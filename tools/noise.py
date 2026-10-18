"""Noise character: how colourful and how fine-grained a photo's noise is.

A camera's noise does not reach the file as three independent channels. The
sensor samples one colour per photosite, demosaicing spreads each sample across
all three channels and across neighbouring pixels, and the raw converter's
colour noise reduction (Camera Raw and Lightroom default to 25) smooths what
chroma noise remains. So in a real export the noise is mostly luminance, its
R, G and B parts move together, and it is spatially correlated over a pixel or
two. Noise drawn independently per channel and per pixel is none of those.

Measured on the flattest mid-tone 16x16 blocks of each image (where the
residual is noise rather than detail), against a Gaussian-blurred copy:

  chroma  RMS of the Cb/Cr residual over the Y residual (0 = no colour noise)
  rgbcorr mean correlation between the R, G and B residuals (1 = moving together)
  lag1    lag-1 autocorrelation of the Y residual (higher = coarser grain)
  sigmaY  the Y residual's standard deviation, in 8-bit levels

    python tools/noise.py a.jpg b.jpg ...
    python tools/noise.py --summary a.jpg b.jpg ...   # median and IQR only
"""
import sys, os
import numpy as np
from PIL import Image
from scipy.ndimage import gaussian_filter

BLOCK = 16


def measure(path, max_side=2400, keep=0.08):
    im = Image.open(path).convert('RGB')
    if max(im.size) > max_side:                 # crop, never resize: resizing
        w, h = im.size                          # reshapes the very noise measured
        l, t = (w - max_side) // 2, (h - max_side) // 2
        im = im.crop((max(0, l), max(0, t), max(0, l) + min(w, max_side), max(0, t) + min(h, max_side)))
    x = np.asarray(im, np.float64)
    r, g, b = x[..., 0], x[..., 1], x[..., 2]
    y  =  0.299 * r + 0.587 * g + 0.114 * b
    cb = -0.168736 * r - 0.331264 * g + 0.5 * b
    cr =  0.5 * r - 0.418688 * g - 0.081312 * b

    def hp(c):
        return c - gaussian_filter(c, 1.0)

    res = {k: hp(v) for k, v in (('y', y), ('cb', cb), ('cr', cr), ('r', r), ('g', g), ('b', b))}
    smooth = gaussian_filter(y, 2.0)
    gy, gx = np.gradient(smooth)
    grad = np.hypot(gx, gy)

    H, W = (y.shape[0] // BLOCK) * BLOCK, (y.shape[1] // BLOCK) * BLOCK
    if H == 0 or W == 0:
        raise ValueError('image too small')

    def blocks(a):
        return a[:H, :W].reshape(H // BLOCK, BLOCK, W // BLOCK, BLOCK).swapaxes(1, 2).reshape(-1, BLOCK, BLOCK)

    gb = blocks(grad).mean(axis=(1, 2))
    mb = blocks(y).mean(axis=(1, 2))
    ok = (mb > 40) & (mb < 215)
    if ok.sum() < 20:
        raise ValueError('too few mid-tone blocks')
    idx = np.where(ok)[0]
    idx = idx[np.argsort(gb[idx])][:max(20, int(len(idx) * keep))]

    B = {k: blocks(v)[idx][:, 1:-1, 1:-1] for k, v in res.items()}   # drop the blur's block-edge bleed
    sy = B['y'].std()
    chroma = np.sqrt((B['cb'].var() + B['cr'].var()) / 2) / sy
    def corr(a, c):
        a, c = a.ravel() - a.mean(), c.ravel() - c.mean()
        return float((a * c).sum() / np.sqrt((a * a).sum() * (c * c).sum()))
    rgbcorr = (corr(B['r'], B['g']) + corr(B['g'], B['b']) + corr(B['r'], B['b'])) / 3
    yb = B['y']
    lag1 = (corr(yb[:, :, :-1], yb[:, :, 1:]) + corr(yb[:, :-1, :], yb[:, 1:, :])) / 2
    return {'chroma': float(chroma), 'rgbcorr': rgbcorr, 'lag1': lag1, 'sigmaY': float(sy)}


KEYS = ('chroma', 'rgbcorr', 'lag1', 'sigmaY')

if __name__ == '__main__':
    args = sys.argv[1:]
    summary = '--summary' in args
    paths = [a for a in args if a != '--summary']
    rows = []
    if not summary:
        print(f"  {'file':34} " + ' '.join(f'{k:>8}' for k in KEYS))
    for p in paths:
        try:
            m = measure(p)
        except Exception as e:
            print(f"  {os.path.basename(p):34} error {e}", file=sys.stderr)
            continue
        rows.append(m)
        if not summary:
            print(f"  {os.path.basename(p):34} " + ' '.join(f'{m[k]:8.3f}' for k in KEYS))
    if rows:
        print(f"  n={len(rows)}  median [IQR]")
        for k in KEYS:
            v = np.array([r[k] for r in rows])
            q1, q2, q3 = np.percentile(v, [25, 50, 75])
            print(f"    {k:8} {q2:7.3f}  [{q1:.3f} – {q3:.3f}]")
