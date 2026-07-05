mod config;
mod database;
mod ip;
mod logs;
mod password;
mod response;

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
    let path = req.uri().path();

    match path {
        "/log/static" => return Ok(logs::record_visit(&req, peer, &config, VisitKind::Static)),
        "/log/js" => return Ok(logs::record_visit(&req, peer, &config, VisitKind::Js)),
        "/log/secret" => return Ok(logs::record_visit(&req, peer, &config, VisitKind::Secret)),
        "/ip" => {
            return Ok(match resolve_client_ip(config.ip_source, &req, peer) {
                Ok(client_ip) => ResponseBuilder::new(StatusCode::OK)
                    .text(client_ip.0)
                    .into(),
                Err(err) => ResponseBuilder::from(err).into(),
            });
        }
        _ => {}
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
