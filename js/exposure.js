/**
 * exposure.js — the exposure values as Camera Raw and Lightroom write them.
 *
 * When Camera Raw or Lightroom reads a file's EXIF ExposureTime it calls
 * dng_exif::SetExposureTime(et, snap = true), which snaps the time to a
 * standard speed or rounds it, then encodes it and mirrors it into
 * ShutterSpeedValue. FNumber goes through dng_exif::SetFNumber, which mirrors
 * ApertureValue from the encoded FNumber. These are line-for-line ports of
 * SnapExposureTime, SetExposureTime and SetFNumber in the Adobe DNG SDK 1.4,
 * source/dng_exif.cpp
 * (https://android.googlesource.com/platform/external/dng_sdk/+/refs/heads/main/source/dng_exif.cpp).
 *
 * The SDK 1.7.1 adds a second standard-speed pass after rounding, which turns
 * every rounded 1/1300 into 1/1250. Real exports carry 1/1300 (Lightroom
 * 5.7.1 to Lightroom Classic 10.4), so the one-pass rule is the one ported.
 */

const STANDARD_SPEEDS = [
  30, 25, 20, 15, 13, 10, 8, 6, 5, 4, 3.2, 3, 2.5, 2, 1.6, 1.5, 1.3, 1, 0.8, 0.7, 0.6, 0.5, 0.4, 0.3,
  ...[4, 5, 6, 8, 10, 13, 15, 20, 25, 30, 40, 45, 50, 60, 80, 90, 100, 125, 160, 180, 200, 250, 320,
      350, 400, 500, 640, 750, 800, 1000, 1250, 1500, 1600, 2000, 2500, 3000, 3200, 4000, 5000, 6000,
      6400, 8000, 10000, 12000, 12800, 16000].map(n => 1 / n),
];

/** SnapExposureTime: a time within 2% of a standard speed becomes it; any other is rounded. */
export function snapExposureTime(et) {
  if (et <= 0) return 0;
  for (let fudge = 0; fudge <= 1; fudge++) {
    let test = et;
    if (fudge === 1) {
      // APEX values rounded to a power of two: 1/64 for 1/60, 1/128 for 1/125.
      if (et >= 0.1) break;
      test *= et >= 0.01 ? 16 / 15 : 128 / 125;
    }
    for (const s of STANDARD_SPEEDS) if (test >= s * 0.98 && test <= s * 1.02) return s;
  }
  if (et >= 10)       return Math.floor(et + 0.5);
  if (et >= 0.5)      return Math.floor(et * 10 + 0.5) * 0.1;
  if (et >= 1 / 20)   return 1 / Math.floor(1 / et + 0.5);
  if (et >= 1 / 130)  return 0.2 / Math.floor(0.2 / et + 0.5);
  if (et >= 1 / 750)  return 0.1 / Math.floor(0.1 / et + 0.5);
  if (et >= 1 / 1300) return 0.02 / Math.floor(0.02 / et + 0.5);
  if (et >= 1 / 15000) return 0.01 / Math.floor(0.01 / et + 0.5);
  return 0.001 / Math.floor(0.001 / et + 0.5);
}

const roundU = x => Math.floor(x + 0.5);
const roundS = x => Math.trunc(x > 0 ? x + 0.5 : x - 0.5);
function reduceBy10([n, d]) {
  while (n % 10 === 0 && d % 10 === 0 && d >= 10) { n /= 10; d /= 10; }
  return [n, d];
}
/** An APEX value as dng_urational/dng_srational Set_real64(v, 1000000) then ReduceByFactor(10). */
const apex = v => reduceBy10([roundS(v * 1000000), 1000000]);

/** SetExposureTime's encoding of an already snapped time `s`: ExposureTime and ShutterSpeedValue. */
export function encodeExposureTime(s) {
  let rat;
  if (s >= 100)      rat = [roundU(s), 1];
  else if (s >= 1)   rat = reduceBy10([roundU(s * 10), 10]);
  else if (s <= 0.1) rat = [1, roundU(1 / s)];
  else {
    rat = reduceBy10([roundU(s * 100), 100]);
    for (let f = 2; f <= 9; f++) {
      const z = 1 / f / s;
      if (z >= 0.99 && z <= 1.01) { rat = [1, f]; break; }
    }
  }
  const seconds = rat[0] / rat[1];
  return { exposureTime: rat, seconds, shutterSpeedValue: apex(-Math.log(seconds) / Math.log(2)) };
}

/** The ExposureTime and ShutterSpeedValue an Adobe export writes for a camera's time `et` in seconds. */
export const adobeExposure = et => encodeExposureTime(snapExposureTime(et));

/** FNumber and the ApertureValue mirrored from it, as SetFNumber encodes them. */
export function adobeFNumber(fs) {
  const fNumber = fs > 10 ? [roundU(fs), 1] : fs < 1 ? reduceBy10([roundU(fs * 100), 100]) : reduceBy10([roundU(fs * 10), 10]);
  return { fNumber, apertureValue: apex(2 * Math.log(fNumber[0] / fNumber[1]) / Math.log(2)) };
}
