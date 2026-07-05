mod config;
mod database;
mod ip;
mod password;
mod response;

use config::{ApiConfig, SharedConfig};
use hyper::service::service_fn;
use hyper::{Method, Request, StatusCode};
use hyper_util::server::conn::auto;
use ip::resolve_client_ip;
use response::{ApiError, Body, ResponseBuilder};
use smol::net::TcpListener;
use smol_hyper::rt::{FuturesIo, SmolTimer};
use std::net::SocketAddr;
use std::sync::Arc;
use tracing_subscriber::Layer;
use tracing_subscriber::layer::SubscriberExt;
use tracing_subscriber::util::SubscriberInitExt;

async fn handle(
    req: Request<hyper::body::Incoming>,
    peer: SocketAddr,
    config: SharedConfig,
) -> Result<hyper::Response<Body>, hyper::Error> {
    let path = req.uri().path();

    if path.starts_with("/api") {
        return Ok(match resolve_client_ip(config.ip_source, &req, peer) {
            Ok(client_ip) => ResponseBuilder::new(StatusCode::OK)
                .text(client_ip.0)
                .into(),
            Err(err) => ResponseBuilder::from(err).into(),
        });
    }

    if path == "/log/static" {
        return Ok(static_visit_log(&req, peer, &config));
    }

    if path == "/log/js" {
        return Ok(js_visit_log(&req, peer, &config));
    }

    if let Some(template) = path.strip_prefix("/password/") {
        if req.method() != Method::GET {
            return Ok(ResponseBuilder::from(ApiError::NotFound(path.to_string())).into());
        }
        let template = percent_encoding::percent_decode_str(template)
            .decode_utf8_lossy()
            .into_owned();
        return Ok(password_response(&template));
    }

    Ok(ResponseBuilder::from(ApiError::NotFound(path.to_string())).into())
}

/// The source of a visit. Mirrors the `visit_kind` Postgres enum.
#[derive(Debug, Clone, Copy, sqlx::Type)]
#[sqlx(type_name = "visit_kind", rename_all = "lowercase")]
enum VisitKind {
    Static,
    Js,
}

/// Logs a single visit, recording a freshly generated primary key, a unix
/// timestamp, the client IP, and the user agent. `kind` distinguishes the
/// source of the visit.
///
/// The visit is emitted to the tracing log and persisted to the `visits`
/// table. The database write is spawned onto a detached task so the caller
/// can return its response without waiting on it. The user agent is stored in
/// the deduplicated `user_agents` table and referenced by id.
fn log_visit(config: &ApiConfig, kind: VisitKind, client_ip: &str, user_agent: &str) {
    let pk = uuid::Uuid::new_v4();
    let timestamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);

    tracing::info!(
        target: "visit",
        pk = %pk,
        timestamp,
        kind = ?kind,
        client_ip = %client_ip,
        user_agent = %user_agent,
        "visit",
    );

    let pool = config.db.pool();
    let client_ip = client_ip.to_string();
    let user_agent = user_agent.to_string();

    smol::spawn(async move {
        // Upsert the user agent to get its id, then insert the visit that
        // references it — atomically, in a single round trip.
        let result = sqlx::query(
            "WITH ua AS ( \
                 INSERT INTO user_agents (user_agent) VALUES ($4) \
                 ON CONFLICT (user_agent) DO UPDATE SET user_agent = EXCLUDED.user_agent \
                 RETURNING id \
             ) \
             INSERT INTO visits (id, created_at, kind, client_ip, user_agent_id) \
             SELECT $1, $2, $3, $5, ua.id FROM ua",
        )
        .bind(pk)
        .bind(timestamp as i64)
        .bind(kind)
        .bind(user_agent)
        .bind(client_ip)
        .execute(&pool)
        .await;

        if let Err(err) = result {
            tracing::error!(error = %err, %pk, "failed to persist visit");
        }
    })
    .detach();
}

/// Handles the nginx `mirror` subrequest for static asset views.
///
/// nginx mirrors each static request to an internal location that proxies here.
/// We log the visit and return `204 No Content`; the mirror module discards the
/// response anyway.
fn static_visit_log(
    req: &Request<hyper::body::Incoming>,
    peer: SocketAddr,
    config: &ApiConfig,
) -> hyper::Response<Body> {
    let client_ip = resolve_client_ip(config.ip_source, req, peer)
        .map(|ip| ip.0)
        .unwrap_or_else(|_| "unknown".to_string());

    let user_agent = req
        .headers()
        .get(hyper::header::USER_AGENT)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");

    log_visit(config, VisitKind::Static, &client_ip, user_agent);

    ResponseBuilder::new(StatusCode::NO_CONTENT).empty().into()
}

/// Handles a client-side (JavaScript) visit ping, e.g. from `navigator.sendBeacon`
/// or `fetch`. Logs the visit and returns `204 No Content`.
fn js_visit_log(
    req: &Request<hyper::body::Incoming>,
    peer: SocketAddr,
    config: &ApiConfig,
) -> hyper::Response<Body> {
    let client_ip = resolve_client_ip(config.ip_source, req, peer)
        .map(|ip| ip.0)
        .unwrap_or_else(|_| "unknown".to_string());

    let user_agent = req
        .headers()
        .get(hyper::header::USER_AGENT)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");

    log_visit(config, VisitKind::Js, &client_ip, user_agent);

    ResponseBuilder::new(StatusCode::NO_CONTENT).empty().into()
}

/// Handles `GET /password/{template}`, returning the generated password as
/// plaintext, or a bad-request error if the template is invalid.
fn password_response(template: &str) -> hyper::Response<Body> {
    match password::generate(template) {
        Ok(pw) => ResponseBuilder::new(StatusCode::OK).text(pw).into(),
        Err(err) => ResponseBuilder::from(ApiError::BadRequest(err.to_string())).into(),
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

fn main() {
    dotenvy::dotenv().ok();

    let file_appender = tracing_appender::rolling::Builder::new()
        .rotation(tracing_appender::rolling::Rotation::DAILY)
        .filename_prefix("backend")
        .filename_suffix("log")
        .build("logs")
        .expect("failed to initialize file logger");
    let (non_blocking_file, _guard) = tracing_appender::non_blocking(file_appender);

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

    smol::block_on(async {
        let port = std::env::var("PORT").unwrap_or_else(|_| "3000".to_string());
        let addr = std::env::var("ADDR").unwrap_or_else(|_| "0.0.0.0".to_string());

        let listen_address = format!("{addr}:{port}");

        let listener = TcpListener::bind(&listen_address).await.unwrap();
        tracing::info!("listening on http://{listen_address}");

        let config: SharedConfig = Arc::new(ApiConfig::from_env());

        loop {
            let (stream, peer) = match listener.accept().await {
                Ok(s) => s,
                Err(err) => {
                    tracing::warn!(error = %err, "failed to accept connection");
                    continue;
                }
            };

            let config = Arc::clone(&config);
            smol::spawn(async move {
                let io = FuturesIo::new(stream);
                let mut builder = auto::Builder::new(SmolExec);
                builder.http1().timer(SmolTimer::new());
                builder.http2().timer(SmolTimer::new());
                let service = service_fn(move |req| handle(req, peer, Arc::clone(&config)));
                let conn = builder.serve_connection(io, service);

                if let Err(err) = conn.await {
                    tracing::error!(error = %err, "error serving connection");
                }
            })
            .detach();
        }
    });
}
