use std::sync::Arc;

use axum::extract::State;
use prometheus::{
    Counter, CounterVec, Encoder, Gauge, GaugeVec, Histogram, HistogramOpts, HistogramVec,
    IntGaugeVec, Opts, Registry, TextEncoder,
};

#[derive(Clone)]
pub struct MetricsServerParams {
    pub registry: Arc<Registry>,
}

pub async fn metrics_handler(
    State(state): State<MetricsServerParams>,
) -> impl axum::response::IntoResponse {
    let metric_families = state.registry.gather();
    let mut buffer = Vec::new();
    let encoder = TextEncoder::new();
    if let Err(e) = encoder.encode(&metric_families, &mut buffer) {
        log::error!("could not encode custom metrics: {e}");
    }
    let response = String::from_utf8(buffer).unwrap();
    axum::http::Response::builder()
        .header(
            axum::http::header::CONTENT_TYPE,
            "text/plain;version=1.0.0;charset=utf-8",
        )
        .body(response)
        .unwrap()
}

#[derive(Clone)]
pub struct SwiftServerMetrics {
    pub taker_orders_counter: Counter,
    pub order_type_counter: CounterVec,
    pub redis_publish_fail_counter: CounterVec,
    pub redis_publish_success_counter: CounterVec,
    pub redis_publish_latency: Histogram,
    pub redis_publish_subscribers: IntGaugeVec,
    pub current_slot_gauge: Gauge,
    pub rpc_simulation_status: CounterVec,
    pub response_time_histogram: Histogram,
}

impl SwiftServerMetrics {
    pub fn new() -> Self {
        let taker_orders_counter = Counter::new(
            "swift_taker_orders_count",
            "Number of taker orders received",
        )
        .unwrap();
        let order_type_counter = CounterVec::new(
            Opts::new(
                "swift_order_types_count",
                "Number of orders by market index and type",
            ),
            &["market_type", "market_index", "sanitized"],
        )
        .unwrap();
        let redis_publish_fail_counter = CounterVec::new(
            Opts::new(
                "swift_redis_publish_fail_count",
                "Number of failed Redis publishes (by topic)",
            ),
            &["topic"],
        )
        .unwrap();
        let redis_publish_success_counter = CounterVec::new(
            Opts::new(
                "swift_redis_publish_success_count",
                "Number of successful Redis publishes (by topic)",
            ),
            &["topic"],
        )
        .unwrap();
        let redis_publish_latency = Histogram::with_opts(HistogramOpts {
            common_opts: Opts::new(
                "swift_redis_publish_latency_ms",
                "Redis PUBLISH round-trip latency in ms",
            ),
            buckets: prometheus::exponential_buckets(0.5, 2.0, 10).unwrap(),
        })
        .unwrap();
        let redis_publish_subscribers = IntGaugeVec::new(
            Opts::new(
                "swift_redis_publish_subscribers",
                "Subscriber count returned by the last Redis PUBLISH (by topic)",
            ),
            &["topic"],
        )
        .unwrap();
        let current_slot_gauge = Gauge::new("swift_current_slot", "Current slot").unwrap();
        let response_time_histogram = Histogram::with_opts(HistogramOpts {
            common_opts: prometheus::Opts::new(
                "swift_process_order_duration_ms",
                "Duration of process_order function in ms",
            ),
            buckets: prometheus::exponential_buckets(1.0, 2.0, 10).unwrap(),
        })
        .unwrap();
        let rpc_simulation_status = CounterVec::new(
            Opts::new("swift_rpc_sim_status", "RPC order simulation status"),
            &["status"],
        )
        .unwrap();

        SwiftServerMetrics {
            taker_orders_counter,
            order_type_counter,
            redis_publish_fail_counter,
            redis_publish_success_counter,
            redis_publish_latency,
            redis_publish_subscribers,
            current_slot_gauge,
            rpc_simulation_status,
            response_time_histogram,
        }
    }

    pub fn register(&self, registry: &prometheus::Registry) {
        registry
            .register(Box::new(self.taker_orders_counter.clone()))
            .unwrap();
        registry
            .register(Box::new(self.order_type_counter.clone()))
            .unwrap();
        registry
            .register(Box::new(self.redis_publish_fail_counter.clone()))
            .unwrap();
        registry
            .register(Box::new(self.redis_publish_success_counter.clone()))
            .unwrap();
        registry
            .register(Box::new(self.redis_publish_latency.clone()))
            .unwrap();
        registry
            .register(Box::new(self.redis_publish_subscribers.clone()))
            .unwrap();
        registry
            .register(Box::new(self.current_slot_gauge.clone()))
            .unwrap();
        registry
            .register(Box::new(self.response_time_histogram.clone()))
            .unwrap();
        registry
            .register(Box::new(self.rpc_simulation_status.clone()))
            .unwrap();
    }
}

#[derive(Clone)]
pub struct WsServerMetrics {
    pub redis_message_forward_latency: HistogramVec,
    pub redis_messages_received: CounterVec,
    pub redis_subscriber_reconnects: Counter,
    pub ws_connections: GaugeVec,
    pub ws_outbox_size: Histogram,
    pub ws_connection_errors: CounterVec,
}

impl WsServerMetrics {
    pub fn new() -> Self {
        let redis_message_forward_latency = HistogramVec::new(
            HistogramOpts::new(
                "swift_redis_message_latency_seconds",
                "Latency of messages forwarded through Redis in seconds",
            )
            .buckets(prometheus::exponential_buckets(0.005, 2.0, 10).unwrap()),
            &["topic"],
        )
        .unwrap();
        let redis_messages_received = CounterVec::new(
            Opts::new(
                "swift_redis_messages_received_count",
                "Number of Redis pubsub messages received (by topic)",
            ),
            &["topic"],
        )
        .unwrap();
        let redis_subscriber_reconnects = Counter::new(
            "swift_redis_subscriber_reconnects_count",
            "Number of times the Redis pubsub subscriber task has restarted",
        )
        .unwrap();
        let ws_connections = GaugeVec::new(
            Opts::new("swift_ws_connections", "Number of WebSocket connections"),
            &["fast"],
        )
        .unwrap();

        let ws_outbox_size = Histogram::with_opts(
            HistogramOpts::new("swift_ws_outbox_size", "pending messages in Ws outboxes")
                .buckets(prometheus::exponential_buckets(1.0, 2.0, 6).unwrap()),
        )
        .unwrap();

        let ws_connection_errors = CounterVec::new(
            Opts::new(
                "swift_ws_connection_errors",
                "counts of Ws connection errors",
            ),
            &["type"],
        )
        .unwrap();

        WsServerMetrics {
            redis_message_forward_latency,
            redis_messages_received,
            redis_subscriber_reconnects,
            ws_connections,
            ws_outbox_size,
            ws_connection_errors,
        }
    }

    pub fn register(&self, registry: &prometheus::Registry) {
        registry
            .register(Box::new(self.redis_message_forward_latency.clone()))
            .unwrap();
        registry
            .register(Box::new(self.redis_messages_received.clone()))
            .unwrap();
        registry
            .register(Box::new(self.redis_subscriber_reconnects.clone()))
            .unwrap();
        registry
            .register(Box::new(self.ws_connections.clone()))
            .unwrap();
        registry
            .register(Box::new(self.ws_outbox_size.clone()))
            .unwrap();
        registry
            .register(Box::new(self.ws_connection_errors.clone()))
            .unwrap();
    }
}

impl Default for WsServerMetrics {
    fn default() -> Self {
        WsServerMetrics::new()
    }
}
