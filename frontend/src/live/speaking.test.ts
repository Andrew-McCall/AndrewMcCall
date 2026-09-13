import { describe, expect, it } from "vitest";
import { speaking } from "./speaking";

describe("deciding someone is talking", () => {
  it("needs a clear level to start", () => {
    expect(speaking(0.06, false)).toBe(true);
    expect(speaking(0.03, false)).toBe(false);
  });

  it("holds on through the quiet parts of a sentence", () => {
    expect(speaking(0.03, true)).toBe(true);
  });

  it("lets go once the level really drops", () => {
    expect(speaking(0.01, true)).toBe(false);
  });

  it("ignores room tone", () => {
    expect(speaking(0.004, false)).toBe(false);
  });
});
