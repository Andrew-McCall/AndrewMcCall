//! The only code that writes a note's derived index, plus the boot reindexer.
//!
//! Every save funnels through [`sync_index`], so no handler touches
//! `note_names`, `note_tags`, `note_udf` or `note_links` directly. Each table is
//! rebuilt wholesale for the note being saved (delete, then insert), which makes
//! the operation idempotent and means a re-run can only ever converge.

use sqlx::{PgPool, Postgres, Transaction};
use uuid::Uuid;

use super::derive::{self, Derived, Notice};
use super::frontmatter;

/// Bumped whenever the derivation rules change. The reindexer only visits rows
/// below this, so a parser fix propagates on the next restart without re-walking
/// the vault on every boot afterwards.
pub const INDEX_VERSION: i16 = 1;

/// How many `-2`, `-3`… suffixes to try before falling back to the note id.
const MAX_SLUG_ATTEMPTS: u32 = 50;

/// A slug that is always available: derived from the note's own id.
fn fallback_slug(note_id: Uuid) -> String {
    format!("note-{}", &note_id.simple().to_string()[..8])
}

/// Which note currently owns `slug`, if any.
async fn owner_of(
    tx: &mut Transaction<'_, Postgres>,
    user_id: Uuid,
    slug: &str,
) -> Result<Option<Uuid>, sqlx::Error> {
    sqlx::query_scalar("SELECT note_id FROM note_names WHERE user_id = $1 AND slug = $2")
        .bind(user_id)
        .bind(slug)
        .fetch_optional(&mut **tx)
        .await
}

/// Picks a free primary slug for this note, preferring `wanted`.
///
/// A note must always end up with exactly one primary name, so unlike an alias
/// this can't simply be skipped on collision — it takes a numeric suffix, and
/// ultimately its own id.
///
/// Called after the note's own name rows have been cleared, so a candidate is
/// only ever owned by *another* note; there is no "already mine" case.
async fn allocate_primary(
    tx: &mut Transaction<'_, Postgres>,
    user_id: Uuid,
    note_id: Uuid,
    wanted: &str,
) -> Result<String, sqlx::Error> {
    let base = if wanted.is_empty() {
        fallback_slug(note_id)
    } else {
        wanted.to_string()
    };

    for attempt in 1..=MAX_SLUG_ATTEMPTS {
        let candidate = if attempt == 1 {
            base.clone()
        } else {
            format!("{base}-{attempt}")
        };
        if owner_of(tx, user_id, &candidate).await?.is_none() {
            return Ok(candidate);
        }
    }
    Ok(fallback_slug(note_id))
}

/// Rebuilds every derived table for one note and refreshes its cached title.
///
/// Returns the non-fatal notices the editor shows in its status line — a
/// dropped alias or a normalised tag never fails the save, because an index
/// conflict must not stop someone writing.
pub async fn sync_index(
    tx: &mut Transaction<'_, Postgres>,
    user_id: Uuid,
    note_id: Uuid,
    derived: &Derived,
) -> Result<Vec<Notice>, sqlx::Error> {
    let mut notices = derived.notices.clone();

    // --- names -------------------------------------------------------------
    // Cleared first so a rename releases the old primary before the new one is
    // claimed, and so an alias removed from the frontmatter disappears here too
    // — the table is derived from the file, with nothing held back.
    sqlx::query("DELETE FROM note_names WHERE note_id = $1")
        .bind(note_id)
        .execute(&mut **tx)
        .await?;

    let primary = allocate_primary(tx, user_id, note_id, &derived.primary).await?;
    if !derived.primary.is_empty() && primary != derived.primary {
        notices.push(format!(
            "name {:?} is taken, using {primary:?}",
            derived.primary
        ));
    }
    sqlx::query(
        "INSERT INTO note_names (user_id, slug, note_id, is_primary) VALUES ($1, $2, $3, TRUE)",
    )
    .bind(user_id)
    .bind(&primary)
    .bind(note_id)
    .execute(&mut **tx)
    .await?;

    for alias in &derived.aliases {
        if alias == &primary {
            continue;
        }
        // An alias already owned by another note is dropped, not fought over.
        let inserted = sqlx::query(
            "INSERT INTO note_names (user_id, slug, note_id, is_primary) \
             VALUES ($1, $2, $3, FALSE) ON CONFLICT (user_id, slug) DO NOTHING",
        )
        .bind(user_id)
        .bind(alias)
        .bind(note_id)
        .execute(&mut **tx)
        .await?;
        if inserted.rows_affected() == 0 {
            notices.push(format!("alias {alias:?} is already used by another note"));
        }
    }

    // --- tags --------------------------------------------------------------
    sqlx::query("DELETE FROM note_tags WHERE note_id = $1")
        .bind(note_id)
        .execute(&mut **tx)
        .await?;
    for tag in &derived.tags {
        sqlx::query(
            "INSERT INTO note_tags (note_id, user_id, tag) VALUES ($1, $2, $3) \
             ON CONFLICT DO NOTHING",
        )
        .bind(note_id)
        .bind(user_id)
        .bind(tag)
        .execute(&mut **tx)
        .await?;
    }

    // --- user-defined properties -------------------------------------------
    sqlx::query("DELETE FROM note_udf WHERE note_id = $1")
        .bind(note_id)
        .execute(&mut **tx)
        .await?;
    for (key, value) in &derived.udf {
        sqlx::query(
            "INSERT INTO note_udf (note_id, user_id, key, value) VALUES ($1, $2, $3, $4) \
             ON CONFLICT DO NOTHING",
        )
        .bind(note_id)
        .bind(user_id)
        .bind(key)
        .bind(value)
        .execute(&mut **tx)
        .await?;
    }

    // --- outbound links ----------------------------------------------------
    sqlx::query("DELETE FROM note_links WHERE source_id = $1")
        .bind(note_id)
        .execute(&mut **tx)
        .await?;
    for target in &derived.links {
        sqlx::query(
            "INSERT INTO note_links (source_id, target_slug) VALUES ($1, $2) \
             ON CONFLICT DO NOTHING",
        )
        .bind(note_id)
        .bind(target)
        .execute(&mut **tx)
        .await?;
    }

    // --- cached title ------------------------------------------------------
    sqlx::query("UPDATE notes SET title = $1, index_version = $2 WHERE id = $3")
        .bind(&derived.title)
        .bind(INDEX_VERSION)
        .bind(note_id)
        .execute(&mut **tx)
        .await?;

    Ok(notices)
}

/// Builds the frontmatter block for a note that predates this refactor, from
/// the columns the old schema kept it in.
fn legacy_frontmatter(title: &str, tags: &[String], body: &str) -> String {
    let mut block = String::from("---\n");
    let clean_title = title.trim().replace(['\n', '\r'], " ");
    block.push_str(&format!(
        "title: {}\n",
        if clean_title.is_empty() {
            "Untitled"
        } else {
            &clean_title
        }
    ));
    if !tags.is_empty() {
        block.push_str("tags:\n");
        for tag in tags {
            block.push_str(&format!("  - {}\n", tag.replace(['\n', '\r'], " ")));
        }
    }
    block.push_str("---\n\n");
    block.push_str(body);
    block
}

/// Brings the index up to date at boot.
///
/// * `index_version = 0` — a pre-refactor note. Its title and tags are moved
///   into a frontmatter block prepended to the body, so the file becomes the
///   source of truth it now needs to be.
/// * `index_version < INDEX_VERSION` — re-derived under the current rules.
/// * anything else is skipped, so an ordinary restart does no work.
///
/// Never fatal: a failure here logs and leaves the note for the next boot,
/// rather than taking down a process that serves the whole site.
pub async fn reindex_all(pool: &PgPool) {
    let started = std::time::Instant::now();

    let stale: Vec<(Uuid, Uuid, String, String, i16)> = match sqlx::query_as(
        "SELECT id, user_id, title, body, index_version FROM notes \
         WHERE NOT is_deleted AND index_version < $1 ORDER BY created_at",
    )
    .bind(INDEX_VERSION)
    .fetch_all(pool)
    .await
    {
        Ok(rows) => rows,
        Err(err) => {
            tracing::error!(error = %err, "note reindex could not read notes; skipping");
            return;
        }
    };

    if stale.is_empty() {
        return;
    }
    tracing::info!(count = stale.len(), "reindexing notes");

    let mut migrated = 0usize;
    let mut failed = 0usize;

    for (note_id, user_id, title, body, version) in stale {
        let result = async {
            let mut tx = pool.begin().await?;

            // One-time: give a pre-refactor note the frontmatter it never had.
            let body = if version == 0 && frontmatter::parse(&body).content_start == 0 {
                let tags: Vec<String> = sqlx::query_scalar(
                    "SELECT tag FROM note_tags WHERE note_id = $1 ORDER BY tag",
                )
                .bind(note_id)
                .fetch_all(&mut *tx)
                .await?;
                let rewritten = legacy_frontmatter(&title, &tags, &body);
                sqlx::query("UPDATE notes SET body = $1 WHERE id = $2")
                    .bind(&rewritten)
                    .bind(note_id)
                    .execute(&mut *tx)
                    .await?;
                migrated += 1;
                rewritten
            } else {
                body
            };

            let derived = derive::derive(&body);
            sync_index(&mut tx, user_id, note_id, &derived).await?;
            tx.commit().await?;
            Ok::<_, sqlx::Error>(())
        };

        if let Err(err) = result.await {
            failed += 1;
            tracing::error!(error = %err, %note_id, "failed to reindex note");
        }
    }

    tracing::info!(
        migrated,
        failed,
        elapsed_ms = started.elapsed().as_millis() as u64,
        "note reindex complete"
    );
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fallback_slug_is_stable_and_short() {
        let id = Uuid::parse_str("0189d1f2-3456-7890-abcd-ef0123456789").unwrap();
        assert_eq!(fallback_slug(id), "note-0189d1f2");
        assert_eq!(fallback_slug(id), fallback_slug(id));
    }

    #[test]
    fn legacy_frontmatter_carries_title_and_tags() {
        let out = legacy_frontmatter("My Note", &["a".into(), "b".into()], "body text\n");
        assert_eq!(out, "---\ntitle: My Note\ntags:\n  - a\n  - b\n---\n\nbody text\n");

        let parsed = derive::derive(&out);
        assert_eq!(parsed.title, "My Note");
        assert_eq!(parsed.tags, ["a", "b"]);
    }

    #[test]
    fn legacy_frontmatter_handles_an_empty_title() {
        let out = legacy_frontmatter("   ", &[], "text");
        assert_eq!(out, "---\ntitle: Untitled\n---\n\ntext");
        assert_eq!(derive::derive(&out).title, "Untitled");
    }

    #[test]
    fn legacy_frontmatter_flattens_newlines_in_a_title() {
        let out = legacy_frontmatter("two\nlines", &[], "x");
        assert_eq!(derive::derive(&out).title, "two lines");
    }
}
