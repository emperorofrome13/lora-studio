import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { readSafetensorsMetadata } from '../lib/safetensors.mjs';
import { createLibrary, migrateEntry } from '../lib/library.mjs';

async function writeLora(file, meta) {
  const header = Buffer.from(JSON.stringify({ __metadata__: meta, 'w': { dtype: 'F16', shape: [1], data_offsets: [0, 2] } }), 'utf8');
  const len = Buffer.alloc(8); len.writeBigUInt64LE(BigInt(header.length));
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, Buffer.concat([len, header, Buffer.alloc(2)]));
}

const tmp = () => fs.mkdtemp(path.join(os.tmpdir(), 'lora-studio-'));

test('safetensors header metadata (kohya and modelspec keys)', async () => {
  const dir = await tmp();
  await writeLora(path.join(dir, 'a.safetensors'), { 'modelspec.title': 'Ink Wash', 'modelspec.architecture': 'stable-diffusion-xl-v1-base/lora' });
  await writeLora(path.join(dir, 'b.safetensors'), { ss_base_model_version: 'sdxl_base_v1-0', ss_tag_frequency: JSON.stringify({ d: { heron: 9, rain: 4, ink: 7, x: 1 } }) });
  const a = await readSafetensorsMetadata(path.join(dir, 'a.safetensors'));
  assert.equal(a.title, 'Ink Wash');
  assert.equal(a.baseModel, 'stable-diffusion-xl-v1-base/lora');
  const b = await readSafetensorsMetadata(path.join(dir, 'b.safetensors'));
  assert.equal(b.triggerWord, 'heron, ink, rain');
  assert.deepEqual(await readSafetensorsMetadata(path.join(dir, 'missing.safetensors')), { title: null, triggerWord: null, baseModel: null });
});

test('scan records new files, hashes them and stores the Civitai match', async () => {
  const dir = await tmp();
  const loras = path.join(dir, 'loras');
  await writeLora(path.join(loras, 'styles', 'deep', 'ink.safetensors'), { 'modelspec.title': 'Ink' });
  await writeLora(path.join(loras, 'top.safetensors'), {});
  const lookups = [];
  const lib = createLibrary({
    dataDir: path.join(dir, 'data'), delayMs: 0, log: () => {},
    lookup: async (hash) => { lookups.push(hash); return lookups.length === 1 ? { found: true, modelId: 11, versionId: 22, title: 'Ink Wash', trainedWords: ['inkwash'] } : { found: false }; },
  });
  await lib.load();
  await lib.addFolder(loras);
  const first = await lib.scanFolder(loras);
  assert.equal(first.added, 2);
  assert.deepEqual(first.models.map((m) => m.relativeDir).sort(), ['', 'styles/deep']);
  assert.ok(first.models.every((m) => m.isNew));
  await lib.idle();
  const second = await lib.scanFolder(loras);
  assert.equal(second.added, 0);
  assert.equal(lookups.length, 2, 'each file is looked up once');
  const found = second.models.find((m) => m.metadata.civitaiModelId);
  assert.equal(found.metadata.civitaiVersionId, 22);
  assert.ok(second.models.every((m) => m.sha256 && m.metadata.civitaiChecked));
  await lib.flush();
  // A fresh library (next server start) reads the saved cache and folders.
  const again = createLibrary({ dataDir: path.join(dir, 'data'), lookup: async () => { throw new Error('should not look up'); }, log: () => {} });
  await again.load();
  assert.deepEqual(again.folders, [loras]);
  const third = await again.scanFolder(loras);
  assert.equal(third.models.filter((m) => m.isNew).length, 0);
  assert.equal(third.models.find((m) => m.metadata.civitaiTitle).metadata.civitaiTitle, 'Ink Wash');
});

test('old lorabrowser cache entries migrate', () => {
  const found = migrateEntry({ filename: 'x.safetensors', fullPath: 'C:\\l\\x.safetensors', size: 5, createdAt: '2026-01-01T00:00:00.000Z', sha256: 'ab', metadata: { civitaiTitle: 'X', civitaiImage: 'https://i/x.jpg' } });
  assert.equal(found.civitai.title, 'X');
  assert.equal(found.civitai.modelId, null, 'ids are fetched again');
  assert.equal(found.header, null, 'header is read on first scan');
  const none = migrateEntry({ fullPath: 'C:\\l\\y.safetensors', sha256: 'cd', metadata: { title: null, triggerWord: null, baseModel: null, civitaiTitle: null } });
  assert.equal(none.civitai.found, false);
  assert.deepEqual(none.header, { title: null, triggerWord: null, baseModel: null });
  assert.equal(migrateEntry({ filename: 'no-path' }), null);
});
