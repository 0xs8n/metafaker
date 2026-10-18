/**
 * Baseline JPEG transcoder: re-quantise an encoded JPEG onto different
 * quantization tables without touching the DCT or the colour transform.
 *
 * The browser's encoder writes its own tables, which are a fingerprint. Simply
 * overwriting the DQT bytes changes the image, because the coefficients were
 * quantised against the old table. Rescaling each coefficient by srcQ/dstQ and
 * re-encoding puts the camera's table in the file and keeps the picture.
 *
 * Coefficients in the entropy stream and entries in a DQT are both in zigzag
 * order, so the rescale is index-for-index with no reordering.
 *
 * Baseline sequential Huffman only, which is what canvas.toDataURL emits.
 * Anything else (progressive, arithmetic, restart intervals, 16-bit tables)
 * returns null so the caller can keep the original bytes.
 */

const ZIGZAG_LEN = 64;

// Annex K Huffman tables — complete over every category, so any coefficient
// the rescale produces can be encoded.
const STD_DC_LUMA_BITS   = [0,1,5,1,1,1,1,1,1,0,0,0,0,0,0,0];
const STD_DC_LUMA_VALS   = [0,1,2,3,4,5,6,7,8,9,10,11];
const STD_DC_CHROMA_BITS = [0,3,1,1,1,1,1,1,1,1,1,0,0,0,0,0];
const STD_DC_CHROMA_VALS = [0,1,2,3,4,5,6,7,8,9,10,11];
const STD_AC_LUMA_BITS   = [0,2,1,3,3,2,4,3,5,5,4,4,0,0,1,0x7d];
const STD_AC_LUMA_VALS   = [
  0x01,0x02,0x03,0x00,0x04,0x11,0x05,0x12,0x21,0x31,0x41,0x06,0x13,0x51,0x61,0x07,
  0x22,0x71,0x14,0x32,0x81,0x91,0xa1,0x08,0x23,0x42,0xb1,0xc1,0x15,0x52,0xd1,0xf0,
  0x24,0x33,0x62,0x72,0x82,0x09,0x0a,0x16,0x17,0x18,0x19,0x1a,0x25,0x26,0x27,0x28,
  0x29,0x2a,0x34,0x35,0x36,0x37,0x38,0x39,0x3a,0x43,0x44,0x45,0x46,0x47,0x48,0x49,
  0x4a,0x53,0x54,0x55,0x56,0x57,0x58,0x59,0x5a,0x63,0x64,0x65,0x66,0x67,0x68,0x69,
  0x6a,0x73,0x74,0x75,0x76,0x77,0x78,0x79,0x7a,0x83,0x84,0x85,0x86,0x87,0x88,0x89,
  0x8a,0x92,0x93,0x94,0x95,0x96,0x97,0x98,0x99,0x9a,0xa2,0xa3,0xa4,0xa5,0xa6,0xa7,
  0xa8,0xa9,0xaa,0xb2,0xb3,0xb4,0xb5,0xb6,0xb7,0xb8,0xb9,0xba,0xc2,0xc3,0xc4,0xc5,
  0xc6,0xc7,0xc8,0xc9,0xca,0xd2,0xd3,0xd4,0xd5,0xd6,0xd7,0xd8,0xd9,0xda,0xe1,0xe2,
  0xe3,0xe4,0xe5,0xe6,0xe7,0xe8,0xe9,0xea,0xf1,0xf2,0xf3,0xf4,0xf5,0xf6,0xf7,0xf8,
  0xf9,0xfa];
const STD_AC_CHROMA_BITS = [0,2,1,2,4,4,3,4,7,5,4,4,0,1,2,0x77];
const STD_AC_CHROMA_VALS = [
  0x00,0x01,0x02,0x03,0x11,0x04,0x05,0x21,0x31,0x06,0x12,0x41,0x51,0x07,0x61,0x71,
  0x13,0x22,0x32,0x81,0x08,0x14,0x42,0x91,0xa1,0xb1,0xc1,0x09,0x23,0x33,0x52,0xf0,
  0x15,0x62,0x72,0xd1,0x0a,0x16,0x24,0x34,0xe1,0x25,0xf1,0x17,0x18,0x19,0x1a,0x26,
  0x27,0x28,0x29,0x2a,0x35,0x36,0x37,0x38,0x39,0x3a,0x43,0x44,0x45,0x46,0x47,0x48,
  0x49,0x4a,0x53,0x54,0x55,0x56,0x57,0x58,0x59,0x5a,0x63,0x64,0x65,0x66,0x67,0x68,
  0x69,0x6a,0x73,0x74,0x75,0x76,0x77,0x78,0x79,0x7a,0x82,0x83,0x84,0x85,0x86,0x87,
  0x88,0x89,0x8a,0x92,0x93,0x94,0x95,0x96,0x97,0x98,0x99,0x9a,0xa2,0xa3,0xa4,0xa5,
  0xa6,0xa7,0xa8,0xa9,0xaa,0xb2,0xb3,0xb4,0xb5,0xb6,0xb7,0xb8,0xb9,0xba,0xc2,0xc3,
  0xc4,0xc5,0xc6,0xc7,0xc8,0xc9,0xca,0xd2,0xd3,0xd4,0xd5,0xd6,0xd7,0xd8,0xd9,0xda,
  0xe2,0xe3,0xe4,0xe5,0xe6,0xe7,0xe8,0xe9,0xea,0xf2,0xf3,0xf4,0xf5,0xf6,0xf7,0xf8,
  0xf9,0xfa];

function huffDecodeTable(bits, vals) {
  const map = new Map();
  let code = 0, k = 0;
  for (let len = 1; len <= 16; len++) {
    for (let i = 0; i < bits[len - 1]; i++) map.set(len * 65536 + code++, vals[k++]);
    code <<= 1;
  }
  return map;
}

function huffEncodeTable(bits, vals) {
  const enc = [];
  let code = 0, k = 0;
  for (let len = 1; len <= 16; len++) {
    for (let i = 0; i < bits[len - 1]; i++) enc[vals[k++]] = { code: code++, len };
    code <<= 1;
  }
  return enc;
}

class BitReader {
  constructor(data, pos) { this.d = data; this.p = pos; this.acc = 0; this.n = 0; this.hitMarker = false; }
  bit() {
    if (this.n === 0) {
      if (this.p >= this.d.length) { this.hitMarker = true; return 0; }
      let v = this.d[this.p++];
      if (v === 0xFF) {
        const nxt = this.d[this.p];
        if (nxt === 0x00) this.p++;
        else { this.hitMarker = true; this.p--; return 0; }
      }
      this.acc = v; this.n = 8;
    }
    this.n--;
    return (this.acc >> this.n) & 1;
  }
  bits(n) { let v = 0; for (let i = 0; i < n; i++) v = (v << 1) | this.bit(); return v; }
}

/**
 * A growable byte buffer backed by a Uint8Array. Building the output as a plain
 * array with per-byte push, then Uint8Array.from, cost enough memory to crash
 * the renderer on a large, high-detail image (a few million bytes of entropy
 * data in a boxed JS array plus the copy). This holds the bytes in a typed
 * array that doubles when full.
 */
class ByteSink {
  constructor(cap = 1 << 16) { this.buf = new Uint8Array(cap); this.len = 0; }
  _ensure(n) {
    if (this.len + n <= this.buf.length) return;
    let c = this.buf.length * 2;
    while (c < this.len + n) c *= 2;
    const b = new Uint8Array(c);
    b.set(this.buf.subarray(0, this.len));
    this.buf = b;
  }
  byte(v) { if (this.len >= this.buf.length) this._ensure(1); this.buf[this.len++] = v & 0xFF; }
  push(...bytes) { this._ensure(bytes.length); for (let i = 0; i < bytes.length; i++) this.buf[this.len++] = bytes[i] & 0xFF; }
  append(arr) { this._ensure(arr.length); this.buf.set(arr, this.len); this.len += arr.length; }
  bytes() { return this.buf.subarray(0, this.len); }
}

class BitWriter {
  constructor() { this.sink = new ByteSink(1 << 18); this.acc = 0; this.n = 0; }
  write(code, len) {
    for (let i = len - 1; i >= 0; i--) {
      this.acc = ((this.acc << 1) | ((code >> i) & 1)) & 0xFF;
      if (++this.n === 8) {
        this.sink.byte(this.acc);
        if (this.acc === 0xFF) this.sink.byte(0x00);   // byte stuffing
        this.acc = 0; this.n = 0;
      }
    }
  }
  flush() { while (this.n !== 0) this.write(1, 1); }
}

/**
 * Optimal Huffman table for a symbol frequency count (JPEG Annex K.2, as
 * implemented by libjpeg's jpeg_gen_optimal_table). `freq` has 257 entries;
 * entry 256 is the reserved code point that keeps any real code from being
 * all ones. Returns { bits[16], vals[] }.
 */
function optimalTable(freqIn) {
  const freq = Int32Array.from(freqIn);
  freq[256] = 1;
  const codesize = new Int32Array(257);
  const others = new Int32Array(257).fill(-1);
  for (;;) {
    let c1 = -1, c2 = -1, v = 0x7fffffff;
    for (let i = 0; i <= 256; i++) if (freq[i] && freq[i] <= v) { v = freq[i]; c1 = i; }
    v = 0x7fffffff;
    for (let i = 0; i <= 256; i++) if (freq[i] && freq[i] <= v && i !== c1) { v = freq[i]; c2 = i; }
    if (c2 < 0) break;
    freq[c1] += freq[c2]; freq[c2] = 0;
    codesize[c1]++;
    while (others[c1] >= 0) { c1 = others[c1]; codesize[c1]++; }
    others[c1] = c2;
    codesize[c2]++;
    while (others[c2] >= 0) { c2 = others[c2]; codesize[c2]++; }
  }
  const bits = new Int32Array(33);
  for (let i = 0; i <= 256; i++) if (codesize[i]) bits[codesize[i]]++;
  let i = 32;
  while (i > 16) {
    if (bits[i] > 0) {
      let j = i - 2;
      while (bits[j] === 0) j--;
      bits[i] -= 2; bits[i - 1]++; bits[j + 1] += 2; bits[j]--;
    } else i--;
  }
  while (bits[i] === 0) i--;
  bits[i]--;                                   // drop the reserved code point
  const vals = [];
  for (let len = 1; len <= 32; len++) for (let s = 0; s < 256; s++) if (codesize[s] === len) vals.push(s);
  return { bits: Array.from(bits.subarray(1, 17)), vals };
}

const extend = (v, t) => (v < (1 << (t - 1)) ? v - (1 << t) + 1 : v);
const category = v => { let a = Math.abs(v), n = 0; while (a) { n++; a >>= 1; } return n; };
const toBits = (v, s) => (v >= 0 ? v : v + (1 << s) - 1);

function decodeHuff(br, map) {
  let code = 0;
  for (let len = 1; len <= 16; len++) {
    code = (code << 1) | br.bit();
    const v = map.get(len * 65536 + code);
    if (v !== undefined) return v;
    if (br.hitMarker) return 0;
  }
  throw new Error('invalid Huffman code');
}

/**
 * @param {Uint8Array} data  a baseline JPEG
 * @param {{luma:number[], chroma:number[]}} target  64-entry zigzag tables
 * @param {{restartInterval?: number}} [opts]  MCUs between RSTn markers; 0 = none.
 *   Adobe's exporter writes a DRI segment and restart markers, and the
 *   re-encoder reproduces that: after every `restartInterval` MCUs the bit
 *   stream is padded with 1-bits, an RSTn marker (n cycling 0–7) is written,
 *   and the DC predictors reset.
 * @returns {Uint8Array|null}
 */
export function requantize(data, target, opts = {}) {
  const restartInterval = Math.max(0, Math.floor(opts.restartInterval || 0));
  if (data[0] !== 0xFF || data[1] !== 0xD8) return null;

  const srcQ = {};           // id -> Int32Array(64)
  const dcTabs = {}, acTabs = {};
  let frame = null, sosPos = -1, sos = null, srcRestart = 0;
  const preSegments = [];    // APPn / COM to carry over verbatim

  let i = 2;
  while (i + 3 < data.length) {
    if (data[i] !== 0xFF) return null;
    const m = data[i + 1];
    if (m === 0xD8 || m === 0x01 || (m >= 0xD0 && m <= 0xD7)) { i += 2; continue; }
    const len = (data[i + 2] << 8) | data[i + 3];
    const body = i + 4, end = i + 2 + len;
    if (end > data.length) return null;

    if (m === 0xDB) {
      let p = body;
      while (p < end) {
        const pq = data[p] >> 4, tq = data[p] & 15; p++;
        if (pq !== 0) return null;                       // 16-bit tables: not handled
        const t = new Int32Array(64);
        for (let k = 0; k < 64; k++) t[k] = data[p++];
        srcQ[tq] = t;
      }
    } else if (m === 0xC4) {
      let p = body;
      while (p < end) {
        const tc = data[p] >> 4, th = data[p] & 15; p++;
        const bits = []; let total = 0;
        for (let k = 0; k < 16; k++) { bits.push(data[p + k]); total += data[p + k]; }
        p += 16;
        const vals = [];
        for (let k = 0; k < total; k++) vals.push(data[p + k]);
        p += total;
        (tc === 0 ? dcTabs : acTabs)[th] = huffDecodeTable(bits, vals);
      }
    } else if (m === 0xC0) {
      const prec = data[body];
      if (prec !== 8) return null;
      const h = (data[body + 1] << 8) | data[body + 2];
      const w = (data[body + 3] << 8) | data[body + 4];
      const n = data[body + 5];
      const comps = [];
      for (let c = 0; c < n; c++) {
        const o = body + 6 + c * 3;
        comps.push({ id: data[o], h: data[o + 1] >> 4, v: data[o + 1] & 15, tq: data[o + 2] });
      }
      frame = { w, h, comps };
    } else if (m === 0xC1 || m === 0xC2 || m === 0xC3 || (m >= 0xC5 && m <= 0xCF && m !== 0xC8)) {
      return null;                                       // not baseline sequential
    } else if (m === 0xDD) {
      srcRestart = (data[body] << 8) | data[body + 1];
      if (srcRestart !== 0) return null;                 // input restart markers: not handled
    } else if (m === 0xDA) {
      const n = data[body];
      const scan = [];
      for (let c = 0; c < n; c++) {
        const o = body + 1 + c * 2;
        scan.push({ id: data[o], dc: data[o + 1] >> 4, ac: data[o + 1] & 15 });
      }
      sos = scan; sosPos = end;
      break;
    }
    // The browser's APP0/APP2 are not carried over: the caller supplies the
    // exporter's own APP14 through opts.app14 and its metadata separately.
    i = end;
  }
  if (!frame || !sos || sosPos < 0) return null;

  const hMax = Math.max(...frame.comps.map(c => c.h));
  const vMax = Math.max(...frame.comps.map(c => c.v));
  const mcuW = 8 * hMax, mcuH = 8 * vMax;
  const mcusX = Math.ceil(frame.w / mcuW), mcusY = Math.ceil(frame.h / mcuH);

  // ── decode every block, in MCU order ──
  const br = new BitReader(data, sosPos);
  const preds = {}; frame.comps.forEach(c => (preds[c.id] = { v: 0 }));
  const blocks = [];
  try {
    for (let my = 0; my < mcusY; my++) {
      for (let mx = 0; mx < mcusX; mx++) {
        for (const comp of frame.comps) {
          const s = sos.find(x => x.id === comp.id);
          if (!s) return null;
          for (let by = 0; by < comp.v; by++) {
            for (let bx = 0; bx < comp.h; bx++) {
              const blk = new Int32Array(ZIGZAG_LEN);
              const t = decodeHuff(br, dcTabs[s.dc]);
              const diff = t ? extend(br.bits(t), t) : 0;
              preds[comp.id].v += diff;
              blk[0] = preds[comp.id].v;
              let k = 1;
              while (k < 64) {
                const rs = decodeHuff(br, acTabs[s.ac]);
                const r = rs >> 4, sz = rs & 15;
                if (sz === 0) { if (r === 15) { k += 16; continue; } break; }
                k += r;
                if (k > 63) break;
                blk[k] = extend(br.bits(sz), sz);
                k++;
              }
              blocks.push({ comp, blk });
            }
          }
        }
      }
    }
  } catch { return null; }

  // ── rescale onto the target tables ──
  // Component 0 is luma; everything else takes the chroma table, matching how
  // the source file assigns its own two tables.
  const dstQ = {};
  for (const c of frame.comps) {
    const isLuma = c === frame.comps[0];
    dstQ[c.tq] = Int32Array.from(isLuma ? target.luma : target.chroma);
  }
  for (const { comp, blk } of blocks) {
    const sq = srcQ[comp.tq], dq = dstQ[comp.tq];
    if (!sq || !dq) return null;
    for (let k = 0; k < 64; k++) {
      if (blk[k] === 0) continue;
      // Round half away from zero, the same for both signs. With the
      // browser's fine quality-1.0 tables, exact .5 ties are common, and
      // Math.round sent every one toward +infinity: that left one identical
      // 8x8 pattern in every output, enough to recognise them as a group
      // (AUC 0.995 against real files; 0.74 with this rounding, measured on
      // real phone photos). Breaking ties at random measured no better.
      const v = (blk[k] * sq[k]) / dq[k];
      blk[k] = Math.sign(v) * Math.round(Math.abs(v));
    }
  }

  // ── Huffman tables ──
  // Adobe's exporter writes tables optimised for the image (its DHT runs
  // 150–280 bytes); its thumbnails use the standard Annex K tables (416
  // bytes). Both are reproduced: `optimizeHuffman` gathers the symbol
  // statistics of the re-quantised coefficients and builds the tables the
  // way libjpeg's jpeg_gen_optimal_table does.
  let tables;
  if (opts.optimizeHuffman !== false) {
    const freq = [new Int32Array(257), new Int32Array(257), new Int32Array(257), new Int32Array(257)]; // dc0, ac0, dc1, ac1
    const fPreds = {}; frame.comps.forEach(c => (fPreds[c.id] = { v: 0 }));
    let fi = 0, fMcu = 0;
    for (let my = 0; my < mcusY; my++) {
      for (let mx = 0; mx < mcusX; mx++) {
        if (restartInterval && fMcu > 0 && fMcu % restartInterval === 0) frame.comps.forEach(c => (fPreds[c.id].v = 0));
        fMcu++;
        for (const comp of frame.comps) {
          const sel = comp === frame.comps[0] ? 0 : 1;
          for (let n = 0; n < comp.v * comp.h; n++) {
            const blk = blocks[fi++].blk;
            const diff = blk[0] - fPreds[comp.id].v;
            fPreds[comp.id].v = blk[0];
            freq[sel * 2][category(diff)]++;
            let run = 0;
            for (let k = 1; k < 64; k++) {
              if (blk[k] === 0) { run++; continue; }
              while (run > 15) { freq[sel * 2 + 1][0xF0]++; run -= 16; }
              freq[sel * 2 + 1][(run << 4) | category(blk[k])]++;
              run = 0;
            }
            if (run > 0) freq[sel * 2 + 1][0x00]++;
          }
        }
      }
    }
    tables = freq.map(f => optimalTable(f));
  } else {
    tables = [
      { bits: STD_DC_LUMA_BITS, vals: STD_DC_LUMA_VALS },
      { bits: STD_AC_LUMA_BITS, vals: STD_AC_LUMA_VALS },
      { bits: STD_DC_CHROMA_BITS, vals: STD_DC_CHROMA_VALS },
      { bits: STD_AC_CHROMA_BITS, vals: STD_AC_CHROMA_VALS },
    ];
  }
  const dcEnc = [huffEncodeTable(tables[0].bits, tables[0].vals), huffEncodeTable(tables[2].bits, tables[2].vals)];
  const acEnc = [huffEncodeTable(tables[1].bits, tables[1].vals), huffEncodeTable(tables[3].bits, tables[3].vals)];

  // ── re-encode ──
  const bw = new BitWriter();
  const wPreds = {}; frame.comps.forEach(c => (wPreds[c.id] = { v: 0 }));
  let bi = 0, mcuCount = 0, rstIndex = 0;
  try {
    for (let my = 0; my < mcusY; my++) {
      for (let mx = 0; mx < mcusX; mx++) {
        if (restartInterval && mcuCount > 0 && mcuCount % restartInterval === 0) {
          bw.flush();
          bw.sink.push(0xFF, 0xD0 + (rstIndex & 7));
          rstIndex++;
          frame.comps.forEach(c => (wPreds[c.id].v = 0));
        }
        mcuCount++;
        for (const comp of frame.comps) {
          const sel = comp === frame.comps[0] ? 0 : 1;
          for (let n = 0; n < comp.v * comp.h; n++) {
            const blk = blocks[bi++].blk;
            const diff = blk[0] - wPreds[comp.id].v;
            wPreds[comp.id].v = blk[0];
            const t = category(diff);
            const dce = dcEnc[sel][t]; if (!dce) return null;
            bw.write(dce.code, dce.len);
            if (t) bw.write(toBits(diff, t), t);
            let run = 0;
            for (let k = 1; k < 64; k++) {
              if (blk[k] === 0) { run++; continue; }
              while (run > 15) { const z = acEnc[sel][0xF0]; bw.write(z.code, z.len); run -= 16; }
              const sz = category(blk[k]);
              const e = acEnc[sel][(run << 4) | sz]; if (!e) return null;
              bw.write(e.code, e.len);
              bw.write(toBits(blk[k], sz), sz);
              run = 0;
            }
            if (run > 0) { const e = acEnc[sel][0x00]; bw.write(e.code, e.len); }
          }
        }
      }
    }
  } catch { return null; }
  bw.flush();

  // ── assemble ──
  const out = new ByteSink(bw.sink.len + (1 << 16));
  const push = (...b) => out.push(...b);
  push(0xFF, 0xD8);
  for (const seg of preSegments) out.append(seg);

  // DQT: both tables in one segment, which is how the exporter packs them.
  const tqs = [...new Set(frame.comps.map(c => c.tq))].sort();
  {
    const len = 2 + tqs.length * 65;
    push(0xFF, 0xDB, (len >> 8) & 0xFF, len & 0xFF);
    for (const tq of tqs) {
      push(tq & 15);
      const t = dstQ[tq];
      for (let k = 0; k < 64; k++) push(Math.max(1, Math.min(255, t[k])));
    }
  }
  // DRI, as the exporter places it: after DQT, before the frame header.
  if (restartInterval) {
    push(0xFF, 0xDD, 0x00, 0x04, (restartInterval >> 8) & 0xFF, restartInterval & 0xFF);
  }
  // An APP14 handed in goes here, between DRI and SOF0, which is where the
  // exporter puts it in its embedded thumbnails.
  if (opts.app14) out.append(opts.app14);
  // SOF0. Component identifiers are renumbered 0, 1, 2: the browser's
  // encoder writes 1, 2, 3, every Adobe export measured writes 0, 1, 2.
  const nc = frame.comps.length;
  const sofLen = 8 + 3 * nc;
  push(0xFF, 0xC0, (sofLen >> 8) & 0xFF, sofLen & 0xFF, 8,
       (frame.h >> 8) & 0xFF, frame.h & 0xFF, (frame.w >> 8) & 0xFF, frame.w & 0xFF, nc);
  frame.comps.forEach((c, i) => push(i, (c.h << 4) | c.v, c.tq));
  // DHT: all four tables in one segment, in the order libjpeg emits them.
  {
    const dht = [
      [0, 0, tables[0]], [1, 0, tables[1]],
      [0, 1, tables[2]], [1, 1, tables[3]],
    ];
    const len = 2 + dht.reduce((n, [, , t]) => n + 1 + 16 + t.vals.length, 0);
    push(0xFF, 0xC4, (len >> 8) & 0xFF, len & 0xFF);
    for (const [tc, th, t] of dht) push((tc << 4) | th, ...t.bits, ...t.vals);
  }
  // SOS
  const sosLen = 6 + 2 * nc;
  push(0xFF, 0xDA, (sosLen >> 8) & 0xFF, sosLen & 0xFF, nc);
  frame.comps.forEach((c, i) => {
    const sel = i === 0 ? 0 : 1;
    push(i, (sel << 4) | sel);
  });
  push(0x00, 0x3F, 0x00);
  out.append(bw.sink.bytes());
  push(0xFF, 0xD9);

  return out.bytes().slice();
}
