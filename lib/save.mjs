// Save a cleaned image into a folder the user chose. Never overwrites: an
// existing name gets " (1)", " (2)", ... appended.
import fs from 'node:fs/promises';
import path from 'node:path';

const MAGIC = {
  '.png': (b) => b.length >= 8 && b.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])),
  '.jpg': (b) => b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  '.webp': (b) => b.length >= 12 && b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP',
};
MAGIC['.jpeg'] = MAGIC['.jpg'];

export const MAX_BYTES = 300 * 1024 * 1024;

// Files this server wrote since it started. Only these can be read back (for the
// Strip tab's "verify on disk" check), so the read route cannot expose other files.
const written = new Set();
const keyOf = (p) => path.resolve(p).toLowerCase();

/** Bytes of a file saved by saveImage in this server session, or null when it was not. */
export async function readSaved(target) {
  if (!target || !written.has(keyOf(target))) return null;
  return fs.readFile(path.resolve(target));
}

function badRequest(message) { return Object.assign(new Error(message), { status: 400 }); }

/** Windows-safe file name: no folders, no reserved characters or device names. */
export function safeName(raw) {
  // split('/') rather than path.basename: on Windows basename treats "a:" as a drive letter.
  let name = String(raw || '').replace(/\\/g, '/').split('/').pop()
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/[. ]+$/, '').trim();
  const ext = path.extname(name).toLowerCase();
  if (!MAGIC[ext]) throw badRequest('Only .png, .jpg, .jpeg and .webp files can be saved');
  let stem = name.slice(0, -ext.length) || 'image';
  if (/^(con|prn|aux|nul|com\d|lpt\d)$/i.test(stem)) stem = `_${stem}`;
  return `${stem.slice(0, 180)}${ext}`;
}

export async function saveImage(folderRaw, nameRaw, data) {
  const folderText = String(folderRaw || '').trim();
  if (!folderText) throw badRequest('Choose an output folder');
  if (!path.isAbsolute(folderText)) throw badRequest('Use a full folder path, like D:\\clean-images');
  const folder = path.resolve(folderText);
  const name = safeName(nameRaw);
  const ext = path.extname(name).toLowerCase();
  if (!MAGIC[ext](data)) throw badRequest('The data is not a valid image of that type');
  await fs.mkdir(folder, { recursive: true });
  const stem = name.slice(0, -ext.length);
  for (let n = 0; n < 10000; n++) {
    const target = path.join(folder, n ? `${stem} (${n})${ext}` : name);
    try {
      await fs.writeFile(target, data, { flag: 'wx' }); // wx = fail if it exists
      written.add(keyOf(target));
      return target;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
    }
  }
  throw new Error('Too many files with the same name in that folder');
}
