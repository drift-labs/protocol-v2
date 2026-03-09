use std::{
    cmp::Ordering,
    convert::TryFrom,
    fmt::Display,
    ops::{Deref, DerefMut},
};

use derive_more::From;
use itertools::Itertools as _;
use serde::{de::Error, Deserialize, Serialize};

use crate::{
    payload::AggregatedPriceFeedData,
    time::{DurationUs, FixedRate, TimestampUs},
    ChannelId, Price, PriceFeedId, PriceFeedProperty, Rate,
};

#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LatestPriceRequestRepr {
    /// List of feed IDs.
    /// Either feed ids or symbols must be specified.
    pub price_feed_ids: Option<Vec<PriceFeedId>>,
    /// List of feed symbols.
    /// Either feed ids or symbols must be specified.
    pub symbols: Option<Vec<String>>,
    /// List of feed properties the sender is interested in.
    pub properties: Vec<PriceFeedProperty>,
    // "chains" was renamed to "formats". "chains" is still supported for compatibility.
    /// Requested formats of the payload.
    #[serde(alias = "chains")]
    pub formats: Vec<Format>,
    #[serde(default)]
    pub json_binary_encoding: JsonBinaryEncoding,
    /// If `true`, the response will contain a JSON object containing
    /// all data of the update.
    #[serde(default = "default_parsed")]
    pub parsed: bool,
    /// Channel determines frequency of updates.
    pub channel: Channel,
}

#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LatestPriceRequest(LatestPriceRequestRepr);

impl<'de> Deserialize<'de> for LatestPriceRequest {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        let value = LatestPriceRequestRepr::deserialize(deserializer)?;
        Self::new(value).map_err(Error::custom)
    }
}

impl LatestPriceRequest {
    pub fn new(value: LatestPriceRequestRepr) -> Result<Self, &'static str> {
        validate_price_feed_ids_or_symbols(&value.price_feed_ids, &value.symbols)?;
        validate_optional_nonempty_vec_has_unique_elements(
            &value.price_feed_ids,
            "no price feed ids specified",
            "duplicate price feed ids specified",
        )?;
        validate_optional_nonempty_vec_has_unique_elements(
            &value.symbols,
            "no symbols specified",
            "duplicate symbols specified",
        )?;
        validate_formats(&value.formats)?;
        validate_properties(&value.properties)?;
        Ok(Self(value))
    }
}

impl Deref for LatestPriceRequest {
    type Target = LatestPriceRequestRepr;

    fn deref(&self) -> &Self::Target {
        &self.0
    }
}
impl DerefMut for LatestPriceRequest {
    fn deref_mut(&mut self) -> &mut Self::Target {
        &mut self.0
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PriceRequestRepr {
    /// Requested timestamp of the update.
    pub timestamp: TimestampUs,
    /// List of feed IDs.
    /// Either feed ids or symbols must be specified.
    pub price_feed_ids: Option<Vec<PriceFeedId>>,
    /// List of feed symbols.
    /// Either feed ids or symbols must be specified.
    pub symbols: Option<Vec<String>>,
    /// List of feed properties the sender is interested in.
    pub properties: Vec<PriceFeedProperty>,
    /// Requested formats of the payload.
    pub formats: Vec<Format>,
    #[serde(default)]
    pub json_binary_encoding: JsonBinaryEncoding,
    /// If `true`, the stream update will contain a JSON object containing
    /// all data of the update.
    #[serde(default = "default_parsed")]
    pub parsed: bool,
    /// Channel determines frequency of updates.
    pub channel: Channel,
}

#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PriceRequest(PriceRequestRepr);

impl<'de> Deserialize<'de> for PriceRequest {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        let value = PriceRequestRepr::deserialize(deserializer)?;
        Self::new(value).map_err(Error::custom)
    }
}

impl PriceRequest {
    pub fn new(value: PriceRequestRepr) -> Result<Self, &'static str> {
        validate_price_feed_ids_or_symbols(&value.price_feed_ids, &value.symbols)?;
        validate_optional_nonempty_vec_has_unique_elements(
            &value.price_feed_ids,
            "no price feed ids specified",
            "duplicate price feed ids specified",
        )?;
        validate_optional_nonempty_vec_has_unique_elements(
            &value.symbols,
            "no symbols specified",
            "duplicate symbols specified",
        )?;
        validate_formats(&value.formats)?;
        validate_properties(&value.properties)?;
        Ok(Self(value))
    }
}

impl Deref for PriceRequest {
    type Target = PriceRequestRepr;

    fn deref(&self) -> &Self::Target {
        &self.0
    }
}
impl DerefMut for PriceRequest {
    fn deref_mut(&mut self) -> &mut Self::Target {
        &mut self.0
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReducePriceRequest {
    /// Feed update previously received from WebSocket or from "Fetch price"
    /// or "Fetch latest price" endpoints.
    pub payload: JsonUpdate,
    /// List of feeds that should be preserved in the output update.
    pub price_feed_ids: Vec<PriceFeedId>,
}

pub type LatestPriceResponse = JsonUpdate;
pub type ReducePriceResponse = JsonUpdate;
pub type PriceResponse = JsonUpdate;

pub fn default_parsed() -> bool {
    true
}

pub fn schema_default_symbols() -> Option<Vec<String>> {
    None
}
pub fn schema_default_price_feed_ids() -> Option<Vec<PriceFeedId>> {
    Some(vec![PriceFeedId(1)])
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum DeliveryFormat {
    /// Deliver stream updates as JSON text messages.
    #[default]
    Json,
    /// Deliver stream updates as binary messages.
    Binary,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Format {
    Evm,
    Solana,
    LeEcdsa,
    LeUnsigned,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum JsonBinaryEncoding {
    #[default]
    Base64,
    Hex,
}

#[derive(Serialize, Deserialize)]
pub enum ChannelSchemaRepr {
    #[serde(rename = "real_time")]
    RealTime,
    #[serde(rename = "fixed_rate@50ms")]
    FixedRate50ms,
    #[serde(rename = "fixed_rate@200ms")]
    FixedRate200ms,
    #[serde(rename = "fixed_rate@1000ms")]
    FixedRate1000ms,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, From)]
pub enum Channel {
    FixedRate(FixedRate),
    RealTime,
}

impl PartialOrd for Channel {
    fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
        let rate_left = match self {
            Channel::FixedRate(rate) => rate.duration().as_micros(),
            Channel::RealTime => FixedRate::MIN.duration().as_micros(),
        };
        let rate_right = match other {
            Channel::FixedRate(rate) => rate.duration().as_micros(),
            Channel::RealTime => FixedRate::MIN.duration().as_micros(),
        };
        Some(rate_left.cmp(&rate_right))
    }
}

impl Serialize for Channel {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        match self {
            Channel::FixedRate(fixed_rate) => serializer.serialize_str(&format!(
                "fixed_rate@{}ms",
                fixed_rate.duration().as_millis()
            )),
            Channel::RealTime => serializer.serialize_str("real_time"),
        }
    }
}

impl Display for Channel {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Channel::FixedRate(fixed_rate) => {
                write!(f, "fixed_rate@{}ms", fixed_rate.duration().as_millis())
            }
            Channel::RealTime => write!(f, "real_time"),
        }
    }
}

impl Channel {
    pub fn id(&self) -> ChannelId {
        match self {
            Channel::FixedRate(fixed_rate) => match fixed_rate.duration().as_millis() {
                50 => ChannelId::FIXED_RATE_50,
                200 => ChannelId::FIXED_RATE_200,
                1000 => ChannelId::FIXED_RATE_1000,
                _ => panic!("unknown channel: {self:?}"),
            },
            Channel::RealTime => ChannelId::REAL_TIME,
        }
    }
}

#[test]
fn id_supports_all_fixed_rates() {
    for rate in FixedRate::ALL {
        Channel::FixedRate(rate).id();
    }
}

fn parse_channel(value: &str) -> Option<Channel> {
    if value == "real_time" {
        Some(Channel::RealTime)
    } else if let Some(rest) = value.strip_prefix("fixed_rate@") {
        let ms_value = rest.strip_suffix("ms")?;
        Some(Channel::FixedRate(FixedRate::from_millis(
            ms_value.parse().ok()?,
        )?))
    } else {
        None
    }
}

impl<'de> Deserialize<'de> for Channel {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        let value = <String>::deserialize(deserializer)?;
        parse_channel(&value).ok_or_else(|| Error::custom("unknown channel"))
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SubscriptionParamsRepr {
    /// List of feed IDs.
    /// Either feed ids or symbols must be specified.
    pub price_feed_ids: Option<Vec<PriceFeedId>>,
    /// List of feed symbols.
    /// Either feed ids or symbols must be specified.
    pub symbols: Option<Vec<String>>,
    /// List of feed properties the sender is interested in.
    pub properties: Vec<PriceFeedProperty>,
    /// Requested formats of the payload.
    /// As part of each feed update, the server will send on-chain payloads required
    /// to validate these price updates on the specified chains.
    #[serde(alias = "chains")]
    pub formats: Vec<Format>,
    /// If `json` is selected, the server will send price updates as JSON objects
    /// (the on-chain payload will be encoded according to the `jsonBinaryEncoding` property).
    /// If `binary` is selected, the server will send price updates as binary messages.
    #[serde(default)]
    pub delivery_format: DeliveryFormat,
    /// For `deliveryFormat == "json"`, the on-chain payload will be encoded using the specified encoding.
    /// This option has no effect for  `deliveryFormat == "binary"`.
    #[serde(default)]
    pub json_binary_encoding: JsonBinaryEncoding,
    /// If `true`, the stream update will contain a `parsed` JSON field containing
    /// all data of the update.
    #[serde(default = "default_parsed")]
    pub parsed: bool,
    /// Channel determines frequency of updates.
    pub channel: Channel,
    /// If true, the subscription will ignore invalid feed IDs and subscribe to any valid feeds.
    /// Otherwise, the entire subscription will fail if any feed is invalid.
    #[serde(default, alias = "ignoreInvalidFeedIds")]
    pub ignore_invalid_feeds: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SubscriptionParams(SubscriptionParamsRepr);

impl<'de> Deserialize<'de> for SubscriptionParams {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        let value = SubscriptionParamsRepr::deserialize(deserializer)?;
        Self::new(value).map_err(Error::custom)
    }
}

impl SubscriptionParams {
    pub fn new(value: SubscriptionParamsRepr) -> Result<Self, &'static str> {
        validate_price_feed_ids_or_symbols(&value.price_feed_ids, &value.symbols)?;
        validate_optional_nonempty_vec_has_unique_elements(
            &value.price_feed_ids,
            "no price feed ids specified",
            "duplicate price feed ids specified",
        )?;
        validate_optional_nonempty_vec_has_unique_elements(
            &value.symbols,
            "no symbols specified",
            "duplicate symbols specified",
        )?;
        validate_formats(&value.formats)?;
        validate_properties(&value.properties)?;
        Ok(Self(value))
    }
}

impl Deref for SubscriptionParams {
    type Target = SubscriptionParamsRepr;

    fn deref(&self) -> &Self::Target {
        &self.0
    }
}
impl DerefMut for SubscriptionParams {
    fn deref_mut(&mut self) -> &mut Self::Target {
        &mut self.0
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JsonBinaryData {
    /// Encoding of the data. It will be the same as `jsonBinaryEncoding` specified in the `SubscriptionRequest`.
    pub encoding: JsonBinaryEncoding,
    /// Binary data encoded in base64 or hex, depending on the requested encoding.
    pub data: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JsonUpdate {
    /// Parsed representation of the price update.
    /// Present unless `parsed = false` is specified in subscription params.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub parsed: Option<ParsedPayload>,
    /// Signed on-chain payload for EVM. Only present if `Evm` is present in `formats` in subscription params.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub evm: Option<JsonBinaryData>,
    /// Signed on-chain payload for Solana. Only present if `Solana` is present in `formats` in subscription params.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub solana: Option<JsonBinaryData>,
    /// Signed binary payload for off-chain verification. Only present if `LeEcdsa` is present in `formats` in subscription params.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub le_ecdsa: Option<JsonBinaryData>,
    /// Unsigned binary payload. Only present if `LeUnsigned` is present in `formats` in subscription params.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub le_unsigned: Option<JsonBinaryData>,
}

#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ParsedPayload {
    /// Unix timestamp associated with the update (with microsecond precision).
    #[serde(with = "crate::serde_str::timestamp")]
    pub timestamp_us: TimestampUs,
    /// Values of the update for each feed.
    pub price_feeds: Vec<ParsedFeedPayload>,
}

/// Parsed representation of a feed update.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ParsedFeedPayload {
    /// Feed ID.
    pub price_feed_id: PriceFeedId,
    /// For price feeds: main price. For funding rate feeds: funding price.
    /// Only present if the `price` property was specified
    /// in the `SubscriptionRequest` and the value is currently available for this price feed.
    #[serde(skip_serializing_if = "Option::is_none")]
    #[serde(with = "crate::serde_str::option_price")]
    #[serde(default)]
    pub price: Option<Price>,
    /// Best bid price for this price feed. Only present if the `bestBidPrice` property
    /// was specified in the `SubscriptionRequest` and this is a price feed and
    /// the value is currently available for this price feed.
    #[serde(skip_serializing_if = "Option::is_none")]
    #[serde(with = "crate::serde_str::option_price")]
    #[serde(default)]
    pub best_bid_price: Option<Price>,
    /// Best ask price for this price feed. Only present if the `bestAskPrice` property was
    /// specified in the `SubscriptionRequest` and this is a price feed and
    /// the value is currently available for this price feed.
    #[serde(skip_serializing_if = "Option::is_none")]
    #[serde(with = "crate::serde_str::option_price")]
    #[serde(default)]
    pub best_ask_price: Option<Price>,
    /// Number of publishers contributing to this feed update. Only present if the `publisherCount`
    /// property was specified in the `SubscriptionRequest`.
    #[serde(skip_serializing_if = "Option::is_none")]
    #[serde(default)]
    pub publisher_count: Option<u16>,
    /// Exponent for this feed. Only present if the `exponent` property was specified
    /// in the `SubscriptionRequest`. Each decimal field provided by the feed (price, fundingRate, etc)
    /// returns the mantissa of the value. The actual value can be calculated as
    /// `mantissa * 10^exponent`.
    #[serde(skip_serializing_if = "Option::is_none")]
    #[serde(default)]
    pub exponent: Option<i16>,
    /// Confidence for this price feed. Only present if the `confidence` property was
    /// specified in the `SubscriptionRequest` and this is a price feed and
    /// the value is currently available for this price feed.
    #[serde(skip_serializing_if = "Option::is_none")]
    #[serde(default)]
    pub confidence: Option<Price>,
    /// Perpetual future funding rate for this feed.
    /// Only present if the `fundingRate` property was specified in the `SubscriptionRequest`
    /// and this is a funding rate feed
    /// and the value is currently available for this price feed.
    #[serde(skip_serializing_if = "Option::is_none")]
    #[serde(default)]
    pub funding_rate: Option<Rate>,
    /// Most recent perpetual future funding rate timestamp for this feed.
    /// Only present if the `fundingTimestamp` property was specified in the `SubscriptionRequest`
    /// and this is a funding rate feed
    /// and the value is currently available for this price feed.
    #[serde(skip_serializing_if = "Option::is_none")]
    #[serde(default)]
    pub funding_timestamp: Option<TimestampUs>,
    /// Duration, in microseconds, between consecutive funding rate updates for this price feed.
    /// Only present if the `fundingRateInterval` property was requested in the `SubscriptionRequest`
    /// and this is a funding rate feed and the value is defined for that feed.
    #[serde(skip_serializing_if = "Option::is_none")]
    #[serde(default)]
    pub funding_rate_interval: Option<DurationUs>,
    /// Market session for this price feed. Only present if the `marketSession` property was specified
    /// in the `SubscriptionRequest`.
    #[serde(skip_serializing_if = "Option::is_none")]
    #[serde(default)]
    pub market_session: Option<MarketSession>,
    /// Exponential moving average of the main price for this price feeds.
    /// Only present if the `emaPrice` property was specified
    /// in the `SubscriptionRequest`  and this is a price feed
    /// and the value is currently available for this price feed.
    #[serde(skip_serializing_if = "Option::is_none")]
    #[serde(with = "crate::serde_str::option_price")]
    #[serde(default)]
    pub ema_price: Option<Price>,
    /// Exponential moving average of the confidence for this price feeds.
    /// Only present if the `emaConfidence` property was specified
    /// in the `SubscriptionRequest`  and this is a price feed
    /// and the value is currently available for this price feed.
    #[serde(skip_serializing_if = "Option::is_none")]
    #[serde(default)]
    pub ema_confidence: Option<Price>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[serde(default)]
    pub feed_update_timestamp: Option<TimestampUs>,
    // More fields may be added later.
}

impl ParsedFeedPayload {
    pub fn new(
        price_feed_id: PriceFeedId,
        data: &AggregatedPriceFeedData,
        properties: &[PriceFeedProperty],
    ) -> Self {
        let mut output = Self {
            price_feed_id,
            price: None,
            best_bid_price: None,
            best_ask_price: None,
            publisher_count: None,
            exponent: None,
            confidence: None,
            funding_rate: None,
            funding_timestamp: None,
            funding_rate_interval: None,
            market_session: None,
            ema_price: None,
            ema_confidence: None,
            feed_update_timestamp: None,
        };
        for &property in properties {
            match property {
                PriceFeedProperty::Price => {
                    output.price = data.price;
                }
                PriceFeedProperty::BestBidPrice => {
                    output.best_bid_price = data.best_bid_price;
                }
                PriceFeedProperty::BestAskPrice => {
                    output.best_ask_price = data.best_ask_price;
                }
                PriceFeedProperty::PublisherCount => {
                    output.publisher_count = Some(data.publisher_count);
                }
                PriceFeedProperty::Exponent => {
                    output.exponent = Some(data.exponent);
                }
                PriceFeedProperty::Confidence => {
                    output.confidence = data.confidence;
                }
                PriceFeedProperty::FundingRate => {
                    output.funding_rate = data.funding_rate;
                }
                PriceFeedProperty::FundingTimestamp => {
                    output.funding_timestamp = data.funding_timestamp;
                }
                PriceFeedProperty::FundingRateInterval => {
                    output.funding_rate_interval = data.funding_rate_interval;
                }
                PriceFeedProperty::MarketSession => {
                    output.market_session = Some(data.market_session);
                }
                PriceFeedProperty::EmaPrice => {
                    output.ema_price = data.ema_price;
                }
                PriceFeedProperty::EmaConfidence => {
                    output.ema_confidence = data.ema_confidence;
                }
                PriceFeedProperty::FeedUpdateTimestamp => {
                    output.feed_update_timestamp = data.feed_update_timestamp;
                }
            }
        }
        output
    }

    pub fn new_full(
        price_feed_id: PriceFeedId,
        exponent: Option<i16>,
        data: &AggregatedPriceFeedData,
    ) -> Self {
        Self {
            price_feed_id,
            price: data.price,
            best_bid_price: data.best_bid_price,
            best_ask_price: data.best_ask_price,
            publisher_count: Some(data.publisher_count),
            exponent,
            confidence: data.confidence,
            funding_rate: data.funding_rate,
            funding_timestamp: data.funding_timestamp,
            funding_rate_interval: data.funding_rate_interval,
            market_session: Some(data.market_session),
            ema_price: data.ema_price,
            ema_confidence: data.ema_confidence,
            feed_update_timestamp: data.feed_update_timestamp,
        }
    }
}

/// A WebSocket JSON message sent from the client to the server.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(tag = "type")]
#[serde(rename_all = "camelCase")]
pub enum WsRequest {
    Subscribe(SubscribeRequest),
    Unsubscribe(UnsubscribeRequest),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
pub struct SubscriptionId(pub u64);

/// A subscription request.
///
/// After a successful subscription, the server will respond with a `SubscribedResponse`
/// or `SubscribedWithInvalidFeedIdsIgnoredResponse` message,
/// followed by `StreamUpdatedResponse` messages.
/// If a subscription cannot be made, the server will respond with a `SubscriptionError`
/// message containing the error message.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SubscribeRequest {
    /// A number chosen by the client to identify the new subscription.
    /// This identifier will be sent back in any responses related to this subscription.
    pub subscription_id: SubscriptionId,
    /// Properties of the new subscription.
    #[serde(flatten)]
    pub params: SubscriptionParams,
}

/// An unsubscription request.
///
/// After a successful unsubscription, the server will respond with a `UnsubscribedResponse` message
/// and stop sending `SubscriptionErrorResponse` messages for that subscription.
/// If the unsubscription cannot be made, the server will respond with a `SubscriptionError` message
/// containing the error text.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UnsubscribeRequest {
    /// ID of the subscription that should be canceled.
    pub subscription_id: SubscriptionId,
}

/// A WebSocket JSON message sent from the server to the client.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize, From)]
#[serde(tag = "type")]
#[serde(rename_all = "camelCase")]
pub enum WsResponse {
    Error(ErrorResponse),
    Subscribed(SubscribedResponse),
    SubscribedWithInvalidFeedIdsIgnored(SubscribedWithInvalidFeedIdsIgnoredResponse),
    Unsubscribed(UnsubscribedResponse),
    SubscriptionError(SubscriptionErrorResponse),
    StreamUpdated(StreamUpdatedResponse),
}

/// Sent from the server when a subscription succeeded and all specified feeds were valid.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SubscribedResponse {
    pub subscription_id: SubscriptionId,
}

#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InvalidFeedSubscriptionDetails {
    /// List of price feed IDs that could not be found.
    pub unknown_ids: Vec<PriceFeedId>,
    /// List of price feed symbols that could not be found.
    pub unknown_symbols: Vec<String>,
    /// List of price feed IDs that do not support the requested channel.
    pub unsupported_channels: Vec<PriceFeedId>,
    /// List of unstable price feed IDs. Unstable feeds are not available for subscription.
    pub unstable: Vec<PriceFeedId>,
}

/// Sent from the server when a subscription succeeded, but
/// some of the  specified feeds were invalid.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SubscribedWithInvalidFeedIdsIgnoredResponse {
    /// The value specified in the corresponding `SubscribeRequest`.
    pub subscription_id: SubscriptionId,
    /// IDs of valid feeds included in the established subscription.
    pub subscribed_feed_ids: Vec<PriceFeedId>,
    /// Map of failed feed IDs categorized by failure reason.
    pub ignored_invalid_feed_ids: InvalidFeedSubscriptionDetails,
}

/// Notification of a successful unsubscription.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UnsubscribedResponse {
    /// The value specified in the corresponding `SubscribeRequest`.
    pub subscription_id: SubscriptionId,
}

/// Sent from the server if the requested subscription or unsubscription request
/// could not be fulfilled.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SubscriptionErrorResponse {
    /// The value specified in the corresponding `SubscribeRequest`.
    pub subscription_id: SubscriptionId,
    /// Text of the error.
    pub error: String,
}

/// Sent from the server if an internal error occured while serving data for an existing subscription,
/// or a client request sent a bad request.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ErrorResponse {
    /// Text of the error.
    pub error: String,
}

/// Sent from the server when new data is available for an existing subscription
/// (only if `delivery_format == Json`).
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StreamUpdatedResponse {
    /// The value specified in the corresponding `SubscribeRequest`.
    pub subscription_id: SubscriptionId,
    /// Content of the update.
    #[serde(flatten)]
    pub payload: JsonUpdate,
}

// Common validation functions
fn validate_price_feed_ids_or_symbols(
    price_feed_ids: &Option<Vec<PriceFeedId>>,
    symbols: &Option<Vec<String>>,
) -> Result<(), &'static str> {
    if price_feed_ids.is_none() && symbols.is_none() {
        return Err("either price feed ids or symbols must be specified");
    }
    if price_feed_ids.is_some() && symbols.is_some() {
        return Err("either price feed ids or symbols must be specified, not both");
    }
    Ok(())
}

fn validate_optional_nonempty_vec_has_unique_elements<T>(
    vec: &Option<Vec<T>>,
    empty_msg: &'static str,
    duplicate_msg: &'static str,
) -> Result<(), &'static str>
where
    T: Eq + std::hash::Hash,
{
    if let Some(items) = vec {
        if items.is_empty() {
            return Err(empty_msg);
        }
        if !items.iter().all_unique() {
            return Err(duplicate_msg);
        }
    }
    Ok(())
}

fn validate_properties(properties: &[PriceFeedProperty]) -> Result<(), &'static str> {
    if properties.is_empty() {
        return Err("no properties specified");
    }
    if !properties.iter().all_unique() {
        return Err("duplicate properties specified");
    }
    Ok(())
}

fn validate_formats(formats: &[Format]) -> Result<(), &'static str> {
    if !formats.iter().all_unique() {
        return Err("duplicate formats or chains specified");
    }
    Ok(())
}

#[derive(Serialize, Deserialize, Debug, Clone, Copy, PartialEq, Eq, Hash, From, Default)]
#[serde(rename_all = "camelCase")]

pub enum MarketSession {
    #[default]
    Regular,
    PreMarket,
    PostMarket,
    OverNight,
    Closed,
}

#[derive(Serialize, Deserialize, Debug, Clone, Copy, PartialEq, Eq, Hash, From, Default)]
#[serde(rename_all = "camelCase")]

pub enum TradingStatus {
    #[default]
    Open,
    Closed,
    Halted,
    CorpAction,
}

impl From<MarketSession> for i16 {
    fn from(s: MarketSession) -> i16 {
        match s {
            MarketSession::Regular => 0,
            MarketSession::PreMarket => 1,
            MarketSession::PostMarket => 2,
            MarketSession::OverNight => 3,
            MarketSession::Closed => 4,
        }
    }
}

impl TryFrom<i16> for MarketSession {
    type Error = anyhow::Error;

    fn try_from(value: i16) -> Result<MarketSession, Self::Error> {
        match value {
            0 => Ok(MarketSession::Regular),
            1 => Ok(MarketSession::PreMarket),
            2 => Ok(MarketSession::PostMarket),
            3 => Ok(MarketSession::OverNight),
            4 => Ok(MarketSession::Closed),
            _ => Err(anyhow::anyhow!("invalid MarketSession value: {}", value)),
        }
    }
}
