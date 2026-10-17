#!/usr/bin/env node
/**
 * stress.js — run every file in <inDir> through BOTH the randomize and strip
 * paths of the real app, one at a time, and report per file. Writes outputs to
 * <outDir> and prints one JSON line per input plus a final JSON summary line.
 *
 *   node tools/stress.js <inDir> <outDir>
 *
 * Reports, per file: input type and dimensions, the classifier verdict, and for
 * each path whether it errored (and the message), the output size and mode.
 * Zero npm dependencies; Node 22+.
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const cdp = require('./lib/cdp.js');

const ROOT = path.resolve(__dirname, '..');
const MIME = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp' };

async function main() {
  const inDir = path.resolve(process.argv[2]);
  const outDir = path.resolve(process.argv[3]);
  fs.mkdirSync(outDir, { recursive: true });
  const names = fs.readdirSync(inDir).filter(f => /\.(jpe?g|png|webp)$/i.test(f)).sort();

  const server = await cdp.startStaticServer(ROOT);
  const chrome = await cdp.launchChrome();
  const rows = [];
  try {
    const page = chrome.page;
    const rec = await cdp.instrumentPage(page);
    await page.navigate(`${server.origin}/index.html`, { timeoutMs: 30000 });
    await cdp.waitForApp(page);

    for (const name of names) {
      const type = MIME[path.extname(name).toLowerCase()] || 'application/octet-stream';
      const b64in = fs.readFileSync(path.join(inDir, name)).toString('base64');
      const r = await page.evaluate(async (b64, name, type) => {
        const toFile = () => {
          const bin = atob(b64); const u8 = new Uint8Array(bin.length);
          for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
          return new File([u8], name, { type });
        };
        const readB64 = blob => new Promise((res, rej) => {
          const fr = new FileReader(); fr.onload = () => res(String(fr.result).split(',')[1]); fr.onerror = () => rej(fr.error); fr.readAsDataURL(blob);
        });
        const out = { w: 0, h: 0, isPhoto: null, reason: '' };
        // Randomize
        App.reset(); await App.loadFiles([toFile()]);
        let it = S.items[S.items.length - 1];
        out.w = 0; out.h = 0;
        out.isPhoto = it.inputClass ? it.inputClass.isPhoto : null;
        out.reason = it.inputClass ? it.inputClass.reason : '';
        App.select(it.id);
        try { await App.randomize(); it = S.items[S.items.length - 1]; out.randErr = it.error || null; out.randSize = it.modBlob ? it.modBlob.size : 0; out.randB64 = it.modBlob ? await readB64(it.modBlob) : null; out.randCam = it.fakeCamera ? `${it.fakeCamera.make} ${it.fakeCamera.model}` : ''; }
        catch (e) { out.randErr = e.message; out.randSize = 0; out.randB64 = null; }
        // Strip
        App.reset(); await App.loadFiles([toFile()]);
        it = S.items[S.items.length - 1];
        App.select(it.id);
        try { await App.clear(); it = S.items[S.items.length - 1]; out.stripErr = it.error || null; out.stripSize = it.modBlob ? it.modBlob.size : 0; out.stripB64 = it.modBlob ? await readB64(it.modBlob) : null; }
        catch (e) { out.stripErr = e.message; out.stripSize = 0; out.stripB64 = null; }
        return out;
      }, b64in, name, type);

      if (r.randB64) fs.writeFileSync(path.join(outDir, name.replace(/\.[^.]+$/, '') + '.rand.jpg'), Buffer.from(r.randB64, 'base64'));
      if (r.stripB64) fs.writeFileSync(path.join(outDir, name.replace(/\.[^.]+$/, '') + '.strip.jpg'), Buffer.from(r.stripB64, 'base64'));
      const row = { name, type, isPhoto: r.isPhoto, reason: r.reason, randErr: r.randErr, randSize: r.randSize, randCam: r.randCam, stripErr: r.stripErr, stripSize: r.stripSize };
      rows.push(row);
      console.log(JSON.stringify(row));
    }

    const foreign = [...new Set(rec.requests.filter(u => !(u.startsWith(`${server.origin}/`) || u.startsWith('blob:') || u.startsWith('data:'))))];
    const failures = rows.filter(r => r.randErr || r.stripErr);
    console.log(JSON.stringify({ summary: true, files: rows.length, pipelineFailures: failures.length,
      exceptions: rec.exceptions.length, consoleErrors: rec.consoleErrors.length, foreignRequests: foreign }));
  } finally {
    await chrome.close();
    await server.close();
  }
}
main().catch(e => { console.error('stress failed:', e.stack || e); process.exit(1); });
