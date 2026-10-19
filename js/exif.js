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
  pickLocation, fmtDate, fmtGpsDate,
  wallClockToUtc, utcToWallClock, tzOffsetString, sunElevation,
  dmsToDec,
  fromRat, cleanExifStr, escapeHtml,
} from './helpers.js';
import { CAMERAS, pickOptics } from './data.js';
import { PHONE_APPLE, PHONE_ANDROID, BODY_ADOBE } from './exposure-tables.js';
import { adobeExposure, adobeFNumber } from './exposure.js';
import { pickEditor, earliestRelease } from './provenance.js';
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

/**
 * The EXIF or XMP UserComment, read on its own: parseFileExif's options skip
 * both, and iOS and macOS write "Screenshot" there on their screenshots.
 */
export async function readUserComment(file) {
  try {
    const r = await exifr.parse(file, { ifd0: false, exif: true, xmp: true, userComment: true });
    const v = r?.userComment ?? r?.UserComment;
    if (v instanceof Uint8Array) {
      const unicode = String.fromCharCode(...v.subarray(0, 7)) === 'UNICODE';
      const body = v.subarray(8);
      const text = unicode ? new TextDecoder(body[0] === 0 ? 'utf-16be' : 'utf-16le').decode(body) : new TextDecoder().decode(body);
      return text.replace(/\0/g, '').trim();
    }
    // Some writers store it as text, its 8-byte character-code prefix included.
    return String(v?.value ?? v ?? '').replace(/^(ASCII|UNICODE|JIS)\0*/, '').replace(/\0/g, '').trim();
  } catch {
    return '';
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

export async function readBackExifStrict(bytes) {
  const blob = new Blob([bytes], { type: 'image/jpeg' });
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
    let bin = '';
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    const parsed = piexifToDisplay(window.piexif.load(bin));
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

/**
 * A Canon lens's maximum aperture at the focal length used, as Camera Raw
 * writes it: APEX on Canon's eighth-stop scale, as a decimal (3/1 for f/2.8,
 * 175/100 for f/1.8, 5625/1000 for f/7.1). Measured on R5, R5 Mark II and
 * R6 Mark II exports.
 */
function eighthStopAperture(f) {
  const v = Math.round(2 * Math.log2(f) * 8) / 8;
  if (Number.isInteger(v)) return [v, 1];
  if (Number.isInteger(v * 100)) return [Math.round(v * 100), 100];
  return [Math.round(v * 1000), 1000];
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
//
// FNumber is not the camera's: every Adobe export measured rewrites it as a
// decimal (f/1.78 as 18/10, f/5.6 as 56/10, f/8 as 8/1), so it is written that
// way for every make. FocalLength keeps the camera's denominator, unreduced
// (470/10 from a Nikon, 1590/100 from a Fujifilm). A DigitalZoomRatio array is
// the value the firmware writes when no zoom was used, which the export keeps.

const WRITERS = {
  apple: {
    kind: 'phone',
    focal: 'lens',
    expComp: 1, brightness: 'cf', maxAperture: null, sensitivity: null,
    flashOff: [16], flashFired: 25, metering: [5],
    lensTags: ['make', 'model', 'info'], lensMake: 'Apple',
    gpsVersion: null, dirRef: 'T',
    extras: { focalEquiv: true, digitalZoom: 'zoom', sensing: true, sceneType: true },
  },
  google: {
    kind: 'phone',
    focal: 'lens',
    expComp: 6, brightness: 100, maxAperture: 'apex', sensitivity: null,
    flashOff: [16], flashFired: 1, metering: [2],
    lensTags: ['make', 'model'], lensMake: 'Google',
    gpsVersion: [2, 2, 0, 0], dirRef: 'M',
    extras: { focalEquiv: true, digitalZoom: [0, 1], customRendered: 1, sensing: true, sceneType: true,
              contrast: true, subjectDistanceRange: true },
  },
  samsung: {
    kind: 'phone',
    focal: 'lens',
    expComp: 100, brightness: 100, maxAperture: 'apex', sensitivity: null,
    flashOff: [0], flashFired: 1, metering: [2],
    lensTags: [], gpsVersion: [2, 2, 0, 0], dirRef: 'M',
    extras: { focalEquiv: true, digitalZoom: [100, 100] },
  },
  samsungA: {
    kind: 'phone',
    focal: 'lens',
    expComp: 10, brightness: 100, maxAperture: 'apex', sensitivity: null,
    flashOff: [0], flashFired: 1, metering: [2],
    lensTags: [], gpsVersion: [2, 2, 0, 0], dirRef: 'M',
    extras: { focalEquiv: true, digitalZoom: 'always', customRendered: 0, sensing: true, sceneType: true,
              contrast: true },
  },
  oneplus: {
    kind: 'phone',
    focal: 'lens',
    expComp: 6, brightness: 100, maxAperture: 'apex', sensitivity: null,
    flashOff: [16], flashFired: 1, metering: [2],
    lensTags: ['model'], lensMake: null,
    gpsVersion: null, dirRef: 'M',
    extras: { focalEquiv: true, digitalZoom: 'always', sensing1: true, sceneType: true },
  },
  xiaomi: {
    kind: 'phone',
    focal: 'lens',
    expComp: 6, brightness: 100, maxAperture: 'apex', sensitivity: 3,
    flashOff: [16], flashFired: 1, metering: [2],
    lensTags: [], gpsVersion: null, dirRef: 'M',
    extras: { focalEquiv: true, sensing1: true, sceneType: true, lightSource: 21 },
  },
  canon: {
    kind: 'body',
    focal: 1,
    expComp: 1, brightness: null, maxAperture: 'eighth', sensitivity: 2,
    flashOff: [0], flashFired: 9, metering: [5, 5, 5, 2, 3],
    lensTags: ['info', 'model', 'serial'], lensMake: null, lensInfoApertureZero: true,
    gpsVersion: [2, 3, 0, 0], serial: 12,
    extras: { focalPlane: true, customRendered: 0, serialNumber: true, status: true, mapDatum: true },
  },
  nikon: {
    kind: 'body',
    focal: 10,
    expComp: 6, brightness: null, maxAperture: null, sensitivity: 2,
    flashOff: [0], flashFired: 9, metering: [5, 5, 5, 2, 3],
    lensTags: ['info', 'model', 'make', 'serial'], lensMake: 'NIKON', lensAdobe: true,
    gpsVersion: [2, 3, 0, 0], serial: 7,
    extras: { focalPlane: true, focalPlaneUnit: 3, sensing: true, fileSource: true, sceneType: true,
              cfa: true, customRendered: 1, focalEquiv: true, gainControl: true, contrast: true,
              subjectDistanceRange: true, serialNumber: true, lightSource: 0 },
  },
  sony: {
    kind: 'body',
    focal: 10,
    expComp: 10, brightness: 2560, maxAperture: 256, sensitivity: 2,
    flashOff: [16], flashFired: 9, metering: [5, 5, 5, 2, 3],
    lensTags: ['info', 'model'], lensMake: null,
    gpsVersion: [2, 3, 0, 0],
    extras: { focalPlane: true, focalPlaneUnit: 3, fileSource: true, sceneType: true, customRendered: 0,
              focalEquiv: true, digitalZoom: [16, 16], contrast: true, lightSource: 0 },
  },
  fuji: {
    kind: 'body',
    focal: 100,
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
 * Real exposures (exposure-tables.js), each file weighted so that every
 * uploader counts once. Times are the camera's own, before Adobe rounds them.
 */
function parseExposures(table, fields) {
  return table.split('|').flatMap(group => {
    const files = group.split(' ');
    return files.map(file => {
      const v = Object.fromEntries(file.split(',').map((x, i) => [fields[i], Number(x)]));
      return { f: v.f, t: 1 / v.inv, iso: v.iso, w: 1 / files.length };
    });
  });
}
const EXPOSURES = {
  apple:   parseExposures(PHONE_APPLE, ['f', 'inv', 'iso']),
  android: parseExposures(PHONE_ANDROID, ['f', 'inv', 'iso']),
  body:    parseExposures(BODY_ADOBE, ['f', 'inv', 'iso']),
};

// Samsung, OnePlus and Xiaomi write ISO on the nominal third-stop scale, as
// their files in the survey do; a Pixel writes any integer.
const ISO_THIRDS = [10, 12, 16, 20, 25, 32, 40, 50, 64, 80, 100, 125, 160, 200, 250, 320, 400, 500,
  640, 800, 1000, 1250, 1600, 2000, 2500, 3200, 4000, 5000, 6400, 8000, 10000, 12800];
const nearestThird = iso => ISO_THIRDS.reduce((a, b) => Math.abs(Math.log(b / iso)) < Math.abs(Math.log(a / iso)) ? b : a);
/** The ISO camera `cam` writes for a measured file's `iso`. */
export const writtenIso = (cam, iso) => cam.type === 'phone' && cam.writer !== 'apple' && cam.writer !== 'google' ? nearestThird(iso) : iso;

const evOf = (f, t, iso) => Math.log2(f * f / t) - Math.log2(iso / 100);

/** The files shot within 0.4 of a stop of f-number `f`, or as far as it takes to hold 100. */
function filesNearAperture(files, f) {
  for (let stops = 0.4; ; stops += 0.2) {
    const near = files.filter(x => Math.abs(2 * Math.log2(x.f / f)) <= stops);
    if (near.length >= 100) return near;
  }
}

/**
 * The exposure of a photo of a scene of brightness `ev`: a real file's
 * exposure that gives that EV within half a stop, widened a half stop at a
 * time when none does. A phone takes the time and ISO of a file shot through
 * a lens of about its lens's f-number, since a phone exposes its telephoto
 * and ultra-wide differently from its main camera; a body takes the file's
 * f-number, time and ISO, among those its lens opens to and its shutter and
 * ISO range allow.
 */
function drawExposure(cam, lens, apertureAtFocal, ev) {
  const phone = cam.type === 'phone';
  const files = phone ? (cam.writer === 'apple' ? EXPOSURES.apple : EXPOSURES.android) : EXPOSURES.body;
  const usable = phone ? filesNearAperture(files, lens.f) : files.filter(x =>
    x.f >= apertureAtFocal - 0.05 && x.t >= 1 / cam.fastest && x.iso >= cam.isoRange[0] && x.iso <= cam.isoRange[1] &&
    (!cam.fixedLens || x.f <= Math.max(...cam.apertures)));
  const fOf = x => phone ? lens.f : x.f;
  for (let tol = 0.5; tol <= 30; tol += 0.5) {
    const near = usable.filter(x => Math.abs(evOf(fOf(x), x.t, x.iso) - ev) <= tol);
    if (!near.length) continue;
    let r = rnd() * near.reduce((n, x) => n + x.w, 0);
    const x = near.find(c => (r -= c.w) <= 0) || near[near.length - 1];
    return { aperture: fOf(x), exposureSec: x.t, iso: writtenIso(cam, x.iso) };
  }
  throw new Error(`no measured exposure fits ${cam.model}`);
}

function apexBrightness(aperture, exposureSec, iso) {
  return 2 * Math.log2(aperture) - Math.log2(exposureSec) - Math.log2(iso / 3.125);
}

// ── Dates ────────────────────────────────────────────────────────

// The export dates are drawn from what real Adobe exports on Wikimedia Commons
// show (4,688 files, 169 uploaders, every uploader weighted equally).

// Capture-to-export delay, as quantiles in days: 40% are exported within a
// day, half within two days, one in ten more than 110 days later and one in
// twenty more than a year and a half later. Drawn by interpolating between
// the quantiles on a log scale.
const EXPORT_LAG_DAYS = [[0, 0.02], [0.05, 0.034], [0.1, 0.055], [0.2, 0.124], [0.3, 0.333],
  [0.4, 0.918], [0.5, 2.014], [0.6, 3.206], [0.7, 8.076], [0.8, 25.87], [0.9, 111.1],
  [0.95, 543.2], [0.99, 1770.8], [1, 2500]];
function drawExportLagMs() {
  const u = rnd();
  let i = 1;
  while (i < EXPORT_LAG_DAYS.length - 1 && EXPORT_LAG_DAYS[i][0] < u) i++;
  const [q0, d0] = EXPORT_LAG_DAYS[i - 1], [q1, d1] = EXPORT_LAG_DAYS[i];
  const t = (u - q0) / (q1 - q0);
  return Math.exp(Math.log(d0) + t * (Math.log(d1) - Math.log(d0))) * DAY;
}

// Local hour of export, percent per hour 00-23; almost nothing between 04:00
// and 08:00, a small floor kept there rather than none.
const EXPORT_HOUR_WEIGHTS = [2.1, 1.8, 1.2, 0.9, 0.1, 0.1, 0.1, 0.1, 1.4, 4.1, 6.5, 5.1,
                             2.9, 6.9, 4.0, 8.0, 8.9, 8.0, 5.2, 7.3, 5.1, 5.8, 8.1, 6.5];
function pickExportHour() {
  return Number(weightedPick(Object.fromEntries(EXPORT_HOUR_WEIGHTS.map((w, i) => [i, w]))));
}

/**
 * The latest moment any date in the output may carry: a random one to ninety
 * days in the past, so the newest date in an output does not say when the
 * tool was run.
 */
const pickAnchor = () => Date.now() - randInt(1, 90) * DAY - Math.floor(rnd() * DAY);

/**
 * Export and capture times for a generated photo. The export comes first: a
 * day in the two years before the anchor, at a measured hour of the day. The
 * capture is then the export minus a measured delay, at a measured hour of
 * its own when the delay is a day or more. Drawn this way round, both the
 * export hours and the delays match the real exports; drawing the capture
 * first and rejecting exports past the anchor cut off the long delays.
 */
function pickTimes(anchor) {
  const MIN = 30 * 60000;
  const exportAt = new Date(anchor - rnd() * 700 * DAY);
  exportAt.setHours(pickExportHour(), randInt(0, 59), randInt(0, 59), 0);
  if (exportAt.getTime() > anchor) exportAt.setDate(exportAt.getDate() - 1);
  const lag = drawExportLagMs();
  let capture = new Date(exportAt.getTime() - lag);
  // A delay of a day or more lands on an earlier calendar day, so re-drawing
  // the hour keeps the capture before the export.
  if (lag >= DAY) capture.setHours(pickHour(), randInt(0, 59), randInt(0, 59), 0);
  if (exportAt.getTime() - capture.getTime() < MIN) capture = new Date(exportAt.getTime() - MIN - randInt(0, 3600) * 1000);
  return { capture, exportAt };
}

/**
 * The export time for a kept original date: the capture plus a measured
 * delay, at a measured hour of the day when the delay is a day or more, never
 * before the editor's first release and never after `latest`. A capture too
 * old for the editor is exported at some point between its first release and
 * `latest`, as people re-export old photos. A capture only minutes before
 * `latest` gets a shorter minimum delay rather than an export after it.
 */
function pickExport(capture, latest, earliest) {
  const MIN = Math.min(30 * 60000, (latest - capture.getTime()) / 2);
  for (let tries = 0; tries < 200; tries++) {
    const lag = drawExportLagMs();
    const t = new Date(capture.getTime() + lag);
    if (lag >= DAY) t.setHours(pickExportHour(), randInt(0, 59), randInt(0, 59), 0);
    if (t.getTime() >= capture.getTime() + MIN && t.getTime() <= latest && t >= earliest) return t;
  }
  const lo = Math.max(capture.getTime() + MIN, earliest.getTime());
  const hi = Math.max(lo, latest);
  return new Date(lo + rnd() * (hi - lo));
}

/** Whether this camera, and the firmware it reports, existed by `date`. */
const existedBy = (cam, date) =>
  new Date(`${cam.released}T00:00:00`) <= date &&
  (!cam.firmwareDate || new Date(`${cam.firmwareDate}T00:00:00`) <= date);

/**
 * Whether Camera Raw could open this body's raw files by `date`. A body names
 * its first supporting release as `acrMin`; an export dated before that
 * release existed would name an editor that could not have read the file.
 */
const rawSupportedBy = (cam, date) => {
  if (!cam.acrMin) return true;
  const first = earliestRelease('acr', cam.acrMin);
  return !!first && first <= date;
};

/**
 * Which editor exported the photo, as often as real exports name each one:
 * dated 2024 on, weighting each Wikimedia Commons uploader equally (391 phone
 * exports from 36 uploaders, 1,510 body exports from 64). Left out, and the
 * rest renormalised: Lightroom mobile (9.1% of phone exports, 8.7% of body
 * exports) and, for phones, Camera Raw (8.3%), whose packets were not
 * measured, and the discontinued Lightroom 6 (2.8% of phone exports).
 */
const EDITOR_SHARES = { phone: { lrc: 67.7, lr: 12.0 }, body: { lrc: 56.1, lr: 25.7, acr: 9.5 } };

/** The cameras offered: every phone, and the bodies whose profile digest was measured (see data.js). */
const OFFERED = CAMERAS.filter(c => c.type === 'phone' || c.profileDigest);

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
  // The capture comes first, so the camera can be one that existed by then.
  // A kept original date and time is the capture exactly; every other date is
  // drawn to fit after it. One that cannot be told consistently (older than
  // every camera here, or later than now) is replaced by a drawn date and the
  // caller is told why (keepDateDropped).
  const anchor = pickAnchor();
  const kept = options.originalDate instanceof Date && !isNaN(options.originalDate) ? options.originalDate : null;
  let capture = null, exportAt = null, pool = [], keepDateDropped = null, latest = anchor, loc = null;
  if (kept) {
    if (kept.getTime() >= Date.now()) keepDateDropped = 'future';
    else if (kept.getTime() < anchor - DAY) capture = new Date(kept.getTime());
    else {
      // The anchor keeps the newest date from saying when the tool ran, but a
      // photo taken after it has to be exported after it, so the bound is now,
      // read in the place's own zone: the kept wall clock must already have
      // happened there, or the file would claim a capture in the future.
      for (let i = 0; i < 200 && !loc; i++) {
        const l = pickLocation();
        if (wallClockToUtc(kept, l.tz).getTime() < Date.now() - 60000) loc = l;
      }
      if (loc) {
        capture = new Date(kept.getTime());
        latest = utcToWallClock(Date.now(), loc.tz).getTime();
      } else keepDateDropped = 'future';
    }
    if (capture) {
      pool = OFFERED.filter(c => existedBy(c, capture) && rawSupportedBy(c, new Date(latest)));
      if (!pool.length) { keepDateDropped = 'old'; capture = null; loc = null; latest = anchor; }
    }
  }
  // A long measured delay can put the capture before every camera here; draw
  // again until at least one existed.
  for (let tries = 0; !pool.length && tries < 50; tries++) {
    ({ capture, exportAt } = pickTimes(anchor));
    pool = OFFERED.filter(c => existedBy(c, capture) && rawSupportedBy(c, exportAt));
  }
  const cam = pick(pool);
  const w   = WRITERS[cam.writer];
  if (!loc) loc = pickLocation();
  const isBody = w.kind === 'body';
  const acrMin = isBody ? cam.acrMin || null : null;
  // Only an editor that had a release able to open the body's raws by then.
  const editors = Object.entries(EDITOR_SHARES[isBody ? 'body' : 'phone']).filter(([k]) => {
    const first = earliestRelease(k, acrMin);
    return first && first <= (exportAt || new Date(latest));
  });
  const editorKind = editors.length ? weightedPick(Object.fromEntries(editors)) : 'acr';
  if (!exportAt) exportAt = pickExport(capture, latest, earliestRelease(editorKind, acrMin));
  const editor = pickEditor(editorKind, exportAt, acrMin);

  const { focalPhys, focalEquiv, lens } = pickOptics(cam);
  const widest = cam.type === 'phone' ? Math.min(...cam.lenses.map(l => l.f)) : Math.min(...cam.apertures);
  // The widest aperture the lens offers at this focal length; a variable zoom
  // closes down towards its long end.
  const apertureAtFocal = !lens || !lens.range || lens.range[1] === lens.range[0] ? (lens ? lens.wide : widest)
    : lens.wide + (lens.tele - lens.wide) * (focalPhys - lens.range[0]) / (lens.range[1] - lens.range[0]);

  const utc          = wallClockToUtc(capture, loc.tz);
  const exportUtc    = wallClockToUtc(exportAt, loc.tz);
  const offsetString = tzOffsetString(utc, loc.tz);
  const exportOffset = tzOffsetString(exportUtc, loc.tz);

  const scene = pickScene(sunElevation(loc.lat, loc.lon, utc));
  const flashFired = !!cam.flash && scene.dark && rnd() < (cam.type === 'phone' ? 0.3 : 0.25);
  const sceneEv = scene.evMin + rnd() * (scene.evMax - scene.evMin) + (flashFired ? 3 : 0);
  const { aperture, exposureSec, iso } = drawExposure(cam, lens, apertureAtFocal, sceneEv);
  const ev = evOf(aperture, exposureSec, iso);
  // What the export writes: Adobe's rounding of the camera's time, and the
  // APEX values mirrored from the written ExposureTime and FNumber.
  const written = adobeExposure(exposureSec);
  const { fNumber: fnumberRat, apertureValue } = adobeFNumber(aperture);

  const flash           = flashFired ? w.flashFired : pick(w.flashOff);
  const meteringMode    = pick(w.metering);
  const exposureProgram = cam.type === 'phone' ? 2 : pick([1, 2, 3, 3, 3, 4]);
  const exposureMode    = exposureProgram === 1 ? 1 : 0;
  const whiteBalance    = cam.type === 'phone' ? 0 : pick([0, 0, 0, 1]);
  const sceneCapture    = scene.name === 'night' ? 3 : 0;
  const biasStops       = cam.type === 'phone' ? 0 : pick([0, 0, 0, 1 / 3, -1 / 3, 2 / 3, -2 / 3, 1, -1]);
  const subsec = cam.subsec ? String(cryptoRandInt(0, Math.pow(10, cam.subsec) - 1)).padStart(cam.subsec, '0') : null;
  // The ICC profile embedded below is always the sRGB one, so ColorSpace must
  // say so too: real exports never pair Uncalibrated with an sRGB profile.
  const colorSpace = 1;
  const dpi = editor.dpi;

  const bv = apexBrightness(aperture, exposureSec, iso);
  const latRef = loc.lat >= 0 ? 'N' : 'S';
  const lonRef = loc.lon >= 0 ? 'E' : 'W';

  // FocalLength as the firmware writes it, the phone's measured per-lens
  // rational or the body's own denominator, unreduced.
  const focalRat = w.focal === 'lens' ? lens.focalRat : [Math.round(focalPhys * w.focal), w.focal];

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
    // Canon leaves the apertures empty; Camera Raw 16.5 and later write them as 0/0.
    const apZero = w.lensInfoApertureZero;
    lensSpec = [specRat(lens.range[0]), specRat(lens.range[1]),
                apZero ? [0, 0] : specRat(lens.wide), apZero ? [0, 0] : specRat(lens.tele)];
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
    ExposureTime: written.seconds, FNumber: aperture, ISO: iso,
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

  p["Exif"][E.ExposureTime]    = written.exposureTime;
  p["Exif"][E.FNumber]         = fnumberRat;
  p["Exif"][E.ExposureProgram] = exposureProgram;
  p["Exif"][E.ISOSpeedRatings] = iso;
  if (w.sensitivity) {
    p["Exif"][E.SensitivityType] = w.sensitivity;
    // Fujifilm writes SensitivityType 1 without the index it names.
    if (w.sensitivity !== 1) p["Exif"][E.RecommendedExposureIndex] = iso;
  }
  p["Exif"][E.ExifVersion]       = cam.exifVersion;
  p["Exif"][E.DateTimeOriginal]  = captureStr;
  p["Exif"][E.DateTimeDigitized] = captureStr;
  if (cam.offset !== 'none' && offsetString) {
    p["Exif"][TAG_OFFSET_TIME_ORIGINAL] = offsetString;
    if (cam.offset === 'all' || cam.offset === 'two') p["Exif"][TAG_OFFSET_TIME] = exportOffset || offsetString;
    if (cam.offset === 'all') p["Exif"][TAG_OFFSET_TIME_DIGITIZED] = offsetString;
  }
  // ShutterSpeedValue and ApertureValue: Adobe rewrites both as N/1000000, reduced by tens.
  p["Exif"][E.ShutterSpeedValue] = written.shutterSpeedValue;
  p["Exif"][E.ApertureValue]     = apertureValue;
  if (w.brightness === 'cf')       p["Exif"][E.BrightnessValue] = ratFloat32(bv);
  else if (w.brightness === 2560)  p["Exif"][E.BrightnessValue] = [Math.round(bv * 2560), 2560];
  else if (w.brightness)           p["Exif"][E.BrightnessValue] = ratFixed(bv, w.brightness);
  p["Exif"][E.ExposureBiasValue] = w.expComp === 1 ? reduce(Math.round(biasStops * 3), 3) : [Math.round(biasStops * w.expComp), w.expComp];
  if (w.maxAperture === 'apex')          p["Exif"][E.MaxApertureValue] = lens && lens.apex ? lens.apex : ratFixed(2 * Math.log2(widest), 100);
  else if (w.maxAperture === 'eighth')   p["Exif"][E.MaxApertureValue] = eighthStopAperture(apertureAtFocal);
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
    } else if (s.perCmRat) {
      p["Exif"][E.FocalPlaneXResolution] = s.perCmRat;
      p["Exif"][E.FocalPlaneYResolution] = s.perCmRat;
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
  // The 2x2 repeat as two SHORTs in the file's (little-endian) order, then RGGB.
  if (w.extras.cfa)        p["Exif"][E.CFAPattern] = "\x02\x00\x02\x00\x00\x01\x01\x02";
  if (w.extras.customRendered != null) p["Exif"][E.CustomRendered] = w.extras.customRendered;
  p["Exif"][E.ExposureMode] = exposureMode;
  p["Exif"][E.WhiteBalance] = whiteBalance;
  if (Array.isArray(w.extras.digitalZoom)) p["Exif"][E.DigitalZoomRatio] = w.extras.digitalZoom;
  else if (w.extras.digitalZoom === 'always') p["Exif"][E.DigitalZoomRatio] = [1, 1];
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
  // GPSVersionID: Camera Raw writes 2.3.0.0 (7 of 7 real exports), Lightroom
  // 2.2.0.0 (3 of 3) and Lightroom Classic 2.2.0.0 (14 of 16).
  p["GPS"][G.GPSVersionID] = editorKind === 'acr' ? [2, 3, 0, 0] : [2, 2, 0, 0];
  p["GPS"][G.GPSLatitudeRef]  = latRef;
  p["GPS"][G.GPSLatitude]     = adobeGps(Math.abs(loc.lat));
  p["GPS"][G.GPSLongitudeRef] = lonRef;
  p["GPS"][G.GPSLongitude]    = adobeGps(Math.abs(loc.lon));
  p["GPS"][G.GPSAltitudeRef]  = loc.alt < 0 ? 1 : 0;
  p["GPS"][G.GPSAltitude]     = [Math.round(Math.abs(loc.alt) * 100), 100];
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
        profileDigest: cam.profileDigest, lensCorrection: drawLensCorrection(cam, lens) }
    // Always a generated name in the phone's own convention: the user's real
    // filename would identify them or the original photo.
    : phoneSource(cam, capture, subsec);
  const aux = isBody ? {
    serialNumber, lensSerial,
    firmware: cam.firmware || null,
    focusDistance: rnd() < 0.5 ? `${randInt(5, 900)}/10` : '4294967295/1',
    corrected: cam.writer === 'canon' || cam.writer === 'sony',
  } : {};

  return {
    display, piexif: p, cam, loc, iso, lens, editor,
    capture, exportAt, offset: offsetString, exportOffset, subsec, keepDateDropped,
    scene: scene.name, ev: Number(ev.toFixed(2)),
    lensMeta, source, aux,
  };
}

// Lens corrections in the 40 raw-source exports on disk (one uploader's
// repeats counted once): profile correction and lateral CA removal both on in
// 27, both off in 10, the profile alone in 2, CA removal alone in 1.
const LENS_CORRECTION = [[true, true, 27], [false, false, 10], [true, false, 2], [false, true, 1]];

/**
 * Whether the export has lens-profile correction and lateral CA removal on.
 * Profile correction is on only for a lens whose Camera Raw profile was copied
 * from a real export (data.js `lcp`), on a body that does not carry its own;
 * otherwise it is off, drawn from the measured cells with it off.
 */
function drawLensCorrection(cam, lens) {
  const profile = (!cam.rawLensProfile && lens?.lcp) || null;
  const cells = profile ? LENS_CORRECTION : LENS_CORRECTION.filter(([on]) => !on);
  let r = rnd() * cells.reduce((n, c) => n + c[2], 0);
  const [on, autoCA] = cells.find(c => (r -= c[2]) <= 0) || cells[0];
  return { profile: on ? profile : null, autoCA };
}

/** A camera-raw-style file stem, like "4E4A0122" or "DSC_1234". */
function rawFileStem(cam) {
  if (cam.writer === 'canon') return hex(4).toUpperCase() + digits(4);
  return `${cam.raw.prefix}${digits(4)}`;
}

// The iPhone source a desktop export names, IMG_nnnn with these extensions:
// 16 exports from 10 Wikimedia Commons uploaders (2024 on, each uploader
// weighted equally, ProRAW DNGs left out). None had a lowercase .jpg.
const IPHONE_EXT = { HEIC: 4.0, JPG: 2.5, jpeg: 2.5, JPEG: 1.0 };

/** The phone's original file, in its own naming; an iPhone's may be HEIC. */
function phoneSource(cam, capture, subsec) {
  const stem = phoneStem(cam, capture, subsec);
  if (cam.make !== 'Apple') return { raw: false, fileName: `${stem}.jpg` };
  const ext = weightedPick(IPHONE_EXT);
  return { raw: false, fileName: `${stem}.${ext}`, mime: ext === 'HEIC' ? 'image/heic' : 'image/jpeg' };
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
  const anchor = Date.now() - randInt(1, 120) * DAY - Math.floor(rnd() * DAY);
  const exportAt = new Date(anchor);
  exportAt.setHours(pickExportHour(), randInt(0, 59), randInt(0, 59), 0);
  const editor = pickEditor(rnd() < 0.5 ? 'acr' : 'lr', exportAt);
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
