-- Public home-page content: blog posts, pinned projects, a cache of recent
-- GitHub commits, and a small key/value store for the profile blurb. Reads are
-- public; writes go through the admin API only.

-- A blog post. `slug` is the public URL segment (lowercase, hyphenated) and
-- `body` is markdown rendered client-side. A post is invisible to the public
-- until `is_published`; `published_at` is set on first publish and kept stable
-- across later edits so the byline date doesn't drift.
--
-- Deletion is soft, matching `notes`: the API only sets `is_deleted` and every
-- read filters it out.
CREATE TABLE IF NOT EXISTS posts (
    id           UUID PRIMARY KEY,
    slug         TEXT NOT NULL,
    title        TEXT NOT NULL DEFAULT '',
    body         TEXT NOT NULL DEFAULT '',
    is_published BOOLEAN NOT NULL DEFAULT FALSE,
    published_at TIMESTAMPTZ,
    is_deleted   BOOLEAN NOT NULL DEFAULT FALSE,
    created_at   TIMESTAMPTZ NOT NULL,
    updated_at   TIMESTAMPTZ NOT NULL
);

-- Slugs are unique among live posts only, so a slug freed by deletion is
-- reusable while the hidden row keeps its history.
CREATE UNIQUE INDEX IF NOT EXISTS posts_slug_live_idx
    ON posts (slug) WHERE NOT is_deleted;

CREATE INDEX IF NOT EXISTS posts_published_idx
    ON posts (published_at DESC) WHERE is_published AND NOT is_deleted;

-- A pinned project shown on the home page. `repo` is a GitHub `owner/name`;
-- `sort_order` ascending decides display order.
CREATE TABLE IF NOT EXISTS projects (
    id         UUID PRIMARY KEY,
    name       TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    url        TEXT,
    repo       TEXT,
    sort_order INT NOT NULL DEFAULT 0,
    is_deleted BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMPTZ NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS projects_sort_order_idx
    ON projects (sort_order) WHERE NOT is_deleted;

-- A cache of recent commits pulled from the GitHub events API by a background
-- sync task. Plain cache semantics: rows are upserted by sha and pruned to the
-- newest N, never soft-deleted.
CREATE TABLE IF NOT EXISTS github_commits (
    sha          TEXT PRIMARY KEY,
    repo         TEXT NOT NULL,
    message      TEXT NOT NULL,
    url          TEXT NOT NULL,
    committed_at TIMESTAMPTZ NOT NULL,
    fetched_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS github_commits_committed_at_idx
    ON github_commits (committed_at DESC);

-- Small site-wide key/value settings: the home-page intro markdown, profile
-- image, GitHub link — plus internal keys (e.g. the GitHub sync etag) that the
-- admin profile editor never exposes.
CREATE TABLE IF NOT EXISTS site_settings (
    key        TEXT PRIMARY KEY,
    value      TEXT NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO site_settings (key, value) VALUES
    ('intro_markdown', ''),
    ('profile_image_url', 'https://avatars.githubusercontent.com/Andrew-McCall'),
    ('github_url', 'https://github.com/Andrew-McCall')
ON CONFLICT (key) DO NOTHING;
