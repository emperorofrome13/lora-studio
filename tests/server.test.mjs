import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createServer } from '../server.mjs';
import { createLibrary } from '../lib/library.mjs';

let server, base, dir;
before(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lora-studio-srv-'));
  const lib = createLibrary({ dataDir: path.join(dir, 'data'), lookup: async () => ({ found: false }), delayMs: 0, log: () => {} });
  await lib.load();
  server = createServer(lib);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => new Promise((r) => server.close(r)));

test('serves the app page and the health check', async () => {
  const page = await fetch(base + '/');
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-security-policy'), /blob:/);
  assert.match(await page.text(), /LORA STUDIO/);
  const h = await (await fetch(base + '/api/health')).json();
  assert.equal(h.app, 'lora-studio');
});

test('rejects path traversal and foreign Host headers', async () => {
  const r = await fetch(base + '/..%2f..%2fserver.mjs');
  assert.ok([403, 404].includes(r.status));
  const foreign = await new Promise((resolve) => {
    import('node:http').then(({ request }) => {
      const req = request(base + '/api/folders', { headers: { Host: 'evil.example' } }, (res) => resolve(res.statusCode));
      req.end();
    });
  });
  assert.equal(foreign, 403);
});

test('folders: JSON required, bad folder is 404, good folder saved and scanned', async () => {
  const notJson = await fetch(base + '/api/folders', { method: 'POST', body: 'folder=x' });
  assert.equal(notJson.status, 415);
  const missing = await fetch(base + '/api/folders', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ folder: path.join(dir, 'nope') }) });
  assert.equal(missing.status, 404);
  const loras = path.join(dir, 'loras');
  await fs.mkdir(loras);
  const ok = await (await fetch(base + '/api/folders', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ folder: loras }) })).json();
  assert.deepEqual(ok.folders, [loras]);
  const scan = await (await fetch(base + '/api/loras?path=' + encodeURIComponent(loras))).json();
  assert.deepEqual(scan.models, []);
  const del = await (await fetch(base + '/api/folders?folder=' + encodeURIComponent(loras), { method: 'DELETE' })).json();
  assert.deepEqual(del.folders, []);
});

test('strip save endpoint needs the app header and writes the file', async () => {
  const pngBytes = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), Buffer.alloc(20)]);
  const out = path.join(dir, 'stripped');
  const url = `${base}/api/strip/save?folder=${encodeURIComponent(out)}&name=a.png`;
  const noHeader = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: pngBytes });
  assert.equal(noHeader.status, 415);
  const ok = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream', 'X-Lora-Studio': '1' }, body: pngBytes });
  const body = await ok.json();
  assert.equal(ok.status, 200);
  assert.equal(body.savedAs, path.join(out, 'a.png'));
  assert.deepEqual(await fs.readFile(body.savedAs), pngBytes);
});
