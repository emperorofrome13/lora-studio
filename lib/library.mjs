// The LoRA library: saved folders, the on-disk cache of known files, and a
// background worker that hashes new files and looks them up on Civitai.
//
// The cache is held in memory and written atomically (temp file + rename), so
// the scanner and the background worker never race each other on the file.
import crypto from 'node:crypto';
import { createReadStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { readSafetensorsMetadata } from './safetensors.mjs';
import { lookupByHash as defaultLookup } from './civitai.mjs';

export function sha256File(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = createReadStream(filePath);
    stream.on('error', reject);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

/** Recursive, depth-limited listing so a junction loop cannot hang the server. */
export async function listSafetensors(dir, depth = 0) {
  let entries;
  try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return []; }
  const out = [];
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (depth < 10) out.push(...await listSafetensors(fullPath, depth + 1));
    } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.safetensors')) {
      try {
        const stat = await fs.stat(fullPath);
        out.push({ fullPath, filename: entry.name, size: stat.size, mtime: new Date(stat.mtime).toISOString() });
      } catch { /* unreadable file */ }
    }
  }
  return out;
}

async function readJson(file, fallback) {
  try { return JSON.parse((await fs.readFile(file, 'utf8')).replace(/^﻿/, '')); }
  catch { return fallback; }
}

let tmpSeq = 0;
async function writeJson(file, value) {
  const tmp = `${file}.${process.pid}.${++tmpSeq}.tmp`;
  try {
    await fs.writeFile(tmp, JSON.stringify(value, null, 2), 'utf8');
    await fs.rename(tmp, file);
  } catch (e) {
    await fs.unlink(tmp).catch(() => {});
    throw e;
  }
}

const sameFolder = (a, b) => a.toLowerCase() === b.toLowerCase();
const stripSep = (p) => (p.length > 3 && p.endsWith(path.sep) ? p.slice(0, -1) : p);
export const normalizeFolder = (value) => stripSep(path.resolve(String(value || '').trim()));

/**
 * Accept both this app's cache entries and the older lorabrowser format
 * ({ createdAt, metadata: { title, civitaiTitle, civitaiImage, ... } }).
 */
export function migrateEntry(raw) {
  if (!raw || typeof raw !== 'object' || !raw.fullPath) return null;
  if (raw.v === 2) return raw;
  const m = raw.metadata || {};
  const header = ('title' in m || 'triggerWord' in m || 'baseModel' in m)
    ? { title: m.title || null, triggerWord: m.triggerWord || null, baseModel: m.baseModel || null }
    : null;
  let civitai = null;
  if (raw.sha256) {
    civitai = m.civitaiTitle
      // Found before, but the old format kept no model/version ids: look those up again.
      ? { found: true, checkedAt: null, title: m.civitaiTitle, image: m.civitaiImage || null, modelId: null, versionId: null, trainedWords: [] }
      : { found: false, checkedAt: null };
  }
  return {
    v: 2,
    filename: raw.filename || path.basename(raw.fullPath),
    fullPath: raw.fullPath,
    size: raw.size || 0,
    mtime: raw.mtime || raw.createdAt || null,
    sha256: raw.sha256 || null,
    firstSeen: raw.firstSeen || null,
    header,
    civitai,
  };
}

const needsEnrichment = (e) => !e.sha256 || !e.civitai || (e.civitai.found && !e.civitai.modelId);

export function createLibrary({ dataDir, lookup = defaultLookup, hashFile = sha256File, delayMs = 250, log = console.log } = {}) {
  const cacheFile = path.join(dataDir, 'cache.json');
  const foldersFile = path.join(dataDir, 'folders.json');
  const cache = new Map();          // lower-case fullPath -> entry
  const newThisRun = new Set();     // lower-case fullPaths first seen since the server started
  const queue = [];
  const queued = new Set();
  let folders = [];
  let current = null;
  let working = false;
  let saveTimer = null;
  let saving = Promise.resolve();
  let startup = { scannedAt: null, folders: [] };

  function scheduleSave() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      saving = saving.then(() => writeJson(cacheFile, [...cache.values()])).catch((e) => log(`[library] could not save cache: ${e.message}`));
    }, 300);
  }

  async function flush() {
    if (saveTimer) {
      clearTimeout(saveTimer);
      saveTimer = null;
      saving = saving.then(() => writeJson(cacheFile, [...cache.values()]));
    }
    await saving;
  }

  async function load() {
    await fs.mkdir(dataDir, { recursive: true });
    const raw = await readJson(cacheFile, []);
    for (const item of Array.isArray(raw) ? raw : []) {
      const entry = migrateEntry(item);
      if (entry) cache.set(entry.fullPath.toLowerCase(), entry);
    }
    const data = await readJson(foldersFile, { folders: [] });
    const list = Array.isArray(data) ? data : data.folders;
    folders = (Array.isArray(list) ? list : [])
      .filter((f) => typeof f === 'string' && f.trim())
      .map(normalizeFolder)
      .filter((f, i, all) => all.findIndex((o) => sameFolder(o, f)) === i);
  }

  function enqueue(key) {
    if (queued.has(key)) return;
    queued.add(key);
    queue.push(key);
    work();
  }

  async function work() {
    if (working) return;
    working = true;
    try {
      while (queue.length) {
        const key = queue.shift();
        queued.delete(key);
        const entry = cache.get(key);
        if (!entry || !needsEnrichment(entry)) continue;
        current = entry.filename;
        try {
          if (!entry.sha256) { entry.sha256 = await hashFile(entry.fullPath); scheduleSave(); }
          const info = await lookup(entry.sha256);
          if (info) { entry.civitai = info; scheduleSave(); }
        } catch (e) {
          log(`[library] ${entry.filename}: ${e.message}`);
        }
        if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
      }
    } finally {
      working = false;
      current = null;
    }
  }

  function toApi(entry, root) {
    const key = entry.fullPath.toLowerCase();
    const h = entry.header || {};
    const c = entry.civitai || {};
    return {
      filename: entry.filename,
      fullPath: entry.fullPath,
      relativeDir: path.relative(root, path.dirname(entry.fullPath)).split(path.sep).join('/'),
      size: entry.size,
      createdAt: entry.mtime,
      isNew: newThisRun.has(key),
      sha256: entry.sha256,
      metadata: {
        title: h.title || null,
        triggerWord: h.triggerWord || null,
        baseModel: h.baseModel || null,
        civitaiChecked: Boolean(entry.civitai),
        civitaiTitle: c.title || null,
        civitaiImage: c.image || null,
        civitaiModelId: c.modelId || null,
        civitaiVersionId: c.versionId || null,
        civitaiVersionName: c.versionName || null,
        civitaiBaseModel: c.baseModel || null,
        trainedWords: c.trainedWords || [],
      },
    };
  }

  /** List a folder, record anything new, queue Civitai lookups, return the models. */
  async function scanFolder(folderPath) {
    const root = normalizeFolder(folderPath);
    const files = await listSafetensors(root);
    let added = 0;
    let dirty = false;
    const models = [];
    for (const file of files) {
      const key = file.fullPath.toLowerCase();
      let entry = cache.get(key);
      if (!entry) {
        entry = { v: 2, filename: file.filename, fullPath: file.fullPath, size: file.size, mtime: file.mtime,
          sha256: null, firstSeen: new Date().toISOString(), header: null, civitai: null };
        cache.set(key, entry);
        newThisRun.add(key);
        added++;
        dirty = true;
      } else if (entry.size !== file.size) {
        // Same path, different file: start over.
        Object.assign(entry, { size: file.size, mtime: file.mtime, sha256: null, header: null, civitai: null });
        dirty = true;
      } else if (entry.mtime !== file.mtime) {
        entry.mtime = file.mtime;
        entry.header = null;
        dirty = true;
      }
      if (!entry.header) {
        entry.header = await readSafetensorsMetadata(file.fullPath);
        dirty = true;
      }
      if (needsEnrichment(entry)) enqueue(key);
      models.push(toApi(entry, root));
    }
    if (dirty) scheduleSave();
    models.sort((a, b) => a.filename.localeCompare(b.filename));
    return { folder: root, total: files.length, added, models };
  }

  async function saveFolders() {
    await writeJson(foldersFile, { folders });
  }

  return {
    load,
    flush,
    scanFolder,
    get folders() { return [...folders]; },
    async addFolder(raw) {
      const folder = normalizeFolder(raw);
      const stat = await fs.stat(folder).catch(() => null);
      if (!stat) throw Object.assign(new Error(`Folder not found: ${folder}`), { status: 404 });
      if (!stat.isDirectory()) throw Object.assign(new Error(`Not a folder: ${folder}`), { status: 400 });
      const added = !folders.some((f) => sameFolder(f, folder));
      if (added) { folders.push(folder); await saveFolders(); }
      return { folder, added };
    },
    async removeFolder(raw) {
      const folder = normalizeFolder(raw);
      folders = folders.filter((f) => !sameFolder(f, folder));
      await saveFolders();
    },
    /** Startup check: scan every saved folder so newly added LoRAs are recorded. */
    async startupScan() {
      const report = { scannedAt: null, folders: [] };
      for (const folder of folders) {
        try {
          const r = await scanFolder(folder);
          report.folders.push({ folder, total: r.total, added: r.added, error: null });
          log(`[startup] ${folder}: ${r.total} file(s), ${r.added} new`);
        } catch (e) {
          report.folders.push({ folder, total: 0, added: 0, error: e.message });
        }
      }
      report.scannedAt = new Date().toISOString();
      startup = report;
      return report;
    },
    status() {
      return { ...startup, pending: queue.length + (current ? 1 : 0), current };
    },
    idle: () => new Promise((resolve) => {
      const check = () => (!working && !queue.length ? resolve() : setTimeout(check, 20));
      check();
    }),
  };
}
