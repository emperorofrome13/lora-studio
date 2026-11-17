// Lossless metadata stripping for PNG, JPEG and WebP.
//
// Works on the file's container structure only: image data is copied byte for
// byte and never re-encoded, so pixels are identical. Everything that is not
// needed to draw the image is dropped (text chunks, EXIF, XMP, IPTC, comments,
// thumbnails, timestamps, embedded workflows, trailing data after the image).
//
// stripImage(bytes, { keepColor }) -> { format, ext, bytes, removed: [labels], warnings: [text] }
// Throws for formats it does not understand (the UI falls back to re-encoding).

const latin = new TextDecoder('latin1');
const ascii = (u, start, len) => latin.decode(u.subarray(start, start + len));

function concat(parts) {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

export function detectFormat(u) {
  if (u.length >= 8 && [137, 80, 78, 71, 13, 10, 26, 10].every((n, i) => u[i] === n)) return 'png';
  if (u.length >= 3 && u[0] === 0xff && u[1] === 0xd8 && u[2] === 0xff) return 'jpeg';
  if (u.length >= 12 && ascii(u, 0, 4) === 'RIFF' && ascii(u, 8, 4) === 'WEBP') return 'webp';
  return null;
}

// ------------------------------------------------------------------ PNG
const PNG_IMAGE = new Set(['IHDR', 'PLTE', 'tRNS', 'IDAT', 'IEND', 'acTL', 'fcTL', 'fdAT']);
const PNG_COLOR = new Set(['iCCP', 'sRGB', 'gAMA', 'cHRM', 'cICP', 'mDCV', 'cLLI', 'sBIT']);
const PNG_NAMES = { eXIf: 'EXIF', tIME: 'timestamp (tIME)', pHYs: 'pixel density (pHYs)', iCCP: 'color profile (iCCP)', sRGB: 'sRGB flag', gAMA: 'gamma', cHRM: 'chromaticity', bKGD: 'background color', hIST: 'histogram', sPLT: 'palette suggestion', oFFs: 'offset', caNv: 'canvas info' };

function stripPng(u, opts) {
  const dv = new DataView(u.buffer, u.byteOffset, u.byteLength);
  const parts = [u.subarray(0, 8)];
  const removed = [];
  let off = 8;
  let sawEnd = false;
  while (off + 12 <= u.length) {
    const len = dv.getUint32(off);
    const type = ascii(u, off + 4, 4);
    const end = off + 12 + len;
    if (end > u.length) throw new Error('The PNG file is truncated or damaged');
    if (PNG_IMAGE.has(type) || (opts.keepColor && PNG_COLOR.has(type))) {
      parts.push(u.subarray(off, end));
    } else if (type === 'tEXt' || type === 'zTXt' || type === 'iTXt') {
      const data = u.subarray(off + 8, off + 8 + len);
      const z = data.indexOf(0);
      removed.push(`text "${z > 0 ? latin.decode(data.subarray(0, Math.min(z, 79))) : '?'}"`);
    } else {
      removed.push(PNG_NAMES[type] || `${type} chunk`);
    }
    off = end;
    if (type === 'IEND') { sawEnd = true; break; }
  }
  if (!sawEnd) throw new Error('The PNG file has no end marker');
  if (off < u.length) removed.push(`${u.length - off} bytes hidden after the image`);
  return { format: 'png', ext: '.png', bytes: concat(parts), removed, warnings: [] };
}

// ------------------------------------------------------------------ JPEG
function exifOrientation(seg) {
  // seg = APP1 payload starting with "Exif\0\0"
  try {
    const t = seg.subarray(6);
    const le = t[0] === 0x49;
    const dv = new DataView(t.buffer, t.byteOffset, t.byteLength);
    const ifd = dv.getUint32(4, le);
    const count = dv.getUint16(ifd, le);
    for (let i = 0; i < count; i++) {
      const e = ifd + 2 + i * 12;
      if (dv.getUint16(e, le) === 0x0112) return dv.getUint16(e + 8, le);
    }
  } catch { /* malformed EXIF */ }
  return 1;
}

function jpegLabel(marker, payload) {
  const id = latin.decode(payload.subarray(0, 40));
  if (marker === 0xfe) return 'comment';
  if (marker === 0xe0) return id.startsWith('JFIF') ? 'JFIF header' : id.startsWith('JFXX') ? 'JFIF thumbnail' : 'APP0 block';
  if (marker === 0xe1) return id.startsWith('Exif') ? 'EXIF' : id.startsWith('http://ns.adobe.com/xap') ? 'XMP' : id.includes('xmp') ? 'XMP extension' : 'APP1 block';
  if (marker === 0xe2) return id.startsWith('ICC_PROFILE') ? 'color profile (ICC)' : id.startsWith('MPF') ? 'multi-picture data' : 'APP2 block';
  if (marker === 0xed) return 'Photoshop / IPTC';
  return `APP${marker - 0xe0} block`;
}

function stripJpeg(u, opts) {
  const parts = [u.subarray(0, 2)];
  const removed = [];
  const warnings = [];
  let pos = 2;
  let sawEnd = false;
  while (pos < u.length) {
    if (u[pos] !== 0xff) throw new Error('The JPEG file is damaged (bad marker)');
    const marker = u[pos + 1];
    if (marker === 0xff) { pos++; continue; }                  // fill byte
    if (marker === 0xd9) { parts.push(u.subarray(pos, pos + 2)); pos += 2; sawEnd = true; break; }
    if ((marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) { parts.push(u.subarray(pos, pos + 2)); pos += 2; continue; }
    if (pos + 4 > u.length) throw new Error('The JPEG file is truncated');
    const len = (u[pos + 2] << 8) | u[pos + 3];
    const end = pos + 2 + len;
    if (len < 2 || end > u.length) throw new Error('The JPEG file is truncated');
    const payload = u.subarray(pos + 4, end);
    const isApp = marker >= 0xe0 && marker <= 0xef;
    if (marker === 0xfe || isApp) {
      const label = jpegLabel(marker, payload);
      const adobe = marker === 0xee && latin.decode(payload.subarray(0, 5)) === 'Adobe'; // color transform flag, needed to decode
      const icc = marker === 0xe2 && label.startsWith('color profile');
      if (adobe || (icc && opts.keepColor)) parts.push(u.subarray(pos, end));
      else {
        if (!removed.includes(label)) removed.push(label);
        if (label === 'EXIF' && exifOrientation(payload) > 1) {
          warnings.push('This photo had an EXIF rotation tag. Without it, it may show sideways.');
        }
      }
      pos = end;
      continue;
    }
    parts.push(u.subarray(pos, end));
    pos = end;
    if (marker === 0xda) {
      // Entropy-coded scan data: runs until the next real marker (not 0xFF00 or a restart marker).
      let j = pos;
      while (j + 1 < u.length && !(u[j] === 0xff && u[j + 1] !== 0 && !(u[j + 1] >= 0xd0 && u[j + 1] <= 0xd7) && u[j + 1] !== 0xff)) j++;
      parts.push(u.subarray(pos, j));
      pos = j;
    }
  }
  if (!sawEnd) {
    parts.push(new Uint8Array([0xff, 0xd9]));
    warnings.push('The file had no end marker; one was added.');
  }
  if (pos < u.length) removed.push(`${u.length - pos} bytes hidden after the image`);
  return { format: 'jpeg', ext: '.jpg', bytes: concat(parts), removed, warnings };
}

// ------------------------------------------------------------------ WebP
const WEBP_IMAGE = new Set(['VP8 ', 'VP8L', 'VP8X', 'ALPH', 'ANIM', 'ANMF']);
const WEBP_NAMES = { EXIF: 'EXIF', 'XMP ': 'XMP', ICCP: 'color profile (ICC)' };

function stripWebp(u, opts) {
  const dv = new DataView(u.buffer, u.byteOffset, u.byteLength);
  const riffEnd = Math.min(u.length, 8 + dv.getUint32(4, true));
  const parts = [];
  const removed = [];
  let vp8x = null;
  let off = 12;
  while (off + 8 <= riffEnd) {
    const type = ascii(u, off, 4);
    const len = dv.getUint32(off + 4, true);
    if (off + 8 + len > u.length) throw new Error('The WebP file is truncated or damaged');
    const padded = len + (len & 1);
    if (WEBP_IMAGE.has(type) || (opts.keepColor && type === 'ICCP')) {
      const chunk = new Uint8Array(8 + padded);         // copy: VP8X flags are edited below
      chunk.set(u.subarray(off, Math.min(off + 8 + padded, u.length)));
      if (type === 'VP8X') vp8x = chunk;
      parts.push(chunk);
    } else {
      removed.push(WEBP_NAMES[type] || `${type.trim()} chunk`);
    }
    off += 8 + padded;
  }
  if (vp8x) vp8x[8] &= ~(0x08 | 0x04 | (opts.keepColor ? 0 : 0x20)); // clear EXIF, XMP (and ICC) flags
  if (riffEnd < u.length) removed.push(`${u.length - riffEnd} bytes hidden after the image`);
  const body = concat(parts);
  const head = new Uint8Array(12);
  head.set([0x52, 0x49, 0x46, 0x46]);
  new DataView(head.buffer).setUint32(4, 4 + body.length, true);
  head.set([0x57, 0x45, 0x42, 0x50], 8);
  return { format: 'webp', ext: '.webp', bytes: concat([head, body]), removed, warnings: [] };
}

// ------------------------------------------------------------------ Inspection
// inspectImage(bytes) -> { format, blocks: [{ name, kind, size }], found: [labels], clean }
// An independent second opinion used by "Double-check": it walks the container
// structure (every chunk / segment, classified as image data, color or metadata)
// and also scans the raw bytes for tell-tale metadata strings, so a leftover is
// caught even if it hides somewhere the structure walk does not expect.
const RAW_MARKERS = [
  ['<x:xmpmeta', 'XMP packet'], ['http://ns.adobe.com/xap/1.0/', 'XMP packet'], ['Exif\0\0', 'EXIF block'],
  ['"class_type"', 'ComfyUI prompt graph'], ['"last_node_id"', 'ComfyUI workflow graph'], ['"widgets_values"', 'ComfyUI workflow graph'],
  ['Negative prompt:', 'A1111 generation parameters'], ['Steps: ', 'A1111 generation parameters'], ['sampler_name', 'sampler settings'],
  ['parameters\0', '"parameters" text'], ['workflow\0', '"workflow" text'], ['prompt\0', '"prompt" text'],
  ['Photoshop 3.0', 'Photoshop / IPTC block'], ['<lora:', 'LoRA tag'], ['ComfyUI', 'the word "ComfyUI"'],
];

function inspectPng(u, blocks) {
  const dv = new DataView(u.buffer, u.byteOffset, u.byteLength);
  let off = 8;
  while (off + 12 <= u.length) {
    const len = dv.getUint32(off);
    const type = ascii(u, off + 4, 4);
    let name = type;
    if (type === 'tEXt' || type === 'zTXt' || type === 'iTXt') {
      const data = u.subarray(off + 8, Math.min(u.length, off + 8 + len));
      const z = data.indexOf(0);
      name = `${type} "${z > 0 ? latin.decode(data.subarray(0, Math.min(z, 79))) : '?'}"`;
    }
    blocks.push({ name, size: len, kind: PNG_IMAGE.has(type) ? 'image' : PNG_COLOR.has(type) ? 'color' : 'meta' });
    off += 12 + len;
    if (type === 'IEND') break;
  }
  return Math.min(off, u.length);
}

function inspectJpeg(u, blocks) {
  let pos = 2;
  while (pos + 1 < u.length) {
    if (u[pos] !== 0xff) break;
    const marker = u[pos + 1];
    if (marker === 0xff) { pos++; continue; }
    if (marker === 0xd9) { pos += 2; break; }
    if ((marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) { pos += 2; continue; }
    if (pos + 4 > u.length) break;
    const len = (u[pos + 2] << 8) | u[pos + 3];
    const end = Math.min(u.length, pos + 2 + len);
    const payload = u.subarray(pos + 4, end);
    if (marker === 0xfe || (marker >= 0xe0 && marker <= 0xef)) {
      const label = jpegLabel(marker, payload);
      const adobe = marker === 0xee && latin.decode(payload.subarray(0, 5)) === 'Adobe';
      blocks.push({ name: adobe ? 'Adobe color transform' : label, size: len, kind: adobe ? 'image' : label.startsWith('color profile') ? 'color' : label === 'JFIF header' ? 'header' : 'meta' });
    } else {
      blocks.push({ name: marker === 0xda ? 'image scan' : marker === 0xdb ? 'quantization table' : marker === 0xc4 ? 'Huffman table' : (marker >= 0xc0 && marker <= 0xcf) ? 'frame header' : `marker 0x${marker.toString(16)}`, size: len, kind: 'image' });
    }
    pos = end;
    if (marker === 0xda) {
      let j = pos;
      while (j + 1 < u.length && !(u[j] === 0xff && u[j + 1] !== 0 && !(u[j + 1] >= 0xd0 && u[j + 1] <= 0xd7) && u[j + 1] !== 0xff)) j++;
      pos = j;
    }
  }
  return Math.min(pos, u.length);
}

function inspectWebp(u, blocks) {
  const dv = new DataView(u.buffer, u.byteOffset, u.byteLength);
  const riffEnd = Math.min(u.length, 8 + dv.getUint32(4, true));
  let off = 12;
  while (off + 8 <= riffEnd) {
    const type = ascii(u, off, 4);
    const len = dv.getUint32(off + 4, true);
    blocks.push({ name: WEBP_NAMES[type] || type.trim(), size: len, kind: WEBP_IMAGE.has(type) ? 'image' : type === 'ICCP' ? 'color' : 'meta' });
    if (type === 'VP8X' && off + 9 <= u.length) {
      const flags = u[off + 8];
      if (flags & 0x08) blocks.push({ name: 'EXIF flag set in header', size: 0, kind: 'meta' });
      if (flags & 0x04) blocks.push({ name: 'XMP flag set in header', size: 0, kind: 'meta' });
    }
    off += 8 + len + (len & 1);
  }
  return riffEnd;
}

export function inspectImage(input) {
  const u = input instanceof Uint8Array ? input : new Uint8Array(input);
  const format = detectFormat(u);
  const blocks = [];
  let end = u.length;
  try {
    if (format === 'png') end = inspectPng(u, blocks);
    else if (format === 'jpeg') end = inspectJpeg(u, blocks);
    else if (format === 'webp') end = inspectWebp(u, blocks);
  } catch { blocks.push({ name: 'damaged structure', size: 0, kind: 'meta' }); }
  if (format && end < u.length) blocks.push({ name: `${u.length - end} bytes hidden after the image`, size: u.length - end, kind: 'meta' });
  const found = [];
  for (const b of blocks) if (b.kind === 'meta' && !found.includes(b.name)) found.push(b.name);
  // Raw scan of the whole file. latin1 maps every byte to one character, so indexOf finds byte strings.
  const raw = latin.decode(u);
  for (const [needle, label] of RAW_MARKERS) {
    const at = raw.indexOf(needle);
    if (at >= 0) {
      const tag = `${label} (found in the raw bytes)`;
      if (!found.includes(tag)) found.push(tag);
    }
  }
  return { format: format || 'other', blocks, found, clean: found.length === 0 };
}

export function stripImage(input, opts = {}) {
  const u = input instanceof Uint8Array ? input : new Uint8Array(input);
  const format = detectFormat(u);
  if (format === 'png') return stripPng(u, opts);
  if (format === 'jpeg') return stripJpeg(u, opts);
  if (format === 'webp') return stripWebp(u, opts);
  throw Object.assign(new Error('Not a PNG, JPEG or WebP file'), { unsupported: true });
}
