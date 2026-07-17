//! A minimal outbound HTTPS client built from crates already in the tree:
//! smol's TCP, `futures-rustls` over the rustls that sqlx pulls in, and
//! hyper's HTTP/1 client connection. One connection per request — fine for
//! the low-volume background fetches this backend makes.

use std::sync::Arc;

use bytes::Bytes;
use futures_rustls::TlsConnector;
use futures_rustls::rustls::pki_types::ServerName;
use futures_rustls::rustls::{ClientConfig, RootCertStore};
use http_body_util::{BodyExt, Empty};
use hyper::header::{HeaderName, HeaderValue};
use hyper::{HeaderMap, Request, StatusCode};
use smol_hyper::rt::FuturesIo;

#[derive(Debug, thiserror::Error)]
pub enum HttpClientError {
    #[error("invalid host {0:?}")]
    InvalidHost(String),
    #[error("connect failed: {0}")]
    Connect(#[from] std::io::Error),
    #[error("http error: {0}")]
    Http(#[from] hyper::Error),
    #[error("invalid header value")]
    InvalidHeader,
}

fn tls_config() -> Arc<ClientConfig> {
    let mut roots = RootCertStore::empty();
    roots.extend(webpki_roots::TLS_SERVER_ROOTS.iter().cloned());
    Arc::new(
        ClientConfig::builder()
            .with_root_certificates(roots)
            .with_no_client_auth(),
    )
}

/// Performs one `GET https://{host}{path}` with the given extra headers and
/// returns the status, response headers, and fully-buffered body.
pub async fn https_get(
    host: &str,
    path: &str,
    headers: &[(HeaderName, String)],
) -> Result<(StatusCode, HeaderMap, Bytes), HttpClientError> {
    let server_name = ServerName::try_from(host.to_string())
        .map_err(|_| HttpClientError::InvalidHost(host.to_string()))?;

    let tcp = smol::net::TcpStream::connect((host, 443)).await?;
    let tls = TlsConnector::from(tls_config())
        .connect(server_name, tcp)
        .await?;

    let (mut sender, conn) = hyper::client::conn::http1::handshake(FuturesIo::new(tls)).await?;
    // The connection future drives IO; it resolves once the exchange is done.
    smol::spawn(async move {
        if let Err(err) = conn.await {
            tracing::debug!(error = %err, "outbound connection ended with error");
        }
    })
    .detach();

    let mut request = Request::builder()
        .uri(path)
        .header(hyper::header::HOST, host);
    for (name, value) in headers {
        let value =
            HeaderValue::from_str(value).map_err(|_| HttpClientError::InvalidHeader)?;
        request = request.header(name, value);
    }
    let request = request
        .body(Empty::<Bytes>::new())
        .expect("static request parts are valid");

    let response = sender.send_request(request).await?;
    let (parts, body) = response.into_parts();
    let bytes = body.collect().await?.to_bytes();
    Ok((parts.status, parts.headers, bytes))
}
