//! HTTP and metrics server
use std::sync::Arc;

use axum::{
    body::Body,
    extract::State,
    http::{header::CONTENT_TYPE, Response, StatusCode},
    response::{Html, IntoResponse, Json},
};
use prometheus::{
    Encoder, HistogramVec, IntCounter, IntCounterVec, IntGauge, Registry, TextEncoder,
};
use serde::{Deserialize, Serialize};
use tokio::sync::RwLock;

/// Margin status indicating liquidation risk level
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum MarginStatus {
    /// User is liquidatable (total_collateral < margin_requirement)
    Liquidatable,
    /// User is high-risk but not yet liquidatable (free margin < 20% of margin requirement)
    HighRisk,
    /// User is safe (not liquidatable and not high-risk)
    Safe,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UserMarginStatus {
    pub cross: MarginStatus,
    /// Only contains isolated positions that are high risk or liquidatable
    pub isolated: Vec<(u16, MarginStatus)>, // (market_index, status)
}

impl UserMarginStatus {
    pub fn is_liquidatable(&self) -> bool {
        self.cross == MarginStatus::Liquidatable
            || self
                .isolated
                .iter()
                .any(|(_, s)| *s == MarginStatus::Liquidatable)
    }

    pub fn is_at_risk(&self) -> bool {
        self.cross != MarginStatus::Safe || !self.isolated.is_empty()
    }
}

/// Market type for positions and oracles
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum MarketType {
    Perp,
    Spot,
}

#[derive(Debug)]
pub struct Metrics {
    pub tx_sent: IntCounterVec,
    pub tx_confirmed: IntCounterVec,
    pub tx_failed: IntCounterVec,
    pub trigger_expected: IntCounter,
    pub trigger_actual: IntCounter,
    pub fill_expected: IntCounterVec,
    pub fill_actual: IntCounterVec,
    pub liquidation_attempts: IntCounterVec,
    pub liquidation_success: IntCounterVec,
    pub liquidation_failed: IntCounterVec,
    pub liquidation_skipped: IntCounterVec,
    pub liquidation_backoff_skips: IntCounter,
    pub swap_quote_latency_ms: IntGauge,
    pub jupiter_quote_failures: IntCounter,
    pub titan_quote_failures: IntCounter,
    pub confirmation_slots: HistogramVec,
    pub cu_spent: HistogramVec,
    pub registry: Registry,
}

impl Metrics {
    pub fn new() -> Self {
        let registry = Registry::new();

        let tx_sent = IntCounterVec::new(
            prometheus::Opts::new("rfb_tx_sent_total", "Number of transactions sent"),
            &["intent"],
        )
        .unwrap();
        registry.register(Box::new(tx_sent.clone())).unwrap();

        let tx_confirmed = IntCounterVec::new(
            prometheus::Opts::new("rfb_tx_confirmed_total", "Number of transactions confirmed"),
            &["intent", "result"],
        )
        .unwrap();
        registry.register(Box::new(tx_confirmed.clone())).unwrap();

        let tx_failed = IntCounterVec::new(
            prometheus::Opts::new("rfb_tx_failed_total", "Number of transactions failed"),
            &["intent", "reason"],
        )
        .unwrap();
        registry.register(Box::new(tx_failed.clone())).unwrap();

        let fill_expected = IntCounterVec::new(
            prometheus::Opts::new("rfb_fill_expected_total", "Number of expected fills"),
            &["intent"],
        )
        .unwrap();
        registry.register(Box::new(fill_expected.clone())).unwrap();

        let fill_actual = IntCounterVec::new(
            prometheus::Opts::new("rfb_fill_actual_total", "Number of actual fills"),
            &["intent"],
        )
        .unwrap();
        registry.register(Box::new(fill_actual.clone())).unwrap();

        let trigger_expected = IntCounter::new(
            "rfb_trigger_expected_total",
            "Number of expected triggered orders",
        )
        .unwrap();
        registry
            .register(Box::new(trigger_expected.clone()))
            .unwrap();

        let trigger_actual = IntCounter::new(
            "rfb_trigger_actual_total",
            "Number of actual triggered orders",
        )
        .unwrap();
        registry.register(Box::new(trigger_actual.clone())).unwrap();

        let liquidation_attempts = IntCounterVec::new(
            prometheus::Opts::new(
                "rfb_liquidation_attempts_total",
                "Number of liquidation attempts",
            ),
            &["type"],
        )
        .unwrap();
        registry
            .register(Box::new(liquidation_attempts.clone()))
            .unwrap();

        let liquidation_success = IntCounterVec::new(
            prometheus::Opts::new(
                "rfb_liquidation_success_total",
                "Number of successful liquidations",
            ),
            &["type"],
        )
        .unwrap();
        registry
            .register(Box::new(liquidation_success.clone()))
            .unwrap();

        let liquidation_failed = IntCounterVec::new(
            prometheus::Opts::new(
                "rfb_liquidation_failed_total",
                "Number of failed liquidations",
            ),
            &["type"],
        )
        .unwrap();
        registry
            .register(Box::new(liquidation_failed.clone()))
            .unwrap();

        let liquidation_skipped = IntCounterVec::new(
            prometheus::Opts::new(
                "rfb_liquidation_skipped_total",
                "Number of liquidations skipped by reason",
            ),
            &["reason"],
        )
        .unwrap();
        registry
            .register(Box::new(liquidation_skipped.clone()))
            .unwrap();

        let liquidation_backoff_skips = IntCounter::new(
            "rfb_liquidation_backoff_skips_total",
            "Number of liquidation attempts skipped due to exponential backoff",
        )
        .unwrap();
        registry
            .register(Box::new(liquidation_backoff_skips.clone()))
            .unwrap();

        let swap_quote_latency_ms = IntGauge::new(
            "rfb_swap_quote_latency_ms",
            "Swap quote request latency in milliseconds",
        )
        .unwrap();
        registry
            .register(Box::new(swap_quote_latency_ms.clone()))
            .unwrap();

        let jupiter_quote_failures = IntCounter::new(
            "rfb_jupiter_quote_failures_total",
            "Number of Jupiter quote failures",
        )
        .unwrap();
        registry
            .register(Box::new(jupiter_quote_failures.clone()))
            .unwrap();

        let titan_quote_failures = IntCounter::new(
            "rfb_titan_quote_failures_total",
            "Number of Titan quote failures",
        )
        .unwrap();
        registry
            .register(Box::new(titan_quote_failures.clone()))
            .unwrap();

        let confirmation_slots = HistogramVec::new(
            prometheus::HistogramOpts::new(
                "rfb_tx_confirmation_slots",
                "Slots taken to confirm tx",
            ),
            &["intent"],
        )
        .unwrap();
        registry
            .register(Box::new(confirmation_slots.clone()))
            .unwrap();

        let cu_spent = HistogramVec::new(
            prometheus::HistogramOpts::new("rfb_tx_cu_spent", "Compute units spent per tx"),
            &["intent"],
        )
        .unwrap();
        registry.register(Box::new(cu_spent.clone())).unwrap();

        Self {
            tx_sent,
            tx_confirmed,
            tx_failed,
            fill_expected,
            fill_actual,
            liquidation_attempts,
            liquidation_success,
            liquidation_failed,
            liquidation_skipped,
            liquidation_backoff_skips,
            swap_quote_latency_ms,
            jupiter_quote_failures,
            titan_quote_failures,
            confirmation_slots,
            cu_spent,
            registry,
            trigger_expected,
            trigger_actual,
        }
    }
}

pub async fn metrics_handler(State(state): State<AppState>) -> impl IntoResponse {
    let metric_families = state.metrics.registry.gather();
    let mut buffer = Vec::new();
    let encoder = TextEncoder::new();
    encoder.encode(&metric_families, &mut buffer).unwrap();

    let response = String::from_utf8(buffer).unwrap();
    Response::builder()
        .header(CONTENT_TYPE, "text/plain;version=1.0.0;charset=utf-8")
        .body(response)
        .unwrap()
}

pub async fn health_handler() -> impl IntoResponse {
    Response::builder()
        .status(StatusCode::OK)
        .body(Body::empty())
        .unwrap()
}

/// Dashboard state shared between liquidator and HTTP server
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DashboardState {
    pub high_risk_users: Vec<HighRiskUser>,
    pub oracle_prices: Vec<OraclePriceInfo>,
    pub current_slot: u64,
    pub last_updated_ms: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HighRiskUser {
    pub pubkey: String,
    pub authority: String,
    pub total_collateral: i128,
    pub margin_requirement: u128,
    pub free_margin: i128,
    pub free_margin_ratio: f64,
    pub status: MarginStatus,
    pub last_updated_slot: u64,
    pub last_updated_ms: u64,
    pub positions: Vec<PositionInfo>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PositionInfo {
    pub market_type: MarketType,
    pub market_index: u16,
    pub base_asset_amount: i64,
    pub quote_asset_amount: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OraclePriceInfo {
    pub market_type: MarketType,
    pub market_index: u16,
    pub price: i64,
    pub last_updated_slot: u64,
    pub last_updated_ms: u64,
    pub age_slots: u64,
    pub age_ms: u64,
    pub is_stale: bool,
}

/// Shared dashboard state
pub type DashboardStateRef = Arc<RwLock<Option<DashboardState>>>;

/// Combined state for HTTP handlers
#[derive(Clone)]
pub struct AppState {
    pub metrics: Arc<Metrics>,
    pub dashboard_state: DashboardStateRef,
}

/// API endpoint to get dashboard data
pub async fn dashboard_api_handler(State(state): State<AppState>) -> impl IntoResponse {
    let dashboard_state = state.dashboard_state.read().await;
    match dashboard_state.as_ref() {
        Some(data) => Json(data.clone()).into_response(),
        None => (
            StatusCode::SERVICE_UNAVAILABLE,
            Json(serde_json::json!({"error": "Dashboard data not available"})),
        )
            .into_response(),
    }
}

/// Serve the dashboard HTML page
pub async fn dashboard_handler() -> Html<&'static str> {
    Html(include_str!("../static/dashboard.html"))
}
