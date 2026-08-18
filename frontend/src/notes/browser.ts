// The note browser: search, a nested tag tree, metadata filters, sort, Trash.
//
// One component, two placements — a slide-over drawer on a phone, a permanent
// sidebar from `lg` up. That is a CSS difference only; nothing here knows which
// it is.

import { esc } from "../helpers";
import type { NoteIndexEntry } from "./api";
import { tagMatches, tagPath } from "./links";

export type Sort = "updated" | "created" | "title";

export interface BrowserState {
  search: string;
  tag: string | null;
  /** A `key=value` metadata filter, for user-defined properties. */
  meta: { key: string; value: string } | null;
  sort: Sort;
  trash: boolean;
}

export const initialState = (): BrowserState => ({
  search: "",
  tag: null,
  meta: null,
  sort: "updated",
  trash: false,
});

/** A node in the tag tree. `full` is the complete path, e.g. `infra/prod`. */
interface TagNode {
  name: string;
  full: string;
  count: number;
  children: TagNode[];
}

/** Builds the nested tree by splitting tag names on `/`. */
export function buildTagTree(entries: NoteIndexEntry[]): TagNode[] {
  const roots: TagNode[] = [];
  const counts = new Map<string, number>();
  for (const note of entries) {
    for (const tag of note.tags) {
      // Every ancestor counts the note too, so filtering by `infra` shows
      // everything under `infra/prod` and the number agrees with the list.
      const parts = tagPath(tag);
      for (let i = 0; i < parts.length; i++) {
        const full = parts.slice(0, i + 1).join("/");
        counts.set(full, (counts.get(full) ?? 0) + 1);
      }
    }
  }
  for (const full of [...counts.keys()].sort()) {
    const parts = tagPath(full);
    let level = roots;
    for (let i = 0; i < parts.length; i++) {
      const path = parts.slice(0, i + 1).join("/");
      let node = level.find((n) => n.full === path);
      if (!node) {
        node = { name: parts[i], full: path, count: counts.get(path) ?? 0, children: [] };
        level.push(node);
      }
      level = node.children;
    }
  }
  return roots;
}

/** Property key → value → number of notes carrying it. */
export function buildPropertyIndex(
  entries: NoteIndexEntry[],
): Map<string, Map<string, number>> {
  const out = new Map<string, Map<string, number>>();
  for (const note of entries) {
    for (const { key, value } of note.udf) {
      const values = out.get(key) ?? new Map<string, number>();
      values.set(value, (values.get(value) ?? 0) + 1);
      out.set(key, values);
    }
  }
  return out;
}

export function applyFilters(
  entries: NoteIndexEntry[],
  state: BrowserState,
): NoteIndexEntry[] {
  const q = state.search.trim().toLowerCase();
  const filtered = entries.filter((note) => {
    if (state.tag && !note.tags.some((t) => tagMatches(t, state.tag!))) return false;
    if (
      state.meta &&
      !note.udf.some((m) => m.key === state.meta!.key && m.value === state.meta!.value)
    ) {
      return false;
    }
    if (!q) return true;
    return (
      note.title.toLowerCase().includes(q) ||
      note.excerpt.toLowerCase().includes(q) ||
      note.tags.some((t) => t.toLowerCase().includes(q)) ||
      note.udf.some((m) => m.value.toLowerCase().includes(q)) ||
      note.names.some((n) => n.includes(q))
    );
  });

  const by: Record<Sort, (a: NoteIndexEntry, b: NoteIndexEntry) => number> = {
    updated: (a, b) => b.updated_at.localeCompare(a.updated_at),
    created: (a, b) => b.created_at.localeCompare(a.created_at),
    title: (a, b) => a.title.localeCompare(b.title),
  };
  return [...filtered].sort(by[state.sort]);
}

const relative = (iso: string): string => {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.round(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(iso).toLocaleDateString();
};

const CHIP =
  "text-green-600 bg-green-900/30 px-1.5 py-0.5 text-xs font-mono whitespace-nowrap";

// 44px minimum touch target throughout — this is the pane you drive with a
// thumb.
const ROW =
  "w-full text-left px-3 py-3 border cursor-pointer transition-colors min-h-11 " +
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-green-500";

const tagTreeHtml = (nodes: TagNode[], active: string | null, depth = 0): string =>
  nodes
    .map(
      (node) => `
      <button data-tag="${esc(node.full)}"
        class="w-full flex items-center justify-between gap-2 px-2 py-2 min-h-11 text-left font-mono text-sm cursor-pointer
               ${active === node.full ? "text-green-300 bg-green-900/30" : "text-green-700 hover:text-green-400"}"
        style="padding-left:${0.5 + depth * 0.75}rem">
        <span class="truncate">#${esc(node.name)}</span>
        <span class="text-green-800 text-xs shrink-0">${node.count}</span>
      </button>
      ${tagTreeHtml(node.children, active, depth + 1)}`,
    )
    .join("");

export interface BrowserCallbacks {
  onSelect: (note: NoteIndexEntry) => void;
  onNew: () => void;
  onChange: () => void;
  onRestore: (note: NoteIndexEntry) => void;
}

/** Renders the browser into `host` and wires its controls. */
export function renderBrowser(
  host: HTMLElement,
  entries: NoteIndexEntry[],
  state: BrowserState,
  currentId: string | null,
  cb: BrowserCallbacks,
): void {
  const shown = applyFilters(entries, state);
  const tree = buildTagTree(entries);
  const properties = buildPropertyIndex(entries);

  host.innerHTML = `
    <div class="flex items-center gap-2 mb-3">
      <input id="nb-search" type="search" value="${esc(state.search)}"
        placeholder="search notes…" aria-label="Search notes" autocomplete="off"
        class="flex-1 min-w-0 bg-stone-900 border border-green-900 focus:border-green-600 outline-none
               px-3 py-2 min-h-11 text-green-300 placeholder-green-800 font-mono text-sm" />
      <button id="nb-new" title="New note" aria-label="New note"
        class="shrink-0 border border-green-500 text-green-400 hover:bg-green-500/10 px-3 min-h-11 cursor-pointer font-mono
               focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-green-500">+</button>
    </div>

    <div class="flex items-center gap-2 mb-3">
      <select id="nb-sort" aria-label="Sort notes"
        class="flex-1 min-w-0 bg-stone-900 border border-green-900 text-green-400 font-mono text-xs px-2 py-2 min-h-11 cursor-pointer outline-none focus:border-green-600">
        <option value="updated"${state.sort === "updated" ? " selected" : ""}>recently updated</option>
        <option value="created"${state.sort === "created" ? " selected" : ""}>recently created</option>
        <option value="title"${state.sort === "title" ? " selected" : ""}>title A–Z</option>
      </select>
      <button id="nb-trash" aria-pressed="${state.trash}"
        class="shrink-0 border px-3 min-h-11 font-mono text-xs cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-green-500
               ${state.trash ? "border-red-700 text-red-400 bg-red-900/20" : "border-green-900 text-green-700 hover:text-green-400"}">trash</button>
    </div>

    ${
      tree.length
        ? `<details class="mb-3" ${state.tag ? "open" : ""}>
             <summary class="cursor-pointer select-none text-green-600 font-mono text-xs uppercase tracking-widest py-2 min-h-11 flex items-center">tags</summary>
             <div class="mt-1">
               <button data-tag="" class="w-full text-left px-2 py-2 min-h-11 font-mono text-sm cursor-pointer ${state.tag === null ? "text-green-300" : "text-green-700 hover:text-green-400"}">all</button>
               ${tagTreeHtml(tree, state.tag)}
             </div>
           </details>`
        : ""
    }

    ${
      properties.size
        ? `<details class="mb-3" ${state.meta ? "open" : ""}>
             <summary class="cursor-pointer select-none text-green-600 font-mono text-xs uppercase tracking-widest py-2 min-h-11 flex items-center">properties</summary>
             <div class="mt-1">
               ${
                 state.meta
                   ? `<button data-meta-clear class="w-full text-left px-2 py-2 min-h-11 font-mono text-sm text-green-700 hover:text-green-400 cursor-pointer">clear filter</button>`
                   : ""
               }
               ${[...properties.entries()]
                 .sort(([a], [b]) => a.localeCompare(b))
                 .map(
                   ([key, values]) => `
                   <div class="mt-1">
                     <span class="block px-2 text-green-800 font-mono text-xs">${esc(key)}</span>
                     ${[...values.entries()]
                       .sort(([a], [b]) => a.localeCompare(b))
                       .map(
                         ([value, count]) => `
                         <button data-meta-key="${esc(key)}" data-meta-value="${esc(value)}"
                           class="w-full flex items-center justify-between gap-2 px-2 py-2 min-h-11 text-left font-mono text-sm cursor-pointer
                                  ${
                                    state.meta?.key === key && state.meta?.value === value
                                      ? "text-green-300 bg-green-900/30"
                                      : "text-green-700 hover:text-green-400"
                                  }"
                           style="padding-left:1.25rem">
                           <span class="truncate">${esc(value)}</span>
                           <span class="text-green-800 text-xs shrink-0">${count}</span>
                         </button>`,
                       )
                       .join("")}
                   </div>`,
                 )
                 .join("")}
             </div>
           </details>`
        : ""
    }

    <div id="nb-list" class="flex flex-col gap-1" role="list"></div>`;

  const list = host.querySelector<HTMLDivElement>("#nb-list")!;
  if (shown.length === 0) {
    list.innerHTML = `<p class="text-green-800 text-sm py-3 font-mono">${
      state.trash ? "Trash is empty." : entries.length ? "No notes match." : "No notes yet."
    }</p>`;
  } else {
    for (const note of shown) {
      const row = document.createElement("button");
      row.type = "button";
      row.setAttribute("role", "listitem");
      row.className =
        ROW +
        (note.id === currentId
          ? " border-green-600 bg-stone-900"
          : " border-green-900/40 hover:border-green-700 hover:bg-stone-900/50");
      row.innerHTML = `
        <span class="block text-green-300 font-mono truncate">${esc(note.title || "Untitled")}</span>
        <span class="block text-green-800 text-xs mt-0.5">${esc(relative(note.updated_at))}</span>
        ${
          note.tags.length
            ? `<span class="flex gap-1 mt-1 overflow-x-auto">${note.tags
                .map((t) => `<span class="${CHIP}">#${esc(t)}</span>`)
                .join("")}</span>`
            : ""
        }`;
      row.onclick = () => (state.trash ? cb.onRestore(note) : cb.onSelect(note));
      if (state.trash) row.title = "Restore this note";
      list.appendChild(row);
    }
  }

  const search = host.querySelector<HTMLInputElement>("#nb-search")!;
  search.oninput = () => {
    state.search = search.value;
    cb.onChange();
  };
  host.querySelector<HTMLButtonElement>("#nb-new")!.onclick = cb.onNew;
  host.querySelector<HTMLSelectElement>("#nb-sort")!.onchange = (ev) => {
    state.sort = (ev.target as HTMLSelectElement).value as Sort;
    cb.onChange();
  };
  host.querySelector<HTMLButtonElement>("#nb-trash")!.onclick = () => {
    state.trash = !state.trash;
    cb.onChange();
  };
  for (const btn of host.querySelectorAll<HTMLButtonElement>("[data-tag]")) {
    btn.onclick = () => {
      state.tag = btn.dataset.tag || null;
      cb.onChange();
    };
  }
  for (const btn of host.querySelectorAll<HTMLButtonElement>("[data-meta-key]")) {
    btn.onclick = () => {
      const key = btn.dataset.metaKey!;
      const value = btn.dataset.metaValue!;
      // Clicking the active filter again clears it.
      state.meta =
        state.meta?.key === key && state.meta?.value === value ? null : { key, value };
      cb.onChange();
    };
  }
  host.querySelector<HTMLButtonElement>("[data-meta-clear]")?.addEventListener(
    "click",
    () => {
      state.meta = null;
      cb.onChange();
    },
  );
}
