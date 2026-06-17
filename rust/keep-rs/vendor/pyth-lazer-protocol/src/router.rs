//! WebSocket JSON protocol types for API the router provides to consumers and publishers.

use {
    crate::payload::AggregatedPriceFeedData,
    anyhow::{bail, Context},
    itertools::Itertools,
    protobuf::well_known_types::timestamp::Timestamp,
    rust_decimal::{prelude::FromPrimitive, Decimal},
    serde::{de::Error, Deserialize, Serialize},
    std::{
        fmt::Display,
        num::NonZeroI64,
        ops::{Add, Deref, DerefMut, Div, Sub},
        time::{SystemTime, UNIX_EPOCH},
    },
};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
pub struct PublisherId(pub u16);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
pub struct PriceFeedId(pub u32);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
pub struct ChannelId(pub u8);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
pub struct TimestampUs(pub u64);

impl TryFrom<&Timestamp> for TimestampUs {
    type Error = anyhow::Error;

    fn try_from(timestamp: &Timestamp) -> anyhow::Result<Self> {
        let seconds_in_micros: u64 = (timestamp.seconds * 1_000_000).try_into()?;
        let nanos_in_micros: u64 = (timestamp.nanos / 1_000).try_into()?;
        Ok(TimestampUs(seconds_in_micros + nanos_in_micros))
    }
}

impl TimestampUs {
    pub fn now() -> Self {
        let value = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("invalid system time")
            .as_micros()
            .try_into()
            .expect("invalid system time");
        Self(value)
    }

    pub fn saturating_us_since(self, other: Self) -> u64 {
        self.0.saturating_sub(other.0)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[repr(transparent)]
pub struct Rate(pub i64);

impl Rate {
    pub fn parse_str(value: &str, exponent: u32) -> anyhow::Result<Self> {
        let value: Decimal = value.parse()?;
        let coef = 10i64.checked_pow(exponent).context("overflow")?;
        let coef = Decimal::from_i64(coef).context("overflow")?;
        let value = value.checked_mul(coef).context("overflow")?;
        if !value.is_integer() {
            bail!("price value is more precise than available exponent");
        }
        let value: i64 = value.try_into().context("overflow")?;
        Ok(Self(value))
    }

    pub fn from_f64(value: f64, exponent: u32) -> anyhow::Result<Self> {
        let value = Decimal::from_f64(value).context("overflow")?;
        let coef = 10i64.checked_pow(exponent).context("overflow")?;
        let coef = Decimal::from_i64(coef).context("overflow")?;
        let value = value.checked_mul(coef).context("overflow")?;
        let value: i64 = value.try_into().context("overflow")?;
        Ok(Self(value))
    }

    pub fn from_integer(value: i64, exponent: u32) -> anyhow::Result<Self> {
        let coef = 10i64.checked_pow(exponent).context("overflow")?;
        let value = value.checked_mul(coef).context("overflow")?;
        Ok(Self(value))
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[repr(transparent)]
pub struct Price(pub NonZeroI64);

impl Price {
    pub fn from_integer(value: i64, exponent: u32) -> anyhow::Result<Price> {
        let coef = 10i64.checked_pow(exponent).context("overflow")?;
        let value = value.checked_mul(coef).context("overflow")?;
        let value = NonZeroI64::new(value).context("zero price is unsupported")?;
        Ok(Self(value))
    }

    pub fn parse_str(value: &str, exponent: u32) -> anyhow::Result<Price> {
        let value: Decimal = value.parse()?;
        let coef = 10i64.checked_pow(exponent).context("overflow")?;
        let coef = Decimal::from_i64(coef).context("overflow")?;
        let value = value.checked_mul(coef).context("overflow")?;
        if !value.is_integer() {
            bail!("price value is more precise than available exponent");
        }
        let value: i64 = value.try_into().context("overflow")?;
        let value = NonZeroI64::new(value).context("zero price is unsupported")?;
        Ok(Self(value))
    }

    pub fn new(value: i64) -> anyhow::Result<Self> {
        let value = NonZeroI64::new(value).context("zero price is unsupported")?;
        Ok(Self(value))
    }

    pub fn into_inner(self) -> NonZeroI64 {
        self.0
    }

    pub fn to_f64(self, exponent: u32) -> anyhow::Result<f64> {
        Ok(self.0.get() as f64 / 10i64.checked_pow(exponent).context("overflow")? as f64)
    }

    pub fn from_f64(value: f64, exponent: u32) -> anyhow::Result<Self> {
        let value = (value * 10f64.powi(exponent as i32)) as i64;
        let value = NonZeroI64::new(value).context("zero price is unsupported")?;
        Ok(Self(value))
    }

    pub fn mul(self, rhs: Price, rhs_exponent: u32) -> anyhow::Result<Price> {
        let left_value = i128::from(self.0.get());
        let right_value = i128::from(rhs.0.get());

        let value = left_value * right_value / 10i128.pow(rhs_exponent);
        let value = value.try_into()?;
        NonZeroI64::new(value)
            .context("zero price is unsupported")
            .map(Self)
    }
}

impl Sub<i64> for Price {
    type Output = Option<Price>;

    fn sub(self, rhs: i64) -> Self::Output {
        let value = self.0.get().saturating_sub(rhs);
        NonZeroI64::new(value).map(Self)
    }
}

impl Add<i64> for Price {
    type Output = Option<Price>;

    fn add(self, rhs: i64) -> Self::Output {
        let value = self.0.get().saturating_add(rhs);
        NonZeroI64::new(value).map(Self)
    }
}

impl Add<Price> for Price {
    type Output = Option<Price>;
    fn add(self, rhs: Price) -> Self::Output {
        let value = self.0.get().saturating_add(rhs.0.get());
        NonZeroI64::new(value).map(Self)
    }
}

impl Sub<Price> for Price {
    type Output = Option<Price>;
    fn sub(self, rhs: Price) -> Self::Output {
        let value = self.0.get().saturating_sub(rhs.0.get());
        NonZeroI64::new(value).map(Self)
    }
}

impl Div<i64> for Price {
    type Output = Option<Price>;
    fn div(self, rhs: i64) -> Self::Output {
        let value = self.0.get().saturating_div(rhs);
        NonZeroI64::new(value).map(Self)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum PriceFeedProperty {
    Price,
    BestBidPrice,
    BestAskPrice,
    PublisherCount,
    Exponent,
    Confidence,
    FundingRate,
    FundingTimestamp,
    // padding to keep wire-level discriminants aligned with the on-chain enum
    FundingRateInterval,
    MarketSession,
    EmaPrice,
    EmaConfidence,
    FeedUpdateTimestamp,
    // More fields may be added later.
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

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub enum Channel {
    FixedRate(FixedRate),
}

impl Serialize for Channel {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        match self {
            Channel::FixedRate(fixed_rate) => {
                if *fixed_rate == FixedRate::MIN {
                    return serializer.serialize_str("real_time");
                }
                serializer.serialize_str(&format!("fixed_rate@{}ms", fixed_rate.value_ms()))
            }
        }
    }
}

pub mod channel_ids {
    use super::ChannelId;

    pub const FIXED_RATE_1: ChannelId = ChannelId(1);
    pub const FIXED_RATE_50: ChannelId = ChannelId(2);
    pub const FIXED_RATE_200: ChannelId = ChannelId(3);
}

impl Display for Channel {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Channel::FixedRate(fixed_rate) => match *fixed_rate {
                FixedRate::MIN => write!(f, "real_time"),
                rate => write!(f, "fixed_rate@{}ms", rate.value_ms()),
            },
        }
    }
}

impl Channel {
    pub fn id(&self) -> ChannelId {
        match self {
            Channel::FixedRate(fixed_rate) => match fixed_rate.value_ms() {
                1 => channel_ids::FIXED_RATE_1,
                50 => channel_ids::FIXED_RATE_50,
                200 => channel_ids::FIXED_RATE_200,
                _ => panic!("unknown channel: {self:?}"),
            },
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
        Some(Channel::FixedRate(FixedRate::MIN))
    } else if let Some(rest) = value.strip_prefix("fixed_rate@") {
        let ms_value = rest.strip_suffix("ms")?;
        Some(Channel::FixedRate(FixedRate::from_ms(
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
        parse_channel(&value).ok_or_else(|| D::Error::custom("unknown channel"))
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct FixedRate {
    ms: u32,
}

impl FixedRate {
    // Assumptions (tested below):
    // - Values are sorted.
    // - 1 second contains a whole number of each interval.
    // - all intervals are divisable by the smallest interval.
    pub const ALL: [Self; 3] = [Self { ms: 1 }, Self { ms: 50 }, Self { ms: 200 }];
    pub const MIN: Self = Self::ALL[0];

    pub fn from_ms(value: u32) -> Option<Self> {
        Self::ALL.into_iter().find(|v| v.ms == value)
    }

    pub fn value_ms(self) -> u32 {
        self.ms
    }

    pub fn value_us(self) -> u64 {
        (self.ms * 1000).into()
    }
}

#[test]
fn fixed_rate_values() {
    assert!(
        FixedRate::ALL.windows(2).all(|w| w[0] < w[1]),
        "values must be unique and sorted"
    );
    for value in FixedRate::ALL {
        assert!(
            1000 % value.ms == 0,
            "1 s must contain whole number of intervals"
        );
        assert!(
            value.value_us() % FixedRate::MIN.value_us() == 0,
            "the interval's borders must be a subset of the minimal interval's borders"
        );
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SubscriptionParamsRepr {
    pub price_feed_ids: Vec<PriceFeedId>,
    pub properties: Vec<PriceFeedProperty>,
    // "chains" was renamed to "formats". "chains" is still supported for compatibility.
    #[serde(alias = "chains")]
    pub formats: Vec<Format>,
    #[serde(default)]
    pub delivery_format: DeliveryFormat,
    #[serde(default)]
    pub json_binary_encoding: JsonBinaryEncoding,
    /// If `true`, the stream update will contain a `parsed` JSON field containing
    /// all data of the update.
    #[serde(default = "default_parsed")]
    pub parsed: bool,
    pub channel: Channel,
    #[serde(default)]
    pub ignore_invalid_feed_ids: bool,
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
        Self::new(value).map_err(D::Error::custom)
    }
}

impl SubscriptionParams {
    pub fn new(value: SubscriptionParamsRepr) -> Result<Self, &'static str> {
        if value.price_feed_ids.is_empty() {
            return Err("no price feed ids specified");
        }
        if !value.price_feed_ids.iter().all_unique() {
            return Err("duplicate price feed ids specified");
        }
        if !value.formats.iter().all_unique() {
            return Err("duplicate formats or chains specified");
        }
        if value.properties.is_empty() {
            return Err("no properties specified");
        }
        if !value.properties.iter().all_unique() {
            return Err("duplicate properties specified");
        }
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

pub fn default_parsed() -> bool {
    true
}

#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JsonBinaryData {
    pub encoding: JsonBinaryEncoding,
    pub data: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JsonUpdate {
    /// Present unless `parsed = false` is specified in subscription params.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub parsed: Option<ParsedPayload>,
    /// Only present if `Evm` is present in `formats` in subscription params.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub evm: Option<JsonBinaryData>,
    /// Only present if `Solana` is present in `formats` in subscription params.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub solana: Option<JsonBinaryData>,
    /// Only present if `LeEcdsa` is present in `formats` in subscription params.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub le_ecdsa: Option<JsonBinaryData>,
    /// Only present if `LeUnsigned` is present in `formats` in subscription params.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub le_unsigned: Option<JsonBinaryData>,
}

#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ParsedPayload {
    #[serde(with = "crate::serde_str::timestamp")]
    pub timestamp_us: TimestampUs,
    pub price_feeds: Vec<ParsedFeedPayload>,
}

#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ParsedFeedPayload {
    pub price_feed_id: PriceFeedId,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[serde(with = "crate::serde_str::option_price")]
    #[serde(default)]
    pub price: Option<Price>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[serde(with = "crate::serde_str::option_price")]
    #[serde(default)]
    pub best_bid_price: Option<Price>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[serde(with = "crate::serde_str::option_price")]
    #[serde(default)]
    pub best_ask_price: Option<Price>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[serde(default)]
    pub publisher_count: Option<u16>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[serde(default)]
    pub exponent: Option<i16>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[serde(default)]
    pub confidence: Option<Price>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[serde(default)]
    pub funding_rate: Option<Rate>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[serde(default)]
    pub funding_timestamp: Option<TimestampUs>,
    // More fields may be added later.
}

impl ParsedFeedPayload {
    pub fn new(
        price_feed_id: PriceFeedId,
        exponent: Option<i16>,
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
                    output.exponent = exponent;
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
                PriceFeedProperty::FundingRateInterval
                | PriceFeedProperty::MarketSession
                | PriceFeedProperty::EmaPrice
                | PriceFeedProperty::EmaConfidence
                | PriceFeedProperty::FeedUpdateTimestamp => {}
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
        }
    }
}
