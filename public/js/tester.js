// Tester tab: start / attach to the local LoRA Tester app, show it inside the
// studio, and send finished test runs to the Grid tab's strength grid.
import { app, fetchJson, escapeHtml, chooseFolder } from './app.js';

const $ = (id) => document.getElementById(`ts-${id}`);
let status = null;
let pollTimer = 0;
let frameUrl = '';
let jobs = [];

const post = (url, body = {}) => fetchJson(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

function folderForm(message) {
  return `<p>${message}</p>
    <div class="ts-folder"><button class="ui-btn primary" type="button" id="ts-folderBrowse">📁 Browse…</button><input class="ui-input" type="text" id="ts-folderInput" placeholder="or type the LoRA Tester folder" autocomplete="off" value="${escapeHtml(status && status.source !== 'bundled' ? status.dir : '')}">
    <button class="ui-btn" type="button" id="ts-folderSave">Use this folder</button></div>`;
}

function wireFolderForm() {
  const save = document.getElementById('ts-folderSave');
  if (save) save.onclick = saveFolder;
  const browse = document.getElementById('ts-folderBrowse');
  if (browse) browse.onclick = async () => {
    const input = document.getElementById('ts-folderInput');
    const folder = await chooseFolder({ title: 'Choose the LoRA Tester folder', start: input.value.trim() });
    if (folder) { input.value = folder; saveFolder(); }
  };
}

function draw() {
  const s = status;
  const dot = $('dot');
  const running = s && s.state === 'running';
  dot.className = `ts-dot ${running ? 'on' : s && ['installing', 'starting'].includes(s.state) ? 'wait' : s && s.state === 'failed' ? 'err' : ''}`;
  $('start').hidden = !s || !s.found || running || ['installing', 'starting'].includes(s.state);
  $('start').textContent = s && s.state === 'failed' ? 'Try again' : s && !s.venv ? 'Set up and start LoRA Tester' : 'Start LoRA Tester';
  $('stop').hidden = !running;
  $('open').hidden = !running;
  if (running) $('open').href = s.url;
  $('toGrid').hidden = !jobs.length;
  $('job').hidden = !jobs.length;

  const detail = !s ? 'Checking…'
    : s.state === 'running' ? `v${s.version} running at ${s.url}${s.activeJob ? ' · a test is running' : ''}`
      : s.state === 'installing' ? 'Setting up Python packages (first start only)…'
        : s.state === 'starting' ? 'Starting…'
          : s.state === 'failed' ? 'Could not start — see the message below'
            : s.state === 'missing' ? 'Not found' : 'Not running';
  $('detail').textContent = detail;

  const log = $('log');
  log.hidden = !s || !s.log.length || running;
  if (s) log.textContent = s.log.join('\n');

  const intro = $('intro');
  intro.hidden = running;
  const extra = intro.querySelector('.ts-extra') || Object.assign(document.createElement('div'), { className: 'ts-extra' });
  if (!extra.isConnected) intro.append(extra);
  extra.innerHTML = s && !s.found
    ? folderForm(`LoRA Tester was not found in <code>${escapeHtml(s.dir)}</code>. If you have it somewhere else, type its folder:`)
    : s ? `<p class="ts-where">Folder: ${s.source === 'bundled' ? 'the <code>tester</code> folder inside LoRA Studio' : `<code>${escapeHtml(s.dir)}</code>`} <button class="link-button" type="button" id="ts-change">change</button></p>` : '';
  wireFolderForm();
  const change = document.getElementById('ts-change');
  if (change) change.onclick = () => { extra.innerHTML = folderForm('Choose the folder that contains LoRA Tester (leave the box empty and press “Use this folder” to use the bundled copy):'); wireFolderForm(); };

  const frame = $('frame');
  frame.hidden = !running;
  if (running && frameUrl !== s.url) { frameUrl = s.url; frame.src = s.url; }
  if (!running && frameUrl) { frameUrl = ''; frame.removeAttribute('src'); }
}

async function saveFolder() {
  const input = document.getElementById('ts-folderInput');
  try {
    status = await post('/api/tester/folder', { folder: input.value });
    app.toast('LoRA Tester folder saved');
    await loadJobs();
    draw();
  } catch (e) { app.toast(e.message); }
}

async function refresh() {
  try { status = await fetchJson('/api/tester/status'); } catch (e) { status = { state: 'failed', found: false, log: [e.message], dir: '' }; }
  draw();
  clearTimeout(pollTimer);
  // Poll quickly while setting up, slowly while the tab is open otherwise.
  if (app.isActive('tester')) pollTimer = setTimeout(refresh, ['installing', 'starting'].includes(status.state) ? 1000 : 8000);
}

async function loadJobs() {
  try { jobs = (await fetchJson('/api/tester/jobs')).jobs; } catch { jobs = []; }
  $('job').innerHTML = jobs.map((j) => `<option value="${escapeHtml(j.id)}">${escapeHtml(`${j.created.replace('T', ' ').slice(0, 16)} · ${j.images} images · ${j.loras.length} LoRA${j.loras.length === 1 ? '' : 's'}${j.model ? ` · ${j.model}` : ''}${j.status && j.status !== 'completed' ? ` · ${j.status}` : ''}`)}</option>`).join('');
  draw();
}

async function sendToGrid() {
  const id = $('job').value;
  if (!id) return;
  const btn = $('toGrid');
  btn.disabled = true;
  try {
    const { images } = await fetchJson(`/api/tester/job?id=${encodeURIComponent(id)}`);
    const files = [];
    for (let i = 0; i < images.length; i++) {
      btn.textContent = `Loading ${i + 1}/${images.length}…`;
      const r = await fetch(`/api/tester/image?path=${encodeURIComponent(images[i].path)}`);
      if (!r.ok) continue;
      const blob = await r.blob();
      // Prefix with the LoRA folder so names stay unique across LoRAs in one run.
      const folder = images[i].path.split('/').slice(-2, -1)[0] || '';
      files.push(new File([blob], `${folder ? `${folder}__` : ''}${images[i].name}`, { type: blob.type, lastModified: Date.parse(id.replace(/^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2}).*/, '$1-$2-$3T$4:$5:$6')) || 0 }));
    }
    if (!files.length) { app.toast('No images of that run could be read (were they deleted?)'); return; }
    const view = document.getElementById('gr-viewMode');
    if (view) view.value = 'strength';
    app.go('grid', { files });
  } catch (e) {
    app.toast(e.message);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Send results to Grid';
  }
}

export function init() {
  $('start').addEventListener('click', async () => {
    try { status = await post('/api/tester/start'); draw(); refresh(); } catch (e) { app.toast(e.message); refresh(); }
  });
  $('stop').addEventListener('click', async () => {
    if (status && status.activeJob && !confirm('A test is running in LoRA Tester. Stopping now cancels it. Stop anyway?')) return;
    try { status = await post('/api/tester/stop'); app.toast('LoRA Tester stopped'); } catch (e) { app.toast(e.message); }
    refresh();
  });
  $('toGrid').addEventListener('click', sendToGrid);
}

export function show() { refresh(); loadJobs(); }
