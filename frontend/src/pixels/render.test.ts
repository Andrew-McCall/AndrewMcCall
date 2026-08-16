import { describe, expect, test } from "vitest";
import { backingScale, cellRect } from "./render";

describe("cellRect", () => {
  test("fills its slot completely at full size", () => {
    expect(cellRect(12, 1)).toEqual({ size: 12, offset: 0 });
  });

  test("leaves an even gap on both sides", () => {
    expect(cellRect(12, 0.5)).toEqual({ size: 6, offset: 3 });
  });

  test("keeps the drawn cell exactly centred in its slot, always", () => {
    for (let scale = 1; scale <= 16; scale++) {
      for (let size = 0.1; size <= 1.0001; size += 0.05) {
        const rect = cellRect(scale, size);
        const after = scale - rect.size - rect.offset;
        // Equal margins on both sides — never a pixel more on one than the
        // other, or the shape sits off centre in its own grid.
        expect(after, `${scale} @ ${size.toFixed(2)}`).toBe(rect.offset);
        expect(rect.size, `${scale} @ ${size.toFixed(2)}`).toBeGreaterThanOrEqual(1);
        expect(rect.size, `${scale} @ ${size.toFixed(2)}`).toBeLessThanOrEqual(scale);
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
