use drift_program::state::user::MarketType;
use reqwest::Client;
use serde::{
    de::{self},
    Deserialize, Serialize,
};

use crate::types::{MarketId, SdkError};

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
    s.parse().map_err(|msg| de::Error::custom(msg))
}

#[cfg(test)]
mod tests {
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
}
