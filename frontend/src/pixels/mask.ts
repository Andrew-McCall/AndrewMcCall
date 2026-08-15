// A grid of on/off cells, and the passes that work on cells alone.
//
// Everything here is shape-agnostic: by the time a mask reaches these functions
// it no longer matters whether an ellipse, a square or a star produced it.

export interface Mask {
  w: number;
  h: number;
  cells: Uint8Array;
}

// 1 outline, 2 outline with its diagonal gaps closed, 3 a wall of a given
// depth, 4 solid.
export type Mode = "outline" | "diagonal" | "thick" | "filled";

export interface Options {
  mode: Mode;
  thickness: number;
  bias: number;
}

// Every rasteriser returns both: `mask` is what you asked for, `solid` is the
// same shape filled. Mode 2 needs the solid one to know which way is inward.
export interface Rastered {
  mask: Mask;
  solid: Mask;
}

// How deep the wall is for a mode. Modes 1 and 2 are a one-cell outline; a
// filled shape has no wall at all.
export const wallDepth = (options: Options): number => {
  if (options.mode === "filled") return 0;
  if (options.mode === "thick") return Math.max(1, Math.round(options.thickness));
  return 1;
};

export const blank = (w: number, h: number): Mask => ({
  w,
  h,
  cells: new Uint8Array(w * h),
});

export const at = (mask: Mask, x: number, y: number): number =>
  x < 0 || y < 0 || x >= mask.w || y >= mask.h ? 0 : mask.cells[y * mask.w + x];

export const setCell = (mask: Mask, x: number, y: number, value: number): void => {
  if (x < 0 || y < 0 || x >= mask.w || y >= mask.h) return;
  mask.cells[y * mask.w + x] = value;
};

export const copy = (mask: Mask): Mask => ({
  w: mask.w,
  h: mask.h,
  cells: mask.cells.slice(),
});

const NEIGHBOURS = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
  [1, 1],
  [1, -1],
  [-1, 1],
  [-1, -1],
];

const filledNeighbours = (mask: Mask, x: number, y: number): number => {
  let count = 0;
  for (const [dx, dy] of NEIGHBOURS) count += at(mask, x + dx, y + dy);
  return count;
};

// Squared distance from a cell's centre to the grid's centre.
const centreDistance = (mask: Mask, x: number, y: number): number => {
  const dx = x + 0.5 - mask.w / 2;
  const dy = y + 0.5 - mask.h / 2;
  return dx * dx + dy * dy;
};

// Mode 2. Two cells meeting only at a corner leave a gap you can see through,
// so one of the two cells beside them gets filled — whichever lies inside the
// solid shape. Growing inward like that leaves the outer silhouette untouched.
export const closeDiagonals = (ring: Mask, solid: Mask): Mask => {
  const out = copy(ring);

  const fillGap = (ax: number, ay: number, bx: number, by: number): void => {
    const aInside = at(solid, ax, ay);
    const bInside = at(solid, bx, by);
    if (aInside && bInside) {
      // Both would do, so take the one nearer the centre. Ties only happen on
      // the shape's own axis of symmetry, where either answer is symmetric.
      const nearer =
        centreDistance(ring, ax, ay) <= centreDistance(ring, bx, by);
      setCell(out, nearer ? ax : bx, nearer ? ay : by, 1);
    } else if (aInside) {
      setCell(out, ax, ay, 1);
    } else if (bInside) {
      setCell(out, bx, by, 1);
    }
    // Neither inside: nothing to fill without swelling the shape.
  };

  for (let y = 0; y < ring.h - 1; y++) {
    for (let x = 0; x < ring.w - 1; x++) {
      const tl = at(ring, x, y);
      const tr = at(ring, x + 1, y);
      const bl = at(ring, x, y + 1);
      const br = at(ring, x + 1, y + 1);
      if (tl && br && !tr && !bl) fillGap(x + 1, y, x, y + 1);
      else if (tr && bl && !tl && !br) fillGap(x, y, x + 1, y + 1);
    }
  }
  return out;
};

// Sweeps up the two artefacts worth sweeping: specks and dead-end nubs on one
// side, pinholes on the other. Each pass reads the previous grid and writes a
// fresh one, so the result never depends on which way the scan ran.
export const tidy = (mask: Mask): Mask => {
  let current = mask;
  for (let pass = 0; pass < 3; pass++) {
    const next = copy(current);
    let changed = false;
    for (let y = 0; y < current.h; y++) {
      for (let x = 0; x < current.w; x++) {
        const neighbours = filledNeighbours(current, x, y);
        if (at(current, x, y)) {
          if (neighbours <= 1) {
            setCell(next, x, y, 0);
            changed = true;
          }
        } else if (neighbours >= 7) {
          setCell(next, x, y, 1);
          changed = true;
        }
      }
    }
    if (!changed) return current;
    current = next;
  }
  return current;
};

// Filled runs per row as inclusive [start, end] pairs. Feeds both the row-count
// panel and the SVG export, which is why it lives here rather than in either.
export const rows = (mask: Mask): [number, number][][] => {
  const out: [number, number][][] = [];
  for (let y = 0; y < mask.h; y++) {
    const runs: [number, number][] = [];
    let start = -1;
    for (let x = 0; x <= mask.w; x++) {
      const filled = x < mask.w && at(mask, x, y);
      if (filled && start < 0) start = x;
      if (!filled && start >= 0) {
        runs.push([start, x - 1]);
        start = -1;
      }
    }
    out.push(runs);
  }
  return out;
};
