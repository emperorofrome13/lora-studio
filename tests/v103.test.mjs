// v1.03: folder choosing — the in-app folder browser listing and the picker routes' safety.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { listDir } from '../lib/folders.mjs';
import { createServer } from '../server.mjs';
import { createLibrary } from '../lib/library.mjs';

test('listDir: folders only, sorted naturally, hidden ones left out, with a parent', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ls-browse-'));
  try {
    for (const d of ['b', 'A', 'loras 10', 'loras 2', '.hidden']) await fs.mkdir(path.join(dir, d));
    await fs.writeFile(path.join(dir, 'file.txt'), 'x');
    const r = await listDir(dir);
    assert.equal(r.path, path.resolve(dir));
    assert.equal(r.parent, path.dirname(path.resolve(dir)));
    assert.deepEqual(r.dirs.map((d) => d.name), ['A', 'b', 'loras 2', 'loras 10']);
    assert.equal(r.dirs[0].path, path.join(path.resolve(dir), 'A'));
    assert.ok(r.roots.some((x) => x.name === 'Home'));
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('listDir: empty path lists the starting places; a missing folder is a clear 400', async () => {
  const top = await listDir('');
  assert.equal(top.path, '');
  assert.ok(top.dirs.length >= 1);
  await assert.rejects(listDir(path.join(os.tmpdir(), 'does-not-exist-ls-123')), (e) => e.status === 400 && /does not exist/.test(e.message));
});

test('server: browse route works; picker route needs a JSON POST (other sites cannot open it)', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ls-pick-'));
  const lib = createLibrary({ dataDir: path.join(dir, 'data'), lookup: async () => ({ found: false }), delayMs: 0, log: () => {} });
  await lib.load();
  const server = createServer(lib);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const b = await (await fetch(`${base}/api/browse?path=${encodeURIComponent(dir)}`)).json();
    assert.deepEqual(b.dirs.map((d) => d.name), ['data']);
    assert.equal((await fetch(`${base}/api/pick-folder`)).status, 405);
    assert.equal((await fetch(`${base}/api/pick-folder`, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: '{}' })).status, 415);
    // fetch ignores a custom Host header, so send this one with node:http.
    const http = await import('node:http');
    const status = await new Promise((resolve, reject) => {
      http.get({ host: '127.0.0.1', port: server.address().port, path: '/api/browse', headers: { Host: 'evil.example.com' } }, (r) => { r.resume(); resolve(r.statusCode); }).on('error', reject);
    });
    assert.equal(status, 403, 'DNS-rebinding pages cannot list folders');
  } finally {
    await new Promise((r) => server.close(r));
    await fs.rm(dir, { recursive: true, force: true });
  }
});
