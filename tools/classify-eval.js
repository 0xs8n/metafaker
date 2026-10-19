#!/usr/bin/env node
/**
 * classify-eval.js — measure the shipped screenshot/photo classifier on a
 * labelled corpus and on the copies a messaging app or an editor would make.
 *
 *   node tools/classify-eval.js <corpus> [--holdout g1,g2] [--jobs 1] [--json rows.jsonl] [--misses]
 *
 * <corpus>/photo/<group>/* are real camera photos, <corpus>/screen/<group>/*
 * are screenshots (JPEG, PNG or WebP). Each file is classified as it is, with
 * its metadata stripped, and as re-encoded copies (VARIANTS), all through
 * js/classify.js and js/exif.js in headless Chrome, the calls hydrateItem() in
 * js/ui.js makes. Groups named in --holdout are reported apart, so a change
 * tuned on the others can be checked on sources it never saw.
 *
 * Prints, per variant, the share of screenshots caught and the number of
 * photos taken for a screenshot. Exit code 1 if any photo variant is.
 * No corpus is committed: the useful files are other people's images.
 */
'use strict';

const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const cdp = require('./lib/cdp.js');

const ROOT = path.resolve(__dirname, '..');
const IMAGE = /\.(jpe?g|png|webp)$/i;

// maxEdge: long-edge cap (no upscaling). crop: centre crop to this long/short
// ratio first, keeping the orientation (a phone-screen shape, a panorama). meta: 'kept' carries the original's
// EXIF/XMP/IPTC (a PNG's eXIf and XMP chunks) into the copy; 'stripped' drops
// them from a JPEG losslessly.
const VARIANTS = [
  { name: 'original', meta: 'kept' },
  { name: 'original-stripped', meta: 'stripped', jpegOnly: true },
  { name: '1280-q70', maxEdge: 1280, type: 'image/jpeg', q: 0.70 },
  { name: '1280-q75', maxEdge: 1280, type: 'image/jpeg', q: 0.75 },
  { name: '1600-q80', maxEdge: 1600, type: 'image/jpeg', q: 0.80 },
  { name: '1600-q85', maxEdge: 1600, type: 'image/jpeg', q: 0.85 },
  { name: 'full-q90', maxEdge: 1e9, type: 'image/jpeg', q: 0.90 },
  { name: '1600-webp80', maxEdge: 1600, type: 'image/webp', q: 0.80 },
  { name: 'tall-crop-q80', maxEdge: 1600, crop: 19.5 / 9, type: 'image/jpeg', q: 0.80 },
  { name: 'pano-crop-q80', maxEdge: 1600, crop: 3, type: 'image/jpeg', q: 0.80 },
  { name: '1600-q80-kept', maxEdge: 1600, type: 'image/jpeg', q: 0.80, meta: 'kept' },
];

function parseArgs(argv) {
  const a = { corpus: null, holdout: new Set(), jobs: 1, json: null, misses: false };
  for (let i = 0; i < argv.length; i++) {
    const v = argv[i];
    if (v === '--holdout') a.holdout = new Set(argv[++i].split(',').filter(Boolean));
    else if (v === '--jobs') a.jobs = Math.max(1, +argv[++i] || 1);
    else if (v === '--json') a.json = path.resolve(argv[++i]);
    else if (v === '--misses') a.misses = true;
    else if (!a.corpus) a.corpus = path.resolve(v);
  }
  if (!a.corpus) throw new Error('usage: node tools/classify-eval.js <corpus> [--holdout g1,g2] [--jobs N] [--json out] [--misses]');
  return a;
}

function listCorpus(corpus, holdout) {
  const sources = [];
  for (const label of ['photo', 'screen']) {
    const dir = path.join(corpus, label);
    if (!fs.existsSync(dir)) continue;
    for (const group of fs.readdirSync(dir).sort()) {
      const gdir = path.join(dir, group);
      if (!fs.statSync(gdir).isDirectory()) continue;
      for (const f of fs.readdirSync(gdir).sort()) {
        if (IMAGE.test(f)) sources.push({ rel: `${label}/${group}/${f}`, label, group, split: holdout.has(group) ? 'holdout' : 'train' });
      }
    }
  }
  return sources;
}

/** Repo files at /, corpus files at /corpus/, one origin so the page can fetch both. */
function serve(corpus) {
  const server = http.createServer((req, res) => {
    const rel = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    if (rel === '/') { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end('<!doctype html><title>classify-eval</title>'); return; }
    const [base, sub] = rel.startsWith('/corpus/') ? [corpus, rel.slice(8)] : [ROOT, rel.slice(1)];
    const file = path.resolve(base, sub);
    if (!file.startsWith(base) || !fs.existsSync(file) || !fs.statSync(file).isFile()) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'Content-Type': cdp.MIME[path.extname(file).toLowerCase()] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    fs.createReadStream(file).pipe(res);
  });
  return new Promise(r => server.listen(0, '127.0.0.1', () => r({ origin: `http://127.0.0.1:${server.address().port}`, close: () => server.close() })));
}

/** Runs in the page: build each variant of one source and classify it as the app does. */
async function classifySource(url, variants) {
  const { sniffFormat, measureContent, classifyInput } = await import('/js/classify.js');
  const { parseFileExif, readUserComment } = await import('/js/exif.js');
  const bytes = new Uint8Array(await (await fetch(url)).arrayBuffer());
  const isJpeg = bytes[0] === 0xFF && bytes[1] === 0xD8;

  // Lossless split of a JPEG into its metadata segments (APP1 EXIF/XMP, APP13
  // IPTC) and everything else.
  const jpegSegments = u => {
    const meta = [], rest = [u.subarray(0, 2)];
    let i = 2;
    while (i + 4 <= u.length && u[i] === 0xFF) {
      const m = u[i + 1];
      if (m === 0xDA) break;
      const end = i + 2 + ((u[i + 2] << 8) | u[i + 3]);
      (m === 0xE1 || m === 0xED ? meta : rest).push(u.subarray(i, end));
      i = end;
    }
    rest.push(u.subarray(i));
    return { meta, rest };
  };
  // A PNG's EXIF (eXIf) and XMP (iTXt) chunks, as the JPEG segments a
  // converter that keeps metadata would write.
  const pngMeta = u => {
    const meta = [], dv = new DataView(u.buffer, u.byteOffset, u.byteLength), enc = new TextEncoder();
    const app1 = body => { const s = new Uint8Array(4 + body.length); s.set([0xFF, 0xE1, (body.length + 2) >> 8, (body.length + 2) & 255]); s.set(body, 4); return s; };
    for (let i = 8; i + 8 <= u.length;) {
      const len = dv.getUint32(i), type = String.fromCharCode(...u.subarray(i + 4, i + 8)), data = u.subarray(i + 8, i + 8 + len);
      if (type === 'eXIf') meta.push(app1(new Uint8Array([...enc.encode('Exif\0\0'), ...data])));
      if (type === 'iTXt' && String.fromCharCode(...data.subarray(0, 17)) === 'XML:com.adobe.xmp' && data[18] === 0) {
        let k = 19, nul = 0;
        while (k < data.length && nul < 2) if (data[k++] === 0) nul++;
        meta.push(app1(new Uint8Array([...enc.encode('http://ns.adobe.com/xap/1.0/\0'), ...data.subarray(k)])));
      }
      if (type === 'IEND') break;
      i += 12 + len;
    }
    return meta;
  };
  const isPng = bytes[0] === 0x89 && bytes[1] === 0x50;
  const withMeta = (u, meta) => new Blob([u.subarray(0, 2), ...meta, u.subarray(2)], { type: 'image/jpeg' });

  const classify = async blob => {
    const file = new File([blob], 'input', { type: blob.type });
    const format = sniffFormat(new Uint8Array(await file.slice(0, 1024).arrayBuffer()));
    const exif = await parseFileExif(file);
    let content = null;
    try {
      const bmp = await createImageBitmap(file);
      try { content = measureContent(bmp); } finally { bmp.close(); }
    } catch {}
    const userComment = await readUserComment(file);
    const v = classifyInput({ format, exif, userComment, content });
    return { format, isPhoto: v.isPhoto, kind: v.kind, reason: v.reason, userComment, content };
  };

  const out = [];
  const src = new Blob([bytes]);
  const segs = isJpeg ? jpegSegments(bytes) : null;
  let bmp = null;
  for (const v of variants) {
    if (v.jpegOnly && !isJpeg) continue;
    let blob;
    if (!v.type) {
      blob = v.meta === 'stripped' ? new Blob(segs.rest, { type: 'image/jpeg' }) : src;
    } else {
      if (!bmp) bmp = await createImageBitmap(src);
      let sw = bmp.width, sh = bmp.height;
      if (v.crop) {
        const long = Math.max(sw, sh), short = Math.min(sw, sh);
        const [cl, cs] = long / short > v.crop ? [short * v.crop, short] : [long, long / v.crop];
        [sw, sh] = sw >= sh ? [cl, cs] : [cs, cl];
      }
      const s = Math.min(1, v.maxEdge / Math.max(sw, sh));
      const c = document.createElement('canvas');
      c.width = Math.max(1, Math.round(sw * s)); c.height = Math.max(1, Math.round(sh * s));
      const cx = c.getContext('2d');
      cx.imageSmoothingQuality = 'high';
      cx.drawImage(bmp, (bmp.width - sw) / 2, (bmp.height - sh) / 2, sw, sh, 0, 0, c.width, c.height);
      blob = await new Promise(r => c.toBlob(r, v.type, v.q));
      c.width = c.height = 0;
      if (v.meta === 'kept') blob = withMeta(new Uint8Array(await blob.arrayBuffer()), isJpeg ? segs.meta : isPng ? pngMeta(bytes) : []);
    }
    out.push({ variant: v.name, ...(await classify(blob)) });
  }
  if (bmp) bmp.close();
  return out;
}

async function openPages(chrome, origin, n) {
  const pages = [chrome.page];
  for (let i = 1; i < n; i++) {
    const t = await (await fetch(`http://127.0.0.1:${chrome.port}/json/new?about:blank`, { method: 'PUT' })).json();
    pages.push(await cdp.CdpSession.connect(t.webSocketDebuggerUrl));
  }
  for (const p of pages) { await p.send('Page.enable'); await p.navigate(`${origin}/`); }
  return pages;
}

function pct(n, d) { return d ? `${n}/${d} (${(100 * n / d).toFixed(1)}%)` : '-'; }

function report(rows, showMisses) {
  const names = VARIANTS.map(v => v.name);
  const line = cols => console.log(cols.map((c, i) => String(c).padEnd(i ? 22 : 19)).join(''));
  console.log('\nScreenshots caught (non-photo) and photos taken for a screenshot, per variant:\n');
  line(['variant', 'screens train', 'screens holdout', 'photos->screen train', 'photos->screen holdout']);
  for (const name of [...names, 'all']) {
    const r = rows.filter(x => name === 'all' || x.variant === name);
    const cell = (label, split) => {
      const s = r.filter(x => x.label === label && x.split === split);
      return label === 'screen' ? pct(s.filter(x => !x.isPhoto).length, s.length) : `${s.filter(x => !x.isPhoto).length} of ${s.length}`;
    };
    line([name, cell('screen', 'train'), cell('screen', 'holdout'), cell('photo', 'train'), cell('photo', 'holdout')]);
  }
  const groups = [...new Set(rows.filter(r => r.label === 'screen').map(r => r.group))];
  console.log('\nScreenshots caught per group (all variants):');
  for (const g of groups) {
    const s = rows.filter(r => r.group === g && r.label === 'screen');
    console.log(`  ${g.padEnd(24)}${s[0].split.padEnd(9)}${pct(s.filter(x => !x.isPhoto).length, s.length)}`);
  }
  const fp = rows.filter(r => r.label === 'photo' && !r.isPhoto);
  console.log(`\nPhotos taken for a screenshot: ${fp.length}`);
  for (const r of fp) console.log(`  ${r.rel} [${r.variant}] ${r.reason}`);
  if (showMisses) {
    console.log('\nScreenshots taken for a photo:');
    for (const r of rows.filter(x => x.label === 'screen' && x.isPhoto)) console.log(`  ${r.rel} [${r.variant}] ${JSON.stringify(r.content)}`);
  }
  return fp.length;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const sources = listCorpus(args.corpus, args.holdout);
  if (!sources.length) throw new Error(`no images under ${args.corpus}/{photo,screen}/<group>/`);
  const server = await serve(args.corpus);
  const chrome = await cdp.launchChrome();
  const rows = [];
  const t0 = Date.now();
  try {
    const pages = await openPages(chrome, server.origin, args.jobs);
    let next = 0, done = 0;
    await Promise.all(pages.map(async page => {
      while (next < sources.length) {
        const s = sources[next++];
        let res;
        try {
          res = await page.evaluate(classifySource, `/corpus/${s.rel.split('/').map(encodeURIComponent).join('/')}`, VARIANTS);
        } catch (e) {
          console.error(`  ${s.rel}: ${e.message.split('\n')[0]}`);
          continue;
        }
        for (const r of res) rows.push({ ...s, ...r });
        if (++done % 25 === 0) process.stderr.write(`  ${done}/${sources.length} sources, ${((Date.now() - t0) / 1000).toFixed(0)} s\n`);
      }
    }));
  } finally {
    await chrome.close();
    server.close();
  }
  if (args.json) fs.writeFileSync(args.json, rows.map(r => JSON.stringify(r)).join('\n') + '\n');
  const nSrc = l => sources.filter(s => s.label === l).length;
  console.log(`${nSrc('photo')} photos and ${nSrc('screen')} screenshots, ${rows.length} variants, ${((Date.now() - t0) / 1000).toFixed(0)} s`);
  process.exitCode = report(rows, args.misses) ? 1 : 0;
}

main().catch(e => { console.error(e); process.exit(2); });
