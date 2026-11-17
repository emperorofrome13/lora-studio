// LoRA Tester integration: finds the LoRA Tester app (Python/Flask), sets up its
// private Python environment on first use, starts and stops it, and reads its
// finished test runs so their images can be loaded into the Grid tab.
//
// Where the tester lives, first match wins:
//   1. LORA_TESTER_DIR environment variable
//   2. "testerDir" in data/settings.json (set from the Tester tab)
//   3. the "tester" folder next to server.mjs (bundled copy)
import { spawn, execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import { existsSync, openSync, closeSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { createSettings } from './settings.mjs';

const WIN = process.platform === 'win32';
const DEFAULT_PORT = 8795;
const MAX_LOG = 60;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function run(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    execFile(cmd, args, { windowsHide: true, timeout: opts.timeout || 20000, ...opts }, (err, stdout, stderr) => {
      resolve({ ok: !err, code: err ? err.code : 0, stdout: String(stdout || ''), stderr: String(stderr || '') });
    });
  });
}

export function createTester({ appDir, dataDir, settings: store = createSettings(dataDir) }) {
  let state = 'unknown';      // installing | starting | failed (while we work); otherwise derived
  let log = [];
  let busy = null;            // promise of the current start

  const note = (line) => {
    for (const l of String(line).split(/\r?\n/)) if (l.trim()) log.push(l.trimEnd());
    if (log.length > MAX_LOG) log = log.slice(-MAX_LOG);
  };

  const loadSettings = () => store.load();

  const dir = () => path.resolve(process.env.LORA_TESTER_DIR || store.get('testerDir') || path.join(appDir, 'tester'));
  const venvPython = () => path.join(dir(), '.venv', WIN ? 'Scripts' : 'bin', WIN ? 'python.exe' : 'python');
  const isTester = (d) => existsSync(path.join(d, 'app', 'server.py')) && existsSync(path.join(d, 'app', 'jobs.py'));

  async function serverRecord() {
    try { return JSON.parse(await fs.readFile(path.join(dir(), 'data', 'server.json'), 'utf8')); } catch { return null; }
  }

  async function health(port) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(1500) });
      if (!r.ok) return null;
      const body = await r.json();
      return body && body.ok ? body : null;
    } catch { return null; }
  }

  const alive = (pid) => {
    if (!pid) return false;
    try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
  };

  /** First port from `start` that nothing listens on (exclusive test bind). */
  function freePort(start) {
    return new Promise((resolve, reject) => {
      const tryPort = (p) => {
        if (p >= start + 30) { reject(new Error(`No free port between ${start} and ${start + 29}.`)); return; }
        const probe = net.createServer();
        probe.once('error', () => tryPort(p + 1));
        probe.listen({ port: p, host: '127.0.0.1', exclusive: true }, () => probe.close(() => resolve(p)));
      };
      tryPort(start);
    });
  }

  /** The running tester, if any: { port, url, version, pid }. */
  async function running() {
    const rec = await serverRecord();
    if (!rec || !rec.port) return null;
    // The process in this folder's record must be alive, or another app on that port could answer.
    if (!alive(rec.pid)) return null;
    const h = await health(rec.port);
    return h ? { port: rec.port, url: `http://127.0.0.1:${rec.port}`, version: h.version, pid: rec.pid } : null;
  }

  async function activeJob(url) {
    try {
      // Short timeout: the tester's first status call can be slow, and this is only a hint.
      const r = await fetch(`${url}/api/status`, { signal: AbortSignal.timeout(1500) });
      const body = await r.json();
      return body.active_job_id || null;
    } catch { return null; }
  }

  async function status() {
    const d = dir();
    const found = isTester(d);
    const live = found ? await running() : null;
    let current = state;
    if (live) current = 'running';
    else if (!['installing', 'starting', 'failed'].includes(state)) current = found ? 'stopped' : 'missing';
    return {
      dir: d,
      source: process.env.LORA_TESTER_DIR ? 'env' : store.get('testerDir') ? 'settings' : 'bundled',
      found,
      venv: found && existsSync(venvPython()),
      state: current,
      url: live ? live.url : null,
      version: live ? live.version : null,
      activeJob: live ? await activeJob(live.url) : null,
      log: log.slice(-25),
    };
  }

  async function findPython() {
    const candidates = WIN
      ? [['py', ['-3.12']], ['py', ['-3.13']], ['py', ['-3.11']], ['py', ['-3']], ['python', []]]
      : [['python3', []], ['python', []]];
    for (const [cmd, pre] of candidates) {
      const r = await run(cmd, [...pre, '-c', 'import sys; print(sys.version_info >= (3, 10))']);
      if (r.ok && r.stdout.trim() === 'True') return [cmd, pre];
    }
    return null;
  }

  async function ensureEnv() {
    const py = venvPython();
    if (!existsSync(py)) {
      state = 'installing';
      note('Creating the private Python environment (.venv)…');
      const base = await findPython();
      if (!base) throw new Error('Python 3.10 or newer was not found. Install it from https://www.python.org (tick "Add python.exe to PATH"), then press Start again.');
      const r = await run(base[0], [...base[1], '-m', 'venv', path.join(dir(), '.venv')], { timeout: 180000 });
      if (!r.ok || !existsSync(py)) throw new Error(`Could not create the Python environment: ${(r.stderr || r.stdout).trim().slice(-400)}`);
    }
    const check = await run(py, ['-c', 'import flask, PIL']);
    if (!check.ok) {
      state = 'installing';
      note('Installing Flask and Pillow (one time, about a minute)…');
      const r = await run(py, ['-m', 'pip', 'install', '--disable-pip-version-check', '-r', path.join(dir(), 'requirements.txt')], { timeout: 600000, cwd: dir() });
      note(r.stdout.split(/\r?\n/).filter((l) => /Successfully|ERROR|error/i.test(l)).join('\n'));
      if (!r.ok) throw new Error(`Installing the Python packages failed: ${(r.stderr || r.stdout).trim().slice(-400)}`);
    }
    return py;
  }

  async function doStart() {
    const d = dir();
    if (!isTester(d)) throw new Error(`LoRA Tester was not found in ${d}`);
    const live = await running();
    if (live) return live;
    log = [];
    const py = await ensureEnv();
    state = 'starting';
    note('Starting LoRA Tester…');
    mkdirSync(path.join(d, 'logs'), { recursive: true });
    const out = openSync(path.join(d, 'logs', 'server.log'), 'a');
    const err = openSync(path.join(d, 'logs', 'server.err'), 'a');
    // Detached: a long test keeps running even when LoRA Studio is restarted.
    // Pick the port here: Node's probe is exclusive, so it never lands on a port another
    // LoRA Tester (for example a separate install) is already serving.
    const port = await freePort(DEFAULT_PORT);
    const child = spawn(py, ['-m', 'app.server', '--no-browser', '--port', String(port)], {
      cwd: d, detached: true, windowsHide: true, stdio: ['ignore', out, err],
    });
    closeSync(out); closeSync(err);
    let spawnError = null;
    child.on('error', (e) => { spawnError = e; });
    child.unref();
    const deadline = Date.now() + 60000;
    while (Date.now() < deadline) {
      if (spawnError) throw spawnError;
      if (child.exitCode !== null) break;
      const now = await running();
      if (now && now.pid === child.pid && now.port === port) { note(`LoRA Tester v${now.version} is running at ${now.url}`); return now; }
      await sleep(400);
    }
    let tail = '';
    try { tail = (await fs.readFile(path.join(d, 'logs', 'server.err'), 'utf8')).split(/\r?\n/).slice(-12).join('\n'); } catch { /* no log */ }
    try { process.kill(child.pid); } catch { /* already gone */ }
    throw new Error(`LoRA Tester did not start within 60 seconds.${tail ? `\n${tail}` : ''}`);
  }

  async function start() {
    if (busy) return busy;
    state = 'starting';
    busy = doStart()
      .then((r) => { state = 'unknown'; return r; })
      .catch((e) => { state = 'failed'; note(e.message); throw e; })
      .finally(() => { busy = null; });
    return busy;
  }

  async function stop() {
    const live = await running();
    if (!live) return { stopped: false, message: 'LoRA Tester is not running.' };
    if (!live.pid) throw new Error('The running LoRA Tester did not record its process ID, so it was left running. Close it with its own stop.bat.');
    try { process.kill(live.pid); } catch (e) { if (e.code !== 'ESRCH') throw e; }
    for (let i = 0; i < 20 && (await health(live.port)); i++) await sleep(250);
    await fs.rm(path.join(dir(), 'data', 'server.json'), { force: true });
    state = 'unknown';
    note('LoRA Tester stopped.');
    return { stopped: true };
  }

  async function setFolder(raw) {
    const text = String(raw || '').trim();
    if (!text) { await store.set('testerDir', undefined); return status(); }
    if (!path.isAbsolute(text)) throw Object.assign(new Error('Use a full folder path, like D:\\apps\\Lora tester'), { status: 400 });
    const d = path.resolve(text);
    if (!isTester(d)) throw Object.assign(new Error('That folder does not contain LoRA Tester (app\\server.py was not found).'), { status: 400 });
    await store.set('testerDir', d);
    state = 'unknown';
    return status();
  }

  /** Finished or partly finished runs that produced images, newest first. */
  async function jobs() {
    const jobDir = path.join(dir(), 'data', 'jobs');
    let names = [];
    try { names = (await fs.readdir(jobDir)).filter((n) => /^[\w-]+\.json$/.test(n)); } catch { return []; }
    const list = [];
    for (const n of names) {
      try {
        const j = JSON.parse(await fs.readFile(path.join(jobDir, n), 'utf8'));
        const results = Array.isArray(j.results) ? j.results.filter((r) => r && typeof r.rel_path === 'string') : [];
        if (!results.length) continue;
        list.push({
          id: String(j.id || n.replace(/\.json$/, '')), status: j.status || '', created: j.created_at || '',
          model: String(j.checkpoint || j.model_id || '').replace(/^unet::|^gguf::/, ''), images: results.length,
          loras: [...new Set(results.map((r) => r.lora_name).filter(Boolean))],
        });
      } catch { /* unreadable job file */ }
    }
    return list.sort((a, b) => String(b.created).localeCompare(String(a.created)));
  }

  async function jobImages(id) {
    if (!/^[\w-]+$/.test(String(id || ''))) throw Object.assign(new Error('Bad job id'), { status: 400 });
    const j = JSON.parse(await fs.readFile(path.join(dir(), 'data', 'jobs', `${id}.json`), 'utf8'));
    return (j.results || []).filter((r) => r && typeof r.rel_path === 'string').map((r) => ({ path: r.rel_path, name: r.filename || path.basename(r.rel_path), lora: r.lora_name, strength: r.strength }));
  }

  /** One output image, only from inside the tester's output folder. */
  async function readOutput(rel) {
    const base = path.join(dir(), 'output');
    const file = path.resolve(base, String(rel || ''));
    if (!file.startsWith(base + path.sep) || !/\.(png|jpe?g|webp)$/i.test(file)) return null;
    try { return await fs.readFile(file); } catch { return null; }
  }

  return { loadSettings, status, start, stop, setFolder, jobs, jobImages, readOutput };
}
