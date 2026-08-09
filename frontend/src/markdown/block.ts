// Stage one of the renderer: lines in, block tokens out. No HTML is produced
// here, which is what lets the outline (and anything else that wants structure
// rather than markup) reuse the same parse.
//
// Block text is kept *raw* — unescaped, and with markers like `[ ]` still
// attached. Escaping happens once, in inline.ts, immediately before markup is
// applied; keeping that in exactly one place is the renderer's whole safety
// story.

export type Block =
  | { kind: "heading"; level: number; text: string }
  | { kind: "paragraph"; text: string }
  | { kind: "list"; ordered: boolean; items: string[] }
  | { kind: "code"; lang: string; text: string }
  | { kind: "quote"; text: string }
  | { kind: "rule" }
  | { kind: "table"; head: string[]; rows: string[][] };

export interface BlockOptions {
  /** Deepest `#` level treated as a heading. Beyond it, the line is prose. */
  headingLevels?: number;
  /** Parse `| a | b |` grids. Off by default: the blog doesn't use them. */
  tables?: boolean;
}

const splitRow = (line: string): string[] =>
  line
    .trim()
    .replace(/^\||\|$/g, "")
    .split("|")
    .map((cell) => cell.trim());

/** A `|---|:--:|` divider, which is what distinguishes a table from prose. */
const isDivider = (line: string): boolean =>
  /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(line) &&
  line.includes("-");

export function parseBlocks(md: string, opts: BlockOptions = {}): Block[] {
  const headingLevels = opts.headingLevels ?? 3;
  const out: Block[] = [];
  const lines = md.replace(/\r\n/g, "\n").split("\n");

  let paragraph: string[] = [];
  let list: { ordered: boolean; items: string[] } | null = null;
  let code: { lang: string; lines: string[] } | null = null;

  const flushParagraph = () => {
    if (paragraph.length === 0) return;
    // Wrapped lines join into one paragraph with single spaces.
    out.push({ kind: "paragraph", text: paragraph.join(" ") });
    paragraph = [];
  };
  const flushList = () => {
    if (!list) return;
    out.push({ kind: "list", ordered: list.ordered, items: list.items });
    list = null;
  };
  const flushBoth = () => {
    flushParagraph();
    flushList();
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Inside a fence, everything is literal until the closing ```.
    if (code) {
      if (line.startsWith("```")) {
        out.push({ kind: "code", lang: code.lang, text: code.lines.join("\n") });
        code = null;
      } else {
        code.lines.push(line);
      }
      continue;
    }
    if (line.startsWith("```")) {
      flushBoth();
      code = { lang: line.slice(3).trim(), lines: [] };
      continue;
    }

    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    if (heading && heading[1].length <= headingLevels) {
      flushBoth();
      out.push({ kind: "heading", level: heading[1].length, text: heading[2] });
      continue;
    }

    const bullet = line.match(/^\s*[-*]\s+(.*)$/);
    const numbered = line.match(/^\s*\d+\.\s+(.*)$/);
    if (bullet || numbered) {
      flushParagraph();
      const ordered = !!numbered;
      // A change of marker type starts a new list rather than mixing them.
      if (!list || list.ordered !== ordered) {
        flushList();
        list = { ordered, items: [] };
      }
      list.items.push((bullet ?? numbered)![1]);
      continue;
    }

    if (line.match(/^\s*(---+|\*\*\*+)\s*$/)) {
      flushBoth();
      out.push({ kind: "rule" });
      continue;
    }

    // A table is only a table if a divider follows the header row, so an
    // ordinary sentence containing a pipe stays prose.
    if (opts.tables && line.includes("|") && isDivider(lines[i + 1] ?? "")) {
      flushBoth();
      const head = splitRow(line);
      const rows: string[][] = [];
      i++; // consume the divider
      while (i + 1 < lines.length && lines[i + 1].includes("|")) {
        rows.push(splitRow(lines[++i]));
      }
      out.push({ kind: "table", head, rows });
      continue;
    }

    const quote = line.match(/^>\s?(.*)$/);
    if (quote) {
      flushBoth();
      out.push({ kind: "quote", text: quote[1] });
      continue;
    }

    if (line.trim() === "") {
      flushBoth();
      continue;
    }

    flushList();
    paragraph.push(line.trim());
  }

  // An unclosed fence still emits its content rather than swallowing it.
  if (code) out.push({ kind: "code", lang: code.lang, text: code.lines.join("\n") });
  flushBoth();
  return out;
}
