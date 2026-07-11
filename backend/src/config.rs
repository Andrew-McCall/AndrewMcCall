use crate::{database::connection::DatabaseConnection, ip::IpSource};

#[derive(Debug)]
pub struct ApiConfig {
    pub ip_source: IpSource,
    pub db: DatabaseConnection,
    /// How long an issued auth token stays valid. `None` means tokens never
    /// expire (`user_tokens.expires_at` is left null).
    pub token_ttl_days: Option<i64>,
    /// Whether to mark the session cookie `Secure` (HTTPS-only). Defaults to
    /// true; set `COOKIE_SECURE=false` for local HTTP development.
    pub cookie_secure: bool,
    /// The name of the bootstrap admin, created on startup if absent. Paired
    /// with `admin_pin`; both must be set for bootstrapping to happen.
    pub admin_name: Option<String>,
    /// The plaintext PIN for the bootstrap admin (hashed before storage).
    pub admin_pin: Option<String>,
}

pub type SharedConfig = std::sync::Arc<ApiConfig>;

impl ApiConfig {
    pub fn from_env() -> Self {
        Self {
            ip_source: IpSource::from_env().unwrap_or(IpSource::ConnectInfo),
            db: DatabaseConnection::from_env()
                .expect("failed to configure database connection from environment"),
            token_ttl_days: std::env::var("TOKEN_TTL_DAYS")
                .ok()
                .and_then(|v| v.parse().ok()),
            cookie_secure: std::env::var("COOKIE_SECURE")
                .map(|v| !v.eq_ignore_ascii_case("false") && v != "0")
                .unwrap_or(true),
            admin_name: non_empty_env("ADMIN_NAME"),
            admin_pin: non_empty_env("ADMIN_PIN"),
        }
    }
}

/// Reads an environment variable, treating an unset or empty value as absent.
fn non_empty_env(key: &str) -> Option<String> {
    std::env::var(key).ok().filter(|v| !v.is_empty())
}
