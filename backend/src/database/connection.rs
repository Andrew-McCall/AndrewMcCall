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

    /// Applies every pending migration from the embedded `migrations/` directory,
    /// bringing the schema up to date. Run once at startup so a freshly deployed
    /// binary carries its own schema forward without a separate migration step —
    /// `deploy.sh` relies on this, skipping its optional `sqlx migrate` when the
    /// CLI is absent. Already-applied migrations are recorded in `_sqlx_migrations`
    /// and skipped, so this is a no-op once the database is current.
    pub async fn migrate(&self) -> Result<(), sqlx::migrate::MigrateError> {
        sqlx::migrate!("./migrations").run(&self.pool).await
    }
}
