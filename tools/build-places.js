#!/usr/bin/env node
/**
 * build-places.js — generate js/places.js, the table every generated GPS
 * position is drawn from, and tools/us-land.json, the land mask check.js tests
 * generated positions against.
 *
 *   node tools/build-places.js [--src DIR]
 *
 * Every input is a US government work in the public domain, downloaded into
 * DIR (default <tmp>/metafaker-places) when missing and reused after:
 *   Census 2024 Gazetteer places        internal point, land area
 *   Census sub-est2024                  2024 population of incorporated places
 *   Census ACS 2020-2024 5-year B01003  population of census-designated places
 *   Census cartographic boundaries 2024 place and state polygons (1:500,000,
 *                                       clipped to the shoreline)
 *   USGS GNIS Federal Codes             each place's town-centre point
 *   NWS public forecast zones           time zone of each zone (TIME_ZONE)
 *   USGS Elevation Point Query Service  ground elevation (3DEP) at each centre
 *   IANA tz database zone1970.tab       the US zone list, for the zone check
 *
 * Each place gets one disk, the largest that fits inside the place polygon,
 * inside US land less MARGIN_M, clear of any forecast zone in another time
 * zone, and within the place's settled radius of its town centre (below). The
 * app draws a place weighted by population and a point uniformly in its disk.
 * The script then samples every disk and refuses to write if any sample
 * leaves the place, US land, the time zone or the shipped land mask.
 *
 * Zero npm dependencies; Node 22+.
 */

'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');

const ROOT = path.resolve(__dirname, '..');
const OUT_TABLE = path.join(ROOT, 'js', 'places.js');
const OUT_MASK = path.join(ROOT, 'tools', 'us-land.json');
const MIN_POP = 10000;
// A smaller disk would put all of a place's draws on one spot.
const MIN_RADIUS_M = 250;
// A place's settled radius is sqrt(area / pi) for its land area, or for the
// area its population would fill at the 2010 Census urban-core density of
// 1,000 people per square mile, whichever is smaller. Without the second
// bound, Anchorage's and Juneau's disks sat in the mountains and icefields
// that make up most of their land.
const CORE_DENSITY_PER_M2 = 1000 / 2589988;
// The land mask is simplified by up to this much, so every disk keeps this far
// from the coast and the simplified mask still contains it.
const MARGIN_M = 150;
const UA = 'MetaFakerResearch/1.0 (https://github.com/0xs8n/metafaker)';

const SOURCES = {
  gazetteer: 'https://www2.census.gov/geo/docs/maps-data/data/gazetteer/2024_Gazetteer/2024_Gaz_place_national.zip',
  estimates: 'https://www2.census.gov/programs-surveys/popest/datasets/2020-2024/cities/totals/sub-est2024.csv',
  acs:       'https://www2.census.gov/programs-surveys/acs/summary_file/2024/table-based-SF/data/5YRData/acsdt5y2024-b01003.dat',
  places:    'https://www2.census.gov/geo/tiger/GENZ2024/shp/cb_2024_us_place_500k.zip',
  states:    'https://www2.census.gov/geo/tiger/GENZ2024/shp/cb_2024_us_state_500k.zip',
  zones:     'https://www.weather.gov/source/gis/Shapefiles/WSOM/z_16ap26.zip',
  towns:     'https://prd-tnm.s3.amazonaws.com/StagedProducts/GeographicNames/FederalCodes/FedCodes_National_Text.zip',
  tzdb:      'https://data.iana.org/time-zones/tzdb/zone1970.tab',
};
const EPQS = 'https://epqs.nationalmap.gov/v1/json';

// NWS TIME_ZONE code -> the IANA zone whose rules the place follows. A
// lower-case code observes the opposite of the upper-case one's daylight time.
// Two-letter codes mark zones split by a time-zone line; places there are left
// out rather than guessed.
const NWS_ZONE = {
  E: 'America/New_York', C: 'America/Chicago', M: 'America/Denver', m: 'America/Phoenix',
  P: 'America/Los_Angeles', A: 'America/Anchorage', H: 'Pacific/Honolulu', h: 'America/Adak',
};
// US zones whose offsets differ from every zone above within the capture
// window. Metlakatla went back to Pacific time for the winter of 2018-19; the
// Annette Island Reserve has no place in the table (checked below).
const ZONE_EXCEPTIONS = { 'America/Metlakatla': 'Metlakatla' };

const STATE_FIPS_EXCLUDED = new Set(['60', '66', '69', '72', '78']);   // territories
const M_PER_DEG = 6371008.8 * Math.PI / 180;

// ── Sources ──────────────────────────────────────────────────────

function argValue(name, fallback) {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : fallback;
}

async function download(url, file) {
  if (fs.existsSync(file)) return;
  console.log(`download ${url}`);
  const res = await fetch(url, { headers: { 'User-Agent': UA } });
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  fs.writeFileSync(file + '.part', Buffer.from(await res.arrayBuffer()));
  fs.renameSync(file + '.part', file);
}

/** The entry of a zip archive whose name ends with `suffix`. */
function unzipEntry(buf, suffix) {
  const eocd = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  let at = buf.readUInt32LE(eocd + 16);
  for (let n = buf.readUInt16LE(eocd + 10); n > 0; n--) {
    const method = buf.readUInt16LE(at + 10), size = buf.readUInt32LE(at + 20);
    const nameLen = buf.readUInt16LE(at + 28), extraLen = buf.readUInt16LE(at + 30), commentLen = buf.readUInt16LE(at + 32);
    const local = buf.readUInt32LE(at + 42);
    const name = buf.toString('utf8', at + 46, at + 46 + nameLen);
    if (name.endsWith(suffix)) {
      const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
      const data = buf.subarray(start, start + size);
      return method === 0 ? data : zlib.inflateRawSync(data);
    }
    at += 46 + nameLen + extraLen + commentLen;
  }
  throw new Error(`no ${suffix} in archive`);
}

/** Polygon shapefile -> one array of rings per record, each ring [x0,y0,x1,y1,...]. */
function readShp(buf) {
  const shapes = [];
  for (let at = 100; at < buf.length;) {
    const len = buf.readInt32BE(at + 4) * 2, c = at + 8;
    const rings = [];
    if (buf.readInt32LE(c) === 5) {
      const parts = buf.readInt32LE(c + 36), points = buf.readInt32LE(c + 40);
      const pts = c + 44 + parts * 4;
      for (let p = 0; p < parts; p++) {
        const from = buf.readInt32LE(c + 44 + p * 4);
        const to = p + 1 < parts ? buf.readInt32LE(c + 48 + p * 4) : points;
        const ring = new Float64Array((to - from) * 2);
        for (let i = 0; i < ring.length; i++) ring[i] = buf.readDoubleLE(pts + (from * 2 + i) * 8);
        rings.push(ring);
      }
    }
    shapes.push(rings);
    at = c + len;
  }
  return shapes;
}

function readDbf(buf) {
  const count = buf.readUInt32LE(4), headerLen = buf.readUInt16LE(8), recordLen = buf.readUInt16LE(10);
  const fields = [];
  for (let at = 32; buf[at] !== 0x0d; at += 32) {
    fields.push({ name: buf.toString('latin1', at, at + 11).replace(/\0.*$/, ''), len: buf[at + 16] });
  }
  const rows = [];
  for (let i = 0; i < count; i++) {
    let at = headerLen + i * recordLen + 1;
    const row = {};
    for (const f of fields) { row[f.name] = buf.toString('utf8', at, at + f.len).trim(); at += f.len; }
    rows.push(row);
  }
  return rows;
}

function readShapefile(zipBuf) {
  const shapes = readShp(unzipEntry(zipBuf, '.shp'));
  return readDbf(unzipEntry(zipBuf, '.dbf')).map((row, i) => ({ row, rings: shapes[i], bbox: bboxOf(shapes[i]) }));
}

// ── Geometry ─────────────────────────────────────────────────────
//
// Coordinates stay in degrees. Distances use the same local projection the
// app samples in: metres east = dLon * M_PER_DEG * cos(lat of the centre).

function bboxOf(rings) {
  const b = [Infinity, Infinity, -Infinity, -Infinity];
  for (const r of rings) for (let i = 0; i < r.length; i += 2) {
    if (r[i] < b[0]) b[0] = r[i]; if (r[i] > b[2]) b[2] = r[i];
    if (r[i + 1] < b[1]) b[1] = r[i + 1]; if (r[i + 1] > b[3]) b[3] = r[i + 1];
  }
  return b;
}

/** Even-odd test over a set of rings. */
function ringsContain(rings, x, y) {
  let inside = false;
  for (const r of rings) {
    for (let i = 0, j = r.length - 2; i < r.length; j = i, i += 2) {
      if ((r[i + 1] > y) !== (r[j + 1] > y) && x < r[i] + (y - r[i + 1]) * (r[j] - r[i]) / (r[j + 1] - r[i + 1])) inside = !inside;
    }
  }
  return inside;
}

function shapeContains(s, x, y) {
  return x >= s.bbox[0] && x <= s.bbox[2] && y >= s.bbox[1] && y <= s.bbox[3] && ringsContain(s.rings, x, y);
}

/** Distance in metres from (x0, y0) to segment a-b, all in degrees. */
function segDist(x0, y0, kx, ax, ay, bx, by) {
  const px = (ax - x0) * kx, py = (ay - y0) * M_PER_DEG;
  const qx = (bx - x0) * kx, qy = (by - y0) * M_PER_DEG;
  const dx = qx - px, dy = qy - py, l2 = dx * dx + dy * dy;
  const t = l2 ? Math.max(0, Math.min(1, -(px * dx + py * dy) / l2)) : 0;
  return Math.hypot(px + t * dx, py + t * dy);
}

function ringsDist(rings, x0, y0, limitM = Infinity) {
  const kx = M_PER_DEG * Math.cos(y0 * Math.PI / 180);
  let d = limitM;
  for (const r of rings) for (let i = 0, j = r.length - 2; i < r.length; j = i, i += 2) {
    const ex = Math.max(Math.min(r[i], r[j]) - x0, 0, x0 - Math.max(r[i], r[j])) * kx;
    const ey = Math.max(Math.min(r[i + 1], r[j + 1]) - y0, 0, y0 - Math.max(r[i + 1], r[j + 1])) * M_PER_DEG;
    if (ex >= d || ey >= d) continue;
    d = Math.min(d, segDist(x0, y0, kx, r[j], r[j + 1], r[i], r[i + 1]));
  }
  return d;
}

/** Shapes bucketed by bounding box in a 1-degree grid, for point lookups. */
function shapeIndex(shapes) {
  const cells = new Map();
  for (const s of shapes) {
    for (let i = Math.floor(s.bbox[0]); i <= Math.floor(s.bbox[2]); i++) for (let j = Math.floor(s.bbox[1]); j <= Math.floor(s.bbox[3]); j++) {
      const k = i * 1000 + j;
      if (!cells.has(k)) cells.set(k, []);
      cells.get(k).push(s);
    }
  }
  return (x, y) => (cells.get(Math.floor(x) * 1000 + Math.floor(y)) || []).find(s => shapeContains(s, x, y));
}

/** Segments bucketed in a degree grid, each with a tag. */
class SegmentGrid {
  constructor(cell) { this.cell = cell; this.cells = new Map(); this.segs = []; this.tags = []; }
  add(ax, ay, bx, by, tag) {
    const id = this.tags.length;
    this.segs.push(ax, ay, bx, by); this.tags.push(tag);
    const c = this.cell;
    for (let i = Math.floor(Math.min(ax, bx) / c); i <= Math.floor(Math.max(ax, bx) / c); i++) {
      for (let j = Math.floor(Math.min(ay, by) / c); j <= Math.floor(Math.max(ay, by) / c); j++) {
        const k = i * 100000 + j;
        let list = this.cells.get(k);
        if (!list) this.cells.set(k, list = []);
        list.push(id);
      }
    }
  }
  /** Distance in metres to the nearest segment, or `reachM` if none is closer. */
  dist(x0, y0, reachM, skip = () => false) {
    const kx = M_PER_DEG * Math.cos(y0 * Math.PI / 180), s = this.segs, c = this.cell;
    const dx = reachM / kx, dy = reachM / M_PER_DEG;
    const near = [];
    for (let i = Math.floor((x0 - dx) / c); i <= Math.floor((x0 + dx) / c); i++) {
      for (let j = Math.floor((y0 - dy) / c); j <= Math.floor((y0 + dy) / c); j++) {
        const list = this.cells.get(i * 100000 + j);
        if (!list) continue;
        const gap = Math.hypot(Math.max(i * c - x0, 0, x0 - (i + 1) * c) * kx, Math.max(j * c - y0, 0, y0 - (j + 1) * c) * M_PER_DEG);
        if (gap < reachM) near.push([gap, list]);
      }
    }
    near.sort((a, b) => a[0] - b[0]);
    let d = reachM;
    for (const [gap, list] of near) {
      if (gap >= d) break;
      for (const id of list) {
        if (skip(this.tags[id])) continue;
        d = Math.min(d, segDist(x0, y0, kx, s[4 * id], s[4 * id + 1], s[4 * id + 2], s[4 * id + 3]));
      }
    }
    return d;
  }
  /** Even-odd test over every stored segment (they must form closed loops). */
  contains(x, y) {
    if (!this.rows) {
      this.rows = new Map();
      for (const k of this.cells.keys()) {
        const i = Math.round(k / 100000), j = k - i * 100000;
        if (!this.rows.has(j)) this.rows.set(j, []);
        this.rows.get(j).push(i);
      }
      for (const r of this.rows.values()) r.sort((a, b) => a - b);
    }
    let inside = false;
    const s = this.segs, c = this.cell, j = Math.floor(y / c), i0 = Math.floor(x / c);
    for (const i of this.rows.get(j) || []) {
      if (i < i0) continue;
      for (const id of this.cells.get(i * 100000 + j)) {
        const ax = s[4 * id], ay = s[4 * id + 1], bx = s[4 * id + 2], by = s[4 * id + 3];
        if ((ay > y) === (by > y)) continue;
        // A segment spanning several cells is listed in each; count it once, in the cell that holds its crossing.
        const cx = ax + (y - ay) * (bx - ax) / (by - ay);
        if (cx > x && Math.floor(cx / c) === i) inside = !inside;
      }
    }
    return inside;
  }
}

/**
 * The boundary of the union of the state polygons: every state edge that no
 * other state shares. The cartographic boundary files are built from one
 * topology, so a shared border is the same vertices in both states.
 */
function landBoundary(states) {
  const key = (ax, ay, bx, by) => (ax < bx || (ax === bx && ay < by)) ? `${ax},${ay},${bx},${by}` : `${bx},${by},${ax},${ay}`;
  const count = new Map();
  const edges = [];
  for (const s of states) for (const r of s.rings) for (let i = 0, j = r.length - 2; i < r.length; j = i, i += 2) {
    if (r[j] === r[i] && r[j + 1] === r[i + 1]) continue;
    const k = key(r[j], r[j + 1], r[i], r[i + 1]);
    count.set(k, (count.get(k) || 0) + 1);
    edges.push([r[j], r[j + 1], r[i], r[i + 1], k]);
  }
  return edges.filter(e => count.get(e[4]) === 1).map(e => e.slice(0, 4));
}

/** Join boundary edges into polylines that break at every node not of degree 2. */
function chains(edges) {
  const pk = (x, y) => `${x},${y}`;
  const at = new Map();
  edges.forEach((e, i) => {
    for (const k of [pk(e[0], e[1]), pk(e[2], e[3])]) { if (!at.has(k)) at.set(k, []); at.get(k).push(i); }
  });
  const used = new Uint8Array(edges.length);
  const out = [];
  const walk = (i, x, y, line) => {
    for (;;) {
      const next = (at.get(pk(x, y)) || []).filter(n => !used[n]);
      if (at.get(pk(x, y)).length !== 2 || next.length !== 1) return;
      const e = edges[next[0]];
      used[next[0]] = 1;
      [x, y] = e[0] === x && e[1] === y ? [e[2], e[3]] : [e[0], e[1]];
      line.push(x, y);
    }
  };
  for (let i = 0; i < edges.length; i++) {
    if (used[i]) continue;
    used[i] = 1;
    const e = edges[i];
    const fwd = [e[2], e[3]], back = [e[0], e[1]];
    walk(i, e[2], e[3], fwd);
    walk(i, e[0], e[1], back);
    const line = [];
    for (let k = back.length - 2; k >= 0; k -= 2) line.push(back[k], back[k + 1]);
    line.push(...fwd);
    out.push(line);
  }
  return out;
}

/** Douglas-Peucker on [x0,y0,...], tolerance in metres, end points kept. */
function simplify(line, tolM) {
  const n = line.length / 2, keep = new Uint8Array(n);
  keep[0] = keep[n - 1] = 1;
  const stack = [[0, n - 1]];
  while (stack.length) {
    const [a, b] = stack.pop();
    let best = -1, far = tolM;
    for (let i = a + 1; i < b; i++) {
      const x0 = line[2 * i], y0 = line[2 * i + 1];
      const d = segDist(x0, y0, M_PER_DEG * Math.cos(y0 * Math.PI / 180), line[2 * a], line[2 * a + 1], line[2 * b], line[2 * b + 1]);
      if (d > far) { far = d; best = i; }
    }
    if (best >= 0) { keep[best] = 1; stack.push([a, best], [best, b]); }
  }
  const out = [];
  for (let i = 0; i < n; i++) if (keep[i]) out.push(line[2 * i], line[2 * i + 1]);
  return out;
}

// ── Places ───────────────────────────────────────────────────────

function displayName(name, usps) {
  const base = name.replace(/\s*\(balance\)$/, '')
    .replace(/\s+(city and borough|metropolitan government|metro government|unified government|consolidated government|urban county|municipality|city|town|village|borough|CDP)$/, '');
  return `${base}, ${usps}`;
}

function readPlaces(src) {
  const pop = new Map();
  for (const line of fs.readFileSync(path.join(src, 'sub-est2024.csv'), 'latin1').split('\n').slice(1)) {
    const f = [...line.matchAll(/(?:"([^"]*)"|([^,\r]*))(?:,|$)/g)].map(m => m[1] ?? m[2]);
    if (f[0] === '162') pop.set(f[1] + f[3], Number(f[15]));
  }
  const acs = new Map();
  for (const line of fs.readFileSync(path.join(src, 'acsdt5y2024-b01003.dat'), 'latin1').split('\n')) {
    if (line.startsWith('1600000US')) { const [id, e] = line.split('|'); acs.set(id.slice(9), Number(e)); }
  }
  const gaz = unzipEntry(fs.readFileSync(path.join(src, '2024_Gaz_place_national.zip')), '.txt').toString('utf8').split('\n');
  const head = gaz[0].split('\t').map(s => s.trim());
  const col = name => head.indexOf(name);
  const places = [];
  for (const line of gaz.slice(1)) {
    const f = line.split('\t').map(s => s.trim());
    if (f.length < head.length || STATE_FIPS_EXCLUDED.has(f[col('GEOID')].slice(0, 2))) continue;
    const geoid = f[col('GEOID')];
    const incorporated = f[col('FUNCSTAT')] !== 'S';
    const p = incorporated ? pop.get(geoid) : acs.get(geoid);
    if (!(p >= MIN_POP)) continue;
    places.push({
      geoid, name: displayName(f[col('NAME')], f[col('USPS')]), pop: p,
      lat: Number(f[col('INTPTLAT')]), lon: Number(f[col('INTPTLONG')]),
      cap: Math.sqrt(Math.min(Number(f[col('ALAND')]), p / CORE_DENSITY_PER_M2) / Math.PI),
    });
  }
  return places;
}

/**
 * GNIS point of each place's town centre, by Census GEOID: the Populated Place
 * feature carrying the place's code, else its Civil or Census feature.
 */
function readTownPoints(zipBuf) {
  const rank = { 'Populated Place': 0, 'Civil': 1, 'Census': 2 };
  const lines = unzipEntry(zipBuf, '.txt').toString('utf8').replace(/^\uFEFF/, '').split('\n');
  const head = lines[0].split('|').map(s => s.trim());
  const col = name => head.indexOf(name);
  const best = new Map();
  for (const line of lines.slice(1)) {
    const f = line.split('|');
    const r = rank[f[col('feature_class')]], code = f[col('census_code')];
    if (r === undefined || !code || f[col('county_sequence')] !== '1') continue;
    const geoid = f[col('state_numeric')] + code;
    const lat = Number(f[col('prim_lat_dec')]), lon = Number(f[col('prim_long_dec')]);
    if (!lat || !lon) continue;
    if (!best.has(geoid) || r < best.get(geoid).r) best.set(geoid, { r, lat, lon });
  }
  return best;
}

/**
 * The largest disk that fits inside `radiusAt`'s region, by best-first
 * subdivision of the box [x0, y0, x1, y1] (polylabel). `radiusAt` must change
 * by at most one metre per metre moved, and may return 0 for any point outside.
 */
function largestDisk(box, radiusAt, start) {
  const kx = M_PER_DEG * Math.cos((box[1] + box[3]) / 2 * Math.PI / 180);
  const cell = (x, y, h) => { const r = radiusAt(x, y); return { x, y, h, r, max: r + h * Math.SQRT2 }; };
  let best = { x: start[0], y: start[1], r: radiusAt(start[0], start[1]) };
  const w = (box[2] - box[0]) * kx, hgt = (box[3] - box[1]) * M_PER_DEG;
  const size = Math.max(1, Math.min(w, hgt)), heap = [];
  const push = c => { heap.push(c); for (let i = heap.length - 1; i > 0;) { const p = (i - 1) >> 1; if (heap[p].max >= heap[i].max) break; [heap[p], heap[i]] = [heap[i], heap[p]]; i = p; } };
  const pop = () => {
    const top = heap[0], last = heap.pop();
    if (heap.length) {
      heap[0] = last;
      for (let i = 0; ;) { const l = 2 * i + 1, r = l + 1; let m = i;
        if (l < heap.length && heap[l].max > heap[m].max) m = l; if (r < heap.length && heap[r].max > heap[m].max) m = r;
        if (m === i) break; [heap[m], heap[i]] = [heap[i], heap[m]]; i = m; }
    }
    return top;
  };
  for (let x = 0; x < w; x += size) for (let y = 0; y < hgt; y += size) {
    push(cell(box[0] + (x + size / 2) / kx, box[1] + (y + size / 2) / M_PER_DEG, size / 2));
  }
  for (let evals = 0; heap.length && evals < 6000; evals++) {
    const c = pop();
    if (c.r > best.r) best = c;
    if (c.max - best.r <= 25) continue;
    const h = c.h / 2;
    for (const [sx, sy] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) push(cell(c.x + sx * h / kx, c.y + sy * h / M_PER_DEG, h));
  }
  return best;
}

// ── Elevation ────────────────────────────────────────────────────

async function elevations(points, cacheFile) {
  const cache = fs.existsSync(cacheFile) ? JSON.parse(fs.readFileSync(cacheFile, 'utf8')) : {};
  const save = () => { fs.writeFileSync(cacheFile + '.part', JSON.stringify(cache)); fs.renameSync(cacheFile + '.part', cacheFile); };
  const todo = [...new Set(points.map(p => `${p.lat},${p.lon}`))].filter(k => !(k in cache));
  if (todo.length) console.log(`elevation: ${todo.length} points to query from USGS EPQS`);
  let done = 0;
  const worker = async () => {
    while (todo.length) {
      const k = todo.pop();
      const [lat, lon] = k.split(',');
      for (let attempt = 1; ; attempt++) {
        try {
          const res = await fetch(`${EPQS}?x=${lon}&y=${lat}&wkid=4326&units=Meters&includeDate=false`,
            { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(60000) });
          const v = Number((await res.json()).value);
          if (!res.ok || !Number.isFinite(v) || v < -500) throw new Error(`HTTP ${res.status} value ${v}`);
          cache[k] = Math.round(v * 10) / 10;
          break;
        } catch (e) {
          if (attempt >= 6) throw new Error(`EPQS ${k}: ${e.message}`);
          await new Promise(r => setTimeout(r, 2000 * attempt));
        }
      }
      if (++done % 100 === 0) { save(); console.log(`elevation: ${done} done, ${Math.round(process.uptime())} s`); }
    }
  };
  await Promise.all(Array.from({ length: 10 }, worker));
  save();
  return points.map(p => cache[`${p.lat},${p.lon}`]);
}

// ── Time zones ───────────────────────────────────────────────────

/** Offsets of `tz` every six hours from `from` to `to`, as one string. */
function offsetTrace(tz, from, to) {
  const fmt = new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'longOffset' });
  const out = [];
  for (let t = from; t <= to; t += 6 * 3600e3) out.push(fmt.formatToParts(t).find(p => p.type === 'timeZoneName').value);
  return out.join(' ');
}

/**
 * Every IANA zone in the US must follow one of the NWS_ZONE zones over the
 * capture window: from the oldest camera's release, which bounds every capture
 * date the app writes, to two years past today.
 */
function checkZoneEquivalence(src, places) {
  const released = [...fs.readFileSync(path.join(ROOT, 'js', 'data.js'), 'utf8').matchAll(/released:"(\d{4}-\d\d-\d\d)"/g)].map(m => m[1]).sort();
  const from = Date.parse(`${released[0]}T00:00:00Z`), to = Date.now() + 2 * 365 * 86400e3;
  const ref = new Map(Object.values(NWS_ZONE).map(z => [offsetTrace(z, from, to), z]));
  const us = fs.readFileSync(path.join(src, 'zone1970.tab'), 'utf8').split('\n')
    .map(l => l.split('\t')).filter(f => /(^|,)US(,|$)/.test(f[0])).map(f => f[2]);
  const odd = us.filter(z => !ref.has(offsetTrace(z, from, to)));
  for (const z of odd) {
    if (!(z in ZONE_EXCEPTIONS)) throw new Error(`${z} follows none of the NWS zones between ${released[0]} and now`);
    const hit = places.find(p => p.name.startsWith(ZONE_EXCEPTIONS[z]));
    if (hit) throw new Error(`${hit.name} is in ${z}, which follows none of the NWS zones`);
  }
  console.log(`zones: ${us.length} US zones; all but ${odd.join(', ') || 'none'} match an NWS zone from ${released[0]}`);
}

// ── Build ────────────────────────────────────────────────────────

async function main() {
  const src = argValue('--src', path.join(os.tmpdir(), 'metafaker-places'));
  fs.mkdirSync(src, { recursive: true });
  for (const url of Object.values(SOURCES)) await download(url, path.join(src, path.basename(url)));
  const file = url => fs.readFileSync(path.join(src, path.basename(url)));

  const places = readPlaces(src);
  const placeShapes = new Map(readShapefile(file(SOURCES.places)).map(s => [s.row.GEOID, s]));
  const states = readShapefile(file(SOURCES.states)).filter(s => !STATE_FIPS_EXCLUDED.has(s.row.STATEFP));
  const zones = readShapefile(file(SOURCES.zones)).filter(s => s.rings.length);
  console.log(`places >= ${MIN_POP}: ${places.length}; states ${states.length}; forecast zones ${zones.length}; ${Math.round(process.uptime())} s`);

  const edges = landBoundary(states);
  const land = new SegmentGrid(0.05);
  for (const e of edges) land.add(...e, 0);
  const zoneEdges = new SegmentGrid(0.05);
  for (const z of zones) for (const r of z.rings) for (let i = 0, j = r.length - 2; i < r.length; j = i, i += 2) {
    zoneEdges.add(r[j], r[j + 1], r[i], r[i + 1], z.row.TIME_ZONE);
  }
  const onLand = (x, y) => states.some(s => shapeContains(s, x, y));
  const zoneShape = shapeIndex(zones);
  const zoneAt = (x, y) => zoneShape(x, y)?.row.TIME_ZONE;
  const towns = readTownPoints(file(SOURCES.towns));

  // The disk is the largest that stays inside the place, on land, in one time
  // zone, and within the settled radius of the town centre, so a city's draws sit
  // around its centre rather than wherever its land area happens to be widest.
  const kept = [], dropped = [];
  for (const p of places) {
    const shape = placeShapes.get(p.geoid);
    if (!shape) { dropped.push(`${p.name} (no boundary)`); continue; }
    const gnis = towns.get(p.geoid);
    const town = gnis && shapeContains(shape, gnis.lon, gnis.lat) ? gnis : { lat: p.lat, lon: p.lon };
    const radiusAt = (x, y) => {
      const cap = p.cap - Math.hypot((x - town.lon) * M_PER_DEG * Math.cos(y * Math.PI / 180), (y - town.lat) * M_PER_DEG);
      if (cap <= 0) return cap;
      const code = zoneAt(x, y);
      if (!NWS_ZONE[code] || !shapeContains(shape, x, y) || !land.contains(x, y)) return 0;
      let d = Math.min(cap, ringsDist(shape.rings, x, y, cap));
      d = Math.min(d, land.dist(x, y, d + MARGIN_M) - MARGIN_M);
      return Math.min(d, zoneEdges.dist(x, y, d, tag => tag === code));
    };
    const dy = p.cap / M_PER_DEG, dx = dy / Math.cos(town.lat * Math.PI / 180);
    const box = [Math.max(shape.bbox[0], town.lon - dx), Math.max(shape.bbox[1], town.lat - dy),
                 Math.min(shape.bbox[2], town.lon + dx), Math.min(shape.bbox[3], town.lat + dy)];
    const best = largestDisk(box, radiusAt, [town.lon, town.lat]);
    const r = Math.floor(best.r);
    if (r < MIN_RADIUS_M) { dropped.push(`${p.name} (radius ${r} m)`); continue; }
    const lat = Number(best.y.toFixed(5)), lon = Number(best.x.toFixed(5));
    kept.push({ ...p, lat, lon, r: Math.min(r, Math.floor(radiusAt(lon, lat))), tz: NWS_ZONE[zoneAt(lon, lat)], shape });
    if (kept.length % 250 === 0) console.log(`disks: ${kept.length} placed, ${Math.round(process.uptime())} s`);
  }
  console.log(`kept ${kept.length}, dropped ${dropped.length}: ${dropped.join('; ')}`);
  checkZoneEquivalence(src, kept);

  // The mask keeps only the boundary loops near some place, so remote islands
  // read as water; a dropped loop flips only the points it encloses.
  const near = (b) => kept.some(p => {
    const dy = p.r / M_PER_DEG, dx = dy / Math.cos(p.lat * Math.PI / 180);
    return p.lon + dx >= b[0] && p.lon - dx <= b[2] && p.lat + dy >= b[1] && p.lat - dy <= b[3];
  });
  const lines = components(chains(edges)).filter(c => near(bboxOf(c))).flat()
    .map(l => simplify(l, MARGIN_M - 5).map(v => Math.round(v * 1e5)));
  const mask = new SegmentGrid(0.05);
  for (const l of lines) for (let i = 2; i < l.length; i += 2) mask.add(l[i - 2] / 1e5, l[i - 1] / 1e5, l[i] / 1e5, l[i + 1] / 1e5, 0);

  // Every disk, sampled on its rim and inside, must stay in its place, on US
  // land, in its time zone and inside the mask check.js uses.
  let samples = 0;
  for (const p of kept) {
    const kx = M_PER_DEG * Math.cos(p.lat * Math.PI / 180);
    for (const f of [0, 0.5, 0.999]) for (let a = 0; a < 96; a++) {
      const t = (a + 0.5 * f) * 2 * Math.PI / 96;
      const x = p.lon + f * p.r * Math.sin(t) / kx, y = p.lat + f * p.r * Math.cos(t) / M_PER_DEG;
      const zone = zoneAt(x, y);
      const fail = !shapeContains(p.shape, x, y) ? 'leaves the place' : !onLand(x, y) ? 'leaves US land'
        : zone !== undefined && NWS_ZONE[zone] !== p.tz ? 'leaves its time zone'
        : !mask.contains(x, y) ? 'leaves the land mask' : null;
      if (fail) throw new Error(`${p.name}: disk of ${p.r} m ${fail} at ${y.toFixed(6)}, ${x.toFixed(6)}`);
      samples++;
      if (f === 0) break;
    }
  }
  console.log(`disks: ${samples} samples, all inside place, US land, time zone and mask`);

  const elev = await elevations(kept, path.join(src, 'epqs.json'));
  kept.forEach((p, i) => { p.elev = Math.round(elev[i]); });
  kept.sort((a, b) => b.pop - a.pop);
  const tzs = [...new Set(kept.map(p => p.tz))];
  const rows = kept.map(p => JSON.stringify([p.name, p.lat, p.lon, p.r, p.pop, p.elev, tzs.indexOf(p.tz)]));
  const table = `// Generated by tools/build-places.js from US Census, NWS and USGS data. Do not edit by hand.
//
// US places of ${MIN_POP.toLocaleString('en-US')} people or more, largest first. Each row:
// [name, lat, lon, radius m, population, ground elevation m, index into ZONES]
// Every point within the radius of (lat, lon) is inside the place, on US land
// at least ${MARGIN_M} m from the coast, in one time zone, and within
// the place's settled radius of its GNIS town centre (see tools/build-places.js).

export const ZONES = ${JSON.stringify(tzs)};

export const PLACES = [
${rows.join(',\n')},
];
`;
  fs.writeFileSync(OUT_TABLE, table);
  fs.writeFileSync(OUT_MASK, JSON.stringify({
    about: `US land (Census cb_2024_us_state_500k, 50 states and DC) as boundary polylines in degrees x 1e5, simplified by up to ${MARGIN_M} m. Even-odd over all segments. Generated by tools/build-places.js.`,
    lines,
  }));
  const pop = kept.reduce((s, p) => s + p.pop, 0);
  console.log(`wrote ${path.relative(ROOT, OUT_TABLE)} (${kept.length} places, ${pop.toLocaleString('en-US')} people, ${fs.statSync(OUT_TABLE).size} bytes)`);
  console.log(`wrote ${path.relative(ROOT, OUT_MASK)} (${lines.length} lines, ${fs.statSync(OUT_MASK).size} bytes)`);
}

/** Group polylines into connected sets, so whole loops can be dropped together. */
function components(lines) {
  const parent = lines.map((_, i) => i);
  const find = i => parent[i] === i ? i : (parent[i] = find(parent[i]));
  const endAt = new Map();
  lines.forEach((l, i) => {
    for (const k of [`${l[0]},${l[1]}`, `${l[l.length - 2]},${l[l.length - 1]}`]) {
      if (endAt.has(k)) parent[find(i)] = find(endAt.get(k)); else endAt.set(k, i);
    }
  });
  const groups = new Map();
  lines.forEach((l, i) => { const r = find(i); if (!groups.has(r)) groups.set(r, []); groups.get(r).push(l); });
  return [...groups.values()];
}

main().catch(e => { console.error(e.message); process.exit(1); });
