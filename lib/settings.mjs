// Small persistent settings store: data/settings.json. Shared by the LoRA Tester
// folder choice and the Civitai API key, so one never overwrites the other.
// data/ is local only: it is git-ignored and never included in the public export.
import fs from 'node:fs/promises';
import path from 'node:path';

export function createSettings(dataDir) {
  const file = path.join(dataDir, 'settings.json');
  let data = {};
  let writing = Promise.resolve();

  async function load() {
    try { data = JSON.parse(await fs.readFile(file, 'utf8')) || {}; } catch { data = {}; }
    return data;
  }

  /** Set (or with undefined/'' remove) one key and save atomically. Writes are queued. */
  function set(key, value) {
    if (value === undefined || value === null || value === '') delete data[key];
    else data[key] = value;
    const snapshot = JSON.stringify(data, null, 2);
    writing = writing.then(async () => {
      await fs.mkdir(dataDir, { recursive: true });
      const tmp = `${file}.tmp`;
      await fs.writeFile(tmp, snapshot);
      await fs.rename(tmp, file);
    });
    return writing;
  }

  return { load, set, get: (key) => data[key], file };
}
