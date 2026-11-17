// Civitai tab (ported from Civit Lens): browse Civitai images, filter for real
// ComfyUI workflows, save/block, model search. Talks to Civitai through the
// local server's /api/civitai proxy.
import { extractWorkflow, workflowTier, matchesImage, resourcesOf } from './civitai-logic.js';
import { app, typing } from './app.js';
import { findByVersionId, findByName, ownedVersionIds, ownedNames, whenReady } from './loras.js';

const $ = (id) => document.getElementById(`cv-${id}`);
const node = (tag, className = '', text = '') => {
  const el = document.createElement(tag);
  if (className) el.className = className;
  if (text !== undefined && text !== null) el.textContent = String(text);
  return el;
};
function safeLink(url) {
  try { const u = new URL(url); return u.protocol === 'https:' || u.protocol === 'http:' ? u.href : '#'; } catch { return '#'; }
}
function addButton(parent, title, onClick, cls = 'mini-btn') {
  const btn = node('button', cls, title); btn.type = 'button'; btn.addEventListener('click', onClick); parent.append(btn); return btn;
}
function getStored(key, fallback) { try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; } }
const save = (key, value) => { try { localStorage.setItem(key, JSON.stringify(value)); } catch { showNotice('Your browser could not save preferences. Free some browser storage space and try again.'); } };

const state = {
  site: getStored('cl-site', 'com') === 'red' ? 'red' : 'com',
  images: [], seen: new Set(), blocked: new Set(getStored('cl-blocked', []).map((s) => String(s).toLowerCase())),
  favorites: new Set(getStored('cl-favorites', [])),
  model: null, nextCursor: null, complete: false, loading: false, batchCount: 0, scanSession: 0,
  activeDetail: null, remoteFilters: null, savedImages: getStored('cl-saved-images', {}), started: false,
};
const api = async (endpoint, params = {}) => {
  const u = new URL(endpoint, window.location.origin);
  u.searchParams.set('site', state.site);
  for (const [key, val] of Object.entries(params)) if (val !== '' && val !== undefined && val !== null) u.searchParams.set(key, String(val));
  const resp = await fetch(u);
  const body = await resp.json().catch(() => ({ error: 'Invalid response' }));
  if (!resp.ok) throw new Error(body.error ? `${body.error}${body.detail ? ' — ' + String(body.detail).slice(0, 140) : ''}` : 'Request failed');
  return body;
};
function remoteOpts() {
  return {
    limit: 80, sort: $('sort').value, period: $('period').value,
    baseModels: $('baseModel').value.trim(), username: $('uploader').value.trim(),
    nsfw: state.site === 'red' ? ($('rating').value || 'true') : 'None',
    tags: /^\d+(,\d+)*$/.test($('tags').value.trim()) ? $('tags').value.trim() : '',
    ...(state.model ? (state.model.versionId ? { modelVersionId: state.model.versionId } : { modelId: state.model.id }) : {}),
  };
}
function localOpts() {
  return {
    workflow: document.querySelector('input[name="cv-workflow"]:checked').value,
    resourceType: $('resourceType').value, minLikes: $('minLikes').value,
    orientation: $('orientation').value, text: $('textQuery').value,
    ownedVersionIds: $('resourceType').value === 'mine' ? ownedVersionIds() : null,
    ownedNames: $('resourceType').value === 'mine' ? ownedNames() : null,
  };
}
function galleryTitle(img) { return img.meta?.prompt ? String(img.meta.prompt).slice(0, 150) : `Image #${img.id}`; }
function siteHost() { return state.site === 'red' ? 'https://civitai.red' : 'https://civitai.com'; }
function fmt(n) { return new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 }).format(Number(n) || 0); }
function isSaved(image) { return state.favorites.has(`${state.site}:${image.id}`); }
function toggleSaved(img) {
  const key = `${state.site}:${img.id}`;
  if (state.favorites.has(key)) { state.favorites.delete(key); delete state.savedImages[key]; }
  else { state.favorites.add(key); state.savedImages[key] = img; }
  save('cl-saved-images', state.savedImages);
  save('cl-favorites', [...state.favorites]); render();
}
function blockUser(username) {
  username = String(username || '').trim();
  if (!username) return;
  state.blocked.add(username.toLowerCase());
  save('cl-blocked', [...state.blocked]);
  $('blockCount').textContent = String(state.blocked.size);
  closePanels(); render();
}
function unblockUser(username) {
  state.blocked.delete(String(username).toLowerCase()); save('cl-blocked', [...state.blocked]);
  $('blockCount').textContent = String(state.blocked.size); render(); showBlocks();
}
function showNotice(message = '') { $('notice').hidden = !message; $('notice').textContent = message; }
function syncSite() {
  const red = state.site === 'red';
  $('siteRed').classList.toggle('active', red); $('siteCom').classList.toggle('active', !red);
  $('siteLabel').textContent = red ? '.RED' : '.COM';
  $('rating').disabled = !red;
  $('rating').title = red ? 'Content availability depends on account and region' : 'civitai.com is SFW';
  save('cl-site', state.site);
}
function filterActive() {
  const opts = localOpts();
  const tags = [];
  if (opts.workflow === 'graph') tags.push('Real workflows');
  else if (opts.workflow === 'params') tags.push('Has generation metadata');
  if (opts.resourceType !== 'all') tags.push(opts.resourceType === 'lora' ? 'LoRA referenced' : opts.resourceType === 'mine' ? 'Uses one of my LoRAs' : 'Checkpoint referenced');
  if (state.model) tags.push(state.model.name + (state.model.versionName ? ` · ${state.model.versionName}` : ''));
  if (opts.text) tags.push(`Text: ${opts.text.slice(0, 28)}`);
  if ($('onlySaved').checked) tags.push('Saved only');
  if (opts.orientation !== 'all') tags.push(opts.orientation);
  if (Number(opts.minLikes) > 0) tags.push(`${opts.minLikes}+ likes`);
  const parent = $('activeFilters'); parent.replaceChildren(); parent.hidden = tags.length === 0;
  for (const t of tags) parent.append(node('span', 'filter-chip', t));
}
function render() {
  const opts = localOpts();
  const candidates = new Map(state.images.map((img) => [String(img.id), img]));
  if ($('onlySaved').checked) {
    for (const [key, img] of Object.entries(state.savedImages)) {
      if (key.startsWith(state.site + ':') && state.favorites.has(key)) candidates.set(String(img.id), img);
    }
  }
  const images = [...candidates.values()].filter((img) => matchesImage(img, opts, state.blocked) && (!$('onlySaved').checked || isSaved(img)));
  const gallery = $('gallery'); gallery.replaceChildren();
  for (const img of images) {
    const tile = node('article', 'tile'); tile.tabIndex = 0;
    tile.setAttribute('aria-label', `Open image ${img.id} by ${img.username || 'unknown'}`);
    tile.addEventListener('click', () => showDetail(img));
    tile.addEventListener('keydown', (ev) => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); showDetail(img); } });
    const media = node('div', 'tile-media');
    const url = safeLink(img.url);
    if (url !== '#') {
      const picture = node('img'); picture.src = url; picture.loading = 'lazy'; picture.decoding = 'async';
      picture.alt = galleryTitle(img); picture.referrerPolicy = 'no-referrer';
      picture.onerror = () => { picture.replaceWith(node('div', 'tile-placeholder', 'Image unavailable')); };
      media.append(picture);
    } else media.append(node('div', 'tile-placeholder', 'Image unavailable'));
    media.append(node('div', 'tile-overlay'));
    const top = node('div', 'tile-top');
    const tier = workflowTier(img.meta);
    top.append(node('span', `tile-badge ${tier === 'graph' ? '' : tier}`, tier === 'graph' ? '◆ Real workflow' : tier === 'params' ? '◈ Metadata' : 'No metadata'));
    const actions = node('div', 'tile-actions');
    const fav = addButton(actions, isSaved(img) ? '♥' : '♡', (e) => { e.stopPropagation(); toggleSaved(img); }, `tile-action ${isSaved(img) ? 'saved' : ''}`);
    fav.title = isSaved(img) ? 'Unsave image' : 'Save image'; fav.setAttribute('aria-label', fav.title);
    const block = addButton(actions, '⊘', (e) => { e.stopPropagation(); blockUser(img.username); }, 'tile-action');
    block.title = `Hide all images from @${img.username}`; block.setAttribute('aria-label', block.title);
    top.append(actions); media.append(top); tile.append(media);
    const footer = node('div', 'tile-bottom'); footer.append(node('div', 'tile-name', `@${img.username || 'unknown'}`));
    const info = node('div', 'tile-info'); info.append(node('span', 'tile-base', img.baseModel || 'Unknown model')); info.append(node('span', '', `♥ ${fmt(img.stats?.likeCount)}`)); footer.append(info); tile.append(footer); gallery.append(tile);
  }
  $('countLabel').textContent = state.loading ? `Loading Civitai images… · ${state.images.length} scanned` : `${images.length} shown · ${state.images.length} scanned · ${state.blocked.size} blocked uploader${state.blocked.size === 1 ? '' : 's'}`;
  gallery.setAttribute('aria-busy', String(state.loading));
  $('scanLabel').textContent = `${state.batchCount} ${state.batchCount === 1 ? 'page' : 'pages'} scanned`;
  $('empty').hidden = images.length !== 0 || state.loading;
  if (opts.workflow === 'graph') {
    $('empty').querySelector('h3').textContent = 'No downloadable workflows in these pages yet';
    $('empty').querySelector('p').textContent = 'Scan more pages or choose another model. Images made with ComfyUI do not always include their node graph.';
  } else {
    $('empty').querySelector('h3').textContent = 'No matching images in scanned pages';
    $('empty').querySelector('p').textContent = 'Try fewer filters, or scan additional pages. Saved images and blocked uploaders stay in this browser.';
  }
  $('loadMore').hidden = state.complete;
  $('loadMore').disabled = state.loading;
  $('loadMore').textContent = state.loading ? 'Loading…' : 'Load next page ↓';
  $('deepScan').disabled = state.loading || state.complete;
  $('endLabel').textContent = state.complete ? 'End of available results' : state.loading ? 'Requesting Civitai API…' : '';
  filterActive();
}
async function getBatch(session = state.scanSession) {
  if (state.complete || state.loading || session !== state.scanSession) return false;
  state.loading = true; render();
  try {
    const payload = await api('/api/civitai/images', { ...state.remoteFilters, ...(state.nextCursor ? { cursor: state.nextCursor } : {}) });
    if (session !== state.scanSession) return false;
    const before = state.nextCursor;
    for (const item of (Array.isArray(payload.items) ? payload.items : [])) {
      const k = String(item.id);
      if (!state.seen.has(k)) { state.seen.add(k); state.images.push(item); }
      if (isSaved(item)) state.savedImages[state.site + ':' + item.id] = item;
    }
    if (state.favorites.size) save('cl-saved-images', state.savedImages);
    const after = payload.metadata?.nextCursor;
    state.nextCursor = after || null;
    state.complete = !after || after === before;
    state.batchCount++;
    showNotice('');
    return true;
  } catch (err) {
    if (session === state.scanSession) showNotice(`${err.message}. If you need mature-content access on .red, configure your own API token and check your Civitai account permissions.`);
    return false;
  } finally {
    if (session === state.scanSession) { state.loading = false; render(); }
  }
}
async function scanPages(count = 1) {
  const session = state.scanSession;
  for (let i = 0; i < count && session === state.scanSession && !state.complete; i++) {
    if (!(await getBatch(session))) break;
  }
}
async function restart() {
  state.started = true;
  state.scanSession++; state.remoteFilters = remoteOpts();
  state.images = []; state.seen.clear(); state.nextCursor = null; state.complete = false; state.batchCount = 0;
  state.loading = false; showNotice(''); render();
  await scanPages(1);
}
function setSite(site) {
  if (state.site === site) return;
  state.site = site; syncSite(); restart();
}
function closePanels() { $('overlay').hidden = true; $('modal').hidden = true; $('detailPanel').hidden = true; state.activeDetail = null; }
function openPanel(which) { closePanels(); $('overlay').hidden = false; $(which).hidden = false; }
function kvRows(rows) {
  const box = node('div', 'kv');
  for (const [k, v] of rows) box.append(node('span', '', k), node('span', '', v ?? '—'));
  return box;
}
const title = (text) => node('div', 'section-title', text);
const infoCode = (text) => node('pre', 'body-code', text);
function detailLink(parent, label, url) {
  const a = node('a', 'btn secondary', label); a.href = safeLink(url); a.target = '_blank'; a.rel = 'noreferrer noopener'; parent.append(a); return a;
}
function downloadJson(filename, data) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const u = URL.createObjectURL(blob); const a = node('a'); a.href = u; a.download = filename; document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(u), 1000);
}
function showDetail(img) {
  openPanel('detailPanel'); state.activeDetail = img;
  const parent = $('detailBody'); parent.replaceChildren();
  const url = safeLink(img.url);
  if (url !== '#') { const picture = node('img', 'detail-image'); picture.src = url; picture.alt = galleryTitle(img); picture.referrerPolicy = 'no-referrer'; parent.append(picture); }
  const tier = workflowTier(img.meta), graph = extractWorkflow(img.meta);
  const meta = img.meta;
  const plainPrompt = meta?.prompt && typeof meta.prompt === 'string' && !meta.prompt.trim().startsWith('{') ? meta.prompt : '';
  const buttons = node('div', 'detail-buttons');
  detailLink(buttons, 'Open on Civitai ↗', `${siteHost()}/images/${encodeURIComponent(img.id)}`);
  addButton(buttons, isSaved(img) ? '♥ Saved' : '♡ Save image', () => { toggleSaved(img); showDetail(img); }, 'btn secondary');
  addButton(buttons, '⊘ Block uploader', () => blockUser(img.username), 'btn secondary');
  if (plainPrompt) addButton(buttons, '⧉ Copy prompt', () => app.copy(plainPrompt, 'Prompt copied'), 'btn secondary');
  parent.append(buttons);
  parent.append(title('GENERATION OVERVIEW'));
  parent.append(kvRows([
    ['Uploader', `@${img.username || 'unknown'}`], ['Image ID', String(img.id)],
    ['Resolution', `${img.width || '?'} × ${img.height || '?'}`],
    ['Base model', img.baseModel || 'Unspecified'],
    ['Metadata proof', tier === 'graph' ? 'Full structured ComfyUI graph' : tier === 'params' ? 'Generation parameters only' : 'Not provided'],
    ['Rating', img.nsfwLevel || 'Unspecified'],
    ['Created', img.createdAt ? new Date(img.createdAt).toLocaleDateString() : 'Unknown'],
  ]));
  const resources = resourcesOf(img);
  parent.append(title('REFERENCED CHECKPOINTS & FINE-TUNES'));
  if (resources.length) {
    const wrap = node('div', 'reslist');
    let owned = 0;
    for (const r of resources) {
      const name = r.modelName || (r.name ? String(r.name).replace(/\\/g, '/').split('/').pop() : '');
      const label = `${r.type || 'Resource'}${name ? ' · ' + name : ''}${r.modelVersionId ? ' · #' + r.modelVersionId : ''}${r.weight != null ? ' · ' + r.weight : ''}`;
      const mine = r.modelVersionId ? findByVersionId(r.modelVersionId) : findByName(r.name);
      const pill = node('span', 'resource-pill', label);
      if (mine.length) {
        owned++;
        pill.append(' ', node('span', 'lib-have', '✓ in My LoRAs'));
        pill.style.cursor = 'pointer';
        pill.title = `You have ${mine[0].filename} — click to show it`;
        pill.addEventListener('click', () => { closePanels(); app.go('loras', { search: mine[0].filename }); });
      }
      wrap.append(pill);
    }
    parent.append(wrap);
    parent.append(node('p', 'dim', `${owned ? `${owned} of these ${owned === 1 ? 'is' : 'are'} already in your library. ` : ''}Version IDs come from the uploader’s generation metadata. They are not independently verified.`));
  } else parent.append(node('p', 'dim', 'This upload does not report checkpoint/LoRA resource links in civitaiResources.'));
  parent.append(title('PROMPT & PARAMETERS'));
  if (plainPrompt) parent.append(infoCode(plainPrompt));
  else parent.append(node('p', 'dim', 'No plain-text prompt available.'));
  if (meta?.negativePrompt) { parent.append(node('div', 'sub-label', 'Negative prompt')); parent.append(infoCode(meta.negativePrompt)); }
  parent.append(kvRows([['Seed', meta?.seed], ['Steps', meta?.steps], ['Sampler', meta?.sampler], ['CFG', meta?.cfgScale]]));
  parent.append(title('WORKFLOW DATA'));
  if (graph) {
    parent.append(node('p', 'dim', 'A structured node graph was detected. Export it as JSON for further inspection; execution may still require additional models or nodes.'));
    addButton(parent, '↓ Export workflow JSON', () => downloadJson(`civitai-workflow-${img.id}.json`, graph), 'btn primary wide');
    parent.append(infoCode(JSON.stringify(graph, null, 2)));
  } else parent.append(node('p', 'dim', 'No structured ComfyUI node graph is present in the public generation metadata. A prompt and seed alone do not count as a reusable workflow.'));
  if (meta) { parent.append(title('FULL RAW GENERATION METADATA')); addButton(parent, '↓ Save metadata JSON', () => downloadJson(`civitai-metadata-${img.id}.json`, meta), 'btn secondary'); parent.append(infoCode(JSON.stringify(meta, null, 2))); }
}
function showBlocks() {
  openPanel('modal'); $('modalEyebrow').textContent = 'PERSONAL FILTERS'; $('modalTitle').textContent = 'Blocked uploaders';
  const body = $('modalBody'); body.replaceChildren();
  body.append(node('p', 'model-msg', 'These usernames are hidden in your gallery on both sites and stored locally in your browser.'));
  const form = node('form', 'blocked-form');
  const input = node('input'); input.id = 'cv-blockedUsername'; input.placeholder = 'Add username to block'; input.autocomplete = 'off'; input.required = true;
  const lab = node('label', 'sub-label', 'Username to block'); lab.htmlFor = input.id; body.append(lab);
  const submit = node('button', 'btn primary', 'Block'); submit.type = 'submit'; form.append(input, submit);
  form.addEventListener('submit', (e) => { e.preventDefault(); blockUser(input.value.replace(/^@/, '').trim()); showBlocks(); });
  body.append(form);
  const list = node('div', 'blocked-list');
  for (const name of [...state.blocked].sort()) {
    const item = node('div', 'blocked-person'); item.append(node('span', '', `@${name}`)); addButton(item, 'Unblock', () => unblockUser(name)); list.append(item);
  }
  if (!state.blocked.size) list.append(node('div', 'dim', 'No uploaders blocked yet. Block people directly on image cards as you browse.'));
  body.append(list);
  input.focus();
}
let modelRequest = 0;
function setModel(model) {
  state.model = model;
  $('modelSummary').textContent = model ? `${model.type}: ${model.name}${model.versionName ? ' / ' + model.versionName : ''}` : 'Find checkpoint or LoRA…';
}
function chooseModel(model, version = null) {
  setModel({ id: model.id, versionId: version?.id || null, versionName: version?.name || '', name: model.name, type: model.type });
  closePanels(); restart();
}
function clearModel() { setModel(null); restart(); }
function modelRows(items, target, append = false) {
  if (!append) target.replaceChildren();
  if (!items?.length) { target.append(node('p', 'model-msg', 'No matching models found. Try a shorter name or a different site.')); return; }
  for (const model of items) {
    const item = node('div', 'model-result'); item.append(node('div', 'model-title', model.name || `Model #${model.id}`));
    item.append(node('div', 'model-sub', `${model.type}  ·  by @${model.creator?.username || 'unknown'}  ·  #${model.id}`));
    const versions = node('div', 'version-buttons');
    addButton(versions, 'Use all versions', () => chooseModel(model));
    for (const version of (model.modelVersions || [])) {
      const owned = findByVersionId(version.id).length > 0;
      addButton(versions, `${version.name || 'Version'} · #${version.id}${owned ? ' ✓ mine' : ''}`, () => chooseModel(model, version));
    }
    item.append(versions); target.append(item);
  }
}
function showModelSearch(initial = '') {
  openPanel('modal'); $('modalEyebrow').textContent = 'MODEL CATALOG'; $('modalTitle').textContent = 'Select checkpoint or fine-tune';
  const body = $('modalBody'); body.replaceChildren();
  body.append(node('p', 'model-msg', 'Find a Civitai model by its name. Select the whole model or a specific published version to search its gallery.'));
  const search = node('div', 'modal-search'), input = node('input'); input.id = 'cv-modelSearchName'; input.placeholder = 'Search model name…'; input.autocomplete = 'off';
  const lab = node('label', 'sub-label', 'Model name'); lab.htmlFor = input.id; body.append(lab);
  const kind = node('select');
  for (const [v, t] of [['', 'Any type'], ['Checkpoint', 'Checkpoint'], ['LORA', 'LoRA / fine-tune']]) { const opt = node('option', '', t); opt.value = v; kind.append(opt); }
  kind.setAttribute('aria-label', 'Model type'); kind.style.width = '180px'; search.append(input, kind); body.append(search);
  const results = node('div'); body.append(results);
  const manual = node('div'); manual.append(title('OR ENTER AN EXACT MODEL ID'));
  const idRow = node('div', 'modal-search'); const mid = node('input'); mid.type = 'number'; mid.min = '1'; mid.placeholder = 'Model ID'; mid.setAttribute('aria-label', 'Model ID');
  const vid = node('input'); vid.type = 'number'; vid.min = '1'; vid.placeholder = 'Version ID (optional)'; vid.setAttribute('aria-label', 'Version ID (optional)');
  const go = addButton(idRow, 'Use ID', () => {
    const id = Number(mid.value), version = Number(vid.value);
    if (!Number.isSafeInteger(id) || id <= 0) { mid.focus(); return; }
    chooseModel({ id, name: `Model #${id}`, type: 'Model' }, version > 0 ? { id: version, name: `Version #${version}` } : null);
  }, 'btn secondary'); go.style.flexShrink = '0'; idRow.append(mid, vid); manual.append(idRow); body.append(manual);
  let timer;
  const searchNow = async () => {
    body.querySelectorAll('.wide').forEach((button) => button.remove());
    const q = input.value.trim(); const request = ++modelRequest;
    if (!q) { results.replaceChildren(node('p', 'model-msg', 'Type a model name to search the catalog.')); return; }
    results.replaceChildren(node('p', 'model-msg', 'Searching models…'));
    try {
      const data = await api('/api/civitai/models', { q, modelType: kind.value });
      if (request !== modelRequest || $('modal').hidden) return;
      modelRows(data.items, results);
      let cursor = data.metadata?.nextCursor;
      const more = addButton(body, 'Load more models', async () => {
        if (!cursor || request !== modelRequest) return;
        more.disabled = true; more.textContent = 'Loading models…';
        try {
          const next = await api('/api/civitai/models', { q, modelType: kind.value, cursor });
          if (request !== modelRequest || $('modal').hidden) return;
          modelRows(next.items, results, true);
          cursor = next.metadata?.nextCursor;
          more.hidden = !cursor;
        } catch (err) { showNotice(err.message); }
        finally { more.disabled = false; more.textContent = 'Load more models'; }
      }, 'btn secondary wide');
      more.hidden = !cursor;
    } catch (err) { if (request === modelRequest) results.replaceChildren(node('p', 'model-msg', `Search failed: ${err.message}`)); }
  };
  const debounce = () => { clearTimeout(timer); timer = setTimeout(searchNow, 350); };
  input.addEventListener('input', debounce); kind.addEventListener('change', searchNow);
  results.append(node('p', 'model-msg', 'Search by checkpoint or LoRA title above.'));
  input.focus();
  if (initial) { input.value = initial; kind.value = 'LORA'; searchNow(); }
}

// ------------------------------------------------------------ tab hooks
export function init() {
  $('toggleFilters').addEventListener('click', () => {
    const expanded = $('imageFilters').classList.toggle('mobile-open');
    $('toggleFilters').setAttribute('aria-expanded', String(expanded));
    $('toggleFilters').textContent = expanded ? 'Hide image filters' : 'Show image filters';
  });
  $('siteCom').addEventListener('click', () => setSite('com'));
  $('siteRed').addEventListener('click', () => setSite('red'));
  $('closeDetail').addEventListener('click', closePanels); $('closeModal').addEventListener('click', closePanels); $('overlay').addEventListener('click', closePanels);
  document.addEventListener('keydown', (e) => {
    if (!app.isActive('civitai')) return;
    if (e.key === 'Escape') closePanels();
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); $('textQuery').focus(); }
  });
  $('textQuery').addEventListener('input', render);
  $('clearText').addEventListener('click', () => { $('textQuery').value = ''; render(); $('textQuery').focus(); });
  for (const el of document.querySelectorAll('input[name="cv-workflow"]')) el.addEventListener('change', render);
  for (const id of ['orientation', 'minLikes', 'onlySaved']) $(id).addEventListener('change', render);
  $('resourceType').addEventListener('change', async () => { if ($('resourceType').value === 'mine') await whenReady(); render(); });
  $('reload').addEventListener('click', restart); $('applyRemote').addEventListener('click', restart);
  $('loadMore').addEventListener('click', () => scanPages(1)); $('deepScan').addEventListener('click', () => scanPages(5));
  for (const id of ['sort', 'period', 'rating']) $(id).addEventListener('change', restart);
  for (const id of ['baseModel', 'uploader', 'tags']) $(id).addEventListener('keydown', (e) => { if (e.key === 'Enter') restart(); });
  $('findModel').addEventListener('click', () => showModelSearch()); $('clearModel').addEventListener('click', clearModel);
  $('manageBlocked').addEventListener('click', showBlocks);
  $('resetFilters').addEventListener('click', () => {
    document.querySelector('input[name="cv-workflow"][value="all"]').checked = true;
    for (const [id, value] of Object.entries({ resourceType: 'all', sort: 'Most Reactions', period: 'AllTime', baseModel: '', uploader: '', rating: '', orientation: 'all', minLikes: '0', textQuery: '', tags: '' })) $(id).value = value;
    $('onlySaved').checked = false; setModel(null); restart();
  });
  syncSite(); $('blockCount').textContent = String(state.blocked.size);
}

// ---- API key box: the key goes to this computer's server once and is never read back.
function showKey(info) {
  $('keyState').textContent = info.configured ? `SET ${info.hint}` : 'NOT SET';
  $('keyState').classList.toggle('new', info.configured);
  $('removeKey').hidden = info.source !== 'saved';
  $('apiKey').disabled = info.source === 'env';
  $('saveKey').disabled = info.source === 'env';
  if (info.source === 'env') $('apiKey').placeholder = 'Set by the CIVITAI_TOKEN environment variable';
  else $('apiKey').placeholder = info.configured ? 'Paste a new key to replace it' : 'Paste your API key';
  $('apiStatus').textContent = info.configured ? '● Using your API key' : '● Public API mode';
  $('apiStatus').title = info.configured ? 'Requests use your Civitai API key and its account permissions' : 'Public API connection. Your Civitai browser login is separate; an API key can enable account permissions.';
}

async function saveKey(token) {
  const btn = $('saveKey');
  btn.disabled = true;
  btn.textContent = token ? 'Checking…' : 'Save';
  try {
    const r = await fetch('/api/settings/civitai', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token }) });
    const body = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(body.error || `Could not save (${r.status})`);
    $('apiKey').value = '';
    showKey(body);
    app.toast(body.message || 'Saved');
    restart(); // reload the gallery with the new permissions
  } catch (e) {
    app.toast(e.message);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Save';
  }
}

export async function firstShow() {
  try {
    showKey(await fetch('/api/settings/civitai').then((r) => r.json()));
  } catch { $('apiStatus').textContent = '● API unavailable'; $('apiStatus').classList.add('off'); }
  $('keyForm').addEventListener('submit', (e) => { e.preventDefault(); const t = $('apiKey').value.trim(); if (t) saveKey(t); else app.toast('Paste your Civitai API key first'); });
  $('removeKey').addEventListener('click', () => { if (confirm('Remove the saved Civitai API key from this computer?')) saveKey(''); });
  // An action from another tab (handled synchronously in receive) may already have loaded the gallery.
  if (!state.started) restart();
}

export function receive(action) {
  if (action.model) {
    setModel(action.model);
    closePanels();
    restart();
  } else if (action.searchModel) {
    if (!state.started) restart();
    showModelSearch(action.searchModel);
  }
}
