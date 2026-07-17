//! Blog posts. Public readers only ever see published, live posts; all writes
//! (and the drafts-included listing) require the `admin` role via
//! [`admin::require_admin`].
//!
//! Deletion is soft, matching `notes`: `DELETE` sets `is_deleted` and every
//! read filters it out.

use std::net::SocketAddr;

use chrono::{DateTime, Utc};
use hyper::{Request, StatusCode};
use sonic_rs::{Deserialize, Serialize};
use uuid::Uuid;

use crate::admin;
use crate::config::ApiConfig;
use crate::response::{self, ApiError, Body, ResponseBuilder};

const MAX_TITLE_LEN: usize = 200;
const MAX_BODY_LEN: usize = 100_000;
const MAX_SLUG_LEN: usize = 100;

/// How much raw markdown a list excerpt carries.
const EXCERPT_LEN: usize = 280;

// ---------------------------------------------------------------------------
// Slug handling.
// ---------------------------------------------------------------------------

/// Derives a slug from free text: lowercase, `[a-z0-9]` runs joined by single
/// hyphens, truncated to `MAX_SLUG_LEN`. May return an empty string (the
/// caller decides whether that's an error).
fn slugify(raw: &str) -> String {
    let mut out = String::with_capacity(raw.len());
    let mut pending_hyphen = false;
    for c in raw.chars() {
        if c.is_ascii_alphanumeric() {
            if pending_hyphen && !out.is_empty() {
                out.push('-');
            }
            pending_hyphen = false;
            out.push(c.to_ascii_lowercase());
        } else {
            pending_hyphen = true;
        }
        if out.len() >= MAX_SLUG_LEN {
            break;
        }
    }
    out.truncate(MAX_SLUG_LEN);
    out
}

/// Validates a client-supplied slug (or derives one from the title when empty).
/// The router lowercases pathnames, so slugs are lowercase-only by construction.
fn clean_slug(raw: &str, title: &str) -> Result<String, ApiError> {
    let source = if raw.trim().is_empty() { title } else { raw };
    let slug = slugify(source);
    if slug.is_empty() {
        return Err(ApiError::BadRequest(
            "a slug (or a title to derive one from) is required".into(),
        ));
    }
    Ok(slug)
}

// ---------------------------------------------------------------------------
// Serialized views.
// ---------------------------------------------------------------------------

#[derive(sqlx::FromRow)]
struct PostRow {
    id: Uuid,
    slug: String,
    title: String,
    body: String,
    is_published: bool,
    published_at: Option<DateTime<Utc>>,
    created_at: DateTime<Utc>,
    updated_at: DateTime<Utc>,
}

/// The full JSON wire shape of a post (admin views and the public detail page).
#[derive(Serialize)]
struct PostJson {
    id: String,
    slug: String,
    title: String,
    body: String,
    is_published: bool,
    published_at: Option<String>,
    created_at: String,
    updated_at: String,
}

impl From<PostRow> for PostJson {
    fn from(row: PostRow) -> Self {
        Self {
            id: row.id.to_string(),
            slug: row.slug,
            title: row.title,
            body: row.body,
            is_published: row.is_published,
            published_at: row.published_at.map(|t| t.to_rfc3339()),
            created_at: row.created_at.to_rfc3339(),
            updated_at: row.updated_at.to_rfc3339(),
        }
    }
}

/// A public list entry: no body, just a raw-markdown excerpt for the card.
#[derive(Serialize)]
pub struct PostSummary {
    slug: String,
    title: String,
    excerpt: String,
    published_at: Option<String>,
}

/// Truncates raw markdown to at most `EXCERPT_LEN` characters on a char
/// boundary, appending an ellipsis when cut.
fn excerpt(body: &str) -> String {
    if body.chars().count() <= EXCERPT_LEN {
        return body.to_string();
    }
    let cut: String = body.chars().take(EXCERPT_LEN).collect();
    format!("{cut}…")
}

// ---------------------------------------------------------------------------
// Public handlers.
// ---------------------------------------------------------------------------

/// Loads published post summaries, newest first. Shared with the `/home`
/// aggregate (`limit` caps the home slice).
pub async fn published_summaries(
    pool: &sqlx::PgPool,
    limit: i64,
) -> Result<Vec<PostSummary>, sqlx::Error> {
    let rows: Vec<(String, String, String, Option<DateTime<Utc>>)> = sqlx::query_as(
        "SELECT slug, title, body, published_at \
         FROM posts WHERE is_published AND NOT is_deleted \
         ORDER BY published_at DESC LIMIT $1",
    )
    .bind(limit)
    .fetch_all(pool)
    .await?;

    Ok(rows
        .into_iter()
        .map(|(slug, title, body, published_at)| PostSummary {
            slug,
            title,
            excerpt: excerpt(&body),
            published_at: published_at.map(|t| t.to_rfc3339()),
        })
        .collect())
}

/// `GET /posts` — all published posts, newest first, as summaries.
pub async fn list_published(config: &ApiConfig) -> hyper::Response<Body> {
    match published_summaries(&config.db.pool(), 1000).await {
        Ok(list) => ResponseBuilder::new(StatusCode::OK).json(&list).into(),
        Err(err) => {
            tracing::error!(error = %err, "failed to list posts");
            ResponseBuilder::from(ApiError::Internal).into()
        }
    }
}

/// `GET /posts/{slug}` — one published post, in full. `404` for drafts,
/// deleted posts, and unknown slugs alike.
pub async fn get_by_slug(config: &ApiConfig, slug: &str) -> hyper::Response<Body> {
    let row: Option<PostRow> = match sqlx::query_as(
        "SELECT id, slug, title, body, is_published, published_at, created_at, updated_at \
         FROM posts WHERE slug = $1 AND is_published AND NOT is_deleted",
    )
    .bind(slug)
    .fetch_optional(&config.db.pool())
    .await
    {
        Ok(row) => row,
        Err(err) => {
            tracing::error!(error = %err, "failed to load post");
            return ResponseBuilder::from(ApiError::Internal).into();
        }
    };

    match row {
        Some(row) => ResponseBuilder::new(StatusCode::OK)
            .json(&PostJson::from(row))
            .into(),
        None => ResponseBuilder::from(ApiError::NotFound(format!("/posts/{slug}"))).into(),
    }
}

// ---------------------------------------------------------------------------
// Admin handlers.
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
struct PostRequest {
    #[serde(default)]
    slug: String,
    #[serde(default)]
    title: String,
    #[serde(default)]
    body: String,
    #[serde(default)]
    is_published: bool,
}

/// Validates a post payload, returning the trimmed title and clean slug.
fn validate_post(body: &PostRequest) -> Result<(String, String), ApiError> {
    let title = body.title.trim().to_string();
    if title.chars().count() > MAX_TITLE_LEN {
        return Err(ApiError::BadRequest(format!(
            "a title must be at most {MAX_TITLE_LEN} characters"
        )));
    }
    if body.body.chars().count() > MAX_BODY_LEN {
        return Err(ApiError::BadRequest(format!(
            "a post body must be at most {MAX_BODY_LEN} characters"
        )));
    }
    let slug = clean_slug(&body.slug, &title)?;
    Ok((title, slug))
}

const POST_BODY_HINT: &str =
    r#"expected a JSON body like {"slug": "my-post", "title": "…", "body": "…", "is_published": false}"#;

/// `GET /admin/posts` — every live post including drafts, newest-updated first.
pub async fn admin_list(
    req: Request<hyper::body::Incoming>,
    peer: SocketAddr,
    config: &ApiConfig,
) -> hyper::Response<Body> {
    if let Err(err) = admin::require_admin(&req, peer, config).await {
        return ResponseBuilder::from(err).into();
    }

    let rows: Vec<PostRow> = match sqlx::query_as(
        "SELECT id, slug, title, body, is_published, published_at, created_at, updated_at \
         FROM posts WHERE NOT is_deleted ORDER BY updated_at DESC",
    )
    .fetch_all(&config.db.pool())
    .await
    {
        Ok(rows) => rows,
        Err(err) => {
            tracing::error!(error = %err, "failed to list posts for admin");
            return ResponseBuilder::from(ApiError::Internal).into();
        }
    };

    let list: Vec<PostJson> = rows.into_iter().map(PostJson::from).collect();
    ResponseBuilder::new(StatusCode::OK).json(&list).into()
}

/// `POST /admin/posts` — creates a post. Publishing at creation stamps
/// `published_at` now. A duplicate live slug is a `400`.
pub async fn create(
    req: Request<hyper::body::Incoming>,
    peer: SocketAddr,
    config: &ApiConfig,
) -> hyper::Response<Body> {
    if let Err(err) = admin::require_admin(&req, peer, config).await {
        return ResponseBuilder::from(err).into();
    }

    let body: PostRequest = match response::read_json(req, POST_BODY_HINT).await {
        Ok(body) => body,
        Err(err) => return ResponseBuilder::from(err).into(),
    };
    let (title, slug) = match validate_post(&body) {
        Ok(parts) => parts,
        Err(err) => return ResponseBuilder::from(err).into(),
    };

    let id = Uuid::new_v4();
    let now = Utc::now();
    let published_at = body.is_published.then_some(now);

    let result = sqlx::query(
        "INSERT INTO posts (id, slug, title, body, is_published, published_at, created_at, updated_at) \
         VALUES ($1, $2, $3, $4, $5, $6, $7, $7)",
    )
    .bind(id)
    .bind(&slug)
    .bind(&title)
    .bind(&body.body)
    .bind(body.is_published)
    .bind(published_at)
    .bind(now)
    .execute(&config.db.pool())
    .await;

    match result {
        Ok(_) => {
            let post = PostJson {
                id: id.to_string(),
                slug,
                title,
                body: body.body,
                is_published: body.is_published,
                published_at: published_at.map(|t| t.to_rfc3339()),
                created_at: now.to_rfc3339(),
                updated_at: now.to_rfc3339(),
            };
            ResponseBuilder::new(StatusCode::CREATED).json(&post).into()
        }
        // 23505 is unique_violation against the live-slug index.
        Err(sqlx::Error::Database(db)) if db.code().as_deref() == Some("23505") => {
            ResponseBuilder::from(ApiError::BadRequest(format!(
                "a post with slug {slug:?} already exists"
            )))
            .into()
        }
        Err(err) => {
            tracing::error!(error = %err, "failed to create post");
            ResponseBuilder::from(ApiError::Internal).into()
        }
    }
}

/// `PUT /admin/posts/{id}` — replaces slug/title/body/published state.
/// `published_at` is stamped on first publish and never moves afterwards.
pub async fn update(
    req: Request<hyper::body::Incoming>,
    peer: SocketAddr,
    config: &ApiConfig,
    id: &str,
) -> hyper::Response<Body> {
    if let Err(err) = admin::require_admin(&req, peer, config).await {
        return ResponseBuilder::from(err).into();
    }

    let Ok(post_id) = Uuid::parse_str(id) else {
        return ResponseBuilder::from(ApiError::NotFound(format!("/admin/posts/{id}"))).into();
    };

    let body: PostRequest = match response::read_json(req, POST_BODY_HINT).await {
        Ok(body) => body,
        Err(err) => return ResponseBuilder::from(err).into(),
    };
    let (title, slug) = match validate_post(&body) {
        Ok(parts) => parts,
        Err(err) => return ResponseBuilder::from(err).into(),
    };

    let now = Utc::now();
    let row: Result<Option<PostRow>, sqlx::Error> = sqlx::query_as(
        "UPDATE posts SET slug = $1, title = $2, body = $3, is_published = $4, \
         published_at = CASE WHEN $4 AND published_at IS NULL THEN $5 ELSE published_at END, \
         updated_at = $5 \
         WHERE id = $6 AND NOT is_deleted \
         RETURNING id, slug, title, body, is_published, published_at, created_at, updated_at",
    )
    .bind(&slug)
    .bind(&title)
    .bind(&body.body)
    .bind(body.is_published)
    .bind(now)
    .bind(post_id)
    .fetch_optional(&config.db.pool())
    .await;

    match row {
        Ok(Some(row)) => ResponseBuilder::new(StatusCode::OK)
            .json(&PostJson::from(row))
            .into(),
        Ok(None) => ResponseBuilder::from(ApiError::NotFound(format!("/admin/posts/{id}"))).into(),
        Err(sqlx::Error::Database(db)) if db.code().as_deref() == Some("23505") => {
            ResponseBuilder::from(ApiError::BadRequest(format!(
                "a post with slug {slug:?} already exists"
            )))
            .into()
        }
        Err(err) => {
            tracing::error!(error = %err, "failed to update post");
            ResponseBuilder::from(ApiError::Internal).into()
        }
    }
}

/// `DELETE /admin/posts/{id}` — soft-deletes the post.
pub async fn delete(
    req: Request<hyper::body::Incoming>,
    peer: SocketAddr,
    config: &ApiConfig,
    id: &str,
) -> hyper::Response<Body> {
    if let Err(err) = admin::require_admin(&req, peer, config).await {
        return ResponseBuilder::from(err).into();
    }

    let Ok(post_id) = Uuid::parse_str(id) else {
        return ResponseBuilder::from(ApiError::NotFound(format!("/admin/posts/{id}"))).into();
    };

    let result = sqlx::query(
        "UPDATE posts SET is_deleted = TRUE, updated_at = now() \
         WHERE id = $1 AND NOT is_deleted",
    )
    .bind(post_id)
    .execute(&config.db.pool())
    .await;

    match result {
        Ok(done) if done.rows_affected() > 0 => {
            ResponseBuilder::new(StatusCode::NO_CONTENT).empty().into()
        }
        Ok(_) => ResponseBuilder::from(ApiError::NotFound(format!("/admin/posts/{id}"))).into(),
        Err(err) => {
            tracing::error!(error = %err, "failed to delete post");
            ResponseBuilder::from(ApiError::Internal).into()
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn slugify_lowercases_and_hyphenates() {
        assert_eq!(slugify("Hello, World!"), "hello-world");
        assert_eq!(slugify("  Rust & WASM 2026  "), "rust-wasm-2026");
    }

    #[test]
    fn slugify_collapses_separator_runs() {
        assert_eq!(slugify("a --- b"), "a-b");
        assert_eq!(slugify("---"), "");
    }

    #[test]
    fn clean_slug_falls_back_to_title() {
        assert_eq!(clean_slug("", "My First Post").unwrap(), "my-first-post");
        assert_eq!(clean_slug("Custom Slug", "ignored").unwrap(), "custom-slug");
        assert!(clean_slug("", "").is_err());
    }

    #[test]
    fn clean_slug_caps_length() {
        let long = "a".repeat(MAX_SLUG_LEN * 2);
        assert_eq!(clean_slug(&long, "").unwrap().len(), MAX_SLUG_LEN);
    }

    #[test]
    fn validate_post_rejects_overlong() {
        let req = PostRequest {
            slug: String::new(),
            title: "t".repeat(MAX_TITLE_LEN + 1),
            body: String::new(),
            is_published: false,
        };
        assert!(validate_post(&req).is_err());
    }

    #[test]
    fn excerpt_truncates_on_char_boundary() {
        let short = "hello";
        assert_eq!(excerpt(short), "hello");
        let long = "é".repeat(EXCERPT_LEN + 10);
        let cut = excerpt(&long);
        assert_eq!(cut.chars().count(), EXCERPT_LEN + 1);
        assert!(cut.ends_with('…'));
    }
}
