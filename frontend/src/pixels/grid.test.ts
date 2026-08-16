import { describe, expect, test } from "vitest";
import { gridOffset, line } from "./grid";

// Where the ruled lines actually land, in cells from the left edge.
const linesFor = (size: number, step: number): number[] => {
  const offset = gridOffset(size, step);
  const lines: number[] = [];
  for (let at = offset; at <= size; at += step) lines.push(at);
  return lines;
};

describe("gridOffset", () => {
  test("always lands inside the first tile", () => {
    for (let size = 1; size <= 64; size++) {
      for (const step of [1, 2, 3, 4, 5, 8, 10]) {
        const offset = gridOffset(size, step);
        expect(offset, `size ${size} step ${step}`).toBeGreaterThanOrEqual(0);
        expect(offset, `size ${size} step ${step}`).toBeLessThan(step);
      }
    }
  });

  test("rules a line through the centre of an even shape", () => {
    for (const size of [10, 20, 30, 32, 64]) {
      for (const step of [2, 3, 4, 5, 8]) {
        expect(linesFor(size, step), `size ${size} step ${step}`).toContain(
          size / 2,
        );
      }
    }
  });

  test("centres a square on the middle cell of an odd shape", () => {
    for (const size of [11, 21, 31, 33, 41]) {
      for (const step of [3, 5, 7, 9]) {
        const lines = linesFor(size, step);
        const opening = lines.filter((at) => at <= size / 2).pop()!;
        // The square holding the centre should be centred on it.
        expect(opening + step / 2, `size ${size} step ${step}`).toBe(size / 2);
      }
    }
  });

  test("gets within half a cell when the step cannot divide evenly", () => {
    for (const size of [21, 31]) {
      for (const step of [2, 4, 6]) {
        const lines = linesFor(size, step);
        const opening = lines.filter((at) => at <= size / 2).pop()!;
        expect(
          Math.abs(opening + step / 2 - size / 2),
          `size ${size} step ${step}`,
        ).toBeLessThanOrEqual(0.5);
      }
    }
  });

  test("is the whole grid when a step covers the shape", () => {
    expect(gridOffset(21, 1)).toBe(0);
  });
});

describe("line", () => {
  test("carries its offset in the gradient rather than the position", () => {
    expect(line("right", "red", 40)).toBe(
      "linear-gradient(to right, transparent 40%, red 40%," +
        " red calc(40% + 1px), transparent calc(40% + 1px))",
    );
  });
});
