import { describe, expect, it } from "vitest";
import { counts, fileName } from "./terminal";

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

describe("counts", () => {
  it("counts lines, words and characters", () => {
    expect(counts("one two\nthree")).toBe("2 lines  3 words  13 characters");
  });

  it("says one line, not one lines", () => {
    expect(counts("word")).toBe("1 line  1 word  4 characters");
  });

  it("counts nothing in an empty file", () => {
    expect(counts("")).toBe("0 lines  0 words  0 characters");
  });
});
