// Notes page. Every call uses `credentials: "include"` so the HttpOnly session
// cookie set at login is sent along. On load we check `/api/auth/me`; anyone who
// isn't signed in (any role) is bounced to the login page. Layout is a list of
// notes on the left and an editor pane on the right. Tags are a user-scoped
// vocabulary with full CRUD (`/api/tags`); a note references them by name and
// unknown names are created on save. Deletes are soft server-side, so a deleted
// note or tag simply disappears here.

type Me = { id: string; name: string; role: string };
type Note = {
  id: string;
  title: string;
  body: string;
  tags: string[];
  created_at: string;
  updated_at: string;
};
type Tag = { id: string; name: string };

const api = (path: string, init?: RequestInit) =>
  fetch(`/api${path}`, { credentials: "include", ...init });

const jsonInit = (method: string, body: unknown): RequestInit => ({
  method,
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

// Reads `{ error }` from a non-2xx JSON body, falling back to the status.
const errorText = async (res: Response): Promise<string> => {
  const body = await res.json().catch(() => null);
  if (body && typeof body.error === "string") return body.error;
  return `Error ${res.status}`;
};

const fmtDate = (iso: string): string => new Date(iso).toLocaleString();

// Detaches the window `online`/`offline` listeners this page installs. Set on
// mount, called by the router on navigation away (see main.ts) — mirroring the
// disposeX pattern used by secret_time / secret_pi, so the handlers don't fire
// against a torn-down page after the visitor leaves.
let teardown: (() => void) | null = null;

export function disposeNotes(): void {
  teardown?.();
  teardown = null;
}

// --- offline cache ---------------------------------------------------------
// Notes and tags are mirrored to localStorage on every successful load so the
// page stays readable if the connection later drops. Keys are scoped by user id
// so a shared browser never shows one account's cache to another. `me` is cached
// under a fixed key because we need it to resolve the per-user keys before any
// network call. Everything is best-effort: a full/disabled store is ignored.
const ME_KEY = "notes-offline:me";
const cacheKey = (kind: string, uid: string) => `notes-offline:${kind}:${uid}`;
const readCache = <T>(key: string): T | null => {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
};
const writeCache = (key: string, value: unknown) => {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* quota exceeded or storage disabled — the cache is best-effort */
  }
};

// Escapes text for safe interpolation into innerHTML.
const esc = (s: string): string =>
  s.replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ]!,
  );

export default async (app: HTMLElement) => {
  disposeNotes(); // drop connectivity listeners from a previous visit

  // Gate: any signed-in user may see this page. A non-2xx response is a real
  // auth failure, so bounce to login. A thrown fetch means the network is down —
  // if we have a cached identity from a previous online session, fall through in
  // read-only offline mode instead of stranding the user at a login they can't
  // reach.
  let me: Me;
  let offline = false;
  try {
    const res = await api("/auth/me");
    if (!res.ok) return window.navigate("/secret/login");
    me = await res.json();
    writeCache(ME_KEY, me);
  } catch {
    const cached = readCache<Me>(ME_KEY);
    if (!cached) return window.navigate("/secret/login");
    me = cached;
    offline = true;
  }

  const NOTES_KEY = cacheKey("notes", me.id);
  const TAGS_KEY = cacheKey("tags", me.id);

  app.innerHTML = `
<div class="flex flex-col items-center min-h-screen py-10 px-4 text-green-500">
  <div class="w-full max-w-5xl flex items-center justify-between">
    <a href="/secret" title="Back to the secret menu">
      <h1 class="hover:underline italic text-4xl md:text-5xl font-bold bg-linear-to-r from-green-500 via-green-700 to-green-900 bg-clip-text text-transparent">
        Notes
      </h1>
    </a>
    <div class="flex items-center gap-4 text-sm text-green-700">
      <span>signed in as <span class="text-green-400">${esc(me.name)}</span></span>
      <a href="/secret/admin" class="hover:text-green-400 ${me.role === "admin" ? "" : "hidden"}">admin</a>
      <button id="logout" class="hover:text-green-400 cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-green-500 focus-visible:ring-offset-2 focus-visible:ring-offset-stone-950">log out</button>
    </div>
  </div>

  <div id="offline-banner" class="hidden w-full max-w-5xl mt-4 border border-yellow-700/60 bg-yellow-900/20 text-yellow-500 font-mono text-sm px-4 py-2">
    ⚠ You're offline — showing your last-synced notes. Editing is disabled until you reconnect.
  </div>

  <div class="w-full max-w-5xl mt-8 flex flex-col md:flex-row gap-6">
    <!-- list pane -->
    <div class="md:w-72 shrink-0 flex flex-col gap-3">
      <div class="flex items-center justify-between">
        <h2 class="text-green-600 font-mono text-sm uppercase tracking-widest">Notes</h2>
        <button id="new-note" class="text-green-400 hover:text-green-300 cursor-pointer font-mono text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-green-500 focus-visible:ring-offset-2 focus-visible:ring-offset-stone-950">+ new</button>
      </div>
      <select id="tag-filter"
        class="bg-stone-900 border border-green-900 focus:border-green-600 outline-none px-3 py-2 text-green-300 font-mono text-sm">
        <option value="">all tags</option>
      </select>
      <div id="note-list" class="flex flex-col gap-1"></div>
    </div>

    <!-- editor pane -->
    <div class="flex-1 min-w-0">
      <div id="editor" class="hidden flex-col gap-3"></div>
      <div id="empty" class="text-green-800 font-mono text-sm py-10 text-center">
        Select a note, or create a new one.
      </div>
    </div>
  </div>
</div>`;

  const listEl = app.querySelector<HTMLDivElement>("#note-list")!;
  const editorEl = app.querySelector<HTMLDivElement>("#editor")!;
  const emptyEl = app.querySelector<HTMLDivElement>("#empty")!;
  const tagFilter = app.querySelector<HTMLSelectElement>("#tag-filter")!;
  const bannerEl = app.querySelector<HTMLDivElement>("#offline-banner")!;
  const newBtn = app.querySelector<HTMLButtonElement>("#new-note")!;

  let notes: Note[] = [];
  let tags: Tag[] = [];
  let selectedId: string | null = null; // null === unsaved new note

  // --- connectivity --------------------------------------------------------
  // Reflects the current `offline` flag into the UI: banner, the disabled "new"
  // button, and — if a note is open — a re-render so the editor picks up its
  // read-only lock. Called once at init and whenever the flag actually flips.
  const applyConnectivity = () => {
    bannerEl.classList.toggle("hidden", !offline);
    newBtn.disabled = offline;
    newBtn.classList.toggle("opacity-50", offline);
    newBtn.classList.toggle("cursor-not-allowed", offline);
    if (!editorEl.classList.contains("hidden")) openNote(selectedId);
  };
  const setOffline = (v: boolean) => {
    if (offline === v) return; // only re-render on a real transition
    offline = v;
    applyConnectivity();
  };

  // --- data loading --------------------------------------------------------
  const loadTags = async () => {
    try {
      const res = await api("/tags");
      if (res.ok) {
        tags = await res.json();
        writeCache(TAGS_KEY, tags);
      }
    } catch {
      // Network error: fall back to the last-synced tags so offline filtering
      // and the tag datalist still work.
      const cached = readCache<Tag[]>(TAGS_KEY);
      if (cached) tags = cached;
    }
    const current = tagFilter.value;
    tagFilter.innerHTML =
      `<option value="">all tags</option>` +
      tags
        .map((t) => `<option value="${esc(t.name)}">${esc(t.name)}</option>`)
        .join("");
    tagFilter.value = current;
  };

  // Placeholder rows shown while the note list is fetching, so the pane has
  // shape instead of a blank flash. Only used on the initial load — refreshes
  // after a save/delete keep the existing list visible.
  const renderSkeleton = () => {
    listEl.innerHTML = Array.from({ length: 5 })
      .map(
        () => `
        <div class="px-3 py-2 border border-green-900/40 animate-pulse">
          <div class="h-3.5 bg-green-900/40 rounded w-3/4"></div>
          <div class="h-2.5 bg-green-900/25 rounded w-2/5 mt-2"></div>
        </div>`,
      )
      .join("");
  };

  const loadNotes = async (skeleton = false) => {
    if (skeleton) renderSkeleton();
    try {
      const res = await api("/notes");
      if (!res.ok) {
        listEl.innerHTML = `<div class="text-red-400 text-sm py-2">${esc(await errorText(res))}</div>`;
        return;
      }
      notes = await res.json();
      writeCache(NOTES_KEY, notes);
      setOffline(false);
      renderList();
    } catch {
      // Network error: serve the last-synced notes read-only if we have them.
      const cached = readCache<Note[]>(NOTES_KEY);
      if (cached) {
        notes = cached;
        setOffline(true);
        renderList();
      } else {
        setOffline(true);
        listEl.innerHTML = `<div class="text-red-400 text-sm py-2">Offline, and no notes are cached on this device yet.</div>`;
      }
    }
  };

  // --- list rendering ------------------------------------------------------
  const renderList = () => {
    const filter = tagFilter.value;
    const shown = filter ? notes.filter((n) => n.tags.includes(filter)) : notes;

    listEl.innerHTML = "";
    if (shown.length === 0) {
      listEl.innerHTML = `<div class="text-green-800 text-sm py-2 font-mono">No notes.</div>`;
      return;
    }
    for (const note of shown) {
      const item = document.createElement("button");
      item.className =
        "text-left px-3 py-2 border cursor-pointer transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-green-500 focus-visible:ring-offset-2 focus-visible:ring-offset-stone-950 " +
        (note.id === selectedId
          ? "border-green-600 bg-stone-900"
          : "border-green-900/40 hover:border-green-700 hover:bg-stone-900/50");
      const title = note.title.trim() || "(untitled)";
      item.innerHTML = `
        <div class="text-green-300 font-mono truncate">${esc(title)}</div>
        <div class="text-green-800 text-xs mt-0.5">${esc(fmtDate(note.updated_at))}</div>
        ${
          note.tags.length
            ? `<div class="flex flex-wrap gap-1 mt-1">${note.tags
                .map(
                  (t) =>
                    `<span class="text-green-600 bg-green-900/30 px-1.5 text-xs font-mono">${esc(t)}</span>`,
                )
                .join("")}</div>`
            : ""
        }`;
      item.onclick = () => openNote(note.id);
      listEl.appendChild(item);
    }
  };

  // --- editor --------------------------------------------------------------
  // The tag set currently being edited (kept in a Set for the chip editor).
  let editTags: string[] = [];

  const openNote = (id: string | null) => {
    selectedId = id;
    const note = id ? notes.find((n) => n.id === id) : null;
    editTags = note ? [...note.tags] : [];
    renderEditor(note ?? null);
    renderList(); // refresh selection highlight
  };

  const renderEditor = (note: Note | null) => {
    emptyEl.classList.add("hidden");
    editorEl.classList.remove("hidden");
    editorEl.classList.add("flex");
    // Offline is read-only: inputs are locked and the write actions disabled.
    const ro = offline ? "readonly" : "";
    const dis = offline ? "disabled" : "";
    editorEl.innerHTML = `
      <input id="ed-title" type="text" placeholder="title" autocomplete="off" spellcheck="false" ${ro}
        value="${esc(note?.title ?? "")}"
        class="bg-stone-900 border border-green-900 focus:border-green-600 outline-none px-3 py-2 text-green-200 text-lg placeholder-green-900 font-mono read-only:opacity-70" />
      <textarea id="ed-body" placeholder="write here…" rows="14" spellcheck="false" ${ro}
        class="bg-stone-900 border border-green-900 focus:border-green-600 outline-none px-3 py-2 text-green-300 placeholder-green-900 font-mono resize-y read-only:opacity-70">${esc(note?.body ?? "")}</textarea>

      <div class="flex flex-col gap-2">
        <div id="ed-chips" class="flex flex-wrap gap-1 items-center"></div>
        <div class="flex gap-2 ${offline ? "hidden" : ""}">
          <input id="ed-tag" type="text" placeholder="add a tag" autocomplete="off" spellcheck="false" list="tag-options" ${ro}
            class="flex-1 bg-stone-900 border border-green-900 focus:border-green-600 outline-none px-3 py-2 text-green-300 placeholder-green-900 font-mono text-sm" />
          <datalist id="tag-options">
            ${tags.map((t) => `<option value="${esc(t.name)}"></option>`).join("")}
          </datalist>
          <button id="ed-tag-add" ${dis} class="border border-green-800 text-green-400 hover:bg-green-900/40 disabled:opacity-50 disabled:cursor-not-allowed px-3 cursor-pointer font-mono text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-green-500 focus-visible:ring-offset-2 focus-visible:ring-offset-stone-950">add</button>
        </div>
      </div>

      <div class="flex items-center justify-between mt-1">
        <div class="flex gap-2 ${offline ? "hidden" : ""}">
          <button id="ed-save" ${dis} class="bg-transparent border border-green-500 hover:bg-green-500/10 active:bg-green-500/20 disabled:opacity-60 disabled:cursor-not-allowed text-green-400 font-bold px-5 py-2 cursor-pointer transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-green-500 focus-visible:ring-offset-2 focus-visible:ring-offset-stone-950">Save</button>
          ${note ? `<button id="ed-delete" ${dis} class="text-red-500 hover:text-red-400 disabled:opacity-50 disabled:cursor-not-allowed px-3 cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-500 focus-visible:ring-offset-2 focus-visible:ring-offset-stone-950">delete</button>` : ""}
        </div>
        <span id="ed-status" class="text-green-700 text-sm">${offline ? "read-only (offline)" : ""}</span>
      </div>`;

    const chips = editorEl.querySelector<HTMLDivElement>("#ed-chips")!;
    const tagInput = editorEl.querySelector<HTMLInputElement>("#ed-tag")!;
    const status = editorEl.querySelector<HTMLSpanElement>("#ed-status")!;

    const renderChips = () => {
      chips.innerHTML =
        editTags.length === 0
          ? `<span class="text-green-800 text-sm font-mono">no tags</span>`
          : "";
      for (const t of editTags) {
        const chip = document.createElement("span");
        chip.className =
          "flex items-center gap-1 text-green-400 bg-green-900/30 px-2 py-0.5 text-sm font-mono";
        chip.innerHTML = offline
          ? esc(t)
          : `${esc(t)} <button class="text-green-600 hover:text-red-400 cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-green-500" aria-label="remove ${esc(t)}">×</button>`;
        chip.querySelector("button")?.addEventListener("click", () => {
          editTags = editTags.filter((x) => x !== t);
          renderChips();
        });
        chips.appendChild(chip);
      }
    };

    const addTag = () => {
      if (offline) return;
      const name = tagInput.value.trim();
      if (name && !editTags.includes(name)) editTags.push(name);
      tagInput.value = "";
      renderChips();
      tagInput.focus();
    };
    editorEl.querySelector<HTMLButtonElement>("#ed-tag-add")!.onclick = addTag;
    tagInput.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter" || ev.key === ",") {
        ev.preventDefault();
        addTag();
      }
    });

    const saveBtn = editorEl.querySelector<HTMLButtonElement>("#ed-save")!;
    saveBtn.onclick = () => saveNote(status, saveBtn);
    if (note) {
      editorEl.querySelector<HTMLButtonElement>("#ed-delete")!.onclick = () =>
        deleteNote(note);
    }
    renderChips();
  };

  // Shows a "✓ saved" confirmation on the current editor's status line and
  // fades it out after a couple of seconds. Queried fresh each time because
  // the status span is recreated whenever the editor re-renders.
  let savedTimer: ReturnType<typeof setTimeout> | undefined;
  const flashSaved = () => {
    const status = editorEl.querySelector<HTMLSpanElement>("#ed-status");
    if (!status) return;
    clearTimeout(savedTimer);
    status.textContent = "✓ saved";
    status.className = "text-green-400 text-sm transition-opacity duration-500";
    savedTimer = setTimeout(() => {
      status.classList.add("opacity-0");
    }, 1800);
  };

  const saveNote = async (status: HTMLElement, saveBtn: HTMLButtonElement) => {
    if (offline) return; // read-only offline; the button is disabled anyway
    // Without this, double-clicking Save on a brand-new note fires two POSTs
    // before the first resolves and sets `selectedId` — creating two notes.
    if (saveBtn.disabled) return;
    saveBtn.disabled = true;

    const title = editorEl.querySelector<HTMLInputElement>("#ed-title")!.value;
    const body = editorEl.querySelector<HTMLTextAreaElement>("#ed-body")!.value;
    const payload = { title, body, tags: editTags };
    status.textContent = "saving…";
    try {
      const res =
        selectedId === null
          ? await api("/notes", jsonInit("POST", payload))
          : await api(`/notes/${selectedId}`, jsonInit("PUT", payload));
      if (!res.ok) {
        status.textContent = await errorText(res);
        return;
      }
      const saved: Note = await res.json();
      selectedId = saved.id;
      await Promise.all([loadNotes(), loadTags()]);
      openNote(saved.id); // re-renders the editor, replacing this saveBtn
      // `status` above was wiped by the re-render, so confirm on the fresh one.
      flashSaved();
    } catch {
      status.textContent = "Network error.";
    } finally {
      saveBtn.disabled = false;
    }
  };

  const deleteNote = async (note: Note) => {
    if (offline) return; // read-only offline; the button is disabled anyway
    if (!confirm(`Delete "${note.title.trim() || "untitled"}"?`)) return;
    try {
      const res = await api(`/notes/${note.id}`, { method: "DELETE" });
      if (!res.ok) return alert(await errorText(res));
      selectedId = null;
      editorEl.classList.add("hidden");
      editorEl.classList.remove("flex");
      emptyEl.classList.remove("hidden");
      await loadNotes();
    } catch {
      alert("Network error.");
    }
  };

  // --- events --------------------------------------------------------------
  newBtn.onclick = () => openNote(null);
  tagFilter.onchange = renderList;

  // Browser connectivity transitions. Coming back online re-fetches (which flips
  // the flag off and refreshes); dropping offline locks the UI immediately. Both
  // are detached by disposeNotes() when the router navigates away.
  const onOnline = () => {
    loadTags();
    loadNotes();
  };
  const onOffline = () => setOffline(true);
  window.addEventListener("online", onOnline);
  window.addEventListener("offline", onOffline);
  teardown = () => {
    window.removeEventListener("online", onOnline);
    window.removeEventListener("offline", onOffline);
  };

  // Reflect whatever state the auth gate landed in (offline if `/auth/me` failed
  // but a cached identity was found).
  applyConnectivity();

  app.querySelector<HTMLButtonElement>("#logout")!.onclick = async () => {
    try {
      await api("/auth/logout", { method: "POST" });
    } catch {
      /* clearing the cookie server-side is best-effort */
    }
    window.navigate("/secret/login");
  };

  await Promise.all([loadTags(), loadNotes(true)]);
};
