/**
 * helpers.js — Pure utility functions used across the app.
 */

import { requantize } from './jpeg-requantize.js';
import { pickEditorQtable, THUMB_QTABLE, ADOBE_APP14, editorIcc, xmpSegment } from './provenance.js';
import { rnd, pick, randInt } from './rng.js';

/** The exporter's sRGB ICC profile as a ready-to-insert APP2 segment. */
export function iccApp2Segment() {
  return iccSegments(editorIcc())[0];
}

// ── Random & Math ────────────────────────────────────────────────

export { rnd, pick, randInt };
export const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));
export const cryptoRandFloat = rnd;
export const cryptoRandInt = randInt;

// ── GPS Utilities ────────────────────────────────────────────────

/**
 * Jitter a location within its own metro area.
 *
 * ±0.05° is roughly ±5 km. The previous ±0.3° moved a point up to 33 km, which
 * for a coastal city dropped it in open water — Miami came out 30 km into the
 * Atlantic, Boston into Massachusetts Bay. A photo whose GPS lands at sea is a
 * far louder signal than one that repeats a city, and a few km of spread is
 * what a real set of photos taken around a city looks like anyway.
 *
 * Altitude is jittered by ±20 m around the city's ground elevation rather than
 * randomised, so it stays consistent with the terrain at the coordinates. The
 * timezone is carried through because GPSTimeStamp has to be derived from the
 * photographed city's clock, not the machine's.
 */
export function jitterLocation(base) {
  const lat = base.lat + (rnd() - 0.5) * 0.1;
  const lon = base.lon + (rnd() - 0.5) * 0.1;
  return {
    city: base.city,
    tz: base.tz,
    lat: Number(clamp(lat, -89.99, 89.99).toFixed(6)),
    lon: Number(clamp(lon, -179.99, 179.99).toFixed(6)),
    alt: Math.max(0, Math.round((base.alt ?? 0) + (rnd() - 0.5) * 40)),
  };
}

// ── Timezone ─────────────────────────────────────────────────────

/** Offset in ms that `tz` was running at the given UTC instant, DST included. */
function tzOffsetMs(utcMs, tz) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(new Date(utcMs));
  const p = {};
  for (const { type, value } of parts) p[type] = value;
  const asIfUtc = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour % 24, +p.minute, +p.second);
  return asIfUtc - utcMs;
}

/**
 * Read a wall-clock reading as a time in `tz` and return the real UTC instant.
 *
 * The capture time is a wall clock in the city the photo claims to come from,
 * so the UTC instant behind it depends on that city's offset — which itself
 * depends on the instant, hence the second pass. Without this, GPSTimeStamp was
 * computed with the offset of whoever ran the tool: a photo "taken in Tokyo"
 * carried the operator's own timezone.
 */
export function wallClockToUtc(d, tz) {
  if (!tz) return d;
  try {
    const naive = Date.UTC(d.getFullYear(), d.getMonth(), d.getDate(),
                           d.getHours(), d.getMinutes(), d.getSeconds());
    const first = naive - tzOffsetMs(naive, tz);
    // Re-resolve: near a DST boundary the offset at `first` can differ.
    return new Date(naive - tzOffsetMs(first, tz));
  } catch {
    return d;                      // unknown zone — fall back to the naive time
  }
}

/** The zone's offset at that instant as an EXIF OffsetTime string, "+09:00". */
export function tzOffsetString(utcDate, tz) {
  if (!tz) return null;
  try {
    const mins = Math.round(tzOffsetMs(utcDate.getTime(), tz) / 60000);
    const sign = mins < 0 ? '-' : '+';
    const a = Math.abs(mins);
    return `${sign}${String(Math.floor(a / 60)).padStart(2, '0')}:${String(a % 60).padStart(2, '0')}`;
  } catch {
    return null;
  }
}

// ── Date Formatting ──────────────────────────────────────────────

export function fmtDate(d) {
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}:${p(d.getMonth() + 1)}:${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

export function fmtGpsDate(d) {
  const p = n => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}:${p(d.getUTCMonth() + 1)}:${p(d.getUTCDate())}`;
}

export function gpsTimeStamp(d) {
  return [[d.getUTCHours(), 1], [d.getUTCMinutes(), 1], [d.getUTCSeconds(), 1]];
}

// ── Sun position ─────────────────────────────────────────────────

/**
 * Solar elevation in degrees at a point and UTC instant (USNO low-precision
 * algorithm, good to a fraction of a degree, which is plenty).
 *
 * The scene brightness used to be drawn independently of the clock, so a
 * daylight exposure at 02:40 local time came out about one night-time frame
 * in three. Anyone with the GPS position and the timestamp can compute where
 * the sun was, so the scene is now chosen from that.
 */
export function sunElevation(lat, lon, utc) {
  const RAD = Math.PI / 180;
  const d = utc.getTime() / 864e5 - 10957.5;                    // days since J2000.0
  const g = (357.529 + 0.98560028 * d) * RAD;                    // mean anomaly
  const q = 280.459 + 0.98564736 * d;                            // mean longitude
  const L = (q + 1.915 * Math.sin(g) + 0.020 * Math.sin(2 * g)) * RAD;
  const e = (23.439 - 0.00000036 * d) * RAD;                     // obliquity
  const ra = Math.atan2(Math.cos(e) * Math.sin(L), Math.cos(L));
  const dec = Math.asin(Math.sin(e) * Math.sin(L));
  const gmst = (18.697374558 + 24.06570982441908 * d) % 24;
  const lst = ((gmst + lon / 15) % 24 + 24) % 24;
  const ha = lst * 15 * RAD - ra;
  const el = Math.asin(Math.sin(lat * RAD) * Math.sin(dec)
                     + Math.cos(lat * RAD) * Math.cos(dec) * Math.cos(ha));
  return el / RAD;
}

// ── GPS Coordinate Conversion ────────────────────────────────────

export function decToDMS(deg) {
  const a = Math.abs(deg);
  const d = Math.floor(a);
  const mf = (a - d) * 60;
  const m = Math.floor(mf);
  const s = Math.round((mf - m) * 60 * 1000);
  return [[d, 1], [m, 1], [s, 1000]];
}

export function dmsToDec(dms, ref) {
  if (!Array.isArray(dms) || dms.length < 3) return null;
  const d = fromRat(dms[0]);
  const m = fromRat(dms[1]);
  const s = fromRat(dms[2]);
  if ([d, m, s].some(x => typeof x !== 'number' || Number.isNaN(x))) return null;
  let out = d + (m / 60) + (s / 3600);
  if (ref === 'S' || ref === 'W') out *= -1;
  return out;
}

// ── File / Blob Utilities ────────────────────────────────────────

export function dataUrlToBlob(dataUrl) {
  const m = dataUrl.match(/^data:([^;,]+)?(;base64)?,(.*)$/);
  if (!m) throw new Error('Invalid output image data');
  const mime = m[1] || 'application/octet-stream';
  const isBase64 = !!m[2];
  const body = m[3];
  if (!isBase64) return new Blob([decodeURIComponent(body)], { type: mime });
  const bin = atob(body);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type: mime });
}

// ── Canvas / Image Processing ────────────────────────────────────

export function randomMaxEdge() {
  const edges = [2048, 2160, 2400, 2560, 2880, 3200];
  return edges[Math.floor(rnd() * edges.length)];
}

export function getExportDimensions(width, height, maxEdge) {
  maxEdge = maxEdge || randomMaxEdge();
  const longestEdge = Math.max(width, height);
  if (!longestEdge || longestEdge <= maxEdge) return { width, height };
  const scale = maxEdge / longestEdge;
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

// ── Gaussian noise (Box-Muller with caching) ─────────────────────
let _gaussSpare = null;
function gaussRand() {
  if (_gaussSpare !== null) { const v = _gaussSpare; _gaussSpare = null; return v; }
  let u, v, s;
  do { u = rnd() * 2 - 1; v = rnd() * 2 - 1; s = u * u + v * v; }
  while (s >= 1 || s === 0);
  const mul = Math.sqrt(-2 * Math.log(s) / s);
  _gaussSpare = v * mul;
  return u * mul;
}

/**
 * Add ISO-matched Poisson-Gaussian (heteroscedastic) noise.
 *
 * Camera sensor noise model: σ²(x) = a·x + b
 *   a = shot noise coefficient  (signal-dependent, scales linearly with ISO)
 *   b = read noise variance     (constant per sensor, scales with ISO²)
 *
 * Uniform Gaussian (previous model) is detectable by Noiseprint++, TruFor,
 * and heteroscedastic noise forensic analysis — those tools explicitly verify
 * that brighter pixels have higher variance. The Poisson-Gaussian model
 * matches what real sensors produce.
 */
export function addPixelNoise(ctx, w, h, iso = 100, cameraType = 'phone') {
  // Explicit sigma ranges matched to real camera output in 8-bit JPEG space.
  // Previous model used b = bBase * isoNorm² — at ISO 3200 that gave sigma ≈ 45,
  // which is a ±135 pixel range and reduces images to pure noise.
  let baseSigma;
  if      (iso <= 200)  baseSigma = 0.7 + rnd() * 0.5;  // 0.7–1.2
  else if (iso <= 800)  baseSigma = 1.3 + rnd() * 0.9;  // 1.3–2.2
  else if (iso <= 3200) baseSigma = 2.0 + rnd() * 1.5;  // 2.0–3.5
  else                  baseSigma = 3.0 + rnd() * 2.0;  // 3.0–5.0

  // Decompose into Poisson-Gaussian model: σ²(x) = a·x + b
  // The signal-dependent component gives the heteroscedastic structure that
  // ML forensic tools (Noiseprint++, TruFor) verify, while keeping total
  // noise within the calibrated sigma range above. The shot-to-read split and
  // the per-channel factors are drawn per image: a fixed split was itself a
  // recipe that a classifier trained on this tool's output could learn.
  const sig2 = baseSigma * baseSigma;
  const shot = 0.03 + rnd() * 0.12;    // 3–15% signal-dependent
  const a    = shot * sig2 / 128;
  const b    = (1 - shot) * sig2;
  const rbGain  = 1.1 + rnd() * 0.25;  // R/B shot noise relative to G
  const gGain   = 0.75 + rnd() * 0.15;
  const gRead   = 0.6 + rnd() * 0.25;
  const chroma  = 0.1 + rnd() * 0.25;  // DSLR chroma noise fraction

  const id = ctx.getImageData(0, 0, w, h);
  const d  = id.data;

  for (let i = 0; i < d.length; i += 4) {
    const r0 = d[i], g0 = d[i + 1], b0 = d[i + 2];

    if (cameraType === 'phone') {
      // Bayer CFA: 2 green, 1 red, 1 blue per 2×2 block.
      // R/B have more shot noise than G (fewer photosites per unit area).
      const sigmaR = Math.sqrt(a * rbGain * r0 + b);
      const sigmaG = Math.sqrt(a * gGain * g0 + b * gRead);
      const sigmaB = Math.sqrt(a * rbGain * b0 + b);
      d[i]     = clamp(Math.round(r0 + gaussRand() * sigmaR), 0, 255);
      d[i + 1] = clamp(Math.round(g0 + gaussRand() * sigmaG), 0, 255);
      d[i + 2] = clamp(Math.round(b0 + gaussRand() * sigmaB), 0, 255);
    } else {
      // DSLR: luminance-dominant noise with small chroma component.
      const luma  = 0.2126 * r0 + 0.7152 * g0 + 0.0722 * b0;
      const sigma = Math.sqrt(a * luma + b);
      const lN    = gaussRand() * sigma;
      const cN    = gaussRand() * sigma * chroma;
      d[i]     = clamp(Math.round(r0 + lN + cN), 0, 255);
      d[i + 1] = clamp(Math.round(g0 + lN),       0, 255);
      d[i + 2] = clamp(Math.round(b0 + lN - cN), 0, 255);
    }
  }

  ctx.putImageData(id, 0, 0);
}

// ── Camera colour science ────────────────────────────────────────

// Keyed by the EXIF Make string exactly as the manufacturer writes it, so these
// stay in step with data.js — "samsung" is lowercase, Nikon is the full
// corporate name and Sony is capitalised. A key that does not match means the
// image silently ships with no colour science at all.
const CAMERA_COLOR_PROFILES = {
  'Apple':             { warmth:  8, satScale: 1.05, contrast: 1.02 },
  'samsung':           { warmth:  3, satScale: 1.18, contrast: 1.08 },
  'Google':            { warmth: -6, satScale: 1.08, contrast: 1.04 },
  'OnePlus':           { warmth:  2, satScale: 1.12, contrast: 1.05 },
  'Xiaomi':            { warmth:  4, satScale: 1.15, contrast: 1.06 },
  'Canon':             { warmth: 12, satScale: 1.10, contrast: 1.03 },
  'NIKON CORPORATION': { warmth:  0, satScale: 1.00, contrast: 1.00 },
  'SONY':              { warmth: -8, satScale: 0.97, contrast: 1.01 },
  'FUJIFILM':          { warmth:  5, satScale: 1.06, contrast: 1.12 },
};

/**
 * Apply per-brand colour science to a canvas context.
 *
 * Simulates the characteristic rendering of each manufacturer — Canon's warm
 * creamy tones, Sony's clinical neutrality, Samsung's punch, etc. A ±2 warmth
 * and ±0.03 saturation jitter ensures two images from the same brand still
 * differ from each other.
 */
export function applyCameraColorProfile(ctx, w, h, make) {
  const base = CAMERA_COLOR_PROFILES[make];
  if (!base) return;

  const warmth   = base.warmth   + (rnd() - 0.5) * 4;
  const satScale = base.satScale + (rnd() - 0.5) * 0.06;
  const contrast = base.contrast;

  const id = ctx.getImageData(0, 0, w, h);
  const d  = id.data;

  for (let i = 0; i < d.length; i += 4) {
    let r = d[i], g = d[i + 1], b = d[i + 2];

    // Contrast around midpoint 128
    r = clamp(Math.round((r - 128) * contrast + 128), 0, 255);
    g = clamp(Math.round((g - 128) * contrast + 128), 0, 255);
    b = clamp(Math.round((b - 128) * contrast + 128), 0, 255);

    // Colour temperature
    r = clamp(Math.round(r + warmth), 0, 255);
    b = clamp(Math.round(b - warmth), 0, 255);

    // Luminance-preserving saturation
    const lum = Math.round(0.2126 * r + 0.7152 * g + 0.0722 * b);
    r = clamp(Math.round(lum + (r - lum) * satScale), 0, 255);
    g = clamp(Math.round(lum + (g - lum) * satScale), 0, 255);
    b = clamp(Math.round(lum + (b - lum) * satScale), 0, 255);

    d[i] = r; d[i + 1] = g; d[i + 2] = b;
  }

  ctx.putImageData(id, 0, 0);
}

/**
 * Simulate camera ISP pipeline statistical traces.
 *
 * Real cameras run demosaicing → denoising → sharpening → tone mapping before
 * JPEG encoding. Each stage leaves characteristic statistical traces that ML
 * forensic tools (TruFor, CAT-Net, ManTraNet) are trained to detect.
 * Their absence from a browser-processed image is a strong forensic signal.
 *
 * Simulates:
 *   1. Demosaicing residuals — Laplacian traces from Bayer CFA interpolation
 *   2. S-curve tone mapping  — histogram shape camera firmware curves produce
 *   3. Unsharp mask          — in-camera sharpening halo/ringing around edges
 */
/**
 * Separable box blur of the RGB channels, radius r, into a new buffer.
 * Edges clamp. Used by the unsharp mask and the denoise pass.
 */
function boxBlurRGB(src, w, h, r) {
  const tmp = new Float32Array(w * h * 3);
  const out = new Uint8ClampedArray(src.length);
  const n = 2 * r + 1;
  // Horizontal
  for (let y = 0; y < h; y++) {
    for (let c = 0; c < 3; c++) {
      let sum = 0;
      for (let k = -r; k <= r; k++) sum += src[(y * w + clamp(k, 0, w - 1)) * 4 + c];
      for (let x = 0; x < w; x++) {
        tmp[(y * w + x) * 3 + c] = sum / n;
        const add = src[(y * w + clamp(x + r + 1, 0, w - 1)) * 4 + c];
        const sub = src[(y * w + clamp(x - r, 0, w - 1)) * 4 + c];
        sum += add - sub;
      }
    }
  }
  // Vertical
  for (let x = 0; x < w; x++) {
    for (let c = 0; c < 3; c++) {
      let sum = 0;
      for (let k = -r; k <= r; k++) sum += tmp[(clamp(k, 0, h - 1) * w + x) * 3 + c];
      for (let y = 0; y < h; y++) {
        out[(y * w + x) * 4 + c] = sum / n;
        const add = tmp[(clamp(y + r + 1, 0, h - 1) * w + x) * 3 + c];
        const sub = tmp[(clamp(y - r, 0, h - 1) * w + x) * 3 + c];
        sum += add - sub;
      }
    }
  }
  return out;
}

export function applyISPSimulation(ctx, w, h) {
  const id = ctx.getImageData(0, 0, w, h);
  const d  = id.data;

  // Every stage here is drawn per image, including whether it runs at all.
  // Applying the same curve and the same 3x3 sharpen to every file was a
  // recipe, and a recipe is what a detector trained on this tool would learn.

  // ── 1. S-curve tone mapping (LUT), four images in five ──────
  // Camera firmware applies a characteristic S-shaped tone curve for contrast.
  // Properly anchored: lut[0]=0, lut[128]=128, lut[255]=255.
  if (rnd() < 0.8) {
    const cs = 0.15 + rnd() * 0.55;                 // curve strength 0.15–0.7
    const hs = Math.sin(0.5 * Math.PI * cs) || 1;   // normaliser
    const lut = new Uint8Array(256);
    for (let i = 0; i < 256; i++) {
      const curved = Math.sin((i / 255 - 0.5) * Math.PI * cs) / (2 * hs) + 0.5;
      lut[i] = clamp(Math.round(curved * 255), 0, 255);
    }
    for (let i = 0; i < d.length; i += 4) {
      d[i]     = lut[d[i]];
      d[i + 1] = lut[d[i + 1]];
      d[i + 2] = lut[d[i + 2]];
    }
  }

  // ── 2. Unsharp mask, three images in four, radius 1 or 2 px ──
  // In-camera and editor sharpening creates characteristic halo/ringing
  // around edges — a statistical trace that forensic models are trained to see.
  if (rnd() < 0.75) {
    const sharpStr = 0.05 + rnd() * 0.15;           // 0.05–0.20
    const radius   = rnd() < 0.6 ? 1 : 2;
    const orig     = new Uint8ClampedArray(d);
    const blur     = boxBlurRGB(orig, w, h, radius);
    for (let i = 0; i < d.length; i += 4) {
      for (let c = 0; c < 3; c++) {
        d[i + c] = clamp(Math.round(orig[i + c] + sharpStr * (orig[i + c] - blur[i + c])), 0, 255);
      }
    }
  }

  ctx.putImageData(id, 0, 0);
}

/**
 * Non-rigid warp: a smooth, random displacement field of about a pixel.
 *
 * This is the PRNU defence that the crop, rotation and resize alone are not.
 * Those are one global affine transform, and a sensor-pattern match can be
 * re-registered through it by searching over scale and rotation. A field that
 * varies across the frame has no single inverse to search for: every block is
 * misaligned by its own fraction of a pixel, and the pattern correlation,
 * which is summed over the whole frame, collapses. The displacement is a sum
 * of three low-frequency waves with random directions, wavelengths and
 * phases, and a total amplitude under two pixels, so nothing is visible.
 */
export function applyWarp(ctx, w, h) {
  const id  = ctx.getImageData(0, 0, w, h);
  const d   = id.data;
  const src = new Uint8ClampedArray(d);

  const amp = 0.6 + rnd() * 1.2;
  const waves = [];
  for (let k = 0; k < 3; k++) {
    const wl = 120 + rnd() * 400;
    const th = rnd() * Math.PI * 2;
    const ux = Math.cos(th) / wl, uy = Math.sin(th) / wl;
    const px = rnd() * Math.PI * 2, py = rnd() * Math.PI * 2;
    // sin(X + Y + phase) split per axis so the inner loop has no trig.
    const sx = new Float32Array(w), cx = new Float32Array(w);
    const sy = new Float32Array(h), cy = new Float32Array(h);
    for (let x = 0; x < w; x++) { const t = 2 * Math.PI * x * ux; sx[x] = Math.sin(t); cx[x] = Math.cos(t); }
    for (let y = 0; y < h; y++) { const t = 2 * Math.PI * y * uy; sy[y] = Math.sin(t); cy[y] = Math.cos(t); }
    waves.push({ sx, cx, sy, cy, px: [Math.sin(px), Math.cos(px)], py: [Math.sin(py), Math.cos(py)],
                 ax: amp * (0.4 + rnd() * 0.6) / 3, ay: amp * (0.4 + rnd() * 0.6) / 3 });
  }

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let dx = 0, dy = 0;
      for (const wv of waves) {
        // sin(a + b) with a = x-term, b = y-term, then + phase
        const s = wv.sx[x] * wv.cy[y] + wv.cx[x] * wv.sy[y];
        const c = wv.cx[x] * wv.cy[y] - wv.sx[x] * wv.sy[y];
        dx += wv.ax * (s * wv.px[1] + c * wv.px[0]);
        dy += wv.ay * (s * wv.py[1] + c * wv.py[0]);
      }
      const fx = clamp(x + dx, 0, w - 1), fy = clamp(y + dy, 0, h - 1);
      const x0 = Math.floor(fx), y0 = Math.floor(fy);
      const x1 = Math.min(x0 + 1, w - 1), y1 = Math.min(y0 + 1, h - 1);
      const tx = fx - x0, ty = fy - y0;
      const p00 = (y0 * w + x0) * 4, p10 = (y0 * w + x1) * 4, p01 = (y1 * w + x0) * 4, p11 = (y1 * w + x1) * 4;
      const o = (y * w + x) * 4;
      for (let c = 0; c < 3; c++) {
        const top = src[p00 + c] + (src[p10 + c] - src[p00 + c]) * tx;
        const bot = src[p01 + c] + (src[p11 + c] - src[p01 + c]) * tx;
        d[o + c] = top + (bot - top) * ty;
      }
    }
  }
  ctx.putImageData(id, 0, 0);
}

/**
 * Mild denoise before fresh noise is added: a partial blend toward a 3x3 box
 * blur. The sensor's residual noise pattern lives in the finest detail; taking
 * some of that off before the new, synthetic noise goes on means the final
 * residual is dominated by noise that belongs to no camera. Kept light so
 * texture survives; the sharpen stage restores edges.
 */
export function applyDenoise(ctx, w, h) {
  const strength = 0.35 + rnd() * 0.3;
  const id   = ctx.getImageData(0, 0, w, h);
  const d    = id.data;
  const blur = boxBlurRGB(d, w, h, 1);
  for (let i = 0; i < d.length; i += 4) {
    d[i]     += (blur[i]     - d[i])     * strength;
    d[i + 1] += (blur[i + 1] - d[i + 1]) * strength;
    d[i + 2] += (blur[i + 2] - d[i + 2]) * strength;
  }
  ctx.putImageData(id, 0, 0);
}

/**
 * Simulate lens optical artifacts: vignetting + chromatic aberration.
 *
 * Every real camera lens produces both. Their absence is detectable by
 * forensic lens-profile databases and ML models.
 *
 * Vignetting: cos⁴ light falloff toward corners (polynomial approximation).
 * Chromatic aberration: wavelength-dependent refraction causes radial colour
 * fringing — red shifts outward from centre, blue shifts inward. Both effects
 * scale with distance from the optical axis, so there's zero CA at centre.
 */
export function applyLensOpticalEffects(ctx, w, h, cam = {}) {
  const cameraType = cam.type || 'phone';

  // Neither effect is applied to every image: lens profiles and in-camera
  // correction remove vignetting and lateral CA from a good share of real
  // files, and a constant dose of each would be this tool's own signature.
  const doVignette = rnd() < 0.7;
  const doCA       = rnd() < 0.6;
  if (!doVignette && !doCA) return;

  // Real lens vignetting: ~10–20% light falloff at corners for phones,
  // ~5–12% for DSLRs (better optics + usually partially corrected in-camera).
  const vBase = !doVignette ? 0 : cameraType === 'dslr'
    ? 0.015 + rnd() * 0.035  // ~2–7% corner darkening
    : 0.020 + rnd() * 0.045; // ~3–9% corner darkening

  const diagonal = Math.sqrt(w * w + h * h);
  // Red outward is the common direction, but corrected and over-corrected
  // lenses fringe the other way, so the sign is drawn too.
  const caSign   = rnd() < 0.7 ? 1 : -1;
  const caMax    = !doCA ? 0 : caSign * (cameraType === 'dslr'
    ? (0.00015 + rnd() * 0.00035) * diagonal
    : (0.0003  + rnd() * 0.0005)  * diagonal);

  const cx   = w / 2;
  const cy   = h / 2;
  const maxR = Math.sqrt(cx * cx + cy * cy);

  const id = ctx.getImageData(0, 0, w, h);
  const d  = id.data;

  // Extract channels for clean random-access reads during CA remapping.
  const rBuf = new Uint8Array(w * h);
  const gBuf = new Uint8Array(w * h);
  const bBuf = new Uint8Array(w * h);
  for (let p = 0, i = 0; i < d.length; i += 4, p++) {
    rBuf[p] = d[i]; gBuf[p] = d[i + 1]; bBuf[p] = d[i + 2];
  }

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const p    = y * w + x;
      const i    = p * 4;
      const dx   = x - cx;
      const dy   = y - cy;
      const dist = Math.sqrt(dx * dx + dy * dy);
      const r    = dist / maxR;  // 0 at centre → 1 at corner

      // Vignetting: polynomial approximation of cos⁴ radial falloff.
      const vign = Math.max(0, 1 - vBase * r * r - vBase * 0.4 * r * r * r * r);

      if (caMax !== 0 && dist > 0.5) {
        // CA shift amount scales with r (zero at centre, caMax at corners).
        const shift  = caMax * r;
        const normDX = dx / dist;
        const normDY = dy / dist;

        // Red shifts outward; blue shifts inward toward centre.
        const rX = clamp(Math.round(x + normDX * shift), 0, w - 1);
        const rY = clamp(Math.round(y + normDY * shift), 0, h - 1);
        const bX = clamp(Math.round(x - normDX * shift), 0, w - 1);
        const bY = clamp(Math.round(y - normDY * shift), 0, h - 1);

        d[i]     = clamp(Math.round(rBuf[rY * w + rX] * vign), 0, 255);
        d[i + 1] = clamp(Math.round(gBuf[p]           * vign), 0, 255);
        d[i + 2] = clamp(Math.round(bBuf[bY * w + bX] * vign), 0, 255);
      } else {
        d[i]     = clamp(Math.round(rBuf[p] * vign), 0, 255);
        d[i + 1] = clamp(Math.round(gBuf[p] * vign), 0, 255);
        d[i + 2] = clamp(Math.round(bBuf[p] * vign), 0, 255);
      }
    }
  }

  ctx.putImageData(id, 0, 0);
}

/**
 * Strip the browser's signature APP segments from a JPEG data URL.
 *
 * canvas.toDataURL() emits two segments that no camera would pair with the
 * EXIF we write:
 *
 *   APP0 (FF E0) — the JFIF header. Real cameras write APP1 (Exif) instead.
 *   APP2 (FF E2) — the encoder's ICC profile. Chrome's is 470 bytes, is
 *                  byte-identical on every image the browser encodes, and its
 *                  copyright string names the browser vendor. That makes it
 *                  both a browser fingerprint and a perfect key for correlating
 *                  any two images this tool produced, which is exactly what the
 *                  per-image identity work was meant to prevent.
 *
 * Dropping the ICC profile changes no pixel: the data is already sRGB, which is
 * what a viewer assumes when no profile is present, and plenty of real camera
 * JPEGs carry none at all.
 */
function bytesToDataUrl(mime, out) {
  // Chunked, because String.fromCharCode blows the stack on a whole image.
  let s = '';
  for (let i = 0; i < out.length; i += 0x8000) {
    s += String.fromCharCode.apply(null, out.subarray(i, i + 0x8000));
  }
  return `data:${mime};base64,${btoa(s)}`;
}

function dataUrlToBytes(dataUrl) {
  const m = dataUrl.match(/^data:([^;]+);base64,(.+)$/);
  if (!m) return null;
  const bin = atob(m[2]);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return { mime: m[1], bytes };
}

/**
 * Re-quantise a freshly encoded JPEG onto one of the exporter's measured
 * quantization tables and write it in the exporter's pixel container: the
 * browser's APP0 and ICC are dropped, the coefficients are rescaled onto the
 * new tables (overwriting the DQT bytes alone would change the picture), a DRI
 * segment and restart markers are added, Adobe's APP14 is placed before the
 * frame header, and the Huffman tables are optimised the way the exporter's
 * encoder optimises them. Returns `{ dataUrl, ok }`; ok is false when the
 * input is not plain baseline JPEG, in which case the input is returned
 * unchanged and the caller falls back.
 */
function requantizeToExport(dataUrl, table, opts) {
  const parsed = dataUrlToBytes(dataUrl);
  if (!parsed) return { dataUrl, ok: false };
  try {
    const out = requantize(parsed.bytes, table, opts);
    if (!out) return { dataUrl, ok: false };
    return { dataUrl: bytesToDataUrl(parsed.mime, out), ok: true };
  } catch (e) {
    return { dataUrl, ok: false };
  }
}

/**
 * Encode a 256-long-edge thumbnail the way the exporter does: the standard
 * (Annex K) quantization tables scaled to its thumbnail quality, a 32-MCU
 * restart interval, Adobe's APP14 and the standard Huffman tables. Returns the
 * raw bytes, a binary string for the IFD1 payload, and the dimensions. The
 * same bytes go into both IFD1 and the Photoshop block, as the exports do.
 */
export function makeAdobeThumbnail(dataUrl, longEdge = 256) {
  return new Promise(resolve => {
    const img = new Image();
    img.onerror = () => resolve(null);
    img.onload = () => {
      try {
        const scale = longEdge / Math.max(img.naturalWidth, img.naturalHeight, 1);
        const w = Math.max(1, Math.round(img.naturalWidth  * scale));
        const h = Math.max(1, Math.round(img.naturalHeight * scale));
        const c = document.createElement('canvas');
        c.width = w; c.height = h;
        const ctx = c.getContext('2d');
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = 'high';
        ctx.drawImage(img, 0, 0, w, h);
        const url = c.toDataURL('image/jpeg', 1.0);
        const parsed = dataUrlToBytes(url);
        if (!parsed) return resolve(null);
        const out = requantize(parsed.bytes, THUMB_QTABLE,
          { restartInterval: 32, optimizeHuffman: false, app14: ADOBE_APP14 });
        if (!out || out.length > 63000) return resolve(null);
        let bin = '';
        for (let i = 0; i < out.length; i += 0x8000) bin += String.fromCharCode.apply(null, out.subarray(i, i + 0x8000));
        resolve({ bytes: out, binary: bin, width: w, height: h });
      } catch (e) {
        resolve(null);
      }
    };
    img.src = dataUrl;
  });
}

/**
 * Insert metadata segments immediately after SOI, before the first marker the
 * pixel JPEG carries (its DQT). Used to add the Exif, Photoshop, ICC and XMP
 * segments to the exporter's pixel container in the order the exports show.
 */
export function insertAfterSoi(dataUrl, segments) {
  const parsed = dataUrlToBytes(dataUrl);
  if (!parsed) return dataUrl;
  const { mime, bytes } = parsed;
  if (bytes[0] !== 0xFF || bytes[1] !== 0xD8) return dataUrl;
  const add = segments.filter(Boolean);
  const addLen = add.reduce((n, s) => n + s.length, 0);
  const out = new Uint8Array(bytes.length + addLen);
  let o = 0;
  out.set([0xFF, 0xD8], o); o += 2;
  for (const s of add) { out.set(s, o); o += s.length; }
  out.set(bytes.subarray(2), o);
  return bytesToDataUrl(mime, out);
}

/** Wrap an ICC profile into APP2 segments (chunked if it exceeds one segment). */
function iccSegments(icc) {
  const TAG = [0x49, 0x43, 0x43, 0x5F, 0x50, 0x52, 0x4F, 0x46, 0x49, 0x4C, 0x45, 0x00]; // "ICC_PROFILE\0"
  const MAX = 65519;                       // 65535 minus the 16-byte segment overhead
  const total = Math.max(1, Math.ceil(icc.length / MAX));
  const segs = [];
  for (let n = 0; n < total; n++) {
    const part = icc.subarray(n * MAX, (n + 1) * MAX);
    const len = 16 + part.length;
    const seg = new Uint8Array(2 + len);
    seg.set([0xFF, 0xE2, (len >> 8) & 0xFF, len & 0xFF, ...TAG, n + 1, total], 0);
    seg.set(part, 18);
    segs.push(seg);
  }
  return segs;
}

export function normaliseAppSegments(dataUrl, opts = {}) {
  const m = dataUrl.match(/^data:([^;]+);base64,(.+)$/);
  if (!m) return dataUrl;

  const mime  = m[1];
  const bin   = atob(m[2]);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);

  if (bytes[0] !== 0xFF || bytes[1] !== 0xD8) return dataUrl;   // not a JPEG

  const isIccProfile = at =>
    String.fromCharCode(...bytes.subarray(at, at + 11)) === 'ICC_PROFILE';

  // Walk the chain, dropping the browser's own markers and noting where SOF
  // begins: an exporter writes its APP14 immediately before the frame header.
  const before = [], after = [];
  let seenSof = false;
  let i = 2;
  while (i + 3 < bytes.length && bytes[i] === 0xFF) {
    const marker = bytes[i + 1];
    if (marker === 0xDA) break;                 // SOS: entropy data follows
    const len = (bytes[i + 2] << 8) | bytes[i + 3];
    const end = i + 2 + len;
    if (len < 2 || end > bytes.length) return dataUrl;   // malformed, leave alone
    const drop = marker === 0xE0 || (marker === 0xE2 && isIccProfile(i + 4));
    if (marker >= 0xC0 && marker <= 0xCF && marker !== 0xC4 && marker !== 0xC8) seenSof = true;
    if (!drop) (seenSof ? after : before).push([i, end]);
    i = end;
  }
  after.push([i, bytes.length]);   // SOS onward

  const { icc, app14, xmp } = opts;
  const head = [];                       // straight after SOI, ahead of DQT
  if (icc) head.push(...iccSegments(icc));
  if (xmp) head.push(xmp);
  const beforeSof = app14 ? [app14] : [];   // immediately before SOF

  const size = 2
    + head.reduce((n, s2) => n + s2.length, 0)
    + before.reduce((n, [a, b]) => n + (b - a), 0)
    + beforeSof.reduce((n, s2) => n + s2.length, 0)
    + after.reduce((n, [a, b]) => n + (b - a), 0);

  const out = new Uint8Array(size);
  let o = 0;
  out.set([0xFF, 0xD8], o); o += 2;
  for (const s2 of head) { out.set(s2, o); o += s2.length; }
  for (const [a, b] of before) { out.set(bytes.subarray(a, b), o); o += b - a; }
  for (const s2 of beforeSof) { out.set(s2, o); o += s2.length; }
  for (const [a, b] of after) { out.set(bytes.subarray(a, b), o); o += b - a; }

  let outBin = '';
  for (let k = 0; k < out.length; k += 0x8000) {
    outBin += String.fromCharCode.apply(null, out.subarray(k, k + 0x8000));
  }
  return `data:${mime};base64,${btoa(outBin)}`;
}

/**
 * Core anti-forensic canvas pipeline.
 *
 * The stages, in order. Every parameter is drawn per image and several stages
 * run on only a share of images, so there is no fixed recipe to learn:
 *
 *   1. Proportional crop (≤1.2% per edge) — shifts the sensor grid
 *   2. Rotation (±0.3°–2.0°) on two images in three
 *   3. Reshape to a frame the camera can produce, then size
 *   3b. Non-rigid warp (sub-pixel to ~2 px) and a light denoise — the PRNU
 *       defence; a global transform can be re-registered, a field cannot
 *   4. Camera colour science — brand-specific tone/saturation/contrast
 *   5. ISP simulation — S-curve (4 in 5) + unsharp mask (3 in 4, radius 1–2)
 *   6. Lens optics — vignetting (7 in 10) + chromatic aberration (3 in 5,
 *      either sign)
 *   7. Poisson-Gaussian noise — σ²(x)=a·x+b with a drawn shot/read split
 *   8. Encode, re-quantise onto the exporter's tables, write its container
 */
/**
 * Reshape the source rectangle to a frame the camera could actually produce.
 *
 * This is the loudest tell in the output. A file claiming to be a Pixel 6a at
 * 533x1598 describes a frame no Pixel has ever produced — the aspect ratio
 * alone rules it out before anyone looks at the resolution. The dimensions come
 * from whatever image was loaded, not from the camera being claimed.
 *
 * Where the source is already close to one of the camera's frame shapes, it is
 * centre-cropped onto it, and if the camera's measured native resolution is
 * reachable without upscaling, the output lands on it exactly.
 *
 * Where it is not close — a receipt at 0.34, a panorama at 3.75 — nothing is
 * done. Forcing those onto 9:16 would discard 40% and 65% of the picture
 * respectively, and destroying the image to tidy its metadata is the wrong
 * trade. Those outputs keep the mismatch.
 */
const MAX_CROP_TO_FIT = 0.20;   // 16:9 onto a 3:2 body costs 15.6%, which is a
                                // normal crop; a receipt costs 40% and a
                                // panorama 65%, which are not.

function snapToCameraFrame(x, y, w, h, cam) {
  const aspects = cam.aspects;
  if (!aspects || !aspects.length) return { x, y, w, h, out: null };

  const a = w / h;
  let best = null;
  for (const t of aspects) {
    const loss = 1 - Math.min(a, t) / Math.max(a, t);
    if (!best || loss < best.loss) best = { t, loss };
  }
  if (best.loss > MAX_CROP_TO_FIT) return { x, y, w, h, out: null };

  let nw = w, nh = h;
  if (a > best.t) nw = Math.round(h * best.t);
  else            nh = Math.round(w / best.t);
  const nx = x + Math.round((w - nw) / 2);
  const ny = y + Math.round((h - nh) / 2);

  // Land on a real capture resolution when the source is big enough to get
  // there by downscaling. Upscaling to reach it would be its own giveaway.
  let out = null;
  for (const [mw0, mh0] of cam.modes || []) {
    for (const [mw, mh] of [[mw0, mh0], [mh0, mw0]]) {
      if (Math.abs(mw / mh - best.t) > 0.01) continue;
      if (nw >= mw * 0.98 && nh >= mh * 0.98) { out = { width: mw, height: mh }; break; }
    }
    if (out) break;
  }
  return { x: nx, y: ny, w: nw, h: nh, out };
}

/**
 * Encode the finished canvas as the exporter's pixel container: a measured
 * Adobe quantization table (drawn per image), the DRI and restart markers the
 * exporter writes, Adobe's APP14 before the frame header, and optimised
 * Huffman tables. No metadata is added here; the caller inserts Exif, the
 * Photoshop block, the ICC profile and the XMP packet for a randomized file,
 * or nothing for a stripped one. Falls back to dropping the browser markers
 * and adding APP14 if the re-encoder cannot handle the frame.
 */
function encodeExportPixels(ctx, width, height, minimal = false) {
  const mcusX = Math.ceil(width / 8);   // 4:4:4, so the MCU is 8px; DRI = MCUs per row
  const url = ctx.canvas.toDataURL('image/jpeg', 1.0);
  const r = requantizeToExport(url, pickEditorQtable(),
    { restartInterval: mcusX, optimizeHuffman: true, app14: ADOBE_APP14 });
  if (r.ok) return r.dataUrl;
  return normaliseAppSegments(url, { app14: ADOBE_APP14 });   // fallback: at least drop APP0/ICC
}

function antiForensicRender(img, cam = {}) {
  const cameraType = cam.type || 'phone';
  const cameraMake = cam.make || '';
  const iso        = cam.iso  || 100;

  // Works for an HTMLImageElement (naturalWidth) and an ImageBitmap (width).
  const imgW = img.naturalWidth || img.width;
  const imgH = img.naturalHeight || img.height;

  // 1. Proportional crop
  const minDim  = Math.min(imgW, imgH);
  const maxCrop = Math.max(6, Math.floor(minDim * 0.012));
  const cropT   = randInt(1, maxCrop);
  const cropB   = randInt(1, maxCrop);
  const cropL   = randInt(1, maxCrop);
  const cropR   = randInt(1, maxCrop);
  const srcX    = cropL;
  const srcY    = cropT;
  const srcW    = imgW - cropL - cropR;
  const srcH    = imgH - cropT - cropB;

  // A non-photo (screenshot, graphic) has no sensor fingerprint and no lens,
  // so the anti-forensic stages — colour science, ISP, lens optics, sensor
  // noise, the PRNU warp — are pointless for it and would be wrong: a
  // screenshot with added vignetting and sensor noise is less plausible, not
  // more. `minimal` runs only crop, downscale and a clean re-encode. It is
  // also far lighter on memory, since it skips the full-resolution buffers the
  // warp and ISP stages allocate.
  const minimal = !!cam.minimal;

  if (srcW < 100 || srcH < 100) {
    const c   = document.createElement('canvas');
    c.width   = imgW;
    c.height  = imgH;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(img, 0, 0);
    if (!minimal) {
      applyCameraColorProfile(ctx, c.width, c.height, cameraMake);
      applyISPSimulation(ctx, c.width, c.height);
      applyLensOpticalEffects(ctx, c.width, c.height, cam);
      addPixelNoise(ctx, c.width, c.height, iso, cameraType);
    }
    return { dataUrl: encodeExportPixels(ctx, c.width, c.height, minimal), width: c.width, height: c.height };
  }

  // 3. Reshape to a frame the camera can produce, then size the output.
  // A native capture resolution is used when reachable; otherwise a downscale
  // is always applied, even to an already-small input. Resampling onto a new,
  // smaller grid is the one transform that reliably breaks sensor-pattern
  // (PRNU) correlation — it moves every photosite's noise off the lattice an
  // investigator's fingerprint lives on. The crop, rotation and warp weaken
  // that correlation; the downscale is what defeats it. 8–20% is invisible and
  // well within the range an export resizes by.
  const frame = snapToCameraFrame(srcX, srcY, srcW, srcH, cam);
  const longest = Math.max(frame.w, frame.h);
  // Non-photos are capped at 1600 on the long edge. They keep the exporter's
  // 4:4:4 container like everything else, so the quality-1.0 encode must stay
  // bounded: a very large, near-incompressible frame (fine noise) can exhaust
  // the renderer at quality 1.0, and no real screenshot needs more than 1600.
  const maxEdge = minimal ? Math.min(1600, Math.round(longest * (0.80 + rnd() * 0.12)))
                          : Math.min(randomMaxEdge(), Math.round(longest * (0.80 + rnd() * 0.12)));
  const size = frame.out || getExportDimensions(frame.w, frame.h, maxEdge);

  const c   = document.createElement('canvas');
  c.width   = size.width;
  c.height  = size.height;
  // willReadFrequently keeps the canvas CPU-backed. The pipeline calls
  // getImageData once per stage, and without this each call pays a
  // GPU-to-CPU readback; Chrome warns about it in the console.
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';

  if (minimal) {
    // Crop and downscale only, no rotation or sensor-pattern work.
    ctx.drawImage(img, frame.x, frame.y, frame.w, frame.h, 0, 0, size.width, size.height);
    return { dataUrl: encodeExportPixels(ctx, size.width, size.height, minimal), width: size.width, height: size.height };
  }

  // 2. Rotation on about two images in three, 0.3–2.0° either way. Rotating
  // every image was a tell twice over: a tilted horizon on each, and one more
  // constant in the recipe. The warp below carries the PRNU defence on the
  // images that are not rotated.
  const angleDeg = rnd() < 0.65 ? (rnd() < 0.5 ? 1 : -1) * (0.3 + rnd() * 1.7) : 0;
  const angle = angleDeg * (Math.PI / 180);

  // Aspect-ratio-aware scale so rotated image covers all four canvas corners.
  const ar    = size.height / size.width;
  const absA  = Math.abs(angle);
  const scale = Math.max(
    Math.cos(absA) + ar       * Math.sin(absA),   // x constraint
    Math.cos(absA) + Math.sin(absA) / ar           // y constraint
  ) + 0.002;

  ctx.translate(size.width  / 2, size.height / 2);
  ctx.rotate(angle);
  ctx.scale(scale, scale);
  ctx.translate(-size.width / 2, -size.height / 2);

  ctx.drawImage(img, frame.x, frame.y, frame.w, frame.h, 0, 0, size.width, size.height);
  ctx.setTransform(1, 0, 0, 1, 0, 0);

  // 3b. Non-rigid warp and a light denoise: the sensor-pattern defence.
  applyWarp(ctx, size.width, size.height);
  applyDenoise(ctx, size.width, size.height);

  // 4. Camera colour science
  applyCameraColorProfile(ctx, size.width, size.height, cameraMake);

  // 5. ISP pipeline simulation (demosaicing residuals + S-curve + unsharp mask)
  applyISPSimulation(ctx, size.width, size.height);

  // 6. Lens optical effects (vignetting + chromatic aberration)
  applyLensOpticalEffects(ctx, size.width, size.height, cam);

  // 7. Poisson-Gaussian noise (signal-dependent, ISO-matched)
  addPixelNoise(ctx, size.width, size.height, iso, cameraType);

  // 8. Encode as the exporter's pixel container. Quality 1.0 specifically: it
  // is the only setting at which the browser emits 4:4:4 chroma, which is what
  // an editor export uses. Everything lower is 4:2:0 and would contradict the
  // story the file tells. It is also the cleanest source for re-quantisation.
  return { dataUrl: encodeExportPixels(ctx, size.width, size.height, minimal), width: size.width, height: size.height };
}

/**
 * Decode an image and run it through the pipeline. `cam` carries the
 * generated camera (type, make, ISO, XMP segment); `{ strip: true }` renders
 * the metadata-free variant.
 */
/**
 * Decode an image from a Blob/File (or a URL string) into something
 * drawImage accepts, trying every path the browser supports.
 *
 * createImageBitmap decodes more formats than an <img> and whatever the
 * browser's codecs cover — JPEG, PNG, WebP, AVIF, and HEIC on browsers that
 * support it (Safari, and Chrome where the platform provides it). An <img>
 * fallback covers the rest. When nothing can decode it, the error names the
 * format so the message is actionable: HEIC on a browser without HEIC support
 * is the common case, and the fix (convert to JPEG, or use Safari) is clear.
 */
async function decodeImage(src) {
  const isBlob = typeof Blob !== 'undefined' && src instanceof Blob;
  if (isBlob && typeof createImageBitmap === 'function') {
    try { return await createImageBitmap(src); } catch (e) { /* fall through to <img> */ }
  }
  try {
    return await new Promise((res, rej) => {
      const img = new Image();
      img.onload  = () => res(img);
      img.onerror = () => rej(new Error('img decode failed'));
      img.src = isBlob ? URL.createObjectURL(src) : src;
    });
  } catch (e) {
    const type = (isBlob && src.type) ? src.type : '';
    if (/heic|heif/i.test(type) || /heic|heif/i.test(String(src.name || ''))) {
      throw new Error('This browser cannot decode HEIC/HEIF. Convert the image to JPEG first, or open MetaFaker in Safari, which decodes HEIC natively.');
    }
    throw new Error('Could not decode this image' + (type ? ' (' + type + ')' : '') + '. It may be an unsupported format or a corrupt file.');
  }
}

export function stripViaCanvas(src, cam) {
  return decodeImage(src).then(img => antiForensicRender(img, cam));
}

// ── Display / String Utilities ───────────────────────────────────

export function fmtBytes(b) {
  if (b < 1024) return `${b} B`;
  if (b < 1048576) return `${(b / 1024).toFixed(1)} KB`;
  return `${(b / 1048576).toFixed(2)} MB`;
}

export function fromRat(v) {
  if (!Array.isArray(v) || v.length !== 2) return null;
  const [n, d] = v;
  if (typeof n !== 'number' || typeof d !== 'number' || d === 0) return null;
  return n / d;
}

export function cleanExifStr(v) {
  return typeof v === 'string' ? v.replace(/\0+$/g, '') : v;
}

export function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function makeId() {
  if (window.crypto?.randomUUID) return window.crypto.randomUUID();
  return `img_${Date.now()}_${rnd().toString(36).slice(2, 10)}`;
}
