//! WebSocket JSON protocol types for API the publisher provides to the router.
//! Publisher data sourcing may also be implemented in the router process,
//! eliminating WebSocket overhead.

use {
    super::router::{Price, PriceFeedId, Rate, TimestampUs},
    derive_more::derive::From,
    serde::{Deserialize, Serialize},
};

/// Represents a binary (bincode-serialized) stream update sent
/// from the publisher to the router.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PriceFeedDataV2 {
    pub price_feed_id: PriceFeedId,
    /// Timestamp of the last update provided by the source of the prices
    /// (like an exchange). If unavailable, this value is set to `publisher_timestamp_us`.
    pub source_timestamp_us: TimestampUs,
    /// Timestamp of the last update provided by the publisher.
    pub publisher_timestamp_us: TimestampUs,
    /// Last known value of the best executable price of this price feed.
    /// `None` if no value is currently available.
    pub price: Option<Price>,
    /// Last known value of the best bid price of this price feed.
    /// `None` if no value is currently available.
    pub best_bid_price: Option<Price>,
    /// Last known value of the best ask price of this price feed.
    /// `None` if no value is currently available.
    pub best_ask_price: Option<Price>,
    /// Last known value of the funding rate of this feed.
    /// `None` if no value is currently available.
    pub funding_rate: Option<Rate>,
}

/// Old Represents a binary (bincode-serialized) stream update sent
/// from the publisher to the router.
/// Superseded by `PriceFeedData`.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PriceFeedDataV1 {
    pub price_feed_id: PriceFeedId,
    /// Timestamp of the last update provided by the source of the prices
    /// (like an exchange). If unavailable, this value is set to `publisher_timestamp_us`.
    pub source_timestamp_us: TimestampUs,
    /// Timestamp of the last update provided by the publisher.
    pub publisher_timestamp_us: TimestampUs,
    /// Last known value of the best executable price of this price feed.
    /// `None` if no value is currently available.
    #[serde(with = "crate::serde_price_as_i64")]
    pub price: Option<Price>,
    /// Last known value of the best bid price of this price feed.
    /// `None` if no value is currently available.
    #[serde(with = "crate::serde_price_as_i64")]
    pub best_bid_price: Option<Price>,
    /// Last known value of the best ask price of this price feed.
    /// `None` if no value is currently available.
    #[serde(with = "crate::serde_price_as_i64")]
    pub best_ask_price: Option<Price>,
}

impl From<PriceFeedDataV1> for PriceFeedDataV2 {
    fn from(v0: PriceFeedDataV1) -> Self {
        Self {
            price_feed_id: v0.price_feed_id,
            source_timestamp_us: v0.source_timestamp_us,
            publisher_timestamp_us: v0.publisher_timestamp_us,
            price: v0.price,
            best_bid_price: v0.best_bid_price,
            best_ask_price: v0.best_ask_price,
            funding_rate: None,
        }
    }
}

/// A response sent from the server to the publisher client.
/// Currently only serde errors are reported back to the client.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize, From)]
#[serde(tag = "type")]
#[serde(rename_all = "camelCase")]
pub enum ServerResponse {
    UpdateDeserializationError(UpdateDeserializationErrorResponse),
}
/// Sent to the publisher if the binary data could not be parsed
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateDeserializationErrorResponse {
    pub error: String,
}

#[test]
fn price_feed_data_v1_serde() {
    let data = [
        1, 0, 0, 0, // price_feed_id
        2, 0, 0, 0, 0, 0, 0, 0, // source_timestamp_us
        3, 0, 0, 0, 0, 0, 0, 0, // publisher_timestamp_us
        4, 0, 0, 0, 0, 0, 0, 0, // price
        5, 0, 0, 0, 0, 0, 0, 0, // best_bid_price
        6, 2, 0, 0, 0, 0, 0, 0, // best_ask_price
    ];

    let expected = PriceFeedDataV1 {
        price_feed_id: PriceFeedId(1),
        source_timestamp_us: TimestampUs(2),
        publisher_timestamp_us: TimestampUs(3),
        price: Some(Price(4.try_into().unwrap())),
        best_bid_price: Some(Price(5.try_into().unwrap())),
        best_ask_price: Some(Price((2 * 256 + 6).try_into().unwrap())),
    };
    assert_eq!(
        bincode::deserialize::<PriceFeedDataV1>(&data).unwrap(),
        expected
    );
    assert_eq!(bincode::serialize(&expected).unwrap(), data);

    let data2 = [
        1, 0, 0, 0, // price_feed_id
        2, 0, 0, 0, 0, 0, 0, 0, // source_timestamp_us
        3, 0, 0, 0, 0, 0, 0, 0, // publisher_timestamp_us
        4, 0, 0, 0, 0, 0, 0, 0, // price
        0, 0, 0, 0, 0, 0, 0, 0, // best_bid_price
        0, 0, 0, 0, 0, 0, 0, 0, // best_ask_price
    ];
    let expected2 = PriceFeedDataV1 {
        price_feed_id: PriceFeedId(1),
        source_timestamp_us: TimestampUs(2),
        publisher_timestamp_us: TimestampUs(3),
        price: Some(Price(4.try_into().unwrap())),
        best_bid_price: None,
        best_ask_price: None,
    };
    assert_eq!(
        bincode::deserialize::<PriceFeedDataV1>(&data2).unwrap(),
        expected2
    );
    assert_eq!(bincode::serialize(&expected2).unwrap(), data2);
}

#[test]
fn price_feed_data_v2_serde() {
    let data = [
        1, 0, 0, 0, // price_feed_id
        2, 0, 0, 0, 0, 0, 0, 0, // source_timestamp_us
        3, 0, 0, 0, 0, 0, 0, 0, // publisher_timestamp_us
        1, 4, 0, 0, 0, 0, 0, 0, 0, // price
        1, 5, 0, 0, 0, 0, 0, 0, 0, // best_bid_price
        1, 6, 2, 0, 0, 0, 0, 0, 0, // best_ask_price
        0, // funding_rate
    ];

    let expected = PriceFeedDataV2 {
        price_feed_id: PriceFeedId(1),
        source_timestamp_us: TimestampUs(2),
        publisher_timestamp_us: TimestampUs(3),
        price: Some(Price(4.try_into().unwrap())),
        best_bid_price: Some(Price(5.try_into().unwrap())),
        best_ask_price: Some(Price((2 * 256 + 6).try_into().unwrap())),
        funding_rate: None,
    };
    assert_eq!(
        bincode::deserialize::<PriceFeedDataV2>(&data).unwrap(),
        expected
    );
    assert_eq!(bincode::serialize(&expected).unwrap(), data);

    let data2 = [
        1, 0, 0, 0, // price_feed_id
        2, 0, 0, 0, 0, 0, 0, 0, // source_timestamp_us
        3, 0, 0, 0, 0, 0, 0, 0, // publisher_timestamp_us
        1, 4, 0, 0, 0, 0, 0, 0, 0, // price
        0, // best_bid_price
        0, // best_ask_price
        1, 7, 3, 0, 0, 0, 0, 0, 0, // funding_rate
    ];
    let expected2 = PriceFeedDataV2 {
        price_feed_id: PriceFeedId(1),
        source_timestamp_us: TimestampUs(2),
        publisher_timestamp_us: TimestampUs(3),
        price: Some(Price(4.try_into().unwrap())),
        best_bid_price: None,
        best_ask_price: None,
        funding_rate: Some(Rate(3 * 256 + 7)),
    };
    assert_eq!(
        bincode::deserialize::<PriceFeedDataV2>(&data2).unwrap(),
        expected2
    );
    assert_eq!(bincode::serialize(&expected2).unwrap(), data2);
}
