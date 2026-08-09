// Reading view: tag chips, the heading outline, the rendered note, and its
// linked mentions.
//
// The three things at the top — browser (the ☰ in the shell), tags, and
// headings — are the point of this view. On a phone the outline collapses into
// a <details>; from `lg` up the shell moves it to a sticky rail. Same markup.

import { esc } from "../helpers";
import { renderWithOutline, type Heading } from "../markdown";
import type { Note, NoteIndexEntry } from "./api";
import * as fm from "./frontmatter";
import { noteHref, resolve, titleFromSlug } from "./links";

const CHIP =
  "text-green-400 bg-green-900/30 hover:bg-green-900/60 px-2 py-1 text-xs font-mono " +
  "whitespace-nowrap cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-green-500";

const outlineHtml = (headings: Heading[]): string => {
  if (headings.length === 0) return "";
  const min = Math.min(...headings.map((h) => h.level));
  const items = headings
    .map(
      (h) =>
        `<a href="#${h.id}" class="block py-1.5 text-sm text-green-700 hover:text-green-400 truncate"
            style="padding-left:${(h.level - min) * 0.75}rem">${esc(h.text)}</a>`,
    )
    .join("");
  return `
    <details class="mt-3 border-t border-green-900/60 pt-2 lg:hidden" role="navigation" aria-label="On this page">
      <summary class="cursor-pointer select-none text-green-600 font-mono text-xs uppercase tracking-widest py-2 min-h-11 flex items-center">contents</summary>
      <nav class="mt-1">${items}</nav>
    </details>
    <nav class="hidden lg:block" aria-label="On this page" data-outline>${items}</nav>`;
};

const mentions = (title: string, links: { slug: string; title: string | null; id: string | null }[]) => {
  const resolved = links.filter((l) => l.id);
  const dangling = links.filter((l) => !l.id);
  const section = (label: string, body: string) =>
    body
      ? `<section class="mt-8 border-t border-green-900/60 pt-3">
           <h2 class="text-green-700 font-mono text-xs uppercase tracking-widest">${label}</h2>
           <div class="flex flex-wrap gap-2 mt-2">${body}</div>
         </section>`
      : "";

  return (
    section(
      `${title} (${resolved.length})`,
      resolved
        .map(
          (l) =>
            `<a href="${noteHref(l.slug)}" data-nav class="border border-green-900 hover:border-green-600 px-3 py-2 min-h-11 flex items-center text-green-400 text-sm">→ ${esc(l.title ?? l.slug)}</a>`,
        )
        .join(""),
    ) +
    section(
      `unresolved (${dangling.length})`,
      dangling
        .map(
          (l) =>
            `<a href="${noteHref(l.slug)}" data-nav data-create="${esc(l.slug)}"
                class="border border-dashed border-green-900 hover:border-green-600 px-3 py-2 min-h-11 flex items-center text-green-700 text-sm">+ ${esc(titleFromSlug(l.slug))}</a>`,
        )
        .join(""),
    )
  );
};

export interface ReaderCallbacks {
  onTag: (tag: string) => void;
  /** A `[[link]]` to a note that doesn't exist yet. */
  onCreate: (slug: string) => void;
  onNavigate: (href: string) => void;
}

export function renderReader(
  host: HTMLElement,
  note: Note,
  index: NoteIndexEntry[],
  cb: ReaderCallbacks,
): void {
  // Only the prose. `note.body` is the whole file, so rendering it directly
  // printed the frontmatter as a paragraph and turned its `---` delimiters into
  // horizontal rules at the top of every note.
  const content = fm.contentOf(note.body, fm.parse(note.body));

  // Wikilinks resolve against the loaded index, so no round trip and no flash
  // of unresolved links.
  const { html, headings } = renderWithOutline(content, {
    headingLevels: 6,
    tasks: true,
    tables: true,
    autolink: true,
    wikilink: (target) => {
      // A note with no primary name has no address, so it can't be linked to —
      // render the link as dangling rather than pointing at nothing.
      const hit = resolve(target, index);
      return hit?.slug ? { href: noteHref(hit.slug) } : null;
    },
  });

  const properties = note.udf.length
    ? `<dl class="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs font-mono">
         ${note.udf
           .map(
             (m) =>
               `<dt class="text-green-800">${esc(m.key)}</dt><dd class="text-green-500 truncate">${esc(m.value)}</dd>`,
           )
           .join("")}
       </dl>`
    : "";

  host.innerHTML = `
    <article class="max-w-3xl">
      <h1 class="text-2xl md:text-3xl font-bold text-lime-300 break-words">${esc(note.title)}</h1>

      <div class="flex items-center gap-2 mt-2 overflow-x-auto">
        ${note.tags.map((t) => `<button data-tag="${esc(t)}" class="${CHIP}">#${esc(t)}</button>`).join("")}
        <span class="text-green-800 text-xs whitespace-nowrap ml-auto pl-3">
          ${esc(new Date(note.updated_at).toLocaleString())}
        </span>
      </div>
      ${properties}
      ${outlineHtml(headings)}

      <div class="mt-6 flex flex-col gap-3 text-stone-300 leading-relaxed break-words">${html}</div>
      ${mentions("linked mentions", note.links)}
      ${
        note.backlinks.length
          ? `<section class="mt-8 border-t border-green-900/60 pt-3">
               <h2 class="text-green-700 font-mono text-xs uppercase tracking-widest">backlinks (${note.backlinks.length})</h2>
               <div class="flex flex-wrap gap-2 mt-2">
                 ${note.backlinks
                   .map(
                     (l) =>
                       `<a href="${noteHref(l.slug)}" data-nav class="border border-green-900 hover:border-green-600 px-3 py-2 min-h-11 flex items-center text-green-400 text-sm">← ${esc(l.title ?? l.slug)}</a>`,
                   )
                   .join("")}
               </div>
             </section>`
          : ""
      }
    </article>`;

  for (const btn of host.querySelectorAll<HTMLButtonElement>("[data-tag]")) {
    btn.onclick = () => cb.onTag(btn.dataset.tag!);
  }

  // A dangling `[[link]]` in the prose: the renderer marks it rather than
  // linking it, so creation is a deliberate click, not a stray tap.
  for (const el of host.querySelectorAll<HTMLAnchorElement>("[data-wikilink]")) {
    el.onclick = (ev) => {
      ev.preventDefault();
      cb.onCreate(el.dataset.wikilink!);
    };
  }

  for (const el of host.querySelectorAll<HTMLAnchorElement>("[data-nav]")) {
    el.onclick = (ev) => {
      ev.preventDefault();
      const slug = el.dataset.create;
      if (slug) cb.onCreate(titleFromSlug(slug));
      else cb.onNavigate(el.getAttribute("href")!);
    };
  }

  // Internal note links produced by the markdown renderer.
  for (const el of host.querySelectorAll<HTMLAnchorElement>('a[href^="/secret/notes/"]')) {
    if (el.dataset.nav !== undefined) continue;
    el.onclick = (ev) => {
      ev.preventDefault();
      cb.onNavigate(el.getAttribute("href")!);
    };
  }
}
