use std::{task::Poll, time::Duration};

use drift_program::state::user::MarketType;
use futures_util::Stream;
use reqwest::Client;
use serde::{
    de::{self},
    Deserialize, Serialize,
};
use tokio::sync::mpsc::{channel, Receiver};

use crate::types::{MarketId, SdkError};

pub type OrderbookStream = RxStream<Result<L2Orderbook, SdkError>>;

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
    /// Subscribe to a DLOB for `market`
    pub fn subscribe(&self, market: MarketId, interval_s: Option<u64>) -> OrderbookStream {
        let mut interval = tokio::time::interval(Duration::from_secs(interval_s.unwrap_or(1)));
        let (tx, rx) = channel(16);
        tokio::spawn({
            let client = self.clone();
            async move {
                loop {
                    let _ = interval.tick().await;
                    tx.try_send(client.get_l2(market).await).expect("sent");
                }
            }
        });

        RxStream(rx)
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
    bids: Vec<L2Level>,
    /// sorted asks, lowest first
    asks: Vec<L2Level>,
    slot: u64,
}

#[derive(Debug, PartialEq, Serialize, Deserialize)]
pub struct L2Level {
    #[serde(deserialize_with = "parse_int_str")]
    price: u64,
    #[serde(deserialize_with = "parse_int_str")]
    size: u64,
}

fn parse_int_str<'de, D>(deserializer: D) -> Result<u64, D::Error>
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

    #[tokio::test]
    async fn pull_l2_book() {
        let url = "https://dlob.drift.trade";
        let client = DLOBClient::new(url);
        let perp_book = client.get_l2(MarketId::perp(0)).await.unwrap();
        dbg!(perp_book);
        let spot_book = client.get_l2(MarketId::spot(2)).await.unwrap();
        dbg!(spot_book);
    }

    #[tokio::test]
    async fn stream_l2_book() {
        let url = "https://dlob.drift.trade";
        let client = DLOBClient::new(url);
        let stream = client.subscribe(MarketId::perp(0), None);
        let mut short_stream = stream.take(5);
        while let Some(book) = short_stream.next().await {
            dbg!(book);
        }
    }
}
