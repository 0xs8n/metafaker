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
