/**
 * exif.js — Metadata generation, parsing, and display.
 *
 * generateFake() builds the metadata of a photo exported from Adobe Camera
 * Raw (camera bodies, from a raw file) or Adobe Lightroom (phones, from a
 * JPEG). The tag values that survive an export are written in the exact form
 * each camera's firmware uses, read from real sample files; the tags Adobe
 * drops or rewrites are dropped or rewritten the way the measured exports do.
 */

import exifr from '../vendor/exifr.esm.js';
import { ICONS } from './icons.js';
import {
  pick, randInt, clamp, cryptoRandInt,
  jitterLocation, fmtDate, fmtGpsDate,
  wallClockToUtc, tzOffsetString, sunElevation,
  dmsToDec, dataUrlToBlob,
  fromRat, cleanExifStr, escapeHtml,
} from './helpers.js';
import { CAMERAS, LOCATIONS, pickOptics } from './data.js';
import { pickEditor } from './provenance.js';
import { rnd } from './rng.js';

// ── EXIF Parsing ─────────────────────────────────────────────────

export async function parseFileExif(file) {
  try {
    const raw = await exifr.parse(file, { all: true, gps: true, tiff: true, exif: true, iptc: true });
    return raw || {};
  } catch (e) {
    return {};
  }
}

export function piexifToDisplay(pxData) {
  const px = window.piexif;
  const z = pxData?.["0th"]  || {};
  const e = pxData?.["Exif"] || {};
  const g = pxData?.["GPS"]  || {};
  const out = {};
  const set = (key, val) => {
    if (val == null) return;
    if (typeof val === 'number' && Number.isNaN(val)) return;
    out[key] = val;
  };

  set('Make',        cleanExifStr(z[px.ImageIFD.Make]));
  set('Model',       cleanExifStr(z[px.ImageIFD.Model]));
  set('Software',    cleanExifStr(z[px.ImageIFD.Software]));
  set('DateTime',    cleanExifStr(z[px.ImageIFD.DateTime]));
  set('XResolution', fromRat(z[px.ImageIFD.XResolution]));
  set('YResolution', fromRat(z[px.ImageIFD.YResolution]));
  set('Orientation', z[px.ImageIFD.Orientation]);

  set('ExposureTime',           fromRat(e[px.ExifIFD.ExposureTime]));
  set('FNumber',                fromRat(e[px.ExifIFD.FNumber]));
  set('ISO',                    e[px.ExifIFD.ISOSpeedRatings]);
  set('DateTimeOriginal',       cleanExifStr(e[px.ExifIFD.DateTimeOriginal]));
  set('FocalLength',            fromRat(e[px.ExifIFD.FocalLength]));
  set('FocalLengthIn35mmFormat', e[px.ExifIFD.FocalLengthIn35mmFilm]);
  set('Flash',                  e[px.ExifIFD.Flash]);
  set('MeteringMode',           e[px.ExifIFD.MeteringMode]);
  set('ExposureProgram',        e[px.ExifIFD.ExposureProgram]);
  set('WhiteBalance',           e[px.ExifIFD.WhiteBalance]);
  set('ColorSpace',             e[px.ExifIFD.ColorSpace]);
  set('ExposureMode',           e[px.ExifIFD.ExposureMode]);
  set('SceneCaptureType',       e[px.ExifIFD.SceneCaptureType]);
  set('SensingMethod',          e[px.ExifIFD.SensingMethod]);
  set('LensMake',               cleanExifStr(e[px.ExifIFD.LensMake]));
  set('LensModel',              cleanExifStr(e[px.ExifIFD.LensModel]));
  set('SubSecTimeOriginal',     cleanExifStr(e[px.ExifIFD.SubSecTimeOriginal]));
  set('PixelXDimension',        e[px.ExifIFD.PixelXDimension]);
  set('PixelYDimension',        e[px.ExifIFD.PixelYDimension]);

  const latRef = cleanExifStr(g[px.GPSIFD.GPSLatitudeRef]);
  const lonRef = cleanExifStr(g[px.GPSIFD.GPSLongitudeRef]);
  set('GPSLatitude',  dmsToDec(g[px.GPSIFD.GPSLatitude], latRef));
  set('GPSLongitude', dmsToDec(g[px.GPSIFD.GPSLongitude], lonRef));
  const alt = fromRat(g[px.GPSIFD.GPSAltitude]);
  if (typeof alt === 'number') set('GPSAltitude', g[px.GPSIFD.GPSAltitudeRef] === 1 ? -alt : alt);

  return out;
}

export async function readBackExifStrict(dataUrl) {
  const blob = dataUrlToBlob(dataUrl);
  let exifrErr = null;
  try {
    const parsed = await exifr.parse(blob, { all: true, gps: true, tiff: true, exif: true });
    if (parsed && Object.keys(parsed).length) {
      return { blob, exif: parsed, parser: 'exifr', warning: null };
    }
    exifrErr = new Error('exifr returned no fields');
  } catch (e) {
    exifrErr = e;
  }
  try {
    const parsed = piexifToDisplay(window.piexif.load(dataUrl));
    if (Object.keys(parsed).length) {
      return { blob, exif: parsed, parser: 'piexif',
               warning: `EXIF was written, but exifr readback failed (${exifrErr?.message || 'unknown error'}).` };
    }
  } catch (e) {
    const exifrMsg = exifrErr?.message || 'unknown exifr error';
    throw new Error(`Metadata verification failed (exifr: ${exifrMsg}; piexif: ${e.message})`);
  }
  throw new Error(`Metadata verification failed (${exifrErr?.message || 'no readable EXIF found'})`);
}

// ── Rational encoders ────────────────────────────────────────────

const gcd = (a, b) => (b ? gcd(b, a % b) : a);
const reduce = (n, d) => { const g = gcd(Math.abs(n), d) || 1; return [n / g, d / g]; };
const ratFixed = (v, den) => [Math.round(v * den), den];

/**
 * Apple's rationals are the continued-fraction convergent of the float32
 * value, taken at the first convergent that agrees to about nine digits:
 * f/1.78 becomes 1244236/699009, a 6.765 mm focal length 251773/37217.
 */
function ratFloat32(v) {
  const f = Math.fround(v);
  if (f === 0) return [0, 1];
  const neg = f < 0;
  let a = Math.abs(f);
  let h0 = 0, h1 = 1, k0 = 1, k1 = 0;
  for (let i = 0; i < 40; i++) {
    const ai = Math.floor(a);
    [h0, h1] = [h1, ai * h1 + h0];
    [k0, k1] = [k1, ai * k1 + k0];
    if (k1 > 100000000) break;
    if (Math.abs(h1 / k1 - Math.abs(f)) <= 1e-9 * Math.abs(f)) break;
    if (a - ai === 0) break;
    a = 1 / (a - ai);
  }
  return [neg ? -h1 : h1, k1];
}

/** APEX shutter/aperture value, as Adobe rewrites it on export: N/1000000, or N/1 when integral. */
function apexMicro(v) {
  const r = Math.round(v);
  if (Math.abs(v - r) < 1e-9) return [r, 1];
  return [Math.round(v * 1000000), 1000000];
}

/** Lens specification rationals, "24/1 70/1 28/10 28/10" in the EXIF and XMP. */
function specRat(v) {
  if (Number.isInteger(v)) return [v, 1];
  if (Math.abs(v * 10 - Math.round(v * 10)) < 1e-9) return [Math.round(v * 10), 10];
  return [Math.round(v * 100), 100];
}
function lensInfoString(spec) {
  return spec.map(([n, d]) => `${n}/${d}`).join(' ');
}

/** GPS coordinate in the form the exporter writes: degrees, decimal minutes over 1e7, zero seconds. */
function adobeGps(abs) {
  const d = Math.floor(abs);
  const m = (abs - d) * 60;
  return [[d, 1], [Math.round(m * 1e7), 1e7], [0, 1]];
}

// ── Per-firmware encodings ───────────────────────────────────────
//
// What each camera writes, and how, among the tags that survive an Adobe
// export. Keyed by the `writer` field in data.js. Bodies (canon/nikon/sony/
// fuji) export from a raw file through Camera Raw and keep the FocalPlane and
// sensor-origin tags; phones export from a JPEG through Lightroom and do not.

const WRITERS = {
  apple: {
    kind: 'phone',
    fnumber: 'lens', focal: 'lens',
    expComp: 1, brightness: 'cf', maxAperture: null, sensitivity: null,
    flashOff: [16], flashFired: 25, metering: [5],
    lensTags: ['make', 'model', 'info'], lensMake: 'Apple',
    gpsVersion: null, dirRef: 'T',
    extras: { focalEquiv: true, digitalZoom: 'zoom', sensing: true, sceneType: true },
  },
  google: {
    kind: 'phone',
    fnumber: 'lens', focal: 'lens',
    expComp: 6, brightness: 100, maxAperture: 100, sensitivity: null,
    flashOff: [16], flashFired: 1, metering: [2],
    lensTags: ['make', 'model'], lensMake: 'Google',
    gpsVersion: [2, 2, 0, 0], dirRef: 'M',
    extras: { focalEquiv: true, digitalZoom: 'always', customRendered: 1, sensing: true, sceneType: true,
              contrast: true, subjectDistanceRange: true },
  },
  samsung: {
    kind: 'phone',
    fnumber: 'lens', focal: 'lens',
    expComp: 100, brightness: 100, maxAperture: 'apex', sensitivity: null,
    flashOff: [0], flashFired: 1, metering: [2],
    lensTags: [], gpsVersion: [2, 2, 0, 0], dirRef: 'M',
    extras: { focalEquiv: true, digitalZoom: 'always' },
  },
  samsungA: {
    kind: 'phone',
    fnumber: 'lens', focal: 'lens',
    expComp: 10, brightness: 100, maxAperture: 'apex', sensitivity: null,
    flashOff: [0], flashFired: 1, metering: [2],
    lensTags: [], gpsVersion: [2, 2, 0, 0], dirRef: 'M',
    extras: { focalEquiv: true, digitalZoom: 'always', customRendered: 0, sensing: true, sceneType: true,
              contrast: true },
  },
  oneplus: {
    kind: 'phone',
    fnumber: 'lens', focal: 'lens',
    expComp: 6, brightness: 100, maxAperture: 'apex', sensitivity: null,
    flashOff: [16], flashFired: 1, metering: [2],
    lensTags: ['model'], lensMake: null,
    gpsVersion: null, dirRef: 'M',
    extras: { focalEquiv: true, digitalZoom: 'always', sensing1: true, sceneType: true },
  },
  xiaomi: {
    kind: 'phone',
    fnumber: 'lens', focal: 'lens',
    expComp: 6, brightness: 100, maxAperture: 'apex', sensitivity: 3,
    flashOff: [16], flashFired: 1, metering: [2],
    lensTags: [], gpsVersion: null, dirRef: 'M',
    extras: { focalEquiv: true, sensing1: true, sceneType: true, lightSource: 21 },
  },
  canon: {
    kind: 'body',
    fnumber: 10, focal: 1,
    expComp: 1, brightness: null, maxAperture: 'adobe100', sensitivity: 2,
    flashOff: [0], flashFired: 9, metering: [5, 5, 5, 2, 3],
    lensTags: ['info', 'model', 'serial'], lensMake: null, lensInfoApertureZero: true,
    gpsVersion: [2, 3, 0, 0], serial: 12,
    extras: { focalPlane: true, customRendered: 0, serialNumber: true, status: true, mapDatum: true },
  },
  nikon: {
    kind: 'body',
    fnumber: 100, focal: 10,
    expComp: 6, brightness: null, maxAperture: null, sensitivity: 2,
    flashOff: [0], flashFired: 9, metering: [5, 5, 5, 2, 3],
    lensTags: ['info', 'model', 'make', 'serial'], lensMake: 'NIKON', lensAdobe: true,
    gpsVersion: [2, 3, 0, 0], serial: 7,
    extras: { focalPlane: true, focalPlaneUnit: 3, sensing: true, fileSource: true, sceneType: true,
              cfa: true, customRendered: 1, focalEquiv: true, gainControl: true, contrast: true,
              subjectDistanceRange: true, serialNumber: true },
  },
  sony: {
    kind: 'body',
    fnumber: 10, focal: 10,
    expComp: 10, brightness: 2560, maxAperture: 256, sensitivity: 2,
    flashOff: [16], flashFired: 9, metering: [5, 5, 5, 2, 3],
    lensTags: ['info', 'model'], lensMake: null,
    gpsVersion: [2, 3, 0, 0],
    extras: { focalPlane: true, focalPlaneUnit: 3, fileSource: true, sceneType: true, customRendered: 0,
              focalEquiv: true, digitalZoom: 'always', contrast: true, lightSource: 0 },
  },
  fuji: {
    kind: 'body',
    fnumber: 100, focal: 100,
    expComp: 100, brightness: 100, maxAperture: 100, sensitivity: 1,
    flashOff: [0], flashFired: 9, metering: [5, 5, 5, 2, 3],
    lensTags: ['info', 'model', 'make', 'serial'], lensMake: 'FUJIFILM',
    gpsVersion: [2, 3, 0, 0], serial: 8,
    extras: { focalPlane: true, focalPlaneUnit: 3, sensing: true, fileSource: true, sceneType: true,
              customRendered: 0, focalEquiv: true, sharpness: true, subjectDistanceRange: true,
              serialNumber: true, lightSource: 0 },
  },
};

// ── Exposure ─────────────────────────────────────────────────────

const SCENES = {
  daylight: { evMin: 13, evMax: 16, dark: false },
  overcast: { evMin: 10, evMax: 13, dark: false },
  indoor:   { evMin:  6, evMax:  9, dark: false },
  dim:      { evMin:  3, evMax:  6, dark: true  },
  night:    { evMin:  0, evMax:  3, dark: true  },
};

function weightedPick(weights) {
  const entries = Object.entries(weights);
  let r = rnd() * entries.reduce((n, [, w]) => n + w, 0);
  for (const [k, w] of entries) { r -= w; if (r <= 0) return k; }
  return entries[0][0];
}

/** The scene follows the sun's elevation at the claimed place and time. */
function pickScene(sunEl) {
  let w;
  if      (sunEl > 25) w = { daylight: 55, overcast: 25, indoor: 20 };
  else if (sunEl >  8) w = { daylight: 35, overcast: 35, indoor: 25, dim: 5 };
  else if (sunEl > -6) w = { overcast: 20, indoor: 45, dim: 30, night: 5 };
  else                 w = { indoor: 50, dim: 30, night: 20 };
  const name = weightedPick(w);
  return { name, ...SCENES[name] };
}

const HOUR_WEIGHTS = [1, 1, 1, 1, 1, 1, 2, 4, 6, 8, 8, 8, 9, 9, 9, 9, 9, 9, 8, 7, 5, 4, 2, 1.5];
function pickHour() {
  return Number(weightedPick(Object.fromEntries(HOUR_WEIGHTS.map((w, i) => [i, w]))));
}

const HOUR = 36e5, DAY = 864e5;

/**
 * Solve a physically consistent shutter/ISO pair for a scene and aperture:
 * N²/t = (ISO/100)·2^EV. Picking the three independently produced frames no
 * scene could have produced.
 */
function solveExposure(cam, aperture, ev, focalEquiv) {
  const isos = [...cam.isos].sort((a, b) => a - b);
  const seconds = s => s[0] / s[1];
  const slowest = cam.type === 'phone'
    ? 1 / 60
    : clamp(1 / Math.max(focalEquiv, 1), 1 / 250, 1 / 30);
  const required = iso => 100 * aperture * aperture / (iso * Math.pow(2, ev));
  let iso = isos[isos.length - 1];
  for (const candidate of isos) {
    if (required(candidate) <= slowest) { iso = candidate; break; }
  }
  const want = required(iso);
  let shutter = cam.shutters[0];
  let bestErr = Infinity;
  for (const s of cam.shutters) {
    const err = Math.abs(Math.log2(seconds(s)) - Math.log2(want));
    if (err < bestErr) { bestErr = err; shutter = s; }
  }
  return { shutter, iso };
}

function cameraEvRange(cam, aperture) {
  const secs = cam.shutters.map(s => s[0] / s[1]);
  const evAt = (t, iso) => Math.log2(aperture * aperture / t) - Math.log2(iso / 100);
  return [evAt(Math.max(...secs), Math.max(...cam.isos)), evAt(Math.min(...secs), Math.min(...cam.isos))];
}

function apexBrightness(aperture, exposureSec, iso) {
  return 2 * Math.log2(aperture) - Math.log2(exposureSec) - Math.log2(iso / 3.125);
}

// ── Dates ────────────────────────────────────────────────────────

function pickDates(originalDate) {
  const anchor = Date.now() - randInt(1, 90) * DAY - Math.floor(rnd() * DAY);
  let capture;
  if (originalDate instanceof Date && !isNaN(originalDate)) {
    capture = new Date(originalDate.getFullYear(), originalDate.getMonth(), originalDate.getDate(),
                       pickHour(), randInt(0, 59), randInt(0, 59));
  } else {
    capture = new Date(anchor - randInt(2, 700 * 24) * HOUR);
    capture.setHours(pickHour(), randInt(0, 59), randInt(0, 59), 0);
  }
  let exportAt = new Date(Math.min(anchor, capture.getTime() + randInt(2, 45 * 24) * HOUR));
  exportAt.setHours(randInt(9, 23), randInt(0, 59), randInt(0, 59), 0);
  if (exportAt.getTime() <= capture.getTime() + HOUR) exportAt = new Date(capture.getTime() + randInt(2, 8) * HOUR);
  return { capture, exportAt };
}

// ── Tag registration ─────────────────────────────────────────────

const TAG_OFFSET_TIME           = 0x9010;
const TAG_OFFSET_TIME_ORIGINAL  = 0x9011;
const TAG_OFFSET_TIME_DIGITIZED = 0x9012;
const TAG_SERIAL_NUMBER         = 0xa431;
const TAG_LENS_SERIAL           = 0xa435;

/** Register the handful of tags piexifjs 1.0.6 does not know, so exif-writer can serialise them. */
function registerTags(px) {
  const E = px?.TAGS?.Exif;
  if (!E) return;
  const add = (tag, name, type) => { if (!E[tag]) E[tag] = { name, type }; };
  add(TAG_OFFSET_TIME, 'OffsetTime', 'Ascii');
  add(TAG_OFFSET_TIME_ORIGINAL, 'OffsetTimeOriginal', 'Ascii');
  add(TAG_OFFSET_TIME_DIGITIZED, 'OffsetTimeDigitized', 'Ascii');
  add(TAG_SERIAL_NUMBER, 'BodySerialNumber', 'Ascii');
  add(TAG_LENS_SERIAL, 'LensSerialNumber', 'Ascii');
}

const FIXED_LENGTH_ASCII = new Set([`GPS:${0x001d}`]);

function alignAsciiValues(p, px) {
  for (const [ifdKey, fallback] of [['0th', 'Image'], ['Exif', 'Exif'], ['GPS', 'GPS'],
                                    ['Interop', 'Interop'], ['1st', 'Image']]) {
    const ifd = p[ifdKey];
    if (!ifd) continue;
    const table = px.TAGS[ifdKey] || px.TAGS[fallback] || {};
    for (const tag of Object.keys(ifd)) {
      if (table[tag]?.type !== 'Ascii') continue;
      if (FIXED_LENGTH_ASCII.has(`${ifdKey}:${tag}`)) continue;
      const v = ifd[tag];
      if (typeof v === 'string' && v.length % 2 === 0) ifd[tag] = v + '\0';
    }
  }
}

// ── Serial-number generators (shape matches the measured samples) ──

const digits = n => Array.from({ length: n }, () => '0123456789'[Math.floor(rnd() * 10)]).join('');
function serialFor(writer) {
  if (writer.serial === 12) return digits(12);        // Canon
  if (writer.serial === 7)  return digits(7);         // Nikon
  if (writer.serial === 8)  return (0x30000000 + Math.floor(rnd() * 0x0fffffff)).toString(16).toUpperCase(); // Fuji
  return null;
}
const hex = n => Array.from({ length: n }, () => '0123456789abcdef'[Math.floor(rnd() * 16)]).join('');

// ── Fake metadata generation ─────────────────────────────────────

/**
 * Build the metadata of one exported photo. Returns the display object, the
 * piexif write object, and the context the container (XMP, APP13) needs.
 *
 * Every call draws a fresh, independent identity — camera, lens, city, dates
 * and editor — including within a batch, so no two outputs share an identity
 * that would link them to each other or to the person who shared them.
 */
export function generateFake(options = {}) {
  const px = window.piexif;
  registerTags(px);
  const cam = pick(CAMERAS);
  const w   = WRITERS[cam.writer];
  const loc = jitterLocation(pick(LOCATIONS));
  const isBody = w.kind === 'body';
  const editor = pickEditor(isBody ? 'acr' : 'lr');

  const { focalPhys, focalEquiv, aperture, lens } = pickOptics(cam);

  const { capture, exportAt } = pickDates(options.originalDate);
  const utc          = wallClockToUtc(capture, loc.tz);
  const exportUtc    = wallClockToUtc(exportAt, loc.tz);
  const offsetString = tzOffsetString(utc, loc.tz);
  const exportOffset = tzOffsetString(exportUtc, loc.tz);

  const scene = pickScene(sunElevation(loc.lat, loc.lon, utc));
  const flashFired = !!cam.flash && scene.dark && rnd() < (cam.type === 'phone' ? 0.3 : 0.25);
  const rawEv = scene.evMin + rnd() * (scene.evMax - scene.evMin) + (flashFired ? 3 : 0);
  const [evLo, evHi] = cameraEvRange(cam, aperture);
  const ev = clamp(rawEv, evLo, evHi);
  const { shutter, iso } = solveExposure(cam, aperture, ev, focalEquiv);
  const exposureSec = shutter[0] / shutter[1];

  const flash           = flashFired ? w.flashFired : pick(w.flashOff);
  const meteringMode    = pick(w.metering);
  const exposureProgram = cam.type === 'phone' ? 2 : pick([1, 2, 3, 3, 3, 4]);
  const exposureMode    = exposureProgram === 1 ? 1 : 0;
  const whiteBalance    = cam.type === 'phone' ? 0 : pick([0, 0, 0, 1]);
  const sceneCapture    = scene.name === 'night' ? 3 : 0;
  const biasStops       = cam.type === 'phone' ? 0 : pick([0, 0, 0, 1 / 3, -1 / 3, 2 / 3, -2 / 3, 1, -1]);
  const subsec = cam.subsec ? String(cryptoRandInt(0, Math.pow(10, cam.subsec) - 1)).padStart(cam.subsec, '0') : null;
  const colorSpace = rnd() < 0.9 ? 1 : 65535;
  const dpi = editor.dpi;

  const tv = -Math.log2(exposureSec);
  const av = 2 * Math.log2(aperture);
  const bv = apexBrightness(aperture, exposureSec, iso);
  const widest = cam.type === 'phone' ? Math.min(...cam.lenses.map(l => l.f)) : Math.min(...cam.apertures);
  const latRef = loc.lat >= 0 ? 'N' : 'S';
  const lonRef = loc.lon >= 0 ? 'E' : 'W';

  // Lens figures: phones carry the measured per-lens rationals; bodies compute
  // from the aperture in the firmware's own denominator.
  const fnumberRat = w.fnumber === 'lens'
    ? lens.fRat
    : reduce(Math.round(aperture * w.fnumber), w.fnumber);
  const focalRat = w.focal === 'lens'
    ? lens.focalRat
    : (w.focal === 1 ? [focalPhys, 1] : reduce(Math.round(focalPhys * w.focal), w.focal));

  // Lens specification and names.
  let lensSpec = null, lensModel = null, lensMake = null, auxLens = null, adobeLens = null;
  if (cam.type === 'phone') {
    lensModel = lens.model;
    if (w.lensTags.includes('make')) lensMake = w.lensMake;
    lensSpec = cam.lensInfo || null;
    auxLens = lens.model;
  } else if (cam.fixedLens) {
    lensSpec = [specRat(focalPhys), specRat(focalPhys), specRat(widest), specRat(widest)];
    auxLens = `${cam.model.split(' ').pop()} ${focalPhys}mm f/${widest}`;
  } else if (lens) {
    lensModel = lens.model;
    if (w.lensTags.includes('make')) lensMake = w.lensMake;
    const apZero = w.lensInfoApertureZero;
    lensSpec = [specRat(lens.range[0]), specRat(lens.range[1]),
                apZero ? [0, 1] : specRat(lens.wide), apZero ? [0, 1] : specRat(lens.tele)];
    // Nikon F-mount glass reaches Camera Raw only through the raw's MakerNote,
    // so its EXIF LensModel is dropped and XMP names it in Adobe's own form.
    if (w.lensAdobe && lens.mount === 'F' && lens.adobe) { auxLens = lens.adobe; lensModel = lens.adobe; }
    else auxLens = lens.model;
  }

  const serialNumber = w.extras.serialNumber ? serialFor(w) : null;
  const lensSerial = (w.lensTags.includes('serial') && !cam.fixedLens && lens) ? hex(10).toUpperCase() : null;

  // ── Display object (UI) ──
  const display = {
    Make: cam.make, Model: cam.model, Software: editor.software,
    LensMake: lensMake, LensModel: lensModel,
    DateTimeOriginal: capture, DateTime: exportAt, SubSecTimeOriginal: subsec,
    OffsetTimeOriginal: cam.offset !== 'none' ? offsetString : null,
    ExposureTime: exposureSec, FNumber: aperture, ISO: iso,
    FocalLength: focalPhys, FocalLengthIn35mmFormat: w.extras.focalEquiv ? focalEquiv : null,
    Flash: flash, MeteringMode: meteringMode,
    ExposureProgram: exposureProgram, ExposureMode: exposureMode,
    WhiteBalance: whiteBalance, SceneCaptureType: sceneCapture,
    SensingMethod: (w.extras.sensing ? 2 : (w.extras.sensing1 ? 1 : null)),
    Orientation: 1, ColorSpace: colorSpace,
    XResolution: dpi, YResolution: dpi,
    GPSLatitude: loc.lat, GPSLongitude: loc.lon, GPSAltitude: loc.alt,
  };

  // ── Piexif write object (the Adobe export's EXIF) ──
  const I = px.ImageIFD, E = px.ExifIFD, G = px.GPSIFD;
  const captureStr = fmtDate(capture);
  const exportStr  = fmtDate(exportAt);
  const p = { "0th": {}, "Exif": {}, "GPS": {}, "Interop": {}, "1st": {} };

  // IFD0: the exporter drops Orientation, YCbCrPositioning and empty
  // Artist/Copyright. ModifyDate is the export time.
  p["0th"][I.Make]           = cam.make;
  p["0th"][I.Model]          = cam.model;
  p["0th"][I.XResolution]    = [dpi, 1];
  p["0th"][I.YResolution]    = [dpi, 1];
  p["0th"][I.ResolutionUnit] = 2;
  p["0th"][I.Software]       = editor.software;
  p["0th"][I.DateTime]       = exportStr;

  p["Exif"][E.ExposureTime]    = shutter;
  p["Exif"][E.FNumber]         = fnumberRat;
  p["Exif"][E.ExposureProgram] = exposureProgram;
  p["Exif"][E.ISOSpeedRatings] = iso;
  if (w.sensitivity) {
    p["Exif"][E.SensitivityType] = w.sensitivity;
    if (w.sensitivity === 1) { if (E.StandardOutputSensitivity) p["Exif"][E.StandardOutputSensitivity] = iso; }
    else p["Exif"][E.RecommendedExposureIndex] = iso;
  }
  p["Exif"][E.ExifVersion]       = cam.exifVersion;
  p["Exif"][E.DateTimeOriginal]  = captureStr;
  p["Exif"][E.DateTimeDigitized] = captureStr;
  if (cam.offset !== 'none' && offsetString) {
    p["Exif"][TAG_OFFSET_TIME_ORIGINAL] = offsetString;
    if (cam.offset === 'all' || cam.offset === 'two') p["Exif"][TAG_OFFSET_TIME] = exportOffset || offsetString;
    if (cam.offset === 'all') p["Exif"][TAG_OFFSET_TIME_DIGITIZED] = offsetString;
  }
  // ShutterSpeedValue and ApertureValue: Adobe rewrites both as N/1000000.
  p["Exif"][E.ShutterSpeedValue] = apexMicro(tv);
  p["Exif"][E.ApertureValue]     = apexMicro(av);
  if (w.brightness === 'cf')       p["Exif"][E.BrightnessValue] = ratFloat32(bv);
  else if (w.brightness === 2560)  p["Exif"][E.BrightnessValue] = [Math.round(bv * 2560), 2560];
  else if (w.brightness)           p["Exif"][E.BrightnessValue] = ratFixed(bv, w.brightness);
  p["Exif"][E.ExposureBiasValue] = w.expComp === 1 ? reduce(Math.round(biasStops * 3), 3) : [Math.round(biasStops * w.expComp), w.expComp];
  if (w.maxAperture === 'apex')          p["Exif"][E.MaxApertureValue] = fnumberRat === lens.fRat ? lens.apex : ratFixed(2 * Math.log2(widest), 100);
  else if (w.maxAperture === 'adobe100') p["Exif"][E.MaxApertureValue] = ratFixed(2 * Math.log2(lens ? lens.wide : widest), 100);
  else if (w.maxAperture === 256)        p["Exif"][E.MaxApertureValue] = [Math.round(2 * Math.log2(widest) * 256), 256];
  else if (w.maxAperture)                p["Exif"][E.MaxApertureValue] = ratFixed(2 * Math.log2(widest), w.maxAperture);
  p["Exif"][E.MeteringMode] = meteringMode;
  if (w.extras.lightSource != null) p["Exif"][E.LightSource] = w.extras.lightSource;
  p["Exif"][E.Flash] = flash;
  p["Exif"][E.FocalLength] = focalRat;
  if (subsec) {
    p["Exif"][E.SubSecTimeOriginal]  = subsec;
    p["Exif"][E.SubSecTimeDigitized] = subsec;
  }
  p["Exif"][E.ColorSpace] = colorSpace;
  if (w.extras.focalPlane && cam.sensor) {
    const s = cam.sensor;
    if (s.inch) {
      p["Exif"][E.FocalPlaneXResolution] = [s.px[0] * 1000, s.inch[0]];
      p["Exif"][E.FocalPlaneYResolution] = [s.px[1] * 1000, s.inch[1]];
      p["Exif"][E.FocalPlaneResolutionUnit] = 2;
    } else if (s.cm) {
      p["Exif"][E.FocalPlaneXResolution] = reduce(Math.round(s.px[0] / s.cm[0] * 32768), 32768);
      p["Exif"][E.FocalPlaneYResolution] = reduce(Math.round(s.px[1] / s.cm[1] * 32768), 32768);
      p["Exif"][E.FocalPlaneResolutionUnit] = 3;
    } else if (s.perCm) {
      p["Exif"][E.FocalPlaneXResolution] = [s.perCm, 1];
      p["Exif"][E.FocalPlaneYResolution] = [s.perCm, 1];
      p["Exif"][E.FocalPlaneResolutionUnit] = 3;
    }
  }
  if (w.extras.sensing)  p["Exif"][E.SensingMethod] = 2;
  if (w.extras.sensing1) p["Exif"][E.SensingMethod] = 1;
  if (w.extras.fileSource) p["Exif"][E.FileSource] = "\x03";
  if (w.extras.sceneType)  p["Exif"][E.SceneType]  = "\x01";
  if (w.extras.cfa)        p["Exif"][E.CFAPattern] = "\x00\x02\x00\x02\x00\x01\x01\x02";
  if (w.extras.customRendered != null) p["Exif"][E.CustomRendered] = w.extras.customRendered;
  p["Exif"][E.ExposureMode] = exposureMode;
  p["Exif"][E.WhiteBalance] = whiteBalance;
  if (w.extras.digitalZoom === 'always') p["Exif"][E.DigitalZoomRatio] = [1, 1];
  else if (w.extras.digitalZoom === 'zoom' && rnd() < 0.25) p["Exif"][E.DigitalZoomRatio] = ratFloat32(1 + rnd());
  if (w.extras.focalEquiv) p["Exif"][E.FocalLengthIn35mmFilm] = focalEquiv;
  p["Exif"][E.SceneCaptureType] = sceneCapture;
  if (w.extras.gainControl) p["Exif"][E.GainControl] = iso < 400 ? 0 : iso < 1600 ? 1 : 2;
  if (w.extras.contrast) { p["Exif"][E.Contrast] = 0; p["Exif"][E.Saturation] = 0; p["Exif"][E.Sharpness] = 0; }
  else if (w.extras.sharpness) p["Exif"][E.Sharpness] = 0;
  if (w.extras.subjectDistanceRange) p["Exif"][E.SubjectDistanceRange] = 0;
  if (w.extras.serialNumber && serialNumber) p["Exif"][TAG_SERIAL_NUMBER] = serialNumber;
  if (w.lensTags.includes('info') && lensSpec)   p["Exif"][E.LensSpecification] = lensSpec;
  if (w.lensTags.includes('make') && lensMake)   p["Exif"][E.LensMake] = lensMake;
  if (w.lensTags.includes('model') && lensModel) p["Exif"][E.LensModel] = lensModel;
  if (lensSerial) p["Exif"][TAG_LENS_SERIAL] = lensSerial;

  // GPS, in the exporter's coordinate encoding. The exporter normalises
  // GPSVersionID: Camera Raw writes 2.3.0.0, Lightroom 2.2.0.0 (measured).
  p["GPS"][G.GPSVersionID] = isBody ? [2, 3, 0, 0] : [2, 2, 0, 0];
  p["GPS"][G.GPSLatitudeRef]  = latRef;
  p["GPS"][G.GPSLatitude]     = adobeGps(Math.abs(loc.lat));
  p["GPS"][G.GPSLongitudeRef] = lonRef;
  p["GPS"][G.GPSLongitude]    = adobeGps(Math.abs(loc.lon));
  p["GPS"][G.GPSAltitudeRef]  = 0;
  p["GPS"][G.GPSAltitude]     = [Math.round(loc.alt * 100), 100];
  p["GPS"][G.GPSTimeStamp]    = [[utc.getUTCHours(), 1], [utc.getUTCMinutes(), 1], [utc.getUTCSeconds(), 1]];
  if (w.extras.status)   p["GPS"][G.GPSStatus]   = "A";
  if (w.extras.mapDatum) p["GPS"][G.GPSMapDatum] = "WGS-84";
  p["GPS"][G.GPSDateStamp] = fmtGpsDate(utc);

  alignAsciiValues(p, px);

  // The lens description the XMP carries, and the aux block for a raw export.
  const lensMeta = {
    model: lensModel, auxLens,
    lensInfo: lensSpec ? lensInfoString(lensSpec) : null,
  };
  const source = isBody
    ? { raw: true, mime: cam.raw.mime, fileName: `${rawFileStem(cam)}.${cam.raw.ext}`,
        cameraProfile: pick(['Adobe Color', 'Camera Standard', 'Camera Standard']) }
    // Always a generated name in the phone's own convention: the user's real
    // filename would identify them or the original photo.
    : { raw: false, fileName: `${phoneStem(cam, capture, subsec)}.jpg` };
  const aux = isBody ? {
    serialNumber, lensSerial,
    firmware: cam.firmware || null,
    focusDistance: rnd() < 0.5 ? `${randInt(5, 900)}/10` : '4294967295/1',
    corrected: cam.writer === 'canon' || cam.writer === 'sony',
  } : {};

  return {
    display, piexif: p, cam, loc, iso, lens, editor,
    capture, exportAt, offset: offsetString, exportOffset, subsec,
    scene: scene.name, ev: Number(ev.toFixed(2)),
    lensMeta, source, aux,
  };
}

/** A camera-raw-style file stem, like "4E4A0122" or "DSC_1234". */
function rawFileStem(cam) {
  if (cam.writer === 'canon') return hex(4).toUpperCase() + digits(4);
  return `${cam.raw.prefix}${digits(4)}`;
}
/** A phone's original JPEG stem, matching its own naming. */
function phoneStem(cam, d, subsec) {
  const p = n => String(n).padStart(2, '0');
  const ymd = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`;
  const hms = `${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
  if (cam.make === 'Apple')   return `IMG_${digits(4)}`;
  if (cam.make === 'Google')  return `PXL_${ymd}_${hms}${subsec || '000'}`;
  if (cam.make === 'samsung') return `${ymd}_${hms}`;
  return `IMG_${ymd}_${hms}`;
}

/**
 * Metadata for a non-photo (a screenshot, a graphic) that was opened in an
 * editor and exported. It carries no camera, no lens, no exposure and no GPS,
 * because none of those exist for an image that never passed through a lens;
 * it carries only the editor's own fields — Software, resolution, dates and
 * the XMP/crs provenance. The container is still the Adobe export the pixel
 * pipeline writes, so the Software must stay Adobe (a GIMP Software tag on an
 * Adobe APP14 container would be its own contradiction). Returning the same
 * shape as generateFake lets the caller reuse the container assembly.
 */
export function generateGraphic() {
  const px = window.piexif;
  registerTags(px);
  const editor = pickEditor(rnd() < 0.5 ? 'acr' : 'lr');
  const anchor = Date.now() - randInt(1, 120) * DAY - Math.floor(rnd() * DAY);
  const exportAt = new Date(anchor);
  exportAt.setHours(randInt(8, 23), randInt(0, 59), randInt(0, 59), 0);
  const capture = new Date(exportAt.getTime() - randInt(1, 600) * 60000);   // edited minutes to hours earlier

  const I = px.ImageIFD, E = px.ExifIFD;
  const p = { "0th": {}, "Exif": {}, "GPS": {}, "Interop": {}, "1st": {} };
  p["0th"][I.XResolution]    = [editor.dpi, 1];
  p["0th"][I.YResolution]    = [editor.dpi, 1];
  p["0th"][I.ResolutionUnit] = 2;
  p["0th"][I.Software]       = editor.software;
  p["0th"][I.DateTime]       = fmtDate(exportAt);
  p["Exif"][E.ExifVersion]       = "0232";
  p["Exif"][E.DateTimeOriginal]  = fmtDate(capture);
  p["Exif"][E.DateTimeDigitized] = fmtDate(capture);
  p["Exif"][E.ColorSpace]        = 1;
  alignAsciiValues(p, px);

  return {
    display: { Software: editor.software, DateTimeOriginal: capture, DateTime: exportAt, ColorSpace: 1,
               XResolution: editor.dpi, YResolution: editor.dpi },
    piexif: p, cam: null, loc: null, lens: null, editor,
    capture, exportAt, offset: null, exportOffset: null, subsec: null,
    scene: 'daylight', ev: 0,
    lensMeta: {}, aux: {},
    source: { raw: false, fileName: `image_${digits(4)}.jpg` },
  };
}

// ── Metadata Display ─────────────────────────────────────────────

export const SECTIONS = [
  { key: 'device',  title: 'Device',          fields: ['Make','Model','Software','LensMake','LensModel'] },
  { key: 'capture', title: 'Capture Settings', fields: ['DateTimeOriginal','DateTime','ModifyDate','OffsetTimeOriginal','SubSecTimeOriginal','ExposureTime','FNumber','ISO','FocalLength','FocalLengthIn35mmFormat','Flash','MeteringMode','ExposureProgram','ExposureMode','WhiteBalance','SceneCaptureType','SensingMethod'] },
  { key: 'gps',     title: 'Location (GPS)',   fields: ['GPSLatitude','GPSLongitude','GPSAltitude'] },
  { key: 'image',   title: 'Image',            fields: ['PixelXDimension','PixelYDimension','ExifImageWidth','ExifImageHeight','ImageWidth','ImageHeight','Orientation','ColorSpace','XResolution','YResolution'] },
];

export const LABELS = {
  Make:'Camera Make', Model:'Camera Model', Software:'Software',
  LensMake:'Lens Make', LensModel:'Lens Model',
  DateTimeOriginal:'Date Taken', DateTime:'Date Modified', ModifyDate:'Date Modified',
  OffsetTimeOriginal:'UTC Offset', SubSecTimeOriginal:'Sub-Second',
  ExposureTime:'Shutter Speed', FNumber:'Aperture', ISO:'ISO',
  FocalLength:'Focal Length', FocalLengthIn35mmFormat:'35mm Equiv.',
  Flash:'Flash', MeteringMode:'Metering', ExposureProgram:'Program',
  ExposureMode:'Exposure Mode', WhiteBalance:'White Balance',
  SceneCaptureType:'Scene Capture', SensingMethod:'Sensor',
  GPSLatitude:'Latitude', GPSLongitude:'Longitude', GPSAltitude:'Altitude',
  PixelXDimension:'Pixel Width', PixelYDimension:'Pixel Height',
  ExifImageWidth:'Pixel Width', ExifImageHeight:'Pixel Height',
  ImageWidth:'Width', ImageHeight:'Height', Orientation:'Orientation',
  ColorSpace:'Color Space', XResolution:'X Resolution', YResolution:'Y Resolution',
};

const FLASH_MAP   = { 0:'No flash', 1:'Flash fired', 9:'Flash fired', 16:'Flash off', 24:'Flash off', 25:'Flash fired', 31:'Flash fired + red-eye' };
const METER_MAP   = { 1:'Average', 2:'Center-weighted', 3:'Spot', 4:'Multi-spot', 5:'Multi-segment', 6:'Partial' };
const PROG_MAP    = { 0:'Not defined', 1:'Manual', 2:'Auto', 3:'Aperture priority', 4:'Shutter priority', 5:'Creative', 6:'Action', 7:'Portrait', 8:'Landscape' };
const ORIENT_MAP  = { 1:'Normal (0 deg)', 3:'Rotated 180 deg', 6:'Rotated 90 deg CW', 8:'Rotated 90 deg CCW' };
const WB_MAP      = { 0:'Auto', 1:'Manual' };
const CS_MAP      = { 1:'sRGB', 65535:'Uncalibrated' };
const EXPMODE_MAP = { 0:'Auto', 1:'Manual', 2:'Auto bracket' };
const SCENE_MAP   = { 0:'Standard', 1:'Landscape', 2:'Portrait', 3:'Night' };
const SENSING_MAP = { 1:'Not defined', 2:'One-chip color area', 3:'Two-chip color area', 4:'Three-chip color area', 5:'Color sequential area', 7:'Trilinear', 8:'Color sequential linear' };

function mapCode(map, v, prefix = '') {
  return typeof v === 'number' ? (map[v] ?? `${prefix}${v}`) : String(v);
}

export function fmtVal(key, v) {
  if (v == null) return null;
  switch (key) {
    case 'ExposureTime':
      if (typeof v !== 'number') return String(v);
      return v >= 1 ? `${v}s` : `1/${Math.round(1 / v)}s`;
    case 'FNumber':
      return typeof v === 'number' ? `f/${v.toFixed(1)}` : String(v);
    case 'FocalLength': case 'FocalLengthIn35mmFormat':
      return typeof v === 'number' ? `${v}mm` : String(v);
    case 'GPSAltitude':
      return typeof v === 'number' ? `${v.toFixed(1)} m` : String(v);
    case 'GPSLatitude': case 'GPSLongitude':
      if (typeof v === 'number') return `${v.toFixed(6)} deg`;
      if (Array.isArray(v) && v.length >= 3) return `${v[0]} deg ${v[1]}'${v[2]}"`;
      return String(v);
    case 'DateTimeOriginal': case 'DateTime': case 'ModifyDate':
      if (v instanceof Date) return v.toLocaleString();
      return String(v);
    case 'Flash':            return mapCode(FLASH_MAP,   v, 'Code ');
    case 'MeteringMode':     return mapCode(METER_MAP,   v, 'Mode ');
    case 'ExposureProgram':  return mapCode(PROG_MAP,    v);
    case 'Orientation':      return mapCode(ORIENT_MAP,  v);
    case 'WhiteBalance':     return mapCode(WB_MAP,      v);
    case 'ColorSpace':       return mapCode(CS_MAP,      v);
    case 'ExposureMode':     return mapCode(EXPMODE_MAP, v);
    case 'SceneCaptureType': return mapCode(SCENE_MAP,   v);
    case 'SensingMethod':    return mapCode(SENSING_MAP, v);
    case 'SubSecTimeOriginal': return String(v);
    case 'PixelXDimension': case 'PixelYDimension':
    case 'ExifImageWidth': case 'ExifImageHeight':
      return typeof v === 'number' ? `${v} px` : String(v);
    case 'XResolution': case 'YResolution':
      return typeof v === 'number' ? `${v} DPI` : String(v);
    default:
      if (v instanceof Date) return v.toLocaleString();
      return String(v);
  }
}

export function renderMeta(exifObj, isFake = false) {
  if (!exifObj || Object.keys(exifObj).length === 0) {
    return { html: `<div class="no-meta"><div class="no-meta-icon">${ICONS.camera}</div><p>No EXIF metadata found in this image.</p></div>`, count: 0 };
  }
  let html = '';
  let count = 0;
  for (const sec of SECTIONS) {
    const rows = [];
    for (const field of sec.fields) {
      const raw = exifObj[field];
      const disp = fmtVal(field, raw);
      if (!disp) continue;
      count++;
      let extra = '';
      if (field === 'GPSLatitude' && isFake) {
        const lat = exifObj.GPSLatitude, lon = exifObj.GPSLongitude;
        const latRef = exifObj.GPSLatitudeRef || exifObj.latitudeRef;
        const lonRef = exifObj.GPSLongitudeRef || exifObj.longitudeRef;
        const toDec = v => {
          if (typeof v === 'number' && Number.isFinite(v)) return v;
          if (Array.isArray(v) && v.length >= 3) return v[0] + v[1] / 60 + v[2] / 3600;
          return null;
        };
        let latDec = toDec(lat);
        let lonDec = toDec(lon);
        if (latDec != null && latRef === 'S') latDec = -Math.abs(latDec);
        if (lonDec != null && lonRef === 'W') lonDec = -Math.abs(lonDec);
        if (latDec != null && lonDec != null) {
          const la = latDec.toFixed(5), lo = lonDec.toFixed(5);
          extra = `<a class="gps-link" href="https://www.openstreetmap.org/?mlat=${la}&mlon=${lo}#map=14/${la}/${lo}" target="_blank" rel="noopener noreferrer">Map</a>`;
        }
      }
      rows.push(`<div class="meta-row">
        <span class="meta-key">${escapeHtml(LABELS[field] || field)}</span>
        <span class="meta-val${isFake ? ' is-new' : ''}">${escapeHtml(disp)}${extra}</span>
      </div>`);
    }
    if (rows.length) {
      html += `<div class="meta-section">
        <div class="meta-section-title">${sec.title}</div>
        ${rows.join('')}
      </div>`;
    }
  }
  if (!html) {
    return { html: `<div class="no-meta"><div class="no-meta-icon">${ICONS.camera}</div><p>No recognized EXIF fields found.</p></div>`, count: 0 };
  }
  return { html, count };
}
