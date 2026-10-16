# metafaker

MetaFaker is a static browser application for loading one or many images, re-encoding them as JPEG, and either stripping EXIF metadata or replacing it with a generated metadata set. The app is fully client-side: there is no backend, no upload step, no cloud storage, and the page makes **no network request at all** beyond loading its own files.

## Current behavior

- Accepts multiple images from drag and drop or the file picker.
- Builds a local batch queue with previews and per-image state.
- Parses original EXIF locally in the browser.
- Re-encodes each processed image as a new JPEG through an anti-forensic pixel pipeline.
- Either strips metadata entirely or injects a generated metadata set.
- Downloads processed files locally under a filename matching the generated camera.

## Privacy of the page itself

A privacy tool that phones home is not one. The page therefore:

- loads **no third-party resource**. The two libraries it uses (`piexifjs` 1.0.6 and `exifr` 7.1.3) are vendored under `vendor/`, not fetched from a CDN. A CDN-served module import cannot carry an integrity hash, so a compromised CDN could have run anything against the user's photos, and every visit handed the CDN the visitor's IP address and referrer. The icons are inline SVG rather than a Google-hosted web font, for the same reason.
- sends `Referrer-Policy: no-referrer`, so following a link from the page never reveals the page.
- offers a map link only for **generated** coordinates, pointing at OpenStreetMap with `noreferrer`. The original image's coordinates are the user's real position and are never linked anywhere.
- carries a Content-Security-Policy of `default-src 'none'` with `script-src 'self'`, as defence in depth behind the output escaping: EXIF from an untrusted image reaches the metadata panel, and if anything ever slipped through unescaped the CSP stops it executing.
- stores only the theme preference, in `localStorage` under `metafaker.theme`. Processed images, previews and queue state live in memory for the active tab only.

`tools/check.js` asserts the no-network property on every run: any request to a host other than the local test server fails the build.

## Running it

The app is static. Serve the directory with any static host (`python -m http.server`, GitHub Pages, nginx) and open `index.html`.

Opening `index.html` straight from disk does **not** work in Chrome: the app is written as ES modules, and Chrome blocks module imports from `file://`. For offline use, build the single-file version:

```
node tools/build.js
```

That writes `dist/metafaker.html`, one self-contained file with every script, style and library inlined, which opens from `file://` in any browser and can be copied to an air-gapped machine.

## Architecture

The application is split into small browser modules:

- `index.html` — the UI shell, upload zone, preview panel, action buttons and metadata panel.
- `css/style.css` — layout, batch queue, preview card, metadata table and toast styling.
- `js/main.js` — bootstraps the app, theme state, and wires drag/drop and file input events to the controller.
- `js/ui.js` — application state, queue management, rendering, downloads, and the processing workflow.
- `js/exif.js` — generates the metadata set, parses source EXIF, verifies written metadata, formats values for display.
- `js/data.js` — the camera database with per-model firmware facts, per-make EXIF profiles, the US location database, and the lens database.
- `js/provenance.js` — everything the file says about the editor that wrote it: its quantization tables, ICC profile, APP14 marker and XMP packet.
- `js/exif-writer.js` — the TIFF/Exif serialiser that replaces piexifjs's `dump`.
- `js/jpeg-requantize.js` — the baseline JPEG transcoder that re-quantises the browser's output onto the exporter's tables.
- `js/helpers.js` — shared utilities, the canvas pipeline, timezone and sun-position maths.
- `js/icons.js` — inline SVG icons.
- `vendor/` — the two pinned libraries.
- `tools/` — the test harness, the single-file build, and offline forensic measurement scripts.

`js/makernote.js`, `js/icc-profiles.js` and `js/qtables.js` hold measured data for a camera-original provenance that is **not wired in**; see the note at the top of each.

## Processing pipeline

For each loaded file:

1. The browser reads the input locally and creates an object URL for previewing.
2. `exifr` parses the original metadata.
3. On `Randomize`, `generateFake()` builds the camera, lens, timestamps, exposure, location and editor identity, and the XMP packet is built from the same values.
4. The image goes through the canvas pipeline in `js/helpers.js` and is exported as a fresh JPEG with the exporter's container.
5. `js/exif-writer.js` serialises the EXIF block and it is inserted into the JPEG.
6. The result is parsed back once more to verify the metadata was written before the output is offered for preview or download.

`Strip Current Metadata` runs the same pixel pipeline and writes the file as the same export with its metadata removed: no Exif, no XMP, no ICC profile, and the Adobe APP14 marker left in place, which is exactly what `exiftool -all=` leaves behind on a Camera Raw export. The earlier version left the ICC profile in, which produced a combination of segments that exists nowhere except in this tool's output.

### Canvas pipeline

The canvas export is not a plain re-encode. Each image passes through these stages so the output does not carry the sensor and encoder fingerprints of the original:

1. Proportional crop of up to 1.2% per edge, which shifts the PRNU grid alignment.
2. Rotation of 0.5 to 2.0 degrees in either direction, with a scale factor that keeps the frame filled.
3. Reshape onto a frame the claimed camera can produce, landing on a native capture resolution when reachable, else one of six long-edge sizes.
4. Per-brand colour profile: warmth, saturation and contrast matched to the generated make.
5. ISP simulation: an anchored S-curve tone mapping plus a light unsharp mask.
6. Lens optics: radial vignetting and sub-pixel chromatic aberration.
7. Poisson-Gaussian sensor noise scaled to the generated ISO value.
8. JPEG encode at quality 1.0 (the only setting at which the browser emits 4:4:4 chroma, which an export uses), then re-quantisation of the coefficients onto the exporter's measured tables, and rewriting of the container: the browser's JFIF and ICC segments are removed and the exporter's ICC profile, XMP packet and APP14 marker are written in its order.

## Metadata generation

The generated metadata is built from static profiles rather than free-form values. The intent is internal consistency, because the cheapest way to detect fabricated metadata is not to find a wrong value but to find two values that contradict each other.

### Provenance

The output is written as a photo exported from Adobe Camera Raw, not as a camera original, and that is deliberate.

A camera original has to carry a MakerNote. Real ones are large and specific, and a partial one is affirmative evidence of tampering rather than the ordinary absence that any editor produces. An export is a story the file can tell completely: camera `Make` and `Model` intact, `Software` naming the editor, zero MakerNote tags, and a resolution below native. Photographers shoot raw and export, so this is among the most common files that exist.

Measured from a real Camera Raw export and applied: its quantization tables, the 3144-byte HP sRGB profile it embeds, its `APP14` marker placed immediately before `SOF`, and single `DQT` and `DHT` segments. The export's own fields are the editor's: `Software` names a Camera Raw 16.x release and platform, drawn per image rather than fixed, because one identical string on every file the tool produced was a perfect key for grouping them; the resolution is Camera Raw's default 240 ppi most of the time; an Interoperability IFD is written as the exporter writes one; and there is **no IFD1 thumbnail**, because Camera Raw and Lightroom exports do not embed one. (The thumbnail this tool used to embed was encoded by the browser and carried Chrome's JFIF header and an ICC profile with the copyright string "Google Inc. 2016" inside every file.)

The XMP packet carries what a real one carries: `xmp:CreateDate` and `photoshop:DateCreated` at the capture time, `xmp:ModifyDate`, `xmp:MetadataDate` and the history entry at the **export** time, which is hours to weeks later; the `aux:` and `exifEX:` lens fields; a full `crs:` develop-settings block with `HasSettings` and `AlreadyApplied` set as on an export; and a history line naming the raw format the claimed camera actually shoots (`image/x-canon-cr3`, `image/x-nikon-nef`, `image/x-sony-arw`, `image/x-fuji-raf`, `image/x-adobe-dng` for phones that shoot raw, `image/jpeg` for those that do not). The packet is UTF-8 with a correct byte-order mark.

### Consistency rules

- **Per-make tag sets.** An export preserves the camera's tags, so a file claiming a Samsung has to carry Samsung's tag set, not a generic one. `EXIF_PROFILES` in `js/data.js` records, per make, which optional tags that firmware writes (which `SubSecTime` tags and at what width, `SensingMethod`, `SceneType`, `FileSource`, `CustomRendered`, the contrast/saturation/sharpness trio, `DigitalZoomRatio`, `LightSource`, `GainControl`, Nikon's `CFAPattern`, the CIPA sensitivity pair, which lens tags) and the values it uses (`MeteringMode`, the `Flash` codes for "did not fire"). Per model, `ExifVersion`, built-in flash, raw format and `OffsetTime` support are fixed, not drawn; the `OffsetTime` tags only exist from Exif 2.31, so a 0220 writer never carries them. Canon never writes `FocalLengthIn35mmFormat`; Apple writes no `MaxApertureValue`; Nikon writes `Flash` as 0; the Qualcomm-based Android makers write `ExifVersion` 0220. `FlashpixVersion` is always 0100. `ColorSpace` is always sRGB, because the export is.
- **Per-make encodings.** Each firmware serialises its rationals its own way and the export carries the strings through. Apple writes arbitrary-denominator rationals produced from floats and reduced fractions (`89/50` for f/1.78); Nikon and Sony write APEX values over 1000000; Canon snaps to eighth-stops and reduces exposure compensation in thirds; Nikon writes compensation in unreduced sixths; the Android makers and Fujifilm write over 100. GPS coordinates are the exception: they are written as the **exporter** writes them, degrees plus decimal minutes to four places with a zero seconds field, because XMP stores them as `DDD,MM.mmmmN` and the exporter reconciles that back into EXIF.
- **Manufacturer spellings.** Samsung writes `samsung`, Nikon writes `NIKON CORPORATION` and `NIKON Z 9` with a space, Sony writes `SONY`.
- **The sun fixes the scene.** The capture hour is drawn from when people actually take pictures, then the sun's elevation at the claimed place and time is computed, and the scene brightness is chosen from it: no daylight exposures after dark. The exposure is then solved, not sampled: shutter and ISO are solved against the aperture through `N² / t = (ISO / 100) · 2^EV`, clamped to what the body can meter, and snapped to the shutter ladder. The APEX tags and `BrightnessValue` are derived from the same solution.
- **Lenses have to fit.** Bodies list the mounts they accept and lenses declare theirs. The lens is chosen before the aperture and only f-numbers it can open to are offered. `LensSpecification` carries the lens's real range, with Canon's apertures left as 0/0 as its firmware writes them. A fixed-lens body reports no lens model; F-mount Nikon glass reports through the MakerNote only, so the D850 carries no lens tags in EXIF and the export names the lens in XMP in Adobe's own `24.0-70.0 mm f/2.8` form.
- **Phone optics are per lens.** `FocalLength` carries the real focal length and `FocalLengthIn35mmFormat` the equivalent. Apple's `LensSpecification` spans every lens on the back.
- **GPS agrees with the place.** Altitude is jittered around the city's real ground elevation. `GPSTimeStamp` is UTC derived from the capture time through the city's own timezone, DST included, with matching `OffsetTimeOriginal`. Each make's GPS tag set is its own: Apple adds speed, heading, bearing and `GPSHPositioningError`; Canon adds `GPSStatus` and `GPSMapDatum`; the Android makers write `GPSVersionID` 2.2.0.0, Apple and the bodies 2.3.0.0.
- **Dates do not leak the run.** Captures are drawn from the two years before an anchor that itself sits a random one to ninety days in the past, so the latest date in a batch no longer says when the tool was run. The export follows the capture during waking hours. `Keep original date` keeps the original calendar day in the output and so links it to the original; use it only when the day is not sensitive.
- **Byte layout.** ASCII values are padded to an even length, sub-IFDs carry their next-IFD terminators, tags are sorted. Output is checked with `exiftool -validate`.

The location dataset in `js/data.js` is 58 United States cities, covering the lower 48 plus Alaska and Hawaii. Every generated photo geolocates inside the US by construction. A chosen city is jittered by up to 0.05 degrees, roughly 5 km, which keeps the coordinate inside that city's metro area and on dry land.

## Export format

- Output files are always JPEG.
- The original filename is not preserved. `getOutputName()` in `js/ui.js` generates the name Camera Raw gives an export: the source file's own name with a lowercase `.jpg` extension, so the convention follows the faked camera (`IMG_1234.jpg` for Apple and Canon, `DSC_1234.jpg` for Nikon, `DSC01234.jpg` for Sony, `DSCF1234.jpg` for Fujifilm, `20240612_141503.jpg` for Samsung, `PXL_20240612_141503123.RAW-02.ORIGINAL.jpg` for a Pixel exported from its raw). Date-based names use the faked capture time and the Pixel's millisecond field is the frame's `SubSecTime`.

## Threat model and limits

What this tool does and does not protect against, stated plainly, because the people who need it most are the ones who will be hurt by overclaiming.

- **Metadata.** Everything the original carried is gone: Exif, XMP, IPTC, MakerNote, ICC, embedded thumbnails, trailers such as Samsung's and Google's motion-photo data, C2PA manifests. The output's metadata describes a camera, place and time that are not yours.
- **Encoder fingerprints.** The browser's quantization tables, JFIF header and ICC profile are replaced with a real exporter's. Every output of this tool shares that exporter's tables and profile, as every real Camera Raw export does.
- **Sensor noise (PRNU).** The crop, rotation, resize and added noise reduce the correlation with your camera's sensor pattern substantially, but they do not guarantee it is gone against an adversary who has a reference photo set from your camera and searches over scale and rotation to re-register the pattern. Treat PRNU as weakened, not defeated.
- **Machine-learning manipulation detectors** (TruFor, Noiseprint++, CAT-Net and the like) are untested against this output. The pipeline adds the statistical traces they look for, but no claim is made that they are fooled.
- **Image content** is yours to check: faces, reflections, signage, documents, screen contents, and anything that contradicts the claimed location or season.
- **Downloads carry their origin.** Browsers record where a file came from in filesystem metadata outside the file (`Zone.Identifier` on Windows, quarantine and "where from" attributes on macOS). The file's bytes are clean; the download record is not. The offline single-file build opened from disk avoids the web origin.
- **Linking across a batch.** Each image draws its own camera, place and date. Ten photos posted together will claim ten cameras in ten cities, which is unlike a real roll; images meant to be published separately are unlinkable to each other, which is the point.

## Testing

```
node tools/check.js
```

Launches headless Chrome, processes every image in `testimg/`, and asserts the output's structure byte by byte (segment order, no JFIF, no thumbnail, correct XMP byte-order mark, no browser strings anywhere in the file), that the page made no request to any host but the test server, and, when `exiftool` is installed, that each file validates clean, that its dates, GPS, exposure and sun position are consistent, and that no browser-encoded data survives. See `tools/README.md` for the offline pixel-domain measurements.

## Runtime dependencies

Both are vendored and pinned; nothing is fetched at runtime.

- `vendor/piexif.js` — piexifjs 1.0.6, for reading EXIF back and inserting the APP1 segment. Its serialiser is replaced by `js/exif-writer.js`.
- `vendor/exifr.esm.js` — exifr 7.1.3, for parsing. `vendor/exifr.umd.js` is the same library in the form the single-file build inlines.

There is no build step for the multi-file version. `node tools/build.js` produces the single-file one.
