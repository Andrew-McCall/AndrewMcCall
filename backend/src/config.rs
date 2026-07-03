use crate::ip::IpSource;

/// Shared, read-only application configuration.
///
/// Built once at startup and wrapped in an `Arc` so every connection's service
/// can cheaply share it (see [`SharedConfig`]).
#[derive(Debug)]
pub struct ApiConfig {
    pub ip_source: IpSource,
}

/// Reference-counted handle to the [`ApiConfig`] passed through as request state.
pub type SharedConfig = std::sync::Arc<ApiConfig>;

impl ApiConfig {
    /// Loads configuration from the environment, falling back to sensible
    /// defaults where a value is unset.
    pub fn from_env() -> Self {
        Self {
            ip_source: IpSource::from_env().unwrap_or(IpSource::ConnectInfo),
        }
    }
}
