import { describe, expect, test } from "vitest";
import { maxThickness, raster } from "./square";
import { toRows } from "./test-helpers";

const square = (
  size: number,
  mode: "outline" | "diagonal" | "thick" | "filled",
  thickness = 1,
  bias = -0.5,
) => raster({ size }, { mode, thickness, bias }).mask;

describe("squares", () => {
  test("fill every cell when solid", () => {
    expect(toRows(square(3, "filled"))).toEqual(["###", "###", "###"]);
  });

  test("outline as a one-cell border", () => {
    expect(toRows(square(4, "outline"))).toEqual([
      "####",
      "#..#",
      "#..#",
      "####",
    ]);
  });

  test("wall to the asked depth on all four sides", () => {
    expect(toRows(square(6, "thick", 2))).toEqual([
      "######",
      "######",
      "##..##",
      "##..##",
      "######",
      "######",
    ]);
  });

  test("have no diagonal gaps to close", () => {
    expect(toRows(square(5, "diagonal"))).toEqual(toRows(square(5, "outline")));
  });

  test("ignore the smoothing bias, having no edge to smooth", () => {
    expect(toRows(square(7, "outline", 1, -1))).toEqual(
      toRows(square(7, "outline", 1, 0.75)),
    );
  });

  test("cap their wall at half the side, rounded up", () => {
    // An odd square needs the rounded-up depth, or its centre cell survives
    // the wall and the maximum is not solid.
    expect(maxThickness({ size: 7 })).toBe(4);
    expect(maxThickness({ size: 8 })).toBe(4);
  });

  test("are solid at maximum wall depth", () => {
    expect(toRows(square(7, "thick", maxThickness({ size: 7 })))).toEqual(
      toRows(square(7, "filled")),
    );
  });
});
