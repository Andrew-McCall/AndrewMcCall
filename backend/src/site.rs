//! The public home-page aggregate plus admin management of the profile blurb
//! (`site_settings`) and pinned projects. `GET /home` bundles everything the
//! front page needs — profile, projects, recent commits, recent posts — into
//! one response so the page costs a single round trip.

use std::net::SocketAddr;

use chrono::{DateTime, Utc};
use hyper::{Request, StatusCode};
use sonic_rs::{Deserialize, Serialize};
use uuid::Uuid;

use crate::admin;
use crate::config::ApiConfig;
use crate::posts;
use crate::response::{self, ApiError, Body, ResponseBuilder};

const MAX_NAME_LEN: usize = 100;
const MAX_DESCRIPTION_LEN: usize = 1_000;
const MAX_URL_LEN: usize = 500;
const MAX_INTRO_LEN: usize = 20_000;

/// How many commits / posts the home aggregate carries.
const HOME_COMMITS: i64 = 10;
const HOME_POSTS: i64 = 3;

/// The `site_settings` keys the profile editor may read and write. Internal
/// keys (like the GitHub sync etag) are deliberately not listed.
const PROFILE_KEYS: [&str; 3] = ["intro_markdown", "profile_image_url", "github_url"];

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

#[derive(Serialize)]
struct ProjectJson {
    id: String,
    name: String,
    description: String,
    url: Option<String>,
    repo: Option<String>,
    sort_order: i32,
}

impl From<ProjectRow> for ProjectJson {
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

#[derive(Serialize, Default)]
struct ProfileJson {
    intro_markdown: String,
    profile_image_url: String,
    github_url: String,
}

#[derive(Serialize)]
struct CommitJson {
    sha: String,
    repo: String,
    message: String,
    url: String,
    committed_at: String,
}

#[derive(Serialize)]
struct HomeJson {
    profile: ProfileJson,
    projects: Vec<ProjectJson>,
    commits: Vec<CommitJson>,
    posts: Vec<posts::PostSummary>,
}

// ---------------------------------------------------------------------------
// Shared loaders.
// ---------------------------------------------------------------------------

async fn load_profile(pool: &sqlx::PgPool) -> Result<ProfileJson, sqlx::Error> {
    let rows: Vec<(String, String)> =
        sqlx::query_as("SELECT key, value FROM site_settings WHERE key = ANY($1)")
            .bind(&PROFILE_KEYS[..])
            .fetch_all(pool)
            .await?;

    let mut profile = ProfileJson::default();
    for (key, value) in rows {
        match key.as_str() {
            "intro_markdown" => profile.intro_markdown = value,
            "profile_image_url" => profile.profile_image_url = value,
            "github_url" => profile.github_url = value,
            _ => {}
        }
    }
    Ok(profile)
}

async fn load_projects(pool: &sqlx::PgPool) -> Result<Vec<ProjectJson>, sqlx::Error> {
    let rows: Vec<ProjectRow> = sqlx::query_as(
        "SELECT id, name, description, url, repo, sort_order \
         FROM projects WHERE NOT is_deleted ORDER BY sort_order, created_at",
    )
    .fetch_all(pool)
    .await?;
    Ok(rows.into_iter().map(ProjectJson::from).collect())
}

async fn load_commits(pool: &sqlx::PgPool, limit: i64) -> Result<Vec<CommitJson>, sqlx::Error> {
    let rows: Vec<(String, String, String, String, DateTime<Utc>)> = sqlx::query_as(
        "SELECT sha, repo, message, url, committed_at \
         FROM github_commits ORDER BY committed_at DESC LIMIT $1",
    )
    .bind(limit)
    .fetch_all(pool)
    .await?;
    Ok(rows
        .into_iter()
        .map(|(sha, repo, message, url, committed_at)| CommitJson {
            sha,
            repo,
            message,
            url,
            committed_at: committed_at.to_rfc3339(),
        })
        .collect())
}

// ---------------------------------------------------------------------------
// Public handler.
// ---------------------------------------------------------------------------

/// `GET /home` — everything the front page renders, in one response.
pub async fn home(config: &ApiConfig) -> hyper::Response<Body> {
    let pool = config.db.pool();

    let result = async {
        Ok::<_, sqlx::Error>(HomeJson {
            profile: load_profile(&pool).await?,
            projects: load_projects(&pool).await?,
            commits: load_commits(&pool, HOME_COMMITS).await?,
            posts: posts::published_summaries(&pool, HOME_POSTS).await?,
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

/// `PUT /admin/profile` — upserts the three whitelisted settings keys.
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
        r#"expected a JSON body like {"intro_markdown": "…", "profile_image_url": "…", "github_url": "…"}"#,
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

    let pool = config.db.pool();
    let values = [
        ("intro_markdown", body.intro_markdown.as_str()),
        ("profile_image_url", image_url.as_str()),
        ("github_url", github_url.as_str()),
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

    let profile = ProfileJson {
        intro_markdown: body.intro_markdown,
        profile_image_url: image_url,
        github_url,
    };
    ResponseBuilder::new(StatusCode::OK).json(&profile).into()
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
            .json(&ProjectJson {
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
            .json(&ProjectJson {
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
