// Filtering logic for the note browser.
//
// These exist because the metadata filter shipped inert once already: the state
// field was declared, the menu was rendered, and nothing ever read it. Pure
// functions with tests are the part that can't quietly do nothing.

import { describe, expect, it } from "vitest";
import type { NoteIndexEntry } from "./api";
import { applyFilters, buildPropertyIndex, buildTagTree, initialState } from "./browser";

const note = (over: Partial<NoteIndexEntry> = {}): NoteIndexEntry => ({
  id: over.id ?? "1",
  slug: over.slug ?? "a-note",
  title: over.title ?? "A Note",
  tags: over.tags ?? [],
  names: over.names ?? [over.slug ?? "a-note"],
  udf: over.udf ?? [],
  excerpt: over.excerpt ?? "",
  created_at: over.created_at ?? "2026-01-01T00:00:00Z",
  updated_at: over.updated_at ?? "2026-01-01T00:00:00Z",
});

const state = (over: Partial<ReturnType<typeof initialState>> = {}) => ({
  ...initialState(),
  ...over,
});

describe("tag filtering", () => {
  const notes = [
    note({ id: "1", tags: ["infra"] }),
    note({ id: "2", tags: ["infra/prod"] }),
    note({ id: "3", tags: ["personal"] }),
  ];

  it("includes nested tags under their parent", () => {
    const ids = applyFilters(notes, state({ tag: "infra" })).map((n) => n.id);
    expect(ids.sort()).toEqual(["1", "2"]);
  });

  it("does not match a parent when filtering on the child", () => {
    expect(applyFilters(notes, state({ tag: "infra/prod" })).map((n) => n.id)).toEqual(["2"]);
  });

  it("returns everything with no filter", () => {
    expect(applyFilters(notes, state())).toHaveLength(3);
  });
});

describe("metadata filtering", () => {
  const notes = [
    note({ id: "1", udf: [{ key: "client", value: "acme" }] }),
    note({ id: "2", udf: [{ key: "client", value: "globex" }] }),
    note({ id: "3", udf: [{ key: "status", value: "acme" }] }), // same value, other key
    note({ id: "4" }),
  ];

  it("keeps only notes carrying the exact key and value", () => {
    const ids = applyFilters(notes, state({ meta: { key: "client", value: "acme" } })).map(
      (n) => n.id,
    );
    expect(ids).toEqual(["1"]);
  });

  it("does not match the same value under a different key", () => {
    const ids = applyFilters(notes, state({ meta: { key: "status", value: "acme" } })).map(
      (n) => n.id,
    );
    expect(ids).toEqual(["3"]);
  });

  it("combines with a tag filter", () => {
    const tagged = [
      note({ id: "1", tags: ["work"], udf: [{ key: "client", value: "acme" }] }),
      note({ id: "2", tags: ["home"], udf: [{ key: "client", value: "acme" }] }),
    ];
    const ids = applyFilters(
      tagged,
      state({ tag: "work", meta: { key: "client", value: "acme" } }),
    ).map((n) => n.id);
    expect(ids).toEqual(["1"]);
  });

  it("matches nothing when no note has the property", () => {
    expect(applyFilters(notes, state({ meta: { key: "nope", value: "x" } }))).toEqual([]);
  });
});

describe("search", () => {
  const notes = [
    note({ id: "1", title: "Deploy Pipeline", slug: "deploy-pipeline", names: ["deploy-pipeline"] }),
    note({ id: "2", title: "Backend", excerpt: "about deployment", names: ["backend"] }),
    note({ id: "3", title: "Other", names: ["other", "old-deploy"] }),
    note({ id: "4", title: "Tagged", tags: ["deployment"], names: ["tagged"] }),
    note({ id: "5", title: "Propertied", udf: [{ key: "env", value: "deploy-target" }], names: ["p"] }),
  ];

  it("matches title, excerpt, tags, properties and aliases", () => {
    const ids = applyFilters(notes, state({ search: "deploy" })).map((n) => n.id);
    expect(ids.sort()).toEqual(["1", "2", "3", "4", "5"]);
  });

  it("is case-insensitive", () => {
    for (const q of ["deploy pipeline", "DEPLOY PIPELINE", "Deploy Pipeline"]) {
      expect(applyFilters(notes, state({ search: q })).map((n) => n.id)).toEqual(["1"]);
    }
  });
});

describe("sorting", () => {
  const notes = [
    note({ id: "1", title: "B", updated_at: "2026-01-02T00:00:00Z", created_at: "2026-01-03T00:00:00Z" }),
    note({ id: "2", title: "A", updated_at: "2026-01-03T00:00:00Z", created_at: "2026-01-01T00:00:00Z" }),
  ];

  it("orders by most recently updated, created, or title", () => {
    expect(applyFilters(notes, state({ sort: "updated" })).map((n) => n.id)).toEqual(["2", "1"]);
    expect(applyFilters(notes, state({ sort: "created" })).map((n) => n.id)).toEqual(["1", "2"]);
    expect(applyFilters(notes, state({ sort: "title" })).map((n) => n.id)).toEqual(["2", "1"]);
  });

  it("does not mutate the input array", () => {
    const original = [...notes];
    applyFilters(notes, state({ sort: "title" }));
    expect(notes).toEqual(original);
  });
});

describe("buildPropertyIndex", () => {
  it("counts notes per key and value", () => {
    const index = buildPropertyIndex([
      note({ id: "1", udf: [{ key: "client", value: "acme" }] }),
      note({ id: "2", udf: [{ key: "client", value: "acme" }] }),
      note({ id: "3", udf: [{ key: "client", value: "globex" }] }),
    ]);
    expect(index.get("client")).toEqual(new Map([["acme", 2], ["globex", 1]]));
  });

  it("is empty when nothing has properties", () => {
    expect(buildPropertyIndex([note()]).size).toBe(0);
  });
});

describe("buildTagTree", () => {
  it("nests on slashes and counts ancestors", () => {
    const tree = buildTagTree([
      note({ id: "1", tags: ["infra/prod"] }),
      note({ id: "2", tags: ["infra"] }),
    ]);
    expect(tree).toHaveLength(1);
    expect(tree[0].full).toBe("infra");
    // Both notes count toward the parent; only one toward the child.
    expect(tree[0].count).toBe(2);
    expect(tree[0].children[0].full).toBe("infra/prod");
    expect(tree[0].children[0].count).toBe(1);
  });
});
