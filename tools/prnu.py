"""PRNU survival measurement for the shipped pipeline.

Sensor-pattern (PRNU) correlation is the strongest link between a photo and the
specific camera that took it. This measures how well that link survives the
tool's pixel pipeline, using the real shipped code (via tools/prnu-process.js)
and a synthetic sensor fingerprint we control, so the number is grounded rather
than asserted.

Method, standard PRNU analysis:
  1. Build a fingerprint K (a fixed multiplicative noise field) for one
     "camera", and a different K2 for an unrelated camera.
  2. Make N textured content images. Stamp K into them (img*(1+K)) and save as
     high-quality JPEG: these are that camera's originals. Stamp K2 into a
     second set: an unrelated camera's originals.
  3. Estimate the fingerprint K_hat from the camera's originals (average of
     their noise residuals) — the reference anyone with access to the camera
     could build to link photos to it.
  4. Run every original through the shipped pipeline (prnu-process.js).
  5. For each processed image, measure the peak-to-correlation energy (PCE)
     between its residual and K_hat, searching over small scale/rotation/shift
     to re-align — the strongest form of the linking the pipeline is meant to
     prevent.

Reported:
  - baseline PCE   : K_hat vs the camera's own ORIGINALS (match, pre-pipeline)
  - processed PCE  : K_hat vs the camera's PROCESSED images (what survives)
  - unrelated PCE  : K_hat vs the OTHER camera's processed images (true non-match)
An image is normally treated as a match at PCE >= 60. The pipeline
succeeds when processed PCE falls to the non-match floor.

Requires numpy, scipy, pillow, and Node. Run from the repo root:
    python tools/prnu.py
"""
import os, sys, subprocess, tempfile, shutil
import numpy as np
from numpy.fft import fft2, ifft2
from PIL import Image
from scipy.ndimage import gaussian_filter, zoom, rotate

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RNG = np.random.default_rng(20261017)
SIZE = 768           # content size; below the pipeline's resize threshold so geometry stays close
N = 10               # originals per camera
PCE_THRESHOLD = 60.0 # standard PRNU match threshold


# ── fingerprint & content ────────────────────────────────────────

def fingerprint(h, w, strength=0.015):
    """A fixed, zero-mean, unit-ish PRNU field."""
    k = RNG.standard_normal((h, w)).astype(np.float64)
    k = gaussian_filter(k, 0.5)                 # mild correlation, as real PRNU has
    k -= k.mean()
    k /= k.std()
    return k * strength


def content(h, w):
    """Broadband textured grey image in [16, 239], like a real photo's luma."""
    base = RNG.standard_normal((h, w))
    img = np.zeros((h, w))
    for s in (64, 24, 8, 3):                    # multi-scale structure + fine texture
        img += gaussian_filter(RNG.standard_normal((h, w)), s) * s
    img += base * 2.0
    img -= img.min(); img /= img.max()
    return 16 + img * 223


def residual(gray):
    """Noise residual = image minus a denoised estimate (high-pass)."""
    den = gaussian_filter(gray, 1.2)
    w = gray - den
    # zero-mean rows and columns to suppress linear-pattern / JPEG-grid leakage
    w -= w.mean(axis=0, keepdims=True)
    w -= w.mean(axis=1, keepdims=True)
    return w


def pce(w, k):
    """Peak-to-correlation energy of the normalised cross-correlation of w and k."""
    h, wd = min(w.shape[0], k.shape[0]), min(w.shape[1], k.shape[1])
    a = w[:h, :wd]; b = k[:h, :wd]
    a = a - a.mean(); b = b - b.mean()
    na, nb = np.linalg.norm(a), np.linalg.norm(b)
    if na == 0 or nb == 0:
        return 0.0
    cc = np.real(ifft2(fft2(a) * np.conj(fft2(b))))
    cc /= (na * nb)
    peak_idx = np.unravel_index(np.argmax(np.abs(cc)), cc.shape)
    peak = cc[peak_idx]
    # energy excluding an 11x11 neighbourhood around the peak
    mask = np.ones_like(cc, dtype=bool)
    py, px = peak_idx
    for dy in range(-5, 6):
        for dx in range(-5, 6):
            mask[(py + dy) % cc.shape[0], (px + dx) % cc.shape[1]] = False
    energy = np.mean(cc[mask] ** 2)
    if energy == 0:
        return 0.0
    return float(np.sign(peak) * peak * peak / energy)


def pce_registered(w, k):
    """Max PCE over the strongest realistic linking attempt: resize the
    fingerprint k to the residual's size (the output dimensions are known),
    then search a fine scale/rotation grid; translation is handled by the FFT."""
    if k.shape != w.shape:
        k = zoom(k, (w.shape[0] / k.shape[0], w.shape[1] / k.shape[1]), order=1)
    best = -1e9
    for sc in (0.94, 0.97, 1.0, 1.03, 1.06):
        ws = zoom(w, sc, order=1) if sc != 1.0 else w
        for ang in (-2.0, -1.0, 0.0, 1.0, 2.0):
            wr = rotate(ws, ang, reshape=False, order=1) if ang != 0.0 else ws
            best = max(best, pce(wr, k))
    return best


# ── run ──────────────────────────────────────────────────────────

def gray(path):
    im = Image.open(path).convert('RGB')
    a = np.asarray(im, np.float64)
    return 0.299 * a[..., 0] + 0.587 * a[..., 1] + 0.114 * a[..., 2]


def make_set(k, folder, n):
    os.makedirs(folder, exist_ok=True)
    paths = []
    for i in range(n):
        c = content(SIZE, SIZE)
        img = np.clip(c * (1 + k), 0, 255).astype(np.uint8)
        p = os.path.join(folder, f'img_{i:02d}.jpg')
        Image.fromarray(img, 'L').convert('RGB').save(p, 'JPEG', quality=98, subsampling=0)
        paths.append(p)
    return paths


def main():
    tmp = tempfile.mkdtemp(prefix='prnu_')
    try:
        K = fingerprint(SIZE, SIZE)
        K2 = fingerprint(SIZE, SIZE)            # unrelated camera

        cam_in = os.path.join(tmp, 'cam_in');   cam_paths = make_set(K, cam_in, N)
        oth_in = os.path.join(tmp, 'oth_in');   make_set(K2, oth_in, N)

        # Fingerprint estimate K_hat from the camera's own originals.
        K_hat = np.mean([residual(gray(p)) for p in cam_paths], axis=0)

        # Baseline: the originals themselves (pre-pipeline) must be a strong match.
        base_pce = [pce_registered(residual(gray(p)), K_hat) for p in cam_paths]

        # Run both sets through the shipped pipeline.
        print('processing camera originals through the shipped pipeline...')
        cam_out = os.path.join(tmp, 'cam_out')
        subprocess.run(['node', os.path.join('tools', 'prnu-process.js'), cam_in, cam_out],
                       cwd=ROOT, check=True)
        print('processing unrelated-camera originals...')
        oth_out = os.path.join(tmp, 'oth_out')
        subprocess.run(['node', os.path.join('tools', 'prnu-process.js'), oth_in, oth_out],
                       cwd=ROOT, check=True)

        proc_pce = [pce_registered(residual(gray(os.path.join(cam_out, f))), K_hat)
                    for f in sorted(os.listdir(cam_out)) if f.endswith('.jpg')]
        oth_pce = [pce_registered(residual(gray(os.path.join(oth_out, f))), K_hat)
                   for f in sorted(os.listdir(oth_out)) if f.endswith('.jpg')]

        def row(label, vals):
            vals = np.array(vals)
            hits = int((vals >= PCE_THRESHOLD).sum())
            print(f'  {label:42} median {np.median(vals):8.1f}   max {vals.max():8.1f}   '
                  f'>= {PCE_THRESHOLD:.0f}: {hits}/{len(vals)}')

        print()
        print(f'PRNU peak-to-correlation energy (match threshold {PCE_THRESHOLD:.0f}); {N} images per camera')
        row('baseline: originals vs own fingerprint', base_pce)
        row('after pipeline: processed vs fingerprint', proc_pce)
        row('control: other camera processed vs fingerprint', oth_pce)
        print()
        survived = int((np.array(proc_pce) >= PCE_THRESHOLD).sum())
        floor = np.median(oth_pce)
        if survived == 0 and np.median(proc_pce) <= floor + 15:
            print('  RESULT: the fingerprint does not survive the pipeline — processed images '
                  'fall to the non-match floor.')
        else:
            print(f'  RESULT: {survived}/{len(proc_pce)} processed images still match; '
                  'the pipeline does not fully break the correlation here.')
        print()
        print('  Caveat: a synthetic fingerprint and a high-pass residual estimator, not a '
              'full PRNU suite (no Wiener/zero-mean wavelet denoise, no real sensor). It '
              'measures the shipped pipeline on a controllable fingerprint; a real sensor '
              'pattern and a production estimator may behave differently.')
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


if __name__ == '__main__':
    main()
