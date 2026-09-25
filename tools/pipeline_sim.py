"""Faithful offline port of the pixel stages in js/helpers.py, so the whole
pipeline can be measured on full-resolution real photos without going through
the browser (which would need the input re-encoded to inject it, contaminating
the very compression history we are trying to measure).

Stage order mirrors antiForensicRender: crop, rotate+scale, resize, colour
profile, ISP (S-curve + unsharp), lens (vignette + chromatic aberration),
Poisson-Gaussian noise, encode.
"""
import numpy as np
from PIL import Image

RNG = np.random.default_rng(12345)


def camera_colour(a, warmth, sat, contrast):
    a = np.clip((a - 128.0) * contrast + 128.0, 0, 255)
    a[..., 0] = np.clip(a[..., 0] + warmth, 0, 255)
    a[..., 2] = np.clip(a[..., 2] - warmth, 0, 255)
    lum = (0.2126 * a[..., 0] + 0.7152 * a[..., 1] + 0.0722 * a[..., 2])[..., None]
    return np.clip(lum + (a - lum) * sat, 0, 255)


def isp(a, curve=0.5, sharp=0.13):
    # anchored S-curve as a LUT, exactly as the JS builds it
    hs = np.sin(0.5 * np.pi * curve) or 1.0
    i = np.arange(256) / 255.0
    lut = np.clip(np.round((np.sin((i - 0.5) * np.pi * curve) / (2 * hs) + 0.5) * 255), 0, 255)
    a = lut[a.astype(np.uint8)]
    # 3x3 box blur unsharp mask
    pad = np.pad(a, ((1, 1), (1, 1), (0, 0)), mode='edge')
    blur = sum(pad[y:y + a.shape[0], x:x + a.shape[1]] for y in range(3) for x in range(3)) / 9.0
    return np.clip(a + sharp * (a - blur), 0, 255)


def lens(a, v_base=0.05, ca_frac=0.0006):
    h, w, _ = a.shape
    cy, cx = (h - 1) / 2, (w - 1) / 2
    yy, xx = np.mgrid[0:h, 0:w]
    dx, dy = xx - cx, yy - cy
    dist = np.hypot(dx, dy)
    r = dist / dist.max()
    vign = np.clip(1 - v_base * r ** 2 - v_base * 0.4 * r ** 4, 0, 1)[..., None]
    out = a * vign
    # radial chromatic aberration: red out, blue in
    shift = ca_frac * np.hypot(w, h) * r
    with np.errstate(invalid='ignore', divide='ignore'):
        nx, ny = np.where(dist > 0, dx / dist, 0), np.where(dist > 0, dy / dist, 0)
    rx = np.clip(np.round(xx + nx * shift), 0, w - 1).astype(int)
    ry = np.clip(np.round(yy + ny * shift), 0, h - 1).astype(int)
    bx = np.clip(np.round(xx - nx * shift), 0, w - 1).astype(int)
    by = np.clip(np.round(yy - ny * shift), 0, h - 1).astype(int)
    res = out.copy()
    res[..., 0] = out[ry, rx, 0]
    res[..., 2] = out[by, bx, 2]
    return np.clip(res, 0, 255)


def noise(a, iso=200):
    if iso <= 200:    base = 0.95
    elif iso <= 800:  base = 1.75
    elif iso <= 3200: base = 2.75
    else:             base = 4.0
    s2 = base * base
    ka, kb = 0.05 * s2 / 128, 0.95 * s2
    out = a.copy()
    for c, gain, rd in ((0, 1.2, 1.0), (1, 0.8, 0.7), (2, 1.2, 1.0)):
        sigma = np.sqrt(np.maximum(ka * gain * a[..., c] + kb * rd, 0))
        out[..., c] = a[..., c] + RNG.standard_normal(a.shape[:2]) * sigma
    return np.clip(out, 0, 255)


def run(src, out_path, long_edge=2160, iso=200, stages=('geom', 'colour', 'isp', 'lens', 'noise')):
    im = Image.open(src).convert('RGB')
    if 'geom' in stages:
        w, h = im.size
        im = im.crop((int(w * 0.012), int(h * 0.012), int(w * 0.988), int(h * 0.988)))
        im = im.rotate(1.3, resample=Image.BICUBIC)
        cw, ch = im.size
        z = 1.06
        im = im.crop((int(cw * (1 - 1 / z) / 2), int(ch * (1 - 1 / z) / 2),
                      int(cw * (1 + 1 / z) / 2), int(ch * (1 + 1 / z) / 2)))
    if max(im.size) > long_edge:
        s = long_edge / max(im.size)
        im = im.resize((int(im.width * s), int(im.height * s)), Image.LANCZOS)
    a = np.asarray(im, np.float64)
    if 'colour' in stages: a = camera_colour(a, warmth=-6, sat=1.08, contrast=1.04)
    if 'isp'    in stages: a = isp(a)
    if 'lens'   in stages: a = lens(a)
    if 'noise'  in stages: a = noise(a, iso)
    Image.fromarray(a.round().astype(np.uint8)).save(out_path, 'JPEG', quality=100, subsampling=0)
    return out_path


if __name__ == '__main__':
    import sys
    src = sys.argv[1] if len(sys.argv) > 1 else 'samples/pixel7a_0.jpg'
    run(src, 'sim_full.jpg')
    run(src, 'sim_nonoise.jpg', stages=('geom', 'colour', 'isp', 'lens'))
    run(src, 'sim_geomonly.jpg', stages=('geom',))
    run(src, 'sim_noiseonly.jpg', stages=('noise',))
    print('  wrote sim_full / sim_nonoise / sim_geomonly / sim_noiseonly')
