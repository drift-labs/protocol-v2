use std::{borrow::Cow, env, net::SocketAddr};

use axum::{
    extract::{Query, State},
    http::Method,
    routing::get,
    Router,
};
use axum_prometheus::PrometheusMetricLayer;
use dotenv::dotenv;
use futures_util::StreamExt;
use redis::{AsyncCommands, ScanOptions};
use serde_json::Value;
use tower_http::cors::{Any, CorsLayer};

const HASH_PREFIX: &str = "swift-hashes::*";

#[derive(Clone)]
pub struct ServerParams<T: Clone + AsyncCommands> {
    pub host: String,
    pub port: String,
    pub redis_pool: T,
}
#[derive(serde::Deserialize)]
pub struct HashQuery {
    pub hash: String,
}

#[derive(serde::Serialize, serde::Deserialize)]
pub struct HashesResponse {
    #[serde(rename = "hashes")]
    pub hashes: serde_json::Map<String, Value>,
}

pub async fn fallback(uri: axum::http::Uri) -> impl axum::response::IntoResponse {
    (axum::http::StatusCode::NOT_FOUND, format!("No route {uri}"))
}

pub async fn health_check<T: Clone + AsyncCommands>(
    State(server_params): State<ServerParams<T>>,
) -> impl axum::response::IntoResponse {
    match server_params.redis_pool.clone().ping().await {
        Ok(()) => (axum::http::StatusCode::OK, "ok"),
        Err(_) => {
            let msg = "redis_healthy=false";
            log::error!(target: "server", "Failed health check {msg}");
            (axum::http::StatusCode::PRECONDITION_FAILED, msg)
        }
    }
}

pub async fn get_all_hashes<T: Clone + AsyncCommands>(
    State(server_params): State<ServerParams<T>>,
) -> impl axum::response::IntoResponse {
    let scan_opts = ScanOptions::default()
        .with_pattern(HASH_PREFIX)
        .with_count(256);
    let mut conn = server_params.redis_pool.clone();

    let keys = match conn.scan_options::<String>(scan_opts).await {
        Ok(it) => it.collect::<Vec<String>>().await,
        Err(e) => {
            log::error!("Error scanning keys: {e:?}");
            return (
                axum::http::StatusCode::INTERNAL_SERVER_ERROR,
                "Error getting keys".to_string(),
            );
        }
    };

    if keys.is_empty() {
        return (axum::http::StatusCode::NOT_FOUND, "not found".to_string());
    }

    let values: Vec<Option<String>> = match conn.mget(&keys).await {
        Ok(values) => values,
        Err(e) => {
            log::error!("Error executing pipeline: {:?}", e);
            return (
                axum::http::StatusCode::INTERNAL_SERVER_ERROR,
                "Error getting values".to_string(),
            );
        }
    };

    let mut map = serde_json::Map::new();
    for (mut key, value) in keys.into_iter().zip(values.into_iter()) {
        if let Some(value) = value {
            if key.starts_with(HASH_PREFIX) {
                key.drain(0..HASH_PREFIX.len());
            }
            map.insert(key, serde_json::Value::String(value));
        }
    }

    match serde_json::to_string(&HashesResponse { hashes: map }) {
        Ok(json) => (axum::http::StatusCode::OK, json),
        Err(_) => (
            axum::http::StatusCode::INTERNAL_SERVER_ERROR,
            "Failed to serialize response".to_string(),
        ),
    }
}

pub async fn get_hash_status<T: Clone + AsyncCommands>(
    State(server_params): State<ServerParams<T>>,
    Query(query): Query<HashQuery>,
) -> impl axum::response::IntoResponse {
    let encoded_hash = query.hash;
    if encoded_hash.is_empty() {
        return (
            axum::http::StatusCode::BAD_REQUEST,
            Cow::Borrowed("Missing hash parameter"),
        );
    }
    let decoded_hash_result = urlencoding::decode(&encoded_hash);
    if decoded_hash_result.is_err() {
        return (
            axum::http::StatusCode::BAD_REQUEST,
            Cow::Borrowed("Invalid hash parameter"),
        );
    }

    let decoded_hash = decoded_hash_result.unwrap().to_string();

    let mut conn = server_params.redis_pool.clone();

    let redis_key = format!("swift-hashes::{}", decoded_hash);
    match conn.get::<_, Option<String>>(redis_key).await {
        Ok(Some(value)) => {
            log::info!("Value for decoded_hash {decoded_hash}: {value}");
            (axum::http::StatusCode::OK, Cow::Owned(value))
        }
        Ok(None) => {
            log::info!("No value found for key: {decoded_hash}");
            (
                axum::http::StatusCode::NOT_FOUND,
                Cow::Borrowed("not found"),
            )
        }
        Err(e) => {
            log::error!("Error: {e:?}");
            (
                axum::http::StatusCode::INTERNAL_SERVER_ERROR,
                Cow::Borrowed("error finding"),
            )
        }
    }
}

pub async fn start_server() {
    dotenv().ok();

    let elasticache_host = env::var("ELASTICACHE_HOST").unwrap_or_else(|_| "localhost".to_string());
    let elasticache_port = env::var("ELASTICACHE_PORT").unwrap_or_else(|_| "6379".to_string());
    let connection_string = if env::var("USE_SSL").unwrap_or_else(|_| "false".to_string()) == "true"
    {
        format!("rediss://{}:{}", elasticache_host, elasticache_port)
    } else {
        format!("redis://{}:{}", elasticache_host, elasticache_port)
    };

    let redis_client = redis::Client::open(connection_string).expect("valid redis URL");
    let redis_pool = redis_client
        .get_multiplexed_tokio_connection()
        .await
        .expect("redis connects");

    log::info!("Connecting to Redis via pool");

    let state = ServerParams {
        redis_pool,
        host: env::var("HOST").unwrap_or_else(|_| "0.0.0.0".to_string()),
        port: env::var("PORT").unwrap_or_else(|_| "3000".to_string()),
    };

    log::info!("Established Redis pool connection");

    let (prometheus_layer, metric_handle) = PrometheusMetricLayer::pair();
    let addr: SocketAddr = format!("{}:{}", state.host, state.port).parse().unwrap();
    let cors = CorsLayer::new()
        .allow_methods([Method::POST, Method::GET, Method::OPTIONS])
        .allow_headers(Any)
        .allow_origin(Any);
    let app = Router::new()
        .fallback(fallback)
        .route("/confirmation/health", get(health_check))
        .route("/confirmation/hash-status", get(get_hash_status))
        .route("/confirmation/hashes", get(get_all_hashes))
        .with_state(state)
        .layer(cors)
        .layer(prometheus_layer);

    let listener = tokio::net::TcpListener::bind(&addr).await.unwrap();
    log::info!(
        "Swift confirmation server on {}",
        listener.local_addr().unwrap()
    );

    // Metrics
    let metrics_addr: SocketAddr = format!(
        "0.0.0.0:{}",
        env::var("METRICS_PORT").unwrap_or("9464".to_string())
    )
    .parse()
    .unwrap();
    let metrics_app =
        Router::new().route("/metrics", get(|| async move { metric_handle.render() }));

    let listener_metrics = tokio::net::TcpListener::bind(&metrics_addr).await.unwrap();
    log::info!(
        "Swift confirmation metrics server on {}",
        listener_metrics.local_addr().unwrap()
    );

    let _ = tokio::join!(
        axum::serve(listener, app),
        axum::serve(listener_metrics, metrics_app)
    );
}

#[cfg(test)]
mod tests {
    use std::str::from_utf8;

    use axum::{body::to_bytes, http::StatusCode, response::IntoResponse};
    use futures_util::FutureExt;
    use redis::{
        aio::{ConnectionLike, MultiplexedConnection},
        RedisFuture,
    };

    use super::*;

    /// Mock redis client with broken pipe
    #[derive(Clone)]
    struct MockBrokenRedis;
    impl ConnectionLike for MockBrokenRedis {
        fn get_db(&self) -> i64 {
            0_i64
        }
        fn req_packed_command<'a>(
            &'a mut self,
            _cmd: &'a redis::Cmd,
        ) -> redis::RedisFuture<'a, redis::Value> {
            Box::pin(std::future::ready(Err(std::io::Error::new(
                std::io::ErrorKind::BrokenPipe,
                "oh no",
            )
            .into())))
        }
        fn req_packed_commands<'a>(
            &'a mut self,
            cmd: &'a redis::Pipeline,
            _offset: usize,
            _count: usize,
        ) -> RedisFuture<'a, Vec<redis::Value>> {
            (async move { cmd.exec_async(self).await.map(|_f| vec![redis::Value::Nil]) }).boxed()
        }
    }

    async fn setup_test_server() -> ServerParams<MultiplexedConnection> {
        let cli = redis::Client::open("redis://localhost:6379").expect("valid redis URL");
        let redis_pool = cli
            .get_multiplexed_tokio_connection()
            .await
            .expect("redis connects");

        ServerParams {
            host: "127.0.0.1".to_string(),
            port: "3000".to_string(),
            redis_pool,
        }
    }

    #[tokio::test]
    async fn test_health_check() {
        let state = setup_test_server().await;
        let response = health_check(State(state)).await;
        assert_eq!(response.into_response().status(), StatusCode::OK);
    }

    #[tokio::test]
    async fn test_health_check_failure() {
        let state = ServerParams {
            host: "127.0.0.1".to_string(),
            port: "3000".to_string(),
            redis_pool: MockBrokenRedis {},
        };

        let response = health_check(State(state)).await;
        let response = response.into_response();
        assert_eq!(response.status(), StatusCode::PRECONDITION_FAILED);

        let body_bytes = to_bytes(response.into_body(), 1024).await.unwrap();
        let body_str = from_utf8(&body_bytes).unwrap();
        assert_eq!(body_str, "redis_healthy=false");
    }

    #[tokio::test]
    async fn test_fallback() {
        let uri = "/not-found".parse().unwrap();
        let response = fallback(uri).await;
        assert_eq!(response.into_response().status(), StatusCode::NOT_FOUND);
    }

    #[tokio::test]
    async fn test_get_hash_status_empty_hash() {
        let state = setup_test_server().await;
        let query = HashQuery {
            hash: "".to_string(),
        };

        let response = get_hash_status(State(state), Query(query)).await;
        assert_eq!(response.into_response().status(), StatusCode::BAD_REQUEST);
    }

    #[ignore]
    #[tokio::test]
    async fn test_get_hash_status_invalid_hash() {
        let state = setup_test_server().await;
        let query = HashQuery {
            hash: "%invalid%".to_string(),
        };

        let response = get_hash_status(State(state), Query(query)).await;
        assert_eq!(response.into_response().status(), StatusCode::BAD_REQUEST);
    }

    #[tokio::test]
    async fn test_get_hash_status_not_found() {
        let state = setup_test_server().await;
        let query = HashQuery {
            hash: "nonexistent".to_string(),
        };

        let response = get_hash_status(State(state), Query(query)).await;
        assert_eq!(response.into_response().status(), StatusCode::NOT_FOUND);
    }

    #[tokio::test]
    async fn test_get_all_hashes_empty() {
        let state = setup_test_server().await;
        let response = get_all_hashes(State(state)).await;
        let response = response.into_response();

        assert_eq!(response.status(), StatusCode::OK);

        let body_bytes = to_bytes(response.into_body(), 1024).await.unwrap();
        let body_str = from_utf8(&body_bytes).unwrap();
        let response: HashesResponse = serde_json::from_str(body_str).unwrap();

        assert!(response.hashes.len() > 0);
    }
}
