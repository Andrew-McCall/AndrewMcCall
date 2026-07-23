// Small markdown renderer for blog posts and the intro blurb. Sanitizing by
// construction: every line is HTML-escaped before any inline markup is applied,
// and links only ever get http(s) or site-relative hrefs. No raw HTML pass-through.

import { esc } from "./helpers";

const inline = (text: string): string =>
  esc(text)
    .replace(/`([^`]+)`/g, `<code class="bg-stone-900 text-lime-300 px-1">$1</code>`)
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/\*([^*]+)\*/g, "<em>$1</em>")
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (match, label, url) => {
      if (!/^(https?:\/\/|\/)/.test(url)) return match;
      const external = url.startsWith("http");
      return `<a href="${url}" class="text-green-500 hover:text-green-400 underline"${
        external ? ` target="_blank" rel="noopener"` : ""
      }>${label}</a>`;
    });

export function renderMarkdown(md: string): string {
  const out: string[] = [];
  const lines = md.replace(/\r\n/g, "\n").split("\n");
  let paragraph: string[] = [];
  let list: { ordered: boolean; items: string[] } | null = null;
  let code: string[] | null = null;

  const flushParagraph = () => {
    if (paragraph.length === 0) return;
    out.push(`<p class="leading-relaxed">${inline(paragraph.join(" "))}</p>`);
    paragraph = [];
  };
  const flushList = () => {
    if (!list) return;
    const tag = list.ordered ? "ol" : "ul";
    const style = list.ordered ? "list-decimal" : "list-disc";
    out.push(
      `<${tag} class="${style} pl-6 flex flex-col gap-1">${list.items
        .map((item) => `<li>${inline(item)}</li>`)
        .join("")}</${tag}>`,
    );
    list = null;
  };

  for (const line of lines) {
    if (code) {
      if (line.startsWith("```")) {
        out.push(
          `<pre class="bg-stone-900 border border-green-900 p-3 overflow-x-auto"><code class="text-lime-300 text-sm">${esc(code.join("\n"))}</code></pre>`,
        );
        code = null;
      } else {
        code.push(line);
      }
      continue;
    }
    if (line.startsWith("```")) {
      flushParagraph();
      flushList();
      code = [];
      continue;
    }

    const heading = line.match(/^(#{1,3})\s+(.*)$/);
    if (heading) {
      flushParagraph();
      flushList();
      const level = heading[1].length;
      const sizes = ["text-2xl", "text-xl", "text-lg"];
      // Slugified id so headings are deep-linkable; a hover-revealed anchor
      // exposes the link without cluttering the prose.
      const id = esc(
        heading[2]
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, "-")
          .replace(/^-+|-+$/g, ""),
      );
      out.push(
        `<h${level + 1} id="${id}" class="group ${sizes[level - 1]} font-bold text-green-400 mt-4 scroll-mt-20">` +
          `<a href="#${id}" class="no-underline">${inline(heading[2])}` +
          `<span class="opacity-0 group-hover:opacity-100 text-green-700 ml-2">#</span></a>` +
          `</h${level + 1}>`,
      );
      continue;
    }

    const bullet = line.match(/^\s*[-*]\s+(.*)$/);
    const numbered = line.match(/^\s*\d+\.\s+(.*)$/);
    if (bullet || numbered) {
      flushParagraph();
      const ordered = !!numbered;
      if (!list || list.ordered !== ordered) {
        flushList();
        list = { ordered, items: [] };
      }
      list.items.push((bullet ?? numbered)![1]);
      continue;
    }

    if (line.match(/^\s*(---+|\*\*\*+)\s*$/)) {
      flushParagraph();
      flushList();
      out.push(`<hr class="border-green-900" />`);
      continue;
    }

    const quote = line.match(/^>\s?(.*)$/);
    if (quote) {
      flushParagraph();
      flushList();
      out.push(
        `<blockquote class="border-l-2 border-green-700 pl-3 text-stone-400 italic">${inline(quote[1])}</blockquote>`,
      );
      continue;
    }

    if (line.trim() === "") {
      flushParagraph();
      flushList();
      continue;
    }

    flushList();
    paragraph.push(line.trim());
  }

  if (code) {
    out.push(
      `<pre class="bg-stone-900 border border-green-900 p-3 overflow-x-auto"><code class="text-lime-300 text-sm">${esc(code.join("\n"))}</code></pre>`,
    );
  }
  flushParagraph();
  flushList();
  return out.join("\n");
}
