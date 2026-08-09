// The notes page: layout shell, routing, mode switching and autosave.
//
// Reader is the landing mode, so opening a note on a phone never summons the
// keyboard. The browser is a slide-over drawer below `lg` and a permanent
// sidebar above it — one component, placed by CSS.

import { getMe, type Me } from "../session";
import * as api from "./api";
import { NotesStore, type Note, type NoteIndexEntry } from "./api";
import { initialState, renderBrowser, type BrowserState } from "./browser";
import * as fm from "./frontmatter";
import { renderEditor, type EditorHandles } from "./editor";
import { noteHref, resolve, slugify } from "./links";
import { renderReader } from "./reader";

const AUTOSAVE_MS = 1500;
/// Short enough that a crash loses at most a few words, long enough that a
/// burst of typing is one storage write rather than one per character.
const DRAFT_MS = 400;

let teardown: (() => void) | null = null;

/** Called by the router when navigating away (see main.ts). */
export function disposeNotes(): void {
  teardown?.();
  teardown = null;
}

type Mode = "read" | "edit";

export default async function notesPage(app: HTMLElement, slug?: string) {
  disposeNotes();

  let me: Me | null = await getMe();
  if (!me) return window.navigate("/secret");
  const store = new NotesStore(me.id);

  // --- state ---------------------------------------------------------------
  /// Live notes. Also the resolution table for `[[links]]` and the editor's
  /// autocomplete, so it must never be replaced by a filtered subset.
  let index: NoteIndexEntry[] = [];
  /// Soft-deleted notes, loaded only for the Trash view. Kept apart from
  /// `index` precisely because that one has those other two jobs.
  let trashed: NoteIndexEntry[] = [];
  let note: Note | null = null;
  /** The editor buffer. Diverges from `note.body` while there are edits. */
  let buffer = "";
  let mode: Mode = "read";
  let offline = false;
  let dirty = false;
  let saving = false;
  let editor: EditorHandles | null = null;
  let saveTimer: ReturnType<typeof setTimeout> | undefined;
  let draftTimer: ReturnType<typeof setTimeout> | undefined;
  const browserState: BrowserState = initialState();

  app.innerHTML = `
<div class="min-h-[100dvh] flex flex-col text-green-500"
     style="padding-top:env(safe-area-inset-top);padding-bottom:env(safe-area-inset-bottom)">

  <header class="sticky top-0 z-30 flex items-center gap-2 px-3 py-2 bg-stone-950/95 backdrop-blur border-b border-green-900/60">
    <button id="nx-menu" aria-label="Open note browser" aria-expanded="false"
      class="lg:hidden min-w-11 min-h-11 border border-green-900 text-green-400 hover:border-green-600 cursor-pointer
             focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-green-500">☰</button>
    <a href="/secret" class="shrink-0 italic font-bold text-green-600 hover:text-green-400" title="Back to the secret menu">notes</a>
    <span class="text-green-900" aria-hidden="true">/</span>
    <h1 id="nx-title" class="flex-1 min-w-0 truncate text-green-300 font-mono text-sm"></h1>
    <span id="nx-status" role="status" aria-live="polite" class="text-xs text-green-700 whitespace-nowrap"></span>
    <button id="nx-mode" aria-label="Toggle editing"
      class="min-w-11 min-h-11 border border-green-700 text-green-300 hover:bg-green-900/30 cursor-pointer
             focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-green-500">✎</button>
  </header>

  <div id="nx-offline" class="hidden border-b border-yellow-700/60 bg-yellow-900/20 text-yellow-500 font-mono text-xs px-3 py-2">
    ⚠ Offline — showing your last-synced notes. Editing is disabled until you reconnect.
  </div>

  <div class="flex-1 flex min-h-0">
    <!-- Drawer on small screens, sidebar from lg. -->
    <div id="nx-backdrop" class="hidden fixed inset-0 bg-black/60 z-30 lg:hidden"></div>
    <aside id="nx-browser"
      class="fixed inset-y-0 left-0 z-40 w-[85vw] max-w-xs -translate-x-full transition-transform duration-200
             overflow-y-auto bg-stone-950 border-r border-green-900/60 p-3
             lg:static lg:translate-x-0 lg:w-72 lg:shrink-0 lg:z-auto lg:bg-transparent"
      aria-label="Note browser"></aside>

    <main id="nx-main" class="flex-1 min-w-0 overflow-y-auto px-4 py-5"></main>
  </div>
</div>`;

  const $ = <T extends HTMLElement>(sel: string) => app.querySelector<T>(sel)!;
  const menuBtn = $("#nx-menu");
  const backdrop = $("#nx-backdrop");
  const aside = $("#nx-browser");
  const main = $("#nx-main");
  const titleEl = $("#nx-title");
  const statusEl = $("#nx-status");
  const modeBtn = $<HTMLButtonElement>("#nx-mode");
  const offlineEl = $("#nx-offline");

  const status = (text: string, cls = "text-green-700") => {
    statusEl.textContent = text;
    statusEl.className = `text-xs whitespace-nowrap ${cls}`;
  };

  // --- drawer --------------------------------------------------------------
  const setDrawer = (open: boolean) => {
    aside.classList.toggle("-translate-x-full", !open);
    backdrop.classList.toggle("hidden", !open);
    menuBtn.setAttribute("aria-expanded", String(open));
    // Keeps the rest of the page out of the tab order and off screen readers
    // while the drawer covers it.
    main.inert = open && window.innerWidth < 1024;
    if (!open) menuBtn.focus();
  };
  menuBtn.onclick = () => setDrawer(aside.classList.contains("-translate-x-full"));
  backdrop.onclick = () => setDrawer(false);

  // --- browser -------------------------------------------------------------
  const paintBrowser = () =>
    renderBrowser(aside, browserState.trash ? trashed : index, browserState, note?.id ?? null, {
      onChange: () => {
        if (browserState.trash) void loadTrash();
        else void refreshIndex().then(paintBrowser);
      },
      onSelect: (entry) => {
        // Only live notes are selectable; a trashed row offers restore instead
        // and has no address to navigate to.
        if (!entry.slug) return;
        setDrawer(false);
        void open(entry.slug);
      },
      onNew: () => {
        setDrawer(false);
        startNew("");
      },
      onRestore: async (entry) => {
        try {
          await api.restoreNote(entry.id);
          browserState.trash = false;
          await refreshIndex();
          paintBrowser();
        } catch (err) {
          status(err instanceof Error ? err.message : "Restore failed.", "text-red-400");
        }
      },
    });

  const loadTrash = async () => {
    try {
      trashed = await api.listNotes({ trash: true });
    } catch {
      trashed = [];
    }
    paintBrowser();
  };

  const refreshIndex = async () => {
    try {
      index = await api.listNotes();
      store.cacheIndex(index);
      setOffline(false);
    } catch {
      index = store.cachedIndex() ?? [];
      setOffline(true);
    }
  };

  const setOffline = (v: boolean) => {
    offline = v;
    offlineEl.classList.toggle("hidden", !v);
    modeBtn.disabled = v;
    modeBtn.classList.toggle("opacity-40", v);
    if (v && mode === "edit") setMode("read");
  };

  // --- saving --------------------------------------------------------------
  const flushSave = async () => {
    clearTimeout(saveTimer);
    if (!dirty || saving || offline) return;
    saving = true;
    status("saving…");
    // What we're sending, captured so we can tell whether the user typed while
    // the request was in flight.
    const sent = buffer;
    try {
      const saved = note
        ? await api.updateNote(note.id, sent, note.updated_at)
        : await api.createNote(sent);

      note = saved;
      store.cacheNote(saved);

      // The server may have rewritten the text itself — a rename records the
      // superseded name in `aliases:`. Adopt its version only when nothing was
      // typed during the request; never yank text out from under a cursor.
      const untouched = buffer === sent;
      if (untouched) {
        buffer = saved.body;
        dirty = false;
        // Cancel any debounced write first, or it would fire after this and
        // resurrect a draft for a note that is already saved.
        clearTimeout(draftTimer);
        draftTimer = undefined;
        store.clearDraft(saved.id);
        if (editor && editor.textarea.value !== saved.body) {
          const at = editor.textarea.selectionStart;
          editor.textarea.value = saved.body;
          editor.textarea.selectionStart = editor.textarea.selectionEnd = Math.min(
            at,
            saved.body.length,
          );
        }
        // Unconditionally, not only when the server rewrote the text: the save
        // is the point at which the panel is known to match the file.
        refreshPanel();
      } else {
        // Keystrokes landed mid-flight: keep them, and schedule another save.
        clearTimeout(saveTimer);
        saveTimer = setTimeout(() => void flushSave(), AUTOSAVE_MS);
      }
      store.cacheNote(saved);
      const notices = saved.notices ?? [];
      // A notice means the index quietly differs from the text — a dropped
      // alias, a normalised tag. Shown, but never treated as a failure.
      status(
        notices.length ? `saved — ${notices[0]}` : untouched ? "saved ✓" : "unsaved",
        notices.length ? "text-yellow-500" : "text-green-400",
      );
      titleEl.textContent = saved.title;
      // Keep the URL on the note's current name after a rename.
      if (window.location.pathname !== noteHref(saved.slug)) {
        window.history.replaceState({}, "", noteHref(saved.slug));
      }
      await refreshIndex();
      paintBrowser();
    } catch (err) {
      if (err instanceof api.ApiError && err.status === 409) {
        status("conflict — this note changed elsewhere", "text-red-400");
        showConflict(err.conflict!);
      } else {
        status(err instanceof Error ? err.message : "Save failed.", "text-red-400");
      }
    } finally {
      saving = false;
    }
  };

  const showConflict = (current: Note) => {
    const keep = confirm(
      "This note was changed in another tab.\n\n" +
        "OK — discard your changes and load the newer version.\n" +
        "Cancel — keep editing yours (your draft is saved locally).",
    );
    if (keep) {
      note = current;
      buffer = current.body;
      dirty = false;
      store.clearDraft(current.id);
      render();
    } else if (note) {
      // Let the next save win by rebasing on the version we were shown.
      note = { ...current, body: buffer };
    }
  };

  /// Writes the pending draft immediately. `localStorage.setItem` is
  /// synchronous, and the body can be 100 kB, so this must not run per
  /// keystroke — see `markDirty`.
  const writeDraft = () => {
    clearTimeout(draftTimer);
    draftTimer = undefined;
    if (dirty) store.saveDraft(note?.id ?? "new", buffer);
  };

  /// Re-reads the frontmatter into the Properties panel.
  ///
  /// Skipped while the panel itself has focus, because it re-renders its own
  /// inputs — refreshing mid-keystroke would drop what you were typing into the
  /// tag box.
  const refreshPanel = () => {
    if (!editor) return;
    if (document.activeElement?.closest("#ed-props")) return;
    editor.refreshProperties();
  };

  const markDirty = (body: string) => {
    buffer = body;
    dirty = true;
    status("unsaved");
    // Debounced: a synchronous stringify-and-write of the whole note on every
    // keypress visibly janks typing once a note gets long, which is exactly
    // when losing it would hurt most.
    clearTimeout(draftTimer);
    draftTimer = setTimeout(() => {
      writeDraft();
      // The panel mirrors the frontmatter you are typing, so it tracks the text
      // rather than only updating when the editor is reopened.
      refreshPanel();
    }, DRAFT_MS);
    clearTimeout(saveTimer);
    if (!offline) saveTimer = setTimeout(() => void flushSave(), AUTOSAVE_MS);
  };

  // --- views ---------------------------------------------------------------
  const setMode = (next: Mode) => {
    mode = next;
    modeBtn.textContent = next === "read" ? "✎" : "👁";
    modeBtn.setAttribute("aria-label", next === "read" ? "Edit note" : "Read note");
    render();
  };

  const render = () => {
    titleEl.textContent = note?.title ?? (buffer ? "New note" : "");
    if (!note && !buffer) {
      main.innerHTML = `
        <div class="text-green-800 font-mono text-sm py-16 text-center">
          Select a note, or create one.
        </div>`;
      return;
    }

    if (mode === "edit") {
      editor = renderEditor(main, note, buffer, index, {
        onInput: markDirty,
        onSaveNow: () => void flushSave(),
        onDelete: async () => {
          if (!note || !confirm(`Delete “${note.title}”?`)) return;
          try {
            await api.deleteNote(note.id);
            store.clearDraft(note.id);
            note = null;
            buffer = "";
            await refreshIndex();
            paintBrowser();
            window.history.pushState({}, "", "/secret/notes");
            setMode("read");
          } catch (err) {
            status(err instanceof Error ? err.message : "Delete failed.", "text-red-400");
          }
        },
        onRename: (title) => {
          // A rename is only a title change in the text. Preserving the old
          // name is the server's job: it writes the superseded slug into this
          // note's `aliases:` and hands the rewritten body back, so existing
          // links keep resolving and the alias is visible in edit mode.
          markDirty(setTitle(buffer, title));
          if (editor) {
            editor.textarea.value = buffer;
            editor.refreshProperties();
          }
          void flushSave();
        },
      });
      editor.textarea.focus();
      return;
    }

    editor = null;
    if (!note) {
      // An unsaved stub has nothing to read yet.
      setMode("edit");
      return;
    }
    renderReader(main, note, index, {
      onTag: (tag) => {
        browserState.tag = tag;
        browserState.trash = false;
        paintBrowser();
        if (window.innerWidth < 1024) setDrawer(true);
      },
      onCreate: (target) => startNew(target),
      onNavigate: (href) => window.navigate(href),
    });
  };

  const setTitle = (text: string, title: string): string => {
    const parsed = fm.parse(text);
    if (parsed.contentStart === 0) return fm.stub(title) + text;
    return fm.patchList(text, "title", [title]);
  };

  // --- opening -------------------------------------------------------------
  const startNew = (title: string) => {
    note = null;
    buffer = fm.stub(title);
    dirty = false;
    const draft = store.draft("new");
    if (draft && draft.body !== buffer && confirm("Restore your unsaved note?")) {
      buffer = draft.body;
      dirty = true;
    }
    window.history.pushState({}, "", "/secret/notes");
    setMode("edit");
  };

  const open = async (targetSlug: string) => {
    const entry = resolve(targetSlug, index);
    if (!entry?.slug) {
      // No such note — or one with no address, which a live note never is.
      // Offer to create it rather than 404ing; that is the whole point of
      // auto-creation.
      startNew(targetSlug.replace(/-/g, " "));
      return;
    }
    window.history.pushState({}, "", noteHref(entry.slug));
    try {
      note = await api.getNote(entry.id);
      store.cacheNote(note);
      setOffline(false);
    } catch {
      note = store.cachedNote(entry.id);
      setOffline(true);
      if (!note) {
        main.innerHTML = `<p class="text-red-400 py-10">This note isn't cached on this device.</p>`;
        return;
      }
    }
    buffer = note.body;
    dirty = false;

    const draft = store.draft(note.id);
    if (draft && draft.body !== note.body) {
      if (confirm("You have unsaved changes to this note. Restore them?")) {
        buffer = draft.body;
        dirty = true;
        setMode("edit");
        return;
      }
      store.clearDraft(note.id);
    }
    setMode("read");
    paintBrowser();
  };

  // --- global wiring -------------------------------------------------------
  modeBtn.onclick = () => setMode(mode === "read" ? "edit" : "read");

  const onKey = (ev: KeyboardEvent) => {
    const mod = ev.metaKey || ev.ctrlKey;
    if (mod && ev.key.toLowerCase() === "k") {
      ev.preventDefault();
      setDrawer(true);
      aside.querySelector<HTMLInputElement>("#nb-search")?.focus();
    } else if (mod && ev.key.toLowerCase() === "e") {
      ev.preventDefault();
      if (!offline) setMode(mode === "read" ? "edit" : "read");
    } else if (mod && ev.key.toLowerCase() === "s") {
      ev.preventDefault();
      void flushSave();
    } else if (ev.key === "Escape") {
      setDrawer(false);
    }
  };

  const onHide = () => {
    // The tab may never come back, so commit the debounced draft synchronously
    // before attempting the (async, possibly doomed) network save.
    if (document.visibilityState === "hidden") {
      writeDraft();
      void flushSave();
    }
  };
  const onOnline = () => {
    setOffline(false);
    void refreshIndex().then(paintBrowser);
  };
  const onOffline = () => setOffline(true);

  window.addEventListener("keydown", onKey);
  window.addEventListener("online", onOnline);
  window.addEventListener("offline", onOffline);
  document.addEventListener("visibilitychange", onHide);

  teardown = () => {
    clearTimeout(saveTimer);
    writeDraft(); // synchronous; survives even if the save below never lands
    void flushSave();
    window.removeEventListener("keydown", onKey);
    window.removeEventListener("online", onOnline);
    window.removeEventListener("offline", onOffline);
    document.removeEventListener("visibilitychange", onHide);
  };

  // --- boot ----------------------------------------------------------------
  await refreshIndex();
  paintBrowser();
  if (slug) await open(slug);
  else render();
}

export { slugify };
