#!/usr/bin/env node
/**
 * build.js — produce dist/metafaker.html, one self-contained file that works
 * when opened straight from disk (file://).
 *
 * Chrome refuses to load ES modules from file://, so the js/ modules are
 * rewritten as classic scripts: each becomes an IIFE registered in a
 * `__modules` map, imports become destructuring reads from that map, and the
 * modules are emitted in dependency order. css/style.css, vendor/piexif.js
 * and vendor/exifr.umd.js are inlined. The CSP is kept but loosened to allow
 * the now-inline script and style.
 *
 *   node tools/build.js             # build + verify in headless Chrome
 *   node tools/build.js --no-verify # build only
 *
 * Zero npm dependencies; Node 22+.
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const ROOT = path.resolve(__dirname, '..');
const JS_DIR = path.join(ROOT, 'js');
const DIST = path.join(ROOT, 'dist');
const OUT_FILE = path.join(DIST, 'metafaker.html');
const ENTRY = 'main';

// ── Module transform ─────────────────────────────────────────────

const IDENT = '[A-Za-z_$][\\w$]*';

/** './x.js' relative to the importing module id -> module id ('x'). */
function resolveId(fromId, spec) {
  const fromDir = path.posix.dirname(fromId);
  const joined = path.posix.normalize(path.posix.join(fromDir, spec));
  return joined.replace(/\.js$/, '');
}

function parseBindings(clause) {
  // "{ a, b as c }" -> [{imported:'a', local:'a'}, {imported:'b', local:'c'}]
  return clause.split(',').map(s => s.trim()).filter(Boolean).map(s => {
    const m = s.match(new RegExp(`^(${IDENT}|default)\\s+as\\s+(${IDENT})$`)) ;
    if (m) return { imported: m[1], local: m[2] };
    if (!new RegExp(`^${IDENT}$`).test(s)) throw new Error(`cannot parse import/export specifier "${s}"`);
    return { imported: s, local: s };
  });
}

/** Map a vendor/URL import onto the global its UMD build exposes. */
function externalFor(spec) {
  if (/exifr/i.test(spec)) return '(window.exifr && window.exifr.default) || window.exifr';
  if (/piexif/i.test(spec)) return 'window.piexif';
  return null;
}

/**
 * Rewrite one ES module into the body of an IIFE.
 * Returns { code, deps, exports } where `code` ends with a `return {...}`.
 */
function transformModule(id, src) {
  const deps = [];
  const exports = [];           // [exportedName, localExpression]
  let code = src;

  // Side-effect imports: import './x.js';
  code = code.replace(/^[ \t]*import\s*(['"])([^'"]+)\1\s*;?[ \t]*$/gm, (_, q, spec) => {
    const ext = externalFor(spec);
    if (ext) return `void ${ext};`;
    const dep = resolveId(id, spec);
    deps.push(dep);
    return `void __modules[${JSON.stringify(dep)}];`;
  });

  // Named / default / namespace imports.
  const importRe = /^[ \t]*import\s+([^'";]*?)\s+from\s*(['"])([^'"]+)\2\s*;?[ \t]*$/gm;
  code = code.replace(importRe, (_, clause, q, spec) => {
    clause = clause.trim();
    const ext = externalFor(spec);
    const source = ext ? `(${ext})` : `__modules[${JSON.stringify(resolveId(id, spec))}]`;
    if (!ext) deps.push(resolveId(id, spec));
    if (!ext && (/^\.\.?\//.test(spec) === false)) throw new Error(`${id}: non-relative import "${spec}" cannot be bundled`);

    const lines = [];
    let rest = clause;
    const ns = rest.match(new RegExp(`\\*\\s+as\\s+(${IDENT})`));
    if (ns) { lines.push(`const ${ns[1]} = ${source};`); rest = rest.replace(ns[0], '').replace(/^\s*,|,\s*$/g, '').trim(); }
    const braces = rest.match(/\{([^}]*)\}/);
    if (braces) {
      const parts = parseBindings(braces[1]).map(b => b.imported === b.local ? b.local : `${b.imported}: ${b.local}`);
      if (parts.length) lines.push(`const { ${parts.join(', ')} } = ${source};`);
      rest = rest.replace(braces[0], '').replace(/^\s*,|,\s*$/g, '').trim();
    }
    if (rest) {
      if (!new RegExp(`^${IDENT}$`).test(rest)) throw new Error(`${id}: cannot parse import clause "${clause}"`);
      lines.push(ext ? `const ${rest} = ${source};` : `const ${rest} = ${source}.default;`);
    }
    return lines.join(' ');
  });

  // export function/const/let/var/class NAME
  const declRe = new RegExp(`^([ \\t]*)export\\s+(async\\s+function\\*?|function\\*?|class|const|let|var)\\s+(${IDENT})`, 'gm');
  code = code.replace(declRe, (_, indent, kind, name) => {
    exports.push([name, name]);
    return `${indent}${kind} ${name}`;
  });

  // export default EXPR
  code = code.replace(/^([ \t]*)export\s+default\s+/gm, (_, indent) => {
    exports.push(['default', '__default']);
    return `${indent}const __default = `;
  });

  // export { a, b as c } [from './x.js']
  const listRe = /^[ \t]*export\s*\{([^}]*)\}\s*(?:from\s*(['"])([^'"]+)\2)?\s*;?[ \t]*$/gm;
  code = code.replace(listRe, (_, list, q, spec) => {
    const bindings = parseBindings(list.replace(/\s+as\s+/g, ' as '));
    if (spec) {
      const dep = resolveId(id, spec);
      deps.push(dep);
      for (const b of bindings) exports.push([b.local, `__modules[${JSON.stringify(dep)}][${JSON.stringify(b.imported)}]`]);
    } else {
      for (const b of bindings) exports.push([b.local, b.imported]);
    }
    return '';
  });

  if (/^[ \t]*export\s*\*/m.test(code)) throw new Error(`${id}: "export *" is not supported`);
  if (/\bimport\s*\(/.test(code)) throw new Error(`${id}: dynamic import() is not supported in the offline bundle`);
  if (/\bimport\.meta\b/.test(code)) throw new Error(`${id}: import.meta is not supported in the offline bundle`);
  const leftover = code.match(/^[ \t]*(import|export)\s/m);
  if (leftover) throw new Error(`${id}: unhandled ${leftover[1]} statement remained after transform`);

  const ret = exports.map(([name, expr]) => (name === expr ? name : `${JSON.stringify(name)}: ${expr}`)).join(', ');
  return { code: `${code}\n;return { ${ret} };`, deps: [...new Set(deps)], exports: exports.map(e => e[0]) };
}

function loadGraph(entryId) {
  const modules = new Map();
  const visit = id => {
    if (modules.has(id)) return;
    const file = path.join(JS_DIR, `${id}.js`);
    if (!fs.existsSync(file)) throw new Error(`module not found: js/${id}.js`);
    const src = fs.readFileSync(file, 'utf8');
    const mod = transformModule(id, src);
    modules.set(id, mod);
    for (const d of mod.deps) visit(d);
  };
  visit(entryId);
  return modules;
}

function topoOrder(modules, entryId) {
  const order = [], state = new Map();          // 1 = visiting, 2 = done
  const stack = [];
  const visit = id => {
    if (state.get(id) === 2) return;
    if (state.get(id) === 1) throw new Error(`circular import: ${[...stack, id].join(' -> ')}`);
    state.set(id, 1); stack.push(id);
    for (const d of modules.get(id).deps) visit(d);
    stack.pop(); state.set(id, 2);
    order.push(id);
  };
  visit(entryId);
  return order;
}

function bundle() {
  const modules = loadGraph(ENTRY);
  const order = topoOrder(modules, ENTRY);
  const parts = [`'use strict';\nconst __modules = Object.create(null);`];
  for (const id of order) {
    const m = modules.get(id);
    parts.push(`// ── js/${id}.js ${'─'.repeat(Math.max(4, 60 - id.length))}\n` +
      `__modules[${JSON.stringify(id)}] = (function () {\n${m.code}\n})();`);
  }
  return { code: parts.join('\n\n'), order, modules };
}

// ── HTML assembly ────────────────────────────────────────────────

const escapeScript = js => js.replace(/<\/script/gi, '<\\/script').replace(/<!--/g, '<\\!--');
const escapeStyle = css => css.replace(/<\/style/gi, '<\\/style');

const CSP = [
  "default-src 'none'",
  "script-src 'unsafe-inline'",
  "style-src 'unsafe-inline'",
  "img-src 'self' blob: data:",
  "font-src 'self' data:",
  "connect-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join('; ');

function assembleHtml(bundleCode) {
  let html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const notes = [];

  // CSP: keep the meta, swap the policy for the inline-everything one.
  // The content attribute spans lines and contains single quotes ('none').
  const cspRe = /<meta\s+http-equiv=["']Content-Security-Policy["']\s+content=(?:"[^"]*"|'[^']*')\s*\/?>/i;
  if (cspRe.test(html)) {
    html = html.replace(cspRe, `<meta http-equiv="Content-Security-Policy" content="${CSP}">`);
  } else {
    html = html.replace(/<head>/i, `<head>\n  <meta http-equiv="Content-Security-Policy" content="${CSP}">`);
    notes.push('index.html had no CSP meta; one was added');
  }

  // Stylesheets: inline the local one, drop any remote one.
  html = html.replace(/<link\b[^>]*\brel=["']stylesheet["'][^>]*>/gi, tag => {
    const href = (tag.match(/\bhref=["']([^"']+)["']/i) || [])[1] || '';
    if (/^https?:/i.test(href)) { notes.push(`dropped remote stylesheet ${href}`); return ''; }
    const file = path.join(ROOT, href);
    if (!fs.existsSync(file)) throw new Error(`stylesheet not found: ${href}`);
    return `<style>\n${escapeStyle(fs.readFileSync(file, 'utf8'))}\n</style>`;
  });

  // Scripts.
  let sawEntry = false, sawPiexif = false;
  html = html.replace(/<script\b[^>]*\bsrc=["']([^"']+)["'][^>]*>\s*<\/script>/gi, (tag, src) => {
    const isModule = /\btype=["']module["']/i.test(tag);
    if (/piexif/i.test(src)) {
      sawPiexif = true;
      return `<script>\n${escapeScript(fs.readFileSync(path.join(ROOT, 'vendor', 'piexif.js'), 'utf8'))}\n</script>`;
    }
    if (isModule && /js\/main\.js$/.test(src)) {
      sawEntry = true;
      const exifr = fs.readFileSync(path.join(ROOT, 'vendor', 'exifr.umd.js'), 'utf8');
      return `<script>\n${escapeScript(exifr)}\n</script>\n<script>\n${escapeScript(bundleCode)}\n</script>`;
    }
    if (/^https?:/i.test(src)) { notes.push(`dropped remote script ${src}`); return ''; }
    const file = path.join(ROOT, src);
    if (!fs.existsSync(file)) throw new Error(`script not found: ${src}`);
    notes.push(`inlined ${src}`);
    return `<script>\n${escapeScript(fs.readFileSync(file, 'utf8'))}\n</script>`;
  });
  if (!sawEntry) throw new Error('index.html has no <script type="module" src="js/main.js"> to replace');
  if (!sawPiexif) notes.push('index.html had no piexif <script>; the bundle expects window.piexif');

  // Anything still pointing off-host in the markup (scripts/styles excluded:
  // the map link template inside ui.js is a user-clicked anchor, not a load).
  const markupOnly = html.replace(/<script\b[\s\S]*?<\/script>/gi, '').replace(/<style\b[\s\S]*?<\/style>/gi, '');
  const remote = (markupOnly.match(/<(?:link|script|img|iframe|source)\b[^>]*\b(?:src|href)=["']https?:\/\/[^"']+["'][^>]*>/gi) || []);
  if (remote.length) notes.push(`remote loads remain in markup: ${remote.join(' ')}`);

  return { html, notes };
}

// ── Verification in headless Chrome ──────────────────────────────

async function verify(outFile) {
  const cdp = require('./lib/cdp.js');
  const failures = [];
  const check = (ok, what, detail = '') => {
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${what}${ok || !detail ? '' : ' — ' + detail}`);
    if (!ok) failures.push(what);
  };
  const chrome = await cdp.launchChrome();
  try {
    const page = chrome.page;
    const rec = await cdp.instrumentPage(page);
    const url = pathToFileURL(outFile).href;
    await page.navigate(url, { timeoutMs: 30000 });
    const appType = await cdp.waitForApp(page);
    check(appType === 'object' || appType === 'function', 'window.App defined', `typeof window.App = ${appType}`);
    check(await page.evaluate('typeof window.piexif'), 'window.piexif defined');
    check(await page.evaluate('typeof window.exifr'), 'window.exifr defined');

    const sample = fs.readdirSync(path.join(ROOT, 'testimg')).filter(f => /\.jpe?g$/i.test(f)).sort()[0];
    let result = null;
    try {
      const b64 = fs.readFileSync(path.join(ROOT, 'testimg', sample)).toString('base64');
      result = await page.evaluate(async (b64, name) => {
        const bin = atob(b64);
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        const file = new File([bytes], name, { type: 'image/jpeg' });
        await App.loadFiles([file]);
        await App.randomize();
        const it = S.items[0];
        return { error: it.error, size: it.modBlob ? it.modBlob.size : 0, hasExif: !!it.fakeExif,
                 camera: it.fakeCamera ? `${it.fakeCamera.make} ${it.fakeCamera.model}` : '' };
      }, b64, sample);
    } catch (e) {
      check(false, 'processing one image did not throw', e.message);
    }
    if (result) {
      check(!result.error, `processing ${sample} reported no error`, result.error);
      check(result.size > 0, 'modBlob produced', `size=${result.size}`);
      check(result.hasExif, 'generated EXIF present', '');
      console.log(`  info  ${sample} -> ${result.size} bytes as ${result.camera}`);
    }

    const allowed = u => u.startsWith('file://') || u.startsWith('blob:') || u.startsWith('data:');
    const foreign = [...new Set(rec.requests.filter(u => !allowed(u)))];
    check(foreign.length === 0, `all ${rec.requests.length} network requests are file:/blob:/data:`, foreign.join(', '));
    check(rec.exceptions.length === 0, 'no uncaught exceptions', rec.exceptions.join(' | '));
    check(rec.consoleErrors.length === 0, 'no console.error calls', rec.consoleErrors.join(' | '));
    check(rec.logErrors.length === 0, 'no error-level log entries (CSP, failed loads)', rec.logErrors.join(' | '));
  } finally {
    await chrome.close();
  }
  return failures;
}

// ── Main ─────────────────────────────────────────────────────────

async function main() {
  const noVerify = process.argv.includes('--no-verify');
  const { code, order } = bundle();
  const { html, notes } = assembleHtml(code);
  fs.mkdirSync(DIST, { recursive: true });
  fs.writeFileSync(OUT_FILE, html);
  const size = fs.statSync(OUT_FILE).size;
  console.log(`bundled modules (dependency order): ${order.join(' -> ')}`);
  for (const n of notes) console.log(`note: ${n}`);
  console.log(`wrote ${OUT_FILE} (${size} bytes, ${(size / 1024).toFixed(1)} KB)`);

  if (noVerify) return;
  console.log('verifying via file:// in headless Chrome');
  const failures = await verify(OUT_FILE);
  if (failures.length) {
    console.log(`FAIL: ${failures.length} verification check(s) failed`);
    process.exitCode = 1;
  } else {
    console.log('PASS: offline bundle verified');
  }
}

main().catch(e => {
  console.error('build.js failed:', e.stack || e);
  process.exit(2);
});
