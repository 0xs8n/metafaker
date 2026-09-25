# metafaker

MetaFaker is a static browser application for loading one or many images, re-encoding them as JPEG, and either stripping EXIF metadata or replacing it with a generated metadata set. The app is fully client-side. There is no backend, no upload step, and no cloud storage in the current version.

## Current behavior

- Accepts multiple images from drag and drop or the file picker.
- Builds a local batch queue with previews and per-image state.
- Parses original EXIF locally in the browser.
- Re-encodes each processed image as a new JPEG.
- Either strips metadata entirely or injects a generated EXIF block.
- Downloads processed files locally under a filename matching the generated camera brand.

## Architecture

The application is split into small browser modules:

- `index.html`
  Defines the UI shell, upload zone, preview panel, action buttons, metadata panel, and the single metadata tab.
- `css/style.css`
  Provides the layout, responsive batch queue, preview card styling, metadata table styling, and toast notifications.
- `js/main.js`
  Bootstraps the app, initializes theme state, and wires drag/drop plus file input events to the controller.
- `js/ui.js`
  Owns application state, queue management, rendering, downloads, and the high-level processing workflow.
- `js/exif.js`
  Generates fake EXIF data, parses source EXIF, verifies written metadata, formats values for display, and normalizes GPS output.
- `js/data.js`
  Contains the static camera database, the international location database, and lens mapping data used for internally consistent fake metadata.
- `js/helpers.js`
  Provides shared utilities such as ID generation, byte formatting, GPS conversion helpers, blob/data URL helpers, and the canvas export pipeline.

## Processing pipeline

For each loaded file, the app follows this flow:

1. The browser reads the input file locally and creates an object URL for previewing.
2. `exifr` parses the original metadata from the input file.
3. When the user clicks `Randomize Current` or `Randomize Entire Batch`, the image goes through the canvas pipeline in `js/helpers.js` and is exported as a fresh JPEG.
4. `generateFake()` builds a camera profile, lens data, timestamps, exposure values, and a location from the static datasets.
5. `piexifjs` writes that EXIF block into the freshly exported JPEG.
6. A second GPS pass rewrites the latitude and longitude tags with consistent hemisphere references.
7. The app reads the resulting JPEG back once more to verify that metadata was written successfully before making the output available for preview or download.

The `Strip Current Metadata` path uses the same canvas export step but skips EXIF injection and leaves the output JPEG without metadata.

### Canvas pipeline

The canvas export is not a plain re-encode. Each image passes through these stages, in order, so that the output does not carry the sensor and encoder fingerprints of the original:

1. Proportional crop of up to 1.2% per edge, which shifts the PRNU grid alignment.
2. Rotation of 0.5 to 2.0 degrees in either direction, with a scale factor that keeps the frame filled.
3. Resize to one of six target long-edge resolutions.
4. Per-brand colour profile: warmth, saturation, and contrast matched to the generated camera make.
5. ISP simulation: an anchored S-curve tone mapping plus a light unsharp mask.
6. Lens optics: radial vignetting and sub-pixel chromatic aberration.
7. Poisson-Gaussian sensor noise scaled to the generated ISO value.
8. JPEG encode at a randomised quality, then removal of the two segments that identify the browser's encoder: the JFIF `APP0` marker, and the `APP2` ICC profile, which is byte-identical on every image Chrome encodes and names the browser vendor in its copyright string. A non-ICC `APP2` such as MPF is left alone.

## Metadata generation

The generated EXIF data is built from static profiles rather than arbitrary free-form values. The intent is internal consistency between related fields, because the cheapest way to detect fabricated metadata is not to find a wrong value but to find two values that contradict each other.

Examples of fields that are generated together:

- camera make, model, and software
- lens make and lens model
- shutter speed, aperture, ISO, focal length, and 35 mm equivalent focal length
- white balance, flash, metering mode, exposure program, and exposure mode
- capture timestamps including sub-second precision
- GPS latitude, longitude, altitude, date stamp, and time stamp

### Provenance

The output is written as a photo exported from Adobe Camera Raw, not as a camera original, and that is deliberate.

A camera original has to carry a MakerNote. Real ones are large and specific — a Sony body writes 103 tags, a Pixel writes 22 plus a 72 KB binary blob and a container declaring embedded depth and gain maps that have to actually exist. None of that can be synthesised convincingly, and a partial one is worse than none, because it is affirmative evidence of tampering rather than the ordinary absence that any editor produces.

An export is a story the file can tell completely. Every Canon EOS R5 image sampled on Wikimedia Commons was one: camera `Make` and `Model` intact, `Software` naming the editor, zero MakerNote tags, and 6021x3783 against a native 8192x5464. Photographers shoot raw and export, so this is among the most common files that exist — and it is structurally what our output already was.

Measured from a real Camera Raw export and applied: its quantization tables, the 3144-byte HP sRGB profile it embeds, its `APP14` marker placed immediately before `SOF`, an XMP packet with matching `CreatorTool`, dates and `xmpMM` identifiers, and single `DQT` and `DHT` segments rather than split ones. Encoding is at quality 1.0 because that is the only setting at which the browser emits 4:4:4 chroma, which is what an export uses.

Camera make, model, exposure, optics, GPS and timestamps are unchanged — an export preserves all of them.

Not reproduced: the `APP13` Photoshop block, which carries the original photographer's own embedded thumbnail and IPTC, and the restart interval.

### Consistency rules

- **Manufacturer spellings.** Each profile stores the string the device actually writes, which is often not the marketing name: Samsung writes `samsung` in lowercase, Nikon writes `NIKON CORPORATION` and `NIKON Z 9` with a space, Sony writes `SONY`. Apple writes a bare version in `Software` (`17.4.1`), while Android phones write a build fingerprint or an HDR+ pipeline version.
- **Exposure is solved, not sampled.** A scene brightness in EV is drawn first, weighted toward daylight, then shutter and ISO are solved against the chosen aperture through `N² / t = (ISO / 100) · 2^EV`. Independent picks produced triplets no scene can produce. The scene is clamped to what that body can actually meter, and the leftover rounding from snapping to the shutter ladder is kept, since real EXIF is not algebraically exact either.
- **Lenses have to fit.** Bodies list the mounts they accept and lenses declare theirs, so a 5D Mark IV is never paired with an RF mirrorless lens nor a D850 with a NIKKOR Z. The lens is chosen before the aperture and only f-numbers it can open to are offered, so an f/4 zoom cannot report f/1.2. A fixed-lens body such as the X100VI reports no lens model at all, because it has no interchangeable lens to name.
- **Phone optics are per lens.** A phone's focal length and aperture belong to one fixed lens, so they are chosen as a unit. `FocalLength` carries the real focal length in mm and `FocalLengthIn35mmFormat` the equivalent — a phone reporting 26 mm in both was claiming a lens that does not fit in a handset. Bodies derive the equivalent from their sensor crop, so an APS-C camera reports 23 mm actual and 35 mm equivalent.
- **GPS agrees with the place.** Altitude is jittered around the city's real ground elevation rather than randomised, and `GPSTimeStamp` is UTC derived from the capture time through that city's own timezone, DST included, alongside a matching `OffsetTimeOriginal`. Deriving it from the machine clock previously leaked the real timezone of whoever ran the tool.
- **An IFD1 thumbnail is embedded**, rendered from the processed output so it matches the full-size image. Most camera JPEGs carry one, and a thumbnail that disagrees with the image it is inside is what exposes edited photos.
- **Apple images carry a MakerNote** (`js/makernote.js`), whose values track the rest of the frame — colour temperature follows the scene, signal-to-noise follows ISO, camera type follows the lens. Only Apple's is synthesised, because only its internal offsets are relative to the MakerNote itself and therefore survive the EXIF being rewritten at a different position. Read the header comment in that file before extending it: a missing MakerNote is consistent with ordinary processing, while a synthesised one is not consistent with anything but synthesis if compared against real files from the same model.
- **Byte layout.** ASCII values are padded to an even length, because TIFF expects values on word boundaries and piexifjs does not pad — one odd-length string put every later value on an odd offset, which `exiftool -validate` reports on every file and which is a signature of the writer rather than of a camera.

- **The TIFF block is written by `js/exif-writer.js`**, not by piexifjs. piexifjs omits the four-byte next-IFD terminator on the Exif and GPS sub-IFDs, so a reader takes the first value to be that pointer, and it never pads between values. Both faults were identical on every file it wrote, which made them a signature of the writer. The replacement emits the same dictionary shape and falls back to piexifjs if it cannot vouch for its own output.

Output is checked with `exiftool -validate`, which reports `OK` for all nine camera makes.

The location dataset in `js/data.js` is 58 United States cities, covering the lower 48 plus Alaska and Hawaii. Every generated photo geolocates inside the US by construction: international cities were removed from the dataset rather than filtered when picking, so no code path can select one.

A chosen city is jittered by up to 0.05 degrees, roughly 5 km, which keeps the coordinate inside that city's metro area. The earlier 0.3 degrees moved a point as much as 33 km and put coastal cities out at sea — Miami landed 30 km into the Atlantic — and a photo whose GPS falls in open water is a louder signal than one that repeats a city.

## Export format

- Output files are always JPEG.
- The original filename is not preserved. `getOutputName()` in `js/ui.js` generates a name in the convention of the faked camera brand: `IMG_1234.jpg` for Apple, `PXL_20240612_141503123.jpg` for Google, `DSC_1234.JPG` for Nikon, and so on.
- For date-based naming schemes, the filename date is taken from the faked `DateTimeOriginal` so the two agree.

The canvas export pipeline in `js/helpers.js` creates a fresh JPEG bitmap and may resize large inputs before export. This keeps the processing path uniform and avoids depending on the original container format.

## Runtime dependencies

The app is static, but it relies on two browser-loaded libraries:

- `piexifjs` from jsDelivr for binary EXIF writing, pinned to 1.0.6 with a subresource integrity hash
- `exifr` from jsDelivr for EXIF parsing and readback verification, imported as an ES module and pinned to 7.1.3

There is no build step. Opening `index.html` through a static host is sufficient.

## Local state

The app stores only theme preference in `localStorage` under the `metafaker.theme` key.

Processed images, previews, and queue state live in memory for the active tab only. Resetting the queue revokes object URLs and clears that in-memory state.

## Development notes

- The app is meant to run as a static site.
- There is no server-side API surface.
- The queue and preview logic are optimized to avoid rendering every thumbnail at full cost for large mobile batches.
- The metadata panel always shows either original EXIF, generated EXIF, or an explicit stripped state for the selected image.

## Hosting

Because the project is fully static, it can be hosted on any simple static host such as GitHub Pages. No environment variables or API keys are required for the current local-only version.
