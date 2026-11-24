import { describe, expect, it } from "vitest";
import { pixelHtml, shade } from "./pixels";

describe("shade", () => {
  it("lights the top left and darkens the bottom right", () => {
    expect(shade(["###", "###", "###"])).toEqual(["hhl", "hml", "lll"]);
  });

  it("leaves empty cells empty", () => {
    expect(shade(["#.", ".#"])).toEqual(["h.", ".l"]);
  });
});

describe("pixelHtml", () => {
  it("writes one element per cell", () => {
    expect(pixelHtml(["#.", ".#"])).toBe('<i class="h"></i><i></i><i></i><i class="l"></i>');
  });
});
