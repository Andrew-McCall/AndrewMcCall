-- Post types. Every post carries a `post_type` discriminator; `article` is the
-- plain markdown post that predates this migration, so existing rows default to
-- it. Type-specific fields live in side tables keyed by `post_id`, keeping the
-- generic `posts` envelope (slug/title/body/publish state) unchanged.
ALTER TABLE posts ADD COLUMN IF NOT EXISTS post_type TEXT NOT NULL DEFAULT 'article';

-- Extra fields for a `book_review` post. One row per review post, joined in on
-- read. `posts` still owns soft-delete (`is_deleted`) and publish state; every
-- read filters through the `posts` join, so this row simply rides along. The FK
-- cascade only fires on a hard delete, which the API never issues.
CREATE TABLE IF NOT EXISTS book_reviews (
    post_id    UUID PRIMARY KEY REFERENCES posts(id) ON DELETE CASCADE,
    book_title TEXT NOT NULL DEFAULT '',
    author     TEXT NOT NULL DEFAULT '',
    rating     SMALLINT CHECK (rating BETWEEN 1 AND 5),  -- NULL = unrated
    cover_url  TEXT,
    isbn       TEXT,
    read_date  DATE,
    link       TEXT,                                     -- Goodreads / purchase / reference URL
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
