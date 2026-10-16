# Forensic measurement tools

Pixel-domain checks for comparing MetaFaker's output against real camera files.
Metadata is only half the problem; these cover the other half.

Requires `numpy`, `scipy`, `pillow`. Run them against your own JPEGs — no sample
images are committed here, because the useful ones are other people's
photographs.

## `forensics.py`

    python tools/forensics.py a.jpg b.jpg ...

Three measures, chosen to be content-robust enough to compare across different
pictures:

- **resample** — resizing or rotating makes each pixel a fixed linear
  combination of its neighbours, leaving a periodic pattern in the prediction
  residual. High means "resampled".
- **blockiness** — pixel differences across 8x8 block boundaries versus inside
  them. Rises with each compression and with lower quality.
- **ghost** — recompress across a sweep of qualities; an image already
  compressed at some quality dips there. High means "compressed more than once".

## `cfa.py`

    python tools/cfa.py a.jpg b.jpg ...

Demosaicing trace. A sensor measures one colour per photosite and interpolates
the rest, so an unresampled camera JPEG shows a 2x2 pattern in its prediction
residual. Resizing destroys it. Around 1.0 means no trace survives.

Note this reads as a *pass* for our output rather than a failure: the file
presents as an editor export, and real exports are resized too, so they have no
CFA trace either.

## `pipeline_sim.py`

    python tools/pipeline_sim.py photo.jpg

An offline port of the pixel stages in `js/helpers.js` — crop, rotate, resize,
colour profile, ISP, lens, noise. It exists because injecting a photo into the
browser means re-encoding it first, which contaminates the compression history
the measurements are trying to read. This way a full-resolution original can go
through the same stages untouched.

It is a port, not the shipped code: the resampling kernel and RNG differ, so
treat its output as indicative rather than exact.

## Reference measurements

Taken 2026-09-25 against unmodified originals from Wikimedia Commons.

| file | resample | blockiness | ghost | CFA |
|---|---|---|---|---|
| Pixel 7a original | 69.8 | 1.002 | 0.089 | 1.280 |
| Pixel 8 Pro original | 20.5 | 1.000 | 0.012 | — |
| Galaxy S23 Ultra original | 22.9 | 1.002 | 0.014 | 1.003 |
| Sony A7 IV original | 57.9 | 1.013 | 0.005 | 1.194 |
| real Camera Raw export | 43.2 | 1.004 | 0.014 | 1.020 |
| **our output, real photo in** | **68.4** | **0.997** | **0.032** | **1.002** |

Every measure falls inside the range real files occupy.

Two cautions. Synthetic test fixtures give misleading numbers here — flat
gradients drove blockiness to 1.395 and ghost to 0.295, neither of which
reflects the pipeline. And three detectors are not a forensic suite: PRNU, ELA
and the ML detectors (TruFor, Noiseprint++, CAT-Net) are untested.

## Browser harness and offline build

Two Node scripts (Node 22+, no npm packages) that drive the real app in
headless Chrome over the DevTools protocol. Chrome is found automatically in
its usual install locations, or set `CHROME=/path/to/chrome`. The launch and
protocol plumbing is shared in `tools/lib/cdp.js`.

### `check.js`

    node tools/check.js

Serves the repo on `127.0.0.1`, loads every `testimg/*.jpg`, randomizes the
batch, strips one extra copy of the first image, and writes the outputs to
`tools/out/` (git-ignored). Then it asserts:

- **privacy** — every network request the page made went to `127.0.0.1`,
  `blob:` or `data:`; no uncaught exceptions, `console.error` calls or
  error-level log entries (CSP violations, failed loads).
- **bytes** (own JPEG segment walker) — one SOI before SOS, no APP0, one DQT
  carrying two tables, APP14 Adobe, baseline SOF0 with three 1x1 components
  (4:4:4), DHT and SOS. Randomized files must carry APP1 Exif, APP1 XMP whose
  packet begins with the UTF-8 BOM, and APP2 ICC_PROFILE; stripped files must
  carry no APP1/APP2 at all. Nowhere in the file: `Google Inc`, `Skia`,
  `JFIF`, `Chrome`, `Mozilla`, or UTF-16BE `Google` / `Skia`.
- **exiftool** (when found on PATH or at the known Windows install path;
  otherwise SKIPPED) — `-validate` reports OK with no warnings; Make/Model
  present; Software is Adobe Camera Raw; ModifyDate >= DateTimeOriginal; the
  XMP CreateDate matches DateTimeOriginal; GPS inside the US envelope; the
  exposure triangle agrees with the APEX tags within 0.75 EV; no thumbnail,
  JFIF or Google ICC tags; ExifImageWidth/Height equal the SOF0 frame; and the
  sun is not below -6° at the GPS position and time when the exposure claims
  bright daylight (EV > 11). Stripped files must carry no metadata groups.

Exit code is 1 on any failure; each failure names the file, the assertion and
the actual value.

### `build.js`

    node tools/build.js             # build and verify
    node tools/build.js --no-verify

Writes `dist/metafaker.html`, a single file that works opened from disk via
`file://`. Chrome will not run ES modules from `file://`, so the `js/` modules
are rewritten into classic-script IIFEs registered in a `__modules` map and
emitted in dependency order; `css/style.css`, `vendor/piexif.js` and
`vendor/exifr.umd.js` are inlined. The CSP is kept with `'unsafe-inline'` on
script and style (everything is inline) and `connect-src 'none'`. The result is
then opened in headless Chrome via `file://` and checked: `window.App` exists,
one test image randomizes to a `modBlob`, and no request left the machine.
