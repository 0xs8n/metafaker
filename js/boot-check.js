/*
 * boot-check.js — a classic (non-module) script that runs even when the app's
 * ES modules cannot.
 *
 * The app is built from ES modules (js/main.js is type="module"). Browsers
 * block module loading over file://, so double-clicking index.html leaves the
 * static shell on screen with every button dead — which looks like "the site
 * doesn't work". This script loads fine on file:// (classic scripts are not
 * blocked there) and, if the controller has not come up shortly after load,
 * explains why and points at the fixes: the single-file build, or a local
 * server. On the served app and in the single-file build the controller loads
 * normally, so nothing is shown.
 */
(function () {
  function overlay(html) {
    var d = document.createElement('div');
    d.setAttribute('role', 'alert');
    d.style.cssText =
      'position:fixed;inset:0;z-index:99999;display:flex;align-items:center;' +
      'justify-content:center;padding:24px;background:#0f172a;color:#e2e8f0;' +
      "font-family:-apple-system,Segoe UI,system-ui,sans-serif;line-height:1.6";
    d.innerHTML =
      '<div style="max-width:560px">' +
      '<div style="font-size:20px;font-weight:700;margin-bottom:12px">MetaFaker could not start</div>' +
      '<div style="font-size:15px;color:#cbd5e1">' + html + '</div></div>';
    (document.body || document.documentElement).appendChild(d);
  }

  function check() {
    if (window.App) return;                 // controller came up: served app or single-file build
    if (location.protocol === 'file:') {
      overlay(
        'Browsers block this modular version when it is opened directly from a ' +
        'folder, so the buttons do nothing. Two ways to run it:' +
        '<ul style="margin:12px 0 0;padding-left:20px">' +
        '<li style="margin-bottom:8px">Open the single-file build <b>dist/metafaker.html</b> ' +
        '(or <b>metafaker.html</b>) instead &mdash; it runs offline by double-clicking.</li>' +
        '<li>Or serve this folder and open the address it prints, e.g. ' +
        '<code style="background:#1e293b;padding:2px 6px;border-radius:4px">python -m http.server</code> ' +
        'then <code style="background:#1e293b;padding:2px 6px;border-radius:4px">http://localhost:8000</code>.</li></ul>'
      );
    } else {
      overlay(
        'The app failed to load. Open the browser console to see the error, and ' +
        'make sure every file under <code>js/</code> and <code>vendor/</code> is present.'
      );
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { setTimeout(check, 2500); });
  } else {
    setTimeout(check, 2500);
  }
})();
