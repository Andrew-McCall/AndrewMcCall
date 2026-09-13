use bytes::Bytes;
use http_body::{Body as HttpBody, Frame};
use smol::stream::Stream;
use http_body_util::BodyExt;
use hyper::header::{CONTENT_TYPE, HeaderName, HeaderValue};
use hyper::{HeaderMap, Request, StatusCode};
use sonic_rs::{Deserialize, Serialize};
use std::convert::Infallible;
use std::pin::Pin;
use std::task::{Context, Poll};
use thiserror::Error;

#[derive(Debug, Error)]
pub enum ApiError {
    #[error("bad request: {0}")]
    BadRequest(String),
    #[error("unauthorized")]
    Unauthorized,
    #[error("forbidden")]
    Forbidden,
    #[error("method not allowed")]
    MethodNotAllowed,
    #[error("too many failed attempts, try again later")]
    TooManyRequests,
    #[error("not found: {0}")]
    NotFound(String),
    #[error("internal server error")]
    Internal,
    #[error("internal server error")]
    Serialization(#[from] sonic_rs::Error),
}

impl ApiError {
    fn status_code(&self) -> StatusCode {
        match self {
            ApiError::BadRequest(_) => StatusCode::BAD_REQUEST,
            ApiError::Unauthorized => StatusCode::UNAUTHORIZED,
            ApiError::Forbidden => StatusCode::FORBIDDEN,
            ApiError::MethodNotAllowed => StatusCode::METHOD_NOT_ALLOWED,
            ApiError::TooManyRequests => StatusCode::TOO_MANY_REQUESTS,
            ApiError::NotFound(_) => StatusCode::NOT_FOUND,
            ApiError::Internal => StatusCode::INTERNAL_SERVER_ERROR,
            ApiError::Serialization(_) => StatusCode::INTERNAL_SERVER_ERROR,
        }
    }
}

#[derive(Serialize)]
struct ErrorBody {
    error: String,
}

/// Buffers a request body fully into memory, mapping a transport error to a
/// `400 Bad Request`. For small bodies only — the whole body is collected.
pub async fn read_body(req: Request<hyper::body::Incoming>) -> Result<Bytes, ApiError> {
    match req.into_body().collect().await {
        Ok(collected) => Ok(collected.to_bytes()),
        Err(err) => {
            tracing::warn!(error = %err, "failed to read request body");
            Err(ApiError::BadRequest("could not read body".into()))
        }
    }
}

/// Reads a request body and deserializes it from JSON. A read failure or invalid
/// JSON becomes a `400 Bad Request` carrying `invalid_body`, which should
/// describe the expected shape.
pub async fn read_json<T>(
    req: Request<hyper::body::Incoming>,
    invalid_body: &'static str,
) -> Result<T, ApiError>
where
    T: for<'de> Deserialize<'de>,
{
    let body = read_body(req).await?;
    sonic_rs::from_slice(&body).map_err(|_| ApiError::BadRequest(invalid_body.into()))
}

/// A response body: either one complete buffer, or a stream of frames.
pub enum Body {
    /// One complete buffer — every ordinary response.
    Once(Option<Bytes>),
    /// Frames as they are produced, for the event streams.
    Stream {
        /// Pinned on the heap: a channel receiver holds an event listener and
        /// so cannot be moved once polled.
        frames: Pin<Box<smol::channel::Receiver<Bytes>>>,
        /// Held for as long as the body lives, and dropped with it. See
        /// [`Body::stream`].
        _held: Box<dyn Send>,
    },
}

impl Body {
    /// A body that streams frames as they are sent, ending when every sender is
    /// dropped.
    ///
    /// `held` is dropped along with the body. Hyper drops a response body when
    /// its connection ends, so whatever owns the other end of this stream can
    /// learn about a closed tab, a slept laptop and a lost connection through
    /// that one path rather than by timing anything out.
    pub fn stream(frames: smol::channel::Receiver<Bytes>, held: Box<dyn Send>) -> Self {
        Self::Stream {
            frames: Box::pin(frames),
            _held: held,
        }
    }

    fn new(bytes: Bytes) -> Self {
        Self::Once(Some(bytes))
    }

    fn empty() -> Self {
        Self::Once(None)
    }
}

impl HttpBody for Body {
    type Data = Bytes;
    type Error = Infallible;

    fn poll_frame(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
    ) -> Poll<Option<Result<Frame<Self::Data>, Self::Error>>> {
        match &mut *self {
            Body::Once(bytes) => Poll::Ready(bytes.take().map(|bytes| Ok(Frame::data(bytes)))),
            Body::Stream { frames, .. } => frames
                .as_mut()
                .poll_next(cx)
                .map(|frame| frame.map(|bytes| Ok(Frame::data(bytes)))),
        }
    }

    fn is_end_stream(&self) -> bool {
        match self {
            Body::Once(bytes) => bytes.is_none(),
            // A stream ends when its senders are dropped, which cannot be known
            // ahead of the next poll.
            Body::Stream { .. } => false,
        }
    }

    fn size_hint(&self) -> http_body::SizeHint {
        match self {
            Body::Once(Some(bytes)) => http_body::SizeHint::with_exact(bytes.len() as u64),
            Body::Once(None) => http_body::SizeHint::with_exact(0),
            Body::Stream { .. } => http_body::SizeHint::default(),
        }
    }
}

/// Builds an event-stream response around `frames`.
///
/// The headers are all about buffering: an event stream that any hop decides to
/// buffer is a stream that delivers nothing until it ends, which for a live call
/// means never. `x-accel-buffering` is nginx's own switch, set here so the
/// behaviour travels with the response rather than living only in a vhost file.
pub fn event_stream(
    frames: smol::channel::Receiver<Bytes>,
    held: Box<dyn Send>,
) -> hyper::Response<Body> {
    let mut response = hyper::Response::new(Body::stream(frames, held));
    let headers = response.headers_mut();
    headers.insert(
        hyper::header::CONTENT_TYPE,
        HeaderValue::from_static("text/event-stream"),
    );
    headers.insert(
        hyper::header::CACHE_CONTROL,
        HeaderValue::from_static("no-cache"),
    );
    headers.insert("x-accel-buffering", HeaderValue::from_static("no"));
    response
}

struct ResponseContent {
    content_type: &'static str,
    bytes: Bytes,
}

pub struct ResponseBuilder {
    status: StatusCode,
    headers: HeaderMap,
    content: Option<ResponseContent>,
}

impl ResponseBuilder {
    pub fn new(status: StatusCode) -> Self {
        Self {
            status,
            headers: HeaderMap::new(),
            content: None,
        }
    }

    pub fn headers_mut(&mut self) -> &mut HeaderMap {
        &mut self.headers
    }

    pub fn header(mut self, name: HeaderName, value: HeaderValue) -> Self {
        self.headers_mut().insert(name, value);
        self
    }

    /// Appends a `Set-Cookie` header. Uses `append` (not `insert`) so several
    /// cookies can be set on one response. The value must be a valid header
    /// string (ASCII); a malformed cookie is dropped with a warning rather than
    /// failing the response.
    pub fn set_cookie(mut self, cookie: impl AsRef<str>) -> Self {
        match HeaderValue::from_str(cookie.as_ref()) {
            Ok(value) => {
                self.headers_mut().append(hyper::header::SET_COOKIE, value);
            }
            Err(err) => tracing::warn!(error = %err, "invalid Set-Cookie value"),
        }
        self
    }

    fn with_content(mut self, content_type: &'static str, bytes: Bytes) -> Self {
        self.content = Some(ResponseContent {
            content_type,
            bytes,
        });
        self
    }

    pub fn json<T: Serialize>(self, value: &T) -> Self {
        match sonic_rs::to_vec(value) {
            Ok(bytes) => self.with_content("application/json", Bytes::from(bytes)),
            Err(err) => {
                tracing::error!(error = %err, "failed to serialize json response body");
                self.error(ApiError::Serialization(err))
            }
        }
    }

    pub fn svg(self, bytes: impl Into<Bytes>) -> Self {
        self.with_content("image/svg+xml", bytes.into())
    }

    pub fn xml(self, xml: impl Into<String>) -> Self {
        self.with_content("application/xml; charset=utf-8", Bytes::from(xml.into()))
    }

    pub fn html(self, html: impl Into<String>) -> Self {
        self.with_content("text/html; charset=utf-8", Bytes::from(html.into()))
    }

    pub fn text(self, text: impl Into<String>) -> Self {
        self.with_content("text/plain; charset=utf-8", Bytes::from(text.into()))
    }

    pub fn empty(mut self) -> Self {
        self.content = None;
        self
    }

    pub fn error(mut self, error: ApiError) -> Self {
        self.status = error.status_code();
        let body = ErrorBody {
            error: error.to_string(),
        };
        self.json(&body)
    }
}

impl From<ApiError> for ResponseBuilder {
    fn from(error: ApiError) -> Self {
        ResponseBuilder::new(error.status_code()).error(error)
    }
}

fn allows_body(status: StatusCode) -> bool {
    !status.is_informational()
        && status != StatusCode::NO_CONTENT
        && status != StatusCode::NOT_MODIFIED
}

impl From<ResponseBuilder> for hyper::Response<Body> {
    fn from(builder: ResponseBuilder) -> Self {
        let content = builder.content.filter(|_| allows_body(builder.status));
        let content_type = content.as_ref().map(|c| c.content_type);

        let body = match content {
            Some(content) => Body::new(content.bytes),
            None => Body::empty(),
        };

        let mut response = hyper::Response::new(body);
        *response.status_mut() = builder.status;

        if let Some(content_type) = content_type {
            response
                .headers_mut()
                .insert(CONTENT_TYPE, HeaderValue::from_static(content_type));
        }
        response.headers_mut().extend(builder.headers);
        response
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use http_body_util::BodyExt;

    #[test]
    fn a_stream_body_yields_each_frame_sent() {
        let (frames, rx) = smol::channel::unbounded();
        let mut body = Body::stream(rx, Box::new(()));
        frames
            .try_send(Bytes::from("event: ping\n\n"))
            .expect("the body is listening");

        let frame = smol::block_on(body.frame())
            .expect("a frame should arrive")
            .expect("frames never error");

        assert_eq!(
            frame.into_data().unwrap(),
            Bytes::from("event: ping\n\n")
        );
    }

    #[test]
    fn a_stream_body_ends_when_its_sender_is_dropped() {
        let (frames, rx) = smol::channel::unbounded::<Bytes>();
        let mut body = Body::stream(rx, Box::new(()));

        drop(frames);

        assert!(
            smol::block_on(body.frame()).is_none(),
            "a stream with no senders left must end, not hang"
        );
    }

    #[test]
    fn dropping_a_stream_body_drops_what_it_holds() {
        use std::sync::Arc;
        use std::sync::atomic::{AtomicBool, Ordering};

        struct Held(Arc<AtomicBool>);
        impl Drop for Held {
            fn drop(&mut self) {
                self.0.store(true, Ordering::SeqCst);
            }
        }

        let dropped = Arc::new(AtomicBool::new(false));
        let (_frames, rx) = smol::channel::unbounded::<Bytes>();
        let body = Body::stream(rx, Box::new(Held(dropped.clone())));
        assert!(!dropped.load(Ordering::SeqCst));

        drop(body);

        assert!(
            dropped.load(Ordering::SeqCst),
            "removing a peer depends on the body dropping what it holds"
        );
    }

    #[test]
    fn an_event_stream_asks_every_hop_not_to_buffer_it() {
        let (_frames, rx) = smol::channel::unbounded();

        let response = event_stream(rx, Box::new(()));

        let headers = response.headers();
        assert_eq!(headers[hyper::header::CONTENT_TYPE], "text/event-stream");
        assert_eq!(headers[hyper::header::CACHE_CONTROL], "no-cache");
        assert_eq!(headers["x-accel-buffering"], "no");
    }
}
