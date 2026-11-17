// Workflow tab: drop images (or workflow .json files), see which ones carry a
// ComfyUI workflow, and preview the node graph. Everything is read in the browser.
import { app, escapeHtml } from './app.js';
import { readImageMetadata, fieldsToMap, analyze } from './meta.js';

const $ = (id) => document.getElementById(`wf-${id}`);
const SVGNS = 'http://www.w3.org/2000/svg';
const items = [];                // { id, key, file, url, kind, label, workflow, prompt, graph, analysis, error }
const known = new Set();
let nextId = 1;
let selected = null;
let view = { x: 0, y: 0, k: 1 };  // pan/zoom of the graph viewer
let graphBounds = null;
let selectedNode = null;

const KIND = {
  workflow: { badge: 'ComfyUI workflow', cls: 'ok' },
  api: { badge: 'API prompt only', cls: 'mid' },
  params: { badge: 'A1111 / Forge settings', cls: 'mid' },
  other: { badge: 'Other metadata', cls: 'low' },
  none: { badge: 'No workflow', cls: 'none' },
  error: { badge: 'Unreadable', cls: 'none' },
};

const parseJson = (v) => { if (v && typeof v === 'object') return v; try { return JSON.parse(v); } catch { return null; } };
const isUiWorkflow = (j) => Boolean(j && typeof j === 'object' && Array.isArray(j.nodes));
function apiNodes(j) {
  if (!j || typeof j !== 'object' || Array.isArray(j)) return null;
  const root = j.output && typeof j.output === 'object' ? j.output : j;
  const entries = Object.entries(root).filter(([, n]) => n && typeof n === 'object' && typeof n.class_type === 'string');
  return entries.length ? Object.fromEntries(entries) : null;
}

// ------------------------------------------------------------------ reading
async function readItem(item) {
  try {
    const isJson = /\.json$/i.test(item.file.name) || item.file.type === 'application/json';
    let map = {};
    if (isJson) {
      const j = parseJson(await item.file.text());
      if (!j) throw new Error('This .json file is not valid JSON');
      if (isUiWorkflow(j)) map.workflow = j;
      else if (apiNodes(j)) map.prompt = j;
      else throw new Error('This .json file is not a ComfyUI workflow');
    } else {
      const info = await readImageMetadata(await item.file.arrayBuffer());
      map = fieldsToMap(info.fields);
      item.fieldCount = info.fields.length;
    }
    const wf = parseJson(map.workflow);
    const pr = apiNodes(parseJson(map.prompt));
    item.workflow = isUiWorkflow(wf) ? wf : null;
    item.prompt = pr;
    item.analysis = analyze({ ...map, workflow: map.workflow && typeof map.workflow === 'object' ? JSON.stringify(map.workflow) : map.workflow, prompt: map.prompt && typeof map.prompt === 'object' ? JSON.stringify(map.prompt) : map.prompt });
    if (item.workflow) item.kind = 'workflow';
    else if (item.prompt) item.kind = 'api';
    else if (map.parameters) item.kind = 'params';
    else if (Object.keys(map).length) item.kind = 'other';
    else item.kind = 'none';
    item.parameters = map.parameters || null;
    item.nodeCount = item.workflow ? item.workflow.nodes.length : item.prompt ? Object.keys(item.prompt).length : 0;
    item.otherKeys = Object.keys(map);
  } catch (e) {
    item.kind = 'error';
    item.error = e.message;
  }
}

function addFiles(list) {
  const fresh = [];
  for (const file of list) {
    if (!/\.(png|jpe?g|webp|avif|json)$/i.test(file.name)) continue;
    const key = [file.name, file.size, file.lastModified, file.webkitRelativePath || ''].join('|');
    if (known.has(key)) continue;
    known.add(key);
    const item = { id: nextId++, key, file, url: /\.json$/i.test(file.name) ? null : URL.createObjectURL(file), kind: 'pending' };
    items.push(item);
    fresh.push(item);
  }
  if (!fresh.length) { app.toast('No new images or workflow files to add'); return; }
  drawList();
  (async () => {
    for (let i = 0; i < fresh.length; i++) {
      await readItem(fresh[i]);
      if (i % 8 === 7) { drawList(); await new Promise((r) => setTimeout(r, 0)); }
    }
    drawList();
    if (!selected) {
      const first = items.find((x) => x.kind === 'workflow' || x.kind === 'api');
      if (first) select(first);
    }
    const found = fresh.filter((x) => x.kind === 'workflow' || x.kind === 'api').length;
    app.toast(`${found} of ${fresh.length} file${fresh.length === 1 ? '' : 's'} carry a ComfyUI workflow`);
  })();
}

// ------------------------------------------------------------------ list
function drawList() {
  const counts = {};
  for (const it of items) counts[it.kind] = (counts[it.kind] || 0) + 1;
  const withGraph = (counts.workflow || 0) + (counts.api || 0);
  app.setCount('workflow', items.length || '');
  $('clear').disabled = !items.length;
  $('summary').innerHTML = items.length
    ? `<b>${items.length}</b> file${items.length === 1 ? '' : 's'} · <b style="color:var(--ok)">${withGraph}</b> with a ComfyUI workflow`
      + `${counts.api ? ` (${counts.api} API prompt only)` : ''}${counts.params ? ` · ${counts.params} A1111 settings` : ''}`
      + ` · ${(counts.none || 0) + (counts.other || 0) + (counts.error || 0)} without${counts.pending ? ` · reading ${counts.pending}…` : ''}`
    : 'No files yet. Drop images from ComfyUI, Civitai or anywhere else.';
  const onlyGraph = $('onlyGraph').checked;
  const q = $('search').value.trim().toLowerCase();
  const shown = items.filter((it) => (!onlyGraph || it.kind === 'workflow' || it.kind === 'api')
    && (!q || it.file.name.toLowerCase().includes(q) || (it.analysis && [it.analysis.model, it.analysis.prompt, it.analysis.loras.map((l) => l.name).join(' ')].join(' ').toLowerCase().includes(q))));
  $('list').replaceChildren(...shown.map((it) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = `wf-item${it === selected ? ' on' : ''}`;
    const k = KIND[it.kind] || { badge: 'Reading…', cls: 'none' };
    const extra = it.nodeCount ? ` · ${it.nodeCount} nodes` : '';
    b.innerHTML = `${it.url ? `<img src="${it.url}" alt="" loading="lazy">` : '<span class="wf-jsonicon">{ }</span>'}
      <span class="wf-itemtext"><span class="wf-itemname">${escapeHtml(it.file.webkitRelativePath || it.file.name)}</span>
      <span class="wf-badge ${k.cls}">${escapeHtml(k.badge)}${extra}</span></span>`;
    b.onclick = () => select(it);
    return b;
  }));
  if (items.length && !shown.length) $('list').innerHTML = '<p class="wf-none">No files match. Clear the search or untick “Only files with a workflow”.</p>';
}

// ------------------------------------------------------------------ graph model
const SLOT_H = 20;
const TITLE_H = 30;
const TYPE_COLORS = {
  MODEL: '#b39ddb', CLIP: '#ffd500', VAE: '#ff6e6e', CONDITIONING: '#ffa931', LATENT: '#ff9cf9', IMAGE: '#64b5f6',
  MASK: '#81c784', CONTROL_NET: '#00d78d', CLIP_VISION: '#a8dadc', INT: '#29b6f6', FLOAT: '#26a69a', STRING: '#9ccc65', NOISE: '#bbb', SAMPLER: '#ecb4b4', SIGMAS: '#cdffcd', GUIDER: '#66ffff',
};
const typeColor = (t) => TYPE_COLORS[String(t || '').toUpperCase()] || '#9aa7b4';
const xy = (v, i) => (Array.isArray(v) ? Number(v[i]) : v && typeof v === 'object' ? Number(v[i] ?? v[i === 0 ? 'x' : 'y'] ?? v[String(i)]) : 0) || 0;
const fmtValue = (v) => (v === null || v === undefined ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v));

/** UI workflow -> { nodes: [{id,title,type,x,y,w,h,inputs,outputs,widgets,mode,color,bgcolor,collapsed}], links, groups } */
function modelFromWorkflow(wf) {
  const nodes = wf.nodes.map((n) => {
    const values = Array.isArray(n.widgets_values) ? n.widgets_values : n.widgets_values && typeof n.widgets_values === 'object' ? Object.values(n.widgets_values) : [];
    const objNames = n.widgets_values && !Array.isArray(n.widgets_values) && typeof n.widgets_values === 'object' ? Object.keys(n.widgets_values) : null;
    // Names are only shown when they line up one-to-one with the values (seed widgets add an
    // extra "control after generate" value, which would shift every label after it).
    let widgetNames = (n.inputs || []).filter((i) => i.widget && i.widget.name).map((i) => i.widget.name);
    if (widgetNames.length !== values.length) widgetNames = [];
    return {
      id: String(n.id), type: String(n.type || 'Node'), title: n.title || n.type || 'Node',
      x: xy(n.pos, 0), y: xy(n.pos, 1), w: Math.max(80, xy(n.size, 0) || 200), h: Math.max(20, xy(n.size, 1) || 60),
      inputs: (n.inputs || []).filter((i) => !(i.widget && i.link == null)).map((i) => ({ name: i.label || i.localized_name || i.name, type: i.type, link: i.link })),
      inputsAll: n.inputs || [],
      outputs: (n.outputs || []).map((o) => ({ name: o.label || o.localized_name || o.name, type: o.type, links: o.links || [] })),
      widgets: values.map((v, i) => ({ name: objNames ? objNames[i] : widgetNames[i] || '', value: v })).filter((w) => w.value !== null && w.value !== undefined),
      mode: n.mode || 0, color: n.color, bgcolor: n.bgcolor, collapsed: Boolean(n.flags && n.flags.collapsed),
    };
  });
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const links = [];
  for (const l of wf.links || []) {
    const r = Array.isArray(l) ? { id: l[0], from: l[1], fromSlot: l[2], to: l[3], toSlot: l[4], type: l[5] } : l && { id: l.id, from: l.origin_id, fromSlot: l.origin_slot, to: l.target_id, toSlot: l.target_slot, type: l.type };
    if (!r || !byId.has(String(r.from)) || !byId.has(String(r.to))) continue;
    const target = byId.get(String(r.to));
    // Input slot index among the *drawn* inputs (widget inputs without a link are hidden).
    const drawnIndex = target.inputs.findIndex((i) => i.link != null && String(i.link) === String(r.id));
    links.push({ from: String(r.from), fromSlot: Number(r.fromSlot) || 0, to: String(r.to), toSlot: drawnIndex >= 0 ? drawnIndex : Number(r.toSlot) || 0, type: r.type });
  }
  const groups = (wf.groups || []).map((g) => ({ title: g.title || '', x: xy(g.bounding, 0), y: xy(g.bounding, 1), w: Array.isArray(g.bounding) ? g.bounding[2] : 300, h: Array.isArray(g.bounding) ? g.bounding[3] : 200, color: g.color || '#3f789e' }));
  return { nodes, links, groups, api: false };
}

/** API prompt (no layout stored) -> laid out left to right by dependency depth. */
function modelFromPrompt(pr) {
  const ids = Object.keys(pr);
  const isLink = (v) => Array.isArray(v) && v.length === 2 && pr[String(v[0])] && Number.isInteger(Number(v[1]));
  const depth = new Map();
  const depthOf = (id, seen = new Set()) => {
    if (depth.has(id)) return depth.get(id);
    if (seen.has(id)) return 0;
    seen.add(id);
    let d = 0;
    for (const v of Object.values(pr[id].inputs || {})) if (isLink(v)) d = Math.max(d, depthOf(String(v[0]), seen) + 1);
    depth.set(id, d);
    return d;
  };
  ids.forEach((id) => depthOf(id));
  const outCount = new Map();
  for (const id of ids) for (const v of Object.values(pr[id].inputs || {})) if (isLink(v)) outCount.set(String(v[0]), Math.max(outCount.get(String(v[0])) || 0, Number(v[1]) + 1));
  const columns = new Map();
  const nodes = [];
  const links = [];
  for (const id of ids.sort((a, b) => depth.get(a) - depth.get(b) || Number(a) - Number(b))) {
    const n = pr[id];
    const inputs = [];
    const widgets = [];
    for (const [name, v] of Object.entries(n.inputs || {})) {
      if (isLink(v)) { links.push({ from: String(v[0]), fromSlot: Number(v[1]), to: id, toSlot: inputs.length, type: '' }); inputs.push({ name, type: '' }); }
      else widgets.push({ name, value: v });
    }
    const outputs = Array.from({ length: outCount.get(id) || 0 }, (_, i) => ({ name: `output ${i + 1}`, type: '' }));
    const longText = widgets.some((w) => typeof w.value === 'string' && w.value.length > 60);
    const h = Math.max(inputs.length, outputs.length) * SLOT_H + widgets.length * 18 + (longText ? 60 : 12);
    const d = depth.get(id);
    const colY = columns.get(d) || 0;
    nodes.push({ id, type: n.class_type, title: (n._meta && n._meta.title) || n.class_type, x: d * 340, y: colY, w: 280, h, inputs, outputs, widgets, mode: 0 });
    columns.set(d, colY + h + TITLE_H + 40);
  }
  // Link types: guess from the input name so wires get useful colors.
  for (const l of links) {
    const target = nodes.find((n) => n.id === l.to);
    const name = String(target && target.inputs[l.toSlot] ? target.inputs[l.toSlot].name : '').toLowerCase();
    l.type = /model/.test(name) ? 'MODEL' : /clip/.test(name) ? 'CLIP' : /vae/.test(name) ? 'VAE' : /positive|negative|cond/.test(name) ? 'CONDITIONING' : /latent|samples/.test(name) ? 'LATENT' : /image|pixels/.test(name) ? 'IMAGE' : '';
  }
  return { nodes, links, groups: [], api: true };
}

// ------------------------------------------------------------------ drawing
function svg(tag, attrs, parent) {
  const e = document.createElementNS(SVGNS, tag);
  for (const [k, v] of Object.entries(attrs || {})) if (v !== undefined && v !== null) e.setAttribute(k, v);
  if (parent) parent.append(e);
  return e;
}
const clip = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

function drawGraph(model) {
  const stage = $('svg');
  stage.replaceChildren();
  const root = svg('g', { id: 'wf-root' }, stage);
  const nodeById = new Map(model.nodes.map((n) => [n.id, n]));

  for (const g of model.groups) {
    svg('rect', { x: g.x, y: g.y, width: g.w, height: g.h, rx: 6, fill: g.color, 'fill-opacity': 0.18, stroke: g.color, 'stroke-opacity': 0.6 }, root);
    const t = svg('text', { x: g.x + 10, y: g.y + 24, class: 'wf-gtitle' }, root);
    t.textContent = g.title;
  }

  const slotPos = (n, side, i) => (n.collapsed
    ? { x: side === 'in' ? n.x : n.x + Math.min(n.w, 180), y: n.y - TITLE_H / 2 }
    : { x: side === 'in' ? n.x : n.x + n.w, y: n.y + SLOT_H * i + SLOT_H / 2 + 4 });
  const wires = svg('g', {}, root);
  for (const l of model.links) {
    const a = nodeById.get(l.from), b = nodeById.get(l.to);
    const p = slotPos(a, 'out', l.fromSlot), q = slotPos(b, 'in', l.toSlot);
    const dx = Math.max(40, Math.abs(q.x - p.x) * 0.5);
    svg('path', { d: `M${p.x},${p.y} C${p.x + dx},${p.y} ${q.x - dx},${q.y} ${q.x},${q.y}`, class: 'wf-wire', stroke: typeColor(l.type), 'data-from': l.from, 'data-to': l.to }, wires);
  }

  for (const n of model.nodes) {
    const g = svg('g', { class: `wf-node${n.mode === 2 ? ' muted' : n.mode === 4 ? ' bypass' : ''}`, 'data-id': n.id }, root);
    const w = n.collapsed ? Math.min(n.w, 180) : n.w;
    if (n.collapsed) {
      svg('rect', { x: n.x, y: n.y - TITLE_H, width: w, height: TITLE_H, rx: 10, fill: n.color || '#2b2f36', class: 'wf-box' }, g);
    } else {
      svg('rect', { x: n.x, y: n.y - TITLE_H, width: w, height: n.h + TITLE_H, rx: 8, fill: n.bgcolor || '#30343b', class: 'wf-box' }, g);
      svg('path', { d: `M${n.x},${n.y} v${-TITLE_H + 8} a8,8 0 0 1 8,-8 h${w - 16} a8,8 0 0 1 8,8 v${TITLE_H - 8} z`, fill: n.color || '#23262c' }, g);
    }
    const title = svg('text', { x: n.x + 10, y: n.y - 10, class: 'wf-title' }, g);
    title.textContent = clip(String(n.title), Math.max(6, Math.floor(w / 7.5)));
    if (n.collapsed) continue;
    n.inputs.forEach((s, i) => {
      const p = slotPos(n, 'in', i);
      svg('circle', { cx: p.x, cy: p.y, r: 5, fill: typeColor(s.type) }, g);
      const t = svg('text', { x: p.x + 10, y: p.y + 4, class: 'wf-slot' }, g);
      t.textContent = clip(String(s.name || ''), Math.floor(w / 15));
    });
    n.outputs.forEach((s, i) => {
      const p = slotPos(n, 'out', i);
      svg('circle', { cx: p.x, cy: p.y, r: 5, fill: typeColor(s.type) }, g);
      const t = svg('text', { x: p.x - 10, y: p.y + 4, class: 'wf-slot', 'text-anchor': 'end' }, g);
      t.textContent = clip(String(s.name || ''), Math.floor(w / 15));
    });
    // Widget values under the slots, as far as the node's height allows.
    let y = n.y + Math.max(n.inputs.length, n.outputs.length) * SLOT_H + 18;
    for (const wdg of n.widgets) {
      if (y > n.y + n.h - 4) break;
      const value = fmtValue(wdg.value).replace(/\s+/g, ' ');
      const long = value.length > Math.floor(w / 7) && typeof wdg.value === 'string';
      svg('rect', { x: n.x + 8, y: y - 13, width: w - 16, height: long ? Math.min(n.y + n.h - y + 8, 64) : 18, rx: 4, class: 'wf-widget' }, g);
      const t = svg('text', { x: n.x + 14, y, class: 'wf-wtext' }, g);
      if (long) {
        const per = Math.max(10, Math.floor((w - 28) / 6.4));
        const lines = [];
        for (let i = 0; i < value.length && lines.length < 3; i += per) lines.push(value.slice(i, i + per));
        lines.forEach((line, i) => { const s = svg('tspan', { x: n.x + 14, dy: i ? 15 : 0 }, t); s.textContent = i === 2 && value.length > per * 3 ? `${line.slice(0, -1)}…` : line; });
        y += Math.min(n.y + n.h - y + 8, 64) + 6;
      } else {
        t.textContent = clip(`${wdg.name ? `${wdg.name}: ` : ''}${value}`, Math.floor((w - 20) / 6.6));
        y += 22;
      }
    }
    g.addEventListener('click', (e) => { e.stopPropagation(); showNode(n, model); });
  }

  // Bounds for "fit".
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const n of model.nodes) { x0 = Math.min(x0, n.x); y0 = Math.min(y0, n.y - TITLE_H); x1 = Math.max(x1, n.x + n.w); y1 = Math.max(y1, n.y + n.h); }
  for (const g of model.groups) { x0 = Math.min(x0, g.x); y0 = Math.min(y0, g.y); x1 = Math.max(x1, g.x + g.w); y1 = Math.max(y1, g.y + g.h); }
  graphBounds = Number.isFinite(x0) ? { x0, y0, x1, y1 } : { x0: 0, y0: 0, x1: 400, y1: 300 };
  fit();
}

function applyView() {
  const g = document.getElementById('wf-root');
  if (g) g.setAttribute('transform', `translate(${view.x},${view.y}) scale(${view.k})`);
  $('zoomLabel').textContent = `${Math.round(view.k * 100)}%`;
}

function fit() {
  if (!graphBounds) return;
  const box = $('svg').getBoundingClientRect();
  const w = box.width || 800, h = box.height || 500, pad = 30;
  const gw = graphBounds.x1 - graphBounds.x0, gh = graphBounds.y1 - graphBounds.y0;
  view.k = Math.max(0.05, Math.min(1.5, Math.min((w - pad * 2) / gw, (h - pad * 2) / gh)));
  view.x = (w - gw * view.k) / 2 - graphBounds.x0 * view.k;
  view.y = (h - gh * view.k) / 2 - graphBounds.y0 * view.k;
  applyView();
}

function zoomAt(factor, cx, cy) {
  const k = Math.max(0.05, Math.min(4, view.k * factor));
  view.x = cx - (cx - view.x) * (k / view.k);
  view.y = cy - (cy - view.y) * (k / view.k);
  view.k = k;
  applyView();
}

function showNode(n, model) {
  selectedNode = n;
  for (const el of $('svg').querySelectorAll('.wf-node')) el.classList.toggle('sel', el.dataset.id === n.id);
  for (const el of $('svg').querySelectorAll('.wf-wire')) el.classList.toggle('hot', el.dataset.from === n.id || el.dataset.to === n.id);
  const ins = model.links.filter((l) => l.to === n.id).map((l) => `${escapeHtml(n.inputs[l.toSlot] ? n.inputs[l.toSlot].name : '?')} ← ${escapeHtml((model.nodes.find((x) => x.id === l.from) || {}).title || l.from)}`);
  $('node').innerHTML = `<div class="wf-nodehead"><b>${escapeHtml(n.title)}</b><span>${escapeHtml(n.type)} · #${escapeHtml(n.id)}${n.mode === 2 ? ' · muted' : n.mode === 4 ? ' · bypassed' : ''}</span><button class="ui-btn small" type="button" id="wf-nodeClose">Close</button></div>
    ${ins.length ? `<div class="wf-kv"><i>Inputs</i>${ins.map((s) => `<div>${s}</div>`).join('')}</div>` : ''}
    ${n.widgets.length ? `<div class="wf-kv"><i>Values</i>${n.widgets.map((w) => `<div>${w.name ? `<em>${escapeHtml(w.name)}</em> ` : ''}<span class="wf-val">${escapeHtml(fmtValue(w.value))}</span></div>`).join('')}</div>` : '<div class="wf-kv"><i>No widget values</i></div>'}`;
  $('node').hidden = false;
  $('nodeClose').onclick = () => { $('node').hidden = true; selectedNode = null; for (const el of $('svg').querySelectorAll('.sel,.hot')) el.classList.remove('sel', 'hot'); };
}

// ------------------------------------------------------------------ selection + actions
function download(name, text) {
  const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
  const a = document.createElement('a');
  a.href = url; a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}
const stem = (name) => name.replace(/\.[^.]+$/, '') || 'workflow';

function select(it) {
  selected = it;
  selectedNode = null;
  $('node').hidden = true;
  drawList();
  $('empty').hidden = true;
  $('viewer').hidden = false;
  $('name').textContent = it.file.webkitRelativePath || it.file.name;
  const k = KIND[it.kind] || KIND.none;
  const a = it.analysis;
  const facts = [];
  if (it.kind === 'error') facts.push(escapeHtml(it.error));
  if (a && a.model !== 'Unknown model') facts.push(`<b>Model</b> ${escapeHtml(a.model)}`);
  if (a && a.loras.length) facts.push(`<b>LoRAs</b> ${escapeHtml(a.loras.map((l) => `${l.name}${l.model !== null ? ` @${l.model}` : ''}`).join(', '))}`);
  if (a && a.stats.seed) facts.push(`<b>Seed</b> ${escapeHtml(a.stats.seed)}`);
  if (a && a.stats.steps) facts.push(`<b>Steps</b> ${escapeHtml(a.stats.steps)}`);
  if (a && a.stats.sampler) facts.push(`<b>Sampler</b> ${escapeHtml(a.stats.sampler)}`);
  $('facts').innerHTML = `<span class="wf-badge ${k.cls}">${escapeHtml(k.badge)}${it.nodeCount ? ` · ${it.nodeCount} nodes` : ''}</span>${facts.map((f) => `<span>${f}</span>`).join('')}`;
  $('dlWorkflow').hidden = !it.workflow;
  $('copyWorkflow').hidden = !it.workflow;
  $('dlPrompt').hidden = !it.prompt;
  $('toPrompt').hidden = !it.url;
  const graph = it.workflow || it.prompt;
  $('graphWrap').hidden = !graph;
  $('apiNote').hidden = it.kind !== 'api';
  $('noGraph').hidden = Boolean(graph);
  if (!graph) {
    $('noGraph').innerHTML = it.kind === 'params'
      ? `<h3>No node graph in this image</h3><p>It has A1111 / Forge generation settings instead:</p><pre>${escapeHtml(it.parameters)}</pre>`
      : it.kind === 'other'
        ? `<h3>No ComfyUI workflow in this image</h3><p>It has other metadata fields: ${escapeHtml(it.otherKeys.join(', '))}. Open it in the Prompt tab to read them.</p>`
        : it.kind === 'error' ? `<h3>Could not read this file</h3><p>${escapeHtml(it.error)}</p>`
          : '<h3>No workflow in this image</h3><p>The file carries no generation metadata at all. It may have been stripped, re-saved by an editor, or screenshotted. Only original ComfyUI “Save Image” files keep the workflow.</p>';
    return;
  }
  it.graph = it.graph || (it.workflow ? modelFromWorkflow(it.workflow) : modelFromPrompt(it.prompt));
  drawGraph(it.graph); // synchronous: the viewer is visible now, so fit() can measure it
}

function highlightSearch() {
  const q = $('nodeSearch').value.trim().toLowerCase();
  if (!selected || !selected.graph) return;
  let hits = 0;
  for (const el of $('svg').querySelectorAll('.wf-node')) {
    const n = selected.graph.nodes.find((x) => x.id === el.dataset.id);
    const hit = q && n && [n.title, n.type, ...n.widgets.map((w) => fmtValue(w.value))].join(' ').toLowerCase().includes(q);
    el.classList.toggle('hit', Boolean(hit));
    el.classList.toggle('dim', Boolean(q) && !hit);
    if (hit) hits++;
  }
  $('searchCount').textContent = q ? `${hits} node${hits === 1 ? '' : 's'}` : '';
}

async function filesFromDrop(dt) {
  const entries = [...dt.items].map((i) => i.webkitGetAsEntry?.()).filter(Boolean);
  if (!entries.some((e) => e.isDirectory)) return [...dt.files];
  const files = [];
  async function walk(entry) {
    if (entry.isFile) { const f = await new Promise((res) => entry.file(res, () => res(null))); if (f) files.push(f); }
    else if (entry.isDirectory) {
      const reader = entry.createReader();
      for (;;) { const chunk = await new Promise((res) => reader.readEntries(res, () => res([]))); if (!chunk.length) break; await Promise.all(chunk.map(walk)); }
    }
  }
  await Promise.all(entries.map(walk));
  return files;
}

export function init() {
  $('add').addEventListener('click', () => $('files').click());
  $('addFolder').addEventListener('click', () => $('folder').click());
  for (const id of ['files', 'folder']) $(id).addEventListener('change', (e) => { addFiles(e.target.files); e.target.value = ''; });
  $('clear').addEventListener('click', () => {
    for (const it of items) if (it.url) URL.revokeObjectURL(it.url);
    items.length = 0; known.clear(); selected = null;
    $('viewer').hidden = true; $('empty').hidden = false; drawList();
  });
  $('onlyGraph').addEventListener('change', drawList);
  $('search').addEventListener('input', drawList);
  $('nodeSearch').addEventListener('input', highlightSearch);
  $('fit').addEventListener('click', fit);
  $('zoomIn').addEventListener('click', () => { const b = $('svg').getBoundingClientRect(); zoomAt(1.25, b.width / 2, b.height / 2); });
  $('zoomOut').addEventListener('click', () => { const b = $('svg').getBoundingClientRect(); zoomAt(0.8, b.width / 2, b.height / 2); });
  $('dlWorkflow').addEventListener('click', () => selected && selected.workflow && download(`${stem(selected.file.name)}.workflow.json`, JSON.stringify(selected.workflow, null, 2)));
  $('copyWorkflow').addEventListener('click', () => selected && selected.workflow && app.copy(JSON.stringify(selected.workflow), 'Workflow JSON copied — paste it into ComfyUI with Ctrl+V'));
  $('dlPrompt').addEventListener('click', () => selected && selected.prompt && download(`${stem(selected.file.name)}.api.json`, JSON.stringify(selected.prompt, null, 2)));
  $('toPrompt').addEventListener('click', () => selected && app.go('prompt', { file: selected.file }));
  $('full').addEventListener('click', () => {
    const on = document.getElementById('tab-workflow').classList.toggle('wf-full');
    $('full').textContent = on ? 'Exit full screen ✕' : 'Full screen ⛶';
    requestAnimationFrame(fit);
  });

  // Pan with drag, zoom with the wheel (around the cursor).
  const stage = $('svg');
  let drag = null;
  let suppressClick = false;
  stage.addEventListener('pointerdown', (e) => { if (e.button === 0) drag = { x: e.clientX, y: e.clientY, vx: view.x, vy: view.y, moved: false }; });
  stage.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
    if (!drag.moved && Math.abs(dx) + Math.abs(dy) > 3) {
      // Capture only once it is a real drag, so plain clicks still reach the nodes.
      drag.moved = true; stage.classList.add('panning');
      try { stage.setPointerCapture(e.pointerId); } catch { /* pointer already gone */ }
    }
    if (drag.moved) { view.x = drag.vx + dx; view.y = drag.vy + dy; applyView(); }
  });
  const end = () => {
    if (drag && drag.moved) { suppressClick = true; setTimeout(() => { suppressClick = false; }, 0); }
    drag = null; stage.classList.remove('panning');
  };
  stage.addEventListener('pointerup', end);
  stage.addEventListener('pointercancel', end);
  // A click that ends a pan must not select the node under the pointer.
  stage.addEventListener('click', (e) => { if (suppressClick) e.stopPropagation(); }, true);
  stage.addEventListener('wheel', (e) => {
    e.preventDefault();
    const b = stage.getBoundingClientRect();
    zoomAt(e.deltaY < 0 ? 1.15 : 1 / 1.15, e.clientX - b.left, e.clientY - b.top);
  }, { passive: false });
  window.addEventListener('resize', () => { if (app.isActive('workflow') && selected && selected.graph) fit(); });

  const tab = document.getElementById('tab-workflow');
  const drop = $('drop');
  let depth = 0;
  tab.addEventListener('dragenter', (e) => { e.preventDefault(); depth++; drop.classList.add('dragging'); });
  tab.addEventListener('dragleave', () => { if (--depth <= 0) { depth = 0; drop.classList.remove('dragging'); } });
  tab.addEventListener('dragover', (e) => { e.preventDefault(); if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy'; });
  tab.addEventListener('drop', async (e) => {
    e.preventDefault(); depth = 0; drop.classList.remove('dragging');
    if (e.dataTransfer) addFiles(await filesFromDrop(e.dataTransfer));
  });
  document.addEventListener('keydown', (e) => {
    if (!app.isActive('workflow') || !selected || !selected.graph) return;
    if (['INPUT', 'SELECT', 'TEXTAREA'].includes(document.activeElement?.tagName)) return;
    if (e.key === '0') { fit(); }
    if (e.key === 'Escape' && tab.classList.contains('wf-full')) $('full').click();
  });
}

export function show() { if (selected && selected.graph) requestAnimationFrame(fit); }

/** From other tabs: { files: [File] } */
export function receive(action) { if (action.files) addFiles(action.files); }
