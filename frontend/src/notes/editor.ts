// Editing view: the raw markdown file, a markup toolbar, `[[` autocomplete, a
// Properties panel, and autosave.
//
// The textarea is the source of truth, frontmatter block and all. The
// Properties panel *edits* exactly two things — `tags:` and the note's names —
// because each is a single well-tested transform over the text (see
// frontmatter.patchList). Every other key is shown read-only and edited as
// text, so there is no whole-block serializer to lose your formatting.

import { esc } from "../helpers";
import type { Note, NoteIndexEntry } from "./api";
import * as fm from "./frontmatter";
import { slugify } from "./links";

const INPUT =
  "bg-stone-900 border border-green-900 focus:border-green-600 outline-none px-3 py-2 " +
  "text-green-300 placeholder-green-800 font-mono text-sm";

const BTN =
  "border border-green-900 text-green-500 hover:border-green-600 hover:text-green-300 " +
  "min-w-11 min-h-11 px-2 font-mono text-sm cursor-pointer " +
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-green-500";

/** Wraps the selection, or inserts the pair and puts the caret between. */
function wrap(area: HTMLTextAreaElement, before: string, after = before): void {
  const { selectionStart: s, selectionEnd: e, value } = area;
  area.value = value.slice(0, s) + before + value.slice(s, e) + after + value.slice(e);
  area.selectionStart = s + before.length;
  area.selectionEnd = e + before.length;
  area.focus();
  area.dispatchEvent(new Event("input"));
}

/** Prefixes every line touched by the selection. */
function prefixLines(area: HTMLTextAreaElement, marker: string): void {
  const { selectionStart: s, selectionEnd: e, value } = area;
  const start = value.lastIndexOf("\n", s - 1) + 1;
  const end = value.indexOf("\n", e) === -1 ? value.length : value.indexOf("\n", e);
  const block = value
    .slice(start, end)
    .split("\n")
    .map((l) => (l.startsWith(marker) ? l.slice(marker.length) : marker + l))
    .join("\n");
  area.value = value.slice(0, start) + block + value.slice(end);
  area.selectionStart = start;
  area.selectionEnd = start + block.length;
  area.focus();
  area.dispatchEvent(new Event("input"));
}

const TOOLS: [label: string, title: string, apply: (a: HTMLTextAreaElement) => void][] = [
  ["B", "Bold", (a) => wrap(a, "**")],
  ["I", "Italic", (a) => wrap(a, "*")],
  ["H", "Heading", (a) => prefixLines(a, "## ")],
  ["•", "Bullet list", (a) => prefixLines(a, "- ")],
  ["☐", "Task", (a) => prefixLines(a, "- [ ] ")],
  ["❝", "Quote", (a) => prefixLines(a, "> ")],
  ["[[", "Link a note", (a) => wrap(a, "[[", "]]")],
  ["`", "Code", (a) => wrap(a, "`")],
];

export interface EditorCallbacks {
  onInput: (body: string) => void;
  onSaveNow: () => void;
  onDelete: () => void;
  onRename: (title: string) => void;
}

export interface EditorHandles {
  textarea: HTMLTextAreaElement;
  /** Re-renders the Properties panel from the current buffer. */
  refreshProperties: () => void;
}

export function renderEditor(
  host: HTMLElement,
  note: Note | null,
  body: string,
  index: NoteIndexEntry[],
  cb: EditorCallbacks,
): EditorHandles {
  host.innerHTML = `
    <div class="flex flex-col gap-3 h-full">
      <details id="ed-props" class="border border-green-900/60">
        <summary class="cursor-pointer select-none text-green-600 font-mono text-xs uppercase tracking-widest px-3 py-2 min-h-11 flex items-center">properties</summary>
        <div id="ed-props-body" class="px-3 pb-3 flex flex-col gap-3"></div>
      </details>

      <div class="flex gap-1 overflow-x-auto sticky top-0 bg-stone-950 py-1 z-10" role="toolbar" aria-label="Markdown formatting">
        ${TOOLS.map(
          ([label, title], i) =>
            `<button type="button" data-tool="${i}" title="${esc(title)}" aria-label="${esc(title)}" class="${BTN} shrink-0">${esc(label)}</button>`,
        ).join("")}
        ${note ? `<button type="button" id="ed-delete" title="Delete note" aria-label="Delete note" class="${BTN} shrink-0 ml-auto border-red-900 text-red-500 hover:border-red-600 hover:text-red-400">🗑</button>` : ""}
      </div>

      <div class="relative flex-1 min-h-0">
        <textarea id="ed-body" aria-label="Note markdown"
          spellcheck="true" autocapitalize="sentences" autocorrect="on"
          class="${INPUT} w-full h-full min-h-[50vh] resize-none leading-relaxed"
          placeholder="---&#10;title: …&#10;tags:&#10;---&#10;&#10;write here…">${esc(body)}</textarea>
        <ul id="ed-complete" role="listbox" aria-label="Link a note"
          class="hidden absolute z-20 max-h-56 overflow-y-auto w-full max-w-sm bg-stone-900 border border-green-700 font-mono text-sm"></ul>
      </div>
    </div>`;

  const area = host.querySelector<HTMLTextAreaElement>("#ed-body")!;
  const propsBody = host.querySelector<HTMLDivElement>("#ed-props-body")!;
  const complete = host.querySelector<HTMLUListElement>("#ed-complete")!;

  for (const btn of host.querySelectorAll<HTMLButtonElement>("[data-tool]")) {
    btn.onclick = () => TOOLS[Number(btn.dataset.tool)][2](area);
  }
  host.querySelector<HTMLButtonElement>("#ed-delete")?.addEventListener("click", cb.onDelete);

  // --- Properties ----------------------------------------------------------
  const refreshProperties = () => {
    const parsed = fm.parse(area.value);
    const tags = fm.get(parsed, "tags");
    const aliases = fm.get(parsed, "aliases");
    const title = fm.first(parsed, "title") ?? note?.title ?? "";
    const others = parsed.entries.filter(
      ([k]) => !["title", "tags", "aliases"].includes(k),
    );

    propsBody.innerHTML = `
      <div>
        <span class="text-green-800 font-mono text-xs">tags</span>
        <div id="pr-tags" class="flex flex-wrap gap-1 mt-1 items-center"></div>
        <div class="flex gap-2 mt-2">
          <input id="pr-tag-input" list="pr-tag-options" placeholder="add a tag" autocomplete="off"
            class="${INPUT} flex-1 min-w-0 min-h-11" />
          <datalist id="pr-tag-options">
            ${[...new Set(index.flatMap((n) => n.tags))]
              .sort()
              .map((t) => `<option value="${esc(t)}"></option>`)
              .join("")}
          </datalist>
        </div>
      </div>

      <div>
        <span class="text-green-800 font-mono text-xs">names</span>
        <div class="flex items-center gap-2 mt-1 flex-wrap">
          <span class="text-green-300 font-mono text-sm">${esc(note?.slug ?? (slugify(title) || "—"))}</span>
          <span class="text-green-800 text-xs">primary</span>
          <button type="button" id="pr-rename" class="${BTN} px-3">rename</button>
        </div>
        <div id="pr-aliases" class="flex flex-wrap gap-1 mt-2 items-center"></div>
        <div class="flex gap-2 mt-2">
          <input id="pr-alias-input" placeholder="add an alias" autocomplete="off"
            class="${INPUT} flex-1 min-w-0 min-h-11" />
        </div>
      </div>

      ${
        others.length
          ? `<div>
               <span class="text-green-800 font-mono text-xs">other properties — edit these in the text</span>
               <dl class="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 mt-1 text-xs font-mono">
                 ${others
                   .map(
                     ([k, vs]) =>
                       `<dt class="text-green-700">${esc(k)}</dt><dd class="text-green-500 break-words">${esc(vs.join(", "))}</dd>`,
                   )
                   .join("")}
               </dl>
             </div>`
          : ""
      }`;

    const setList = (key: string, values: string[]) => {
      const at = area.selectionStart;
      area.value = fm.patchList(area.value, key, values);
      area.selectionStart = area.selectionEnd = Math.min(at, area.value.length);
      cb.onInput(area.value);
      refreshProperties();
    };

    const chipRow = (
      container: HTMLElement,
      values: string[],
      key: string,
      prefix: string,
    ) => {
      container.innerHTML = values.length
        ? ""
        : `<span class="text-green-800 text-xs font-mono">none</span>`;
      values.forEach((value, i) => {
        const chip = document.createElement("span");
        chip.className =
          "flex items-center gap-1 text-green-400 bg-green-900/30 px-2 py-1 text-xs font-mono";
        chip.innerHTML = `${prefix}${esc(value)} <button type="button" aria-label="Remove ${esc(value)}" class="text-green-600 hover:text-red-400 cursor-pointer px-1">×</button>`;
        chip.querySelector("button")!.onclick = () =>
          setList(key, values.filter((_, j) => j !== i));
        container.appendChild(chip);
      });
    };

    chipRow(propsBody.querySelector<HTMLElement>("#pr-tags")!, tags, "tags", "#");
    chipRow(propsBody.querySelector<HTMLElement>("#pr-aliases")!, aliases, "aliases", "");

    const addFrom = (input: HTMLInputElement, key: string, values: string[]) => {
      const value = input.value.trim();
      if (!value || values.includes(value)) {
        input.value = "";
        return;
      }
      setList(key, [...values, value]);
    };
    const tagInput = propsBody.querySelector<HTMLInputElement>("#pr-tag-input")!;
    tagInput.onkeydown = (ev) => {
      if (ev.key === "Enter" || ev.key === ",") {
        ev.preventDefault();
        addFrom(tagInput, "tags", tags);
      }
    };
    const aliasInput = propsBody.querySelector<HTMLInputElement>("#pr-alias-input")!;
    aliasInput.onkeydown = (ev) => {
      if (ev.key === "Enter") {
        ev.preventDefault();
        addFrom(aliasInput, "aliases", aliases);
      }
    };

    propsBody.querySelector<HTMLButtonElement>("#pr-rename")!.onclick = () => {
      const next = prompt("New title for this note", title);
      if (next && next.trim() && next.trim() !== title) cb.onRename(next.trim());
    };
  };

  // --- `[[` autocomplete ---------------------------------------------------
  let matches: NoteIndexEntry[] = [];
  let active = 0;
  let query = "";

  const hideComplete = () => {
    complete.classList.add("hidden");
    matches = [];
  };

  const insertLink = (title: string) => {
    const at = area.selectionStart;
    const open = area.value.lastIndexOf("[[", at);
    area.value = area.value.slice(0, open) + `[[${title}]]` + area.value.slice(at);
    const caret = open + title.length + 4;
    area.selectionStart = area.selectionEnd = caret;
    hideComplete();
    cb.onInput(area.value);
    area.focus();
  };

  const paintComplete = () => {
    complete.innerHTML =
      matches
        .map(
          (n, i) =>
            `<li role="option" aria-selected="${i === active}" data-i="${i}"
                 class="px-3 py-2 min-h-11 flex items-center cursor-pointer ${i === active ? "bg-green-900/50 text-green-200" : "text-green-400"}">${esc(n.title)}</li>`,
        )
        .join("") +
      `<li role="option" aria-selected="${active === matches.length}" data-i="${matches.length}"
           class="px-3 py-2 min-h-11 flex items-center cursor-pointer border-t border-green-900 ${active === matches.length ? "bg-green-900/50 text-green-200" : "text-green-600"}">
         + create “${esc(query || "…")}”
       </li>`;
    for (const li of complete.querySelectorAll<HTMLLIElement>("[data-i]")) {
      li.onmousedown = (ev) => {
        ev.preventDefault();
        const i = Number(li.dataset.i);
        insertLink(i < matches.length ? matches[i].title : query);
      };
    }
    complete.classList.remove("hidden");
  };

  const updateComplete = () => {
    const at = area.selectionStart;
    const open = area.value.lastIndexOf("[[", at);
    // Only while the caret sits inside an unclosed `[[` on the same line.
    if (open === -1 || area.value.slice(open, at).includes("]]") || area.value.slice(open, at).includes("\n")) {
      return hideComplete();
    }
    query = area.value.slice(open + 2, at);
    const q = query.toLowerCase();
    matches = index
      .filter(
        (n) =>
          n.title.toLowerCase().includes(q) ||
          n.names.some((s) => s.includes(slugify(query))),
      )
      .slice(0, 6);
    active = 0;
    paintComplete();
  };

  area.addEventListener("input", () => {
    cb.onInput(area.value);
    updateComplete();
  });
  area.addEventListener("blur", () => setTimeout(hideComplete, 150));
  area.addEventListener("keydown", (ev) => {
    const open = !complete.classList.contains("hidden");
    if (open && (ev.key === "ArrowDown" || ev.key === "ArrowUp")) {
      ev.preventDefault();
      const n = matches.length + 1;
      active = (active + (ev.key === "ArrowDown" ? 1 : n - 1)) % n;
      paintComplete();
      return;
    }
    if (open && ev.key === "Enter") {
      ev.preventDefault();
      insertLink(active < matches.length ? matches[active].title : query);
      return;
    }
    if (open && ev.key === "Escape") {
      ev.preventDefault();
      hideComplete();
      return;
    }
    if ((ev.metaKey || ev.ctrlKey) && ev.key.toLowerCase() === "s") {
      ev.preventDefault();
      cb.onSaveNow();
    }
  });

  refreshProperties();
  return { textarea: area, refreshProperties };
}
