// Wikilink resolution — the rule that decides whether `[[something]]` becomes a
// link or an invitation to create a note.
//
// `slugify` parity with Rust lives in parity.test.ts; this covers the lookup
// built on top of it, which had no tests at all despite being what makes a
// rename non-destructive.

import { describe, expect, it } from "vitest";
import type { NoteIndexEntry } from "./api";
import { noteHref, resolve, tagMatches, titleFromSlug } from "./links";

const entry = (slug: string | null, names: string[] = []): NoteIndexEntry => ({
  id: slug ?? "trashed",
  slug,
  title: slug ?? "Trashed",
  tags: [],
  names: slug ? [slug, ...names] : [],
  udf: [],
  excerpt: "",
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
});

const index = [
  entry("deploy-pipeline", ["deploy-notes", "old-name"]),
  entry("backend"),
];

describe("resolve", () => {
  it("matches the primary name", () => {
    expect(resolve("deploy-pipeline", index)?.slug).toBe("deploy-pipeline");
  });

  it("is insensitive to case, spacing and punctuation", () => {
    for (const target of ["Deploy Pipeline", "DEPLOY  PIPELINE", "deploy--pipeline", "Deploy, Pipeline!"]) {
      expect(resolve(target, index)?.slug).toBe("deploy-pipeline");
    }
  });

  // The property that makes renaming safe: the superseded name still resolves.
  it("falls back to an alias", () => {
    expect(resolve("deploy-notes", index)?.slug).toBe("deploy-pipeline");
    expect(resolve("Old Name", index)?.slug).toBe("deploy-pipeline");
  });

  it("prefers a primary name over another note's alias", () => {
    const shadowed = [entry("backend"), entry("other", ["backend"])];
    expect(resolve("backend", shadowed)?.slug).toBe("backend");
  });

  it("returns null for an unknown target", () => {
    expect(resolve("nothing-here", index)).toBeNull();
  });

  it("returns null for an unslugifiable target", () => {
    expect(resolve("!!!", index)).toBeNull();
    expect(resolve("", index)).toBeNull();
  });

  // A trashed note has released its names, so it must not be linkable.
  it("never resolves to a note with no address", () => {
    const withTrash = [...index, entry(null)];
    expect(resolve("trashed", withTrash)).toBeNull();
    expect(resolve("", withTrash)).toBeNull();
  });
});

describe("noteHref", () => {
  it("builds the routed path", () => {
    expect(noteHref("deploy-pipeline")).toBe("/secret/notes/deploy-pipeline");
  });
});

describe("titleFromSlug", () => {
  it("reads back as words", () => {
    expect(titleFromSlug("deploy-pipeline")).toBe("Deploy Pipeline");
    expect(titleFromSlug("a")).toBe("A");
  });

  it("falls back rather than returning nothing", () => {
    expect(titleFromSlug("")).toBe("Untitled");
  });
});

describe("tagMatches", () => {
  it("matches a tag and its descendants, not its siblings", () => {
    expect(tagMatches("infra", "infra")).toBe(true);
    expect(tagMatches("infra/prod", "infra")).toBe(true);
    expect(tagMatches("infrastructure", "infra")).toBe(false);
    expect(tagMatches("infra", "infra/prod")).toBe(false);
  });
});
