mod response;

use hyper::service::service_fn;
use hyper::{Request, StatusCode};
use hyper_util::server::conn::auto;
use response::{Body, ResponseBuilder};
use smol::net::TcpListener;
use smol_hyper::rt::{FuturesIo, SmolTimer};
use tracing_subscriber::Layer;
use tracing_subscriber::layer::SubscriberExt;
use tracing_subscriber::util::SubscriberInitExt;

async fn handle(
    _req: Request<hyper::body::Incoming>,
) -> Result<hyper::Response<Body>, hyper::Error> {
    Ok(ResponseBuilder::new(StatusCode::OK)
        .text("Hello, world!\n")
        .into())
}

#[derive(Clone, Copy)]
struct SmolExec;

impl<Fut> hyper::rt::Executor<Fut> for SmolExec
where
    Fut: std::future::Future + Send + 'static,
    Fut::Output: Send + 'static,
{
    fn execute(&self, fut: Fut) {
        smol::spawn(fut).detach();
    }
}

fn main() {
    #[cfg(debug_assertions)]
    dotenvy::dotenv().ok();

    let file_appender = tracing_appender::rolling::Builder::new()
        .rotation(tracing_appender::rolling::Rotation::DAILY)
        .filename_prefix("backend")
        .filename_suffix("log")
        .build("logs")
        .expect("failed to initialize file logger");
    let (non_blocking_file, _guard) = tracing_appender::non_blocking(file_appender);

    tracing_subscriber::registry()
        .with(tracing_subscriber::fmt::layer().with_filter(tracing_subscriber::EnvFilter::from_default_env()))
        .with(
            tracing_subscriber::fmt::layer()
                .with_ansi(false)
                .with_writer(non_blocking_file)
                .with_filter(tracing_subscriber::filter::LevelFilter::TRACE),
        )
        .init();

    smol::block_on(async {
        let port = std::env::var("PORT").unwrap_or_else(|_| "3000".to_string());
        let addr = std::env::var("ADDR").unwrap_or_else(|_| "0.0.0.0".to_string());

        let listen_address = format!("{addr}:{port}");

        let listener = TcpListener::bind(&listen_address).await.unwrap();
        tracing::info!("listening on http://{listen_address}");

        loop {
            let (stream, _) = match listener.accept().await {
                Ok(s) => s,
                Err(err) => {
                    tracing::warn!(error = %err, "failed to accept connection");
                    continue;
                }
            };

            smol::spawn(async move {
                let io = FuturesIo::new(stream);
                let mut builder = auto::Builder::new(SmolExec);
                builder.http1().timer(SmolTimer::new());
                builder.http2().timer(SmolTimer::new());
                let conn = builder.serve_connection(io, service_fn(handle));

                if let Err(err) = conn.await {
                    tracing::error!(error = %err, "error serving connection");
                }
            })
            .detach();
        }
    });
}
