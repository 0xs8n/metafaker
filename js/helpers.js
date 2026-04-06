/**
 * helpers.js — Pure utility functions used across the app.
 *
 * Contains random selection, math, date formatting, GPS conversion,
 * canvas/image processing, clipboard, and other general-purpose helpers.
 * No EXIF-specific logic or UI code belongs here.
 */

// ── Random & Math ────────────────────────────────────────────────

/** Pick a random element from an array. */
export const pick = a => a[Math.floor(Math.random() * a.length)];

/** Random integer between lo and hi (inclusive). */
export const randInt = (lo, hi) => Math.floor(Math.random() * (hi - lo + 1)) + lo;

/** Clamp a number between lo and hi. */
export const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

// ── GPS Boundaries ───────────────────────────────────────────────

/** Bounding box for valid US GPS coordinates (includes Alaska & Hawaii). */
export const US_GPS_BOUNDS = {
  minLat: 18.8,
  maxLat: 71.5,
  minLon: -171.0,
  maxLon: -66.0,
};

/**
 * Jitter a base US city location by ~0.3° in each direction.
 * Keeps points near a real city while avoiding fixed city-center coords.
 * Returns conventional signed coords: north positive, west negative.
 */
export function jitterUsLocation(base) {
  const lat = base.lat + (Math.random() - 0.5) * 0.6;
  const lon = base.lon + (Math.random() - 0.5) * 0.6;
  return {
    city: base.city,
    lat: Number(clamp(Math.abs(lat), US_GPS_BOUNDS.minLat, US_GPS_BOUNDS.maxLat).toFixed(6)),
    lon: Number(clamp(lon, US_GPS_BOUNDS.minLon, US_GPS_BOUNDS.maxLon).toFixed(6)),
  };
}

// ── Date Formatting ──────────────────────────────────────────────

/** Format a Date as EXIF datetime string: "YYYY:MM:DD HH:MM:SS" */
export function fmtDate(d) {
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}:${p(d.getMonth() + 1)}:${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/** Format a Date as GPS date stamp (UTC): "YYYY:MM:DD" */
export function fmtGpsDate(d) {
  const p = n => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}:${p(d.getUTCMonth() + 1)}:${p(d.getUTCDate())}`;
}

/** Convert a Date to GPS timestamp rational array (UTC). */
export function gpsTimeStamp(d) {
  return [[d.getUTCHours(), 1], [d.getUTCMinutes(), 1], [d.getUTCSeconds(), 1]];
}

/** Generate a random date within the past ~2 years. */
export function randomDate() {
  const now = Date.now();
  return new Date(now - Math.random() * 730 * 864e5);
}

// ── GPS Coordinate Conversion ────────────────────────────────────

/** Convert decimal degrees to EXIF DMS rational array: [[d,1],[m,1],[s*1000,1000]] */
export function decToDMS(deg) {
  const a = Math.abs(deg);
  const d = Math.floor(a);
  const mf = (a - d) * 60;
  const m = Math.floor(mf);
  const s = Math.round((mf - m) * 60 * 1000);
  return [[d, 1], [m, 1], [s, 1000]];
}

/** Convert EXIF DMS rational array back to decimal degrees. */
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

/** Read a File as a data URL string. */
export function fileToDataUrl(file) {
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = e => res(e.target.result);
    r.onerror = rej;
    r.readAsDataURL(file);
  });
}

/** Convert a data URL string to a Blob. Handles both base64 and plain encodings. */
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
 * Randomize JPEG quality per image (0.80–0.88).
 * Varying quality prevents identical quantization tables across images,
 * which forensic tools can use to link images to the same source.
 */
export function randomJpegQuality() {
  return 0.80 + Math.random() * 0.08;
}

/**
 * Pick a random max edge length for export.
 * Varying dimensions prevents forensic detection of a fixed resize pattern.
 */
export function randomMaxEdge() {
  const edges = [2048, 2160, 2400, 2560, 2880, 3200];
  return edges[Math.floor(Math.random() * edges.length)];
}

/** Calculate export dimensions that fit within maxEdge while preserving aspect ratio. */
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

/**
 * Add ±1 random noise to each RGB channel.
 * Invisible to the eye, but breaks pixel-level correlation between
 * images processed on the same GPU/browser (canvas fingerprinting).
 */
export function addPixelNoise(ctx, w, h) {
  const imageData = ctx.getImageData(0, 0, w, h);
  const d = imageData.data;
  for (let i = 0; i < d.length; i += 4) {
    d[i]     = Math.max(0, Math.min(255, d[i]     + Math.round((Math.random() - 0.5) * 2)));
    d[i + 1] = Math.max(0, Math.min(255, d[i + 1] + Math.round((Math.random() - 0.5) * 2)));
    d[i + 2] = Math.max(0, Math.min(255, d[i + 2] + Math.round((Math.random() - 0.5) * 2)));
  }
  ctx.putImageData(imageData, 0, 0);
}

/**
 * Core anti-forensic canvas pipeline used by both toJpeg and stripViaCanvas.
 * Applies five layers of transformation to defeat forensic analysis:
 *
 *   1. Random crop (1-6px per edge) — shifts the pixel grid so PRNU sensor
 *      noise patterns no longer align between images from the same device.
 *   2. Micro-rotation (±0.3°) — forces sub-pixel interpolation on every pixel,
 *      destroying fixed-pattern noise. Imperceptible to the eye.
 *   3. Random resize — varies output dimensions to prevent size-based clustering.
 *   4. Pixel noise (±1 per RGB) — breaks canvas/GPU rendering fingerprints.
 *   5. Random JPEG quality — varies quantization tables between images.
 *
 * Returns { dataUrl, width, height }.
 */
function antiForensicRender(img) {
  // 1. Random crop: remove 1-6px from each edge
  const cropT = randInt(1, 6);
  const cropB = randInt(1, 6);
  const cropL = randInt(1, 6);
  const cropR = randInt(1, 6);
  const srcX = cropL;
  const srcY = cropT;
  const srcW = img.naturalWidth - cropL - cropR;
  const srcH = img.naturalHeight - cropT - cropB;

  // Skip if image is too small to crop safely
  if (srcW < 100 || srcH < 100) {
    const c = document.createElement('canvas');
    c.width = img.naturalWidth;
    c.height = img.naturalHeight;
    const ctx = c.getContext('2d');
    ctx.drawImage(img, 0, 0);
    return { dataUrl: c.toDataURL('image/jpeg', randomJpegQuality()), width: c.width, height: c.height };
  }

  // 3. Random resize (applied to cropped dimensions)
  const maxEdge = randomMaxEdge();
  const size = getExportDimensions(srcW, srcH, maxEdge);

  const c = document.createElement('canvas');
  c.width = size.width;
  c.height = size.height;
  const ctx = c.getContext('2d');
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';

  // 2. Micro-rotation: ±0.3° — forces interpolation on every pixel,
  //    destroying PRNU sensor noise patterns. Scale up 1% to cover
  //    tiny corner gaps left by the rotation.
  const angle = (Math.random() - 0.5) * 0.6 * (Math.PI / 180);
  ctx.translate(size.width / 2, size.height / 2);
  ctx.rotate(angle);
  ctx.scale(1.01, 1.01);
  ctx.translate(-size.width / 2, -size.height / 2);

  // Draw cropped + rotated + resized
  ctx.drawImage(img, srcX, srcY, srcW, srcH, 0, 0, size.width, size.height);

  // 4. Pixel noise
  addPixelNoise(ctx, size.width, size.height);

  // 5. Random JPEG quality
  return { dataUrl: c.toDataURL('image/jpeg', randomJpegQuality()), width: size.width, height: size.height };
}

/** Re-encode an image data URL as JPEG via the anti-forensic pipeline. */
export function toJpeg(dataUrl) {
  return new Promise((res, rej) => {
    const img = new Image();
    img.onload = () => res(antiForensicRender(img));
    img.onerror = rej;
    img.src = dataUrl;
  });
}

/**
 * Strip all metadata and apply anti-forensic transforms.
 * Returns { dataUrl, width, height } — a clean JPEG with no EXIF.
 */
export function stripViaCanvas(dataUrl) {
  return new Promise((res, rej) => {
    const img = new Image();
    img.onload = () => res(antiForensicRender(img));
    img.onerror = rej;
    img.src = dataUrl;
  });
}

// ── Display / String Utilities ───────────────────────────────────

/** Format byte count as human-readable string (B / KB / MB). */
export function fmtBytes(b) {
  if (b < 1024) return `${b} B`;
  if (b < 1048576) return `${(b / 1024).toFixed(1)} KB`;
  return `${(b / 1048576).toFixed(2)} MB`;
}

/** Extract a number from an EXIF rational pair [numerator, denominator]. */
export function fromRat(v) {
  if (!Array.isArray(v) || v.length !== 2) return null;
  const [n, d] = v;
  if (typeof n !== 'number' || typeof d !== 'number' || d === 0) return null;
  return n / d;
}

/** Strip trailing null bytes from EXIF strings. */
export function cleanExifStr(v) {
  return typeof v === 'string' ? v.replace(/\0+$/g, '') : v;
}

/** Escape HTML special characters to prevent XSS in dynamic content. */
export function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Generate a unique ID (uses crypto.randomUUID when available). */
export function makeId() {
  if (window.crypto?.randomUUID) return window.crypto.randomUUID();
  return `img_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

/** Copy text to clipboard with fallback for older browsers. */
export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
  } catch (e) {
    const area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', 'readonly');
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.appendChild(area);
    area.select();
    document.execCommand('copy');
    document.body.removeChild(area);
  }
}
