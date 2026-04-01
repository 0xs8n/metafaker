/**
 * data.js — Static databases for camera profiles, US locations, and lens models.
 *
 * Each camera entry includes realistic specs (apertures, ISOs, shutter speeds,
 * focal lengths) so that generated EXIF is internally consistent. Lens data
 * maps focal lengths to real lens model strings per manufacturer.
 */

import { pick } from './helpers.js';

// ── Camera Database ──────────────────────────────────────────────
// Each entry represents a real camera/phone with authentic spec ranges.
// type: "phone" or "dslr" — affects lens naming, DPI, metering defaults.

export const CAMERAS = [
  // Apple iPhones
  { make:"Apple",    model:"iPhone 15 Pro",          sw:"iOS 17.4.1",               type:"phone", apertures:[1.78,2.2],                isos:[25,32,40,50,64,80,100,125,160,200,250,400,640,800,1000,1600,2500,3200], shutters:[[1,4000],[1,2000],[1,1000],[1,500],[1,250],[1,125],[1,60],[1,30],[1,15]], focals:[26,48,120] },
  { make:"Apple",    model:"iPhone 14 Pro Max",       sw:"iOS 16.7.8",               type:"phone", apertures:[1.78,2.2],                isos:[25,32,50,64,100,125,200,400,640,1600,2500],                                 shutters:[[1,4000],[1,2000],[1,1000],[1,500],[1,250],[1,125],[1,60],[1,30]],       focals:[24,77] },
  { make:"Apple",    model:"iPhone 13 Pro",           sw:"iOS 15.8.3",               type:"phone", apertures:[1.5,1.8,2.8],            isos:[25,50,100,200,400,800,1600,2000],                                           shutters:[[1,4000],[1,2000],[1,1000],[1,500],[1,250],[1,125],[1,60]],             focals:[26,77] },
  { make:"Apple",    model:"iPhone 12",               sw:"iOS 14.8.1",               type:"phone", apertures:[1.6,2.4],                isos:[25,50,100,200,400,800,1600],                                                shutters:[[1,4000],[1,2000],[1,1000],[1,500],[1,250],[1,125],[1,60]],             focals:[26,52] },
  // Samsung Galaxy
  { make:"Samsung",  model:"SM-S928B",                sw:"S928BXXU1AWIM",            type:"phone", apertures:[1.7,2.2,3.4],            isos:[50,100,200,400,800,1600,3200],                                              shutters:[[1,4000],[1,2000],[1,1000],[1,500],[1,250],[1,125],[1,60],[1,30]],       focals:[13,23,69,230] },
  { make:"Samsung",  model:"SM-S916B",                sw:"S916BXXU7EXA1",            type:"phone", apertures:[1.8,2.4],                isos:[50,100,200,400,800,1600,3200],                                              shutters:[[1,4000],[1,2000],[1,1000],[1,500],[1,250],[1,125],[1,60]],             focals:[13,23,69] },
  { make:"Samsung",  model:"SM-A546B",                sw:"A546BXXS4EXD2",            type:"phone", apertures:[1.8,2.4],                isos:[50,100,200,400,800,1600],                                                   shutters:[[1,2000],[1,1000],[1,500],[1,250],[1,125],[1,60],[1,30]],               focals:[25,63] },
  // Google Pixel
  { make:"Google",   model:"Pixel 8 Pro",             sw:"android.14",               type:"phone", apertures:[1.68,2.2,2.8],           isos:[50,100,200,400,800,1600,3200],                                              shutters:[[1,4000],[1,2000],[1,1000],[1,500],[1,250],[1,125],[1,60]],             focals:[10,25,113] },
  { make:"Google",   model:"Pixel 7a",                sw:"android.13",               type:"phone", apertures:[1.89,2.2],               isos:[50,100,200,400,800,1600,3200],                                              shutters:[[1,4000],[1,2000],[1,1000],[1,500],[1,250],[1,125],[1,60]],             focals:[25,116] },
  // Canon
  { make:"Canon",    model:"Canon EOS R5",            sw:"Firmware Version 1.8.2",   type:"dslr",  apertures:[1.2,1.4,1.8,2.0,2.8,4.0,5.6,8.0,11,16],    isos:[100,125,160,200,250,320,400,640,800,1600,3200,6400,12800,25600,51200],      shutters:[[1,8000],[1,4000],[1,2000],[1,1000],[1,500],[1,250],[1,125],[1,60],[1,30],[1,15],[1,8],[1,4],[1,2],[1,1],[2,1],[4,1]], focals:[24,35,50,85,100,135,200] },
  { make:"Canon",    model:"Canon EOS 5D Mark IV",    sw:"Firmware Version 1.3.3",   type:"dslr",  apertures:[1.4,1.8,2.0,2.8,4.0,5.6,8.0,11,16],         isos:[100,200,400,800,1600,3200,6400,12800,25600],                                shutters:[[1,8000],[1,4000],[1,2000],[1,1000],[1,500],[1,250],[1,125],[1,60],[1,30],[1,15],[1,8],[1,4]], focals:[24,35,50,85,135,200] },
  { make:"Canon",    model:"Canon EOS 90D",           sw:"Firmware Version 1.1.1",   type:"dslr",  apertures:[1.8,2.0,2.8,4.0,5.6,8.0,11],                 isos:[100,200,400,800,1600,3200,6400,12800,25600],                                shutters:[[1,8000],[1,4000],[1,2000],[1,1000],[1,500],[1,250],[1,125],[1,60],[1,30]], focals:[18,24,35,50,85,100] },
  // Nikon
  { make:"Nikon",    model:"NIKON Z9",                sw:"Ver.4.00",                 type:"dslr",  apertures:[1.4,1.8,2.0,2.8,4.0,5.6,8.0,11],             isos:[64,100,200,400,800,1600,3200,6400,12800,25600,51200,102400],                shutters:[[1,32000],[1,8000],[1,4000],[1,2000],[1,1000],[1,500],[1,250],[1,125],[1,60],[1,30],[1,15],[1,8]], focals:[24,35,50,85,105,200,400] },
  { make:"Nikon",    model:"NIKON D850",              sw:"Ver.1.10",                 type:"dslr",  apertures:[1.8,2.0,2.8,4.0,5.6,8.0,11,16],              isos:[64,100,200,400,800,1600,3200,6400,12800,25600],                             shutters:[[1,8000],[1,4000],[1,2000],[1,1000],[1,500],[1,250],[1,125],[1,60],[1,30],[1,15]], focals:[24,35,50,85,135,200] },
  { make:"Nikon",    model:"NIKON Z6II",              sw:"Ver.1.40",                 type:"dslr",  apertures:[1.4,1.8,2.0,2.8,4.0,5.6,8.0,11],             isos:[100,200,400,800,1600,3200,6400,12800,25600,51200],                          shutters:[[1,8000],[1,4000],[1,2000],[1,1000],[1,500],[1,250],[1,125],[1,60],[1,30],[1,15]], focals:[24,35,50,85,105] },
  // Sony
  { make:"Sony",     model:"ILCE-7M4",                sw:"Ver.2.01",                 type:"dslr",  apertures:[1.4,1.8,2.0,2.8,4.0,5.6,8.0,11],             isos:[50,100,200,400,800,1600,3200,6400,12800,25600,51200,102400,204800],         shutters:[[1,8000],[1,4000],[1,2000],[1,1000],[1,500],[1,250],[1,125],[1,60],[1,30],[1,15],[1,8]], focals:[24,35,50,85,135,200] },
  { make:"Sony",     model:"ILCE-7RM5",               sw:"Ver.1.00",                 type:"dslr",  apertures:[1.4,1.8,2.0,2.8,4.0,5.6,8.0,11],             isos:[100,200,400,800,1600,3200,6400,12800,25600,51200],                          shutters:[[1,8000],[1,4000],[1,2000],[1,1000],[1,500],[1,250],[1,125],[1,60],[1,30]], focals:[24,35,50,85,135] },
  // Fujifilm
  { make:"FUJIFILM", model:"X-T5",                   sw:"Firmware Ver2.00",         type:"dslr",  apertures:[1.4,1.8,2.0,2.8,4.0,5.6,8.0,11],             isos:[125,160,200,400,800,1600,3200,6400,12800,25600,51200],                      shutters:[[1,8000],[1,4000],[1,2000],[1,1000],[1,500],[1,250],[1,125],[1,60],[1,30],[1,15]], focals:[18,23,35,56,90] },
  { make:"FUJIFILM", model:"X100VI",                 sw:"Firmware Ver2.10",         type:"dslr",  apertures:[2.0,2.8,4.0,5.6,8.0,11],                     isos:[125,200,400,800,1600,3200,6400,12800,25600],                                shutters:[[1,4000],[1,2000],[1,1000],[1,500],[1,250],[1,125],[1,60],[1,30]], focals:[23] },
];

// ── US Location Database ─────────────────────────────────────────
// Cities across all US regions for realistic GPS coordinate generation.

export const LOCATIONS = [
  // Northeast
  { city:"New York, NY",          lat: 40.7128,  lon: -74.0060  },
  { city:"Brooklyn, NY",          lat: 40.6782,  lon: -73.9442  },
  { city:"Boston, MA",            lat: 42.3601,  lon: -71.0589  },
  { city:"Philadelphia, PA",      lat: 39.9526,  lon: -75.1652  },
  { city:"Washington, DC",        lat: 38.9072,  lon: -77.0369  },
  { city:"Baltimore, MD",         lat: 39.2904,  lon: -76.6122  },
  { city:"Pittsburgh, PA",        lat: 40.4406,  lon: -79.9959  },
  { city:"Hartford, CT",          lat: 41.7637,  lon: -72.6851  },
  { city:"Providence, RI",        lat: 41.8240,  lon: -71.4128  },
  { city:"Newark, NJ",            lat: 40.7357,  lon: -74.1724  },
  // Southeast
  { city:"Miami, FL",             lat: 25.7617,  lon: -80.1918  },
  { city:"Orlando, FL",           lat: 28.5383,  lon: -81.3792  },
  { city:"Tampa, FL",             lat: 27.9506,  lon: -82.4572  },
  { city:"Jacksonville, FL",      lat: 30.3322,  lon: -81.6557  },
  { city:"Atlanta, GA",           lat: 33.7490,  lon: -84.3880  },
  { city:"Charlotte, NC",         lat: 35.2271,  lon: -80.8431  },
  { city:"Raleigh, NC",           lat: 35.7796,  lon: -78.6382  },
  { city:"Nashville, TN",         lat: 36.1627,  lon: -86.7816  },
  { city:"Memphis, TN",           lat: 35.1495,  lon: -90.0490  },
  { city:"New Orleans, LA",       lat: 29.9511,  lon: -90.0715  },
  { city:"Birmingham, AL",        lat: 33.5186,  lon: -86.8104  },
  { city:"Richmond, VA",          lat: 37.5407,  lon: -77.4360  },
  // Midwest
  { city:"Chicago, IL",           lat: 41.8781,  lon: -87.6298  },
  { city:"Detroit, MI",           lat: 42.3314,  lon: -83.0458  },
  { city:"Columbus, OH",          lat: 39.9612,  lon: -82.9988  },
  { city:"Cleveland, OH",         lat: 41.4993,  lon: -81.6944  },
  { city:"Indianapolis, IN",      lat: 39.7684,  lon: -86.1581  },
  { city:"Milwaukee, WI",         lat: 43.0389,  lon: -87.9065  },
  { city:"Minneapolis, MN",       lat: 44.9778,  lon: -93.2650  },
  { city:"St. Louis, MO",         lat: 38.6270,  lon: -90.1994  },
  { city:"Kansas City, MO",       lat: 39.0997,  lon: -94.5786  },
  { city:"Omaha, NE",             lat: 41.2565,  lon: -95.9345  },
  { city:"Des Moines, IA",        lat: 41.5868,  lon: -93.6250  },
  // Southwest & West Coast
  { city:"Los Angeles, CA",       lat: 34.0522,  lon:-118.2437  },
  { city:"San Diego, CA",         lat: 32.7157,  lon:-117.1611  },
  { city:"San Jose, CA",          lat: 37.3382,  lon:-121.8863  },
  { city:"San Francisco, CA",     lat: 37.7749,  lon:-122.4194  },
  { city:"Sacramento, CA",        lat: 38.5816,  lon:-121.4944  },
  { city:"Fresno, CA",            lat: 36.7378,  lon:-119.7871  },
  { city:"Las Vegas, NV",         lat: 36.1699,  lon:-115.1398  },
  { city:"Phoenix, AZ",           lat: 33.4484,  lon:-112.0740  },
  { city:"Tucson, AZ",            lat: 32.2226,  lon:-110.9747  },
  { city:"Albuquerque, NM",       lat: 35.0844,  lon:-106.6504  },
  { city:"El Paso, TX",           lat: 31.7619,  lon:-106.4850  },
  { city:"Denver, CO",            lat: 39.7392,  lon:-104.9903  },
  { city:"Colorado Springs, CO",  lat: 38.8339,  lon:-104.8214  },
  { city:"Salt Lake City, UT",    lat: 40.7608,  lon:-111.8910  },
  // Texas
  { city:"Houston, TX",           lat: 29.7604,  lon: -95.3698  },
  { city:"Dallas, TX",            lat: 32.7767,  lon: -96.7970  },
  { city:"Austin, TX",            lat: 30.2672,  lon: -97.7431  },
  { city:"San Antonio, TX",       lat: 29.4241,  lon: -98.4936  },
  { city:"Fort Worth, TX",        lat: 32.7555,  lon: -97.3308  },
  // Northwest & Pacific
  { city:"Seattle, WA",           lat: 47.6062,  lon:-122.3321  },
  { city:"Portland, OR",          lat: 45.5051,  lon:-122.6750  },
  { city:"Spokane, WA",           lat: 47.6588,  lon:-117.4260  },
  { city:"Boise, ID",             lat: 43.6150,  lon:-116.2023  },
  { city:"Anchorage, AK",         lat: 61.2181,  lon:-149.9003  },
  { city:"Honolulu, HI",          lat: 21.3069,  lon:-157.8583  },
];

// ── Lens Database ────────────────────────────────────────────────
// Real lens models per manufacturer. Each entry has a focal range
// so we can pick a lens that covers the randomly chosen focal length.

export const DSLR_LENSES = {
  'Canon': [
    { model: 'Canon RF 24-70mm F2.8 L IS USM',      range: [24, 70] },
    { model: 'Canon RF 50mm F1.8 STM',               range: [50, 50] },
    { model: 'Canon RF 85mm F1.2 L USM',             range: [85, 85] },
    { model: 'Canon EF 70-200mm f/2.8L IS III USM',  range: [70, 200] },
    { model: 'Canon RF 24-105mm F4 L IS USM',        range: [24, 105] },
    { model: 'Canon RF 35mm F1.8 MACRO IS STM',      range: [35, 35] },
    { model: 'Canon EF 135mm f/2L USM',              range: [135, 135] },
    { model: 'Canon RF 100-400mm F5.6-8 IS USM',     range: [100, 400] },
  ],
  'Nikon': [
    { model: 'NIKKOR Z 24-70mm f/2.8 S',             range: [24, 70] },
    { model: 'NIKKOR Z 50mm f/1.8 S',                range: [50, 50] },
    { model: 'NIKKOR Z 85mm f/1.8 S',                range: [85, 85] },
    { model: 'NIKKOR Z 70-200mm f/2.8 VR S',         range: [70, 200] },
    { model: 'NIKKOR Z 24-200mm f/4-6.3 VR',         range: [24, 200] },
    { model: 'AF-S NIKKOR 105mm f/1.4E ED',          range: [105, 105] },
    { model: 'NIKKOR Z 35mm f/1.8 S',                range: [35, 35] },
    { model: 'AF-S NIKKOR 200-500mm f/5.6E ED VR',   range: [200, 500] },
  ],
  'Sony': [
    { model: 'FE 24-70mm F2.8 GM II',                range: [24, 70] },
    { model: 'FE 50mm F1.8',                         range: [50, 50] },
    { model: 'FE 85mm F1.4 GM',                      range: [85, 85] },
    { model: 'FE 70-200mm F2.8 GM OSS II',           range: [70, 200] },
    { model: 'FE 135mm F1.8 GM',                     range: [135, 135] },
    { model: 'FE 35mm F1.4 GM',                      range: [35, 35] },
    { model: 'FE 24-105mm F4 G OSS',                 range: [24, 105] },
  ],
  'FUJIFILM': [
    { model: 'XF23mmF2 R WR',                        range: [23, 23] },
    { model: 'XF35mmF1.4 R',                         range: [35, 35] },
    { model: 'XF56mmF1.2 R',                         range: [56, 56] },
    { model: 'XF18-55mmF2.8-4 R LM OIS',             range: [18, 55] },
    { model: 'XF90mmF2 R LM WR',                     range: [90, 90] },
    { model: 'XF55-200mmF3.5-4.8 R LM OIS',          range: [55, 200] },
  ],
};

/**
 * Get a realistic lens make/model for a given camera and focal length.
 * Phones report the phone model as the lens; DSLRs pick from real lens databases.
 */
export function getLensInfo(cam, focal, aperture) {
  if (cam.type === 'phone') {
    return { make: cam.make, model: `${cam.model} back camera ${focal}mm f/${aperture}` };
  }
  const pool = DSLR_LENSES[cam.make] || [];
  const matching = pool.filter(l => focal >= l.range[0] && focal <= l.range[1]);
  if (matching.length) {
    return { make: cam.make, model: pick(matching).model };
  }
  // Fallback: pick any lens from this manufacturer
  const fallback = pool.length ? pick(pool) : { model: `${focal}mm` };
  return { make: cam.make, model: fallback.model };
}
