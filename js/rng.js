/**
 * rng.js — One random source for everything the tool draws.
 *
 * Every choice in the output, from the camera to the per-pixel noise, used to
 * come from Math.random, whose state is per page and in principle
 * reconstructible from enough observed draws. Nothing here is believed to be
 * exploitable that way, but a privacy tool should not have to argue the
 * point. All draws now come from crypto.getRandomValues, refilled in blocks so
 * the pixel loops, which draw tens of millions of times, stay fast.
 */

const BUF = new Uint32Array(8192);
let pos = BUF.length;

/** Uniform float in [0, 1). */
export function rnd() {
  if (pos >= BUF.length) { crypto.getRandomValues(BUF); pos = 0; }
  return BUF[pos++] / 4294967296;
}

/** Integer in [lo, hi], inclusive. */
export const randInt = (lo, hi) => lo + Math.floor(rnd() * (hi - lo + 1));

/** One element of a non-empty array. */
export const pick = a => a[Math.floor(rnd() * a.length)];
