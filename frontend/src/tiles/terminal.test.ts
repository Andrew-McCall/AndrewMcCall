import { describe, expect, it } from "vitest";
import { fileName } from "./terminal";

describe("fileName", () => {
  it("uses a post's slug", () => {
    expect(fileName("Simply WSL - The Why", "/posts/simply-wsl-the-why")).toBe("simply-wsl-the-why");
  });

  it("turns a project name into one word", () => {
    expect(fileName("My First Project!", "https://github.com/someone/thing")).toBe("my-first-project");
  });

  it("never returns an empty name", () => {
    expect(fileName("???", "")).toBe("untitled");
  });
});
