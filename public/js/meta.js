// Shared image metadata reading, used by the Prompt and Grid tabs.
//
//  readImageMetadata(buffer) -> { format, width, height, fields: [{key, value}] }
//    PNG tEXt / zTXt / iTXt, JPEG EXIF / XMP / COM, WebP EXIF / XMP.
//  extractPrompt(fields)     -> the positive prompt (port of the PromptExtractor app)
//  extractNegative(fields)   -> the negative prompt, when it can be told apart
//  analyze(map)              -> model, LoRAs, sampler settings (ComfyUI + A1111)

const latin = new TextDecoder('latin1');
const utf8 = new TextDecoder('utf-8');

async function inflate(bytes) {
  // 'deflate' in the Compression Streams API is zlib-wrapped data, as PNG uses.
  if (!('DecompressionStream' in globalThis)) return null;
  try {
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  } catch { return null; }
}

// ---------------------------------------------------------------- PNG
async function readPng(u, dv, out) {
  if (u.length < 24 || [137, 80, 78, 71, 13, 10, 26, 10].some((n, i) => u[i] !== n)) return false;
  out.format = 'png';
  out.width = dv.getUint32(16);
  out.height = dv.getUint32(20);
  let off = 8;
  while (off + 12 <= u.length) {
    const len = dv.getUint32(off);
    const type = latin.decode(u.subarray(off + 4, off + 8));
    const start = off + 8, end = start + len;
    if (end + 4 > u.length) break;
    const data = u.subarray(start, end);
    if (type === 'tEXt' || type === 'zTXt' || type === 'iTXt') {
      const z = data.indexOf(0);
      if (z > 0) {
        const key = latin.decode(data.subarray(0, z));
        let value = null;
        if (type === 'tEXt') value = latin.decode(data.subarray(z + 1));
        else if (type === 'zTXt') { const b = await inflate(data.subarray(z + 2)); value = b ? latin.decode(b) : null; }
        else {
          const compressed = data[z + 1] === 1;
          let p = z + 3;
          const langEnd = data.indexOf(0, p);
          if (langEnd >= 0) {
            p = langEnd + 1;
            const trEnd = data.indexOf(0, p);
            if (trEnd >= 0) {
              const body = data.subarray(trEnd + 1);
              if (compressed) { const b = await inflate(body); value = b ? utf8.decode(b) : null; }
              else value = utf8.decode(body);
            }
          }
        }
        if (value !== null) out.fields.push({ key, value });
      }
    }
    off = end + 4;
    if (type === 'IEND') break;
  }
  return true;
}

// ---------------------------------------------------------------- EXIF / XMP
function decodeAscii(bytes) {
  const text = utf8.decode(bytes).replace(/\0+$/, '');
  return text.trim() ? text : latin.decode(bytes).replace(/\0+$/, '');
}

function printableRatio(s) {
  if (!s.length) return 0;
  let ok = 0;
  for (const ch of s) { const c = ch.charCodeAt(0); if ((c >= 32 && c < 127) || c === 10 || c === 13 || c === 9) ok++; }
  return ok / s.length;
}

function decodeUserComment(bytes) {
  if (bytes.length >= 8) {
    const head = latin.decode(bytes.subarray(0, 8));
    const body = bytes.subarray(8);
    if (head.startsWith('UNICODE')) {
      // The spec says big-endian, but some writers use the file's byte order. Pick whichever reads as text.
      const be = new TextDecoder('utf-16be').decode(body).replace(/\0+$/, '');
      const le = new TextDecoder('utf-16le').decode(body).replace(/\0+$/, '');
      return printableRatio(le) > printableRatio(be) ? le : be;
    }
    if (head.startsWith('ASCII')) return latin.decode(body).replace(/\0+$/, '');
  }
  return decodeAscii(bytes);
}

// ComfyUI's WebP/JPEG savers store graphs as "prompt:{...}" / "workflow:{...}" in EXIF text tags.
function pushExifText(out, key, value) {
  const m = /^\s*(prompt|workflow)\s*:\s*([{[][\s\S]*)$/i.exec(value);
  if (m) out.fields.push({ key: m[1].toLowerCase(), value: m[2] });
  else out.fields.push({ key, value });
}

function readExif(t, out) {
  if (t.length < 8) return;
  const le = t[0] === 0x49 && t[1] === 0x49;
  const be = t[0] === 0x4d && t[1] === 0x4d;
  if (!le && !be) return;
  const dv = new DataView(t.buffer, t.byteOffset, t.byteLength);
  const u16 = (o) => dv.getUint16(o, le);
  const u32 = (o) => dv.getUint32(o, le);
  const unit = { 1: 1, 2: 1, 7: 1, 3: 2, 4: 4, 9: 4, 5: 8, 10: 8 };
  const seen = new Set();
  const ifd = (offset, depth) => {
    if (depth > 4 || offset < 0 || offset + 2 > t.length || seen.has(offset)) return;
    seen.add(offset);
    const count = u16(offset);
    for (let i = 0; i < count; i++) {
      const e = offset + 2 + i * 12;
      if (e + 12 > t.length) return;
      const tag = u16(e), type = u16(e + 2), n = u32(e + 4);
      const size = (unit[type] || 0) * n;
      if (tag === 0x8769) { ifd(u32(e + 8), depth + 1); continue; }
      if (!size) continue;
      const at = size <= 4 ? e + 8 : u32(e + 8);
      if (at < 0 || at + size > t.length) continue;
      const v = t.subarray(at, at + size);
      if (tag === 0x010e) pushExifText(out, 'ImageDescription', decodeAscii(v));
      else if (tag === 0x010f) pushExifText(out, 'Make', decodeAscii(v));
      else if (tag === 0x0110) pushExifText(out, 'Model', decodeAscii(v));
      else if (tag === 0x9286) pushExifText(out, 'UserComment', decodeUserComment(v));
      else if (tag === 0x9c9c) out.fields.push({ key: 'XPComment', value: new TextDecoder('utf-16le').decode(v).replace(/\0+$/, '') });
    }
  };
  ifd(u32(4), 0);
}

const isPromptKey = (k) => ['prompt', 'description', 'caption', 'text', 'input', 'query'].includes(k.trim().toLowerCase());

function readXmp(xmp, out) {
  const start = xmp.indexOf('<'), end = xmp.lastIndexOf('>');
  if (start < 0 || end <= start) return;
  try {
    const doc = new DOMParser().parseFromString(xmp.slice(start, end + 1), 'application/xml');
    if (doc.getElementsByTagName('parsererror').length) throw new Error('bad xml');
    for (const el of doc.getElementsByTagName('*')) {
      for (const attr of el.attributes) {
        if (isPromptKey(attr.localName) || /description/i.test(attr.localName)) out.fields.push({ key: attr.localName, value: attr.value });
      }
      if ((isPromptKey(el.localName) || /description/i.test(el.localName)) && el.textContent.trim()) {
        out.fields.push({ key: el.localName, value: el.textContent });
      }
    }
  } catch {
    const m = /<(?:[^:>]+:)?description[^>]*>([\s\S]*?)<\/(?:[^:>]+:)?description>/i.exec(xmp);
    if (m) out.fields.push({ key: 'Description', value: m[1].replace(/<[^>]*>/g, '') });
  }
}

// ---------------------------------------------------------------- JPEG
function readJpeg(u, dv, out) {
  if (u.length < 4 || u[0] !== 0xff || u[1] !== 0xd8) return false;
  out.format = 'jpeg';
  let off = 2;
  while (off + 4 <= u.length) {
    if (u[off] !== 0xff) break;
    const marker = u[off + 1];
    off += 2;
    if (marker === 0xd9 || marker === 0xda) break;
    const len = dv.getUint16(off);
    if (len < 2 || off + len > u.length) break;
    const data = u.subarray(off + 2, off + len);
    if (marker === 0xe1) {
      if (latin.decode(data.subarray(0, 6)) === 'Exif\0\0') readExif(data.subarray(6), out);
      else {
        const text = utf8.decode(data);
        if (/<x:xmpmeta|<rdf:RDF/i.test(text)) readXmp(text, out);
      }
    } else if (marker === 0xfe) {
      out.fields.push({ key: 'Comment', value: latin.decode(data) });
    } else if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker) && data.length >= 5) {
      out.height = (data[1] << 8) | data[2];
      out.width = (data[3] << 8) | data[4];
    }
    off += len;
  }
  return true;
}

// ---------------------------------------------------------------- WebP
function readWebp(u, dv, out) {
  if (u.length < 12 || latin.decode(u.subarray(0, 4)) !== 'RIFF' || latin.decode(u.subarray(8, 12)) !== 'WEBP') return false;
  out.format = 'webp';
  let off = 12;
  while (off + 8 <= u.length) {
    const type = latin.decode(u.subarray(off, off + 4));
    const len = dv.getUint32(off + 4, true);
    const start = off + 8;
    if (start + len > u.length) break;
    const data = u.subarray(start, start + len);
    if (type === 'VP8X' && len >= 10) {
      out.width = 1 + (data[4] | (data[5] << 8) | (data[6] << 16));
      out.height = 1 + (data[7] | (data[8] << 8) | (data[9] << 16));
    } else if (type === 'EXIF') {
      readExif(latin.decode(data.subarray(0, 6)) === 'Exif\0\0' ? data.subarray(6) : data, out);
    } else if (type === 'XMP ') {
      readXmp(utf8.decode(data), out);
    }
    off = start + len + (len % 2);
  }
  return true;
}

export async function readImageMetadata(buffer) {
  const u = new Uint8Array(buffer);
  const dv = new DataView(buffer);
  const out = { format: 'unknown', width: null, height: null, fields: [] };
  if (await readPng(u, dv, out)) return out;
  if (readJpeg(u, dv, out)) return out;
  if (readWebp(u, dv, out)) return out;
  return out;
}

/** First value per key, plus `parameters` for A1111 JPEG/WebP files that keep it in EXIF. */
export function fieldsToMap(fields) {
  const map = {};
  for (const { key, value } of fields) if (!(key in map)) map[key] = value;
  if (!map.parameters) {
    const a1111 = fields.find((f) => /^(UserComment|Comment|ImageDescription)$/.test(f.key) && /\nSteps:\s*\d+/i.test(f.value));
    if (a1111) map.parameters = a1111.value;
  }
  return map;
}

// ---------------------------------------------------------------- prompt extraction
const cleanText = (v) => String(v).replace(/\0/g, '').replace(/\r\n/g, '\n').replace(/\r/g, '\n').trim();
const cleanPrompt = (v) => cleanText(v).replace(/^"+|"+$/g, '').trim();
const looksLikeJson = (v) => /^\s*[{[]/.test(v);
const looksNegative = (v) => {
  const l = v.toLowerCase();
  return l.includes('worst quality') || l.includes('bad anatomy') || l.includes('negative prompt') || l.startsWith('low quality');
};
const mostlyMetadata = (v) => ['exif', 'xmp', 'photoshop', 'workflow', 'sampler', 'cfg scale', 'seed', 'software']
  .filter((w) => v.toLowerCase().includes(w)).length >= 3;

function parseJson(v) {
  if (v && typeof v === 'object') return v;
  try { return JSON.parse(v); } catch { return null; }
}

/** ComfyUI API prompt: follow sampler positive/negative links back to the text that feeds them. */
function comfyTexts(graph, which) {
  if (!graph || typeof graph !== 'object' || Array.isArray(graph)) return [];
  const nodes = graph.output && typeof graph.output === 'object' ? graph.output : graph;
  const isLink = (v) => Array.isArray(v) && v.length === 2 && (typeof v[0] === 'string' || typeof v[0] === 'number') && nodes[v[0]];
  const texts = [];
  const resolve = (id, depth, seen) => {
    const node = nodes[id];
    if (!node || depth > 8 || seen.has(String(id))) return;
    seen.add(String(id));
    // ConditioningZeroOut (common in CFG-1 Flux/Krea workflows) empties its input: no text flows through.
    if (/ZeroOut/i.test(String(node.class_type || ''))) return;
    const inputs = node.inputs || {};
    let found = false;
    for (const k of ['text', 'text_g', 'text_l', 'prompt', 'string', 'value', 'text_positive']) {
      const v = inputs[k];
      if (typeof v === 'string' && v.trim()) { texts.push(v.trim()); found = true; break; }
      if (isLink(v)) { resolve(v[0], depth + 1, seen); found = true; break; }
    }
    if (found) return;
    for (const [k, v] of Object.entries(inputs)) {
      if (isLink(v) && /cond|clip|text|prompt|string|positive/i.test(k)) resolve(v[0], depth + 1, seen);
    }
  };
  for (const node of Object.values(nodes)) {
    if (!node || typeof node !== 'object' || !node.inputs) continue;
    const link = node.inputs[which];
    if (isLink(link)) resolve(link[0], 0, new Set());
    else if (which === 'positive' && /BasicGuider/i.test(node.class_type || '') && isLink(node.inputs.conditioning)) {
      resolve(node.inputs.conditioning[0], 0, new Set());
    }
  }
  return [...new Set(texts)];
}

function findComfyPrompts(root) {
  const out = [];
  if (!root || typeof root !== 'object' || Array.isArray(root)) return out;
  for (const node of Object.values(root)) {
    if (!node || typeof node !== 'object' || !/CLIPTextEncode/i.test(String(node.class_type || ''))) continue;
    const text = node.inputs && node.inputs.text;
    if (typeof text === 'string' && text.trim() && !looksNegative(text)) out.push(text);
  }
  return out;
}

function findDirectPrompt(el) {
  if (Array.isArray(el)) {
    for (const item of el) { const f = findDirectPrompt(item); if (f) return f; }
  } else if (el && typeof el === 'object') {
    for (const [k, v] of Object.entries(el)) {
      if (typeof v === 'string' && isPromptKey(k) && !/negative/i.test(k) && v.trim()) return v;
    }
    for (const v of Object.values(el)) { const f = findDirectPrompt(v); if (f) return f; }
  }
  return null;
}

function promptFromJson(value) {
  const root = parseJson(value);
  if (!root) return null;
  const linked = comfyTexts(root, 'positive');
  if (linked.length) return cleanPrompt(linked.join('\n\n'));
  const comfy = findComfyPrompts(root);
  if (comfy.length) return cleanPrompt([...new Set(comfy)].join('\n\n'));
  const direct = findDirectPrompt(root);
  return direct ? cleanPrompt(direct) : null;
}

function a1111Prompt(value) {
  const normalized = value.replace(/\r\n/g, '\n').trim();
  let end = normalized.length;
  for (const marker of ['\nNegative prompt:', '\nSteps:', '\nSampler:', '\nSeed:', '\nCFG scale:', '\nSize:', '\nModel:']) {
    const i = normalized.toLowerCase().indexOf(marker.toLowerCase());
    if (i >= 0) end = Math.min(end, i);
  }
  const prompt = normalized.slice(0, end).trim();
  if (/^(steps|sampler|seed|cfg scale|size|model)\s*:/i.test(prompt)) return null;
  return prompt ? cleanPrompt(prompt) : null;
}

function promptFromValue(value) {
  if (!value || !String(value).trim()) return null;
  value = cleanText(value);
  if (looksLikeJson(value)) { const j = promptFromJson(value); if (j) return j; }
  const sd = a1111Prompt(value);
  if (sd) return sd;
  const named = /(?:^|[\n,;])\s*prompt\s*[:=]\s*([\s\S]+?)(?=(?:[\n,;]\s*(?:negative\s+prompt|steps|sampler|seed|cfg\s+scale|model|size)\s*[:=])|$)/i.exec(value);
  if (named) return cleanPrompt(named[1]);
  if (value.length < 4000 && !mostlyMetadata(value)) return cleanPrompt(value);
  return null;
}

export function extractPrompt(fields) {
  for (const key of ['parameters', 'prompt', 'Description', 'ImageDescription', 'UserComment', 'Comment']) {
    const f = fields.find((x) => x.key.toLowerCase() === key.toLowerCase());
    const p = promptFromValue(f && f.value);
    if (p) return p;
  }
  for (const f of fields) {
    const p = promptFromValue(f.value);
    if (p) return p;
  }
  return null;
}

export function extractNegative(fields) {
  const map = fieldsToMap(fields);
  if (map.parameters) {
    const m = /\nNegative prompt:\s*([\s\S]*?)(?=\n(?:Steps|Sampler|Seed|CFG scale|Size|Model)\s*:|$)/i.exec(String(map.parameters).replace(/\r\n/g, '\n'));
    if (m && m[1].trim()) return m[1].trim();
  }
  const graph = parseJson(map.prompt);
  const neg = comfyTexts(graph, 'negative');
  const pos = new Set(comfyTexts(graph, 'positive'));
  const own = neg.filter((t) => !pos.has(t));
  return own.length ? cleanPrompt(own.join('\n\n')) : null;
}

// ---------------------------------------------------------------- analysis (LoRA Lens)
const lower = (v) => String(v ?? '').toLowerCase();
const uniq = (xs) => [...new Set(xs.filter(Boolean))];
export const normalizeName = (s) => String(s ?? '').replace(/\\/g, '/').split('/').pop().replace(/\.(safetensors|ckpt|pt|pth|gguf)$/i, '').trim();
const isActive = (v) => !(v === false || v === 0 || v === 'false' || v === 'False');

export function analyze(meta) {
  const prompt = parseJson(meta.prompt), workflow = parseJson(meta.workflow);
  let nodes = [];
  if (prompt && typeof prompt === 'object') {
    const p = prompt.output && typeof prompt.output === 'object' ? prompt.output : prompt;
    nodes = Object.entries(p).filter(([, v]) => v && typeof v === 'object' && v.class_type)
      .map(([id, n]) => ({ id, type: String(n.class_type || ''), inputs: n.inputs || {} }));
  }
  if (!nodes.length && workflow && Array.isArray(workflow.nodes)) {
    nodes = workflow.nodes.map((n) => ({ id: String(n.id), type: String(n.type || ''),
      inputs: Object.fromEntries((n.inputs || []).map((x, i) => [x.name, (n.widgets_values || [])[i]])) }));
  }
  const modelNames = [], loras = [], allTexts = [], steps = [], samplers = [], schedulers = [], cfgs = [], seeds = [], denoises = [];
  // Round float noise from slider nodes (0.39999999999999974 -> 0.4).
  const val = (v) => (typeof v === 'number' ? Number(v.toFixed(4)) : typeof v === 'string' ? v : null);
  function addLora(name, sm, sc) {
    if (typeof name !== 'string' || !name.trim() || name.trim().startsWith('[')) return;
    const n = normalizeName(name);
    if (n) loras.push({ name: n, model: val(sm), clip: val(sc) });
  }
  function scanLoraObjects(obj, depth = 0) {
    if (depth > 3 || !obj || typeof obj !== 'object') return;
    if (Array.isArray(obj)) { obj.forEach((v) => scanLoraObjects(v, depth + 1)); return; }
    if ((obj.lora || obj.lora_name || obj.name) && ('strength' in obj || 'strength_model' in obj || 'weight' in obj || 'model_strength' in obj)
      && isActive(obj.on) && isActive(obj.enabled) && isActive(obj.active)) {
      addLora(obj.lora_name || obj.lora || obj.name, obj.strength_model ?? obj.model_strength ?? obj.strength ?? obj.weight, obj.strength_clip);
    }
    for (const [k, v] of Object.entries(obj)) if (/lora/i.test(k) && v && typeof v === 'object') scanLoraObjects(v, depth + 1);
  }
  for (const node of nodes) {
    const t = lower(node.type), i = node.inputs || {};
    if (/checkpoint|unetloader|unet_loader|diffusionmodelload|ggufloader|model_loader/.test(t)) {
      for (const k of ['ckpt_name', 'unet_name', 'model_name', 'checkpoint', 'diffusion_model', 'model_path']) {
        if (typeof i[k] === 'string' && i[k]) modelNames.push(normalizeName(i[k]));
      }
    }
    if (/lor(a|as)/.test(t) || Object.keys(i).some((k) => /lora_name|lora_\d|loras/i.test(k))) {
      if (isActive(i.on) && isActive(i.enabled) && isActive(i.active)) {
        if (typeof i.lora_name === 'string') addLora(i.lora_name, i.strength_model ?? i.strength ?? i.model_strength, i.strength_clip ?? i.clip_strength);
        for (const [k, v] of Object.entries(i)) {
          if (/^lora_?\d+(_name)?$/i.test(k)) {
            if (typeof v === 'string') addLora(v, i['strength_' + k] ?? i[k + '_strength'] ?? i.strength, null);
            else scanLoraObjects(v);
          } else if (/loras|lora_stack|lora_list/.test(lower(k))) scanLoraObjects(v);
        }
      }
    }
    if (/cliptextencode|textencode|prompt/.test(t)) {
      for (const k of ['text', 'text_g', 'text_l', 'text_positive', 'text_negative', 'prompt']) if (typeof i[k] === 'string' && i[k].trim()) allTexts.push(i[k].trim());
    }
    if (/ksampler|samplercustom|sampler/.test(t)) {
      for (const k of ['seed', 'noise_seed']) if (i[k] !== undefined && typeof i[k] !== 'object') seeds.push(i[k]);
      if (i.steps !== undefined) steps.push(i.steps);
      if (i.cfg !== undefined) cfgs.push(i.cfg);
      if (i.sampler_name !== undefined) samplers.push(i.sampler_name);
      if (i.scheduler !== undefined) schedulers.push(i.scheduler);
      if (i.denoise !== undefined) denoises.push(i.denoise);
    }
  }
  const parameters = String(meta.parameters || '');
  if (parameters) {
    const grab = (re, list, fn = (x) => x) => { const m = parameters.match(re); if (m) list.push(fn(m[1])); };
    grab(/(?:^|,)\s*Model:\s*([^,\n]+)/i, modelNames, normalizeName);
    grab(/(?:^|,)\s*Seed:\s*([^,\n]+)/i, seeds);
    grab(/(?:^|,)\s*Steps:\s*([^,\n]+)/i, steps);
    grab(/(?:^|,)\s*CFG scale:\s*([^,\n]+)/i, cfgs);
    grab(/(?:^|,)\s*Sampler:\s*([^,\n]+)/i, samplers);
    const pr = parameters.split(/\n(?:Steps|Negative prompt):/i)[0];
    if (pr) allTexts.push(pr);
    // "Lora: name:strength" settings entry (written by LoRA Tester).
    for (const m of parameters.matchAll(/(?:^|,)[ \t]*Lora:[ \t]*([^,\n]+?):([+-]?\d+(?:\.\d+)?)[ \t]*(?=,|\n|$)/gim)) addLora(m[1], Number(m[2]), null);
  }
  for (const text of [...allTexts, parameters]) for (const m of text.matchAll(/<lora:([^:>]+)(?::([+-]?[\d.]+))?>/gi)) addLora(m[1], m[2] ?? null, null);
  const simpleTexts = uniq(allTexts.map((x) => x.replace(/<lora:[^>]+>/gi, '').replace(/\s+/g, ' ').trim())).sort();
  const allLoras = uniq(loras.map((x) => JSON.stringify(x))).map((x) => JSON.parse(x)).sort((a, b) => a.name.localeCompare(b.name));
  const join = (xs) => uniq(xs.map(String)).sort().join(' / ');
  return {
    model: uniq(modelNames).join(' + ') || 'Unknown model',
    loras: allLoras,
    prompt: simpleTexts.join(' | '),
    stats: { seed: join(seeds), steps: join(steps), cfg: join(cfgs), sampler: join(samplers), scheduler: join(schedulers), denoise: join(denoises) },
    detected: Boolean(nodes.length || parameters),
  };
}

/** Everything the Prompt and Grid tabs need from one file. */
export async function readImageFile(file) {
  const info = await readImageMetadata(await file.arrayBuffer());
  const map = fieldsToMap(info.fields);
  return {
    ...info,
    map,
    analysis: analyze(map),
    prompt: extractPrompt(info.fields),
    negative: extractNegative(info.fields),
  };
}
