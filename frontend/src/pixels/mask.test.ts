import { describe, expect, test } from "vitest";
import { bounds, closeDiagonals, rows, trim } from "./mask";
import { fromRows, toRows } from "./test-helpers";

describe("bounds", () => {
  test("measures the drawn shape, not the grid it sits in", () => {
    const mask = fromRows([".....", ".###.", ".###.", "....."]);

    expect(bounds(mask)).toEqual({ x0: 1, y0: 1, x1: 3, y1: 2 });
  });

  test("reaches the edges when the shape fills the grid", () => {
    expect(bounds(fromRows(["##", "##"]))).toEqual({
      x0: 0,
      y0: 0,
      x1: 1,
      y1: 1,
    });
  });

  test("is null when nothing is drawn", () => {
    expect(bounds(fromRows(["..", ".."]))).toBeNull();
  });

  test("follows a single stray cell", () => {
    expect(bounds(fromRows(["...", "...", "..#"]))).toEqual({
      x0: 2,
      y0: 2,
      x1: 2,
      y1: 2,
    });
  });
});

describe("closeDiagonals", () => {
  test("fills the gap cell that lies inside the solid shape", () => {
    // (0,0) and (1,1) touch only at their corner. The solid mask says the
    // bottom-left cell is inside the shape, so that is the one to fill.
    const ring = fromRows(["#.", ".#"]);
    const solid = fromRows(["#.", "##"]);

    expect(toRows(closeDiagonals(ring, solid))).toEqual(["#.", "##"]);
  });

  test("closes an anti-diagonal pair the same way", () => {
    const ring = fromRows([".#", "#."]);
    const solid = fromRows(["##", "#."]);

    expect(toRows(closeDiagonals(ring, solid))).toEqual(["##", "#."]);
  });

  test("leaves a pair alone when neither gap cell is inside the shape", () => {
    const ring = fromRows(["#.", ".#"]);
    const solid = fromRows(["#.", ".#"]);

    expect(toRows(closeDiagonals(ring, solid))).toEqual(["#.", ".#"]);
  });

  test("prefers the gap cell nearer the centre when both are inside", () => {
    // Grid centre is (1.5, 1). Cell (1,0) sits 0.5 from it, cell (0,1) sits
    // 1.12 away, so (1,0) wins.
    const ring = fromRows(["#..", ".#."]);
    const solid = fromRows(["###", "###"]);

    expect(toRows(closeDiagonals(ring, solid))).toEqual(["##.", ".#."]);
  });

  test("leaves an already 4-connected outline untouched", () => {
    const ring = fromRows(["##", "##"]);

    expect(toRows(closeDiagonals(ring, ring))).toEqual(["##", "##"]);
  });
});

describe("trim", () => {
  test("cuts the empty margin off a shape", () => {
    const mask = fromRows([".....", ".###.", ".#.#.", ".###.", "....."]);

    expect(toRows(trim(mask))).toEqual(["###", "#.#", "###"]);
  });

  test("leaves a shape that already fills its grid alone", () => {
    const mask = fromRows(["##", "##"]);

    expect(trim(mask)).toBe(mask);
  });

  test("trims an off-centre shape to itself", () => {
    const mask = fromRows(["....", "..##", "..##"]);

    expect(toRows(trim(mask))).toEqual(["##", "##"]);
  });

  test("leaves an empty grid alone rather than returning nothing", () => {
    const mask = fromRows(["..", ".."]);

    expect(trim(mask)).toBe(mask);
  });
});

describe("rows", () => {
  test("returns the filled runs of each row", () => {
    const mask = fromRows(["##..##", "......", "..##.."]);

    expect(rows(mask)).toEqual([
      [
        [0, 1],
        [4, 5],
      ],
      [],
      [[2, 3]],
    ]);
  });
});
