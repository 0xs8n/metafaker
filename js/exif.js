/**
 * exif.js — EXIF metadata generation, parsing, and display.
 *
 * Handles:
 * - Generating realistic fake EXIF data (generateFake)
 * - Reading/verifying EXIF from processed images (readBackExifStrict)
 * - Parsing EXIF from uploaded files (parseFileExif)
 * - Converting piexif internal format to display-friendly objects
 * - Formatting and rendering metadata for the UI
 */

// Vendored: a bare module import from a CDN cannot carry an integrity hash,
// so a compromised CDN could run anything it liked against the user's photos,
// and every load handed the CDN the user's IP address and referrer.
import exifr from '../vendor/exifr.esm.js';
import { ICONS } from './icons.js';
import {
  pick, randInt, clamp, cryptoRandInt,
  jitterLocation, fmtDate, fmtGpsDate, gpsTimeStamp,
  wallClockToUtc, tzOffsetString, sunElevation,
  dmsToDec, dataUrlToBlob,
  fromRat, cleanExifStr, escapeHtml,
} from './helpers.js';
import { CAMERAS, LOCATIONS, EXIF_PROFILES, pickOptics } from './data.js';
import { pickEditor } from './provenance.js';

// ── EXIF Parsing ─────────────────────────────────────────────────

/**
 * Parse EXIF metadata from a File object using the exifr library.
 * Returns a flat object of EXIF fields, or {} if parsing fails.
 */
export async function parseFileExif(file) {
  try {
    const raw = await exifr.parse(file, { all: true, gps: true, tiff: true, exif: true, iptc: true });
    return raw || {};
  } catch (e) {
    return {};
  }
}

/**
 * Convert piexif's internal IFD structure to a flat display-friendly object.
 * Maps numeric tag IDs to human-readable field names with decoded values.
 */
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

  // 0th IFD (main image info)
  set('Make',        cleanExifStr(z[px.ImageIFD.Make]));
  set('Model',       cleanExifStr(z[px.ImageIFD.Model]));
  set('Software',    cleanExifStr(z[px.ImageIFD.Software]));
  set('DateTime',    cleanExifStr(z[px.ImageIFD.DateTime]));
  set('XResolution', fromRat(z[px.ImageIFD.XResolution]));
  set('YResolution', fromRat(z[px.ImageIFD.YResolution]));
  set('Orientation', z[px.ImageIFD.Orientation]);

  // Exif IFD (capture settings)
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

  // GPS IFD
  const latRef = cleanExifStr(g[px.GPSIFD.GPSLatitudeRef]);
  const lonRef = cleanExifStr(g[px.GPSIFD.GPSLongitudeRef]);
  set('GPSLatitude',  dmsToDec(g[px.GPSIFD.GPSLatitude], latRef));
  set('GPSLongitude', dmsToDec(g[px.GPSIFD.GPSLongitude], lonRef));
  const alt = fromRat(g[px.GPSIFD.GPSAltitude]);
  if (typeof alt === 'number') set('GPSAltitude', g[px.GPSIFD.GPSAltitudeRef] === 1 ? -alt : alt);

  return out;
}

/**
 * Verify that EXIF was correctly written to a data URL.
 * Tries exifr first (more robust), falls back to piexif readback.
 * Returns { blob, exif, parser, warning }.
 */
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

  // Fallback: try piexif's own readback
  try {
    const parsed = piexifToDisplay(window.piexif.load(dataUrl));
    if (Object.keys(parsed).length) {
      return {
        blob,
        exif: parsed,
        parser: 'piexif',
        warning: `EXIF was written, but exifr readback failed (${exifrErr?.message || 'unknown error'}).`,
      };
    }
  } catch (e) {
    const exifrMsg = exifrErr?.message || 'unknown exifr error';
    throw new Error(`Metadata verification failed (exifr: ${exifrMsg}; piexif: ${e.message})`);
  }

  throw new Error(`Metadata verification failed (${exifrErr?.message || 'no readable EXIF found'})`);
}

// ── Fake EXIF Generation ─────────────────────────────────────────

/** Scene brightness bands in EV at ISO 100. */
const SCENES = {
  daylight: { evMin: 13, evMax: 16, dark: false },
  overcast: { evMin: 10, evMax: 13, dark: false },
  indoor:   { evMin:  6, evMax:  9, dark: false },
  dim:      { evMin:  3, evMax:  6, dark: true  },
  night:    { evMin:  0, evMax:  3, dark: true  },
};

function weightedPick(weights) {
  const entries = Object.entries(weights);
  let r = Math.random() * entries.reduce((n, [, w]) => n + w, 0);
  for (const [k, w] of entries) { r -= w; if (r <= 0) return k; }
  return entries[0][0];
}

/**
 * Choose the scene from where the sun actually was.
 *
 * Brightness used to be drawn independently of the clock, so one night-time
 * frame in three claimed full daylight. The sun's elevation at the claimed
 * place and time is a one-line computation for anyone checking, so the scene
 * follows it: high sun is mostly daylight, twilight is mostly interiors, and
 * after dark there is no daylight at all.
 */
function pickScene(sunEl) {
  let w;
  if      (sunEl > 25) w = { daylight: 55, overcast: 25, indoor: 20 };
  else if (sunEl >  8) w = { daylight: 35, overcast: 35, indoor: 25, dim: 5 };
  else if (sunEl > -6) w = { overcast: 20, indoor: 45, dim: 30, night: 5 };
  else                 w = { indoor: 50, dim: 30, night: 20 };
  const name = weightedPick(w);
  return { name, ...SCENES[name] };
}

/** When people take pictures: hardly at all before dawn, mostly through the day and evening. */
const HOUR_WEIGHTS = [1, 1, 1, 1, 1, 1, 2, 4, 6, 8, 8, 8, 9, 9, 9, 9, 9, 9, 8, 7, 5, 4, 2, 1.5];
function pickHour() {
  return Number(weightedPick(Object.fromEntries(HOUR_WEIGHTS.map((w, i) => [i, w]))));
}

const HOUR = 36e5, DAY = 864e5;

/**
 * Capture and export instants.
 *
 * Both are wall-clock readings in the photographed city; the zone is applied
 * when they are converted. The capture is drawn from the two years before an
 * anchor that itself sits a random one to ninety days in the past, so the
 * latest date in a batch no longer says when the tool was run. The export
 * follows the capture by hours to weeks, during waking hours, as a real one
 * does — the earlier version wrote capture and export as the same second.
 */
function pickDates(originalDate) {
  const anchor = Date.now() - randInt(1, 90) * DAY - Math.floor(Math.random() * DAY);
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
  if (exportAt.getTime() <= capture.getTime() + HOUR) {
    exportAt = new Date(capture.getTime() + randInt(2, 8) * HOUR);
  }
  return { capture, exportAt };
}

// ── Rational encodings ──
//
// Each firmware serialises its rationals its own way, and an editor export
// carries those strings through. Writing every value as n/100 for all nine
// makes was a signature of this writer.
const gcd = (a, b) => (b ? gcd(b, a % b) : a);
const reduce = (n, d) => { const g = gcd(Math.abs(n), d) || 1; return [n / g, d / g]; };
const ratFixed   = (v, den) => [Math.round(v * den), den];
const ratReduced = (v, den) => reduce(Math.round(v * den), den);
const ratOdd     = v => { const den = randInt(1000, 9999); return [Math.round(v * den), den]; };
const ratEighths = v => reduce(Math.round(v * 8), 8);

function apexRat(style, v) {
  switch (style) {
    case 'odd':     return ratOdd(v);
    case 'micro':   return ratFixed(v, 1000000);
    case 'eighths': return ratEighths(v);
    default:        return ratFixed(v, 100);
  }
}

function biasRat(style, stops) {
  switch (style) {
    case 'thirds':     return reduce(Math.round(stops * 3), 3);
    case 'sixths':     return [Math.round(stops * 6), 6];
    case 'tenths':     return [Math.round(stops * 10), 10];
    case 'hundredths': return [Math.round(stops * 100), 100];
    default:           return [0, 1];
  }
}

/**
 * A lens focal or f-number as LensSpecification carries it: 24/1, 28/10,
 * 178/100 — the same form the XMP aux:LensInfo string uses, so the two copies
 * of the value in the file agree byte for byte.
 */
const specRat = v => (Number.isInteger(v) ? [v, 1]
  : Math.abs(v * 10 - Math.round(v * 10)) < 1e-9 ? [Math.round(v * 10), 10]
  : [Math.round(v * 100), 100]);

/**
 * Coordinates as Adobe writes them: degrees, decimal minutes to four places,
 * and a zero seconds field. XMP stores GPS as "DDD,MM.mmmmN", and when the
 * exporter reconciles that back into the EXIF block the seconds come out as
 * 0/1 whatever precision the camera used. It is the one encoding that is the
 * same for every make here, because the exporter wrote it, not the camera.
 */
function adobeDegMin(abs) {
  const d = Math.floor(abs);
  const m = Math.round((abs - d) * 60 * 10000);
  return [[d, 1], [m, 10000], [0, 1]];
}

/**
 * Solve a physically consistent shutter/ISO pair for a scene and aperture.
 *
 * Exposure is not three free variables. They are tied together by
 *
 *     N² / t  =  (ISO / 100) · 2^EV
 *
 * so picking shutter, aperture and ISO independently produced frames no scene
 * could have produced — ISO 51200 at 1/4000s and f/1.4 describes somewhere
 * darker than a sealed room, and anyone who computes EV back out of the EXIF
 * sees it at a glance.
 *
 * Real cameras resolve it the way this does: hold the aperture, raise ISO only
 * as far as the shutter requires, then land on a speed from the fixed ladder.
 * The rounding left over from that snap is kept, because a real camera's EXIF
 * does not come out algebraically perfect either.
 *
 * Checked against a published OnePlus 5 frame — ISO 500, f/1.7, 1/100, which
 * is EV 5.85. Fed that scene and aperture, this returns ISO 400 at 1/125.
 */
function solveExposure(cam, aperture, ev, focalEquiv) {
  const isos = [...cam.isos].sort((a, b) => a - b);
  const seconds = s => s[0] / s[1];

  // Slowest shutter still expected to come out sharp. Phones stabilise hard and
  // target around 1/60; bodies follow roughly the 1/focal reciprocal rule.
  const slowest = cam.type === 'phone'
    ? 1 / 60
    : clamp(1 / Math.max(focalEquiv, 1), 1 / 250, 1 / 30);

  const required = iso => 100 * aperture * aperture / (iso * Math.pow(2, ev));

  // Lowest ISO that keeps the shutter short enough; if none does, the sensor is
  // maxed out and the exposure simply runs long, as it would at night.
  let iso = isos[isos.length - 1];
  for (const candidate of isos) {
    if (required(candidate) <= slowest) { iso = candidate; break; }
  }

  // Snap to the nearest rung in stops, not in seconds.
  const want = required(iso);
  let shutter = cam.shutters[0];
  let bestErr = Infinity;
  for (const s of cam.shutters) {
    const err = Math.abs(Math.log2(seconds(s)) - Math.log2(want));
    if (err < bestErr) { bestErr = err; shutter = s; }
  }
  return { shutter, iso };
}

/**
 * The brightest and darkest scenes this body can actually meter at a given
 * aperture — base ISO with its fastest shutter at one end, maximum ISO with its
 * slowest at the other.
 *
 * Scenes are clamped into this range before solving. Without it, an f/1.42
 * phone handed full midday sun needed 1/16000s, its shutter stopped at 1/4000,
 * and the written triplet came out two stops away from the scene it claimed.
 * Real hardware cannot record what it cannot expose, so neither should this.
 */
function cameraEvRange(cam, aperture) {
  const secs   = cam.shutters.map(s => s[0] / s[1]);
  const evAt   = (t, iso) => Math.log2(aperture * aperture / t) - Math.log2(iso / 100);
  return [
    evAt(Math.max(...secs), Math.max(...cam.isos)),
    evAt(Math.min(...secs), Math.min(...cam.isos)),
  ];
}

/**
 * Pad ASCII values to an even byte count before writing.
 *
 * TIFF wants every value to start on a word boundary. piexifjs concatenates
 * value data without padding, so one odd-length string — "17.4.1" and its
 * terminator come to 7 bytes — pushes everything after it onto odd offsets, and
 * `exiftool -validate` then reports a string of "Odd offset for ..." warnings on
 * every file the tool produces. That is a deterministic signature of the writer,
 * which is exactly what this project exists to avoid.
 *
 * piexifjs appends the NUL terminator itself, so a value is even overall when
 * the string length is odd. Real encoders pad the same way, and every reader
 * strips trailing NULs, so nothing downstream sees a difference.
 *
 * Only Ascii-typed tags are touched: Undefined tags such as ExifVersion are
 * fixed-width and must not grow. So are a handful of Ascii ones — GPSDateStamp
 * is specified as exactly 11 bytes, and padding it to 12 trades one validation
 * warning for another.
 */
const FIXED_LENGTH_ASCII = new Set([
  `GPS:${0x001d}`,   // GPSDateStamp, "YYYY:MM:DD\0"
]);

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

/** APEX brightness: Bv = Av + Tv - Sv. Wrong here would be its own tell. */
function apexBrightness(aperture, exposureSec, iso) {
  const av = 2 * Math.log2(aperture);
  const tv = -Math.log2(exposureSec);
  const sv = Math.log2(iso / 3.125);
  return av + tv - sv;
}

// piexifjs 1.0.6 predates the OffsetTime tags, so its writer rejects them
// unless they are registered. Every current phone writes OffsetTimeOriginal,
// and its absence next to a GPS timestamp is conspicuous.
const TAG_OFFSET_TIME            = 0x9010;
const TAG_OFFSET_TIME_ORIGINAL   = 0x9011;
const TAG_OFFSET_TIME_DIGITIZED  = 0x9012;

function registerOffsetTimeTags(px) {
  const tags = px?.TAGS?.Exif;
  if (!tags) return false;
  if (!tags[TAG_OFFSET_TIME])           tags[TAG_OFFSET_TIME]           = { name: 'OffsetTime',          type: 'Ascii' };
  if (!tags[TAG_OFFSET_TIME_ORIGINAL])  tags[TAG_OFFSET_TIME_ORIGINAL]  = { name: 'OffsetTimeOriginal',  type: 'Ascii' };
  if (!tags[TAG_OFFSET_TIME_DIGITIZED]) tags[TAG_OFFSET_TIME_DIGITIZED] = { name: 'OffsetTimeDigitized', type: 'Ascii' };
  return true;
}

/**
 * Generate a complete set of realistic fake EXIF metadata.
 *
 * Picks a camera, a US location, a lens, a capture time and the scene the
 * sun allows at that time, solves a consistent exposure, and writes the tag
 * set that camera's firmware writes — in the encodings it uses — as it would
 * survive a Camera Raw export. The export's own fields (Software, the resolution,
 * the export date in ModifyDate, the Interoperability IFD) are the editor's.
 *
 * Returns { display, piexif, cam, loc, lens, editor, capture, exportAt, ... }.
 */
export function generateFake(options = {}) {
  const px = window.piexif;
  const cam = pick(CAMERAS);
  const prof = EXIF_PROFILES[cam.make];
  const loc = jitterLocation(pick(LOCATIONS));
  const editor = pickEditor();

  // Focal length, aperture and lens are chosen together so they describe a
  // camera that can be assembled and a lens that can take the shot.
  const { focalPhys, focalEquiv, aperture, lens } = pickOptics(cam);

  const { capture, exportAt } = pickDates(options.originalDate);
  const utc          = wallClockToUtc(capture, loc.tz);
  const exportUtc    = wallClockToUtc(exportAt, loc.tz);
  const offsetString = tzOffsetString(utc, loc.tz);
  const exportOffset = tzOffsetString(exportUtc, loc.tz);

  // ── Exposure: the sun fixes the scene; one scene drives shutter, ISO and flash.
  const scene = pickScene(sunElevation(loc.lat, loc.lon, utc));
  const flashFired = !!cam.flash && scene.dark && Math.random() < (cam.type === 'phone' ? 0.3 : 0.25);
  // A fired flash lights the subject, so the frame is metered several stops
  // brighter than the ambient scene.
  const rawEv = scene.evMin + Math.random() * (scene.evMax - scene.evMin) + (flashFired ? 3 : 0);
  const [evLo, evHi] = cameraEvRange(cam, aperture);
  const ev = clamp(rawEv, evLo, evHi);

  const { shutter, iso } = solveExposure(cam, aperture, ev, focalEquiv);
  const exposureSec = shutter[0] / shutter[1];

  const flash           = flashFired ? prof.flashFired : pick(prof.flashOff);
  const meteringMode    = pick(prof.metering);
  const exposureProgram = cam.type === 'phone' ? 2 : pick([1, 2, 3, 3, 3, 4]);
  const exposureMode    = exposureProgram === 1 ? 1 : 0;
  const whiteBalance    = cam.type === 'phone' ? 0 : pick([0, 0, 0, 1]);
  const sceneCapture    = scene.name === 'night' ? 3 : 0;
  const biasStops       = cam.type === 'phone' ? 0 : pick([0, 0, 0, 1 / 3, -1 / 3, 2 / 3, -2 / 3, 1, -1]);
  const subsec = !prof.subsec ? null
    : prof.subsec.endsWith('3') ? String(cryptoRandInt(0, 999)).padStart(3, '0')
    : String(cryptoRandInt(0, 99)).padStart(2, '0');
  // The exporter's resolution, not the camera's: Camera Raw defaults to 240.
  const dpi = pick([240, 240, 240, 300, 72]);

  const widestAperture = cam.type === 'phone'
    ? Math.min(...cam.lenses.map(l => l.f))
    : Math.min(...cam.apertures);
  const tv = -Math.log2(exposureSec);
  const av = 2 * Math.log2(aperture);
  const bv = apexBrightness(aperture, exposureSec, iso);

  const latRef = loc.lat >= 0 ? "N" : "S";
  const lonRef = loc.lon >= 0 ? "E" : "W";

  // ── Display object
  const display = {
    Make: cam.make, Model: cam.model, Software: editor.software,
    LensMake: lens.make, LensModel: lens.model,
    DateTimeOriginal: capture, DateTime: exportAt, SubSecTimeOriginal: subsec,
    OffsetTimeOriginal: cam.offsetTime ? offsetString : null,
    ExposureTime: exposureSec, FNumber: aperture, ISO: iso,
    FocalLength: focalPhys, FocalLengthIn35mmFormat: prof.tags.focalEquiv ? focalEquiv : null,
    Flash: flash, MeteringMode: meteringMode,
    ExposureProgram: exposureProgram, ExposureMode: exposureMode,
    WhiteBalance: whiteBalance, SceneCaptureType: sceneCapture,
    SensingMethod: prof.tags.sensing ? 2 : null,
    Orientation: 1, ColorSpace: 1,
    XResolution: dpi, YResolution: dpi,
    GPSLatitude: loc.lat, GPSLongitude: loc.lon, GPSAltitude: loc.alt,
  };

  // ── Piexif write object
  const I = px.ImageIFD, E = px.ExifIFD, G = px.GPSIFD;
  const captureStr = fmtDate(capture);
  const exportStr  = fmtDate(exportAt);
  const p = { "0th": {}, "Exif": {}, "GPS": {}, "Interop": {}, "1st": {} };

  p["0th"][I.Make]           = cam.make;
  p["0th"][I.Model]          = cam.model;
  p["0th"][I.Orientation]    = 1;
  p["0th"][I.XResolution]    = [dpi, 1];
  p["0th"][I.YResolution]    = [dpi, 1];
  p["0th"][I.ResolutionUnit] = 2;
  p["0th"][I.Software]       = editor.software;   // the exporter, not the camera
  p["0th"][I.DateTime]       = exportStr;         // when the export was written
  // Required for JPEG by the Exif spec; `exiftool -validate` reports its
  // absence, and a camera file that fails validation is its own signal.
  p["0th"][I.YCbCrPositioning] = 1;

  p["Exif"][E.ExposureTime]    = shutter;
  p["Exif"][E.FNumber]         = prof.fnumber === 'reduced' ? ratReduced(aperture, 100) : ratFixed(aperture, prof.fnumber);
  p["Exif"][E.ExposureProgram] = exposureProgram;
  p["Exif"][E.ISOSpeedRatings] = iso;
  if (prof.tags.sensitivity) {
    p["Exif"][E.SensitivityType] = prof.tags.sensitivity;
    if (prof.tags.sensitivity === 1 && E.StandardOutputSensitivity) p["Exif"][E.StandardOutputSensitivity] = iso;
    else p["Exif"][E.RecommendedExposureIndex] = iso;
  }
  p["Exif"][E.ExifVersion]       = cam.exifVersion;
  p["Exif"][E.DateTimeOriginal]  = captureStr;
  p["Exif"][E.DateTimeDigitized] = captureStr;
  if (cam.offsetTime && offsetString && registerOffsetTimeTags(px)) {
    p["Exif"][TAG_OFFSET_TIME]           = exportOffset || offsetString;
    p["Exif"][TAG_OFFSET_TIME_ORIGINAL]  = offsetString;
    p["Exif"][TAG_OFFSET_TIME_DIGITIZED] = offsetString;
  }
  p["Exif"][E.ComponentsConfiguration] = "\x01\x02\x03\x00";
  // APEX values, derived from the solved exposure so they agree with it.
  p["Exif"][E.ShutterSpeedValue] = apexRat(prof.apex, tv);
  p["Exif"][E.ApertureValue]     = apexRat(prof.apex, av);
  if (prof.brightness) p["Exif"][E.BrightnessValue] = prof.brightness === 'odd' ? ratOdd(bv) : ratFixed(bv, 100);
  p["Exif"][E.ExposureBiasValue] = biasRat(prof.bias, biasStops);
  if (prof.maxAperture) p["Exif"][E.MaxApertureValue] = ratFixed(2 * Math.log2(widestAperture), prof.maxAperture);
  p["Exif"][E.MeteringMode] = meteringMode;
  if (prof.tags.lightSource) p["Exif"][E.LightSource] = 0;
  p["Exif"][E.Flash] = flash;
  // FocalLength is the real lens, FocalLengthIn35mmFilm the equivalent. On a
  // phone these differ by the sensor crop; writing the equivalent into both
  // claimed a 26mm lens inside a handset.
  p["Exif"][E.FocalLength] = cam.type === 'phone'
    ? (prof.fnumber === 'reduced' ? ratReduced(focalPhys, 100) : ratFixed(focalPhys, 100))
    : [focalPhys, 1];
  if (subsec) {
    if (prof.subsec !== 'od3') p["Exif"][E.SubSecTime] = subsec;
    p["Exif"][E.SubSecTimeOriginal]  = subsec;
    p["Exif"][E.SubSecTimeDigitized] = subsec;
  }
  p["Exif"][E.FlashpixVersion] = "0100";
  p["Exif"][E.ColorSpace]      = 1;       // the export is sRGB whatever the camera shot
  // PixelXDimension / PixelYDimension set later after canvas render
  if (prof.tags.sensing)    p["Exif"][E.SensingMethod] = 2;
  if (prof.tags.fileSource) p["Exif"][E.FileSource]    = "\x03";
  if (prof.tags.sceneType)  p["Exif"][E.SceneType]     = "\x01";
  if (prof.tags.cfa)        p["Exif"][E.CFAPattern]    = "\x00\x02\x00\x02\x00\x01\x01\x02";
  if (prof.tags.customRendered != null) p["Exif"][E.CustomRendered] = prof.tags.customRendered;
  p["Exif"][E.ExposureMode] = exposureMode;
  p["Exif"][E.WhiteBalance] = whiteBalance;
  if (prof.tags.digitalZoom) p["Exif"][E.DigitalZoomRatio] = [1, 1];
  if (prof.tags.focalEquiv)  p["Exif"][E.FocalLengthIn35mmFilm] = focalEquiv;
  p["Exif"][E.SceneCaptureType] = sceneCapture;
  if (prof.tags.gainControl) p["Exif"][E.GainControl] = iso < 400 ? 0 : iso < 1600 ? 1 : 2;
  if (prof.tags.colorAdj) {
    p["Exif"][E.Contrast]   = 0;
    p["Exif"][E.Saturation] = 0;
    p["Exif"][E.Sharpness]  = 0;
  }
  if (prof.tags.subjectDistance) p["Exif"][E.SubjectDistanceRange] = 0;

  // Lens tags: only the ones this firmware writes. Canon leaves the apertures
  // in its LensSpecification as 0/0.
  const lensTags = cam.lensTags || prof.lensTags;
  if (lensTags.includes('make')  && lens.make)  p["Exif"][E.LensMake]  = lens.make;
  if (lensTags.includes('model') && lens.model) p["Exif"][E.LensModel] = lens.model;
  if (lensTags.includes('info')  && lens.spec) {
    const [f1, f2, a1, a2] = lens.spec;
    p["Exif"][E.LensSpecification] = cam.make === 'Canon'
      ? [specRat(f1), specRat(f2), [0, 0], [0, 0]]
      : [specRat(f1), specRat(f2), specRat(a1), specRat(a2)];
  }

  // No MakerNote. An editor export does not carry one — every Camera Raw
  // export sampled had zero MakerNote tags — so writing one would contradict
  // the Software field rather than add realism.

  // The exporter writes an Interoperability IFD on every sRGB JPEG.
  p["Interop"][px.InteropIFD.InteroperabilityIndex]   = "R98";
  p["Interop"][px.InteropIFD.InteroperabilityVersion] = "0100";

  // ── GPS, in the exporter's coordinate encoding and the camera's tag set.
  if (prof.gps.version) p["GPS"][G.GPSVersionID] = prof.gps.version;
  p["GPS"][G.GPSLatitudeRef]  = latRef;
  p["GPS"][G.GPSLatitude]     = adobeDegMin(Math.abs(loc.lat));
  p["GPS"][G.GPSLongitudeRef] = lonRef;
  p["GPS"][G.GPSLongitude]    = adobeDegMin(Math.abs(loc.lon));
  p["GPS"][G.GPSAltitudeRef]  = 0;
  p["GPS"][G.GPSAltitude]     = prof.gps.apple ? ratOdd(loc.alt + Math.random()) : [loc.alt, 1];
  // UTC, converted from the capture time through the city's own zone.
  p["GPS"][G.GPSTimeStamp]    = gpsTimeStamp(utc);
  if (prof.gps.status) p["GPS"][G.GPSStatus] = "A";
  if (prof.gps.apple) {
    // iOS logs motion and heading with every frame.
    const heading = Math.random() * 360;
    p["GPS"][G.GPSSpeedRef]         = "K";
    p["GPS"][G.GPSSpeed]            = Math.random() < 0.6 ? [0, 1] : ratOdd(0.3 + Math.random() * 4);
    p["GPS"][G.GPSImgDirectionRef]  = "T";
    p["GPS"][G.GPSImgDirection]     = ratOdd(heading);
    p["GPS"][G.GPSDestBearingRef]   = "T";
    p["GPS"][G.GPSDestBearing]      = ratOdd(heading);
    p["GPS"][G.GPSHPositioningError] = [randInt(4, 35), 1];
  }
  if (prof.gps.mapDatum) p["GPS"][G.GPSMapDatum] = "WGS-84";
  p["GPS"][G.GPSDateStamp] = fmtGpsDate(utc);

  alignAsciiValues(p, px);

  return { display, piexif: p, cam, loc, iso, lens, editor,
           capture, exportAt, offset: offsetString, exportOffset, subsec,
           scene: scene.name, ev: Number(ev.toFixed(2)) };
}

// ── Metadata Display ─────────────────────────────────────────────

/**
 * Which EXIF fields to show in each UI section.
 *
 * Two parsers feed this: exifr (normal path) and piexifToDisplay (fallback).
 * They name several tags differently, so both spellings are listed — a given
 * object only ever carries one of each pair, so no row is duplicated.
 *   0x0132 DateTime        -> exifr: ModifyDate
 *   0xA002 PixelXDimension -> exifr: ExifImageWidth
 *   0xA003 PixelYDimension -> exifr: ExifImageHeight
 */
export const SECTIONS = [
  { key: 'device',  title: 'Device',          fields: ['Make','Model','Software','LensMake','LensModel'] },
  { key: 'capture', title: 'Capture Settings', fields: ['DateTimeOriginal','DateTime','ModifyDate','OffsetTimeOriginal','SubSecTimeOriginal','ExposureTime','FNumber','ISO','FocalLength','FocalLengthIn35mmFormat','Flash','MeteringMode','ExposureProgram','ExposureMode','WhiteBalance','SceneCaptureType','SensingMethod'] },
  { key: 'gps',     title: 'Location (GPS)',   fields: ['GPSLatitude','GPSLongitude','GPSAltitude'] },
  { key: 'image',   title: 'Image',            fields: ['PixelXDimension','PixelYDimension','ExifImageWidth','ExifImageHeight','ImageWidth','ImageHeight','Orientation','ColorSpace','XResolution','YResolution'] },
];

/** Human-readable labels for EXIF field keys. */
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

// Lookup maps for numeric EXIF codes → human-readable strings
const FLASH_MAP   = { 0:'No flash', 1:'Flash fired', 9:'Flash fired', 16:'Flash off', 24:'Flash off', 25:'Flash fired', 31:'Flash fired + red-eye' };
const METER_MAP   = { 1:'Average', 2:'Center-weighted', 3:'Spot', 4:'Multi-spot', 5:'Multi-segment', 6:'Partial' };
const PROG_MAP    = { 0:'Not defined', 1:'Manual', 2:'Auto', 3:'Aperture priority', 4:'Shutter priority', 5:'Creative', 6:'Action', 7:'Portrait', 8:'Landscape' };
const ORIENT_MAP  = { 1:'Normal (0 deg)', 3:'Rotated 180 deg', 6:'Rotated 90 deg CW', 8:'Rotated 90 deg CCW' };
const WB_MAP      = { 0:'Auto', 1:'Manual' };
const CS_MAP      = { 1:'sRGB', 65535:'Uncalibrated' };
const EXPMODE_MAP = { 0:'Auto', 1:'Manual', 2:'Auto bracket' };
const SCENE_MAP   = { 0:'Standard', 1:'Landscape', 2:'Portrait', 3:'Night' };
const SENSING_MAP = { 1:'Not defined', 2:'One-chip color area', 3:'Two-chip color area', 4:'Three-chip color area', 5:'Color sequential area', 7:'Trilinear', 8:'Color sequential linear' };

/**
 * Look up a numeric EXIF code in one of the maps above.
 *
 * exifr parsed with { all: true } already translates many of these tags to
 * readable strings ("Pattern", "Flash did not fire, auto mode"). Feeding those
 * to a numeric map misses, and the miss fallback used to prepend its prefix —
 * which is where "Mode Pattern" and "Code Flash did not fire, auto mode" came
 * from. Anything already a string is passed straight through.
 */
function mapCode(map, v, prefix = '') {
  return typeof v === 'number' ? (map[v] ?? `${prefix}${v}`) : String(v);
}

/** Format a raw EXIF value for display based on its field key. */
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

/**
 * Render an EXIF object as sectioned HTML for the metadata panel.
 * Returns { html, count } where count is the number of displayed fields.
 */
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

      // A "Map" link next to the latitude, for generated coordinates only.
      // The original image's coordinates are the user's real position, and a
      // link would send them to a map provider on click, so none is offered.
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
        // Only a ref flips the sign. Without one, the value is already signed
        // (both exifr and piexifToDisplay return signed decimals) — assuming a
        // hemisphere here would send eastern coordinates to the wrong side.
        if (latDec != null && latRef === 'S') latDec = -Math.abs(latDec);
        if (lonDec != null && lonRef === 'W') lonDec = -Math.abs(lonDec);
        if (latDec != null && lonDec != null) {
          const la = latDec.toFixed(5), lo = lonDec.toFixed(5);
          extra = `<a class="gps-link" href="https://www.openstreetmap.org/?mlat=${la}&mlon=${lo}#map=14/${la}/${lo}" target="_blank" rel="noopener noreferrer">Map</a>`;
        }
      }

      // disp comes from EXIF in an untrusted image and lands in innerHTML.
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
