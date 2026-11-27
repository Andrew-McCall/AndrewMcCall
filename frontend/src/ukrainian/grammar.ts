// Turns the dictionary's tags ("noun:inanim:f:v_zna") into plain English.

const PART: Record<string, string> = {
  noun: "noun", verb: "verb", adj: "adjective", adv: "adverb", prep: "preposition",
  conj: "conjunction", part: "particle", pron: "pronoun", num: "numeral",
  intj: "interjection", pred: "predicative word", advp: "verbal adverb", name: "name",
  x: "not in the dictionary",
};

const CASES: Record<string, [name: string, use: string]> = {
  v_naz: ["nominative", "the subject: who or what does it"],
  v_rod: ["genitive", "of; also after не, after amounts and many prepositions"],
  v_dav: ["dative", "to or for someone"],
  v_zna: ["accusative", "the direct object, or motion towards"],
  v_oru: ["instrumental", "with or by means of; together with"],
  v_mis: ["locative", "the place; always after a preposition"],
  v_kly: ["vocative", "calling someone by name"],
};

// In the order they are said.
const WORDS: [tag: string, word: string][] = [
  ["m", "masculine"], ["f", "feminine"], ["n", "neuter"], ["p", "plural"],
  ["imperf", "imperfective"], ["perf", "perfective"], ["inf", "infinitive"],
  ["past", "past"], ["pres", "present"], ["futr", "future"], ["impr", "imperative"],
  ["impers", "impersonal"], ["1", "1st person"], ["2", "2nd person"], ["3", "3rd person"],
  ["compc", "comparative"], ["comps", "superlative"], ["adjp", "participle"],
  ["rev", "reflexive"],
];

export const partName = (part: string): string => PART[part] ?? part;

// A reading without its case, and the case apart.
const describe = (reading: string): [form: string, grammatical: string] => {
  const tags = reading.split(":");
  const personal = tags.includes("pres") || tags.includes("futr") || tags.includes("impr");
  const words = WORDS.filter(([tag]) => tags.includes(tag) && (personal || !/\d/.test(tag)))
    .map(([, word]) => word);
  const grammatical = tags.find((tag) => tag in CASES);
  const counted = grammatical || personal || tags.includes("past");
  if (counted && !tags.includes("p") && (tags.includes("s") || /^(noun|adj|verb)/.test(reading))) {
    words.push("singular");
  }
  return [words.join(" "), grammatical ? CASES[grammatical][0] : ""];
};

// Every reading still possible. Readings that differ only in case become one
// line: "masculine singular, nominative or accusative".
export const readings = (tags: string): string[] => {
  const cases = new Map<string, Set<string>>();
  for (const [form, grammatical] of tags.split("|").map(describe)) {
    if (!cases.has(form)) cases.set(form, new Set());
    if (grammatical) cases.get(form)!.add(grammatical);
  }
  return [...cases]
    .map(([form, names]) => [form, [...names].join(" or ")].filter(Boolean).join(", "))
    .filter(Boolean);
};

// What each possible case is for.
export const caseUses = (tags: string): [name: string, use: string][] => [
  ...new Map(
    tags.split(/[|:]/).filter((tag) => tag in CASES).map((tag) => [tag, CASES[tag]]),
  ).values(),
];
