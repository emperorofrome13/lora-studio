// Strip tab: remove all metadata from dropped images and save clean copies
// into a folder you choose. Stripping happens here in the browser; the server
// only writes the finished files.
import { app, escapeHtml, chooseFolder } from './app.js';
import { stripImage, inspectImage } from './strip-core.js';
import { readImageMetadata } from './meta.js';

const $ = (id) => document.getElementById(`st-${id}`);
const items = [];               // { id, file, url, state, result, savedAs, error }
const known = new Set();
let nextId = 1;
let saving = false;

const isImage = (f) => /^image\//.test(f.type) || /\.(png|jpe?g|webp|gif|bmp|avif|tiff?)$/i.test(f.name);
const fmtBytes = (n) => (n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(2)} MB`);
const stemOf = (name) => name.replace(/\.[^.]+$/, '') || 'image';

/** Formats it cannot strip losslessly (GIF, BMP, AVIF…) are redrawn and saved as PNG, which carries no metadata. */
async function reencode(file) {
  let bitmap;
  try { bitmap = await createImageBitmap(file); } catch { throw new Error('The browser cannot read this image'); }
  const canvas = document.createElement('canvas');
  canvas.width = bitmap.width; canvas.height = bitmap.height;
  canvas.getContext('2d').drawImage(bitmap, 0, 0);
  bitmap.close();
  const blob = await new Promise((r) => canvas.toBlob(r, 'image/png'));
  if (!blob) throw new Error('Could not convert this image');
  const warn = /\.gif$/i.test(file.name) ? 'Converted to PNG; only the first frame of an animated GIF is kept.' : 'Converted to PNG (this format cannot be stripped without re-encoding).';
  return { format: 'png', ext: '.png', bytes: new Uint8Array(await blob.arrayBuffer()), removed: ['everything (redrawn)'], warnings: [warn], converted: true };
}

async function process(item) {
  item.state = 'working';
  item.error = null;
  draw();
  try {
    const original = new Uint8Array(await item.file.arrayBuffer());
    let result;
    try {
      result = stripImage(original, { keepColor: $('keepColor').checked });
    } catch (e) {
      if (!e.unsupported) throw e;
      result = await reencode(item.file);
    }
    // Prove it: read the result back with the same reader the Prompt tab uses,
    // plus the independent structure walk and raw byte scan.
    const audit = await auditBytes(result.bytes);
    if (!audit.clean) throw new Error(`Metadata still present after stripping: ${audit.found.join(', ')}`);
    result.before = original.length;
    item.result = result;
    item.state = 'ready';
  } catch (e) {
    item.state = 'error';
    item.error = e.message;
  }
  draw();
}

/**
 * Three independent checks on one file's bytes:
 *  1. the metadata reader the Prompt tab uses (text fields, EXIF, XMP, comments),
 *  2. a walk through every chunk / segment in the file,
 *  3. a raw byte scan for prompt, workflow, EXIF and XMP signatures.
 */
async function auditBytes(bytes) {
  const u = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const structure = inspectImage(u);
  const read = await readImageMetadata(u.buffer.slice(u.byteOffset, u.byteOffset + u.byteLength));
  const fields = read.fields.map((f) => `${f.key}: ${String(f.value).replace(/\s+/g, ' ').slice(0, 80)}${String(f.value).length > 80 ? '…' : ''}`);
  const found = [...fields.map((f) => `text field "${f}"`), ...structure.found];
  return { clean: found.length === 0, found, fields, structure, width: read.width, height: read.height };
}

// ------------------------------------------------------------------ Double-check panel
const checks = [];                // { id, file, url, state, audit, error }
const checkKnown = new Set();

async function runCheck(c) {
  try {
    c.audit = await auditBytes(new Uint8Array(await c.file.arrayBuffer()));
    c.state = 'done';
  } catch (e) {
    c.state = 'error';
    c.error = e.message;
  }
  drawChecks();
}

function addChecks(list) {
  const fresh = [];
  for (const file of list) {
    if (!isImage(file)) continue;
    const key = [file.name, file.size, file.lastModified, file.webkitRelativePath || ''].join('|');
    if (checkKnown.has(key)) continue;
    checkKnown.add(key);
    const c = { id: nextId++, key, file, url: URL.createObjectURL(file), state: 'queued' };
    checks.push(c);
    fresh.push(c);
  }
  if (!fresh.length) { app.toast('No new images to check'); return; }
  drawChecks();
  (async () => { for (const c of fresh) await runCheck(c); })();
}

function drawChecks() {
  const done = checks.filter((c) => c.state === 'done');
  const clean = done.filter((c) => c.audit.clean).length;
  const dirty = done.length - clean;
  const pending = checks.filter((c) => c.state === 'queued').length;
  const failed = checks.filter((c) => c.state === 'error').length;
  $('checkClear').disabled = !checks.length;
  if (checks.length) {
    $('checkSummary').innerHTML = `<b>${checks.length}</b> checked · <b style="color:var(--ok)">${clean}</b> clean`
      + `${dirty ? ` · <b style="color:var(--danger)">${dirty}</b> still contain metadata` : ''}`
      + `${failed ? ` · <b style="color:var(--danger)">${failed}</b> unreadable` : ''}${pending ? ` · checking ${pending}…` : ''}`;
  }
  $('checkList').replaceChildren(...checks.map((c) => {
    const row = document.createElement('div');
    row.className = 'st-row st-checkrow';
    let verdict = '<div class="st-state wait">Checking…</div>';
    let detail = '';
    if (c.state === 'error') verdict = `<div class="st-state err">❌ ${escapeHtml(c.error)}</div>`;
    if (c.state === 'done') {
      const a = c.audit;
      verdict = a.clean
        ? '<div class="st-state ok">✓ CLEAN — no metadata found</div>'
        : `<div class="st-state err">⚠ METADATA FOUND (${a.found.length})</div>`;
      const blocks = a.structure.blocks.map((b) => `<span class="blk ${b.kind}" title="${escapeHtml(b.kind)}">${escapeHtml(b.name)}${b.size ? ` · ${fmtBytes(b.size)}` : ''}</span>`).join('');
      detail = (a.clean ? '' : `<ul class="st-found">${a.found.map((f) => `<li>${escapeHtml(f)}</li>`).join('')}</ul>`)
        + `<details><summary>File structure · ${escapeHtml(a.structure.format.toUpperCase())} · ${a.structure.blocks.length} blocks</summary><div class="st-blocks">${blocks || 'This format cannot be walked block by block; the raw byte scan still ran.'}</div></details>`;
    }
    row.innerHTML = `<img src="${c.url}" alt="">
      <div><div class="st-name">${escapeHtml(c.file.webkitRelativePath || c.file.name)}</div><div class="st-size">${fmtBytes(c.file.size)}</div></div>
      <div class="st-removed">${detail}</div>${verdict}`;
    const x = document.createElement('button');
    x.className = 'st-x'; x.type = 'button'; x.title = 'Remove from list'; x.textContent = '×';
    x.onclick = () => { URL.revokeObjectURL(c.url); checkKnown.delete(c.key); checks.splice(checks.indexOf(c), 1); drawChecks(); };
    row.append(x);
    return row;
  }));
}

function addFiles(list) {
  const fresh = [];
  for (const file of list) {
    if (!isImage(file)) continue;
    const key = [file.name, file.size, file.lastModified, file.webkitRelativePath || ''].join('|');
    if (known.has(key)) continue;
    known.add(key);
    const item = { id: nextId++, key, file, url: URL.createObjectURL(file), state: 'queued' };
    items.push(item);
    fresh.push(item);
  }
  if (!fresh.length) { app.toast('No new images to add'); return; }
  draw();
  (async () => { for (const it of fresh) await process(it); })();
}

function outputName(item, index) {
  const ext = item.result.converted ? '.png' : (/\.jpeg$/i.test(item.file.name) && item.result.format === 'jpeg' ? '.jpeg' : item.result.ext);
  const mode = $('names').value;
  if (mode === 'numbered') return `image_${String(index).padStart(4, '0')}${ext}`;
  if (mode === 'random') return `${[...crypto.getRandomValues(new Uint8Array(8))].map((b) => b.toString(16).padStart(2, '0')).join('')}${ext}`;
  return `${stemOf(item.file.name)}${ext}`;
}

async function saveAll() {
  const folder = $('target').value.trim();
  if (!folder) { app.toast('Type the folder to save into'); $('target').focus(); return; }
  const todo = items.filter((i) => i.state === 'ready');
  if (!todo.length) return;
  try { localStorage.setItem('ls-strip-target', folder); } catch { /* blocked */ }
  saving = true;
  draw();
  let ok = 0;
  let index = 1;
  for (const item of todo) {
    item.state = 'saving';
    draw();
    try {
      const r = await fetch(`/api/strip/save?folder=${encodeURIComponent(folder)}&name=${encodeURIComponent(outputName(item, index++))}`, {
        method: 'POST', headers: { 'Content-Type': 'application/octet-stream', 'X-Lora-Studio': '1' }, body: item.result.bytes,
      });
      const body = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(body.error || `Save failed (${r.status})`);
      item.savedAs = body.savedAs;
      item.state = 'saved';
      item.result.after = item.result.bytes.length;
      item.result.bytes = null; // free memory; the clean file is on disk now
      ok++;
      // Double-check: read the file back from disk and audit what actually landed there.
      try {
        const disk = await fetch(`/api/files/read?path=${encodeURIComponent(item.savedAs)}`);
        if (!disk.ok) throw new Error('could not read the saved file back');
        const audit = await auditBytes(new Uint8Array(await disk.arrayBuffer()));
        item.verify = audit.clean ? { ok: true } : { ok: false, text: audit.found.join(', ') };
      } catch (e) {
        item.verify = { ok: false, text: e.message };
      }
    } catch (e) {
      item.state = 'ready';
      item.error = e.message;
      draw();
      // A folder problem affects every file: stop instead of repeating the same error.
      if (/folder|path/i.test(e.message)) break;
    }
  }
  saving = false;
  draw();
  if (ok) app.toast(`Saved ${ok} clean image${ok === 1 ? '' : 's'} to ${folder}`);
}

function draw() {
  const ready = items.filter((i) => i.state === 'ready').length;
  const saved = items.filter((i) => i.state === 'saved').length;
  const failed = items.filter((i) => i.state === 'error').length;
  const busy = items.some((i) => i.state === 'working' || i.state === 'queued');
  $('save').disabled = saving || busy || !ready;
  $('save').textContent = saving ? 'Saving…' : `Strip & save${ready ? ` ${ready}` : ''}`;
  $('clear').disabled = saving || !items.length;
  app.setCount('strip', items.length || '');
  const removedBytes = items.filter((i) => i.result && i.result.before).reduce((n, i) => n + i.result.before - (i.result.after ?? i.result.bytes?.length ?? i.result.before), 0);
  $('summary').innerHTML = items.length
    ? `<b>${items.length}</b> image${items.length === 1 ? '' : 's'} · <b>${ready}</b> ready · <b>${saved}</b> saved${failed ? ` · <b style="color:var(--danger)">${failed}</b> failed` : ''}${busy ? ' · reading…' : ''} · ${fmtBytes(Math.max(0, removedBytes))} of metadata removed`
    : 'No images added yet.';

  $('list').replaceChildren(...items.map((item) => {
    const row = document.createElement('div');
    row.className = 'st-row';
    const r = item.result;
    const removed = r
      ? (r.removed.length ? r.removed.map((x) => `<span class="tag">${escapeHtml(x)}</span>`).join('') : 'Already clean — nothing to remove')
        + r.warnings.map((w) => `<div class="warn">⚠ ${escapeHtml(w)}</div>`).join('')
      : '';
    const size = r ? `${fmtBytes(r.before)} → ${fmtBytes(r.after ?? r.bytes.length)}` : fmtBytes(item.file.size);
    const state = {
      queued: ['wait', 'Waiting…'], working: ['wait', 'Reading…'], saving: ['wait', 'Saving…'],
      ready: ['ok', item.error ? '' : '✓ Clean, ready to save'], error: ['err', ''],
      saved: item.verify && !item.verify.ok
        ? ['err', `⚠ Saved as ${String(item.savedAs).split(/[\\/]/).pop()}, but the on-disk check found: ${item.verify.text}`]
        : ['ok', `✓ Saved as ${String(item.savedAs).split(/[\\/]/).pop()}${item.verify ? ' · verified clean on disk' : ''}`],
    }[item.state];
    const stateText = item.error ? `❌ ${item.error}` : state[1];
    row.innerHTML = `<img src="${item.url}" alt="">
      <div><div class="st-name">${escapeHtml(item.file.webkitRelativePath || item.file.name)}</div><div class="st-size">${size}</div></div>
      <div class="st-removed">${removed}</div>
      <div class="st-state ${item.error ? 'err' : state[0]}" title="${escapeHtml(item.savedAs || '')}">${escapeHtml(stateText)}</div>`;
    const x = document.createElement('button');
    x.className = 'st-x'; x.type = 'button'; x.title = 'Remove from list'; x.textContent = '×';
    x.disabled = saving;
    x.onclick = () => {
      URL.revokeObjectURL(item.url);
      known.delete(item.key);
      items.splice(items.indexOf(item), 1);
      draw();
    };
    row.append(x);
    return row;
  }));
}

async function filesFromDrop(dt) {
  const entries = [...dt.items].map((i) => i.webkitGetAsEntry?.()).filter(Boolean);
  if (!entries.some((e) => e.isDirectory)) return [...dt.files];
  const files = [];
  async function walk(entry) {
    if (entry.isFile) {
      const f = await new Promise((res) => entry.file(res, () => res(null)));
      if (f) files.push(f);
    } else if (entry.isDirectory) {
      const reader = entry.createReader();
      for (;;) {
        const chunk = await new Promise((res) => reader.readEntries(res, () => res([])));
        if (!chunk.length) break;
        await Promise.all(chunk.map(walk));
      }
    }
  }
  await Promise.all(entries.map(walk));
  return files;
}

export function init() {
  try { $('target').value = localStorage.getItem('ls-strip-target') || ''; } catch { /* blocked */ }
  $('add').addEventListener('click', () => $('files').click());
  $('addFolder').addEventListener('click', () => $('folder').click());
  for (const id of ['files', 'folder']) $(id).addEventListener('change', (e) => { addFiles(e.target.files); e.target.value = ''; });
  $('save').addEventListener('click', saveAll);
  $('browse').addEventListener('click', async () => {
    const folder = await chooseFolder({ title: 'Choose where to save the clean images', start: $('target').value.trim() });
    if (folder) { $('target').value = folder; try { localStorage.setItem('ls-strip-target', folder); } catch { /* blocked */ } }
  });
  $('target').addEventListener('keydown', (e) => { if (e.key === 'Enter' && !$('save').disabled) saveAll(); });
  $('clear').addEventListener('click', () => {
    for (const i of items) URL.revokeObjectURL(i.url);
    items.length = 0; known.clear(); draw();
  });
  // Changing the color-profile option re-strips everything not yet saved.
  $('keepColor').addEventListener('change', async () => { for (const i of items.filter((x) => x.state === 'ready' || x.state === 'error')) await process(i); });

  $('checkAdd').addEventListener('click', () => $('checkFiles').click());
  $('checkFolder').addEventListener('click', () => $('checkDir').click());
  for (const id of ['checkFiles', 'checkDir']) $(id).addEventListener('change', (e) => { addChecks(e.target.files); e.target.value = ''; });
  $('checkClear').addEventListener('click', () => {
    for (const c of checks) URL.revokeObjectURL(c.url);
    checks.length = 0; checkKnown.clear(); drawChecks();
    $('checkSummary').textContent = 'Saved files are also re-read from disk and checked automatically after “Strip & save”.';
  });
  // Files dropped on the Double-check panel are only checked, never stripped.
  const panel = $('check');
  let checkDepth = 0;
  panel.addEventListener('dragenter', (e) => { e.preventDefault(); e.stopPropagation(); checkDepth++; panel.classList.add('dragging'); });
  panel.addEventListener('dragleave', (e) => { e.stopPropagation(); if (--checkDepth <= 0) { checkDepth = 0; panel.classList.remove('dragging'); } });
  panel.addEventListener('dragover', (e) => { e.preventDefault(); e.stopPropagation(); if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy'; });
  panel.addEventListener('drop', async (e) => {
    e.preventDefault(); e.stopPropagation(); checkDepth = 0; panel.classList.remove('dragging');
    $('drop').classList.remove('dragging');
    if (e.dataTransfer) addChecks(await filesFromDrop(e.dataTransfer));
  });

  const tab = document.getElementById('tab-strip');
  const drop = $('drop');
  let depth = 0;
  tab.addEventListener('dragenter', (e) => { e.preventDefault(); depth++; drop.classList.add('dragging'); });
  tab.addEventListener('dragleave', () => { if (--depth <= 0) { depth = 0; drop.classList.remove('dragging'); } });
  tab.addEventListener('dragover', (e) => { e.preventDefault(); if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy'; });
  tab.addEventListener('drop', async (e) => {
    e.preventDefault(); depth = 0; drop.classList.remove('dragging');
    if (e.dataTransfer) addFiles(await filesFromDrop(e.dataTransfer));
  });
}
