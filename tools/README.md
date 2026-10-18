# Measurement tools

Pixel-domain checks for comparing MetaFaker's output against real camera files.
Metadata is only half of what can identify a photo; the pixels are the other
half. These check that the pixels carry no trace that would link an output back
to its original or set it apart from an ordinary photo.

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

It is a port, not the shipped code: the resampling kernel and RNG differ, and
it predates the non-rigid warp and denoise stages, so treat its output as
indicative rather than exact.

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
reflects the pipeline. And three measures are not a complete analysis: ELA and
the machine-learning models (TruFor, Noiseprint++, CAT-Net) are untested, and
PRNU is covered separately by `prnu.py` below.

## Browser harness and offline build

Two Node scripts (Node 22+, no npm packages) that drive the real app in
headless Chrome over the DevTools protocol. Chrome is found automatically in
its usual install locations, or set `CHROME=/path/to/chrome`. The launch and
protocol plumbing is shared in `tools/lib/cdp.js`.

### `check.js`

    node tools/check.js

Serves the repo on `127.0.0.1`, loads every `testimg/*.jpg` (synthetic
images carrying sensor-like noise), puts the first three through Randomize
Entire Batch and the rest through Randomize one by one, and strips one extra
copy of the first image. It then randomizes a set of non-photo cases (a PNG
screenshot, the same screenshot as JPEG, a PNG renamed `.jpg`, an SVG, a
transparent WebP, and the tool's own screenshot output loaded again) and an
extensionless JPEG with no MIME type. Outputs go to `tools/out/`
(git-ignored). Then it asserts:

- **privacy** — every network request the page made went to `127.0.0.1`,
  `blob:` or `data:`; no uncaught exceptions, `console.error` calls or
  error-level log entries (CSP violations, failed loads).
- **bytes** (own JPEG segment walker) — no APP0, one DQT carrying two tables,
  APP14 Adobe, baseline SOF0 with three 1x1 components (4:4:4), DHT and SOS.
  Randomized files carry three SOI markers before SOS (the image plus the IFD1
  and Photoshop thumbnails), APP1 Exif, APP1 XMP whose packet begins with the
  UTF-8 BOM, and APP2 ICC_PROFILE; stripped files carry one SOI and no
  APP1/APP2 at all. Nowhere in the file: `Google Inc`, `Skia`, `JFIF`,
  `Chrome`, `Mozilla`, or UTF-16BE `Google` / `Skia`.
- **batch independence** — every batch image is randomized, the batch does
  not share one camera and city, and each image has its own generated
  filename.
- **classification** — every non-photo case is classified as a non-photo and
  carries no camera Make or Model, no lens and no GPS (any `Software` it names
  is Adobe); no camera photo is taken for a screenshot; the extensionless JPEG
  is accepted and randomized as a photo.
- **filename** — the input's filename appears nowhere in any output's bytes.
- **exiftool** (when found on PATH or at the known Windows install path;
  otherwise SKIPPED) — `-validate` reports only the warnings a real Adobe
  export produces and no others; Make/Model present; Software is Adobe Camera
  Raw or Lightroom; ModifyDate >= DateTimeOriginal; the XMP CreateDate matches
  DateTimeOriginal; GPS latitude within 18-72° N and longitude within 65-180° W
  (the United States); the exposure triangle agrees with the APEX tags within
  0.75 EV; an IFD1 thumbnail present; no JFIF or Google ICC tags;
  ExifImageWidth/Height absent, as Adobe drops them; and the sun is not below
  -6° at the GPS position and time when the exposure indicates bright daylight
  (EV > 11). Stripped files must carry no metadata groups and validate clean.

Exit code is 1 on any failure; each failure names the file, the assertion and
the actual value.

### `stress.js`

    node tools/stress.js <inDir> <outDir>

Runs every image in `<inDir>` through **both** the randomize and strip paths of
the real app in headless Chrome, one file at a time, and prints one JSON line
per input plus a final summary line. Per file it reports the input type and
dimensions, the classifier verdict (photo vs. non-photo and why), and for each
path whether it errored, the output size and the mode. The summary counts
pipeline failures, uncaught exceptions, console errors and any request that left
the machine. Used to confirm the pipeline survives edge-case inputs — tiny and
boundary sizes, odd dimensions, panoramas, grayscale/CMYK/progressive JPEG,
WebP, RGBA PNG and screenshot-sized PNGs — without a single foreign request.

On a low-memory machine, run it in small batches (a fresh Chrome per batch): the
largest full-pipeline photos can exhaust Chrome's heap and drop the DevTools
socket, which is an environmental limit, not a pipeline fault — the same file
processes cleanly given its own Chrome.

### `filecheck.js`

    node tools/filecheck.js

Loads `index.html` over `file://` — the scenario browsers block ES modules in —
and asserts that `js/boot-check.js` shows its guidance overlay rather than
leaving a dead page.

### `prnu.py` and `prnu-process.js`

    python tools/prnu.py

Measures how well a camera's sensor fingerprint (PRNU) survives the shipped
strip pipeline, the strongest link between a photo and the specific camera that
took it. `prnu-process.js` runs a folder of images through the real strip path
(the full pixel pipeline with no metadata added); `prnu.py` builds a synthetic
fingerprint we control, stamps it into textured content, runs those through the
pipeline, and measures the peak-to-correlation-energy against the estimated
fingerprint before and after. Grounded in the shipped code rather than asserted.
On an earlier pipeline it found that 7 of 10 images still matched. The
current pipeline was then measured against real phones instead of a synthetic
fingerprint (VISION dataset: iPhone 6 and Huawei P9, maximum-likelihood
fingerprints from flat-field shots): processed photos still match their camera
(22 of 22 iPhone 6 outputs), and the downscale, warp, denoise and noise weaken
the pattern only about twofold. The README's threat model reports the numbers.

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
