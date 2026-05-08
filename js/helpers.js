/**
 * helpers.js — Pure utility functions used across the app.
 */

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

// ── Gaussian noise (Box-Muller) ──────────────────────────────────
function gaussianNoise(sigma) {
  const u1 = Math.max(Math.random(), 1e-10);
  const u2 = Math.random();
  return sigma * Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

/**
 * Add ISO-matched, camera-type-aware Gaussian noise to every pixel.
 *
 * Phones: colour noise — channels partially independent with a chroma
 * component, simulating small-sensor CMOS colour noise.
 * DSLRs: luminance-dominant — R/G/B tightly correlated, simulating
 * large-sensor shot noise.
 *
 * Sigma is derived from the fake camera's ISO so images "from different
 * cameras" have genuinely different noise floors.
 */
export function addPixelNoise(ctx, w, h, iso = 100, cameraType = 'phone') {
  let sigma;
  if (iso <= 200)       sigma = 0.8  + Math.random() * 0.4;   // 0.8–1.2
  else if (iso <= 1600) sigma = 1.5  + Math.random() * 1.0;   // 1.5–2.5
  else                  sigma = 3.0  + Math.random() * 2.5;   // 3.0–5.5

  const id = ctx.getImageData(0, 0, w, h);
  const d  = id.data;

  for (let i = 0; i < d.length; i += 4) {
    if (cameraType === 'phone') {
      const chroma = gaussianNoise(sigma * 0.5);
      d[i]     = clamp(d[i]     + Math.round(gaussianNoise(sigma)       + chroma), 0, 255);
      d[i + 1] = clamp(d[i + 1] + Math.round(gaussianNoise(sigma * 0.7)),          0, 255);
      d[i + 2] = clamp(d[i + 2] + Math.round(gaussianNoise(sigma)       - chroma), 0, 255);
    } else {
      const luma   = gaussianNoise(sigma);
      const chroma = gaussianNoise(sigma * 0.25);
      d[i]     = clamp(d[i]     + Math.round(luma + chroma), 0, 255);
      d[i + 1] = clamp(d[i + 1] + Math.round(luma),          0, 255);
      d[i + 2] = clamp(d[i + 2] + Math.round(luma - chroma), 0, 255);
    }
  }

  ctx.putImageData(id, 0, 0);
}

// ── Camera colour science ────────────────────────────────────────

const CAMERA_COLOR_PROFILES = {
  'Apple':    { warmth:  8, satScale: 1.05, contrast: 1.02 },
  'Samsung':  { warmth:  3, satScale: 1.18, contrast: 1.08 },
  'Google':   { warmth: -6, satScale: 1.08, contrast: 1.04 },
  'OnePlus':  { warmth:  2, satScale: 1.12, contrast: 1.05 },
  'Xiaomi':   { warmth:  4, satScale: 1.15, contrast: 1.06 },
  'Canon':    { warmth: 12, satScale: 1.10, contrast: 1.03 },
  'Nikon':    { warmth:  0, satScale: 1.00, contrast: 1.00 },
  'Sony':     { warmth: -8, satScale: 0.97, contrast: 1.01 },
  'FUJIFILM': { warmth:  5, satScale: 1.06, contrast: 1.12 },
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

  const warmth   = base.warmth   + (Math.random() - 0.5) * 4;
  const satScale = base.satScale + (Math.random() - 0.5) * 0.06;
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
 * Seven layers defeat device-correlation forensics:
 *   1. Proportional crop (≤1.2% per edge) — shifts PRNU grid alignment
 *   2. Bimodal rotation (±0.5°–2.0°) — forces sub-pixel interpolation on every
 *      pixel; sufficient to drop PRNU correlation to noise levels
 *   3. Random resize — prevents dimension-based clustering
 *   4. Camera colour science — brand-specific tone/saturation/contrast
 *   5. ISO-matched Gaussian noise — noise floor matches the fake camera's ISO
 *   6. Strip APP0 — removes JFIF browser-version signature
 *   7. Bimodal JPEG quality — wider range = more quantization table diversity
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
    let dataUrl = c.toDataURL('image/jpeg', randomJpegQuality(cameraType));
    dataUrl = stripApp0(dataUrl);
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
  // For portrait images the binding constraint is the x-axis:
  //   s ≥ cos(θ) + (H/W)·sin(θ)
  // For landscape images it's the y-axis:
  //   s ≥ cos(θ) + sin(θ)/(H/W)
  // Using just 1/cos(θ) only works for squares and badly underestimates for
  // portrait/landscape content, leaving visible black bars on the edges.
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

  // 5. ISO-matched Gaussian noise
  addPixelNoise(ctx, size.width, size.height, iso, cameraType);

  // 6+7. Encode, strip APP0
  let dataUrl = c.toDataURL('image/jpeg', randomJpegQuality(cameraType));
  dataUrl = stripApp0(dataUrl);

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
