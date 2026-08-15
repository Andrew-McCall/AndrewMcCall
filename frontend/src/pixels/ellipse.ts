// Ellipses, and the half and quarter cuts of them.
//
// One row scan does the work: for each row, solve the ellipse for its
// half-width and fill that span. A wall is the span of the outer ellipse minus
// the span of a second ellipse `T` smaller on both axes.
//
// That second ellipse is not a constant-width offset of the first — a true
// offset of an ellipse isn't an ellipse — so the wall reads slightly wider at
// the flat ends than at the tips. It is what everyone means by an ellipse with
// a wall, and unlike an offset curve it is exact.

import {
  blank,
  at,
  setCell,
  wallDepth,
  type Mask,
  type Options,
  type Rastered,
} from "./mask";

export interface Params {
  w: number;
  h: number;
  portion?: "full" | "half" | "quarter";
  facing?: string; // Up, Down, Left, Right — where the curved side points
  corner?: string; // TL, TR, BL, BR — which quadrant to keep
}

// The deepest wall worth allowing: one that just reaches the middle. The bias
// belongs in here because it moves the edge the wall is measured from — without
// it a maxed wall can leave a single cell sitting in the centre.
export const maxThickness = (params: Params, bias = 0): number =>
  Math.max(1, Math.ceil(Math.min(params.w, params.h) / 2 + bias));

// Float noise must not decide whether a cell an exact hair inside the edge is
// in or out.
const EPS = 1e-9;

// Half-width of an ellipse with semi-axes a and b at vertical offset dy, or -1
// where the row misses the shape entirely.
//
// A row that grazes the very top or bottom of the ellipse has a half-width of
// exactly zero, which is a hit, not a miss: it is the single cell that makes a
// circle as tall as it is wide.
const spanAt = (dy: number, a: number, b: number): number => {
  if (a <= 0 || b <= 0) return -1;
  const t = 1 - (dy * dy) / (b * b);
  if (t < 0) return -1;
  return a * Math.sqrt(t);
};

// The region that survives the portion cut, as inclusive bounds. A cut is
// simply an edge the crop moved, which is what `cut*` reports.
const cropBox = (params: Params, w: number, h: number) => {
  const box = {
    x0: 0,
    y0: 0,
    x1: w - 1,
    y1: h - 1,
    cutTop: false,
    cutBottom: false,
    cutLeft: false,
    cutRight: false,
  };

  // On an odd size the centre row (or column) belongs to the kept side, so a
  // half of 33 is 17 rows rather than 16.
  const keepTop = () => (box.y1 = Math.ceil(h / 2) - 1);
  const keepBottom = () => (box.y0 = Math.floor(h / 2));
  const keepLeft = () => (box.x1 = Math.ceil(w / 2) - 1);
  const keepRight = () => (box.x0 = Math.floor(w / 2));

  if (params.portion === "half") {
    if (params.facing === "Down") keepBottom();
    else if (params.facing === "Left") keepLeft();
    else if (params.facing === "Right") keepRight();
    else keepTop();
  } else if (params.portion === "quarter") {
    const corner = params.corner ?? "TL";
    if (corner[0] === "B") keepBottom();
    else keepTop();
    if (corner[1] === "R") keepRight();
    else keepLeft();
  }

  box.cutTop = box.y0 > 0;
  box.cutBottom = box.y1 < h - 1;
  box.cutLeft = box.x0 > 0;
  box.cutRight = box.x1 < w - 1;
  return box;
};

type Box = ReturnType<typeof cropBox>;

const crop = (mask: Mask, box: Box): Mask => {
  const out = blank(box.x1 - box.x0 + 1, box.y1 - box.y0 + 1);
  for (let y = 0; y < out.h; y++) {
    for (let x = 0; x < out.w; x++) {
      setCell(out, x, y, at(mask, x + box.x0, y + box.y0));
    }
  }
  return out;
};

export const raster = (params: Params, options: Options): Rastered => {
  const { w, h } = params;
  const depth = wallDepth(options);
  const a = w / 2 + options.bias;
  const b = h / 2 + options.bias;

  const solid = blank(w, h);
  const ring = blank(w, h);

  for (let y = 0; y < h; y++) {
    const dy = y + 0.5 - h / 2;
    const span = spanAt(dy, a, b);
    if (span < 0) continue;

    const centre = w / 2 - 0.5;
    const lo = Math.ceil(centre - span - EPS);
    const hi = Math.floor(centre + span + EPS);

    // The hollow part of this row, from the ellipse `depth` cells smaller.
    let holeLo = 0;
    let holeHi = -1;
    if (depth > 0) {
      const inner = spanAt(dy, a - depth, b - depth);
      if (inner >= 0) {
        holeLo = Math.ceil(centre - inner - EPS);
        holeHi = Math.floor(centre + inner + EPS);
      }
    }

    for (let x = lo; x <= hi; x++) {
      setCell(solid, x, y, 1);
      if (depth === 0 || x < holeLo || x > holeHi) setCell(ring, x, y, 1);
    }
  }

  const box = cropBox(params, w, h);
  const cropped = crop(ring, box);
  const croppedSolid = crop(solid, box);

  // A cut side has to be walled off, or an outline mode leaves an open arc
  // hanging in space. The wall is the same depth as the curved one.
  if (depth > 0) {
    const wallRow = (y: number) => {
      for (let x = 0; x < cropped.w; x++) {
        setCell(cropped, x, y, at(croppedSolid, x, y));
      }
    };
    const wallColumn = (x: number) => {
      for (let y = 0; y < cropped.h; y++) {
        setCell(cropped, x, y, at(croppedSolid, x, y));
      }
    };
    for (let i = 0; i < depth; i++) {
      if (box.cutTop) wallRow(i);
      if (box.cutBottom) wallRow(cropped.h - 1 - i);
      if (box.cutLeft) wallColumn(i);
      if (box.cutRight) wallColumn(cropped.w - 1 - i);
    }
  }

  return { mask: cropped, solid: croppedSolid };
};
