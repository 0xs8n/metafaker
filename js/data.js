/**
 * data.js — Static databases for camera profiles, US locations, and lens models.
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
//
// Per-model firmware facts, all of which an editor export preserves:
//
//   exifVersion — the ExifVersion that firmware writes. Samsung and the
//                 Qualcomm-based Android makers still write 0220; Apple has
//                 written 0232 since iOS 13; bodies vary by release year.
//   flash       — whether the body has a built-in flash. Without one the Flash
//                 tag can only ever say "did not fire".
//   raw         — the MIME type Camera Raw names in its xmpMM:History when it
//                 converts this camera's raw file. Phones that cannot shoot
//                 raw natively are exported from a JPEG instead.
//   offsetTime  — whether the firmware writes the OffsetTime* tags. They were
//                 introduced in Exif 2.31, so a 0220 writer (Samsung, OnePlus,
//                 Xiaomi) cannot carry them without failing validation, and
//                 the 5D Mark IV and D850 predate them.
//   lensTags    — overrides the make-level lens-tag set for one model.

// Frame shapes each body can actually produce. A generated photo whose aspect
// ratio matches no mode the camera offers is the loudest tell in the file: no
// Pixel has ever produced a 0.34 aspect frame. Phones offer 4:3, 16:9 and 1:1
// in both orientations; the bodies here are all 3:2.
const ASPECTS_PHONE = [4/3, 3/4, 16/9, 9/16, 1];
const ASPECTS_DSLR  = [3/2, 2/3];

const DNG = 'image/x-adobe-dng';
const JPG = 'image/jpeg';

export const CAMERAS = [
  // ── Apple ──
  { make:"Apple", model:"iPhone 15 Pro", sw:"17.4.1", type:"phone", aspects:ASPECTS_PHONE, lensWord:"triple",
    exifVersion:"0232", flash:true, raw:DNG, offsetTime:true,
    lenses:[{equiv:13,phys:2.22,f:2.2},{equiv:24,phys:6.86,f:1.78},{equiv:48,phys:6.86,f:1.78},{equiv:77,phys:9.0,f:2.8}],
    isos:[25,32,40,50,64,80,100,125,160,200,250,400,640,800,1000,1600,2500,3200],
    shutters:[[1,4000],[1,2000],[1,1000],[1,500],[1,250],[1,125],[1,60],[1,30],[1,15],[1,8],[1,4]] },

  { make:"Apple", model:"iPhone 14 Pro Max", sw:"16.7.8", type:"phone", aspects:ASPECTS_PHONE, lensWord:"triple",
    exifVersion:"0232", flash:true, raw:DNG, offsetTime:true,
    lenses:[{equiv:13,phys:2.22,f:2.2},{equiv:24,phys:6.86,f:1.78},{equiv:48,phys:6.86,f:1.78},{equiv:77,phys:9.0,f:2.8}],
    isos:[25,32,50,64,100,125,200,400,640,1600,2500],
    shutters:[[1,4000],[1,2000],[1,1000],[1,500],[1,250],[1,125],[1,60],[1,30],[1,15],[1,8]] },

  { make:"Apple", model:"iPhone 13 Pro", sw:"15.8.3", type:"phone", aspects:ASPECTS_PHONE, lensWord:"triple",
    exifVersion:"0232", flash:true, raw:DNG, offsetTime:true,
    lenses:[{equiv:13,phys:1.57,f:1.8},{equiv:26,phys:5.7,f:1.5},{equiv:77,phys:9.0,f:2.8}],
    isos:[25,50,100,200,400,800,1600,2000],
    shutters:[[1,4000],[1,2000],[1,1000],[1,500],[1,250],[1,125],[1,60],[1,30],[1,15]] },

  // The non-Pro iPhones have no ProRAW, so their exports start from the JPEG.
  { make:"Apple", model:"iPhone 12", sw:"14.8.1", type:"phone", aspects:ASPECTS_PHONE, lensWord:"dual",
    exifVersion:"0232", flash:true, raw:JPG, offsetTime:true,
    lenses:[{equiv:13,phys:1.55,f:2.4},{equiv:26,phys:4.2,f:1.6}],
    isos:[25,50,100,200,400,800,1600],
    shutters:[[1,4000],[1,2000],[1,1000],[1,500],[1,250],[1,125],[1,60],[1,30],[1,15]] },

  { make:"Apple", model:"iPhone 11", sw:"14.8.1", type:"phone", aspects:ASPECTS_PHONE, lensWord:"dual",
    exifVersion:"0232", flash:true, raw:JPG, offsetTime:true,
    lenses:[{equiv:13,phys:1.54,f:2.4},{equiv:26,phys:4.25,f:1.8}],
    isos:[25,50,100,200,400,800,1600],
    shutters:[[1,4000],[1,2000],[1,1000],[1,500],[1,250],[1,125],[1,60],[1,30],[1,15]] },

  // ── Samsung — Make is lowercase, Software is the firmware build ──
  { make:"samsung", model:"SM-S928B", sw:"S928BXXU1AWIM", type:"phone", aspects:ASPECTS_PHONE,
    exifVersion:"0220", flash:true, raw:DNG, offsetTime:false,
    lenses:[{equiv:13,phys:2.2,f:2.2},{equiv:24,phys:6.3,f:1.7},{equiv:67,phys:7.9,f:2.4},{equiv:111,phys:13.0,f:3.4}],
    isos:[50,100,200,400,800,1600,3200],
    shutters:[[1,4000],[1,2000],[1,1000],[1,500],[1,250],[1,125],[1,60],[1,30],[1,15],[1,8]] },

  { make:"samsung", model:"SM-S916B", sw:"S916BXXU7EXA1", type:"phone", aspects:ASPECTS_PHONE,
    exifVersion:"0220", flash:true, raw:DNG, offsetTime:false,
    lenses:[{equiv:13,phys:2.2,f:2.2},{equiv:24,phys:6.4,f:1.8},{equiv:70,phys:8.2,f:2.4}],
    isos:[50,100,200,400,800,1600,3200],
    shutters:[[1,4000],[1,2000],[1,1000],[1,500],[1,250],[1,125],[1,60],[1,30],[1,15]] },

  { make:"samsung", model:"SM-A546B", sw:"A546BXXS4EXD2", type:"phone", aspects:ASPECTS_PHONE,
    exifVersion:"0220", flash:true, raw:JPG, offsetTime:false,
    lenses:[{equiv:13,phys:1.9,f:2.2},{equiv:26,phys:4.7,f:1.8}],
    isos:[50,100,200,400,800,1600],
    shutters:[[1,2000],[1,1000],[1,500],[1,250],[1,125],[1,60],[1,30],[1,15]] },

  { make:"samsung", model:"SM-G991B", sw:"G991BXXU8FXD1", type:"phone", aspects:ASPECTS_PHONE,
    exifVersion:"0220", flash:true, raw:DNG, offsetTime:false,
    lenses:[{equiv:13,phys:1.8,f:2.2},{equiv:26,phys:5.4,f:1.8},{equiv:70,phys:7.6,f:2.0}],
    isos:[50,100,200,400,800,1600,3200],
    shutters:[[1,4000],[1,2000],[1,1000],[1,500],[1,250],[1,125],[1,60],[1,30],[1,15]] },

  // ── Google — Software is the HDR+ pipeline build, not the Android version ──
  { make:"Google", model:"Pixel 8 Pro", sw:"HDR+ 1.0.540104767zd", type:"phone", aspects:ASPECTS_PHONE, modes:[[4080,3072]],
    exifVersion:"0232", flash:true, raw:DNG, offsetTime:true,
    lenses:[{equiv:13,phys:1.9,f:1.95},{equiv:25,phys:6.9,f:1.68},{equiv:113,phys:12.5,f:2.8}],
    isos:[50,100,200,400,800,1600,3200],
    shutters:[[1,4000],[1,2000],[1,1000],[1,500],[1,250],[1,125],[1,60],[1,30],[1,15]] },

  { make:"Google", model:"Pixel 7a", sw:"HDR+ 1.0.485286103zd", type:"phone", aspects:ASPECTS_PHONE, modes:[[4624,3472]],
    exifVersion:"0232", flash:true, raw:DNG, offsetTime:true,
    lenses:[{equiv:13,phys:1.8,f:2.2},{equiv:25,phys:5.9,f:1.89}],
    isos:[50,100,200,400,800,1600,3200],
    shutters:[[1,4000],[1,2000],[1,1000],[1,500],[1,250],[1,125],[1,60],[1,30]] },

  { make:"Google", model:"Pixel 6a", sw:"HDR+ 1.0.420988201zd", type:"phone", aspects:ASPECTS_PHONE, modes:[[4032,3024]],
    exifVersion:"0232", flash:true, raw:DNG, offsetTime:true,
    lenses:[{equiv:13,phys:1.8,f:2.2},{equiv:24,phys:4.4,f:1.85}],
    isos:[50,100,200,400,800,1600,3200],
    shutters:[[1,4000],[1,2000],[1,1000],[1,500],[1,250],[1,125],[1,60],[1,30]] },

  // ── OnePlus / Xiaomi — Android build fingerprints ──
  { make:"OnePlus", model:"CPH2583", sw:"CPH2583-user 14 UKQ1.230924.001 release-keys", type:"phone", aspects:ASPECTS_PHONE,
    exifVersion:"0220", flash:true, raw:DNG, offsetTime:false,
    lenses:[{equiv:14,phys:2.2,f:2.2},{equiv:23,phys:6.1,f:1.6},{equiv:73,phys:8.6,f:2.6}],
    isos:[64,100,200,400,800,1600,3200,6400],
    shutters:[[1,4000],[1,2000],[1,1000],[1,500],[1,250],[1,125],[1,60],[1,30],[1,15],[1,8]] },

  { make:"Xiaomi", model:"2312GS7BD", sw:"2312GS7BD-user 14 UKQ1.230804.001 release-keys", type:"phone", aspects:ASPECTS_PHONE,
    exifVersion:"0220", flash:true, raw:DNG, offsetTime:false,
    lenses:[{equiv:14,phys:2.2,f:2.2},{equiv:24,phys:8.7,f:1.42},{equiv:75,phys:8.8,f:2.0}],
    isos:[50,100,200,400,800,1600,3200,6400],
    shutters:[[1,4000],[1,2000],[1,1000],[1,500],[1,250],[1,125],[1,60],[1,30],[1,15],[1,8]] },

  // ── Canon — Make "Canon", Software "Firmware Version x.y.z" ──
  { make:"Canon", model:"Canon EOS R5", sw:"Firmware Version 1.8.2", type:"dslr", aspects:ASPECTS_DSLR, crop:1.0, mounts:['RF','EF'],
    exifVersion:"0231", flash:false, raw:'image/x-canon-cr3', offsetTime:true,
    apertures:[1.2,1.4,1.8,2.0,2.8,4.0,5.6,8.0,11,16],
    isos:[100,125,160,200,250,320,400,640,800,1600,3200,6400,12800,25600,51200],
    shutters:[[1,8000],[1,4000],[1,2000],[1,1000],[1,500],[1,250],[1,125],[1,60],[1,30],[1,15],[1,8],[1,4],[1,2],[1,1],[2,1],[4,1]],
    focals:[24,35,50,85,100,135,200] },

  { make:"Canon", model:"Canon EOS 5D Mark IV", sw:"Firmware Version 1.3.3", type:"dslr", aspects:ASPECTS_DSLR, crop:1.0, mounts:['EF'],
    exifVersion:"0230", flash:false, raw:'image/x-canon-cr2', offsetTime:false,
    apertures:[1.4,1.8,2.0,2.8,4.0,5.6,8.0,11,16],
    isos:[100,200,400,800,1600,3200,6400,12800,25600],
    shutters:[[1,8000],[1,4000],[1,2000],[1,1000],[1,500],[1,250],[1,125],[1,60],[1,30],[1,15],[1,8],[1,4]],
    focals:[24,35,50,85,135,200] },

  { make:"Canon", model:"Canon EOS 90D", sw:"Firmware Version 1.1.1", type:"dslr", aspects:ASPECTS_DSLR, crop:1.6, mounts:['EF','EF-S'],
    exifVersion:"0231", flash:true, raw:'image/x-canon-cr3', offsetTime:true,
    apertures:[1.8,2.0,2.8,4.0,5.6,8.0,11],
    isos:[100,200,400,800,1600,3200,6400,12800,25600],
    shutters:[[1,8000],[1,4000],[1,2000],[1,1000],[1,500],[1,250],[1,125],[1,60],[1,30]],
    focals:[18,24,35,50,85,100] },

  // ── Nikon — Make "NIKON CORPORATION", Model has a space, Software "Ver.NN.NN" ──
  { make:"NIKON CORPORATION", model:"NIKON Z 9", sw:"Ver.04.00", type:"dslr", aspects:ASPECTS_DSLR, crop:1.0, mounts:['Z','F'],
    exifVersion:"0232", flash:false, raw:'image/x-nikon-nef', offsetTime:true,
    apertures:[1.4,1.8,2.0,2.8,4.0,5.6,8.0,11],
    isos:[64,100,200,400,800,1600,3200,6400,12800,25600,51200],
    shutters:[[1,32000],[1,8000],[1,4000],[1,2000],[1,1000],[1,500],[1,250],[1,125],[1,60],[1,30],[1,15],[1,8]],
    focals:[24,35,50,85,105,200,400] },

  // F-mount glass reports through the MakerNote only, so the EXIF carries no
  // lens tags; Camera Raw names the lens in XMP in its own "24.0-70.0 mm" form.
  { make:"NIKON CORPORATION", model:"NIKON D850", sw:"Ver.01.10", type:"dslr", aspects:ASPECTS_DSLR, crop:1.0, mounts:['F'],
    exifVersion:"0231", flash:false, raw:'image/x-nikon-nef', offsetTime:false, lensTags:[],
    apertures:[1.8,2.0,2.8,4.0,5.6,8.0,11,16],
    isos:[64,100,200,400,800,1600,3200,6400,12800,25600],
    shutters:[[1,8000],[1,4000],[1,2000],[1,1000],[1,500],[1,250],[1,125],[1,60],[1,30],[1,15]],
    focals:[24,35,50,85,135,200] },

  { make:"NIKON CORPORATION", model:"NIKON Z 6II", sw:"Ver.01.40", type:"dslr", aspects:ASPECTS_DSLR, crop:1.0, mounts:['Z','F'],
    exifVersion:"0231", flash:false, raw:'image/x-nikon-nef', offsetTime:true,
    apertures:[1.4,1.8,2.0,2.8,4.0,5.6,8.0,11],
    isos:[100,200,400,800,1600,3200,6400,12800,25600,51200],
    shutters:[[1,8000],[1,4000],[1,2000],[1,1000],[1,500],[1,250],[1,125],[1,60],[1,30],[1,15]],
    focals:[24,35,50,85,105] },

  // ── Sony — Make "SONY", Software "<model> v<firmware>" ──
  { make:"SONY", model:"ILCE-7M4", sw:"ILCE-7M4 v2.01", type:"dslr", aspects:ASPECTS_DSLR, modes:[[4608,3072]], crop:1.0, mounts:['E'],
    exifVersion:"0231", flash:false, raw:'image/x-sony-arw', offsetTime:true,
    apertures:[1.4,1.8,2.0,2.8,4.0,5.6,8.0,11],
    isos:[50,100,200,400,800,1600,3200,6400,12800,25600,51200],
    shutters:[[1,8000],[1,4000],[1,2000],[1,1000],[1,500],[1,250],[1,125],[1,60],[1,30],[1,15],[1,8]],
    focals:[24,35,50,85,135,200] },

  { make:"SONY", model:"ILCE-7RM5", sw:"ILCE-7RM5 v1.00", type:"dslr", aspects:ASPECTS_DSLR, crop:1.0, mounts:['E'],
    exifVersion:"0231", flash:false, raw:'image/x-sony-arw', offsetTime:true,
    apertures:[1.4,1.8,2.0,2.8,4.0,5.6,8.0,11],
    isos:[100,200,400,800,1600,3200,6400,12800,25600,51200],
    shutters:[[1,8000],[1,4000],[1,2000],[1,1000],[1,500],[1,250],[1,125],[1,60],[1,30]],
    focals:[24,35,50,85,135] },

  // ── Fujifilm — APS-C, Software "Digital Camera <model> Ver<n.nn>" ──
  { make:"FUJIFILM", model:"X-T5", sw:"Digital Camera X-T5 Ver4.10", type:"dslr", aspects:ASPECTS_DSLR, crop:1.5, mounts:['X'],
    exifVersion:"0232", flash:false, raw:'image/x-fuji-raf', offsetTime:true,
    apertures:[1.4,1.8,2.0,2.8,4.0,5.6,8.0,11],
    isos:[125,160,200,400,800,1600,3200,6400,12800,25600,51200],
    shutters:[[1,8000],[1,4000],[1,2000],[1,1000],[1,500],[1,250],[1,125],[1,60],[1,30],[1,15]],
    focals:[18,23,35,56,90] },

  { make:"FUJIFILM", model:"X100VI", sw:"Digital Camera X100VI Ver1.10", type:"dslr", aspects:ASPECTS_DSLR, crop:1.5, mounts:[], fixedLens:true,
    exifVersion:"0232", flash:true, raw:'image/x-fuji-raf', offsetTime:true, lensTags:['make','info'],
    apertures:[2.0,2.8,4.0,5.6,8.0,11],
    isos:[125,200,400,800,1600,3200,6400,12800,25600],
    shutters:[[1,4000],[1,2000],[1,1000],[1,500],[1,250],[1,125],[1,60],[1,30]],
    focals:[23] },
];

// ── Per-make EXIF profiles ───────────────────────────────────────
//
// Which optional tags each make's firmware writes, and how it encodes the
// values it does write. An editor export carries the camera's tags through
// unchanged, so a file claiming a Samsung has to carry Samsung's tag set, not
// a generic one. Writing every tag for every make, or drawing their presence
// at random, was the next-loudest tell after the aspect ratio.
//
//   metering    — MeteringMode values the firmware uses. Samsung and Pixel
//                 write centre-weighted (2); Apple and the bodies write
//                 multi-segment (5), bodies also offer centre and spot.
//   flashOff    — Flash values written when the flash did not fire. Nikon
//                 writes 0 ("No Flash"), most others 16 ("Off, Did not
//                 fire"), Apple either 16 or 24 ("Auto, Did not fire").
//   flashFired  — the value for a fired built-in flash.
//   subsec      — which SubSecTime tags are written and at what width.
//                 Apple: Original and Digitized, three digits. Android: all
//                 three, three digits. Canon and Nikon: all three, two digits.
//                 Sony and Fujifilm: none.
//   bias        — how ExposureCompensation is encoded. Phones write 0/1.
//                 Canon and Fujifilm reduce thirds, Nikon writes sixths
//                 unreduced ("-2/6"), Sony writes tenths.
//   apex        — rational style for ShutterSpeedValue and ApertureValue.
//                 Apple writes arbitrary-denominator rationals produced from
//                 floats; Nikon and Sony write /1000000; Canon snaps to
//                 eighth-stops; the Android makers and Fujifilm write /100.
//   fnumber     — denominator of FNumber. Apple reduces (89/50); the other
//                 phones write /100; bodies write /10.
//   maxAperture — denominator of MaxApertureValue, or null when not written.
//   brightness  — BrightnessValue encoding, or null when not written.
//   lensTags    — which of LensMake, LensModel, LensSpecification are written.
//   gps         — GPSVersionID (the Exif spec requires it, and the validator
//                 checks: 2.2.0.0 on the Android makers; 2.3.0.0 on the bodies
//                 and on Apple, whose GPSHPositioningError is a 2.3 tag), plus
//                 whether the firmware adds GPSMapDatum, GPSStatus, or Apple's
//                 speed/heading set.
//   tags        — fixed-presence tags: sensing (SensingMethod 2), sceneType,
//                 fileSource, customRendered (value or null), colorAdj
//                 (Contrast/Saturation/Sharpness = 0), digitalZoom (1/1),
//                 focalEquiv (FocalLengthIn35mmFormat; Canon never writes
//                 it), lightSource (0), gainControl, subjectDistance (0),
//                 cfa (Nikon's CFAPattern), sensitivity (SensitivityType +
//                 RecommendedExposureIndex, CIPA 2.3 bodies).

export const EXIF_PROFILES = {
  'Apple': {
    metering:[5], flashOff:[16,24], flashFired:25, subsec:'od3', bias:'zero',
    apex:'odd', fnumber:'reduced', maxAperture:null, brightness:'odd',
    lensTags:['make','model','info'],
    gps:{ version:[2,3,0,0], mapDatum:false, status:false, apple:true },
    tags:{ sensing:true, sceneType:true, fileSource:false, customRendered:null, colorAdj:false,
           digitalZoom:false, focalEquiv:true, lightSource:false, gainControl:false,
           subjectDistance:false, cfa:false, sensitivity:null },
  },
  'samsung': {
    metering:[2], flashOff:[0], flashFired:1, subsec:'all3', bias:'zero',
    apex:'centi', fnumber:100, maxAperture:100, brightness:'centi',
    lensTags:[],
    gps:{ version:[2,2,0,0], mapDatum:false, status:false, apple:false },
    tags:{ sensing:false, sceneType:true, fileSource:false, customRendered:null, colorAdj:true,
           digitalZoom:false, focalEquiv:true, lightSource:false, gainControl:false,
           subjectDistance:false, cfa:false, sensitivity:null },
  },
  'Google': {
    metering:[2], flashOff:[16], flashFired:1, subsec:'all3', bias:'zero',
    apex:'centi', fnumber:100, maxAperture:100, brightness:'centi',
    lensTags:['make','model'],
    gps:{ version:[2,2,0,0], mapDatum:false, status:false, apple:false },
    tags:{ sensing:true, sceneType:true, fileSource:false, customRendered:1, colorAdj:true,
           digitalZoom:false, focalEquiv:true, lightSource:false, gainControl:false,
           subjectDistance:false, cfa:false, sensitivity:null },
  },
  'OnePlus': {
    metering:[2], flashOff:[16], flashFired:1, subsec:'all3', bias:'zero',
    apex:'centi', fnumber:100, maxAperture:100, brightness:null,
    lensTags:[],
    gps:{ version:[2,2,0,0], mapDatum:false, status:false, apple:false },
    tags:{ sensing:true, sceneType:false, fileSource:false, customRendered:null, colorAdj:false,
           digitalZoom:false, focalEquiv:true, lightSource:false, gainControl:false,
           subjectDistance:false, cfa:false, sensitivity:null },
  },
  'Xiaomi': {
    metering:[2], flashOff:[16], flashFired:1, subsec:'all3', bias:'zero',
    apex:'centi', fnumber:100, maxAperture:100, brightness:null,
    lensTags:[],
    gps:{ version:[2,2,0,0], mapDatum:false, status:false, apple:false },
    tags:{ sensing:true, sceneType:false, fileSource:false, customRendered:null, colorAdj:false,
           digitalZoom:false, focalEquiv:true, lightSource:false, gainControl:false,
           subjectDistance:false, cfa:false, sensitivity:null },
  },
  'Canon': {
    metering:[5,5,5,2,3], flashOff:[16], flashFired:25, subsec:'all2', bias:'thirds',
    apex:'eighths', fnumber:10, maxAperture:null, brightness:null,
    lensTags:['model','info'],
    gps:{ version:[2,3,0,0], mapDatum:true, status:true, apple:false },
    tags:{ sensing:false, sceneType:false, fileSource:false, customRendered:0, colorAdj:false,
           digitalZoom:false, focalEquiv:false, lightSource:false, gainControl:false,
           subjectDistance:false, cfa:false, sensitivity:2 },
  },
  'NIKON CORPORATION': {
    metering:[5,5,5,2,3], flashOff:[0], flashFired:9, subsec:'all2', bias:'sixths',
    apex:'micro', fnumber:10, maxAperture:10, brightness:null,
    lensTags:['model'],
    gps:{ version:[2,3,0,0], mapDatum:true, status:false, apple:false },
    tags:{ sensing:true, sceneType:true, fileSource:true, customRendered:0, colorAdj:true,
           digitalZoom:true, focalEquiv:true, lightSource:true, gainControl:true,
           subjectDistance:true, cfa:true, sensitivity:2 },
  },
  'SONY': {
    metering:[5,5,5,2,3], flashOff:[16], flashFired:9, subsec:null, bias:'tenths',
    apex:'micro', fnumber:10, maxAperture:100, brightness:'centi',
    lensTags:['model','info'],
    gps:{ version:[2,3,0,0], mapDatum:false, status:false, apple:false },
    tags:{ sensing:true, sceneType:true, fileSource:true, customRendered:0, colorAdj:true,
           digitalZoom:true, focalEquiv:true, lightSource:true, gainControl:false,
           subjectDistance:false, cfa:false, sensitivity:2 },
  },
  'FUJIFILM': {
    metering:[5,5,5,2,3], flashOff:[16], flashFired:9, subsec:null, bias:'hundredths',
    apex:'centi', fnumber:10, maxAperture:100, brightness:'centi',
    lensTags:['make','model','info'],
    gps:{ version:[2,3,0,0], mapDatum:false, status:false, apple:false },
    tags:{ sensing:true, sceneType:true, fileSource:true, customRendered:0, colorAdj:true,
           digitalZoom:false, focalEquiv:true, lightSource:false, gainControl:false,
           subjectDistance:true, cfa:false, sensitivity:1 },
  },
};

// ── Location Database ────────────────────────────────────────────
//
// United States only, by design: every generated photo must geolocate inside
// the US. International cities were removed rather than filtered at pick time,
// so there is no code path that can select one. They are in git history if
// they are ever wanted back.
//
// lon is always negative here (western hemisphere).
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
];

// ── Lens Database ────────────────────────────────────────────────
// Real lens models per manufacturer, with the focal range each covers so the
// chosen lens can actually reach the chosen focal length, and the widest
// aperture it opens to so the chosen f-number is one the lens can produce.
// `tele` is the maximum aperture at the long end of a variable zoom, for
// LensSpecification; it equals `wide` on primes and constant-aperture zooms.

// `mount` matters: an RF lens does not fit an EF body and a Z lens does not fit
// an F body, so pairing a 5D Mark IV with an RF zoom, or a D850 with a NIKKOR Z,
// describes a camera that cannot be assembled. Bodies list the mounts they
// accept — R5 and the Z bodies include the older mount because the first-party
// adapters are near-universal, and EF-S is APS-C only.
export const DSLR_LENSES = {
  'Canon': [
    { model: 'RF24-70mm F2.8 L IS USM',             range: [24, 70],   wide: 2.8, tele: 2.8, mount: 'RF' },
    { model: 'RF50mm F1.8 STM',                     range: [50, 50],   wide: 1.8, tele: 1.8, mount: 'RF' },
    { model: 'RF85mm F1.2 L USM',                   range: [85, 85],   wide: 1.2, tele: 1.2, mount: 'RF' },
    { model: 'RF24-105mm F4 L IS USM',              range: [24, 105],  wide: 4.0, tele: 4.0, mount: 'RF' },
    { model: 'RF35mm F1.8 MACRO IS STM',            range: [35, 35],   wide: 1.8, tele: 1.8, mount: 'RF' },
    { model: 'RF100-400mm F5.6-8 IS USM',           range: [100, 400], wide: 5.6, tele: 8.0, mount: 'RF' },
    { model: 'EF24-70mm f/2.8L II USM',             range: [24, 70],   wide: 2.8, tele: 2.8, mount: 'EF' },
    { model: 'EF50mm f/1.8 STM',                    range: [50, 50],   wide: 1.8, tele: 1.8, mount: 'EF' },
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
    { model: 'NIKKOR Z 50mm f/1.8 S',               range: [50, 50],   wide: 1.8, tele: 1.8, mount: 'Z' },
    { model: 'NIKKOR Z 85mm f/1.8 S',               range: [85, 85],   wide: 1.8, tele: 1.8, mount: 'Z' },
    { model: 'NIKKOR Z 70-200mm f/2.8 VR S',        range: [70, 200],  wide: 2.8, tele: 2.8, mount: 'Z' },
    { model: 'NIKKOR Z 24-200mm f/4-6.3 VR',        range: [24, 200],  wide: 4.0, tele: 6.3, mount: 'Z' },
    { model: 'NIKKOR Z 35mm f/1.8 S',               range: [35, 35],   wide: 1.8, tele: 1.8, mount: 'Z' },
    { model: 'NIKKOR Z 100-400mm f/4.5-5.6 VR S',   range: [100, 400], wide: 4.5, tele: 5.6, mount: 'Z' },
    { model: 'AF-S NIKKOR 24-70mm f/2.8E ED VR',    range: [24, 70],   wide: 2.8, tele: 2.8, mount: 'F' },
    { model: 'AF-S NIKKOR 50mm f/1.8G',             range: [50, 50],   wide: 1.8, tele: 1.8, mount: 'F' },
    { model: 'AF-S NIKKOR 85mm f/1.8G',             range: [85, 85],   wide: 1.8, tele: 1.8, mount: 'F' },
    { model: 'AF-S NIKKOR 70-200mm f/2.8E FL ED VR',range: [70, 200],  wide: 2.8, tele: 2.8, mount: 'F' },
    { model: 'AF-S NIKKOR 35mm f/1.8G ED',          range: [35, 35],   wide: 1.8, tele: 1.8, mount: 'F' },
    { model: 'AF-S NIKKOR 105mm f/1.4E ED',         range: [105, 105], wide: 1.4, tele: 1.4, mount: 'F' },
    { model: 'AF-S NIKKOR 200-500mm f/5.6E ED VR',  range: [200, 500], wide: 5.6, tele: 5.6, mount: 'F' },
  ],
  'SONY': [
    { model: 'FE 24-70mm F2.8 GM II',               range: [24, 70],   wide: 2.8, tele: 2.8, mount: 'E' },
    { model: 'FE 50mm F1.8',                        range: [50, 50],   wide: 1.8, tele: 1.8, mount: 'E' },
    { model: 'FE 85mm F1.4 GM',                     range: [85, 85],   wide: 1.4, tele: 1.4, mount: 'E' },
    { model: 'FE 70-200mm F2.8 GM OSS II',          range: [70, 200],  wide: 2.8, tele: 2.8, mount: 'E' },
    { model: 'FE 135mm F1.8 GM',                    range: [135, 135], wide: 1.8, tele: 1.8, mount: 'E' },
    { model: 'FE 35mm F1.4 GM',                     range: [35, 35],   wide: 1.4, tele: 1.4, mount: 'E' },
    { model: 'FE 24-105mm F4 G OSS',                range: [24, 105],  wide: 4.0, tele: 4.0, mount: 'E' },
  ],
  'FUJIFILM': [
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
 * Order matters. Picking the aperture first and then hunting for a lens left no
 * good option when nothing matched — the old fallback handed back any lens that
 * reached the focal length, which is how an f/4 zoom ended up reporting f/1.2.
 * Choosing the lens first and then drawing only from the f-numbers it can open
 * to makes that combination unrepresentable.
 *
 * The returned `lens` carries `make`, `model` and `spec` ([minFocal, maxFocal,
 * wideF, teleF], the LensSpecification values) — any of which may be null when
 * that firmware does not report it. The export names the lens in XMP in
 * `auxLens`, which for Nikon F glass is Adobe's own "24.0-70.0 mm f/2.8" form,
 * since the camera's EXIF never carried a name to preserve.
 */
export function pickOptics(cam) {
  if (cam.type === 'phone') {
    const l = pick(cam.lenses);
    return { focalPhys: l.phys, focalEquiv: l.equiv, aperture: l.f,
             lens: phoneLens(cam, l) };
  }

  const focalPhys  = pick(cam.focals);
  const focalEquiv = Math.round(focalPhys * (cam.crop || 1));

  if (cam.fixedLens) {
    const aperture = pick(cam.apertures);
    const wide = Math.min(...cam.apertures);
    return { focalPhys, focalEquiv, aperture,
             lens: { make: cam.make, model: null, spec: [focalPhys, focalPhys, wide, wide],
                     auxLens: `${cam.model} ${focalPhys}mm f/${wide}` } };
  }

  const covering = (DSLR_LENSES[cam.make] || []).filter(l =>
    (cam.mounts || []).includes(l.mount) && focalPhys >= l.range[0] && focalPhys <= l.range[1]);
  const chosen = covering.length ? pick(covering) : null;

  const openable = chosen ? cam.apertures.filter(a => a >= chosen.wide - 0.01) : cam.apertures;
  const aperture = openable.length ? pick(openable) : (chosen ? chosen.wide : pick(cam.apertures));

  if (!chosen) return { focalPhys, focalEquiv, aperture, lens: { make: null, model: null, spec: null, auxLens: null } };

  const spec = [chosen.range[0], chosen.range[1], chosen.wide, chosen.tele];
  const auxLens = chosen.mount === 'F' ? adobeLensName(chosen) : chosen.model;
  return { focalPhys, focalEquiv, aperture,
           lens: { make: cam.make, model: chosen.model, spec, auxLens } };
}

/** Adobe's generic lens description, "24.0-70.0 mm f/2.8" or "50.0 mm f/1.8". */
function adobeLensName(l) {
  const f1 = l.range[0].toFixed(1), f2 = l.range[1].toFixed(1);
  const focal = l.range[0] === l.range[1] ? `${f1} mm` : `${f1}-${f2} mm`;
  const ap = l.wide === l.tele ? `f/${l.wide}` : `f/${l.wide}-${l.tele}`;
  return `${focal} ${ap}`;
}

/**
 * Phones report the phone itself as the lens, in the manufacturer's own
 * wording. Apple names the camera cluster and quotes the physical focal
 * length; its LensSpecification spans every lens on the back. Google names
 * the module. Samsung, OnePlus and Xiaomi write no lens tags at all.
 */
function phoneLens(cam, l) {
  const f = Number(l.f.toFixed(2));
  if (cam.make === 'Apple') {
    const phys = cam.lenses.map(x => x.phys), fs = cam.lenses.map(x => x.f);
    const model = `${cam.model} back ${cam.lensWord} camera ${l.phys}mm f/${f}`;
    return { make: 'Apple', model, auxLens: model,
             spec: [Math.min(...phys), Math.max(...phys), Math.min(...fs), Math.max(...fs)] };
  }
  if (cam.make === 'Google') {
    const model = `${cam.model} back camera ${l.phys}mm f/${f}`;
    return { make: 'Google', model, auxLens: model, spec: null };
  }
  return { make: null, model: null, auxLens: null, spec: null };
}
