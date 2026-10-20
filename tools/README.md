# Measurement tools

The harness, the build, the table generators, and the measurements behind the
README's figures.

The first three scripts are pixel-domain checks for comparing MetaFaker's output
against real camera files. Metadata is only half of what can identify a photo;
the pixels are the other half. These check that the pixels carry no trace that
would link an output back to its original or set it apart from an ordinary
photo.

They require `numpy`, `scipy`, `pillow`. Run them against your own JPEGs — no sample
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

## `noise.py`

    python tools/noise.py a.jpg b.jpg ...
    python tools/noise.py --summary a.jpg b.jpg ...

Noise character on the flattest mid-tone 16x16 blocks of each image: the
chroma-to-luminance ratio of the noise residual, the correlation between its R,
G and B parts, its lag-1 autocorrelation (grain), and its luminance standard
deviation. A real export's noise is mostly luminance, moves together across
channels and has a slight grain. Compare an output against the same input
downscaled plainly to the output's size and saved with the output's own
quantization tables; against any other reference the tables alone shift the
chroma figure. Measured 2026-10-18 on 44 Commons files: the phone outputs'
chroma excess fell from +0.24 to +0.05 and the RGB-correlation gap from -0.26
to -0.02 once the noise was rebuilt as a smoothed luminance field plus a weaker
chroma field. Outputs were then at most 3,200 px on the long edge; the
measurement has not been rerun since they are drawn at real export sizes.

## Reference measurements

Taken 2026-09-25 against unmodified originals from Wikimedia Commons. The
"our output" row predates the current pipeline (the warp and denoise, the
rebuilt noise, the re-quantiser's tie rounding and the output sizes) and has not
been re-measured.

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

Node scripts (Node 22+, no npm packages). All but `build-places.js` and
`capture_times.js` drive the real app in headless Chrome over the DevTools
protocol. `exposure_tables.py`, documented here beside the tools that use its
output, is Python and needs only the standard library. Chrome is found automatically in
its usual install locations, or set `CHROME=/path/to/chrome`. The launch and
protocol plumbing is shared in `tools/lib/cdp.js`.

### `check.js`

    node tools/check.js

Serves the repo on `127.0.0.1`, loads every `testimg/*.jpg` (synthetic
images carrying sensor-like noise), puts the first three through Randomize
Entire Batch and the rest through Randomize one by one, and strips one extra
copy of the first image. It then randomizes a set of non-photo cases (a PNG
screenshot, the same screenshot as JPEG, a PNG renamed `.jpg`, an SVG, a
transparent WebP, the tool's own screenshot output loaded again, and a photo
JPEG labelled "Screenshot" in its `UserComment`), a photo on a clipped black
background, and an extensionless JPEG with no MIME type. Outputs go to
`tools/out/` (git-ignored). Then it asserts:

- **privacy** — every network request the page made went to `127.0.0.1`,
  `blob:` or `data:`; no uncaught exceptions, `console.error` calls or
  error-level log entries (CSP violations, failed loads); every preview the
  page shows is at most 1600 px on the long edge.
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
- **filename** — the input's filename appears nowhere in any output's bytes,
  and no download name carries a date within a day of the run.
- **exposure** — the port of Adobe's exposure rounding writes the DNG SDK's
  worked cases (a camera's 1/1215 s as 1/1200, 2101/1000000 as 1/480) and
  can produce every `ExposureTime` of the real exports in
  `tools/adobe-exposure-times.json` except the encodings Adobe never writes,
  with their `ShutterSpeedValue`. Over 1000 `generateFake()` identities: every
  `ExposureTime` is one the rule produces, `ShutterSpeedValue` and
  `ApertureValue` are mirrored from the written `ExposureTime` and `FNumber`,
  no EV above 11 with the sun below -6°, phones sit at exactly 1/60 s in under
  20% and at the 50 Hz times 1/50 and 1/100 s in under 4%, no real file
  carries more than a fifth of the draws at any EV for any camera and lens,
  and, each within four standard errors of the real share, phones fall after
  civil dusk as often as US phone photos (10.4%), bodies between 09:00 and
  18:00 sit at EV 13 or brighter as often as body exports (19.3%), and iPhones
  with and without a telephoto use their main camera as often as real ones
  (69.3% and 90.5%). A zoomed iPhone's 35 mm equivalent must follow its
  `DigitalZoomRatio`. Each identity's time and ISO, ranked among the real files of its table at the
  same EV (within half a stop) and f-number, written as an export of them
  writes them and, for a body, within its shutter and ISO range, puts 25%,
  50% and 75% of the batch below the real quartiles within four standard
  errors plus 4 points. `node tools/check.js --exposure-runs 100` runs only
  these checks, on 100 batches, and reports how many fail, the pooled shares,
  and how many of 20,000 batches resampled from the pooled identities fail.
- **gps** — 3,000 locations drawn from the shipped generator all lie on US
  land, tested against `tools/us-land.json`.
- **size** — 200 output sizes drawn at each listed camera's own frame are all
  downscaled by at least 8%, none above 16 MP, the aspect ratio kept, and the
  share longer than 3,200 px within 0.15 of real exports' (0.68 for phones,
  0.69 for bodies).
- **packets** — 400 generated XMP packets, built in the page: phone editors
  85% Lightroom Classic and 15% Lightroom, body editors 61%, 28% and 10%
  Camera Raw; every body carries Adobe Standard, its own measured profile
  digest and the Adobe Color look, and names a release new enough to open its
  raws; `ColorVariance` exactly from `crs:Version` 17.5 and
  `CropConstrainToUnitSquare` exactly from 17.3; lens-profile correction only
  with the profile measured for that lens, and on in some exports;
  `DerivedFrom` the source ID twice with no instance ID; the AutoToneDigest
  pair at the measured share, never repeated; `PreservedFileName` and the pick
  flag exactly on Lightroom Classic, the `edited` event exactly on Lightroom
  for Windows, the look's Copyright line exactly where the editor writes it;
  iPhone sources named `IMG_nnnn` with `.HEIC`, `.JPG`, `.jpeg` or `.JPEG`,
  HEIC at about 40% and recorded as converted.
- **keep date** — with `Keep original date and time`, 150 identities each from
  an old and a recent kept date keep the exact Date Taken, export after the
  capture with a drawn delay, never later than now in the place's zone, on a
  camera released by then; a future date and one older than every camera are
  replaced and reported. One of the run's own outputs, loaded again with the
  box ticked, keeps its Date Taken through the page.
- **exiftool** (when found on PATH or at a usual install location, including
  the per-user one under `LOCALAPPDATA`; otherwise SKIPPED) — `-validate`
  reports only the warnings a real Adobe export produces and no others, and all
  four of its missing-tag warnings; Make/Model present; Software is Adobe
  Camera Raw, Lightroom or Lightroom Classic; ModifyDate >= DateTimeOriginal; the XMP CreateDate matches
  DateTimeOriginal; the GPS position on US land, tested against
  `tools/us-land.json`; the exposure triangle agrees with the APEX tags within
  0.75 EV; an IFD1 thumbnail present; no JFIF or Google ICC tags;
  ExifImageWidth/Height absent, as Adobe drops them; ColorSpace sRGB whenever
  the ICC profile is; the XMP crop rectangle and angle, applied to the input,
  give the output's shape; and the sun is not below
  -6° at the GPS position and time when the exposure indicates bright daylight
  (EV > 11). Stripped files must carry no metadata groups and validate clean.

Exit code is 1 on any failure; each failure names the file, the assertion and
the actual value.

### `exposure_tables.py`

    python tools/exposure_tables.py <phone-survey.jsonl> <body-survey.jsonl> [js/exposure-tables.js]

Writes `js/exposure-tables.js`, the real exposures generated photos draw
from, from Wikimedia Commons API surveys (one JSON object per file, as
`prop=imageinfo&iiprop=metadata|user` reports it over the "Taken with"
categories). Phones: f-number, time and ISO of every phone file located in the
United States that is not an Adobe export, as an Apple and an Android table.
Bodies: the same three of every Adobe export of a body photo. Files are grouped
by uploader so the generator can weight each uploader once. Rerun it on a newer
survey to refresh the tables.

### `capture_times.js`

    node tools/capture_times.js <phone-survey.jsonl>

Prints `CAPTURE_DAYLIGHT` and `CAPTURE_AFTER_SUNSET` for `js/exif.js` from the
same Commons phone survey `exposure_tables.py` reads: for every US-located
phone photo, the sun at its own place and date (time zone from the nearest
place in `js/places.js`), and its capture time as a fraction of the daylight,
or as the time since sunset, each uploader weighted once. It also prints the
share taken after civil dusk, which `check.js` asserts on.

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

### `classify-eval.js`

    node tools/classify-eval.js <corpus> [--holdout g1,g2] [--jobs N] [--json rows.jsonl] [--misses]

Measures `js/classify.js` on a labelled corpus laid out as
`<corpus>/photo/<group>/*` (real camera photos) and `<corpus>/screen/<group>/*`
(screenshots), JPEG, PNG or WebP. Each file is classified in headless Chrome
through the same calls the page makes: as it is, with its metadata stripped,
and as copies a messaging app or an editor would make (JPEG q70 to q90 at 1280,
1600 px and full size, WebP, a phone-screen-shaped and a panorama crop, and a
JPEG copy that keeps the metadata). It prints, per copy, the share of
screenshots caught and the number of photos taken for a screenshot, and exits 1
if any photo copy is. Groups named in `--holdout` are reported apart, so a
threshold tuned on the other groups is checked on sources it never saw: hold
out whole categories (a camera, a Commons category), never copies of one image.
`--jobs N` classifies on N pages at once. `--json` writes every measurement, for trying a threshold change offline before
running it again. No corpus is committed; the useful files are other people's
images. The corpus behind the README's figures is described there.

### `filecheck.js`

    node tools/filecheck.js

Loads `index.html` over `file://` — the scenario browsers block ES modules in —
and asserts that `js/boot-check.js` shows its guidance overlay rather than
leaving a dead page.

### `peak.js`

    node tools/peak.js <image> [randomize|strip] [out.jpg]

Peak renderer memory and time for one image, in a fresh headless Chrome. The
file goes in through the page's own file input, as a user's does, and the
script prints one JSON line: load and render times, output size and
dimensions, and the renderer's peak working set after loading and after the
render. Windows only (it reads the peak from `Get-Process`). Run it three
times per input: the spread between runs is tens of MiB, more when other
programs compete for memory. The figures in the README's "Large photos" come
from it.

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
the pattern only about twofold. Both measurements predate outputs drawn at real
export sizes (2026-10-19) and have not been rerun. The README's threat model
reports the numbers.

### `build-places.js`

    node tools/build-places.js [--src DIR]

Generates `js/places.js`, the US place table every generated GPS position is
drawn from, and `tools/us-land.json`, the land mask `check.js` tests positions
against. No browser. It downloads its public-domain sources into `DIR`
(default `<tmp>/metafaker-places`) when missing and reuses them after: the
Census 2024 Gazetteer, place and state boundaries and population estimates,
the ACS 2020-2024 place populations, the NWS forecast zones with their time
zones, the GNIS Federal Codes town points, the IANA zone list, and one USGS
Elevation Point Query Service lookup per place, cached in `DIR/epqs.json`.
The first run takes about 80 minutes, almost all of it elevation lookups; a
rerun with the cache takes about 5 and writes identical files. It refuses to
write if any sampled point of any disk leaves its place, US land, its time
zone or the simplified mask, or if a US time zone stops matching the zone the
table uses for it.

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
