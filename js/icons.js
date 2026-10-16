/**
 * icons.js — Inline SVG icons.
 *
 * The page used to load Material Icons from fonts.googleapis.com, which sent
 * every visitor's IP address and referrer to Google on each load. Icons are
 * now plain SVG served from this origin, so the page makes no third-party
 * request at all. Each is a 24x24 stroke icon drawn in currentColor and sized
 * by the font-size of its container (see .icon in css/style.css).
 */

const svg = (body) =>
  `<svg class="icon" viewBox="0 0 24 24" aria-hidden="true">${body}</svg>`;

export const ICONS = {
  sun:    svg('<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41"/>'),
  moon:   svg('<path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/>'),
  image:  svg('<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="m21 15-5-5L5 21"/>'),
  info:   svg('<circle cx="12" cy="12" r="10"/><path d="M12 16v-4M12 8h.01"/>'),
  camera: svg('<path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/><circle cx="12" cy="13" r="4"/>'),
  clean:  svg('<path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><path d="m9 11 3 3L22 4"/>'),
};
