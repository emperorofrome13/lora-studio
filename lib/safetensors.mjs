// Read the human-readable metadata out of a .safetensors header.
//
// Layout: 8-byte little-endian header length, then that many bytes of UTF-8
// JSON. Metadata lives in the header's `__metadata__` object (modelspec.* for
// ComfyUI / AI-Toolkit, ss_* for kohya, plus a few Civitai keys). Only the
// header is read, so even multi-GB files are cheap.
import fs from 'node:fs/promises';

const normalizeKey = (key) => String(key).toLowerCase().replace(/[\s_\-.]/g, '');

const TITLE_KEYS = ['modelspectitle', 'title', 'modelname', 'civitaititle', 'ssoutputname'];
const TRIGGER_KEYS = ['modelspectriggerphrase', 'triggerword', 'trigger', 'sstriggerwords'];
const BASE_KEYS = ['modelspecarchitecture', 'ssbasemodelversion', 'sssdmodelname', 'basemodel',
  'basemodelname', 'basemodelversion', 'foundationmodel'];

function pickFirst(normalized, keys) {
  for (const key of keys) if (normalized[key]) return normalized[key];
  return null;
}

/** kohya's ss_tag_frequency: { dataset: { tag: count } } -> the three most frequent tags. */
export function triggerFromTagFrequency(raw) {
  if (!raw) return null;
  try {
    const counts = {};
    for (const dataset of Object.values(JSON.parse(raw))) {
      if (!dataset || typeof dataset !== 'object') continue;
      for (const [tag, count] of Object.entries(dataset)) {
        const clean = String(tag).trim();
        if (clean) counts[clean] = (counts[clean] || 0) + Number(count || 0);
      }
    }
    const top = Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([tag]) => tag);
    return top.length ? top.join(', ') : null;
  } catch {
    return null;
  }
}

/** Map a raw __metadata__ object onto { title, triggerWord, baseModel }. */
export function mapMetadata(rawMeta) {
  const out = { title: null, triggerWord: null, baseModel: null };
  if (!rawMeta || typeof rawMeta !== 'object') return out;
  const normalized = {};
  for (const [key, value] of Object.entries(rawMeta)) {
    if (value === null || value === undefined) continue;
    const text = String(value).trim();
    if (text) normalized[normalizeKey(key)] = text;
  }
  out.title = pickFirst(normalized, TITLE_KEYS);
  out.triggerWord = pickFirst(normalized, TRIGGER_KEYS) || triggerFromTagFrequency(normalized.sstagfrequency);
  out.baseModel = pickFirst(normalized, BASE_KEYS);
  return out;
}

async function readExact(handle, length, position) {
  const buffer = Buffer.alloc(length);
  let offset = 0;
  while (offset < length) {
    const { bytesRead } = await handle.read(buffer, offset, length - offset, position + offset);
    if (bytesRead === 0) break;
    offset += bytesRead;
  }
  return offset === length ? buffer : buffer.subarray(0, offset);
}

/** Never throws: unreadable or non-safetensors files give empty metadata. */
export async function readSafetensorsMetadata(filePath) {
  let handle;
  try {
    handle = await fs.open(filePath, 'r');
    const head = await readExact(handle, 8, 0);
    if (head.length < 8) return mapMetadata(null);
    const headerLen = Number(head.readBigUInt64LE(0));
    if (!Number.isSafeInteger(headerLen) || headerLen <= 0 || headerLen > 256 * 1024 * 1024) return mapMetadata(null);
    const header = JSON.parse((await readExact(handle, headerLen, 8)).toString('utf8'));
    return mapMetadata(header.__metadata__);
  } catch {
    return mapMetadata(null);
  } finally {
    if (handle) await handle.close().catch(() => {});
  }
}
