import { describe, expect, test } from "vitest";
import { closeDiagonals, rows, tidy } from "./mask";
import { fromRows, toRows } from "./test-helpers";

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

describe("tidy", () => {
  test("removes an isolated speck", () => {
    const mask = fromRows([".....", ".....", "..#..", ".....", "....."]);

    expect(toRows(tidy(mask))).toEqual([
      ".....",
      ".....",
      ".....",
      ".....",
      ".....",
    ]);
  });

  test("removes a dead-end nub hanging off a wall", () => {
    const mask = fromRows(["..#..", "..#..", "..#.."]);

    // Top and bottom cells each have exactly one filled neighbour, so both go;
    // the middle is then a speck and goes on the next pass.
    expect(toRows(tidy(mask))).toEqual([".....", ".....", "....."]);
  });

  test("fills a pinhole surrounded on all sides", () => {
    const mask = fromRows(["###", "#.#", "###"]);

    expect(toRows(tidy(mask))).toEqual(["###", "###", "###"]);
  });

  test("leaves a clean ring untouched", () => {
    const ring = ["#####", "#...#", "#...#", "#...#", "#####"];

    expect(toRows(tidy(fromRows(ring)))).toEqual(ring);
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
