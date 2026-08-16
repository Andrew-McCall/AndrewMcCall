import { describe, expect, test } from "vitest";
import { backingScale, cellRect } from "./render";

describe("cellRect", () => {
  test("fills its slot completely at full size", () => {
    expect(cellRect(12, 1)).toEqual({ size: 12, offset: 0 });
  });

  test("leaves an even gap on both sides", () => {
    expect(cellRect(12, 0.5)).toEqual({ size: 6, offset: 3 });
  });

  test("keeps the drawn cell centred in its slot", () => {
    for (const scale of [3, 4, 8, 12, 16]) {
      for (const size of [0.2, 0.5, 0.75, 0.9, 1]) {
        const rect = cellRect(scale, size);
        const after = scale - rect.size - rect.offset;
        // A whole number of pixels cannot always split evenly, but the two
        // margins must never differ by more than one.
        expect(Math.abs(after - rect.offset), `${scale} @ ${size}`).toBeLessThanOrEqual(1);
      }
    }
  });

  test("never shrinks a cell out of existence", () => {
    expect(cellRect(1, 0.1)).toEqual({ size: 1, offset: 0 });
    expect(cellRect(2, 0.1).size).toBeGreaterThanOrEqual(1);
  });
});

describe("backingScale", () => {
  test("draws one pixel per cell when there are no gaps to show", () => {
    expect(backingScale(21, 1)).toBe(1);
    expect(backingScale(512, 1)).toBe(1);
  });

  test("gives a small grid room for a visible gap", () => {
    expect(backingScale(21, 0.8)).toBeGreaterThanOrEqual(8);
  });

  test("keeps a large grid to a sane canvas", () => {
    const scale = backingScale(512, 0.8);
    expect(scale).toBeGreaterThanOrEqual(3); // still enough to show a gap
    expect(512 * scale).toBeLessThanOrEqual(2048);
  });
});
