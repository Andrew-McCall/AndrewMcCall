-- Notes become markdown documents: the body is the whole `.md` file, and every
-- indexed fact — title, tags, names, links, user-defined properties — is
-- derived from that text on save.
--
-- This migration REPLACES the old shape rather than living alongside it. The
-- backfill is split by risk, not by layer:
--
--   * the relational copy of existing tags happens here, in SQL, because it is
--     deterministic and cannot be subtly wrong;
--   * rewriting note bodies to add frontmatter happens in Rust, in the boot
--     reindexer, because a bug there is unrecoverable — and because a failed
--     SQL migration takes the entire site down (main.rs `.expect()`s it), not
--     just notes.
--
-- The reindexer therefore reads the NEW note_tags, which is populated below
-- before the legacy tables are dropped.

-- Derivation version. The reindexer only touches rows below the current value,
-- so a parser fix self-heals the vault without re-walking it on every restart.
-- 0 also means "never indexed" — the marker for pre-refactor notes.
ALTER TABLE notes ADD COLUMN IF NOT EXISTS index_version SMALLINT NOT NULL DEFAULT 0;

-- ---------------------------------------------------------------------------
-- Names: the primary slug and every alias, in one table.
--
-- `slug` and `aliases` are the same concept — a name this note answers to — so
-- PRIMARY KEY (user_id, slug) states the guarantee that matters outright: a
-- name resolves to exactly one note. A rename inserts the new primary and
-- demotes the old row, so existing [[links]] keep working without the server
-- ever editing a note the author didn't open.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS note_names (
    user_id    UUID NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    slug       TEXT NOT NULL,
    note_id    UUID NOT NULL REFERENCES notes (id) ON DELETE CASCADE,
    is_primary BOOLEAN NOT NULL DEFAULT FALSE,
    PRIMARY KEY (user_id, slug)
);

CREATE INDEX IF NOT EXISTS note_names_note_id_idx ON note_names (note_id);

CREATE UNIQUE INDEX IF NOT EXISTS note_names_one_primary_idx
    ON note_names (note_id) WHERE is_primary;

-- ---------------------------------------------------------------------------
-- Tags: a bare string, many per note, freely shared between notes. No ids, no
-- soft-delete, no CRUD — a tag exists precisely while some live note's
-- frontmatter names it. `user_id` is denormalised so the browser's tag list is
-- one index scan instead of a join back through notes.
-- ---------------------------------------------------------------------------
ALTER TABLE note_tags RENAME TO note_tags_legacy;

CREATE TABLE note_tags (
    note_id UUID NOT NULL REFERENCES notes (id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    tag     TEXT NOT NULL,
    PRIMARY KEY (note_id, tag)
);

CREATE INDEX note_tags_lookup_idx ON note_tags (user_id, tag);

-- Carry existing tags across before the legacy tables go. Deleted tags are
-- skipped: they were already invisible to every read path.
INSERT INTO note_tags (note_id, user_id, tag)
SELECT ntl.note_id, n.user_id, t.name
FROM note_tags_legacy ntl
JOIN notes n ON n.id = ntl.note_id
JOIN tags  t ON t.id = ntl.tag_id
WHERE NOT t.is_deleted
ON CONFLICT DO NOTHING;

DROP TABLE note_tags_legacy;
DROP TABLE tags;

-- ---------------------------------------------------------------------------
-- Everything else in the frontmatter: dual strings, indexed. This is what makes
-- inventing a property free — write `client: acme` and it is queryable with no
-- migration — and what makes a mistyped key visible instead of silent, since
-- `tag:` lands here in plain sight rather than quietly failing to be a tag.
--
-- `value` is part of the primary key so a key can hold a list.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS note_udf (
    note_id UUID NOT NULL REFERENCES notes (id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    key     TEXT NOT NULL,
    value   TEXT NOT NULL,
    PRIMARY KEY (note_id, key, value)
);

CREATE INDEX IF NOT EXISTS note_udf_lookup_idx ON note_udf (user_id, key, value);

-- ---------------------------------------------------------------------------
-- Outbound [[wikilinks]], rebuilt from the body on every save.
--
-- Targets are stored as slugs rather than ids on purpose: a link to a note that
-- does not exist yet is an ordinary row, and creating, deleting or renaming a
-- note needs no maintenance here at all. Backlinks are a join against
-- note_names; unresolved links are the rows with no matching name.
--
-- Deliberately not one of the metadata tables: links come from the body, not
-- from the block at the top of the page.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS note_links (
    source_id   UUID NOT NULL REFERENCES notes (id) ON DELETE CASCADE,
    target_slug TEXT NOT NULL,
    PRIMARY KEY (source_id, target_slug)
);

CREATE INDEX IF NOT EXISTS note_links_target_slug_idx ON note_links (target_slug);
