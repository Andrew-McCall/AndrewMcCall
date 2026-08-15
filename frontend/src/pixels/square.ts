// Squares. No distance field, no rounding, nothing to approximate: a border of
// depth T is every cell within T of an edge. The smoothing bias is ignored
// here because a square's edge is already exactly where it should be.

import {
  blank,
  setCell,
  wallDepth,
  type Options,
  type Rastered,
} from "./mask";

export interface Params {
  size: number;
}

// Rounded up, not down: on an odd square a wall of floor(size / 2) leaves the
// centre cell behind, so the maximum would not be solid.
// Takes the bias for a consistent signature across the rasterisers, and
// ignores it: a square has no edge to smooth.
export const maxThickness = (params: Params, _bias = 0): number =>
  Math.ceil(params.size / 2);

export const raster = (params: Params, options: Options): Rastered => {
  const n = params.size;
  const depth = wallDepth(options);

  const solid = blank(n, n);
  const ring = blank(n, n);

  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      setCell(solid, x, y, 1);
      const onWall = x < depth || y < depth || x >= n - depth || y >= n - depth;
      if (depth === 0 || onWall) setCell(ring, x, y, 1);
    }
  }

  return { mask: ring, solid };
};
