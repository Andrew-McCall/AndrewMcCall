//! Encoding for the frames the server pushes down a room's event stream.
//!
//! One frame is one event: a line naming its kind, a line holding its JSON, and
//! a blank line. Frames are built once and handed to every peer as a `Bytes`
//! clone, so a fan-out serializes once however many people are listening.

use bytes::Bytes;
use sonic_rs::Serialize;

/// Encodes one SSE frame.
///
/// Serializing these plain structs cannot fail in practice. If it somehow did,
/// an empty object keeps the stream well-formed — a malformed frame would break
/// every call in the room, which is a bad trade for an impossible case.
pub fn frame<T: Serialize>(event: &str, data: &T) -> Bytes {
    let json = sonic_rs::to_string(data).unwrap_or_else(|err| {
        tracing::error!(error = %err, event, "failed to serialize a live event");
        "{}".to_string()
    });
    Bytes::from(format!("event: {event}\ndata: {json}\n\n"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn encodes_an_event_name_and_its_json() {
        #[derive(Serialize)]
        struct Payload {
            name: String,
        }

        let bytes = frame(
            "peer-left",
            &Payload {
                name: "Alice".to_string(),
            },
        );

        assert_eq!(
            String::from_utf8(bytes.to_vec()).unwrap(),
            "event: peer-left\ndata: {\"name\":\"Alice\"}\n\n"
        );
    }
}
