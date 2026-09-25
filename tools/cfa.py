"""CFA / demosaicing periodicity.

A sensor measures one colour per photosite and interpolates the rest, so in an
unresampled camera JPEG the interpolated pixels carry a smaller prediction
residual than the measured ones, on a 2x2 lattice. Resizing destroys it.
Reported as the ratio between the strongest and weakest of the four phases:
~1.0 means no CFA trace survives.
"""
import numpy as np
from PIL import Image
import sys, os

def cfa_ratio(path, max_side=1600):
    im = Image.open(path).convert('RGB')
    if max(im.size) > max_side:                 # crop, never resize: resizing would
        w, h = im.size                          # destroy the very signal we measure
        l, t = (w - max_side)//2, (h - max_side)//2
        im = im.crop((max(0,l), max(0,t), max(0,l)+min(w,max_side), max(0,t)+min(h,max_side)))
    g = np.asarray(im, np.float64)[..., 1]      # green carries the densest CFA pattern
    # Laplacian prediction residual
    r = np.abs(4*g[1:-1,1:-1] - g[:-2,1:-1] - g[2:,1:-1] - g[1:-1,:-2] - g[1:-1,2:])
    phases = [r[y::2, x::2].mean() for y in range(2) for x in range(2)]
    lo, hi = min(phases), max(phases)
    return hi / lo if lo > 0 else float('nan')

if __name__ == '__main__':
    print(f"  {'file':28} {'CFA phase ratio':>16}   interpretation")
    for p in sys.argv[1:]:
        try:
            v = cfa_ratio(p)
            note = 'CFA trace present' if v > 1.06 else 'no CFA trace (resampled)'
            print(f"  {os.path.basename(p):28} {v:16.4f}   {note}")
        except Exception as e:
            print(f"  {os.path.basename(p):28} error {e}")
