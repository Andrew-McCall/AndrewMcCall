//! Visit logging. Records anonymous page visits to both the tracing log and the
//! `visits` table, and backs the HTTP endpoints that trigger it.

use hyper::{Request, StatusCode};
use std::net::SocketAddr;

use crate::config::ApiConfig;
use crate::database::models::VisitKind;
use crate::ip::resolve_client_ip;
use crate::response::{Body, ResponseBuilder};

/// Records a visit under `kind` and returns `204 No Content`.
///
/// Backs the nginx static mirror (`/log/static`), the client-side JavaScript
/// ping (`/log/js`), and the secret endpoint (`/log/secret`). The visit is
/// emitted to the tracing log and persisted to `visits`; the database write is
/// detached so the response returns without waiting on it, and the user agent is
/// stored once in `user_agents` and referenced by id. Every caller discards the
/// body, so an empty `204` suits each.
pub fn record_visit(
    req: &Request<hyper::body::Incoming>,
    peer: SocketAddr,
    config: &ApiConfig,
    kind: VisitKind,
) -> hyper::Response<Body> {
    let client_ip = resolve_client_ip(config.ip_source, req, peer)
        .map(|ip| ip.0)
        .unwrap_or_else(|_| "unknown".to_string());

    let header = |name: &str| req.headers().get(name).and_then(|v| v.to_str().ok());

    let user_agent = header("user-agent").unwrap_or("").to_string();

    // The nginx mirror rewrites the proxied path to `/log/static`, so the page
    // the visitor requested only survives in the `X-Original-URI` header nginx
    // sets to `$request_uri`. Keep just the path, dropping any query or fragment;
    // absent (the js/secret pings), the route stays null.
    let route = header("x-original-uri")
        .map(|uri| uri.split(['?', '#']).next().unwrap_or(uri))
        .filter(|path| !path.is_empty())
        .map(str::to_string);

    let pk = uuid::Uuid::new_v4();
    let timestamp = chrono::Utc::now();

    tracing::info!(
        target: "visit",
        pk = %pk,
        timestamp = %timestamp.to_rfc3339(),
        kind = ?kind,
        route = route.as_deref().unwrap_or("-"),
        client_ip = %client_ip,
        user_agent = %user_agent,
        "visit",
    );

    let pool = config.db.pool();
    smol::spawn(async move {
        // Upsert the user agent for its id, then insert the visit referencing
        // it — atomically, in a single round trip.
        let result = sqlx::query(
            "WITH ua AS ( \
                 INSERT INTO user_agents (user_agent) VALUES ($4) \
                 ON CONFLICT (user_agent) DO UPDATE SET user_agent = EXCLUDED.user_agent \
                 RETURNING id \
             ) \
             INSERT INTO visits (id, created_at, kind, client_ip, user_agent_id, route) \
             SELECT $1, $2, $3, $5, ua.id, $6 FROM ua",
        )
        .bind(pk)
        .bind(timestamp)
        .bind(kind)
        .bind(user_agent)
        .bind(client_ip)
        .bind(route)
        .execute(&pool)
        .await;

        if let Err(err) = result {
            tracing::error!(error = %err, %pk, "failed to persist visit");
        }
    })
    .detach();

    ResponseBuilder::new(StatusCode::NO_CONTENT).empty().into()
}
