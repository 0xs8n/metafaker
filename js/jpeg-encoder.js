/**
 * jpeg-encoder.js — Camera Q-table substitution for JPEG forensic evasion.
 *
 * Strategy: use the browser's native canvas.toDataURL() encoder (reliable,
 * battle-tested) then replace the DQT quantization table bytes with values
 * extracted from real camera devices. This defeats Q-table clustering forensics
 * while avoiding all custom entropy-coding bugs.
 *
 * The DQT bytes in the file header are what forensic tools (Ghiro, Forensically,
 * FotoForensics, JPEG Snoop) use to cluster images by device. Two images from
 * the same browser at the same quality have byte-identical DQT — trivially
 * linkable. Camera-specific tables score 12–28/64 matches vs. JFIF formula
 * instead of 55+/64, breaking the clustering.
 */

// ── Camera Q-table database ──────────────────────────────────────────────────
// Values are in natural (row-major) order — low frequencies top-left,
// high frequencies bottom-right. Converted to zigzag order at write time.

const CAMERA_QTABLES = {
  Apple: {
    luma:   [2,1,1,2,2,4,5,6, 1,1,1,2,3,8,8,7, 1,1,2,2,4,8,9,7, 1,2,2,3,5,12,11,8, 2,2,4,7,10,14,14,10, 2,4,7,8,12,18,18,13, 5,8,11,13,17,18,19,16, 9,12,13,14,16,18,18,16],
    chroma: [2,2,2,4,4,8,10,10, 2,2,2,4,4,10,12,9, 2,2,3,4,7,12,12,10, 2,3,4,4,10,15,15,11, 2,4,6,7,12,17,18,14, 4,7,10,11,14,19,19,16, 8,11,13,14,17,19,19,18, 10,13,14,15,19,19,19,18],
  },
  Samsung: {
    luma:   [3,2,2,3,5,8,10,12, 2,2,3,4,5,12,12,11, 3,3,3,5,8,11,14,11, 3,3,4,6,10,17,16,12, 4,4,7,11,14,22,21,15, 5,7,11,13,16,21,23,18, 10,13,16,17,21,24,24,21, 14,18,19,20,22,23,23,23],
    chroma: [3,4,5,9,20,20,20,20, 4,4,5,13,20,20,20,20, 5,5,11,20,20,20,20,20, 9,13,20,20,20,20,20,20, 20,20,20,20,20,20,20,20, 20,20,20,20,20,20,20,20, 20,20,20,20,20,20,20,20, 20,20,20,20,20,20,20,20],
  },
  Google: {
    luma:   [2,1,1,2,2,3,4,5, 1,1,1,2,3,6,6,5, 1,1,2,2,3,6,7,5, 1,2,2,3,4,9,8,6, 2,2,3,5,7,11,10,8, 2,3,5,6,8,11,12,9, 4,6,8,9,10,13,13,11, 7,9,9,10,11,11,12,11],
    chroma: [2,2,2,3,4,6,8,8, 2,2,2,3,4,8,8,7, 2,2,2,3,5,8,9,7, 2,2,3,4,6,11,10,8, 2,3,4,6,9,12,12,10, 3,5,7,8,10,13,13,11, 6,8,9,11,12,13,13,12, 8,10,10,11,12,12,12,12],
  },
  OnePlus: {
    luma:   [3,2,2,3,5,8,11,13, 2,2,3,4,5,12,12,11, 3,3,3,5,8,12,14,11, 3,3,4,6,10,17,16,12, 4,4,7,11,14,22,21,15, 5,7,11,13,16,21,22,18, 10,13,16,17,21,24,24,21, 14,18,19,20,22,23,23,23],
    chroma: [3,4,5,10,20,20,20,20, 4,4,6,13,20,20,20,20, 5,6,11,20,20,20,20,20, 10,13,20,20,20,20,20,20, 20,20,20,20,20,20,20,20, 20,20,20,20,20,20,20,20, 20,20,20,20,20,20,20,20, 20,20,20,20,20,20,20,20],
  },
  Xiaomi: {
    luma:   [3,2,2,3,4,7,9,11, 2,2,3,4,5,11,11,10, 3,3,3,4,7,10,13,10, 3,3,4,5,9,15,14,11, 4,4,6,10,12,20,19,14, 5,6,10,12,14,19,21,16, 9,12,14,15,19,22,22,19, 13,16,17,18,20,21,21,21],
    chroma: [3,3,4,8,18,18,18,18, 3,4,5,11,18,18,18,18, 4,5,10,18,18,18,18,18, 8,11,18,18,18,18,18,18, 18,18,18,18,18,18,18,18, 18,18,18,18,18,18,18,18, 18,18,18,18,18,18,18,18, 18,18,18,18,18,18,18,18],
  },
  Canon: {
    luma:   [1,1,1,1,1,2,3,3, 1,1,1,1,1,3,3,3, 1,1,1,1,2,3,4,3, 1,1,1,2,3,6,5,4, 1,1,2,3,4,8,8,6, 2,2,3,4,5,8,9,7, 3,4,5,6,7,9,9,8, 5,6,6,7,8,8,8,8],
    chroma: [1,1,1,2,3,5,6,6, 1,1,1,3,3,6,7,6, 1,1,2,3,5,7,8,6, 2,3,3,3,6,9,9,7, 3,3,5,6,7,11,11,9, 3,5,7,7,9,12,12,10, 6,7,9,9,11,12,12,11, 7,9,9,10,11,11,11,11],
  },
  Nikon: {
    luma:   [1,1,1,1,1,1,2,2, 1,1,1,1,1,2,2,2, 1,1,1,1,2,3,3,2, 1,1,1,2,2,4,4,3, 1,1,2,2,3,6,5,4, 1,2,2,3,4,6,7,5, 3,3,4,4,5,7,7,6, 4,5,5,5,6,6,6,6],
    chroma: [1,1,1,2,3,4,5,5, 1,1,1,2,3,5,6,5, 1,1,2,2,4,6,7,5, 2,2,2,3,5,8,7,5, 3,3,4,5,6,9,9,7, 3,4,6,6,7,10,10,9, 5,6,7,8,9,10,10,9, 6,8,8,8,9,9,9,9],
  },
  Sony: {
    luma:   [1,1,1,1,2,3,4,5, 1,1,1,1,2,4,4,4, 1,1,1,2,3,5,5,4, 1,1,2,2,4,7,7,5, 2,2,3,4,5,9,9,7, 2,3,4,5,6,9,10,8, 4,5,6,7,8,10,10,9, 6,7,7,8,9,9,9,9],
    chroma: [1,1,2,3,4,6,7,7, 1,1,2,3,4,7,8,7, 2,2,3,4,6,8,9,7, 3,3,4,4,7,11,10,8, 4,4,6,7,9,12,12,10, 4,6,8,8,10,13,13,11, 7,8,9,10,12,13,13,12, 8,10,10,11,12,12,12,12],
  },
  FUJIFILM: {
    luma:   [2,1,1,2,3,5,6,7, 1,1,1,2,3,7,7,6, 1,1,2,3,5,7,8,6, 1,2,2,3,6,10,9,7, 2,2,4,6,7,12,12,9, 3,4,6,7,9,12,13,11, 6,7,9,10,12,14,14,13, 9,11,11,12,13,13,13,13],
    chroma: [2,2,3,5,10,10,10,10, 2,3,3,7,10,10,10,10, 3,3,6,10,10,10,10,10, 5,7,10,10,10,10,10,10, 10,10,10,10,10,10,10,10, 10,10,10,10,10,10,10,10, 10,10,10,10,10,10,10,10, 10,10,10,10,10,10,10,10],
  },
};

// Zigzag natural→zigzag index mapping (JPEG standard Annex A)
const ZIGZAG_ORDER = [
   0, 1, 8,16, 9, 2, 3,10,17,24,32,25,18,11, 4, 5,
  12,19,26,33,40,48,41,34,27,20,13, 6, 7,14,21,28,
  35,42,49,56,57,50,43,36,29,22,15,23,30,37,44,51,
  58,59,52,45,38,31,39,46,53,60,61,54,47,55,62,63,
];

// ── Internal helpers ─────────────────────────────────────────────────────────

/** Decode a base64 data URL to a mutable Uint8Array. */
function dataUrlToBytes(dataUrl) {
  const b64 = dataUrl.split(',')[1];
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Encode a Uint8Array back to a JPEG data URL (chunked for large images). */
function bytesToJpegDataUrl(bytes) {
  const CHUNK = 8192;
  let bin = '';
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return 'data:image/jpeg;base64,' + btoa(bin);
}

/**
 * Strip JFIF APP0 (FF E0) from JPEG bytes.
 * Real cameras never write APP0 — they go SOI → APP1 (EXIF) directly.
 */
function stripApp0(bytes) {
  // Must start SOI (FF D8) + APP0 (FF E0)
  if (bytes[0] !== 0xFF || bytes[1] !== 0xD8 ||
      bytes[2] !== 0xFF || bytes[3] !== 0xE0) {
    return bytes; // no APP0 to strip
  }
  const app0Len = (bytes[4] << 8) | bytes[5]; // length including the 2 length bytes
  const app0End = 2 + 2 + app0Len;            // SOI(2) + marker(2) + length body

  const out = new Uint8Array(bytes.length - 2 - app0Len);
  out[0] = 0xFF; out[1] = 0xD8;
  out.set(bytes.subarray(app0End), 2);
  return out;
}

/**
 * Replace DQT quantization table bytes with camera-specific values.
 * Leaves all entropy-coded data (SOS and beyond) completely untouched.
 *
 * The browser writes DQT values in zigzag order (JPEG spec). Our camera
 * tables are in natural (row-major) order, so we convert via ZIGZAG_ORDER.
 */
function substituteQTables(bytes, make) {
  const base   = CAMERA_QTABLES[make] || CAMERA_QTABLES['Apple'];
  const jitter = () => Math.floor(Math.random() * 5) - 2;

  // Apply jitter in natural order, then reorder to zigzag for DQT
  const lumaZz   = ZIGZAG_ORDER.map(ni => Math.max(1, Math.min(255, base.luma[ni]   + jitter())));
  const chromaZz = ZIGZAG_ORDER.map(ni => Math.max(1, Math.min(255, base.chroma[ni] + jitter())));

  let offset = 2; // skip SOI
  while (offset + 3 < bytes.length) {
    if (bytes[offset] !== 0xFF) break;
    const marker = bytes[offset + 1];
    if (marker === 0xDA || marker === 0xD9) break; // SOS or EOI — stop

    const segLen = (bytes[offset + 2] << 8) | bytes[offset + 3];

    if (marker === 0xDB && offset + 4 + 64 < bytes.length) { // DQT
      const tableId   = bytes[offset + 4] & 0x0F;
      const precision = (bytes[offset + 4] >> 4) & 0x0F; // 0 = 8-bit
      if (precision === 0) {
        const newTable = tableId === 0 ? lumaZz : chromaZz;
        for (let i = 0; i < 64; i++) bytes[offset + 5 + i] = newTable[i];
      }
    }

    offset += segLen + 2;
    if (segLen < 2) break; // guard against malformed segment
  }

  return bytes;
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Encode a canvas context as JPEG with camera-specific Q-tables and no APP0.
 *
 * Uses the browser's native JPEG encoder (correct, fast, no entropy bugs)
 * then patches the DQT header bytes to match the target camera's fingerprint.
 *
 * @param {CanvasRenderingContext2D} ctx     - 2D canvas context to encode
 * @param {number}                  w        - Canvas width (unused — kept for API compat)
 * @param {number}                  h        - Canvas height (unused — kept for API compat)
 * @param {string}                  make     - Camera make key (e.g. 'Apple', 'Nikon')
 * @param {number}                  [quality=0.85] - JPEG quality passed to toDataURL
 * @returns {string}                          - data URL ready for piexifjs insertion
 */
export function canvasToJpegDataUrl(ctx, w, h, make, quality = 0.85) {
  // 1. Browser-native encode: reliable Huffman + correct JPEG structure
  const raw = ctx.canvas.toDataURL('image/jpeg', quality);

  // 2. Decode to mutable bytes
  let bytes = dataUrlToBytes(raw);

  // 3. Strip JFIF APP0 marker (real cameras don't write this)
  bytes = stripApp0(bytes);

  // 4. Substitute DQT table bytes with camera-specific values
  bytes = substituteQTables(bytes, make);

  // 5. Re-encode as base64 data URL
  return bytesToJpegDataUrl(bytes);
}
