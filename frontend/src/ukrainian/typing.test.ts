import { describe, expect, it } from "vitest";
import { accept, blank, norm, weave } from "./typing";

describe("norm", () => {
  it("ignores case, stress marks and the kind of apostrophe", () => {
    expect(norm("Бур’яна́х")).toBe("бур'янах");
  });
});

describe("accept", () => {
  it("keeps the book's capitals for what was typed", () => {
    expect(accept("Ява", "яв")).toEqual({ typed: "Яв", wrong: false, done: false });
  });
  it("stops at the first wrong letter", () => {
    expect(accept("хата", "хаша")).toEqual({ typed: "ха", wrong: true, done: false });
  });
  it("is done at the last letter and rejects more", () => {
    expect(accept("і", "і")).toEqual({ typed: "і", wrong: false, done: true });
    expect(accept("і", "іі")).toEqual({ typed: "і", wrong: true, done: true });
  });
});

describe("weave", () => {
  const text = "— Ми йдемо, Яво!";
  const words = [
    { start: 2, form: "Ми" },
    { start: 5, form: "йдемо" },
    { start: 12, form: "Яво" },
  ];
  it("keeps punctuation and blanks what is not typed yet", () => {
    const shown = ["Ми", "йд", ""];
    expect(weave(text, words, (i) => blank(words[i].form, shown[i]))).toBe("— Ми йд___, ___!");
  });
  it("passes the text between words through `gap`", () => {
    expect(weave(text, words, () => "x", () => "|")).toBe("|x|x|x|");
  });
});
