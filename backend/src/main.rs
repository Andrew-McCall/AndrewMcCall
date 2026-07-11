mod admin;
mod auth;
mod config;
mod countries;
mod database;
mod ip;
mod logs;
mod password;
mod response;
mod stats;

use config::{ApiConfig, SharedConfig};
use database::models::VisitKind;
use hyper::service::service_fn;
use hyper::{Method, Request, StatusCode};
use hyper_util::server::conn::auto;
use ip::resolve_client_ip;
use response::{ApiError, Body, ResponseBuilder};
use smol::net::TcpListener;
use smol_hyper::rt::{FuturesIo, SmolTimer};
use std::net::SocketAddr;
use std::sync::Arc;
use tracing_appender::non_blocking::WorkerGuard;
use tracing_subscriber::Layer;
use tracing_subscriber::layer::SubscriberExt;
use tracing_subscriber::util::SubscriberInitExt;

async fn handle(
    req: Request<hyper::body::Incoming>,
    peer: SocketAddr,
    config: SharedConfig,
) -> Result<hyper::Response<Body>, hyper::Error> {
    Ok(route(req, peer, config).await)
}

/// Routes a request to its handler and returns the built response. Every path,
/// including unknown ones and wrong methods, yields a response, so routing
/// itself never fails.
async fn route(
    req: Request<hyper::body::Incoming>,
    peer: SocketAddr,
    config: SharedConfig,
) -> hyper::Response<Body> {
    let path = req.uri().path();

    match path {
        "/log/static" => logs::record_visit(&req, peer, &config, VisitKind::Static),
        "/log/js" => logs::record_visit(&req, peer, &config, VisitKind::Js),
        "/log/secret" => logs::record_visit(&req, peer, &config, VisitKind::Secret),
        "/ip" => match resolve_client_ip(config.ip_source, &req, peer) {
            Ok(client_ip) => ResponseBuilder::new(StatusCode::OK)
                .text(client_ip.0)
                .into(),
            Err(err) => ResponseBuilder::from(err).into(),
        },
        "/password/types" if req.method() == Method::GET => password::types_response(),
        "/password" if req.method() == Method::POST || req.method().as_str() == "QUERY" => {
            password::respond(req).await
        }
        "/password/types" | "/password" => ResponseBuilder::from(ApiError::MethodNotAllowed).into(),
        "/countries" if req.method() == Method::GET => countries::list_response(&config).await,
        "/countries" => ResponseBuilder::from(ApiError::MethodNotAllowed).into(),
        "/stats" if req.method() == Method::GET => {
            stats::stats_response(&config, req.uri().query()).await
        }
        "/stats" => ResponseBuilder::from(ApiError::MethodNotAllowed).into(),
        "/auth/login" if req.method() == Method::POST => auth::login(req, &config).await,
        "/auth/logout" if req.method() == Method::POST => auth::logout(req, peer, &config).await,
        "/auth/me" if req.method() == Method::GET => auth::me(req, peer, &config).await,
        "/auth/totp/setup" if req.method() == Method::POST => {
            auth::totp_setup(req, peer, &config).await
        }
        "/auth/totp/enable" if req.method() == Method::POST => {
            auth::totp_enable(req, peer, &config).await
        }
        "/auth/totp/disable" if req.method() == Method::POST => {
            auth::totp_disable(req, peer, &config).await
        }
        "/auth/login" | "/auth/logout" | "/auth/me" | "/auth/totp/setup" | "/auth/totp/enable"
        | "/auth/totp/disable" => ResponseBuilder::from(ApiError::MethodNotAllowed).into(),
        "/admin/users" if req.method() == Method::GET => {
            admin::list_users(req, peer, &config).await
        }
        "/admin/users" if req.method() == Method::POST => {
            admin::create_user(req, peer, &config).await
        }
        "/admin/users" => ResponseBuilder::from(ApiError::MethodNotAllowed).into(),
        _ if path.starts_with("/admin/users/") => {
            // Own the id before moving `req` into the handler (the id borrows
            // `path`, which borrows `req`).
            let id = path["/admin/users/".len()..].to_string();
            if req.method() == Method::DELETE {
                admin::delete_user(req, peer, &config, &id).await
            } else {
                ResponseBuilder::from(ApiError::MethodNotAllowed).into()
            }
        }
        _ => match path.strip_prefix("/countries/") {
            Some(file) => countries::svg_response(req.method(), file).await,
            None => ResponseBuilder::from(ApiError::NotFound(path.to_string())).into(),
        },
    }
}

#[derive(Clone, Copy)]
struct SmolExec;

impl<Fut> hyper::rt::Executor<Fut> for SmolExec
where
    Fut: std::future::Future + Send + 'static,
    Fut::Output: Send + 'static,
{
    fn execute(&self, fut: Fut) {
        smol::spawn(fut).detach();
    }
}

/// Initializes tracing, emitting to stderr (filtered by `RUST_LOG`) and to a
/// daily-rotated file under `logs/`. The returned guard must be kept alive for
/// the lifetime of the process so the non-blocking file writer is flushed.
fn init_tracing() -> WorkerGuard {
    let file_appender = tracing_appender::rolling::Builder::new()
        .rotation(tracing_appender::rolling::Rotation::DAILY)
        .filename_prefix("backend")
        .filename_suffix("log")
        .build("logs")
        .expect("failed to initialize file logger");
    let (non_blocking_file, guard) = tracing_appender::non_blocking(file_appender);

    tracing_subscriber::registry()
        .with(
            tracing_subscriber::fmt::layer()
                .with_filter(tracing_subscriber::EnvFilter::from_default_env()),
        )
        .with(
            tracing_subscriber::fmt::layer()
                .with_ansi(false)
                .with_writer(non_blocking_file)
                .with_filter(tracing_subscriber::filter::LevelFilter::TRACE),
        )
        .init();

    guard
}

fn main() {
    dotenvy::dotenv().ok();
    let _guard = init_tracing();

    smol::block_on(async {
        let port = std::env::var("PORT").unwrap_or_else(|_| "3000".to_string());
        let addr = std::env::var("ADDR").unwrap_or_else(|_| "0.0.0.0".to_string());

        let listen_address = format!("{addr}:{port}");

        let listener = TcpListener::bind(&listen_address).await.unwrap();
        tracing::info!("listening on http://{listen_address}");

        let config: SharedConfig = Arc::new(ApiConfig::from_env());
        ensure_admin(&config).await;

        loop {
            let (stream, peer) = match listener.accept().await {
                Ok(s) => s,
                Err(err) => {
                    tracing::warn!(error = %err, "failed to accept connection");
                    continue;
                }
            };

            let config = Arc::clone(&config);
            smol::spawn(serve_connection(stream, peer, config)).detach();
        }
    });
}

/// Bootstraps the first administrator from `ADMIN_NAME` / `ADMIN_PIN`. If both
/// are set and no user with that name exists yet, inserts them with the `admin`
/// role and a hashed PIN. A no-op when the variables are unset or the user
/// already exists, so it is safe to run on every startup.
async fn ensure_admin(config: &ApiConfig) {
    let (Some(name), Some(pin)) = (config.admin_name.as_deref(), config.admin_pin.as_deref())
    else {
        return;
    };

    let pin_hash = match auth::hash_pin(pin) {
        Ok(hash) => hash,
        Err(err) => {
            tracing::error!(?err, "failed to hash bootstrap admin pin");
            return;
        }
    };

    // Insert only if absent; do nothing if the name is already taken (we never
    // overwrite an existing user's pin or role from env).
    let pool = config.db.pool();
    let result = sqlx::query(
        "INSERT INTO users (id, name, pin, role, created_at) \
         VALUES ($1, $2, $3, 'admin', now()) \
         ON CONFLICT (name) DO NOTHING",
    )
    .bind(uuid::Uuid::new_v4())
    .bind(name)
    .bind(&pin_hash)
    .execute(&pool)
    .await;

    match result {
        Ok(done) if done.rows_affected() > 0 => {
            tracing::info!(admin = %name, "bootstrapped admin user");
        }
        Ok(_) => tracing::debug!(admin = %name, "admin user already exists; leaving as-is"),
        Err(err) => tracing::error!(error = %err, "failed to bootstrap admin user"),
    }
}

/// Serves a single accepted TCP connection, negotiating HTTP/1 or HTTP/2 and
/// dispatching each request through [`handle`].
async fn serve_connection(stream: smol::net::TcpStream, peer: SocketAddr, config: SharedConfig) {
    let io = FuturesIo::new(stream);
    let mut builder = auto::Builder::new(SmolExec);
    builder.http1().timer(SmolTimer::new());
    builder.http2().timer(SmolTimer::new());
    let service = service_fn(move |req| handle(req, peer, Arc::clone(&config)));

    if let Err(err) = builder.serve_connection(io, service).await {
        tracing::error!(error = %err, "error serving connection");
    }
}
