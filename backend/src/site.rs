//! The public home-page aggregate plus admin management of the profile blurb
//! (`site_settings`) and pinned projects. `GET /home` bundles everything the
//! front page needs — profile, projects, recent commits, recent posts — into
//! one response so the page costs a single round trip.

use std::net::SocketAddr;

use chrono::{DateTime, Utc};
use hyper::header::{CACHE_CONTROL, HeaderValue};
use hyper::{Request, StatusCode};
use sonic_rs::{Deserialize, Serialize};
use ts_typegen::Ts;
use uuid::Uuid;

use crate::admin;
use crate::config::ApiConfig;
use crate::ip::resolve_client_ip;
use crate::posts;
use crate::response::{self, ApiError, Body, ResponseBuilder};

const MAX_NAME_LEN: usize = 100;
const MAX_DESCRIPTION_LEN: usize = 1_000;
const MAX_URL_LEN: usize = 500;
const MAX_INTRO_LEN: usize = 20_000;
const MAX_DETAIL_VALUE_LEN: usize = 500;

/// Search engines truncate around 60 characters of title and 160 of description.
/// The caps sit a little above that so a slightly long line is still saveable —
/// they're a guard against nonsense, not a style rule.
const MAX_SEO_TITLE_LEN: usize = 70;
const MAX_SEO_DESCRIPTION_LEN: usize = 200;

/// The home-page "Now" details: a fixed whitelist of `(key, label)` display rows,
/// in display order. The value (and an optional link) behind each key is edited
/// via the admin API and stored in `home_details`; the key set itself is fixed
/// here. Adding a detail is a line here plus a seed row in the migration — no
/// schema change. Keys not listed here are ignored on write and never rendered.
const DETAILS: [(&str, &str); 5] = [
    ("currently_reading", "Currently reading"),
    ("currently_building", "Currently building"),
    ("currently_learning", "Currently learning"),
    ("based_in", "Based in"),
    ("email", "Email"),
];

/// How many commits / posts the home aggregate carries.
const HOME_COMMITS: i64 = 10;
const HOME_POSTS: i64 = 4;

/// The `site_settings` keys the profile editor may read and write. Internal
/// keys (like the GitHub sync etag) are deliberately not listed.
const PROFILE_KEYS: [&str; 5] = [
    "intro_markdown",
    "profile_image_url",
    "github_url",
    "seo_title",
    "seo_description",
];

// ---------------------------------------------------------------------------
// Validation helpers.
// ---------------------------------------------------------------------------

/// Trims a URL-ish field; empty becomes `None`. Only http(s) or site-relative
/// (`/…`) values are accepted, so nothing `javascript:`-shaped is ever stored.
fn clean_url(raw: &str) -> Result<Option<String>, ApiError> {
    let url = raw.trim();
    if url.is_empty() {
        return Ok(None);
    }
    if url.len() > MAX_URL_LEN {
        return Err(ApiError::BadRequest(format!(
            "a url must be at most {MAX_URL_LEN} characters"
        )));
    }
    if !(url.starts_with("http://") || url.starts_with("https://") || url.starts_with('/')) {
        return Err(ApiError::BadRequest(
            "a url must start with http://, https:// or /".into(),
        ));
    }
    Ok(Some(url.to_string()))
}

/// Flattens a value destined for a `<meta>` tag to a single trimmed line,
/// squashing runs of whitespace. Empty stays empty.
fn one_line(raw: &str) -> String {
    raw.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// Validates a GitHub `owner/name` repo reference; empty becomes `None`.
/// Forgiving about pasted URLs: strips a github.com prefix (https/ssh) and a
/// trailing `.git` or `/` before validating.
fn clean_repo(raw: &str) -> Result<Option<String>, ApiError> {
    let mut repo = raw.trim();
    for prefix in [
        "https://github.com/",
        "http://github.com/",
        "https://www.github.com/",
        "http://www.github.com/",
        "www.github.com/",
        "github.com/",
        "git@github.com:",
    ] {
        if let Some(rest) = repo.strip_prefix(prefix) {
            repo = rest;
            break;
        }
    }
    repo = repo
        .trim_end_matches('/')
        .trim_end_matches(".git")
        .trim_end_matches('/');
    if repo.is_empty() {
        return Ok(None);
    }
    let valid_part = |s: &str| {
        !s.is_empty()
            && s.chars()
                .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
    };
    match repo.split_once('/') {
        Some((owner, name)) if valid_part(owner) && valid_part(name) => Ok(Some(repo.to_string())),
        _ => Err(ApiError::BadRequest(
            "a repo must look like owner/name".into(),
        )),
    }
}

// ---------------------------------------------------------------------------
// Wire shapes.
// ---------------------------------------------------------------------------

#[derive(sqlx::FromRow)]
struct ProjectRow {
    id: Uuid,
    name: String,
    description: String,
    url: Option<String>,
    repo: Option<String>,
    sort_order: i32,
}

#[derive(Serialize, Ts)]
struct Project {
    id: String,
    name: String,
    description: String,
    url: Option<String>,
    repo: Option<String>,
    sort_order: i32,
}

impl From<ProjectRow> for Project {
    fn from(row: ProjectRow) -> Self {
        Self {
            id: row.id.to_string(),
            name: row.name,
            description: row.description,
            url: row.url,
            repo: row.repo,
            sort_order: row.sort_order,
        }
    }
}

/// `seo_title` / `seo_description` are the home page's search-result copy. Both
/// are allowed to be empty, and empty means "use the build-time default baked
/// into `index.html`" — see `VITE_SITE_TITLE` / `VITE_SITE_DESCRIPTION` in
/// `frontend/.env`. That's why they're plain `String` rather than `Option`: the
/// frontend only ever asks "is this blank?", and a blank string answers it.
#[derive(Serialize, Default, Ts)]
struct Profile {
    intro_markdown: String,
    profile_image_url: String,
    github_url: String,
    seo_title: String,
    seo_description: String,
}

#[derive(Serialize, Ts)]
struct Commit {
    sha: String,
    repo: String,
    message: String,
    url: String,
    committed_at: String,
}

#[derive(Serialize, Ts)]
struct Detail {
    key: String,
    label: String,
    value: String,
    url: Option<String>,
}

#[derive(Serialize, Ts)]
#[ts(rename = "Home")]
struct HomeJson {
    profile: Profile,
    projects: Vec<Project>,
    commits: Vec<Commit>,
    posts: Vec<posts::PostSummary>,
    book_reviews: Vec<posts::PostSummary>,
    details: Vec<Detail>,
}

// ---------------------------------------------------------------------------
// Shared loaders.
// ---------------------------------------------------------------------------

async fn load_profile(pool: &sqlx::PgPool) -> Result<Profile, sqlx::Error> {
    let rows: Vec<(String, String)> =
        sqlx::query_as("SELECT key, value FROM site_settings WHERE key = ANY($1)")
            .bind(&PROFILE_KEYS[..])
            .fetch_all(pool)
            .await?;

    let mut profile = Profile::default();
    for (key, value) in rows {
        match key.as_str() {
            "intro_markdown" => profile.intro_markdown = value,
            "profile_image_url" => profile.profile_image_url = value,
            "github_url" => profile.github_url = value,
            "seo_title" => profile.seo_title = value,
            "seo_description" => profile.seo_description = value,
            _ => {}
        }
    }
    Ok(profile)
}

async fn load_projects(pool: &sqlx::PgPool) -> Result<Vec<Project>, sqlx::Error> {
    let rows: Vec<ProjectRow> = sqlx::query_as(
        "SELECT id, name, description, url, repo, sort_order \
         FROM projects WHERE NOT is_deleted ORDER BY sort_order, created_at",
    )
    .fetch_all(pool)
    .await?;
    Ok(rows.into_iter().map(Project::from).collect())
}

async fn load_commits(pool: &sqlx::PgPool, limit: i64) -> Result<Vec<Commit>, sqlx::Error> {
    let rows: Vec<(String, String, String, String, DateTime<Utc>)> = sqlx::query_as(
        "SELECT sha, repo, message, url, committed_at \
         FROM github_commits ORDER BY committed_at DESC LIMIT $1",
    )
    .bind(limit)
    .fetch_all(pool)
    .await?;
    Ok(rows
        .into_iter()
        .map(|(sha, repo, message, url, committed_at)| Commit {
            sha,
            repo,
            message,
            url,
            committed_at: committed_at.to_rfc3339(),
        })
        .collect())
}

/// The stored `(key, value, url)` rows, unordered and unfiltered.
async fn detail_rows(
    pool: &sqlx::PgPool,
) -> Result<Vec<(String, String, Option<String>)>, sqlx::Error> {
    sqlx::query_as("SELECT key, value, url FROM home_details")
        .fetch_all(pool)
        .await
}

/// Joins stored rows to the `DETAILS` whitelist, in whitelist order. `include_empty`
/// keeps rows whose value is blank — the admin editor wants a field for every
/// key, the public home page only wants the details that are actually set.
fn assemble_details(
    rows: &[(String, String, Option<String>)],
    include_empty: bool,
) -> Vec<Detail> {
    DETAILS
        .iter()
        .filter_map(|(key, label)| {
            let found = rows.iter().find(|(k, _, _)| k == key);
            let value = found.map(|(_, v, _)| v.trim().to_string()).unwrap_or_default();
            if value.is_empty() && !include_empty {
                return None;
            }
            Some(Detail {
                key: (*key).to_string(),
                label: (*label).to_string(),
                value,
                url: found.and_then(|(_, _, u)| u.clone()),
            })
        })
        .collect()
}

/// The always-present dynamic details, computed per request and appended after
/// the curated ones: just the visitor's own IP. These are not stored in
/// `home_details` and are not part of the admin-editable whitelist.
///
/// Server uptime used to live here too. It says how long the box has been up
/// and how recently it was restarted, which is nobody's business but the
/// admin's, so it moved to `GET /admin/status`.
fn dynamic_details(
    req: &Request<hyper::body::Incoming>,
    peer: SocketAddr,
    config: &ApiConfig,
) -> Vec<Detail> {
    // Skip the IP detail rather than failing the page if it can't be resolved
    // (e.g. a missing forwarding header behind a misconfigured proxy).
    let Ok(ip) = resolve_client_ip(config.ip_source, req, peer) else {
        return Vec::new();
    };
    vec![Detail {
        key: "your_ip".into(),
        label: "Your IP".into(),
        value: ip.0,
        url: None,
    }]
}

// ---------------------------------------------------------------------------
// Public handler.
// ---------------------------------------------------------------------------

/// `GET /home` — everything the front page renders, in one response.
pub async fn home(
    req: Request<hyper::body::Incoming>,
    peer: SocketAddr,
    config: &ApiConfig,
) -> hyper::Response<Body> {
    let pool = config.db.pool();

    let result = async {
        let mut details = assemble_details(&detail_rows(&pool).await?, false);
        details.extend(dynamic_details(&req, peer, config));
        Ok::<_, sqlx::Error>(HomeJson {
            profile: load_profile(&pool).await?,
            projects: load_projects(&pool).await?,
            commits: load_commits(&pool, HOME_COMMITS).await?,
            posts: posts::published_summaries_of_type(&pool, posts::PostType::Article, HOME_POSTS)
                .await?,
            book_reviews: posts::published_summaries_of_type(
                &pool,
                posts::PostType::BookReview,
                HOME_POSTS,
            )
            .await?,
            details,
        })
    };

    match result.await {
        Ok(home) => ResponseBuilder::new(StatusCode::OK).json(&home).into(),
        Err(err) => {
            tracing::error!(error = %err, "failed to load home aggregate");
            ResponseBuilder::from(ApiError::Internal).into()
        }
    }
}

/// The canonical origin every sitemap URL is built from.
const SITE_ORIGIN: &str = "https://www.andrewmccall.uk";

/// The fixed public routes that always belong in the sitemap, independent of
/// the database. Blog post detail pages (`/posts/{slug}`) are appended from the
/// `posts` table at request time.
const STATIC_PATHS: [&str; 2] = ["/", "/posts"];

/// `GET /sitemap.xml` — a `urlset` of the fixed public routes plus one entry
/// per published post, generated on request and cached for an hour at the HTTP
/// layer (nginx / browsers / crawlers). Post slugs are lowercase `[a-z0-9-]`
/// by construction, so they need no XML escaping.
pub async fn sitemap(config: &ApiConfig) -> hyper::Response<Body> {
    let slugs = match posts::published_slugs(&config.db.pool()).await {
        Ok(slugs) => slugs,
        Err(err) => {
            tracing::error!(error = %err, "failed to load slugs for sitemap");
            return ResponseBuilder::from(ApiError::Internal).into();
        }
    };

    let mut xml = String::from(
        "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n\
         <urlset xmlns=\"http://www.sitemaps.org/schemas/sitemap/0.9\">\n",
    );
    for path in STATIC_PATHS {
        xml.push_str(&format!("  <url><loc>{SITE_ORIGIN}{path}</loc></url>\n"));
    }
    for slug in &slugs {
        xml.push_str(&format!(
            "  <url><loc>{SITE_ORIGIN}/posts/{slug}</loc></url>\n"
        ));
    }
    xml.push_str("</urlset>\n");

    ResponseBuilder::new(StatusCode::OK)
        .header(CACHE_CONTROL, HeaderValue::from_static("public, max-age=3600"))
        .xml(xml)
        .into()
}

// ---------------------------------------------------------------------------
// Admin: profile settings.
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
struct ProfileRequest {
    #[serde(default)]
    intro_markdown: String,
    #[serde(default)]
    profile_image_url: String,
    #[serde(default)]
    github_url: String,
    #[serde(default)]
    seo_title: String,
    #[serde(default)]
    seo_description: String,
}

/// `GET /admin/profile` — the editable profile settings.
pub async fn get_profile(
    req: Request<hyper::body::Incoming>,
    peer: SocketAddr,
    config: &ApiConfig,
) -> hyper::Response<Body> {
    if let Err(err) = admin::require_admin(&req, peer, config).await {
        return ResponseBuilder::from(err).into();
    }
    match load_profile(&config.db.pool()).await {
        Ok(profile) => ResponseBuilder::new(StatusCode::OK).json(&profile).into(),
        Err(err) => {
            tracing::error!(error = %err, "failed to load profile settings");
            ResponseBuilder::from(ApiError::Internal).into()
        }
    }
}

/// `PUT /admin/profile` — upserts the whitelisted settings keys.
pub async fn update_profile(
    req: Request<hyper::body::Incoming>,
    peer: SocketAddr,
    config: &ApiConfig,
) -> hyper::Response<Body> {
    if let Err(err) = admin::require_admin(&req, peer, config).await {
        return ResponseBuilder::from(err).into();
    }

    let body: ProfileRequest = match response::read_json(
        req,
        r#"expected a JSON body like {"intro_markdown": "…", "profile_image_url": "…", "github_url": "…", "seo_title": "…", "seo_description": "…"}"#,
    )
    .await
    {
        Ok(body) => body,
        Err(err) => return ResponseBuilder::from(err).into(),
    };

    if body.intro_markdown.chars().count() > MAX_INTRO_LEN {
        return ResponseBuilder::from(ApiError::BadRequest(format!(
            "the intro must be at most {MAX_INTRO_LEN} characters"
        )))
        .into();
    }
    let image_url = match clean_url(&body.profile_image_url) {
        Ok(url) => url.unwrap_or_default(),
        Err(err) => return ResponseBuilder::from(err).into(),
    };
    let github_url = match clean_url(&body.github_url) {
        Ok(url) => url.unwrap_or_default(),
        Err(err) => return ResponseBuilder::from(err).into(),
    };

    // Collapsed to one line and trimmed: these go straight into `<meta>`
    // content, where a newline is meaningless but survives a round trip through
    // the editor and shows up in the rendered tag.
    let seo_title = one_line(&body.seo_title);
    let seo_description = one_line(&body.seo_description);
    for (field, value, max) in [
        ("seo title", &seo_title, MAX_SEO_TITLE_LEN),
        ("seo description", &seo_description, MAX_SEO_DESCRIPTION_LEN),
    ] {
        if value.chars().count() > max {
            return ResponseBuilder::from(ApiError::BadRequest(format!(
                "the {field} must be at most {max} characters"
            )))
            .into();
        }
    }

    let pool = config.db.pool();
    let values = [
        ("intro_markdown", body.intro_markdown.as_str()),
        ("profile_image_url", image_url.as_str()),
        ("github_url", github_url.as_str()),
        ("seo_title", seo_title.as_str()),
        ("seo_description", seo_description.as_str()),
    ];
    for (key, value) in values {
        let result = sqlx::query(
            "INSERT INTO site_settings (key, value, updated_at) VALUES ($1, $2, now()) \
             ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()",
        )
        .bind(key)
        .bind(value)
        .execute(&pool)
        .await;
        if let Err(err) = result {
            tracing::error!(error = %err, key, "failed to save profile setting");
            return ResponseBuilder::from(ApiError::Internal).into();
        }
    }

    let profile = Profile {
        intro_markdown: body.intro_markdown,
        profile_image_url: image_url,
        github_url,
        seo_title,
        seo_description,
    };
    ResponseBuilder::new(StatusCode::OK).json(&profile).into()
}

// ---------------------------------------------------------------------------
// Admin: home-page "Now" details.
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
struct DetailRequest {
    #[serde(default)]
    key: String,
    #[serde(default)]
    value: String,
    #[serde(default)]
    url: String,
}

const DETAILS_BODY_HINT: &str =
    r#"expected a JSON array like [{"key": "currently_reading", "value": "…", "url": "https://…"}]"#;

/// `GET /admin/details` — every whitelisted detail with its current value and
/// link, including keys that are still blank so the editor has a field for each.
pub async fn get_details(
    req: Request<hyper::body::Incoming>,
    peer: SocketAddr,
    config: &ApiConfig,
) -> hyper::Response<Body> {
    if let Err(err) = admin::require_admin(&req, peer, config).await {
        return ResponseBuilder::from(err).into();
    }
    match detail_rows(&config.db.pool()).await {
        Ok(rows) => ResponseBuilder::new(StatusCode::OK)
            .json(&assemble_details(&rows, true))
            .into(),
        Err(err) => {
            tracing::error!(error = %err, "failed to load details");
            ResponseBuilder::from(ApiError::Internal).into()
        }
    }
}

/// `PUT /admin/details` — upserts the values/links for whitelisted keys. Keys not
/// in `DETAILS` are silently ignored, so the editor can post the whole set. All
/// input is validated before any write so a bad row can't leave a partial save.
pub async fn update_details(
    req: Request<hyper::body::Incoming>,
    peer: SocketAddr,
    config: &ApiConfig,
) -> hyper::Response<Body> {
    if let Err(err) = admin::require_admin(&req, peer, config).await {
        return ResponseBuilder::from(err).into();
    }

    let body: Vec<DetailRequest> = match response::read_json(req, DETAILS_BODY_HINT).await {
        Ok(body) => body,
        Err(err) => return ResponseBuilder::from(err).into(),
    };

    let mut cleaned: Vec<(&str, String, Option<String>)> = Vec::new();
    for detail in &body {
        let Some(&(key, _)) = DETAILS.iter().find(|(k, _)| *k == detail.key) else {
            continue; // not a whitelisted key
        };
        let value = detail.value.trim().to_string();
        if value.chars().count() > MAX_DETAIL_VALUE_LEN {
            return ResponseBuilder::from(ApiError::BadRequest(format!(
                "a detail value must be at most {MAX_DETAIL_VALUE_LEN} characters"
            )))
            .into();
        }
        let url = match clean_url(&detail.url) {
            Ok(url) => url,
            Err(err) => return ResponseBuilder::from(err).into(),
        };
        cleaned.push((key, value, url));
    }

    let pool = config.db.pool();
    for (key, value, url) in cleaned {
        let result = sqlx::query(
            "INSERT INTO home_details (key, value, url, updated_at) VALUES ($1, $2, $3, now()) \
             ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, url = EXCLUDED.url, updated_at = now()",
        )
        .bind(key)
        .bind(value)
        .bind(url)
        .execute(&pool)
        .await;
        if let Err(err) = result {
            tracing::error!(error = %err, key, "failed to save detail");
            return ResponseBuilder::from(ApiError::Internal).into();
        }
    }

    match detail_rows(&pool).await {
        Ok(rows) => ResponseBuilder::new(StatusCode::OK)
            .json(&assemble_details(&rows, true))
            .into(),
        Err(err) => {
            tracing::error!(error = %err, "failed to reload details");
            ResponseBuilder::from(ApiError::Internal).into()
        }
    }
}

// ---------------------------------------------------------------------------
// Admin: pinned projects.
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
struct ProjectRequest {
    #[serde(default)]
    name: String,
    #[serde(default)]
    description: String,
    #[serde(default)]
    url: String,
    #[serde(default)]
    repo: String,
    #[serde(default)]
    sort_order: i32,
}

struct ValidProject {
    name: String,
    description: String,
    url: Option<String>,
    repo: Option<String>,
    sort_order: i32,
}

fn validate_project(body: &ProjectRequest) -> Result<ValidProject, ApiError> {
    let name = body.name.trim().to_string();
    if name.is_empty() {
        return Err(ApiError::BadRequest("a project name is required".into()));
    }
    if name.chars().count() > MAX_NAME_LEN {
        return Err(ApiError::BadRequest(format!(
            "a project name must be at most {MAX_NAME_LEN} characters"
        )));
    }
    if body.description.chars().count() > MAX_DESCRIPTION_LEN {
        return Err(ApiError::BadRequest(format!(
            "a description must be at most {MAX_DESCRIPTION_LEN} characters"
        )));
    }
    Ok(ValidProject {
        name,
        description: body.description.trim().to_string(),
        url: clean_url(&body.url)?,
        repo: clean_repo(&body.repo)?,
        sort_order: body.sort_order,
    })
}

const PROJECT_BODY_HINT: &str = r#"expected a JSON body like {"name": "…", "description": "…", "url": "https://…", "repo": "owner/name", "sort_order": 0}"#;

/// `GET /admin/projects` — all live projects in display order.
pub async fn list_projects(
    req: Request<hyper::body::Incoming>,
    peer: SocketAddr,
    config: &ApiConfig,
) -> hyper::Response<Body> {
    if let Err(err) = admin::require_admin(&req, peer, config).await {
        return ResponseBuilder::from(err).into();
    }
    match load_projects(&config.db.pool()).await {
        Ok(list) => ResponseBuilder::new(StatusCode::OK).json(&list).into(),
        Err(err) => {
            tracing::error!(error = %err, "failed to list projects");
            ResponseBuilder::from(ApiError::Internal).into()
        }
    }
}

/// `POST /admin/projects` — creates a pinned project.
pub async fn create_project(
    req: Request<hyper::body::Incoming>,
    peer: SocketAddr,
    config: &ApiConfig,
) -> hyper::Response<Body> {
    if let Err(err) = admin::require_admin(&req, peer, config).await {
        return ResponseBuilder::from(err).into();
    }

    let body: ProjectRequest = match response::read_json(req, PROJECT_BODY_HINT).await {
        Ok(body) => body,
        Err(err) => return ResponseBuilder::from(err).into(),
    };
    let project = match validate_project(&body) {
        Ok(project) => project,
        Err(err) => return ResponseBuilder::from(err).into(),
    };

    let id = Uuid::new_v4();
    let result = sqlx::query(
        "INSERT INTO projects (id, name, description, url, repo, sort_order, created_at, updated_at) \
         VALUES ($1, $2, $3, $4, $5, $6, now(), now())",
    )
    .bind(id)
    .bind(&project.name)
    .bind(&project.description)
    .bind(&project.url)
    .bind(&project.repo)
    .bind(project.sort_order)
    .execute(&config.db.pool())
    .await;

    match result {
        Ok(_) => ResponseBuilder::new(StatusCode::CREATED)
            .json(&Project {
                id: id.to_string(),
                name: project.name,
                description: project.description,
                url: project.url,
                repo: project.repo,
                sort_order: project.sort_order,
            })
            .into(),
        Err(err) => {
            tracing::error!(error = %err, "failed to create project");
            ResponseBuilder::from(ApiError::Internal).into()
        }
    }
}

/// `PUT /admin/projects/{id}` — replaces a project's fields.
pub async fn update_project(
    req: Request<hyper::body::Incoming>,
    peer: SocketAddr,
    config: &ApiConfig,
    id: &str,
) -> hyper::Response<Body> {
    if let Err(err) = admin::require_admin(&req, peer, config).await {
        return ResponseBuilder::from(err).into();
    }

    let Ok(project_id) = Uuid::parse_str(id) else {
        return ResponseBuilder::from(ApiError::NotFound(format!("/admin/projects/{id}"))).into();
    };

    let body: ProjectRequest = match response::read_json(req, PROJECT_BODY_HINT).await {
        Ok(body) => body,
        Err(err) => return ResponseBuilder::from(err).into(),
    };
    let project = match validate_project(&body) {
        Ok(project) => project,
        Err(err) => return ResponseBuilder::from(err).into(),
    };

    let result = sqlx::query(
        "UPDATE projects SET name = $1, description = $2, url = $3, repo = $4, \
         sort_order = $5, updated_at = now() \
         WHERE id = $6 AND NOT is_deleted",
    )
    .bind(&project.name)
    .bind(&project.description)
    .bind(&project.url)
    .bind(&project.repo)
    .bind(project.sort_order)
    .bind(project_id)
    .execute(&config.db.pool())
    .await;

    match result {
        Ok(done) if done.rows_affected() > 0 => ResponseBuilder::new(StatusCode::OK)
            .json(&Project {
                id: project_id.to_string(),
                name: project.name,
                description: project.description,
                url: project.url,
                repo: project.repo,
                sort_order: project.sort_order,
            })
            .into(),
        Ok(_) => ResponseBuilder::from(ApiError::NotFound(format!("/admin/projects/{id}"))).into(),
        Err(err) => {
            tracing::error!(error = %err, "failed to update project");
            ResponseBuilder::from(ApiError::Internal).into()
        }
    }
}

/// `DELETE /admin/projects/{id}` — soft-deletes the project.
pub async fn delete_project(
    req: Request<hyper::body::Incoming>,
    peer: SocketAddr,
    config: &ApiConfig,
    id: &str,
) -> hyper::Response<Body> {
    if let Err(err) = admin::require_admin(&req, peer, config).await {
        return ResponseBuilder::from(err).into();
    }

    let Ok(project_id) = Uuid::parse_str(id) else {
        return ResponseBuilder::from(ApiError::NotFound(format!("/admin/projects/{id}"))).into();
    };

    let result = sqlx::query(
        "UPDATE projects SET is_deleted = TRUE, updated_at = now() \
         WHERE id = $1 AND NOT is_deleted",
    )
    .bind(project_id)
    .execute(&config.db.pool())
    .await;

    match result {
        Ok(done) if done.rows_affected() > 0 => {
            ResponseBuilder::new(StatusCode::NO_CONTENT).empty().into()
        }
        Ok(_) => ResponseBuilder::from(ApiError::NotFound(format!("/admin/projects/{id}"))).into(),
        Err(err) => {
            tracing::error!(error = %err, "failed to delete project");
            ResponseBuilder::from(ApiError::Internal).into()
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn clean_url_accepts_http_and_relative() {
        assert_eq!(
            clean_url(" https://example.com ").unwrap().as_deref(),
            Some("https://example.com")
        );
        assert_eq!(clean_url("/profile.jpg").unwrap().as_deref(), Some("/profile.jpg"));
        assert_eq!(clean_url("  ").unwrap(), None);
    }

    #[test]
    fn clean_url_rejects_other_schemes() {
        assert!(clean_url("javascript:alert(1)").is_err());
        assert!(clean_url("ftp://example.com").is_err());
    }

    #[test]
    fn clean_repo_validates_owner_name() {
        assert_eq!(
            clean_repo("Andrew-McCall/AndrewMcCall").unwrap().as_deref(),
            Some("Andrew-McCall/AndrewMcCall")
        );
        assert_eq!(
            clean_repo("https://github.com/Andrew-McCall/AndrewMcCall")
                .unwrap()
                .as_deref(),
            Some("Andrew-McCall/AndrewMcCall")
        );
        assert_eq!(
            clean_repo("git@github.com:Andrew-McCall/AndrewMcCall.git")
                .unwrap()
                .as_deref(),
            Some("Andrew-McCall/AndrewMcCall")
        );
        assert_eq!(
            clean_repo("github.com/Andrew-McCall/AndrewMcCall/")
                .unwrap()
                .as_deref(),
            Some("Andrew-McCall/AndrewMcCall")
        );
        assert_eq!(clean_repo("").unwrap(), None);
        assert!(clean_repo("no-slash").is_err());
        assert!(clean_repo("https://gitlab.com/owner/name").is_err());
        assert!(clean_repo("bad/na me").is_err());
        assert!(clean_repo("/name").is_err());
    }

    fn row(key: &str, value: &str, url: Option<&str>) -> (String, String, Option<String>) {
        (key.into(), value.into(), url.map(Into::into))
    }

    #[test]
    fn assemble_details_public_drops_blank_and_keeps_whitelist_order() {
        let rows = vec![
            row("based_in", "  Manchester  ", None),
            row("currently_reading", "The Pragmatic Programmer", Some("https://ex.com")),
            row("currently_building", "   ", None), // blank -> dropped
            row("unknown_key", "ignored", None),    // not whitelisted -> never seen
        ];
        let details = assemble_details(&rows, false);
        let keys: Vec<_> = details.iter().map(|f| f.key.as_str()).collect();
        // DETAILS order preserved; blank and unknown keys excluded.
        assert_eq!(keys, ["currently_reading", "based_in"]);
        // Value is trimmed.
        assert_eq!(details[1].value, "Manchester");
        assert_eq!(details[0].url.as_deref(), Some("https://ex.com"));
    }

    #[test]
    fn assemble_details_admin_includes_every_whitelisted_key() {
        let rows = vec![row("currently_reading", "A book", None)];
        let details = assemble_details(&rows, true);
        // One row per whitelisted key, even the ones with no stored value.
        let keys: Vec<_> = details.iter().map(|f| f.key.as_str()).collect();
        assert_eq!(keys, DETAILS.map(|(k, _)| k));
        assert_eq!(details[0].value, "A book");
        assert!(details[1].value.is_empty());
    }

    #[test]
    fn validate_project_requires_name() {
        let req = ProjectRequest {
            name: "  ".into(),
            description: String::new(),
            url: String::new(),
            repo: String::new(),
            sort_order: 0,
        };
        assert!(validate_project(&req).is_err());
    }
}
