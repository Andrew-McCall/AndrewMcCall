use bytes::Bytes;
use http_body::{Body as HttpBody, Frame};
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
    #[error("method not allowed")]
    MethodNotAllowed,
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
            ApiError::MethodNotAllowed => StatusCode::METHOD_NOT_ALLOWED,
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

/// A single-frame, in-memory response body.
pub struct Body(Option<Bytes>);

impl Body {
    fn new(bytes: Bytes) -> Self {
        Self(Some(bytes))
    }

    fn empty() -> Self {
        Self(None)
    }
}

impl HttpBody for Body {
    type Data = Bytes;
    type Error = Infallible;

    fn poll_frame(
        mut self: Pin<&mut Self>,
        _cx: &mut Context<'_>,
    ) -> Poll<Option<Result<Frame<Self::Data>, Self::Error>>> {
        Poll::Ready(self.0.take().map(|bytes| Ok(Frame::data(bytes))))
    }

    fn is_end_stream(&self) -> bool {
        self.0.is_none()
    }

    fn size_hint(&self) -> http_body::SizeHint {
        match &self.0 {
            Some(bytes) => http_body::SizeHint::with_exact(bytes.len() as u64),
            None => http_body::SizeHint::with_exact(0),
        }
    }
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
