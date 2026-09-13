//! Live rooms — voice, camera and screen shared between signed-in users.
//!
//! A room is opened by whoever joins it first and destroyed when the last
//! person leaves, so the link to one is good for exactly that call. Nothing
//! about a call is written down: the whole thing lives in [`state`], in memory,
//! and a restart ends every call rather than half-restoring it.
//!
//! Signalling is server-sent events downstream and plain POSTs upstream.
//! **Opening a room's event stream is joining it**, and dropping that stream is
//! leaving: the response body owns the guard that removes the peer, so a closed
//! tab needs no goodbye and a crashed browser cannot leave a ghost behind.

pub mod event;
pub mod state;

use std::net::SocketAddr;
use std::time::Duration;

use hyper::{Request, StatusCode};
use percent_encoding::{NON_ALPHANUMERIC, utf8_percent_encode};
use rand::RngExt;
use rand::rngs::SysRng;
use rand_core::UnwrapErr;
use sonic_rs::{Deserialize, Serialize, Value};
use ts_typegen::Ts;

use crate::auth;
use crate::config::{ApiConfig, SharedConfig};
use crate::live::state::{Live, PeerId};
use crate::response::{self, ApiError, Body, ResponseBuilder, event_stream};

/// How often every open stream is pinged. Long enough to be invisible, short
/// enough to beat the proxy timeouts in front of us — and each ping is a write,
/// which is how a connection that died without closing is finally noticed.
const KEEPALIVE: Duration = Duration::from_secs(15);

/// Longest room title kept. Titles are shown in a list and pushed to a phone;
/// anything longer is someone pasting.
const MAX_TITLE: usize = 60;

/// Shown when a room is opened without a title.
const UNTITLED: &str = "Untitled room";

/// Pings every open stream on a timer, for as long as the process runs.
pub fn spawn_keepalive(config: SharedConfig) {
    smol::spawn(async move {
        loop {
            smol::Timer::after(KEEPALIVE).await;
            config.live.keepalive();
        }
    })
    .detach();
}

// ---------------------------------------------------------------------------
// Wire types.

#[derive(Deserialize)]
struct NewRoom {
    title: Option<String>,
}

/// The id a client should navigate to. No room exists yet — it is created by
/// the first stream that opens on it.
#[derive(Serialize, Ts)]
pub struct CreatedRoom {
    pub id: String,
    pub title: String,
}

#[derive(Deserialize)]
struct SignalIn {
    from: String,
    to: String,
    kind: String,
    payload: Value,
}

const NEW_ROOM_HINT: &str = r#"expected a JSON body like {"title": "…"}"#;
const SIGNAL_HINT: &str =
    r#"expected a JSON body like {"from": "…", "to": "…", "kind": "offer", "payload": {…}}"#;

// ---------------------------------------------------------------------------
// Handlers.

/// `GET /live/rooms` — the open rooms.
pub async fn list_rooms(
    req: Request<hyper::body::Incoming>,
    peer: SocketAddr,
    config: &ApiConfig,
) -> hyper::Response<Body> {
    if let Err(err) = auth::authenticate(&req, peer, config).await {
        return ResponseBuilder::from(err).into();
    }

    ResponseBuilder::new(StatusCode::OK)
        .json(&config.live.open())
        .into()
}

/// `POST /live/rooms` — picks an id to open a room on.
pub async fn create_room(
    req: Request<hyper::body::Incoming>,
    peer: SocketAddr,
    config: &ApiConfig,
) -> hyper::Response<Body> {
    if let Err(err) = auth::authenticate(&req, peer, config).await {
        return ResponseBuilder::from(err).into();
    }

    let body: NewRoom = match response::read_json(req, NEW_ROOM_HINT).await {
        Ok(body) => body,
        Err(err) => return ResponseBuilder::from(err).into(),
    };

    ResponseBuilder::new(StatusCode::OK)
        .json(&CreatedRoom {
            id: unused_id(&config.live),
            title: clean_title(body.title.as_deref()),
        })
        .into()
}

/// `GET /live/events` — the lobby: the open rooms, and the list again whenever
/// it changes.
pub async fn lobby_events(
    req: Request<hyper::body::Incoming>,
    peer: SocketAddr,
    config: &ApiConfig,
) -> hyper::Response<Body> {
    if let Err(err) = auth::authenticate(&req, peer, config).await {
        return ResponseBuilder::from(err).into();
    }

    event_stream(config.live.watch_lobby(), Box::new(()))
}

/// `GET /live/rooms/{id}/events` — joins the room and streams it.
pub async fn room_events(
    req: Request<hyper::body::Incoming>,
    peer: SocketAddr,
    config: &ApiConfig,
    room_id: &str,
) -> hyper::Response<Body> {
    let user = match auth::authenticate(&req, peer, config).await {
        Ok(user) => user,
        Err(err) => return ResponseBuilder::from(err).into(),
    };

    // Only used when this is the join that opens the room; joining one that is
    // already running keeps the title it was opened with.
    let title = clean_title(crate::admin::query_param(req.uri().query(), "title").as_deref());

    let joined = match config.live.join(room_id, &title, user.id, &user.name) {
        Ok(joined) => joined,
        Err(err) => return ResponseBuilder::from(err).into(),
    };

    // The one line per join that `signal` deliberately does not write.
    tracing::info!(
        room = room_id,
        peer = %joined.peer_id,
        seq = joined.seq,
        people = joined.roster.len() + 1,
        who = %user.name,
        "joined a live room"
    );

    if joined.created {
        announce_room(config, room_id, &title, &user.name);
    }

    event_stream(joined.events, Box::new(joined.guard))
}

/// `POST /live/rooms/{id}/signal` — hands one offer, answer or candidate to one
/// other peer.
pub async fn signal(
    req: Request<hyper::body::Incoming>,
    _peer: SocketAddr,
    config: &ApiConfig,
    room_id: &str,
) -> hyper::Response<Body> {
    // Deliberately the non-recording lookup: trickle ICE calls this dozens of
    // times per join, and an `auth_log` row per candidate records nothing
    // anyone will read. The stream that joined the room is logged instead.
    let user = match auth::authenticate_quiet(&req, config).await {
        Ok(user) => user,
        Err(err) => return ResponseBuilder::from(err).into(),
    };

    let body: SignalIn = match response::read_json(req, SIGNAL_HINT).await {
        Ok(body) => body,
        Err(err) => return ResponseBuilder::from(err).into(),
    };

    if !matches!(body.kind.as_str(), "offer" | "answer" | "ice") {
        return ResponseBuilder::from(ApiError::BadRequest(
            "kind must be offer, answer or ice".into(),
        ))
        .into();
    }

    let Ok(from) = body.from.parse::<PeerId>() else {
        return ResponseBuilder::from(ApiError::Forbidden).into();
    };

    if let Err(err) = config
        .live
        .relay(room_id, user.id, from, &body.to, &body.kind, &body.payload)
    {
        return ResponseBuilder::from(err).into();
    }

    ResponseBuilder::new(StatusCode::NO_CONTENT).empty().into()
}

// ---------------------------------------------------------------------------
// Helpers.

/// Trims a title to something worth showing in a list.
fn clean_title(title: Option<&str>) -> String {
    let title = title.unwrap_or_default().trim();
    if title.is_empty() {
        return UNTITLED.to_string();
    }
    title.chars().take(MAX_TITLE).collect()
}

/// A room id nothing is using: three words, as the password generator makes
/// them, so a link can be read down a phone.
fn unused_id(live: &Live) -> String {
    let mut rng = UnwrapErr(SysRng);
    loop {
        let id = format!(
            "{}-{}-{}",
            random_word(&mut rng),
            random_word(&mut rng),
            random_word(&mut rng)
        );
        if !live.open().iter().any(|room| room.id == id) {
            return id;
        }
    }
}

fn random_word(rng: &mut UnwrapErr<SysRng>) -> &'static str {
    let index = rng.random_range(0..am_wordlist::LEN);
    am_wordlist::get(index).unwrap_or_default()
}

/// Pushes a notification that a room has opened, if ntfy is configured.
///
/// Fire-and-forget: a call must not wait on a notification, and a failed one is
/// worth a log line and nothing more.
fn announce_room(config: &ApiConfig, room_id: &str, title: &str, host: &str) {
    let Some(topic) = config.ntfy_topic.clone() else {
        return;
    };
    let host_header = config.ntfy_host.clone();

    let message = format!("{host} opened {title}");
    let click = format!("{}/secret/live/{room_id}", crate::site::SITE_ORIGIN);
    let path = format!(
        "/{topic}/trigger?title={}&message={}&click={}",
        encode("Live now"),
        encode(&message),
        encode(&click)
    );

    smol::spawn(async move {
        match crate::http_client::https_get(&host_header, &path, &[]).await {
            Ok((status, _, _)) if status.is_success() => {}
            Ok((status, _, _)) => tracing::warn!(%status, "ntfy refused a live-room notification"),
            Err(err) => tracing::warn!(error = %err, "failed to notify that a room opened"),
        }
    })
    .detach();
}

fn encode(value: &str) -> String {
    utf8_percent_encode(value, NON_ALPHANUMERIC).to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_blank_title_falls_back() {
        assert_eq!(clean_title(None), UNTITLED);
        assert_eq!(clean_title(Some("   ")), UNTITLED);
    }

    #[test]
    fn a_title_is_trimmed_and_capped() {
        assert_eq!(clean_title(Some("  Friday music  ")), "Friday music");
        assert_eq!(clean_title(Some(&"x".repeat(200))).chars().count(), MAX_TITLE);
    }

    #[test]
    fn a_room_id_is_three_words() {
        let id = unused_id(&Live::new());

        let words: Vec<&str> = id.split('-').collect();
        assert_eq!(words.len(), 3, "{id}");
        assert!(
            words.iter().all(|w| !w.is_empty() && w.chars().all(|c| c.is_ascii_lowercase())),
            "{id}"
        );
    }
}
