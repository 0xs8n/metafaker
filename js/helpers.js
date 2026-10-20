/**
 * helpers.js — Pure utility functions used across the app.
 */

import { requantize } from './jpeg-requantize.js';
import { pickEditorQtable, pickExportLongEdge, THUMB_QTABLE, ADOBE_APP14, editorIcc, xmpSegment } from './provenance.js';
import { rnd, pick, randInt } from './rng.js';
import { PLACES, ZONES } from './places.js';

/** The exporter's sRGB ICC profile as a ready-to-insert APP2 segment. */
export function iccApp2Segment() {
  return iccSegments(editorIcc())[0];
}

// ── Random & Math ────────────────────────────────────────────────

export { rnd, pick, randInt };
export const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));
export const cryptoRandInt = randInt;

// ── GPS Utilities ────────────────────────────────────────────────

const M_PER_DEG = 6371008.8 * Math.PI / 180;
let placesTotal = 0;
const PLACE_CUMULATIVE = PLACES.map(p => (placesTotal += p[4]));

/**
 * A US place drawn by population, and a point drawn uniformly in its disk.
 * tools/build-places.js sizes each disk so every point in it is inside the
 * place, on land and in one time zone; the sampling here uses the same local
 * projection the build checked.
 *
 * Altitude is ±20 m around the ground elevation at the disk's centre, so it
 * stays near the terrain. The time zone is carried through because
 * GPSTimeStamp has to be derived from the place's clock, not the machine's.
 */
export function pickLocation() {
  const x = rnd() * placesTotal;
  let lo = 0, hi = PLACES.length - 1;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (PLACE_CUMULATIVE[mid] > x) hi = mid; else lo = mid + 1; }
  const [city, lat0, lon0, radius, , elevation, zone] = PLACES[lo];
  const d = radius * Math.sqrt(rnd()), a = 2 * Math.PI * rnd();
  return {
    city,
    tz: ZONES[zone],
    lat: Number((lat0 + d * Math.cos(a) / M_PER_DEG).toFixed(6)),
    lon: Number((lon0 + d * Math.sin(a) / (M_PER_DEG * Math.cos(lat0 * Math.PI / 180))).toFixed(6)),
    alt: Math.round(elevation + (rnd() - 0.5) * 40),
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

/** The wall clock `tz` showed at a UTC instant, as a Date whose local fields are that reading. */
export function utcToWallClock(utcMs, tz) {
  const w = new Date(utcMs + tzOffsetMs(utcMs, tz));
  return new Date(w.getUTCFullYear(), w.getUTCMonth(), w.getUTCDate(), w.getUTCHours(), w.getUTCMinutes(), w.getUTCSeconds());
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

/**
 * Sunrise and sunset, as minutes after local midnight, on the wall-clock day
 * of `day` at a place in zone `tz`; null where the sun does not both rise and
 * set that day.
 */
export function sunriseSunset(lat, lon, day, tz) {
  const noon = new Date(day.getFullYear(), day.getMonth(), day.getDate(), 12);
  const midnight = wallClockToUtc(noon, tz).getTime() - 12 * 36e5;
  const above = m => sunElevation(lat, lon, new Date(midnight + m * 60000)) + 0.833;
  let rise = null, set = null;
  for (let m = 0, a = above(0); m < 1440; m += 10) {
    const b = above(m + 10);
    const at = m + 10 * a / (a - b);
    if (a < 0 && b >= 0 && rise === null) rise = at;
    if (a >= 0 && b < 0) set = at;
    a = b;
  }
  return rise !== null && set !== null && set > rise ? { rise, set } : null;
}

// ── GPS Coordinate Conversion ────────────────────────────────────

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

// ── Canvas / Image Processing ────────────────────────────────────

function scaleToLongEdge(width, height, maxEdge) {
  const longestEdge = Math.max(width, height);
  if (!longestEdge || longestEdge <= maxEdge) return { width, height };
  const scale = maxEdge / longestEdge;
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

/**
 * The claimed camera's own frame at aspect ratio `a` (width / height): the
 * largest its default native frame holds, which is what an uncropped export
 * of it measures (4032x3024 and 4032x2268 from an iPhone 13 Pro on Commons).
 * Null for a camera with no measured frame.
 */
function nativeFrame(cam, a) {
  const px = cam.sensor?.px || cam.modes?.[0];
  if (!px) return null;
  const W = Math.max(px[0], px[1]), H = Math.min(px[0], px[1]), r = Math.max(a, 1 / a);
  let long = W, short = H;
  if (Math.abs(r - W / H) >= 0.01) {
    if (r > W / H) short = Math.round(W / r);
    else long = Math.round(H * r);
  }
  return a >= 1 ? { w: long, h: short } : { w: short, h: long };
}

// The largest output: 16 MP (4899x3266 at 3:2, 4618x3464 at 4:3). Measured on
// a 60 MP input with tools/peak.js, the renderer's peak grows by about 50 MiB
// per output megapixel (1,226-1,553 MiB at 24 MP, 2,205-2,211 at 45 MP);
// at 16 MP it is 968-975 MiB, within the worst the tool reached at its old
// 3,200-pixel cap (1,072 MiB), rather than double it.
const MAX_OUTPUT_PIXELS = 16e6;

/**
 * The output size for a frame. A photo's long edge is drawn from real Adobe
 * exports of its kind of camera (provenance.js), within three limits:
 * 80 to 92% of the frame, so the image is always downscaled (see the
 * pipeline); the claimed camera's own frame, which no export of it exceeds,
 * so a draw above it lands on the native size, as so many real exports do;
 * and MAX_OUTPUT_PIXELS, where a draw above it lands anywhere in the top 10%
 * below it, so outputs do not pile up on one size no camera takes. Redrawing
 * instead would keep only the smaller exports: half of real body exports are
 * larger than 5472. Non-photos are capped at 1600: they keep the exporter's
 * 4:4:4 container, so the quality-1.0 encode must stay bounded (a large,
 * near-incompressible frame of fine noise can exhaust the renderer at quality
 * 1.0), and no real screenshot needs more.
 */
export function exportSize(frame, cam) {
  const fit = Math.round(Math.max(frame.w, frame.h) * (0.80 + rnd() * 0.12));
  if (cam.minimal) return scaleToLongEdge(frame.w, frame.h, Math.min(1600, fit));
  const a = frame.w / frame.h;
  const ceiling = Math.floor(Math.sqrt(MAX_OUTPUT_PIXELS * Math.max(a, 1 / a)));
  const native = nativeFrame(cam, a);
  const nativeLong = native && Math.max(native.w, native.h) <= ceiling ? Math.max(native.w, native.h) : Infinity;
  let drawn = pickExportLongEdge(cam.type || 'phone');
  if (drawn > ceiling && ceiling < Math.min(fit, nativeLong)) drawn = Math.round(ceiling * (0.9 + rnd() * 0.1));
  const edge = Math.min(drawn, fit, nativeLong, ceiling);
  if (edge === nativeLong) return { width: native.w, height: native.h };
  return scaleToLongEdge(frame.w, frame.h, edge);
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
 * Uniform Gaussian noise (the previous model) is not what a real sensor
 * produces: real sensor noise is heteroscedastic, so brighter pixels have
 * higher variance. The Poisson-Gaussian model matches what real sensors
 * produce, so the output reads as an ordinary photo.
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
  // A camera body's sensor is many times a phone's, so at the same ISO its
  // export is cleaner. Measured with tools/noise.py against plain downscales
  // of the same inputs, the body outputs carried about 0.4 levels more
  // luminance noise than the reference without this factor, and 0.12 less
  // with 0.75.
  if (cameraType === 'dslr') baseSigma *= 0.85;

  // Decompose into Poisson-Gaussian model: σ²(x) = a·x + b
  // The signal-dependent component gives the heteroscedastic structure real
  // sensors have, while keeping total noise within the calibrated sigma range
  // above. The shot-to-read split and the per-channel factors are drawn per
  // image: a fixed split would be a constant shared by every output, and a
  // shared constant is what lets separate images be linked to one another.
  const sig2 = baseSigma * baseSigma;
  const shot = 0.03 + rnd() * 0.12;    // 3–15% signal-dependent
  const a    = shot * sig2 / 128;
  const b    = (1 - shot) * sig2;

  // The noise is built the way it reaches a real export, not as three
  // independent channels. Demosaicing spreads each photosite's sample across
  // all three channels and its neighbours, and the raw converter's colour noise
  // reduction (25 by default in Camera Raw and Lightroom) smooths away most of
  // the chroma that is left. So the noise is a luminance field with a slight
  // grain, plus a much weaker, smoother chroma field. Per-channel independent
  // noise, which this used to add, is far more colourful than any real export.
  const P = NOISE_SHAPE[cameraType] || NOISE_SHAPE.phone;
  const grain   = P.grain[0]  + rnd() * (P.grain[1]  - P.grain[0]);
  const chroma  = P.chroma[0] + rnd() * (P.chroma[1] - P.chroma[0]);
  const cRadius = randInt(P.cRadius[0], P.cRadius[1]);
  const crTilt  = 0.8 + rnd() * 0.4;   // Cr against Cb, as the sensor's R/B gains differ

  // Chroma first, so its scratch buffer is gone before the luminance field and
  // the pixels are allocated: at most three full-frame float fields at once.
  const n  = w * h;
  const cb = gaussField(n), cr = gaussField(n);
  {
    const tmp = new Float32Array(n);
    smoothFieldBox(cb, w, h, cRadius, tmp);
    smoothFieldBox(cr, w, h, cRadius, tmp);
  }
  const lum = gaussField(n);
  smoothField3(lum, w, h, grain);

  const id = ctx.getImageData(0, 0, w, h);
  const d  = id.data;

  for (let p = 0, i = 0; p < n; p++, i += 4) {
    const r0 = d[i], g0 = d[i + 1], b0 = d[i + 2];
    const y0 = 0.299 * r0 + 0.587 * g0 + 0.114 * b0;
    const sigma = Math.sqrt(a * y0 + b);
    const dy  = lum[p] * sigma;
    const dcb = cb[p] * sigma * chroma;
    const dcr = cr[p] * sigma * chroma * crTilt;
    d[i]     = clamp(Math.round(r0 + dy + 1.402 * dcr), 0, 255);
    d[i + 1] = clamp(Math.round(g0 + dy - 0.344136 * dcb - 0.714136 * dcr), 0, 255);
    d[i + 2] = clamp(Math.round(b0 + dy + 1.772 * dcb), 0, 255);
  }

  ctx.putImageData(id, 0, 0);
}

// Per camera type, the ranges each image's noise character is drawn from:
// `grain` is the neighbour weight of the luminance field's 3x3 smoothing (0 is
// per-pixel white noise), `chroma` the chroma field's RMS relative to the
// luminance field's, and `cRadius` the box radius of the chroma smoothing.
// Calibrated with tools/noise.py: outputs of real camera files and Adobe
// exports against plain downscales of the same files (see tools/README.md).
const NOISE_SHAPE = {
  phone: { grain: [0.08, 0.30], chroma: [0.06, 0.24], cRadius: [1, 3] },
  dslr:  { grain: [0.06, 0.28], chroma: [0.05, 0.20], cRadius: [1, 3] },
};

/** n independent standard normal draws. */
function gaussField(n) {
  const f = new Float32Array(n);
  for (let i = 0; i < n; i++) f[i] = gaussRand();
  return f;
}

/**
 * Smooth a unit-variance white field in place with the separable kernel
 * [k, 1, k] and rescale it back to unit variance. Edges clamp.
 */
function smoothField3(f, w, h, k) {
  if (k <= 0) return;
  const g = 1 / Math.sqrt(1 + 2 * k * k);   // per axis, [k,1,k] scales white-noise variance by 1+2k²
  const row = new Float32Array(w);
  for (let y = 0; y < h; y++) {
    const o = y * w;
    for (let x = 0; x < w; x++) row[x] = f[o + x];
    for (let x = 0; x < w; x++) {
      const l = row[x > 0 ? x - 1 : 0], r = row[x < w - 1 ? x + 1 : w - 1];
      f[o + x] = (row[x] + k * (l + r)) * g;
    }
  }
  const col = new Float32Array(h);
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) col[y] = f[y * w + x];
    for (let y = 0; y < h; y++) {
      const u = col[y > 0 ? y - 1 : 0], v = col[y < h - 1 ? y + 1 : h - 1];
      f[y * w + x] = (col[y] + k * (u + v)) * g;
    }
  }
}

/**
 * Smooth a unit-variance white field in place with two passes of a separable
 * box of radius r (close to a Gaussian), and rescale it to unit variance.
 */
function smoothFieldBox(f, w, h, r, tmp) {
  const m = 2 * r + 1;
  for (let pass = 0; pass < 2; pass++) {
    for (let y = 0; y < h; y++) {               // horizontal, f -> tmp
      const o = y * w;
      let s = 0;
      for (let k = -r; k <= r; k++) s += f[o + clamp(k, 0, w - 1)];
      for (let x = 0; x < w; x++) {
        tmp[o + x] = s / m;
        s += f[o + Math.min(x + r + 1, w - 1)] - f[o + Math.max(x - r, 0)];
      }
    }
    for (let x = 0; x < w; x++) {               // vertical, tmp -> f
      let s = 0;
      for (let k = -r; k <= r; k++) s += tmp[clamp(k, 0, h - 1) * w + x];
      for (let y = 0; y < h; y++) {
        f[y * w + x] = s / m;
        s += tmp[Math.min(y + r + 1, h - 1) * w + x] - tmp[Math.max(y - r, 0) * w + x];
      }
    }
  }
  // Variance of white noise after two box passes: sum of the squared weights
  // of the triangular kernel they make, per axis, squared for two axes.
  let ss = 0;
  for (let t = -2 * r; t <= 2 * r; t++) { const c = (m - Math.abs(t)) / (m * m); ss += c * c; }
  const g = 1 / ss;                             // = 1 / (per-axis variance)
  for (let i = 0; i < f.length; i++) f[i] *= g;  // sqrt(g²) for the two axes
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
  // The saturation change is taken from a smoothed copy, so it reaches the
  // picture's colours but not its fine chroma grain. Boosting every pixel's
  // chroma also boosted the photo's colour noise: measured with
  // tools/noise.py, a 1.15 boost raised the chroma-to-luminance noise ratio by
  // about 0.06, which made the phone outputs more colourful than real exports.
  const smooth = satScale !== 1 ? boxBlurRGB(d, w, h, 2) : null;
  const satAdd = satScale - 1;

  for (let i = 0; i < d.length; i += 4) {
    let r = d[i], g = d[i + 1], b = d[i + 2];

    // Contrast around midpoint 128
    r = clamp(Math.round((r - 128) * contrast + 128), 0, 255);
    g = clamp(Math.round((g - 128) * contrast + 128), 0, 255);
    b = clamp(Math.round((b - 128) * contrast + 128), 0, 255);

    // Colour temperature
    r = clamp(Math.round(r + warmth), 0, 255);
    b = clamp(Math.round(b - warmth), 0, 255);

    // Luminance-preserving saturation of the low-frequency colour: the
    // smoothed copy's chroma after the same contrast and warmth (the constant
    // part of the contrast cancels out of a chroma difference).
    if (smooth) {
      const sr = smooth[i] * contrast + warmth, sg = smooth[i + 1] * contrast, sb = smooth[i + 2] * contrast - warmth;
      const sl = 0.2126 * sr + 0.7152 * sg + 0.0722 * sb;
      r = clamp(Math.round(r + (sr - sl) * satAdd), 0, 255);
      g = clamp(Math.round(g + (sg - sl) * satAdd), 0, 255);
      b = clamp(Math.round(b + (sb - sl) * satAdd), 0, 255);
    }

    d[i] = r; d[i + 1] = g; d[i + 2] = b;
  }

  ctx.putImageData(id, 0, 0);
}

/**
 * Reproduce the statistical character of a camera's image pipeline.
 *
 * Real cameras run demosaicing → denoising → sharpening → tone mapping before
 * JPEG encoding, and each stage leaves characteristic statistical traces in
 * the pixels. An image re-encoded by a browser lacks them, which sets it apart
 * from ordinary photos; reproducing them keeps the output consistent with the
 * photo it presents as.
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
  // Applying the same curve and the same 3x3 sharpen to every file would be a
  // fixed recipe shared by every output, which would link separate images to
  // one another.

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
  // around edges, a statistical trace every ordinary photo carries.
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
 * Meant to weaken the sensor-pattern (PRNU) link. A crop and rotation are one
 * global transform, and a sensor-pattern match can be re-aligned through it by
 * searching over scale and rotation; a field that varies across the frame has
 * no single inverse. In practice its effect is small: the field's wavelengths
 * (120-520 px) make it nearly a plain shift over any patch, and on real phones
 * the warp, denoise and fresh noise together cut the match score only about
 * twofold, far from breaking it. The displacement is a sum of three
 * low-frequency waves with random directions, wavelengths and phases, and a
 * total amplitude under two pixels, so nothing is visible.
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
 * Every real camera lens produces both, so a photo without them is
 * inconsistent with the lens it names.
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

  // Lateral CA is what is left after correction: phones correct it in the
  // image processor and Camera Raw's profiles remove most of the rest, so the
  // residual is a fraction of a pixel at the corner. It used to be drawn as
  // 0.03–0.08% of the diagonal (up to about 3 px) and applied with whole-pixel
  // rounding, which misregistered the colour channels across the whole frame:
  // measured with tools/noise.py, that alone raised the chroma-to-luminance
  // noise ratio by about 0.5 on the images it touched. Red outward is the
  // common direction, but over-corrected lenses fringe the other way, so the
  // sign is drawn too.
  const caSign   = rnd() < 0.7 ? 1 : -1;
  const caMax    = !doCA ? 0 : caSign * (cameraType === 'dslr'
    ? 0.08 + rnd() * 0.27     // px at the corner
    : 0.10 + rnd() * 0.35);

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

        // Red shifts outward; blue shifts inward toward centre. Sampled
        // bilinearly: the shift is sub-pixel.
        d[i]     = clamp(Math.round(sampleBilinear(rBuf, w, h, x + normDX * shift, y + normDY * shift) * vign), 0, 255);
        d[i + 1] = clamp(Math.round(gBuf[p] * vign), 0, 255);
        d[i + 2] = clamp(Math.round(sampleBilinear(bBuf, w, h, x - normDX * shift, y - normDY * shift) * vign), 0, 255);
      } else {
        d[i]     = clamp(Math.round(rBuf[p] * vign), 0, 255);
        d[i + 1] = clamp(Math.round(gBuf[p] * vign), 0, 255);
        d[i + 2] = clamp(Math.round(bBuf[p] * vign), 0, 255);
      }
    }
  }

  ctx.putImageData(id, 0, 0);
}

/** One channel buffer sampled at a fractional position, edges clamped. */
function sampleBilinear(buf, w, h, fx, fy) {
  fx = clamp(fx, 0, w - 1); fy = clamp(fy, 0, h - 1);
  const x0 = Math.floor(fx), y0 = Math.floor(fy);
  const x1 = Math.min(x0 + 1, w - 1), y1 = Math.min(y0 + 1, h - 1);
  const tx = fx - x0, ty = fy - y0;
  const top = buf[y0 * w + x0] + (buf[y0 * w + x1] - buf[y0 * w + x0]) * tx;
  const bot = buf[y1 * w + x0] + (buf[y1 * w + x1] - buf[y1 * w + x0]) * tx;
  return top + (bot - top) * ty;
}

/** A JPEG as the browser's encoder writes it, as bytes. */
async function canvasJpegBytes(canvas) {
  const blob = await new Promise(res => canvas.toBlob(res, 'image/jpeg', 1.0));
  if (!blob) throw new Error('The browser could not encode the image.');
  return new Uint8Array(await blob.arrayBuffer());
}

/**
 * Re-quantise a freshly encoded JPEG onto one of the exporter's measured
 * quantization tables and write it in the exporter's pixel container: the
 * browser's APP0 and ICC are dropped, the coefficients are rescaled onto the
 * new tables (overwriting the DQT bytes alone would change the picture), a DRI
 * segment and restart markers are added, Adobe's APP14 is placed before the
 * frame header, and the Huffman tables are optimised the way the exporter's
 * encoder optimises them. Returns the new bytes, or null when the input is not
 * plain baseline JPEG, in which case the caller falls back.
 */
function requantizeToExport(bytes, table, opts) {
  try {
    return requantize(bytes, table, opts) || null;
  } catch (e) {
    return null;
  }
}

/**
 * Encode a 256-long-edge thumbnail the way the exporter does: the standard
 * (Annex K) quantization tables scaled to its thumbnail quality, a 32-MCU
 * restart interval, Adobe's APP14 and the standard Huffman tables. Returns the
 * raw bytes, a binary string for the IFD1 payload, and the dimensions. The
 * same bytes go into both IFD1 and the Photoshop block, as the exports do.
 * Drawn from the finished canvas, so the output never has to be decoded again.
 */
async function makeAdobeThumbnail(source, longEdge = 256) {
  try {
    const scale = longEdge / Math.max(source.width, source.height, 1);
    const w = Math.max(1, Math.round(source.width  * scale));
    const h = Math.max(1, Math.round(source.height * scale));
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const ctx = c.getContext('2d');
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(source, 0, 0, w, h);
    const out = requantize(await canvasJpegBytes(c), THUMB_QTABLE,
      { restartInterval: 32, optimizeHuffman: false, app14: ADOBE_APP14 });
    if (!out || out.length > 63000) return null;
    let bin = '';
    for (let i = 0; i < out.length; i += 0x8000) bin += String.fromCharCode.apply(null, out.subarray(i, i + 0x8000));
    return { bytes: out, binary: bin, width: w, height: h };
  } catch (e) {
    return null;
  }
}

/**
 * Insert metadata segments immediately after SOI, before the first marker the
 * pixel JPEG carries (its DQT). Used to add the Exif, Photoshop, ICC and XMP
 * segments to the exporter's pixel container in the order the exports show.
 */
export function insertAfterSoi(bytes, segments) {
  if (bytes[0] !== 0xFF || bytes[1] !== 0xD8) return bytes;
  const add = segments.filter(Boolean);
  const addLen = add.reduce((n, s) => n + s.length, 0);
  const out = new Uint8Array(bytes.length + addLen);
  let o = 0;
  out.set([0xFF, 0xD8], o); o += 2;
  for (const s of add) { out.set(s, o); o += s.length; }
  out.set(bytes.subarray(2), o);
  return out;
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

/**
 * Strip the browser's signature APP segments from a JPEG.
 *
 * The canvas encoder emits two segments that no camera would pair with the
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
export function normaliseAppSegments(bytes, opts = {}) {
  if (bytes[0] !== 0xFF || bytes[1] !== 0xD8) return bytes;   // not a JPEG

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
    if (len < 2 || end > bytes.length) return bytes;   // malformed, leave alone
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

  return out;
}

/**
 * Core privacy canvas pipeline: removes the traces in the pixels that could
 * link an image back to the original photo and the device that took it.
 *
 * The stages, in order. Every parameter is drawn per image and several stages
 * run on only a share of images, so there is no fixed recipe to learn:
 *
 *   1. Proportional crop (≤1.2% per edge) — shifts the sensor grid
 *   2. Rotation (±0.3°–2.0°) on two images in three
 *   3. Reshape to a frame the camera can produce, then size
 *   3b. Non-rigid warp (sub-pixel to ~2 px) and a light denoise — weakens the
 *       sensor-pattern (PRNU) link to the camera; a global transform can be
 *       re-aligned, a field cannot
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
 * This is the most visible inconsistency an output could carry. A file
 * presenting as a Pixel 6a at 533x1598 describes a frame no Pixel has ever
 * produced — the aspect ratio alone rules it out before anyone looks at the
 * resolution. The dimensions come
 * from whatever image was loaded, not from the camera being claimed.
 *
 * Where the source is already close to one of the camera's frame shapes, it is
 * centre-cropped onto it. The output is then always downscaled from there; it
 * never lands on the camera's native resolution, because an export is normally
 * smaller than native and every bit of downscaling weakens the sensor pattern.
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
  if (!aspects || !aspects.length) return { x, y, w, h };

  const a = w / h;
  let best = null;
  for (const t of aspects) {
    const loss = 1 - Math.min(a, t) / Math.max(a, t);
    if (!best || loss < best.loss) best = { t, loss };
  }
  if (best.loss > MAX_CROP_TO_FIT) return { x, y, w, h };

  let nw = w, nh = h;
  if (a > best.t) nw = Math.round(h * best.t);
  else            nh = Math.round(w / best.t);
  const nx = x + Math.round((w - nw) / 2);
  const ny = y + Math.round((h - nh) / 2);
  return { x: nx, y: ny, w: nw, h: nh };
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
async function encodeExportPixels(canvas) {
  const mcusX = Math.ceil(canvas.width / 8);   // 4:4:4, so the MCU is 8px; DRI = MCUs per row
  const raw = await canvasJpegBytes(canvas);
  return requantizeToExport(raw, pickEditorQtable(),
    { restartInterval: mcusX, optimizeHuffman: true, app14: ADOBE_APP14 })
    || normaliseAppSegments(raw, { app14: ADOBE_APP14 });   // fallback: at least drop APP0/ICC
}

/**
 * The crop the render applied, as Adobe records one: the output's top-left
 * and bottom-right corners in normalised source coordinates, and CropAngle in
 * degrees. Measured on real exports with a straightened crop (Lightroom
 * Classic 13.5.1, 10.3): the TL-to-BR diagonal is R(CropAngle)·(w, h) for the
 * output's own w × h, so the angle is the opposite of the canvas rotation.
 */
function appliedCrop(imgW, imgH, frame, W, H, angle = 0, scale = 1) {
  const cos = Math.cos(angle), sin = Math.sin(angle);
  const corner = (dx, dy) => {
    const ux = W / 2 + (dx * cos + dy * sin) / scale;      // canvas → drawn-image coordinates
    const uy = H / 2 + (-dx * sin + dy * cos) / scale;
    return [(frame.x + ux * frame.w / W) / imgW, (frame.y + uy * frame.h / H) / imgH];
  };
  const [left, top] = corner(-W / 2, -H / 2);
  const [right, bottom] = corner(W / 2, H / 2);
  return { top, left, bottom, right, angle: -angle * 180 / Math.PI };
}

const PREVIEW_EDGE = 1600;

/**
 * A small copy of a drawable for the page to display. Shown at its own size,
 * a 60 MP photo is decoded whole for the screen and held while it is visible,
 * for a box a few hundred pixels wide: with this copy instead, the renderer's
 * peak after loading one fell from 803-953 MiB to about 450 (measured).
 * WebP keeps a graphic's transparency; a browser without a WebP encoder
 * writes PNG instead.
 */
export async function makePreviewBlob(source) {
  const scale = Math.min(1, PREVIEW_EDGE / Math.max(source.width, source.height, 1));
  const c = document.createElement('canvas');
  c.width  = Math.max(1, Math.round(source.width  * scale));
  c.height = Math.max(1, Math.round(source.height * scale));
  const ctx = c.getContext('2d');
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(source, 0, 0, c.width, c.height);
  const blob = await new Promise(res => c.toBlob(res, 'image/webp', 0.9));
  c.width = c.height = 0;
  return blob;
}

/**
 * The finished canvas as the caller needs it: the pixel container's bytes, the
 * preview, the crop it records and, when asked for, the Adobe thumbnail. The
 * canvas's backing store is released here rather than whenever it is collected.
 */
async function finishRender(canvas, cam, crop = null) {
  const out = {
    crop,
    bytes: await encodeExportPixels(canvas),
    width: canvas.width, height: canvas.height,
    preview: await makePreviewBlob(canvas),
    thumb: cam.thumbnail ? await makeAdobeThumbnail(canvas) : null,
  };
  canvas.width = canvas.height = 0;
  return out;
}

async function privacyRender(input, cam = {}) {
  const cameraType = cam.type || 'phone';
  const cameraMake = cam.make || '';
  const iso        = cam.iso  || 100;

  const imgW = input.width;
  const imgH = input.height;

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
  // so the privacy stages — colour science, ISP, lens optics, sensor
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
    await drawRegion(ctx, input, { x: 0, y: 0, w: imgW, h: imgH }, imgW, imgH, 1);
    if (!minimal) {
      applyCameraColorProfile(ctx, c.width, c.height, cameraMake);
      applyISPSimulation(ctx, c.width, c.height);
      applyLensOpticalEffects(ctx, c.width, c.height, cam);
      addPixelNoise(ctx, c.width, c.height, iso, cameraType);
    }
    return finishRender(c, cam);
  }

  // 3. Reshape to a frame the camera can produce, then size the output. A
  // downscale is always applied, even to an already-small input: resampling
  // onto a new, smaller grid moves every photosite's noise off the lattice the
  // camera's sensor pattern (PRNU) lives on, which weakens the link between the
  // photo and the camera. It does NOT break that link: measured on real phones
  // (iPhone 6, Huawei P9), outputs at these scales still match the camera's
  // fingerprint, and offline even a 0.3 scale did. See the README threat model.
  const frame = snapToCameraFrame(srcX, srcY, srcW, srcH, cam);
  const size = exportSize(frame, cam);

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
    await drawRegion(ctx, input, frame, size.width, size.height, 1);
    return finishRender(c, cam, appliedCrop(imgW, imgH, frame, size.width, size.height));
  }

  // 2. Rotation on about two images in three, 0.3–2.0° either way. Rotating
  // every image would stand out twice over: a tilted horizon on each, and one
  // more constant shared by every output. The warp below carries the
  // sensor-pattern protection on the images that are not rotated.
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

  await drawRegion(ctx, input, frame, size.width, size.height, scale);
  ctx.setTransform(1, 0, 0, 1, 0, 0);

  // 3b. Non-rigid warp and a light denoise: part of the sensor-pattern
  // protection.
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
  return finishRender(c, cam, appliedCrop(imgW, imgH, frame, size.width, size.height, angle, scale));
}

/**
 * Draw the rectangle `r` of the input onto ctx at (0, 0, tw, th), under ctx's
 * transform, whose own `zoom` enlarges it further.
 *
 * The input is decoded whole at twice the size it is drawn at, at most its
 * own, and the crop and the final step down happen in this draw. Measured
 * against drawing from the full-resolution decode (12 and 60 MP inputs,
 * 2,048 to 7,000 px outputs, mean absolute Laplacian of luma): the same
 * sharpness on an unrotated frame and 3 to 11% less on a rotated one, with no
 * difference visible in 100% crops. Decoding only the frame at the drawn size
 * (createImageBitmap with a source rectangle) cost 8 to 26% of the sharpness,
 * and Chrome placed the rectangle mirrored on a photo with EXIF orientation 6.
 */
async function drawRegion(ctx, input, r, tw, th, zoom) {
  const img = await input.scaled(Math.min(1, 2 * tw * zoom / r.w));
  const kx = img.width / input.width, ky = img.height / input.height;
  ctx.drawImage(img, r.x * kx, r.y * ky, r.w * kx, r.h * ky, 0, 0, tw, th);
  if (img.close) img.close();
}

function loadImage(url) {
  return new Promise((res, rej) => {
    const img = new Image();
    img.onload  = () => res(img);
    img.onerror = () => rej(new Error('img decode failed'));
    img.src = url;
  });
}

/**
 * Open an input from a Blob/File (or a URL string) without decoding it whole.
 * Resolves to its dimensions as displayed (EXIF orientation applied),
 * `scaled(k)`, the whole image decoded at k times that size, and `close()`.
 *
 * Decoding the whole image at full size and holding it kept the
 * full-resolution bitmap alive for the entire render: 4 bytes per pixel,
 * 240 MB for a 60 MP photo, on top of every stage's buffers. An <img> that is
 * never displayed only reads the header, so it gives the size for free, and
 * createImageBitmap with resize options hands back the picture at the size the
 * render needs. Chrome still decodes the whole file inside that call
 * (measured), but drops it before the first stage allocates anything.
 *
 * createImageBitmap covers whatever the browser's codecs cover: JPEG, PNG,
 * WebP, AVIF, and HEIC on browsers that support it (Safari, and Chrome where
 * the platform provides it). Where it cannot decode a format the <img> can
 * (SVG), the picture is drawn from the <img>. When nothing can decode it, the
 * error names the format so the message is actionable: HEIC on a browser
 * without HEIC support is the common case, and the fix (convert to JPEG, or
 * use Safari) is clear.
 */
async function openSource(src) {
  const isBlob = typeof Blob !== 'undefined' && src instanceof Blob;
  const url = isBlob ? URL.createObjectURL(src) : src;
  const close = () => { if (isBlob) URL.revokeObjectURL(url); };
  const fromImage = (img, dw, dh) => {
    const c = document.createElement('canvas');
    c.width = dw; c.height = dh;
    const ctx = c.getContext('2d');
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(img, 0, 0, dw, dh);
    return c;
  };
  const sized = (w, h, k) => [Math.max(1, Math.round(w * k)), Math.max(1, Math.round(h * k))];
  const canBitmap = isBlob && typeof createImageBitmap === 'function';
  try {
    const img = await loadImage(url);
    return {
      width: img.naturalWidth, height: img.naturalHeight, close,
      async scaled(k) {
        const [dw, dh] = sized(img.naturalWidth, img.naturalHeight, k);
        if (canBitmap) {
          try {
            return await createImageBitmap(src, { resizeWidth: dw, resizeHeight: dh, resizeQuality: 'high' });
          } catch (e) { /* fall through to the <img> */ }
        }
        return fromImage(img, dw, dh);
      },
    };
  } catch (e) { /* the <img> could not read it; createImageBitmap may */ }
  try {
    if (!canBitmap) throw new Error('no createImageBitmap');
    const bmp = await createImageBitmap(src);
    return {
      width: bmp.width, height: bmp.height,
      close() { bmp.close(); close(); },
      async scaled(k) { return fromImage(bmp, ...sized(bmp.width, bmp.height, k)); },
    };
  } catch (e) {
    close();
    const type = (isBlob && src.type) ? src.type : '';
    if (/heic|heif/i.test(type) || /heic|heif/i.test(String(src.name || ''))) {
      throw new Error('This browser cannot decode HEIC/HEIF. Convert the image to JPEG first, or open MetaFaker in Safari, which decodes HEIC natively.');
    }
    throw new Error('Could not decode this image' + (type ? ' (' + type + ')' : '') + '. It may be an unsupported format or a corrupt file.');
  }
}

/**
 * Run an image through the pipeline. `cam` carries the generated camera (type,
 * make, ISO), `minimal` for a non-photo and `thumbnail` when the caller needs
 * the Adobe thumbnail. Resolves to { bytes, width, height, preview, thumb }:
 * the pixel container with no metadata, its size, a small preview Blob, and
 * the thumbnail or null.
 */
export async function stripViaCanvas(src, cam) {
  const input = await openSource(src);
  try { return await privacyRender(input, cam); }
  finally { input.close(); }
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
