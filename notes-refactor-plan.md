# Notes refactor — plan

Turning `/secret/notes` from a title+body+tags CRUD form into an Obsidian-lite
markdown vault: markdown as the source of truth, frontmatter properties,
`[[wikilinks]]` with auto-create, backlinks, a reader mode, and a note browser —
mobile-first.

**Status: BUILT (2026-08-09). 152 Rust tests, 98 TS tests, both suites green;
migration + reindexer verified against a real pre-refactor dataset on the local
podman Postgres. Not yet exercised in a browser — see §10.**

Deviations from the plan as written, all deliberate:

- **Module split is per consumer, not per widget.** The outline lives in
  `reader.ts` and the Properties panel in `editor.ts` rather than in `toc.ts` /
  `properties.ts`; each is used by exactly one view, and a file per widget would
  have been indirection without a second caller. `shortcuts` folded into the
  page shell for the same reason.
- **`GET /meta/types` gained a `source` field.** A UDF key can legitimately be
  named `tag` (that is the `tags:`-typo case), so the built-in type and the
  user-defined key collide. They are reported separately rather than merged, and
  `?source=udf` reaches the shadowed one.
- **`GET /notes` returns every name and every user-defined property**, not just
  the primary name. Without aliases the reader resolved `[[links]]` client-side
  differently from the server, so a link to a renamed note showed dangling in the
  prose while "linked mentions" resolved it correctly; without properties the
  browser could list metadata keys but not filter on them.
- **Shared fixtures are one `fixtures/notes/parity.json`** rather than `*.md`
  plus `expected.json` — simpler for both readers, and it covers frontmatter,
  patching and slugs in one file.
- **Not built: the seed script.** Local test data was inserted ad hoc.

**All open questions answered in review (see `refer.md`, untracked).**
This revision incorporates those answers. The structural changes that came out of
the review: metadata (not tags) is the organising concept (§1.3), names and
aliases unify (§1.4), and the tag tables collapse (§2.2).

---

## 1. The model

### 1.1 A note is a markdown file

One `body` column holds the whole document:

```markdown
---
title: Deploy pipeline
tags:
  - infra
  - infra/prod
aliases:
  - deploy-notes
created: 2026-08-09
---

Prose, with a [[Backend]] link.

## Restarting
...
```

Everything the app shows — title, tags, names, links — is **derived from that
text by the server on save** and cached in side tables for cheap querying. One
source of truth, so the index can never drift from what you typed.

| Field  | Rule |
|--------|------|
| title  | frontmatter `title:` → first `# H1` → prettified primary name → `Untitled` |
| tags   | frontmatter `tags:` only — inline `#tag` is not indexed |
| names  | primary = slugified title; aliases = frontmatter `aliases:` |
| udf    | every other frontmatter key, as `key` → `value` |
| links  | every `[[target]]` outside code spans and fences |

New notes get a frontmatter `title:` and **no `# H1`** — two titles means one
goes stale, and the Contents outline stays real content headings rather than
leading with the note's own name. Existing notes that open with an H1 keep
working: the derivation chain falls back to it.

### 1.2 The frontmatter block is the complete, visible truth

The server never keeps state about a note that isn't in the note's own text.
When it learns something — a rename generating an alias — it **writes that back
into the frontmatter**, so opening the note in edit mode always shows every
alias and every tag it actually has. Nothing is hidden in a table you can't see.

Two consequences worth building for:

- A save response returns the **canonical body**. The editor adopts it only if
  you haven't typed since the request went out; otherwise it keeps your buffer
  and re-syncs on the next quiet moment. Never yank text out from under a
  cursor.
- Writeback is limited to **alias additions from a rename**. Pure normalisation
  (trimming a tag, collapsing `foo bar` → `foo-bar`) affects the index only and
  is reported in the save status — it does not rewrite what you wrote.

### 1.3 Metadata is the concept; tags are one type of it

The vocabulary this plan uses, because getting it consistent is what keeps the
code easy to change:

- **Metadata** — the `---` block at the top of the file. A set of entries, each
  with a **type** and a **value**. This is the organising concept.
- **Metadata type** — `tag`, `alias`, `name`, or any key you invent.
- **Tag** — the simplest possible type: a bare string, nothing else. No id, no
  colour, no description, no row of its own to maintain. Written `#infra` in
  prose and displayed as a chip; **stored bare** (`infra`), because the sigil is
  presentation and would otherwise need stripping in six places.

Storage follows the same split: **purpose-built tables for the types with real
rules, one open table for everything else.**

| Type | Table | Rule it needs |
|------|-------|---------------|
| name, alias | `note_names` | value resolves to exactly one note, per user |
| tag | `note_tags` | many per note, freely shared between notes |
| anything else | `note_udf` | dual strings, indexed, no constraints |

No EAV for the constrained types, so each table states its own guarantee
directly instead of emulating it with flags. `note_udf` absorbs the long tail, so
inventing a property costs nothing: write `client: acme` and it is indexed and
browsable with no migration and no registration. A mistyped key (`tag:` for
`tags:`) lands in `note_udf` and shows up in the Properties panel as a stray
property — visibly wrong, rather than silently not-a-chip.

There is deliberately **no `props` JSONB column**. `note_udf` is what it was
trying to be, and unlike JSONB it's queryable with an ordinary index.

A **display registry** (`meta_types`: label, chip, filterable, sort order, per
key) is the natural home for customising how a UDF key presents. Nothing in
storage depends on it, so it is deferred to phase 2 (§9) and can arrive without
rework. Until then: built-ins are known to the code, and UDF keys render as
`key: value` rows and are offered as browser filters.

### 1.4 Names: one concept, one table

`slug` and `aliases` are the same thing — a name this note answers to — so they
live in one place:

```sql
CREATE TABLE note_names (
    user_id    UUID NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    slug       TEXT NOT NULL,
    note_id    UUID NOT NULL REFERENCES notes (id) ON DELETE CASCADE,
    is_primary BOOLEAN NOT NULL DEFAULT FALSE,
    PRIMARY KEY (user_id, slug)
);
CREATE INDEX note_names_note_id_idx ON note_names (note_id);
CREATE UNIQUE INDEX note_names_one_primary_idx ON note_names (note_id) WHERE is_primary;
```

- `PRIMARY KEY (user_id, slug)` is the correctness guarantee: a name resolves to
  exactly one note, enforced by Postgres rather than by application care.
- Link resolution is one indexed lookup. Backlinks are
  `note_links.target_slug = ANY(<this note's names>)`.
- Rename = insert the new primary, demote the old row. Alias CRUD = one row.
- Soft-deleting a note drops its name rows, so the names free up immediately;
  the reindexer only ever populates them for live notes.
- The table is **100% derived** from the files (title → primary, `aliases:` →
  the rest), so the boot reindexer can rebuild it from scratch.

**Why aliases and tags are different metadata types, not one.** They have
opposite uniqueness rules. A tag is deliberately shared — `#infra` on forty notes
is the point. An alias must resolve to exactly one note or the link breaks. That
difference is exactly why each gets its own table rather than sharing a
polymorphic one: `PRIMARY KEY (user_id, slug)` states the alias rule outright,
where a shared table would have to emulate it with a denormalised flag and a
partial index.

**Alias collisions** never fail a save: if the name is taken by another live
note, it's dropped from the index and reported in the save status. An index
conflict must not block you writing.

### 1.5 Wikilinks

| Syntax | Meaning |
|--------|---------|
| `[[Target]]` | link, display = `Target` |
| `[[Target\|label]]` | link, display = `label` |
| `[[Target#Heading]]` | link to `#heading-slug` in the target |
| `[[#Heading]]` | link within the current note |

- Resolution key is `slugify(target)` against `note_names`, so
  `[[deploy pipeline]]`, `[[Deploy Pipeline]]` and `[[Deploy-Pipeline]]` all hit
  the same note.
- Unresolved links render in a distinct "dangling" style. Clicking one opens the
  editor pre-filled with a frontmatter stub, **unsaved** — it persists on your
  first keystroke. No junk notes from a stray tap on a phone.
- Never extracted from inside fenced blocks or inline code.
- Bare `https://…` URLs autolink. `[[…]]` only ever produces an internal
  `/secret/notes/<slug>` href built from `[a-z0-9-]`, so it can't be an
  injection vector.

### 1.6 Frontmatter grammar (deliberately not YAML)

Parsed only when the document's **first line** is exactly `---`, terminated by
the next line that is exactly `---`.

```
key: value                 # scalar, raw text to end of line, trimmed
key: [a, b, c]             # inline list
key:                       # block list
  - a
  - b
key:                       # empty → absent
```

- Keys `[A-Za-z0-9_-]+`, lowercased; duplicate key → last wins.
- Values are strings; `true`/`false` and integers are recognised for known keys
  only (`pinned`). One matched pair of `"` or `'` is stripped.
- Unknown keys round-trip **untouched** — they live in the text, and are indexed
  into `note_udf` so the browser can filter on them.
- A malformed block is **never an error**: it degrades to "no frontmatter" and
  the text renders as-is. A note can never become unopenable.

~70 lines per language, no dependency, and every rule pinned by a shared fixture
corpus (§6).

---

## 2. Schema

### 2.1 `0012_notes_markdown.sql` — replaces the old shape outright

The old tables and the new ones do **not** coexist: one migration builds the new
shape, carries the data across, and drops what it replaced.

That creates one ordering problem worth being explicit about. The boot reindexer
(§3.3) needs each pre-refactor note's existing tags in order to write them into
its new frontmatter — but by the time it runs, the old tables are gone. The fix
is to split the backfill by risk: the migration does the **relational copy**
(deterministic SQL that can't meaningfully fail), and Rust does the **text
rewrite** (where a bug would be unrecoverable, and where a failed SQL migration
would `.expect()` the whole site down). So `note_tags` is populated from the old
tables *before* they're dropped, and the reindexer reads the new table.

```sql
-- Bumped in code when derivation rules change; the boot reindexer only touches
-- rows below the current version, so a parser fix self-heals the vault without
-- re-walking it on every restart. 0 also means "never indexed" — the migration
-- marker for pre-refactor notes.
ALTER TABLE notes ADD COLUMN IF NOT EXISTS index_version SMALLINT NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS note_names ( ... );        -- §1.4

-- Tags: a bare string, many per note, freely shared. `user_id` is denormalised
-- so the browser's tag list is one index scan rather than a join through notes.
-- The legacy note_tags (note_id, tag_id) is renamed out of the way first, its
-- rows copied across, then dropped — all inside this migration.
ALTER TABLE note_tags RENAME TO note_tags_legacy;

CREATE TABLE note_tags (
    note_id UUID NOT NULL REFERENCES notes (id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    tag     TEXT NOT NULL,
    PRIMARY KEY (note_id, tag)
);
CREATE INDEX note_tags_lookup_idx ON note_tags (user_id, tag);

-- Carry the existing tags across. Pure relational copy: no text parsing, no
-- slugify, nothing that can be subtly wrong. The reindexer reads this to build
-- each pre-refactor note's frontmatter.
INSERT INTO note_tags (note_id, user_id, tag)
SELECT ntl.note_id, n.user_id, t.name
FROM note_tags_legacy ntl
JOIN notes n ON n.id = ntl.note_id
JOIN tags  t ON t.id = ntl.tag_id
WHERE NOT t.is_deleted
ON CONFLICT DO NOTHING;

DROP TABLE note_tags_legacy;
DROP TABLE tags;

-- Every other frontmatter key: dual strings, indexed. `value` is in the primary
-- key so a user-defined key can hold a list (`client: [acme, globex]`) without
-- any special casing.
CREATE TABLE IF NOT EXISTS note_udf (
    note_id UUID NOT NULL REFERENCES notes (id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    key     TEXT NOT NULL,
    value   TEXT NOT NULL,
    PRIMARY KEY (note_id, key, value)
);
CREATE INDEX IF NOT EXISTS note_udf_lookup_idx ON note_udf (user_id, key, value);

-- Outbound links, rebuilt from the body on every save. Targets are stored as
-- slugs, not ids: a link to a note that doesn't exist yet is a first-class row,
-- and creating/deleting/renaming a note needs no maintenance here at all.
-- Kept out of the metadata tables on purpose — links come from the body, not
-- from the block at the top of the page.
CREATE TABLE IF NOT EXISTS note_links (
    source_id   UUID NOT NULL REFERENCES notes (id) ON DELETE CASCADE,
    target_slug TEXT NOT NULL,
    PRIMARY KEY (source_id, target_slug)
);
CREATE INDEX IF NOT EXISTS note_links_target_slug_idx ON note_links (target_slug);
```

`title` is **not** duplicated into `note_udf`: it already has a dedicated
`notes.title` cache column, and storing the same fact twice is how the two drift.
Types backed by a real column are skipped by the UDF sync.

`notes.title` stays as a **derived cache**, written from the frontmatter on every
save, so list queries never parse markdown.

### 2.2 Tags, simplified

Tags are now derived strings owned by the file, which makes the `tags` table's
independent identity dead weight — and its CRUD actively wrong. `POST /tags`
creates a tag no file references; `PUT /tags/{id}` renames one, and the next
reindex of any note carrying it puts the old name straight back. So:

- **`tags` and the old `note_tags` are dropped in 0012.** A tag exists iff a live
  note's frontmatter names it. No ids, no `is_deleted`, no orphan cleanup, no
  CRUD, no drift.
- `GET /tags` is replaced by `GET /meta?type=tag` → `[{ value, count }]`, which
  serves the tag filter, the alias list and any UDF key with the same code (§3.1).
- `POST /tags`, `PUT /tags/{id}`, `DELETE /tags/{id}` are **removed**. You add a
  tag by writing it in a file; you remove the last one and it's gone.
- Renaming a tag globally would mean rewriting frontmatter across many notes —
  the same cross-note write we rejected for links (§1.3 rationale). Parked as a
  future explicit, previewed bulk operation.
- Tag names normalise to `[\w/-]`, max 50 chars, case preserved. `infra/prod`
  nests in the browser tree. An unnormalisable tag is dropped from the index with
  a notice, never an error.

Nothing from the old shape survives: no `tags` table, no `tag_id`, no
`is_deleted` on a tag, no second migration to finish the job later.

---

## 3. Backend — `backend/src/notes.rs` → `backend/src/notes/`

`notes.rs` is 666 lines mixing validation, tag plumbing, SQL and HTTP. Split:

```
backend/src/notes/
  mod.rs          re-exports the handlers main.rs calls; limits
  frontmatter.rs  parse() / patch_tags() / patch_aliases()      + tests
  derive.rs       title/tags/aliases/udf/wikilink extraction    + tests
  names.rs        note_names: resolve, rename, alias CRUD       + tests
  meta.rs         note_tags + note_udf sync; the /meta query dispatch
  index.rs        sync_index(tx, …); reindex_all(pool) for boot backfill
  routes.rs       HTTP handlers (thin: auth → validate → index → respond)
```

`slugify` currently lives in `posts.rs`. Hoist it to a top-level
`backend/src/slug.rs` used by **both** `posts` and `notes` — one slug algorithm
in the codebase.

### 3.1 API

| Method | Path | Change |
|--------|------|--------|
| `GET`  | `/notes` | **index only** — `id, slug, title, tags, updated_at, excerpt`. No bodies. Optional `?q=` (ILIKE over title+body), `?trash=1` |
| `GET`  | `/notes/{id}` | **new** — full note: `body`, `meta`, `names`, `links`, `backlinks`, `unresolved` |
| `POST` | `/notes` | body `{ body }`; everything derived |
| `PUT`  | `/notes/{id}` | body `{ body, base_updated_at? }` |
| `POST` | `/notes/{id}/restore` | **new** — undo a soft delete (Trash) |
| `DELETE` | `/notes/{id}` | unchanged |
| `GET`  | `/meta?type=X` | **new** — `[{ value, count }]` for `tag`, `alias`, or any UDF key |
| `GET`  | `/meta/types` | **new** — the metadata keys actually in use, for the browser's filter menu |
| ~~`GET`/`POST`/`PUT`/`DELETE` `/tags…`~~ | | **removed** (§2.2) |

`GET /meta` dispatches over the three metadata tables behind one shape, so a
caller never learns that `tag` and `client` are stored differently — and when the
registry lands in phase 2, nothing about that shape changes.

**The browser does not call either endpoint.** `GET /notes` already carries every
tag and property, so the filter menu is derived from the index: one request
instead of three, and the counts shown are guaranteed to match the rows actually
listed. Filtering has to happen client-side over that list regardless (as title
search and tag filtering already did), so fetching the menu separately would have
meant two sources for one fact. The endpoints stay as API surface for any
non-browser client.

Notes stay **id-addressed**. The pretty `/secret/notes/<slug>` URL is a frontend
concern — the client already loads the index, so it resolves slug → id locally.
One identifier server-side, and a rename can't 404 an in-flight write.

- **Optimistic concurrency.** `PUT` accepts `base_updated_at`; if the row moved,
  return `409` with the current note so the editor can warn instead of silently
  clobbering a second tab. Autosave makes this reachable.
- **No legacy payload shim.** `{title, tags}` in a request body is gone, not
  tolerated — the body is the note. That's the replace-don't-coexist rule, and it
  is what merges the backend and frontend into a single deploy (§7).
- `MAX_BODY_LEN` **20 000 → 100 000**, matching `posts`. Frontmatter plus a real
  long-form note passes 20k sooner than you'd think, and the failure mode is a
  `400` after you've written the thing.

### 3.2 One write path

```rust
// notes/index.rs
pub struct Derived {
    title:   String,
    names:   Names,                     // primary + aliases
    tags:    Vec<String>,
    udf:     Vec<(String, String)>,     // every other frontmatter key
    links:   Vec<String>,
}

pub fn derive(body: &str) -> Derived;                      // pure, unit-tested
pub async fn sync_index(tx, user_id, note_id, &Derived) -> Vec<Notice>;
```

`derive` is pure and carries the bulk of the tests. `sync_index` is the only
place that writes `note_names`, `note_tags`, `note_udf` or `note_links`, and
returns the non-fatal notices (dropped alias, normalised tag) the editor
surfaces. Four delete-then-insert passes, each independent and trivial — more
lines than one polymorphic write, and far easier to read. No handler touches a
side table directly.

### 3.3 Boot reindex

In `main.rs`, after `migrate()` and before serving:

```rust
notes::reindex_all(&config).await;   // logs count + duration; never fatal
```

- `index_version = 0` (pre-refactor notes): prepend a frontmatter block carrying
  the existing `notes.title` and the tags 0012 copied into the new `note_tags`,
  then derive normally. The old tables are already gone by this point — the copy
  in the migration is what makes that safe.
- `index_version < CURRENT`: re-derive.
- Otherwise skipped, so a normal restart does no work.

Idempotent, uses the same code as a save, self-heals after a parser fix, and logs
loudly on failure without taking the process down — unlike a failed SQL
migration, which `main.rs` `.expect()`s and which would leave the whole site
dead, not just notes. That's the reason no backfill logic lives in SQL.

---

## 4. Frontend — module split

### 4.1 `markdown.ts` → `markdown/` (own commit, no behaviour change)

Today's renderer is a 134-line string-appender used by `posts.ts` and
`secret_admin_posts.ts`. It can't produce a heading outline and has no extension
point. Refactor into two stages:

```
frontend/src/markdown/
  index.ts     renderMarkdown(md, opts?)  ← same export, same default output
  block.ts     lines → Block[] tokens (heading, para, list, code, quote, hr, table)
  inline.ts    inline formatting, escape-first, plus opt-in rules
  outline.ts   headings(blocks) → { level, text, id }[]
  render.ts    Block[] → HTML
```

`renderMarkdown(md)` keeps its exact signature and output, so `posts.ts` and
`secret_admin_posts.ts` need **zero** changes — `./markdown` resolves to the
directory. `opts` adds what notes need: `{ wikilink, tasks, tables,
headingLevels: 6 }`. The escape-first invariant is preserved and pinned by tests.
Notes additionally get h4–h6 (currently capped at h3), task lists, and tables.

### 4.2 `secret_notes.ts` → `notes/`

```
frontend/src/notes/
  index.ts        default export + disposeNotes — the router entry, ~40 lines
  state.ts        store: index, open note, mode, dirty buffer; subscribe()
  api.ts          typed fetch wrappers + localStorage cache + draft mirror
  frontmatter.ts  TS mirror of the Rust parser (parse + patchTags/patchAliases)
  links.ts        slugify (mirrors Rust), resolve(target, index), stub template
  browser.ts      note browser: search, tag tree, metadata filters, sort, Trash
  reader.ts       reader mode
  editor.ts       editor: textarea, toolbar, [[ autocomplete, autosave
  properties.ts   the Properties panel (tags + names editable, UDF read-only)
  toc.ts          outline strip / "on this page"
  shortcuts.ts    desktop key bindings, returns its own disposer
```

`secret_notes.ts` shrinks to a re-export, so `main.ts`'s route table and the
`disposeNotes` teardown hook stay as they are.

**Router change** (`main.ts`): `prefixRoutes` currently assumes public routes
("Only public prefix routes exist today, so no session gate here"). Add `auth`
handling to that branch and register:

```ts
{ prefix: "/secret/notes/", auth: "user",
  render: (app, slug) => import("./notes").then(m => m.default(app, slug)) }
```

That's the whole GUI-nav foundation: deep links, browser back/forward, and
`[[wikilink]]` clicks all become ordinary `window.navigate()` calls.

---

## 5. UI/UX

Terminal palette unchanged (stone-950 / green).

### Reader mode (the default when a note opens)

```
┌──────────────────────────────────────────────┐
│ ☰  Notes ▸ Deploy pipeline        ⌕    ✎     │ sticky, 48px, safe-area padded
├──────────────────────────────────────────────┤
│ Deploy pipeline                              │ title from frontmatter
│ #infra  #infra/prod            updated 2h ago│ chips → filter the browser
│ ▸ Contents                                   │ <details>, open on ≥md
├──────────────────────────────────────────────┤
│ …rendered markdown…                          │
│                                              │
│ ── Linked mentions (3) ─────────────────     │
│  → Backend   → Runbook   → Postgres          │
│ ── Unresolved (1) ──────────────────────     │
│  + Grafana                    (tap to create)│
└──────────────────────────────────────────────┘
```

`☰` is the browser, the chip row is the tags, `▸ Contents` is the heading
outline — the three things asked for, at the top. On ≥`lg` the outline moves to a
sticky right rail and the browser becomes a permanent left sidebar: the same
three components re-placed by CSS, not re-implemented.

### Editor mode

```
┌──────────────────────────────────────────────┐
│ ☰  Deploy pipeline          saved ✓      👁   │
├──────────────────────────────────────────────┤
│ Properties ▾                                 │
│   Tags   [infra ×] [infra/prod ×] [+]        │
│   Names  deploy-pipeline (primary)  ✎rename  │
│          deploy-notes ×             [+ alias]│
│   client acme                    (text only) │
│   created 2026-08-09             (text only) │
├──────────────────────────────────────────────┤
│ B  I  H  •  ☐  ❝  ⌗  [[  `                  │ sticky above the textarea
│ ┌──────────────────────────────────────────┐ │
│ │ ---                                      │ │ raw file, frontmatter included
│ │ title: Deploy pipeline                   │ │
│ │ aliases: [deploy-notes]                  │ │
│ │ ---                                      │ │
└──────────────────────────────────────────────┘
```

- The textarea is the source of truth, `---` block and all. The **Properties**
  panel *edits* exactly two things — `tags:` and names — because each is a single
  well-defined transform that can be tested exhaustively and can't touch anything
  else you wrote. Every other key is **shown read-only** and edited as text, which
  is where an Obsidian-shaped workflow expects it. No lossy GUI↔text round trip.
- Showing UDF keys read-only is what makes a mistyped key obvious: `tag: infra`
  appears as a plain property row instead of a chip, right next to the real tags.
- Names are identity, not an arbitrary property, which is why they get a real UI:
  rename (new primary, old demoted to alias) and add/remove alias, each writing
  straight into the `aliases:` frontmatter so the text always shows the truth.
- Toolbar buttons are one `wrapSelection(before, after)` or
  `prefixLines(marker)` call each — no per-button logic.
- `[[` opens autocomplete over the loaded index (title + alias substring); ↑/↓/
  Enter/Esc on desktop, a tap list on mobile. Top row is always "create «typed»".
- **Autosave**: 1.5 s idle, plus on blur, on `visibilitychange → hidden`, and on
  `Ctrl/Cmd-S`. Status line shows `saving… / saved ✓ / unsaved`, and carries the
  non-fatal notices from `sync_index`.
- **Local draft safety**: the unsaved buffer mirrors to
  `localStorage["notes-draft:<uid>:<id>"]` (debounced) and clears on a confirmed
  save. Reopening a note with a newer draft offers "restore unsaved changes", so
  a dropped connection or a killed mobile tab can't eat your typing. Writes stay
  online-only.

### Browser

Search (title + tag + alias substring, client-side over the index), then a **tag
tree** built by splitting names on `/` — `infra/prod` nests under `infra`, and
selecting `infra` matches its children. Below it, **metadata filters** for every
other key in use (`GET /meta/types`, then `GET /meta?type=client` for its
values), so a property you invented this morning is a filter this afternoon.
Pseudo-filters: All, Untagged, Unresolved links, **Trash**. Sort: updated / created / A–Z. Rows show title, chips, relative
time. Trash rows offer restore (`POST /notes/{id}/restore`) — soft delete already
keeps everything, and auto-create makes notes cheaper to spawn and so to delete
by accident.

### Mobile

The default layout; desktop is the enhancement.

- One column. The browser is a left slide-over drawer (`☰`, backdrop tap, `Esc`,
  `inert` on the rest while open, focus returned to `☰` on close).
- `100dvh` flex column so the on-screen keyboard can't push the toolbar off;
  `env(safe-area-inset-*)` padding on the sticky bars.
- Tap targets ≥44 px. Tag chip rows scroll horizontally rather than wrapping into
  a wall.
- `spellcheck="true"`, `autocapitalize="sentences"` in the editor — notes are
  prose. (The current page copies the code-editor `spellcheck="false"`.)
- No swipe gestures: they collide with browser-back and text selection.
- No split preview below `lg`; the read/edit toggle is one tap and preserves
  scroll position by heading anchor.
- Reader is the landing mode, so opening a note on a phone never summons the
  keyboard.

### Desktop keys (all disposed by `disposeNotes`)

`Ctrl/Cmd-K` quick switcher · `Ctrl/Cmd-E` toggle read/edit (Obsidian's binding)
· `Ctrl/Cmd-S` save now · `Esc` close overlay.

### Site-wide: drop `select-none`

`index.html` puts `class="select-none"` on `<body>`, so nothing is selectable
anywhere and three pages opt back in with `select-text`. Flip the default:
selectable body, and `select-none` where it belongs. Audit shows the pages that
need it already declare it locally (labels, `<summary>`, the pi keypad, the
prettier/python gutters) and the games are `<canvas>`. Two real fixes:
`secret_motion.ts`'s text grid (`gridEl`) and the morse keyer surface. Then drop
the now-redundant `select-text` from `posts.ts`, `home.ts` and the two admin
previews.

---

## 6. Tests

`cargo test` is 90 green today — that's the floor.

**Rust** (pure functions, no DB):
- frontmatter: all four value forms, unknown-key preservation, missing/malformed
  block, `---` as a horizontal rule on line 1, CRLF, duplicate keys, `:` inside a
  value; `patch_tags`/`patch_aliases` on a note with no block, an empty block,
  and an existing entry.
- derive: title precedence chain; tags from each list form; nested names;
  wikilink forms (`|`, `#`, `[[#local]]`); links inside fences and inline code are
  **not** extracted; an unknown key routes to UDF; a multi-valued UDF key yields
  one row per value; `title` is not duplicated into UDF.
- names: rename demotes the old primary; alias collision is dropped with a notice
  rather than an error; soft-delete frees the names; one-primary-per-note holds.
- slug: parity fixtures with TS; collision suffixing; punctuation-only titles.
- index: `derive` is idempotent — `derive(serialize(derive(x))) == derive(x)`.

**TS** — `vitest` as a devDependency, `npm test`, run from `npm run build` so
`deploy.sh` fails the deploy rather than shipping a broken renderer:
- markdown: an XSS corpus (`<script>`, `javascript:` hrefs, `onerror=`, raw HTML
  in every block type). The renderer's safety rests on "escape before applying
  markup" and that invariant is currently protected by nothing but care — it gets
  pinned **before** the renderer is touched.
- a byte-for-byte before/after snapshot of the renderer over a corpus of real
  post bodies, proving the blog's output doesn't move.
- frontmatter and slugify parity against the shared fixtures.

**Shared fixtures**: `fixtures/notes/*.md` + `fixtures/notes/expected.json`, read
by Rust via `include_str!` and by vitest via `?raw`. One corpus, two parsers,
drift impossible to miss.

**Local stack** (podman — being set up):
- `compose.yaml`: Postgres 17, named volume, `5433:5432` so it can't collide.
- `backend/.env.example` pointing `DATABASE_DSN` at it, plus `ADMIN_NAME`/
  `ADMIN_PIN` for a local login. The backend migrates on startup, so a fresh
  empty database bootstraps itself — no sqlx CLI needed.
- `VITE_API_TARGET` in `vite.config.ts`, defaulting to the current production URL
  so nobody else's workflow changes:
  `VITE_API_TARGET=http://127.0.0.1:3000 npm run dev`.
- A seed script planting a realistic vault: nested tags, wikilinks, dangling
  links, an alias collision, and a pre-refactor note with no frontmatter so the
  boot reindexer is actually exercised.

---

## 7. Rollout

Two deploys, because replace-don't-coexist removes the compat shim that would
have let the backend ship ahead of the frontend:

| # | Commit | Risk | Verify |
|---|--------|------|--------|
| 0 | `markdown/` refactor, vitest, fixtures, podman stack, `VITE_API_TARGET`, select-none flip | none — renderer output byte-identical, no API or schema change | `npm test`, load `/posts/<slug>`, click through the games |
| 1 | Everything else: 0012, `notes/` split, boot reindexer, new API, `notes/` frontend | the whole refactor, at once | manual checklist §8, against the podman stack first |

Deploy 0 stays separate because it touches the public blog's renderer and is
worth proving in isolation; it changes no behaviour, so there's nothing to
coordinate.

**The cost of merging 1.** `deploy.sh` builds both, then swaps the frontend
(line 314) *before* migrating and restarting the backend (line 315). With no
compat shim, new JS meets the old API for that gap — migration plus a systemd
restart, so roughly 30–60 seconds during which `/secret/notes` errors. It's
auth-gated and single-user, so the blast radius is you, briefly. Worth it for not
carrying a shim forever; say the word if you'd rather I keep one and split it
back into two deploys.

**Before deploy 1: `pg_dump` `notes`, `tags` and `note_tags`.** 0012 drops two of
those tables and the reindexer rewrites every note body — that combination is the
one irreversible step in this plan, and the dump is the only way back. Verify
checklist item 16 against it afterwards.

---

## 8. Manual checklist (before deploy 1 goes out)

1. Create a note from empty → frontmatter stub appears, saves, gets a name.
2. `[[New thing]]` → renders dangling → click → stub editor → type → saves → the
   original link goes live and appears in its backlinks.
3. Rename → old `[[link]]` still resolves, and the old name is **visible in the
   frontmatter** in edit mode. URL updates.
4. Add and remove an alias from the Properties panel; both show in the text.
5. Claim an alias another note already owns → save succeeds, notice shown, index
   unchanged.
6. Nested tag `a/b` → tree nests, filtering by `a` includes it.
7. Unknown frontmatter key survives three save cycles unchanged, shows read-only
   in Properties, and appears as a browser filter.
8. Mistype `tag:` for `tags:` → it shows as a plain property next to the real
   tags rather than silently doing nothing.
9. Two tabs, edit both → second save shows the conflict warning, no data loss.
10. Kill the tab mid-edit → reopen → draft restore offered.
11. Delete → appears in Trash → restore → back in the list with its names.
12. Airplane mode → index and last-read notes still render; editor locked.
13. Phone: drawer opens/closes, keyboard doesn't cover the toolbar, outline
    collapses, chips scroll, no horizontal page scroll at 320 px.
14. `/secret/notes/<slug>` cold load, then back/forward through five notes.
15. A note body of `<script>alert(1)</script>` renders as text everywhere.
16. **Every pre-refactor note** came through with its old title and tags intact,
    now as frontmatter — checked note-by-note against the pre-deploy `pg_dump`.

## 10. What is verified, and what isn't

**Verified automatically** — 170 Rust tests, 112 TS tests, both green:
browser filtering (tags, nested tags, metadata, search, sort),
frontmatter grammar and patching, slug rules, title precedence, tag
normalisation, wikilink extraction (including *not* extracting from code),
UDF routing, the escape-first invariant with an XSS corpus, and a byte-for-byte
snapshot proving the `markdown/` split left blog output untouched. Rust and TS
run the same `fixtures/notes/parity.json`.

**Verified by hand against the local stack:** migration 0012 on a real
pre-refactor dataset — bodies rewritten with frontmatter carrying the old titles
and live tags, a soft-deleted tag correctly excluded, nested `infra/prod`
preserved; the reindexer idempotent across restarts; and the full API sequence
(create, dangling link resolving when its target appears, rename preserving the
old name **in the note's text**, 409 on a stale write, notices instead of errors
for bad tags, delete → trash → restore, search, metadata queries).

**Verified in a real browser** (Chromium 150 via `nix-shell -p chromium`, driven
by playwright-core against the local stack) — 21/21 checks: page renders and
lists notes, reader is the landing mode, the URL tracks the slug, a new note
starts from the frontmatter stub, autosave fires and surfaces its notices,
Properties shows tag chips plus read-only unknown keys, a mistyped `tag:` shows
as a property, resolved vs dangling links render differently, `<script>` renders
as literal text, nested tag filtering matches children, the metadata filter
narrows the list, and on a 320px viewport there is no horizontal scroll and the
drawer opens and closes via ☰ and Escape.

Three bugs only the browser found, all fixed: the Vite proxy never stripped
`/api` for a local backend (so the documented local workflow 404'd every call);
the reader rendered the frontmatter block as prose with its `---` as horizontal
rules; and the Properties panel only refreshed when the *server* rewrote the
text, so editing frontmatter left it stale.

**Still not exercised:** the two-tab conflict path, draft restore after a killed
tab, offline mode, and restore-from-Trash through the UI (the endpoint is
covered).

## 9. Out of scope (deliberate)

The **`meta_types` display registry** (label / chip / filterable / sort order per
metadata key) — deferred, not dropped. Nothing in storage depends on it, so it
lands whenever without rework; until then built-ins are code-known and UDF keys
use defaults.

Offline **writes** (a sync engine: ordering, replay, conflict resolution — an
order of magnitude bigger than everything above, and read-only offline plus local
drafts covers the real risk), global tag rename, tags-as-notes, graph view,
embeds `![[note]]`, callouts, LaTeX, canvas, per-note sharing, attachments,
folders (tags are the hierarchy), inline `#tags`, full-text search ranking
(substring `ILIKE` is plenty at this size).
