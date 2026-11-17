import { app, fetchJson } from './app.js';
import * as loras from './loras.js';
import * as civitai from './civitai.js';
import * as prompt from './prompt.js';
import * as grid from './grid.js';
import * as strip from './strip.js';
import * as workflow from './workflow.js';
import * as tester from './tester.js';

const tabs = { loras, civitai, prompt, grid, strip, workflow, tester };
for (const [name, mod] of Object.entries(tabs)) {
  app.register(name, mod);
  mod.init();
}

document.getElementById('tabs').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-tab]');
  if (btn) app.go(btn.dataset.tab);
});

// Number keys 1-7 switch tabs when you are not typing.
document.addEventListener('keydown', (e) => {
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  const el = document.activeElement;
  if (el && ['INPUT', 'SELECT', 'TEXTAREA'].includes(el.tagName) && el.type !== 'checkbox' && el.type !== 'radio') return;
  if (document.querySelector('.modal.open, #cv-modal:not([hidden]), #cv-detailPanel:not([hidden])')) return;
  const name = Object.keys(tabs)[Number(e.key) - 1];
  if (name) app.go(name);
});

let saved = null;
try { saved = localStorage.getItem('ls-tab'); } catch { /* storage blocked */ }
app.go(location.hash.slice(1) in tabs ? location.hash.slice(1) : saved in tabs ? saved : 'loras');

fetchJson('/api/health')
  .then((h) => {
    const el = document.getElementById('appVersion');
    el.textContent = `v${h.version} · ${h.copy || 'local'}`;
    el.title = `LoRA Studio v${h.version}, running from the "${h.copy}" folder at ${location.host}`;
  })
  .catch(() => { document.getElementById('appVersion').textContent = 'server offline'; });
