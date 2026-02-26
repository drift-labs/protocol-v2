//! Pyth Lazer type definitions and utilities.

use anchor_lang::prelude::*;

declare_id!("pytd2yyk641x7ak7mkaasSJVXh6YYZnC7wTmtgAyxPt");

#[program]
pub mod pyth_lazer {}

pub mod api;
pub mod binary_update;
pub mod dynamic_value;
pub mod feed_kind;
pub mod jrpc;
pub mod message;
pub mod payload;
pub mod price;
pub mod publisher;
pub mod rate;
mod serde_price_as_i64;
mod serde_str;
pub mod signature;
pub mod storage;
pub mod symbol_state;
pub mod time;

use serde::{Deserialize, Serialize};
use {
    derive_more::{From, Into},
    strum::FromRepr,
};

pub use crate::{
    dynamic_value::DynamicValue,
    feed_kind::FeedKind,
    price::{Price, PriceError},
    rate::{Rate, RateError},
    symbol_state::SymbolState,
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

#[cfg(test)]
mod tests {
    use crate::{
        binary_update::BINARY_UPDATE_FORMAT_MAGIC,
        message::format_magics_le::{
            EVM_FORMAT_MAGIC, JSON_FORMAT_MAGIC, LE_ECDSA_FORMAT_MAGIC, LE_UNSIGNED_FORMAT_MAGIC,
            SOLANA_FORMAT_MAGIC,
        },
        payload::PAYLOAD_FORMAT_MAGIC,
    };

    #[test]
    fn magics_in_big_endian() {
        assert_eq!(u32::swap_bytes(BINARY_UPDATE_FORMAT_MAGIC), 1937213467);
        assert_eq!(u32::swap_bytes(PAYLOAD_FORMAT_MAGIC), 1976813459);
        assert_eq!(u32::swap_bytes(SOLANA_FORMAT_MAGIC), 3103857282);
        assert_eq!(u32::swap_bytes(JSON_FORMAT_MAGIC), 2584795844);
        assert_eq!(u32::swap_bytes(EVM_FORMAT_MAGIC), 706910618);
        assert_eq!(u32::swap_bytes(LE_ECDSA_FORMAT_MAGIC), 3837609805);
        assert_eq!(u32::swap_bytes(LE_UNSIGNED_FORMAT_MAGIC), 206398297);
        for magic in [
            BINARY_UPDATE_FORMAT_MAGIC,
            PAYLOAD_FORMAT_MAGIC,
            SOLANA_FORMAT_MAGIC,
            JSON_FORMAT_MAGIC,
            EVM_FORMAT_MAGIC,
            LE_ECDSA_FORMAT_MAGIC,
            LE_UNSIGNED_FORMAT_MAGIC,
        ] {
            assert_ne!(u32::swap_bytes(magic), magic);
        }
    }
}
