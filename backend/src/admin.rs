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
