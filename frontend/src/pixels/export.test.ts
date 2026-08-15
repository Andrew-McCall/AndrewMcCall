import { describe, expect, test } from "vitest";
import { rowCountText, toSvg } from "./export";
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

describe("rowCountText", () => {
  test("counts each run in a row and totals the lot", () => {
    expect(rowCountText(mask)).toBe(
      ["y=0: 2 + 2 (x 0-1, x 4-5)", "y=2: 2 (x 2-3)", "", "Total: 6 cells"].join(
        "\n",
      ),
    );
  });

  test("skips empty rows", () => {
    expect(rowCountText(mask)).not.toContain("y=1");
  });
});
