// Build a clean, shareable copy of LoRA Studio (for GitHub or anyone else).
//
//   node tools/export-public.mjs [target-folder]
//
// Default target: a "lora-studio-public" folder next to this project.
// - Copies only an allowlist of app files: no data/, logs/, caches, backups,
//   saved folders, LoRA cache, launcher records or test images.
// - Bundles LoRA Tester's code (app/, tests/, requirements.txt) into tester/,
//   without its data, output, logs, virtual environment or notes.
// - Scans every exported file for personal strings (your user name, home
//   folder, project folders, saved LoRA folders, ComfyUI paths) and fails
//   loudly if any are found.
// Re-running updates the export in place and keeps a .git folder if you made one.
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TARGET = path.resolve(process.argv[2] || path.join(path.dirname(ROOT), 'lora-studio-public'));
const MARKER = '.lora-studio-export';

const STUDIO_FILES = ['server.mjs', 'launch.mjs', 'stop.mjs', 'quickstart.bat', 'stop.bat', 'start.sh', 'stop.sh', 'package.json'];
const STUDIO_DIRS = ['public', 'lib', 'tests'];
const SKIP = new Set(['_verify', 'node_modules', '__pycache__', '.pytest_cache', '.DS_Store', 'Thumbs.db']);

async function readJson(file) { try { return JSON.parse(await fs.readFile(file, 'utf8')); } catch { return null; } }

async function testerSource() {
  const settings = await readJson(path.join(ROOT, 'data', 'settings.json'));
  for (const d of [process.env.LORA_TESTER_DIR, settings && settings.testerDir, path.join(ROOT, 'tester')]) {
    if (d && existsSync(path.join(d, 'app', 'server.py'))) return path.resolve(d);
  }
  return null;
}

async function copyTree(src, dest) {
  await fs.mkdir(dest, { recursive: true });
  for (const entry of await fs.readdir(src, { withFileTypes: true })) {
    if (SKIP.has(entry.name) || entry.name.endsWith('.pyc')) continue;
    const s = path.join(src, entry.name), d = path.join(dest, entry.name);
    if (entry.isDirectory()) await copyTree(s, d);
    else if (entry.isFile()) await fs.copyFile(s, d);
  }
}

async function listFiles(dir) {
  const out = [];
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    if (entry.name === '.git') continue;
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...await listFiles(p));
    else out.push(p);
  }
  return out;
}

/** Strings that would identify this machine or its owner. */
async function personalMarkers(testerDir) {
  const raw = new Set();
  const user = os.userInfo().username;
  if (user && user.length >= 3) raw.add(user);
  raw.add(os.homedir());
  raw.add(path.dirname(ROOT));                       // the folder that holds your projects
  raw.add(ROOT);
  if (testerDir) raw.add(testerDir);
  const folders = await readJson(path.join(ROOT, 'data', 'folders.json'));
  for (const f of (Array.isArray(folders) ? folders : folders && folders.folders) || []) raw.add(String(f));
  const tcfg = testerDir && await readJson(path.join(testerDir, 'data', 'config.json'));
  if (tcfg && tcfg.loras_dir) raw.add(String(tcfg.loras_dir));
  // Your Civitai API key (saved in the app or set in the environment) must never ship.
  const settings = await readJson(path.join(ROOT, 'data', 'settings.json'));
  if (settings && settings.civitaiToken) raw.add(String(settings.civitaiToken));
  if (process.env.CIVITAI_TOKEN) raw.add(process.env.CIVITAI_TOKEN);
  // Your personal git email (commits to the public repo should use GitHub's noreply address).
  try {
    const email = execFileSync('git', ['config', '--global', 'user.email'], { encoding: 'utf8', windowsHide: true }).trim();
    if (email && !/noreply/i.test(email)) raw.add(email);
  } catch { /* git not installed or no email set */ }
  const variants = new Set();
  for (const m of raw) {
    const s = String(m || '').trim();
    if (s.length < 3) continue;
    variants.add(s.toLowerCase());
    variants.add(s.replace(/\\/g, '/').toLowerCase());
    variants.add(s.replace(/\\/g, '\\\\').toLowerCase());
  }
  return [...variants];
}

const README = `# LoRA Studio

A local, private toolbox for people who make images with Stable Diffusion / ComfyUI and collect LoRAs.
Everything runs on your own computer; images you drop in are read in the browser and never uploaded.

| Tab | What it does |
|---|---|
| **My LoRAs** | Browse folders of \`.safetensors\` LoRAs: title, trigger words, base model, Civitai match and preview. Saved folders are re-checked for new files on every start. |
| **Civitai** | Browse civitai.com images, filter for ones with real ComfyUI workflows, search models, save favourites, block uploaders. |
| **Prompt** | Drop or paste an image to read its prompt, negative prompt, LoRAs and settings (A1111, ComfyUI, EXIF, XMP). |
| **Grid** | Contact sheet of your images grouped by generation settings, the LoRA strength grid (grid / flip / side-by-side / wipe), and **picks**: click ♥ on the images you like to see them together as one tight cube grid, then ★ the best ones as finalists. Export the cube as a PNG or copy the files to a folder. |
| **Strip** | Save copies of images with **all** metadata removed (prompts, workflows, EXIF, XMP, IPTC, hidden data) without re-compressing. Every saved file is read back from disk and checked, and a **Double-check** panel audits any image you drop on it. |
| **Workflow** | Drop a pile of images and see which ones carry a ComfyUI workflow. Preview the node graph (pan, zoom, search, click a node for its values) and download the workflow \`.json\`. |
| **Tester** | Runs the bundled **LoRA Tester**: imports LoRAs, runs each through a strength matrix on your ComfyUI models, labels every image, and sends finished runs straight to the Grid's strength grid. |

## Requirements

- **Windows 10/11, macOS or Linux** with a desktop.
- **Node.js 20 or newer** — https://nodejs.org. No \`npm install\` needed: it uses Node's built-in modules only.
- For the **Tester** tab only: **Python 3.10+** (https://www.python.org; on Windows tick *Add python.exe to PATH*) and **ComfyUI** running locally (usually \`http://127.0.0.1:8188\`).
- Linux only, for the folder window: \`zenity\` (GNOME and most desktops) or \`kdialog\` (KDE). Without either, the app opens its own built-in folder browser instead.

## Start

1. Download or clone this folder.
2. Start it:
   - **Windows:** double-click **\`quickstart.bat\`**.
   - **macOS / Linux:** open a terminal in this folder and run \`sh start.sh\`.
3. It starts the server in the background and opens http://127.0.0.1:4400 (or the next free port) in Google Chrome, or in your default browser when Chrome is not installed.
4. To stop it: **\`stop.bat\`** on Windows, \`sh stop.sh\` on macOS / Linux.

Command line alternative on any system: \`npm start\`, then open http://127.0.0.1:4400.

## Choosing folders

You never have to type a path. **📁 Choose LoRA folder…** (My LoRAs), **📁 Browse…** (Strip, Grid, Tester) open your system's own folder window — Explorer on Windows, Finder on macOS, zenity/kdialog on Linux — and the chosen folder is filled in for you. Typing or pasting a path still works too.

The first time you press **Start LoRA Tester**, the app creates a private Python environment in \`tester/.venv\` and installs Flask and Pillow (about a minute). After that it starts in seconds. LoRA Tester keeps running when LoRA Studio stops, so a long test is not interrupted; stop it from the Tester tab.

### Civitai API key (optional)

The Civitai tab works without an account. To use your own account's permissions (for example mature content on civitai.red), create a key at civitai.com → *Account settings* → *API Keys*, then paste it into **CIVITAI API KEY** in the Civitai tab's sidebar and press **Save**. The app checks it with Civitai once, then keeps it only on your computer in \`data/settings.json\` (git-ignored). It is never shown again and never sent anywhere except civitai.com. **Remove saved key** deletes it.

Advanced: a \`CIVITAI_TOKEN\` environment variable, if set, is used instead of the saved key.

## Keys

\`1\`–\`7\` switch tabs. Grid: \`F\` expanded view, arrows step through images; in the image viewer \`P\` picks and \`S\` marks a finalist. Civitai: \`Ctrl+K\` search. Workflow: \`0\` fits the graph.

## Privacy and safety

- The server listens on \`127.0.0.1\` only and refuses requests whose Host header is not local.
- Images dropped into Prompt, Grid, Strip and Workflow are read inside your browser. Nothing is uploaded.
- Your LoRA files are only read, never modified. Saving (Strip, Grid "Copy files") never overwrites: an existing name gets " (1)" added.
- Your settings live in \`data/\` and \`tester/data/\`, which are not part of the repository (see \`.gitignore\`).

## Tests

\`\`\`
npm test
\`\`\`

LoRA Tester's own tests (after its first start created \`tester/.venv\`):

\`\`\`
cd tester
.venv\\Scripts\\python.exe -m unittest discover -s tests
\`\`\`

## License

MIT — see [LICENSE](LICENSE). LoRA Studio is not affiliated with Civitai or ComfyUI.

## Layout

\`\`\`
server.mjs          HTTP server: static files and the /api routes
lib/                LoRA library, Civitai proxy, safe file saving, LoRA Tester manager
public/             the web app (one module per tab in public/js)
tester/             LoRA Tester (Python + Flask), started on demand from the Tester tab
tests/              node --test suites
launch.mjs/stop.mjs used by quickstart.bat / stop.bat (Windows) and start.sh / stop.sh (macOS, Linux)
\`\`\`
`;

const LICENSE = `MIT License

Copyright (c) 2026 The LoRA Studio authors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
`;

const GITIGNORE = `# your own settings, caches and logs
data/
logs/
.server.json
node_modules/
# LoRA Tester runtime files
tester/.venv/
tester/data/
tester/output/
tester/logs/
__pycache__/
*.pyc
`;

/** Processes started from the export folder (its LoRA Studio server or its LoRA Tester). Windows only. */
function runningFrom(folder) {
  if (process.platform !== 'win32') return [];
  const script = "Get-CimInstance Win32_Process -Filter \"Name='node.exe' OR Name='python.exe'\" | ForEach-Object { \"$($_.ProcessId)`t$($_.ExecutablePath)`t$($_.CommandLine)\" }";
  let out = '';
  try { out = execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', windowsHide: true, timeout: 20000 }); } catch { return []; }
  const needle = folder.toLowerCase() + path.sep;
  return out.split(/\r?\n/).filter((l) => l.toLowerCase().includes(needle)).map((l) => l.split('\t').slice(0, 2).join(' '));
}

async function main() {
  const testerDir = await testerSource();
  // Replacing files under a running copy orphans it (its stop.bat record is deleted).
  const busy = runningFrom(TARGET);
  if (busy.length) {
    throw new Error(`the public copy is running. Close it first (stop.bat in ${TARGET}, and Stop in its Tester tab), then export again.\n  Running: ${busy.join('\n  Running: ')}`);
  }
  if (!testerDir) throw new Error('LoRA Tester was not found (set LORA_TESTER_DIR or choose its folder in the Tester tab).');
  if (TARGET === ROOT || TARGET.startsWith(ROOT + path.sep)) throw new Error('The export folder must be outside this project.');

  if (existsSync(TARGET)) {
    const entries = await fs.readdir(TARGET);
    const ours = entries.includes(MARKER);
    if (!ours && entries.some((e) => e !== '.git')) throw new Error(`${TARGET} already exists and is not an earlier export. Choose an empty or new folder.`);
    for (const e of entries) if (e !== '.git') await fs.rm(path.join(TARGET, e), { recursive: true, force: true });
  }
  await fs.mkdir(TARGET, { recursive: true });

  for (const f of STUDIO_FILES) await fs.copyFile(path.join(ROOT, f), path.join(TARGET, f));
  for (const d of STUDIO_DIRS) await copyTree(path.join(ROOT, d), path.join(TARGET, d));
  await fs.mkdir(path.join(TARGET, 'tools'), { recursive: true });
  await fs.copyFile(fileURLToPath(import.meta.url), path.join(TARGET, 'tools', 'export-public.mjs'));

  const t = path.join(TARGET, 'tester');
  await copyTree(path.join(testerDir, 'app'), path.join(t, 'app'));
  if (existsSync(path.join(testerDir, 'tests'))) await copyTree(path.join(testerDir, 'tests'), path.join(t, 'tests'));
  await fs.copyFile(path.join(testerDir, 'requirements.txt'), path.join(t, 'requirements.txt'));

  await fs.writeFile(path.join(TARGET, 'README.md'), README);
  await fs.writeFile(path.join(TARGET, '.gitignore'), GITIGNORE);
  await fs.writeFile(path.join(TARGET, 'LICENSE'), LICENSE);
  // Keep shell scripts on LF and batch files on CRLF whatever system clones the repository.
  await fs.writeFile(path.join(TARGET, '.gitattributes'), '*.sh text eol=lf\n*.bat text eol=crlf\n');
  await fs.writeFile(path.join(TARGET, MARKER), 'Created by tools/export-public.mjs. Safe to delete.\n');

  // Personal-data scan over every exported file.
  const markers = await personalMarkers(testerDir);
  const hits = [];
  const files = await listFiles(TARGET);
  for (const file of files) {
    const text = (await fs.readFile(file)).toString('latin1').toLowerCase();
    for (const m of markers) if (text.includes(m)) hits.push(`${path.relative(TARGET, file)}: contains "${m}"`);
  }
  if (hits.length) {
    console.error('Personal data found in the export. Nothing should be shared until this is fixed:');
    for (const h of hits) console.error(`  ${h}`);
    process.exitCode = 2;
    return;
  }
  console.log(`Exported ${files.length} files to ${TARGET}`);
  console.log(`Personal-data scan: clean (${markers.length} patterns checked against every file).`);
}

main().catch((e) => { console.error(`Export failed: ${e.message}`); process.exitCode = 1; });
