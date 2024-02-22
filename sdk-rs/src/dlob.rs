// Standard Library Imports
use std::{task::Poll, time::Duration};

// External Crate Imports
use drift::state::user::MarketType;
use futures_util::{SinkExt, Stream, StreamExt};
use log::{error, info};
use reqwest::Client;
use serde::{
    de::{self},
    Deserialize, Serialize,
};
use serde_json::{json, Value};
use tokio::{
    sync::mpsc::{channel, Receiver},
    time::{Duration as TokioDuration, Instant},
};
use tokio_tungstenite::{connect_async, tungstenite::protocol::Message};

use crate::{
    types::{MarketId, SdkError, SdkResult},
    utils::dlob_subscribe_ws_json,
};

pub type L2OrderbookStream = RxStream<Result<L2Orderbook, SdkError>>;
pub type L3OrderbookStream = RxStream<Result<L3Orderbook, SdkError>>;

#[derive(Clone)]
/// Decentralized limit orderbook client
pub struct DLOBClient {
    url: String,
    client: Client,
}

impl DLOBClient {
    pub fn new(url: &str) -> Self {
        let url = url.trim_end_matches('/');

        Self {
            url: url.to_string(),
            client: Client::new(),
        }
    }
    /// Query L2 Orderbook for given `market`
    pub async fn get_l2(&self, market: MarketId) -> Result<L2Orderbook, SdkError> {
        let market_type = match market.kind {
            MarketType::Perp => "perp",
            MarketType::Spot => "spot",
        };
        let response = self
            .client
            .get(format!(
                "{}/l2?marketType={}&marketIndex={}",
                &self.url, market_type, market.index
            ))
            .send()
            .await?;
        let body = response.bytes().await?;
        serde_json::from_slice(body.as_ref()).map_err(|_| SdkError::Deserializing)
    }

    pub async fn get_l3(&self, market: MarketId) -> Result<L3Orderbook, SdkError> {
        let market_type = match market.kind {
            MarketType::Perp => "perp",
            MarketType::Spot => "spot",
        };
        let response = self
            .client
            .get(format!(
                "{}/l3?marketType={}&marketIndex={}",
                &self.url, market_type, market.index
            ))
            .send()
            .await?;
        let body = response.bytes().await?;
        serde_json::from_slice(body.as_ref()).map_err(|_| SdkError::Deserializing)
    }

    /// Subscribe to a DLOB L2 book for `market`
    pub fn subscribe_l2_book(
        &self,
        market: MarketId,
        interval_s: Option<u64>,
    ) -> L2OrderbookStream {
        let mut interval = tokio::time::interval(Duration::from_secs(interval_s.unwrap_or(1)));
        let (tx, rx) = channel(16);
        tokio::spawn({
            let client = self.clone();
            async move {
                loop {
                    let _ = interval.tick().await;
                    if tx.try_send(client.get_l2(market).await).is_err() {
                        // capacity reached or receiver closed, end the subscription task
                        break;
                    }
                }
            }
        });

        RxStream(rx)
    }

    // Subscribe to a DLOB L3 book for `market`
    pub fn subscribe_l3_book(
        &self,
        market: MarketId,
        interval_s: Option<u64>,
    ) -> L3OrderbookStream {
        let mut interval = tokio::time::interval(Duration::from_secs(interval_s.unwrap_or(1)));
        let (tx, rx) = channel(16);
        tokio::spawn({
            let client = self.clone();
            async move {
                loop {
                    let _ = interval.tick().await;
                    if tx.try_send(client.get_l3(market).await).is_err() {
                        // capacity reached or receiver closed, end the subscription task
                        break;
                    }
                }
            }
        });

        RxStream(rx)
    }

    /// Subscribe to an orderbook via WebSocket.
    pub async fn subscribe_ws(&self, market_symbol: &str) -> SdkResult<L2OrderbookStream> {
        // This unwrap should never panic
        let ws_url = crate::utils::http_to_ws(&self.url).unwrap();
        let (mut ws_stream, _) = connect_async(ws_url).await?;

        // Setup channel for L2OrderbookStream
        let (tx, rx) = channel::<SdkResult<L2Orderbook>>(16);

        let market_subscription_message = dlob_subscribe_ws_json(market_symbol);
        ws_stream
            .send(Message::Text(market_subscription_message))
            .await
            .map_err(crate::types::SinkError)?;

        let heartbeat_interval = TokioDuration::from_secs(5);
        let mut last_heartbeat = Instant::now();
        tokio::spawn(async move {
            while let Some(message) = ws_stream.next().await {
                if last_heartbeat.elapsed() > heartbeat_interval {
                    error!("Heartbeat missed!");
                    let _ = ws_stream.close(None).await;
                    let _ = tx.send(Err(SdkError::MissedHeartbeat)).await;
                    break;
                }

                match message {
                    Ok(Message::Text(text)) => {
                        let value: Value =
                            serde_json::from_str(&text).unwrap_or_else(|_| json!({}));

                        if value.get("channel").and_then(Value::as_str) == Some("heartbeat") {
                            info!("Received heartbeat");
                            last_heartbeat = Instant::now();
                        } else if let Some(channel) = value.get("channel").and_then(Value::as_str) {
                            if channel.contains("orderbook") {
                                // This unwraps because if we get bad data, we want to panic.
                                // There's nothing a user can do about it if dlob server fmt changes, etc.
                                // So it's best to panic.
                                let orderbook_data =
                                    value.get("data").and_then(Value::as_str).unwrap();
                                match serde_json::from_str::<L2Orderbook>(orderbook_data) {
                                    Ok(orderbook) => {
                                        if tx.send(Ok(orderbook)).await.is_err() {
                                            break; // Break if the receiver is dropped
                                        }
                                    }
                                    Err(_e) => {
                                        let _ = tx.send(Err(SdkError::Deserializing)).await;
                                    }
                                }
                            }
                        }
                    }
                    Ok(Message::Close(_)) => break, // Handle WebSocket close
                    Err(_) => {
                        let _ = tx.send(Err(SdkError::WebsocketError)).await;
                        break;
                    }
                    _ => {} // Handle other message types if needed
                }
            }
        });

        Ok(RxStream(rx))
    }
}

/// Simple stream wrapper over a read channel
pub struct RxStream<T>(Receiver<T>);
impl<T> Stream for RxStream<T> {
    type Item = T;
    fn poll_next(
        mut self: std::pin::Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
    ) -> Poll<Option<Self::Item>> {
        self.as_mut().0.poll_recv(cx)
    }
}

impl<T> RxStream<T> {
    /// destruct returning the inner channel
    pub fn into_rx(self) -> Receiver<T> {
        self.0
    }
}

#[derive(Debug, PartialEq, Serialize, Deserialize)]
pub struct L2Orderbook {
    /// sorted bids, highest first
    pub bids: Vec<L2Level>,
    /// sorted asks, lowest first
    pub asks: Vec<L2Level>,
    pub slot: u64,
}

#[derive(Debug, PartialEq, Serialize, Deserialize)]
pub struct L3Orderbook {
    /// sorted bids, highest first
    pub bids: Vec<L3Level>,
    /// sorted asks, lowest first
    pub asks: Vec<L3Level>,
    pub slot: u64,
}

#[derive(Debug, PartialEq, Serialize, Deserialize)]
pub struct L2Level {
    #[serde(deserialize_with = "parse_int_str")]
    pub price: i64,
    #[serde(deserialize_with = "parse_int_str")]
    pub size: i64,
}

#[derive(Debug, PartialEq, Serialize, Deserialize)]
pub struct L3Level {
    #[serde(deserialize_with = "parse_int_str")]
    pub price: i64,
    #[serde(deserialize_with = "parse_int_str")]
    pub size: i64,
    pub maker: String,
    #[serde(rename = "orderId")]
    pub order_id: u64,
}

fn parse_int_str<'de, D>(deserializer: D) -> Result<i64, D::Error>
where
    D: de::Deserializer<'de>,
{
    let s: &str = de::Deserialize::deserialize(deserializer)?;
    s.parse().map_err(de::Error::custom)
}

#[cfg(test)]
mod tests {
    use futures_util::StreamExt;

    use super::*;
    use crate::{types::Context, DriftClient, MarketExt, RpcAccountProvider};

    // this is my (frank) free helius endpoint
    const MAINNET_ENDPOINT: &str =
        "https://mainnet.helius-rpc.com/?api-key=3a1ca16d-e181-4755-9fe7-eac27579b48c";

    #[cfg(feature = "rpc_tests")]
    #[tokio::test]
    async fn pull_l2_book() {
        let url = "https://dlob.drift.trade";
        let client = DLOBClient::new(url);
        let perp_book = client.get_l2(MarketId::perp(0)).await.unwrap();
        dbg!(perp_book);
        let spot_book = client.get_l2(MarketId::spot(2)).await.unwrap();
        dbg!(spot_book);
    }

    #[cfg(feature = "rpc_tests")]
    #[tokio::test]
    async fn stream_l2_book() {
        let url = "https://dlob.drift.trade";
        let client = DLOBClient::new(url);
        let stream = client.subscribe_l2_book(MarketId::perp(0), None);
        let mut short_stream = stream.take(5);
        while let Some(book) = short_stream.next().await {
            let _ = dbg!(book);
        }
    }

    #[cfg(feature = "rpc_tests")]
    #[tokio::test]
    async fn pull_l3_book() {
        let url = "https://dlob.drift.trade";
        let client = DLOBClient::new(url);
        let perp_book = client.get_l3(MarketId::perp(0)).await.unwrap();
        dbg!(perp_book);
        let spot_book = client.get_l3(MarketId::spot(2)).await.unwrap();
        dbg!(spot_book);
    }

    #[cfg(feature = "rpc_tests")]
    #[tokio::test]
    async fn stream_l3_book() {
        let url = "https://dlob.drift.trade";
        let client = DLOBClient::new(url);
        let stream = client.subscribe_l3_book(MarketId::perp(0), None);
        let mut short_stream = stream.take(5);
        while let Some(book) = short_stream.next().await {
            let _ = dbg!(book);
        }
    }

    #[cfg(feature = "rpc_tests")]
    #[tokio::test]
    async fn subscribe_ws() {
        let client = DriftClient::new(
            Context::MainNet,
            MAINNET_ENDPOINT,
            RpcAccountProvider::new(MAINNET_ENDPOINT),
        )
        .await
        .unwrap();
        let url = "https://dlob.drift.trade";
        let dlob_client = DLOBClient::new(url);

        let market = MarketId::perp(0); // sol-perp
        let market_symbol = client
            .program_data()
            .perp_market_config_by_index(market.index)
            .unwrap()
            .symbol();

        let stream = dlob_client.subscribe_ws(market_symbol).await.unwrap();
        let mut short_stream = stream.take(5);
        while let Some(book) = short_stream.next().await {
            dbg!(book);
        }
    }
}
