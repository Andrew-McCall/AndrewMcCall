import { describe, expect, it } from "vitest";
import { sound, syllableCount } from "./sound";

describe("sound", () => {
  it("splits into syllables and puts the stressed one in capitals", () => {
    expect(sound("шмарка́тий")).toBe("shmar-KA-tyi");
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
  it("tells «й» before a vowel from «й» after one", () => {
    expect(sound("його́")).toBe("yo-HO");
    expect(sound("мий")).toBe("myi");
  });
  it("keeps apart two letters that would read as one sound", () => {
    expect(sound("зго́да")).toBe("Z·HO-da");
    expect(sound("жо́да")).toBe("ZHO-da");
  });
  it("marks every stressed syllable of a word with two stresses", () => {
    expect(sound("коли́-не́будь")).toBe("ko-LY-NE-bood'");
  });
  it("counts syllables", () => {
    expect(syllableCount("він")).toBe(1);
    expect(syllableCount("шмаркатий")).toBe(3);
  });
  it("skips letters that are not Ukrainian", () => {
    expect(sound("ы")).toBe("");
  });
});
