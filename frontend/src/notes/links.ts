// Slug rules and `[[wikilink]]` resolution, client-side.
//
// `slugify` mirrors `backend/src/slug.rs` exactly — the client resolves links
// against the loaded index without asking the server, so the two must agree
// character for character. `links.test.ts` covers the same cases as the Rust
// tests.

import type { NoteIndexEntry } from "./api";

const MAX_SLUG_LEN = 100;

export function slugify(raw: string): string {
  let out = "";
  let pending = false;
  for (const c of raw) {
    if (/[A-Za-z0-9]/.test(c)) {
      if (pending && out) out += "-";
      pending = false;
      out += c.toLowerCase();
    } else {
      pending = true;
    }
    if (out.length >= MAX_SLUG_LEN) break;
  }
  return out.slice(0, MAX_SLUG_LEN);
}

/** The URL for a note, by slug. Deep-linkable and back-button friendly. */
export const noteHref = (slug: string): string => `/secret/notes/${slug}`;

/**
 * Finds the note a `[[target]]` points at.
 *
 * Matches the primary slug first, then any alias — which is what keeps links
 * working after a rename, since the superseded name stays on the note.
 */
export function resolve(
  target: string,
  index: NoteIndexEntry[],
): NoteIndexEntry | null {
  const slug = slugify(target);
  if (!slug) return null;
  return (
    index.find((n) => n.slug === slug) ??
    index.find((n) => n.names?.includes(slug)) ??
    null
  );
}

/** Turns a slug back into something readable, for a note that doesn't exist. */
export const titleFromSlug = (slug: string): string =>
  slug
    .split("-")
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ") || "Untitled";

/** Splits a nested tag into its path segments: `a/b/c` → `[a, b, c]`. */
export const tagPath = (tag: string): string[] =>
  tag.split("/").filter(Boolean);

/** True when `tag` is `filter` or nested beneath it. */
export const tagMatches = (tag: string, filter: string): boolean =>
  tag === filter || tag.startsWith(`${filter}/`);
