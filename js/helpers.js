/**
 * helpers.js — Pure utility functions used across the app.
 */

import { canvasToJpegDataUrl } from './jpeg-encoder.js';

// ── Random & Math ────────────────────────────────────────────────

export const pick = a => a[Math.floor(Math.random() * a.length)];
export const randInt = (lo, hi) => Math.floor(Math.random() * (hi - lo + 1)) + lo;
export const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

/** Cryptographically secure random float in [0, 1). */
export function cryptoRandFloat() {
  const buf = new Uint32Array(1);
  crypto.getRandomValues(buf);
  return buf[0] / (0xFFFFFFFF + 1);
}

/** Cryptographically secure random integer in [lo, hi]. */
export function cryptoRandInt(lo, hi) {
  const range = hi - lo + 1;
  const buf = new Uint32Array(1);
  crypto.getRandomValues(buf);
  return lo + (buf[0] % range);
}

// ── GPS Utilities ────────────────────────────────────────────────

/**
 * Jitter a location by ±0.3° in each direction.
 * Works for any global coordinate — no US-specific clamping.
 */
export function jitterLocation(base) {
  const lat = base.lat + (Math.random() - 0.5) * 0.6;
  const lon = base.lon + (Math.random() - 0.5) * 0.6;
  return {
    city: base.city,
    lat: Number(clamp(lat, -89.99, 89.99).toFixed(6)),
    lon: Number(clamp(lon, -179.99, 179.99).toFixed(6)),
  };
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

export function randomDate() {
  const now = Date.now();
  return new Date(now - Math.random() * 730 * 864e5);
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

export function fileToDataUrl(file) {
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = e => res(e.target.result);
    r.onerror = rej;
    r.readAsDataURL(file);
  });
}

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

/**
 * Bimodal JPEG quality picker matched to camera type.
 * Wider range creates more quantization table diversity between images,
 * defeating Huffman-table clustering analysis.
 */
export function randomJpegQuality(cameraType = 'phone') {
  const r = Math.random();
  if (cameraType === 'dslr') {
    if (r < 0.15) return 0.78 + Math.random() * 0.07;  // 0.78–0.85
    if (r < 0.60) return 0.86 + Math.random() * 0.06;  // 0.86–0.92
    return 0.93 + Math.random() * 0.03;                  // 0.93–0.96
  }
  if (r < 0.40) return 0.70 + Math.random() * 0.10;    // 0.70–0.80
  if (r < 0.80) return 0.82 + Math.random() * 0.10;    // 0.82–0.92
  return 0.93 + Math.random() * 0.03;                    // 0.93–0.96
}

export function randomMaxEdge() {
  const edges = [2048, 2160, 2400, 2560, 2880, 3200];
  return edges[Math.floor(Math.random() * edges.length)];
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
  do { u = Math.random() * 2 - 1; v = Math.random() * 2 - 1; s = u * u + v * v; }
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
  if      (iso <= 200)  baseSigma = 0.7 + Math.random() * 0.5;  // 0.7–1.2
  else if (iso <= 800)  baseSigma = 1.3 + Math.random() * 0.9;  // 1.3–2.2
  else if (iso <= 3200) baseSigma = 2.0 + Math.random() * 1.5;  // 2.0–3.5
  else                  baseSigma = 3.0 + Math.random() * 2.0;  // 3.0–5.0

  // Decompose into Poisson-Gaussian model: σ²(x) = a·x + b
  // The signal-dependent component gives the heteroscedastic structure that
  // ML forensic tools (Noiseprint++, TruFor) verify, while keeping total
  // noise within the calibrated sigma range above.
  const sig2 = baseSigma * baseSigma;
  const a    = 0.05 * sig2 / 128;   // ~5% signal-dependent (shot noise)
  const b    = 0.95 * sig2;          // ~95% constant (read noise)

  const id = ctx.getImageData(0, 0, w, h);
  const d  = id.data;

  for (let i = 0; i < d.length; i += 4) {
    const r0 = d[i], g0 = d[i + 1], b0 = d[i + 2];

    if (cameraType === 'phone') {
      // Bayer CFA: 2 green, 1 red, 1 blue per 2×2 block.
      // R/B have ~20% more shot noise than G (fewer photosites per unit area).
      const sigmaR = Math.sqrt(a * 1.2 * r0 + b);
      const sigmaG = Math.sqrt(a * 0.8 * g0 + b * 0.7);
      const sigmaB = Math.sqrt(a * 1.2 * b0 + b);
      d[i]     = clamp(Math.round(r0 + gaussRand() * sigmaR), 0, 255);
      d[i + 1] = clamp(Math.round(g0 + gaussRand() * sigmaG), 0, 255);
      d[i + 2] = clamp(Math.round(b0 + gaussRand() * sigmaB), 0, 255);
    } else {
      // DSLR: luminance-dominant noise with small chroma component.
      const luma  = 0.2126 * r0 + 0.7152 * g0 + 0.0722 * b0;
      const sigma = Math.sqrt(a * luma + b);
      const lN    = gaussRand() * sigma;
      const cN    = gaussRand() * sigma * 0.2;
      d[i]     = clamp(Math.round(r0 + lN + cN), 0, 255);
      d[i + 1] = clamp(Math.round(g0 + lN),       0, 255);
      d[i + 2] = clamp(Math.round(b0 + lN - cN), 0, 255);
    }
  }

  ctx.putImageData(id, 0, 0);
}

// ── Camera colour science ────────────────────────────────────────

const CAMERA_COLOR_PROFILES = {
  'Apple':    { warmth:  3, satScale: 1.02, contrast: 1.01 },
  'Samsung':  { warmth:  1, satScale: 1.05, contrast: 1.03 },
  'Google':   { warmth: -2, satScale: 1.03, contrast: 1.02 },
  'OnePlus':  { warmth:  1, satScale: 1.04, contrast: 1.02 },
  'Xiaomi':   { warmth:  2, satScale: 1.04, contrast: 1.02 },
  'Canon':    { warmth:  4, satScale: 1.03, contrast: 1.01 },
  'Nikon':    { warmth:  0, satScale: 1.00, contrast: 1.00 },
  'Sony':     { warmth: -3, satScale: 0.99, contrast: 1.01 },
  'FUJIFILM': { warmth:  2, satScale: 1.02, contrast: 1.04 },
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

  const warmth   = base.warmth   + (Math.random() - 0.5) * 2;
  const satScale = base.satScale + (Math.random() - 0.5) * 0.03;
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
export function applyISPSimulation(ctx, w, h) {
  const id = ctx.getImageData(0, 0, w, h);
  const d  = id.data;

  // ── 1. Demosaicing residuals ──────────────────────────────────
  // Real Bayer demosaicing leaves a Laplacian-shaped residual in the green
  // channel (dominant colour in the Bayer CFA). ML detectors analyse the
  // frequency-domain power spectrum of this residual. Amplitude at 0.3–0.6%
  // is forensically detectable but completely invisible to humans.
  const demosaicStr = 0.003 + Math.random() * 0.003;
  const gChan = new Uint8Array(w * h);
  for (let i = 0; i < d.length; i += 4) gChan[i >> 2] = d[i + 1];

  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const p   = (y * w + x) * 4;
      const idx = y * w + x;
      const lap = gChan[(y - 1) * w + x] + gChan[(y + 1) * w + x] +
                  gChan[y * w + (x - 1)] + gChan[y * w + (x + 1)] - 4 * gChan[idx];
      const res = Math.round(lap * demosaicStr);
      d[p]     = clamp(d[p]     + res, 0, 255);
      d[p + 1] = clamp(d[p + 1] + res, 0, 255);
      d[p + 2] = clamp(d[p + 2] + res, 0, 255);
    }
  }

  // ── 2. S-curve tone mapping (LUT) ────────────────────────────
  // Camera firmware applies a characteristic S-shaped tone curve for contrast.
  // The resulting histogram shape is a camera-authenticity marker. We use a
  // properly anchored S-curve: lut[0]=0, lut[128]=128, lut[255]=255.
  // Kept very weak (0.06–0.14) so histogram shape changes are ML-detectable
  // but not visible to a human observer.
  const cs = 0.06 + Math.random() * 0.08;         // curve strength 0.06–0.14
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

  // ── 3. Unsharp mask sharpening ───────────────────────────────
  // In-camera sharpening (USM) creates characteristic halo/ringing around
  // edges — a statistical trace that forensic models are trained to see.
  // Kept very subtle (0.04–0.08) so edge ringing is statistically present
  // but halos are invisible at normal viewing distances.
  const sharpStr = 0.04 + Math.random() * 0.04;   // 0.04–0.08
  const orig     = new Uint8ClampedArray(d);

  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const p = (y * w + x) * 4;
      for (let c = 0; c < 3; c++) {
        const blur = (
          orig[((y - 1) * w + (x - 1)) * 4 + c] + orig[((y - 1) * w + x) * 4 + c] + orig[((y - 1) * w + (x + 1)) * 4 + c] +
          orig[(y * w + (x - 1)) * 4 + c]        + orig[(y * w + x) * 4 + c]        + orig[(y * w + (x + 1)) * 4 + c] +
          orig[((y + 1) * w + (x - 1)) * 4 + c] + orig[((y + 1) * w + x) * 4 + c] + orig[((y + 1) * w + (x + 1)) * 4 + c]
        ) / 9;
        d[p + c] = clamp(Math.round(orig[p + c] + sharpStr * (orig[p + c] - blur)), 0, 255);
      }
    }
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

  // Real lens vignetting: subtle cos⁴ light falloff toward corners.
  // Values kept low so the darkening is statistically present in the noise
  // profile but not visible as a gradient to the naked eye (~2–5% at corners).
  const vBase = cameraType === 'dslr'
    ? 0.012 + Math.random() * 0.018  // ~1.7–4% corner darkening
    : 0.018 + Math.random() * 0.022; // ~2.5–5.5% corner darkening

  const diagonal = Math.sqrt(w * w + h * h);
  // CA kept under 1px at the extreme corners — imperceptible fringing.
  const caMax    = cameraType === 'dslr'
    ? (0.00005 + Math.random() * 0.00010) * diagonal  // ~0.16–0.48px at corner
    : (0.00010 + Math.random() * 0.00015) * diagonal; // ~0.32–0.80px at corner

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

      if (dist > 0.5) {
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
 * Strip the JFIF APP0 marker from a JPEG data URL.
 *
 * canvas.toDataURL() always emits APP0 (FF E0) right after SOI.
 * Real cameras never write JFIF APP0 — they write APP1 (EXIF) only.
 * Removing it eliminates the consistent browser-version byte signature.
 */
export function stripApp0(dataUrl) {
  const m = dataUrl.match(/^data:([^;]+);base64,(.+)$/);
  if (!m) return dataUrl;

  const mime  = m[1];
  const bin   = atob(m[2]);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);

  // Must be SOI (FF D8) + APP0 (FF E0)
  if (bytes[0] !== 0xFF || bytes[1] !== 0xD8 ||
      bytes[2] !== 0xFF || bytes[3] !== 0xE0) {
    return dataUrl;
  }

  const app0Len = (bytes[4] << 8) | bytes[5]; // includes the 2 length bytes
  const app0End = 2 + 2 + app0Len;            // SOI(2) + marker(2) + length body

  const out = new Uint8Array(bytes.length - 2 - app0Len);
  out[0] = 0xFF;
  out[1] = 0xD8;
  out.set(bytes.subarray(app0End), 2);

  let outBin = '';
  for (let k = 0; k < out.length; k++) outBin += String.fromCharCode(out[k]);
  return `data:${mime};base64,${btoa(outBin)}`;
}

/**
 * Core anti-forensic canvas pipeline.
 *
 * Ten layers defeat both device-correlation forensics and ML manipulation
 * detection (TruFor, ManTraNet, CAT-Net, Noiseprint++):
 *
 *   1. Proportional crop (≤1.2% per edge) — shifts PRNU grid alignment
 *   2. Bimodal rotation (±0.5°–2.0°) — sub-pixel interpolation destroys PRNU
 *   3. Random resize — prevents dimension-based clustering
 *   4. Camera colour science — brand-specific tone/saturation/contrast
 *   5. ISP pipeline simulation — demosaicing residuals + S-curve + unsharp mask
 *      (embeds statistical traces ML detectors expect from real cameras)
 *   6. Lens optical effects — vignetting (cos⁴) + chromatic aberration
 *      (every real lens produces both; their absence is a forensic red flag)
 *   7. Poisson-Gaussian noise — σ²(x)=a·x+b, heteroscedastic per real sensors
 *      (ML tools verify signal-dependent variance; uniform Gaussian is detectable)
 *   8. Custom JPEG encoder — camera-brand Q-tables with per-image ±2 jitter
 *      (browser canvas always emits identical Q-tables at a given quality level;
 *      forensic tools cluster images by Q-table pattern, this breaks that)
 */
function antiForensicRender(img, cam = {}) {
  const cameraType = cam.type || 'phone';
  const cameraMake = cam.make || '';
  const iso        = cam.iso  || 100;

  // 1. Proportional crop
  const minDim  = Math.min(img.naturalWidth, img.naturalHeight);
  const maxCrop = Math.max(6, Math.floor(minDim * 0.012));
  const cropT   = randInt(1, maxCrop);
  const cropB   = randInt(1, maxCrop);
  const cropL   = randInt(1, maxCrop);
  const cropR   = randInt(1, maxCrop);
  const srcX    = cropL;
  const srcY    = cropT;
  const srcW    = img.naturalWidth  - cropL - cropR;
  const srcH    = img.naturalHeight - cropT - cropB;

  if (srcW < 100 || srcH < 100) {
    const c   = document.createElement('canvas');
    c.width   = img.naturalWidth;
    c.height  = img.naturalHeight;
    const ctx = c.getContext('2d');
    ctx.drawImage(img, 0, 0);
    applyCameraColorProfile(ctx, c.width, c.height, cameraMake);
    applyISPSimulation(ctx, c.width, c.height);
    applyLensOpticalEffects(ctx, c.width, c.height, cam);
    addPixelNoise(ctx, c.width, c.height, iso, cameraType);
    const dataUrl = canvasToJpegDataUrl(ctx, c.width, c.height, cameraMake, randomJpegQuality(cameraType));
    return { dataUrl, width: c.width, height: c.height };
  }

  // 3. Random resize
  const maxEdge = randomMaxEdge();
  const size    = getExportDimensions(srcW, srcH, maxEdge);

  const c   = document.createElement('canvas');
  c.width   = size.width;
  c.height  = size.height;
  const ctx = c.getContext('2d');
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';

  // 2. Bimodal rotation: 50% small (0.5–1.0°), 50% large (1.0–2.0°), random sign
  const sign     = Math.random() < 0.5 ? 1 : -1;
  const angleDeg = sign * (Math.random() < 0.5
    ? 0.5 + Math.random() * 0.5    // 0.5–1.0°
    : 1.0 + Math.random() * 1.0);  // 1.0–2.0°
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

  ctx.drawImage(img, srcX, srcY, srcW, srcH, 0, 0, size.width, size.height);

  // 4. Camera colour science
  applyCameraColorProfile(ctx, size.width, size.height, cameraMake);

  // 5. ISP pipeline simulation (demosaicing residuals + S-curve + unsharp mask)
  applyISPSimulation(ctx, size.width, size.height);

  // 6. Lens optical effects (vignetting + chromatic aberration)
  applyLensOpticalEffects(ctx, size.width, size.height, cam);

  // 7. Poisson-Gaussian noise (signal-dependent, ISO-matched)
  addPixelNoise(ctx, size.width, size.height, iso, cameraType);

  // 8. Encode with camera-specific Q-tables (no APP0 written)
  const dataUrl = canvasToJpegDataUrl(ctx, size.width, size.height, cameraMake, randomJpegQuality(cameraType));

  return { dataUrl, width: size.width, height: size.height };
}

export function toJpeg(dataUrl, cam) {
  return new Promise((res, rej) => {
    const img   = new Image();
    img.onload  = () => res(antiForensicRender(img, cam));
    img.onerror = rej;
    img.src     = dataUrl;
  });
}

export function stripViaCanvas(dataUrl, cam) {
  return new Promise((res, rej) => {
    const img   = new Image();
    img.onload  = () => res(antiForensicRender(img, cam));
    img.onerror = rej;
    img.src     = dataUrl;
  });
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
  return `img_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
  } catch (e) {
    const area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', 'readonly');
    area.style.position = 'fixed';
    area.style.opacity  = '0';
    document.body.appendChild(area);
    area.select();
    document.execCommand('copy');
    document.body.removeChild(area);
  }
}
