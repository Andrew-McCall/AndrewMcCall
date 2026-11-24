import { describe, expect, it } from "vitest";
import { outcome } from "./blackjack";

describe("outcome", () => {
  it("pays three to two for a natural even when the dealer busts", () => {
    expect(outcome(21, 25, true, false)).toEqual({ text: "Blackjack.", pays: 2.5 });
  });

  it("pushes when both hold a natural", () => {
    expect(outcome(21, 21, true, true)).toEqual({ text: "Push.", pays: 1 });
  });

  it("pays even money for 21 made with three cards", () => {
    expect(outcome(21, 19, false, false)).toEqual({ text: "You win.", pays: 2 });
  });

  it("loses a bust whatever the dealer holds", () => {
    expect(outcome(22, 25, false, false)).toEqual({ text: "Bust.", pays: 0 });
  });

  it("wins when only the dealer busts", () => {
    expect(outcome(18, 23, false, false)).toEqual({ text: "Dealer busts. You win.", pays: 2 });
  });
});
