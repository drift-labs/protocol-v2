use serde::{Deserialize, Serialize};

use crate::router::{
    Channel, Format, JsonBinaryEncoding, JsonUpdate, PriceFeedId, PriceFeedProperty, TimestampUs,
};

#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LatestPriceRequest {
    pub price_feed_ids: Vec<PriceFeedId>,
    pub properties: Vec<PriceFeedProperty>,
    // "chains" was renamed to "formats". "chains" is still supported for compatibility.
    #[serde(alias = "chains")]
    pub formats: Vec<Format>,
    #[serde(default)]
    pub json_binary_encoding: JsonBinaryEncoding,
    /// If `true`, the stream update will contain a JSON object containing
    /// all data of the update.
    #[serde(default = "default_parsed")]
    pub parsed: bool,
    pub channel: Channel,
}

#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PriceRequest {
    pub timestamp: TimestampUs,
    pub price_feed_ids: Vec<PriceFeedId>,
    pub properties: Vec<PriceFeedProperty>,
    pub formats: Vec<Format>,
    #[serde(default)]
    pub json_binary_encoding: JsonBinaryEncoding,
    /// If `true`, the stream update will contain a JSON object containing
    /// all data of the update.
    #[serde(default = "default_parsed")]
    pub parsed: bool,
    pub channel: Channel,
}

#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReducePriceRequest {
    pub payload: JsonUpdate,
    pub price_feed_ids: Vec<PriceFeedId>,
}

pub type LatestPriceResponse = JsonUpdate;
pub type ReducePriceResponse = JsonUpdate;
pub type PriceResponse = JsonUpdate;

pub fn default_parsed() -> bool {
    true
}
