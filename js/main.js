/**
 * main.js — Application entry point.
 *
 * Imports the App controller and wires up DOM event listeners.
 * Handles theme initialization (respects system preference + saved choice).
 */

import { App, S } from './ui.js';

// Expose on window so HTML onclick handlers (e.g. App.randomize()) work
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
