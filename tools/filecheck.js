#!/usr/bin/env node
// Load index.html via file:// (the failing scenario) and report whether the
// boot-check guard shows its message instead of leaving a dead page.
'use strict';
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const cdp = require('./lib/cdp.js');

async function main() {
  const url = pathToFileURL(path.resolve(__dirname, '..', 'index.html')).href;
  const chrome = await cdp.launchChrome();
  try {
    const page = chrome.page;
    await cdp.instrumentPage(page);
    await page.navigate(url, { timeoutMs: 20000 });
    await cdp.sleep(3200);                    // let the 2.5s guard fire
    const r = await page.evaluate(() => ({
      app: typeof window.App,
      alert: !!document.querySelector('[role="alert"]'),
      alertText: (document.querySelector('[role="alert"]')?.textContent || '').slice(0, 120),
    }));
    console.log('file:// index.html  ->  window.App =', r.app, '| guard shown =', r.alert);
    if (r.alert) console.log('   guard text:', r.alertText.replace(/\s+/g, ' ').trim());
    console.log(r.alert ? 'PASS: dead page replaced with guidance' : 'FAIL: no guidance shown');
  } finally {
    await chrome.close();
  }
}
main().catch(e => { console.error(e.stack || e); process.exit(1); });
