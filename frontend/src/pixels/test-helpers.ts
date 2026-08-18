// Test-only helpers. Not imported by any page code.
//
// Masks are written as text grids in the tests ('#' filled, '.' empty) because a
// wrong cell then shows up as a readable diff rather than an index.

import { blank, at, setCell, type Mask } from "./mask";

export const fromRows = (rows: string[]): Mask => {
  const mask = blank(rows[0].length, rows.length);
  rows.forEach((row, y) => {
    [...row].forEach((c, x) => setCell(mask, x, y, c === "#" ? 1 : 0));
  });
  return mask;
};

export const toRows = (mask: Mask): string[] => {
  const rows: string[] = [];
  for (let y = 0; y < mask.h; y++) {
    let row = "";
    for (let x = 0; x < mask.w; x++) row += at(mask, x, y) ? "#" : ".";
    rows.push(row);
  }
  return rows;
};

export const filledCount = (mask: Mask): number =>
  mask.cells.reduce((total: number, cell) => total + cell, 0);

// First and last filled cell in a row, or null when the row is empty.
export const rowSpan = (mask: Mask, y: number): [number, number] | null => {
  let lo = -1;
  let hi = -1;
  for (let x = 0; x < mask.w; x++) {
    if (!at(mask, x, y)) continue;
    if (lo < 0) lo = x;
    hi = x;
  }
  return lo < 0 ? null : [lo, hi];
};

// How many separate blobs of filled cells the mask has, under 4- or
// 8-connectivity. An outline that hasn't broken anywhere is exactly 1.
export const components = (mask: Mask, connectivity: 4 | 8): number => {
  const seen = new Uint8Array(mask.w * mask.h);
  const steps =
    connectivity === 4
      ? [
          [1, 0],
          [-1, 0],
          [0, 1],
          [0, -1],
        ]
      : [
          [1, 0],
          [-1, 0],
          [0, 1],
          [0, -1],
          [1, 1],
          [1, -1],
          [-1, 1],
          [-1, -1],
        ];

  let found = 0;
  for (let y = 0; y < mask.h; y++) {
    for (let x = 0; x < mask.w; x++) {
      if (!at(mask, x, y) || seen[y * mask.w + x]) continue;
      found++;
      const queue = [[x, y]];
      seen[y * mask.w + x] = 1;
      while (queue.length) {
        const [cx, cy] = queue.pop()!;
        for (const [dx, dy] of steps) {
          const nx = cx + dx;
          const ny = cy + dy;
          if (!at(mask, nx, ny) || seen[ny * mask.w + nx]) continue;
          seen[ny * mask.w + nx] = 1;
          queue.push([nx, ny]);
        }
      }
    }
  }
  return found;
};

// Length of the run of filled cells starting at the row's left edge, which is
// how thick a wall is where it crosses the horizontal axis.
export const leftRun = (mask: Mask, y: number): number => {
  const span = rowSpan(mask, y);
  if (!span) return 0;
  let run = 0;
  for (let x = span[0]; x < mask.w && at(mask, x, y); x++) run++;
  return run;
};
