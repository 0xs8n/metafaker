/**
 * exif.js — EXIF metadata generation, parsing, and display.
 *
 * Handles:
 * - Generating realistic fake EXIF data (generateFake)
 * - Reading/verifying EXIF from processed images (readBackExifStrict)
 * - Parsing EXIF from uploaded files (parseFileExif)
 * - Converting piexif internal format to display-friendly objects
 * - Formatting and rendering metadata for the UI
 * - Enforcing US GPS coordinates on data URLs
 */

import exifr from 'https://cdn.jsdelivr.net/npm/exifr@7.1.3/dist/full.esm.js';
import {
  pick, randInt, clamp, cryptoRandInt,
  jitterLocation, fmtDate, fmtGpsDate, gpsTimeStamp, randomDate,
  wallClockToUtc, tzOffsetString,
  decToDMS, dmsToDec, dataUrlToBlob,
  fromRat, cleanExifStr, escapeHtml,
} from './helpers.js';
import { CAMERAS, LOCATIONS, pickOptics } from './data.js';
import { buildMakerNote } from './makernote.js';
import { dumpExifSafe } from './exif-writer.js';

// ── GPS Enforcement ──────────────────────────────────────────────

/**
 * Re-write GPS tags on a data URL to ensure valid global coordinates.
 * This is a second pass after piexif.insert to fix any GPS inconsistencies.
 * Handles both hemispheres: lat can be N/S, lon can be E/W.
 */
export function enforceValidGps(dataUrl, loc, altitude = 0) {
  if (!loc) return dataUrl;
  const px = window.piexif;
  const exifObj = px.load(dataUrl);
  exifObj["GPS"] = exifObj["GPS"] || {};

  const safeLat = clamp(Math.abs(loc.lat), 0, 89.99);
  const safeLon = clamp(Math.abs(loc.lon), 0, 179.99);
  const latRef  = loc.lat >= 0 ? "N" : "S";
  const lonRef  = loc.lon >= 0 ? "E" : "W";
  const safeAlt = Math.max(0, Math.round(Number(altitude) || 0));

  exifObj["GPS"][px.GPSIFD.GPSVersionID]    = [2, 3, 0, 0];
  exifObj["GPS"][px.GPSIFD.GPSLatitudeRef]  = latRef;
  exifObj["GPS"][px.GPSIFD.GPSLatitude]     = decToDMS(safeLat);
  exifObj["GPS"][px.GPSIFD.GPSLongitudeRef] = lonRef;
  exifObj["GPS"][px.GPSIFD.GPSLongitude]    = decToDMS(safeLon);
  exifObj["GPS"][px.GPSIFD.GPSAltitudeRef]  = 0;
  exifObj["GPS"][px.GPSIFD.GPSAltitude]     = [safeAlt, 1];

  return px.insert(dumpExifSafe(exifObj, px), dataUrl);
}

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

/**
 * Scene brightness in EV at ISO 100, weighted the way a real camera roll is:
 * mostly daylight, a good share of interiors, a little night.
 */
const SCENES = [
  { name: 'daylight', evMin: 13, evMax: 16, weight: 36, dark: false },
  { name: 'overcast', evMin: 10, evMax: 13, weight: 24, dark: false },
  { name: 'indoor',   evMin:  6, evMax:  9, weight: 25, dark: false },
  { name: 'dim',      evMin:  3, evMax:  6, weight: 10, dark: true  },
  { name: 'night',    evMin:  0, evMax:  3, weight:  5, dark: true  },
];

function pickScene() {
  let r = Math.random() * SCENES.reduce((n, s) => n + s.weight, 0);
  for (const s of SCENES) { r -= s.weight; if (r <= 0) return s; }
  return SCENES[0];
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
 * Picks a random camera, settings, date, and US location, then builds
 * both a display object (for UI) and a piexif object (for binary writing).
 * Includes all standard tags that real cameras write — SubSecTime, ExifVersion,
 * ComponentsConfiguration, FileSource, LensModel, etc. — to avoid forensic red flags.
 *
 * Returns { display, piexif, cam, loc }.
 */
export function generateFake(options = {}) {
  const cam = pick(CAMERAS);
  const loc = jitterLocation(pick(LOCATIONS));

  // Focal length, aperture and lens are chosen together so they describe a
  // camera that can be assembled and a lens that can take the shot.
  const { focalPhys, focalEquiv, aperture, lens } = pickOptics(cam);

  let date;
  if (options.originalDate instanceof Date && !isNaN(options.originalDate)) {
    const d = options.originalDate;
    date = new Date(d.getFullYear(), d.getMonth(), d.getDate(), randInt(0, 23), randInt(0, 59), randInt(0, 59));
  } else {
    date = randomDate();
  }

  // ── Exposure: one scene drives shutter, ISO and flash together.
  const scene = pickScene();
  const flashFired = scene.dark && Math.random() < (cam.type === 'phone' ? 0.35 : 0.25);
  // A fired flash lights the subject, so the frame is metered several stops
  // brighter than the ambient scene.
  const rawEv = scene.evMin + Math.random() * (scene.evMax - scene.evMin) + (flashFired ? 3 : 0);
  const [evLo, evHi] = cameraEvRange(cam, aperture);
  const ev = clamp(rawEv, evLo, evHi);

  const { shutter, iso } = solveExposure(cam, aperture, ev, focalEquiv);
  const exposureSec = shutter[0] / shutter[1];

  const flash = flashFired ? 25 : (scene.dark ? pick([24, 16]) : pick([24, 16, 0]));
  const meteringMode    = cam.type === 'phone' ? 5 : pick([2, 3, 5]);
  const exposureProgram = cam.type === 'phone' ? 2 : pick([1, 2, 3, 4]);
  const whiteBalance    = pick([0, 0, 0, 1]);
  const orientation     = 1;
  const exposureMode    = exposureProgram === 1 ? 1 : 0;
  const sceneCapture    = scene.name === 'night' ? 3 : 0;

  // GPS timestamps are UTC, resolved through the photographed city's zone.
  const utc          = wallClockToUtc(date, loc.tz);
  const offsetString = tzOffsetString(utc, loc.tz);

  // Per-image randomised fields — formerly all fixed constants (forensic red flags)
  const dpi             = cam.type === 'phone' ? pick([72, 72, 72, 96]) : pick([240, 240, 300, 350, 360]);
  const subSec          = String(cryptoRandInt(10, 999)).padStart(3, '0');
  const contrast        = pick([0, 0, 0, 1, 2]);
  const saturation      = pick([0, 0, 0, 1, 2]);
  const sharpness       = pick([0, 0, 0, 1, 2]);
  const customRendered  = cam.type === 'phone' ? pick([0, 0, 6]) : 0;    // 6 = HDR
  const digitalZoom     = cam.type === 'phone' ? pick([[100,100],[120,100],[150,100],[200,100]]) : [100, 100];
  const colorSpace      = cam.type === 'phone' ? pick([1, 1, 1, 65535]) : 1;
  const sensingMethod   = cam.type === 'phone' ? pick([1, 2, 2, 2]) : 2;
  const flashpixVersion = pick(["0100", "0101"]);

  // GPS direction refs
  const latRef = loc.lat >= 0 ? "N" : "S";
  const lonRef = loc.lon >= 0 ? "E" : "W";

  // ── Display object
  const display = {
    Make: cam.make, Model: cam.model, Software: cam.sw,
    LensMake: lens.make, LensModel: lens.model,
    DateTimeOriginal: date, DateTime: date, SubSecTimeOriginal: subSec,
    ExposureTime: exposureSec, FNumber: aperture, ISO: iso,
    FocalLength: focalPhys, FocalLengthIn35mmFormat: focalEquiv,
    Flash: flash, MeteringMode: meteringMode,
    ExposureProgram: exposureProgram, ExposureMode: exposureMode,
    WhiteBalance: whiteBalance, SceneCaptureType: sceneCapture, SensingMethod: sensingMethod,
    Orientation: orientation, ColorSpace: colorSpace,
    XResolution: dpi, YResolution: dpi,
    GPSLatitude: loc.lat, GPSLongitude: loc.lon, GPSAltitude: loc.alt,
  };

  // ── Piexif write object
  const px = window.piexif;
  const dateStr = fmtDate(date);
  const p = { "0th": {}, "Exif": {}, "GPS": {}, "Interop": {}, "1st": {} };

  p["0th"][px.ImageIFD.Make]           = cam.make;
  p["0th"][px.ImageIFD.Model]          = cam.model;
  p["0th"][px.ImageIFD.Software]       = cam.sw;
  p["0th"][px.ImageIFD.DateTime]       = dateStr;
  p["0th"][px.ImageIFD.XResolution]    = [dpi, 1];
  p["0th"][px.ImageIFD.YResolution]    = [dpi, 1];
  p["0th"][px.ImageIFD.ResolutionUnit] = 2;
  p["0th"][px.ImageIFD.Orientation]    = orientation;
  // Required for JPEG by the Exif spec; `exiftool -validate` reports its
  // absence, and a camera file that fails validation is its own signal.
  p["0th"][px.ImageIFD.YCbCrPositioning] = 1;   // centered

  p["Exif"][px.ExifIFD.ExposureTime]          = shutter;
  p["Exif"][px.ExifIFD.FNumber]               = [Math.round(aperture * 100), 100];
  p["Exif"][px.ExifIFD.ISOSpeedRatings]       = iso;
  p["Exif"][px.ExifIFD.DateTimeOriginal]      = dateStr;
  p["Exif"][px.ExifIFD.DateTimeDigitized]     = dateStr;
  // FocalLength is the real lens, FocalLengthIn35mmFilm the equivalent. On a
  // phone these differ by the sensor crop; writing the equivalent into both
  // claimed a 26mm lens inside a handset.
  p["Exif"][px.ExifIFD.FocalLength]           = [Math.round(focalPhys * 100), 100];
  p["Exif"][px.ExifIFD.FocalLengthIn35mmFilm] = focalEquiv;
  p["Exif"][px.ExifIFD.Flash]                 = flash;
  p["Exif"][px.ExifIFD.MeteringMode]          = meteringMode;
  p["Exif"][px.ExifIFD.ExposureProgram]       = exposureProgram;
  p["Exif"][px.ExifIFD.WhiteBalance]          = whiteBalance;
  p["Exif"][px.ExifIFD.ColorSpace]            = colorSpace;

  const biasChoices = [[0,1],[0,1],[0,1],[1,3],[-1,3],[2,3],[-2,3],[1,1],[-1,1]];
  p["Exif"][px.ExifIFD.ExposureBiasValue] = pick(biasChoices);

  // APEX values, derived from the solved exposure so they agree with it.
  const widestAperture = cam.type === 'phone'
    ? Math.min(...cam.lenses.map(l => l.f))
    : Math.min(...cam.apertures);
  p["Exif"][px.ExifIFD.ShutterSpeedValue] = [Math.round(-Math.log2(exposureSec) * 100), 100];
  p["Exif"][px.ExifIFD.ApertureValue]     = [Math.round(2 * Math.log2(aperture) * 100), 100];
  p["Exif"][px.ExifIFD.MaxApertureValue]  = [Math.round(2 * Math.log2(widestAperture) * 100), 100];
  p["Exif"][px.ExifIFD.BrightnessValue]   = [Math.round(apexBrightness(aperture, exposureSec, iso) * 100), 100];

  // ExifVersion varies by camera firmware era — "0232" is very recent (2023+),
  // "0231" is common for 2018–2022 devices, "0230" for older hardware.
  const exifVersion = cam.type === 'phone'
    ? pick(["0231", "0231", "0232"])   // phones tend to be newer firmware
    : pick(["0230", "0231", "0231"]);  // DSLRs often trail
  p["Exif"][px.ExifIFD.ExifVersion]             = exifVersion;
  p["Exif"][px.ExifIFD.FlashpixVersion]         = flashpixVersion;
  p["Exif"][px.ExifIFD.ComponentsConfiguration] = "\x01\x02\x03\x00";
  p["Exif"][px.ExifIFD.FileSource]              = "\x03";
  p["Exif"][px.ExifIFD.SceneType]               = "\x01";
  p["Exif"][px.ExifIFD.CustomRendered]          = customRendered;
  p["Exif"][px.ExifIFD.ExposureMode]            = exposureMode;
  p["Exif"][px.ExifIFD.SceneCaptureType]        = sceneCapture;
  p["Exif"][px.ExifIFD.SensingMethod]           = sensingMethod;
  p["Exif"][px.ExifIFD.SubSecTime]              = subSec;
  p["Exif"][px.ExifIFD.SubSecTimeOriginal]      = subSec;
  p["Exif"][px.ExifIFD.SubSecTimeDigitized]     = subSec;
  p["Exif"][px.ExifIFD.DigitalZoomRatio]        = digitalZoom;
  p["Exif"][px.ExifIFD.Contrast]                = contrast;
  p["Exif"][px.ExifIFD.Saturation]              = saturation;
  p["Exif"][px.ExifIFD.Sharpness]               = sharpness;
  if (lens.make)  p["Exif"][px.ExifIFD.LensMake]  = lens.make;
  if (lens.model) p["Exif"][px.ExifIFD.LensModel] = lens.model;
  // PixelXDimension / PixelYDimension set later after canvas render

  // A camera JPEG almost always carries a MakerNote; only Apple's is
  // synthesised, because only its offsets survive being relocated. See
  // makernote.js for what this does and does not buy.
  const makerNote = buildMakerNote(cam.make, {
    iso, focalEquiv, scene: scene.name,
    iosMajor: parseInt(String(cam.sw).split('.')[0], 10) || 17,
  });
  if (makerNote) p["Exif"][px.ExifIFD.MakerNote] = makerNote;

  // The UTC offset the capture time was recorded at. Every current phone writes
  // this, and a GPS timestamp with no offset tag beside it stands out.
  if (offsetString && registerOffsetTimeTags(px)) {
    p["Exif"][TAG_OFFSET_TIME]           = offsetString;
    p["Exif"][TAG_OFFSET_TIME_ORIGINAL]  = offsetString;
    p["Exif"][TAG_OFFSET_TIME_DIGITIZED] = offsetString;
  }

  p["GPS"][px.GPSIFD.GPSLatitudeRef]  = latRef;
  p["GPS"][px.GPSIFD.GPSLatitude]     = decToDMS(Math.abs(loc.lat));
  p["GPS"][px.GPSIFD.GPSLongitudeRef] = lonRef;
  p["GPS"][px.GPSIFD.GPSLongitude]    = decToDMS(Math.abs(loc.lon));
  p["GPS"][px.GPSIFD.GPSAltitudeRef]  = 0;
  p["GPS"][px.GPSIFD.GPSAltitude]     = [display.GPSAltitude, 1];
  // UTC, converted from the capture time through the city's own zone.
  p["GPS"][px.GPSIFD.GPSDateStamp]    = fmtGpsDate(utc);
  p["GPS"][px.GPSIFD.GPSTimeStamp]    = gpsTimeStamp(utc);
  p["GPS"][px.GPSIFD.GPSMapDatum]     = "WGS-84";

  alignAsciiValues(p, px);

  return { display, piexif: p, cam, loc, iso, scene: scene.name, ev: Number(ev.toFixed(2)) };
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
const FLASH_MAP   = { 0:'No flash', 1:'Flash fired', 16:'Flash off', 24:'Flash off', 25:'Flash fired', 31:'Flash fired + red-eye' };
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
    return { html: `<div class="no-meta"><div class="no-meta-icon"><span class="material-icons" style="font-size:inherit">photo_camera</span></div><p>No EXIF metadata found in this image.</p></div>`, count: 0 };
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

      // Add a "Map" link next to latitude
      let extra = '';
      if (field === 'GPSLatitude') {
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
          extra = `<a class="gps-link" href="https://maps.google.com/?q=${latDec},${lonDec}" target="_blank" rel="noopener">Map</a>`;
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
    return { html: `<div class="no-meta"><div class="no-meta-icon"><span class="material-icons" style="font-size:inherit">photo_camera</span></div><p>No recognized EXIF fields found.</p></div>`, count: 0 };
  }

  return { html, count };
}
