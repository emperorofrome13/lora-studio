"""MOSS-Image and MiniMax H3 Image support (v1.05): detection, plans, graphs, LoRA folder checks."""

from __future__ import annotations

import json
import struct
import tempfile
import unittest
from pathlib import Path

from app import checkpoint_meta, comfy, detect

MOSS_KEYS = ["shared_block_modulation.weight", "layers.0.proj.ffn_up_gate.weight", "layers.0.proj.qkv.weight"]
H3_IMAGE_KEYS = ["video_patch_proj.weight", "condition_proj.weight", "blocks.0.attn.weight"]
H3_VIDEO_KEYS = H3_IMAGE_KEYS + ["audio_patch_proj.weight"]
CLIPS = [
    "qwen3.5_9b_w4a8_gptq.safetensors",
    "qwen3vl_32b_minimax_h3_int8_convrot.safetensors",
    "qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors",
]
VAES = ["flux2-vae_small.safetensors", "moss_image_vae_bf16.safetensors", "minimax_h3_image_vae_fp16.safetensors"]


def write_header(path: Path, keys: list[str]) -> None:
    header = {key: {"dtype": "F16", "shape": [2, 2], "data_offsets": [0, 8]} for key in keys}
    raw = json.dumps(header).encode("utf-8")
    path.write_bytes(struct.pack("<Q", len(raw)) + raw + b"\x00" * 64)


class MossH3DetectionTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        root = Path(self.tmp.name) / "models"
        self.loras = root / "loras"
        self.unet = root / "unet"
        self.loras.mkdir(parents=True)
        self.unet.mkdir(parents=True)

    def tearDown(self):
        self.tmp.cleanup()

    def plan(self, name: str, keys: list[str], prefer_fp4: bool = False) -> dict:
        write_header(self.unet / name, keys)
        return checkpoint_meta.inspect_checkpoint(
            name, str(self.loras), clip_files=CLIPS, vae_files=VAES,
            samplers=["euler", "er_sde"], schedulers=["simple"], loader="unet", prefer_fp4=prefer_fp4,
        )

    def test_moss_detected_from_tensors_even_with_a_finetune_name(self):
        plan = self.plan("MyFinetune_00001_.safetensors", ["model." + k for k in MOSS_KEYS])
        self.assertEqual(plan["architecture"], "moss")
        self.assertTrue(plan["supported"])
        self.assertEqual((plan["clip_name"], plan["clip_type"]), ("qwen3.5_9b_w4a8_gptq.safetensors", "moss_image"))
        self.assertEqual(plan["vae_name"], "flux2-vae_small.safetensors")
        self.assertEqual((plan["steps"], plan["cfg"], plan["sampler"], plan["scheduler"]), (25, 2.5, "er_sde", "simple"))
        self.assertEqual((plan["width"] % 16, plan["height"] % 16), (0, 0))
        self.assertEqual(plan["warnings"], [])

    def test_h3_image_vs_h3_video(self):
        image = self.plan("anything.safetensors", H3_IMAGE_KEYS)
        video = self.plan("other.safetensors", H3_VIDEO_KEYS)
        self.assertEqual(image["architecture"], "h3image")
        self.assertTrue(image["supported"])
        self.assertEqual((image["clip_type"], image["vae_name"]), ("minimax", "minimax_h3_image_vae_fp16.safetensors"))
        self.assertEqual((image["steps"], image["cfg"], image["sampler"]), (6, 1.0, "euler"))
        self.assertEqual((image["width"] % 32, image["height"] % 32), (0, 0))
        self.assertGreaterEqual(image["width"] * image["height"], 4_000_000, "H3 Image is tuned for ~4 MP and up")
        self.assertEqual(video["architecture"], "h3video")
        self.assertFalse(video["supported"])
        self.assertIn("H3 Image", video["unsupported_reason"])

    def test_h3_text_encoder_follows_the_gpu(self):
        self.assertEqual(self.plan("a.safetensors", H3_IMAGE_KEYS)["clip_name"], "qwen3vl_32b_minimax_h3_int8_convrot.safetensors")
        self.assertEqual(self.plan("b.safetensors", H3_IMAGE_KEYS, prefer_fp4=True)["clip_name"], "qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors")
        self.assertTrue(checkpoint_meta.gpu_prefers_fp4("cuda:0 NVIDIA GeForce RTX 5070 Ti : cudaMallocAsync"))
        self.assertTrue(checkpoint_meta.gpu_prefers_fp4("NVIDIA RTX PRO 6000 Blackwell Workstation Edition"))
        self.assertFalse(checkpoint_meta.gpu_prefers_fp4("cuda:0 NVIDIA GeForce RTX 4090 : cudaMallocAsync"))
        self.assertFalse(checkpoint_meta.gpu_prefers_fp4(""))

    def test_name_fallback_when_the_file_is_not_readable_here(self):
        for name, arch in [("moss_image_sft_int8_convrot.safetensors", "moss"),
                           ("minimax_h3_image_pruned_int8_convrot.safetensors", "h3image"),
                           ("minimax_h3_fl2va_pruned_int8_convrot.safetensors", "h3video")]:
            self.assertEqual(checkpoint_meta.detect_architecture(name, str(self.loras), "unet"), arch, name)


class MossH3WorkflowTests(unittest.TestCase):
    def build(self, architecture: str, **extra) -> dict:
        args = dict(
            architecture=architecture, checkpoint="model.safetensors", lora_name="lt_x_test.safetensors",
            strength=-1.5, positive="a red fox", negative="blurry", width=1792, height=2304, steps=6, cfg=1.0,
            sampler="euler", scheduler="simple", seed=42, filename_prefix="t/x", clip_name="te.safetensors",
            vae_name="vae.safetensors", model_loader="unet",
        )
        args.update(extra)
        return comfy.build_workflow_for_architecture(**args)

    @staticmethod
    def by_type(graph: dict) -> dict:
        return {node["class_type"]: (key, node) for key, node in graph.items()}

    def check_links(self, graph: dict) -> None:
        for key, node in graph.items():
            for name, value in node["inputs"].items():
                if isinstance(value, list) and len(value) == 2 and isinstance(value[0], str):
                    self.assertIn(value[0], graph, f"node {key} input {name} points at a missing node")

    def test_moss_graph(self):
        g = self.build("moss", width=1024, height=1536, steps=25, cfg=2.5, sampler="er_sde")
        self.check_links(g)
        t = self.by_type(g)
        self.assertEqual(t["CLIPLoader"][1]["inputs"]["type"], "moss_image")
        self.assertEqual(t["EmptyFlux2LatentImage"][1]["inputs"]["width"], 1024)
        lora_key, lora = t["LoraLoaderModelOnly"]
        self.assertEqual(lora["inputs"]["strength_model"], -1.5)
        sampler = t["KSampler"][1]["inputs"]
        self.assertEqual(sampler["model"], [lora_key, 0])
        self.assertEqual((sampler["steps"], sampler["cfg"], sampler["sampler_name"]), (25, 2.5, "er_sde"))
        self.assertEqual(t["UNETLoader"][1]["inputs"]["unet_name"], "model.safetensors")

    def test_h3_image_graph(self):
        g = self.build("h3image")
        self.check_links(g)
        t = self.by_type(g)
        self.assertEqual(t["CLIPLoader"][1]["inputs"]["type"], "minimax")
        cond_key, cond = t["MiniMaxH3ImageConditioning"]
        self.assertEqual((cond["inputs"]["prompt"], cond["inputs"]["width"], cond["inputs"]["height"]), ("a red fox", 1792, 2304))
        sampler = t["KSampler"][1]["inputs"]
        self.assertEqual(sampler["positive"], [cond_key, 0])
        self.assertEqual(sampler["latent_image"], [cond_key, 1], "the latent comes from the conditioning node")
        zero_key, _ = t["ConditioningZeroOut"]
        self.assertEqual(sampler["negative"], [zero_key, 0])
        self.assertEqual(sampler["model"], [t["LoraLoaderModelOnly"][0], 0])
        self.assertNotIn("EmptyLatentImage", t)


class LorasFolderTests(unittest.TestCase):
    def test_loras_match_detects_a_folder_from_another_comfyui(self):
        with tempfile.TemporaryDirectory() as tmp:
            mine = Path(tmp) / "new" / "loras"
            other = Path(tmp) / "old" / "loras"
            (mine / "sub").mkdir(parents=True)
            other.mkdir(parents=True)
            listed = ["a.safetensors", "sub\\b.safetensors", "c.safetensors"]
            for name in listed:
                (mine / name.replace("\\", "/")).write_bytes(b"x")
            (other / "a.safetensors").write_bytes(b"x")
            self.assertTrue(detect.loras_match(mine, listed))
            self.assertFalse(detect.loras_match(other, listed), "only 1 of 3 listed LoRAs is there")
            self.assertTrue(detect.loras_match(other, []), "nothing listed: nothing to compare")
            self.assertFalse(detect.loras_match(Path(tmp) / "missing", listed))


class LabelLayoutTests(unittest.TestCase):
    def test_label_lines_never_overlap_on_large_images(self):
        """The burned-in bar used to overlap the LoRA name and the info line on 1024 px+ images."""
        from PIL import Image, ImageDraw
        from app import annotate

        calls: list[tuple] = []
        original = ImageDraw.ImageDraw.text

        def spy(draw, xy, text, font=None, **kw):
            calls.append((text, draw.textbbox(xy, text, font=font)))
            return original(draw, xy, text, font=font, **kw)

        ImageDraw.ImageDraw.text = spy
        try:
            with tempfile.TemporaryDirectory() as tmp:
                for width, height in [(1024, 1536), (1792, 2304), (3072, 4096)]:
                    src = Path(tmp) / f"s{width}.png"
                    Image.new("RGB", (width, height), (90, 90, 90)).save(src)
                    calls.clear()
                    annotate.annotate_image(
                        src, Path(tmp) / f"o{width}.png", lora_name="my-long-style-lora-moss-image-sft-epoch-10",
                        prompt_label="Cafe", strength=-1.5, checkpoint="[UNET] model.safetensors", seed=1,
                        trigger="tw", positive="p", negative="n", settings={},
                    )
                    rows = [box for text, box in calls if text != "LORA"]
                    for upper, lower in zip(rows, rows[1:]):
                        self.assertLessEqual(upper[3], lower[1], f"lines overlap at {width}x{height}")
        finally:
            ImageDraw.ImageDraw.text = original


if __name__ == "__main__":
    unittest.main()
