//! The live-room registry: who is in which room, and the channel each of them
//! listens on.
//!
//! Rooms exist only in memory and only while someone is in them. There is no
//! table and no history: a room is created by its first joiner and destroyed
//! when its last peer leaves, so a deploy ends every call rather than
//! resurrecting a half-connected one.
//!
//! Each peer holds one channel. Everything the server pushes — the roster,
//! signalling relayed from another peer, source states — is written into it as
//! an already-encoded SSE frame, so a fan-out serializes once and hands every
//! peer a cheap `Bytes` clone.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use bytes::Bytes;
use chrono::{DateTime, Utc};
use smol::channel::{Receiver, Sender};
use uuid::Uuid;

use sonic_rs::Value;

use crate::live::event::frame;
use crate::response::ApiError;

/// How many people may be in one room at once. This is a mesh: every
/// participant holds a connection to every other, so the ceiling is the
/// slowest uplink in the room, not the server.
pub const ROOM_CAPACITY: usize = 6;

/// Identifies one participant's connection, not the user behind it — the same
/// person joining from two tabs is two peers.
pub type PeerId = Uuid;

/// A room as the lobby sees it. Timestamps are stringified here, at the
/// serialization boundary, as everywhere else in the API.
#[derive(Debug, Clone, PartialEq, sonic_rs::Serialize, ts_typegen::Ts)]
pub struct RoomSummary {
    pub id: String,
    pub title: String,
    pub started_by: String,
    pub started_at: String,
    pub people: usize,
}

/// What a joining peer needs: its own identity, who else is here, and the
/// stream to listen on.
#[derive(Debug)]
pub struct Joined {
    pub peer_id: PeerId,
    pub seq: u64,
    /// True when this join opened the room, rather than walking into one
    /// already running. The handler announces only the former.
    pub created: bool,
    pub roster: Vec<PeerSummary>,
    pub events: Receiver<Bytes>,
    /// Removes this peer from its room when dropped. The response body owns it,
    /// so a closed tab, a slept laptop and a dropped connection are one path.
    pub guard: PeerGuard,
}

/// Removes a peer from its room when it goes out of scope.
#[derive(Debug)]
pub struct PeerGuard {
    live: Live,
    room_id: String,
    peer_id: PeerId,
}

impl Drop for PeerGuard {
    fn drop(&mut self) {
        self.live.leave(&self.room_id, self.peer_id);
    }
}

/// What a peer is told the moment it joins: its own identity, and the room it
/// has landed in.
#[derive(sonic_rs::Serialize)]
struct Hello<'a> {
    peer_id: String,
    seq: u64,
    title: &'a str,
    roster: &'a [PeerSummary],
}

/// A signalling message as the receiving peer sees it.
#[derive(sonic_rs::Serialize)]
struct SignalOut<'a> {
    from: String,
    kind: &'a str,
    payload: &'a Value,
}

/// The `peer-left` payload.
#[derive(sonic_rs::Serialize)]
struct Departure {
    peer_id: String,
}

/// Another participant, as announced to the room and carried in the roster.
/// Ids are stringified here, at the serialization boundary, as everywhere else
/// in the API.
#[derive(Debug, Clone, PartialEq, sonic_rs::Serialize, ts_typegen::Ts)]
pub struct PeerSummary {
    pub peer_id: String,
    pub name: String,
    pub seq: u64,
}

/// A cloneable handle to the registry. Cloning shares the same rooms.
#[derive(Debug, Clone, Default)]
pub struct Live(Arc<Mutex<Registry>>);

/// Everything live: the rooms, and the lobby pages watching them.
#[derive(Debug, Default)]
struct Registry {
    rooms: HashMap<String, Room>,
    lobby: Vec<Sender<Bytes>>,
}

impl Registry {
    /// Pushes the whole room list to every lobby page, dropping the watchers
    /// whose channel has closed — a page that has gone away.
    fn tell_lobby(&mut self) {
        let rooms = frame("rooms", &self.summaries());
        self.lobby.retain(|watcher| watcher.try_send(rooms.clone()).is_ok());
    }

    /// The open rooms, oldest first.
    fn summaries(&self) -> Vec<RoomSummary> {
        let mut open: Vec<RoomSummary> = self
            .rooms
            .iter()
            .map(|(id, room)| room.summary(id))
            .collect();
        open.sort_by(|a, b| a.started_at.cmp(&b.started_at));
        open
    }
}

#[derive(Debug)]
pub struct Room {
    title: String,
    started_by: String,
    started_at: DateTime<Utc>,
    /// Handed out in join order and never reused, so the two ends of a pair can
    /// agree on who offers without asking the server.
    next_seq: u64,
    peers: HashMap<PeerId, Peer>,
}

#[derive(Debug)]
struct Peer {
    user_id: Uuid,
    name: String,
    seq: u64,
    events: Sender<Bytes>,
}

impl Room {
    /// Sends a frame to everyone in the room except `except` — normally the
    /// peer whose own action caused it.
    ///
    /// A send can only fail on a closed channel, which means that peer's
    /// connection has already gone; its guard removes it a moment later.
    fn announce(&self, frame: Bytes, except: PeerId) {
        for (peer_id, peer) in &self.peers {
            if *peer_id != except {
                let _ = peer.events.try_send(frame.clone());
            }
        }
    }

    /// This room as the lobby sees it.
    fn summary(&self, id: &str) -> RoomSummary {
        RoomSummary {
            id: id.to_string(),
            title: self.title.clone(),
            started_by: self.started_by.clone(),
            started_at: self.started_at.to_rfc3339(),
            people: self.peers.len(),
        }
    }

    /// The peers already here, in join order.
    fn roster(&self) -> Vec<PeerSummary> {
        let mut roster: Vec<PeerSummary> = self
            .peers
            .iter()
            .map(|(peer_id, peer)| PeerSummary {
                peer_id: peer_id.to_string(),
                name: peer.name.clone(),
                seq: peer.seq,
            })
            .collect();
        roster.sort_by_key(|peer| peer.seq);
        roster
    }
}

impl Live {
    pub fn new() -> Self {
        Self::default()
    }

    /// Joins `room_id`, creating the room if nobody is in it yet. `title` names
    /// a newly created room and is ignored when joining an existing one.
    pub fn join(
        &self,
        room_id: &str,
        title: &str,
        user_id: Uuid,
        name: &str,
    ) -> Result<Joined, ApiError> {
        let mut registry = self.0.lock().unwrap();
        let created = !registry.rooms.contains_key(room_id);
        let room = registry.rooms.entry(room_id.to_string()).or_insert_with(|| Room {
            title: title.to_string(),
            started_by: name.to_string(),
            started_at: Utc::now(),
            next_seq: 0,
            peers: HashMap::new(),
        });

        if room.peers.len() >= ROOM_CAPACITY {
            return Err(ApiError::BadRequest(format!(
                "that room is full ({ROOM_CAPACITY} people)"
            )));
        }

        let roster = room.roster();

        let peer_id = Uuid::new_v4();
        let seq = room.next_seq;
        room.next_seq += 1;

        // Unbounded so a fan-out can never block the peer doing the sending. A
        // client that stops reading is a dead connection, and dropping its
        // stream is what cleans it up.
        let (events, rx) = smol::channel::unbounded();

        // Sent before the room is told about the arrival, so a peer always has
        // its own identity before anything refers to it.
        let _ = events.try_send(frame(
            "hello",
            &Hello {
                peer_id: peer_id.to_string(),
                seq,
                title: &room.title,
                roster: &roster,
            },
        ));

        room.peers.insert(
            peer_id,
            Peer {
                user_id,
                name: name.to_string(),
                seq,
                events,
            },
        );

        room.announce(
            frame(
                "peer-joined",
                &PeerSummary {
                    peer_id: peer_id.to_string(),
                    name: name.to_string(),
                    seq,
                },
            ),
            peer_id,
        );

        registry.tell_lobby();

        Ok(Joined {
            peer_id,
            seq,
            created,
            roster,
            events: rx,
            guard: PeerGuard {
                live: self.clone(),
                room_id: room_id.to_string(),
                peer_id,
            },
        })
    }

    /// Subscribes to the lobby: the open rooms now, and the whole list again
    /// whenever it changes.
    ///
    /// There is no guard to match — a watcher is forgotten when its channel
    /// closes, which happens by itself when the response body is dropped.
    pub fn watch_lobby(&self) -> Receiver<Bytes> {
        let mut registry = self.0.lock().unwrap();
        let (events, rx) = smol::channel::unbounded();
        let _ = events.try_send(frame("rooms", &registry.summaries()));
        registry.lobby.push(events);
        rx
    }

    /// Sends a comment frame to every open stream.
    ///
    /// This is what keeps a stream alive through intermediaries that reap idle
    /// connections, and — more usefully — it is a write, which is how a
    /// connection that died without a FIN is finally noticed.
    pub fn keepalive(&self) {
        let ping = Bytes::from_static(b":ping\n\n");
        let mut registry = self.0.lock().unwrap();
        for room in registry.rooms.values() {
            for peer in room.peers.values() {
                let _ = peer.events.try_send(ping.clone());
            }
        }
        // Also the moment a lobby page that has gone away is forgotten, even if
        // no room has opened or closed since.
        registry
            .lobby
            .retain(|watcher| watcher.try_send(ping.clone()).is_ok());
    }

    /// Relays one signalling message from `from` to `to`, both of which must be
    /// in `room_id`. `user_id` is the authenticated caller, checked against the
    /// peer it claims to be.
    pub fn relay(
        &self,
        room_id: &str,
        user_id: Uuid,
        from: PeerId,
        to: &str,
        kind: &str,
        payload: &Value,
    ) -> Result<(), ApiError> {
        let registry = self.0.lock().unwrap();
        let room = registry.rooms.get(room_id).ok_or(ApiError::Forbidden)?;

        // The peer id was minted server-side and handed only to that client's
        // own stream, but a second session of the same user must not be able to
        // borrow it either: the claim is checked against the account behind it.
        let sender = room.peers.get(&from).ok_or(ApiError::Forbidden)?;
        if sender.user_id != user_id {
            return Err(ApiError::Forbidden);
        }

        let to: PeerId = to.parse().map_err(|_| ApiError::Forbidden)?;
        let target = room.peers.get(&to).ok_or(ApiError::Forbidden)?;

        // `from` is stamped by the server and the payload is re-serialized
        // rather than passed through as text: a frame is newline-delimited, so
        // client text spliced in verbatim could forge events of its own.
        let _ = target.events.try_send(frame(
            "signal",
            &SignalOut {
                from: from.to_string(),
                kind,
                payload,
            },
        ));

        Ok(())
    }

    /// Removes a peer and tells the rest of the room. Called only by
    /// [`PeerGuard::drop`], so every way a connection can end arrives here.
    fn leave(&self, room_id: &str, peer_id: PeerId) {
        let mut registry = self.0.lock().unwrap();
        let Some(room) = registry.rooms.get_mut(room_id) else {
            return;
        };
        if room.peers.remove(&peer_id).is_none() {
            return;
        }

        // A room is its people. The last one out closes it, which is also what
        // makes a share link good for exactly one call.
        if room.peers.is_empty() {
            registry.rooms.remove(room_id);
            registry.tell_lobby();
            return;
        }

        room.announce(
            frame(
                "peer-left",
                &Departure {
                    peer_id: peer_id.to_string(),
                },
            ),
            peer_id,
        );
        registry.tell_lobby();
    }

    /// Every room with someone in it, for the lobby.
    pub fn open(&self) -> Vec<RoomSummary> {
        self.0.lock().unwrap().summaries()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Joins a room the way a handler would, returning just the `Joined`.
    fn join(live: &Live, room: &str, name: &str) -> Joined {
        live.join(room, "Music", Uuid::new_v4(), name)
            .expect("join should succeed")
    }

    /// Throws away whatever is already queued for a peer, so a test can assert
    /// on the frame caused by what it does next.
    fn drain(joined: &Joined) {
        while joined.events.try_recv().is_ok() {}
    }

    /// The text of the next frame waiting on a peer's stream.
    fn next_frame(joined: &Joined) -> String {
        let frame = joined
            .events
            .try_recv()
            .expect("a frame should be waiting");
        String::from_utf8(frame.to_vec()).expect("frames are utf-8")
    }

    #[test]
    fn joining_an_unknown_room_creates_it() {
        let live = Live::new();

        // Held: the peer is in the room only for as long as its `Joined` lives.
        let _alice = join(&live, "blue-otter-lamp", "Alice");

        let open = live.open();
        assert_eq!(open.len(), 1);
        assert_eq!(open[0].id, "blue-otter-lamp");
        assert_eq!(open[0].title, "Music");
        assert_eq!(open[0].started_by, "Alice");
        assert_eq!(open[0].people, 1);
    }

    #[test]
    fn a_joiner_is_announced_to_the_peers_already_there() {
        let live = Live::new();
        let alice = join(&live, "blue-otter-lamp", "Alice");
        drain(&alice); // her own hello
        let bob = join(&live, "blue-otter-lamp", "Bob");

        let frame = next_frame(&alice);

        assert!(frame.starts_with("event: peer-joined\n"), "{frame}");
        assert!(frame.contains("\"name\":\"Bob\""), "{frame}");
        assert!(frame.contains(&bob.peer_id.to_string()), "{frame}");
        assert!(frame.ends_with("\n\n"), "{frame}");
    }

    #[test]
    fn dropping_a_peers_guard_announces_that_it_left() {
        let live = Live::new();
        let alice = join(&live, "blue-otter-lamp", "Alice");
        let bob = join(&live, "blue-otter-lamp", "Bob");
        let bob_id = bob.peer_id.to_string();
        drain(&alice); // her hello, and bob arriving

        drop(bob);

        let frame = next_frame(&alice);
        assert!(frame.starts_with("event: peer-left\n"), "{frame}");
        assert!(frame.contains(&bob_id), "{frame}");
    }

    #[test]
    fn the_last_peer_leaving_destroys_the_room() {
        let live = Live::new();
        let alice = join(&live, "blue-otter-lamp", "Alice");
        assert_eq!(live.open().len(), 1);

        drop(alice);

        assert!(live.open().is_empty(), "an empty room should not linger");
    }

    #[test]
    fn a_room_refuses_someone_past_capacity() {
        let live = Live::new();
        let _held: Vec<Joined> = (0..ROOM_CAPACITY)
            .map(|i| join(&live, "blue-otter-lamp", &format!("Peer {i}")))
            .collect();

        let refused = live.join("blue-otter-lamp", "Music", Uuid::new_v4(), "Latecomer");

        match refused {
            Err(ApiError::BadRequest(message)) => assert!(message.contains("full"), "{message}"),
            other => panic!("a full room should refuse the join, got {other:?}"),
        }
    }

    /// Joins as a known user, for the tests that care which account is calling.
    fn join_as(live: &Live, room: &str, user_id: Uuid, name: &str) -> Joined {
        live.join(room, "Music", user_id, name)
            .expect("join should succeed")
    }

    /// A stand-in for the SDP or ICE candidate a real client would send.
    fn payload(text: &str) -> Value {
        sonic_rs::from_str(&format!("{{\"sdp\":\"{text}\"}}")).expect("valid json")
    }

    #[test]
    fn a_signal_reaches_only_its_target() {
        let live = Live::new();
        let alice_user = Uuid::new_v4();
        let alice = join_as(&live, "blue-otter-lamp", alice_user, "Alice");
        let bob = join_as(&live, "blue-otter-lamp", Uuid::new_v4(), "Bob");
        let carol = join_as(&live, "blue-otter-lamp", Uuid::new_v4(), "Carol");
        while alice.events.try_recv().is_ok() {}
        while bob.events.try_recv().is_ok() {}
        while carol.events.try_recv().is_ok() {}

        live.relay(
            "blue-otter-lamp",
            alice_user,
            alice.peer_id,
            &bob.peer_id.to_string(),
            "offer",
            &payload("v=0"),
        )
        .expect("relay should succeed");

        let frame = next_frame(&bob);
        assert!(frame.starts_with("event: signal\n"), "{frame}");
        assert!(frame.contains(&alice.peer_id.to_string()), "{frame}");
        assert!(frame.contains("offer"), "{frame}");
        assert!(
            carol.events.try_recv().is_err(),
            "a signal is for one peer, not the room"
        );
    }

    #[test]
    fn a_signal_cannot_be_sent_as_another_peer() {
        let live = Live::new();
        let alice = join_as(&live, "blue-otter-lamp", Uuid::new_v4(), "Alice");
        let bob = join_as(&live, "blue-otter-lamp", Uuid::new_v4(), "Bob");
        let mallory_user = Uuid::new_v4();
        let _mallory = join_as(&live, "blue-otter-lamp", mallory_user, "Mallory");
        while bob.events.try_recv().is_ok() {}

        // Mallory holds a real session, but claims to be Alice's peer.
        let result = live.relay(
            "blue-otter-lamp",
            mallory_user,
            alice.peer_id,
            &bob.peer_id.to_string(),
            "offer",
            &payload("v=0"),
        );

        assert!(
            matches!(result, Err(ApiError::Forbidden)),
            "expected the impersonation to be refused, got {result:?}"
        );
        assert!(
            bob.events.try_recv().is_err(),
            "nothing should have been delivered"
        );
    }

    /// A regression guard rather than a driven behaviour: routing by room
    /// already refuses this, and it must keep refusing it.
    #[test]
    fn a_signal_cannot_cross_into_another_room() {
        let live = Live::new();
        let alice_user = Uuid::new_v4();
        let alice = join_as(&live, "blue-otter-lamp", alice_user, "Alice");
        let elsewhere = join_as(&live, "green-anvil-rope", Uuid::new_v4(), "Stranger");
        while elsewhere.events.try_recv().is_ok() {}

        let result = live.relay(
            "blue-otter-lamp",
            alice_user,
            alice.peer_id,
            &elsewhere.peer_id.to_string(),
            "offer",
            &payload("v=0"),
        );

        assert!(
            matches!(result, Err(ApiError::Forbidden)),
            "expected a refusal, got {result:?}"
        );
        assert!(elsewhere.events.try_recv().is_err());
    }

    #[test]
    fn a_new_lobby_watcher_is_sent_the_rooms_that_are_already_open() {
        let live = Live::new();
        let _alice = join(&live, "blue-otter-lamp", "Alice");

        let lobby = live.watch_lobby();

        let frame = String::from_utf8(lobby.try_recv().expect("a frame").to_vec()).unwrap();
        assert!(frame.starts_with("event: rooms\n"), "{frame}");
        assert!(frame.contains("blue-otter-lamp"), "{frame}");
    }

    #[test]
    fn the_lobby_is_told_when_a_room_opens() {
        let live = Live::new();
        let lobby = live.watch_lobby();
        while lobby.try_recv().is_ok() {} // the list it was given on subscribing

        let _alice = join(&live, "blue-otter-lamp", "Alice");

        let frame =
            String::from_utf8(lobby.try_recv().expect("the lobby should be told").to_vec())
                .unwrap();
        assert!(frame.starts_with("event: rooms\n"), "{frame}");
        assert!(frame.contains("blue-otter-lamp"), "{frame}");
    }

    #[test]
    fn the_lobby_sees_the_head_count_change() {
        let live = Live::new();
        let _alice = join(&live, "blue-otter-lamp", "Alice");
        let bob = join(&live, "blue-otter-lamp", "Bob");
        let lobby = live.watch_lobby();
        while lobby.try_recv().is_ok() {}

        drop(bob);

        let frame =
            String::from_utf8(lobby.try_recv().expect("the lobby should be told").to_vec())
                .unwrap();
        assert!(frame.contains("\"people\":1"), "{frame}");
    }

    #[test]
    fn a_keepalive_reaches_every_peer() {
        let live = Live::new();
        let alice = join(&live, "blue-otter-lamp", "Alice");
        let bob = join(&live, "green-anvil-rope", "Bob");
        while alice.events.try_recv().is_ok() {}
        while bob.events.try_recv().is_ok() {}

        live.keepalive();

        assert_eq!(next_frame(&alice), ":ping\n\n");
        assert_eq!(next_frame(&bob), ":ping\n\n");
    }

    #[test]
    fn a_keepalive_reaches_the_lobby_too() {
        let live = Live::new();
        let lobby = live.watch_lobby();
        while lobby.try_recv().is_ok() {}

        live.keepalive();

        let frame = String::from_utf8(lobby.try_recv().expect("a ping").to_vec()).unwrap();
        assert_eq!(frame, ":ping\n\n");
    }

    #[test]
    fn a_joiner_is_told_who_is_already_here() {
        let live = Live::new();
        let _alice = join(&live, "blue-otter-lamp", "Alice");
        let bob = join(&live, "blue-otter-lamp", "Bob");

        let frame = next_frame(&bob);

        assert!(frame.starts_with("event: hello\n"), "{frame}");
        assert!(frame.contains(&bob.peer_id.to_string()), "{frame}");
        assert!(frame.contains("Alice"), "{frame}");
        assert!(frame.contains("\"seq\":1"), "{frame}");
    }

    #[test]
    fn only_the_join_that_opens_a_room_reports_creating_it() {
        let live = Live::new();

        let alice = join(&live, "blue-otter-lamp", "Alice");
        let bob = join(&live, "blue-otter-lamp", "Bob");

        assert!(alice.created, "alice opened the room");
        assert!(!bob.created, "bob walked into a room already running");
    }
}
