// The notes API client, the offline read cache, and local draft persistence.
//
// Three storage concerns, deliberately separate:
//
//   * the **index cache** keeps the browser usable offline (read-only, as
//     before);
//   * the **note cache** keeps notes you have opened readable offline;
//   * **drafts** mirror an unsaved editor buffer so a dropped connection or a
//     killed mobile tab can't eat your typing. This is the part that matters —
//     writes are still online-only, but nothing you typed is ever lost.
//
// All of it is best-effort: a full or disabled localStorage is ignored.

import { api, errorText } from "../helpers";

export interface NoteIndexEntry {
  id: string;
  /** `null` for a trashed note: deletion releases its names, so it has no
   *  address until restored. Nullable so the compiler forces callers to say
   *  what they do about it rather than navigating to `/secret/notes/`. */
  slug: string | null;
  title: string;
  tags: string[];
  /** Every name this note answers to, primary first — so a `[[link]]` written
   *  against a superseded name resolves client-side exactly as the server
   *  resolves it. */
  names: string[];
  /** User-defined properties, which the browser filters on client-side. */
  udf: MetaEntry[];
  excerpt: string;
  created_at: string;
  updated_at: string;
}

export interface MetaEntry {
  key: string;
  value: string;
}

export interface NoteLink {
  slug: string;
  title: string | null;
  id: string | null;
}

export interface Note {
  id: string;
  slug: string;
  title: string;
  body: string;
  tags: string[];
  names: string[];
  udf: MetaEntry[];
  links: NoteLink[];
  backlinks: NoteLink[];
  created_at: string;
  updated_at: string;
  notices?: string[];
}

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly conflict?: Note,
  ) {
    super(message);
  }
}

// --- storage ---------------------------------------------------------------
// Keyed by user id so a shared browser never shows one account's cache to
// another.

const key = (kind: string, uid: string, extra = "") =>
  `notes:${kind}:${uid}${extra ? `:${extra}` : ""}`;

const read = <T>(k: string): T | null => {
  try {
    const raw = localStorage.getItem(k);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
};

const write = (k: string, value: unknown) => {
  try {
    localStorage.setItem(k, JSON.stringify(value));
  } catch {
    /* quota exceeded or storage disabled — the cache is best-effort */
  }
};

const drop = (k: string) => {
  try {
    localStorage.removeItem(k);
  } catch {
    /* ignore */
  }
};

export interface Draft {
  body: string;
  savedAt: number;
}

/** Everything storage-related, bound to one user. */
export class NotesStore {
  constructor(private readonly uid: string) {}

  // Cached values are normalised on read. localStorage outlives a deploy, so a
  // cache written by an older shape can be missing a field that today's code
  // assumes is an array — and `note.udf.some(...)` on `undefined` throws, which
  // would take down the whole browser rather than degrade.

  cachedIndex = (): NoteIndexEntry[] | null => {
    const raw = read<Partial<NoteIndexEntry>[]>(key("index", this.uid));
    return (
      raw?.map((e) => ({
        ...(e as NoteIndexEntry),
        tags: e.tags ?? [],
        names: e.names ?? [],
        udf: e.udf ?? [],
      })) ?? null
    );
  };

  cacheIndex = (list: NoteIndexEntry[]) => write(key("index", this.uid), list);

  cachedNote = (id: string): Note | null => {
    const raw = read<Partial<Note>>(key("note", this.uid, id));
    if (!raw) return null;
    return {
      ...(raw as Note),
      tags: raw.tags ?? [],
      names: raw.names ?? [],
      udf: raw.udf ?? [],
      links: raw.links ?? [],
      backlinks: raw.backlinks ?? [],
    };
  };

  cacheNote = (note: Note) => write(key("note", this.uid, note.id), note);

  /** `id` is "new" for a note that has never been saved. */
  draft = (id: string): Draft | null => read<Draft>(key("draft", this.uid, id));

  saveDraft = (id: string, body: string) =>
    write(key("draft", this.uid, id), { body, savedAt: Date.now() } as Draft);

  clearDraft = (id: string) => drop(key("draft", this.uid, id));
}

// --- requests --------------------------------------------------------------

const json = async <T>(res: Response): Promise<T> => {
  if (!res.ok) throw new ApiError(await errorText(res), res.status);
  return (await res.json()) as T;
};

export const listNotes = async (opts: { q?: string; trash?: boolean } = {}) => {
  const params = new URLSearchParams();
  if (opts.q) params.set("q", opts.q);
  if (opts.trash) params.set("trash", "1");
  const suffix = params.toString() ? `?${params}` : "";
  return json<NoteIndexEntry[]>(await api(`/notes${suffix}`));
};

export const getNote = async (id: string) =>
  json<Note>(await api(`/notes/${encodeURIComponent(id)}`));

export const createNote = async (body: string) =>
  json<Note>(
    await api("/notes", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ body }),
    }),
  );

/**
 * Saves an existing note. `baseUpdatedAt` is the `updated_at` the editor last
 * saw; when the row has moved on the server answers 409 with the current note,
 * which is surfaced as `ApiError.conflict` so the editor can warn instead of
 * silently clobbering another tab.
 */
export const updateNote = async (
  id: string,
  body: string,
  baseUpdatedAt?: string,
): Promise<Note> => {
  const res = await api(`/notes/${encodeURIComponent(id)}`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ body, base_updated_at: baseUpdatedAt }),
  });
  if (res.status === 409) {
    const current = (await res.json()) as Note;
    throw new ApiError("This note changed in another tab.", 409, current);
  }
  return json<Note>(res);
};

export const deleteNote = async (id: string) => {
  const res = await api(`/notes/${encodeURIComponent(id)}`, { method: "DELETE" });
  if (!res.ok) throw new ApiError(await errorText(res), res.status);
};

export const restoreNote = async (id: string) =>
  json<Note>(
    await api(`/notes/${encodeURIComponent(id)}/restore`, { method: "POST" }),
  );

// `GET /meta` and `GET /meta/types` exist and are tested, but the browser does
// not call them: the note index already carries every tag and property, so
// deriving the filter menu from it costs no extra request and guarantees the
// counts shown match the rows actually listed. The endpoints remain for any
// non-browser client.
