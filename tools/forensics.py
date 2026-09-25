"""Pixel-domain forensic measures, for comparing our output against real files.

Three standard detectors, chosen because they are content-robust enough to
compare across different pictures:

  resample   Popescu-Farid style. Resizing or rotating an image makes each
             pixel a fixed linear combination of its neighbours, which leaves a
             periodic pattern in the prediction residual. Reported as the
             strongest off-DC peak in the residual's spectrum, normalised by the
             mean. High means "this was resampled".

  blockiness Ratio of pixel differences across 8x8 block boundaries to those
             inside blocks. JPEG quantisation makes boundaries discontinuous;
             the ratio rises with each compression and with lower quality.

  ghost      Recompress at a sweep of qualities and measure the error. A singly
             compressed image gives a smooth curve; one that was already
             compressed at some quality dips there. Reported as the depth of
             the deepest local dip, so higher means "compressed more than once".
"""
import numpy as np
from PIL import Image
import io


def _luma(path, max_side=1400):
    im = Image.open(path).convert('RGB')
    if max(im.size) > max_side:                    # keep runtimes sane
        s = max_side / max(im.size)
        im = im.resize((int(im.width * s), int(im.height * s)), Image.LANCZOS)
    a = np.asarray(im, np.float64)
    return 0.299 * a[..., 0] + 0.587 * a[..., 1] + 0.114 * a[..., 2], im


def resample_peak(y):
    """Strongest periodic component in the second-difference residual."""
    # second difference along each axis kills smooth content, keeps interpolation
    rx = y[:, 2:] - 2 * y[:, 1:-1] + y[:, :-2]
    ry = y[2:, :] - 2 * y[1:-1, :] + y[:-2, :]
    out = []
    for r, axis in ((rx, 1), (ry, 0)):
        v = np.abs(r).mean(axis=axis)              # 1-D profile of residual energy
        v = v - v.mean()
        if v.size < 64 or not np.isfinite(v).all():
            out.append(0.0); continue
        w = np.hanning(v.size)
        sp = np.abs(np.fft.rfft(v * w))
        sp[:3] = 0                                  # ignore DC / very low freq
        if sp.max() <= 0: out.append(0.0); continue
        out.append(float(sp.max() / (sp.mean() + 1e-9)))
    return max(out)


def blockiness(y):
    """Cross-boundary vs interior gradient energy on the 8x8 grid."""
    d = np.abs(np.diff(y, axis=1))
    cols = np.arange(d.shape[1])
    on = d[:, cols % 8 == 7]                        # boundary columns
    off = d[:, cols % 8 != 7]
    if off.size == 0 or off.mean() == 0: return 0.0
    return float(on.mean() / off.mean())


def ghost(path, qualities=range(45, 100, 5)):
    """Depth of the deepest dip in the recompression-error curve."""
    im = Image.open(path).convert('RGB')
    if max(im.size) > 900:
        s = 900 / max(im.size)
        im = im.resize((int(im.width * s), int(im.height * s)), Image.LANCZOS)
    base = np.asarray(im, np.float64)
    errs = []
    for q in qualities:
        b = io.BytesIO()
        im.save(b, 'JPEG', quality=int(q), subsampling=0)
        r = np.asarray(Image.open(io.BytesIO(b.getvalue())).convert('RGB'), np.float64)
        errs.append(((base - r) ** 2).mean())
    e = np.array(errs)
    # a dip is a point below the straight line joining its neighbours
    dips = []
    for i in range(1, len(e) - 1):
        expected = (e[i - 1] + e[i + 1]) / 2
        if expected > 0:
            dips.append(max(0.0, (expected - e[i]) / expected))
    return float(max(dips)) if dips else 0.0


def measure(path):
    y, _ = _luma(path)
    return {
        'resample': round(resample_peak(y), 1),
        'blockiness': round(blockiness(y), 3),
        'ghost': round(ghost(path), 4),
    }


if __name__ == '__main__':
    import sys, os
    rows = []
    for p in sys.argv[1:]:
        try:
            m = measure(p)
            rows.append((os.path.basename(p), m))
        except Exception as e:
            rows.append((os.path.basename(p), {'error': str(e)[:40]}))
    print(f"  {'file':26} {'resample':>9} {'blockiness':>11} {'ghost':>8}")
    for name, m in rows:
        if 'error' in m:
            print(f"  {name:26} {m['error']}")
        else:
            print(f"  {name:26} {m['resample']:9.1f} {m['blockiness']:11.3f} {m['ghost']:8.4f}")
