//! Per-user notes and a user-scoped tag vocabulary. Every handler authenticates
//! the request with [`auth::authenticate`] (any signed-in user, not just an
//! admin) and scopes every query to that user's id, so a user can only ever see
//! or touch their own notes and tags.
//!
//! Deletion is soft throughout: `DELETE` sets `is_deleted` and all reads filter
//! it out. There is deliberately no undelete endpoint — recovering a deleted
//! note or tag takes direct database access.

use std::collections::HashMap;
use std::net::SocketAddr;

use chrono::{DateTime, Utc};
use hyper::{Request, StatusCode};
use sonic_rs::{Deserialize, Serialize};
use uuid::Uuid;

use crate::auth;
use crate::config::ApiConfig;
use crate::response::{self, ApiError, Body, ResponseBuilder};

/// Caps keep request bodies bounded (the whole body is buffered in memory) and
/// keep the UI sane. A note over these limits is a `400`, not a truncation.
const MAX_TITLE_LEN: usize = 200;
const MAX_BODY_LEN: usize = 20_000;
const MAX_TAG_LEN: usize = 50;
const MAX_TAGS_PER_NOTE: usize = 25;

// ---------------------------------------------------------------------------
// Tag name normalisation.
// ---------------------------------------------------------------------------

/// Trims a tag name and rejects it if it is empty or too long. Names are stored
/// as typed (case preserved); uniqueness is exact.
fn clean_tag_name(raw: &str) -> Result<String, ApiError> {
    let name = raw.trim();
    if name.is_empty() {
        return Err(ApiError::BadRequest("a tag name must not be empty".into()));
    }
    if name.len() > MAX_TAG_LEN {
        return Err(ApiError::BadRequest(format!(
            "a tag name must be at most {MAX_TAG_LEN} characters"
        )));
    }
    Ok(name.to_string())
}

/// Cleans and de-duplicates a list of tag names, preserving first-seen order.
fn clean_tag_list(raw: &[String]) -> Result<Vec<String>, ApiError> {
    if raw.len() > MAX_TAGS_PER_NOTE {
        return Err(ApiError::BadRequest(format!(
            "a note may have at most {MAX_TAGS_PER_NOTE} tags"
        )));
    }
    let mut out: Vec<String> = Vec::with_capacity(raw.len());
    for name in raw {
        let name = clean_tag_name(name)?;
        if !out.iter().any(|existing| existing == &name) {
            out.push(name);
        }
    }
    Ok(out)
}

// ---------------------------------------------------------------------------
// Serialized views.
// ---------------------------------------------------------------------------

/// A note row loaded from the database (its tags are fetched separately).
#[derive(sqlx::FromRow)]
struct NoteRow {
    id: Uuid,
    title: String,
    body: String,
    created_at: DateTime<Utc>,
    updated_at: DateTime<Utc>,
}

/// The JSON wire shape of a note, including its live tag names.
#[derive(Serialize)]
struct NoteJson {
    id: String,
    title: String,
    body: String,
    tags: Vec<String>,
    created_at: String,
    updated_at: String,
}

impl NoteJson {
    fn from_row(row: NoteRow, tags: Vec<String>) -> Self {
        Self {
            id: row.id.to_string(),
            title: row.title,
            body: row.body,
            tags,
            created_at: row.created_at.to_rfc3339(),
            updated_at: row.updated_at.to_rfc3339(),
        }
    }
}

/// The JSON wire shape of a tag.
#[derive(Serialize)]
struct TagJson {
    id: String,
    name: String,
}

// ---------------------------------------------------------------------------
// Tag helpers (shared by note save and tag CRUD).
// ---------------------------------------------------------------------------

/// Resolves a live tag id for `name`, creating the tag if the user doesn't have
/// one yet. Matches the partial unique index on `(user_id, name) WHERE NOT
/// is_deleted`, so a name freed by a soft-deleted tag is reusable.
async fn upsert_tag(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    user_id: Uuid,
    name: &str,
) -> Result<Uuid, sqlx::Error> {
    sqlx::query_scalar(
        "INSERT INTO tags (id, user_id, name) VALUES ($1, $2, $3) \
         ON CONFLICT (user_id, name) WHERE NOT is_deleted \
         DO UPDATE SET name = EXCLUDED.name \
         RETURNING id",
    )
    .bind(Uuid::new_v4())
    .bind(user_id)
    .bind(name)
    .fetch_one(&mut **tx)
    .await
}

/// Replaces a note's tag set with `names` (already cleaned and de-duplicated),
/// creating any tags that don't exist. Runs inside the caller's transaction.
async fn set_note_tags(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    user_id: Uuid,
    note_id: Uuid,
    names: &[String],
) -> Result<(), sqlx::Error> {
    sqlx::query("DELETE FROM note_tags WHERE note_id = $1")
        .bind(note_id)
        .execute(&mut **tx)
        .await?;
    for name in names {
        let tag_id = upsert_tag(tx, user_id, name).await?;
        sqlx::query(
            "INSERT INTO note_tags (note_id, tag_id) VALUES ($1, $2) ON CONFLICT DO NOTHING",
        )
        .bind(note_id)
        .bind(tag_id)
        .execute(&mut **tx)
        .await?;
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Note handlers.
// ---------------------------------------------------------------------------

/// `GET /notes` — the user's live notes, newest-updated first, each with its
/// live tag names.
pub async fn list_notes(
    req: Request<hyper::body::Incoming>,
    peer: SocketAddr,
    config: &ApiConfig,
) -> hyper::Response<Body> {
    let user = match auth::authenticate(&req, peer, config).await {
        Ok(user) => user,
        Err(err) => return ResponseBuilder::from(err).into(),
    };

    let pool = config.db.pool();

    let notes: Vec<NoteRow> = match sqlx::query_as(
        "SELECT id, title, body, created_at, updated_at \
         FROM notes WHERE user_id = $1 AND NOT is_deleted \
         ORDER BY updated_at DESC",
    )
    .bind(user.id)
    .fetch_all(&pool)
    .await
    {
        Ok(notes) => notes,
        Err(err) => {
            tracing::error!(error = %err, "failed to list notes");
            return ResponseBuilder::from(ApiError::Internal).into();
        }
    };

    // One extra query gathers every (note, tag) pair for this user, avoiding a
    // per-note round trip.
    let pairs: Vec<(Uuid, String)> = match sqlx::query_as(
        "SELECT nt.note_id, t.name \
         FROM note_tags nt \
         JOIN tags t ON t.id = nt.tag_id \
         JOIN notes n ON n.id = nt.note_id \
         WHERE n.user_id = $1 AND NOT n.is_deleted AND NOT t.is_deleted \
         ORDER BY t.name",
    )
    .bind(user.id)
    .fetch_all(&pool)
    .await
    {
        Ok(pairs) => pairs,
        Err(err) => {
            tracing::error!(error = %err, "failed to load note tags");
            return ResponseBuilder::from(ApiError::Internal).into();
        }
    };

    let mut tags_by_note: HashMap<Uuid, Vec<String>> = HashMap::new();
    for (note_id, name) in pairs {
        tags_by_note.entry(note_id).or_default().push(name);
    }

    let list: Vec<NoteJson> = notes
        .into_iter()
        .map(|row| {
            let tags = tags_by_note.remove(&row.id).unwrap_or_default();
            NoteJson::from_row(row, tags)
        })
        .collect();

    ResponseBuilder::new(StatusCode::OK).json(&list).into()
}

#[derive(Deserialize)]
struct NoteRequest {
    #[serde(default)]
    title: String,
    #[serde(default)]
    body: String,
    #[serde(default)]
    tags: Vec<String>,
}

/// Validates a note payload, returning the trimmed title and cleaned tag list.
fn validate_note(body: &NoteRequest) -> Result<(String, Vec<String>), ApiError> {
    let title = body.title.trim().to_string();
    if title.chars().count() > MAX_TITLE_LEN {
        return Err(ApiError::BadRequest(format!(
            "a title must be at most {MAX_TITLE_LEN} characters"
        )));
    }
    if body.body.chars().count() > MAX_BODY_LEN {
        return Err(ApiError::BadRequest(format!(
            "a note body must be at most {MAX_BODY_LEN} characters"
        )));
    }
    let tags = clean_tag_list(&body.tags)?;
    Ok((title, tags))
}

/// `POST /notes` — body `{title, body, tags?}`. Creates a note, creating any
/// referenced tags that don't exist yet, and returns the saved note.
pub async fn create_note(
    req: Request<hyper::body::Incoming>,
    peer: SocketAddr,
    config: &ApiConfig,
) -> hyper::Response<Body> {
    let user = match auth::authenticate(&req, peer, config).await {
        Ok(user) => user,
        Err(err) => return ResponseBuilder::from(err).into(),
    };

    let body: NoteRequest = match response::read_json(
        req,
        r#"expected a JSON body like {"title": "…", "body": "…", "tags": ["work"]}"#,
    )
    .await
    {
        Ok(body) => body,
        Err(err) => return ResponseBuilder::from(err).into(),
    };

    let (title, tags) = match validate_note(&body) {
        Ok(parts) => parts,
        Err(err) => return ResponseBuilder::from(err).into(),
    };

    let id = Uuid::new_v4();
    let now = Utc::now();
    let pool = config.db.pool();

    let result = async {
        let mut tx = pool.begin().await?;
        sqlx::query(
            "INSERT INTO notes (id, user_id, title, body, created_at, updated_at) \
             VALUES ($1, $2, $3, $4, $5, $5)",
        )
        .bind(id)
        .bind(user.id)
        .bind(&title)
        .bind(&body.body)
        .bind(now)
        .execute(&mut *tx)
        .await?;
        set_note_tags(&mut tx, user.id, id, &tags).await?;
        tx.commit().await?;
        Ok::<_, sqlx::Error>(())
    };
    if let Err(err) = result.await {
        tracing::error!(error = %err, "failed to create note");
        return ResponseBuilder::from(ApiError::Internal).into();
    }

    let note = NoteJson {
        id: id.to_string(),
        title,
        body: body.body,
        tags,
        created_at: now.to_rfc3339(),
        updated_at: now.to_rfc3339(),
    };
    ResponseBuilder::new(StatusCode::CREATED).json(&note).into()
}

/// `PUT /notes/{id}` — body `{title, body, tags?}`. Replaces the note's content
/// and tag set. `404` if the note isn't the caller's (or is deleted).
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

    let body: NoteRequest = match response::read_json(
        req,
        r#"expected a JSON body like {"title": "…", "body": "…", "tags": ["work"]}"#,
    )
    .await
    {
        Ok(body) => body,
        Err(err) => return ResponseBuilder::from(err).into(),
    };

    let (title, tags) = match validate_note(&body) {
        Ok(parts) => parts,
        Err(err) => return ResponseBuilder::from(err).into(),
    };

    let now = Utc::now();
    let pool = config.db.pool();

    let updated = async {
        let mut tx = pool.begin().await?;
        // Ownership-scoped: only a live note owned by this user is touched. The
        // row count tells us whether it existed.
        let done = sqlx::query(
            "UPDATE notes SET title = $1, body = $2, updated_at = $3 \
             WHERE id = $4 AND user_id = $5 AND NOT is_deleted",
        )
        .bind(&title)
        .bind(&body.body)
        .bind(now)
        .bind(note_id)
        .bind(user.id)
        .execute(&mut *tx)
        .await?;
        if done.rows_affected() == 0 {
            return Ok::<bool, sqlx::Error>(false);
        }
        set_note_tags(&mut tx, user.id, note_id, &tags).await?;
        tx.commit().await?;
        Ok(true)
    };

    match updated.await {
        Ok(true) => {}
        Ok(false) => {
            return ResponseBuilder::from(ApiError::NotFound(format!("/notes/{id}"))).into();
        }
        Err(err) => {
            tracing::error!(error = %err, "failed to update note");
            return ResponseBuilder::from(ApiError::Internal).into();
        }
    }

    let note = NoteJson {
        id: note_id.to_string(),
        title,
        body: body.body,
        tags,
        // created_at isn't reloaded here; the client already has it from the list.
        created_at: now.to_rfc3339(),
        updated_at: now.to_rfc3339(),
    };
    ResponseBuilder::new(StatusCode::OK).json(&note).into()
}

/// `DELETE /notes/{id}` — soft-deletes the note (sets `is_deleted`). `404` if it
/// isn't the caller's or was already deleted.
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
    let result = sqlx::query(
        "UPDATE notes SET is_deleted = TRUE, updated_at = now() \
         WHERE id = $1 AND user_id = $2 AND NOT is_deleted",
    )
    .bind(note_id)
    .bind(user.id)
    .execute(&pool)
    .await;

    match result {
        Ok(done) if done.rows_affected() > 0 => {
            ResponseBuilder::new(StatusCode::NO_CONTENT).empty().into()
        }
        Ok(_) => ResponseBuilder::from(ApiError::NotFound(format!("/notes/{id}"))).into(),
        Err(err) => {
            tracing::error!(error = %err, "failed to delete note");
            ResponseBuilder::from(ApiError::Internal).into()
        }
    }
}

// ---------------------------------------------------------------------------
// Tag handlers.
// ---------------------------------------------------------------------------

/// `GET /tags` — the user's live tags, alphabetically.
pub async fn list_tags(
    req: Request<hyper::body::Incoming>,
    peer: SocketAddr,
    config: &ApiConfig,
) -> hyper::Response<Body> {
    let user = match auth::authenticate(&req, peer, config).await {
        Ok(user) => user,
        Err(err) => return ResponseBuilder::from(err).into(),
    };

    let pool = config.db.pool();
    let rows: Vec<(Uuid, String)> = match sqlx::query_as(
        "SELECT id, name FROM tags WHERE user_id = $1 AND NOT is_deleted ORDER BY name",
    )
    .bind(user.id)
    .fetch_all(&pool)
    .await
    {
        Ok(rows) => rows,
        Err(err) => {
            tracing::error!(error = %err, "failed to list tags");
            return ResponseBuilder::from(ApiError::Internal).into();
        }
    };

    let list: Vec<TagJson> = rows
        .into_iter()
        .map(|(id, name)| TagJson {
            id: id.to_string(),
            name,
        })
        .collect();
    ResponseBuilder::new(StatusCode::OK).json(&list).into()
}

#[derive(Deserialize)]
struct TagRequest {
    name: String,
}

/// `POST /tags` — body `{name}`. Creates a standalone tag. A duplicate live name
/// is a `400`.
pub async fn create_tag(
    req: Request<hyper::body::Incoming>,
    peer: SocketAddr,
    config: &ApiConfig,
) -> hyper::Response<Body> {
    let user = match auth::authenticate(&req, peer, config).await {
        Ok(user) => user,
        Err(err) => return ResponseBuilder::from(err).into(),
    };

    let body: TagRequest =
        match response::read_json(req, r#"expected a JSON body like {"name": "work"}"#).await {
            Ok(body) => body,
            Err(err) => return ResponseBuilder::from(err).into(),
        };

    let name = match clean_tag_name(&body.name) {
        Ok(name) => name,
        Err(err) => return ResponseBuilder::from(err).into(),
    };

    let id = Uuid::new_v4();
    let pool = config.db.pool();
    let result = sqlx::query("INSERT INTO tags (id, user_id, name) VALUES ($1, $2, $3)")
        .bind(id)
        .bind(user.id)
        .bind(&name)
        .execute(&pool)
        .await;

    match result {
        Ok(_) => ResponseBuilder::new(StatusCode::CREATED)
            .json(&TagJson {
                id: id.to_string(),
                name,
            })
            .into(),
        // 23505 is unique_violation against the live-name index.
        Err(sqlx::Error::Database(db)) if db.code().as_deref() == Some("23505") => {
            ResponseBuilder::from(ApiError::BadRequest(format!(
                "a tag named {name:?} already exists"
            )))
            .into()
        }
        Err(err) => {
            tracing::error!(error = %err, "failed to create tag");
            ResponseBuilder::from(ApiError::Internal).into()
        }
    }
}

/// `PUT /tags/{id}` — body `{name}`. Renames a tag. `404` if it isn't the
/// caller's; `400` if the new name collides with another live tag.
pub async fn update_tag(
    req: Request<hyper::body::Incoming>,
    peer: SocketAddr,
    config: &ApiConfig,
    id: &str,
) -> hyper::Response<Body> {
    let user = match auth::authenticate(&req, peer, config).await {
        Ok(user) => user,
        Err(err) => return ResponseBuilder::from(err).into(),
    };

    let Ok(tag_id) = Uuid::parse_str(id) else {
        return ResponseBuilder::from(ApiError::NotFound(format!("/tags/{id}"))).into();
    };

    let body: TagRequest =
        match response::read_json(req, r#"expected a JSON body like {"name": "work"}"#).await {
            Ok(body) => body,
            Err(err) => return ResponseBuilder::from(err).into(),
        };

    let name = match clean_tag_name(&body.name) {
        Ok(name) => name,
        Err(err) => return ResponseBuilder::from(err).into(),
    };

    let pool = config.db.pool();
    let result = sqlx::query(
        "UPDATE tags SET name = $1 WHERE id = $2 AND user_id = $3 AND NOT is_deleted",
    )
    .bind(&name)
    .bind(tag_id)
    .bind(user.id)
    .execute(&pool)
    .await;

    match result {
        Ok(done) if done.rows_affected() > 0 => ResponseBuilder::new(StatusCode::OK)
            .json(&TagJson {
                id: tag_id.to_string(),
                name,
            })
            .into(),
        Ok(_) => ResponseBuilder::from(ApiError::NotFound(format!("/tags/{id}"))).into(),
        Err(sqlx::Error::Database(db)) if db.code().as_deref() == Some("23505") => {
            ResponseBuilder::from(ApiError::BadRequest(format!(
                "a tag named {name:?} already exists"
            )))
            .into()
        }
        Err(err) => {
            tracing::error!(error = %err, "failed to rename tag");
            ResponseBuilder::from(ApiError::Internal).into()
        }
    }
}

/// `DELETE /tags/{id}` — soft-deletes the tag. It vanishes from tag listings and
/// from every note that carried it (note→tag links are left in place, so an
/// undelete restores them). `404` if it isn't the caller's or was already gone.
pub async fn delete_tag(
    req: Request<hyper::body::Incoming>,
    peer: SocketAddr,
    config: &ApiConfig,
    id: &str,
) -> hyper::Response<Body> {
    let user = match auth::authenticate(&req, peer, config).await {
        Ok(user) => user,
        Err(err) => return ResponseBuilder::from(err).into(),
    };

    let Ok(tag_id) = Uuid::parse_str(id) else {
        return ResponseBuilder::from(ApiError::NotFound(format!("/tags/{id}"))).into();
    };

    let pool = config.db.pool();
    let result = sqlx::query(
        "UPDATE tags SET is_deleted = TRUE WHERE id = $1 AND user_id = $2 AND NOT is_deleted",
    )
    .bind(tag_id)
    .bind(user.id)
    .execute(&pool)
    .await;

    match result {
        Ok(done) if done.rows_affected() > 0 => {
            ResponseBuilder::new(StatusCode::NO_CONTENT).empty().into()
        }
        Ok(_) => ResponseBuilder::from(ApiError::NotFound(format!("/tags/{id}"))).into(),
        Err(err) => {
            tracing::error!(error = %err, "failed to delete tag");
            ResponseBuilder::from(ApiError::Internal).into()
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn clean_tag_name_trims_and_rejects_empty() {
        assert_eq!(clean_tag_name("  work  ").unwrap(), "work");
        assert!(clean_tag_name("   ").is_err());
    }

    #[test]
    fn clean_tag_name_rejects_overlong() {
        let long = "a".repeat(MAX_TAG_LEN + 1);
        assert!(clean_tag_name(&long).is_err());
    }

    #[test]
    fn clean_tag_list_dedupes_preserving_order() {
        let input = ["work".to_string(), "idea".to_string(), "work".to_string()];
        assert_eq!(clean_tag_list(&input).unwrap(), vec!["work", "idea"]);
    }

    #[test]
    fn clean_tag_list_rejects_too_many() {
        let input: Vec<String> = (0..MAX_TAGS_PER_NOTE + 1).map(|i| i.to_string()).collect();
        assert!(clean_tag_list(&input).is_err());
    }
}
