import { describe, expect, test } from "vitest";
import { maxThickness, raster } from "./star";
import { raster as ellipse } from "./ellipse";
import { at, blank, setCell, type Mask } from "./mask";
import { components, filledCount, toRows } from "./test-helpers";

const star = (
  size: number,
  points = 5,
  ratio = 0.5,
  mode: "outline" | "thick" | "filled" = "filled",
  thickness = 1,
  bias = -0.5,
) => raster({ size, points, ratio }, { mode, thickness, bias }).mask;

const rotateQuarterTurn = (mask: Mask): Mask => {
  const out = blank(mask.h, mask.w);
  for (let y = 0; y < mask.h; y++) {
    for (let x = 0; x < mask.w; x++) {
      setCell(out, mask.h - 1 - y, x, at(mask, x, y));
    }
  }
  return out;
};

describe("stars", () => {
  test("point straight up, so they mirror on the vertical axis", () => {
    for (const points of [3, 5, 6, 8]) {
      const grid = toRows(star(41, points));
      for (const row of grid) {
        expect([...row].reverse().join(""), `${points} points`).toBe(row);
      }
    }
  });

  test("with four points survive a quarter turn unchanged", () => {
    const mask = star(41, 4);
    expect(toRows(rotateQuarterTurn(mask))).toEqual(toRows(mask));
  });

  test("cover less ground than the circle they fit inside", () => {
    const disc = ellipse(
      { w: 41, h: 41 },
      { mode: "filled", thickness: 1, bias: -0.5 },
    ).mask;
    expect(filledCount(star(41))).toBeLessThan(filledCount(disc));
  });

  test("get spikier as the inner ratio drops", () => {
    expect(filledCount(star(41, 5, 0.3))).toBeLessThan(
      filledCount(star(41, 5, 0.8)),
    );
  });

  test("outline as one unbroken loop", () => {
    for (const points of [3, 5, 7]) {
      expect(components(star(61, points, 0.5, "outline"), 8), `${points}`).toBe(
        1,
      );
    }
  });

  test("are solid at maximum wall depth", () => {
    for (const size of [41, 42]) {
      const params = { size, points: 5, ratio: 0.5 };
      const depth = maxThickness(params, -0.5);
      expect(
        toRows(star(size, 5, 0.5, "thick", depth)),
        `size ${size}`,
      ).toEqual(toRows(star(size, 5, 0.5, "filled")));
    }
  });

  test("cap their wall well short of the outer radius", () => {
    // The wall can only reach as far as the notches between the points, which
    // are much closer to the centre than the tips are.
    expect(maxThickness({ size: 41, points: 5, ratio: 0.5 }, -0.5)).toBeLessThan(
      12,
    );
  });
});
