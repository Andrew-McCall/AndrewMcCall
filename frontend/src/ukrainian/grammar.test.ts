import { describe, expect, it } from "vitest";
import { caseUses, partName, readings } from "./grammar";

describe("readings", () => {
  it("describes a noun", () => {
    expect(readings("noun:inanim:f:v_zna")).toEqual(["feminine accusative singular"]);
  });
  it("lists each possible case once", () => {
    expect(readings("noun:anim:p:v_naz|noun:anim:p:v_zna")).toEqual([
      "plural nominative",
      "plural accusative",
    ]);
  });
  it("describes verbs", () => {
    expect(readings("verb:imperf:pres:s:3")).toEqual(["imperfective present 3rd person singular"]);
    expect(readings("verb:perf:past:m")).toEqual(["masculine perfective past singular"]);
    expect(readings("verb:imperf:inf")).toEqual(["imperfective infinitive"]);
  });
  it("does not read a pronoun's person as a verb ending", () => {
    expect(readings("noun:anim:s:v_naz:pron:pers:1")).toEqual(["nominative singular"]);
  });
  it("merges readings that only differ in detail the reader does not need", () => {
    expect(readings("noun:anim:m:v_naz:prop:fname|noun:anim:m:v_naz:prop:lname")).toEqual([
      "masculine nominative singular",
    ]);
  });
  it("says nothing about words that do not change", () => {
    expect(readings("prep")).toEqual([]);
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
