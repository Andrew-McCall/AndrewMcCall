import { describe, expect, it } from "vitest";

import { MAX_CHOICES, choiceForKey, formatGdp, keyFor, keyHint } from "./secret_countries";

describe("formatGdp", () => {
  it("keeps economies under a billion in millions", () => {
    expect(formatGdp(314)).toBe("$314 million");
    expect(formatGdp(999.7)).toBe("$1 billion");
  });

  it("rounds larger economies to billions", () => {
    expect(formatGdp(2_827_113)).toBe("$2,827 billion");
  });
});

describe("answer keys", () => {
  it("runs digits, then lower case, then upper case up to the maximum", () => {
    expect(MAX_CHOICES).toBe(40);
    expect([0, 8, 9, 34, 35, 39].map(keyFor)).toEqual(["1", "9", "a", "z", "A", "E"]);
  });

  it("describes only the keys in play", () => {
    expect(keyHint(1)).toBe("Learner mode · Enter for next");
    expect(keyHint(4)).toBe("Keys 1–4 answer · Enter for next");
    expect(keyHint(12)).toBe("Keys 1–9, a–c answer · Enter for next");
    expect(keyHint(40)).toBe("Keys 1–9, a–z, A–E answer · Enter for next");
  });
});

describe("choiceForKey", () => {
  it("maps keys to choices, ignoring case when only one case is in play", () => {
    expect(choiceForKey("3", 4)).toBe(2);
    expect(choiceForKey("5", 4)).toBe(-1);
    expect(choiceForKey("A", 12)).toBe(9); // Caps Lock on
    expect(choiceForKey("A", 40)).toBe(35);
    expect(choiceForKey("a", 40)).toBe(9);
    expect(choiceForKey("Enter", 40)).toBe(-1);
  });
});
