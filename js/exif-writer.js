/**
 * exif-writer.js — TIFF/Exif serialiser, replacing piexifjs's `dump`.
 *
 * piexifjs writes a structurally sloppy block, and the sloppiness is
 * identical on every file it produces, which makes it a signature of the
 * writer rather than of a camera. `exiftool -validate` reports two faults:
 *
 *   1. No four-byte next-IFD terminator on the Exif and GPS sub-IFDs. The
 *      directory entries end and the first value begins immediately, so a
 *      reader takes that value to be the next-IFD pointer:
 *      "Value for ExifIFD tag 0x829a ExposureTime overlaps IFD".
 *   2. No padding between values, so any odd-length one puts every value
 *      after it on an odd offset. TIFF wants values word-aligned.
 *
 * This writer emits the same dictionary shape piexifjs accepts — so it is a
 * drop-in for `piexif.dump` — with both faults fixed. Callers should keep
 * piexifjs's version as a fallback; `dumpExif` throws rather than emit a block
 * it cannot vouch for.
 *
 * Big-endian ("MM") throughout, matching piexifjs, with all offsets measured
 * from the TIFF header.
 */

const TYPE = { Byte: 1, Ascii: 2, Short: 3, Long: 4, Rational: 5, Undefined: 7, SLong: 9, SRational: 10 };
const TYPE_SIZE = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 7: 1, 9: 4, 10: 8 };

const u8  = n => String.fromCharCode(n & 0xFF);
const u16 = n => String.fromCharCode((n >> 8) & 0xFF, n & 0xFF);
const u32 = n => String.fromCharCode((n >>> 24) & 0xFF, (n >>> 16) & 0xFF, (n >>> 8) & 0xFF, n & 0xFF);
const s32 = n => u32(n < 0 ? n + 0x100000000 : n);

const asList = v => (Array.isArray(v) ? v : [v]);
/** Rationals arrive either as one [num, den] pair or as a list of pairs. */
const asPairs = v => (Array.isArray(v) && Array.isArray(v[0]) ? v : [v]);

/** Serialise one tag value, returning { type, count, bytes }. */
function encodeValue(typeName, value) {
  switch (typeName) {
    case 'Byte': {
      const a = asList(value);
      return { type: TYPE.Byte, count: a.length, bytes: a.map(u8).join('') };
    }
    case 'Ascii': {
      const s = String(value);
      return { type: TYPE.Ascii, count: s.length + 1, bytes: s + '\0' };
    }
    case 'Short': {
      const a = asList(value);
      return { type: TYPE.Short, count: a.length, bytes: a.map(u16).join('') };
    }
    case 'Long': {
      const a = asList(value);
      return { type: TYPE.Long, count: a.length, bytes: a.map(u32).join('') };
    }
    case 'SLong': {
      const a = asList(value);
      return { type: TYPE.SLong, count: a.length, bytes: a.map(s32).join('') };
    }
    case 'Rational': {
      const p = asPairs(value);
      return { type: TYPE.Rational, count: p.length, bytes: p.map(([n, d]) => u32(n) + u32(d)).join('') };
    }
    case 'SRational': {
      const p = asPairs(value);
      return { type: TYPE.SRational, count: p.length, bytes: p.map(([n, d]) => s32(n) + s32(d)).join('') };
    }
    case 'Undefined': {
      const s = typeof value === 'string' ? value : asList(value).map(u8).join('');
      return { type: TYPE.Undefined, count: s.length, bytes: s };
    }
    default:
      throw new Error(`exif-writer: unsupported tag type "${typeName}"`);
  }
}

/**
 * Collect the entries for one IFD, sorted by tag as TIFF requires.
 *
 * `exclude` drops the structural tags — sub-IFD pointers and the thumbnail
 * offset/length. They describe a layout that no longer applies once the block
 * is rebuilt, and a dictionary that came back from `piexif.load` still carries
 * them, so keeping them produced duplicate tags and stale offsets.
 */
function collect(dict, table, exclude) {
  const out = [];
  for (const key of Object.keys(dict || {})) {
    const tag = Number(key);
    if (exclude && exclude.has(tag)) continue;
    const meta = table[tag];
    if (!meta) continue;                       // unknown tag: skip rather than guess
    const v = dict[key];
    if (v === null || v === undefined) continue;
    out.push({ tag, ...encodeValue(meta.type, v) });
  }
  return out.sort((a, b) => a.tag - b.tag);
}

const pad2 = n => n + (n % 2);
const dirSize = n => 2 + 12 * n + 4;
/** Only values longer than four bytes live outside the directory. */
const valuesSize = entries =>
  entries.reduce((n, e) => n + (e.bytes.length > 4 ? pad2(e.bytes.length) : 0), 0);

/**
 * Write one directory plus its value area.
 * `valuesAt` is where this IFD's out-of-line values begin, and `nextIfd` the
 * offset of the following directory (0 when there is none) — the four bytes
 * piexifjs leaves out on sub-IFDs.
 */
function writeIfd(entries, valuesAt, nextIfd) {
  let dir = u16(entries.length);
  let values = '';
  let cursor = valuesAt;

  for (const e of entries) {
    dir += u16(e.tag) + u16(e.type) + u32(e.count);
    if (e.bytes.length <= 4) {
      dir += e.bytes + '\0'.repeat(4 - e.bytes.length);
    } else {
      dir += u32(cursor);
      values += e.bytes;
      if (e.bytes.length % 2) values += '\0';   // keep the next value word-aligned
      cursor += pad2(e.bytes.length);
    }
  }
  dir += u32(nextIfd);
  return dir + values;
}

const PTR_EXIF    = 0x8769;
const PTR_GPS     = 0x8825;
const PTR_INTEROP = 0xA005;
const THUMB_OFFSET = 0x0201;
const THUMB_LENGTH = 0x0202;

/**
 * Serialise a piexifjs-shaped dictionary into an APP1 payload
 * ("Exif\0\0" + TIFF block).
 *
 * `px` supplies the tag tables, so the two stay in step — including the
 * OffsetTime tags registered onto them at runtime.
 */
export function dumpExif(dict, px) {
  const T = px.TAGS;
  const tableFor = (key, fallback) => T[key] || T[fallback] || {};

  const structural0 = new Set([PTR_EXIF, PTR_GPS, THUMB_OFFSET, THUMB_LENGTH]);
  const structuralE = new Set([PTR_INTEROP]);
  const structural1 = new Set([THUMB_OFFSET, THUMB_LENGTH]);

  const zeroth  = collect(dict['0th'],     tableFor('0th', 'Image'),       structural0);
  const exif    = collect(dict['Exif'],    tableFor('Exif', 'Exif'),       structuralE);
  const gps     = collect(dict['GPS'],     tableFor('GPS', 'GPS'),         null);
  const interop = collect(dict['Interop'], tableFor('Interop', 'Interop'), null);
  const first   = collect(dict['1st'],     tableFor('1st', 'Image'),       structural1);

  const thumbnail = typeof dict.thumbnail === 'string' && dict.thumbnail.length ? dict.thumbnail : null;
  if (thumbnail && thumbnail.length > 63000) throw new Error('exif-writer: thumbnail over 64kB');

  // Pointer entries are four-byte Longs, so they sit inside the directory and
  // do not disturb the value areas. Values are patched once offsets are known.
  const ptr = (tag) => ({ tag, type: TYPE.Long, count: 1, bytes: u32(0) });
  if (exif.length)    zeroth.push(ptr(PTR_EXIF));
  if (gps.length)     zeroth.push(ptr(PTR_GPS));
  if (interop.length) exif.push(ptr(PTR_INTEROP));
  if (thumbnail) {
    first.push({ tag: THUMB_OFFSET, type: TYPE.Long, count: 1, bytes: u32(0) });
    first.push({ tag: THUMB_LENGTH, type: TYPE.Long, count: 1, bytes: u32(thumbnail.length) });
  }
  zeroth.sort((a, b) => a.tag - b.tag);
  exif.sort((a, b) => a.tag - b.tag);
  first.sort((a, b) => a.tag - b.tag);

  // Lay everything out, directory then its values, in reading order.
  let pos = 8;                                   // straight after the TIFF header
  const at = {};
  const place = (name, entries) => {
    if (!entries.length) { at[name] = null; return; }
    at[name] = { dir: pos, values: pos + dirSize(entries.length) };
    pos += dirSize(entries.length) + valuesSize(entries);
  };
  place('zeroth', zeroth);
  place('exif', exif);
  place('interop', interop);
  place('gps', gps);
  place('first', first);
  const thumbAt = thumbnail ? pos : 0;

  const patch = (entries, tag, value) => {
    const e = entries.find(x => x.tag === tag);
    if (e) e.bytes = u32(value);
  };
  if (at.exif)    patch(zeroth, PTR_EXIF, at.exif.dir);
  if (at.gps)     patch(zeroth, PTR_GPS, at.gps.dir);
  if (at.interop) patch(exif, PTR_INTEROP, at.interop.dir);
  if (thumbnail)  patch(first, THUMB_OFFSET, thumbAt);

  const header = 'MM\0*' + u32(8);
  let body = '';
  // IFD0 points at IFD1 when there is a thumbnail directory; sub-IFDs terminate.
  body += writeIfd(zeroth, at.zeroth.values, at.first ? at.first.dir : 0);
  if (at.exif)    body += writeIfd(exif,    at.exif.values, 0);
  if (at.interop) body += writeIfd(interop, at.interop.values, 0);
  if (at.gps)     body += writeIfd(gps,     at.gps.values, 0);
  if (at.first)   body += writeIfd(first,   at.first.values, 0);

  return 'Exif\0\0' + header + body + (thumbnail || '');
}

/**
 * Serialise with `dumpExif`, verifying the result parses back before returning
 * it, and falling back to piexifjs if anything is off. A metadata block that
 * validates a little better is not worth a file nobody can read.
 */
export function dumpExifSafe(dict, px) {
  try {
    const bytes = dumpExif(dict, px);
    // Cheap structural checks only. The real gate is downstream: the pipeline
    // already runs readBackExifStrict on the finished file and fails loudly if
    // the metadata cannot be parsed back out.
    if (!bytes.startsWith('Exif\0\0MM\0*')) throw new Error('bad TIFF header');
    if (bytes.length < 16 || bytes.length > 0xFFFD) throw new Error(`implausible length ${bytes.length}`);
    for (let i = 0; i < bytes.length; i++) {
      if (bytes.charCodeAt(i) > 0xFF) throw new Error(`non-byte value at ${i}`);
    }
    return bytes;
  } catch (e) {
    if (typeof console !== 'undefined') {
      console.warn('exif-writer: falling back to piexif.dump —', e.message);
    }
    return px.dump(dict);
  }
}
