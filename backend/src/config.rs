use crate::{database::connection::DatabaseConnection, ip::IpSource};

#[derive(Debug)]
pub struct ApiConfig {
    pub ip_source: IpSource,
    pub db: DatabaseConnection,
}

pub type SharedConfig = std::sync::Arc<ApiConfig>;

impl ApiConfig {
    pub fn from_env() -> Self {
        Self {
            ip_source: IpSource::from_env().unwrap_or(IpSource::ConnectInfo),
            db: DatabaseConnection::from_env()
                .expect("failed to configure database connection from environment"),
        }
    }
}
