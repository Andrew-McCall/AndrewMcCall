//! `POST /message`: the front page's contact box, forwarded to ntfy.

use std::collections::HashMap;
use std::net::SocketAddr;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use hyper::{Request, StatusCode};
use percent_encoding::{NON_ALPHANUMERIC, utf8_percent_encode};
use serde::Deserialize;

use crate::config::ApiConfig;
use crate::ip::resolve_client_ip;
use crate::response::{self, ApiError, Body, ResponseBuilder};

const MAX_TEXT: usize = 600;
const MAX_FROM: usize = 120;
const PER_SENDER: usize = 3;
const WINDOW: Duration = Duration::from_secs(60 * 60);

#[derive(Deserialize)]
struct MessageRequest {
    text: String,
    #[serde(default)]
    from: String,
}

/// When each sender last wrote, so one address cannot fill the phone.
#[derive(Debug, Default)]
pub struct Senders(Mutex<HashMap<String, Vec<Instant>>>);

impl Senders {
    fn allow(&self, sender: &str, now: Instant) -> bool {
        let mut senders = self.0.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        senders.retain(|_, sent| {
            sent.retain(|at| now.duration_since(*at) < WINDOW);
            !sent.is_empty()
        });
        let sent = senders.entry(sender.to_string()).or_default();
        if sent.len() >= PER_SENDER {
            return false;
        }
        sent.push(now);
        true
    }
}

fn clean(request: &MessageRequest) -> Result<(String, String), ApiError> {
    let text = request.text.trim();
    let from = request.from.trim();
    if text.is_empty() {
        return Err(ApiError::BadRequest("the message is empty".into()));
    }
    if text.chars().count() > MAX_TEXT || from.chars().count() > MAX_FROM {
        return Err(ApiError::BadRequest("the message is too long".into()));
    }
    Ok((text.to_string(), from.to_string()))
}

fn encode(value: &str) -> String {
    utf8_percent_encode(value, NON_ALPHANUMERIC).to_string()
}

pub async fn send(
    req: Request<hyper::body::Incoming>,
    peer: SocketAddr,
    config: &ApiConfig,
) -> hyper::Response<Body> {
    let sender = match resolve_client_ip(config.ip_source, &req, peer) {
        Ok(ip) => ip.0,
        Err(err) => return ResponseBuilder::from(err).into(),
    };
    let request: MessageRequest = match response::read_json(
        req,
        r#"expected a JSON body like {"text": "hello", "from": "a name"}"#,
    )
    .await
    {
        Ok(request) => request,
        Err(err) => return ResponseBuilder::from(err).into(),
    };
    let (text, from) = match clean(&request) {
        Ok(cleaned) => cleaned,
        Err(err) => return ResponseBuilder::from(err).into(),
    };
    let Some(topic) = config.ntfy_topic.as_deref() else {
        tracing::warn!("a message arrived but NTFY_TOPIC is not set");
        return ResponseBuilder::from(ApiError::Internal).into();
    };
    if !config.senders.allow(&sender, Instant::now()) {
        return ResponseBuilder::from(ApiError::TooManyRequests).into();
    }

    let title = if from.is_empty() {
        "Message from the site".to_string()
    } else {
        format!("Message from {from}")
    };
    let path = format!(
        "/{topic}/trigger?title={}&message={}",
        encode(&title),
        encode(&text)
    );
    match crate::http_client::https_get(&config.ntfy_host, &path, &[]).await {
        Ok((status, _, _)) if status.is_success() => {
            ResponseBuilder::new(StatusCode::NO_CONTENT).into()
        }
        Ok((status, _, _)) => {
            tracing::warn!(%status, "ntfy refused a message");
            ResponseBuilder::from(ApiError::Internal).into()
        }
        Err(err) => {
            tracing::warn!(error = %err, "failed to forward a message");
            ResponseBuilder::from(ApiError::Internal).into()
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn request(text: &str, from: &str) -> MessageRequest {
        MessageRequest {
            text: text.into(),
            from: from.into(),
        }
    }

    #[test]
    fn trims_and_keeps_a_normal_message() {
        let cleaned = clean(&request("  hello  ", " Sam ")).unwrap();
        assert_eq!(cleaned, ("hello".to_string(), "Sam".to_string()));
    }

    #[test]
    fn rejects_an_empty_message() {
        assert!(clean(&request("   ", "Sam")).is_err());
    }

    #[test]
    fn rejects_text_or_sender_over_the_limit() {
        assert!(clean(&request(&"a".repeat(MAX_TEXT + 1), "")).is_err());
        assert!(clean(&request("hello", &"a".repeat(MAX_FROM + 1))).is_err());
        assert!(clean(&request(&"a".repeat(MAX_TEXT), &"a".repeat(MAX_FROM))).is_ok());
    }

    #[test]
    fn limits_each_sender_within_the_window() {
        let senders = Senders::default();
        let start = Instant::now();
        for _ in 0..PER_SENDER {
            assert!(senders.allow("1.2.3.4", start));
        }
        assert!(!senders.allow("1.2.3.4", start));
        assert!(senders.allow("5.6.7.8", start));
    }

    #[test]
    fn forgets_a_sender_once_the_window_has_passed() {
        let senders = Senders::default();
        let start = Instant::now();
        for _ in 0..PER_SENDER {
            assert!(senders.allow("1.2.3.4", start));
        }
        assert!(senders.allow("1.2.3.4", start + WINDOW));
    }
}
