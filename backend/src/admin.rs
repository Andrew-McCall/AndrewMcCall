//! Admin-only user management. Every handler here first calls [`require_admin`],
//! so only a user with the `admin` role can list, create, or delete users —
//! creating users has no other entry point in the API.

use std::net::SocketAddr;

use chrono::{DateTime, Utc};
use hyper::{Request, StatusCode};
use sonic_rs::{Deserialize, Serialize};
use uuid::Uuid;

use crate::auth::{self, AuthUser};
use crate::config::ApiConfig;
use crate::database::models::UserRole;
use crate::response::{self, ApiError, Body, ResponseBuilder};

/// Authenticates the request and requires the `admin` role. A valid non-admin
/// token is [`ApiError::Forbidden`]; a missing/invalid token is
/// [`ApiError::Unauthorized`] (propagated from [`auth::authenticate`]).
async fn require_admin(
    req: &Request<hyper::body::Incoming>,
    peer: SocketAddr,
    config: &ApiConfig,
) -> Result<AuthUser, ApiError> {
    let user = auth::authenticate(req, peer, config).await?;
    if user.is_admin() {
        Ok(user)
    } else {
        Err(ApiError::Forbidden)
    }
}

/// One row of the admin user listing, read from the database.
#[derive(sqlx::FromRow)]
struct AdminUser {
    id: Uuid,
    name: String,
    role: UserRole,
    totp_enabled: bool,
    created_at: DateTime<Utc>,
    /// Newest `auth_log` timestamp for this user, or null if never seen.
    last_login: Option<DateTime<Utc>>,
}

/// The JSON wire shape of an admin user listing row. `UserRole` has no serde
/// impl (it's only a `sqlx::Type`), so we map to explicit string fields here.
#[derive(Serialize)]
struct AdminUserJson {
    id: String,
    name: String,
    role: &'static str,
    totp_enabled: bool,
    created_at: String,
    last_login: Option<String>,
}

impl From<AdminUser> for AdminUserJson {
    fn from(u: AdminUser) -> Self {
        Self {
            id: u.id.to_string(),
            name: u.name,
            role: u.role.as_str(),
            totp_enabled: u.totp_enabled,
            created_at: u.created_at.to_rfc3339(),
            last_login: u.last_login.map(|t| t.to_rfc3339()),
        }
    }
}

/// `GET /admin/users` — every user with role, 2FA state, and last-login time.
pub async fn list_users(
    req: Request<hyper::body::Incoming>,
    peer: SocketAddr,
    config: &ApiConfig,
) -> hyper::Response<Body> {
    if let Err(err) = require_admin(&req, peer, config).await {
        return ResponseBuilder::from(err).into();
    }

    let pool = config.db.pool();
    let rows: Vec<AdminUser> = match sqlx::query_as(
        "SELECT u.id, u.name, u.role, (u.totp_secret IS NOT NULL) AS totp_enabled, \
                u.created_at, MAX(l.created_at) AS last_login \
         FROM users u LEFT JOIN auth_log l ON l.user_id = u.id \
         GROUP BY u.id \
         ORDER BY u.created_at",
    )
    .fetch_all(&pool)
    .await
    {
        Ok(rows) => rows,
        Err(err) => {
            tracing::error!(error = %err, "failed to list users");
            return ResponseBuilder::from(ApiError::Internal).into();
        }
    };

    let list: Vec<AdminUserJson> = rows.into_iter().map(AdminUserJson::from).collect();
    ResponseBuilder::new(StatusCode::OK).json(&list).into()
}

#[derive(Deserialize)]
struct CreateUserRequest {
    name: String,
    pin: String,
    role: Option<String>,
}

#[derive(Serialize)]
struct CreatedUser {
    id: String,
    name: String,
    role: &'static str,
}

/// `POST /admin/users` — body `{name, pin, role?}`. Hashes the PIN and inserts a
/// new user. This is the only path that creates users. A duplicate name is a
/// `400`.
pub async fn create_user(
    req: Request<hyper::body::Incoming>,
    peer: SocketAddr,
    config: &ApiConfig,
) -> hyper::Response<Body> {
    if let Err(err) = require_admin(&req, peer, config).await {
        return ResponseBuilder::from(err).into();
    }

    let body: CreateUserRequest = match response::read_json(
        req,
        r#"expected a JSON body like {"name": "alice", "pin": "1234", "role": "standard"}"#,
    )
    .await
    {
        Ok(body) => body,
        Err(err) => return ResponseBuilder::from(err).into(),
    };

    let name = body.name.trim();
    if name.is_empty() {
        return ResponseBuilder::from(ApiError::BadRequest("name must not be empty".into())).into();
    }
    if body.pin.is_empty() {
        return ResponseBuilder::from(ApiError::BadRequest("pin must not be empty".into())).into();
    }
    let role = match body.role.as_deref() {
        None => UserRole::Standard,
        Some(label) => match UserRole::parse(label) {
            Some(role) => role,
            None => {
                return ResponseBuilder::from(ApiError::BadRequest(format!(
                    "unknown role {label:?} (expected \"standard\" or \"admin\")"
                )))
                .into();
            }
        },
    };

    let pin_hash = match auth::hash_pin(&body.pin) {
        Ok(hash) => hash,
        Err(err) => return ResponseBuilder::from(err).into(),
    };

    let id = Uuid::new_v4();
    let pool = config.db.pool();
    let result = sqlx::query(
        "INSERT INTO users (id, name, pin, role, created_at) VALUES ($1, $2, $3, $4, now())",
    )
    .bind(id)
    .bind(name)
    .bind(&pin_hash)
    .bind(role)
    .execute(&pool)
    .await;

    match result {
        Ok(_) => ResponseBuilder::new(StatusCode::CREATED)
            .json(&CreatedUser {
                id: id.to_string(),
                name: name.to_string(),
                role: role.as_str(),
            })
            .into(),
        // 23505 is unique_violation — the name is already taken.
        Err(sqlx::Error::Database(db)) if db.code().as_deref() == Some("23505") => {
            ResponseBuilder::from(ApiError::BadRequest(format!(
                "a user named {name:?} already exists"
            )))
            .into()
        }
        Err(err) => {
            tracing::error!(error = %err, "failed to create user");
            ResponseBuilder::from(ApiError::Internal).into()
        }
    }
}

/// One detailed visit row for the admin listing, joined to its user agent.
#[derive(sqlx::FromRow)]
struct VisitRow {
    id: Uuid,
    created_at: DateTime<Utc>,
    /// Visit kind as text (`static`, `js`, or `secret`).
    kind: String,
    /// The page path, or null for the js/secret pings and pre-tracking visits.
    route: Option<String>,
    client_ip: String,
    user_agent: String,
}

/// The JSON wire shape of a detailed visit row.
#[derive(Serialize)]
struct VisitJson {
    id: String,
    created_at: String,
    kind: String,
    route: Option<String>,
    client_ip: String,
    user_agent: String,
}

impl From<VisitRow> for VisitJson {
    fn from(v: VisitRow) -> Self {
        Self {
            id: v.id.to_string(),
            created_at: v.created_at.to_rfc3339(),
            kind: v.kind,
            route: v.route,
            client_ip: v.client_ip,
            user_agent: v.user_agent,
        }
    }
}

/// A page of detailed visits plus the total matching the current filters, so the
/// client can drive prev/next controls.
#[derive(Serialize)]
struct VisitsPage {
    total: i64,
    limit: i64,
    offset: i64,
    visits: Vec<VisitJson>,
}

/// Largest page the admin visits endpoint will return in one request.
const MAX_VISITS_LIMIT: i64 = 500;
/// Default page size when the caller doesn't ask for one.
const DEFAULT_VISITS_LIMIT: i64 = 100;

/// `GET /admin/visits` — admin-only, detailed per-visit rows with client IPs and
/// user agents (the IP-level view the public `/stats` endpoint deliberately
/// withholds). Newest first, paginated with `limit`/`offset`, and optionally
/// filtered by `kind` (`static`/`js`/`secret`) and exact `route`. Returns
/// `{total, limit, offset, visits}`.
pub async fn list_visits(
    req: Request<hyper::body::Incoming>,
    peer: SocketAddr,
    config: &ApiConfig,
) -> hyper::Response<Body> {
    if let Err(err) = require_admin(&req, peer, config).await {
        return ResponseBuilder::from(err).into();
    }

    let query = req.uri().query();
    let limit = parse_i64(query, "limit")
        .unwrap_or(DEFAULT_VISITS_LIMIT)
        .clamp(1, MAX_VISITS_LIMIT);
    let offset = parse_i64(query, "offset").unwrap_or(0).max(0);
    // Only the known enum labels reach the query; anything else is ignored (no
    // filter) rather than erroring.
    let kind = query_param(query, "kind")
        .filter(|k| matches!(k.as_str(), "static" | "js" | "secret"));
    let route = query_param(query, "route").filter(|r| is_valid_route(r));

    let pool = config.db.pool();

    // Both queries share the same optional filters, bound the same way: a null
    // bind disables that filter (`$n IS NULL OR col = $n`), so there's no dynamic
    // SQL and the bind positions are fixed.
    let total: i64 = match sqlx::query_scalar(
        "SELECT COUNT(*) FROM visits v \
         WHERE ($1::text IS NULL OR v.kind::text = $1) \
           AND ($2::text IS NULL OR v.route = $2)",
    )
    .bind(&kind)
    .bind(&route)
    .fetch_one(&pool)
    .await
    {
        Ok(total) => total,
        Err(err) => {
            tracing::error!(error = %err, "failed to count visits");
            return ResponseBuilder::from(ApiError::Internal).into();
        }
    };

    let rows: Vec<VisitRow> = match sqlx::query_as(
        "SELECT v.id, v.created_at, v.kind::text AS kind, v.route, v.client_ip, a.user_agent \
         FROM visits v JOIN user_agents a ON a.id = v.user_agent_id \
         WHERE ($1::text IS NULL OR v.kind::text = $1) \
           AND ($2::text IS NULL OR v.route = $2) \
         ORDER BY v.created_at DESC \
         LIMIT $3 OFFSET $4",
    )
    .bind(&kind)
    .bind(&route)
    .bind(limit)
    .bind(offset)
    .fetch_all(&pool)
    .await
    {
        Ok(rows) => rows,
        Err(err) => {
            tracing::error!(error = %err, "failed to list visits");
            return ResponseBuilder::from(ApiError::Internal).into();
        }
    };

    let page = VisitsPage {
        total,
        limit,
        offset,
        visits: rows.into_iter().map(VisitJson::from).collect(),
    };
    ResponseBuilder::new(StatusCode::OK).json(&page).into()
}

/// `DELETE /admin/users/{id}` — removes a user (cascading to their tokens and
/// recovery codes). Admins may not delete themselves, so an admin can't lock the
/// system out of its last account by accident.
pub async fn delete_user(
    req: Request<hyper::body::Incoming>,
    peer: SocketAddr,
    config: &ApiConfig,
    id: &str,
) -> hyper::Response<Body> {
    let admin = match require_admin(&req, peer, config).await {
        Ok(admin) => admin,
        Err(err) => return ResponseBuilder::from(err).into(),
    };

    let Ok(target) = Uuid::parse_str(id) else {
        return ResponseBuilder::from(ApiError::NotFound(format!("/admin/users/{id}"))).into();
    };
    if target == admin.id {
        return ResponseBuilder::from(ApiError::BadRequest(
            "you can't delete your own account".into(),
        ))
        .into();
    }

    let pool = config.db.pool();
    let result = sqlx::query("DELETE FROM users WHERE id = $1")
        .bind(target)
        .execute(&pool)
        .await;

    match result {
        Ok(done) if done.rows_affected() > 0 => {
            ResponseBuilder::new(StatusCode::NO_CONTENT).empty().into()
        }
        Ok(_) => ResponseBuilder::from(ApiError::NotFound(format!("/admin/users/{id}"))).into(),
        Err(err) => {
            tracing::error!(error = %err, "failed to delete user");
            ResponseBuilder::from(ApiError::Internal).into()
        }
    }
}

/// Percent-decodes the first value of query parameter `key`, if present.
fn query_param(query: Option<&str>, key: &str) -> Option<String> {
    query
        .into_iter()
        .flat_map(|q| q.split('&'))
        .filter_map(|pair| pair.split_once('='))
        .find(|(k, _)| *k == key)
        .map(|(_, v)| {
            percent_encoding::percent_decode_str(v)
                .decode_utf8_lossy()
                .into_owned()
        })
}

/// Parses query parameter `key` as an `i64`, or `None` if absent/non-numeric.
fn parse_i64(query: Option<&str>, key: &str) -> Option<i64> {
    query_param(query, key).and_then(|v| v.parse().ok())
}

/// Whether `route` looks like a page path: absolute (`/…`), of bounded length,
/// and free of control characters. The value is always bound as a query
/// parameter, so this guards against junk and unbounded input, not injection.
fn is_valid_route(route: &str) -> bool {
    route.starts_with('/') && route.len() <= 256 && !route.chars().any(|c| c.is_control())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn query_param_reads_and_decodes() {
        assert_eq!(query_param(None, "kind"), None);
        assert_eq!(query_param(Some("kind=js"), "kind"), Some("js".to_string()));
        assert_eq!(
            query_param(Some("a=1&route=%2Fsecret%2Fpi"), "route"),
            Some("/secret/pi".to_string())
        );
        assert_eq!(query_param(Some("kind=js"), "missing"), None);
    }

    #[test]
    fn parse_i64_reads_numbers_only() {
        assert_eq!(parse_i64(Some("limit=50"), "limit"), Some(50));
        assert_eq!(parse_i64(Some("limit=abc"), "limit"), None);
        assert_eq!(parse_i64(None, "limit"), None);
    }

    #[test]
    fn is_valid_route_requires_absolute_bounded_path() {
        assert!(is_valid_route("/"));
        assert!(is_valid_route("/secret/pi"));
        assert!(!is_valid_route("secret"));
        assert!(!is_valid_route(&format!("/{}", "a".repeat(256))));
        assert!(!is_valid_route("/bad\nroute"));
    }
}
