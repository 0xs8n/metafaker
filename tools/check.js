#!/usr/bin/env node
/**
 * check.js — end-to-end output check for MetaFaker.
 *
 * Serves the repo on 127.0.0.1, drives the real app in headless Chrome over
 * the DevTools protocol, pulls every processed JPEG back out, and asserts on
 * the bytes (segment layout, forbidden encoder strings) and, when exiftool is
 * available, on the metadata (validation, internal consistency, plausibility).
 *
 *   node tools/check.js            # all testimg/*.jpg
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

  // Common structure
  assert(name, 'jpeg: exactly one SOI before SOS', countBytes(buf, Buffer.from([0xFF, 0xD8]), walk.sosOffset) === 1,
    `found ${countBytes(buf, Buffer.from([0xFF, 0xD8]), walk.sosOffset)} x FFD8 before SOS (embedded thumbnail?)`);
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
  } else {
    assert(name, 'jpeg: no APP1', app1.length === 0, `${app1.length} APP1: ${app1.map(describeApp).join(',')}`);
    assert(name, 'jpeg: no APP2', app2.length === 0, `${app2.length} APP2: ${app2.map(describeApp).join(',')}`);
  }

  // No unexpected application segments either way.
  const allowed = mode === 'randomized' ? new Set([0xE1, 0xE2, 0xEE]) : new Set([0xEE]);
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

  const validate = tag(t, 'Validate', 'ExifTool');
  assert(name, 'exiftool: Validate == OK', validate === 'OK' || /^(0\s*)+$/.test(String(validate)), String(validate));
  assert(name, 'exiftool: no Warning', warnings.length === 0, warnings.join(' | '));

  const make = tag(t, 'Make', 'IFD0'), model = tag(t, 'Model', 'IFD0');
  assert(name, 'exiftool: Make/Model present', !!make && !!model, `Make=${make} Model=${model}`);
  const software = tag(t, 'Software', 'IFD0');
  assert(name, 'exiftool: Software is Adobe Camera Raw', typeof software === 'string' && software.startsWith('Adobe Photoshop Camera Raw'), `Software=${software}`);

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
  assert(name, 'exiftool: GPSLatitude in [18, 72]', lat >= 18 && lat <= 72, `lat=${lat}`);
  assert(name, 'exiftool: GPSLongitude in [-180, -65]', lon >= -180 && lon <= -65, `lon=${lon}`);

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

  const thumbKeys = Object.keys(t).filter(k => /:(ThumbnailImage|ThumbnailOffset|ThumbnailLength)$/.test(k));
  assert(name, 'exiftool: no thumbnail tags', thumbKeys.length === 0, thumbKeys.join(','));
  const jfif = groupKeys(t, 'JFIF');
  assert(name, 'exiftool: no JFIF tags', jfif.length === 0, jfif.join(','));
  const copyright = tag(t, 'ProfileCopyright', 'ICC-header') ?? tag(t, 'ProfileCopyright');
  assert(name, 'exiftool: ICC ProfileCopyright not Google', !(typeof copyright === 'string' && /Google/i.test(copyright)), `ProfileCopyright=${copyright}`);

  const ew = num(tag(t, 'ExifImageWidth', 'ExifIFD')), eh = num(tag(t, 'ExifImageHeight', 'ExifIFD'));
  assert(name, 'exiftool: ExifImageWidth/Height == SOF0', ew === info.width && eh === info.height, `Exif=${ew}x${eh} SOF0=${info.width}x${info.height}`);

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

async function processInBrowser(page, origin, names) {
  // Load all images, randomize the batch, then load the first image a second
  // time and strip it — so one output of each kind exists.
  const summary = await page.evaluate(async (base, names) => {
    const toFile = async n => {
      const r = await fetch(`${base}/testimg/${n}`);
      if (!r.ok) throw new Error(`fetch ${n}: HTTP ${r.status}`);
      return new File([await r.blob()], n, { type: 'image/jpeg' });
    };
    const files = [];
    for (const n of names) files.push(await toFile(n));
    await App.loadFiles(files);
    await App.randomizeAll();
    const dup = await toFile(names[0]);
    await App.loadFiles([dup]);
    App.select(S.items[S.items.length - 1].id);
    await App.clear();
    return S.items.map((it, i) => ({
      index: i,
      name: it.file.name,
      error: it.error,
      hasBlob: !!it.modBlob,
      size: it.modBlob ? it.modBlob.size : 0,
      mode: it.fakeExif ? 'randomized' : 'stripped',
      camera: it.fakeCamera ? `${it.fakeCamera.make} ${it.fakeCamera.model}` : '',
      city: it.fakeLocation ? it.fakeLocation.city : '',
      date: it.fakeDate ? new Date(it.fakeDate).toISOString() : '',
    }));
  }, origin, names);

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
      row.layout = info.layout;
      row.dims = info.width ? `${info.width}x${info.height}` : '?';
      row.info = info;
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
