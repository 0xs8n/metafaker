#!/usr/bin/env node
/**
 * Measure when real US phone photos are taken, relative to the sun at their
 * own place and date, and print the CAPTURE_* tables for js/exif.js.
 *
 *     node tools/capture_times.js <phone-survey.jsonl>
 *
 * The input is the Wikimedia Commons phone survey tools/exposure_tables.py
 * reads (one JSON object per file with title, user, Make, DateTimeOriginal,
 * GPSLatitude, GPSLongitude and their Ref fields). Files located in the United
 * States, one count per uploader. A photo taken between sunrise and sunset is
 * kept as its fraction of the daylight; one taken outside it as the time since
 * sunset, in half hours.
 * The share after civil dusk (sun below -6 degrees) is printed for check.js.
 */
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';

const { PLACES, ZONES } = await import(new URL('../js/places.js', import.meta.url));
const { wallClockToUtc, sunElevation, sunriseSunset } = await import(new URL('../js/helpers.js', import.meta.url));

const US_BOXES = [[24.5, 49.5, -125, -66.9], [18.5, 22.5, -161, -154], [51, 71.5, -170, -130]];
const DAY_BINS = 20;

function zoneOf(lat, lon) {
  let best = null, bd = Infinity;
  for (const p of PLACES) {
    const d = (p[1] - lat) ** 2 + ((p[2] - lon) * Math.cos(lat * Math.PI / 180)) ** 2;
    if (d < bd) { bd = d; best = p; }
  }
  return ZONES[best[6]];
}

export function readPhotos(file) {
  const seen = new Set(), out = [];
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    const r = JSON.parse(line);
    if (seen.has(r.title) || !r.Make) continue;
    seen.add(r.title);
    let lat = parseFloat(r.GPSLatitude), lon = parseFloat(r.GPSLongitude);
    if (!isFinite(lat) || !isFinite(lon)) continue;
    if (r.GPSLatitudeRef === 'S') lat = -Math.abs(lat);
    if (r.GPSLongitudeRef === 'W') lon = -Math.abs(lon);
    if (!US_BOXES.some(([a, b, c, d]) => lat >= a && lat <= b && lon >= c && lon <= d)) continue;
    const m = /^(\d{4}):(\d\d):(\d\d) (\d\d):(\d\d):(\d\d)/.exec(r.DateTimeOriginal || '');
    if (!m || +m[1] < 2005) continue;
    const wall = new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
    const tz = zoneOf(lat, lon);
    const sun = sunriseSunset(lat, lon, wall, tz);
    const min = +m[4] * 60 + +m[5] + +m[6] / 60;
    out.push({
      r, user: r.user, hour: +m[4],
      dusk: sunElevation(lat, lon, wallClockToUtc(wall, tz)) < -6,
      dayFraction: sun && min >= sun.rise && min <= sun.set ? (min - sun.rise) / (sun.set - sun.rise) : null,
      afterSunset: sun ? ((min - sun.set) % 1440 + 1440) % 1440 : null,
    });
  }
  return out;
}

/** Sum of fn(photo) with every uploader weighing one in total. */
export function perUploader(photos, fn) {
  const by = new Map();
  for (const p of photos) by.set(p.user, [...(by.get(p.user) || []), p]);
  let s = 0;
  for (const g of by.values()) for (const p of g) s += fn(p) / g.length / by.size;
  return { value: s, uploaders: by.size };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const photos = readPhotos(process.argv[2]);
  const share = fn => 100 * perUploader(photos, fn).value;
  const day = Array.from({ length: DAY_BINS }, (_, i) =>
    share(p => p.dayFraction !== null && Math.min(DAY_BINS - 1, Math.floor(p.dayFraction * DAY_BINS)) === i));
  const night = Array.from({ length: 48 }, (_, i) => share(p => p.dayFraction === null && Math.floor(p.afterSunset / 30) === i));
  while (night.length && night[night.length - 1] < 0.005) night.pop();
  const f = a => a.map(x => Number(x.toFixed(2))).join(', ');
  const { uploaders } = perUploader(photos, () => 0);
  console.log(`// ${photos.length} files from ${uploaders} uploaders; ${share(p => p.dusk).toFixed(1)}% after civil dusk`);
  console.log(`const CAPTURE_DAYLIGHT = [${f(day)}];`);
  console.log(`const CAPTURE_AFTER_SUNSET = [${f(night)}];`);
}
