# metafaker

MetaFaker protects your privacy when you share photos. A photo straight from a phone or camera carries far more than the picture: the GPS position where it was taken, the exact time, the device's make and model, and, in the pixels themselves, a faint sensor pattern that can link it to the specific camera that took it. MetaFaker removes that identifying information before you share an image, either by stripping the metadata or by replacing it with a consistent, generated set that does not point to you.

It is for anyone who wants to share a photo without also sharing where they live, where they have been, or which device they own: journalists and the people they protect, activists, people selling things online, anyone who posts pictures publicly.

Everything runs locally in your browser. There is no backend, no upload step and no cloud storage, and the page makes **no network request at all** beyond loading its own files.

## Current behavior

- Accepts multiple images from drag and drop or the file picker, decoded with
  `createImageBitmap`, which covers JPEG, PNG, WebP, AVIF and HEIC wherever the
  browser's codecs do (Safari decodes HEIC; Chrome without HEIC support gets a
  clear message to convert to JPEG). An undecodable file fails with a readable
  reason rather than silently.
- Tells a camera photo from a non-photo before generating any metadata. A
  screenshot or exported graphic never passed through a lens, so giving it a
  camera, lens and GPS would make it inconsistent with what it is. Such
  inputs are cleaned of any identifying metadata instead — either a plain strip
  or an Adobe-exported graphic carrying editor provenance only, chosen at random
  so they do not share one signature, and never a camera or a location.
- Builds a local batch queue with previews and per-image state.
- Parses original EXIF locally in the browser.
- Re-encodes each processed image as a new JPEG through a privacy pipeline that removes identifying traces from the pixels, not only from the metadata.
- Either removes the metadata entirely or replaces it with a generated metadata set whose location is always inside the United States.
- Downloads processed files locally under a filename matching the generated camera.

## Privacy of the page itself

A privacy tool that phones home is not one. The page therefore:

- loads **no third-party resource**. The two libraries it uses (`piexifjs` 1.0.6 and `exifr` 7.1.3) are vendored under `vendor/`, not fetched from a CDN. A CDN-served module import cannot carry an integrity hash, so a compromised CDN could have run anything against the user's photos, and every visit handed the CDN the visitor's IP address and referrer. The icons are inline SVG rather than a Google-hosted web font, for the same reason.
- pins `vendor/piexif.js` with a Subresource Integrity hash, so the browser refuses to run it if its bytes ever differ from the reviewed file. `.gitattributes` keeps `vendor/` byte-for-byte, because a line-ending conversion changes the bytes and would break the hash.
- sends `Referrer-Policy: no-referrer`, so following a link from the page never reveals the page.
- offers a map link only for **generated** coordinates, pointing at OpenStreetMap with `noreferrer`. The original image's coordinates are the user's real position and are never linked anywhere.
- carries a Content-Security-Policy of `default-src 'none'` with `script-src 'self'`, as defence in depth behind the output escaping: EXIF from an untrusted image reaches the metadata panel, and if anything ever slipped through unescaped the CSP stops it executing.
- stores only the theme preference, in `localStorage` under `metafaker.theme`. Processed images, previews and queue state live in memory for the active tab only.

`tools/check.js` asserts the no-network property on every run: any request to a host other than the local test server fails the build.

## Running it

The hosted version is at https://0xs8n.github.io/metafaker/. The app is static, so you can also serve the directory with any static host (`python -m http.server`, GitHub Pages, nginx) and open `index.html`.

**To run it offline, open `dist/metafaker.html`** — one self-contained file with every script, style and library inlined, which works by double-clicking in any browser and can be copied to an air-gapped machine. Rebuild it after changing the source with:

```
node tools/build.js
```

Opening the modular `index.html` straight from disk does **not** work: browsers block ES module imports from `file://`, so the controller never loads and the buttons do nothing. If you open it that way, a message now says so and points you to the single-file build or to serving the folder, rather than leaving a dead page.

## Architecture

The application is split into small browser modules:

- `index.html` — the UI shell, upload zone, preview panel, action buttons and metadata panel.
- `css/style.css` — layout, batch queue, preview card, metadata table and toast styling.
- `js/main.js` — bootstraps the app, theme state, and wires drag/drop and file input events to the controller.
- `js/ui.js` — application state, queue management, rendering, downloads, and the processing workflow.
- `js/classify.js` — tells a camera photo from a screenshot or exported graphic before any metadata is generated, so a non-photo is never given a camera, lens or location.
- `js/exif.js` — generates the Adobe-export metadata set in each firmware's measured encodings (the per-make `WRITERS` profiles), parses source EXIF, verifies written metadata, and formats values for display.
- `js/data.js` — the camera database with the per-model EXIF facts measured from real files, the US location database, and the lens database.
- `js/provenance.js` — everything the file says about the editor that wrote it: its quantization tables, ICC profile, APP14 marker, the Photoshop APP13 block, and the XMP packet.
- `js/exif-writer.js` — the TIFF/Exif serialiser that replaces piexifjs's `dump`, little- or big-endian.
- `js/jpeg-requantize.js` — the baseline JPEG transcoder that re-quantises the browser's output onto the exporter's tables, adds its restart interval and APP14, and optimises the Huffman tables.
- `js/helpers.js` — shared utilities, the canvas pipeline, timezone and sun-position maths.
- `js/rng.js` — the one random source, backed by `crypto.getRandomValues`.
- `js/md5.js` — MD5, for the Photoshop IPTCDigest resource.
- `js/icons.js` — inline SVG icons.
- `js/boot-check.js` — a classic (non-module) script that shows a guidance overlay when `index.html` is opened from `file://` or the app otherwise fails to load.
- `vendor/` — the two pinned libraries.
- `tools/` — the test harness, the single-file build, and offline image-analysis measurement scripts.

`js/makernote.js`, `js/icc-profiles.js` and `js/qtables.js` hold measured data for a camera-original provenance that is **not wired in**; see the note at the top of each.

## Processing pipeline

For each loaded file:

1. The browser reads the input locally and creates an object URL for previewing.
2. `exifr` parses the original metadata, and `js/classify.js` decides whether the input is a camera photo or a non-photo (a screenshot or exported graphic) from its format, its dimensions and whether it names a camera.
3. On `Randomize`, a photo gets a generated camera, lens, timestamps, exposure, location and editor identity from `generateFake()`, and the XMP packet is built from the same values. A non-photo is cleaned instead, as described above, and never given a camera or a location.
4. The image goes through the canvas pipeline in `js/helpers.js` and is exported as a fresh JPEG with the exporter's container.
5. `js/exif-writer.js` serialises the EXIF block and it is inserted into the JPEG.
6. The result is parsed back once more to verify the metadata was written before the output is offered for preview or download.

`Strip Current Metadata` runs the same pixel pipeline and writes the file as the same export with its metadata removed: no Exif, no XMP, no ICC profile, and the Adobe APP14 marker left in place, which is exactly what `exiftool -all=` leaves behind on a Camera Raw export. The earlier version left the ICC profile in, which produced a combination of segments that exists nowhere except in this tool's output. A non-photo takes the light path described below.

### Canvas pipeline

The canvas export is not a plain re-encode. Each photo passes through these stages so the output does not carry the sensor and encoder fingerprints that could link it back to the original photo or to the device that took it. Every parameter is drawn per image and several stages run on only a share of images, so there is no fixed recipe shared by every output that would link separately shared images to one another:

1. Proportional crop of up to 1.2% per edge, which shifts the sensor grid.
2. Rotation of 0.3 to 2.0 degrees in either direction on about two images in three, with a scale factor that keeps the frame filled.
3. Reshape onto a frame the generated camera can produce, landing on a native capture resolution when reachable. Otherwise the image is always downscaled, by 8 to 20% and to at most one of six long-edge sizes (2048 to 3200 pixels), even when it is already small. Resampling onto a new, smaller grid is the step that reliably breaks the sensor-pattern (PRNU) link between a photo and the camera that took it.
4. A non-rigid warp: a smooth random displacement field of under two pixels, built from three low-frequency waves with random directions and phases, followed by a light denoise. This strengthens the sensor-pattern protection. A crop and rotation are one global transform, and a sensor-pattern match can be re-aligned through it by searching over scale and rotation; a field that varies across the frame has no single inverse, so every block is misaligned by its own fraction of a pixel and the whole-frame correlation weakens. Measured on its own, the warp is not enough (see the threat model below); the downscale in step 3 is what reliably breaks the link.
5. Per-brand colour profile: warmth, saturation and contrast matched to the generated make.
6. ISP simulation: an anchored S-curve tone mapping on four images in five, and an unsharp mask of radius one or two pixels on three in four.
7. Lens optics: radial vignetting on seven images in ten and sub-pixel chromatic aberration, in either direction, on three in five.
8. Poisson-Gaussian sensor noise scaled to the generated ISO value, with the shot-to-read split and per-channel factors drawn per image.
9. JPEG encode at quality 1.0 (the only setting at which the browser emits 4:4:4 chroma, which an export uses), then re-quantisation of the coefficients onto the exporter's measured tables, and rewriting of the container: the browser's JFIF and ICC segments are removed and the exporter's ICC profile, XMP packet and APP14 marker are written in its order.

A non-photo (a screenshot or exported graphic) takes a light path: crop, downscale (capped at 1600 pixels on the long edge) and a clean re-encode in the same export container. It has no sensor and no lens, so sensor noise, lens effects or a warp would only make it less like what it is.

Every random draw in the tool, from the camera down to the per-pixel noise, comes from `crypto.getRandomValues` through `js/rng.js`, refilled in blocks so the pixel loops stay fast.

## Metadata generation

The generated metadata is built from static profiles rather than free-form values. The intent is internal consistency: metadata whose values contradict each other stands out, and a file that stands out draws attention to itself and to the person who shared it.

### Measured, not guessed

The camera facts in `js/data.js` and the Adobe facts in `js/provenance.js` were read from real files on Wikimedia Commons on 2026-10-16 with ExifTool: two camera originals per phone model, one per camera body, and seven Adobe exports (Camera Raw 16.3/16.4/16.5 and Lightroom Classic 13.4/14.0.1, plus Lightroom 7.1.2 and 6.5). Where a secondary phone lens was not among the samples, its figures are marked `approx` in the data file. Reproducing a measured rule beats inventing a plausible one: an iPhone 15 Pro writes f/1.78 as the fraction `1244236/699009` (the continued-fraction convergent of the float32 value), while a 14 Pro Max writes `89/50` for the same aperture, so the tool writes each model's own form.

### Provenance

The output is written as a photo exported from Adobe Camera Raw (for camera bodies, from a raw file) or Adobe Lightroom (for phones, from a JPEG), not as a camera original, and that is deliberate.

A camera original has to carry a MakerNote. Real ones are large and model-specific, and an incomplete one would make the file internally inconsistent, whereas having none is ordinary: editors routinely drop it. An export is a story the file can tell completely: camera `Make` and `Model` intact, `Software` naming the editor, zero MakerNote tags, and a resolution below native. Photographers shoot raw and export, so this is among the most common files that exist.

The whole container is reproduced from the measured exports. The pixel section is the exporter's: one of three measured quantization tables drawn per image, a restart interval and restart markers, the 12-byte Adobe `APP14` marker before the frame header, optimised Huffman tables, and 4:4:4 chroma. After the start marker come the four metadata segments in the exports' order: the EXIF (little-endian, as every Adobe export is), the Photoshop `APP13` block, the `APP2` ICC profile (the 3144-byte HP sRGB profile), and the `APP1` XMP packet. `Software` names a Camera Raw 16.x or Lightroom 7.x release and platform, drawn per image rather than fixed, because one identical string on every file was a perfect key for grouping them; the resolution is Camera Raw's 300 ppi or Lightroom's 240.

An IFD1 thumbnail **is** embedded, because Adobe exports carry one: a 256-pixel image encoded the way the exporter encodes it (the standard Huffman tables, a 32-MCU restart interval, Adobe's APP14), and the same bytes appear again as the Photoshop thumbnail, as in the real files. (The thumbnail this tool briefly dropped, and before that embedded wrongly, had been encoded by the browser and carried Chrome's JFIF header and an ICC profile with the copyright string "Google Inc. 2016".)

The Photoshop `APP13` block carries the resolution-info resource, the IPTC record (the UTF-8 marker, record version 4, and the capture date and time with zone), the thumbnail resource, and the MD5 of the IPTC block as its IPTCDigest, exactly as the exports do.

The XMP packet carries what a real one carries, in Adobe's attribute order: `xmp:CreateDate` and `photoshop:DateCreated` at the capture time, `xmp:ModifyDate`, `xmp:MetadataDate` and the history entry at the **export** time, which is hours to weeks later; the `aux:` and `exifEX:` lens fields; a full `crs:` develop-settings block (a raw opens with Temperature/Tint and sharpening at 40, a JPEG with IncrementalTemperature and sharpening at 0); the four tone curves and the PointColors list; a `DerivedFrom` element; and a history line naming the raw format the generated camera actually shoots (`image/x-canon-cr3`, `image/x-nikon-nef`, `image/x-sony-arw`, `image/x-fuji-raf`), or "saved to new location" for a phone JPEG. The packet is UTF-8 with a correct byte-order mark, the eight-space toolkit string Adobe writes, and the 4097-byte whitespace padding it appends.

A genuine Adobe export does not pass `exiftool -validate`: Adobe drops `ComponentsConfiguration`, `ExifImageWidth`, `ExifImageHeight` and `YCbCrPositioning`, and a Samsung or OnePlus phone writes `OffsetTime` and `LensModel` with an `ExifVersion` older than the spec allows for them. The output carries those same four omissions and, for those phones, those same version mismatches, so it produces the **same** validation warnings a real export does and no others. Matching the real file means matching its imperfections, not scoring better than it.

### Consistency rules

- **Per-make tag sets.** An export preserves the camera's tags, so a file presenting as a Samsung has to carry Samsung's tag set, not a generic one. The per-make `WRITERS` profiles in `js/exif.js` record which optional tags that firmware writes (which `SubSecTime` tags and at what width, `SensingMethod`, `SceneType`, `FileSource`, `CustomRendered`, the contrast/saturation/sharpness trio, `DigitalZoomRatio`, `LightSource`, `GainControl`, Nikon's `CFAPattern`, the CIPA sensitivity pair, which lens tags) and the values it uses (`MeteringMode`, the `Flash` codes for "did not fire"). Per model, `ExifVersion`, built-in flash, raw format and `OffsetTime` support are fixed, not drawn; the `OffsetTime` tags only exist from Exif 2.31, so a 0220 writer never carries them. Canon never writes `FocalLengthIn35mmFormat`; Apple writes no `MaxApertureValue`; Nikon writes `Flash` as 0; the Qualcomm-based Android makers write `ExifVersion` 0220. `FlashpixVersion` is always 0100. `ColorSpace` is always sRGB, because the export is.
- **Per-make encodings.** Each firmware serialises its rationals its own way and the export carries the strings through. Apple writes arbitrary-denominator rationals produced from floats and reduced fractions (`89/50` for f/1.78); Nikon and Sony write APEX values over 1000000; Canon snaps to eighth-stops and reduces exposure compensation in thirds; Nikon writes compensation in unreduced sixths; the Android makers and Fujifilm write over 100. GPS coordinates are the exception: they are written as the **exporter** writes them, degrees plus decimal minutes to four places with a zero seconds field, because XMP stores them as `DDD,MM.mmmmN` and the exporter reconciles that back into EXIF.
- **Manufacturer spellings.** Samsung writes `samsung`, Nikon writes `NIKON CORPORATION` and `NIKON Z 9` with a space, Sony writes `SONY`.
- **The sun fixes the scene.** The capture hour is drawn from when people actually take pictures, then the sun's elevation at the generated place and time is computed, and the scene brightness is chosen from it: no daylight exposures after dark. The exposure is then solved, not sampled: shutter and ISO are solved against the aperture through `N² / t = (ISO / 100) · 2^EV`, clamped to what the body can meter, and snapped to the shutter ladder. The APEX tags and `BrightnessValue` are derived from the same solution.
- **Lenses have to fit.** Bodies list the mounts they accept and lenses declare theirs. The lens is chosen before the aperture and only f-numbers it can open to are offered. `LensSpecification` carries the lens's real range, with Canon's apertures left as 0/0 as its firmware writes them. A fixed-lens body reports no lens model; F-mount Nikon glass reports through the MakerNote only, so the D850 carries no lens tags in EXIF and the export names the lens in XMP in Adobe's own `24.0-70.0 mm f/2.8` form.
- **Phone optics are per lens.** `FocalLength` carries the real focal length and `FocalLengthIn35mmFormat` the equivalent. Apple's `LensSpecification` spans every lens on the back.
- **GPS agrees with the place.** Altitude is jittered around the city's real ground elevation. `GPSTimeStamp` is UTC derived from the capture time through the city's own timezone, DST included, with matching `OffsetTimeOriginal` where the model writes it. `GPSVersionID` follows the exporter, which normalises it: Camera Raw (the camera bodies) writes 2.3.0.0 and Lightroom (the phones) 2.2.0.0, as measured. Canon bodies also carry `GPSStatus` and `GPSMapDatum`, as Canon's firmware writes them.
- **Every image is its own identity.** `Randomize Entire Batch` gives each image exactly what `Randomize Current` gives it: its own camera, lens, city, capture and export dates, editor version and filename, drawn independently. Images processed together share nothing through their metadata, so they cannot be linked to each other, or grouped as coming from one person, by a common device, place, trip or naming sequence.
- **Dates do not leak the run.** Captures are drawn from the two years before an anchor that itself sits a random one to ninety days in the past, so the latest date in a batch no longer says when the tool was run. The export follows the capture during waking hours. `Keep original date` keeps the original calendar day in the output and so links it to the original; use it only when the day is not sensitive.
- **Byte layout.** ASCII values are padded to an even length, sub-IFDs carry their next-IFD terminators, tags are sorted. Output is checked with `exiftool -validate`, which reports exactly the warnings a real Adobe export produces (see Provenance) and no others.

The location dataset in `js/data.js` is 58 United States cities, covering the lower 48 plus Alaska and Hawaii. Every generated photo geolocates inside the US by construction, and `tools/check.js` asserts it on every run. A chosen city is jittered by up to 0.05 degrees, roughly 5 km, which keeps the coordinate inside that city's metro area.

## Export format

- Output files are always JPEG.
- The original filename is never used, in the download name or anywhere inside the file. Each photo gets a generated source filename in its camera's own convention, recorded in the XMP as `crs:RawFileName` (`DSC_4821.NEF` for a Nikon, `DSC04821.ARW` for a Sony, `DSCF4821.RAF` for a Fujifilm, `IMG_0734.jpg` for an iPhone, `PXL_20240612_141503123.jpg` for a Pixel, `20240612_141503.jpg` for a Samsung), and `getOutputName()` in `js/ui.js` names the download after that same stem with a lowercase `.jpg`, as a real Camera Raw or Lightroom export is. Date-based names use the generated capture time, and the Pixel's millisecond field is the frame's `SubSecTime`. A cleaned file with no generated camera gets a plain date-based name. `tools/check.js` asserts that the input's filename appears nowhere in the output's bytes.

## Threat model and limits

What this tool does and does not protect against, stated plainly, because the people who need it most are the ones who will be hurt by overclaiming.

- **Metadata.** Everything the original carried is gone: Exif, XMP, IPTC, MakerNote, ICC, embedded thumbnails, trailers such as Samsung's and Google's motion-photo data, C2PA manifests. The output's metadata describes a camera, place and time that are not yours.
- **Encoder fingerprints.** The browser's quantization tables, JFIF header and ICC profile are replaced with a real exporter's. Each output uses one of the exporter's measured tables and its ICC profile, as real Adobe exports do.
- **Sensor pattern (PRNU).** Every camera sensor leaves a faint, unique noise pattern in its photos, which can link a photo to the specific camera that took it. The pipeline is built to break that link: it always downscales the image, which is the step that reliably breaks the correlation, and adds a non-rigid warp, a denoise and fresh noise on top. `tools/prnu.py` measures this against a synthetic sensor fingerprint. On an earlier version of the pipeline, which did not always downscale, the median correlation fell from about 56,700 to about 790, a drop of roughly 98.6%, but 7 of 10 processed images still exceeded the standard match threshold of 60. The pipeline was strengthened in response (the downscale made unconditional, the denoise made stronger), and that version has not yet been re-measured. Nothing has been measured against a real camera's sensor pattern. Treat this as strong protection, not a proven guarantee.
- **Machine-learning image-analysis models** (TruFor, Noiseprint++, CAT-Net and the like) have not been tested against this output. The pipeline reproduces the statistical traces of an ordinary camera photo, but no claim is made about how these models assess it.
- **Image content** is yours to check: faces, reflections, signage, documents, screen contents, and anything that contradicts the generated location or season.
- **Downloads carry their origin.** Browsers record where a file came from in filesystem metadata outside the file (`Zone.Identifier` on Windows, quarantine and "where from" attributes on macOS). The file's bytes are clean; the download record is not. The offline single-file build opened from disk avoids the web origin.
- **Linking across a batch.** Every image, in a batch or on its own, draws an independent identity, so the metadata gives no common device, place or date to link images to one another. Their content still can: the same scene, objects or people across several photos link them regardless of metadata.

## Testing

```
node tools/check.js
```

Launches headless Chrome, processes every image in `testimg/` plus a synthetic PNG screenshot, and asserts: the output's structure byte by byte (segment order, no JFIF, the Adobe thumbnails, a correct XMP byte-order mark, no browser strings anywhere in the file); that the page made no request to any host but the test server; that images randomized as a batch each get their own identity; that the screenshot is classified as a non-photo and given no camera, lens or location; and, when `exiftool` is installed, that each file produces only the validation warnings a real Adobe export does, that its GPS is inside the United States, that its dates, exposure and sun position are consistent, and that no browser-encoded data survives.

`node tools/stress.js <inDir> <outDir>` runs both the randomize and strip paths over a folder of edge-case inputs (tiny, boundary and odd sizes, panoramas, grayscale/CMYK/progressive JPEG, WebP, RGBA and screenshot PNGs) and reports the classifier verdict and any failure per file. See `tools/README.md` for this and the offline pixel-domain measurements.

## Runtime dependencies

Both are vendored and pinned; nothing is fetched at runtime.

- `vendor/piexif.js` — piexifjs 1.0.6, for reading EXIF back and inserting the APP1 segment. Its serialiser is replaced by `js/exif-writer.js`.
- `vendor/exifr.esm.js` — exifr 7.1.3, for parsing. `vendor/exifr.umd.js` is the same library in the form the single-file build inlines.

There is no build step for the multi-file version. `node tools/build.js` produces the single-file one.
