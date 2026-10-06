/**
 * Canonical brand mark (issue #13).
 *
 * The mark is a 1-bit dithered dog head drawn white on a solid black ground.
 * `public/logo.png` is the approved reference asset (600x600, no transparent
 * padding: the mark is cropped flush to the top and bottom of its square, and
 * insets ~20px left / ~19px right). It stays the raster reference for the
 * social card and Organization metadata.
 *
 * This module holds the deliberate *small-size variant* of that mark: a
 * flat-fill silhouette, derived once from the canonical raster because below
 * roughly 48px a halftone stops reading as tone. At favicon and header sizes
 * the dots smear into noise and the interior shading (eyes, muzzle shadow)
 * disappears, so the small cut drops them for an outline that survives 16px.
 *
 * Derivation of MARK_PATH (from `public/logo.png`, 600x600):
 *   1. dilate the 1-bit dots (9px max filter) to bridge the halftone cells;
 *   2. flood-fill the exterior from all four corners - the mark is flush with
 *      the top and bottom edges, so its exterior is two separate regions and
 *      the right-hand one is enclosed-looking from the top-left alone;
 *   3. erode back to the dot envelope (7px min filter) and smooth (sigma 2.5);
 *   4. trace the single resulting contour with marching squares at 0.5 and
 *      simplify it (Ramer-Douglas-Peucker, ~1.5px).
 * The result is one closed path with no holes, IoU 0.996 against the extracted
 * mask, and it keeps the canonical crop exactly: flush with y=0 and y=600,
 * x=19..578 against the raster's dot envelope of x=19..578. Nothing is
 * redrawn by hand, and no other file carries a copy of the shape: the header
 * lockup, /favicon.svg, and the raster tile artifacts all render this path.
 *
 * If the mark changes, re-derive the silhouette, replace MARK_PATH, and
 * regenerate `public/favicon-32.png` and `public/apple-touch-icon.png` with
 * the tile recipe documented in DESIGN.md ("Brand mark").
 */

/** The mark's own frame, matching `public/logo.png` 1:1. */
export const MARK_VIEW_BOX = '0 0 600 600';

/** Flat-fill silhouette of the canonical mark, in MARK_VIEW_BOX coordinates. */
export const MARK_PATH =
  'M195 0 191 4.5 169 11.4 146 22.9 120 46.3 94.7 100 55 165 52.8 176 58.4 191 ' +
  '55.5 203 49 211.8 29 228.2 23.1 238 26.4 260 18.7 300 18.7 325 25.1 359 39.9 390 ' +
  '40.8 407 44.2 414 50.9 456 60.2 481 56.6 499 55.2 551 62 561.2 75 565.6 97 548.7 ' +
  '106 536 119.8 496 132 486.7 138.3 488 148 501.3 171 519.9 191 520.8 202 525.6 218 ' +
  '524.8 243 532.4 258 533.2 291 511 315 504.8 327 504.7 361 513.7 370 519.1 379.7 533 ' +
  '389.2 542 395.5 554 400.3 574 401 590 404.5 599 411 599.5 460.6 599 464 593.9 498 ' +
  '584 511 575.1 531.5 541 534.9 528 543.1 519 550 499.5 571.6 458 578.4 410 576.3 360 ' +
  '564 313 554.8 292 552.2 271 546.8 252 549.6 238 548.3 212 545 201 536.4 187 533.5 ' +
  '174 520 156.3 507.6 146 487.6 120 469.4 107 457 94.6 419 51 381 22.9 345 4.5 342.6 ' +
  '0 196 0Z';
