-- Per-user notes, with a user-scoped tag vocabulary and a many-to-many link
-- between the two. Everything here belongs to exactly one user and cascades
-- away when that user is deleted.

-- A single note owned by a user. `title` and `body` are free text; both default
-- to empty so a blank note can be created and filled in later.
--
-- Deletion is soft: the API only ever sets `is_deleted` and every read filters
-- it out, so a "deleted" note is hidden from the owner but still on disk.
-- Undeleting is deliberately not exposed over HTTP — it takes direct DB access.
CREATE TABLE IF NOT EXISTS notes (
    id         UUID PRIMARY KEY,
    user_id    UUID NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    title      TEXT NOT NULL DEFAULT '',
    body       TEXT NOT NULL DEFAULT '',
    is_deleted BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMPTZ NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL
);

-- Partial index: listings only ever want live notes, so we don't index the
-- deleted ones.
CREATE INDEX IF NOT EXISTS notes_user_id_updated_at_idx
    ON notes (user_id, updated_at DESC) WHERE NOT is_deleted;

-- Tags are per-user: each user has their own namespace, so a name is unique
-- within a user rather than globally. Two users may both have a "work" tag.
--
-- Tags are soft-deleted the same way as notes (see above). The uniqueness of a
-- name is enforced only among live tags, so a name freed by deleting a tag can
-- be reused — while the old, hidden tag keeps its historical note links.
CREATE TABLE IF NOT EXISTS tags (
    id         UUID PRIMARY KEY,
    user_id    UUID NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    name       TEXT NOT NULL,
    is_deleted BOOLEAN NOT NULL DEFAULT FALSE
);

CREATE UNIQUE INDEX IF NOT EXISTS tags_user_id_name_live_idx
    ON tags (user_id, name) WHERE NOT is_deleted;

CREATE INDEX IF NOT EXISTS tags_user_id_idx ON tags (user_id) WHERE NOT is_deleted;

-- Many-to-many: a note carries any number of tags, a tag labels any number of
-- notes. Deleting either side removes the link (but not the other side).
CREATE TABLE IF NOT EXISTS note_tags (
    note_id UUID NOT NULL REFERENCES notes (id) ON DELETE CASCADE,
    tag_id  UUID NOT NULL REFERENCES tags  (id) ON DELETE CASCADE,
    PRIMARY KEY (note_id, tag_id)
);

CREATE INDEX IF NOT EXISTS note_tags_tag_id_idx ON note_tags (tag_id);
