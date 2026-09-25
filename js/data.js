/**
 * data.js — Static databases for camera profiles, global locations, and lens models.
 *
 * Every string here is what the real device writes into EXIF, not the marketing
 * name. Those differ more than you would expect, and the mismatches are trivial
 * for an analyst to spot:
 *
 *   Samsung writes Make as lowercase "samsung".
 *   Nikon writes Make as "NIKON CORPORATION" and Model as "NIKON Z 9", with a space.
 *   Sony writes Make as "SONY" in caps, and Software as "<model> v<firmware>".
 *   Apple writes Software as a bare version string, "17.4.1", with no "iOS" prefix.
 *   Android phones write Software as a build fingerprint, not a UI version.
 *
 * Sources for the field formats are noted in README.md.
 */

import { pick } from './helpers.js';

// ── Camera Database ──────────────────────────────────────────────
//
// Phones declare `lenses`, because on a phone the focal length and the aperture
// are properties of one fixed lens — an iPhone cannot shoot its 77mm telephoto
// at f/1.78. Picking focal and aperture independently produced combinations no
// such phone can physically produce.
//
//   equiv — 35mm-equivalent focal length, the marketing figure, written to
//           FocalLengthIn35mmFilm
//   phys  — the actual focal length of the lens in mm, written to FocalLength.
//           A phone lens is a few mm; writing the equivalent here was the single
//           clearest tell in the generated EXIF.
//   f     — that lens's fixed aperture
//
// Main-camera `phys` values come from published EXIF samples (iPhone 24mm/6.86mm,
// Samsung 24mm/6.3mm, OnePlus 24mm/4.1mm — crop factors 3.5, 3.8 and 5.9).
// Ultrawide and telephoto values are derived from those bodies' lens-class crop
// factors (~8.3 ultrawide, ~8.5 tele) and are representative rather than
// per-model exact.
//
// Bodies declare `focals` (actual lens mm) plus `crop`, so FocalLengthIn35mmFilm
// is derived: an APS-C body must report 23mm actual and 35mm equivalent, never
// the same number twice.

export const CAMERAS = [
  // ── Apple ──
  { make:"Apple", model:"iPhone 15 Pro", sw:"17.4.1", type:"phone", lensWord:"triple",
    lenses:[{equiv:13,phys:2.22,f:2.2},{equiv:24,phys:6.86,f:1.78},{equiv:48,phys:6.86,f:1.78},{equiv:77,phys:9.0,f:2.8}],
    isos:[25,32,40,50,64,80,100,125,160,200,250,400,640,800,1000,1600,2500,3200],
    shutters:[[1,4000],[1,2000],[1,1000],[1,500],[1,250],[1,125],[1,60],[1,30],[1,15],[1,8],[1,4]] },

  { make:"Apple", model:"iPhone 14 Pro Max", sw:"16.7.8", type:"phone", lensWord:"triple",
    lenses:[{equiv:13,phys:2.22,f:2.2},{equiv:24,phys:6.86,f:1.78},{equiv:48,phys:6.86,f:1.78},{equiv:77,phys:9.0,f:2.8}],
    isos:[25,32,50,64,100,125,200,400,640,1600,2500],
    shutters:[[1,4000],[1,2000],[1,1000],[1,500],[1,250],[1,125],[1,60],[1,30],[1,15],[1,8]] },

  { make:"Apple", model:"iPhone 13 Pro", sw:"15.8.3", type:"phone", lensWord:"triple",
    lenses:[{equiv:13,phys:1.57,f:1.8},{equiv:26,phys:5.7,f:1.5},{equiv:77,phys:9.0,f:2.8}],
    isos:[25,50,100,200,400,800,1600,2000],
    shutters:[[1,4000],[1,2000],[1,1000],[1,500],[1,250],[1,125],[1,60],[1,30],[1,15]] },

  { make:"Apple", model:"iPhone 12", sw:"14.8.1", type:"phone", lensWord:"dual",
    lenses:[{equiv:13,phys:1.55,f:2.4},{equiv:26,phys:4.2,f:1.6}],
    isos:[25,50,100,200,400,800,1600],
    shutters:[[1,4000],[1,2000],[1,1000],[1,500],[1,250],[1,125],[1,60],[1,30],[1,15]] },

  { make:"Apple", model:"iPhone 11", sw:"14.8.1", type:"phone", lensWord:"dual",
    lenses:[{equiv:13,phys:1.54,f:2.4},{equiv:26,phys:4.25,f:1.8}],
    isos:[25,50,100,200,400,800,1600],
    shutters:[[1,4000],[1,2000],[1,1000],[1,500],[1,250],[1,125],[1,60],[1,30],[1,15]] },

  // ── Samsung — Make is lowercase, Software is the firmware build ──
  { make:"samsung", model:"SM-S928B", sw:"S928BXXU1AWIM", type:"phone",
    lenses:[{equiv:13,phys:2.2,f:2.2},{equiv:24,phys:6.3,f:1.7},{equiv:67,phys:7.9,f:2.4},{equiv:111,phys:13.0,f:3.4}],
    isos:[50,100,200,400,800,1600,3200],
    shutters:[[1,4000],[1,2000],[1,1000],[1,500],[1,250],[1,125],[1,60],[1,30],[1,15],[1,8]] },

  { make:"samsung", model:"SM-S916B", sw:"S916BXXU7EXA1", type:"phone",
    lenses:[{equiv:13,phys:2.2,f:2.2},{equiv:24,phys:6.4,f:1.8},{equiv:70,phys:8.2,f:2.4}],
    isos:[50,100,200,400,800,1600,3200],
    shutters:[[1,4000],[1,2000],[1,1000],[1,500],[1,250],[1,125],[1,60],[1,30],[1,15]] },

  { make:"samsung", model:"SM-A546B", sw:"A546BXXS4EXD2", type:"phone",
    lenses:[{equiv:13,phys:1.9,f:2.2},{equiv:26,phys:4.7,f:1.8}],
    isos:[50,100,200,400,800,1600],
    shutters:[[1,2000],[1,1000],[1,500],[1,250],[1,125],[1,60],[1,30],[1,15]] },

  { make:"samsung", model:"SM-G991B", sw:"G991BXXU8FXD1", type:"phone",
    lenses:[{equiv:13,phys:1.8,f:2.2},{equiv:26,phys:5.4,f:1.8},{equiv:70,phys:7.6,f:2.0}],
    isos:[50,100,200,400,800,1600,3200],
    shutters:[[1,4000],[1,2000],[1,1000],[1,500],[1,250],[1,125],[1,60],[1,30],[1,15]] },

  // ── Google — Software is the HDR+ pipeline build, not the Android version ──
  { make:"Google", model:"Pixel 8 Pro", sw:"HDR+ 1.0.540104767zd", type:"phone",
    lenses:[{equiv:13,phys:1.9,f:1.95},{equiv:25,phys:6.9,f:1.68},{equiv:113,phys:12.5,f:2.8}],
    isos:[50,100,200,400,800,1600,3200],
    shutters:[[1,4000],[1,2000],[1,1000],[1,500],[1,250],[1,125],[1,60],[1,30],[1,15]] },

  { make:"Google", model:"Pixel 7a", sw:"HDR+ 1.0.485286103zd", type:"phone",
    lenses:[{equiv:13,phys:1.8,f:2.2},{equiv:25,phys:5.9,f:1.89}],
    isos:[50,100,200,400,800,1600,3200],
    shutters:[[1,4000],[1,2000],[1,1000],[1,500],[1,250],[1,125],[1,60],[1,30]] },

  { make:"Google", model:"Pixel 6a", sw:"HDR+ 1.0.420988201zd", type:"phone",
    lenses:[{equiv:13,phys:1.8,f:2.2},{equiv:24,phys:4.4,f:1.85}],
    isos:[50,100,200,400,800,1600,3200],
    shutters:[[1,4000],[1,2000],[1,1000],[1,500],[1,250],[1,125],[1,60],[1,30]] },

  // ── OnePlus / Xiaomi — Android build fingerprints ──
  { make:"OnePlus", model:"CPH2583", sw:"CPH2583-user 14 UKQ1.230924.001 release-keys", type:"phone",
    lenses:[{equiv:14,phys:2.2,f:2.2},{equiv:23,phys:6.1,f:1.6},{equiv:73,phys:8.6,f:2.6}],
    isos:[64,100,200,400,800,1600,3200,6400],
    shutters:[[1,4000],[1,2000],[1,1000],[1,500],[1,250],[1,125],[1,60],[1,30],[1,15],[1,8]] },

  { make:"Xiaomi", model:"2312GS7BD", sw:"2312GS7BD-user 14 UKQ1.230804.001 release-keys", type:"phone",
    lenses:[{equiv:14,phys:2.2,f:2.2},{equiv:24,phys:8.7,f:1.42},{equiv:75,phys:8.8,f:2.0}],
    isos:[50,100,200,400,800,1600,3200,6400],
    shutters:[[1,4000],[1,2000],[1,1000],[1,500],[1,250],[1,125],[1,60],[1,30],[1,15],[1,8]] },

  // ── Canon — Make "Canon", Software "Firmware Version x.y.z" ──
  { make:"Canon", model:"Canon EOS R5", sw:"Firmware Version 1.8.2", type:"dslr", crop:1.0,
    apertures:[1.2,1.4,1.8,2.0,2.8,4.0,5.6,8.0,11,16],
    isos:[100,125,160,200,250,320,400,640,800,1600,3200,6400,12800,25600,51200],
    shutters:[[1,8000],[1,4000],[1,2000],[1,1000],[1,500],[1,250],[1,125],[1,60],[1,30],[1,15],[1,8],[1,4],[1,2],[1,1],[2,1],[4,1]],
    focals:[24,35,50,85,100,135,200] },

  { make:"Canon", model:"Canon EOS 5D Mark IV", sw:"Firmware Version 1.3.3", type:"dslr", crop:1.0,
    apertures:[1.4,1.8,2.0,2.8,4.0,5.6,8.0,11,16],
    isos:[100,200,400,800,1600,3200,6400,12800,25600],
    shutters:[[1,8000],[1,4000],[1,2000],[1,1000],[1,500],[1,250],[1,125],[1,60],[1,30],[1,15],[1,8],[1,4]],
    focals:[24,35,50,85,135,200] },

  { make:"Canon", model:"Canon EOS 90D", sw:"Firmware Version 1.1.1", type:"dslr", crop:1.6,
    apertures:[1.8,2.0,2.8,4.0,5.6,8.0,11],
    isos:[100,200,400,800,1600,3200,6400,12800,25600],
    shutters:[[1,8000],[1,4000],[1,2000],[1,1000],[1,500],[1,250],[1,125],[1,60],[1,30]],
    focals:[18,24,35,50,85,100] },

  // ── Nikon — Make "NIKON CORPORATION", Model has a space, Software "Ver.NN.NN" ──
  { make:"NIKON CORPORATION", model:"NIKON Z 9", sw:"Ver.04.00", type:"dslr", crop:1.0,
    apertures:[1.4,1.8,2.0,2.8,4.0,5.6,8.0,11],
    isos:[64,100,200,400,800,1600,3200,6400,12800,25600,51200,102400],
    shutters:[[1,32000],[1,8000],[1,4000],[1,2000],[1,1000],[1,500],[1,250],[1,125],[1,60],[1,30],[1,15],[1,8]],
    focals:[24,35,50,85,105,200,400] },

  { make:"NIKON CORPORATION", model:"NIKON D850", sw:"Ver.01.10", type:"dslr", crop:1.0,
    apertures:[1.8,2.0,2.8,4.0,5.6,8.0,11,16],
    isos:[64,100,200,400,800,1600,3200,6400,12800,25600],
    shutters:[[1,8000],[1,4000],[1,2000],[1,1000],[1,500],[1,250],[1,125],[1,60],[1,30],[1,15]],
    focals:[24,35,50,85,135,200] },

  { make:"NIKON CORPORATION", model:"NIKON Z 6II", sw:"Ver.01.40", type:"dslr", crop:1.0,
    apertures:[1.4,1.8,2.0,2.8,4.0,5.6,8.0,11],
    isos:[100,200,400,800,1600,3200,6400,12800,25600,51200],
    shutters:[[1,8000],[1,4000],[1,2000],[1,1000],[1,500],[1,250],[1,125],[1,60],[1,30],[1,15]],
    focals:[24,35,50,85,105] },

  // ── Sony — Make "SONY", Software "<model> v<firmware>" ──
  { make:"SONY", model:"ILCE-7M4", sw:"ILCE-7M4 v2.01", type:"dslr", crop:1.0,
    apertures:[1.4,1.8,2.0,2.8,4.0,5.6,8.0,11],
    isos:[50,100,200,400,800,1600,3200,6400,12800,25600,51200,102400,204800],
    shutters:[[1,8000],[1,4000],[1,2000],[1,1000],[1,500],[1,250],[1,125],[1,60],[1,30],[1,15],[1,8]],
    focals:[24,35,50,85,135,200] },

  { make:"SONY", model:"ILCE-7RM5", sw:"ILCE-7RM5 v1.00", type:"dslr", crop:1.0,
    apertures:[1.4,1.8,2.0,2.8,4.0,5.6,8.0,11],
    isos:[100,200,400,800,1600,3200,6400,12800,25600,51200],
    shutters:[[1,8000],[1,4000],[1,2000],[1,1000],[1,500],[1,250],[1,125],[1,60],[1,30]],
    focals:[24,35,50,85,135] },

  // ── Fujifilm — APS-C, Software "Digital Camera <model> Ver<n.nn>" ──
  { make:"FUJIFILM", model:"X-T5", sw:"Digital Camera X-T5 Ver4.10", type:"dslr", crop:1.5,
    apertures:[1.4,1.8,2.0,2.8,4.0,5.6,8.0,11],
    isos:[125,160,200,400,800,1600,3200,6400,12800,25600,51200],
    shutters:[[1,8000],[1,4000],[1,2000],[1,1000],[1,500],[1,250],[1,125],[1,60],[1,30],[1,15]],
    focals:[18,23,35,56,90] },

  { make:"FUJIFILM", model:"X100VI", sw:"Digital Camera X100VI Ver1.10", type:"dslr", crop:1.5,
    apertures:[2.0,2.8,4.0,5.6,8.0,11],
    isos:[125,200,400,800,1600,3200,6400,12800,25600],
    shutters:[[1,4000],[1,2000],[1,1000],[1,500],[1,250],[1,125],[1,60],[1,30]],
    focals:[23] },
];

// ── Location Database ────────────────────────────────────────────
//
// lon: negative = West, positive = East.
// alt: ground elevation in metres. A GPS altitude unrelated to the terrain at
//      the coordinates is a cheap consistency check to fail — a Denver photo
//      tagged 143 m rather than ~1600 m does not survive one.
// tz:  IANA zone. GPSTimeStamp is UTC, so it must be derived from the capture
//      time using the zone of the *photographed city*. Deriving it from the
//      machine's own clock leaked the real timezone of whoever ran the tool.

export const LOCATIONS = [
  // Northeast
  { city:"New York, NY",           lat: 40.7128, lon: -74.0060, alt:  10, tz:"America/New_York" },
  { city:"Brooklyn, NY",           lat: 40.6782, lon: -73.9442, alt:  16, tz:"America/New_York" },
  { city:"Boston, MA",             lat: 42.3601, lon: -71.0589, alt:  43, tz:"America/New_York" },
  { city:"Philadelphia, PA",       lat: 39.9526, lon: -75.1652, alt:  12, tz:"America/New_York" },
  { city:"Washington, DC",         lat: 38.9072, lon: -77.0369, alt:   7, tz:"America/New_York" },
  { city:"Baltimore, MD",          lat: 39.2904, lon: -76.6122, alt:  10, tz:"America/New_York" },
  { city:"Pittsburgh, PA",         lat: 40.4406, lon: -79.9959, alt: 233, tz:"America/New_York" },
  { city:"Hartford, CT",           lat: 41.7637, lon: -72.6851, alt:  18, tz:"America/New_York" },
  { city:"Providence, RI",         lat: 41.8240, lon: -71.4128, alt:  12, tz:"America/New_York" },
  { city:"Newark, NJ",             lat: 40.7357, lon: -74.1724, alt:   4, tz:"America/New_York" },
  // Southeast
  { city:"Miami, FL",              lat: 25.7617, lon: -80.1918, alt:   2, tz:"America/New_York" },
  { city:"Orlando, FL",            lat: 28.5383, lon: -81.3792, alt:  25, tz:"America/New_York" },
  { city:"Tampa, FL",              lat: 27.9506, lon: -82.4572, alt:   5, tz:"America/New_York" },
  { city:"Jacksonville, FL",       lat: 30.3322, lon: -81.6557, alt:   5, tz:"America/New_York" },
  { city:"Atlanta, GA",            lat: 33.7490, lon: -84.3880, alt: 320, tz:"America/New_York" },
  { city:"Charlotte, NC",          lat: 35.2271, lon: -80.8431, alt: 229, tz:"America/New_York" },
  { city:"Raleigh, NC",            lat: 35.7796, lon: -78.6382, alt:  96, tz:"America/New_York" },
  { city:"Nashville, TN",          lat: 36.1627, lon: -86.7816, alt: 182, tz:"America/Chicago" },
  { city:"Memphis, TN",            lat: 35.1495, lon: -90.0490, alt:  81, tz:"America/Chicago" },
  { city:"New Orleans, LA",        lat: 29.9511, lon: -90.0715, alt:   1, tz:"America/Chicago" },
  { city:"Birmingham, AL",         lat: 33.5186, lon: -86.8104, alt: 197, tz:"America/Chicago" },
  { city:"Richmond, VA",           lat: 37.5407, lon: -77.4360, alt:  50, tz:"America/New_York" },
  // Midwest
  { city:"Chicago, IL",            lat: 41.8781, lon: -87.6298, alt: 179, tz:"America/Chicago" },
  { city:"Detroit, MI",            lat: 42.3314, lon: -83.0458, alt: 183, tz:"America/Detroit" },
  { city:"Columbus, OH",           lat: 39.9612, lon: -82.9988, alt: 275, tz:"America/New_York" },
  { city:"Cleveland, OH",          lat: 41.4993, lon: -81.6944, alt: 199, tz:"America/New_York" },
  { city:"Indianapolis, IN",       lat: 39.7684, lon: -86.1581, alt: 218, tz:"America/Indiana/Indianapolis" },
  { city:"Milwaukee, WI",          lat: 43.0389, lon: -87.9065, alt: 188, tz:"America/Chicago" },
  { city:"Minneapolis, MN",        lat: 44.9778, lon: -93.2650, alt: 264, tz:"America/Chicago" },
  { city:"St. Louis, MO",          lat: 38.6270, lon: -90.1994, alt: 142, tz:"America/Chicago" },
  { city:"Kansas City, MO",        lat: 39.0997, lon: -94.5786, alt: 277, tz:"America/Chicago" },
  { city:"Omaha, NE",              lat: 41.2565, lon: -95.9345, alt: 332, tz:"America/Chicago" },
  { city:"Des Moines, IA",         lat: 41.5868, lon: -93.6250, alt: 291, tz:"America/Chicago" },
  // Southwest & West Coast
  { city:"Los Angeles, CA",        lat: 34.0522, lon:-118.2437, alt:  93, tz:"America/Los_Angeles" },
  { city:"San Diego, CA",          lat: 32.7157, lon:-117.1611, alt:  19, tz:"America/Los_Angeles" },
  { city:"San Jose, CA",           lat: 37.3382, lon:-121.8863, alt:  25, tz:"America/Los_Angeles" },
  { city:"San Francisco, CA",      lat: 37.7749, lon:-122.4194, alt:  16, tz:"America/Los_Angeles" },
  { city:"Sacramento, CA",         lat: 38.5816, lon:-121.4944, alt:   9, tz:"America/Los_Angeles" },
  { city:"Fresno, CA",             lat: 36.7378, lon:-119.7871, alt:  94, tz:"America/Los_Angeles" },
  { city:"Las Vegas, NV",          lat: 36.1699, lon:-115.1398, alt: 610, tz:"America/Los_Angeles" },
  { city:"Phoenix, AZ",            lat: 33.4484, lon:-112.0740, alt: 331, tz:"America/Phoenix" },
  { city:"Tucson, AZ",             lat: 32.2226, lon:-110.9747, alt: 728, tz:"America/Phoenix" },
  { city:"Albuquerque, NM",        lat: 35.0844, lon:-106.6504, alt:1619, tz:"America/Denver" },
  { city:"El Paso, TX",            lat: 31.7619, lon:-106.4850, alt:1140, tz:"America/Denver" },
  { city:"Denver, CO",             lat: 39.7392, lon:-104.9903, alt:1609, tz:"America/Denver" },
  { city:"Colorado Springs, CO",   lat: 38.8339, lon:-104.8214, alt:1839, tz:"America/Denver" },
  { city:"Salt Lake City, UT",     lat: 40.7608, lon:-111.8910, alt:1288, tz:"America/Denver" },
  // Texas
  { city:"Houston, TX",            lat: 29.7604, lon: -95.3698, alt:  13, tz:"America/Chicago" },
  { city:"Dallas, TX",             lat: 32.7767, lon: -96.7970, alt: 131, tz:"America/Chicago" },
  { city:"Austin, TX",             lat: 30.2672, lon: -97.7431, alt: 149, tz:"America/Chicago" },
  { city:"San Antonio, TX",        lat: 29.4241, lon: -98.4936, alt: 198, tz:"America/Chicago" },
  { city:"Fort Worth, TX",         lat: 32.7555, lon: -97.3308, alt: 199, tz:"America/Chicago" },
  // Northwest & Pacific
  { city:"Seattle, WA",            lat: 47.6062, lon:-122.3321, alt:  53, tz:"America/Los_Angeles" },
  { city:"Portland, OR",           lat: 45.5051, lon:-122.6750, alt:  15, tz:"America/Los_Angeles" },
  { city:"Spokane, WA",            lat: 47.6588, lon:-117.4260, alt: 570, tz:"America/Los_Angeles" },
  { city:"Boise, ID",              lat: 43.6150, lon:-116.2023, alt: 824, tz:"America/Boise" },
  { city:"Anchorage, AK",          lat: 61.2181, lon:-149.9003, alt:  31, tz:"America/Anchorage" },
  { city:"Honolulu, HI",           lat: 21.3069, lon:-157.8583, alt:   6, tz:"Pacific/Honolulu" },
  // Western Europe
  { city:"London, UK",             lat: 51.5074, lon:  -0.1278, alt:  11, tz:"Europe/London" },
  { city:"Paris, France",          lat: 48.8566, lon:   2.3522, alt:  35, tz:"Europe/Paris" },
  { city:"Berlin, Germany",        lat: 52.5200, lon:  13.4050, alt:  34, tz:"Europe/Berlin" },
  { city:"Amsterdam, Netherlands", lat: 52.3676, lon:   4.9041, alt:   2, tz:"Europe/Amsterdam" },
  { city:"Madrid, Spain",          lat: 40.4168, lon:  -3.7038, alt: 667, tz:"Europe/Madrid" },
  { city:"Barcelona, Spain",       lat: 41.3851, lon:   2.1734, alt:  12, tz:"Europe/Madrid" },
  { city:"Rome, Italy",            lat: 41.9028, lon:  12.4964, alt:  21, tz:"Europe/Rome" },
  { city:"Lisbon, Portugal",       lat: 38.7169, lon:  -9.1395, alt:  10, tz:"Europe/Lisbon" },
  { city:"Vienna, Austria",        lat: 48.2082, lon:  16.3738, alt: 171, tz:"Europe/Vienna" },
  { city:"Zürich, Switzerland",    lat: 47.3769, lon:   8.5417, alt: 408, tz:"Europe/Zurich" },
  { city:"Stockholm, Sweden",      lat: 59.3293, lon:  18.0686, alt:  28, tz:"Europe/Stockholm" },
  { city:"Manchester, UK",         lat: 53.4808, lon:  -2.2426, alt:  38, tz:"Europe/London" },
  // Canada
  { city:"Toronto, ON",            lat: 43.6532, lon: -79.3832, alt:  76, tz:"America/Toronto" },
  { city:"Vancouver, BC",          lat: 49.2827, lon:-123.1207, alt:   2, tz:"America/Vancouver" },
  { city:"Montreal, QC",           lat: 45.5017, lon: -73.5673, alt:  36, tz:"America/Toronto" },
  { city:"Calgary, AB",            lat: 51.0447, lon:-114.0719, alt:1045, tz:"America/Edmonton" },
  // Australia
  { city:"Sydney, NSW",            lat:-33.8688, lon: 151.2093, alt:  19, tz:"Australia/Sydney" },
  { city:"Melbourne, VIC",         lat:-37.8136, lon: 144.9631, alt:  31, tz:"Australia/Melbourne" },
  { city:"Brisbane, QLD",          lat:-27.4698, lon: 153.0251, alt:  27, tz:"Australia/Brisbane" },
  // Asia-Pacific
  { city:"Tokyo, Japan",           lat: 35.6762, lon: 139.6503, alt:  40, tz:"Asia/Tokyo" },
  { city:"Osaka, Japan",           lat: 34.6937, lon: 135.5023, alt:  16, tz:"Asia/Tokyo" },
  { city:"Seoul, South Korea",     lat: 37.5665, lon: 126.9780, alt:  38, tz:"Asia/Seoul" },
  { city:"Singapore",              lat:  1.3521, lon: 103.8198, alt:  15, tz:"Asia/Singapore" },
  // Latin America
  { city:"São Paulo, Brazil",      lat:-23.5505, lon: -46.6333, alt: 760, tz:"America/Sao_Paulo" },
  { city:"Mexico City, Mexico",    lat: 19.4326, lon: -99.1332, alt:2240, tz:"America/Mexico_City" },
  { city:"Buenos Aires, Argentina",lat:-34.6037, lon: -58.3816, alt:  25, tz:"America/Argentina/Buenos_Aires" },
  // Middle East / Other
  { city:"Dubai, UAE",             lat: 25.2048, lon:  55.2708, alt:   5, tz:"Asia/Dubai" },
  { city:"Istanbul, Turkey",       lat: 41.0082, lon:  28.9784, alt:  39, tz:"Europe/Istanbul" },
];

// ── Lens Database ────────────────────────────────────────────────
// Real lens models per manufacturer, with the focal range each covers so the
// chosen lens can actually reach the chosen focal length, and the widest
// aperture it opens to so the chosen f-number is one the lens can produce.

export const DSLR_LENSES = {
  'Canon': [
    { model: 'RF24-70mm F2.8 L IS USM',             range: [24, 70],   wide: 2.8 },
    { model: 'RF50mm F1.8 STM',                     range: [50, 50],   wide: 1.8 },
    { model: 'RF85mm F1.2 L USM',                   range: [85, 85],   wide: 1.2 },
    { model: 'EF70-200mm f/2.8L IS III USM',        range: [70, 200],  wide: 2.8 },
    { model: 'RF24-105mm F4 L IS USM',              range: [24, 105],  wide: 4.0 },
    { model: 'RF35mm F1.8 MACRO IS STM',            range: [35, 35],   wide: 1.8 },
    { model: 'EF135mm f/2L USM',                    range: [135, 135], wide: 2.0 },
    { model: 'RF100-400mm F5.6-8 IS USM',           range: [100, 400], wide: 5.6 },
    { model: 'EF-S18-135mm f/3.5-5.6 IS USM',       range: [18, 135],  wide: 3.5 },
  ],
  'NIKON CORPORATION': [
    { model: 'NIKKOR Z 24-70mm f/2.8 S',            range: [24, 70],   wide: 2.8 },
    { model: 'NIKKOR Z 50mm f/1.8 S',               range: [50, 50],   wide: 1.8 },
    { model: 'NIKKOR Z 85mm f/1.8 S',               range: [85, 85],   wide: 1.8 },
    { model: 'NIKKOR Z 70-200mm f/2.8 VR S',        range: [70, 200],  wide: 2.8 },
    { model: 'NIKKOR Z 24-200mm f/4-6.3 VR',        range: [24, 200],  wide: 4.0 },
    { model: 'AF-S NIKKOR 105mm f/1.4E ED',         range: [105, 105], wide: 1.4 },
    { model: 'NIKKOR Z 35mm f/1.8 S',               range: [35, 35],   wide: 1.8 },
    { model: 'AF-S NIKKOR 200-500mm f/5.6E ED VR',  range: [200, 500], wide: 5.6 },
  ],
  'SONY': [
    { model: 'FE 24-70mm F2.8 GM II',               range: [24, 70],   wide: 2.8 },
    { model: 'FE 50mm F1.8',                        range: [50, 50],   wide: 1.8 },
    { model: 'FE 85mm F1.4 GM',                     range: [85, 85],   wide: 1.4 },
    { model: 'FE 70-200mm F2.8 GM OSS II',          range: [70, 200],  wide: 2.8 },
    { model: 'FE 135mm F1.8 GM',                    range: [135, 135], wide: 1.8 },
    { model: 'FE 35mm F1.4 GM',                     range: [35, 35],   wide: 1.4 },
    { model: 'FE 24-105mm F4 G OSS',                range: [24, 105],  wide: 4.0 },
  ],
  'FUJIFILM': [
    { model: 'XF23mmF2 R WR',                       range: [23, 23],   wide: 2.0 },
    { model: 'XF35mmF1.4 R',                        range: [35, 35],   wide: 1.4 },
    { model: 'XF56mmF1.2 R',                        range: [56, 56],   wide: 1.2 },
    { model: 'XF18-55mmF2.8-4 R LM OIS',            range: [18, 55],   wide: 2.8 },
    { model: 'XF90mmF2 R LM WR',                    range: [90, 90],   wide: 2.0 },
    { model: 'XF55-200mmF3.5-4.8 R LM OIS',         range: [55, 200],  wide: 3.5 },
  ],
};

/**
 * Pick a lens that can actually take the shot.
 *
 * Phones report the phone itself as the lens, in the manufacturer's own
 * wording: Apple names the camera cluster and quotes the physical focal
 * length, never the 35mm equivalent.
 *
 * Bodies pick from the real lens list, filtered to lenses that both cover the
 * focal length and open at least as wide as the chosen aperture — an
 * f/4 zoom cannot report f/1.4.
 */
export function getLensInfo(cam, focalPhys, aperture) {
  if (cam.type === 'phone') {
    const f = Number(aperture.toFixed(2));
    if (cam.make === 'Apple') {
      return { make: 'Apple', model: `${cam.model} back ${cam.lensWord} camera ${focalPhys}mm f/${f}` };
    }
    // Android makers generally write just the module description.
    return { make: cam.make, model: `${cam.model} back camera ${focalPhys}mm f/${f}` };
  }

  const pool = DSLR_LENSES[cam.make] || [];
  const usable = pool.filter(l =>
    focalPhys >= l.range[0] && focalPhys <= l.range[1] && aperture >= l.wide - 0.01);
  if (usable.length) return { make: cam.make, model: pick(usable).model };

  // Nothing covers it: fall back to any lens reaching that focal length.
  const covering = pool.filter(l => focalPhys >= l.range[0] && focalPhys <= l.range[1]);
  if (covering.length) return { make: cam.make, model: pick(covering).model };
  return { make: cam.make, model: pool.length ? pick(pool).model : `${focalPhys}mm` };
}
