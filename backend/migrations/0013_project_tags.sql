-- Tags for pinned projects, in the same shape as `note_tags`: a bare string,
-- many per project, freely shared between projects. No ids, no soft-delete — a
-- tag exists precisely while some live project names it, so a renamed or
-- removed tag needs no cleanup pass.
--
-- `projects` is soft-deleted, so the FK cascade only fires on a hard delete,
-- which the API never issues. A deleted project keeps its tag rows and they
-- simply stop being reachable: every read joins back through
-- `projects WHERE NOT is_deleted`.
CREATE TABLE IF NOT EXISTS project_tags (
    project_id UUID NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
    tag        TEXT NOT NULL,
    PRIMARY KEY (project_id, tag)
);

-- Serves the distinct-tag list behind the admin editor's autofill; the primary
-- key already covers the per-project lookup.
CREATE INDEX IF NOT EXISTS project_tags_tag_idx ON project_tags (tag);
