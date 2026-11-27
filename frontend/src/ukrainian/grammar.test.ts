import { describe, expect, it } from "vitest";
import { caseUses, partName, readings, senses } from "./grammar";

describe("readings", () => {
  it("describes a noun", () => {
    expect(readings("noun:inanim:f:v_zna")).toEqual(["feminine singular, accusative"]);
  });
  it("joins readings that differ only in case", () => {
    expect(readings("noun:anim:p:v_naz|noun:anim:p:v_zna")).toEqual([
      "plural, nominative or accusative",
    ]);
  });
  it("keeps readings apart when more than the case differs", () => {
    expect(readings("noun:inanim:f:v_rod|noun:inanim:p:v_naz")).toEqual([
      "feminine singular, genitive",
      "plural, nominative",
    ]);
  });
  it("describes verbs", () => {
    expect(readings("verb:imperf:pres:s:3")).toEqual(["imperfective present 3rd person singular"]);
    expect(readings("verb:perf:past:m")).toEqual(["masculine perfective past singular"]);
    expect(readings("verb:imperf:inf")).toEqual(["imperfective infinitive"]);
  });
  it("does not read a pronoun's person as a verb ending", () => {
    expect(readings("noun:anim:s:v_naz:pron:pers:1")).toEqual(["singular, nominative"]);
  });
  it("merges readings that only differ in detail the reader does not need", () => {
    expect(readings("noun:anim:m:v_naz:prop:fname|noun:anim:m:v_naz:prop:lname")).toEqual([
      "masculine singular, nominative",
    ]);
  });
  it("says nothing about words that do not change", () => {
    expect(readings("prep")).toEqual([]);
  });
});

describe("senses", () => {
  it("splits on a semicolon but not inside brackets", () => {
    expect(senses("truth (conformity to fact; true facts); justice")).toEqual([
      "truth (conformity to fact; true facts)",
      "justice",
    ]);
  });
  it("gives the aspect partner a line of its own", () => {
    expect(senses("to read; to recite (perfective: прочита́ти)")).toEqual([
      "to read",
      "to recite",
      "its perfective partner: прочита́ти",
    ]);
  });
  it("gives nothing for an empty gloss", () => {
    expect(senses("")).toEqual([]);
  });
});

describe("caseUses", () => {
  it("explains each case in the tags once", () => {
    expect(caseUses("adj:m:v_naz|adj:m:v_zna").map(([name]) => name)).toEqual([
      "nominative",
      "accusative",
    ]);
  });
});

describe("partName", () => {
  it("names the part of speech", () => {
    expect(partName("adj")).toBe("adjective");
  });
});
