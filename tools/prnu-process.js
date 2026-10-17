#!/usr/bin/env node
/**
 * prnu-process.js — run a folder of images through the SHIPPED strip pipeline.
 *
 * The strip path is the full pixel pipeline (crop, rotation, non-rigid warp,
 * denoise, colour, ISP, lens, noise, re-encode) with no metadata added, so it
 * is exactly what tools/prnu.py needs to measure the pipeline's effect on a
 * camera sensor fingerprint. Reads JPEGs from <inDir>, writes the processed
 * JPEGs to <outDir> under the same names.
 *
 *   node tools/prnu-process.js <inDir> <outDir>
 *
 * Zero npm dependencies; Node 22+.
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const cdp = require('./lib/cdp.js');

const ROOT = path.resolve(__dirname, '..');

async function main() {
  const inDir = path.resolve(process.argv[2]);
  const outDir = path.resolve(process.argv[3]);
  fs.mkdirSync(outDir, { recursive: true });
  const names = fs.readdirSync(inDir).filter(f => /\.jpe?g$/i.test(f)).sort();
  if (!names.length) throw new Error(`no JPEGs in ${inDir}`);

  const server = await cdp.startStaticServer(ROOT);
  const chrome = await cdp.launchChrome();
  try {
    const page = chrome.page;
    await cdp.instrumentPage(page);
    await page.navigate(`${server.origin}/index.html`, { timeoutMs: 30000 });
    await cdp.waitForApp(page);

    for (const name of names) {
      const b64in = fs.readFileSync(path.join(inDir, name)).toString('base64');
      const b64out = await page.evaluate(async (b64, name) => {
        const bin = atob(b64);
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        const file = new File([bytes], name, { type: 'image/jpeg' });
        App.reset();
        await App.loadFiles([file]);
        App.select(S.items[S.items.length - 1].id);
        await App.clear();                       // strip = full pixel pipeline, no metadata
        const it = S.items[S.items.length - 1];
        if (it.error || !it.modBlob) throw new Error('process failed: ' + (it.error || 'no blob'));
        return await new Promise((res, rej) => {
          const fr = new FileReader();
          fr.onload = () => res(String(fr.result).split(',')[1]);
          fr.onerror = () => rej(fr.error);
          fr.readAsDataURL(it.modBlob);
        });
      }, b64in, name);
      fs.writeFileSync(path.join(outDir, name), Buffer.from(b64out, 'base64'));
      process.stdout.write('.');
    }
    process.stdout.write('\n');
  } finally {
    await chrome.close();
    await server.close();
  }
}

main().catch(e => { console.error('prnu-process failed:', e.stack || e); process.exit(1); });
