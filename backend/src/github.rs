//! Background sync of recent GitHub commits into the `github_commits` cache.
//!
//! One conditional request per interval to `GET /users/{u}/events/public`
//! covers pushes across every public repo. The response etag is kept in
//! `site_settings` so an unchanged feed costs a `304` (which doesn't count
//! against GitHub's rate limit). Rows are upserted by sha and pruned to the
//! newest [`KEEP_COMMITS`].

use std::time::Duration;

use chrono::{DateTime, Utc};
use hyper::StatusCode;
use hyper::header::{ACCEPT, AUTHORIZATION, ETAG, IF_NONE_MATCH, USER_AGENT};
use sonic_rs::Deserialize;

use crate::config::SharedConfig;
use crate::http_client;

const GITHUB_HOST: &str = "api.github.com";
const ETAG_KEY: &str = "github_events_etag";
const KEEP_COMMITS: i64 = 100;

// ---------------------------------------------------------------------------
// Events payload parsing.
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
struct Event {
    #[serde(rename = "type", default)]
    kind: String,
    #[serde(default)]
    repo: Option<EventRepo>,
    #[serde(default)]
    payload: Option<EventPayload>,
    #[serde(default)]
    created_at: Option<String>,
}

#[derive(Deserialize)]
struct EventRepo {
    #[serde(default)]
    name: String,
}

#[derive(Deserialize)]
struct EventPayload {
    #[serde(default)]
    commits: Option<Vec<EventCommit>>,
}

#[derive(Deserialize)]
struct EventCommit {
    #[serde(default)]
    sha: String,
    #[serde(default)]
    message: String,
}

pub struct CommitRow {
    pub sha: String,
    pub repo: String,
    pub message: String,
    pub url: String,
    pub committed_at: DateTime<Utc>,
}

/// Extracts commit rows from a GitHub events payload. Only `PushEvent`s carry
/// commits; the push time stands in for each commit's timestamp, which is
/// close enough for a "recent commits" table.
fn parse_events(json: &[u8]) -> Result<Vec<CommitRow>, sonic_rs::Error> {
    let events: Vec<Event> = sonic_rs::from_slice(json)?;

    let mut rows = Vec::new();
    for event in events {
        if event.kind != "PushEvent" {
            continue;
        }
        let Some(repo) = event.repo.as_ref().filter(|r| !r.name.is_empty()) else {
            continue;
        };
        let Some(committed_at) = event
            .created_at
            .as_deref()
            .and_then(|t| DateTime::parse_from_rfc3339(t).ok())
            .map(|t| t.with_timezone(&Utc))
        else {
            continue;
        };
        for commit in event.payload.and_then(|p| p.commits).unwrap_or_default() {
            if commit.sha.is_empty() {
                continue;
            }
            rows.push(CommitRow {
                url: format!("https://github.com/{}/commit/{}", repo.name, commit.sha),
                repo: repo.name.clone(),
                message: commit.message,
                sha: commit.sha,
                committed_at,
            });
        }
    }
    Ok(rows)
}

// ---------------------------------------------------------------------------
// Sync loop.
// ---------------------------------------------------------------------------

/// Spawns the detached sync loop: one fetch at startup, then one per interval.
/// A no-op when `GITHUB_USERNAME` is unset.
pub fn spawn_sync(config: SharedConfig) {
    let Some(username) = config.github_username.clone() else {
        tracing::debug!("GITHUB_USERNAME unset; github sync disabled");
        return;
    };

    let interval = Duration::from_secs(config.github_sync_minutes.max(1) * 60);
    smol::spawn(async move {
        loop {
            if let Err(err) = sync_once(&config, &username).await {
                tracing::warn!(error = %err, "github sync failed");
            }
            smol::Timer::after(interval).await;
        }
    })
    .detach();
}

async fn sync_once(config: &SharedConfig, username: &str) -> Result<(), String> {
    let pool = config.db.pool();

    let etag: Option<String> =
        sqlx::query_scalar("SELECT value FROM site_settings WHERE key = $1")
            .bind(ETAG_KEY)
            .fetch_optional(&pool)
            .await
            .map_err(|err| format!("etag load: {err}"))?;

    let mut headers = vec![
        (USER_AGENT, "andrewmccall.uk-backend".to_string()),
        (ACCEPT, "application/vnd.github+json".to_string()),
    ];
    if let Some(etag) = etag.filter(|e| !e.is_empty()) {
        headers.push((IF_NONE_MATCH, etag));
    }
    if let Some(token) = config.github_token.as_deref() {
        headers.push((AUTHORIZATION, format!("Bearer {token}")));
    }

    let path = format!("/users/{username}/events/public?per_page=100");
    let (status, response_headers, body) = http_client::https_get(GITHUB_HOST, &path, &headers)
        .await
        .map_err(|err| format!("fetch: {err}"))?;

    match status {
        StatusCode::NOT_MODIFIED => return Ok(()),
        StatusCode::OK => {}
        other => return Err(format!("github responded {other}")),
    }

    let rows = parse_events(&body).map_err(|err| format!("parse: {err}"))?;
    let fetched = rows.len();

    for row in rows {
        sqlx::query(
            "INSERT INTO github_commits (sha, repo, message, url, committed_at) \
             VALUES ($1, $2, $3, $4, $5) ON CONFLICT (sha) DO NOTHING",
        )
        .bind(&row.sha)
        .bind(&row.repo)
        .bind(&row.message)
        .bind(&row.url)
        .bind(row.committed_at)
        .execute(&pool)
        .await
        .map_err(|err| format!("upsert: {err}"))?;
    }

    sqlx::query(
        "DELETE FROM github_commits WHERE sha NOT IN \
         (SELECT sha FROM github_commits ORDER BY committed_at DESC LIMIT $1)",
    )
    .bind(KEEP_COMMITS)
    .execute(&pool)
    .await
    .map_err(|err| format!("prune: {err}"))?;

    if let Some(etag) = response_headers.get(ETAG).and_then(|v| v.to_str().ok()) {
        sqlx::query(
            "INSERT INTO site_settings (key, value, updated_at) VALUES ($1, $2, now()) \
             ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()",
        )
        .bind(ETAG_KEY)
        .bind(etag)
        .execute(&pool)
        .await
        .map_err(|err| format!("etag save: {err}"))?;
    }

    tracing::info!(commits = fetched, "github sync complete");
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    const EVENTS: &str = r#"[
        {
            "type": "PushEvent",
            "repo": {"name": "Andrew-McCall/AndrewMcCall"},
            "created_at": "2026-07-16T12:00:00Z",
            "payload": {"commits": [
                {"sha": "abc123", "message": "first"},
                {"sha": "def456", "message": "second"}
            ]}
        },
        {"type": "WatchEvent", "repo": {"name": "x/y"}, "created_at": "2026-07-16T12:00:00Z"},
        {"type": "PushEvent", "created_at": "2026-07-16T12:00:00Z"},
        {"type": "PushEvent", "repo": {"name": "a/b"}, "payload": {"commits": [{"sha": "", "message": "no sha"}]}, "created_at": "2026-07-16T12:00:00Z"}
    ]"#;

    #[test]
    fn parse_events_extracts_push_commits_only() {
        let rows = parse_events(EVENTS.as_bytes()).unwrap();
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0].sha, "abc123");
        assert_eq!(rows[0].repo, "Andrew-McCall/AndrewMcCall");
        assert_eq!(
            rows[0].url,
            "https://github.com/Andrew-McCall/AndrewMcCall/commit/abc123"
        );
        assert_eq!(rows[1].message, "second");
    }

    #[test]
    fn parse_events_tolerates_missing_fields() {
        assert!(parse_events(b"[]").unwrap().is_empty());
        assert!(parse_events(b"[{}]").unwrap().is_empty());
        assert!(parse_events(b"not json").is_err());
    }
}
