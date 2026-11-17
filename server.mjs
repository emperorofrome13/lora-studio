// LoRA Studio server: static files, the local LoRA library API and the
// Civitai proxy. Node built-ins only. Loopback only: it can list any folder.
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createLibrary } from './lib/library.mjs';
import { proxyCivitai, tokenInfo, setSavedToken, checkTokenFormat, testToken } from './lib/civitai.mjs';
import { createSettings } from './lib/settings.mjs';
import { pickFolder, listDir } from './lib/folders.mjs';
import { saveImage, readSaved, MAX_BYTES } from './lib/save.mjs';
import { createTester } from './lib/tester.mjs';

export const VERSION = '1.03';
const APP_DIR = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(APP_DIR, 'public');
const DATA = process.env.LORA_STUDIO_DATA || path.join(APP_DIR, 'data');

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json',
};
// frame-src: the Tester tab shows the local LoRA Tester app in a frame.
const CSP = "default-src 'self'; img-src 'self' https: data: blob:; media-src 'self' https: blob:; connect-src 'self'; "
  + "frame-src http://127.0.0.1:* http://localhost:*; "
  + "style-src 'self' 'unsafe-inline'; script-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'";

function json(res, code, data) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(JSON.stringify(data));
}

function readJsonBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (chunk) => { data += chunk; if (data.length > 1e6) req.destroy(); });
    req.on('end', () => { try { resolve(data ? JSON.parse(data) : {}); } catch { resolve({}); } });
    req.on('error', () => resolve({}));
  });
}

/** Whole request body as a Buffer, or null when it exceeds `limit`. */
function readRawBody(req, limit) {
  return new Promise((resolve) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { resolve(null); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', () => resolve(null));
  });
}

// Only answer requests addressed to this machine by name. Blocks DNS-rebinding
// pages from reading your folder listings through the browser.
const LOCAL_HOSTS = /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i;

async function serveStatic(pathname, res) {
  const rel = pathname === '/' ? 'index.html' : decodeURIComponent(pathname).replace(/^\/+/, '');
  const file = path.resolve(PUBLIC, rel);
  if (file !== PUBLIC && !file.startsWith(PUBLIC + path.sep)) return json(res, 403, { error: 'Forbidden' });
  try {
    if (!(await fs.stat(file)).isFile()) return json(res, 404, { error: 'Not found' });
    const body = await fs.readFile(file);
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-cache', 'Content-Security-Policy': CSP });
    res.end(body);
  } catch {
    json(res, 404, { error: 'Not found' });
  }
}

export function createServer(library, tester = null, settings = null) {
  return http.createServer(async (req, res) => {
    try {
      if (!LOCAL_HOSTS.test(req.headers.host || '')) return json(res, 403, { error: 'Local access only' });
      const url = new URL(req.url, 'http://localhost');
      const p = url.pathname;

      if (req.method !== 'GET' && req.method !== 'POST' && req.method !== 'DELETE') return json(res, 405, { error: 'Method not allowed' });
      // State-changing requests must be JSON or carry the app's own header. Both force a
      // CORS preflight from other websites, which this server never approves.
      if (req.method === 'POST' && !String(req.headers['content-type'] || '').includes('application/json')
        && req.headers['x-lora-studio'] !== '1') {
        return json(res, 415, { error: 'Send JSON' });
      }

      // /api/files/save is the same never-overwrite writer, used by Grid to copy picked files.
      if (p === '/api/strip/save' || p === '/api/files/save') {
        if (req.method !== 'POST' || req.headers['x-lora-studio'] !== '1') return json(res, 405, { error: 'POST from the app only' });
        const data = await readRawBody(req, MAX_BYTES);
        if (!data) return json(res, 413, { error: 'File is too large' });
        try {
          const savedAs = await saveImage(url.searchParams.get('folder'), url.searchParams.get('name'), data);
          return json(res, 200, { savedAs });
        } catch (e) {
          return json(res, e.status || 500, { error: e.status ? e.message : `Could not save: ${e.message}` });
        }
      }

      if (p === '/api/files/read') {
        if (req.method !== 'GET') return json(res, 405, { error: 'GET only' });
        const data = await readSaved(url.searchParams.get('path')).catch(() => null);
        if (!data) return json(res, 404, { error: 'Only files saved by this app since it started can be read back' });
        res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
        return res.end(data);
      }

      if (p.startsWith('/api/tester/')) {
        if (!tester) return json(res, 503, { error: 'LoRA Tester integration is not available' });
        try {
          if (p === '/api/tester/status' && req.method === 'GET') return json(res, 200, await tester.status());
          // Start returns at once; setup can take a minute, and the page polls /status meanwhile.
          if (p === '/api/tester/start' && req.method === 'POST') { tester.start().catch(() => {}); await new Promise((r) => setTimeout(r, 150)); return json(res, 200, await tester.status()); }
          if (p === '/api/tester/stop' && req.method === 'POST') { await tester.stop(); return json(res, 200, await tester.status()); }
          if (p === '/api/tester/folder' && req.method === 'POST') return json(res, 200, await tester.setFolder((await readJsonBody(req)).folder));
          if (p === '/api/tester/jobs' && req.method === 'GET') return json(res, 200, { jobs: await tester.jobs() });
          if (p === '/api/tester/job' && req.method === 'GET') return json(res, 200, { images: await tester.jobImages(url.searchParams.get('id')) });
          if (p === '/api/tester/image' && req.method === 'GET') {
            const data = await tester.readOutput(url.searchParams.get('path'));
            if (!data) return json(res, 404, { error: 'Image not found' });
            const ext = path.extname(url.searchParams.get('path')).toLowerCase();
            res.writeHead(200, { 'Content-Type': ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' : 'image/jpeg', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
            return res.end(data);
          }
        } catch (e) {
          return json(res, e.status || 500, { error: e.message, status: await tester.status().catch(() => null) });
        }
        return json(res, 404, { error: 'Unknown API route' });
      }

      if (p === '/api/pick-folder') {
        if (req.method !== 'POST') return json(res, 405, { error: 'POST only' });
        const body = await readJsonBody(req);
        const r = await pickFolder({ title: body.title, start: body.start });
        if (r.status === 'busy') return json(res, 409, { error: 'A folder window is already open. Finish choosing there first.' });
        return json(res, 200, r);
      }
      if (p === '/api/browse') {
        if (req.method !== 'GET') return json(res, 405, { error: 'GET only' });
        try { return json(res, 200, await listDir(url.searchParams.get('path') || '')); } catch (e) { return json(res, e.status || 500, { error: e.message }); }
      }

      if (p === '/api/settings/civitai') {
        if (req.method === 'GET') return json(res, 200, tokenInfo());
        if (req.method !== 'POST') return json(res, 405, { error: 'GET or POST only' });
        if (!settings) return json(res, 503, { error: 'Settings are not available' });
        const token = String((await readJsonBody(req)).token ?? '').trim();
        if (!token) { // remove the saved key
          await settings.set('civitaiToken', undefined);
          setSavedToken('');
          return json(res, 200, { ...tokenInfo(), message: 'Saved key removed.' });
        }
        const bad = checkTokenFormat(token);
        if (bad) return json(res, 400, { error: bad });
        const check = await testToken(token);
        if (check === 'rejected') return json(res, 400, { error: 'Civitai rejected this key. Copy it again from civitai.com → Account settings → API Keys.' });
        await settings.set('civitaiToken', token);
        setSavedToken(token);
        return json(res, 200, { ...tokenInfo(), message: check === 'ok' ? 'Key saved and accepted by Civitai.' : 'Key saved. Civitai could not be reached to confirm it right now.' });
      }

      if (p === '/api/health') {
        // copy: the app folder's name, so two installs side by side are easy to tell apart.
        return json(res, 200, { ok: true, app: 'lora-studio', version: VERSION, pid: process.pid, copy: path.basename(APP_DIR), tokenConfigured: tokenInfo().configured });
      }
      if (p === '/api/civitai/images' || p === '/api/civitai/models') {
        if (req.method !== 'GET') return json(res, 405, { error: 'GET only' });
        const r = await proxyCivitai(url);
        return json(res, r.status, r.body);
      }
      if (p === '/api/folders') {
        if (req.method === 'GET') return json(res, 200, { folders: library.folders });
        if (req.method === 'POST') {
          const body = await readJsonBody(req);
          if (!String(body.folder || '').trim()) return json(res, 400, { error: 'Missing "folder"' });
          try {
            const { folder, added } = await library.addFolder(body.folder);
            const scan = await library.scanFolder(folder);
            return json(res, 200, { folders: library.folders, saved: folder, added, models: scan.total });
          } catch (e) {
            return json(res, e.status || 500, { error: e.message });
          }
        }
        const raw = String(url.searchParams.get('folder') || '').trim();
        if (!raw) return json(res, 400, { error: 'Missing "folder"' });
        await library.removeFolder(raw);
        return json(res, 200, { folders: library.folders });
      }
      if (p === '/api/loras') {
        const dir = url.searchParams.get('path');
        if (!dir) return json(res, 400, { error: 'Missing "path"' });
        const stat = await fs.stat(path.resolve(dir)).catch(() => null);
        if (!stat || !stat.isDirectory()) return json(res, 404, { error: 'Folder not found' });
        return json(res, 200, await library.scanFolder(dir));
      }
      if (p === '/api/loras/status') return json(res, 200, library.status());
      if (p.startsWith('/api/')) return json(res, 404, { error: 'Unknown API route' });

      if (req.method !== 'GET') return json(res, 405, { error: 'GET only' });
      return serveStatic(p, res);
    } catch (err) {
      if (!res.headersSent) json(res, 500, { error: 'Internal server error' });
      else res.end();
    }
  });
}

async function main() {
  const library = createLibrary({ dataDir: DATA });
  await library.load();
  const settings = createSettings(DATA);
  await settings.load();
  setSavedToken(settings.get('civitaiToken'));
  const tester = createTester({ appDir: APP_DIR, dataDir: DATA, settings });
  const server = createServer(library, tester, settings);
  const port = Number(process.env.PORT) || 4400;
  const host = process.env.HOST || '127.0.0.1';
  server.listen(port, host, () => console.log(`LoRA Studio v${VERSION} running at http://${host}:${port}`));
  server.on('error', (e) => { console.error(`Could not start LoRA Studio: ${e.message}`); process.exit(1); });
  // Record LoRAs added since the last run, without delaying startup.
  library.startupScan().catch((e) => console.error(`[startup] scan failed: ${e.message}`));
  const shutdown = () => library.flush().finally(() => process.exit(0));
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
