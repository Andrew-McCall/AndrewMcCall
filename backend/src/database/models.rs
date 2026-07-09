//! Row types mapping one-to-one to the tables in `migrations/`. These are pure
//! data structs decoupled from the HTTP layer: nothing here knows about hyper,
//! requests, or responses — handlers translate to/from these at the boundary.

// These structs are read back from the database by the query layer as it grows;
// several are not constructed in Rust yet.
#![allow(dead_code)]

use chrono::{DateTime, Utc};
use uuid::Uuid;

/// The source of a visit. Mirrors the `visit_kind` Postgres enum.
#[derive(Debug, Clone, Copy, PartialEq, Eq, sqlx::Type)]
#[sqlx(type_name = "visit_kind", rename_all = "lowercase")]
pub enum VisitKind {
    Static,
    Js,
    Secret,
}

/// A territory from Natural Earth admin-0 (`countries` table). `slug` also
/// names the SVG outline under `assets/countries/`. The capital isn't stored
/// here — it's the [`City`] with `capital` set.
#[derive(Debug, Clone, sqlx::FromRow)]
pub struct Country {
    pub slug: String,
    pub name: String,
    pub population: Option<i64>,
    /// Lowercase ISO 3166-1 alpha-2 code, for flag CDN links; `None` where
    /// Natural Earth has none (e.g. disputed or uninhabited territories).
    pub iso2: Option<String>,
    /// GDP in millions of current USD (Natural Earth `GDP_MD`); `None` where
    /// unavailable.
    pub gdp: Option<i64>,
}

/// One of a country's headline cities (`cities` table). `x`/`y` are in the
/// country SVG's viewBox coordinate space.
#[derive(Debug, Clone, sqlx::FromRow)]
pub struct City {
    pub country_slug: String,
    pub name: String,
    pub x: f64,
    pub y: f64,
    pub population: Option<i64>,
    pub capital: bool,
}

/// A deduplicated user-agent string (`user_agents` table).
#[derive(Debug, Clone, sqlx::FromRow)]
pub struct UserAgent {
    pub id: i64,
    pub user_agent: String,
}

/// A single anonymous page visit (`visits` table).
#[derive(Debug, Clone, sqlx::FromRow)]
pub struct Visit {
    pub id: Uuid,
    pub created_at: DateTime<Utc>,
    pub kind: VisitKind,
    pub client_ip: String,
    pub user_agent_id: i64,
}

/// An application user (`users` table).
///
/// `Debug` is implemented by hand so the `pin` hash and `totp_secret` never
/// leak into logs.
#[derive(Clone, sqlx::FromRow)]
pub struct User {
    pub id: Uuid,
    pub name: String,
    pub pin: String,
    pub totp_secret: Option<String>,
    pub created_at: DateTime<Utc>,
}

impl std::fmt::Debug for User {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("User")
            .field("id", &self.id)
            .field("name", &self.name)
            .field("pin", &"<redacted>")
            .field(
                "totp_secret",
                &self.totp_secret.as_ref().map(|_| "<redacted>"),
            )
            .field("created_at", &self.created_at)
            .finish()
    }
}

/// An authentication token issued to a user (`user_tokens` table).
///
/// `Debug` is implemented by hand so the token value never leaks into logs.
#[derive(Clone, sqlx::FromRow)]
pub struct UserToken {
    pub id: Uuid,
    pub user_id: Uuid,
    pub token: String,
    pub created_at: DateTime<Utc>,
    /// `None` if the token never expires.
    pub expires_at: Option<DateTime<Utc>>,
}

impl std::fmt::Debug for UserToken {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("UserToken")
            .field("id", &self.id)
            .field("user_id", &self.user_id)
            .field("token", &"<redacted>")
            .field("created_at", &self.created_at)
            .field("expires_at", &self.expires_at)
            .finish()
    }
}

/// A single authenticated request (`auth_log` table). Mirrors [`Visit`] but
/// carries the accessed `uri` and the `user_id` behind the token instead of a
/// visit kind. The newest row for a user is that user's last login.
#[derive(Debug, Clone, sqlx::FromRow)]
pub struct AuthLog {
    pub id: Uuid,
    pub created_at: DateTime<Utc>,
    pub uri: String,
    pub user_id: Uuid,
    pub client_ip: String,
    pub user_agent_id: i64,
}
