/**
 * classify.js — decide whether an input is a real camera photo or not.
 *
 * The metadata generator invents a camera, lens, exposure and GPS fix. That is
 * right for a photo taken on a phone or a camera, and wrong for anything that
 * never passed through a lens: a screenshot, an exported graphic, a scan, a
 * meme. Stamping "iPhone 15 Pro, f/1.78, GPS in Houston" onto a MacBook
 * screenshot is a louder tell than any metadata the screenshot came with,
 * because a screenshot has no camera to name. For those inputs the honest
 * output is a clean file with no fabricated camera — which is what a real
 * shared screenshot looks like.
 *
 * The test is deliberately high-precision: it only calls something a non-photo
 * when the evidence is strong, so a genuine photo is never mistaken for a
 * screenshot and quietly stripped when the user wanted it faked. The signals:
 *
 *   - It already carries a camera Make or Model. Cameras and phones always
 *     write one; a screenshot never does. Present → it is a photo, full stop.
 *   - It is a PNG. Cameras and phones output JPEG or HEIC; PNG is the format
 *     of screenshots and graphics, not of a camera original.
 *   - Its pixel dimensions are exactly a known screen or device-screen size.
 *     A photo's dimensions are sensor sizes (4032x3024, 8192x5464); a
 *     screenshot's are display sizes (2560x1600, 1170x2532).
 *
 * Content-based detection (flat regions, hard edges, absent sensor noise)
 * would raise recall on JPEG screenshots and downloaded graphics; it is not
 * done here, so a graphic re-saved as a camera-dimensioned JPEG can still slip
 * through as a photo. Dimensions and format catch the common cases.
 */

// Distinctive display and device-screen resolutions, landscape orientation;
// the check also tries the rotated form, so portrait screenshots match too.
//
// The generic 16:9 sizes (1280x720, 1920x1080, 2560x1440, 3840x2160) are left
// out on purpose: people export real photos and video frames to exactly those,
// so they are not a reliable screenshot signal. Kept here are the 16:10 laptop
// sizes, the MacBook notch sizes, and the tall phone/tablet ratios, which a
// camera photo is essentially never exactly sized to.
const SCREEN_SIZES = [
  // laptop / desktop displays, 16:10 and laptop-specific (logical and HiDPI)
  [1280, 800], [1366, 768], [1440, 900], [1536, 960], [1680, 1050],
  [1920, 1200], [2048, 1280], [2240, 1400], [2560, 1600], [2880, 1800],
  [3024, 1964], [3456, 2234], [1512, 982], [1710, 1112], [1470, 956],
  // phone screens (given landscape; rotated check covers the usual portrait)
  [750, 1334], [828, 1792], [1080, 2340], [1080, 2400], [1125, 2436],
  [1170, 2532], [1179, 2556], [1242, 2208], [1242, 2688], [1284, 2778],
  [1290, 2796], [1440, 3120], [1440, 3200], [1344, 2992],
  // tablet screens
  [1536, 2048], [1620, 2160], [1640, 2360], [1668, 2224], [1668, 2388],
  [1488, 2266], [2048, 2732], [2064, 2752],
];
const SCREEN_SET = new Set();
for (const [w, h] of SCREEN_SIZES) { SCREEN_SET.add(`${w}x${h}`); SCREEN_SET.add(`${h}x${w}`); }

/**
 * @param {{type?: string, exif?: object, width?: number, height?: number}} input
 * @returns {{ isPhoto: boolean, kind: 'photo'|'screenshot'|'graphic', reason: string }}
 */
export function classifyInput({ type = '', exif = {}, width = 0, height = 0 } = {}) {
  const make = exif.Make || exif.make || exif.Model || exif.model;
  if (make) return { isPhoto: true, kind: 'photo', reason: `camera metadata present (${make})` };

  if (/png/i.test(type)) {
    return { isPhoto: false, kind: 'screenshot', reason: 'PNG input (cameras write JPEG/HEIC, not PNG)' };
  }
  if (width && height && SCREEN_SET.has(`${width}x${height}`)) {
    return { isPhoto: false, kind: 'screenshot', reason: `dimensions ${width}x${height} match a screen size, with no camera metadata` };
  }
  return { isPhoto: true, kind: 'photo', reason: 'no screenshot signal' };
}
