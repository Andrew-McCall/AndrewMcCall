// TypeScript mirror of `backend/src/notes/frontmatter.rs`.
//
// The server is authoritative — it re-derives everything on save — but the
// editor needs to read properties live (to show the tag chips while you type)
// and to patch `tags:` / `aliases:` without a round trip. Keep the two in step;
// `frontmatter.test.ts` runs both against the same cases.

export interface Frontmatter {
  /** Entries in source order. A scalar is a one-element array. */
  entries: [key: string, values: string[]][];
  /** Byte offset where content after the block begins; 0 when there is none. */
  contentStart: number;
}

const EMPTY: Frontmatter = { entries: [], contentStart: 0 };

const unquote = (raw: string): string => {
  const t = raw.trim();
  for (const q of ['"', "'"]) {
    if (t.length >= 2 && t.startsWith(q) && t.endsWith(q)) return t.slice(1, -1);
  }
  return t;
};

const isKey = (s: string): boolean => /^[A-Za-z0-9_-]+$/.test(s);

const inlineList = (raw: string): string[] =>
  raw
    .replace(/^\[/, "")
    .replace(/\]$/, "")
    .split(",")
    .map(unquote)
    .filter((v) => v !== "");

export function parse(text: string): Frontmatter {
  const firstLine = (text.split("\n")[0] ?? "").replace(/\r$/, "");
  if (firstLine.trimEnd() !== "---") return EMPTY;

  const lines = text.split("\n");
  const entries: [string, string[]][] = [];
  let pendingKey: string | null = null;
  let closed = false;
  // Start of the line about to be read. Accumulated as we go rather than
  // re-summed each iteration: a note whose first line is `---` used as a
  // horizontal rule never reaches a terminator, so this loop can run the length
  // of the whole document.
  let offset = lines[0].length + 1;

  for (let i = 1; i < lines.length; i++) {
    const raw = lines[i];
    const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    offset += raw.length + 1; // now the start of the next line

    if (line.trimEnd() === "---") {
      closed = true;
      break;
    }

    const item = line.trimStart();
    if (item.startsWith("- ") && pendingKey) {
      const value = unquote(item.slice(2));
      if (value) entries.find(([k]) => k === pendingKey)?.[1].push(value);
      continue;
    }

    const colon = line.indexOf(":");
    if (colon > -1) {
      const key = line.slice(0, colon).trim().toLowerCase();
      if (isKey(key)) {
        const rawValue = line.slice(colon + 1).trim();
        const values = !rawValue
          ? []
          : rawValue.startsWith("[")
            ? inlineList(rawValue)
            : [unquote(rawValue)];
        const existing = entries.find(([k]) => k === key);
        // Last wins, keeping the original position.
        if (existing) existing[1] = values;
        else entries.push([key, values]);
        pendingKey = key;
        continue;
      }
    }
    pendingKey = null;
  }

  // No terminator: never a frontmatter block, so nothing is swallowed.
  if (!closed) return EMPTY;
  return { entries, contentStart: Math.min(offset, text.length) };
}

export const get = (fm: Frontmatter, key: string): string[] =>
  fm.entries.find(([k]) => k === key)?.[1] ?? [];

export const first = (fm: Frontmatter, key: string): string | undefined =>
  get(fm, key)[0];

export const contentOf = (text: string, fm: Frontmatter): string =>
  text.slice(Math.min(fm.contentStart, text.length));

/** Block form always: it needs no escaping, so a comma can't corrupt the doc. */
const renderEntry = (key: string, values: string[]): string => {
  const clean = (v: string) => v.replace(/[\r\n]/g, " ");
  if (values.length === 0) return `${key}:\n`;
  if (values.length === 1) return `${key}: ${clean(values[0])}\n`;
  return `${key}:\n` + values.map((v) => `  - ${clean(v)}\n`).join("");
};

/**
 * Rewrites one list-valued key, leaving every other line — unknown keys,
 * ordering, spacing — byte-identical.
 *
 * The narrowest possible edit on purpose: it is the only thing the Properties
 * panel is allowed to do to your text, so there is no whole-block serializer to
 * lose comments or reorder keys. Empty `values` removes the key.
 */
export function patchList(text: string, key: string, values: string[]): string {
  key = key.toLowerCase();
  const fm = parse(text);

  if (fm.contentStart === 0) {
    if (values.length === 0) return text;
    const separator = text ? "\n" : "";
    return `---\n${renderEntry(key, values)}---\n${separator}${text}`;
  }

  const block = text.slice(0, fm.contentStart);
  const content = text.slice(fm.contentStart);
  let out = "";
  let replaced = false;
  let skipping = false;

  for (const rawLine of block.split(/(?<=\n)/)) {
    const trimmed = rawLine.replace(/[\r\n]+$/, "");

    if (skipping) {
      if (trimmed.trimStart().startsWith("- ")) continue;
      skipping = false;
    }

    const colon = trimmed.indexOf(":");
    const isTarget =
      colon > -1 && trimmed.slice(0, colon).trim().toLowerCase() === key;

    if (isTarget && !replaced) {
      replaced = true;
      skipping = true;
      if (values.length) out += renderEntry(key, values);
      continue;
    }

    // Insert before the closing `---` when the key wasn't already there.
    if (trimmed.trimEnd() === "---" && !replaced && out !== "") {
      replaced = true;
      if (values.length) out += renderEntry(key, values);
    }

    out += rawLine;
  }

  return out + content;
}

/** The frontmatter stub a brand-new note starts from. */
export const stub = (title: string): string =>
  `---\ntitle: ${title.replace(/[\r\n]/g, " ")}\ntags:\n---\n\n`;
