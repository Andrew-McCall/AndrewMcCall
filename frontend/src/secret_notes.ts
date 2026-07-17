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
  // Gate: any signed-in user may see this page.
  let me: Me;
  try {
    const res = await api("/auth/me");
    if (!res.ok) return window.navigate("/secret/login");
    me = await res.json();
  } catch {
    return window.navigate("/secret/login");
  }

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

  let notes: Note[] = [];
  let tags: Tag[] = [];
  let selectedId: string | null = null; // null === unsaved new note

  // --- data loading --------------------------------------------------------
  const loadTags = async () => {
    try {
      const res = await api("/tags");
      if (res.ok) tags = await res.json();
    } catch {
      /* leave tags as-is on a transient error */
    }
    const current = tagFilter.value;
    tagFilter.innerHTML =
      `<option value="">all tags</option>` +
      tags
        .map((t) => `<option value="${esc(t.name)}">${esc(t.name)}</option>`)
        .join("");
    tagFilter.value = current;
  };

  const loadNotes = async () => {
    try {
      const res = await api("/notes");
      if (!res.ok) {
        listEl.innerHTML = `<div class="text-red-400 text-sm py-2">${esc(await errorText(res))}</div>`;
        return;
      }
      notes = await res.json();
      renderList();
    } catch {
      listEl.innerHTML = `<div class="text-red-400 text-sm py-2">Network error.</div>`;
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
    editorEl.innerHTML = `
      <input id="ed-title" type="text" placeholder="title" autocomplete="off" spellcheck="false"
        value="${esc(note?.title ?? "")}"
        class="bg-stone-900 border border-green-900 focus:border-green-600 outline-none px-3 py-2 text-green-200 text-lg placeholder-green-900 font-mono" />
      <textarea id="ed-body" placeholder="write here…" rows="14" spellcheck="false"
        class="bg-stone-900 border border-green-900 focus:border-green-600 outline-none px-3 py-2 text-green-300 placeholder-green-900 font-mono resize-y">${esc(note?.body ?? "")}</textarea>

      <div class="flex flex-col gap-2">
        <div id="ed-chips" class="flex flex-wrap gap-1 items-center"></div>
        <div class="flex gap-2">
          <input id="ed-tag" type="text" placeholder="add a tag" autocomplete="off" spellcheck="false" list="tag-options"
            class="flex-1 bg-stone-900 border border-green-900 focus:border-green-600 outline-none px-3 py-2 text-green-300 placeholder-green-900 font-mono text-sm" />
          <datalist id="tag-options">
            ${tags.map((t) => `<option value="${esc(t.name)}"></option>`).join("")}
          </datalist>
          <button id="ed-tag-add" class="border border-green-800 text-green-400 hover:bg-green-900/40 px-3 cursor-pointer font-mono text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-green-500 focus-visible:ring-offset-2 focus-visible:ring-offset-stone-950">add</button>
        </div>
      </div>

      <div class="flex items-center justify-between mt-1">
        <div class="flex gap-2">
          <button id="ed-save" class="bg-transparent border border-green-500 hover:bg-green-500/10 active:bg-green-500/20 disabled:opacity-60 disabled:cursor-not-allowed text-green-400 font-bold px-5 py-2 cursor-pointer transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-green-500 focus-visible:ring-offset-2 focus-visible:ring-offset-stone-950">Save</button>
          ${note ? `<button id="ed-delete" class="text-red-500 hover:text-red-400 px-3 cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-500 focus-visible:ring-offset-2 focus-visible:ring-offset-stone-950">delete</button>` : ""}
        </div>
        <span id="ed-status" class="text-green-700 text-sm"></span>
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
        chip.innerHTML = `${esc(t)} <button class="text-green-600 hover:text-red-400 cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-green-500" aria-label="remove ${esc(t)}">×</button>`;
        chip.querySelector("button")!.onclick = () => {
          editTags = editTags.filter((x) => x !== t);
          renderChips();
        };
        chips.appendChild(chip);
      }
    };

    const addTag = () => {
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

  const saveNote = async (status: HTMLElement, saveBtn: HTMLButtonElement) => {
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
      status.textContent = "saved";
      await Promise.all([loadNotes(), loadTags()]);
      openNote(saved.id); // re-renders the editor, replacing this saveBtn
    } catch {
      status.textContent = "Network error.";
    } finally {
      saveBtn.disabled = false;
    }
  };

  const deleteNote = async (note: Note) => {
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
  app.querySelector<HTMLButtonElement>("#new-note")!.onclick = () =>
    openNote(null);
  tagFilter.onchange = renderList;

  app.querySelector<HTMLButtonElement>("#logout")!.onclick = async () => {
    try {
      await api("/auth/logout", { method: "POST" });
    } catch {
      /* clearing the cookie server-side is best-effort */
    }
    window.navigate("/secret/login");
  };

  await Promise.all([loadTags(), loadNotes()]);
};
