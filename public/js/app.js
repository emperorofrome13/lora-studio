// Tiny shared hub: tab switching, cross-tab actions, toasts and helpers.
const modules = {};
const started = new Set();
let toastTimer = 0;

export const app = {
  active: null,

  register(name, mod) { modules[name] = mod; },

  isActive(name) { return this.active === name; },

  /** Show a tab, optionally handing it an action (e.g. { search: 'name' }). */
  go(name, action) {
    if (!modules[name]) name = 'loras';
    if (this.active !== name) {
      this.active = name;
      for (const btn of document.querySelectorAll('#tabs button')) btn.classList.toggle('on', btn.dataset.tab === name);
      for (const tab of document.querySelectorAll('.tab')) tab.hidden = tab.id !== `tab-${name}`;
      document.body.classList.remove('focus-mode');
      try { localStorage.setItem('ls-tab', name); } catch { /* storage blocked */ }
      if (location.hash !== `#${name}`) history.replaceState(null, '', `#${name}`);
      const mod = modules[name];
      if (!started.has(name)) { started.add(name); mod.firstShow?.(); }
      mod.show?.();
      window.scrollTo(0, 0);
    }
    if (action) modules[name].receive?.(action);
  },

  toast(message) {
    const el = document.getElementById('toast');
    el.textContent = message;
    el.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('show'), 2200);
  },

  async copy(text, label = 'Copied') {
    try {
      await navigator.clipboard.writeText(text);
      this.toast(label);
    } catch {
      this.toast('Clipboard access was blocked by the browser');
    }
  },

  setCount(tab, text) {
    const el = document.getElementById(`tabcount-${tab}`);
    if (el) el.textContent = text ? String(text) : '';
  },
};

// ---------------------------------------------------------------- folder choosing
/**
 * Let the person choose a folder: the operating system's own picker first
 * (Explorer / Finder / zenity), or the in-app folder browser when there is none.
 * Resolves to the full folder path, or null when cancelled.
 */
export async function chooseFolder({ title = 'Choose a folder', start = '' } = {}) {
  let r;
  try {
    r = await fetchJson('/api/pick-folder', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title, start }) });
  } catch (e) {
    app.toast(e.message);
    return null;
  }
  if (r.status === 'ok') return r.folder;
  if (r.status === 'cancelled') return null;
  return browseFolders(title, start, r.reason); // no system picker here
}

function browseFolders(title, start, reason) {
  return new Promise((resolve) => {
    const box = document.createElement('div');
    box.className = 'fb-backdrop';
    box.innerHTML = `<div class="fb-box" role="dialog" aria-modal="true" aria-label="${escapeHtml(title)}">
      <div class="fb-head"><b>${escapeHtml(title)}</b><button type="button" class="ui-btn small" data-x>Cancel</button></div>
      ${reason ? `<p class="fb-note">${escapeHtml(reason)} Using the built-in folder browser instead.</p>` : ''}
      <div class="fb-roots"></div>
      <div class="fb-path"><button type="button" class="ui-btn small" data-up title="Up one folder">↑ Up</button><code></code></div>
      <div class="fb-list" tabindex="0"></div>
      <div class="fb-foot"><span class="fb-hint">Double-click a folder to open it.</span><button type="button" class="ui-btn primary" data-ok disabled>Use this folder</button></div>
    </div>`;
    document.body.append(box);
    const $ = (s) => box.querySelector(s);
    let current = '';
    const done = (value) => { box.remove(); document.removeEventListener('keydown', onKey, true); resolve(value); };
    const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); done(null); } };
    document.addEventListener('keydown', onKey, true);
    async function show(dir) {
      let data;
      try { data = await fetchJson(`/api/browse?path=${encodeURIComponent(dir)}`); } catch (e) { app.toast(e.message); return; }
      current = data.path;
      $('.fb-path code').textContent = current || 'Choose a drive or place';
      $('[data-up]').disabled = !current;
      $('[data-up]').onclick = () => show(data.parent || '');
      $('[data-ok]').disabled = !current;
      $('.fb-roots').replaceChildren(...data.roots.map((r) => {
        const b = document.createElement('button');
        b.type = 'button'; b.className = 'ui-btn small'; b.textContent = r.name; b.title = r.path;
        b.onclick = () => show(r.path);
        return b;
      }));
      const list = $('.fb-list');
      list.replaceChildren(...data.dirs.map((d) => {
        const b = document.createElement('button');
        b.type = 'button'; b.className = 'fb-item'; b.textContent = `📁 ${d.name}`; b.title = d.path;
        b.onclick = () => { for (const x of list.children) x.classList.remove('on'); b.classList.add('on'); };
        b.ondblclick = () => show(d.path);
        b.onkeydown = (e) => { if (e.key === 'Enter') show(d.path); };
        return b;
      }));
      if (!data.dirs.length) list.innerHTML = '<p class="fb-empty">No folders inside this one.</p>';
      list.scrollTop = 0;
    }
    $('[data-x]').onclick = () => done(null);
    box.addEventListener('click', (e) => { if (e.target === box) done(null); });
    $('[data-ok]').onclick = () => done(current || null);
    show(start || '');
  });
}

export async function fetchJson(url, options) {
  const response = await fetch(url, options);
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || `Request failed (${response.status})`);
  return body;
}

export const escapeHtml = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/** True while the user is typing in a field (keyboard shortcuts should stay out of the way). */
export const typing = () => {
  const el = document.activeElement;
  return Boolean(el && (['INPUT', 'SELECT', 'TEXTAREA'].includes(el.tagName) && el.type !== 'checkbox' && el.type !== 'radio' || el.isContentEditable));
};
