import { describe, expect, test } from "vitest";
import { rowCountText, rowStats, spansOf, toSvg } from "./export";
import { fromRows } from "./test-helpers";

const mask = fromRows(["##..##", "......", "..##.."]);

describe("toSvg", () => {
  test("sizes the canvas from the mask", () => {
    expect(toSvg(mask)).toContain('viewBox="0 0 6 3"');
  });

  test("emits one rect per run rather than one per cell", () => {
    expect(toSvg(mask).match(/<rect/g)).toHaveLength(3);
    expect(toSvg(mask)).toContain('<rect x="4" y="0" width="2" height="1"');
  });

  test("paints the cells in the colour asked for", () => {
    expect(toSvg(mask, { fill: "#22c55e" })).toContain('fill="#22c55e"');
  });

  test("leaves the background out unless one is given", () => {
    expect(toSvg(mask)).not.toContain('width="6" height="3" fill');
    expect(toSvg(mask, { background: "#ffffff" })).toContain(
      '<rect x="0" y="0" width="6" height="3" fill="#ffffff"',
    );
  });
});

describe("toSvg with gaps between the pixels", () => {
  test("keeps merging runs while the cells still touch", () => {
    expect(toSvg(mask, { pixelSize: 1 }).match(/<rect/g)).toHaveLength(3);
  });

  test("draws each cell on its own once they do not", () => {
    // Runs cannot be merged into one rect when there is a gap in between.
    expect(toSvg(mask, { pixelSize: 0.5 }).match(/<rect/g)).toHaveLength(6);
  });

  test("centres the smaller cell in the space it would have filled", () => {
    expect(toSvg(mask, { pixelSize: 0.5 })).toContain(
      '<rect x="0.25" y="0.25" width="0.5" height="0.5"',
    );
  });

  test("keeps the viewBox on whole cells so nothing shifts", () => {
    expect(toSvg(mask, { pixelSize: 0.5 })).toContain('viewBox="0 0 6 3"');
  });

  test("writes coordinates a person can read", () => {
    // Not 0.30000000000000004.
    expect(toSvg(mask, { pixelSize: 0.4 })).toContain('x="0.3"');
  });
});

describe("rowStats", () => {
  test("gives each drawn row its total and its runs", () => {
    expect(rowStats(mask)).toEqual([
      {
        y: 0,
        total: 4,
        runs: [
          [0, 1],
          [4, 5],
        ],
      },
      { y: 2, total: 2, runs: [[2, 3]] },
    ]);
  });

  test("leaves out rows with nothing in them", () => {
    expect(rowStats(mask).map((row) => row.y)).not.toContain(1);
  });
});

describe("spansOf", () => {
  test("writes a lone cell as one number, not a range of itself", () => {
    expect(spansOf({ y: 0, total: 1, runs: [[7, 7]] })).toBe("7");
  });

  test("writes a real run as a range", () => {
    expect(spansOf({ y: 0, total: 3, runs: [[4, 6]] })).toBe("4-6");
  });

  test("separates the runs of a row", () => {
    expect(
      spansOf({
        y: 0,
        total: 2,
        runs: [
          [1, 1],
          [13, 13],
        ],
      }),
    ).toBe("1, 13");
  });
});

describe("rowCountText", () => {
  test("lines the columns up under a header", () => {
    expect(rowCountText(mask)).toBe(
      [
        "y  cells  spans",
        "0      4  0-1, 4-5",
        "2      2  2-3",
        "",
        "Total: 6 cells",
      ].join("\n"),
    );
  });

  test("keeps the columns aligned once the numbers get wider", () => {
    const tall = fromRows([
      ...Array(10).fill("....."),
      "#####",
      ...Array(89).fill("....."),
      "##...",
    ]);
    const lines = rowCountText(tall).split("\n");

    // The counts end in the same column whether y is 10 or 99.
    expect(lines[1].indexOf("5")).toBe(lines[2].indexOf("2"));
  });
});
