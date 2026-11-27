import { describe, expect, it } from "vitest";
import { clickRate, reach } from "./banana";

describe("reach", () => {
  it("shows only the first item when nothing is owned or affordable", () => {
    expect(reach([0, 0, 0], [false, false, false])).toBe(1);
  });

  it("shows every affordable item and the next one after them", () => {
    expect(reach([0, 0, 0, 0], [true, true, false, false])).toBe(3);
  });

  it("counts owned items as reached even when they are too dear now", () => {
    expect(reach([2, 1, 0, 0], [false, false, false, false])).toBe(3);
  });

  it("shows the whole shop once every item is reached", () => {
    expect(reach([1, 0], [false, true])).toBe(2);
  });
});

describe("clickRate", () => {
  it("spreads the last five seconds of clicks over a second", () => {
    const clicks = [
      { at: 1, amount: 10 },
      { at: 4, amount: 5 },
      { at: 5.5, amount: 5 },
    ];
    expect(clickRate(clicks, 6)).toBe(2);
  });

  it("is zero when nobody has clicked lately", () => {
    expect(clickRate([{ at: 1, amount: 50 }], 7)).toBe(0);
  });
});
