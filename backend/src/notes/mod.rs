//! Per-user notes, as markdown documents.
//!
//! A note's `body` is the whole `.md` file — an optional `---` frontmatter block
//! followed by content — and it is the only source of truth. Title, tags, names
//! and links are all *derived* from that text on save ([`derive`]) and written
//! to side tables by [`index::sync_index`], so the index can never disagree with
//! what the author typed.
//!
//! Two rules shape the API:
//!
//! * **The frontmatter block shows everything.** The server keeps no state about
//!   a note that isn't in the note's own text, so a rename writes the superseded
//!   name back into `aliases:` rather than hiding it in a table.
//! * **An index problem never blocks a save.** A duplicate alias or an
//!   unusable tag comes back as a notice in the response, not a `400`.
//!
//! Every handler authenticates with [`auth::authenticate`] (any signed-in user)
//! and scopes its queries to that user's id. Deletion is soft; unlike the old
//! design there is now a restore endpoint, since auto-created notes are cheap to
//! delete by accident.

pub mod derive;
pub mod frontmatter;
pub mod index;

use std::collections::HashMap;
use std::net::SocketAddr;

use chrono::{DateTime, Utc};
use hyper::{Request, StatusCode};
use sonic_rs::{Deserialize, Serialize};
use uuid::Uuid;

use crate::auth;
use crate::config::ApiConfig;
use crate::response::{self, ApiError, Body, ResponseBuilder};

/// The whole body is buffered in memory per request, so it stays bounded — but
/// generously: frontmatter plus a real long-form note passes the old 20k limit
/// sooner than you would think, and the failure mode is a rejected save after
/// the writing is done.
const MAX_BODY_LEN: usize = 100_000;

/// How much plain text a list entry carries, for previews and client search.
const EXCERPT_LEN: usize = 200;

// ---------------------------------------------------------------------------
// Serialized views.
// ---------------------------------------------------------------------------

/// A list entry. Deliberately without the body: the browser, quick switcher and
/// `[[link]]` autocomplete all work from this, and shipping every note's full
/// text to a phone to render a sidebar would be wasteful.
#[derive(Serialize)]
struct NoteIndexJson {
    id: String,
    /// `None` for a soft-deleted note: deletion releases its names so they can
    /// be reused straight away, which means a trashed note genuinely has no
    /// address until it is restored. Nullable rather than an empty string so a
    /// client can't accidentally build `/secret/notes/` out of it.
    slug: Option<String>,
    title: String,
    tags: Vec<String>,
    /// Every name, primary first. Carried in the index so the client can
    /// resolve a `[[link]]` written against a superseded name without a round
    /// trip — otherwise the reader would show it dangling while the server
    /// resolved it perfectly well.
    names: Vec<String>,
    /// User-defined properties, so the browser can filter on them without a
    /// second round trip. Filtering happens client-side over this list (as tag
    /// and title search already do), which also keeps the counts shown in the
    /// filter menu consistent with the rows actually listed.
    udf: Vec<MetaEntry>,
    excerpt: String,
    created_at: String,
    updated_at: String,
}

#[derive(Serialize, Clone)]
struct MetaEntry {
    key: String,
    value: String,
}

#[derive(Serialize)]
struct LinkJson {
    slug: String,
    /// `None` when the target doesn't exist yet — a dangling link.
    title: Option<String>,
    id: Option<String>,
}

/// One note in full, with everything the reader needs in a single request.
#[derive(Serialize)]
struct NoteJson {
    id: String,
    slug: String,
    title: String,
    body: String,
    tags: Vec<String>,
    /// Every name this note answers to, primary first.
    names: Vec<String>,
    udf: Vec<MetaEntry>,
    links: Vec<LinkJson>,
    backlinks: Vec<LinkJson>,
    created_at: String,
    updated_at: String,
    /// Non-fatal problems from the last save (empty on a plain read).
    #[serde(skip_serializing_if = "Vec::is_empty")]
    notices: Vec<String>,
}

#[derive(Serialize)]
struct MetaValueJson {
    value: String,
    count: i64,
}

#[derive(Serialize)]
struct MetaTypeJson {
    key: String,
    count: i64,
    /// `"tag"` for the built-in type, `"udf"` for a user-defined key.
    ///
    /// These can collide: writing `tag:` instead of `tags:` produces a UDF key
    /// literally named "tag" alongside the real thing — which is exactly the
    /// mistake the UDF catch-all exists to make visible, so the two are
    /// reported separately rather than merged. Clients key on (source, key).
    source: &'static str,
}

#[derive(sqlx::FromRow)]
struct NoteRow {
    id: Uuid,
    title: String,
    body: String,
    created_at: DateTime<Utc>,
    updated_at: DateTime<Utc>,
}

/// Plain-text preview: the content after the frontmatter, with the most common
/// markdown punctuation removed so a preview doesn't lead with `##`.
fn excerpt_of(body: &str) -> String {
    let fm = frontmatter::parse(body);
    let content = frontmatter::content_of(body, &fm);
    let mut text = String::with_capacity(EXCERPT_LEN);
    // Counted as we go: `text.chars().count()` per character made this
    // quadratic, once per note on every list request.
    let mut taken = 0usize;
    for c in content.chars() {
        if taken >= EXCERPT_LEN {
            break;
        }
        let before = text.len();
        match c {
            '#' | '*' | '`' | '>' | '[' | ']' | '_' => {}
            '\n' | '\r' | '\t' => {
                if !text.ends_with(' ') {
                    text.push(' ');
                }
            }
            _ => text.push(c),
        }
        // Only characters that actually landed count toward the budget.
        if text.len() != before {
            taken += 1;
        }
    }
    text.trim().to_string()
}

/// Loads `(note_id → tags)` for a set of notes in one query, rather than one
/// round trip per note.
async fn tags_for(
    pool: &sqlx::PgPool,
    user_id: Uuid,
) -> Result<HashMap<Uuid, Vec<String>>, sqlx::Error> {
    let pairs: Vec<(Uuid, String)> =
        sqlx::query_as("SELECT note_id, tag FROM note_tags WHERE user_id = $1 ORDER BY tag")
            .bind(user_id)
            .fetch_all(pool)
            .await?;
    let mut out: HashMap<Uuid, Vec<String>> = HashMap::new();
    for (note_id, tag) in pairs {
        out.entry(note_id).or_default().push(tag);
    }
    Ok(out)
}

/// User-defined properties for every note, in one query.
async fn udf_for(
    pool: &sqlx::PgPool,
    user_id: Uuid,
) -> Result<HashMap<Uuid, Vec<MetaEntry>>, sqlx::Error> {
    let rows: Vec<(Uuid, String, String)> = sqlx::query_as(
        "SELECT note_id, key, value FROM note_udf WHERE user_id = $1 ORDER BY key, value",
    )
    .bind(user_id)
    .fetch_all(pool)
    .await?;
    let mut out: HashMap<Uuid, Vec<MetaEntry>> = HashMap::new();
    for (note_id, key, value) in rows {
        out.entry(note_id).or_default().push(MetaEntry { key, value });
    }
    Ok(out)
}

/// All names for every note, primary first, in one query.
async fn names_for(
    pool: &sqlx::PgPool,
    user_id: Uuid,
) -> Result<HashMap<Uuid, Vec<String>>, sqlx::Error> {
    let rows: Vec<(Uuid, String)> = sqlx::query_as(
        "SELECT note_id, slug FROM note_names WHERE user_id = $1 \
         ORDER BY note_id, is_primary DESC, slug",
    )
    .bind(user_id)
    .fetch_all(pool)
    .await?;
    let mut out: HashMap<Uuid, Vec<String>> = HashMap::new();
    for (note_id, slug) in rows {
        out.entry(note_id).or_default().push(slug);
    }
    Ok(out)
}

// ---------------------------------------------------------------------------
// Note handlers.
// ---------------------------------------------------------------------------

/// `GET /notes` — the user's notes as an index (no bodies).
///
/// `?q=` filters on title and body, case-insensitively. `?trash=1` lists
/// soft-deleted notes instead of live ones, which is what backs the Trash view.
pub async fn list_notes(
    req: Request<hyper::body::Incoming>,
    peer: SocketAddr,
    config: &ApiConfig,
) -> hyper::Response<Body> {
    let user = match auth::authenticate(&req, peer, config).await {
        Ok(user) => user,
        Err(err) => return ResponseBuilder::from(err).into(),
    };

    let query = req.uri().query();
    let trash = crate::admin::query_param(query, "trash").as_deref() == Some("1");
    // `%` and `_` are LIKE wildcards, so a search for "100%" would otherwise
    // match far more than it should. `\` is the escape character named below.
    let search = crate::admin::query_param(query, "q")
        .unwrap_or_default()
        .replace('\\', "\\\\")
        .replace('%', "\\%")
        .replace('_', "\\_");

    let pool = config.db.pool();
    let notes: Vec<NoteRow> = match sqlx::query_as(
        "SELECT id, title, body, created_at, updated_at FROM notes \
         WHERE user_id = $1 AND is_deleted = $2 \
           AND ($3 = '' OR title ILIKE '%' || $3 || '%' ESCAPE '\\' \
                        OR body  ILIKE '%' || $3 || '%' ESCAPE '\\') \
         ORDER BY updated_at DESC",
    )
    .bind(user.id)
    .bind(trash)
    .bind(&search)
    .fetch_all(&pool)
    .await
    {
        Ok(notes) => notes,
        Err(err) => {
            tracing::error!(error = %err, "failed to list notes");
            return ResponseBuilder::from(ApiError::Internal).into();
        }
    };

    let lookups = async {
        Ok::<_, sqlx::Error>((
            tags_for(&pool, user.id).await?,
            names_for(&pool, user.id).await?,
            udf_for(&pool, user.id).await?,
        ))
    };
    let (tags, names, udf) = match lookups.await {
        Ok(pair) => pair,
        Err(err) => {
            tracing::error!(error = %err, "failed to load note index");
            return ResponseBuilder::from(ApiError::Internal).into();
        }
    };

    let list: Vec<NoteIndexJson> = notes
        .into_iter()
        .map(|row| {
            let names = names.get(&row.id).cloned().unwrap_or_default();
            NoteIndexJson {
                slug: names.first().cloned(),
                names,
                tags: tags.get(&row.id).cloned().unwrap_or_default(),
                udf: udf.get(&row.id).cloned().unwrap_or_default(),
                excerpt: excerpt_of(&row.body),
                id: row.id.to_string(),
                title: row.title,
                created_at: row.created_at.to_rfc3339(),
                updated_at: row.updated_at.to_rfc3339(),
            }
        })
        .collect();

    ResponseBuilder::new(StatusCode::OK).json(&list).into()
}

/// Assembles the full view of one note: its own row plus names, tags, UDF
/// properties, outbound links (resolved where possible) and backlinks.
async fn load_full(
    pool: &sqlx::PgPool,
    user_id: Uuid,
    note_id: Uuid,
    notices: Vec<String>,
) -> Result<Option<NoteJson>, sqlx::Error> {
    let Some(row) = sqlx::query_as::<_, NoteRow>(
        "SELECT id, title, body, created_at, updated_at FROM notes \
         WHERE id = $1 AND user_id = $2 AND NOT is_deleted",
    )
    .bind(note_id)
    .bind(user_id)
    .fetch_optional(pool)
    .await?
    else {
        return Ok(None);
    };

    // Primary first, then aliases alphabetically.
    let names: Vec<String> = sqlx::query_scalar(
        "SELECT slug FROM note_names WHERE note_id = $1 ORDER BY is_primary DESC, slug",
    )
    .bind(note_id)
    .fetch_all(pool)
    .await?;

    let tags: Vec<String> =
        sqlx::query_scalar("SELECT tag FROM note_tags WHERE note_id = $1 ORDER BY tag")
            .bind(note_id)
            .fetch_all(pool)
            .await?;

    let udf: Vec<(String, String)> = sqlx::query_as(
        "SELECT key, value FROM note_udf WHERE note_id = $1 ORDER BY key, value",
    )
    .bind(note_id)
    .fetch_all(pool)
    .await?;

    // Outbound links, left-joined against names so a dangling target comes back
    // with a null title rather than being silently dropped.
    let links: Vec<(String, Option<Uuid>, Option<String>)> = sqlx::query_as(
        "SELECT l.target_slug, n.id, n.title \
         FROM note_links l \
         LEFT JOIN note_names nm ON nm.user_id = $2 AND nm.slug = l.target_slug \
         LEFT JOIN notes n ON n.id = nm.note_id AND NOT n.is_deleted \
         WHERE l.source_id = $1 \
         ORDER BY l.target_slug",
    )
    .bind(note_id)
    .bind(user_id)
    .fetch_all(pool)
    .await?;

    // Backlinks: anyone pointing at *any* of this note's names, so a link
    // written against an old name still counts.
    let backlinks: Vec<(Uuid, String, String)> = sqlx::query_as(
        "SELECT DISTINCT n.id, nm.slug, n.title \
         FROM note_links l \
         JOIN notes n ON n.id = l.source_id \
         JOIN note_names nm ON nm.note_id = n.id AND nm.is_primary \
         WHERE l.target_slug = ANY($1) AND n.user_id = $2 AND NOT n.is_deleted AND n.id <> $3 \
         ORDER BY n.title",
    )
    .bind(&names)
    .bind(user_id)
    .bind(note_id)
    .fetch_all(pool)
    .await?;

    Ok(Some(NoteJson {
        id: row.id.to_string(),
        slug: names.first().cloned().unwrap_or_default(),
        title: row.title,
        body: row.body,
        tags,
        names,
        udf: udf
            .into_iter()
            .map(|(key, value)| MetaEntry { key, value })
            .collect(),
        links: links
            .into_iter()
            .map(|(slug, id, title)| LinkJson {
                slug,
                id: id.map(|i| i.to_string()),
                title,
            })
            .collect(),
        backlinks: backlinks
            .into_iter()
            .map(|(id, slug, title)| LinkJson {
                slug,
                id: Some(id.to_string()),
                title: Some(title),
            })
            .collect(),
        created_at: row.created_at.to_rfc3339(),
        updated_at: row.updated_at.to_rfc3339(),
        notices,
    }))
}

/// `GET /notes/{id}` — one note in full, with links and backlinks.
pub async fn get_note(
    req: Request<hyper::body::Incoming>,
    peer: SocketAddr,
    config: &ApiConfig,
    id: &str,
) -> hyper::Response<Body> {
    let user = match auth::authenticate(&req, peer, config).await {
        Ok(user) => user,
        Err(err) => return ResponseBuilder::from(err).into(),
    };
    let Ok(note_id) = Uuid::parse_str(id) else {
        return ResponseBuilder::from(ApiError::NotFound(format!("/notes/{id}"))).into();
    };

    match load_full(&config.db.pool(), user.id, note_id, Vec::new()).await {
        Ok(Some(note)) => ResponseBuilder::new(StatusCode::OK).json(&note).into(),
        Ok(None) => ResponseBuilder::from(ApiError::NotFound(format!("/notes/{id}"))).into(),
        Err(err) => {
            tracing::error!(error = %err, "failed to load note");
            ResponseBuilder::from(ApiError::Internal).into()
        }
    }
}

#[derive(Deserialize)]
struct NoteRequest {
    #[serde(default)]
    body: String,
    /// Optimistic concurrency: the `updated_at` the client last saw. When it
    /// no longer matches, the save is refused with a `409` instead of silently
    /// overwriting another tab — reachable in practice because the editor
    /// autosaves.
    #[serde(default)]
    base_updated_at: Option<String>,
}

const BODY_HINT: &str = r#"expected a JSON body like {"body": "---\ntitle: …\n---\n\n…"}"#;

fn validate(body: &NoteRequest) -> Result<(), ApiError> {
    if body.body.chars().count() > MAX_BODY_LEN {
        return Err(ApiError::BadRequest(format!(
            "a note must be at most {MAX_BODY_LEN} characters"
        )));
    }
    Ok(())
}

/// `POST /notes` — body `{body}`. Everything else is derived.
pub async fn create_note(
    req: Request<hyper::body::Incoming>,
    peer: SocketAddr,
    config: &ApiConfig,
) -> hyper::Response<Body> {
    let user = match auth::authenticate(&req, peer, config).await {
        Ok(user) => user,
        Err(err) => return ResponseBuilder::from(err).into(),
    };

    let payload: NoteRequest = match response::read_json(req, BODY_HINT).await {
        Ok(body) => body,
        Err(err) => return ResponseBuilder::from(err).into(),
    };
    if let Err(err) = validate(&payload) {
        return ResponseBuilder::from(err).into();
    }

    let id = Uuid::new_v4();
    let now = Utc::now();
    let pool = config.db.pool();
    let derived = derive::derive(&payload.body);

    let result = async {
        let mut tx = pool.begin().await?;
        sqlx::query(
            "INSERT INTO notes (id, user_id, title, body, created_at, updated_at) \
             VALUES ($1, $2, $3, $4, $5, $5)",
        )
        .bind(id)
        .bind(user.id)
        .bind(&derived.title)
        .bind(&payload.body)
        .bind(now)
        .execute(&mut *tx)
        .await?;
        let notices = index::sync_index(&mut tx, user.id, id, &derived).await?;
        tx.commit().await?;
        Ok::<_, sqlx::Error>(notices)
    };

    let notices = match result.await {
        Ok(notices) => notices,
        Err(err) => {
            tracing::error!(error = %err, "failed to create note");
            return ResponseBuilder::from(ApiError::Internal).into();
        }
    };

    match load_full(&pool, user.id, id, notices).await {
        Ok(Some(note)) => ResponseBuilder::new(StatusCode::CREATED).json(&note).into(),
        _ => ResponseBuilder::from(ApiError::Internal).into(),
    }
}

/// Ensures a superseded primary name survives as an alias **in the note's own
/// text**, so edit mode always shows every name the note answers to.
fn preserve_old_name(body: &str, old: &str) -> String {
    let fm = frontmatter::parse(body);
    let mut aliases: Vec<String> = fm.get("aliases").to_vec();
    if aliases
        .iter()
        .any(|a| crate::slug::slugify(a) == old)
    {
        return body.to_string();
    }
    aliases.push(old.to_string());
    frontmatter::patch_list(body, "aliases", &aliases)
}

/// `PUT /notes/{id}` — body `{body, base_updated_at?}`. Replaces the document
/// and rebuilds its index. `404` if the note isn't the caller's, `409` if it
/// changed underneath them.
pub async fn update_note(
    req: Request<hyper::body::Incoming>,
    peer: SocketAddr,
    config: &ApiConfig,
    id: &str,
) -> hyper::Response<Body> {
    let user = match auth::authenticate(&req, peer, config).await {
        Ok(user) => user,
        Err(err) => return ResponseBuilder::from(err).into(),
    };
    let Ok(note_id) = Uuid::parse_str(id) else {
        return ResponseBuilder::from(ApiError::NotFound(format!("/notes/{id}"))).into();
    };

    let payload: NoteRequest = match response::read_json(req, BODY_HINT).await {
        Ok(body) => body,
        Err(err) => return ResponseBuilder::from(err).into(),
    };
    if let Err(err) = validate(&payload) {
        return ResponseBuilder::from(err).into();
    }

    let now = Utc::now();
    let pool = config.db.pool();

    enum Outcome {
        Saved(Vec<String>),
        Missing,
        Conflict,
    }

    let result = async {
        let mut tx = pool.begin().await?;

        let existing: Option<(DateTime<Utc>,)> = sqlx::query_as(
            "SELECT updated_at FROM notes WHERE id = $1 AND user_id = $2 AND NOT is_deleted \
             FOR UPDATE",
        )
        .bind(note_id)
        .bind(user.id)
        .fetch_optional(&mut *tx)
        .await?;

        let Some((current_updated,)) = existing else {
            return Ok::<_, sqlx::Error>(Outcome::Missing);
        };

        // Only enforced when the client supplies a baseline, so a scripted
        // caller can still do a blind write.
        if let Some(base) = payload.base_updated_at.as_deref() {
            if let Ok(base) = DateTime::parse_from_rfc3339(base) {
                if base.with_timezone(&Utc) != current_updated {
                    return Ok(Outcome::Conflict);
                }
            }
        }

        let old_primary: Option<String> = sqlx::query_scalar(
            "SELECT slug FROM note_names WHERE note_id = $1 AND is_primary",
        )
        .bind(note_id)
        .fetch_optional(&mut *tx)
        .await?;

        // A rename keeps the old name working, recorded in the frontmatter
        // rather than hidden server-side.
        let mut body = payload.body.clone();
        let mut derived = derive::derive(&body);
        if let Some(old) = old_primary {
            if !derived.primary.is_empty() && derived.primary != old {
                body = preserve_old_name(&body, &old);
                derived = derive::derive(&body);
            }
        }

        sqlx::query("UPDATE notes SET title = $1, body = $2, updated_at = $3 WHERE id = $4")
            .bind(&derived.title)
            .bind(&body)
            .bind(now)
            .bind(note_id)
            .execute(&mut *tx)
            .await?;

        let notices = index::sync_index(&mut tx, user.id, note_id, &derived).await?;
        tx.commit().await?;
        Ok(Outcome::Saved(notices))
    };

    let notices = match result.await {
        Ok(Outcome::Saved(notices)) => notices,
        Ok(Outcome::Missing) => {
            return ResponseBuilder::from(ApiError::NotFound(format!("/notes/{id}"))).into();
        }
        Ok(Outcome::Conflict) => {
            // The current note comes back with the error so the editor can show
            // what it would have overwritten.
            let current = load_full(&pool, user.id, note_id, Vec::new()).await.ok().flatten();
            return match current {
                Some(note) => ResponseBuilder::new(StatusCode::CONFLICT).json(&note).into(),
                None => ResponseBuilder::from(ApiError::Internal).into(),
            };
        }
        Err(err) => {
            tracing::error!(error = %err, "failed to update note");
            return ResponseBuilder::from(ApiError::Internal).into();
        }
    };

    match load_full(&pool, user.id, note_id, notices).await {
        Ok(Some(note)) => ResponseBuilder::new(StatusCode::OK).json(&note).into(),
        Ok(None) => ResponseBuilder::from(ApiError::NotFound(format!("/notes/{id}"))).into(),
        Err(err) => {
            tracing::error!(error = %err, "failed to reload note after save");
            ResponseBuilder::from(ApiError::Internal).into()
        }
    }
}

/// `DELETE /notes/{id}` — soft-deletes, and releases the note's names so they
/// can be reused immediately. Restorable via `POST /notes/{id}/restore`.
pub async fn delete_note(
    req: Request<hyper::body::Incoming>,
    peer: SocketAddr,
    config: &ApiConfig,
    id: &str,
) -> hyper::Response<Body> {
    let user = match auth::authenticate(&req, peer, config).await {
        Ok(user) => user,
        Err(err) => return ResponseBuilder::from(err).into(),
    };
    let Ok(note_id) = Uuid::parse_str(id) else {
        return ResponseBuilder::from(ApiError::NotFound(format!("/notes/{id}"))).into();
    };

    let pool = config.db.pool();
    let result = async {
        let mut tx = pool.begin().await?;
        let done = sqlx::query(
            "UPDATE notes SET is_deleted = TRUE, updated_at = now() \
             WHERE id = $1 AND user_id = $2 AND NOT is_deleted",
        )
        .bind(note_id)
        .bind(user.id)
        .execute(&mut *tx)
        .await?;
        if done.rows_affected() == 0 {
            return Ok::<bool, sqlx::Error>(false);
        }
        // Names are freed on delete; the reindexer rebuilds them on restore.
        sqlx::query("DELETE FROM note_names WHERE note_id = $1")
            .bind(note_id)
            .execute(&mut *tx)
            .await?;
        tx.commit().await?;
        Ok(true)
    };

    match result.await {
        Ok(true) => ResponseBuilder::new(StatusCode::NO_CONTENT).empty().into(),
        Ok(false) => ResponseBuilder::from(ApiError::NotFound(format!("/notes/{id}"))).into(),
        Err(err) => {
            tracing::error!(error = %err, "failed to delete note");
            ResponseBuilder::from(ApiError::Internal).into()
        }
    }
}

/// `POST /notes/{id}/restore` — brings a soft-deleted note back and rebuilds its
/// index. Its old names may have been taken in the meantime, in which case
/// [`index::sync_index`] allocates fresh ones and says so in the notices.
pub async fn restore_note(
    req: Request<hyper::body::Incoming>,
    peer: SocketAddr,
    config: &ApiConfig,
    id: &str,
) -> hyper::Response<Body> {
    let user = match auth::authenticate(&req, peer, config).await {
        Ok(user) => user,
        Err(err) => return ResponseBuilder::from(err).into(),
    };
    let Ok(note_id) = Uuid::parse_str(id) else {
        return ResponseBuilder::from(ApiError::NotFound(format!("/notes/{id}"))).into();
    };

    let pool = config.db.pool();
    let result = async {
        let mut tx = pool.begin().await?;
        let body: Option<String> = sqlx::query_scalar(
            "UPDATE notes SET is_deleted = FALSE, updated_at = now() \
             WHERE id = $1 AND user_id = $2 AND is_deleted RETURNING body",
        )
        .bind(note_id)
        .bind(user.id)
        .fetch_optional(&mut *tx)
        .await?;

        let Some(body) = body else {
            return Ok::<Option<Vec<String>>, sqlx::Error>(None);
        };
        let derived = derive::derive(&body);
        let notices = index::sync_index(&mut tx, user.id, note_id, &derived).await?;
        tx.commit().await?;
        Ok(Some(notices))
    };

    match result.await {
        Ok(Some(notices)) => match load_full(&pool, user.id, note_id, notices).await {
            Ok(Some(note)) => ResponseBuilder::new(StatusCode::OK).json(&note).into(),
            _ => ResponseBuilder::from(ApiError::Internal).into(),
        },
        Ok(None) => ResponseBuilder::from(ApiError::NotFound(format!("/notes/{id}"))).into(),
        Err(err) => {
            tracing::error!(error = %err, "failed to restore note");
            ResponseBuilder::from(ApiError::Internal).into()
        }
    }
}

// ---------------------------------------------------------------------------
// Metadata queries.
// ---------------------------------------------------------------------------

/// `GET /meta?type=X` — the values in use for a metadata type, with counts.
///
/// One shape for `tag`, `alias` and every user-defined key, so the client never
/// learns that they are stored in different tables. That indirection is also
/// what lets a display registry arrive later without touching the client.
pub async fn list_meta(
    req: Request<hyper::body::Incoming>,
    peer: SocketAddr,
    config: &ApiConfig,
) -> hyper::Response<Body> {
    let user = match auth::authenticate(&req, peer, config).await {
        Ok(user) => user,
        Err(err) => return ResponseBuilder::from(err).into(),
    };

    let query = req.uri().query();
    let kind = crate::admin::query_param(query, "type").unwrap_or_else(|| "tag".to_string());
    // `&source=udf` reaches a user-defined key that shadows a built-in name.
    let force_udf = crate::admin::query_param(query, "source").as_deref() == Some("udf");

    let pool = config.db.pool();
    let rows: Result<Vec<(String, i64)>, sqlx::Error> = match kind.as_str() {
        _ if force_udf => sqlx::query_as(
            "SELECT u.value, count(*) FROM note_udf u \
             JOIN notes n ON n.id = u.note_id AND NOT n.is_deleted \
             WHERE u.user_id = $1 AND u.key = $2 GROUP BY u.value ORDER BY u.value",
        )
        .bind(user.id)
        .bind(&kind)
        .fetch_all(&pool)
        .await,
        "tag" => sqlx::query_as(
            "SELECT t.tag, count(*) FROM note_tags t \
             JOIN notes n ON n.id = t.note_id AND NOT n.is_deleted \
             WHERE t.user_id = $1 GROUP BY t.tag ORDER BY t.tag",
        )
        .bind(user.id)
        .fetch_all(&pool)
        .await,
        "alias" | "name" => sqlx::query_as(
            "SELECT nm.slug, 1::bigint FROM note_names nm \
             JOIN notes n ON n.id = nm.note_id AND NOT n.is_deleted \
             WHERE nm.user_id = $1 AND nm.is_primary = $2 ORDER BY nm.slug",
        )
        .bind(user.id)
        .bind(kind == "name")
        .fetch_all(&pool)
        .await,
        other => sqlx::query_as(
            "SELECT u.value, count(*) FROM note_udf u \
             JOIN notes n ON n.id = u.note_id AND NOT n.is_deleted \
             WHERE u.user_id = $1 AND u.key = $2 GROUP BY u.value ORDER BY u.value",
        )
        .bind(user.id)
        .bind(other)
        .fetch_all(&pool)
        .await,
    };

    match rows {
        Ok(rows) => {
            let list: Vec<MetaValueJson> = rows
                .into_iter()
                .map(|(value, count)| MetaValueJson { value, count })
                .collect();
            ResponseBuilder::new(StatusCode::OK).json(&list).into()
        }
        Err(err) => {
            tracing::error!(error = %err, "failed to list metadata values");
            ResponseBuilder::from(ApiError::Internal).into()
        }
    }
}

/// `GET /meta/types` — the metadata keys actually in use, with counts.
///
/// This is what lets the browser offer a filter for a property invented this
/// morning, without a registry to register it in first.
pub async fn list_meta_types(
    req: Request<hyper::body::Incoming>,
    peer: SocketAddr,
    config: &ApiConfig,
) -> hyper::Response<Body> {
    let user = match auth::authenticate(&req, peer, config).await {
        Ok(user) => user,
        Err(err) => return ResponseBuilder::from(err).into(),
    };

    let pool = config.db.pool();
    let rows: Result<Vec<(String, i64, String)>, sqlx::Error> = sqlx::query_as(
        "SELECT 'tag', count(DISTINCT t.tag), 'tag' FROM note_tags t \
           JOIN notes n ON n.id = t.note_id AND NOT n.is_deleted WHERE t.user_id = $1 \
         UNION ALL \
         SELECT u.key, count(DISTINCT u.value), 'udf' FROM note_udf u \
           JOIN notes n ON n.id = u.note_id AND NOT n.is_deleted WHERE u.user_id = $1 \
           GROUP BY u.key \
         ORDER BY 3, 1",
    )
    .bind(user.id)
    .fetch_all(&pool)
    .await;

    match rows {
        Ok(rows) => {
            let list: Vec<MetaTypeJson> = rows
                .into_iter()
                .filter(|(_, count, _)| *count > 0)
                .map(|(key, count, source)| MetaTypeJson {
                    key,
                    count,
                    source: if source == "udf" { "udf" } else { "tag" },
                })
                .collect();
            ResponseBuilder::new(StatusCode::OK).json(&list).into()
        }
        Err(err) => {
            tracing::error!(error = %err, "failed to list metadata types");
            ResponseBuilder::from(ApiError::Internal).into()
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn excerpt_skips_the_frontmatter_block() {
        let body = "---\ntitle: T\ntags: [a]\n---\n\nThe actual content.";
        assert_eq!(excerpt_of(body), "The actual content.");
    }

    #[test]
    fn excerpt_strips_markdown_punctuation() {
        assert_eq!(excerpt_of("## Heading\n\n**bold** text"), "Heading bold text");
    }

    #[test]
    fn excerpt_is_bounded() {
        let body = "x".repeat(EXCERPT_LEN * 2);
        assert_eq!(excerpt_of(&body).chars().count(), EXCERPT_LEN);
    }

    #[test]
    fn excerpt_of_an_empty_note_is_empty() {
        assert_eq!(excerpt_of("---\ntitle: T\n---\n"), "");
    }

    #[test]
    fn preserve_old_name_appends_the_superseded_slug() {
        let body = "---\ntitle: New Name\n---\nbody";
        let out = preserve_old_name(body, "old-name");
        assert_eq!(frontmatter::parse(&out).get("aliases"), ["old-name".to_string()]);
        // And it is visible in the text, not just the index.
        assert!(out.contains("old-name"));
    }

    #[test]
    fn preserve_old_name_keeps_existing_aliases() {
        let body = "---\ntitle: T\naliases:\n  - first\n---\nbody";
        let out = preserve_old_name(body, "second");
        assert_eq!(
            frontmatter::parse(&out).get("aliases"),
            ["first".to_string(), "second".to_string()]
        );
    }

    #[test]
    fn preserve_old_name_is_idempotent() {
        let body = "---\ntitle: T\naliases:\n  - old-name\n---\nbody";
        assert_eq!(preserve_old_name(body, "old-name"), body);
    }
}
