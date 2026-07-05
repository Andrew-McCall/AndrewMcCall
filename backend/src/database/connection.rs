use sqlx::PgPool;
#[derive(Debug)]
pub struct DatabaseConnection {
    pool: PgPool,
}

impl DatabaseConnection {
    pub fn from_env() -> Option<DatabaseConnection> {
        let url = match std::env::var("DATABASE_DSN") {
            Ok(dsn) => dsn,
            Err(_) => {
                let username = std::env::var("DATABASE_USERNAME").ok()?;
                let password = std::env::var("DATABASE_PASSWORD").ok()?;
                let host = std::env::var("DATABASE_HOST").ok()?;
                let name = std::env::var("DATABASE_NAME").ok()?;
                let port = std::env::var("DATABASE_PORT").unwrap_or_else(|_| "5432".to_string());

                format!("postgres://{username}:{password}@{host}:{port}/{name}")
            }
        };

        let pool = PgPool::connect_lazy(&url).ok()?;

        Some(DatabaseConnection { pool })
    }

    pub fn pool(&self) -> PgPool {
        self.pool.clone()
    }
}
