/**
 * data.js — Camera, location and lens databases.
 *
 * Every value here was read out of real files on Wikimedia Commons on
 * 2026-10-16 (ExifTool 13.59): two originals per phone model, one per camera
 * body, and seven Adobe exports (Camera Raw 16.3/16.4/16.5, Lightroom 7.1.2
 * and 6.5, Lightroom Classic 13.4 and 14.0.1). Where a secondary phone lens
 * was not among the samples its figures are marked `approx`.
 *
 * The models released from mid-2024 on (iPhone 16, 16 Pro, 17 Pro, Pixel 9,
 * 9 Pro, Galaxy S25 Ultra, EOS R5 Mark II, Z6III, X-T50) and the R6 Mark II,
 * Z f and A7C II were added on 2026-10-18 from 43 camera originals, five or
 * more per phone model from at least four uploaders and one or two per body,
 * read byte by byte, plus nine Adobe exports of those bodies and the EXIF of
 * about 100 more exports as Commons reports it. Each new phone was checked
 * against an original of its make's existing model (iPhone 15 Pro, Pixel 8
 * Pro, Galaxy S24 Ultra, Z 6II): same firmware family, same tag set, so they
 * share its writer profile. A body's FocalPlane resolution, ExifVersion and
 * SubSecTime width are the export's, which is not always what the camera
 * writes: Camera Raw writes the Z6III's and Z f's ExifVersion as 0231.
 *
 * The strings are what the device writes, not the marketing name, and the two
 * differ more than you would expect: Samsung's current firmware writes
 * "Galaxy S24 Ultra" as the Model while older firmware writes "SM-G991B";
 * OnePlus writes "OnePlus 12" and no Software at all; Xiaomi writes the
 * device code "23127PN0CG"; Nikon writes "NIKON Z 6_2" for the Z 6II and
 * "NIKON Z6_3" for the Z6III; Canon writes "Canon EOS R5m2" for the R5 Mark II.
 *
 * A lens's `fRat` is the FNumber the phone itself writes. The export does not
 * keep it: every Adobe export rewrites FNumber as a decimal (see exif.js).
 *
 * Per model:
 *   writer      — which firmware family's encodings apply (see exif.js).
 *   exifVersion — as written; Samsung and OnePlus still write 0220, Xiaomi 0230.
 *   offset      — which OffsetTime tags the firmware writes: 'all' (three),
 *                 'two' (OffsetTime + OffsetTimeOriginal), 'orig', or 'none'.
 *   subsec      — SubSecTime digits, or 0 when the firmware writes none.
 *   raw         — for bodies, the raw file the export is converted from.
 *   profileDigest — for bodies, the crs:CameraProfileDigest of the body's
 *                 "Adobe Standard" profile, which is fixed per model: read from
 *                 real raw-source exports of that body (2026-10-18; the same
 *                 value in all 3 A7 IV exports from three editors, 4 X-T5, 2 D850
 *                 from Camera Raw 11.4.1 and 12.4, 2 R5 Mark II, 2 Z 9, one
 *                 each for the rest; the A7R V's from DNGs Lightroom Classic
 *                 made of its ARWs). A body without one is never offered: a
 *                 random digest matches no real profile, and two outputs of one
 *                 body with different digests contradict each other.
 *   rawLensProfile — the body's raw files carry their own lens-correction
 *                 data, which Camera Raw names "Camera Settings" with a record
 *                 of that shot's distortion model (every export with correction
 *                 on: 5 X-T5, 1 X-T50, 2 R5 Mark II). That record cannot be
 *                 generated faithfully, so these export with correction off.
 *   sensor      — native pixel size and sensor size, for FocalPlane*Resolution;
 *                 `perCmRat` is the exact per-cm rational Camera Raw's exports
 *                 of that body carry (64449339/32768 for an A7 IV or A7C II).
 *   released    — when the model went on sale; a capture is never dated before it.
 *                 Where the maker gave only a month, the last day of it.
 *   firmwareDate — when the firmware whose behaviour the entry reproduces was
 *                 out: the version Canon writes into aux:Firmware, or the
 *                 Samsung build that writes the marketing-name Model. A capture
 *                 is never dated before it either. Where no release date for
 *                 the version is known, the earliest capture seen carrying it.
 *   acrMin      — for bodies, the first Camera Raw release that opens the
 *                 body's raw files, from Adobe's "Cameras supported by Camera
 *                 Raw" list (helpx.adobe.com, read 2026-10-18). Only set where
 *                 it is newer than the oldest release in ACR_RELEASES
 *                 (provenance.js); an export is never dated before that
 *                 release nor names an older one, and a body whose release
 *                 has not been seen in a real export yet is never chosen.
 */

import { pick } from './helpers.js';

// Frame shapes each body can actually produce. A generated photo whose aspect
// ratio matches no mode the camera offers is inconsistent with that camera.
const ASPECTS_PHONE = [4/3, 3/4, 16/9, 9/16, 1];
const ASPECTS_DSLR  = [3/2, 2/3];

// A phone's exposure time as a Lightroom export carries it: rounded to values
// like these, all seen in real exports of phone photos (1/4600, 1/730), never
// the firmware's own 1/4673.
const SHUTTERS_PHONE_EXPORT = [[1,12000],[1,7600],[1,6000],[1,4600],[1,4000],[1,2000],[1,1800],[1,1000],[1,750],
  [1,730],[1,700],[1,500],[1,470],[1,250],[1,230],[1,210],[1,125],[1,100],[1,90],[1,60],[1,30],[1,15],[1,8],[1,4]];

// Apple lens specification rationals, exact as the phones write them (the
// float32 values 2.22 and 1.78 come out as 1551800/699009 and 1244236/699009).
const APPLE_LENSINFO_17P = [[1551800, 699009], [1081, 64], [1244236, 699009], [1433, 512]];
const APPLE_LENSINFO_16P = [[1551800, 699009], [2052196, 131047], [1244236, 699009], [14, 5]];
const APPLE_LENSINFO_16 = [[1551800, 699009], [6249513, 1048576], [8, 5], [11, 5]];
const APPLE_LENSINFO_15 = [[1551800, 699009], [9, 1], [1244236, 699009], [14, 5]];
const APPLE_LENSINFO_13 = [[299253, 190607], [9, 1], [3, 2], [14, 5]];
const APPLE_LENSINFO_12 = [[1625285, 1048571], [21, 5], [8, 5], [12, 5]];
const APPLE_LENSINFO_11 = [[807365, 524263], [17, 4], [9, 5], [12, 5]];

export const CAMERAS = [
  // ── Apple: HostComputer, SubjectArea, CompositeImage, continued-fraction rationals ──
  { make:"Apple", model:"iPhone 17 Pro", released:"2025-09-19", type:"phone", writer:"apple", aspects:ASPECTS_PHONE,
    exifVersion:"0232", offset:'all', subsec:3, flash:true, dirRef:'T', hpos:'cf',
    lensInfo:APPLE_LENSINFO_17P,
    lenses:[
      { equiv:14,  phys:2.22,   f:2.2,  fRat:[11, 5],            focalRat:[1551800, 699009], model:"iPhone 17 Pro back triple camera 2.22mm f/2.2", approx:true },
      { equiv:24,  phys:6.765,  f:1.78, fRat:[1244236, 699009], focalRat:[251773, 37217],   model:"iPhone 17 Pro back triple camera 6.765mm f/1.78" },
      { equiv:48,  phys:6.765,  f:1.78, fRat:[1244236, 699009], focalRat:[251773, 37217],   model:"iPhone 17 Pro back triple camera 6.765mm f/1.78" },
      { equiv:100, phys:16.891, f:2.8,  fRat:[1433, 512],        focalRat:[1081, 64],        model:"iPhone 17 Pro back triple camera 16.891mm f/2.8", approx:true },
      { equiv:200, phys:16.891, f:2.8,  fRat:[1433, 512],        focalRat:[1081, 64],        model:"iPhone 17 Pro back triple camera 16.891mm f/2.8" },
    ],
    isos:[40,50,64,80,100,125,160,200,250,320,400,640,800,1000,1600],
    shutters:SHUTTERS_PHONE_EXPORT },

  { make:"Apple", model:"iPhone 16 Pro", released:"2024-09-20", type:"phone", writer:"apple", aspects:ASPECTS_PHONE,
    exifVersion:"0232", offset:'all', subsec:3, flash:true, dirRef:'T', hpos:'cf',
    lensInfo:APPLE_LENSINFO_16P,
    lenses:[
      { equiv:14,  phys:2.22,  f:2.2,  fRat:[11, 5],            focalRat:[1551800, 699009], model:"iPhone 16 Pro back triple camera 2.22mm f/2.2" },
      { equiv:24,  phys:6.765, f:1.78, fRat:[1244236, 699009], focalRat:[251773, 37217],   model:"iPhone 16 Pro back triple camera 6.765mm f/1.78" },
      { equiv:48,  phys:6.765, f:1.78, fRat:[1244236, 699009], focalRat:[251773, 37217],   model:"iPhone 16 Pro back triple camera 6.765mm f/1.78" },
      { equiv:120, phys:15.66, f:2.8,  fRat:[14, 5],            focalRat:[2052196, 131047], model:"iPhone 16 Pro back triple camera 15.66mm f/2.8" },
    ],
    isos:[50,64,80,100,125,160,200,250,320,400,500,640,800,1250,1600],
    shutters:SHUTTERS_PHONE_EXPORT },

  { make:"Apple", model:"iPhone 16", released:"2024-09-20", type:"phone", writer:"apple", aspects:ASPECTS_PHONE,
    exifVersion:"0232", offset:'all', subsec:3, flash:true, dirRef:'T', hpos:'cf',
    lensInfo:APPLE_LENSINFO_16,
    lenses:[
      { equiv:13, phys:2.22, f:2.2, fRat:[11, 5], focalRat:[1551800, 699009],  model:"iPhone 16 back dual wide camera 2.22mm f/2.2", approx:true },
      { equiv:26, phys:5.96, f:1.6, fRat:[8, 5],  focalRat:[6249513, 1048576], model:"iPhone 16 back dual wide camera 5.96mm f/1.6" },
      { equiv:52, phys:5.96, f:1.6, fRat:[8, 5],  focalRat:[6249513, 1048576], model:"iPhone 16 back dual wide camera 5.96mm f/1.6" },
    ],
    isos:[32,40,50,64,80,100,125,160,200,250,400,640,800,1250],
    shutters:SHUTTERS_PHONE_EXPORT },

  { make:"Apple", model:"iPhone 15 Pro", released:"2023-09-22", type:"phone", writer:"apple", aspects:ASPECTS_PHONE,
    exifVersion:"0232", offset:'all', subsec:3, flash:true, dirRef:'T', hpos:'cf',
    lensInfo:APPLE_LENSINFO_15,
    lenses:[
      { equiv:13, phys:2.22,  f:2.2,  fRat:[11, 5],            focalRat:[111, 50],       model:"iPhone 15 Pro back triple camera 2.22mm f/2.2" },
      { equiv:24, phys:6.765, f:1.78, fRat:[1244236, 699009], focalRat:[251773, 37217], model:"iPhone 15 Pro back triple camera 6.765mm f/1.78" },
      { equiv:48, phys:6.765, f:1.78, fRat:[1244236, 699009], focalRat:[251773, 37217], model:"iPhone 15 Pro back triple camera 6.765mm f/1.78" },
      { equiv:77, phys:9,     f:2.8,  fRat:[14, 5],            focalRat:[9, 1],          model:"iPhone 15 Pro back triple camera 9mm f/2.8" },
    ],
    isos:[25,32,40,50,64,80,100,125,160,200,250,400,640,800,1000,1600,2500,3200],
    shutters:[[1,4000],[1,2000],[1,1215],[1,1000],[1,500],[1,364],[1,250],[1,125],[1,100],[1,60],[1,40],[1,30],[1,15],[1,8],[1,4]] },

  { make:"Apple", model:"iPhone 14 Pro Max", released:"2022-09-16", type:"phone", writer:"apple", aspects:ASPECTS_PHONE,
    exifVersion:"0232", offset:'all', subsec:3, flash:true, dirRef:'T', hpos:'cf',
    lensInfo:APPLE_LENSINFO_15,
    lenses:[
      { equiv:13, phys:2.22, f:2.2,  fRat:[11, 5], focalRat:[111, 50], model:"iPhone 14 Pro Max back triple camera 2.22mm f/2.2" },
      { equiv:24, phys:6.86, f:1.78, fRat:[89, 50], focalRat:[343, 50], model:"iPhone 14 Pro Max back triple camera 6.86mm f/1.78" },
      { equiv:48, phys:6.86, f:1.78, fRat:[89, 50], focalRat:[343, 50], model:"iPhone 14 Pro Max back triple camera 6.86mm f/1.78" },
      { equiv:77, phys:9,    f:2.8,  fRat:[14, 5], focalRat:[9, 1],    model:"iPhone 14 Pro Max back triple camera 9mm f/2.8" },
    ],
    isos:[25,32,50,64,80,100,125,200,400,640,1600,2500],
    shutters:[[1,4000],[1,2000],[1,1000],[1,500],[1,364],[1,250],[1,125],[1,100],[1,60],[1,40],[1,30],[1,15],[1,8]] },

  { make:"Apple", model:"iPhone 13 Pro", released:"2021-09-24", type:"phone", writer:"apple", aspects:ASPECTS_PHONE,
    exifVersion:"0232", offset:'all', subsec:3, flash:true, dirRef:'T', hpos:[35, 1],
    lensInfo:APPLE_LENSINFO_13,
    lenses:[
      { equiv:13, phys:1.57, f:1.8, fRat:[9, 5], focalRat:[157, 100], model:"iPhone 13 Pro back triple camera 1.57mm f/1.8" },
      { equiv:26, phys:5.7,  f:1.5, fRat:[3, 2], focalRat:[57, 10],   model:"iPhone 13 Pro back triple camera 5.7mm f/1.5" },
      { equiv:77, phys:9,    f:2.8, fRat:[14, 5], focalRat:[9, 1],     model:"iPhone 13 Pro back triple camera 9mm f/2.8" },
    ],
    isos:[32,40,50,64,80,100,125,200,400,800,1600,2000],
    shutters:[[1,4000],[1,2000],[1,1000],[1,500],[1,250],[1,125],[1,100],[1,60],[1,40],[1,30],[1,15]] },

  { make:"Apple", model:"iPhone 12", released:"2020-10-23", type:"phone", writer:"apple", aspects:ASPECTS_PHONE,
    exifVersion:"0232", offset:'all', subsec:3, flash:true, dirRef:'T', hpos:'cf',
    lensInfo:APPLE_LENSINFO_12,
    lenses:[
      { equiv:13, phys:1.55, f:2.4, fRat:[12, 5], focalRat:[31, 20], model:"iPhone 12 back dual wide camera 1.55mm f/2.4" },
      { equiv:26, phys:4.2,  f:1.6, fRat:[8, 5],  focalRat:[21, 5],  model:"iPhone 12 back dual wide camera 4.2mm f/1.6" },
    ],
    isos:[32,40,50,64,80,100,125,200,400,640,800,1600],
    shutters:[[1,4000],[1,2000],[1,1000],[1,500],[1,250],[1,125],[1,100],[1,60],[1,40],[1,30],[1,15]] },

  { make:"Apple", model:"iPhone 11", released:"2019-09-20", type:"phone", writer:"apple", aspects:ASPECTS_PHONE,
    exifVersion:"0232", offset:'all', subsec:3, flash:true, dirRef:'M', hpos:'cf',
    lensInfo:APPLE_LENSINFO_11,
    lenses:[
      { equiv:13, phys:1.54, f:2.4, fRat:[12, 5], focalRat:[77, 50], model:"iPhone 11 back dual wide camera 1.54mm f/2.4" },
      { equiv:26, phys:4.25, f:1.8, fRat:[9, 5],  focalRat:[17, 4],  model:"iPhone 11 back dual wide camera 4.25mm f/1.8" },
    ],
    isos:[32,40,50,64,80,100,125,200,400,640,800,1600],
    shutters:[[1,4000],[1,2000],[1,1000],[1,500],[1,250],[1,125],[1,100],[1,60],[1,40],[1,30],[1,15]] },

  // ── Samsung Snapdragon S-series: marketing-name Model on current firmware, ImageUniqueID per sensor ──
  // Every S25 Ultra build seen, from the launch firmware on, writes the marketing name.
  { make:"samsung", model:"Galaxy S25 Ultra", released:"2025-02-07", sw:"S938BXXSBCZG3", type:"phone", writer:"samsung", aspects:ASPECTS_PHONE,
    exifVersion:"0220", offset:'two', subsec:3, flash:true, altitude:true,
    lenses:[
      { equiv:13,  phys:2.2,  f:1.9, focalRat:[220, 100],  fRat:[190, 100], apex:[185, 100], id:"J50XLRD00PM" },
      { equiv:23,  phys:6.3,  f:1.7, focalRat:[630, 100],  fRat:[170, 100], apex:[153, 100], id:"JK0XLRD00SM" },
      { equiv:69,  phys:7.9,  f:2.4, focalRat:[790, 100],  fRat:[240, 100], apex:[252, 100], id:"M12XSRD00PM", approx:true },
      { equiv:115, phys:18.6, f:3.4, focalRat:[1860, 100], fRat:[340, 100], apex:[353, 100], id:"J50XSRD00SM" },
    ],
    isos:[20,25,32,40,50,64,80,100,125,160,200,250,320,400,500,640,800,1000,1250,1600,2000,2500,3200],
    shutters:SHUTTERS_PHONE_EXPORT },

  { make:"samsung", model:"Galaxy S24 Ultra", released:"2024-01-31", firmwareDate:"2025-03-01", sw:"S928BXXU4BYCG", type:"phone", writer:"samsung", aspects:ASPECTS_PHONE,
    exifVersion:"0220", offset:'two', subsec:3, flash:true, altitude:false,
    lenses:[
      { equiv:13,  phys:2.2,  f:2.2, focalRat:[220, 100],  fRat:[220, 100], apex:[227, 100], id:"H12XSQE01PM", approx:true },
      { equiv:23,  phys:6.3,  f:1.7, focalRat:[630, 100],  fRat:[170, 100], apex:[153, 100], id:"HK0XLQE00SM" },
      { equiv:67,  phys:7.9,  f:2.4, focalRat:[790, 100],  fRat:[240, 100], apex:[253, 100], id:"H50XSQE00SM", approx:true },
      { equiv:111, phys:13.0, f:3.4, focalRat:[1300, 100], fRat:[340, 100], apex:[353, 100], id:"HK0XLQE00VM", approx:true },
    ],
    isos:[25,32,40,50,64,80,100,125,160,200,250,320,400,500,640,800,1000,1250,1600,2000,2500,3200],
    shutters:[[1,5874],[1,4000],[1,2000],[1,1000],[1,500],[1,250],[1,120],[1,100],[1,60],[1,50],[1,33],[1,30],[1,17],[1,15],[1,10]] },

  { make:"samsung", model:"Galaxy S23+", released:"2023-02-17", firmwareDate:"2024-11-01", sw:"S916BXXS7CXK6", type:"phone", writer:"samsung", aspects:ASPECTS_PHONE,
    exifVersion:"0220", offset:'two', subsec:3, flash:true, altitude:false,
    lenses:[
      { equiv:13, phys:2.2, f:2.2, focalRat:[220, 100], fRat:[220, 100], apex:[227, 100], id:"F12XSQE01PM", approx:true },
      { equiv:23, phys:5.4, f:1.8, focalRat:[540, 100], fRat:[180, 100], apex:[169, 100], id:"F50XLPE00SM" },
      { equiv:70, phys:8.2, f:2.4, focalRat:[820, 100], fRat:[240, 100], apex:[253, 100], id:"F50XSQE00SM", approx:true },
    ],
    isos:[25,32,40,50,64,80,100,125,160,200,250,320,400,500,640,800,1000,1250,1600,2000,2500,3200],
    shutters:[[1,5874],[1,4000],[1,2000],[1,1000],[1,500],[1,250],[1,120],[1,100],[1,60],[1,50],[1,33],[1,30],[1,17],[1,15]] },

  { make:"samsung", model:"SM-G991B", released:"2021-01-29", sw:"G991BXXS9FWL9", type:"phone", writer:"samsung", aspects:ASPECTS_PHONE,
    exifVersion:"0220", offset:'two', subsec:3, flash:true, altitude:true,
    lenses:[
      { equiv:13, phys:1.8, f:2.2, focalRat:[180, 100], fRat:[220, 100], apex:[227, 100], id:"R12LLMF05VM", approx:true },
      { equiv:26, phys:5.4, f:1.8, focalRat:[540, 100], fRat:[180, 100], apex:[169, 100], id:"R12LLMF05VM" },
      { equiv:70, phys:7.6, f:2.0, focalRat:[760, 100], fRat:[200, 100], apex:[200, 100], id:"R50LLMF05VM", approx:true },
    ],
    isos:[25,32,40,50,64,80,100,125,160,200,250,320,400,500,640,800,1000,1250,1600,2000,2500,3200],
    shutters:[[1,6480],[1,4000],[1,2000],[1,1000],[1,500],[1,250],[1,120],[1,100],[1,60],[1,50],[1,33],[1,30],[1,17],[1,15]] },

  // Exynos A54: a different writer (Android ExifInterface): 4-digit SubSecTime, no OffsetTime,
  // no ImageUniqueID, Contrast/Saturation/Sharpness, LightSource, GPSVersionID present.
  { make:"samsung", model:"SM-A546B", released:"2023-03-24", sw:"A546BXXSHEZA3", type:"phone", writer:"samsungA", aspects:ASPECTS_PHONE,
    exifVersion:"0220", offset:'none', subsec:4, flash:true, altitude:true,
    lenses:[
      { equiv:13, phys:1.9,  f:2.2, focalRat:[190, 100], fRat:[220, 100], apex:[220, 100], approx:true },
      { equiv:23, phys:5.54, f:1.8, focalRat:[554, 100], fRat:[180, 100], apex:[170, 100] },
    ],
    isos:[25,32,40,50,64,80,100,125,160,200,250,320,400,500,640,800,1000,1250,1600],
    shutters:[[1,4000],[1,2000],[1,1000],[1,602],[1,500],[1,250],[1,120],[1,100],[1,60],[1,50],[1,33],[1,30],[1,17],[1,15]] },

  // ── Google: fixed-denominator rationals throughout, GPSVersionID first, CustomRendered 1 ──
  { make:"Google", model:"Pixel 9 Pro", released:"2024-09-04", sw:"HDR+ 1.0.702121622nd", type:"phone", writer:"google", aspects:ASPECTS_PHONE, modes:[[4080,3072],[8160,6144]],
    exifVersion:"0232", offset:'all', subsec:3, flash:true,
    lenses:[
      { equiv:12,  phys:2.02,   f:1.7,  focalRat:[2020, 1000],  fRat:[170, 100], apex:[153, 100], model:"Pixel 9 Pro back camera 2.02mm f/1.7" },
      { equiv:24,  phys:6.9,    f:1.68, focalRat:[6900, 1000],  fRat:[168, 100], apex:[150, 100], model:"Pixel 9 Pro back camera 6.9mm f/1.68" },
      { equiv:49,  phys:6.9,    f:1.68, focalRat:[6900, 1000],  fRat:[168, 100], apex:[150, 100], model:"Pixel 9 Pro back camera 6.9mm f/1.68" },
      { equiv:110, phys:17.906, f:2.8,  focalRat:[17906, 1000], fRat:[280, 100], apex:[297, 100], model:"Pixel 9 Pro back camera 17.906mm f/2.8" },
    ],
    isos:[19,21,22,23,24,52,70,121,127,130,210,212,279,380,588,606,715,802,940,1910],
    shutters:SHUTTERS_PHONE_EXPORT },

  { make:"Google", model:"Pixel 9", released:"2024-08-22", sw:"HDR+ 1.0.702121622zd", type:"phone", writer:"google", aspects:ASPECTS_PHONE, modes:[[4080,3072]],
    exifVersion:"0232", offset:'all', subsec:3, flash:true,
    lenses:[
      { equiv:12, phys:2.02, f:1.7,  focalRat:[2020, 1000], fRat:[170, 100], apex:[153, 100], model:"Pixel 9 back camera 2.02mm f/1.7" },
      { equiv:24, phys:6.9,  f:1.68, focalRat:[6900, 1000], fRat:[168, 100], apex:[150, 100], model:"Pixel 9 back camera 6.9mm f/1.68" },
      { equiv:49, phys:6.9,  f:1.68, focalRat:[6900, 1000], fRat:[168, 100], apex:[150, 100], model:"Pixel 9 back camera 6.9mm f/1.68" },
    ],
    isos:[18,19,20,21,22,23,26,37,47,51,55,64,150,158,190,235,350,468,477,651,837],
    shutters:SHUTTERS_PHONE_EXPORT },

  { make:"Google", model:"Pixel 8 Pro", released:"2023-10-12", sw:"HDR+ 1.0.695519190zm", type:"phone", writer:"google", aspects:ASPECTS_PHONE, modes:[[4080,3072]],
    exifVersion:"0232", offset:'all', subsec:3, flash:true,
    lenses:[
      { equiv:13,  phys:1.95, f:1.95, focalRat:[1950, 1000],  fRat:[195, 100], apex:[193, 100], model:"Pixel 8 Pro back camera 1.95mm f/1.95", approx:true },
      { equiv:24,  phys:6.9,  f:1.68, focalRat:[6900, 1000],  fRat:[168, 100], apex:[150, 100], model:"Pixel 8 Pro back camera 6.9mm f/1.68" },
      { equiv:113, phys:12.5, f:2.8,  focalRat:[12500, 1000], fRat:[280, 100], apex:[297, 100], model:"Pixel 8 Pro back camera 12.5mm f/2.8", approx:true },
    ],
    isos:[21,33,42,53,66,84,100,133,168,211,266,336,423,533,672,846,1066,1343,1692,2132,2686,3384],
    shutters:[[1,4000],[1,2000],[1,1300],[1,1000],[1,500],[1,250],[1,120],[1,100],[1,60],[1,50],[1,30],[1,15]] },

  { make:"Google", model:"Pixel 7a", released:"2023-05-11", sw:"HDR+ 1.0.748116481zd", type:"phone", writer:"google", aspects:ASPECTS_PHONE, modes:[[4624,3472]],
    exifVersion:"0232", offset:'all', subsec:3, flash:true,
    lenses:[
      { equiv:14, phys:1.835, f:2.2,  focalRat:[1835, 1000], fRat:[220, 100], apex:[228, 100], model:"Pixel 7a back camera 1.835mm f/2.2" },
      { equiv:25, phys:5.43,  f:1.89, focalRat:[5430, 1000], fRat:[189, 100], apex:[184, 100], model:"Pixel 7a back camera 5.43mm f/1.89" },
    ],
    isos:[21,33,43,53,66,84,100,133,168,211,266,336,423,533,672,846,1066,1343,1692,2132,2686,3384],
    shutters:[[1,4000],[1,2000],[1,1300],[1,1000],[1,500],[1,250],[1,120],[1,100],[1,60],[1,50],[1,30]] },

  { make:"Google", model:"Pixel 6a", released:"2022-07-28", sw:"HDR+ 1.0.641377693zd", type:"phone", writer:"google", aspects:ASPECTS_PHONE, modes:[[4032,3024]],
    exifVersion:"0232", offset:'all', subsec:3, flash:true,
    lenses:[
      { equiv:13, phys:1.8,  f:2.2,  focalRat:[1800, 1000], fRat:[220, 100], apex:[228, 100], model:"Pixel 6a back camera 1.8mm f/2.2", approx:true },
      { equiv:27, phys:4.38, f:1.73, focalRat:[4380, 1000], fRat:[173, 100], apex:[158, 100], model:"Pixel 6a back camera 4.38mm f/1.73" },
    ],
    isos:[21,33,43,53,66,84,100,133,168,211,266,336,423,533,672,846,1066,1343,1692,2132,2686],
    shutters:[[1,4000],[1,2000],[1,1300],[1,1000],[1,500],[1,250],[1,120],[1,100],[1,60],[1,50],[1,30]] },

  // ── OnePlus: Model "OnePlus 12", no Software, OffsetTimeOriginal only, SensingMethod 1, DigitalZoomRatio /10000 ──
  { make:"OnePlus", model:"OnePlus 12", released:"2024-01-23", type:"phone", writer:"oneplus", aspects:ASPECTS_PHONE,
    exifVersion:"0220", offset:'orig', subsec:3, flash:true,
    lenses:[
      { equiv:14, phys:2.2,  f:2.2, focalRat:[2200, 1000], fRat:[22, 10], apex:[227, 100], model:"OnePlus 12 back camera 2.2mm f/2.2", approx:true },
      { equiv:23, phys:6.06, f:1.6, focalRat:[6060, 1000], fRat:[16, 10], apex:[135, 100], model:"OnePlus 12 back camera 6.06mm f/1.6" },
      { equiv:73, phys:8.6,  f:2.6, focalRat:[8600, 1000], fRat:[26, 10], apex:[276, 100], model:"OnePlus 12 back camera 8.6mm f/2.6", approx:true },
    ],
    isos:[50,64,80,100,125,160,200,250,320,400,500,640,800,1000,1250,1600,2000,2500,3200,4000,5000,6400],
    shutters:[[1,4000],[1,2000],[1,1000],[1,795],[1,500],[1,250],[1,120],[1,100],[1,60],[1,50],[1,33],[1,30],[1,17],[1,15],[1,10],[1,8]] },

  // ── Xiaomi: Model is the device code, ExifVersion 0230, ISOSpeed with SensitivityType 3, LightSource 21, no LensModel ──
  { make:"Xiaomi", model:"23127PN0CG", released:"2024-02-25", type:"phone", writer:"xiaomi", aspects:ASPECTS_PHONE,
    exifVersion:"0230", offset:'two', subsec:3, flash:true,
    lenses:[
      { equiv:14, phys:2.2,  f:2.2, focalRat:[2200, 1000], fRat:[220, 100], apex:[227, 100], approx:true },
      { equiv:23, phys:6.55, f:1.6, focalRat:[6550, 1000], fRat:[160, 100], apex:[135, 100] },
      { equiv:75, phys:8.8,  f:2.0, focalRat:[8800, 1000], fRat:[200, 100], apex:[200, 100], approx:true },
    ],
    isos:[50,64,80,100,125,160,200,250,320,400,500,640,800,1000,1250,1600,2000,2500,3200,4000,5000,6400],
    shutters:[[1,4000],[1,2000],[1,1000],[1,500],[1,329],[1,250],[1,120],[1,100],[1,60],[1,50],[1,33],[1,30],[1,17],[1,15],[1,10],[1,8]] },

  // ── Canon: no Software, APEX over 65536, LensInfo with empty apertures, 12-digit serials ──
  // The camera writes "Canon EOS R5m2" and "Canon EOS R6m2" for the Mark II bodies.
  // The R5 Mark II's launch firmware 1.0.0 is in an export of a 2024-08-25 capture.
  { make:"Canon", model:"Canon EOS R5m2", released:"2024-08-20", acrMin:"16.4", type:"dslr", writer:"canon", aspects:ASPECTS_DSLR, crop:1.0, mounts:['RF','EF'], rawLensProfile:true,
    exifVersion:"0231", offset:'all', subsec:2, flash:false, firmware:"1.0.0",
    raw:{ mime:'image/x-canon-cr3', ext:'CR3', prefix:'IMG_' }, profileDigest:'34CFA4AC8E3861352E9AE36290FF5B0C',
    sensor:{ px:[8192, 5464], inch:[1419, 947] },
    apertures:[1.2,1.4,1.8,2.0,2.8,4.0,5.6,8.0,11,16],
    isos:[100,125,160,200,250,320,400,640,800,1600,3200,6400,12800,25600,51200],
    shutters:[[1,8000],[1,4000],[1,2000],[1,1000],[1,800],[1,640],[1,500],[1,250],[1,160],[1,125],[1,100],[1,60],[1,30],[1,15],[1,8],[1,4],[1,2],[1,1]],
    focals:[24,35,50,85,100,135,200] },

  // Camera Raw writes the R6 Mark II's FocalPlane per cm over 32768, not per inch.
  { make:"Canon", model:"Canon EOS R6m2", released:"2022-11-30", firmwareDate:"2023-05-23", type:"dslr", writer:"canon", aspects:ASPECTS_DSLR, crop:1.0, mounts:['RF','EF'],
    exifVersion:"0231", offset:'all', subsec:2, flash:false, firmware:"1.1.1",
    raw:{ mime:'image/x-canon-cr3', ext:'CR3', prefix:'IMG_' }, profileDigest:'A7AC0B2D7EA83BFB7F00D942B278F9EC',
    sensor:{ px:[6000, 4000], perCmRat:[54718516, 32768] },
    apertures:[1.2,1.4,1.8,2.0,2.8,4.0,5.6,8.0,11,16],
    isos:[100,200,400,800,1600,3200,6400,12800,25600,51200,102400],
    shutters:[[1,8000],[1,4000],[1,2000],[1,1000],[1,500],[1,250],[1,160],[1,125],[1,100],[1,60],[1,30],[1,15],[1,8],[1,4]],
    focals:[24,35,50,70,85,100,135,200] },

  { make:"Canon", model:"Canon EOS R5", released:"2020-07-30", firmwareDate:"2023-10-17", type:"dslr", writer:"canon", aspects:ASPECTS_DSLR, crop:1.0, mounts:['RF','EF'],
    exifVersion:"0231", offset:'all', subsec:2, flash:false, firmware:"1.8.2",
    raw:{ mime:'image/x-canon-cr3', ext:'CR3', prefix:'IMG_' }, profileDigest:'23A8FA817AB0E63610A09E90F3703131',
    sensor:{ px:[8192, 5464], inch:[1419, 947] },
    apertures:[1.2,1.4,1.8,2.0,2.8,4.0,5.6,8.0,11,16],
    isos:[100,125,160,200,250,320,400,640,800,1600,3200,6400,12800,25600,51200],
    shutters:[[1,8000],[1,4000],[1,2000],[1,1000],[1,500],[1,250],[1,125],[1,100],[1,60],[1,30],[1,15],[1,8],[1,4],[1,2],[1,1],[2,1],[4,1]],
    focals:[24,35,50,85,100,135,200] },

  { make:"Canon", model:"Canon EOS 5D Mark IV", released:"2016-09-08", firmwareDate:"2021-06-14", type:"dslr", writer:"canon", aspects:ASPECTS_DSLR, crop:1.0, mounts:['EF'],
    exifVersion:"0230", offset:'none', subsec:2, flash:false, firmware:"1.3.3",
    raw:{ mime:'image/x-canon-cr2', ext:'CR2', prefix:'IMG_' },
    sensor:{ px:[6720, 4480], inch:[1419, 947] },
    apertures:[1.4,1.8,2.0,2.8,4.0,5.6,8.0,11,16],
    isos:[100,200,400,800,1600,2500,3200,6400,12800,25600],
    shutters:[[1,8000],[1,4000],[1,2000],[1,1000],[1,500],[1,250],[1,200],[1,125],[1,60],[1,30],[1,15],[1,8],[1,4]],
    focals:[24,35,50,85,135,200] },

  { make:"Canon", model:"Canon EOS 90D", released:"2019-09-26", firmwareDate:"2019-10-25", type:"dslr", writer:"canon", aspects:ASPECTS_DSLR, crop:1.6, mounts:['EF','EF-S'],
    exifVersion:"0231", offset:'all', subsec:2, flash:true, firmware:"1.1.1",
    raw:{ mime:'image/x-canon-cr3', ext:'CR3', prefix:'IMG_' }, profileDigest:'418DA6060FE18E4AB89CD15B15C9353B',
    sensor:{ px:[6960, 4640], inch:[877, 585] },
    apertures:[1.8,2.0,2.8,4.0,5.6,8.0,11],
    isos:[100,200,320,400,800,1600,3200,6400,12800,25600],
    shutters:[[1,8000],[1,4000],[1,2000],[1,1000],[1,500],[1,250],[1,125],[1,60],[1,30]],
    focals:[18,24,35,50,85,100] },

  // ── Nikon: exposure compensation in sixths, FocalPlane over 32768 per cm, CFAPattern, GainControl, 7-digit serials ──
  // The camera writes "NIKON Z6_3", without the space in the Z 6II's name, and
  // ExifVersion 0232; Camera Raw's exports of both new bodies write 0231.
  { make:"NIKON CORPORATION", model:"NIKON Z6_3", released:"2024-06-24", acrMin:"16.3", type:"dslr", writer:"nikon", aspects:ASPECTS_DSLR, crop:1.0, mounts:['Z','F'],
    exifVersion:"0231", offset:'all', subsec:2, flash:false,
    raw:{ mime:'image/x-nikon-nef', ext:'NEF', prefix:'DSC_' }, profileDigest:'C9968249830BD8AF4B057F09F1E3258A',
    sensor:{ px:[6048, 4032], perCmRat:[55369938, 32768] },
    apertures:[1.4,1.8,2.0,2.8,4.0,5.6,8.0,11],
    isos:[100,200,400,800,1000,1600,3200,6400,12800,25600,51200],
    shutters:[[1,8000],[1,4000],[1,2000],[1,1000],[1,800],[1,500],[1,250],[1,125],[1,60],[1,40],[1,30],[1,15]],
    focals:[24,35,50,85,105,200] },

  { make:"NIKON CORPORATION", model:"NIKON Z f", released:"2023-10-27", type:"dslr", writer:"nikon", aspects:ASPECTS_DSLR, crop:1.0, mounts:['Z','F'],
    exifVersion:"0231", offset:'all', subsec:2, flash:false,
    raw:{ mime:'image/x-nikon-nef', ext:'NEF', prefix:'DSC_' },
    sensor:{ px:[6048, 4032], perCmRat:[55369938, 32768] },
    apertures:[1.4,1.8,2.0,2.8,4.0,5.6,8.0,11],
    isos:[100,200,400,800,1600,3200,6400,12800,25600,51200],
    shutters:[[1,8000],[1,4000],[1,2000],[1,1000],[1,500],[1,250],[1,160],[1,100],[1,60],[1,30],[1,15]],
    focals:[24,35,50,85,105,135] },

  { make:"NIKON CORPORATION", model:"NIKON Z 9", released:"2021-12-24", type:"dslr", writer:"nikon", aspects:ASPECTS_DSLR, crop:1.0, mounts:['Z','F'],
    exifVersion:"0232", offset:'all', subsec:2, flash:false,
    raw:{ mime:'image/x-nikon-nef', ext:'NEF', prefix:'DSC_' }, profileDigest:'7742AD8D70EC50CB34CCEA53E99873A8',
    sensor:{ px:[8256, 5504], cm:[3.59, 2.39] },
    apertures:[1.4,1.8,2.0,2.8,4.0,5.6,8.0,11],
    isos:[64,100,200,400,800,1000,1600,3200,6400,12800,25600,51200],
    shutters:[[1,32000],[1,8000],[1,4000],[1,2000],[1,1000],[1,500],[1,250],[1,160],[1,125],[1,60],[1,30],[1,15],[1,8]],
    focals:[24,35,50,85,105,200,400] },

  { make:"NIKON CORPORATION", model:"NIKON D850", released:"2017-09-07", type:"dslr", writer:"nikon", aspects:ASPECTS_DSLR, crop:1.0, mounts:['F'],
    exifVersion:"0231", offset:'none', subsec:2, flash:false,
    raw:{ mime:'image/x-nikon-nef', ext:'NEF', prefix:'DSC_' }, profileDigest:'2DE3C8E3E7A6454D52ADD2F110A1ADA2',
    sensor:{ px:[8256, 5504], cm:[3.59, 2.39] },
    apertures:[1.8,2.0,2.8,4.0,5.6,8.0,11,16],
    isos:[64,100,200,400,800,1600,3200,6400,12800,25600],
    shutters:[[1,8000],[1,4000],[1,2000],[1,1000],[1,500],[1,250],[1,125],[1,60],[1,30],[1,15]],
    focals:[24,35,50,85,135,200] },

  // The camera writes "NIKON Z 6_2"; Commons categorises it as "Z 6 II".
  { make:"NIKON CORPORATION", model:"NIKON Z 6_2", released:"2020-11-05", type:"dslr", writer:"nikon", aspects:ASPECTS_DSLR, crop:1.0, mounts:['Z','F'],
    exifVersion:"0231", offset:'all', subsec:2, flash:false,
    raw:{ mime:'image/x-nikon-nef', ext:'NEF', prefix:'DSC_' },
    sensor:{ px:[6048, 4024], perCmRat:[55150724, 32768] },
    apertures:[1.4,1.8,2.0,2.8,4.0,5.6,8.0,11],
    isos:[100,200,400,800,1600,3200,6400,12800,25600,51200],
    shutters:[[1,8000],[1,4000],[1,2000],[1,1000],[1,500],[1,250],[1,125],[1,60],[1,30],[1,15]],
    focals:[24,35,50,85,105] },

  // ── Sony: BrightnessValue over 2560, MaxApertureValue over 256, compensation in tenths, no serial in EXIF ──
  { make:"SONY", model:"ILCE-7CM2", released:"2023-09-30", type:"dslr", writer:"sony", aspects:ASPECTS_DSLR, crop:1.0, mounts:['E'],
    exifVersion:"0232", offset:'all', subsec:3, flash:false,
    raw:{ mime:'image/x-sony-arw', ext:'ARW', prefix:'DSC0' }, profileDigest:'6DCE037B2B8020C0CCBB224F2DE36670',
    sensor:{ px:[7008, 4672], perCmRat:[64449339, 32768] },
    apertures:[1.4,1.8,2.0,2.8,4.0,5.6,6.3,8.0,11],
    isos:[100,200,320,400,800,1600,3200,6400,12800,25600,51200],
    shutters:[[1,8000],[1,4000],[1,2000],[1,1000],[1,800],[1,500],[1,400],[1,320],[1,250],[1,200],[1,160],[1,125],[1,80],[1,60],[1,30],[1,15]],
    focals:[24,35,50,70,85,135,200] },

  { make:"SONY", model:"ILCE-7M4", released:"2021-12-17", type:"dslr", writer:"sony", aspects:ASPECTS_DSLR, modes:[[4608,3072]], crop:1.0, mounts:['E'],
    exifVersion:"0232", offset:'all', subsec:3, flash:false,
    raw:{ mime:'image/x-sony-arw', ext:'ARW', prefix:'DSC0' }, profileDigest:'A4DC20C59DE4E2DF67946B80BFDA0801',
    sensor:{ px:[7008, 4672], perCmRat:[64449339, 32768] },
    apertures:[1.4,1.8,2.0,2.8,4.0,5.6,6.3,8.0,11],
    isos:[50,100,200,400,800,1000,1250,1600,3200,6400,12800,25600,51200],
    shutters:[[1,8000],[1,4000],[1,2000],[1,1000],[1,500],[1,250],[1,160],[1,125],[1,60],[1,30],[1,15],[1,8]],
    focals:[24,35,50,85,135,200] },

  { make:"SONY", model:"ILCE-7RM5", released:"2022-11-24", type:"dslr", writer:"sony", aspects:ASPECTS_DSLR, crop:1.0, mounts:['E'],
    exifVersion:"0232", offset:'all', subsec:3, flash:false,
    raw:{ mime:'image/x-sony-arw', ext:'ARW', prefix:'DSC0' }, profileDigest:'8BC96EBFC3EA48E8A20B842065C33BC4',
    sensor:{ px:[9504, 6336], cm:[3.57, 2.38] },
    apertures:[1.4,1.8,2.0,2.2,2.8,4.0,5.6,8.0,11],
    isos:[100,200,400,640,800,1600,3200,6400,12800,25600,51200],
    shutters:[[1,8000],[1,5000],[1,4000],[1,2000],[1,1000],[1,500],[1,250],[1,125],[1,60],[1,30]],
    focals:[24,35,50,85,135] },

  // ── Fujifilm: everything over 100, SensitivityType 1 without an index, serials like 3B008051 ──
  { make:"FUJIFILM", model:"X-T50", released:"2024-06-30", acrMin:"16.3", type:"dslr", writer:"fuji", aspects:ASPECTS_DSLR, crop:1.5, mounts:['X'], rawLensProfile:true,
    exifVersion:"0232", offset:'all', subsec:2, flash:false,
    raw:{ mime:'image/x-fuji-raf', ext:'RAF', prefix:'DSCF' }, profileDigest:'6DA0A6EFA8823F485E37B03DDCBA7D3D',
    sensor:{ px:[7728, 5152], perCmRat:[108260745, 32768] },
    apertures:[1.4,2.0,2.8,4.0,5.6,8.0,11],
    isos:[125,160,200,250,400,800,1600,3200,6400,12800],
    shutters:[[1,4000],[1,2000],[1,1000],[1,500],[1,250],[1,170],[1,125],[1,60],[1,30],[1,15]],
    focals:[16,18,23,35,56] },

  { make:"FUJIFILM", model:"X-T5", released:"2022-11-17", type:"dslr", writer:"fuji", aspects:ASPECTS_DSLR, crop:1.5, mounts:['X'], rawLensProfile:true,
    exifVersion:"0232", offset:'all', subsec:0, flash:false,
    raw:{ mime:'image/x-fuji-raf', ext:'RAF', prefix:'DSCF' }, profileDigest:'937A7BEEC058D87FEBE4AE4633E885D6',
    sensor:{ px:[7728, 5152], perCmRat:[108260745, 32768] },
    apertures:[1.4,1.8,2.0,2.8,4.0,5.6,8.0,11],
    isos:[125,160,200,400,800,1000,1600,3200,6400,12800,25600,51200],
    shutters:[[1,8000],[1,4000],[1,2000],[1,1000],[1,500],[1,400],[1,250],[1,125],[1,60],[1,34],[1,30],[1,15]],
    focals:[16,18,23,35,56,90] },

  { make:"FUJIFILM", model:"X100VI", released:"2024-02-28", acrMin:"16.2", type:"dslr", writer:"fuji", aspects:ASPECTS_DSLR, crop:1.5, mounts:[], fixedLens:true,
    exifVersion:"0232", offset:'all', subsec:2, flash:true,
    raw:{ mime:'image/x-fuji-raf', ext:'RAF', prefix:'DSCF' },
    sensor:{ px:[7728, 5152], perCm:3289 },
    apertures:[2.0,2.8,4.0,5.6,8.0,11],
    isos:[125,200,400,800,1000,1600,3200,6400,12800,25600],
    shutters:[[1,4000],[1,2000],[1,1000],[1,500],[1,340],[1,250],[1,125],[1,60],[1,34],[1,30]],
    focals:[23] },
];

// ── Location Database ────────────────────────────────────────────
//
// United States only, by design: every generated photo must geolocate inside
// the US. International cities were removed rather than filtered at pick time,
// so there is no code path that can select one.
//
// lon is always negative here (western hemisphere).
// alt: ground elevation in metres. A GPS altitude unrelated to the terrain at
//      the coordinates is a cheap consistency check to fail.
// tz:  IANA zone. GPSTimeStamp is UTC, so it must be derived from the capture
//      time using the zone of the *photographed city*.

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
];

// ── Lens Database ────────────────────────────────────────────────
// Real lens models per manufacturer, with the focal range each covers so the
// chosen lens can actually reach the chosen focal length, and the widest
// aperture it opens to so the chosen f-number is one the lens can produce.
// `tele` is the maximum aperture at the long end of a variable zoom.
// `adobe` is the name Camera Raw writes for an F-mount Nikon lens, whose
// identity reaches it through the raw file's MakerNote rather than a string.
// `lcp` is the lens-correction profile Camera Raw names when its profile
// correction is on, copied from a real raw export with that lens (Camera Raw
// 16.3 and 16.4, Lightroom Classic 8.4, 9.4 and 14.0.1). A lens without one
// is exported with profile correction off: the profile is lens-specific and
// none is invented. A `rawLensProfile` body never names one (see CAMERAS).

export const DSLR_LENSES = {
  'Canon': [
    { model: 'RF24-70mm F2.8 L IS USM',             range: [24, 70],   wide: 2.8, tele: 2.8, mount: 'RF' },
    { model: 'RF50mm F1.8 STM',                     range: [50, 50],   wide: 1.8, tele: 1.8, mount: 'RF' },
    { model: 'RF85mm F1.2 L USM',                   range: [85, 85],   wide: 1.2, tele: 1.2, mount: 'RF' },
    { model: 'RF24-105mm F4 L IS USM',              range: [24, 105],  wide: 4.0, tele: 4.0, mount: 'RF',
      lcp: { name: 'Adobe (Canon RF 24-105mm F4 L IS USM)', file: 'Canon (Canon RF 24-105mm F4L IS USM) - RAW.lcp', digest: 'ADDA69217AE7A042DAE5913B0FCF6F52' } },
    { model: 'RF35mm F1.8 MACRO IS STM',            range: [35, 35],   wide: 1.8, tele: 1.8, mount: 'RF' },
    { model: 'RF100-400mm F5.6-8 IS USM',           range: [100, 400], wide: 5.6, tele: 8.0, mount: 'RF' },
    { model: 'RF100-500mm F4.5-7.1 L IS USM',       range: [100, 500], wide: 4.5, tele: 7.1, mount: 'RF',
      lcp: { name: 'Adobe (Canon RF 100-500mm F4.5-7.1 L IS USM)', file: 'Canon (Canon RF 100-500mm F4.5-7.1 L IS USM) - RAW.lcp', digest: '60528901A40D44097DC962288DAACACD' } },
    { model: 'EF24-70mm f/2.8L II USM',             range: [24, 70],   wide: 2.8, tele: 2.8, mount: 'EF',
      lcp: { name: 'Adobe (Canon EF 24-70mm f/2.8 L II USM)', file: 'Canon EOS 5D Mark II (Canon EF 24-70mm f2.8 L II USM) - RAW.lcp', digest: 'AFEEACDA8777F259982DCD59A5178FC0' } },
    { model: 'EF50mm f/1.8 STM',                    range: [50, 50],   wide: 1.8, tele: 1.8, mount: 'EF',
      lcp: { name: 'Adobe (Canon EF 50mm f/1.8 STM)', file: 'Canon EOS-1Ds Mark III (Canon EF 50mm f1.8 STM) - RAW.lcp', digest: 'B23331240701D3B28825B46A4802290C' } },
    { model: 'EF85mm f/1.4L IS USM',                range: [85, 85],   wide: 1.4, tele: 1.4, mount: 'EF' },
    { model: 'EF70-200mm f/2.8L IS III USM',        range: [70, 200],  wide: 2.8, tele: 2.8, mount: 'EF' },
    { model: 'EF35mm f/1.4L II USM',                range: [35, 35],   wide: 1.4, tele: 1.4, mount: 'EF' },
    { model: 'EF135mm f/2L USM',                    range: [135, 135], wide: 2.0, tele: 2.0, mount: 'EF' },
    { model: 'EF24-105mm f/4L IS II USM',           range: [24, 105],  wide: 4.0, tele: 4.0, mount: 'EF' },
    { model: 'EF100mm f/2.8L MACRO IS USM',         range: [100, 100], wide: 2.8, tele: 2.8, mount: 'EF' },
    { model: 'EF-S18-135mm f/3.5-5.6 IS USM',       range: [18, 135],  wide: 3.5, tele: 5.6, mount: 'EF-S' },
    { model: 'EF-S24mm f/2.8 STM',                  range: [24, 24],   wide: 2.8, tele: 2.8, mount: 'EF-S' },
  ],
  'NIKON CORPORATION': [
    { model: 'NIKKOR Z 24-70mm f/2.8 S',            range: [24, 70],   wide: 2.8, tele: 2.8, mount: 'Z' },
    { model: 'NIKKOR Z 24-120mm f/4 S',             range: [24, 120],  wide: 4.0, tele: 4.0, mount: 'Z' },
    { model: 'NIKKOR Z 50mm f/1.8 S',               range: [50, 50],   wide: 1.8, tele: 1.8, mount: 'Z' },
    { model: 'NIKKOR Z 85mm f/1.8 S',               range: [85, 85],   wide: 1.8, tele: 1.8, mount: 'Z' },
    { model: 'NIKKOR Z 70-200mm f/2.8 VR S',        range: [70, 200],  wide: 2.8, tele: 2.8, mount: 'Z' },
    { model: 'NIKKOR Z 24-200mm f/4-6.3 VR',        range: [24, 200],  wide: 4.0, tele: 6.3, mount: 'Z' },
    { model: 'NIKKOR Z 35mm f/1.8 S',               range: [35, 35],   wide: 1.8, tele: 1.8, mount: 'Z' },
    { model: 'NIKKOR Z 100-400mm f/4.5-5.6 VR S',   range: [100, 400], wide: 4.5, tele: 5.6, mount: 'Z' },
    { model: 'AF-S NIKKOR 24-70mm f/2.8E ED VR',    range: [24, 70],   wide: 2.8, tele: 2.8, mount: 'F', adobe: 'VR 24-70mm f/2.8E' },
    { model: 'AF-S NIKKOR 50mm f/1.8G',             range: [50, 50],   wide: 1.8, tele: 1.8, mount: 'F', adobe: '50mm f/1.8G' },
    { model: 'AF-S NIKKOR 85mm f/1.8G',             range: [85, 85],   wide: 1.8, tele: 1.8, mount: 'F', adobe: '85mm f/1.8G' },
    { model: 'AF-S NIKKOR 70-200mm f/2.8E FL ED VR',range: [70, 200],  wide: 2.8, tele: 2.8, mount: 'F', adobe: 'VR 70-200mm f/2.8E' },
    { model: 'AF-S NIKKOR 35mm f/1.8G ED',          range: [35, 35],   wide: 1.8, tele: 1.8, mount: 'F', adobe: '35mm f/1.8G' },
    { model: 'AF-S NIKKOR 105mm f/1.4E ED',         range: [105, 105], wide: 1.4, tele: 1.4, mount: 'F', adobe: '105mm f/1.4E' },
    { model: 'AF-S NIKKOR 200-500mm f/5.6E ED VR',  range: [200, 500], wide: 5.6, tele: 5.6, mount: 'F', adobe: 'VR 200-500mm f/5.6E' },
  ],
  'SONY': [
    { model: 'FE 24-70mm F2.8 GM II',               range: [24, 70],   wide: 2.8, tele: 2.8, mount: 'E' },
    { model: 'FE 24-240mm F3.5-6.3 OSS',            range: [24, 240],  wide: 3.5, tele: 6.3, mount: 'E',
      lcp: { name: 'Adobe (Sony FE 24-240mm F3.5-6.3 OSS)', file: 'SONY (Sony FE 24-240mm F3.5-6.3 OSS) - RAW.lcp', digest: '0E0E0483ED048452CE6CC01CB9D7D893' } },
    { model: 'FE 50mm F1.8',                        range: [50, 50],   wide: 1.8, tele: 1.8, mount: 'E' },
    { model: 'FE 85mm F1.4 GM',                     range: [85, 85],   wide: 1.4, tele: 1.4, mount: 'E' },
    { model: 'FE 70-200mm F2.8 GM OSS II',          range: [70, 200],  wide: 2.8, tele: 2.8, mount: 'E' },
    { model: 'FE 70-200mm F2.8 GM OSS',             range: [70, 200],  wide: 2.8, tele: 2.8, mount: 'E' },
    { model: 'FE 135mm F1.8 GM',                    range: [135, 135], wide: 1.8, tele: 1.8, mount: 'E' },
    { model: 'FE 35mm F1.4 GM',                     range: [35, 35],   wide: 1.4, tele: 1.4, mount: 'E' },
    { model: 'FE 24-105mm F4 G OSS',                range: [24, 105],  wide: 4.0, tele: 4.0, mount: 'E' },
  ],
  'FUJIFILM': [
    { model: 'XF16-80mmF4 R OIS WR',                range: [16, 80],   wide: 4.0, tele: 4.0, mount: 'X' },
    { model: 'XF23mmF2 R WR',                       range: [23, 23],   wide: 2.0, tele: 2.0, mount: 'X' },
    { model: 'XF35mmF1.4 R',                        range: [35, 35],   wide: 1.4, tele: 1.4, mount: 'X' },
    { model: 'XF56mmF1.2 R',                        range: [56, 56],   wide: 1.2, tele: 1.2, mount: 'X' },
    { model: 'XF18-55mmF2.8-4 R LM OIS',            range: [18, 55],   wide: 2.8, tele: 4.0, mount: 'X' },
    { model: 'XF90mmF2 R LM WR',                    range: [90, 90],   wide: 2.0, tele: 2.0, mount: 'X' },
    { model: 'XF55-200mmF3.5-4.8 R LM OIS',         range: [55, 200],  wide: 3.5, tele: 4.8, mount: 'X' },
  ],
};

/**
 * Choose focal length, aperture and lens as one consistent set.
 *
 * Phones: one of the phone's fixed lenses, carrying its own measured
 * rationals and model string. Bodies: the focal length is drawn and any
 * mountable lens that covers it is chosen; only f-numbers the lens opens to
 * are offered.
 */
export function pickOptics(cam) {
  if (cam.type === 'phone') {
    const l = pick(cam.lenses);
    return { focalPhys: l.phys, focalEquiv: l.equiv, aperture: l.f, lens: l };
  }

  if (cam.fixedLens) {
    const focalPhys  = pick(cam.focals);
    const focalEquiv = Math.round(focalPhys * (cam.crop || 1));
    const aperture = pick(cam.apertures);
    const wide = Math.min(...cam.apertures);
    return { focalPhys, focalEquiv, aperture,
             lens: { model: null, range: [focalPhys, focalPhys], wide, tele: wide, mount: null } };
  }

  const focalPhys = pick(cam.focals);
  const covering = (DSLR_LENSES[cam.make] || []).filter(l =>
    (cam.mounts || []).includes(l.mount) && focalPhys >= l.range[0] && focalPhys <= l.range[1]);
  const chosen = covering.length ? pick(covering) : null;
  const focalEquiv = Math.round(focalPhys * (cam.crop || 1));
  const openable = chosen ? cam.apertures.filter(a => a >= chosen.wide - 0.01) : cam.apertures;
  const aperture = openable.length ? pick(openable) : (chosen ? chosen.wide : pick(cam.apertures));
  return { focalPhys, focalEquiv, aperture, lens: chosen };
}
