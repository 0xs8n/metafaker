/**
 * classify.js — decide whether an input is a real camera photo or not.
 *
 * The metadata generator invents a camera, lens, exposure and GPS fix. That is
 * right for a photo taken on a phone or a camera, and wrong for anything that
 * never passed through a lens: a screenshot, an exported graphic, a scan, a
 * meme. Writing "iPhone 15 Pro, f/1.78, GPS in Houston" onto a MacBook
 * screenshot would make it inconsistent with what it is, because a screenshot
 * has no camera to name. For those inputs the honest output is a clean file
 * with no camera information — which is what a real shared screenshot looks
 * like.
 *
 * The signals, in order:
 *
 *   - It already carries a camera Make or Model. Cameras and phones always
 *     write one; a screenshot never does. Present → it is a photo.
 *   - Its real format, read from the file's first bytes rather than its name
 *     or the browser's MIME guess (both come from the extension, so a PNG
 *     renamed .jpg used to pass as a photo). PNG, GIF, BMP, ICO and SVG are
 *     the formats of screenshots and graphics, not of a camera original.
 *   - Transparency. A camera photo has no alpha channel.
 *   - Its content. A camera sensor's noise means a photo almost never has
 *     tiles that are perfectly uniform, or sharp text and UI edges sitting on
 *     a perfectly uniform background; screens and graphics are full of both.
 *     This also catches screenshots shared as JPEG, and this tool's own
 *     cleaned output of a screenshot when it is loaded again.
 *
 * The content thresholds were calibrated on 298 real camera photos (35 phone
 * models, flat-field shots of plain walls and sky, and real Adobe exports) and
 * 26 real screenshots, each tested as the original, as a messaging-app copy
 * (1280 px, JPEG q75) and as a copy like this tool's output: 0 of 894 photo
 * variants were taken for a screenshot, and 73 of 78 screenshot variants were
 * caught. The rule leans toward "photo" when unsure, because a photo misread
 * as a screenshot only loses its generated camera, while the reverse puts a
 * camera on a screenshot.
 */

/** The real image format, from the file's leading bytes. */
export function sniffFormat(bytes) {
  const b = bytes || new Uint8Array(0);
  const at = (i, ...v) => v.every((x, k) => b[i + k] === x);
  const ascii = (i, n) => String.fromCharCode(...b.subarray(i, i + n));
  if (at(0, 0xFF, 0xD8, 0xFF)) return 'jpeg';
  if (at(0, 0x89, 0x50, 0x4E, 0x47)) return 'png';
  if (ascii(0, 4) === 'GIF8') return 'gif';
  if (ascii(0, 4) === 'RIFF' && ascii(8, 4) === 'WEBP') return 'webp';
  if (ascii(0, 2) === 'BM') return 'bmp';
  if (at(0, 0, 0, 1, 0) || at(0, 0, 0, 2, 0)) return 'ico';
  if (at(0, 0x49, 0x49, 0x2A, 0) || at(0, 0x4D, 0x4D, 0, 0x2A)) return 'tiff';
  if (ascii(4, 4) === 'ftyp') {
    const brands = ascii(8, Math.min(b.length - 8, 32));
    if (/avi[fs]/.test(brands)) return 'avif';
    if (/hei[cxms]|hev[cxms]|mif1|msf1/.test(brands)) return 'heic';
  }
  const head = new TextDecoder('utf-8', { fatal: false }).decode(b.subarray(0, 1024)).replace(/^﻿/, '').trimStart();
  if (/^(<\?xml[^>]*>\s*)?(<!--[\s\S]*?-->\s*)*(<!DOCTYPE svg[^>]*>\s*)?<svg[\s>]/i.test(head)) return 'svg';
  return 'unknown';
}

/** Formats a camera or phone never writes, used for screenshots and graphics. */
const GRAPHIC_FORMATS = { png: 'PNG', gif: 'GIF', bmp: 'BMP', ico: 'icon', svg: 'SVG' };

const TILE = 16;
const MAX_TILES = 900;

/**
 * Measure the content signals on a decoded image, sampling up to ~900 tiles of
 * 16x16 at native resolution, one 16-pixel strip at a time to keep memory low.
 *   flat  — share of tiles whose every channel is perfectly uniform
 *   edge  — share of tiles with strong contrast (luma range >= 48) where at
 *           least half the pixels sit within +-3 of the tile's dominant colour
 *   alpha — whether any sampled pixel is transparent
 * Mirrors the calibration script exactly; change both together.
 */
export function measureContent(bitmap) {
  const w = bitmap.width, h = bitmap.height;
  const ny = Math.floor(h / TILE), nx = Math.floor(w / TILE);
  if (!ny || !nx) return { flat: 0, edge: 0, alpha: false };
  const step = Math.max(1, Math.floor(Math.sqrt((ny * nx) / MAX_TILES)));
  const c = document.createElement('canvas');
  c.width = w; c.height = TILE;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  let total = 0, flat = 0, edge = 0, alpha = false;
  const counts = new Map();
  for (let ty = 0; ty < ny; ty += step) {
    ctx.clearRect(0, 0, w, TILE);
    ctx.drawImage(bitmap, 0, ty * TILE, w, TILE, 0, 0, w, TILE);
    const d = ctx.getImageData(0, 0, w, TILE).data;
    for (let tx = 0; tx < nx; tx += step) {
      total++;
      let rMin = 255, rMax = 0, gMin = 255, gMax = 0, bMin = 255, bMax = 0, lMin = 255, lMax = 0;
      counts.clear();
      for (let y = 0; y < TILE; y++) {
        for (let x = 0; x < TILE; x++) {
          const i = (y * w + tx * TILE + x) * 4;
          const r = d[i], g = d[i + 1], bl = d[i + 2];
          if (d[i + 3] < 250) alpha = true;
          if (r < rMin) rMin = r; if (r > rMax) rMax = r;
          if (g < gMin) gMin = g; if (g > gMax) gMax = g;
          if (bl < bMin) bMin = bl; if (bl > bMax) bMax = bl;
          const l = Math.floor((299 * r + 587 * g + 114 * bl) / 1000);
          if (l < lMin) lMin = l; if (l > lMax) lMax = l;
          const key = (r >> 3) * 1024 + (g >> 3) * 32 + (bl >> 3);
          counts.set(key, (counts.get(key) || 0) + 1);
        }
      }
      if (rMax === rMin && gMax === gMin && bMax === bMin) { flat++; continue; }
      if (lMax - lMin < 48) continue;
      // Dominant colour bin; on a tie the lowest key wins, as in the calibration.
      let modeKey = -1, modeCount = -1;
      for (const [k, n] of counts) if (n > modeCount || (n === modeCount && k < modeKey)) { modeKey = k; modeCount = n; }
      let sr = 0, sg = 0, sb = 0, m = 0;
      for (let y = 0; y < TILE; y++) for (let x = 0; x < TILE; x++) {
        const i = (y * w + tx * TILE + x) * 4;
        if ((d[i] >> 3) * 1024 + (d[i + 1] >> 3) * 32 + (d[i + 2] >> 3) !== modeKey) continue;
        sr += d[i]; sg += d[i + 1]; sb += d[i + 2]; m++;
      }
      sr /= m; sg /= m; sb /= m;
      let near = 0;
      for (let y = 0; y < TILE; y++) for (let x = 0; x < TILE; x++) {
        const i = (y * w + tx * TILE + x) * 4;
        if (Math.max(Math.abs(d[i] - sr), Math.abs(d[i + 1] - sg), Math.abs(d[i + 2] - sb)) <= 3) near++;
      }
      if (near >= 0.5 * TILE * TILE) edge++;
    }
  }
  c.width = c.height = 0;
  return { flat: flat / total, edge: edge / total, alpha };
}

const FLAT_ONLY = 0.55;       // this much perfectly flat area is a screen
const FLAT_WITH_EDGES = 0.10; // ...or some flat area together with
const EDGES = 0.065;          // text/UI edges on a flat background

/**
 * @param {{format?: string, exif?: object, content?: {flat:number, edge:number, alpha:boolean}}} input
 * @returns {{ isPhoto: boolean, kind: 'photo'|'screenshot'|'graphic', reason: string }}
 */
export function classifyInput({ format = 'unknown', exif = {}, content = null } = {}) {
  const make = exif.Make || exif.make || exif.Model || exif.model;
  if (make) return { isPhoto: true, kind: 'photo', reason: `camera metadata present (${make})` };

  if (GRAPHIC_FORMATS[format]) {
    return { isPhoto: false, kind: format === 'png' ? 'screenshot' : 'graphic',
             reason: `${GRAPHIC_FORMATS[format]} file (cameras write JPEG or HEIC)` };
  }
  if (content?.alpha) return { isPhoto: false, kind: 'graphic', reason: 'it has transparency, which a camera photo never does' };
  if (content) {
    const flat = Math.round(content.flat * 100), edge = Math.round(content.edge * 100);
    if (content.flat >= FLAT_ONLY || (content.flat >= FLAT_WITH_EDGES && content.edge >= EDGES)) {
      return { isPhoto: false, kind: 'screenshot',
               reason: `screen-like content: ${flat}% perfectly flat, ${edge}% sharp edges on flat areas` };
    }
  }
  return { isPhoto: true, kind: 'photo', reason: 'no screenshot signal' };
}
