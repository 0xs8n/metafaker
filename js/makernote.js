/**
 * makernote.js — Synthesised manufacturer MakerNote blocks.
 *
 * Almost every JPEG straight out of a camera carries a MakerNote, and a file
 * with a full Exif IFD, GPS and a thumbnail but no MakerNote at all looks like
 * metadata that was written by a tool rather than a camera.
 *
 * Read the trade-off before extending this. A missing MakerNote is consistent
 * with plenty of innocent handling — social networks, editors and export
 * pipelines strip them constantly. A *synthesised* one is not consistent with
 * anything except synthesis, if someone compares it against a corpus of real
 * files from the same model and finds a tag set no firmware ever wrote. This
 * raises the bar against casual inspection, not against an expert with
 * reference images. Replacing these values with ones extracted from a real
 * photo off the same device is strictly better, and is why the structure is
 * kept separate from the values.
 *
 * Only Apple is implemented. Its block is relocatable: ExifTool resolves the
 * internal offsets against the start of the MakerNote itself
 * (`Base => '$start - 14'` in MakerNotes.pm), so the block survives piexif
 * re-dumping the EXIF at a different position. Canon's offsets are relative to
 * the file's TIFF header instead, so a synthesised Canon block would break the
 * moment it moved, and it is deliberately absent.
 *
 * Tag numbers, types and enumerated values are taken from ExifTool's
 * Image::ExifTool::Apple tag table.
 */

// TIFF field types
const T_ASCII     = 2;
const T_SLONG     = 9;
const T_SRATIONAL = 10;

const u16 = n => String.fromCharCode((n >> 8) & 0xFF, n & 0xFF);
const u32 = n => String.fromCharCode((n >>> 24) & 0xFF, (n >>> 16) & 0xFF, (n >>> 8) & 0xFF, n & 0xFF);
const s32 = n => u32(n < 0 ? n + 0x100000000 : n);

const slong     = v     => ({ type: T_SLONG,     count: 1,           bytes: s32(v) });
const ascii     = s     => ({ type: T_ASCII,     count: s.length + 1, bytes: s + '\0' });
const srational = pairs => ({ type: T_SRATIONAL, count: pairs.length,
                              bytes: pairs.map(([n, d]) => s32(n) + s32(d)).join('') });

/** "Apple iOS\0" + 0x0001 + "MM": 14 bytes, then a big-endian IFD. */
const APPLE_HEADER = 'Apple iOS\0\x00\x01MM';

/**
 * Serialise entries as a big-endian TIFF IFD placed straight after the header.
 * Values longer than four bytes live in a data area after the IFD and are
 * referenced by their offset from byte zero of the MakerNote.
 */
function buildBlock(header, entries) {
  const sorted = [...entries].sort((a, b) => a.tag - b.tag);   // TIFF wants ascending tags
  const ifdSize = 2 + 12 * sorted.length + 4;
  let cursor = header.length + ifdSize;

  let ifd = u16(sorted.length);
  let data = '';

  for (const e of sorted) {
    ifd += u16(e.tag) + u16(e.type) + u32(e.count);
    if (e.bytes.length <= 4) {
      ifd += e.bytes + '\0'.repeat(4 - e.bytes.length);
    } else {
      ifd += u32(cursor);
      data   += e.bytes;
      cursor += e.bytes.length;
      if (e.bytes.length % 2) { data += '\0'; cursor += 1; }   // keep word alignment
    }
  }
  ifd += u32(0);                                                // no next IFD
  return header + ifd + data;
}

const randHex = n => Array.from({ length: n },
  () => '0123456789abcdef'[Math.floor(Math.random() * 16)]).join('');

const uuid = () => `${randHex(8)}-${randHex(4)}-4${randHex(3)}-`
  + `${'89ab'[Math.floor(Math.random() * 4)]}${randHex(3)}-${randHex(12)}`;

/** Round to a rational with a fixed denominator. */
const rat = (v, den = 1000000) => [Math.round(v * den), den];

/**
 * Build an Apple MakerNote consistent with the frame it is attached to.
 *
 * The values track the rest of the EXIF — colour temperature follows the
 * scene, signal-to-noise follows ISO, the camera type follows which lens was
 * used — because a MakerNote that disagrees with the Exif IFD beside it is
 * worse than none at all.
 */
export function buildAppleMakerNote({ iso = 100, focalEquiv = 26, scene = 'daylight', iosMajor = 17 }) {
  // Apple bumps this with the imaging stack, not with iOS itself; these are the
  // values seen alongside the iOS releases in the camera table.
  const version = iosMajor >= 16 ? 14 : 11;

  // A handheld phone sits near 1g on one axis with small readings on the others.
  const gx = (Math.random() - 0.5) * 0.14;
  const gz = (Math.random() - 0.5) * 0.40;
  const gy = -Math.sqrt(Math.max(0.05, 1 - gx * gx - gz * gz));

  const kelvin = { daylight: 5400, overcast: 6200, indoor: 3300, dim: 2900, night: 2700 }[scene] ?? 5200;
  const colorTemperature = kelvin + Math.round((Math.random() - 0.5) * 400);

  // Signal-to-noise falls roughly a few dB per ISO stop above base.
  const snr = Math.max(6, 42 - 4.2 * Math.log2(Math.max(iso, 25) / 25));

  const hdr = scene === 'daylight' || scene === 'overcast';
  const focusNear = 0.3 + Math.random() * 1.2;

  const entries = [
    { tag: 0x0001, ...slong(version) },                        // MakerNoteVersion
    { tag: 0x0004, ...slong(Math.random() < 0.9 ? 1 : 0) },    // AEStable
    { tag: 0x0005, ...slong(180 + Math.floor(Math.random() * 60)) },  // AETarget
    { tag: 0x0006, ...slong(170 + Math.floor(Math.random() * 70)) },  // AEAverage
    { tag: 0x0007, ...slong(Math.random() < 0.92 ? 1 : 0) },   // AFStable
    { tag: 0x0008, ...srational([rat(gx), rat(gy), rat(gz)]) },// AccelerationVector
    { tag: 0x000a, ...slong(hdr ? 3 : 4) },                    // HDRImageType: HDR / Original
    { tag: 0x000c, ...srational([rat(focusNear, 1000), rat(focusNear * (1.3 + Math.random()), 1000)]) },
    { tag: 0x0014, ...slong(10) },                             // ImageCaptureType: Photo
    { tag: 0x0015, ...ascii(randHex(32)) },                    // ImageUniqueID
    { tag: 0x001f, ...slong(0) },                              // PhotosAppFeatureFlags
    { tag: 0x0020, ...ascii(uuid().toUpperCase()) },           // ImageCaptureRequestID
    { tag: 0x0021, ...srational([rat(1 + Math.random() * 1.6, 1000)]) },  // HDRHeadroom
    { tag: 0x0026, ...slong(2) },                              // SignalToNoiseRatioType
    { tag: 0x0027, ...srational([rat(snr, 1000)]) },           // SignalToNoiseRatio
    { tag: 0x002d, ...slong(colorTemperature) },               // ColorTemperature
    { tag: 0x002e, ...slong(focalEquiv <= 16 ? 0 : 1) },       // CameraType: wide / normal
  ];

  return buildBlock(APPLE_HEADER, entries);
}

/** Which makes this module can produce a block for. */
export function hasMakerNote(make) {
  return make === 'Apple';
}

export function buildMakerNote(make, context) {
  return make === 'Apple' ? buildAppleMakerNote(context) : null;
}
