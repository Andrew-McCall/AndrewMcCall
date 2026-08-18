mod admin;
mod auth;
mod config;
mod countries;
mod database;
mod github;
mod http_client;
mod ip;
mod logs;
mod notes;
mod password;
mod posts;
mod response;
mod site;
mod slug;
mod text;
mod stats;
mod visit_class;

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
    let method = req.method().clone();
    let path = req.uri().path();

    // Step 1: fixed routes, keyed on the (method, path) pair. Paths that accept
    // any method use a `_` method pattern; method-restricted paths fall through
    // to the 405 arm below, and unknown paths to step 2.
    match (&method, path) {
        (_, "/log/static") => logs::record_visit(&req, peer, &config, VisitKind::Static),
        (_, "/log/js") => logs::record_visit(&req, peer, &config, VisitKind::Js),
        (_, "/log/secret") => logs::record_visit(&req, peer, &config, VisitKind::Secret),
        (_, "/ip") => match resolve_client_ip(config.ip_source, &req, peer) {
            Ok(client_ip) => ResponseBuilder::new(StatusCode::OK)
                .text(client_ip.0)
                .into(),
            Err(err) => ResponseBuilder::from(err).into(),
        },
        (_, "/http") => http_dump(req, peer, &config).await,

        // Liveness probe. Deliberately dependency-free (no database, no config
        // lookups): a 200 here means the process is up and serving, which is
        // exactly what the frontend gates the canvas transparency on.
        (&Method::GET, "/health") => ResponseBuilder::new(StatusCode::OK).text("OK").into(),

        (&Method::GET, "/password/types") => password::types_response(),
        (m, "/password") if *m == Method::POST || m.as_str() == "QUERY" => {
            password::respond(req).await
        }
        (&Method::GET, "/sitemap.xml") => site::sitemap(&config).await,
        (&Method::GET, "/countries") => countries::list_response(&config).await,
        (&Method::GET, "/stats") => stats::stats_response(&config, req.uri().query()).await,

        (&Method::POST, "/auth/login") => auth::login(req, peer, &config).await,
        (&Method::POST, "/auth/logout") => auth::logout(req, peer, &config).await,
        (&Method::GET, "/auth/me") => auth::me(req, peer, &config).await,
        (&Method::POST, "/auth/pin") => auth::change_pin(req, peer, &config).await,
        (&Method::POST, "/auth/totp/setup") => auth::totp_setup(req, peer, &config).await,
        (&Method::POST, "/auth/totp/enable") => auth::totp_enable(req, peer, &config).await,
        (&Method::POST, "/auth/totp/disable") => auth::totp_disable(req, peer, &config).await,

        (&Method::GET, "/admin/status") => admin::status(req, peer, &config).await,
        (&Method::GET, "/admin/users") => admin::list_users(req, peer, &config).await,
        (&Method::POST, "/admin/users") => admin::create_user(req, peer, &config).await,
        (&Method::GET, "/admin/visits") => admin::list_visits(req, peer, &config).await,
        (&Method::GET, "/admin/posts") => posts::admin_list(req, peer, &config).await,
        (&Method::POST, "/admin/posts") => posts::create(req, peer, &config).await,
        (&Method::GET, "/admin/projects") => site::list_projects(req, peer, &config).await,
        (&Method::POST, "/admin/projects") => site::create_project(req, peer, &config).await,
        (&Method::GET, "/admin/project-tags") => site::list_project_tags(req, peer, &config).await,
        (&Method::GET, "/admin/profile") => site::get_profile(req, peer, &config).await,
        (&Method::PUT, "/admin/profile") => site::update_profile(req, peer, &config).await,
        (&Method::GET, "/admin/details") => site::get_details(req, peer, &config).await,
        (&Method::PUT, "/admin/details") => site::update_details(req, peer, &config).await,

        (&Method::GET, "/home") => site::home(req, peer, &config).await,
        (&Method::GET, "/posts") => posts::list_published(&config).await,

        (&Method::GET, "/notes") => notes::list_notes(req, peer, &config).await,
        (&Method::POST, "/notes") => notes::create_note(req, peer, &config).await,
        (&Method::GET, "/meta") => notes::list_meta(req, peer, &config).await,
        (&Method::GET, "/meta/types") => notes::list_meta_types(req, peer, &config).await,

        // Known path, but the method above didn't match: 405 (not 404).
        (
            _,
            "/health" | "/password/types" | "/password" | "/countries" | "/stats" | "/auth/login"
            | "/auth/logout" | "/auth/me" | "/auth/pin" | "/auth/totp/setup" | "/auth/totp/enable"
            | "/auth/totp/disable" | "/admin/status" | "/admin/users" | "/admin/visits"
            | "/admin/posts" | "/admin/projects" | "/admin/project-tags" | "/admin/profile"
            | "/admin/details" | "/home"
            | "/posts" | "/notes" | "/meta" | "/meta/types",
        ) => ResponseBuilder::from(ApiError::MethodNotAllowed).into(),

        // Step 2: parameterized routes. Own the id/slug before moving `req`,
        // since it borrows `path`, which borrows `req`.
        _ => {
            if let Some(id) = path.strip_prefix("/admin/users/") {
                let id = id.to_string();
                return if method == Method::DELETE {
                    admin::delete_user(req, peer, &config, &id).await
                } else {
                    ResponseBuilder::from(ApiError::MethodNotAllowed).into()
                };
            }
            if let Some(id) = path.strip_prefix("/admin/posts/") {
                let id = id.to_string();
                return match method {
                    Method::PUT => posts::update(req, peer, &config, &id).await,
                    Method::DELETE => posts::delete(req, peer, &config, &id).await,
                    _ => ResponseBuilder::from(ApiError::MethodNotAllowed).into(),
                };
            }
            if let Some(id) = path.strip_prefix("/admin/projects/") {
                let id = id.to_string();
                return match method {
                    Method::PUT => site::update_project(req, peer, &config, &id).await,
                    Method::DELETE => site::delete_project(req, peer, &config, &id).await,
                    _ => ResponseBuilder::from(ApiError::MethodNotAllowed).into(),
                };
            }
            if let Some(slug) = path.strip_prefix("/posts/") {
                let slug = slug.to_string();
                return if method == Method::GET {
                    posts::get_by_slug(&config, &slug).await
                } else {
                    ResponseBuilder::from(ApiError::MethodNotAllowed).into()
                };
            }
            if let Some(rest) = path.strip_prefix("/notes/") {
                // `/notes/{id}/restore` before the bare-id forms, so the suffix
                // isn't parsed as part of the uuid.
                if let Some(id) = rest.strip_suffix("/restore") {
                    let id = id.to_string();
                    return if method == Method::POST {
                        notes::restore_note(req, peer, &config, &id).await
                    } else {
                        ResponseBuilder::from(ApiError::MethodNotAllowed).into()
                    };
                }
                let id = rest.to_string();
                return match method {
                    Method::GET => notes::get_note(req, peer, &config, &id).await,
                    Method::PUT => notes::update_note(req, peer, &config, &id).await,
                    Method::DELETE => notes::delete_note(req, peer, &config, &id).await,
                    _ => ResponseBuilder::from(ApiError::MethodNotAllowed).into(),
                };
            }
            if let Some(file) = path.strip_prefix("/countries/") {
                return countries::svg_response(&method, file).await;
            }
            ResponseBuilder::from(ApiError::NotFound(path.to_string())).into()
        }
    }
}

/// Debug endpoint: returns a plain-text dump of the incoming request — the
/// request line, resolved client IP, every header, and the full body. Reads the
/// body into memory, so it's meant for inspecting small requests only.
async fn http_dump(
    req: Request<hyper::body::Incoming>,
    peer: SocketAddr,
    config: &config::ApiConfig,
) -> hyper::Response<Body> {
    let mut out = String::new();

    // Request line + version. Captured before the body is consumed below.
    out.push_str(&format!(
        "{} {} {:?}\n",
        req.method(),
        req.uri(),
        req.version()
    ));

    // Resolved client IP, plus the raw TCP peer for comparison. On failure
    // (e.g. loopback) show the error rather than aborting the dump.
    match resolve_client_ip(config.ip_source, &req, peer) {
        Ok(client_ip) => out.push_str(&format!("client ip: {}\n", client_ip.0)),
        Err(err) => out.push_str(&format!("client ip: <unresolved: {err}>\n")),
    }
    out.push_str(&format!("peer: {peer}\n"));

    out.push_str("\nheaders:\n");
    for (name, value) in req.headers() {
        out.push_str(&format!(
            "  {}: {}\n",
            name,
            value.to_str().unwrap_or("<non-utf8>")
        ));
    }

    out.push_str("\nbody:\n");
    match response::read_body(req).await {
        Ok(bytes) => out.push_str(&String::from_utf8_lossy(&bytes)),
        Err(err) => out.push_str(&format!("<could not read body: {err}>")),
    }

    ResponseBuilder::new(StatusCode::OK).text(out).into()
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

/// Parses `RUST_LOG` into a target filter.
///
/// [`tracing_subscriber::filter::Targets`] understands the directive syntax
/// this project actually uses — `info`, `backend=debug`, `info,sqlx=warn` —
/// without `EnvFilter`, which drags in a regex engine to support span-field
/// predicates nothing here writes. An unparseable value falls back to `info`
/// rather than failing startup over a typo in an env var.
fn log_filter() -> tracing_subscriber::filter::Targets {
    use std::str::FromStr;
    let raw = std::env::var("RUST_LOG").unwrap_or_default();
    if raw.trim().is_empty() {
        return tracing_subscriber::filter::Targets::new()
            .with_default(tracing::level_filters::LevelFilter::INFO);
    }
    tracing_subscriber::filter::Targets::from_str(&raw).unwrap_or_else(|err| {
        eprintln!("ignoring unparseable RUST_LOG ({err}); defaulting to info");
        tracing_subscriber::filter::Targets::new()
            .with_default(tracing::level_filters::LevelFilter::INFO)
    })
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
        .with(tracing_subscriber::fmt::layer().with_filter(log_filter()))
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

        // Bring the schema up to date before serving. Without this a deploy that
        // adds a migration (and boxes without the sqlx CLI, which deploy.sh's
        // optional migrate step skips) would run against a stale schema — e.g. a
        // missing `visits.route` column 500s every `/stats` request.
        config
            .db
            .migrate()
            .await
            .expect("failed to apply database migrations");

        ensure_admin(&config).await;

        // Brings the note index up to date: gives pre-refactor notes the
        // frontmatter they never had, and re-derives anything indexed by an
        // older ruleset. Deliberately not part of the SQL migration — a failure
        // here logs and leaves the work for the next boot, where a failed
        // migration would `.expect()` the whole site down.
        notes::index::reindex_all(&config.db.pool()).await;

        github::spawn_sync(Arc::clone(&config));

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
