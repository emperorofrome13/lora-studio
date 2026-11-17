// Prompt tab: drop / open / paste one image and get its prompt, negative
// prompt, LoRAs and settings. Replaces the Windows PromptExtractor app.
import { app, escapeHtml } from './app.js';
import { readImageFile } from './meta.js';
import { findByName, whenReady } from './loras.js';

const $ = (id) => document.getElementById(`pe-${id}`);
let currentFile = null;
let currentUrl = null;

function setStatus(text) { $('status').textContent = text; }

export async function loadFile(file) {
  if (!file) return;
  currentFile = file;
  if (currentUrl) URL.revokeObjectURL(currentUrl);
  currentUrl = URL.createObjectURL(file);
  const img = document.createElement('img');
  img.src = currentUrl;
  img.alt = file.name;
  $('pic').replaceChildren(img);
  $('toGrid').disabled = false;
  let info;
  try {
    info = await readImageFile(file);
  } catch (err) {
    $('prompt').value = '';
    $('copy').disabled = true;
    $('negWrap').hidden = true;
    $('details').hidden = true;
    setStatus(`Could not read ${file.name}: ${err.message}`);
    return;
  }
  if (file !== currentFile) return; // a newer file was dropped meanwhile
  $('prompt').value = info.prompt || '';
  $('copy').disabled = !info.prompt;
  setStatus(info.prompt ? `Prompt extracted from ${file.name}.` : `No prompt found in ${file.name}.`);
  $('negWrap').hidden = !info.negative;
  $('neg').value = info.negative || '';
  renderDetails(info);
}

async function renderDetails(info) {
  const a = info.analysis;
  $('details').hidden = !(a.detected || info.fields.length);
  const s = a.stats;
  const rows = [['Base model', a.model], ['Seed', s.seed], ['Steps', s.steps], ['CFG', s.cfg], ['Sampler', s.sampler],
    ['Scheduler', s.scheduler], ['Denoise', s.denoise], ['Image size', info.width ? `${info.width} × ${info.height}` : ''], ['Format', info.format.toUpperCase()]];
  $('kv').innerHTML = rows.filter(([, v]) => v).map(([k, v]) => `<span>${escapeHtml(k)}</span><span>${escapeHtml(v)}</span>`).join('');

  const box = $('loras');
  if (!a.loras.length) { box.innerHTML = `<div class="dim">${a.detected ? 'No LoRAs in this image’s metadata.' : 'No generation metadata found.'}</div>`; }
  else {
    await whenReady();
    box.replaceChildren(...a.loras.map((l) => {
      const row = document.createElement('div');
      row.className = 'lora';
      const owned = findByName(l.name);
      const strength = l.model !== null ? `${l.model}${l.clip !== null && String(l.clip) !== String(l.model) ? ` / clip ${l.clip}` : ''}` : '';
      row.innerHTML = `<span class="nm">${escapeHtml(l.name)}</span>${strength ? `<span class="st">@ ${escapeHtml(strength)}</span>` : ''}`
        + (owned.length ? '<span class="have">✓ in My LoRAs</span>' : '<span class="miss">not in your saved folders</span>') + '<span class="sp"></span>';
      const add = (label, fn) => { const b = document.createElement('button'); b.type = 'button'; b.className = 'ui-btn small'; b.textContent = label; b.onclick = fn; row.append(b); };
      if (owned.length) add('Show in My LoRAs', () => app.go('loras', { search: owned[0].filename }));
      add('Find on Civitai', () => app.go('civitai', { searchModel: l.name }));
      add('Copy tag', () => app.copy(`<lora:${l.name}:${l.model ?? 1}>`, 'LoRA tag copied'));
      return row;
    }));
  }

  const fields = $('fields');
  fields.replaceChildren(...info.fields.map(({ key, value }) => {
    const d = document.createElement('div');
    d.className = 'field';
    let text = value;
    try { if (/^\s*[{[]/.test(value)) text = JSON.stringify(JSON.parse(value), null, 2); } catch { /* not JSON */ }
    d.innerHTML = `<b>${escapeHtml(key)}</b>`;
    const pre = document.createElement('pre');
    pre.textContent = text;
    d.append(pre);
    return d;
  }));
  if (!info.fields.length) fields.innerHTML = '<div class="dim">This file has no text metadata.</div>';
}

function imageFrom(list) {
  return [...(list || [])].find((f) => /^image\//.test(f.type) || /\.(png|jpe?g|webp)$/i.test(f.name));
}

export function init() {
  const drop = $('drop');
  $('open').addEventListener('click', () => $('file').click());
  $('file').addEventListener('change', (e) => { loadFile(e.target.files[0]); e.target.value = ''; });
  $('copy').addEventListener('click', () => { const p = $('prompt').value.trim(); if (p) app.copy(p, 'Prompt copied'); });
  $('copyNeg').addEventListener('click', () => { const p = $('neg').value.trim(); if (p) app.copy(p, 'Negative prompt copied'); });
  $('prompt').addEventListener('input', () => { $('copy').disabled = !$('prompt').value.trim(); });
  $('toGrid').addEventListener('click', () => { if (currentFile) app.go('grid', { files: [currentFile] }); });

  // Dropping anywhere on the Prompt tab loads the image, not just on the drop box.
  const tab = document.getElementById('tab-prompt');
  let depth = 0;
  tab.addEventListener('dragenter', (e) => { e.preventDefault(); depth++; drop.classList.add('dragging'); });
  tab.addEventListener('dragleave', () => { if (--depth <= 0) { depth = 0; drop.classList.remove('dragging'); } });
  tab.addEventListener('dragover', (e) => { e.preventDefault(); if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy'; });
  tab.addEventListener('drop', (e) => {
    e.preventDefault(); depth = 0; drop.classList.remove('dragging');
    const file = imageFrom(e.dataTransfer?.files);
    if (file) loadFile(file); else app.toast('Drop a PNG, JPG or WebP image');
  });
  document.addEventListener('paste', (e) => {
    if (!app.isActive('prompt')) return;
    const file = imageFrom([...(e.clipboardData?.items || [])].filter((i) => i.kind === 'file').map((i) => i.getAsFile()).filter(Boolean));
    if (file) { e.preventDefault(); loadFile(file); }
  });
}

/** From the Grid tab: { file } */
export function receive(action) {
  if (action.file) loadFile(action.file);
}
