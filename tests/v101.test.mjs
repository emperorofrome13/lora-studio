// v1.01: strip double-check (inspectImage + read-back), the "Lora: name:strength"
// reader, and the LoRA Tester integration (folder rules, job listing, output reads).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { stripImage, inspectImage } from '../public/js/strip-core.js';
import { analyze } from '../public/js/meta.js';
import { saveImage, readSaved } from '../lib/save.mjs';
import { createTester } from '../lib/tester.mjs';
import { createServer } from '../server.mjs';
import { createLibrary } from '../lib/library.mjs';

function pngChunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  return Buffer.concat([len, Buffer.from(type, 'latin1'), data, Buffer.from([1, 2, 3, 4])]);
}
const png = Buffer.concat([
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
  pngChunk('IHDR', Buffer.alloc(13, 1)),
  pngChunk('tEXt', Buffer.from('workflow\0{"last_node_id":3,"nodes":[]}', 'latin1')),
  pngChunk('IDAT', Buffer.from('fake-compressed-pixels')),
  pngChunk('IEND', Buffer.alloc(0)),
  Buffer.from('hidden'),
]);

test('inspectImage flags metadata blocks, trailing data and raw signatures', () => {
  const r = inspectImage(png);
  assert.equal(r.format, 'png');
  assert.equal(r.clean, false);
  assert.ok(r.found.includes('tEXt "workflow"'));
  assert.ok(r.found.includes('6 bytes hidden after the image'));
  assert.ok(r.found.some((f) => f.startsWith('ComfyUI workflow graph')), 'raw scan finds the workflow JSON');
  assert.deepEqual(r.blocks.map((b) => b.kind), ['image', 'meta', 'image', 'image', 'meta']);
});

test('inspectImage reports a stripped PNG as clean', () => {
  const clean = inspectImage(stripImage(png).bytes);
  assert.equal(clean.clean, true, clean.found.join(', '));
  assert.deepEqual(clean.blocks.map((b) => b.name), ['IHDR', 'IDAT', 'IEND']);
});

test('inspectImage raw scan catches metadata hidden inside an image chunk', () => {
  const sneaky = Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), pngChunk('IHDR', Buffer.alloc(13, 1)),
    pngChunk('IDAT', Buffer.from('xx Negative prompt: ugly, Steps: 20 xx')), pngChunk('IEND', Buffer.alloc(0)),
  ]);
  const r = inspectImage(sneaky);
  assert.equal(r.clean, false);
  assert.ok(r.found.some((f) => f.startsWith('A1111 generation parameters')));
});

test('readSaved only returns files this process saved', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ls-read-'));
  const clean = Buffer.from(stripImage(png).bytes);
  const saved = await saveImage(dir, 'a.png', clean);
  assert.deepEqual(await readSaved(saved), clean);
  const other = path.join(dir, 'other.png');
  await fs.writeFile(other, clean);
  assert.equal(await readSaved(other), null);
  assert.equal(await readSaved(''), null);
});

test('"Lora: name:strength" in parameters is read as a LoRA with its strength', () => {
  const a = analyze({ parameters: 'a woman\nNegative prompt: blurry\nSteps: 8, Sampler: euler, CFG scale: 1, Seed: 42, Size: 512x768, Model: krea2.safetensors, Lora: my_style-v2:-1.50' });
  assert.deepEqual(a.loras, [{ name: 'my_style-v2', model: -1.5, clip: null }]);
  assert.equal(a.stats.seed, '42');
});

// ---------------------------------------------------------------- tester
let tdir, tester;
before(async () => {
  tdir = await fs.mkdtemp(path.join(os.tmpdir(), 'ls-tester-'));
  const app = path.join(tdir, 'tester');
  await fs.mkdir(path.join(app, 'app'), { recursive: true });
  await fs.writeFile(path.join(app, 'app', 'server.py'), '# fake');
  await fs.writeFile(path.join(app, 'app', 'jobs.py'), '# fake');
  await fs.mkdir(path.join(app, 'data', 'jobs'), { recursive: true });
  await fs.mkdir(path.join(app, 'output', 'job1', 'lora-a'), { recursive: true });
  await fs.writeFile(path.join(app, 'output', 'job1', 'lora-a', '001.png'), png);
  await fs.writeFile(path.join(app, 'data', 'jobs', 'job1.json'), JSON.stringify({
    id: 'job1', status: 'completed', created_at: '2026-11-01T10:00:00', checkpoint: 'unet::model.safetensors',
    results: [{ rel_path: 'job1/lora-a/001.png', filename: '001.png', lora_name: 'lora-a', strength: 1 }],
  }));
  await fs.writeFile(path.join(app, 'data', 'jobs', 'empty.json'), JSON.stringify({ id: 'empty', results: [] }));
  tester = createTester({ appDir: tdir, dataDir: path.join(tdir, 'data') });
  await tester.loadSettings();
});

test('tester: bundled folder is found, stopped, and lists runs with images', async () => {
  const s = await tester.status();
  assert.equal(s.found, true);
  assert.equal(s.source, 'bundled');
  assert.equal(s.state, 'stopped');
  const jobs = await tester.jobs();
  assert.equal(jobs.length, 1);
  assert.deepEqual({ id: jobs[0].id, images: jobs[0].images, model: jobs[0].model, loras: jobs[0].loras }, { id: 'job1', images: 1, model: 'model.safetensors', loras: ['lora-a'] });
  assert.deepEqual(await tester.jobImages('job1'), [{ path: 'job1/lora-a/001.png', name: '001.png', lora: 'lora-a', strength: 1 }]);
});

test('tester: output reads stay inside the output folder', async () => {
  assert.deepEqual(await tester.readOutput('job1/lora-a/001.png'), png);
  assert.equal(await tester.readOutput('../data/jobs/job1.json'), null);
  assert.equal(await tester.readOutput('../../tester/app/server.py'), null);
  await assert.rejects(tester.jobImages('../x'), /Bad job id/);
});

test('tester: folder setting must point at a real LoRA Tester', async () => {
  await assert.rejects(tester.setFolder('relative\\path'), /full folder path/);
  await assert.rejects(tester.setFolder(tdir), /does not contain LoRA Tester/);
  const s = await tester.setFolder(path.join(tdir, 'tester'));
  assert.equal(s.source, 'settings');
  assert.equal((await tester.setFolder('')).source, 'bundled');
});

test('server: tester routes, read-back route and the frame policy', async () => {
  const lib = createLibrary({ dataDir: path.join(tdir, 'libdata'), lookup: async () => ({ found: false }), delayMs: 0, log: () => {} });
  await lib.load();
  const server = createServer(lib, tester);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const page = await fetch(base + '/');
    assert.match(page.headers.get('content-security-policy'), /frame-src http:\/\/127\.0\.0\.1:\*/);
    const st = await (await fetch(base + '/api/tester/status')).json();
    assert.equal(st.found, true);
    const jobs = await (await fetch(base + '/api/tester/jobs')).json();
    assert.equal(jobs.jobs[0].id, 'job1');
    const img = await fetch(base + '/api/tester/image?path=job1%2Flora-a%2F001.png');
    assert.equal(img.status, 200);
    assert.equal(img.headers.get('content-type'), 'image/png');
    assert.equal((await fetch(base + '/api/tester/image?path=..%2Fdata%2Fjobs%2Fjob1.json')).status, 404);
    assert.equal((await fetch(base + '/api/files/read?path=' + encodeURIComponent(path.join(tdir, 'tester', 'app', 'server.py')))).status, 404);
    // Starting needs JSON (or the app header) like every other state change.
    assert.equal((await fetch(base + '/api/tester/start', { method: 'POST' })).status, 415);
  } finally {
    await new Promise((r) => server.close(r));
  }
});

test('tester: a port answered by another process does not count as this tester running', async () => {
  // Something (e.g. a separate LoRA Tester install) answers health checks on a port...
  const http = await import('node:http');
  const other = http.createServer((q, r) => { r.setHeader('Content-Type', 'application/json'); r.end('{"ok":true,"version":"9.99"}'); });
  await new Promise((r) => other.listen(0, '127.0.0.1', r));
  const port = other.address().port;
  const rec = path.join(tdir, 'tester', 'data', 'server.json');
  try {
    // ...but the process in this folder's record is gone: not running.
    await fs.writeFile(rec, JSON.stringify({ pid: 2147480000, port }));
    assert.equal((await tester.status()).state, 'stopped');
    // A live recorded process on that port: running.
    await fs.writeFile(rec, JSON.stringify({ pid: process.pid, port }));
    const s = await tester.status();
    assert.equal(s.state, 'running');
    assert.equal(s.url, `http://127.0.0.1:${port}`);
  } finally {
    await fs.rm(rec, { force: true });
    await new Promise((r) => other.close(r));
  }
});

after(async () => { await fs.rm(tdir, { recursive: true, force: true }); });
