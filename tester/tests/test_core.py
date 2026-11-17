from __future__ import annotations

import json
import struct
import sys
import tempfile
import unittest
import zipfile
from pathlib import Path
from unittest.mock import patch

from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from app import checkpoint_meta, lora_zip  # noqa: E402
from app.annotate import annotate_image  # noqa: E402
from app.comfy import ComfyError, build_workflow, build_workflow_for_architecture  # noqa: E402
from app.config import ConfigStore  # noqa: E402
from app.prompts import DEFAULT_NEGATIVE, DEFAULT_PROMPTS, STRENGTHS  # noqa: E402


def make_safetensors_bytes(*, lora: bool = True, trigger: str = "testtrigger") -> bytes:
    header: dict = {}
    if lora:
        header["lora_unet_input_blocks_0.lora_down.weight"] = {
            "dtype": "F16",
            "shape": [8, 4],
            "data_offsets": [0, 64],
        }
        header["lora_unet_input_blocks_0.lora_up.weight"] = {
            "dtype": "F16",
            "shape": [4, 8],
            "data_offsets": [64, 128],
        }
        header["lora_unet_input_blocks_0.alpha"] = {
            "dtype": "F16",
            "shape": [1],
            "data_offsets": [128, 130],
        }
    header["__metadata__"] = {
        "ss_base_model_version": "sdxl_base_v1-0",
        "ss_trigger_word": trigger,
    }
    raw = json.dumps(header).encode("utf-8")
    return struct.pack("<Q", len(raw)) + raw + b"\x00" * 2048


def make_png_bytes() -> bytes:
    import io

    buffer = io.BytesIO()
    Image.new("RGB", (24, 32), (120, 80, 40)).save(buffer, format="PNG")
    return buffer.getvalue()


class PromptTests(unittest.TestCase):
    def test_five_prompts_and_strengths(self):
        self.assertEqual(len(DEFAULT_PROMPTS), 5)
        self.assertEqual(STRENGTHS, [-2.0, -1.5, -1.0, -0.25, 0.25, 1.0, 1.5, 2.0])
        for prompt in DEFAULT_PROMPTS:
            lowered = prompt["text"].lower()
            self.assertTrue("dress" in lowered or "skirt" in lowered, prompt["id"])
            self.assertGreater(len(prompt["text"].split()), 90, prompt["id"])

    def test_long_prompt_is_about_300_words(self):
        long_prompt = next(item for item in DEFAULT_PROMPTS if item["id"] == "p5")
        self.assertLessEqual(abs(len(long_prompt["text"].split()) - 300), 5)

    def test_negative_prompt_is_present(self):
        self.assertGreater(len(DEFAULT_NEGATIVE.split()), 30)


class SafetensorsTests(unittest.TestCase):
    def test_reads_lora_header(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "test.safetensors"
            path.write_bytes(make_safetensors_bytes())
            parsed = lora_zip.read_safetensors_header(path)
            self.assertIsNotNone(parsed)
            metadata, tensors = parsed
            self.assertTrue(lora_zip._is_lora(tensors))
            self.assertEqual(lora_zip._rank(tensors), "8")
            self.assertEqual(metadata["ss_base_model_version"], "sdxl_base_v1-0")

    def test_rejects_non_lora_safetensors(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "base.safetensors"
            path.write_bytes(make_safetensors_bytes(lora=False))
            metadata, tensors = lora_zip.read_safetensors_header(path)
            self.assertFalse(lora_zip._is_lora(tensors))


class ZipTests(unittest.TestCase):
    def test_safe_extract_rejects_traversal(self):
        with tempfile.TemporaryDirectory() as tmp:
            tmp_path = Path(tmp)
            archive = tmp_path / "evil.zip"
            with zipfile.ZipFile(archive, "w") as handle:
                handle.writestr("../escape.txt", "bad")
                handle.writestr("good/file.txt", "good")
            target = tmp_path / "out"
            lora_zip.safe_extract(archive, target)
            self.assertTrue((target / "good" / "file.txt").exists())
            self.assertFalse((tmp_path / "escape.txt").exists())

    def test_import_zip_finds_lora_and_trigger(self):
        with tempfile.TemporaryDirectory() as tmp:
            tmp_path = Path(tmp)
            archive = tmp_path / "civitai.zip"
            with zipfile.ZipFile(archive, "w") as handle:
                handle.writestr("training/test_lora.safetensors", make_safetensors_bytes())
                handle.writestr("training/config.yaml", "trigger_word: testtrigger\n")
                handle.writestr("samples/preview.png", make_png_bytes())
            import_dir = tmp_path / "imports"
            lora_dir = tmp_path / "loras"
            with patch.object(lora_zip, "IMPORT_DIR", import_dir), patch.object(
                lora_zip, "LORA_DIR", lora_dir
            ):
                manifest = lora_zip.import_zip(archive, "civitai.zip")
                self.assertEqual(len(manifest["loras"]), 1)
                entry = manifest["loras"][0]
                self.assertEqual(entry["display_name"], "test_lora")
                self.assertEqual(entry["trigger"], "testtrigger")
                self.assertEqual(entry["base_model"], "sdxl_base_v1-0")
                self.assertEqual(entry["rank"], "8")
                self.assertTrue(entry["preview"].endswith("preview.png"))
                source, resolved, _ = lora_zip.resolve_lora(manifest["import_id"], entry["lora_id"])
                self.assertTrue(source.is_file())
                self.assertEqual(resolved["display_name"], "test_lora")

                again = lora_zip.import_zip(archive, "civitai.zip")
                self.assertEqual(again["import_id"], manifest["import_id"])

    def test_import_single_lora_file(self):
        with tempfile.TemporaryDirectory() as tmp:
            tmp_path = Path(tmp)
            source = tmp_path / "My LoRA.safetensors"
            source.write_bytes(make_safetensors_bytes(trigger="single_trigger"))
            import_dir = tmp_path / "imports"
            lora_dir = tmp_path / "loras"
            with patch.object(lora_zip, "IMPORT_DIR", import_dir), patch.object(
                lora_zip, "LORA_DIR", lora_dir
            ):
                manifest = lora_zip.import_lora_file(source, source.name)
                self.assertEqual(manifest["source_type"], "file")
                self.assertEqual(len(manifest["loras"]), 1)
                entry = manifest["loras"][0]
                self.assertEqual(entry["display_name"], "My LoRA")
                self.assertEqual(entry["trigger"], "single_trigger")
                path, resolved, _ = lora_zip.resolve_lora(manifest["import_id"], entry["lora_id"])
                self.assertTrue(path.is_file())
                self.assertEqual(resolved["display_name"], "My LoRA")

    def test_tampered_manifest_rel_path_is_rejected(self):
        with tempfile.TemporaryDirectory() as tmp:
            tmp_path = Path(tmp)
            source = tmp_path / "My LoRA.safetensors"
            source.write_bytes(make_safetensors_bytes())
            import_dir = tmp_path / "imports"
            lora_dir = tmp_path / "loras"
            with patch.object(lora_zip, "IMPORT_DIR", import_dir), patch.object(
                lora_zip, "LORA_DIR", lora_dir
            ):
                manifest = lora_zip.import_lora_file(source, source.name)
                manifest_path = import_dir / f"{manifest['import_id']}.json"
                data = json.loads(manifest_path.read_text(encoding="utf-8"))
                data["loras"][0]["rel_path"] = "../../escaped.safetensors"
                manifest_path.write_text(json.dumps(data), encoding="utf-8")
                self.assertIsNone(lora_zip.load_manifest(manifest["import_id"]))
                with self.assertRaises(ValueError):
                    lora_zip.resolve_lora(manifest["import_id"], manifest["loras"][0]["lora_id"])

    def test_upload_single_lora_file_endpoint(self):
        import io

        from app import jobs as jobs_module
        from app import server as server_module

        with tempfile.TemporaryDirectory() as tmp:
            tmp_path = Path(tmp)
            import_dir = tmp_path / "imports"
            lora_dir = tmp_path / "loras"
            upload_dir = tmp_path / "uploads"
            for folder in (import_dir, lora_dir, upload_dir):
                folder.mkdir()
            source_bytes = make_safetensors_bytes(trigger="endpoint_trigger")
            with patch.object(lora_zip, "IMPORT_DIR", import_dir), patch.object(
                lora_zip, "LORA_DIR", lora_dir
            ), patch.object(server_module, "UPLOAD_DIR", upload_dir), patch.object(
                jobs_module, "JOB_DIR", tmp_path / "jobs"
            ), patch.object(jobs_module, "TEMP_DIR", tmp_path / "tmp"):
                application = server_module.create_app()
                application.config.update(TESTING=True)
                client = application.test_client()
                response = client.post(
                    "/api/import",
                    data={"files": (io.BytesIO(source_bytes), "Uploaded LoRA.safetensors")},
                    content_type="multipart/form-data",
                )
                payload = response.get_json()
                self.assertEqual(response.status_code, 200)
                self.assertTrue(payload["ok"])
                self.assertEqual(payload["errors"], [])
                manifest = payload["imports"][0]
                self.assertEqual(manifest["source_type"], "file")
                self.assertEqual(manifest["loras"][0]["display_name"], "Uploaded LoRA")
                self.assertEqual(manifest["loras"][0]["trigger"], "endpoint_trigger")
                self.assertTrue((lora_dir / manifest["import_id"]).is_dir())
                self.assertEqual(list(upload_dir.iterdir()), [])

                bad = client.post(
                    "/api/import",
                    data={"files": (io.BytesIO(b"not a zip"), "broken.zip")},
                    content_type="multipart/form-data",
                )
                self.assertEqual(bad.status_code, 400)
                self.assertFalse(bad.get_json()["ok"])

    def test_bad_zip_with_no_lora_raises_then_stays_an_error(self):
        with tempfile.TemporaryDirectory() as tmp:
            tmp_path = Path(tmp)
            archive = tmp_path / "images.zip"
            with zipfile.ZipFile(archive, "w") as handle:
                handle.writestr("picture.png", make_png_bytes())
            import_dir = tmp_path / "imports"
            lora_dir = tmp_path / "loras"
            with patch.object(lora_zip, "IMPORT_DIR", import_dir), patch.object(
                lora_zip, "LORA_DIR", lora_dir
            ):
                with self.assertRaises(ValueError):
                    lora_zip.import_zip(archive, "images.zip")
                with self.assertRaises(ValueError):
                    lora_zip.import_zip(archive, "images.zip")


class WorkflowTests(unittest.TestCase):
    def test_workflow_contains_lora_and_strength(self):
        workflow = build_workflow(
            checkpoint="model.safetensors",
            lora_name="lt_test.safetensors",
            strength=1.5,
            positive="a woman in a dress",
            negative="blurry",
            width=832,
            height=1216,
            steps=30,
            cfg=7.0,
            sampler="dpmpp_2m",
            scheduler="karras",
            seed=42,
            filename_prefix="test",
        )
        self.assertEqual(workflow["2"]["class_type"], "LoraLoader")
        self.assertEqual(workflow["2"]["inputs"]["strength_model"], 1.5)
        self.assertEqual(workflow["2"]["inputs"]["lora_name"], "lt_test.safetensors")
        self.assertEqual(workflow["6"]["inputs"]["seed"], 42)
        self.assertEqual(workflow["3"]["inputs"]["text"], "a woman in a dress")
        self.assertEqual(workflow["4"]["inputs"]["text"], "blurry")


class ArchitectureWorkflowTests(unittest.TestCase):
    def test_flux2_uses_external_clip_and_vae(self):
        workflow = build_workflow_for_architecture(
            architecture="flux2",
            checkpoint="flux.safetensors",
            lora_name="lt_flux.safetensors",
            strength=0.8,
            positive="a woman in a dress",
            negative="blurry",
            width=832,
            height=1216,
            steps=12,
            cfg=1.0,
            sampler="euler",
            scheduler="simple",
            seed=7,
            filename_prefix="test",
            clip_name="qwen_3_8b_fp8mixed.safetensors",
            clip_type="flux2",
            vae_name="flux2-vae.safetensors",
            clip_skip=-1,
            latent="sd3",
        )
        self.assertEqual(workflow["2"]["class_type"], "LoraLoaderModelOnly")
        self.assertEqual(workflow["3"]["inputs"]["type"], "flux2")
        self.assertEqual(workflow["7"]["class_type"], "EmptySD3LatentImage")
        self.assertEqual(workflow["9"]["inputs"]["vae_name"], "flux2-vae.safetensors")

    def test_zimage_has_auraflow_sampling(self):
        workflow = build_workflow_for_architecture(
            architecture="zimage",
            checkpoint="zit.safetensors",
            lora_name="lt_zit.safetensors",
            strength=1.0,
            positive="a woman in a dress",
            negative="blurry",
            width=1024,
            height=1536,
            steps=8,
            cfg=1.0,
            sampler="res_multistep",
            scheduler="simple",
            seed=8,
            filename_prefix="test",
            clip_name="qwen_3_4b.safetensors",
            clip_type="lumina2",
            vae_name="ae.safetensors",
            shift=3.0,
            latent="sd3",
        )
        self.assertEqual(workflow["3"]["class_type"], "ModelSamplingAuraFlow")
        self.assertEqual(workflow["3"]["inputs"]["shift"], 3.0)
        self.assertEqual(workflow["4"]["inputs"]["type"], "lumina2")
        self.assertEqual(workflow["7"]["class_type"], "EmptySD3LatentImage")

    def test_krea2_uses_clip_skip_and_qwen_vae(self):
        workflow = build_workflow_for_architecture(
            architecture="krea2",
            checkpoint="krea.safetensors",
            lora_name="lt_krea.safetensors",
            strength=1.5,
            positive="a woman in a dress",
            negative="blurry",
            width=1024,
            height=1536,
            steps=20,
            cfg=7.0,
            sampler="exp_heun_2_x0",
            scheduler="sgm_uniform",
            seed=9,
            filename_prefix="test",
            clip_name="qwen3vl_4b_fp8_scaled.safetensors",
            clip_type="krea2",
            vae_name="qwen_image_vae.safetensors",
            clip_skip=-2,
            latent="standard",
        )
        self.assertEqual(workflow["4"]["inputs"]["stop_at_clip_layer"], -2)
        self.assertEqual(workflow["4"]["inputs"]["clip"], ["3", 0])
        self.assertEqual(workflow["7"]["class_type"], "EmptyLatentImage")
        self.assertEqual(workflow["9"]["inputs"]["vae_name"], "qwen_image_vae.safetensors")

    def test_flux2_diffusion_model_uses_unet_loader(self):
        workflow = build_workflow_for_architecture(
            architecture="flux2",
            checkpoint="flux-2-klein-9b.safetensors",
            lora_name="lt_flux.safetensors",
            strength=1.0,
            positive="a woman in a dress",
            negative="blurry",
            width=832,
            height=1216,
            steps=12,
            cfg=1.0,
            sampler="euler",
            scheduler="simple",
            seed=7,
            filename_prefix="test",
            clip_name="qwen_3_8b_fp8mixed.safetensors",
            clip_type="flux2",
            vae_name="flux2-vae.safetensors",
            clip_skip=-1,
            latent="sd3",
            model_loader="unet",
        )
        self.assertEqual(workflow["1"]["class_type"], "UNETLoader")
        self.assertEqual(workflow["1"]["inputs"]["unet_name"], "flux-2-klein-9b.safetensors")
        self.assertEqual(workflow["1"]["inputs"]["weight_dtype"], "default")
        self.assertEqual(workflow["2"]["class_type"], "LoraLoaderModelOnly")

    def test_standard_diffusion_model_is_rejected(self):
        with self.assertRaises(ComfyError):
            build_workflow_for_architecture(
                architecture="standard",
                checkpoint="some_sdxl_unet.safetensors",
                lora_name="lt_test.safetensors",
                strength=1.0,
                positive="a woman in a dress",
                negative="blurry",
                width=832,
                height=1216,
                steps=30,
                cfg=7.0,
                sampler="dpmpp_2m",
                scheduler="karras",
                seed=7,
                filename_prefix="test",
                model_loader="unet",
            )


class ServerModelSelectionTests(unittest.TestCase):
    def test_plain_flux1_unet_name_is_rejected(self):
        from app import server as server_module

        class FakeConfig:
            def __init__(self, loras_dir: str):
                self._loras_dir = loras_dir

            def get(self) -> dict:
                return {"loras_dir": self._loras_dir, "cleanup_after_run": False}

            def update(self, values: dict) -> dict:
                return self.get()

        class FakeManager:
            def __init__(self, config):
                self.config = config

            def active_job_id(self):
                return None

            def create_job(self, **kwargs):
                raise AssertionError("an unsupported model must not create a job")

        with tempfile.TemporaryDirectory() as tmp:
            loras = Path(tmp) / "models" / "loras"
            loras.mkdir(parents=True)
            status = {
                "comfy": {
                    "online": True,
                    "url": "http://127.0.0.1:8188",
                    "message": "",
                    "detail": "",
                    "checkpoints": [],
                    "unet_files": ["pid_flux1_512_to_2048_4step.safetensors"],
                    "gguf_files": [],
                    "model_options": [],
                    "samplers": ["euler"],
                    "schedulers": ["simple"],
                    "clip_files": ["qwen_3_8b_fp8mixed.safetensors"],
                    "vae_files": ["flux2-vae.safetensors"],
                    "checkpoint_info": {},
                }
            }
            fake_config = FakeConfig(str(loras))
            with patch.object(server_module, "ensure_dirs", lambda: None), patch.object(
                server_module, "ConfigStore", lambda: fake_config
            ), patch.object(server_module, "JobManager", FakeManager), patch.object(
                server_module, "_shared_status", lambda config, refresh=False: status
            ):
                application = server_module.create_app()
                application.config.update(TESTING=True)
                client = application.test_client()
                response = client.post(
                    "/api/jobs",
                    json={"checkpoint": "pid_flux1_512_to_2048_4step.safetensors"},
                )
            payload = response.get_json()
            self.assertEqual(response.status_code, 400)
            self.assertFalse(payload["ok"])
            self.assertIn("Flux1", payload["error"])


class CheckpointDetectionTests(unittest.TestCase):
    def _write_checkpoint(self, path: Path, keys: list[str]) -> None:
        header = {
            key: {"dtype": "F16", "shape": [2, 2], "data_offsets": [0, 8]} for key in keys
        }
        raw = json.dumps(header).encode("utf-8")
        path.write_bytes(struct.pack("<Q", len(raw)) + raw + b"\x00" * 64)

    def test_detects_flux2_from_tensor_names(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp) / "models"
            checkpoints = root / "checkpoints"
            loras = root / "loras"
            checkpoints.mkdir(parents=True)
            loras.mkdir(parents=True)
            path = checkpoints / "mystery.safetensors"
            self._write_checkpoint(path, ["double_blocks.0.attn.weight", "single_blocks.0.attn.weight"])
            plan = checkpoint_meta.inspect_checkpoint(
                "mystery.safetensors",
                str(loras),
                clip_files=["qwen_3_8b_fp8mixed.safetensors"],
                vae_files=["flux2-vae.safetensors"],
                samplers=["euler"],
                schedulers=["simple"],
            )
            self.assertEqual(plan["architecture"], "flux2")
            self.assertEqual(plan["clip_name"], "qwen_3_8b_fp8mixed.safetensors")
            self.assertEqual(plan["vae_name"], "flux2-vae.safetensors")
            self.assertEqual(plan["sampler"], "euler")

    def test_detects_zimage_and_krea2_from_tensor_names(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp) / "models"
            checkpoints = root / "checkpoints"
            loras = root / "loras"
            checkpoints.mkdir(parents=True)
            loras.mkdir(parents=True)
            zpath = checkpoints / "mystery_z.safetensors"
            self._write_checkpoint(zpath, ["model.diffusion_model.cap_embedder.0.weight"])
            kpath = checkpoints / "mystery_k.safetensors"
            self._write_checkpoint(kpath, ["txtfusion.0.weight"])
            zplan = checkpoint_meta.inspect_checkpoint(
                zpath.name,
                str(loras),
                clip_files=["qwen_3_4b.safetensors"],
                vae_files=["ae.safetensors"],
                samplers=["res_multistep"],
                schedulers=["simple"],
            )
            kplan = checkpoint_meta.inspect_checkpoint(
                kpath.name,
                str(loras),
                clip_files=["qwen3vl_4b_fp8_scaled.safetensors"],
                vae_files=["qwen_image_vae.safetensors"],
                samplers=["exp_heun_2_x0"],
                schedulers=["sgm_uniform"],
            )
            self.assertEqual(zplan["architecture"], "zimage")
            self.assertEqual(zplan["latent"], "sd3")
            self.assertEqual(kplan["architecture"], "krea2")
            self.assertEqual(kplan["clip_skip"], -2)

    def test_detects_diffusion_model_in_diffusion_models_folder(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp) / "models"
            loras = root / "loras"
            diffusion = root / "diffusion_models"
            loras.mkdir(parents=True)
            diffusion.mkdir(parents=True)
            path = diffusion / "flux-2-klein-9b.safetensors"
            self._write_checkpoint(path, ["double_blocks.0.attn.weight"])
            plan = checkpoint_meta.inspect_checkpoint(
                path.name,
                str(loras),
                clip_files=["qwen_3_8b_fp8mixed.safetensors"],
                vae_files=["flux2-vae.safetensors"],
                samplers=["euler"],
                schedulers=["simple"],
                loader="unet",
            )
            self.assertEqual(plan["architecture"], "flux2")
            self.assertEqual(plan["loader"], "unet")
            self.assertTrue(plan["supported"])

    def test_unknown_diffusion_model_is_marked_unsupported(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp) / "models"
            loras = root / "loras"
            diffusion = root / "diffusion_models"
            loras.mkdir(parents=True)
            diffusion.mkdir(parents=True)
            path = diffusion / "some_video_model.safetensors"
            self._write_checkpoint(path, ["conv.weight"])
            plan = checkpoint_meta.inspect_checkpoint(
                path.name,
                str(loras),
                samplers=["euler"],
                schedulers=["simple"],
                loader="unet",
            )
            self.assertEqual(plan["architecture"], "standard")
            self.assertFalse(plan["supported"])
            self.assertIn("Flux2", plan["unsupported_reason"])
            self.assertEqual(plan["unsupported_label"], "Unsupported diffusion model")

    def test_flux1_upscaler_is_unsupported(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp) / "models"
            loras = root / "loras"
            diffusion = root / "diffusion_models"
            loras.mkdir(parents=True)
            diffusion.mkdir(parents=True)
            path = diffusion / "pid_flux1_512_to_2048_4step.safetensors"
            self._write_checkpoint(path, ["double_blocks.0.attn.weight"])
            plan = checkpoint_meta.inspect_checkpoint(
                path.name,
                str(loras),
                clip_files=["qwen_3_8b_fp8mixed.safetensors"],
                vae_files=["flux2-vae.safetensors"],
                samplers=["euler"],
                schedulers=["simple"],
                loader="unet",
            )
            self.assertEqual(plan["architecture"], "flux1")
            self.assertFalse(plan["supported"])
            self.assertIn("Flux1", plan["unsupported_reason"])
            self.assertEqual(plan["unsupported_label"], "Flux1 model")

    def test_name_heuristics_for_standard_checkpoint(self):
        plan = checkpoint_meta.inspect_checkpoint(
            "some_sdxl_model.safetensors",
            "",
            clip_files=[],
            vae_files=[],
            samplers=["euler"],
            schedulers=["normal"],
        )
        self.assertEqual(plan["architecture"], "standard")
        self.assertEqual(plan["lora_mode"], "model_clip")
        self.assertEqual(plan["sampler"], "euler")


class AnnotationTests(unittest.TestCase):
    def test_annotation_burns_bar_and_metadata(self):
        with tempfile.TemporaryDirectory() as tmp:
            tmp_path = Path(tmp)
            source = tmp_path / "source.png"
            dest = tmp_path / "dest.png"
            Image.new("RGB", (480, 720), (220, 160, 100)).save(source)
            annotate_image(
                source,
                dest,
                lora_name="my_test_lora",
                prompt_label="UGC 1 · Rooftop café",
                strength=0.25,
                checkpoint="model.safetensors",
                seed=1234,
                trigger="testtrigger",
                positive="testtrigger, a woman in a dress",
                negative="blurry",
                settings={
                    "width": 480,
                    "height": 720,
                    "steps": 30,
                    "cfg": 7.0,
                    "sampler": "dpmpp_2m",
                    "scheduler": "karras",
                },
            )
            self.assertTrue(dest.exists())
            with Image.open(dest) as image:
                self.assertEqual(image.size, (480, 720))
                self.assertIn("parameters", image.text)
                self.assertIn("lora_tester", image.text)
                self.assertIn("my_test_lora", image.text["parameters"])
                bottom = image.getpixel((10, 719))
                self.assertLess(sum(bottom), 200, "bottom bar should darken the image")


class ConfigTests(unittest.TestCase):
    def test_config_round_trip(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "config.json"
            store = ConfigStore(path)
            self.assertEqual(store.get()["last_steps"], 30)
            store.update({"last_steps": 42, "comfy_url": "http://127.0.0.1:8199"})
            again = ConfigStore(path)
            self.assertEqual(again.get()["last_steps"], 42)
            self.assertEqual(again.get()["comfy_url"], "http://127.0.0.1:8199")


if __name__ == "__main__":
    unittest.main(verbosity=2)
