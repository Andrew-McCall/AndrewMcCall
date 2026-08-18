// Stage three: block tokens to HTML. Every class string here is load-bearing —
// it is what the blog already renders — so changes show up as a snapshot diff.

import { esc } from "../helpers";
import { headingId, inline, type InlineOptions } from "./inline";
import type { Block } from "./block";

export interface RenderOptions extends InlineOptions {
  /** Render `- [ ]` / `- [x]` items as checkboxes instead of literal text. */
  tasks?: boolean;
}

// Indexed by heading level. Levels 4-6 only appear when the caller raises
// `headingLevels`, so the blog never reaches them.
const SIZES = ["text-2xl", "text-xl", "text-lg", "text-base", "text-sm", "text-sm"];

const CODE_BLOCK = "bg-stone-900 border border-green-900 p-3 overflow-x-auto";

const renderTaskItem = (item: string): string | null => {
  const m = item.match(/^\[([ xX])\]\s+(.*)$/);
  if (!m) return null;
  const done = m[1].toLowerCase() === "x";
  return (
    `<li class="flex items-start gap-2 -ml-4 list-none">` +
    `<input type="checkbox" disabled${done ? " checked" : ""} class="mt-1 accent-green-600" />` +
    `<span${done ? ` class="line-through text-stone-500"` : ""}>${inline(m[2])}</span>` +
    `</li>`
  );
};

const renderBlock = (block: Block, opts: RenderOptions): string => {
  switch (block.kind) {
    case "heading": {
      const id = headingId(block.text);
      // Shifted down one: the page already owns the h1, so `#` is an h2. Capped
      // at h6, since `###### x` would otherwise ask for a nonexistent h7.
      const tag = `h${Math.min(block.level + 1, 6)}`;
      // A hover-revealed anchor makes the heading deep-linkable without
      // cluttering the prose.
      return (
        `<${tag} id="${id}" class="group ${SIZES[block.level - 1]} font-bold text-green-400 mt-4 scroll-mt-20">` +
        `<a href="#${id}" class="no-underline">${inline(block.text, opts)}` +
        `<span class="opacity-0 group-hover:opacity-100 text-green-700 ml-2">#</span></a>` +
        `</${tag}>`
      );
    }
    case "paragraph":
      return `<p class="leading-relaxed">${inline(block.text, opts)}</p>`;
    case "list": {
      const tag = block.ordered ? "ol" : "ul";
      const style = block.ordered ? "list-decimal" : "list-disc";
      const items = block.items
        .map((item) => {
          if (opts.tasks) {
            const task = renderTaskItem(item);
            if (task) return task;
          }
          return `<li>${inline(item, opts)}</li>`;
        })
        .join("");
      return `<${tag} class="${style} pl-6 flex flex-col gap-1">${items}</${tag}>`;
    }
    case "code":
      return `<pre class="${CODE_BLOCK}"><code class="text-lime-300 text-sm">${esc(block.text)}</code></pre>`;
    case "quote":
      return `<blockquote class="border-l-2 border-green-700 pl-3 text-stone-400 italic">${inline(block.text, opts)}</blockquote>`;
    case "rule":
      return `<hr class="border-green-900" />`;
    case "table": {
      const head = block.head
        .map((c) => `<th class="border border-green-900 px-2 py-1 text-left text-green-400">${inline(c, opts)}</th>`)
        .join("");
      const body = block.rows
        .map(
          (row) =>
            `<tr>${row
              .map((c) => `<td class="border border-green-900 px-2 py-1">${inline(c, opts)}</td>`)
              .join("")}</tr>`,
        )
        .join("");
      // Wrapped so a wide table scrolls itself instead of the page.
      return (
        `<div class="overflow-x-auto"><table class="border-collapse text-sm">` +
        `<thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>`
      );
    }
  }
};

export const renderBlocks = (blocks: Block[], opts: RenderOptions = {}): string =>
  blocks.map((block) => renderBlock(block, opts)).join("\n");
