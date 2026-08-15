import { describe, expect, test } from "vitest";
import { maxThickness, raster } from "./ellipse";
import { at, closeDiagonals, type Mask } from "./mask";
import {
  components,
  filledCount,
  leftRun,
  rowSpan,
  toRows,
} from "./test-helpers";

const circle = (
  size: number,
  mode: "outline" | "diagonal" | "thick" | "filled",
  thickness = 1,
  bias = -0.5,
) => raster({ w: size, h: size }, { mode, thickness, bias });

// Every cell of an ellipse ring is decided by two ellipse tests: inside the
// outer one, outside the inner one. Checking that over the whole grid pins the
// wall's depth everywhere at once, diagonals included — sampling the axes only
// would miss exactly the places a wall goes wrong.
const expectAnnulus = (
  mask: Mask,
  w: number,
  h: number,
  bias: number,
  thickness: number,
) => {
  const a = w / 2 + bias;
  const b = h / 2 + bias;
  const wrong: string[] = [];

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const dx = x + 0.5 - w / 2;
      const dy = y + 0.5 - h / 2;
      const outer = (dx / a) ** 2 + (dy / b) ** 2;
      const inner = (dx / (a - thickness)) ** 2 + (dy / (b - thickness)) ** 2;
      // Skip cells sitting exactly on a boundary, where a half-cell of float
      // drift decides the answer and either result is defensible.
      if (Math.abs(outer - 1) < 1e-9 || Math.abs(inner - 1) < 1e-9) continue;
      const want = outer < 1 && inner > 1 ? 1 : 0;
      if (at(mask, x, y) !== want) wrong.push(`(${x},${y}) want ${want}`);
    }
  }
  expect(wrong).toEqual([]);
};

describe("circles", () => {
  test("are symmetric on both axes at every size", () => {
    for (let size = 1; size <= 20; size++) {
      const { mask } = circle(size, "filled");
      const grid = toRows(mask);
      expect(grid, `size ${size} vertical`).toEqual([...grid].reverse());
      for (const row of grid) {
        expect([...row].reverse().join(""), `size ${size} horizontal`).toBe(row);
      }
    }
  });

  test("are as tall as they are wide", () => {
    for (let size = 5; size <= 40; size++) {
      const { mask } = circle(size, "filled");
      const filledRows = [...Array(mask.h).keys()].filter((y) =>
        rowSpan(mask, y),
      );
      const width = rowSpan(mask, Math.floor(mask.h / 2))!;
      expect(
        filledRows.length,
        `size ${size} is ${width[1] - width[0] + 1} wide`,
      ).toBe(width[1] - width[0] + 1);
    }
  });

  test("fill roughly pi r squared cells", () => {
    for (const size of [21, 41, 81]) {
      const { mask } = circle(size, "filled");
      const r = size / 2 - 0.5;
      expect(filledCount(mask)).toBeGreaterThan(Math.PI * r * r * 0.9);
      expect(filledCount(mask)).toBeLessThan(Math.PI * r * r * 1.15);
    }
  });

  test("outlines are one unbroken 8-connected loop", () => {
    for (let size = 5; size <= 80; size++) {
      expect(components(circle(size, "outline").mask, 8), `size ${size}`).toBe(1);
    }
  });

  test("outlines have gaps a 4-connected walk cannot cross", () => {
    // The premise of mode 2: without it, an outline is only diagonally joined.
    expect(components(circle(31, "outline").mask, 4)).toBeGreaterThan(1);
  });

  test("a wall is exactly as deep as asked where it crosses the axis", () => {
    for (const thickness of [2, 3, 5]) {
      const { mask } = circle(41, "thick", thickness, 0);
      expect(leftRun(mask, 20), `thickness ${thickness}`).toBe(thickness);
    }
  });

  test("a wall is the gap between two ellipses everywhere, not just on the axes", () => {
    const thickness = 5;
    const { mask } = circle(61, "thick", thickness, 0);
    expectAnnulus(mask, 61, 61, 0, thickness);
  });

  test("a wall at its maximum thickness is a filled circle, at any bias", () => {
    const size = 31;
    for (const bias of [-1, -0.5, 0, 0.5, 1]) {
      const depth = maxThickness({ w: size, h: size }, bias);
      const thick = circle(size, "thick", depth, bias);
      expect(toRows(thick.mask), `bias ${bias}`).toEqual(
        toRows(circle(size, "filled", 1, bias).mask),
      );
    }
  });

  test("maximum thickness is half the smaller side, moved by the bias", () => {
    expect(maxThickness({ w: 31, h: 31 }, -0.5)).toBe(15);
    expect(maxThickness({ w: 40, h: 20 }, -0.5)).toBe(10);
    // A positive bias pushes the edge out, so the wall needs another cell to
    // reach the middle.
    expect(maxThickness({ w: 31, h: 31 }, 0)).toBe(16);
  });
});

describe("mode 2, diagonals closed", () => {
  const closed = (size: number) => {
    const { mask, solid } = circle(size, "diagonal");
    return { thin: mask, thick: closeDiagonals(mask, solid) };
  };

  test("leaves no diagonal-only gap behind", () => {
    for (const size of [15, 31, 32, 63]) {
      expect(components(closed(size).thick, 4), `size ${size}`).toBe(1);
    }
  });

  test("only ever adds cells", () => {
    const { thin, thick } = closed(31);
    for (let i = 0; i < thin.cells.length; i++) {
      if (thin.cells[i]) expect(thick.cells[i]).toBe(1);
    }
  });

  test("does not swell the outer silhouette", () => {
    const { thin, thick } = closed(31);
    for (let y = 0; y < thin.h; y++) {
      expect(rowSpan(thick, y), `row ${y}`).toEqual(rowSpan(thin, y));
    }
  });
});

describe("ellipses", () => {
  test("fill their bounding box exactly", () => {
    // Bias 0 here: the default of -0.5 deliberately pulls the edge in by half a
    // cell, so it does not reach the box.
    const { mask } = raster(
      { w: 40, h: 20 },
      { mode: "filled", thickness: 1, bias: 0 },
    );
    expect(mask.w).toBe(40);
    expect(mask.h).toBe(20);
    expect(rowSpan(mask, 10)).toEqual([0, 39]);
  });

  test("wall themselves with a second ellipse, not a constant-width offset", () => {
    const thickness = 4;
    const { mask } = raster(
      { w: 60, h: 30 },
      { mode: "thick", thickness, bias: 0 },
    );
    expectAnnulus(mask, 60, 30, 0, thickness);
  });
});

describe("semi circles", () => {
  const semi = (
    h: number,
    facing: string,
    mode: "outline" | "filled" | "thick" = "filled",
    thickness = 1,
  ) =>
    raster(
      { w: h, h, portion: "half", facing },
      { mode, thickness, bias: -0.5 },
    ).mask;

  test("crop to half the grid, keeping the centre row", () => {
    const mask = semi(33, "Up");
    expect(mask.h).toBe(17);
    expect(mask.w).toBe(33);
    // The kept centre row is the equator, so it is the widest row in the shape.
    expect(rowSpan(mask, 16)).toEqual([0, 32]);
  });

  test("facing down keeps the other half", () => {
    const mask = semi(33, "Down");
    expect(mask.h).toBe(17);
    expect(rowSpan(mask, 0)).toEqual([0, 32]);
  });

  test("facing left and right crop columns instead", () => {
    expect(semi(33, "Left").w).toBe(17);
    expect(semi(33, "Right").w).toBe(17);
    expect(semi(33, "Left").h).toBe(33);
  });

  test("close along the flat side with a wall of the asked depth", () => {
    const thickness = 3;
    const mask = semi(41, "Up", "thick", thickness);
    const solid = semi(41, "Up", "filled");
    // The three rows against the cut are solid across the shape's full width.
    for (let y = mask.h - thickness; y < mask.h; y++) {
      expect(rowSpan(mask, y), `row ${y}`).toEqual(rowSpan(solid, y));
    }
    // The row above the wall is a wall on each side, not a solid run.
    expect(rowSpan(mask, mask.h - thickness - 1)).not.toEqual(null);
    expect(leftRun(mask, mask.h - thickness - 1)).toBeLessThan(mask.w / 2);
  });

  test("outline as one closed loop", () => {
    expect(components(semi(41, "Up", "outline"), 8)).toBe(1);
    expect(components(semi(41, "Left", "outline"), 8)).toBe(1);
  });
});

describe("quarter circles", () => {
  const quarter = (
    size: number,
    corner: string,
    mode: "outline" | "filled" = "filled",
  ) =>
    raster(
      { w: size, h: size, portion: "quarter", corner },
      { mode, thickness: 1, bias: -0.5 },
    ).mask;

  test("crop on both axes", () => {
    const mask = quarter(33, "TL");
    expect(mask.w).toBe(17);
    expect(mask.h).toBe(17);
    // TL keeps the top-left quadrant, so the right angle sits at the circle's
    // centre (bottom-right of the crop) and the curve cuts the far corner away.
    expect(at(mask, 16, 16)).toBe(1);
    expect(at(mask, 0, 0)).toBe(0);
  });

  test("each corner keeps a different quadrant", () => {
    expect(at(quarter(33, "BR"), 0, 0)).toBe(1);
    expect(at(quarter(33, "TR"), 0, 16)).toBe(1);
  });

  test("outline as one closed loop", () => {
    expect(components(quarter(41, "TL", "outline"), 8)).toBe(1);
  });
});
