// The opt-in capabilities notes needs. Everything here is off by default —
// markdown.test.ts is what proves the defaults still render the blog unchanged.

import { describe, expect, it } from "vitest";
import { outline, parseBlocks, renderMarkdown, renderWithOutline } from ".";

// Resolves anything but "ghost", so both branches are easy to exercise.
const resolve = (target: string) =>
  target === "ghost" ? null : { href: `/secret/notes/${target}` };
const wiki = { wikilink: resolve };

describe("heading levels", () => {
  it("stops at h3 by default, matching the blog", () => {
    const html = renderMarkdown("#### Four");
    expect(html).toContain("<p");
    expect(html).not.toContain("<h5");
  });

  it("reaches h6 when asked, without inventing an h7", () => {
    const html = renderMarkdown("#### Four\n\n##### Five\n\n###### Six", {
      headingLevels: 6,
    });
    expect(html).toContain("<h5"); // #### is shifted down one, as `#` → h2
    expect(html).toContain("<h6");
    expect(html).not.toContain("<h7");
  });
});

describe("wikilinks", () => {
  it("links a resolved target", () => {
    expect(renderMarkdown("see [[backend]]", wiki)).toContain(
      `href="/secret/notes/backend"`,
    );
  });

  it("marks an unresolved target as dangling and keeps it clickable", () => {
    const html = renderMarkdown("see [[ghost]]", wiki);
    expect(html).toContain(`data-wikilink="ghost"`);
    expect(html).toContain("decoration-dashed");
  });

  it("uses the label after a pipe", () => {
    const html = renderMarkdown("[[backend|the API]]", wiki);
    expect(html).toContain(">the API</a>");
    expect(html).toContain(`href="/secret/notes/backend"`);
  });

  it("targets a heading in another note", () => {
    expect(renderMarkdown("[[backend#Restarting It]]", wiki)).toContain(
      `href="/secret/notes/backend#restarting-it"`,
    );
  });

  it("links within the current note", () => {
    expect(renderMarkdown("[[#Restarting It]]", wiki)).toContain(
      `href="#restarting-it"`,
    );
  });

  it("is inert without the option", () => {
    expect(renderMarkdown("see [[backend]]")).not.toContain("<a ");
  });

  // The rule from the plan: links are never extracted from code.
  it("ignores a wikilink inside inline code", () => {
    const html = renderMarkdown("use `[[backend]]` here", wiki);
    expect(html).not.toContain("<a ");
    expect(html).toContain("[[backend]]");
  });

  it("ignores a wikilink inside a fenced block", () => {
    const html = renderMarkdown("```\n[[backend]]\n```", wiki);
    expect(html).not.toContain("<a ");
    expect(html).toContain("[[backend]]");
  });

  it("escapes a hostile target rather than emitting it raw", () => {
    const html = renderMarkdown(`[[<script>]]`, wiki);
    expect(html).not.toContain("<script");
  });
});

describe("autolink", () => {
  it("links a bare url", () => {
    const html = renderMarkdown("go to https://example.com now", { autolink: true });
    expect(html).toContain(`href="https://example.com"`);
  });

  it("leaves trailing sentence punctuation outside the link", () => {
    const html = renderMarkdown("see https://example.com.", { autolink: true });
    expect(html).toContain(`href="https://example.com"`);
    expect(html).toContain("</a>.");
  });

  it("does not double-link a url already inside a markdown link", () => {
    const html = renderMarkdown("[site](https://example.com)", { autolink: true });
    expect(html.match(/<a /g)).toHaveLength(1);
  });

  it("does not link a url inside code", () => {
    const html = renderMarkdown("`https://example.com`", { autolink: true });
    expect(html).not.toContain("<a ");
  });

  it("is inert without the option", () => {
    expect(renderMarkdown("go to https://example.com")).not.toContain("<a ");
  });
});

describe("task lists", () => {
  it("renders checkboxes when enabled", () => {
    const html = renderMarkdown("- [ ] todo\n- [x] done", { tasks: true });
    expect(html).toContain(`type="checkbox"`);
    expect(html).toContain("checked");
    expect(html).toContain("line-through");
  });

  it("leaves the marker as literal text when disabled", () => {
    const html = renderMarkdown("- [ ] todo");
    expect(html).not.toContain("checkbox");
    expect(html).toContain("[ ] todo");
  });

  it("leaves ordinary items alone", () => {
    const html = renderMarkdown("- plain\n- [x] done", { tasks: true });
    expect(html).toContain("<li>plain</li>");
  });
});

describe("tables", () => {
  const md = "| a | b |\n| --- | --- |\n| 1 | 2 |\n| 3 | 4 |";

  it("renders a grid when enabled", () => {
    const html = renderMarkdown(md, { tables: true });
    expect(html).toContain("<table");
    expect(html).toContain("<th");
    expect(html.match(/<tr>/g)).toHaveLength(3); // header + two rows
  });

  it("scrolls itself rather than the page", () => {
    expect(renderMarkdown(md, { tables: true })).toContain("overflow-x-auto");
  });

  it("is inert without the option", () => {
    expect(renderMarkdown(md)).not.toContain("<table");
  });

  it("does not mistake a sentence containing a pipe for a table", () => {
    const html = renderMarkdown("use a | b in the shell", { tables: true });
    expect(html).not.toContain("<table");
  });

  it("escapes cell content", () => {
    const html = renderMarkdown("| <script> |\n| --- |\n| x |", { tables: true });
    expect(html).not.toContain("<script");
  });
});

describe("outline", () => {
  it("reports headings with ids matching the rendered anchors", () => {
    const md = "# One\n\ntext\n\n## Two Words\n\n### Three";
    const { html, headings } = renderWithOutline(md);
    expect(headings).toEqual([
      { level: 1, text: "One", id: "one" },
      { level: 2, text: "Two Words", id: "two-words" },
      { level: 3, text: "Three", id: "three" },
    ]);
    for (const h of headings) expect(html).toContain(`id="${h.id}"`);
  });

  it("ignores headings inside code blocks", () => {
    expect(outline(parseBlocks("```\n# Not a heading\n```"))).toEqual([]);
  });

  it("is empty for prose", () => {
    expect(outline(parseBlocks("just words"))).toEqual([]);
  });
});
