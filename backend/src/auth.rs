//! Authentication: PIN + token login, TOTP (RFC 6238) enrolment with one-time
//! recovery codes, and a token extractor other modules use to gate endpoints.
//!
//! A user authenticates with `name` + `pin` (hashed with argon2id). Once they
//! enrol TOTP they must also present a 6-digit code — or one of the recovery
//! codes handed out at enrolment — on each login. A successful login mints an
//! opaque token; only its SHA-256 hash is stored (`user_tokens.token`), so a
//! database leak never exposes a live token. The token is returned in the JSON
//! body for `Authorization: Bearer` use, and additionally set as an `HttpOnly`
//! cookie when the caller passes `?cookie=true`.

use std::fmt::Write as _;
use std::net::SocketAddr;

use argon2::Argon2;
use argon2::password_hash::rand_core::OsRng;
use argon2::password_hash::{PasswordHash, PasswordHasher, PasswordVerifier, SaltString};
use chrono::{DateTime, Duration, Utc};
use hyper::header::{AUTHORIZATION, CACHE_CONTROL, COOKIE, HeaderValue, USER_AGENT};
use hyper::{Request, StatusCode};
use rand::RngExt;
use rand::rngs::SysRng;
use rand_core::UnwrapErr;
use sha2::{Digest, Sha256};
use sonic_rs::{Deserialize, Serialize};
use totp_rs::{Algorithm, Secret, TOTP};
use uuid::Uuid;

use crate::config::ApiConfig;
use crate::database::models::UserRole;
use crate::ip::resolve_client_ip;
use crate::response::{self, ApiError, Body, ResponseBuilder};

/// Name of the session cookie set on `?cookie=true` logins and read back by the
/// token extractor.
const COOKIE_NAME: &str = "session";

/// Issuer shown in the authenticator app (the label before the account name).
const ISSUER: &str = "AndrewMcCall";

/// How many one-time recovery codes are generated when a user enrols TOTP.
const RECOVERY_CODE_COUNT: usize = 10;

/// Unambiguous alphabet for recovery codes — no `0/O`, `1/I/L` confusions.
const RECOVERY_ALPHABET: &[u8] = b"ABCDEFGHJKMNPQRSTUVWXYZ23456789";

// ---------------------------------------------------------------------------
// Primitives: PIN hashing, token + recovery-code generation, hashing.
// ---------------------------------------------------------------------------

/// Hashes a PIN with argon2id, returning the PHC string stored in `users.pin`.
pub fn hash_pin(pin: &str) -> Result<String, ApiError> {
    let salt = SaltString::generate(&mut OsRng);
    Argon2::default()
        .hash_password(pin.as_bytes(), &salt)
        .map(|hash| hash.to_string())
        .map_err(|err| {
            tracing::error!(error = %err, "failed to hash pin");
            ApiError::Internal
        })
}

/// Verifies a PIN against a stored argon2 PHC hash. A malformed hash or a
/// mismatch both return false (never panics, never leaks which it was).
pub fn verify_pin(hash: &str, pin: &str) -> bool {
    match PasswordHash::new(hash) {
        Ok(parsed) => Argon2::default()
            .verify_password(pin.as_bytes(), &parsed)
            .is_ok(),
        Err(_) => false,
    }
}

/// Lowercase hex SHA-256 of `input`. Used to derive the stored form of tokens
/// and recovery codes so the plaintext never touches the database.
fn sha256_hex(input: &str) -> String {
    let digest = Sha256::digest(input.as_bytes());
    let mut out = String::with_capacity(digest.len() * 2);
    for byte in digest {
        let _ = write!(out, "{byte:02x}");
    }
    out
}

/// A fresh opaque token: 32 bytes from the OS CSPRNG, URL-safe base64. The
/// caller stores `sha256_hex` of this and hands the plaintext to the client.
fn generate_token() -> String {
    let mut rng = UnwrapErr(SysRng);
    let mut bytes = [0u8; 32];
    rng.fill(&mut bytes);
    use base64::Engine;
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes)
}

/// A single recovery code like `ABCDE-FGHJK`, drawn from [`RECOVERY_ALPHABET`].
fn generate_recovery_code() -> String {
    let mut rng = UnwrapErr(SysRng);
    let mut out = String::with_capacity(11);
    for i in 0..10 {
        if i == 5 {
            out.push('-');
        }
        let idx = rng.random_range(0..RECOVERY_ALPHABET.len());
        out.push(RECOVERY_ALPHABET[idx] as char);
    }
    out
}

// ---------------------------------------------------------------------------
// TOTP helpers.
// ---------------------------------------------------------------------------

/// Builds a [`TOTP`] (SHA1, 6 digits, 30s step, ±1 window) from a base32 secret
/// and the account name shown in the authenticator. Returns `None` for a
/// malformed or too-short secret.
fn build_totp(secret_b32: &str, account: &str) -> Option<TOTP> {
    let bytes = Secret::Encoded(secret_b32.to_string()).to_bytes().ok()?;
    TOTP::new(
        Algorithm::SHA1,
        6,
        1,
        30,
        bytes,
        Some(ISSUER.to_string()),
        account.to_string(),
    )
    .ok()
}

/// Whether `code` is the current TOTP (within the ±1 step window) for `secret`.
fn verify_totp(secret_b32: &str, account: &str, code: &str) -> bool {
    build_totp(secret_b32, account)
        .and_then(|totp| totp.check_current(code).ok())
        .unwrap_or(false)
}

/// A fresh 160-bit TOTP secret, returned base32-encoded (for storage/display).
fn generate_totp_secret() -> String {
    let mut rng = UnwrapErr(SysRng);
    let mut bytes = vec![0u8; 20];
    rng.fill(bytes.as_mut_slice());
    Secret::Raw(bytes).to_encoded().to_string()
}

// ---------------------------------------------------------------------------
// Cookies + token extraction.
// ---------------------------------------------------------------------------

/// Builds the `Set-Cookie` value carrying `token`, honouring the configured
/// `Secure` flag and token TTL.
fn build_cookie(token: &str, config: &ApiConfig) -> String {
    let mut cookie = format!("{COOKIE_NAME}={token}; HttpOnly; Path=/; SameSite=Strict");
    if config.cookie_secure {
        cookie.push_str("; Secure");
    }
    if let Some(days) = config.token_ttl_days {
        let max_age = days.max(0) * 86_400;
        let _ = write!(cookie, "; Max-Age={max_age}");
    }
    cookie
}

/// Builds the `Set-Cookie` value that immediately expires the session cookie.
fn clear_cookie(config: &ApiConfig) -> String {
    let mut cookie = format!("{COOKIE_NAME}=; HttpOnly; Path=/; SameSite=Strict; Max-Age=0");
    if config.cookie_secure {
        cookie.push_str("; Secure");
    }
    cookie
}

/// Extracts the raw token from a request: an `Authorization: Bearer <token>`
/// header takes precedence, else the `session` cookie.
fn extract_token(req: &Request<hyper::body::Incoming>) -> Option<String> {
    if let Some(header) = req
        .headers()
        .get(AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
    {
        let bearer = header
            .strip_prefix("Bearer ")
            .or_else(|| header.strip_prefix("bearer "));
        if let Some(token) = bearer {
            let token = token.trim();
            if !token.is_empty() {
                return Some(token.to_string());
            }
        }
    }

    let cookies = req.headers().get(COOKIE).and_then(|v| v.to_str().ok())?;
    for part in cookies.split(';') {
        if let Some((name, value)) = part.trim().split_once('=')
            && name == COOKIE_NAME
            && !value.is_empty()
        {
            return Some(value.to_string());
        }
    }
    None
}

/// Whether the request's query string opts into cookie mode (`?cookie=true`).
fn wants_cookie(req: &Request<hyper::body::Incoming>) -> bool {
    req.uri()
        .query()
        .into_iter()
        .flat_map(|q| q.split('&'))
        .any(|pair| matches!(pair, "cookie=true" | "cookie=1"))
}

// ---------------------------------------------------------------------------
// Token extractor used to gate protected endpoints.
// ---------------------------------------------------------------------------

/// The authenticated principal behind a valid token.
#[derive(Debug, Clone)]
pub struct AuthUser {
    pub id: Uuid,
    pub name: String,
    pub role: UserRole,
}

impl AuthUser {
    pub fn is_admin(&self) -> bool {
        self.role == UserRole::Admin
    }
}

/// Resolves the token on a request to its user, or [`ApiError::Unauthorized`]
/// if it is missing, unknown, or expired. On success, records the access in
/// `auth_log` on a detached task (so "last login" stays current) and returns
/// the [`AuthUser`].
pub async fn authenticate(
    req: &Request<hyper::body::Incoming>,
    peer: SocketAddr,
    config: &ApiConfig,
) -> Result<AuthUser, ApiError> {
    let token = extract_token(req).ok_or(ApiError::Unauthorized)?;
    let token_hash = sha256_hex(&token);

    let pool = config.db.pool();
    let row: Option<(Uuid, String, UserRole)> = sqlx::query_as(
        "SELECT u.id, u.name, u.role \
         FROM user_tokens t JOIN users u ON u.id = t.user_id \
         WHERE t.token = $1 AND (t.expires_at IS NULL OR t.expires_at > now())",
    )
    .bind(&token_hash)
    .fetch_optional(&pool)
    .await
    .map_err(|err| {
        tracing::error!(error = %err, "failed to look up token");
        ApiError::Internal
    })?;

    let (id, name, role) = row.ok_or(ApiError::Unauthorized)?;

    let client_ip = resolve_client_ip(config.ip_source, req, peer)
        .map(|ip| ip.0)
        .unwrap_or_else(|_| "unknown".to_string());
    let user_agent = req
        .headers()
        .get(USER_AGENT)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_string();
    record_auth(config, id, req.uri().path(), client_ip, user_agent);

    Ok(AuthUser { id, name, role })
}

/// Records a single authenticated request in `auth_log`, deduplicating the user
/// agent, on a detached task. Mirrors `logs::log_visit`.
fn record_auth(
    config: &ApiConfig,
    user_id: Uuid,
    uri: &str,
    client_ip: String,
    user_agent: String,
) {
    let pool = config.db.pool();
    let pk = Uuid::new_v4();
    let timestamp = Utc::now();
    let uri = uri.to_string();

    smol::spawn(async move {
        let result = sqlx::query(
            "WITH ua AS ( \
                 INSERT INTO user_agents (user_agent) VALUES ($5) \
                 ON CONFLICT (user_agent) DO UPDATE SET user_agent = EXCLUDED.user_agent \
                 RETURNING id \
             ) \
             INSERT INTO auth_log (id, created_at, uri, user_id, client_ip, user_agent_id) \
             SELECT $1, $2, $3, $4, $6, ua.id FROM ua",
        )
        .bind(pk)
        .bind(timestamp)
        .bind(uri)
        .bind(user_id)
        .bind(user_agent)
        .bind(client_ip)
        .execute(&pool)
        .await;

        if let Err(err) = result {
            tracing::error!(error = %err, %pk, "failed to persist auth_log");
        }
    })
    .detach();
}

// ---------------------------------------------------------------------------
// Serialized views.
// ---------------------------------------------------------------------------

/// The public JSON shape of a user — never carries the pin hash or TOTP secret.
#[derive(Serialize)]
pub struct UserView {
    pub id: String,
    pub name: String,
    pub role: &'static str,
    pub totp_enabled: bool,
}

// ---------------------------------------------------------------------------
// Handlers.
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
struct LoginRequest {
    name: String,
    pin: String,
    totp: Option<String>,
    recovery: Option<String>,
}

#[derive(Serialize)]
struct LoginReply {
    token: String,
    user: UserView,
}

#[derive(Serialize)]
struct TotpChallenge {
    error: &'static str,
    totp_required: bool,
}

/// A user row loaded for authentication.
#[derive(sqlx::FromRow)]
struct AuthRow {
    id: Uuid,
    name: String,
    pin: String,
    totp_secret: Option<String>,
    role: UserRole,
}

/// `POST /auth/login` — body `{name, pin, totp?, recovery?}`, optional
/// `?cookie=true`. Verifies the PIN, enforces TOTP (code or recovery code) when
/// enrolled, mints a token, and returns `{token, user}` (also setting a cookie
/// in cookie mode). Returns `401 {totp_required:true}` when a second factor is
/// needed but not supplied/valid.
pub async fn login(
    req: Request<hyper::body::Incoming>,
    config: &ApiConfig,
) -> hyper::Response<Body> {
    let cookie_mode = wants_cookie(&req);

    let body: LoginRequest = match response::read_json(
        req,
        r#"expected a JSON body like {"name": "alice", "pin": "1234"}"#,
    )
    .await
    {
        Ok(body) => body,
        Err(err) => return ResponseBuilder::from(err).into(),
    };

    let pool = config.db.pool();
    let user: Option<AuthRow> =
        match sqlx::query_as("SELECT id, name, pin, totp_secret, role FROM users WHERE name = $1")
            .bind(&body.name)
            .fetch_optional(&pool)
            .await
        {
            Ok(user) => user,
            Err(err) => {
                tracing::error!(error = %err, "failed to load user for login");
                return ResponseBuilder::from(ApiError::Internal).into();
            }
        };

    // Same generic error whether the name is unknown or the pin is wrong, so a
    // caller can't probe which names exist.
    let Some(user) = user.filter(|u| verify_pin(&u.pin, &body.pin)) else {
        return ResponseBuilder::from(ApiError::Unauthorized).into();
    };

    // Second factor, if enrolled: a valid TOTP code or a still-unused recovery
    // code. Anything else is a challenge the client can react to.
    if let Some(secret) = &user.totp_secret {
        let totp_ok = body
            .totp
            .as_deref()
            .is_some_and(|code| verify_totp(secret, &user.name, code));
        let recovery_ok = match (totp_ok, body.recovery.as_deref()) {
            (false, Some(code)) => consume_recovery_code(&pool, user.id, code).await,
            _ => false,
        };
        if !totp_ok && !recovery_ok {
            return ResponseBuilder::new(StatusCode::UNAUTHORIZED)
                .json(&TotpChallenge {
                    error: "a TOTP or recovery code is required",
                    totp_required: true,
                })
                .into();
        }
    }

    let token = generate_token();
    let expires_at: Option<DateTime<Utc>> = config
        .token_ttl_days
        .map(|days| Utc::now() + Duration::days(days));
    if let Err(err) = sqlx::query(
        "INSERT INTO user_tokens (id, user_id, token, created_at, expires_at) \
         VALUES ($1, $2, $3, $4, $5)",
    )
    .bind(Uuid::new_v4())
    .bind(user.id)
    .bind(sha256_hex(&token))
    .bind(Utc::now())
    .bind(expires_at)
    .execute(&pool)
    .await
    {
        tracing::error!(error = %err, "failed to persist token");
        return ResponseBuilder::from(ApiError::Internal).into();
    }

    let reply = LoginReply {
        token: token.clone(),
        user: UserView {
            id: user.id.to_string(),
            name: user.name,
            role: user.role.as_str(),
            totp_enabled: user.totp_secret.is_some(),
        },
    };

    let mut builder = ResponseBuilder::new(StatusCode::OK)
        .header(CACHE_CONTROL, HeaderValue::from_static("no-store"));
    if cookie_mode {
        builder = builder.set_cookie(build_cookie(&token, config));
    }
    builder.json(&reply).into()
}

/// Marks a matching unused recovery code as consumed. Returns true only if a row
/// was actually updated (so each code works exactly once).
async fn consume_recovery_code(pool: &sqlx::PgPool, user_id: Uuid, code: &str) -> bool {
    let code_hash = sha256_hex(code.trim());
    let result = sqlx::query(
        "UPDATE user_recovery_codes SET used_at = now() \
         WHERE user_id = $1 AND code_hash = $2 AND used_at IS NULL",
    )
    .bind(user_id)
    .bind(&code_hash)
    .execute(pool)
    .await;

    match result {
        Ok(done) => done.rows_affected() > 0,
        Err(err) => {
            tracing::error!(error = %err, "failed to consume recovery code");
            false
        }
    }
}

/// `POST /auth/logout` — deletes the presented token and clears the cookie.
pub async fn logout(
    req: Request<hyper::body::Incoming>,
    peer: SocketAddr,
    config: &ApiConfig,
) -> hyper::Response<Body> {
    if let Err(err) = authenticate(&req, peer, config).await {
        return ResponseBuilder::from(err).into();
    }
    if let Some(token) = extract_token(&req) {
        let pool = config.db.pool();
        if let Err(err) = sqlx::query("DELETE FROM user_tokens WHERE token = $1")
            .bind(sha256_hex(&token))
            .execute(&pool)
            .await
        {
            tracing::error!(error = %err, "failed to delete token on logout");
        }
    }
    ResponseBuilder::new(StatusCode::NO_CONTENT)
        .set_cookie(clear_cookie(config))
        .empty()
        .into()
}

/// `GET /auth/me` — the current user as [`UserView`].
pub async fn me(
    req: Request<hyper::body::Incoming>,
    peer: SocketAddr,
    config: &ApiConfig,
) -> hyper::Response<Body> {
    let user = match authenticate(&req, peer, config).await {
        Ok(user) => user,
        Err(err) => return ResponseBuilder::from(err).into(),
    };

    let pool = config.db.pool();
    let totp_enabled: bool =
        sqlx::query_scalar("SELECT totp_secret IS NOT NULL FROM users WHERE id = $1")
            .bind(user.id)
            .fetch_optional(&pool)
            .await
            .ok()
            .flatten()
            .unwrap_or(false);

    ResponseBuilder::new(StatusCode::OK)
        .json(&UserView {
            id: user.id.to_string(),
            name: user.name,
            role: user.role.as_str(),
            totp_enabled,
        })
        .into()
}

#[derive(Serialize)]
struct TotpSetupReply {
    secret_base32: String,
    otpauth_uri: String,
}

/// `POST /auth/totp/setup` — returns a fresh (unstored) secret and provisioning
/// URI. The client displays it, then confirms via `/auth/totp/enable`.
pub async fn totp_setup(
    req: Request<hyper::body::Incoming>,
    peer: SocketAddr,
    config: &ApiConfig,
) -> hyper::Response<Body> {
    let user = match authenticate(&req, peer, config).await {
        Ok(user) => user,
        Err(err) => return ResponseBuilder::from(err).into(),
    };

    let secret_base32 = generate_totp_secret();
    let Some(totp) = build_totp(&secret_base32, &user.name) else {
        tracing::error!("failed to build TOTP from freshly generated secret");
        return ResponseBuilder::from(ApiError::Internal).into();
    };

    ResponseBuilder::new(StatusCode::OK)
        .header(CACHE_CONTROL, HeaderValue::from_static("no-store"))
        .json(&TotpSetupReply {
            otpauth_uri: totp.get_url(),
            secret_base32,
        })
        .into()
}

#[derive(Deserialize)]
struct TotpEnableRequest {
    secret: String,
    code: String,
}

#[derive(Serialize)]
struct TotpEnableReply {
    recovery_codes: Vec<String>,
}

/// `POST /auth/totp/enable` — body `{secret, code}`. Verifies the code against
/// the secret, persists the secret, and returns freshly generated one-time
/// recovery codes (shown to the user only here).
pub async fn totp_enable(
    req: Request<hyper::body::Incoming>,
    peer: SocketAddr,
    config: &ApiConfig,
) -> hyper::Response<Body> {
    let user = match authenticate(&req, peer, config).await {
        Ok(user) => user,
        Err(err) => return ResponseBuilder::from(err).into(),
    };

    let body: TotpEnableRequest = match response::read_json(
        req,
        r#"expected a JSON body like {"secret": "…", "code": "123456"}"#,
    )
    .await
    {
        Ok(body) => body,
        Err(err) => return ResponseBuilder::from(err).into(),
    };

    if !verify_totp(&body.secret, &user.name, body.code.trim()) {
        return ResponseBuilder::from(ApiError::BadRequest(
            "that code doesn't match — check the time on your device and try again".into(),
        ))
        .into();
    }

    let pool = config.db.pool();
    let mut tx = match pool.begin().await {
        Ok(tx) => tx,
        Err(err) => {
            tracing::error!(error = %err, "failed to begin totp enable tx");
            return ResponseBuilder::from(ApiError::Internal).into();
        }
    };

    // Persist the verified secret and replace any prior recovery codes.
    let steps = async {
        sqlx::query("UPDATE users SET totp_secret = $1 WHERE id = $2")
            .bind(&body.secret)
            .bind(user.id)
            .execute(&mut *tx)
            .await?;
        sqlx::query("DELETE FROM user_recovery_codes WHERE user_id = $1")
            .bind(user.id)
            .execute(&mut *tx)
            .await?;

        let mut codes = Vec::with_capacity(RECOVERY_CODE_COUNT);
        for _ in 0..RECOVERY_CODE_COUNT {
            let code = generate_recovery_code();
            sqlx::query(
                "INSERT INTO user_recovery_codes (id, user_id, code_hash, created_at) \
                 VALUES ($1, $2, $3, now())",
            )
            .bind(Uuid::new_v4())
            .bind(user.id)
            .bind(sha256_hex(&code))
            .execute(&mut *tx)
            .await?;
            codes.push(code);
        }
        Ok::<_, sqlx::Error>(codes)
    };

    let codes = match steps.await {
        Ok(codes) => codes,
        Err(err) => {
            tracing::error!(error = %err, "failed to enable totp");
            return ResponseBuilder::from(ApiError::Internal).into();
        }
    };

    if let Err(err) = tx.commit().await {
        tracing::error!(error = %err, "failed to commit totp enable");
        return ResponseBuilder::from(ApiError::Internal).into();
    }

    ResponseBuilder::new(StatusCode::OK)
        .header(CACHE_CONTROL, HeaderValue::from_static("no-store"))
        .json(&TotpEnableReply {
            recovery_codes: codes,
        })
        .into()
}

#[derive(Deserialize)]
struct TotpDisableRequest {
    /// A current TOTP or an unused recovery code proving control of the factor.
    code: String,
}

/// `POST /auth/totp/disable` — body `{code}`. Clears the TOTP secret and all
/// recovery codes after checking a current code (or a recovery code).
pub async fn totp_disable(
    req: Request<hyper::body::Incoming>,
    peer: SocketAddr,
    config: &ApiConfig,
) -> hyper::Response<Body> {
    let user = match authenticate(&req, peer, config).await {
        Ok(user) => user,
        Err(err) => return ResponseBuilder::from(err).into(),
    };

    let body: TotpDisableRequest =
        match response::read_json(req, r#"expected a JSON body like {"code": "123456"}"#).await {
            Ok(body) => body,
            Err(err) => return ResponseBuilder::from(err).into(),
        };

    let pool = config.db.pool();
    let secret: Option<String> =
        match sqlx::query_scalar("SELECT totp_secret FROM users WHERE id = $1")
            .bind(user.id)
            .fetch_optional(&pool)
            .await
        {
            Ok(secret) => secret.flatten(),
            Err(err) => {
                tracing::error!(error = %err, "failed to load totp secret");
                return ResponseBuilder::from(ApiError::Internal).into();
            }
        };

    let Some(secret) = secret else {
        return ResponseBuilder::from(ApiError::BadRequest("TOTP is not enabled".into())).into();
    };

    let code = body.code.trim();
    let allowed =
        verify_totp(&secret, &user.name, code) || consume_recovery_code(&pool, user.id, code).await;
    if !allowed {
        return ResponseBuilder::from(ApiError::Unauthorized).into();
    }

    let result = async {
        sqlx::query("UPDATE users SET totp_secret = NULL WHERE id = $1")
            .bind(user.id)
            .execute(&pool)
            .await?;
        sqlx::query("DELETE FROM user_recovery_codes WHERE user_id = $1")
            .bind(user.id)
            .execute(&pool)
            .await?;
        Ok::<_, sqlx::Error>(())
    };
    if let Err(err) = result.await {
        tracing::error!(error = %err, "failed to disable totp");
        return ResponseBuilder::from(ApiError::Internal).into();
    }

    ResponseBuilder::new(StatusCode::NO_CONTENT).empty().into()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pin_hash_round_trips_and_rejects_wrong_pin() {
        let hash = hash_pin("2468").unwrap();
        assert!(verify_pin(&hash, "2468"));
        assert!(!verify_pin(&hash, "1357"));
        // A stored hash is never the plaintext.
        assert_ne!(hash, "2468");
        assert!(hash.starts_with("$argon2"));
    }

    #[test]
    fn verify_pin_rejects_malformed_hash() {
        assert!(!verify_pin("not-a-phc-string", "1234"));
    }

    #[test]
    fn token_hashing_is_stable_and_distinct() {
        assert_eq!(sha256_hex("abc"), sha256_hex("abc"));
        assert_ne!(sha256_hex("abc"), sha256_hex("abd"));
        // 32 bytes -> 64 hex chars.
        assert_eq!(sha256_hex("abc").len(), 64);
    }

    #[test]
    fn generated_tokens_are_unique_and_url_safe() {
        let a = generate_token();
        let b = generate_token();
        assert_ne!(a, b);
        assert!(
            a.chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
        );
    }

    #[test]
    fn recovery_codes_are_grouped_from_the_alphabet() {
        let code = generate_recovery_code();
        assert_eq!(code.len(), 11);
        assert_eq!(code.as_bytes()[5], b'-');
        assert!(
            code.bytes()
                .filter(|&b| b != b'-')
                .all(|b| RECOVERY_ALPHABET.contains(&b))
        );
    }

    #[test]
    fn totp_verifies_a_current_code_and_rejects_a_wrong_one() {
        let secret = generate_totp_secret();
        let totp = build_totp(&secret, "alice").unwrap();
        let now = totp.generate_current().unwrap();
        assert!(verify_totp(&secret, "alice", &now));
        assert!(!verify_totp(&secret, "alice", "000000"));
    }

    #[test]
    fn wrong_secret_does_not_verify() {
        let secret = generate_totp_secret();
        let other = generate_totp_secret();
        let code = build_totp(&secret, "alice")
            .unwrap()
            .generate_current()
            .unwrap();
        assert!(!verify_totp(&other, "alice", &code));
    }
}
