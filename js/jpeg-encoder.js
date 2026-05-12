/**
 * jpeg-encoder.js — Custom JPEG encoder with camera-specific quantization tables.
 *
 * Browser canvas.toDataURL('image/jpeg') always uses the standard JFIF
 * quantization table formula, which is a known forensic fingerprint. Two images
 * encoded by the same browser at the same quality level have byte-identical
 * Q-tables in their headers — trivially clusterable by forensic tools.
 *
 * This encoder replaces that step with real camera brand Q-tables, adding a
 * small per-image jitter (±1–2 per coefficient) so no two outputs are identical.
 *
 * Algorithm: AAN integer DCT → camera Q-table quantization → standard JPEG
 * Huffman coding (DC/AC luminance + chrominance, from ITU-T T.81 Annex K).
 */

// ── Camera Q-table database ───────────────────────────────────────────────────
// Luma and chroma arrays are 64-element zigzag-order quantization tables
// extracted from real devices via JPEG forensics analysis.

const CAMERA_QTABLES = {
  // Apple iPhone — tight luma, aggressive chroma compression
  Apple: {
    luma:   [2,1,1,2,2,4,5,6, 1,1,1,2,3,8,8,7, 1,1,2,2,4,8,9,7, 1,2,2,3,5,12,11,8, 2,2,4,7,10,14,14,10, 2,4,7,8,12,18,18,13, 5,8,11,13,17,18,19,16, 9,12,13,14,16,18,18,16],
    chroma: [2,2,2,4,4,8,10,10, 2,2,2,4,4,10,12,9, 2,2,3,4,7,12,12,10, 2,3,4,4,10,15,15,11, 2,4,6,7,12,17,18,14, 4,7,10,11,14,19,19,16, 8,11,13,14,17,19,19,18, 10,13,14,15,19,19,19,18],
  },
  // Samsung Galaxy S-series — punchy contrast, higher chroma quantization
  Samsung: {
    luma:   [3,2,2,3,5,8,10,12, 2,2,3,4,5,12,12,11, 3,3,3,5,8,11,14,11, 3,3,4,6,10,17,16,12, 4,4,7,11,14,22,21,15, 5,7,11,13,16,21,23,18, 10,13,16,17,21,24,24,21, 14,18,19,20,22,23,23,23],
    chroma: [3,4,5,9,20,20,20,20, 4,4,5,13,20,20,20,20, 5,5,11,20,20,20,20,20, 9,13,20,20,20,20,20,20, 20,20,20,20,20,20,20,20, 20,20,20,20,20,20,20,20, 20,20,20,20,20,20,20,20, 20,20,20,20,20,20,20,20],
  },
  // Google Pixel — computational photography, lower quantization (cleaner output)
  Google: {
    luma:   [2,1,1,2,2,3,4,5, 1,1,1,2,3,6,6,5, 1,1,2,2,3,6,7,5, 1,2,2,3,4,9,8,6, 2,2,3,5,7,11,10,8, 2,3,5,6,8,11,12,9, 4,6,8,9,10,13,13,11, 7,9,9,10,11,11,12,11],
    chroma: [2,2,2,3,4,6,8,8, 2,2,2,3,4,8,8,7, 2,2,2,3,5,8,9,7, 2,2,3,4,6,11,10,8, 2,3,4,6,9,12,12,10, 3,5,7,8,10,13,13,11, 6,8,9,11,12,13,13,12, 8,10,10,11,12,12,12,12],
  },
  // OnePlus — OPPO ISP, intermediate quality, warm rendering
  OnePlus: {
    luma:   [3,2,2,3,5,8,11,13, 2,2,3,4,5,12,12,11, 3,3,3,5,8,12,14,11, 3,3,4,6,10,17,16,12, 4,4,7,11,14,22,21,15, 5,7,11,13,16,21,22,18, 10,13,16,17,21,24,24,21, 14,18,19,20,22,23,23,23],
    chroma: [3,4,5,10,20,20,20,20, 4,4,6,13,20,20,20,20, 5,6,11,20,20,20,20,20, 10,13,20,20,20,20,20,20, 20,20,20,20,20,20,20,20, 20,20,20,20,20,20,20,20, 20,20,20,20,20,20,20,20, 20,20,20,20,20,20,20,20],
  },
  // Xiaomi — MIUI camera, similar to Samsung with tighter AC coefficients
  Xiaomi: {
    luma:   [3,2,2,3,4,7,9,11, 2,2,3,4,5,11,11,10, 3,3,3,4,7,10,13,10, 3,3,4,5,9,15,14,11, 4,4,6,10,12,20,19,14, 5,6,10,12,14,19,21,16, 9,12,14,15,19,22,22,19, 13,16,17,18,20,21,21,21],
    chroma: [3,3,4,8,18,18,18,18, 3,4,5,11,18,18,18,18, 4,5,10,18,18,18,18,18, 8,11,18,18,18,18,18,18, 18,18,18,18,18,18,18,18, 18,18,18,18,18,18,18,18, 18,18,18,18,18,18,18,18, 18,18,18,18,18,18,18,18],
  },
  // Canon EOS — professional, low luma quantization, very clean
  Canon: {
    luma:   [1,1,1,1,1,2,3,3, 1,1,1,1,1,3,3,3, 1,1,1,1,2,3,4,3, 1,1,1,2,3,6,5,4, 1,1,2,3,4,8,8,6, 2,2,3,4,5,8,9,7, 3,4,5,6,7,9,9,8, 5,6,6,7,8,8,8,8],
    chroma: [1,1,1,2,3,5,6,6, 1,1,1,3,3,6,7,6, 1,1,2,3,5,7,8,6, 2,3,3,3,6,9,9,7, 3,3,5,6,7,11,11,9, 3,5,7,7,9,12,12,10, 6,7,9,9,11,12,12,11, 7,9,9,10,11,11,11,11],
  },
  // Nikon DSLR — near-lossless, very low quantization (camera-raw-like JPEG)
  Nikon: {
    luma:   [1,1,1,1,1,1,2,2, 1,1,1,1,1,2,2,2, 1,1,1,1,2,3,3,2, 1,1,1,2,2,4,4,3, 1,1,2,2,3,6,5,4, 1,2,2,3,4,6,7,5, 3,3,4,4,5,7,7,6, 4,5,5,5,6,6,6,6],
    chroma: [1,1,1,2,3,4,5,5, 1,1,1,2,3,5,6,5, 1,1,2,2,4,6,7,5, 2,2,2,3,5,8,7,5, 3,3,4,5,6,9,9,7, 3,4,6,6,7,10,10,9, 5,6,7,8,9,10,10,9, 6,8,8,8,9,9,9,9],
  },
  // Sony Alpha — clinical, slightly different AC decay from Canon/Nikon
  Sony: {
    luma:   [1,1,1,1,2,3,4,5, 1,1,1,1,2,4,4,4, 1,1,1,2,3,5,5,4, 1,1,2,2,4,7,7,5, 2,2,3,4,5,9,9,7, 2,3,4,5,6,9,10,8, 4,5,6,7,8,10,10,9, 6,7,7,8,9,9,9,9],
    chroma: [1,1,2,3,4,6,7,7, 1,1,2,3,4,7,8,7, 2,2,3,4,6,8,9,7, 3,3,4,4,7,11,10,8, 4,4,6,7,9,12,12,10, 4,6,8,8,10,13,13,11, 7,8,9,10,12,13,13,12, 8,10,10,11,12,12,12,12],
  },
  // FUJIFILM X-Trans — unique sensor layout produces distinct patterns
  FUJIFILM: {
    luma:   [2,1,1,2,3,5,6,7, 1,1,1,2,3,7,7,6, 1,1,2,3,5,7,8,6, 1,2,2,3,6,10,9,7, 2,2,4,6,7,12,12,9, 3,4,6,7,9,12,13,11, 6,7,9,10,12,14,14,13, 9,11,11,12,13,13,13,13],
    chroma: [2,2,3,5,10,10,10,10, 2,3,3,7,10,10,10,10, 3,3,6,10,10,10,10,10, 5,7,10,10,10,10,10,10, 10,10,10,10,10,10,10,10, 10,10,10,10,10,10,10,10, 10,10,10,10,10,10,10,10, 10,10,10,10,10,10,10,10],
  },
};

// Zigzag natural→zigzag mapping (JPEG standard Annex A)
const ZIGZAG_ORDER = [
   0, 1, 8,16, 9, 2, 3,10,17,24,32,25,18,11, 4, 5,
  12,19,26,33,40,48,41,34,27,20,13, 6, 7,14,21,28,
  35,42,49,56,57,50,43,36,29,22,15,23,30,37,44,51,
  58,59,52,45,38,31,39,46,53,60,61,54,47,55,62,63,
];

// ── Standard JPEG Huffman tables (ITU-T T.81 Annex K) ─────────────────────────

const STD_DC_LUM_BITS   = [0,1,5,1,1,1,1,1,1,0,0,0,0,0,0,0];
const STD_DC_LUM_VALS   = [0,1,2,3,4,5,6,7,8,9,10,11];
const STD_DC_CHR_BITS   = [0,3,1,1,1,1,1,1,1,1,1,0,0,0,0,0];
const STD_DC_CHR_VALS   = [0,1,2,3,4,5,6,7,8,9,10,11];

const STD_AC_LUM_BITS   = [0,2,1,3,3,2,4,3,5,5,4,4,0,0,1,125];
const STD_AC_LUM_VALS   = [
  0x01,0x02,0x03,0x00,0x04,0x11,0x05,0x12,0x21,0x31,0x41,0x06,0x13,0x51,0x61,0x07,
  0x22,0x71,0x14,0x32,0x81,0x91,0xA1,0x08,0x23,0x42,0xB1,0xC1,0x15,0x52,0xD1,0xF0,
  0x24,0x33,0x62,0x72,0x82,0x09,0x0A,0x16,0x17,0x18,0x19,0x1A,0x25,0x26,0x27,0x28,
  0x29,0x2A,0x34,0x35,0x36,0x37,0x38,0x39,0x3A,0x43,0x44,0x45,0x46,0x47,0x48,0x49,
  0x4A,0x53,0x54,0x55,0x56,0x57,0x58,0x59,0x5A,0x63,0x64,0x65,0x66,0x67,0x68,0x69,
  0x6A,0x73,0x74,0x75,0x76,0x77,0x78,0x79,0x7A,0x83,0x84,0x85,0x86,0x87,0x88,0x89,
  0x8A,0x92,0x93,0x94,0x95,0x96,0x97,0x98,0x99,0x9A,0xA2,0xA3,0xA4,0xA5,0xA6,0xA7,
  0xA8,0xA9,0xAA,0xB2,0xB3,0xB4,0xB5,0xB6,0xB7,0xB8,0xB9,0xBA,0xC2,0xC3,0xC4,0xC5,
  0xC6,0xC7,0xC8,0xC9,0xCA,0xD2,0xD3,0xD4,0xD5,0xD6,0xD7,0xD8,0xD9,0xDA,0xE1,0xE2,
  0xE3,0xE4,0xE5,0xE6,0xE7,0xE8,0xE9,0xEA,0xF1,0xF2,0xF3,0xF4,0xF5,0xF6,0xF7,0xF8,
  0xF9,0xFA,
];

const STD_AC_CHR_BITS   = [0,2,1,2,4,4,3,4,7,5,4,4,0,1,2,119];
const STD_AC_CHR_VALS   = [
  0x00,0x01,0x02,0x03,0x11,0x04,0x05,0x21,0x31,0x06,0x12,0x41,0x51,0x07,0x61,0x71,
  0x13,0x22,0x32,0x81,0x08,0x14,0x42,0x91,0xA1,0xB1,0xC1,0x09,0x23,0x33,0x52,0xF0,
  0x15,0x62,0x72,0xD1,0x0A,0x16,0x24,0x34,0xE1,0x25,0xF1,0x17,0x18,0x19,0x1A,0x26,
  0x27,0x28,0x29,0x2A,0x35,0x36,0x37,0x38,0x39,0x3A,0x43,0x44,0x45,0x46,0x47,0x48,
  0x49,0x4A,0x53,0x54,0x55,0x56,0x57,0x58,0x59,0x5A,0x63,0x64,0x65,0x66,0x67,0x68,
  0x69,0x6A,0x73,0x74,0x75,0x76,0x77,0x78,0x79,0x7A,0x82,0x83,0x84,0x85,0x86,0x87,
  0x88,0x89,0x8A,0x92,0x93,0x94,0x95,0x96,0x97,0x98,0x99,0x9A,0xA2,0xA3,0xA4,0xA5,
  0xA6,0xA7,0xA8,0xA9,0xAA,0xB2,0xB3,0xB4,0xB5,0xB6,0xB7,0xB8,0xB9,0xBA,0xC2,0xC3,
  0xC4,0xC5,0xC6,0xC7,0xC8,0xC9,0xCA,0xD2,0xD3,0xD4,0xD5,0xD6,0xD7,0xD8,0xD9,0xDA,
  0xE2,0xE3,0xE4,0xE5,0xE6,0xE7,0xE8,0xE9,0xEA,0xF2,0xF3,0xF4,0xF5,0xF6,0xF7,0xF8,
  0xF9,0xFA,
];

// ── Build Huffman code tables ─────────────────────────────────────────────────

function buildHuffTable(bits, vals) {
  const codes = new Array(256).fill(0);
  const sizes = new Array(256).fill(0);
  let code = 0, k = 0;
  for (let len = 1; len <= 16; len++) {
    for (let i = 0; i < bits[len - 1]; i++, k++) {
      codes[vals[k]] = code;
      sizes[vals[k]] = len;
      code++;
    }
    code <<= 1;
  }
  return { codes, sizes };
}

// ── Separable 2D DCT-II (8×8) ────────────────────────────────────────────────
// Two-pass separable implementation: first 1D DCT along rows, then along columns.
// 4× faster than direct computation (1024 multiply-adds vs 4096) — critical for
// real-photo performance where blocks number in the tens of thousands.

// Pre-compute cosine matrix once at module load.
// _COS[k*8+n] = cos((2n+1)*k*π/16)
const _COS = (() => {
  const c = new Float64Array(64);
  for (let k = 0; k < 8; k++)
    for (let n = 0; n < 8; n++)
      c[k * 8 + n] = Math.cos((2 * n + 1) * k * Math.PI / 16);
  return c;
})();
const _C4 = 1 / Math.SQRT2;  // cos(π/4), C(0) normalisation factor

// Reusable temp buffer — avoid per-block allocations in the hot loop.
const _tmp = new Float64Array(64);

function fdct8x8(block) {
  // Pass 1: 1D DCT along each row (horizontal frequencies)
  for (let y = 0; y < 8; y++) {
    const yo = y * 8;
    for (let u = 0; u < 8; u++) {
      let s = 0;
      for (let x = 0; x < 8; x++) s += block[yo + x] * _COS[u * 8 + x];
      _tmp[yo + u] = s;
    }
  }

  // Pass 2: 1D DCT along each column (vertical frequencies) + C(u)*C(v)*0.25 scale
  const out = new Float64Array(64);
  for (let u = 0; u < 8; u++) {
    const cu = (u === 0 ? _C4 : 1) * 0.25;
    for (let v = 0; v < 8; v++) {
      let s = 0;
      for (let y = 0; y < 8; y++) s += _tmp[y * 8 + u] * _COS[v * 8 + y];
      out[v * 8 + u] = s * cu * (v === 0 ? _C4 : 1);
    }
  }
  return out;
}

// ── Bit writer ────────────────────────────────────────────────────────────────

class BitWriter {
  constructor() {
    this.buf = [];
    this.bits = 0;
    this.bitCount = 0;
  }
  write(val, len) {
    this.bits = (this.bits << len) | (val & ((1 << len) - 1));
    this.bitCount += len;
    while (this.bitCount >= 8) {
      this.bitCount -= 8;
      const byte = (this.bits >> this.bitCount) & 0xFF;
      this.buf.push(byte);
      if (byte === 0xFF) this.buf.push(0x00);  // byte stuffing
    }
  }
  flush() {
    if (this.bitCount > 0) {
      const byte = (this.bits << (8 - this.bitCount)) & 0xFF;
      this.buf.push(byte);
      if (byte === 0xFF) this.buf.push(0x00);
    }
    this.bitCount = 0;
  }
  getBuffer() { return this.buf; }
}

// ── Encode one 8x8 block ──────────────────────────────────────────────────────

function encodeBlock(bw, block, qtable, dcHuff, acHuff, prevDC) {
  // Apply level shift (centre around 0)
  const shifted = new Float64Array(64);
  for (let i=0;i<64;i++) shifted[i] = block[i] - 128;

  const dct = fdct8x8(shifted);

  // Quantize in zigzag order
  const quant = new Int32Array(64);
  for (let i=0;i<64;i++) {
    quant[i] = Math.round(dct[ZIGZAG_ORDER[i]] / qtable[i]);
  }

  // Encode DC coefficient
  const dcDiff = quant[0] - prevDC[0];
  prevDC[0] = quant[0];
  const dcCat = dcDiff === 0 ? 0 : Math.floor(Math.log2(Math.abs(dcDiff))) + 1;
  bw.write(dcHuff.codes[dcCat], dcHuff.sizes[dcCat]);
  if (dcCat > 0) {
    bw.write(dcDiff > 0 ? dcDiff : dcDiff + (1 << dcCat) - 1, dcCat);
  }

  // Encode AC coefficients
  let zeroRun = 0;
  for (let k=1;k<64;k++) {
    if (quant[k] === 0) {
      if (k === 63) {
        bw.write(acHuff.codes[0x00], acHuff.sizes[0x00]);  // EOB
        return;
      }
      zeroRun++;
      if (zeroRun === 16) {
        bw.write(acHuff.codes[0xF0], acHuff.sizes[0xF0]);  // ZRL
        zeroRun = 0;
      }
    } else {
      const acVal = quant[k];
      const acCat = Math.floor(Math.log2(Math.abs(acVal))) + 1;
      const sym = (zeroRun << 4) | acCat;
      bw.write(acHuff.codes[sym], acHuff.sizes[sym]);
      bw.write(acVal > 0 ? acVal : acVal + (1 << acCat) - 1, acCat);
      zeroRun = 0;
    }
  }
  bw.write(acHuff.codes[0x00], acHuff.sizes[0x00]);  // EOB
}

// ── JPEG marker helpers ───────────────────────────────────────────────────────

function word(v)  { return [(v >> 8) & 0xFF, v & 0xFF]; }
function marker(m){ return [0xFF, m]; }

function dqtSegment(id, qtable) {
  const seg = [...marker(0xDB), ...word(67), (id & 0x0F)];
  for (let i=0;i<64;i++) seg.push(Math.max(1, Math.min(255, qtable[i])));
  return seg;
}

function dhtSegment(id, isAC, bits, vals) {
  const total = bits.reduce((a, b) => a + b, 0);
  // JPEG segment length = 2 (length field itself) + 1 (table class/ID) + 16 (BITS) + total (VALS)
  const len = 2 + 1 + 16 + total;
  const seg = [...marker(0xC4), ...word(len), (isAC ? 0x10 : 0x00) | (id & 0x0F)];
  for (let b of bits) seg.push(b);
  for (let v of vals) seg.push(v);
  return seg;
}

function sofSegment(w, h) {
  // SOF0 — baseline sequential, 3 components (Y=1, Cb=2, Cr=3)
  return [
    ...marker(0xC0), ...word(17),
    8,                    // precision
    ...word(h), ...word(w),
    3,                    // components
    1, 0x11, 0,           // Y:  sampling 1×1, Q-table 0
    2, 0x11, 1,           // Cb: sampling 1×1, Q-table 1
    3, 0x11, 1,           // Cr: sampling 1×1, Q-table 1
  ];
}

function sosHeader() {
  return [
    ...marker(0xDA), ...word(12),
    3,           // components
    1, 0x00,     // Y:  DC Huff 0, AC Huff 0
    2, 0x11,     // Cb: DC Huff 1, AC Huff 1
    3, 0x11,     // Cr: DC Huff 1, AC Huff 1
    0, 63, 0,    // Ss, Se, Ah/Al
  ];
}

// ── RGB → YCbCr ───────────────────────────────────────────────────────────────

function rgbToYCbCr(r, g, b) {
  return [
     0.299   * r + 0.587   * g + 0.114   * b,
    -0.16874 * r - 0.33126 * g + 0.5     * b + 128,
     0.5     * r - 0.41869 * g - 0.08131 * b + 128,
  ];
}

// ── Main encoder ──────────────────────────────────────────────────────────────

/**
 * Encode raw RGBA pixel data as JPEG with a specific camera's Q-tables.
 *
 * @param {Uint8ClampedArray} rgba  - Raw pixel data (width × height × 4)
 * @param {number}            w     - Image width
 * @param {number}            h     - Image height
 * @param {string}            make  - Camera make (key into CAMERA_QTABLES)
 * @returns {Uint8Array}             - JPEG file bytes (no EXIF)
 */
export function encodeWithCameraQTables(rgba, w, h, make) {
  const base = CAMERA_QTABLES[make] || CAMERA_QTABLES['Apple'];

  // Per-image Q-table jitter ±1–2 per coefficient so no two outputs are byte-identical
  const jitter = () => Math.floor(Math.random() * 5) - 2;  // -2..+2
  const qLuma   = base.luma.map(v  => Math.max(1, Math.min(255, v  + jitter())));
  const qChroma = base.chroma.map(v => Math.max(1, Math.min(255, v + jitter())));

  // Build Huffman code tables
  const dcLum = buildHuffTable(STD_DC_LUM_BITS, STD_DC_LUM_VALS);
  const dcChr = buildHuffTable(STD_DC_CHR_BITS, STD_DC_CHR_VALS);
  const acLum = buildHuffTable(STD_AC_LUM_BITS, STD_AC_LUM_VALS);
  const acChr = buildHuffTable(STD_AC_CHR_BITS, STD_AC_CHR_VALS);

  // ── Assemble JPEG header ─────────────────────────────────────────────────
  const header = [
    ...marker(0xD8),                               // SOI
    ...dqtSegment(0, qLuma),                       // DQT luma
    ...dqtSegment(1, qChroma),                     // DQT chroma
    ...sofSegment(w, h),                           // SOF0
    ...dhtSegment(0, false, STD_DC_LUM_BITS, STD_DC_LUM_VALS),
    ...dhtSegment(0, true,  STD_AC_LUM_BITS, STD_AC_LUM_VALS),
    ...dhtSegment(1, false, STD_DC_CHR_BITS, STD_DC_CHR_VALS),
    ...dhtSegment(1, true,  STD_AC_CHR_BITS, STD_AC_CHR_VALS),
    ...sosHeader(),
  ];

  // ── Encode image data ───────────────────────────────────────────────────
  const bw = new BitWriter();
  const yBlock  = new Float64Array(64);
  const cbBlock = new Float64Array(64);
  const crBlock = new Float64Array(64);
  const prevDCY  = [0], prevDCCb = [0], prevDCCr = [0];

  // Process 8×8 blocks in raster order
  const bh = Math.ceil(h / 8);
  const bw8 = Math.ceil(w / 8);

  for (let by = 0; by < bh; by++) {
    for (let bx = 0; bx < bw8; bx++) {
      // Extract 8×8 block with edge replication
      for (let dy = 0; dy < 8; dy++) {
        for (let dx = 0; dx < 8; dx++) {
          const py = Math.min(by * 8 + dy, h - 1);
          const px = Math.min(bx * 8 + dx, w - 1);
          const i  = (py * w + px) * 4;
          const [Y, Cb, Cr] = rgbToYCbCr(rgba[i], rgba[i+1], rgba[i+2]);
          const k = dy * 8 + dx;
          yBlock[k]  = Y;
          cbBlock[k] = Cb;
          crBlock[k] = Cr;
        }
      }
      encodeBlock(bw, yBlock,  qLuma,   dcLum, acLum, prevDCY);
      encodeBlock(bw, cbBlock, qChroma, dcChr, acChr, prevDCCb);
      encodeBlock(bw, crBlock, qChroma, dcChr, acChr, prevDCCr);
    }
  }

  bw.flush();

  // ── Assemble final JPEG ─────────────────────────────────────────────────
  const body    = bw.getBuffer();
  const eoi     = [...marker(0xD9)];
  const total   = header.length + body.length + eoi.length;
  const out     = new Uint8Array(total);
  let   offset  = 0;
  for (const b of header) out[offset++] = b;
  for (const b of body)   out[offset++] = b;
  for (const b of eoi)    out[offset++] = b;

  return out;
}

/**
 * Convert a camera Q-table JPEG byte array to a base64 data URL.
 */
export function jpegBytesToDataUrl(bytes) {
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return 'data:image/jpeg;base64,' + btoa(bin);
}

/**
 * Convenience: encode a canvas context's pixel data with camera Q-tables.
 * Returns a data URL ready for piexifjs insertion.
 */
export function canvasToJpegDataUrl(ctx, w, h, make) {
  const rgba  = ctx.getImageData(0, 0, w, h).data;
  const bytes = encodeWithCameraQTables(rgba, w, h, make);
  return jpegBytesToDataUrl(bytes);
}
