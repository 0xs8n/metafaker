# MetaFaker — project guide

MetaFaker is a client-side privacy tool for photos people share. It removes
what identifies the person who shared an image: the GPS position, the time, the
device, and the camera's sensor pattern in the pixels. It either strips the
metadata or replaces it with a consistent, generated set that does not point to
the user. See `README.md` for the full design and threat model.

## Language

Describe the project in privacy terms: protecting people, removing identifying
information, preventing photos from being linked back to their owner or to each
other. Do not frame it as evading, defeating, fooling or bypassing anything, and
avoid words like "anti-forensic", "spoof", "tamper" or "investigator" in code,
comments, docs and UI text. Technical terms that describe what is measured
(sensor pattern, PRNU, statistical trace, image analysis) are fine.

## Requirements that must hold

- **Generated GPS is always inside the United States.** Locations come only from
  the US city list in `js/data.js`; `tools/check.js` asserts the range.
- **Every image gets its own independent identity**, including in a batch: its
  own camera, lens, city, dates, editor version and filename. Nothing shared
  across images that could link them to each other or to one person.
- **A non-photo is never given a camera, lens or location.** `js/classify.js`
  decides photo vs. screenshot/graphic before anything is generated.
- **One pipeline, no user-facing modes.** The output presents as an Adobe Camera
  Raw (camera bodies) or Lightroom (phones) export.
- **Match real exports, imperfections included.** A genuine Adobe export does
  not pass `exiftool -validate`; the output must produce the same warnings and
  no others, not validate clean.
- **The page makes no third-party network request.** Libraries are vendored,
  icons are inline SVG, and `vendor/piexif.js` is pinned by an SRI hash.
  `.gitattributes` keeps `vendor/` byte-exact; never let line-ending conversion
  touch it.
- **Facts are measured, not invented.** Camera and Adobe values in `js/data.js`
  and `js/provenance.js` come from real files. Don't add a value without a source.
- **All randomness goes through `js/rng.js`** (`crypto.getRandomValues`).
- **Be honest about limits.** The threat model in the README states what is and
  is not proven. Don't claim more than has been measured.

## Commands

    node tools/check.js                  # end-to-end harness (headless Chrome; exiftool if installed)
    node tools/build.js                  # rebuild dist/metafaker.html; run after any source change
    node tools/stress.js <in> <out>      # edge-case inputs through both paths

Node 22+, no npm dependencies. The tools drive headless Chrome over the DevTools
protocol through `tools/lib/cdp.js`. `dist/metafaker.html` is generated: edit the
sources and rebuild, never edit it by hand.
