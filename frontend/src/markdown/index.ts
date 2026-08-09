// Small markdown renderer for blog posts, the intro blurb, and notes.
// Sanitizing by construction: every line is HTML-escaped before any inline
// markup is applied, and links only ever get http(s) or site-relative hrefs.
// No raw HTML pass-through.
//
// Two stages — `parseBlocks` (text → tokens) then `renderBlocks` (tokens →
// HTML) — so the heading outline can reuse the parse instead of scanning the
// markup afterwards.
//
// `renderMarkdown(md)` with no options is the blog's renderer, byte for byte;
// everything notes needs is opt-in. See markdown.test.ts, where the snapshots
// pin the default output and hard assertions pin the escaping.

import { parseBlocks, type Block, type BlockOptions } from "./block";
import { renderBlocks, type RenderOptions } from "./render";
import { outline, type Heading } from "./outline";

export type { Block, Heading, RenderOptions };
export type { WikiTarget } from "./inline";
export { parseBlocks, renderBlocks, outline };

export type MarkdownOptions = BlockOptions & RenderOptions;

export function renderMarkdown(md: string, opts: MarkdownOptions = {}): string {
  return renderBlocks(parseBlocks(md, opts), opts);
}

/** Rendered HTML plus the heading outline, from a single parse. */
export function renderWithOutline(
  md: string,
  opts: MarkdownOptions = {},
): { html: string; headings: Heading[] } {
  const blocks = parseBlocks(md, opts);
  return { html: renderBlocks(blocks, opts), headings: outline(blocks) };
}
