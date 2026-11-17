// v1.02: Civitai API key setting (never echoed back) and the shared settings store.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createServer } from '../server.mjs';
import { createLibrary } from '../lib/library.mjs';
import { createSettings } from '../lib/settings.mjs';
import { createTester } from '../lib/tester.mjs';
import { tokenInfo, setSavedToken, checkTokenFormat } from '../lib/civitai.mjs';

const FAKE = 'abcdef0123456789abcdef0123456789';

test('key format check', () => {
  assert.match(checkTokenFormat(''), /Paste/);
  assert.match(checkTokenFormat('short'), /wrong length/);
  assert.match(checkTokenFormat('has spaces in it 0123456789'), /letters and numbers/);
  assert.equal(checkTokenFormat(FAKE), null);
});

test('tokenInfo reveals only whether a key is set and its last 4 characters', () => {
  const env = process.env.CIVITAI_TOKEN;
  delete process.env.CIVITAI_TOKEN;
  try {
    setSavedToken('');
    assert.deepEqual(tokenInfo(), { configured: false, source: null, hint: '' });
    setSavedToken(FAKE);
    assert.deepEqual(tokenInfo(), { configured: true, source: 'saved', hint: '…6789' });
    process.env.CIVITAI_TOKEN = 'zzzzzzzzzzzzzzzzzzzzenv1';
    assert.equal(tokenInfo().source, 'env', 'the environment variable wins');
  } finally {
    setSavedToken('');
    if (env === undefined) delete process.env.CIVITAI_TOKEN; else process.env.CIVITAI_TOKEN = env;
  }
});

test('settings store is shared: saving the key keeps the tester folder and vice versa', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ls-set-'));
  try {
    const s = createSettings(dir);
    await s.load();
    await s.set('testerDir', 'X:\\somewhere');
    await s.set('civitaiToken', FAKE);
    const again = createSettings(dir);
    await again.load();
    assert.equal(again.get('testerDir'), 'X:\\somewhere');
    assert.equal(again.get('civitaiToken'), FAKE);
    await again.set('civitaiToken', undefined);
    assert.deepEqual(JSON.parse(await fs.readFile(path.join(dir, 'settings.json'), 'utf8')), { testerDir: 'X:\\somewhere' });
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('server: key routes never return the key, reject bad input, and can remove it', async () => {
  const env = process.env.CIVITAI_TOKEN;
  delete process.env.CIVITAI_TOKEN;
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ls-key-'));
  const settings = createSettings(path.join(dir, 'data'));
  await settings.load();
  const lib = createLibrary({ dataDir: path.join(dir, 'data'), lookup: async () => ({ found: false }), delayMs: 0, log: () => {} });
  await lib.load();
  const server = createServer(lib, createTester({ appDir: dir, dataDir: path.join(dir, 'data'), settings }), settings);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (body, headers = { 'Content-Type': 'application/json' }) => fetch(base + '/api/settings/civitai', { method: 'POST', headers, body: JSON.stringify(body) });
  try {
    // A key saved earlier (simulated) is reported by hint only.
    await settings.set('civitaiToken', FAKE);
    setSavedToken(FAKE);
    const info = await (await fetch(base + '/api/settings/civitai')).text();
    assert.ok(!info.includes(FAKE), 'GET must not contain the key');
    assert.match(info, /…6789/);
    const health = await (await fetch(base + '/api/health')).text();
    assert.ok(!health.includes(FAKE) && /"tokenConfigured":true/.test(health));
    // Bad shape: refused without contacting Civitai.
    const bad = await post({ token: 'nope' });
    assert.equal(bad.status, 400);
    // Other websites cannot change it (non-JSON POST is refused).
    assert.equal((await post({ token: '' }, { 'Content-Type': 'text/plain' })).status, 415);
    // Remove.
    const removed = await (await post({ token: '' })).json();
    assert.equal(removed.configured, false);
    assert.equal(settings.get('civitaiToken'), undefined);
  } finally {
    setSavedToken('');
    if (env !== undefined) process.env.CIVITAI_TOKEN = env;
    await new Promise((r) => server.close(r));
    await fs.rm(dir, { recursive: true, force: true });
  }
});
