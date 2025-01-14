use std::fmt;
use std::fmt::{Display, Formatter};

use anchor_lang::prelude::*;
use borsh::{BorshDeserialize, BorshSerialize};

use crate::error::{DriftResult, ErrorCode};
use crate::math::casting::Cast;
use crate::math::constants::{
	AMM_RESERVE_PRECISION, FIVE_MINUTE, MARGIN_PRECISION, ONE_HOUR, SPOT_WEIGHT_PRECISION_U128,
};
#[cfg(test)]
use crate::math::constants::{PRICE_PRECISION_I64, SPOT_CUMULATIVE_INTEREST_PRECISION};
use crate::math::margin::{
	calculate_size_discount_asset_weight, calculate_size_premium_liability_weight,
	MarginRequirementType,
};
use crate::math::safe_math::SafeMath;
use crate::math::spot_balance::{calculate_utilization, get_token_amount, get_token_value};

use crate::math::stats::calculate_new_twap;
use crate::state::oracle::{HistoricalIndexData, HistoricalOracleData, OracleSource};
use crate::state::paused_operations::{InsuranceFundOperation, SpotOperation};
use crate::state::perp_market::{MarketStatus, PoolBalance};
use crate::state::traits::{MarketIndexOffset, Size};
use crate::{validate, PERCENTAGE_PRECISION};

use super::oracle::OraclePriceData;
use super::oracle_map::OracleIdentifier;

#[account(zero_copy(unsafe))]
#[derive(Eq, PartialEq, Debug)]
#[repr(C)]
pub struct Constituent {
	/// address of the constituent
	pub pubkey: Pubkey,
	/// oracle used to price the constituent
	pub oracle: Pubkey,
	pub oracle_source: OracleSource,
	/// target weight of the constituent in the Vault
	/// precision: PERCENTAGE_PRECISION
	pub target_weight: u64,
	/// max deviation from target_weight allowed for the constituent
	/// precision: PERCENTAGE_PRECISION
	pub max_weight_deviation: u64,
	/// min fee charged on swaps to this constituent
	/// precision: PERCENTAGE_PRECISION
	pub swap_fee_min: u64,
	/// max premium to be applied to swap_fee_min when the constituent is at max deviation from target_weight
	/// precision: PERCENTAGE_PRECISION
	pub max_fee_premium: u64,
	/// underlying drift spot market index
	pub spot_market_index: u16,
	/// oracle price at last update
	/// precision: PRICE_PRECISION_I64
	pub last_oracle_price: i64,
	/// timestamp of last oracle price update:
	pub last_oracle_price_ts: u64,
	/// deposit balance of the constituent in token precision
    /// precision: SPOT_BALANCE_PRECISION
    pub deposit_balance: u128,
	/// decimals of the constituent mint
	pub decimals: u32
}

impl Size for Constituent {
	const SIZE: usize = 152;
}

impl Default for Constituent {
    fn default() -> Self {
        Constituent {
            pubkey: Pubkey::default(),
            oracle: Pubkey::default(),
            oracle_source: OracleSource::default(),
            target_weight: 0,
            max_weight_deviation: 0,
            swap_fee_min: 0,
            max_fee_premium: 0,
            spot_market_index: 0,
            last_oracle_price: 0,
            last_oracle_price_ts: 0,
            deposit_balance: 0,
            decimals: 0,
        }
    }
}
