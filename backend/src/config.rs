use crate::{database::connection::DatabaseConnection, ip::IpSource};

#[derive(Debug)]
pub struct ApiConfig {
    pub ip_source: IpSource,
    pub db: DatabaseConnection,
    /// When the process started, for the admin-only uptime in `GET /admin/status`.
    pub started_at: std::time::Instant,
    /// How long an issued auth token stays valid. `None` means tokens never
    /// expire (`user_tokens.expires_at` is left null).
    pub token_ttl_days: Option<i64>,
    /// Whether to mark the session cookie `Secure` (HTTPS-only). Defaults to
    /// true; set `COOKIE_SECURE=false` for local HTTP development.
    pub cookie_secure: bool,
    /// Server-side key (`PIN_HASH_KEY`) used to HMAC the low-entropy PIN before
    /// it's stored in `login_attempts`. Without it a DB leak trivially reverses
    /// the unsalted digest back to the PIN. `None` falls back to a plain hash
    /// (unkeyed) so existing deployments keep working — set it in production.
    pub pin_hash_key: Option<String>,
    /// The name of the bootstrap admin, created on startup if absent. Paired
    /// with `admin_pin`; both must be set for bootstrapping to happen.
    pub admin_name: Option<String>,
    /// The plaintext PIN for the bootstrap admin (hashed before storage).
    pub admin_pin: Option<String>,
    /// The GitHub account whose public push events feed the commits cache.
    /// Unset disables the sync entirely.
    pub github_username: Option<String>,
    /// Optional GitHub token; raises the API rate limit but isn't required for
    /// the one conditional request per interval.
    pub github_token: Option<String>,
    /// Minutes between GitHub sync fetches.
    pub github_sync_minutes: u64,
}

pub type SharedConfig = std::sync::Arc<ApiConfig>;

impl ApiConfig {
    pub fn from_env() -> Self {
        Self {
            ip_source: IpSource::from_env().unwrap_or(IpSource::ConnectInfo),
            db: DatabaseConnection::from_env()
                .expect("failed to configure database connection from environment"),
            started_at: std::time::Instant::now(),
            token_ttl_days: std::env::var("TOKEN_TTL_DAYS")
                .ok()
                .and_then(|v| v.parse().ok()),
            cookie_secure: std::env::var("COOKIE_SECURE")
                .map(|v| !v.eq_ignore_ascii_case("false") && v != "0")
                .unwrap_or(true),
            pin_hash_key: non_empty_env("PIN_HASH_KEY"),
            admin_name: non_empty_env("ADMIN_NAME"),
            admin_pin: non_empty_env("ADMIN_PIN"),
            // Optional: with it unset the sync falls back to the profile's
            // GitHub URL, which the admin editor can set without a restart.
            github_username: non_empty_env("GITHUB_USERNAME"),
            github_token: non_empty_env("GITHUB_TOKEN"),
            github_sync_minutes: std::env::var("GITHUB_SYNC_MINUTES")
                .ok()
                .and_then(|v| v.parse().ok())
                .unwrap_or(30),
        }
    }
}

/// Reads an environment variable, treating an unset or empty value as absent.
fn non_empty_env(key: &str) -> Option<String> {
    std::env::var(key).ok().filter(|v| !v.is_empty())
}
