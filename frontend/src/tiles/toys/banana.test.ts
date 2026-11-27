import { describe, expect, it } from "vitest";
import { reach } from "./banana";

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
