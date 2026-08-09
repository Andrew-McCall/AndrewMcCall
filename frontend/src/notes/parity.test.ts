// Runs the shared corpus in `fixtures/notes/parity.json` against the
// TypeScript frontmatter parser and slugifier.
//
// `backend/src/notes/frontmatter.rs` runs the same file. Add a case there and
// this suite picks it up automatically — which is the point: two
// implementations of one grammar can't quietly disagree.

import { describe, expect, it } from "vitest";
import fixtures from "../../../fixtures/notes/parity.json";
import * as fm from "./frontmatter";
import { slugify } from "./links";

describe("frontmatter parity", () => {
  for (const c of fixtures.frontmatter) {
    it(c.name, () => {
      const parsed = fm.parse(c.text);
      expect(parsed.entries).toEqual(c.entries);
      expect(fm.contentOf(c.text, parsed)).toBe(c.content);
    });
  }
});

describe("patchList parity", () => {
  for (const c of fixtures.patch) {
    it(c.name, () => {
      expect(fm.patchList(c.text, c.key, c.values)).toBe(c.out);
    });
  }

  it("round-trips through parse", () => {
    const out = fm.patchList("---\ntitle: T\n---\nbody", "aliases", ["one", "two"]);
    const parsed = fm.parse(out);
    expect(fm.get(parsed, "aliases")).toEqual(["one", "two"]);
    expect(fm.first(parsed, "title")).toBe("T");
    expect(fm.contentOf(out, parsed)).toBe("body");
  });

  it("survives values containing commas", () => {
    // Why lists always serialize in block form: no escaping needed.
    const out = fm.patchList("---\nt: x\n---\n", "tags", ["a, b", "c"]);
    expect(fm.get(fm.parse(out), "tags")).toEqual(["a, b", "c"]);
  });
});

describe("slugify parity", () => {
  for (const c of fixtures.slugs) {
    it(`${JSON.stringify(c.in)} → ${JSON.stringify(c.out)}`, () => {
      expect(slugify(c.in)).toBe(c.out);
    });
  }

  it("is idempotent", () => {
    for (const c of fixtures.slugs) {
      expect(slugify(slugify(c.in))).toBe(slugify(c.in));
    }
  });

  it("truncates to 100 characters", () => {
    expect(slugify("a".repeat(150))).toHaveLength(100);
  });
});

describe("reader content extraction", () => {
  // Regression: the reader rendered `note.body` whole, so every note opened
  // with its frontmatter printed as a paragraph and its `---` delimiters
  // turned into horizontal rules.
  it("strips the frontmatter before rendering", () => {
    const body = "---\ntitle: T\ntags:\n  - a\n---\n\nReal prose.\n";
    const content = fm.contentOf(body, fm.parse(body));
    expect(content).toBe("\nReal prose.\n");
    expect(content).not.toContain("title:");
    expect(content).not.toContain("---");
  });

  it("leaves a note with no frontmatter untouched", () => {
    const body = "# Just prose\n\nwith a --- rule\n";
    expect(fm.contentOf(body, fm.parse(body))).toBe(body);
  });
});
