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
  pick, randInt, clamp, US_GPS_BOUNDS,
  jitterUsLocation, fmtDate, fmtGpsDate, gpsTimeStamp, randomDate,
  decToDMS, dmsToDec, dataUrlToBlob,
  fmtBytes, fromRat, cleanExifStr, escapeHtml,
} from './helpers.js';
import { CAMERAS, LOCATIONS, getLensInfo } from './data.js';

// ── GPS Enforcement ──────────────────────────────────────────────

/**
 * Re-write GPS tags on a data URL to ensure valid US coordinates.
 * This is a second pass after piexif.insert to fix any GPS inconsistencies.
 */
export function enforceUsGpsOnDataUrl(dataUrl, loc, altitude = 0) {
  if (!loc) return dataUrl;
  const px = window.piexif;
  const exifObj = px.load(dataUrl);
  exifObj["GPS"] = exifObj["GPS"] || {};

  const safeLat = clamp(Math.abs(loc.lat), US_GPS_BOUNDS.minLat, US_GPS_BOUNDS.maxLat);
  const safeLon = clamp(Math.abs(loc.lon), Math.abs(US_GPS_BOUNDS.maxLon), Math.abs(US_GPS_BOUNDS.minLon));
  const safeAlt = Math.max(0, Math.round(Number(altitude) || 0));

  exifObj["GPS"][px.GPSIFD.GPSVersionID]    = [2, 3, 0, 0];
  exifObj["GPS"][px.GPSIFD.GPSLatitudeRef]  = "N";
  exifObj["GPS"][px.GPSIFD.GPSLatitude]     = decToDMS(safeLat);
  exifObj["GPS"][px.GPSIFD.GPSLongitudeRef] = "W";
  exifObj["GPS"][px.GPSIFD.GPSLongitude]    = decToDMS(safeLon);
  exifObj["GPS"][px.GPSIFD.GPSAltitudeRef]  = 0;
  exifObj["GPS"][px.GPSIFD.GPSAltitude]     = [safeAlt, 1];

  return px.insert(px.dump(exifObj), dataUrl);
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
  const cam      = pick(CAMERAS);
  const shutter  = pick(cam.shutters);
  const aperture = pick(cam.apertures);
  const iso      = pick(cam.isos);
  const focal    = pick(cam.focals);
  // If an original date is provided, keep the same calendar date but randomize time
  let date;
  if (options.originalDate instanceof Date && !isNaN(options.originalDate)) {
    const d = options.originalDate;
    date = new Date(d.getFullYear(), d.getMonth(), d.getDate(), randInt(0, 23), randInt(0, 59), randInt(0, 59));
  } else {
    date = randomDate();
  }
  const flash    = pick([0, 16, 24]);
  const meteringMode = cam.type === 'phone' ? 5 : pick([2, 3, 5]);
  const exposureProgram = cam.type === 'phone' ? 2 : pick([1, 2, 3, 4]);
  const whiteBalance = pick([0, 0, 0, 1]); // mostly auto
  const loc = jitterUsLocation(pick(LOCATIONS));
  const lens = getLensInfo(cam, focal, aperture);

  // Canvas output is already correctly oriented, so always write 1 (normal)
  const orientation = 1;

  // DPI: phones use 72, DSLRs use 240 or 300
  const dpi = cam.type === 'phone' ? 72 : pick([240, 300]);

  // Sub-second precision — real cameras always write this
  const subSec = String(randInt(10, 999)).padStart(3, '0');

  // Exposure mode: manual if program is manual, auto otherwise
  const exposureMode = exposureProgram === 1 ? 1 : 0;

  // ── Display object (flat key-value for UI rendering)
  const display = {
    Make: cam.make, Model: cam.model, Software: cam.sw,
    LensMake: lens.make, LensModel: lens.model,
    DateTimeOriginal: date, DateTime: date, SubSecTimeOriginal: subSec,
    ExposureTime: shutter[0] / shutter[1], FNumber: aperture, ISO: iso,
    FocalLength: focal, FocalLengthIn35mmFormat: focal,
    Flash: flash, MeteringMode: meteringMode,
    ExposureProgram: exposureProgram, ExposureMode: exposureMode,
    WhiteBalance: whiteBalance, SceneCaptureType: 0, SensingMethod: 2,
    Orientation: orientation, ColorSpace: 1,
    XResolution: dpi, YResolution: dpi,
    GPSLatitude: loc.lat, GPSLongitude: loc.lon, GPSAltitude: randInt(0, 400),
  };

  // ── Piexif write object (structured for binary EXIF injection)
  const px = window.piexif;
  const dateStr = fmtDate(date);
  const p = { "0th": {}, "Exif": {}, "GPS": {}, "Interop": {}, "1st": {} };

  // 0th IFD — basic image info
  p["0th"][px.ImageIFD.Make]           = cam.make;
  p["0th"][px.ImageIFD.Model]          = cam.model;
  p["0th"][px.ImageIFD.Software]       = cam.sw;
  p["0th"][px.ImageIFD.DateTime]       = dateStr;
  p["0th"][px.ImageIFD.XResolution]    = [dpi, 1];
  p["0th"][px.ImageIFD.YResolution]    = [dpi, 1];
  p["0th"][px.ImageIFD.ResolutionUnit] = 2;
  p["0th"][px.ImageIFD.Orientation]    = orientation;

  // Exif IFD — capture settings
  p["Exif"][px.ExifIFD.ExposureTime]          = shutter;
  p["Exif"][px.ExifIFD.FNumber]               = [Math.round(aperture * 100), 100];
  p["Exif"][px.ExifIFD.ISOSpeedRatings]       = iso;
  p["Exif"][px.ExifIFD.DateTimeOriginal]      = dateStr;
  p["Exif"][px.ExifIFD.DateTimeDigitized]     = dateStr;
  p["Exif"][px.ExifIFD.FocalLength]           = [focal * 10, 10];
  p["Exif"][px.ExifIFD.FocalLengthIn35mmFilm] = focal;
  p["Exif"][px.ExifIFD.Flash]                 = flash;
  p["Exif"][px.ExifIFD.MeteringMode]          = meteringMode;
  p["Exif"][px.ExifIFD.ExposureProgram]       = exposureProgram;
  p["Exif"][px.ExifIFD.WhiteBalance]          = whiteBalance;
  p["Exif"][px.ExifIFD.ColorSpace]            = 1; // sRGB

  // Exposure bias: mostly 0, sometimes +/- 0.3 or 0.7 EV
  const biasChoices = [[0,1],[0,1],[0,1],[1,3],[-1,3],[2,3],[-2,3],[1,1],[-1,1]];
  p["Exif"][px.ExifIFD.ExposureBiasValue] = pick(biasChoices);

  // APEX brightness/speed/aperture values (derived from settings)
  const et = shutter[0] / shutter[1];
  p["Exif"][px.ExifIFD.ShutterSpeedValue] = [Math.round(-Math.log2(et) * 100), 100];
  p["Exif"][px.ExifIFD.ApertureValue]     = [Math.round(2 * Math.log2(aperture) * 100), 100];
  p["Exif"][px.ExifIFD.MaxApertureValue]  = [Math.round(2 * Math.log2(Math.min(...cam.apertures)) * 100), 100];

  // Standard tags that real cameras always write (absence is a forensic red flag)
  p["Exif"][px.ExifIFD.ExifVersion]             = "0232";
  p["Exif"][px.ExifIFD.FlashpixVersion]         = "0100";
  p["Exif"][px.ExifIFD.ComponentsConfiguration] = "\x01\x02\x03\x00"; // YCbCr
  p["Exif"][px.ExifIFD.FileSource]              = "\x03";              // digital still camera
  p["Exif"][px.ExifIFD.SceneType]               = "\x01";              // directly photographed
  p["Exif"][px.ExifIFD.CustomRendered]          = 0;                   // normal processing
  p["Exif"][px.ExifIFD.ExposureMode]            = exposureMode;
  p["Exif"][px.ExifIFD.SceneCaptureType]        = 0;                   // standard
  p["Exif"][px.ExifIFD.SensingMethod]           = 2;                   // one-chip color area sensor
  p["Exif"][px.ExifIFD.SubSecTime]              = subSec;
  p["Exif"][px.ExifIFD.SubSecTimeOriginal]      = subSec;
  p["Exif"][px.ExifIFD.SubSecTimeDigitized]     = subSec;
  p["Exif"][px.ExifIFD.DigitalZoomRatio]        = [100, 100];          // 1.0x (no zoom)
  p["Exif"][px.ExifIFD.Contrast]                = 0;                   // normal
  p["Exif"][px.ExifIFD.Saturation]              = 0;                   // normal
  p["Exif"][px.ExifIFD.Sharpness]               = 0;                   // normal
  p["Exif"][px.ExifIFD.LensMake]                = lens.make;
  p["Exif"][px.ExifIFD.LensModel]               = lens.model;
  // PixelXDimension / PixelYDimension are set later in processRandomizeItem
  // after the canvas render determines actual output dimensions.

  // GPS IFD — US location
  p["GPS"][px.GPSIFD.GPSLatitudeRef]  = "N";
  p["GPS"][px.GPSIFD.GPSLatitude]     = decToDMS(loc.lat);
  p["GPS"][px.GPSIFD.GPSLongitudeRef] = "W";
  p["GPS"][px.GPSIFD.GPSLongitude]    = decToDMS(Math.abs(loc.lon));
  p["GPS"][px.GPSIFD.GPSAltitudeRef]  = 0;
  p["GPS"][px.GPSIFD.GPSAltitude]     = [display.GPSAltitude, 1];
  p["GPS"][px.GPSIFD.GPSDateStamp]    = fmtGpsDate(date);
  p["GPS"][px.GPSIFD.GPSTimeStamp]    = gpsTimeStamp(date);
  p["GPS"][px.GPSIFD.GPSMapDatum]     = "WGS-84";

  return { display, piexif: p, cam, loc };
}

// ── Metadata Display ─────────────────────────────────────────────

/** Which EXIF fields to show in each UI section. */
export const SECTIONS = [
  { key: 'device',  title: 'Device',          fields: ['Make','Model','Software','LensMake','LensModel'] },
  { key: 'capture', title: 'Capture Settings', fields: ['DateTimeOriginal','DateTime','SubSecTimeOriginal','ExposureTime','FNumber','ISO','FocalLength','FocalLengthIn35mmFormat','Flash','MeteringMode','ExposureProgram','ExposureMode','WhiteBalance','SceneCaptureType','SensingMethod'] },
  { key: 'gps',     title: 'Location (GPS)',   fields: ['GPSLatitude','GPSLongitude','GPSAltitude'] },
  { key: 'image',   title: 'Image',            fields: ['PixelXDimension','PixelYDimension','ImageWidth','ImageHeight','Orientation','ColorSpace','XResolution','YResolution'] },
];

/** Human-readable labels for EXIF field keys. */
export const LABELS = {
  Make:'Camera Make', Model:'Camera Model', Software:'Software',
  LensMake:'Lens Make', LensModel:'Lens Model',
  DateTimeOriginal:'Date Taken', DateTime:'Date Modified', SubSecTimeOriginal:'Sub-Second',
  ExposureTime:'Shutter Speed', FNumber:'Aperture', ISO:'ISO',
  FocalLength:'Focal Length', FocalLengthIn35mmFormat:'35mm Equiv.',
  Flash:'Flash', MeteringMode:'Metering', ExposureProgram:'Program',
  ExposureMode:'Exposure Mode', WhiteBalance:'White Balance',
  SceneCaptureType:'Scene Capture', SensingMethod:'Sensor',
  GPSLatitude:'Latitude', GPSLongitude:'Longitude', GPSAltitude:'Altitude',
  PixelXDimension:'Pixel Width', PixelYDimension:'Pixel Height',
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
    case 'DateTimeOriginal': case 'DateTime':
      if (v instanceof Date) return v.toLocaleString();
      return String(v);
    case 'Flash':            return FLASH_MAP[v]   ?? `Code ${v}`;
    case 'MeteringMode':     return METER_MAP[v]   ?? `Mode ${v}`;
    case 'ExposureProgram':  return PROG_MAP[v]    ?? `${v}`;
    case 'Orientation':      return ORIENT_MAP[v]  ?? `${v}`;
    case 'WhiteBalance':     return WB_MAP[v]      ?? `${v}`;
    case 'ColorSpace':       return CS_MAP[v]      ?? `${v}`;
    case 'ExposureMode':     return EXPMODE_MAP[v] ?? `${v}`;
    case 'SceneCaptureType': return SCENE_MAP[v]   ?? `${v}`;
    case 'SensingMethod':    return SENSING_MAP[v] ?? `${v}`;
    case 'SubSecTimeOriginal': return String(v);
    case 'PixelXDimension': case 'PixelYDimension':
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
        let latDec = typeof lat === 'number' ? lat : (Array.isArray(lat) && lat.length >= 3 ? lat[0] + lat[1]/60 + lat[2]/3600 : null);
        let lonDec = typeof lon === 'number' ? lon : (Array.isArray(lon) && lon.length >= 3 ? lon[0] + lon[1]/60 + lon[2]/3600 : null);
        if (latRef === 'S') latDec = -Math.abs(latDec);
        if (lonRef === 'W' || (!lonRef && lonDec > 0)) lonDec = -Math.abs(lonDec);
        if (latDec != null && lonDec != null) {
          extra = `<a class="gps-link" href="https://maps.google.com/?q=${latDec},${lonDec}" target="_blank" rel="noopener">Map</a>`;
        }
      }

      rows.push(`<div class="meta-row">
        <span class="meta-key">${LABELS[field] || field}</span>
        <span class="meta-val${isFake ? ' is-new' : ''}">${disp}${extra}</span>
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
