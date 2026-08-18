//! Blog posts. Public readers only ever see published, live posts; all writes
//! (and the drafts-included listing) require the `admin` role via
//! [`admin::require_admin`].
//!
//! Deletion is soft, matching `notes`: `DELETE` sets `is_deleted` and every
//! read filters it out.

use std::net::SocketAddr;

use chrono::{DateTime, NaiveDate, Utc};
use hyper::{Request, StatusCode};
use sonic_rs::{Deserialize, Serialize};
use ts_typegen::Ts;
use uuid::Uuid;

use crate::admin;
use crate::config::ApiConfig;
use crate::response::{self, ApiError, Body, ResponseBuilder};

const MAX_TITLE_LEN: usize = 200;
const MAX_BODY_LEN: usize = 100_000;
const MAX_SLUG_LEN: usize = 100;
const MAX_AUTHOR_LEN: usize = 200;
const MAX_URL_LEN: usize = 500;
const MAX_ISBN_LEN: usize = 20;

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
// Post types.
// ---------------------------------------------------------------------------

/// The kind of a post. `Article` is a plain markdown post; `BookReview` carries
/// an extra [`BookReview`] payload from the `book_reviews` side table. A new
/// type slots in here plus, optionally, its own side table and payload struct.
#[derive(Serialize, Deserialize, Clone, Copy, PartialEq, Eq, Default, Ts)]
#[serde(rename_all = "snake_case")]
pub enum PostType {
    #[default]
    Article,
    BookReview,
}

impl PostType {
    fn as_str(self) -> &'static str {
        match self {
            PostType::Article => "article",
            PostType::BookReview => "book_review",
        }
    }

    /// Maps a stored discriminator, falling back to `Article` for unknown values
    /// so a stray row never breaks a read.
    fn from_db(s: &str) -> Self {
        match s {
            "book_review" => PostType::BookReview,
            _ => PostType::Article,
        }
    }
}

// ---------------------------------------------------------------------------
// Serialized views.
// ---------------------------------------------------------------------------

/// The `SELECT` list for a [`PostRow`]: the generic post columns plus the
/// optional `book_reviews` side row (every `br_*` column is `NULL` for an
/// article, and for a review only when the side row is somehow absent).
const POST_SELECT: &str = "p.id, p.slug, p.title, p.body, p.is_published, \
     p.published_at, p.created_at, p.updated_at, p.post_type, \
     br.book_title AS br_book_title, br.author AS br_author, br.rating AS br_rating, \
     br.cover_url AS br_cover_url, br.isbn AS br_isbn, br.read_date AS br_read_date, \
     br.link AS br_link \
     FROM posts p LEFT JOIN book_reviews br ON br.post_id = p.id";

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
    post_type: String,
    br_book_title: Option<String>,
    br_author: Option<String>,
    br_rating: Option<i16>,
    br_cover_url: Option<String>,
    br_isbn: Option<String>,
    br_read_date: Option<NaiveDate>,
    br_link: Option<String>,
}

/// The base post columns returned by an `INSERT`/`UPDATE ... RETURNING`, before
/// the type-specific payload (which the writer already holds) is attached.
#[derive(sqlx::FromRow)]
struct BaseRow {
    id: Uuid,
    slug: String,
    title: String,
    body: String,
    is_published: bool,
    published_at: Option<DateTime<Utc>>,
    created_at: DateTime<Utc>,
    updated_at: DateTime<Utc>,
}

/// The type-specific fields of a `book_review` post.
#[derive(Serialize, Ts)]
struct BookReview {
    book_title: String,
    author: String,
    rating: Option<i16>,
    cover_url: Option<String>,
    isbn: Option<String>,
    read_date: Option<String>,
    link: Option<String>,
}

impl BookReview {
    fn from_clean(c: CleanBookReview) -> Self {
        Self {
            book_title: c.book_title,
            author: c.author,
            rating: c.rating,
            cover_url: c.cover_url,
            isbn: c.isbn,
            read_date: c.read_date.map(|d| d.to_string()),
            link: c.link,
        }
    }
}

/// The full JSON wire shape of a post (admin views and the public detail page).
#[derive(Serialize, Ts)]
#[ts(rename = "Post")]
struct PostJson {
    id: String,
    slug: String,
    title: String,
    body: String,
    is_published: bool,
    published_at: Option<String>,
    created_at: String,
    updated_at: String,
    post_type: PostType,
    #[serde(skip_serializing_if = "Option::is_none")]
    book_review: Option<BookReview>,
}

impl From<PostRow> for PostJson {
    fn from(row: PostRow) -> Self {
        let post_type = PostType::from_db(&row.post_type);
        let book_review = (post_type == PostType::BookReview).then(|| BookReview {
            book_title: row.br_book_title.unwrap_or_default(),
            author: row.br_author.unwrap_or_default(),
            rating: row.br_rating,
            cover_url: row.br_cover_url,
            isbn: row.br_isbn,
            read_date: row.br_read_date.map(|d| d.to_string()),
            link: row.br_link,
        });
        Self {
            id: row.id.to_string(),
            slug: row.slug,
            title: row.title,
            body: row.body,
            is_published: row.is_published,
            published_at: row.published_at.map(|t| t.to_rfc3339()),
            created_at: row.created_at.to_rfc3339(),
            updated_at: row.updated_at.to_rfc3339(),
            post_type,
            book_review,
        }
    }
}

/// Assembles a [`PostJson`] from a freshly written base row plus the payload the
/// writer already validated, sparing a re-read after a write.
fn post_json(base: BaseRow, post_type: PostType, review: Option<CleanBookReview>) -> PostJson {
    PostJson {
        id: base.id.to_string(),
        slug: base.slug,
        title: base.title,
        body: base.body,
        is_published: base.is_published,
        published_at: base.published_at.map(|t| t.to_rfc3339()),
        created_at: base.created_at.to_rfc3339(),
        updated_at: base.updated_at.to_rfc3339(),
        post_type,
        book_review: review.map(BookReview::from_clean),
    }
}

/// A public list entry: no body, just a raw-markdown excerpt for the card, plus
/// the type and a light book-review summary so cards can style reviews.
#[derive(Serialize, Ts)]
pub struct PostSummary {
    slug: String,
    title: String,
    excerpt: String,
    published_at: Option<String>,
    post_type: PostType,
    #[serde(skip_serializing_if = "Option::is_none")]
    book_review: Option<BookReview>,
}

/// The `book_reviews` columns needed for a list card (cover, author, rating).
#[derive(sqlx::FromRow)]
struct SummaryRow {
    slug: String,
    title: String,
    body: String,
    published_at: Option<DateTime<Utc>>,
    post_type: String,
    br_book_title: Option<String>,
    br_author: Option<String>,
    br_rating: Option<i16>,
    br_cover_url: Option<String>,
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
/// aggregate (`limit` caps the home slice). `only_type`, when set, restricts to
/// one [`PostType`] discriminator — the home page loads articles and reviews
/// separately.
pub async fn published_summaries(
    pool: &sqlx::PgPool,
    limit: i64,
) -> Result<Vec<PostSummary>, sqlx::Error> {
    published_summaries_filtered(pool, None, limit).await
}

/// Like [`published_summaries`] but restricted to a single post type.
pub async fn published_summaries_of_type(
    pool: &sqlx::PgPool,
    post_type: PostType,
    limit: i64,
) -> Result<Vec<PostSummary>, sqlx::Error> {
    published_summaries_filtered(pool, Some(post_type), limit).await
}

async fn published_summaries_filtered(
    pool: &sqlx::PgPool,
    only_type: Option<PostType>,
    limit: i64,
) -> Result<Vec<PostSummary>, sqlx::Error> {
    // `$2 IS NULL OR p.post_type = $2` keeps a single query for both the
    // all-types and single-type cases.
    let rows: Vec<SummaryRow> = sqlx::query_as(
        "SELECT p.slug, p.title, p.body, p.published_at, p.post_type, \
         br.book_title AS br_book_title, br.author AS br_author, \
         br.rating AS br_rating, br.cover_url AS br_cover_url \
         FROM posts p LEFT JOIN book_reviews br ON br.post_id = p.id \
         WHERE p.is_published AND NOT p.is_deleted \
         AND ($2::text IS NULL OR p.post_type = $2) \
         ORDER BY p.published_at DESC LIMIT $1",
    )
    .bind(limit)
    .bind(only_type.map(PostType::as_str))
    .fetch_all(pool)
    .await?;

    Ok(rows
        .into_iter()
        .map(|row| {
            let post_type = PostType::from_db(&row.post_type);
            let book_review = (post_type == PostType::BookReview).then(|| BookReview {
                book_title: row.br_book_title.unwrap_or_default(),
                author: row.br_author.unwrap_or_default(),
                rating: row.br_rating,
                cover_url: row.br_cover_url,
                isbn: None,
                read_date: None,
                link: None,
            });
            PostSummary {
                slug: row.slug,
                title: row.title,
                excerpt: excerpt(&row.body),
                published_at: row.published_at.map(|t| t.to_rfc3339()),
                post_type,
                book_review,
            }
        })
        .collect())
}

/// Published post slugs, newest first. A lighter query than
/// [`published_summaries`] for the sitemap, which needs only the URL path.
pub async fn published_slugs(pool: &sqlx::PgPool) -> Result<Vec<String>, sqlx::Error> {
    let rows: Vec<(String,)> = sqlx::query_as(
        "SELECT slug FROM posts WHERE is_published AND NOT is_deleted \
         ORDER BY published_at DESC",
    )
    .fetch_all(pool)
    .await?;
    Ok(rows.into_iter().map(|(slug,)| slug).collect())
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
    let row: Option<PostRow> = match sqlx::query_as(&format!(
        "SELECT {POST_SELECT} WHERE p.slug = $1 AND p.is_published AND NOT p.is_deleted"
    ))
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
    #[serde(default)]
    post_type: PostType,
    #[serde(default)]
    book_review: Option<BookReviewRequest>,
}

/// The `book_review` payload on a write. Absent fields default to empty/`None`.
#[derive(Deserialize, Default)]
struct BookReviewRequest {
    #[serde(default)]
    book_title: String,
    #[serde(default)]
    author: String,
    #[serde(default)]
    rating: Option<i16>,
    #[serde(default)]
    cover_url: Option<String>,
    #[serde(default)]
    isbn: Option<String>,
    #[serde(default)]
    read_date: Option<String>,
    #[serde(default)]
    link: Option<String>,
}

/// A validated, normalized book-review payload ready to persist.
struct CleanBookReview {
    book_title: String,
    author: String,
    rating: Option<i16>,
    cover_url: Option<String>,
    isbn: Option<String>,
    read_date: Option<NaiveDate>,
    link: Option<String>,
}

/// Trims an optional string, treating blank as absent and enforcing a max
/// length.
fn clean_opt(v: &Option<String>, max: usize, what: &str) -> Result<Option<String>, ApiError> {
    match v.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        Some(s) if s.chars().count() > max => Err(ApiError::BadRequest(format!(
            "{what} must be at most {max} characters"
        ))),
        Some(s) => Ok(Some(s.to_string())),
        None => Ok(None),
    }
}

/// Validates a `book_review` payload: rating in `1..=5`, an `YYYY-MM-DD`
/// read date, and bounded string fields.
fn validate_book_review(req: &BookReviewRequest) -> Result<CleanBookReview, ApiError> {
    let book_title = req.book_title.trim().to_string();
    if book_title.chars().count() > MAX_TITLE_LEN {
        return Err(ApiError::BadRequest(format!(
            "a book title must be at most {MAX_TITLE_LEN} characters"
        )));
    }
    let author = req.author.trim().to_string();
    if author.chars().count() > MAX_AUTHOR_LEN {
        return Err(ApiError::BadRequest(format!(
            "an author must be at most {MAX_AUTHOR_LEN} characters"
        )));
    }
    if let Some(r) = req.rating && !(1..=5).contains(&r) {
        return Err(ApiError::BadRequest("a rating must be between 1 and 5".into()));
    }
    let read_date = match req.read_date.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        Some(s) => Some(NaiveDate::parse_from_str(s, "%Y-%m-%d").map_err(|_| {
            ApiError::BadRequest("a read date must be in YYYY-MM-DD form".into())
        })?),
        None => None,
    };
    Ok(CleanBookReview {
        book_title,
        author,
        rating: req.rating,
        cover_url: clean_opt(&req.cover_url, MAX_URL_LEN, "a cover URL")?,
        isbn: clean_opt(&req.isbn, MAX_ISBN_LEN, "an ISBN")?,
        read_date,
        link: clean_opt(&req.link, MAX_URL_LEN, "a link")?,
    })
}

/// Validates a post payload, returning the trimmed title, clean slug, and — for
/// a `book_review` — its validated payload (required for that type).
fn validate_post(body: &PostRequest) -> Result<(String, String, Option<CleanBookReview>), ApiError> {
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
    let review = match body.post_type {
        PostType::Article => None,
        PostType::BookReview => {
            let req = body.book_review.as_ref().ok_or_else(|| {
                ApiError::BadRequest("a book_review payload is required for a book_review post".into())
            })?;
            Some(validate_book_review(req)?)
        }
    };
    Ok((title, slug, review))
}

const POST_BODY_HINT: &str =
    r#"expected a JSON body like {"slug": "my-post", "title": "…", "body": "…", "is_published": false, "post_type": "article"}"#;

/// Persists a post's `book_review` side row within a write transaction: upserts
/// it for a review, clears any stale row for an article. The base post row is
/// stamped with `stamp` as its `updated_at`.
async fn write_book_review(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    post_id: Uuid,
    review: &Option<CleanBookReview>,
    stamp: DateTime<Utc>,
) -> Result<(), sqlx::Error> {
    match review {
        Some(r) => {
            sqlx::query(
                "INSERT INTO book_reviews \
                 (post_id, book_title, author, rating, cover_url, isbn, read_date, link, created_at, updated_at) \
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $9) \
                 ON CONFLICT (post_id) DO UPDATE SET \
                 book_title = EXCLUDED.book_title, author = EXCLUDED.author, rating = EXCLUDED.rating, \
                 cover_url = EXCLUDED.cover_url, isbn = EXCLUDED.isbn, read_date = EXCLUDED.read_date, \
                 link = EXCLUDED.link, updated_at = EXCLUDED.updated_at",
            )
            .bind(post_id)
            .bind(&r.book_title)
            .bind(&r.author)
            .bind(r.rating)
            .bind(&r.cover_url)
            .bind(&r.isbn)
            .bind(r.read_date)
            .bind(&r.link)
            .bind(stamp)
            .execute(&mut **tx)
            .await?;
        }
        None => {
            sqlx::query("DELETE FROM book_reviews WHERE post_id = $1")
                .bind(post_id)
                .execute(&mut **tx)
                .await?;
        }
    }
    Ok(())
}

/// `GET /admin/posts` — every live post including drafts, newest-updated first.
pub async fn admin_list(
    req: Request<hyper::body::Incoming>,
    peer: SocketAddr,
    config: &ApiConfig,
) -> hyper::Response<Body> {
    if let Err(err) = admin::require_admin(&req, peer, config).await {
        return ResponseBuilder::from(err).into();
    }

    let rows: Vec<PostRow> = match sqlx::query_as(&format!(
        "SELECT {POST_SELECT} WHERE NOT p.is_deleted ORDER BY p.updated_at DESC"
    ))
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
    let (title, slug, review) = match validate_post(&body) {
        Ok(parts) => parts,
        Err(err) => return ResponseBuilder::from(err).into(),
    };

    let id = Uuid::new_v4();
    let now = Utc::now();
    let published_at = body.is_published.then_some(now);

    // The post row and its side row must land together, so both go in one tx.
    let result = async {
        let mut tx = config.db.pool().begin().await?;
        let base: BaseRow = sqlx::query_as(
            "INSERT INTO posts \
             (id, slug, title, body, is_published, published_at, post_type, created_at, updated_at) \
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $8) \
             RETURNING id, slug, title, body, is_published, published_at, created_at, updated_at",
        )
        .bind(id)
        .bind(&slug)
        .bind(&title)
        .bind(&body.body)
        .bind(body.is_published)
        .bind(published_at)
        .bind(body.post_type.as_str())
        .bind(now)
        .fetch_one(&mut *tx)
        .await?;
        write_book_review(&mut tx, id, &review, now).await?;
        tx.commit().await?;
        Ok::<_, sqlx::Error>(base)
    }
    .await;

    match result {
        Ok(base) => {
            let post = post_json(base, body.post_type, review);
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
    let (title, slug, review) = match validate_post(&body) {
        Ok(parts) => parts,
        Err(err) => return ResponseBuilder::from(err).into(),
    };

    let now = Utc::now();
    // Update the post and rewrite its side row atomically. A missed `WHERE`
    // (unknown/deleted id) yields `None` and the tx is dropped without writing.
    let row: Result<Option<BaseRow>, sqlx::Error> = async {
        let mut tx = config.db.pool().begin().await?;
        let base: Option<BaseRow> = sqlx::query_as(
            "UPDATE posts SET slug = $1, title = $2, body = $3, is_published = $4, post_type = $5, \
             published_at = CASE WHEN $4 AND published_at IS NULL THEN $6 ELSE published_at END, \
             updated_at = $6 \
             WHERE id = $7 AND NOT is_deleted \
             RETURNING id, slug, title, body, is_published, published_at, created_at, updated_at",
        )
        .bind(&slug)
        .bind(&title)
        .bind(&body.body)
        .bind(body.is_published)
        .bind(body.post_type.as_str())
        .bind(now)
        .bind(post_id)
        .fetch_optional(&mut *tx)
        .await?;
        if base.is_some() {
            write_book_review(&mut tx, post_id, &review, now).await?;
            tx.commit().await?;
        }
        Ok::<_, sqlx::Error>(base)
    }
    .await;

    match row {
        Ok(Some(base)) => ResponseBuilder::new(StatusCode::OK)
            .json(&post_json(base, body.post_type, review))
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
            post_type: PostType::Article,
            book_review: None,
        };
        assert!(validate_post(&req).is_err());
    }

    #[test]
    fn book_review_type_requires_payload() {
        let req = PostRequest {
            slug: String::new(),
            title: "The Book".into(),
            body: String::new(),
            is_published: false,
            post_type: PostType::BookReview,
            book_review: None,
        };
        assert!(validate_post(&req).is_err());
    }

    #[test]
    fn validate_book_review_bounds_rating_and_date() {
        let ok = BookReviewRequest {
            author: "Ursula K. Le Guin".into(),
            rating: Some(5),
            read_date: Some("2026-01-15".into()),
            ..Default::default()
        };
        let clean = validate_book_review(&ok).unwrap();
        assert_eq!(clean.rating, Some(5));
        assert_eq!(clean.read_date.unwrap().to_string(), "2026-01-15");

        let bad_rating = BookReviewRequest {
            rating: Some(6),
            ..Default::default()
        };
        assert!(validate_book_review(&bad_rating).is_err());

        let bad_date = BookReviewRequest {
            read_date: Some("15/01/2026".into()),
            ..Default::default()
        };
        assert!(validate_book_review(&bad_date).is_err());
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
