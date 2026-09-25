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

The generated EXIF data is built from static profiles rather than arbitrary free-form values. The intent is internal consistency between related fields.

Examples of fields that are generated together:

- camera make, model, and software
- lens make and lens model
- shutter speed, aperture, ISO, focal length, and 35 mm equivalent focal length
- white balance, flash, metering mode, exposure program, and exposure mode
- capture timestamps including sub-second precision
- GPS latitude, longitude, altitude, date stamp, and time stamp

The location dataset in `js/data.js` covers cities across North America, Europe, Asia-Pacific, Australia, Latin America, and the Middle East. A chosen city is jittered by up to 0.3 degrees in each direction, and `js/exif.js` clamps the result to valid global ranges and derives the matching N/S and E/W references.

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
