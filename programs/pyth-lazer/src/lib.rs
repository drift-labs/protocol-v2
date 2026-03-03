//! Pyth Lazer type definitions and utilities.

use anchor_lang::prelude::*;

declare_id!("pytd2yyk641x7ak7mkaasSJVXh6YYZnC7wTmtgAyxPt");

#[program]
pub mod pyth_lazer {}

pub mod api;
pub mod message;
pub mod payload;
pub mod price;
pub mod rate;
mod serde_price_as_i64;
mod serde_str;
pub mod signature;
pub mod storage;
pub mod time;

use serde::{Deserialize, Serialize};
use {
    derive_more::{From, Into},
    strum::FromRepr,
};

pub use crate::{
    price::{Price, PriceError},
    rate::{Rate, RateError},
};

#[derive(
    Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize, From, Into,
)]
pub struct AssetId(pub u32);

#[derive(
    Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize, From, Into,
)]
pub struct PublisherId(pub u16);

#[derive(
    Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize, From, Into,
)]
pub struct PriceFeedId(pub u32);

#[derive(
    Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize, From, Into,
)]
pub struct ChannelId(pub u8);

impl ChannelId {
    pub const REAL_TIME: ChannelId = ChannelId(1);
    pub const FIXED_RATE_50: ChannelId = ChannelId(2);
    pub const FIXED_RATE_200: ChannelId = ChannelId(3);
    pub const FIXED_RATE_1000: ChannelId = ChannelId(4);
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, FromRepr)]
#[serde(rename_all = "camelCase")]
#[repr(u8)]
pub enum PriceFeedProperty {
    Price,
    BestBidPrice,
    BestAskPrice,
    PublisherCount,
    Exponent,
    Confidence,
    FundingRate,
    FundingTimestamp,
    FundingRateInterval,
    MarketSession,
    EmaPrice,
    EmaConfidence,
    FeedUpdateTimestamp,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum AssetClass {
    Crypto,
    Fx,
    Equity,
    Metal,
    Rates,
    Nav,
    Commodity,
    FundingRate,
    Eco,
    Kalshi,
}

impl AssetClass {
    pub fn as_str(&self) -> &'static str {
        match self {
            AssetClass::Crypto => "crypto",
            AssetClass::Fx => "fx",
            AssetClass::Equity => "equity",
            AssetClass::Metal => "metal",
            AssetClass::Rates => "rates",
            AssetClass::Nav => "nav",
            AssetClass::Commodity => "commodity",
            AssetClass::FundingRate => "funding-rate",
            AssetClass::Eco => "eco",
            AssetClass::Kalshi => "kalshi",
        }
    }
}

/// Operation and coefficient for converting value to mantissa.
pub(crate) enum ExponentFactor {
    Mul(i64),
    Div(i64),
}

impl ExponentFactor {
    pub(crate) fn get(exponent: i16) -> Option<Self> {
        if exponent >= 0 {
            let exponent: u32 = exponent.try_into().ok()?;
            Some(ExponentFactor::Div(10_i64.checked_pow(exponent)?))
        } else {
            let minus_exponent: u32 = exponent.checked_neg()?.try_into().ok()?;
            Some(ExponentFactor::Mul(10_i64.checked_pow(minus_exponent)?))
        }
    }
}
