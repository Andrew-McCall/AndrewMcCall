import { describe, expect, it } from "vitest";
import { canType, charFor, FINGERS, keyFor, ROWS } from "./keyboard";

describe("the Ukrainian layout", () => {
  it("has all 33 letters and the apostrophe", () => {
    const letters = new Set(ROWS.flat().map((key) => key.uk));
    for (const letter of "абвгґдеєжзиіїйклмнопрстуфхцчшщьюя'") {
      expect(letters.has(letter), letter).toBe(true);
    }
  });
  it("maps physical keys to letters and leaves digits alone", () => {
    expect(charFor("KeyQ")).toBe("й");
    expect(charFor("KeyS")).toBe("і");
    expect(charFor("BracketRight")).toBe("ї");
    expect(charFor("IntlBackslash")).toBe("ґ");
    expect(charFor("Slash")).toBe(".");
    expect(charFor("Digit1")).toBeUndefined();
    expect(charFor("Space")).toBeUndefined();
  });
  it("finds the key for either kind of apostrophe", () => {
    expect(keyFor("’")?.code).toBe("Backquote");
    expect(keyFor("'")?.code).toBe("Backquote");
  });
  it("knows which words it cannot type", () => {
    expect(canType("з-під")).toBe(true);
    expect(canType("П’ять")).toBe(true);
    expect(canType("густи́х")).toBe(true);
    expect(canType("сыеле")).toBe(false);
    expect(canType("XV")).toBe(false);
  });
  it("puts the home keys under the index fingers", () => {
    expect(FINGERS[keyFor("а")!.finger]).toBe("left index finger");
    expect(FINGERS[keyFor("О")!.finger]).toBe("right index finger");
    expect(FINGERS[keyFor("я")!.finger]).toBe("left little finger");
    expect(FINGERS[keyFor("ї")!.finger]).toBe("right little finger");
  });
});
