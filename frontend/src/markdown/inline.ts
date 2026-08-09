// Stage two: inline markup within a block's text.
//
// The one rule that matters: `esc()` runs first, on the raw text, before any
// markup is applied. Every replacement below therefore operates on text that
// can no longer contain an active `<`, so no input can introduce a tag or an
// attribute. Anything added here must keep that ordering.

import { esc } from "../helpers";

/// What a `[[wikilink]]` target resolves to. `null` means no such note yet —
/// which is the only "doesn't exist" signal needed, so there is no redundant
/// flag alongside it.
export type WikiTarget = { href: string } | null;

export interface InlineOptions {
  /** Enables `[[target]]`, `[[target|label]]` and `[[target#heading]]`. */
  wikilink?: (target: string) => WikiTarget;
  /** Turns bare `https://…` runs into links. */
  autolink?: boolean;
}

const LINK_CLASS = "text-green-500 hover:text-green-400 underline";

// Spans whose contents must not be touched by later passes: a URL inside an
// href, or anything the author wrote inside backticks.
const PROTECTED = /<(a|code)\b[^>]*>[\s\S]*?<\/\1>/g;

/** Applies `fn` only to the parts of `html` outside links and code spans. */
const outsideProtected = (html: string, fn: (s: string) => string): string => {
  let out = "";
  let last = 0;
  for (const m of html.matchAll(PROTECTED)) {
    out += fn(html.slice(last, m.index)) + m[0];
    last = m.index + m[0].length;
  }
  return out + fn(html.slice(last));
};

/** Slug used for heading anchors, and for `[[note#heading]]` fragments. */
export const headingId = (text: string): string =>
  esc(
    text
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, ""),
  );

// Trailing punctuation is almost always sentence punctuation rather than part
// of the URL, so it is left outside the link.
const BARE_URL = /(https?:\/\/[^\s<]*[^\s<.,;:!?)\]}'"])/g;

const renderWikilink = (raw: string, resolve: (t: string) => WikiTarget): string => {
  // `target|label` and `target#heading` may combine: `[[note#top|see here]]`.
  const [targetPart, labelPart] = raw.split("|", 2);
  const [name, fragment] = targetPart.split("#", 2);
  const label = (labelPart ?? targetPart).trim();

  // `[[#heading]]` is a jump within the current note.
  if (name.trim() === "" && fragment) {
    return `<a href="#${headingId(fragment)}" class="${LINK_CLASS}">${label}</a>`;
  }

  const target = resolve(name.trim());
  if (!target) {
    // Dangling: still a link, so it can be clicked to create the note, but
    // visibly distinct from one that resolves.
    return `<a href="#" data-wikilink="${esc(name.trim())}" class="text-green-700 underline decoration-dashed hover:text-green-500">${label}</a>`;
  }
  const href = fragment ? `${target.href}#${headingId(fragment)}` : target.href;
  return `<a href="${href}" class="${LINK_CLASS}">${label}</a>`;
};

export function inline(text: string, opts: InlineOptions = {}): string {
  let html = esc(text)
    .replace(/`([^`]+)`/g, `<code class="bg-stone-900 text-lime-300 px-1">$1</code>`)
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/\*([^*]+)\*/g, "<em>$1</em>")
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (match, label, url) => {
      // Only http(s) and site-relative targets become links; anything else
      // (javascript:, data:, mailto:) stays as the literal, escaped text.
      if (!/^(https?:\/\/|\/)/.test(url)) return match;
      const external = url.startsWith("http");
      return `<a href="${url}" class="text-green-500 hover:text-green-400 underline"${
        external ? ` target="_blank" rel="noopener"` : ""
      }>${label}</a>`;
    });

  // Wikilinks and autolinks run last, and only outside `<code>`/`<a>` spans, so
  // `[[note]]` inside backticks stays literal and a URL already inside an href
  // isn't linked a second time. With neither option set nothing below runs, and
  // the output above is the blog renderer byte for byte.
  if (opts.wikilink) {
    const resolve = opts.wikilink;
    html = outsideProtected(html, (s) =>
      s.replace(/\[\[([^\]|]*(?:\|[^\]]*)?)\]\]/g, (_m, raw: string) =>
        renderWikilink(raw, resolve),
      ),
    );
  }

  if (opts.autolink) {
    html = outsideProtected(html, (s) =>
      s.replace(
        BARE_URL,
        (url) => `<a href="${url}" class="${LINK_CLASS}" target="_blank" rel="noopener">${url}</a>`,
      ),
    );
  }

  return html;
}
