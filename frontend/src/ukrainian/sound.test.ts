import { describe, expect, it } from "vitest";
import { sound } from "./sound";

describe("sound", () => {
  it("splits into syllables and puts the stressed one in capitals", () => {
    expect(sound("шмарка́тий")).toBe("shmar-KA-tyy");
    expect(sound("кни́га")).toBe("KNY-ha");
    expect(sound("чита́ти")).toBe("chy-TA-ty");
  });
  it("leaves every syllable small when the stress is not known", () => {
    expect(sound("хата")).toBe("kha-ta");
  });
  it("handles iotated vowels, the soft sign and the apostrophe", () => {
    expect(sound("Ки́їв")).toBe("KY-yeev");
    expect(sound("бур'яна́х")).toBe("boor-ya-NAKH");
    expect(sound("кінь")).toBe("keen'");
    expect(sound("щось")).toBe("shchos'");
  });
  it("says a one-syllable word and a hyphenated word", () => {
    expect(sound("і")).toBe("ee");
    expect(sound("з-під")).toBe("z-peed");
  });
  it("skips letters that are not Ukrainian", () => {
    expect(sound("ы")).toBe("");
  });
});
