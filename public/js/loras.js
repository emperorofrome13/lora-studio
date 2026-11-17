// My LoRAs tab: saved folders, metadata cards, search/sort/group, Civitai links.
import { app, fetchJson, escapeHtml, chooseFolder } from './app.js';
import { normalizeName } from './meta.js';

const $ = (id) => document.getElementById(`lb-${id}`);
let savedFolders = [];
let groups = [];            // [{ folder, models, error? }]
const collapsed = new Set();
let busy = false;
let pollTimer = 0;
let polls = 0;
let readyResolve;
const ready = new Promise((r) => { readyResolve = r; });

const defaults = { search: '', sort: 'name', groupBy: 'subfolder', baseFilter: '', onlyNew: false, onlyCivitai: false };
const view = (() => {
  try { return { ...defaults, ...JSON.parse(localStorage.getItem('ls-loras-view') || '{}') }; } catch { return { ...defaults }; }
})();
const saveView = () => { try { localStorage.setItem('ls-loras-view', JSON.stringify(view)); } catch { /* blocked */ } };

// ------------------------------------------------------------ lookups used by other tabs
const allModels = () => groups.flatMap((g) => g.models);
const stem = (m) => normalizeName(m.filename).toLowerCase();

/** Local LoRAs whose file name (or titles) match a LoRA name from image metadata. */
export function findByName(name) {
  const n = normalizeName(name).toLowerCase();
  if (!n) return [];
  return allModels().filter((m) => stem(m) === n);
}
export function findByVersionId(id) {
  const v = Number(id);
  return v ? allModels().filter((m) => Number(m.metadata.civitaiVersionId) === v) : [];
}
export function whenReady() { return ready; }
export function ownedNames() {
  return new Set(allModels().map(stem));
}
export function ownedVersionIds() {
  return new Set(allModels().map((m) => Number(m.metadata.civitaiVersionId)).filter(Boolean));
}

// ------------------------------------------------------------ loading
function status(text) { $('status').innerHTML = text; }

function setBusy(on) {
  busy = on;
  for (const id of ['load', 'save', 'refresh']) $(id).disabled = on;
}

async function loadFolder(folder) {
  try {
    const r = await fetchJson(`/api/loras?path=${encodeURIComponent(folder)}`);
    return { folder: r.folder, models: r.models };
  } catch (err) {
    return { folder, models: [], error: err.message };
  }
}

async function loadMany(folders, label) {
  setBusy(true);
  status(escapeHtml(label));
  try {
    const out = [];
    for (const f of folders) out.push(await loadFolder(f));
    groups = out;
    afterChange();
  } finally {
    setBusy(false);
  }
  watchLookups();
}

const loadAllSaved = () => loadMany(savedFolders, 'Loading saved folders…');

function afterChange() {
  $('tools').hidden = groups.length === 0;
  $('refresh').hidden = groups.length === 0;
  rebuildBaseFilter();
  renderChips();
  render();
  app.setCount('loras', allModels().length || '');
}

async function saveFolder() {
  const folder = $('path').value.trim();
  if (!folder) { $('browse').click(); return; } // nothing typed: open the folder window instead
  setBusy(true);
  status('Saving folder and reading its LoRAs…');
  try {
    const r = await fetchJson('/api/folders', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ folder }) });
    savedFolders = r.folders;
    setBusy(false);
    await loadAllSaved();
    app.toast(`Saved: ${r.saved}`);
  } catch (err) {
    status(`<span style="color:var(--danger)">❌ ${escapeHtml(err.message)}</span>`);
  } finally {
    setBusy(false);
  }
}

async function removeFolder(folder) {
  if (!confirm(`Stop checking this folder on startup?\n\n${folder}\n\nYour files are not touched.`)) return;
  const r = await fetchJson(`/api/folders?folder=${encodeURIComponent(folder)}`, { method: 'DELETE' });
  savedFolders = r.folders;
  groups = groups.filter((g) => g.folder.toLowerCase() !== folder.toLowerCase());
  afterChange();
}

/** While the server hashes new files / asks Civitai, show progress and refresh once done. */
async function watchLookups() {
  clearTimeout(pollTimer);
  let s;
  try { s = await fetchJson('/api/loras/status'); } catch { return; }
  if (s.pending > 0) {
    renderStatus(`· looking up <b>${s.pending}</b> on Civitai${s.current ? ` (now: ${escapeHtml(s.current)})` : ''}…`);
    pollTimer = setTimeout(async () => {
      let now;
      try { now = await fetchJson('/api/loras/status'); } catch { return; }
      // Refresh the cards about every 30 seconds, and once when everything is done.
      if (now.pending === 0 || ++polls % 10 === 0) await refresh(true);
      else watchLookups();
    }, 3000);
  }
}

async function refresh(quiet) {
  if (busy || !groups.length) return;
  const y = window.scrollY;
  if (!quiet) setBusy(true);
  try {
    const out = [];
    for (const g of groups) out.push(await loadFolder(g.folder));
    groups = out;
    afterChange();
    window.scrollTo(0, y);
  } finally {
    if (!quiet) setBusy(false);
  }
  watchLookups();
}

// ------------------------------------------------------------ view
const baseOf = (m) => (m.metadata.baseModel || m.metadata.civitaiBaseModel || '').trim() || 'Unknown base model';
const triggerOf = (m) => m.metadata.triggerWord || (m.metadata.trainedWords || []).join(', ');

function matches(m) {
  if (view.baseFilter && baseOf(m) !== view.baseFilter) return false;
  if (view.onlyNew && !m.isNew) return false;
  if (view.onlyCivitai && !m.metadata.civitaiTitle) return false;
  if (!view.search) return true;
  const meta = m.metadata;
  const hay = [m.filename, meta.title, triggerOf(m), baseOf(m), meta.civitaiTitle, meta.civitaiVersionName, m.relativeDir].filter(Boolean).join(' ').toLowerCase();
  return view.search.toLowerCase().split(/\s+/).every((t) => hay.includes(t));
}

function sorted(list) {
  const out = list.slice();
  const byName = (a, b) => a.filename.localeCompare(b.filename, undefined, { sensitivity: 'base' });
  switch (view.sort) {
    case 'name-desc': out.sort((a, b) => byName(b, a)); break;
    case 'newest': out.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)); break;
    case 'oldest': out.sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt)); break;
    case 'size': out.sort((a, b) => b.size - a.size); break;
    case 'base': out.sort((a, b) => baseOf(a).localeCompare(baseOf(b)) || byName(a, b)); break;
    default: out.sort(byName);
  }
  return out;
}

function bucket(list, keyFn) {
  const map = new Map();
  for (const m of list) {
    const k = keyFn(m);
    if (!map.has(k)) map.set(k, []);
    map.get(k).push(m);
  }
  return [...map.keys()].sort((a, b) => a.localeCompare(b)).map((k) => [k, map.get(k)]);
}

function viewGroups() {
  const out = [];
  if (view.groupBy === 'none') {
    const all = groups.flatMap((g) => g.models.filter(matches));
    if (all.length) out.push({ key: 'all', title: 'All LoRAs', models: sorted(all) });
    return out;
  }
  for (const g of groups) {
    const visible = g.models.filter(matches);
    if (g.error && !visible.length) { out.push({ key: `f:${g.folder}`, title: g.folder, models: [], error: g.error }); continue; }
    if (view.groupBy === 'folder') {
      if (visible.length) out.push({ key: `f:${g.folder}`, title: g.folder, models: sorted(visible) });
    } else if (view.groupBy === 'base') {
      for (const [k, list] of bucket(visible, baseOf)) out.push({ key: `b:${g.folder}:${k}`, title: k, models: sorted(list) });
    } else {
      for (const [k, list] of bucket(visible, (m) => m.relativeDir || '(top level)')) out.push({ key: `s:${g.folder}:${k}`, title: k, models: sorted(list) });
    }
  }
  return out;
}

function renderStatus(extra = '') {
  const shown = viewGroups().reduce((n, g) => n + g.models.length, 0);
  const total = allModels().length;
  const fresh = allModels().filter((m) => m.isNew).length;
  status(groups.length
    ? `✓ <b>${shown}</b> of ${total} LoRA${total === 1 ? '' : 's'} shown${fresh ? ` · ${fresh} new since last start` : ''} ${extra}`
    : 'No saved folders yet — click 📁 Choose LoRA folder… to pick one.');
}

function render() {
  const list = $('list');
  const vg = viewGroups();
  renderStatus();
  if (!vg.some((g) => g.models.length || g.error)) {
    const any = allModels().length > 0;
    list.innerHTML = `<div class="empty-state"><p>${any ? 'Nothing matches your search or filters' : 'No LoRAs loaded yet'}</p><p>${any ? 'Try clearing the search box or the filters.' : 'Click <b>📁 Choose LoRA folder…</b> and pick the folder that holds your .safetensors files.'}</p></div>`;
    return;
  }
  list.replaceChildren(...vg.map(renderGroup));
}

function renderGroup(g) {
  const section = document.createElement('div');
  section.className = 'grp';
  const head = document.createElement('div');
  head.className = 'grp-head';
  head.innerHTML = `<span class="caret">${collapsed.has(g.key) ? '▶' : '▼'}</span><span>📁 ${escapeHtml(g.title)}</span><span class="n">${g.models.length} LoRA${g.models.length === 1 ? '' : 's'}</span>`;
  head.onclick = () => { collapsed.has(g.key) ? collapsed.delete(g.key) : collapsed.add(g.key); render(); };
  section.append(head);
  if (g.error) {
    const e = document.createElement('div'); e.className = 'grp-msg err'; e.textContent = `❌ ${g.error}`; section.append(e);
  } else if (collapsed.has(g.key)) {
    const e = document.createElement('div'); e.className = 'grp-msg'; e.textContent = `${g.models.length} hidden — click the header to expand`; section.append(e);
  } else {
    const cards = document.createElement('div');
    cards.className = 'cards';
    cards.append(...g.models.map(card));
    section.append(cards);
  }
  return section;
}

function formatBytes(bytes) {
  if (!bytes) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const i = Math.min(3, Math.floor(Math.log(bytes) / Math.log(1024)));
  return `${parseFloat((bytes / 1024 ** i).toFixed(i < 3 ? 1 : 2))} ${units[i]}`;
}

function card(m) {
  const meta = m.metadata;
  const el = document.createElement('div');
  el.className = 'card';
  el.dataset.stem = stem(m);
  const trig = triggerOf(m);
  const name = normalizeName(m.filename);
  el.innerHTML = `
    ${meta.civitaiImage ? `<img class="pic" src="${escapeHtml(meta.civitaiImage)}" alt="" loading="lazy" referrerpolicy="no-referrer">` : '<div class="pic empty">◇</div>'}
    <div class="body">
      <h3>${escapeHtml(meta.civitaiTitle || meta.title || m.filename)}</h3>
      <div class="sub">${escapeHtml(m.filename)}${meta.civitaiVersionName ? ` · version ${escapeHtml(meta.civitaiVersionName)}` : ''}</div>
      ${meta.title && meta.title !== meta.civitaiTitle && meta.title !== name ? `<div class="row"><span class="i">✎</span><span>Local title: ${escapeHtml(meta.title)}</span></div>` : ''}
      ${trig ? `<div class="row trig"><span class="i">⚡</span><span>${escapeHtml(trig)}</span></div>` : ''}
      <div class="row base"><span class="i">🧠</span><span>${escapeHtml(baseOf(m))}</span></div>
      <div class="row"><span class="i">🌐</span><span style="color:var(--muted)">${meta.civitaiTitle ? 'Found on Civitai' : meta.civitaiChecked ? 'Not on Civitai' : 'Civitai lookup pending…'}</span></div>
    </div>
    <div class="acts"></div>
    <div class="foot"><span>${escapeHtml(formatBytes(m.size))}</span><span>${escapeHtml(new Date(m.createdAt).toLocaleDateString())}</span></div>
    ${m.isNew ? '<span class="new">NEW</span>' : ''}`;
  const img = el.querySelector('img.pic');
  if (img) img.onerror = () => { const d = document.createElement('div'); d.className = 'pic empty'; d.textContent = '◇'; img.replaceWith(d); };
  const acts = el.querySelector('.acts');
  const btn = (label, title, fn) => { const b = document.createElement('button'); b.type = 'button'; b.className = 'ui-btn small'; b.textContent = label; b.title = title; b.onclick = fn; acts.append(b); };
  if (meta.civitaiModelId) {
    btn('Civitai images', 'Browse images made with this LoRA in the Civitai tab', () => app.go('civitai', {
      model: { id: meta.civitaiModelId, versionId: meta.civitaiVersionId, name: meta.civitaiTitle || name, versionName: meta.civitaiVersionName || '', type: 'LORA' },
    }));
  } else {
    btn('Find on Civitai', 'Search the Civitai model catalog for this name', () => app.go('civitai', { searchModel: meta.title || name }));
  }
  btn('Copy tag', `Copy <lora:${name}:1>`, () => app.copy(`<lora:${name}:1>`, 'LoRA tag copied'));
  if (trig) btn('Copy trigger', 'Copy the trigger words', () => app.copy(trig, 'Trigger words copied'));
  btn('Copy path', m.fullPath, () => app.copy(m.fullPath, 'Path copied'));
  return el;
}

function renderChips() {
  const bar = $('folders');
  bar.replaceChildren();
  if (!savedFolders.length) return;
  const label = document.createElement('span');
  label.className = 'label';
  label.textContent = 'Checked on every startup:';
  bar.append(label);
  const showing = new Set(groups.map((g) => g.folder.toLowerCase()));
  const all = document.createElement('span');
  all.className = 'chip' + (groups.length > 1 && savedFolders.every((f) => showing.has(f.toLowerCase())) ? ' on' : '');
  all.textContent = '📋 All folders';
  all.onclick = loadAllSaved;
  bar.append(all);
  for (const folder of savedFolders) {
    const chip = document.createElement('span');
    chip.className = 'chip' + (groups.length === 1 && showing.has(folder.toLowerCase()) ? ' on' : '');
    chip.title = 'Click to show only this folder';
    chip.innerHTML = `<span class="t">${escapeHtml(folder)}</span>`;
    const x = document.createElement('button');
    x.className = 'x'; x.type = 'button'; x.textContent = '×'; x.title = 'Stop checking this folder';
    x.onclick = (e) => { e.stopPropagation(); removeFolder(folder); };
    chip.append(x);
    chip.onclick = () => { $('path').value = folder; loadMany([folder], `Loading ${folder}…`); };
    bar.append(chip);
  }
}

function rebuildBaseFilter() {
  const sel = $('base');
  const counts = new Map();
  for (const m of allModels()) counts.set(baseOf(m), (counts.get(baseOf(m)) || 0) + 1);
  sel.innerHTML = '<option value="">Base model: all</option>';
  for (const k of [...counts.keys()].sort((a, b) => a.localeCompare(b))) {
    const o = document.createElement('option');
    o.value = k; o.textContent = `${k} (${counts.get(k)})`;
    sel.append(o);
  }
  if (view.baseFilter && counts.has(view.baseFilter)) sel.value = view.baseFilter;
  else { view.baseFilter = ''; sel.value = ''; }
}

// ------------------------------------------------------------ tab hooks
export function init() {
  $('search').value = view.search;
  $('sort').value = view.sort;
  $('group').value = view.groupBy;
  $('onlyNew').checked = view.onlyNew;
  $('onlyCivitai').checked = view.onlyCivitai;
  let t;
  $('search').addEventListener('input', () => { clearTimeout(t); t = setTimeout(() => { view.search = $('search').value.trim(); saveView(); render(); }, 150); });
  const bind = (id, key, prop = 'value') => $(id).addEventListener('change', () => { view[key] = $(id)[prop]; saveView(); render(); });
  bind('sort', 'sort'); bind('base', 'baseFilter'); bind('group', 'groupBy');
  bind('onlyNew', 'onlyNew', 'checked'); bind('onlyCivitai', 'onlyCivitai', 'checked');
  $('collapse').addEventListener('click', () => {
    const vg = viewGroups();
    const allClosed = vg.every((g) => collapsed.has(g.key));
    collapsed.clear();
    if (!allClosed) vg.forEach((g) => collapsed.add(g.key));
    render();
  });
  $('load').addEventListener('click', () => {
    const p = $('path').value.trim();
    if (!p) { app.toast('Choose a folder first (📁 Choose LoRA folder…) or type its path'); return; }
    loadMany([p], `Reading ${p}…`);
  });
  $('save').addEventListener('click', saveFolder);
  $('browse').addEventListener('click', async () => {
    const btn = $('browse');
    btn.disabled = true;
    btn.textContent = '📁 Choose in the folder window…';
    try {
      const folder = await chooseFolder({ title: 'Choose the folder that holds your LoRAs', start: $('path').value.trim() || savedFolders[0] || '' });
      if (folder) { $('path').value = folder; await saveFolder(); }
    } finally {
      btn.disabled = false;
      btn.textContent = '📁 Choose LoRA folder…';
    }
  });
  $('refresh').addEventListener('click', () => refresh(false));
  $('path').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('load').click(); });

  // Load the library straight away: the other tabs use it to mark LoRAs you own.
  (async () => {
    try {
      savedFolders = (await fetchJson('/api/folders')).folders;
      renderChips();
      // Give the server's startup scan a moment so NEW badges are accurate.
      for (let i = 0; i < 40; i++) {
        const s = await fetchJson('/api/loras/status').catch(() => null);
        if (s && s.scannedAt) break;
        await new Promise((r) => setTimeout(r, 300));
      }
      if (savedFolders.length) await loadAllSaved();
      else renderStatus();
    } catch (err) {
      status(`<span style="color:var(--danger)">❌ ${escapeHtml(err.message)}</span>`);
    } finally {
      readyResolve();
    }
  })();
}

/** Other tabs can ask: { search: 'lora name' } to show a LoRA. */
export async function receive(action) {
  if (action.search === undefined) return;
  await ready;
  view.search = action.search;
  view.baseFilter = ''; view.onlyNew = false; view.onlyCivitai = false;
  $('search').value = action.search; $('base').value = ''; $('onlyNew').checked = false; $('onlyCivitai').checked = false;
  saveView();
  render();
  const n = normalizeName(action.search).toLowerCase();
  const hit = document.querySelector(`#lb-list .card[data-stem="${CSS.escape(n)}"]`);
  if (hit) { hit.classList.add('flash'); hit.scrollIntoView({ block: 'center' }); setTimeout(() => hit.classList.remove('flash'), 2500); }
  else if (!viewGroups().length) app.toast(`“${action.search}” is not in your saved folders`);
}
