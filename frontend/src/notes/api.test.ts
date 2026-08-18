// Cache normalisation.
//
// localStorage survives a deploy, so an entry written by an older shape can be
// missing a field today's code treats as an array. `note.udf.some(...)` on
// `undefined` throws, and it would take the whole browser down rather than
// degrade — so reads coerce rather than trust.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { NotesStore } from "./api";
import { applyFilters, initialState } from "./browser";

// Minimal in-memory localStorage; the module reads it at call time.
const backing = new Map<string, string>();
vi.stubGlobal("localStorage", {
  getItem: (k: string) => backing.get(k) ?? null,
  setItem: (k: string, v: string) => void backing.set(k, v),
  removeItem: (k: string) => void backing.delete(k),
});

const UID = "user-1";
const store = new NotesStore(UID);

beforeEach(() => backing.clear());

describe("cachedIndex", () => {
  it("returns null when nothing is cached", () => {
    expect(store.cachedIndex()).toBeNull();
  });

  it("round-trips a current-shape entry", () => {
    const entry = {
      id: "1",
      slug: "a",
      title: "A",
      tags: ["t"],
      names: ["a"],
      udf: [{ key: "client", value: "acme" }],
      excerpt: "",
      created_at: "2026-01-01T00:00:00Z",
      updated_at: "2026-01-01T00:00:00Z",
    };
    store.cacheIndex([entry]);
    expect(store.cachedIndex()).toEqual([entry]);
  });

  it("fills in array fields missing from an older cache", () => {
    // Written before `udf` and `names` existed.
    backing.set(
      `notes:index:${UID}`,
      JSON.stringify([{ id: "1", slug: "a", title: "A", excerpt: "", created_at: "x", updated_at: "y" }]),
    );
    const cached = store.cachedIndex()!;
    expect(cached[0].udf).toEqual([]);
    expect(cached[0].names).toEqual([]);
    expect(cached[0].tags).toEqual([]);
  });

  it("survives being filtered after an older cache is loaded", () => {
    // The actual failure mode: a filter calling .some() on undefined.
    backing.set(
      `notes:index:${UID}`,
      JSON.stringify([{ id: "1", slug: "a", title: "Deploy", excerpt: "", created_at: "x", updated_at: "y" }]),
    );
    const cached = store.cachedIndex()!;
    expect(() => applyFilters(cached, { ...initialState(), search: "deploy" })).not.toThrow();
    expect(
      applyFilters(cached, { ...initialState(), meta: { key: "client", value: "acme" } }),
    ).toEqual([]);
  });
});

describe("cachedNote", () => {
  it("fills in every list field missing from an older cache", () => {
    backing.set(
      `notes:note:${UID}:1`,
      JSON.stringify({ id: "1", slug: "a", title: "A", body: "x", created_at: "p", updated_at: "q" }),
    );
    const note = store.cachedNote("1")!;
    expect(note.tags).toEqual([]);
    expect(note.names).toEqual([]);
    expect(note.udf).toEqual([]);
    expect(note.links).toEqual([]);
    expect(note.backlinks).toEqual([]);
  });

  it("returns null for a note that isn't cached", () => {
    expect(store.cachedNote("missing")).toBeNull();
  });
});

describe("drafts", () => {
  it("round-trips and clears", () => {
    store.saveDraft("1", "hello");
    expect(store.draft("1")?.body).toBe("hello");
    store.clearDraft("1");
    expect(store.draft("1")).toBeNull();
  });

  it("scopes storage per user", () => {
    store.saveDraft("1", "mine");
    expect(new NotesStore("user-2").draft("1")).toBeNull();
  });
});
