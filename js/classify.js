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
 *   - Its EXIF or XMP UserComment reads "Screenshot", which iOS and macOS
 *     write on their screenshots and a JPEG conversion that keeps metadata
 *     carries along.
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
 *     A photo does have perfectly flat tiles where it clips to pure black or
 *     white, so those count for less. This also catches screenshots shared as
 *     JPEG, and this tool's own cleaned output of a screenshot loaded again.
 *   - Its shape, for what content alone misses (a lock screen over a
 *     wallpaper): a portrait image of a phone screen's proportions with a
 *     status bar along the top, or an image at a phone's exact screen size,
 *     needs far fewer UI edges. Neither decides alone.
 *
 * The thresholds come from tools/classify-eval.js on 253 real camera photos
 * and 295 screenshots, each with its metadata stripped and as messaging-app
 * and editor copies; no photo variant is taken for a screenshot. The rule
 * leans toward "photo" when unsure, because a photo misread as a screenshot
 * only loses its generated camera, while the reverse puts a camera on a
 * screenshot. README.md gives the corpus and the held-out results.
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
 *   clip  — share of tiles that are flat at clipped black (every channel
 *           <= 8) or clipped white (>= 247), which a photo's crushed shadows
 *           or blown highlights also produce
 *   alpha — whether any sampled pixel is transparent
 *   width, height, and statusBar (see measureStatusBar) for a phone-shaped
 *   portrait image
 * tools/classify-eval.js measures the thresholds below with this function.
 */
export function measureContent(bitmap) {
  const w = bitmap.width, h = bitmap.height;
  const ny = Math.floor(h / TILE), nx = Math.floor(w / TILE);
  if (!ny || !nx) return { flat: 0, edge: 0, clip: 0, alpha: false, width: w, height: h, statusBar: 0 };
  const step = Math.max(1, Math.floor(Math.sqrt((ny * nx) / MAX_TILES)));
  const c = document.createElement('canvas');
  c.width = w; c.height = TILE;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  let total = 0, flat = 0, clip = 0, edge = 0, alpha = false;
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
      if (rMax === rMin && gMax === gMin && bMax === bMin) {
        flat++;
        if (Math.max(rMax, gMax, bMax) <= 8 || Math.min(rMin, gMin, bMin) >= 247) clip++;
        continue;
      }
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
  return { flat: flat / total, edge: edge / total, clip: clip / total, alpha, width: w, height: h,
           statusBar: phoneShaped(w, h) ? measureStatusBar(bitmap) : 0 };
}

/** Portrait, 18:9 to 2.4:1: most phone screens since 2017, and few photos are cropped to it. */
function phoneShaped(w, h) {
  return h > w && h / w >= 1.98 && h / w <= 2.4;
}

/**
 * How cleanly the top of the image holds a status bar: small high-contrast
 * glyphs (the clock on the left, signal and battery on the right) confined to
 * one thin band, with calmer rows directly above and below. Measured on the
 * top 8% of a copy 360 px wide, so it reads the same at any size. Returns the
 * band's glyph density over its surroundings' (capped at 20), 0 if none has
 * glyphs at both sides.
 */
function measureStatusBar(bitmap) {
  const W = 360, H = Math.max(1, Math.round(W * bitmap.height / bitmap.width));
  const top = Math.min(H, Math.max(16, Math.floor(0.08 * H)));
  const c = document.createElement('canvas');
  c.width = W; c.height = top;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(bitmap, 0, 0, bitmap.width, top * bitmap.height / H, 0, 0, W, top);
  const d = ctx.getImageData(0, 0, W, top).data;
  c.width = c.height = 0;
  const L = new Float32Array(W * top);
  for (let i = 0; i < L.length; i++) L[i] = Math.floor((299 * d[4 * i] + 587 * d[4 * i + 1] + 114 * d[4 * i + 2]) / 1000);

  // Local background: a box mean with edge pixels repeated past the border.
  const ky = Math.max(3, Math.floor(0.03 * H)) | 1, kx = Math.max(3, Math.floor(0.04 * W)) | 1;
  const boxMean = (src, n, stride, count, k) => {
    const out = new Float32Array(src.length), r = k >> 1;
    for (let line = 0; line < count; line++) {
      const at = j => src[line * (stride === 1 ? n : 1) + Math.min(n - 1, Math.max(0, j)) * stride];
      let sum = 0;
      for (let j = -r; j <= r; j++) sum += at(j);
      for (let j = 0; j < n; j++) {
        out[line * (stride === 1 ? n : 1) + j * stride] = sum / k;
        sum += at(j + r + 1) - at(j - r);
      }
    }
    return out;
  };
  const bg = boxMean(boxMean(L, W, 1, top, kx), top, W, W, ky);

  const glyph = new Uint8Array(W * top), rows = new Float64Array(top);
  for (let y = 0; y < top; y++) {
    let n = 0;
    for (let x = 0; x < W; x++) if (Math.abs(L[y * W + x] - bg[y * W + x]) >= 50) { glyph[y * W + x] = 1; n++; }
    rows[y] = n / W;
  }
  const mean = (a, b) => { let s = 0; for (let y = a; y < b; y++) s += rows[y]; return s / (b - a); };
  const share = (y0, y1, x0, x1) => {
    let n = 0;
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) n += glyph[y * W + x];
    return n / ((y1 - y0) * (x1 - x0));
  };
  let best = 0;
  const step = Math.max(1, Math.floor(0.003 * H));
  for (let bh = Math.max(2, Math.floor(0.008 * H)); bh <= Math.max(3, Math.floor(0.035 * H)); bh += step) {
    for (let y0 = 1; y0 < top - bh - 1; y0++) {
      const inside = mean(y0, y0 + bh);
      if (inside < 0.02) continue;
      const around = Math.max(mean(Math.max(0, y0 - bh), y0), mean(y0 + bh, Math.min(top, y0 + 2 * bh)));
      const ratio = Math.min(20, inside / (around + 1e-3));
      if (ratio <= best) continue;
      if (share(y0, y0 + bh, 0, Math.floor(W / 3)) > 0.01 && share(y0, y0 + bh, Math.floor(2 * W / 3), W) > 0.01) best = ratio;
    }
  }
  return best;
}

// Thresholds measured with tools/classify-eval.js (README, "Tells a camera
// photo from a non-photo"): the highest screenshot recall that takes no photo
// variant in the corpus for a screenshot.
const FLAT_ONLY = 0.60;        // this much perfectly flat area is a screen...
const CLIP_NEEDS_EDGES = 0.03; // ...counting clipped flat tiles only beside UI edges
const MIDTONE_FLAT = 0.04;     // flat area that is not just clipped black or white
const FLAT_WITH_EDGES = 0.12;  // some flat area together with
const EDGES = 0.065;           // text/UI edges on a flat background,
const CLIPPED_FLAT = 0.30;     // when the flat area is nearly all clipped, more of it
const CLIPPED_EDGES = 0.12;    // and more edges (stars on a black sky make edges too)
const STATUS_BAR = 10;         // a phone-shaped image with a status bar...
const STATUS_BAR_EDGES = 0.025;// ...and some UI edges
const SCREEN_SIZE_EDGES = 0.02;// an exact phone screen size and some UI edges

// Native screenshot sizes of phones 18:9 or taller, portrait, from Apple's
// Human Interface Guidelines (Layout, device screen sizes) and Google's Pixel
// phone hardware tech specs (Pixel 6 to 11). 1080x1920 is left out: a 16:9
// photo resized to 1920 px lands on it.
const SCREEN_SIZES = new Set([
  '640x1136', '750x1334', '828x1792', '1125x2436', '1170x2532', '1179x2556', '1206x2622', '1242x2688', '1260x2736',
  '1284x2778', '1290x2796', '1320x2868',
  '1080x2342', '1080x2364', '1080x2400', '1080x2424', '1280x2856', '1344x2992', '1440x3120',
]);

/**
 * @param {{format?: string, exif?: object, userComment?: string,
 *          content?: {flat:number, edge:number, clip:number, alpha:boolean, width:number, height:number, statusBar:number}}} input
 * @returns {{ isPhoto: boolean, kind: 'photo'|'screenshot'|'graphic', reason: string }}
 */
export function classifyInput({ format = 'unknown', exif = {}, userComment = '', content = null } = {}) {
  // iOS and macOS write this on their screenshots, and it survives a
  // conversion to JPEG that keeps the metadata.
  if (/^screenshot$/i.test(userComment.trim())) {
    return { isPhoto: false, kind: 'screenshot', reason: 'its metadata labels it a screenshot' };
  }
  const make = exif.Make || exif.make || exif.Model || exif.model;
  if (make) return { isPhoto: true, kind: 'photo', reason: `camera metadata present (${make})` };

  if (GRAPHIC_FORMATS[format]) {
    return { isPhoto: false, kind: format === 'png' ? 'screenshot' : 'graphic',
             reason: `${GRAPHIC_FORMATS[format]} file (cameras write JPEG or HEIC)` };
  }
  if (content?.alpha) return { isPhoto: false, kind: 'graphic', reason: 'it has transparency, which a camera photo never does' };
  if (content) {
    const reason = screenSignal(content);
    if (reason) return { isPhoto: false, kind: 'screenshot', reason };
  }
  return { isPhoto: true, kind: 'photo', reason: 'no screenshot signal' };
}

/**
 * Perfectly flat area and sharp edges on it are what a screen has and a
 * sensor does not, except where a photo clips to pure black or white (a
 * night sky, a studio backdrop): flat tiles there count only beside UI edges.
 */
function screenSignal({ flat, edge, clip = 0, width = 0, height = 0, statusBar = 0 }) {
  const pct = v => `${Math.round(v * 100)}%`;
  const midtone = flat - clip;
  const counted = midtone + (edge >= CLIP_NEEDS_EDGES ? clip : 0);
  const edgesOnFlat = midtone >= MIDTONE_FLAT ? flat >= FLAT_WITH_EDGES && edge >= EDGES
                                              : flat >= CLIPPED_FLAT && edge >= CLIPPED_EDGES;
  if (counted >= FLAT_ONLY || edgesOnFlat) {
    return `screen-like content: ${pct(flat)} perfectly flat, ${pct(edge)} sharp edges on flat areas`;
  }
  if (statusBar >= STATUS_BAR && edge >= STATUS_BAR_EDGES) return `phone-screen shape with a status bar, ${pct(edge)} sharp edges`;
  if (SCREEN_SIZES.has(`${Math.min(width, height)}x${Math.max(width, height)}`) && edge >= SCREEN_SIZE_EDGES) {
    return `exact phone screen size (${width}x${height}) with ${pct(edge)} sharp edges`;
  }
  return null;
}
