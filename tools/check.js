#!/usr/bin/env node
/**
 * check.js — end-to-end output check for MetaFaker.
 *
 * Serves the repo on 127.0.0.1, drives the real app in headless Chrome over
 * the DevTools protocol, pulls every processed JPEG back out, and asserts on
 * the bytes (segment layout, forbidden encoder strings) and, when exiftool is
 * available, on the metadata (validation, internal consistency, plausibility).
 *
 *   node tools/check.js            # all testimg/*.jpg plus a synthetic PNG screenshot
 *   node tools/check.js --keep     # leave Chrome's temp profile in place
 *   CHROME=/path/to/chrome node tools/check.js
 *
 * Outputs land in tools/out/ (git-ignored). Exit code 1 on any failure.
 * Zero npm dependencies; Node 22+ (global WebSocket and fetch).
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const cdp = require('./lib/cdp.js');

const ROOT = path.resolve(__dirname, '..');
const OUT_DIR = path.join(__dirname, 'out');
const TESTIMG = path.join(ROOT, 'testimg');
const EXIFTOOL_FALLBACKS = [
  'C:\\Users\\USERNAME\\AppData\\Local\\Programs\\ExifTool\\ExifTool.exe',
  'C:\\Program Files\\ExifTool\\exiftool.exe',
  'C:\\Windows\\exiftool.exe',
  '/usr/local/bin/exiftool',
  '/usr/bin/exiftool',
  '/opt/homebrew/bin/exiftool',
];

const LOCATION_DRAWS = 3000;

// US land, 50 states and DC, as boundary polylines from tools/build-places.js.
const US_LAND = JSON.parse(fs.readFileSync(path.join(__dirname, 'us-land.json'), 'utf8')).lines.map(l => {
  const pts = Float64Array.from(l, v => v / 1e5);
  let xMax = -Infinity, yMin = Infinity, yMax = -Infinity;
  for (let i = 0; i < pts.length; i += 2) { xMax = Math.max(xMax, pts[i]); yMin = Math.min(yMin, pts[i + 1]); yMax = Math.max(yMax, pts[i + 1]); }
  return { pts, xMax, yMin, yMax };
});

/** Even-odd test of a ray to the east against every boundary segment. */
function onUsLand(lat, lon) {
  let inside = false;
  for (const { pts, xMax, yMin, yMax } of US_LAND) {
    if (lat < yMin || lat > yMax || lon > xMax) continue;
    for (let i = 2; i < pts.length; i += 2) {
      const ax = pts[i - 2], ay = pts[i - 1], bx = pts[i], by = pts[i + 1];
      if ((ay > lat) !== (by > lat) && lon < ax + (lat - ay) * (bx - ax) / (by - ay)) inside = !inside;
    }
  }
  return inside;
}

// ── Result collection ────────────────────────────────────────────

const results = [];                     // { file, check, ok, detail }
function assert(file, check, ok, detail = '') {
  results.push({ file, check, ok: !!ok, detail: ok ? '' : String(detail) });
  return !!ok;
}
const skipped = [];

// ── JPEG segment walker ──────────────────────────────────────────

const MARKER_NAMES = {
  0xC0: 'SOF0', 0xC1: 'SOF1', 0xC2: 'SOF2', 0xC3: 'SOF3', 0xC4: 'DHT',
  0xC5: 'SOF5', 0xC6: 'SOF6', 0xC7: 'SOF7', 0xC9: 'SOF9', 0xCA: 'SOF10',
  0xCB: 'SOF11', 0xCC: 'DAC', 0xCD: 'SOF13', 0xCE: 'SOF14', 0xCF: 'SOF15',
  0xD8: 'SOI', 0xD9: 'EOI', 0xDA: 'SOS', 0xDB: 'DQT', 0xDC: 'DNL',
  0xDD: 'DRI', 0xDE: 'DHP', 0xDF: 'EXP', 0xFE: 'COM',
};
for (let i = 0; i < 16; i++) MARKER_NAMES[0xE0 + i] = `APP${i}`;

/**
 * Walk the marker segments from SOI up to (and including) SOS.
 * Returns { segments: [{ marker, name, offset, length, data }], sosOffset, error }.
 * `data` is the payload after the 2-byte length field.
 */
function walkJpeg(buf) {
  const segments = [];
  if (buf.length < 4 || buf[0] !== 0xFF || buf[1] !== 0xD8) {
    return { segments, sosOffset: -1, error: 'missing SOI' };
  }
  segments.push({ marker: 0xD8, name: 'SOI', offset: 0, length: 0, data: Buffer.alloc(0) });
  let i = 2;
  while (i < buf.length) {
    if (buf[i] !== 0xFF) return { segments, sosOffset: -1, error: `expected marker at 0x${i.toString(16)}, got 0x${buf[i].toString(16)}` };
    while (buf[i] === 0xFF && i < buf.length) i++;          // fill bytes
    if (i >= buf.length) break;
    const marker = buf[i];
    const at = i - 1;
    i++;
    if (marker === 0xD8 || marker === 0x01 || (marker >= 0xD0 && marker <= 0xD7)) {
      segments.push({ marker, name: MARKER_NAMES[marker] || `M${marker.toString(16)}`, offset: at, length: 0, data: Buffer.alloc(0) });
      continue;
    }
    if (marker === 0xD9) {
      segments.push({ marker, name: 'EOI', offset: at, length: 0, data: Buffer.alloc(0) });
      return { segments, sosOffset: -1, error: 'EOI before SOS' };
    }
    if (i + 2 > buf.length) return { segments, sosOffset: -1, error: 'truncated segment length' };
    const length = buf.readUInt16BE(i);
    if (length < 2 || i + length > buf.length) return { segments, sosOffset: -1, error: `bad segment length ${length} at 0x${at.toString(16)}` };
    const data = buf.subarray(i + 2, i + length);
    const seg = { marker, name: MARKER_NAMES[marker] || `M${marker.toString(16)}`, offset: at, length, data };
    segments.push(seg);
    if (marker === 0xDA) return { segments, sosOffset: at, error: null };
    i += length;
  }
  return { segments, sosOffset: -1, error: 'no SOS found' };
}

function describeApp(seg) {
  const head = seg.data.subarray(0, 28).toString('latin1');
  if (seg.marker === 0xE1) {
    if (head.startsWith('Exif\0\0')) return 'APP1:Exif';
    if (head.startsWith('http://ns.adobe.com/xap/1.0/')) return 'APP1:XMP';
    if (head.startsWith('http://ns.adobe.com/xmp/extension/')) return 'APP1:XMPext';
    return 'APP1:?';
  }
  if (seg.marker === 0xE2) {
    if (head.startsWith('ICC_PROFILE\0')) return 'APP2:ICC';
    if (head.startsWith('MPF\0')) return 'APP2:MPF';
    return 'APP2:?';
  }
  if (seg.marker === 0xE0) return head.startsWith('JFIF\0') ? 'APP0:JFIF' : (head.startsWith('JFXX\0') ? 'APP0:JFXX' : 'APP0:?');
  if (seg.marker === 0xEE) return head.startsWith('Adobe') ? 'APP14:Adobe' : 'APP14:?';
  if (seg.marker === 0xED) return head.startsWith('Photoshop 3.0\0') ? 'APP13:PS' : 'APP13:?';
  return seg.name;
}

function parseSof(seg) {
  const d = seg.data;
  if (d.length < 6) return null;
  const precision = d[0];
  const height = d.readUInt16BE(1);
  const width = d.readUInt16BE(3);
  const n = d[5];
  const components = [];
  for (let k = 0; k < n && 6 + k * 3 + 2 < d.length; k++) {
    const id = d[6 + k * 3];
    const hv = d[7 + k * 3];
    const tq = d[8 + k * 3];
    components.push({ id, h: hv >> 4, v: hv & 15, tq });
  }
  return { precision, width, height, components };
}

function countDqtTables(seg) {
  let n = 0, i = 0;
  const d = seg.data;
  while (i < d.length) {
    const pq = d[i] >> 4;
    i += 1 + (pq ? 128 : 64);
    n++;
  }
  return i === d.length ? n : -1;
}

function countBytes(buf, needle, end = buf.length) {
  let n = 0, from = 0;
  for (;;) {
    const at = buf.indexOf(needle, from);
    if (at < 0 || at >= end) return n;
    n++; from = at + 1;
  }
}

const utf16be = s => Buffer.from(Array.from(s).flatMap(c => [0, c.charCodeAt(0)]));
const FORBIDDEN = [
  ['"Google Inc"', Buffer.from('Google Inc', 'latin1')],
  ['"Skia"', Buffer.from('Skia', 'latin1')],
  ['"JFIF"', Buffer.from('JFIF', 'latin1')],
  ['"Chrome"', Buffer.from('Chrome', 'latin1')],
  ['"Mozilla"', Buffer.from('Mozilla', 'latin1')],
  ['UTF-16BE "Google"', utf16be('Google')],
  ['UTF-16BE "Skia"', utf16be('Skia')],
];

// ── Byte-level assertions ────────────────────────────────────────

function byteChecks(name, buf, mode) {
  const walk = walkJpeg(buf);
  const segs = walk.segments;
  const names = segs.map(describeApp);
  const info = { layout: names.join(' '), width: null, height: null };

  if (!assert(name, 'jpeg: parsable up to SOS', !walk.error, walk.error)) return info;

  const has = pred => segs.some(pred);
  const app0 = segs.filter(s => s.marker === 0xE0);
  const app1 = segs.filter(s => s.marker === 0xE1);
  const app2 = segs.filter(s => s.marker === 0xE2);
  const app14 = segs.filter(s => s.marker === 0xEE);
  const exif = app1.filter(s => s.data.subarray(0, 6).toString('latin1') === 'Exif\0\0');
  const xmp = app1.filter(s => s.data.subarray(0, 29).toString('latin1') === 'http://ns.adobe.com/xap/1.0/\0');
  const icc = app2.filter(s => s.data.subarray(0, 12).toString('latin1') === 'ICC_PROFILE\0');
  const dqt = segs.filter(s => s.marker === 0xDB);
  const dht = segs.filter(s => s.marker === 0xC4);
  const sof = segs.filter(s => s.marker >= 0xC0 && s.marker <= 0xCF && s.marker !== 0xC4 && s.marker !== 0xC8 && s.marker !== 0xCC);
  const sof0 = sof.filter(s => s.marker === 0xC0);

  // Common structure. A randomized file is an Adobe export and carries two
  // embedded thumbnails (IFD1 and the Photoshop block), so three SOI appear
  // before SOS; a stripped file has just the one.
  const soiCount = countBytes(buf, Buffer.from([0xFF, 0xD8]), walk.sosOffset);
  if (mode === 'randomized') {
    assert(name, 'jpeg: main SOI plus two embedded thumbnails', soiCount === 3, `found ${soiCount} x FFD8 before SOS`);
  } else if (mode === 'stripped') {
    assert(name, 'jpeg: exactly one SOI before SOS', soiCount === 1, `found ${soiCount} x FFD8 before SOS`);
  } else {
    // nonphoto: blank strip (1 SOI) or exported graphic (3, with thumbnails)
    assert(name, 'jpeg: SOI count is 1 or 3', soiCount === 1 || soiCount === 3, `found ${soiCount} x FFD8 before SOS`);
  }
  assert(name, 'jpeg: no APP0', app0.length === 0, `${app0.length} APP0 segment(s): ${app0.map(describeApp).join(',')}`);
  assert(name, 'jpeg: DQT is one segment with 2 tables', dqt.length === 1 && countDqtTables(dqt[0]) === 2,
    `DQT segments=${dqt.length} tables=${dqt.map(countDqtTables).join('+') || 0}`);
  assert(name, 'jpeg: APP14 Adobe present', app14.length === 1 && app14[0].data.subarray(0, 5).toString('latin1') === 'Adobe',
    `APP14 count=${app14.length}`);
  assert(name, 'jpeg: SOF0 baseline', sof.length === 1 && sof0.length === 1, `frame headers: ${sof.map(s => s.name).join(',') || 'none'}`);
  if (sof0.length) {
    const f = parseSof(sof0[0]);
    info.width = f.width; info.height = f.height;
    const samp = f.components.map(c => `${c.h}x${c.v}`).join(',');
    assert(name, 'jpeg: SOF0 3 components, all 1x1 (4:4:4)',
      f.components.length === 3 && f.components.every(c => c.h === 1 && c.v === 1),
      `components=${f.components.length} sampling=${samp}`);
  }
  assert(name, 'jpeg: DHT present', dht.length >= 1, 'no DHT');
  assert(name, 'jpeg: SOS present', has(s => s.marker === 0xDA), 'no SOS');

  if (mode === 'randomized') {
    assert(name, 'jpeg: APP1 Exif present', exif.length === 1, `Exif APP1 count=${exif.length}`);
    assert(name, 'jpeg: APP1 XMP present', xmp.length === 1, `XMP APP1 count=${xmp.length}`);
    if (xmp.length) {
      const body = xmp[0].data.subarray(29);
      const at = body.indexOf(Buffer.from('begin="', 'latin1'));
      const bom = at >= 0 ? body.subarray(at + 7, at + 10) : Buffer.alloc(0);
      assert(name, 'jpeg: XMP packet begin="<UTF-8 BOM>"', at >= 0 && bom.equals(Buffer.from([0xEF, 0xBB, 0xBF])),
        at < 0 ? 'no begin=" in packet' : `bytes after begin=" are ${[...bom].map(b => b.toString(16).padStart(2, '0')).join(' ')}`);
      const endTag = body.indexOf(Buffer.from('<?xpacket end=', 'latin1'));
      assert(name, 'jpeg: XMP packet has <?xpacket end', endTag >= 0, 'no end tag');
    }
    assert(name, 'jpeg: APP2 ICC_PROFILE present', icc.length >= 1 && app2.length === icc.length,
      `APP2 count=${app2.length} (ICC=${icc.length})`);
  } else if (mode === 'stripped') {
    assert(name, 'jpeg: no APP1', app1.length === 0, `${app1.length} APP1: ${app1.map(describeApp).join(',')}`);
    assert(name, 'jpeg: no APP2', app2.length === 0, `${app2.length} APP2: ${app2.map(describeApp).join(',')}`);
  }
  // mode 'nonphoto' varies (blank strip or Adobe-exported graphic), so only
  // the common structure and forbidden-strings checks apply to it.

  // No unexpected application segments. A randomized or graphic file carries
  // the Adobe set: APP1 (Exif, XMP), APP13 (Photoshop), APP2 (ICC), APP14; a
  // stripped file carries only APP14.
  const allowed = mode === 'stripped' ? new Set([0xEE]) : new Set([0xE1, 0xE2, 0xED, 0xEE]);
  const stray = segs.filter(s => ((s.marker >= 0xE0 && s.marker <= 0xEF) || s.marker === 0xFE) && !allowed.has(s.marker));
  assert(name, 'jpeg: no other APPn/COM segments', stray.length === 0, stray.map(describeApp).join(','));

  for (const [label, needle] of FORBIDDEN) {
    const at = buf.indexOf(needle);
    assert(name, `bytes: no ${label}`, at < 0, `found at offset 0x${at.toString(16)}`);
  }
  return info;
}

// ── exiftool helpers ─────────────────────────────────────────────

function findExiftool() {
  const candidates = ['exiftool', ...(process.env.EXIFTOOL ? [process.env.EXIFTOOL] : []), ...EXIFTOOL_FALLBACKS];
  for (const exe of candidates) {
    if (exe !== 'exiftool' && !fs.existsSync(exe)) continue;
    try {
      const r = spawnSync(exe, ['-ver'], { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', timeout: 180000, windowsHide: true });
      if (r.status === 0 && /^\d+\.\d+/.test((r.stdout || '').trim())) return { exe, version: r.stdout.trim() };
    } catch {}
  }
  return null;
}

/** First value whose key is "Group:Name" (or "Name"); optional group filter. */
function tag(obj, name, group) {
  for (const k of Object.keys(obj)) {
    const parts = k.split(':');
    const last = parts[parts.length - 1];
    if (last !== name) continue;
    if (group && !parts.includes(group)) continue;
    return obj[k];
  }
  return undefined;
}
function keysNamed(obj, name) {
  return Object.keys(obj).filter(k => k.split(':').pop() === name);
}
function groupKeys(obj, group) {
  return Object.keys(obj).filter(k => k.split(':').includes(group));
}

function runExiftool(exe, files) {
  // `-validate` behaves like a tag request and would otherwise narrow the
  // output to the Validate tag alone, hence `-all -warning` alongside it.
  const args = ['-j', '-n', '-a', '-G1', '-validate', '-all', '-warning', '-charset', 'filename=utf8', ...files];
  const r = spawnSync(exe, args, { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', timeout: 300000, maxBuffer: 256 * 1024 * 1024, windowsHide: true });
  if (r.error) throw new Error(`exiftool failed to run: ${r.error.message}`);
  const out = (r.stdout || '').trim();
  if (!out) throw new Error(`exiftool produced no output (status ${r.status}): ${(r.stderr || '').slice(0, 500)}`);
  const json = JSON.parse(out);
  // exiftool repeats the "ExifTool:Warning" key for every warning, and
  // JSON.parse keeps only the last. Recover them all from the raw text, one
  // chunk per SourceFile, and attach them as a proper array.
  const starts = [];
  const re = /"SourceFile":\s*"((?:[^"\\]|\\.)*)"/g;
  let m;
  while ((m = re.exec(out))) starts.push({ at: m.index, file: JSON.parse(`"${m[1]}"`) });
  const warnRe = /"(?:[^"\\]*:)?Warning(?: \(\d+\))?":\s*"((?:[^"\\]|\\.)*)"/g;
  starts.forEach((s, i) => {
    const chunk = out.slice(s.at, i + 1 < starts.length ? starts[i + 1].at : out.length);
    const warnings = [];
    let w;
    while ((w = warnRe.exec(chunk))) warnings.push(JSON.parse(`"${w[1]}"`));
    const obj = json.find(o => o.SourceFile === s.file);
    if (obj) obj.__warnings = warnings;
  });
  return json;
}

// Solar elevation, NOAA spreadsheet algorithm. lat/lon in degrees (east +).
function solarElevation(lat, lon, dateUtc) {
  const rad = d => d * Math.PI / 180, deg = r => r * 180 / Math.PI;
  const jd = dateUtc.getTime() / 86400000 + 2440587.5;
  const T = (jd - 2451545.0) / 36525;
  const L0 = ((280.46646 + T * (36000.76983 + T * 0.0003032)) % 360 + 360) % 360;
  const M = 357.52911 + T * (35999.05029 - 0.0001537 * T);
  const e = 0.016708634 - T * (0.000042037 + 0.0000001267 * T);
  const Mr = rad(M);
  const C = Math.sin(Mr) * (1.914602 - T * (0.004817 + 0.000014 * T)) + Math.sin(2 * Mr) * (0.019993 - 0.000101 * T) + Math.sin(3 * Mr) * 0.000289;
  const trueLong = L0 + C;
  const omega = 125.04 - 1934.136 * T;
  const lambda = trueLong - 0.00569 - 0.00478 * Math.sin(rad(omega));
  const eps0 = 23 + (26 + (21.448 - T * (46.815 + T * (0.00059 - T * 0.001813))) / 60) / 60;
  const eps = eps0 + 0.00256 * Math.cos(rad(omega));
  const decl = deg(Math.asin(Math.sin(rad(eps)) * Math.sin(rad(lambda))));
  const y = Math.tan(rad(eps / 2)) ** 2;
  const eqTime = 4 * deg(y * Math.sin(2 * rad(L0)) - 2 * e * Math.sin(Mr) + 4 * e * y * Math.sin(Mr) * Math.cos(2 * rad(L0))
    - 0.5 * y * y * Math.sin(4 * rad(L0)) - 1.25 * e * e * Math.sin(2 * Mr));
  const minutesUtc = dateUtc.getUTCHours() * 60 + dateUtc.getUTCMinutes() + dateUtc.getUTCSeconds() / 60;
  const tst = (((minutesUtc + eqTime + 4 * lon) % 1440) + 1440) % 1440;
  let ha = tst / 4 - 180;
  if (ha < -180) ha += 360;
  const cosZen = Math.sin(rad(lat)) * Math.sin(rad(decl)) + Math.cos(rad(lat)) * Math.cos(rad(decl)) * Math.cos(rad(ha));
  return 90 - deg(Math.acos(Math.max(-1, Math.min(1, cosZen))));
}

const num = v => (typeof v === 'number' ? v : (typeof v === 'string' && v.trim() !== '' && !isNaN(Number(v)) ? Number(v) : NaN));
const fmt = (v, d = 2) => (Number.isFinite(v) ? v.toFixed(d) : String(v));

function exiftoolChecks(name, t, mode, info) {
  const warnings = Array.isArray(t.__warnings) && t.__warnings.length ? t.__warnings : keysNamed(t, 'Warning').map(k => t[k]);
  const errors = keysNamed(t, 'Error').map(k => t[k]);
  assert(name, 'exiftool: no Error', errors.length === 0, errors.join(' | '));

  if (mode === 'nonphoto') {
    // A non-photo (screenshot/graphic) must never carry a camera, a lens or a
    // location, whichever variant it came out as. Editor provenance is allowed.
    assert(name, 'exiftool: non-photo has no camera Make', keysNamed(t, 'Make').length === 0, `Make=${tag(t, 'Make')}`);
    assert(name, 'exiftool: non-photo has no camera Model', keysNamed(t, 'Model').length === 0, `Model=${tag(t, 'Model')}`);
    assert(name, 'exiftool: non-photo has no GPS', groupKeys(t, 'GPS').length === 0, groupKeys(t, 'GPS').join(','));
    assert(name, 'exiftool: non-photo has no LensModel', keysNamed(t, 'LensModel').length === 0, 'LensModel present');
    const sw = tag(t, 'Software', 'IFD0');
    assert(name, 'exiftool: non-photo Software (if any) is Adobe', !sw || /^Adobe /.test(sw), `Software=${sw}`);
    return;
  }

  if (mode !== 'randomized') {
    // A stripped file should carry no metadata at all.
    assert(name, 'exiftool: no Warning', warnings.length === 0, warnings.join(' | '));
    const metaGroups = ['IFD0', 'ExifIFD', 'GPS', 'XMP-x', 'XMP-xmp', 'XMP-xmpMM', 'ICC-header', 'ICC_Profile', 'JFIF', 'IFD1', 'Photoshop', 'IPTC'];
    const present = metaGroups.filter(g => groupKeys(t, g).length);
    assert(name, 'exiftool: no metadata groups', present.length === 0, `present: ${present.join(',')}`);
    const validate = tag(t, 'Validate', 'ExifTool');
    assert(name, 'exiftool: Validate OK', validate === undefined || validate === 'OK' || /^(0\s*)+$/.test(String(validate)), String(validate));
    return;
  }

  // A genuine Adobe export does not validate clean: it drops
  // ComponentsConfiguration, ExifImageWidth/Height and YCbCrPositioning, and
  // ExifTool reports exactly those four. Matching Adobe means carrying the
  // same four and no others; any further warning is a real defect.
  const ADOBE_WARNINGS = new Set([
    'Missing required JPEG ExifIFD tag 0x9101 ComponentsConfiguration',
    'Missing required JPEG ExifIFD tag 0xa002 ExifImageWidth',
    'Missing required JPEG ExifIFD tag 0xa003 ExifImageHeight',
    'Missing required JPEG IFD0 tag 0x0213 YCbCrPositioning',
    // Samsung and OnePlus firmware writes OffsetTime and LensModel with
    // ExifVersion 0220, which the Exif spec added only at 0231 and 0230; real
    // files from those phones, and their exports, carry these exact warnings.
    'ExifIFD tag 0x9010 OffsetTime requires ExifVersion 0231 or higher',
    'ExifIFD tag 0x9011 OffsetTimeOriginal requires ExifVersion 0231 or higher',
    'ExifIFD tag 0x9012 OffsetTimeDigitized requires ExifVersion 0231 or higher',
    'ExifIFD tag 0xa434 LensModel requires ExifVersion 0230 or higher',
    'ExifIFD tag 0xa433 LensMake requires ExifVersion 0230 or higher',
    'ExifIFD tag 0xa432 LensInfo requires ExifVersion 0230 or higher',
  ]);
  const unexpected = warnings.filter(w => !ADOBE_WARNINGS.has(w) && !/^\[minor\]/.test(w));
  assert(name, 'exiftool: only the Adobe-export validation warnings', unexpected.length === 0, unexpected.join(' | '));

  const make = tag(t, 'Make', 'IFD0'), model = tag(t, 'Model', 'IFD0');
  assert(name, 'exiftool: Make/Model present', !!make && !!model, `Make=${make} Model=${model}`);
  const software = tag(t, 'Software', 'IFD0');
  assert(name, 'exiftool: Software is Adobe Camera Raw or Lightroom',
    typeof software === 'string' && (software.startsWith('Adobe Photoshop Camera Raw') || software.startsWith('Adobe Lightroom')),
    `Software=${software}`);

  const dto = tag(t, 'DateTimeOriginal', 'ExifIFD');
  const modify = tag(t, 'ModifyDate', 'IFD0');
  assert(name, 'exiftool: ModifyDate >= DateTimeOriginal', typeof dto === 'string' && typeof modify === 'string' && modify >= dto, `ModifyDate=${modify} DateTimeOriginal=${dto}`);
  const xmpCreate = tag(t, 'CreateDate', 'XMP-xmp');
  assert(name, 'exiftool: XMP CreateDate == DateTimeOriginal', typeof xmpCreate === 'string' && typeof dto === 'string' && xmpCreate.slice(0, 19) === dto.slice(0, 19), `XMP-xmp:CreateDate=${xmpCreate} DateTimeOriginal=${dto}`);

  // GPS, signed. The Composite group applies the hemisphere refs.
  let lat = num(tag(t, 'GPSLatitude', 'Composite'));
  let lon = num(tag(t, 'GPSLongitude', 'Composite'));
  if (!Number.isFinite(lat)) { lat = num(tag(t, 'GPSLatitude', 'GPS')); if (tag(t, 'GPSLatitudeRef', 'GPS') === 'S') lat = -Math.abs(lat); }
  if (!Number.isFinite(lon)) { lon = num(tag(t, 'GPSLongitude', 'GPS')); if (tag(t, 'GPSLongitudeRef', 'GPS') === 'W') lon = -Math.abs(lon); }
  assert(name, 'exiftool: GPS on US land', onUsLand(lat, lon), `lat=${lat} lon=${lon}`);

  // Exposure triangle vs APEX tags. With -n exiftool has already converted
  // ApertureValue to an f-number and ShutterSpeedValue to seconds.
  const fn = num(tag(t, 'FNumber', 'ExifIFD'));
  const et = num(tag(t, 'ExposureTime', 'ExifIFD'));
  const iso = num(tag(t, 'ISO', 'ExifIFD'));
  const ev = Math.log2(fn * fn / et) - Math.log2(iso / 100);
  const av = num(tag(t, 'ApertureValue', 'ExifIFD'));
  const sv = num(tag(t, 'ShutterSpeedValue', 'ExifIFD'));
  assert(name, 'exiftool: FNumber/ExposureTime/ISO present', Number.isFinite(ev), `FNumber=${fn} ExposureTime=${et} ISO=${iso}`);
  if (Number.isFinite(av) || Number.isFinite(sv)) {
    const apexAv = Number.isFinite(av) ? 2 * Math.log2(av) : 2 * Math.log2(fn);
    const apexTv = Number.isFinite(sv) ? -Math.log2(sv) : -Math.log2(et);
    const apexEv = apexAv + apexTv - Math.log2(iso / 100);
    assert(name, 'exiftool: EV agrees with APEX tags (±0.75)', Math.abs(ev - apexEv) <= 0.75,
      `EV=${fmt(ev)} APEX EV=${fmt(apexEv)} (Av=${fmt(apexAv)} Tv=${fmt(apexTv)})`);
  }

  // Adobe exports carry an IFD1 thumbnail and a matching Photoshop thumbnail.
  const thumbLen = num(tag(t, 'ThumbnailLength', 'IFD1'));
  assert(name, 'exiftool: IFD1 thumbnail present', Number.isFinite(thumbLen) && thumbLen > 0, `ThumbnailLength=${thumbLen}`);
  const jfif = groupKeys(t, 'JFIF');
  assert(name, 'exiftool: no JFIF tags', jfif.length === 0, jfif.join(','));
  const copyright = tag(t, 'ProfileCopyright', 'ICC-header') ?? tag(t, 'ProfileCopyright');
  assert(name, 'exiftool: ICC ProfileCopyright not Google', !(typeof copyright === 'string' && /Google/i.test(copyright)), `ProfileCopyright=${copyright}`);
  // No real export pairs an sRGB ICC profile with ColorSpace Uncalibrated.
  const colorSpace = tag(t, 'ColorSpace', 'ExifIFD');
  const profileDesc = tag(t, 'ProfileDescription', 'ICC_Profile');
  const isSrgbProfile = typeof profileDesc === 'string' && /sRGB/i.test(profileDesc);
  assert(name, 'exiftool: ColorSpace is sRGB whenever the embedded ICC profile is sRGB',
    !isSrgbProfile || colorSpace === 1, `ColorSpace=${colorSpace} ProfileDescription=${profileDesc}`);
  // Adobe drops ExifImageWidth/Height on export; they must be absent.
  assert(name, 'exiftool: no ExifImageWidth/Height (Adobe drops them)',
    keysNamed(t, 'ExifImageWidth').length === 0 && keysNamed(t, 'ExifImageHeight').length === 0, 'present');

  // Sun check: no bright daylight exposure in the middle of the night.
  let when = null;
  const gdt = tag(t, 'GPSDateTime', 'Composite');
  if (typeof gdt === 'string') {
    const m = gdt.match(/(\d{4}):(\d{2}):(\d{2})\s+(\d{1,2}):(\d{2}):(\d{2}(?:\.\d+)?)/);
    if (m) when = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], Math.floor(+m[6])));
  }
  if (!when) {
    const ds = tag(t, 'GPSDateStamp', 'GPS'), ts = tag(t, 'GPSTimeStamp', 'GPS');
    const md = typeof ds === 'string' && ds.match(/(\d{4}):(\d{2}):(\d{2})/);
    const mt = typeof ts === 'string' && ts.match(/(\d{1,2}):(\d{2}):(\d{2}(?:\.\d+)?)/);
    if (md && mt) when = new Date(Date.UTC(+md[1], +md[2] - 1, +md[3], +mt[1], +mt[2], Math.floor(+mt[3])));
  }
  if (when && Number.isFinite(lat) && Number.isFinite(lon) && Number.isFinite(ev)) {
    const elev = solarElevation(lat, lon, when);
    assert(name, 'exiftool: sun check (no EV>11 while sun < -6°)', !(elev < -6 && ev > 11),
      `solar elevation ${fmt(elev, 1)}° at ${when.toISOString()} (${fmt(lat, 3)},${fmt(lon, 3)}) with EV ${fmt(ev)}`);
  } else {
    assert(name, 'exiftool: sun check (no EV>11 while sun < -6°)', false, `missing inputs: GPSDateTime=${gdt} lat=${lat} lon=${lon} EV=${fmt(ev)}`);
  }
}

// ── Browser driving ──────────────────────────────────────────────

const BATCH_SIZE = 3;   // the first N images go through Randomize Entire Batch

async function processInBrowser(page, origin, names) {
  // The first BATCH_SIZE images go through "Randomize Entire Batch", which
  // gives each its own independent identity. The rest are loaded afterwards
  // and randomized one by one. Finally the first image is loaded once more
  // and stripped, so one output of each kind exists.
  const summary = await page.evaluate(async (base, names, batchSize) => {
    const toFile = async n => {
      const r = await fetch(`${base}/testimg/${n}`);
      if (!r.ok) throw new Error(`fetch ${n}: HTTP ${r.status}`);
      return new File([await r.blob()], n, { type: 'image/jpeg' });
    };
    const batch = [];
    for (const n of names.slice(0, batchSize)) batch.push(await toFile(n));
    await App.loadFiles(batch);
    await App.randomizeAll();
    const batchIds = new Set(S.items.map(it => it.id));
    for (const n of names.slice(batchSize)) {
      await App.loadFiles([await toFile(n)]);
      App.select(S.items[S.items.length - 1].id);
      await App.randomize();
    }
    const dup = await toFile(names[0]);
    await App.loadFiles([dup]);
    App.select(S.items[S.items.length - 1].id);
    await App.clear();

    // Non-photo cases: Randomize must classify each as a non-photo and clean
    // it (a plain strip or an exported graphic, chosen at random), never give
    // it a camera or a location. Each one is a way a non-photo used to slip
    // through as a photo: decided by extension or MIME, by dimensions only, or
    // by format only.
    const drawScreen = (w, h) => {
      const c = document.createElement('canvas');
      c.width = w; c.height = h;
      const cx = c.getContext('2d');
      cx.fillStyle = '#1e293b'; cx.fillRect(0, 0, w, h);
      cx.fillStyle = '#334155'; cx.fillRect(0, 0, w, 72);
      cx.fillStyle = '#f8fafc'; cx.fillRect(Math.round(w * 0.2), 120, Math.round(w * 0.6), h - 240);
      cx.fillStyle = '#0f172a'; cx.font = '28px sans-serif';
      for (let y = 180; y < h - 160; y += 44) cx.fillText('The quick brown fox jumps over the lazy dog 0123456789', Math.round(w * 0.22), y);
      cx.fillStyle = '#e2e8f0'; cx.font = 'bold 30px sans-serif'; cx.fillText('Inbox  Archive  Settings', 32, 46);
      return c;
    };
    const toBlob = (c, type, q) => new Promise(res => c.toBlob(res, type, q));
    const screen = drawScreen(2560, 1600);
    const nonPhoto = new Map();   // id -> case name
    const loadOne = async (file, label) => {
      await App.loadFiles([file]);
      const it = S.items[S.items.length - 1];
      if (it.file !== file) return null;     // rejected at load
      if (label) nonPhoto.set(it.id, label);
      App.select(it.id);
      await App.randomize();
      return it;
    };
    const shotPng = await loadOne(new File([await toBlob(screen, 'image/png')], 'screen-capture.png', { type: 'image/png' }), 'PNG screenshot');
    await loadOne(new File([await toBlob(screen, 'image/jpeg', 0.85)], 'screen-capture-shared.jpg', { type: 'image/jpeg' }), 'JPEG screenshot');
    await loadOne(new File([await toBlob(screen, 'image/png')], 'renamed-png.jpg', { type: 'image/jpeg' }), 'PNG renamed .jpg');
    const svg = '<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg" width="800" height="600"><rect width="800" height="600" fill="#2563eb"/><circle cx="400" cy="300" r="180" fill="#f8fafc"/></svg>';
    await loadOne(new File([svg], 'vector-artwork.svg', { type: 'image/svg+xml' }), 'SVG graphic');
    const alpha = document.createElement('canvas'); alpha.width = 900; alpha.height = 700;
    const ax = alpha.getContext('2d'); ax.fillStyle = 'rgba(37,99,235,0.6)'; ax.beginPath(); ax.arc(450, 350, 300, 0, 7); ax.fill();
    await loadOne(new File([await toBlob(alpha, 'image/webp', 0.9)], 'transparent-art.webp', { type: 'image/webp' }), 'WebP with transparency');
    if (shotPng && shotPng.modBlob) {
      await loadOne(new File([shotPng.modBlob], 'reprocessed-output.jpg', { type: 'image/jpeg' }), 'own screenshot output reloaded');
    }
    // A camera JPEG with no extension and no MIME type (how Windows Chrome
    // hands over such files) must be accepted and treated as a photo.
    const noExt = await toFile(names[0]);
    const noExtItem = await loadOne(new File([noExt], 'no-extension-photo', { type: '' }), null);
    const noExtId = noExtItem ? noExtItem.id : null;

    return S.items.map((it, i) => ({
      index: i,
      name: it.file.name,
      error: it.error,
      hasBlob: !!it.modBlob,
      size: it.modBlob ? it.modBlob.size : 0,
      mode: nonPhoto.has(it.id) ? 'nonphoto' : (it.fakeExif ? 'randomized' : 'stripped'),
      isPhoto: it.inputClass ? it.inputClass.isPhoto : null,
      reason: it.inputClass ? it.inputClass.reason : '',
      nonPhotoCase: nonPhoto.get(it.id) || null,
      noExtCase: it.id === noExtId,
      batch: batchIds.has(it.id),
      camera: it.fakeCamera ? `${it.fakeCamera.make} ${it.fakeCamera.model}` : '',
      city: it.fakeLocation ? it.fakeLocation.city : '',
      date: it.fakeDate ? new Date(it.fakeDate).toISOString() : '',
      stem: it.fakeStem ?? null,
      downloadName: App.outputName(it.id),
    }));
  }, origin, names, BATCH_SIZE);

  // Independence: every image in a batch draws its own identity. With 36
  // cameras and 58 cities, three independent draws all landing on the same
  // camera and the same city happens about once in two million runs, so a
  // shared camera+city across the whole batch means a shared identity.
  const b = summary.filter(it => it.batch && it.mode === 'randomized');
  assert('(batch)', 'batch: every image randomized', b.length === BATCH_SIZE, `${b.length}/${BATCH_SIZE}`);
  if (b.length > 1) {
    const ids = new Set(b.map(it => `${it.camera} @ ${it.city}`));
    assert('(batch)', 'batch: images do not share one identity', ids.size > 1, [...ids].join(' | '));
    const stems = b.map(it => it.stem);
    assert('(batch)', 'batch: each image has its own generated filename',
      stems.every(s => typeof s === 'string' && s) && new Set(stems).size === stems.length, stems.join(','));
  }

  // Privacy: a download name must never leak when (or in which time zone)
  // this session ran. Stripped and cleaned outputs carry no EXIF timestamp to
  // echo, so a date embedded in their filename could only come from the real
  // clock, which a getOutputName fallback to `new Date()` used to do.
  const runTime = Date.now();
  const ONE_DAY_MS = 24 * 60 * 60 * 1000;
  for (const it of summary) {
    const m = it.downloadName && it.downloadName.match(/(\d{4})(\d{2})(\d{2})_(\d{2})(\d{2})(\d{2})/);
    if (!m) continue;
    const [, y, mo, d, h, mi, s] = m.map(Number);
    const named = new Date(y, mo - 1, d, h, mi, s).getTime();
    assert(it.downloadName, 'privacy: download name carries no date within a day of the run',
      Math.abs(named - runTime) > ONE_DAY_MS, `name=${it.downloadName} runTime=${new Date(runTime).toISOString()}`);
  }

  // Non-photos: classified non-photo and cleaned by Randomize, never given a camera.
  const EXPECTED_NON_PHOTO = ['PNG screenshot', 'JPEG screenshot', 'PNG renamed .jpg', 'SVG graphic',
    'WebP with transparency', 'own screenshot output reloaded'];
  for (const label of EXPECTED_NON_PHOTO) {
    const it = summary.find(x => x.nonPhotoCase === label);
    if (!assert(`(${label})`, 'classify: case loaded', !!it, 'item missing or rejected at load')) continue;
    assert(`(${label})`, 'classify: flagged non-photo', it.isPhoto === false, `isPhoto=${it.isPhoto} (${it.reason})`);
    assert(`(${label})`, 'classify: no camera or location', !it.camera && !it.city, `camera=${it.camera} city=${it.city}`);
  }
  // Real photos are not mistaken for screenshots by the content check.
  const photosIn = summary.filter(x => !x.nonPhotoCase);
  const misread = photosIn.filter(x => x.isPhoto === false);
  assert('(photos)', 'classify: no camera photo taken for a screenshot', misread.length === 0,
    misread.map(x => `${x.name}: ${x.reason}`).join(' | '));
  const noExt = summary.find(x => x.noExtCase);
  if (assert('(no extension)', 'load: extensionless JPEG with empty MIME accepted', !!noExt, 'rejected at load')) {
    assert('(no extension)', 'classify: treated as a photo and randomized', noExt.isPhoto === true && !!noExt.camera,
      `isPhoto=${noExt.isPhoto} camera=${noExt.camera}`);
  }

  // Pull blobs one at a time: a single returnByValue of all of them is too big.
  for (const item of summary) {
    if (!item.hasBlob) { item.b64 = null; continue; }
    item.b64 = await page.evaluate(async i => {
      const blob = S.items[i].modBlob;
      return new Promise((res, rej) => {
        const fr = new FileReader();
        fr.onload = () => res(String(fr.result).split(',')[1]);
        fr.onerror = () => rej(fr.error);
        fr.readAsDataURL(blob);
      });
    }, item.index);
  }
  return summary;
}

// ── Exposure ─────────────────────────────────────────────────────

const EXPOSURE_BATCH = 1000;

/**
 * Adobe's exposure rounding, run against real exports, and the exposures of
 * a large batch of generated identities. Returns plain data for the checks
 * below; `producible` says whether some camera time rounds to that rational
 * under the one-pass rule (a rounded value need not be a fixed point of it:
 * 1/1314 becomes 1/1300, which itself would become 1/1250).
 */
async function exposureInBrowser(page, origin, n) {
  return page.evaluate(async (base, n) => {
    const x = await import('/js/exposure.js');
    const m = await import('/js/exif.js');
    const t = await import('/js/exposure-tables.js');
    const h = await import('/js/helpers.js');
    const memo = new Map();
    const producible = (num, den) => {
      const key = `${num}/${den}`;
      if (!memo.has(key)) {
        let ok = false;
        for (let i = 0; i <= 4000 && !ok; i++) {
          const [a, b] = x.adobeExposure(num / den * Math.exp((i / 4000 - 0.5) * 0.3)).exposureTime;
          ok = a === num && b === den;
        }
        memo.set(key, ok);
      }
      return memo.get(key);
    };
    const parseRat = s => { const [a, b] = String(s).split('/').map(Number); return [a, b === undefined ? 1 : b]; };
    const same = (r, s) => !!s && s !== 'None' && `${r[0]}/${r[1]}` === s;

    const examples = [['1/1215', '1/1200'], ['1/4673', '1/4700'], ['2101/1000000', '1/480'], ['1/364', '1/350'],
      ['1/1314', '1/1300'], ['1/4', '1/4'], ['166/10000', '1/60'], ['1/16', '1/15']]
      .map(([from, want]) => { const [a, b] = parseRat(from); const e = x.adobeExposure(a / b).exposureTime; return { from, want, got: `${e[0]}/${e[1]}` }; });

    const fixture = await (await fetch(`${base}/tools/adobe-exposure-times.json`)).json();
    const real = {};
    for (const kind of ['phone', 'body']) {
      const r = { files: 0, producible: 0, ssvFiles: 0, ssvMatch: 0, odd: [] };
      for (const [key, count] of Object.entries(fixture[kind])) {
        const [et, ssv] = key.split(' ');
        const [a, b] = parseRat(et);
        r.files += count;
        if (!producible(a, b)) { r.odd.push(`${et} (${count})`); continue; }
        r.producible += count;
        // Other tools run after the export rewrite ShutterSpeedValue as a
        // continued fraction (18113/3133); Adobe's form is over a power of ten.
        if (!/^-?\d+\/10*$/.test(ssv)) continue;
        r.ssvFiles += count;
        if (same(x.encodeExposureTime(a / b).shutterSpeedValue, ssv)) r.ssvMatch += count;
      }
      real[kind] = r;
    }

    const E = window.piexif.ExifIFD;
    const rows = [];
    for (let i = 0; i < n; i++) {
      const g = m.generateFake({});
      const e = g.piexif.Exif;
      const et = e[E.ExposureTime], f = g.display.FNumber;
      rows.push({
        phone: g.cam.type === 'phone', apple: g.cam.writer === 'apple', model: g.cam.model,
        et: `${et[0]}/${et[1]}`, seconds: et[0] / et[1], iso: e[E.ISOSpeedRatings], f, ev: g.ev,
        sun: h.sunElevation(g.loc.lat, g.loc.lon, h.wallClockToUtc(g.capture, g.loc.tz)),
        producible: producible(et[0], et[1]),
        ssvOk: same(x.encodeExposureTime(et[0] / et[1]).shutterSpeedValue, `${e[E.ShutterSpeedValue][0]}/${e[E.ShutterSpeedValue][1]}`),
        avOk: same(x.adobeFNumber(f).apertureValue, `${e[E.ApertureValue][0]}/${e[E.ApertureValue][1]}`),
      });
    }
    const tables = { apple: t.PHONE_APPLE, android: t.PHONE_ANDROID, body: t.BODY_ADOBE };
    return { examples, real, rows, tables };
  }, origin, n);
}

/**
 * Where a generated value falls in the measured distribution it should come
 * from: the uploader-weighted share of real files below it, among files of
 * the same table, in the same 1-EV bin, shot within 0.4 stop of the same
 * f-number. Ties are split at random, so a generator drawing from the
 * measured distribution gives shares uniform on [0, 1].
 */
function exposureRank(files, g, key) {
  const evOf = x => Math.log2(x.f * x.f / x.t) - Math.log2(x.iso / 100);
  const bin = Math.floor(g.ev);
  const ref = files.filter(x => Math.floor(evOf(x)) === bin && Math.abs(2 * Math.log2(x.f / g.f)) <= 0.4);
  if (ref.length < 20) return null;
  const v = key === 't' ? g.seconds : g.iso;
  const tot = ref.reduce((s, x) => s + x.w, 0);
  const below = ref.filter(x => x[key] < v * (1 - 1e-6)).reduce((s, x) => s + x.w, 0);
  const at = ref.filter(x => Math.abs(x[key] / v - 1) <= 1e-6).reduce((s, x) => s + x.w, 0);
  return (below + Math.random() * at) / tot;
}

function exposureChecks(data) {
  for (const ex of data.examples) {
    assert('(exposure)', `snap: Adobe writes a camera's ${ex.from} s as ${ex.want}`, ex.got === ex.want, `got ${ex.got}`);
  }
  // The only real values the rule cannot produce are encodings no Adobe
  // version writes (200/10000, 40/10000), from tools run after the export.
  const NON_ADOBE = { phone: 1, body: 3 };
  for (const [kind, r] of Object.entries(data.real)) {
    assert('(exposure)', `snap: produces the ExposureTime of every real ${kind} export but the non-Adobe encodings`,
      r.files - r.producible === NON_ADOBE[kind], `${r.producible}/${r.files}; not producible: ${r.odd.join(', ')}`);
    assert('(exposure)', `snap: ShutterSpeedValue mirrors ExposureTime as in real ${kind} exports`,
      r.ssvMatch === r.ssvFiles, `${r.ssvMatch}/${r.ssvFiles}`);
  }

  const rows = data.rows;
  const bad = (k) => rows.filter(r => !r[k]).map(r => `${r.model} ${r.et}`);
  const unproducible = bad('producible');
  assert('(exposure)', `batch: every ExposureTime is one Adobe's rounding produces (${rows.length} identities)`,
    unproducible.length === 0, `${unproducible.length}: ${[...new Set(unproducible)].slice(0, 8).join(', ')}`);
  assert('(exposure)', 'batch: ShutterSpeedValue mirrors the written ExposureTime', bad('ssvOk').length === 0, bad('ssvOk').slice(0, 5).join(', '));
  assert('(exposure)', 'batch: ApertureValue mirrors the written FNumber', bad('avOk').length === 0, bad('avOk').slice(0, 5).join(', '));

  const night = rows.filter(r => r.sun < -6 && r.ev > 11);
  assert('(exposure)', 'batch: sun check (no EV>11 while sun < -6°)', night.length === 0,
    night.slice(0, 5).map(r => `${r.model} EV ${fmt(r.ev)} sun ${fmt(r.sun, 1)}°`).join(', '));

  const phones = rows.filter(r => r.phone);
  const share = (set, pred) => set.filter(pred).length / set.length;
  const near = n => r => Math.abs(r.seconds * n - 1) <= 0.02;
  // US phone photos sit at exactly 1/60 s in 11% of files (Apple 13%, Android
  // 1%) and at 1/50 or 1/100 s, the 50 Hz flicker times, in under 1%. At the
  // generator's own mix of scenes the expected share at 1/60 is about 10%; a
  // ladder that floors the phone shutter at 1/60 put 40% there. The bounds sit
  // more than five standard errors from the expected shares at this batch size.
  assert('(exposure)', 'batch: phones at exactly 1/60 s under 20%', share(phones, near(60)) < 0.2,
    `${(100 * share(phones, near(60))).toFixed(1)}% of ${phones.length}`);
  assert('(exposure)', 'batch: phones at the 50 Hz times 1/50 or 1/100 s under 3%',
    share(phones, r => near(50)(r) || near(100)(r)) < 0.03,
    `${(100 * share(phones, r => near(50)(r) || near(100)(r))).toFixed(1)}% of ${phones.length}`);

  // Each generated time and ISO against the real files of its table at the
  // same EV and f-number: the share of real files below it is uniform when
  // the draw follows the measured distribution, so the shares below the real
  // quartiles must be 25%, 50% and 75% within sampling error (4 standard
  // errors) plus 4 points for the half-stop EV window the draw uses instead
  // of the fixed 1-EV bins here.
  const files = {};
  for (const [name, table] of Object.entries(data.tables)) {
    files[name] = table.split('|').flatMap(group => {
      const fs = group.split(' ');
      return fs.map(s => { const [f, inv, iso] = s.split(',').map(Number); return { f, t: 1 / inv, iso, w: 1 / fs.length }; });
    });
  }
  const groups = { 'Apple phones': rows.filter(r => r.phone && r.apple), 'Android phones': rows.filter(r => r.phone && !r.apple),
                   'bodies': rows.filter(r => !r.phone) };
  for (const [label, set] of Object.entries(groups)) {
    const table = label === 'bodies' ? files.body : label === 'Apple phones' ? files.apple : files.android;
    for (const key of ['t', 'iso']) {
      const ranks = set.map(g => exposureRank(table, g, key)).filter(v => v != null);
      const n = ranks.length;
      for (const q of [0.25, 0.5, 0.75]) {
        const got = ranks.filter(v => v < q).length / n;
        const tol = 4 * Math.sqrt(q * (1 - q) / n) + 0.04;
        assert('(exposure)', `batch: ${label}' ${key === 't' ? 'exposure time' : 'ISO'} follows the real files at the same EV (${q * 100}% below the real ${q * 100}th percentile)`,
          Math.abs(got - q) <= tol, `${(100 * got).toFixed(1)}% of ${n}, allowed ${(100 * (q - tol)).toFixed(1)}-${(100 * (q + tol)).toFixed(1)}%`);
      }
    }
  }
}

// ── Keep original date ───────────────────────────────────────────
//
// A kept date and time is the capture exactly, and every other date fits
// after it: the export follows the capture by a drawn delay and neither has
// happened later than now in the generated place's own zone.

const KEEP_DRAWS = 150;

async function keepDateInBrowser(page) {
  return page.evaluate(async n => {
    const { generateFake } = await import('/js/exif.js');
    const { wallClockToUtc } = await import('/js/helpers.js');
    const now = Date.now(), DAY = 864e5;
    const at = ms => { const d = new Date(ms); d.setMilliseconds(0); return d; };
    const fixtures = {
      old: at(now - 2 * 365 * DAY), recent: at(now - 30 * 36e5),
      future: at(now + DAY), ancient: new Date(2001, 5, 1, 12, 0, 0),
    };
    const out = {};
    for (const [k, kept] of Object.entries(fixtures)) {
      out[k] = Array.from({ length: k === 'old' || k === 'recent' ? n : 20 }, () => {
        const g = generateFake({ originalDate: kept });
        return {
          kept: kept.getTime(), capture: g.capture.getTime(), exportAt: g.exportAt.getTime(),
          captureUtc: wallClockToUtc(g.capture, g.loc.tz).getTime(), exportUtc: wallClockToUtc(g.exportAt, g.loc.tz).getTime(),
          released: g.cam.released, dropped: g.keepDateDropped,
        };
      });
    }
    return { now: Date.now(), out };
  }, KEEP_DRAWS);
}

function keepDateChecks({ now, out }) {
  const F = '(keep date)';
  for (const k of ['old', 'recent']) {
    const rows = out[k];
    const bad = rows.filter(r => r.dropped || r.capture !== r.kept);
    assert(F, `keep date (${k}): Date Taken is the original date and time exactly`, bad.length === 0, `${bad.length} of ${rows.length} differ`);
    const order = rows.filter(r => !(r.exportAt > r.capture) || r.captureUtc > now || r.exportUtc > now);
    assert(F, `keep date (${k}): exported after capture, neither later than now in the place's zone`, order.length === 0,
      order.slice(0, 2).map(r => `capture ${new Date(r.capture).toISOString()} export ${new Date(r.exportAt).toISOString()}`).join(' | '));
    const early = rows.filter(r => new Date(`${r.released}T00:00:00`).getTime() > r.capture);
    assert(F, `keep date (${k}): camera released by the kept date`, early.length === 0, early.map(r => r.released).join(','));
    const lags = new Set(rows.map(r => Math.round((r.exportAt - r.capture) / 60000)));
    assert(F, `keep date (${k}): export delay is drawn, not fixed`, lags.size > rows.length / 2, `${lags.size} distinct delays in ${rows.length}`);
  }
  for (const [k, why] of [['future', 'future'], ['ancient', 'old']]) {
    const bad = out[k].filter(r => r.dropped !== why || r.capture === r.kept || r.captureUtc > now);
    assert(F, `keep date (${k}): replaced by a drawn date and reported as '${why}'`, bad.length === 0, `${bad.length} of ${out[k].length}`);
  }
}

/** The real UI path: one of this run's own outputs, loaded again with the box ticked. */
async function keepDateEndToEnd(page) {
  return page.evaluate(async () => {
    const src = S.items.find(it => it.modBlob && it.fakeExif && it.inputClass?.isPhoto);
    if (!src) return { error: 'no randomized photo output to reload' };
    const { parseFileExif } = await import('/js/exif.js');
    const blob = src.modBlob;                  // reset() releases the item's outputs
    const want = (await parseFileExif(blob)).DateTimeOriginal;
    App.reset();
    await App.loadFiles([new File([blob], 'keep-date-input.jpg', { type: 'image/jpeg' })]);
    const it = S.items[S.items.length - 1];
    App.select(it.id);
    document.getElementById('chkKeepDate').checked = true;
    await App.randomize();
    document.getElementById('chkKeepDate').checked = false;
    const out = await parseFileExif(it.modBlob);
    const got = out.DateTimeOriginal, modified = out.ModifyDate;
    const t = d => d instanceof Date ? d.getTime() : NaN;
    return { want: t(want), got: t(got), modified: t(modified), dropped: it.keepDateDropped, error: it.error };
  });
}

// ── Generated packets, in bulk ───────────────────────────────────
//
// The test images give a handful of outputs per run, too few to see a field
// that depends on the camera or is written at a share. These checks draw
// PACKET_SAMPLE identities in the page and build each one's XMP packet the way
// the app does.

const PACKET_SAMPLE = 400;
const xmpAttr = (x, k) => { const m = x.match(new RegExp(`\\b${k}="([^"]*)"`)); return m ? m[1] : null; };
const verAtLeast = (v, min) => {
  const a = v.split('.').map(Number), b = min.split('.').map(Number);
  for (let i = 0; i < Math.max(a.length, b.length); i++) { const d = (a[i] || 0) - (b[i] || 0); if (d) return d > 0; }
  return true;
};

async function samplePackets(page) {
  const { digests, lcp, rawLp } = await page.evaluate(async () => {
    const data = await import('/js/data.js');
    return {
      digests: Object.fromEntries(data.CAMERAS.filter(c => c.profileDigest).map(c => [c.model, c.profileDigest])),
      rawLp: data.CAMERAS.filter(c => c.rawLensProfile).map(c => c.model),
      lcp: Object.fromEntries(Object.values(data.DSLR_LENSES).flat().filter(l => l.lcp).map(l => [l.model, l.lcp])),
    };
  });
  const out = [];
  while (out.length < PACKET_SAMPLE) {           // in batches: one reply of every packet is too big
    out.push(...await page.evaluate(async n => {
      const ex = await import('/js/exif.js');
      const pv = await import('/js/provenance.js');
      return Array.from({ length: n }, () => {
        const g = ex.generateFake({});
        const xmp = pv.buildXmpPacket({
          capture: g.capture, exportAt: g.exportAt, offsetCapture: g.offset, offsetExport: g.exportOffset, subsec: g.subsec,
          lens: g.lensMeta, editor: g.editor, source: g.source, scene: g.scene, aux: g.aux,
        });
        return { model: g.cam.model, type: g.cam.type, software: g.editor.software,
                 lens: g.lens?.model || null,
                 xmp: xmp.slice(0, xmp.indexOf('</x:xmpmeta>')) };
      });
    }, 40));
  }
  return { digests, lcp, rawLp, out };
}

function packetChecks({ digests, lcp, rawLp, out }) {
  const F = '(packets)';
  const bodies = out.filter(p => p.type !== 'phone');
  assert(F, 'packets: sample includes camera bodies', bodies.length >= out.length / 10, bodies.length);

  // A raw export opens on Adobe Standard with the Adobe Color look, and the
  // profile digest is fixed per body: a random one matches no real profile.
  const badProfile = bodies.filter(p => xmpAttr(p.xmp, 'crs:CameraProfile') !== 'Adobe Standard'
    || xmpAttr(p.xmp, 'crs:CameraProfileDigest') !== digests[p.model]);
  assert(F, "packets: body carries Adobe Standard and its body's measured profile digest", badProfile.length === 0,
    badProfile.slice(0, 3).map(p => `${p.model}: ${xmpAttr(p.xmp, 'crs:CameraProfile')} ${xmpAttr(p.xmp, 'crs:CameraProfileDigest')}`).join(' | '));
  const badLook = bodies.filter(p => {
    const look = p.xmp.match(/<crs:Look>([\s\S]*?)<\/crs:Look>/);
    if (!look) return true;
    const top = p.xmp.replace(look[0], '');
    return xmpAttr(look[1], 'crs:Name') !== 'Adobe Color' || xmpAttr(look[1], 'crs:Version') !== xmpAttr(top, 'crs:Version')
      || /crs:ConvertToGrayscale=/.test(top);
  });
  assert(F, 'packets: body carries the Adobe Color look at its own crs:Version', badLook.length === 0,
    badLook.slice(0, 3).map(p => `${p.model} ${p.software}`).join(' | '));
  const badCv = out.filter(p => {
    const top = p.xmp.replace(/<crs:Look>[\s\S]*?<\/crs:Look>/, '');
    return /<crs:ColorVariance>/.test(top) !== verAtLeast(xmpAttr(top, 'crs:Version'), '17.5');
  });
  assert(F, 'packets: ColorVariance present exactly from crs 17.5', badCv.length === 0,
    badCv.slice(0, 3).map(p => p.software).join(' | '));

  // Lens-profile correction names a profile, and that profile is specific to
  // the lens: it is on only where a real export showed which one Camera Raw
  // names, and then names exactly that one.
  const on = bodies.filter(p => xmpAttr(p.xmp, 'crs:LensProfileEnable') === '1');
  const badLens = out.filter(p => {
    const name = xmpAttr(p.xmp, 'crs:LensProfileName');
    if (xmpAttr(p.xmp, 'crs:LensProfileEnable') !== '1') return name !== null;
    const want = !rawLp.includes(p.model) && lcp[p.lens];
    return !want || name !== want.name.replace(/&/g, '&amp;') || xmpAttr(p.xmp, 'crs:LensProfileDigest') !== want.digest;
  });
  assert(F, 'packets: lens-profile correction on only with the profile measured for that lens', badLens.length === 0,
    badLens.slice(0, 3).map(p => `${p.model} + ${p.lens}: ${xmpAttr(p.xmp, 'crs:LensProfileName')}`).join(' | '));
  assert(F, 'packets: some body exports have lens-profile correction on', on.length > 0, `${on.length} of ${bodies.length}`);
  const badUnit = out.filter(p => /crs:CropConstrainToUnitSquare=/.test(p.xmp) !== verAtLeast(xmpAttr(p.xmp, 'crs:Version'), '17.3'));
  assert(F, 'packets: CropConstrainToUnitSquare present exactly from crs 17.3', badUnit.length === 0,
    badUnit.slice(0, 3).map(p => p.software).join(' | '));

  // DerivedFrom names the source file by the ID the packet gives it, with no
  // instance ID, as real exports of a phone JPEG and of a raw file do.
  const badDerived = out.filter(p => {
    const df = (p.xmp.match(/<xmpMM:DerivedFrom([\s\S]*?)\/>/) || [])[1] || '';
    const orig = xmpAttr(p.xmp, 'xmpMM:OriginalDocumentID');
    return !/^[0-9A-F]{32}$/.test(orig || '') || xmpAttr(df, 'stRef:documentID') !== orig
      || xmpAttr(df, 'stRef:originalDocumentID') !== orig || /stRef:instanceID=/.test(df);
  });
  assert(F, 'packets: DerivedFrom is the source ID twice, no instance ID', badDerived.length === 0,
    badDerived.slice(0, 2).map(p => `${p.model}: ${(p.xmp.match(/<xmpMM:DerivedFrom[\s\S]*?\/>/) || [''])[0].replace(/\s+/g, ' ')}`).join(' | '));

  // Auto tone: written at the share real exports show (JPEG 16/31, raw
  // 12/37), always as a pair, with a value of its own in every file.
  for (const [label, set, lo, hi] of [['phone JPEG', out.filter(p => p.type === 'phone'), 0.35, 0.70],
                                      ['raw', bodies, 0.15, 0.50]]) {
    const withAt = set.filter(p => xmpAttr(p.xmp, 'crs:AutoToneDigest'));
    const share = withAt.length / Math.max(1, set.length);
    assert(F, `packets: AutoToneDigest share on ${label} exports in [${lo}, ${hi}]`, share >= lo && share <= hi,
      `${withAt.length} of ${set.length}`);
  }
  const digestsAt = out.map(p => xmpAttr(p.xmp, 'crs:AutoToneDigest')).filter(Boolean);
  const unpaired = out.filter(p => !xmpAttr(p.xmp, 'crs:AutoToneDigest') !== !xmpAttr(p.xmp, 'crs:AutoToneDigestNoSat'));
  assert(F, 'packets: AutoToneDigest always paired with NoSat and never repeated',
    unpaired.length === 0 && new Set(digestsAt).size === digestsAt.length, `${unpaired.length} unpaired`);
}

/**
 * The XMP crop must describe what was done to the pixels: the corners it
 * names, in the input's pixel space and turned back by CropAngle, span a
 * rectangle with the output's own shape. Adobe's convention, measured on real
 * straightened exports, is a TL-to-BR diagonal of R(CropAngle)·(w, h).
 */
function cropChecks(name, t, info, src) {
  const g = k => num(tag(t, k, 'XMP-crs'));
  const hasCrop = String(tag(t, 'HasCrop', 'XMP-crs'));
  if (!assert(name, 'exiftool: XMP HasCrop is True (the pixels were cropped)', /^(True|1|true)$/.test(hasCrop), `HasCrop=${hasCrop}`)) return;
  const [L, T, R, B, A] = ['CropLeft', 'CropTop', 'CropRight', 'CropBottom', 'CropAngle'].map(g);
  const inside = [L, T, R, B].every(v => v >= 0 && v <= 1) && L < R && T < B && Math.abs(A) <= 2.0;
  assert(name, 'exiftool: crop rectangle inside the frame, angle within the rotation range', inside, `L=${L} T=${T} R=${R} B=${B} A=${A}`);
  if (!src || !info.width) return;
  const th = A * Math.PI / 180, dx = (R - L) * src.width, dy = (B - T) * src.height;
  const w = dx * Math.cos(th) + dy * Math.sin(th), h = -dx * Math.sin(th) + dy * Math.cos(th);
  const err = Math.abs(Math.log((w / h) / (info.width / info.height)));
  assert(name, 'exiftool: crop rectangle and angle give the output shape (±1%)', err < 0.01,
    `crop ${fmt(w, 0)}x${fmt(h, 0)} at ${A}° vs output ${info.width}x${info.height}`);
}

// ── Main ─────────────────────────────────────────────────────────

async function main() {
  const t0 = Date.now();
  const names = fs.readdirSync(TESTIMG).filter(f => /\.jpe?g$/i.test(f)).sort();
  if (!names.length) throw new Error(`no test images in ${TESTIMG}`);
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(path.join(OUT_DIR, '.gitignore'), '*\n');
  for (const f of fs.readdirSync(OUT_DIR)) if (/\.jpg$/i.test(f)) fs.unlinkSync(path.join(OUT_DIR, f));

  const server = await cdp.startStaticServer(ROOT);
  console.log(`static server: ${server.origin}`);
  let chrome = null;
  const fileRows = [];
  try {
    chrome = await cdp.launchChrome();
    console.log(`chrome: ${chrome.exe} (${chrome.version.Browser})`);
    const page = chrome.page;
    const rec = await cdp.instrumentPage(page);

    await page.navigate(`${server.origin}/index.html`, { timeoutMs: 30000 });
    const appType = await cdp.waitForApp(page);
    assert('(page)', 'app: window.App defined', appType === 'object' || appType === 'function', `typeof window.App = ${appType}`);

    let items = [];
    try {
      items = await processInBrowser(page, server.origin, names);
    } catch (e) {
      assert('(page)', 'app: processing ran without throwing', false, e.message);
    }
    try {
      exposureChecks(await exposureInBrowser(page, server.origin, EXPOSURE_BATCH));
    } catch (e) {
      assert('(exposure)', 'exposure checks ran without throwing', false, e.stack || e.message);
    }

    const draws = await page.evaluate(async n => {
      const { generateFake } = await import('/js/exif.js');
      return Array.from({ length: n }, () => { const { loc } = generateFake({}); return [loc.lat, loc.lon]; });
    }, LOCATION_DRAWS);
    const offLand = draws.filter(([lat, lon]) => !onUsLand(lat, lon));
    assert('(page)', `gps: ${draws.length} generated locations all on US land`, offLand.length === 0,
      `${offLand.length} off US land, e.g. ${offLand.slice(0, 4).map(p => p.join(', ')).join(' | ')}`);
    try {
      packetChecks(await samplePackets(page));
    } catch (e) {
      assert('(packets)', 'packets: sampling ran without throwing', false, e.message);
    }
    try {
      keepDateChecks(await keepDateInBrowser(page));
      const e2e = await keepDateEndToEnd(page);
      assert('(keep date)', "keep date: the UI keeps the input's exact Date Taken", !e2e.error && !e2e.dropped && e2e.got === e2e.want,
        e2e.error || `want ${new Date(e2e.want).toISOString()} got ${new Date(e2e.got).toISOString()} (${e2e.dropped})`);
      assert('(keep date)', "keep date: the UI output's Date Modified is after its Date Taken", e2e.modified > e2e.got,
        `taken ${new Date(e2e.got).toISOString()} modified ${new Date(e2e.modified).toISOString()}`);
    } catch (e) {
      assert('(keep date)', 'keep date: checks ran without throwing', false, e.stack || e.message);
    }

    // Network privacy: everything must be local.
    const allowed = u => u.startsWith(`${server.origin}/`) || u.startsWith('blob:') || u.startsWith('data:');
    const foreign = [...new Set(rec.requests.filter(u => !allowed(u)))];
    assert('(page)', `network: all ${rec.requests.length} requests local (127.0.0.1 / blob: / data:)`, foreign.length === 0, foreign.join(', '));
    const localUrls = [...new Set(rec.requests.filter(allowed).filter(u => !u.startsWith('blob:') && !u.startsWith('data:')))];
    console.log(`network: ${rec.requests.length} requests; local URLs: ${localUrls.map(u => u.replace(server.origin, '')).join(' ')}`);

    assert('(page)', 'console: no uncaught exceptions', rec.exceptions.length === 0, rec.exceptions.join(' | '));
    assert('(page)', 'console: no console.error calls', rec.consoleErrors.length === 0, rec.consoleErrors.join(' | '));
    assert('(page)', 'console: no error-level log entries (CSP, failed loads)', rec.logErrors.length === 0, rec.logErrors.join(' | '));

    // Byte checks + write outputs.
    const seen = new Map();
    for (const it of items) {
      const base = it.name.replace(/\.jpe?g$/i, '');
      const n = (seen.get(`${base}.${it.mode}`) || 0) + 1;
      seen.set(`${base}.${it.mode}`, n);
      const outName = `${base}.${it.mode}${n > 1 ? '.' + n : ''}.jpg`;
      const row = { name: outName, mode: it.mode, size: 0, dims: '', camera: it.camera, city: it.city, date: it.date, layout: '', exif: {} };
      fileRows.push(row);
      if (!assert(outName, 'app: item processed without error', !it.error, it.error)) continue;
      if (!assert(outName, 'app: modBlob produced', it.hasBlob && it.b64, 'no modBlob')) continue;
      const buf = Buffer.from(it.b64, 'base64');
      row.size = buf.length;
      row.path = path.join(OUT_DIR, outName);
      fs.writeFileSync(row.path, buf);
      const info = byteChecks(outName, buf, it.mode);
      // The user's real filename must never reach the output, in any segment.
      const stem = it.name.replace(/\.[^.]+$/, '');
      assert(outName, 'privacy: input filename absent from output bytes',
        !buf.includes(Buffer.from(stem, 'utf8')), `found "${stem}"`);
      row.layout = info.layout;
      row.dims = info.width ? `${info.width}x${info.height}` : '?';
      row.info = info;
      const srcFile = path.join(TESTIMG, it.noExtCase ? names[0] : it.name);
      const srcSof = fs.existsSync(srcFile) && walkJpeg(fs.readFileSync(srcFile)).segments.find(s => s.marker === 0xC0 || s.marker === 0xC2);
      row.src = srcSof ? parseSof(srcSof) : null;
    }
  } finally {
    if (chrome) await chrome.close();
    await server.close();
  }

  // exiftool block.
  const written = fileRows.filter(r => r.path);
  const et = findExiftool();
  if (!et) {
    skipped.push('exiftool not found on PATH or at the known install locations — metadata assertions SKIPPED');
  } else if (written.length) {
    console.log(`exiftool: ${et.exe} (v${et.version})`);
    try {
      const json = runExiftool(et.exe, written.map(r => r.path));
      const byFile = new Map(json.map(o => [path.basename(String(o.SourceFile)), o]));
      for (const row of written) {
        const t = byFile.get(row.name);
        if (!assert(row.name, 'exiftool: produced output for file', !!t, 'no JSON object for this file')) continue;
        row.exif = t;
        exiftoolChecks(row.name, t, row.mode, row.info);
        if (row.mode === 'randomized') cropChecks(row.name, t, row.info, row.src);
      }
    } catch (e) {
      assert('(exiftool)', 'exiftool: ran successfully', false, e.message);
    }
  }

  report(fileRows, Date.now() - t0);
  const failures = results.filter(r => !r.ok);
  process.exitCode = failures.length ? 1 : 0;
}

function pad(s, n) { s = String(s); return s.length >= n ? s : s + ' '.repeat(n - s.length); }

function report(rows, elapsedMs) {
  console.log('');
  console.log('OUTPUT FILES');
  const head = ['file', 'mode', 'bytes', 'dims', 'camera', 'city', 'bytes-chk', 'exiftool'];
  const table = rows.map(r => {
    const mine = results.filter(x => x.file === r.name);
    const byteFails = mine.filter(x => !x.ok && !x.check.startsWith('exiftool:')).length;
    const etAll = mine.filter(x => x.check.startsWith('exiftool:'));
    const etFails = etAll.filter(x => !x.ok).length;
    return [r.name, r.mode, r.size ? String(r.size) : '-', r.dims || '-', r.camera || '-', r.city || '-',
      byteFails ? `FAIL(${byteFails})` : 'ok', etAll.length ? (etFails ? `FAIL(${etFails})` : 'ok') : 'skip'];
  });
  const widths = head.map((h, i) => Math.max(h.length, ...table.map(r => r[i].length)));
  const line = r => '  ' + r.map((c, i) => pad(c, widths[i])).join('  ');
  console.log(line(head));
  console.log('  ' + widths.map(w => '-'.repeat(w)).join('  '));
  for (const r of table) console.log(line(r));
  for (const r of rows) if (r.layout) console.log(`  ${r.name}: ${r.layout}`);

  console.log('');
  console.log('ASSERTIONS');
  const byCheck = new Map();
  for (const r of results) {
    if (!byCheck.has(r.check)) byCheck.set(r.check, { pass: 0, fail: 0 });
    byCheck.get(r.check)[r.ok ? 'pass' : 'fail']++;
  }
  const cw = Math.max(...[...byCheck.keys()].map(k => k.length));
  for (const [check, c] of byCheck) {
    console.log(`  ${c.fail ? 'FAIL' : 'PASS'}  ${pad(check, cw)}  ${c.pass} pass / ${c.fail} fail`);
  }
  for (const s of skipped) console.log(`  SKIPPED  ${s}`);

  const failures = results.filter(r => !r.ok);
  if (failures.length) {
    console.log('');
    console.log(`FAILURES (${failures.length})`);
    for (const f of failures) console.log(`  ${f.file}: ${f.check}${f.detail ? ' — ' + f.detail : ''}`);
  }
  console.log('');
  console.log(`${failures.length ? 'FAIL' : 'PASS'}: ${results.length - failures.length}/${results.length} assertions passed in ${(elapsedMs / 1000).toFixed(1)}s; outputs in ${OUT_DIR}`);
}

main().catch(e => {
  console.error('check.js crashed:', e.stack || e);
  process.exit(2);
});
