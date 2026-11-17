import { test } from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import { readImageMetadata, extractPrompt, extractNegative, fieldsToMap, analyze } from '../public/js/meta.js';

// ---- tiny PNG builder (CRCs are not checked by the reader)
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  return Buffer.concat([len, Buffer.from(type, 'latin1'), data, Buffer.alloc(4)]);
}
function png(textChunks) {
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(832, 0); ihdr.writeUInt32BE(1216, 4);
  const parts = [Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr)];
  for (const [type, key, value] of textChunks) {
    if (type === 'tEXt') parts.push(chunk('tEXt', Buffer.concat([Buffer.from(key + '\0', 'latin1'), Buffer.from(value, 'latin1')])));
    if (type === 'zTXt') parts.push(chunk('zTXt', Buffer.concat([Buffer.from(key + '\0\0', 'latin1'), zlib.deflateSync(Buffer.from(value, 'latin1'))])));
    if (type === 'iTXt') parts.push(chunk('iTXt', Buffer.concat([Buffer.from(key + '\0\x01\0\0\0', 'latin1'), zlib.deflateSync(Buffer.from(value, 'utf8'))])));
  }
  parts.push(chunk('IEND', Buffer.alloc(0)));
  const b = Buffer.concat(parts);
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.length);
}

const comfyGraph = {
  4: { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: 'models/sdxl_base.safetensors' } },
  5: { class_type: 'LoraLoader', inputs: { lora_name: 'styles\\inkWash_v2.safetensors', strength_model: 0.8, strength_clip: 0.8, model: ['4', 0], clip: ['4', 1] } },
  6: { class_type: 'CLIPTextEncode', inputs: { text: ['10', 0], clip: ['5', 1] } },
  7: { class_type: 'CLIPTextEncode', inputs: { text: 'blurry, extra fingers', clip: ['5', 1] } },
  10: { class_type: 'PrimitiveString', inputs: { value: 'a heron in the rain, ink wash painting' } },
  3: { class_type: 'KSampler', inputs: { seed: 42, steps: 30, cfg: 6.5, sampler_name: 'euler', scheduler: 'normal', denoise: 1, positive: ['6', 0], negative: ['7', 0], model: ['5', 0] } },
};

test('A1111 parameters: prompt, negative and settings', async () => {
  const params = 'a cat wearing a hat <lora:hatStyle:0.7>\nNegative prompt: lowres, bad hands\nSteps: 20, Sampler: Euler a, CFG scale: 7, Seed: 1234, Size: 512x768, Model: dreamshaper_8';
  const meta = await readImageMetadata(png([['tEXt', 'parameters', params]]));
  assert.equal(meta.format, 'png');
  assert.equal(meta.width, 832);
  assert.equal(extractPrompt(meta.fields), 'a cat wearing a hat <lora:hatStyle:0.7>');
  assert.equal(extractNegative(meta.fields), 'lowres, bad hands');
  const a = analyze(fieldsToMap(meta.fields));
  assert.equal(a.model, 'dreamshaper_8');
  assert.deepEqual(a.loras, [{ name: 'hatStyle', model: '0.7', clip: null }]);
  assert.equal(a.stats.seed, '1234');
});

test('ComfyUI graph: follows sampler links through a string node', async () => {
  const meta = await readImageMetadata(png([['zTXt', 'prompt', JSON.stringify(comfyGraph)]]));
  assert.equal(extractPrompt(meta.fields), 'a heron in the rain, ink wash painting');
  assert.equal(extractNegative(meta.fields), 'blurry, extra fingers');
  const a = analyze(fieldsToMap(meta.fields));
  assert.equal(a.model, 'sdxl_base');
  assert.deepEqual(a.loras, [{ name: 'inkWash_v2', model: 0.8, clip: 0.8 }]);
  assert.equal(a.stats.steps, '30');
});

test('iTXt compressed UTF-8 text is read', async () => {
  const meta = await readImageMetadata(png([['iTXt', 'Description', 'café au lait, 35mm photo']]));
  assert.equal(extractPrompt(meta.fields), 'café au lait, 35mm photo');
});

test('JPEG EXIF UserComment (A1111 style) is read', async () => {
  const text = 'portrait of an old sailor\nSteps: 25, Sampler: DPM++ 2M, Seed: 9';
  const body = Buffer.concat([Buffer.from('UNICODE\0', 'latin1'), Buffer.from(text, 'utf16le').swap16()]);
  // TIFF header (big-endian) -> IFD0 with ExifIFD pointer -> UserComment
  const tiff = Buffer.alloc(8 + 2 + 12 + 4 + 2 + 12 + 4);
  tiff.write('MM', 0, 'latin1'); tiff.writeUInt16BE(42, 2); tiff.writeUInt32BE(8, 4);
  tiff.writeUInt16BE(1, 8);
  tiff.writeUInt16BE(0x8769, 10); tiff.writeUInt16BE(4, 12); tiff.writeUInt32BE(1, 14); tiff.writeUInt32BE(26, 18);
  tiff.writeUInt16BE(1, 26);
  tiff.writeUInt16BE(0x9286, 28); tiff.writeUInt16BE(7, 30); tiff.writeUInt32BE(body.length, 32); tiff.writeUInt32BE(tiff.length, 36);
  const app1 = Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), tiff, body]);
  const seg = Buffer.alloc(4); seg[0] = 0xff; seg[1] = 0xe1; seg.writeUInt16BE(app1.length + 2, 2);
  const jpg = Buffer.concat([Buffer.from([0xff, 0xd8]), seg, app1, Buffer.from([0xff, 0xd9])]);
  const meta = await readImageMetadata(jpg.buffer.slice(jpg.byteOffset, jpg.byteOffset + jpg.length));
  assert.equal(meta.format, 'jpeg');
  assert.equal(extractPrompt(meta.fields), 'portrait of an old sailor');
  assert.equal(analyze(fieldsToMap(meta.fields)).stats.seed, '9');
});

test('no metadata gives no prompt', async () => {
  const meta = await readImageMetadata(png([]));
  assert.equal(extractPrompt(meta.fields), null);
  assert.equal(analyze(fieldsToMap(meta.fields)).detected, false);
});

test('ConditioningZeroOut negative is not reported as a negative prompt', async () => {
  const g = {
    1: { class_type: 'CLIPTextEncode', inputs: { text: 'a lighthouse at dusk' } },
    2: { class_type: 'ConditioningZeroOut', inputs: { conditioning: ['1', 0] } },
    3: { class_type: 'KSampler', inputs: { seed: 1, positive: ['1', 0], negative: ['2', 0], strength: 0.39999999999999974 } },
    4: { class_type: 'LoraLoader', inputs: { lora_name: 'x.safetensors', strength_model: 0.39999999999999974 } },
  };
  const meta = await readImageMetadata(png([['tEXt', 'prompt', JSON.stringify(g)]]));
  assert.equal(extractPrompt(meta.fields), 'a lighthouse at dusk');
  assert.equal(extractNegative(meta.fields), null);
  assert.equal(analyze(fieldsToMap(meta.fields)).loras[0].model, 0.4);
});
