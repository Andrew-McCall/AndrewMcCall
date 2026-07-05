//! Visit logging. Records anonymous page visits both to the tracing log and
//! to the `visits` table, and exposes the HTTP endpoints that trigger it.

use hyper::{Request, StatusCode};
use std::net::SocketAddr;

use crate::config::ApiConfig;
use crate::database::models::VisitKind;
use crate::ip::resolve_client_ip;
use crate::response::{Body, ResponseBuilder};

/// Handles a visit-logging endpoint. Resolves the client IP and user agent,
/// records the visit under `kind`, and returns `204 No Content`.
///
/// Used for the nginx static mirror (`/log/static`), the client-side
/// JavaScript ping (`/log/js`), and the secret endpoint (`/secret`). The nginx
/// `mirror` module discards the response body, and the JS pings ignore it, so
/// the empty `204` suits every caller.
pub fn record_visit(
    req: &Request<hyper::body::Incoming>,
    peer: SocketAddr,
    config: &ApiConfig,
    kind: VisitKind,
) -> hyper::Response<Body> {
    let client_ip = resolve_client_ip(config.ip_source, req, peer)
        .map(|ip| ip.0)
        .unwrap_or_else(|_| "unknown".to_string());

    let user_agent = req
        .headers()
        .get(hyper::header::USER_AGENT)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");

    log_visit(config, kind, &client_ip, user_agent);

    ResponseBuilder::new(StatusCode::NO_CONTENT).empty().into()
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
    let timestamp = chrono::Utc::now();

    tracing::info!(
        target: "visit",
        pk = %pk,
        timestamp = %timestamp.to_rfc3339(),
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
        .bind(timestamp)
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
