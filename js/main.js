/**
 * main.js — Application entry point.
 *
 * Imports the App controller and wires up DOM event listeners.
 * Handles theme initialization (respects system preference + saved choice).
 */

import { App, S } from './ui.js';

// Exposed for console debugging only. Nothing in the page calls through
// window any more — every handler is bound below, so the Content-Security
// -Policy in index.html can forbid inline script outright.
window.App = App;
window.S = S;

// ── Theme Initialization ─────────────────────────────────────────
// Use saved preference, or fall back to system preference (prefers-color-scheme)

const savedTheme = localStorage.getItem('metafaker.theme') ||
  (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
document.documentElement.setAttribute('data-theme', savedTheme);
document.getElementById('themeIcon').textContent = savedTheme === 'dark' ? 'light_mode' : 'dark_mode';

// ── Upload Zone Event Listeners ──────────────────────────────────

const zone = document.getElementById('uploadZone');
const input = document.getElementById('fileInput');

zone.addEventListener('click', () => input.click());

zone.addEventListener('dragover', e => {
  e.preventDefault();
  zone.classList.add('dragover');
});

zone.addEventListener('dragleave', () => zone.classList.remove('dragover'));

zone.addEventListener('drop', e => {
  e.preventDefault();
  zone.classList.remove('dragover');
  App.loadFiles(e.dataTransfer.files);
});

input.addEventListener('change', e => {
  App.loadFiles(e.target.files);
});

// ── Control Wiring ───────────────────────────────────────────────
// Bound here rather than as onclick="" attributes so the page needs no inline
// script, which is what lets the CSP block script injection outright.

const bind = (id, fn) => {
  const el = document.getElementById(id);
  if (el) el.addEventListener('click', fn);
};

bind('btnTheme',       () => App.toggleTheme());
bind('btnRandom',      () => App.randomize());
bind('btnRandomAll',   () => App.randomizeAll());
bind('btnClear',       () => App.clear());
bind('btnDownload',    () => App.download());
bind('btnDownloadAll', () => App.downloadAll());
bind('btnReset',       () => App.reset());
bind('tabOrig',        () => App.setTab('orig'));

// The batch strip is re-rendered on every state change, so delegate from the
// container instead of rebinding each thumbnail.
const strip = document.getElementById('batchStrip');
if (strip) {
  strip.addEventListener('click', e => {
    const item = e.target.closest('.batch-item');
    if (item?.dataset.id) App.select(item.dataset.id);
  });
}
