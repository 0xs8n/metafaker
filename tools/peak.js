#!/usr/bin/env node
/**
 * peak.js — peak renderer memory and time for one image through the app.
 *
 * Opens the page in a fresh headless Chrome, hands the file to the page's own
 * file input (DOM.setFileInputFiles, so the page holds a disk-backed File as
 * it does for a user), runs Randomize or Strip once, and prints one JSON line:
 * load and render times, the output's size and dimensions, and the renderer
 * process's peak working set after loading and after the render. The peaks
 * are read from the OS (Get-Process), so this runs on Windows only.
 *
 *   node tools/peak.js <image> [randomize|strip] [out.jpg]
 *
 * Zero npm dependencies; Node 22+.
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const cdp = require('./lib/cdp.js');

const ROOT = path.resolve(__dirname, '..');
const MiB = b => Math.round(b / 1048576);

function rendererPeak(userDataDir) {
  const ps = `Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" | Where-Object { $_.CommandLine -like '*${path.basename(userDataDir)}*' -and $_.CommandLine -like '*--type=renderer*' } | ForEach-Object { (Get-Process -Id $_.ProcessId).PeakWorkingSet64 }`;
  const out = execFileSync('powershell', ['-NoProfile', '-Command', ps], { encoding: 'utf8' });
  return Math.max(0, ...out.trim().split(/\r?\n/).filter(Boolean).map(Number));
}

async function main() {
  if (process.platform !== 'win32') throw new Error('peak.js reads process memory through PowerShell and runs on Windows only');
  const file = path.resolve(process.argv[2] || '');
  const mode = process.argv[3] || 'randomize';
  const outPath = process.argv[4];
  if (!fs.existsSync(file)) throw new Error('usage: node tools/peak.js <image> [randomize|strip] [out.jpg]');

  const server = await cdp.startStaticServer(ROOT);
  const chrome = await cdp.launchChrome();
  try {
    const page = chrome.page;
    await cdp.instrumentPage(page);
    await page.send('DOM.enable');
    await page.navigate(`${server.origin}/index.html`, { timeoutMs: 30000 });
    await cdp.waitForApp(page);
    const { root } = await page.send('DOM.getDocument');
    const { nodeId } = await page.send('DOM.querySelector', { nodeId: root.nodeId, selector: '#fileInput' });

    const tl = Date.now();
    await page.send('DOM.setFileInputFiles', { nodeId, files: [file] });
    await page.evaluate(async () => {
      for (let i = 0; i < 1200; i++) {
        const it = S.items[S.items.length - 1];
        if (it && !it.processing) return;
        await new Promise(r => setTimeout(r, 50));
      }
      throw new Error('load timed out');
    });
    const loadMs = Date.now() - tl;
    const afterLoad = rendererPeak(chrome.userDataDir);

    const r = await page.evaluate(async mode => {
      const t = performance.now();
      await (mode === 'strip' ? App.clear() : App.randomize());
      const it = S.items[S.items.length - 1];
      return { renderMs: Math.round(performance.now() - t), error: it.error || null, outBytes: it.modBlob ? it.modBlob.size : 0 };
    }, mode);
    const after = rendererPeak(chrome.userDataDir);

    if (!r.error) {
      r.dims = await page.evaluate(async () => {
        const b = new Uint8Array(await S.items[S.items.length - 1].modBlob.arrayBuffer());
        for (let i = 2; i + 9 < b.length;) {
          const m = b[i + 1], len = (b[i + 2] << 8) | b[i + 3];
          if (m >= 0xC0 && m <= 0xC3) return `${(b[i + 7] << 8) | b[i + 8]}x${(b[i + 5] << 8) | b[i + 6]}`;
          i += 2 + len;
        }
        return null;
      });
      if (outPath) {
        const b64 = await page.evaluate(() => new Promise((res, rej) => {
          const fr = new FileReader();
          fr.onload = () => res(String(fr.result).split(',')[1]);
          fr.onerror = () => rej(fr.error);
          fr.readAsDataURL(S.items[S.items.length - 1].modBlob);
        }));
        fs.writeFileSync(outPath, Buffer.from(b64, 'base64'));
      }
    }
    console.log(JSON.stringify({ file: path.basename(file), mode, loadMs, ...r,
      peakAfterLoadMiB: MiB(afterLoad), peakMiB: MiB(after) }));
  } finally {
    await chrome.close();
    await server.close();
  }
}

main().catch(e => { console.error('peak failed:', e.stack || e); process.exit(1); });
