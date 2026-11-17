// Start LoRA Studio in the background, wait until it answers, open the browser.
// Usage: node launch.mjs [--no-browser]
import { spawn } from 'node:child_process';
import { openSync, closeSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import net from 'node:net';
import { homedir } from 'node:os';

const root = dirname(fileURLToPath(import.meta.url));
const pidFile = join(root, '.server.json');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const firstPort = Number(process.env.LORA_STUDIO_PORT) || 4400;

async function health(port) {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(2000) });
    return r.ok ? await r.json() : null;
  } catch { return null; }
}

const portFree = (port) => new Promise((resolve) => {
  const probe = net.createServer();
  probe.once('error', () => resolve(false));
  probe.listen(port, '127.0.0.1', () => probe.close(() => resolve(true)));
});

/** A command that opens `url` in Google Chrome (or Chromium on Linux), or null when not installed. */
function chromeCommand(url) {
  if (process.platform === 'win32') {
    const roots = [process.env.PROGRAMFILES, process.env['PROGRAMFILES(X86)'], process.env.LOCALAPPDATA].filter(Boolean);
    const exe = roots.map((r) => join(r, 'Google', 'Chrome', 'Application', 'chrome.exe')).find((p) => existsSync(p));
    return exe ? [exe, [url]] : null;
  }
  if (process.platform === 'darwin') {
    const app = ['/Applications/Google Chrome.app', join(homedir(), 'Applications', 'Google Chrome.app')].find((p) => existsSync(p));
    return app ? ['open', ['-a', app, url]] : null;
  }
  const dirs = String(process.env.PATH || '').split(':').filter(Boolean);
  for (const name of ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser']) {
    const exe = dirs.map((d) => join(d, name)).find((p) => existsSync(p));
    if (exe) return [exe, [url]];
  }
  return null;
}

function defaultBrowserCommand(url) {
  if (process.platform === 'win32') return ['cmd.exe', ['/d', '/c', 'start', '', url]];
  if (process.platform === 'darwin') return ['open', [url]];
  return ['xdg-open', [url]];
}

// Opens in Google Chrome when it is installed, otherwise in the default browser.
function openBrowser(url) {
  if (process.argv.includes('--no-browser')) return;
  const chrome = chromeCommand(url);
  const [cmd, args] = chrome || defaultBrowserCommand(url);
  console.log(chrome ? '      Opening in Google Chrome.' : '      Google Chrome was not found; opening your default browser.');
  const b = spawn(cmd, args, { windowsHide: !chrome, detached: true, stdio: 'ignore' });
  b.on('error', () => console.log(`      Open ${url} in your browser.`));
  b.unref();
}

async function launch() {
  console.log('[1/3] Checking Node.js...');
  if (Number(process.versions.node.split('.')[0]) < 20) throw new Error('Install Node.js 20 or newer from https://nodejs.org, then retry.');

  // Already running from an earlier launch?
  try {
    const saved = JSON.parse(readFileSync(pidFile, 'utf8'));
    const status = await health(saved.port);
    if (status?.app === 'lora-studio' && status.pid === saved.pid) {
      const url = `http://127.0.0.1:${saved.port}`;
      console.log(`[2/3] LoRA Studio is already running at ${url}.`);
      openBrowser(url);
      console.log('[3/3] Ready.');
      return;
    }
  } catch { /* not running */ }

  let port = firstPort;
  while (!(await portFree(port))) {
    if (port - firstPort >= 20) throw new Error(`No free port between ${firstPort} and ${port}.`);
    console.log(`      port ${port} is busy, trying ${port + 1}`);
    port++;
  }

  mkdirSync(join(root, 'logs'), { recursive: true });
  const out = openSync(join(root, 'logs', 'server.log'), 'a');
  const err = openSync(join(root, 'logs', 'server-error.log'), 'a');
  const child = spawn(process.execPath, [join(root, 'server.mjs')], {
    cwd: root, detached: true, windowsHide: true, stdio: ['ignore', out, err],
    env: { ...process.env, HOST: '127.0.0.1', PORT: String(port) },
  });
  closeSync(out); closeSync(err);
  let spawnError = null;
  child.on('error', (e) => { spawnError = e; });

  const deadline = Date.now() + 15000;
  let status = null;
  while (Date.now() < deadline) {
    if (spawnError) throw spawnError;
    status = await health(port);
    if (status?.app === 'lora-studio' && status.pid === child.pid) break;
    if (child.exitCode !== null) throw new Error('Server stopped. Read logs/server-error.log for details.');
    await sleep(200);
  }
  if (status?.pid !== child.pid) {
    child.kill();
    throw new Error('Server did not become ready within 15 seconds. Read logs/server-error.log and retry.');
  }
  writeFileSync(pidFile, JSON.stringify({ pid: child.pid, port }));
  child.unref();
  const url = `http://127.0.0.1:${port}`;
  console.log(`[2/3] LoRA Studio v${status.version} started at ${url} (PID ${child.pid}).`);
  openBrowser(url);
  console.log(`[3/3] Ready. Use stop.bat to stop the server.`);
}

launch().catch((e) => { console.error('Could not start LoRA Studio: ' + e.message); process.exitCode = 1; });
