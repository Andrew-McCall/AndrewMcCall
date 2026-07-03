use hyper::Request;
use std::net::SocketAddr;

use crate::response::ApiError;

#[derive(Clone, Debug)]
pub struct ClientIp(pub String);

#[derive(Debug, Copy, Clone)]
pub enum IpSource {
    ConnectInfo,
    Nginx,
    Cloudflare,
}

impl IpSource {
    pub fn from_env() -> Option<Self> {
        let ip_source = std::env::var("IP_SOURCE").unwrap_or_default();
        Self::parse(ip_source.to_ascii_lowercase().trim())
    }

    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "connectinfo" | "raw" => Some(Self::ConnectInfo),
            "nginx" => Some(Self::Nginx),
            "cloudflare" => Some(Self::Cloudflare),
            _ => None,
        }
    }
}

/// Resolves the client IP for `req` according to the configured [`IpSource`].
///
/// `peer` is the TCP peer address from `TcpListener::accept`; it is used only by
/// [`IpSource::ConnectInfo`], since the proxy variants read the address from a
/// trusted forwarding header instead. Returns [`ApiError::NotFound`] when the
/// expected forwarding header is missing/empty.
///
/// This replaces the axum `client_ip_middleware`: the raw hyper server has no
/// tower middleware chain, so callers invoke this at the top of their handler
/// and insert the returned [`ClientIp`] into the request extensions themselves.
pub fn resolve_client_ip<B>(
    source: IpSource,
    req: &Request<B>,
    peer: SocketAddr,
) -> Result<ClientIp, ApiError> {
    let headers = req.headers();

    let ip = match source {
        IpSource::Cloudflare => headers
            .get("cf-connecting-ip")
            .and_then(|v| v.to_str().ok())
            .map(|s| s.to_string()),
        IpSource::Nginx => headers
            .get("x-forwarded-for")
            .and_then(|v| v.to_str().ok())
            .and_then(|forwarded| forwarded.split(',').next())
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty()),
        IpSource::ConnectInfo => Some(peer.ip().to_string()),
    };

    ip.map(ClientIp)
        .ok_or_else(|| ApiError::NotFound("client IP".to_string()))
}
