import { describe, expect, it } from "vitest";
import { neighbour, tile, windowLimit, type Rect } from "./layout";

const area = (rects: Rect[]) => rects.reduce((sum, [, , w, h]) => sum + w * h, 0);

describe("tile", () => {
  it("returns nothing for an empty desk", () => {
    expect(tile(0, 1000, 600, "dwindle")).toEqual([]);
  });

  it.each(["dwindle", "grid"] as const)("%s covers the whole desk", (mode) => {
    for (let count = 1; count <= 9; count++) {
      expect(area(tile(count, 1000, 600, mode))).toBeCloseTo(600_000);
    }
  });

  it("splits a wide desk left and right first", () => {
    expect(tile(2, 1000, 600, "dwindle")).toEqual([
      [0, 0, 500, 600],
      [500, 0, 500, 600],
    ]);
  });

  it("stretches a short last row across the grid", () => {
    const rects = tile(5, 900, 600, "grid");
    expect(rects[3]).toEqual([0, 300, 450, 300]);
    expect(rects[4]).toEqual([450, 300, 450, 300]);
  });
});

describe("windowLimit", () => {
  it("follows the breakpoints", () => {
    expect(windowLimit(500)).toBe(Infinity);
    expect(windowLimit(768)).toBe(6);
    expect(windowLimit(992)).toBe(8);
    expect(windowLimit(1200)).toBe(10);
    expect(windowLimit(1400)).toBe(Infinity);
  });
});

describe("neighbour", () => {
  const rects: Record<string, Rect> = {
    a: [0, 0, 500, 600],
    b: [500, 0, 500, 300],
    c: [500, 300, 500, 300],
  };

  it("finds the window in the direction asked", () => {
    expect(neighbour(rects, "a", 1, 0)).toBe("b");
    expect(neighbour(rects, "b", 0, 1)).toBe("c");
    expect(neighbour(rects, "c", -1, 0)).toBe("a");
  });

  it("returns nothing at the edge", () => {
    expect(neighbour(rects, "a", -1, 0)).toBeUndefined();
  });
});
