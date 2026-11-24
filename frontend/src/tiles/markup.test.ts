import { describe, expect, it } from "vitest";
import { plainText } from "./markup";

describe("plainText", () => {
  it("drops link, emphasis and code markers", () => {
    expect(plainText("[Simply WSL](/posts/simply-wsl) is **the** list of `commands`.")).toBe(
      "Simply WSL is the list of commands.",
    );
  });

  it("drops a leading heading or quote marker", () => {
    expect(plainText("## 1. Install\n> quoted")).toBe("1. Install quoted");
  });

  it("keeps characters that are not markdown", () => {
    expect(plainText("Porting snake_case C# code where a >= b")).toBe(
      "Porting snake_case C# code where a >= b",
    );
  });
});
