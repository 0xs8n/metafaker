/**
 * cdp.js — minimal headless-Chrome driver over the DevTools protocol.
 *
 * Zero dependencies: Node's built-in http, net, child_process and the global
 * WebSocket (Node 22+). Shared by tools/check.js and tools/build.js.
 */

'use strict';

const http = require('node:http');
const net = require('node:net');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

// ── Ports / files ────────────────────────────────────────────────

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/plain; charset=utf-8',
};

/**
 * Serve `root` on 127.0.0.1 at a random free port.
 * Resolves to { port, origin, close() }.
 */
function startStaticServer(root) {
  const absRoot = path.resolve(root);
  const server = http.createServer((req, res) => {
    try {
      const url = new URL(req.url, 'http://127.0.0.1');
      let rel = decodeURIComponent(url.pathname);
      if (rel.endsWith('/')) rel += 'index.html';
      const file = path.resolve(absRoot, '.' + rel);
      if (!file.startsWith(absRoot)) { res.writeHead(403); res.end('forbidden'); return; }
      fs.stat(file, (err, st) => {
        if (err || !st.isFile()) { res.writeHead(404); res.end('not found'); return; }
        const type = MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
        res.writeHead(200, {
          'Content-Type': type,
          'Content-Length': st.size,
          'Cache-Control': 'no-store',
        });
        if (req.method === 'HEAD') { res.end(); return; }
        fs.createReadStream(file).pipe(res);
      });
    } catch (e) {
      res.writeHead(500); res.end(String(e));
    }
  });
  return new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({
        port,
        origin: `http://127.0.0.1:${port}`,
        close: () => new Promise(r => server.close(() => r())),
      });
    });
  });
}

// ── Chrome ───────────────────────────────────────────────────────

const CHROME_CANDIDATES = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
];

function findChrome() {
  if (process.env.CHROME) {
    if (fs.existsSync(process.env.CHROME)) return process.env.CHROME;
    throw new Error(`CHROME env var points at a missing file: ${process.env.CHROME}`);
  }
  for (const c of CHROME_CANDIDATES) if (fs.existsSync(c)) return c;
  throw new Error('Chrome not found. Set the CHROME env var to the browser executable.');
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function fetchJson(url, init) {
  const res = await fetch(url, init);
  if (!res.ok) throw new Error(`${init?.method || 'GET'} ${url} -> HTTP ${res.status}`);
  return res.json();
}

/**
 * Launch headless Chrome and open one page target.
 * Resolves to { chrome, page, close() } where `page` is a CdpSession.
 */
async function launchChrome(opts = {}) {
  const exe = findChrome();
  const port = await freePort();
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'metafaker-chrome-'));
  const args = [
    '--headless=new',
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${userDataDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-gpu',
    '--disable-extensions',
    '--disable-background-networking',
    '--disable-component-update',
    '--disable-sync',
    '--window-size=1280,900',
    ...(opts.extraArgs || []),
    'about:blank',
  ];
  const proc = spawn(exe, args, { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
  let stderr = '';
  proc.stderr.on('data', d => { stderr += d; if (stderr.length > 20000) stderr = stderr.slice(-20000); });
  let exited = false;
  proc.on('exit', () => { exited = true; });

  // Wait for the DevTools endpoint.
  const deadline = Date.now() + (opts.launchTimeoutMs || 30000);
  let version = null;
  while (Date.now() < deadline) {
    if (exited) break;
    try { version = await fetchJson(`http://127.0.0.1:${port}/json/version`); break; }
    catch { await sleep(150); }
  }
  if (!version) {
    try { proc.kill(); } catch {}
    throw new Error(`Chrome did not expose DevTools on port ${port}.\n${stderr.slice(-2000)}`);
  }

  const target = await fetchJson(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' });
  const page = await CdpSession.connect(target.webSocketDebuggerUrl);

  const close = async () => {
    try { await Promise.race([page.send('Browser.close'), sleep(3000)]); } catch {}
    try { page.ws.close(); } catch {}
    const gone = Date.now() + 5000;
    while (!exited && Date.now() < gone) await sleep(100);
    if (!exited) { try { proc.kill(); } catch {} }
    await sleep(200);
    for (let i = 0; i < 10; i++) {
      try { fs.rmSync(userDataDir, { recursive: true, force: true }); break; }
      catch { await sleep(300); }
    }
  };

  return { exe, port, userDataDir, version, proc, page, close };
}

// ── CDP session ──────────────────────────────────────────────────

class CdpSession {
  constructor(ws) {
    this.ws = ws;
    this.nextId = 1;
    this.pending = new Map();
    this.listeners = new Map();
    ws.addEventListener('message', ev => this._onMessage(String(ev.data)));
    ws.addEventListener('close', () => {
      for (const [, p] of this.pending) p.reject(new Error('CDP socket closed'));
      this.pending.clear();
    });
  }

  static connect(url) {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      ws.addEventListener('open', () => resolve(new CdpSession(ws)), { once: true });
      ws.addEventListener('error', e => reject(new Error(`WebSocket error connecting to ${url}: ${e.message || e}`)), { once: true });
    });
  }

  _onMessage(text) {
    let msg;
    try { msg = JSON.parse(text); } catch { return; }
    if (msg.id !== undefined) {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      if (msg.error) p.reject(new Error(`${p.method}: ${msg.error.message}${msg.error.data ? ' — ' + msg.error.data : ''}`));
      else p.resolve(msg.result);
    } else if (msg.method) {
      for (const fn of this.listeners.get(msg.method) || []) {
        try { fn(msg.params); } catch (e) { console.error('listener error', e); }
      }
      for (const fn of this.listeners.get('*') || []) {
        try { fn(msg.method, msg.params); } catch {}
      }
    }
  }

  send(method, params = {}) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, method });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  on(method, fn) {
    if (!this.listeners.has(method)) this.listeners.set(method, []);
    this.listeners.get(method).push(fn);
    return () => {
      const arr = this.listeners.get(method) || [];
      const i = arr.indexOf(fn);
      if (i >= 0) arr.splice(i, 1);
    };
  }

  /** Resolve once `method` fires (optionally filtered), or reject on timeout. */
  waitFor(method, { timeoutMs = 30000, filter = () => true } = {}) {
    return new Promise((resolve, reject) => {
      const off = this.on(method, params => {
        if (!filter(params)) return;
        clearTimeout(t); off(); resolve(params);
      });
      const t = setTimeout(() => { off(); reject(new Error(`timeout waiting for ${method}`)); }, timeoutMs);
    });
  }

  /**
   * Evaluate an expression (or call a function with JSON args) in the page.
   * Awaits promises, returns the value by JSON, throws on page exceptions.
   */
  async evaluate(fnOrExpr, ...args) {
    const expression = typeof fnOrExpr === 'function'
      ? `(${fnOrExpr.toString()})(${args.map(a => JSON.stringify(a)).join(', ')})`
      : String(fnOrExpr);
    const res = await this.send('Runtime.evaluate', {
      expression, awaitPromise: true, returnByValue: true, userGesture: true,
    });
    if (res.exceptionDetails) {
      const d = res.exceptionDetails;
      const desc = d.exception?.description || d.exception?.value || d.text;
      throw new Error(`page exception: ${desc}`);
    }
    return res.result?.value;
  }

  /** Navigate and wait for the load event. */
  async navigate(url, { timeoutMs = 30000 } = {}) {
    const loaded = this.waitFor('Page.loadEventFired', { timeoutMs });
    const nav = await this.send('Page.navigate', { url });
    if (nav.errorText) throw new Error(`navigation to ${url} failed: ${nav.errorText}`);
    await loaded;
  }
}

/**
 * Attach the standard observers: every network request URL, console errors,
 * uncaught exceptions and error-level log entries (CSP violations, failed loads).
 */
async function instrumentPage(page) {
  const record = { requests: [], consoleErrors: [], exceptions: [], logErrors: [] };
  await page.send('Network.enable');
  await page.send('Page.enable');
  await page.send('Runtime.enable');
  await page.send('Log.enable');
  page.on('Network.requestWillBeSent', p => record.requests.push(p.request.url));
  page.on('Runtime.consoleAPICalled', p => {
    if (p.type === 'error' || p.type === 'assert') {
      record.consoleErrors.push(p.args.map(a => a.value ?? a.description ?? a.type).join(' '));
    }
  });
  page.on('Runtime.exceptionThrown', p => {
    const d = p.exceptionDetails;
    record.exceptions.push(d.exception?.description || d.exception?.value || d.text);
  });
  page.on('Log.entryAdded', p => {
    if (p.entry.level === 'error') record.logErrors.push(`${p.entry.source}: ${p.entry.text}${p.entry.url ? ' (' + p.entry.url + ')' : ''}`);
  });
  return record;
}

/** Wait until `window.App` exists (module scripts run before load, but be safe). */
async function waitForApp(page, timeoutMs = 10000) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const t = await page.evaluate('typeof window.App');
    if (t === 'object' || t === 'function') return t;
    await sleep(100);
  }
  return await page.evaluate('typeof window.App');
}

module.exports = {
  freePort, startStaticServer, findChrome, launchChrome, CdpSession,
  instrumentPage, waitForApp, sleep, MIME,
};
