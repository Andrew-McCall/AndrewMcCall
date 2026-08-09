// Two kinds of test, deliberately different in character:
//
//   * The snapshot block pins *formatting* — the exact HTML the renderer emits
//     today. Its job is to prove the markdown/ refactor changes nothing the blog
//     renders, so a diff here means "you altered output", not "you broke it".
//
//   * The safety block uses hard assertions, never snapshots. The renderer's
//     security rests on one invariant — escape every line before applying any
//     markup — and a snapshot would let a regression be blessed by rerunning
//     with -u. These must fail loudly instead.

import { describe, expect, it } from "vitest";
import { renderMarkdown } from "./markdown";

// One entry per code path in the renderer, so the snapshot covers the whole
// surface rather than whatever a sample post happened to use.
const CASES: [name: string, md: string][] = [
  ["heading levels", "# One\n## Two\n### Three"],
  ["heading beyond h3 is a paragraph", "#### Four\n##### Five"],
  ["heading id slugification", "## Hello, World! (v2)"],
  ["paragraph joins wrapped lines", "one\ntwo\nthree"],
  ["paragraphs split on blank line", "first para\n\nsecond para"],
  ["bullet list with both markers", "- alpha\n* beta\n- gamma"],
  ["numbered list", "1. first\n2. second\n10. tenth"],
  ["list type transition", "- bullet\n1. numbered\n- bullet again"],
  ["indented list items", "  - indented\n  - also"],
  ["fenced code block", "```\nlet x = 1;\n<b>not html</b>\n```"],
  ["fenced code with language", "```rust\nfn main() {}\n```"],
  ["unclosed fence flushes at EOF", "```\nnever closed"],
  ["inline code", "use `cargo test` here"],
  ["bold and italic", "**bold** and *italic* and **both** *mixed*"],
  ["external link", "see [the site](https://example.com) now"],
  ["relative link", "see [posts](/posts) now"],
  ["link with disallowed scheme is literal", "[x](mailto:a@b.c) [y](ftp://h/f)"],
  ["horizontal rules", "above\n\n---\n\nmiddle\n\n***\n\nbelow"],
  ["blockquote", "> quoted line\n> second line"],
  ["blockquote with markup", "> **bold** in a `quote`"],
  ["crlf line endings", "# Title\r\n\r\ntext\r\n"],
  ["empty input", ""],
  ["whitespace only", "   \n\n  \n"],
  ["everything at once", [
    "# Title",
    "",
    "Intro paragraph with **bold**, *italic*, `code` and a",
    "[link](https://example.com).",
    "",
    "## Section",
    "",
    "- one",
    "- two",
    "",
    "1. first",
    "2. second",
    "",
    "> a quote",
    "",
    "```js",
    "const x = 1;",
    "```",
    "",
    "---",
    "",
    "Closing words.",
  ].join("\n")],
];

describe("renderMarkdown formatting", () => {
  it.each(CASES)("%s", (_name, md) => {
    expect(renderMarkdown(md)).toMatchSnapshot();
  });
});

describe("renderMarkdown is safe by construction", () => {
  // Every line is escaped before any markup is applied, so raw HTML can never
  // survive into the output regardless of which block type contains it.
  const RAW_HTML_CONTEXTS: [name: string, md: string][] = [
    ["paragraph", "<script>alert(1)</script>"],
    ["heading", "# <script>alert(1)</script>"],
    ["list item", "- <script>alert(1)</script>"],
    ["numbered item", "1. <script>alert(1)</script>"],
    ["blockquote", "> <script>alert(1)</script>"],
    ["code fence", "```\n<script>alert(1)</script>\n```"],
    ["inline code", "`<script>alert(1)</script>`"],
    ["bold", "**<script>alert(1)</script>**"],
    ["image onerror", `<img src=x onerror="alert(1)">`],
    ["svg onload", "<svg/onload=alert(1)>"],
    ["iframe", `<iframe src="javascript:alert(1)"></iframe>`],
  ];

  it.each(RAW_HTML_CONTEXTS)("escapes raw html in a %s", (_name, md) => {
    const html = renderMarkdown(md);
    // The invariant itself: every `<` in the source arrives as `&lt;`. Testing
    // for absent tag names alone would miss a payload we didn't think of, and
    // testing for strings like `onerror=` gives false alarms — that text is
    // harmless once its surrounding `<` is escaped.
    const sourceAngles = (md.match(/</g) ?? []).length;
    const escapedAngles = (html.match(/&lt;/g) ?? []).length;
    expect(escapedAngles).toBe(sourceAngles);
    expect(html).not.toContain("<script");
    expect(html).not.toContain("<img");
    expect(html).not.toContain("<svg");
    expect(html).not.toContain("<iframe");
  });

  it("refuses a javascript: link target", () => {
    // Left as literal text, so the string "javascript:" is still present — what
    // must not exist is an anchor carrying it.
    const html = renderMarkdown("[click](javascript:alert(1))");
    expect(html).not.toContain("<a ");
    expect(html).not.toMatch(/href=/);
  });

  it("refuses data: and vbscript: link targets", () => {
    const html = renderMarkdown(
      "[a](data:text/html,<script>alert(1)</script>) [b](vbscript:msgbox)",
    );
    expect(html).not.toContain("<a ");
    expect(html).not.toContain("<script");
  });

  it("allows only http(s) and site-relative hrefs", () => {
    const html = renderMarkdown("[a](https://x.test) [b](/posts) [c](../up)");
    expect(html).toContain(`href="https://x.test"`);
    expect(html).toContain(`href="/posts"`);
    expect(html).not.toContain(`href="../up"`);
  });

  it("gives external links noopener, and internal links none", () => {
    expect(renderMarkdown("[a](https://x.test)")).toContain(`rel="noopener"`);
    expect(renderMarkdown("[b](/posts)")).not.toContain("noopener");
  });

  // A quote inside a link target survives escaping as `&quot;`, which has no
  // whitespace and so still matches the URL pattern. It cannot break out of the
  // attribute — inside a double-quoted value `&quot;` is a literal character,
  // not a delimiter — but it is the closest thing to an injection this renderer
  // has, so pin it.
  it("cannot break out of an href attribute", () => {
    const html = renderMarkdown(`[a](/x"onmouseover=alert)`);
    expect(html).not.toMatch(/\sonmouseover=/);
    expect(html).toContain("&quot;");
  });

  it("keeps heading ids to a safe charset and escapes the text", () => {
    const html = renderMarkdown(`## a"b<c`);
    expect(html.match(/id="([^"]*)"/)?.[1]).toMatch(/^[a-z0-9-]*$/);
    expect(html).not.toContain("<c");
    expect(html).toContain("&quot;");
  });
});
