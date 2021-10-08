use anchor_lang::prelude::*;

use crate::error::*;
use crate::math::amm;
use crate::math_error;
use crate::MARK_PRICE_MANTISSA;
use solana_program::msg;

#[account(zero_copy)]
pub struct Markets {
    pub markets: [Market; 1000],
}

impl Default for Markets {
    fn default() -> Self {
        return Markets {
            markets: [Market::default(); 1000],
        };
    }
}

impl Markets {
    pub fn index_from_u64(index: u64) -> usize {
        return std::convert::TryInto::try_into(index).unwrap();
    }
}

#[zero_copy]
#[derive(Default)]
pub struct Market {
    pub initialized: bool,
    pub base_asset_amount_long: i128,
    pub base_asset_amount_short: i128,
    pub base_asset_amount: i128, // net market bias
    pub open_interest: u128,     // number of users in a position
    pub amm: AMM,
}

#[derive(Clone, Copy)]
pub enum OracleSource {
    Pyth,
    Switchboard,
}

impl Default for OracleSource {
    // UpOnly
    fn default() -> Self {
        OracleSource::Pyth
    }
}

#[zero_copy]
#[derive(Default)]
pub struct AMM {
    pub oracle: Pubkey,
    pub oracle_source: OracleSource,
    pub base_asset_reserve: u128,
    pub quote_asset_reserve: u128,
    pub cumulative_funding_rate: i128,
    pub cumulative_repeg_rebate_long: u128,
    pub cumulative_repeg_rebate_short: u128,
    pub cumulative_funding_rate_long: i128,
    pub cumulative_funding_rate_short: i128,
    pub last_funding_rate: i128,
    pub last_funding_rate_ts: i64,
    pub funding_period: i64,
    pub last_mark_price_twap: u128,
    pub last_mark_price_twap_ts: i64,
    pub sqrt_k: u128,
    pub peg_multiplier: u128,
    pub cumulative_fee: u128,
    pub cumulative_fee_realized: u128,
}

impl AMM {
    pub fn mark_price(&self) -> ClearingHouseResult<u128> {
        amm::calculate_price(
            self.quote_asset_reserve,
            self.base_asset_reserve,
            self.peg_multiplier,
        )
    }

    pub fn get_pyth_price(
        &self,
        price_oracle: &AccountInfo,
        window: u32,
        now: i64,
    ) -> ClearingHouseResult<(i128, u128, i64)> {
        let pyth_price_data = price_oracle
            .try_borrow_data()
            .or(Err(ErrorCode::UnableToLoadOracle.into()))?;
        let price_data = pyth_client::cast::<pyth_client::Price>(&pyth_price_data);

        let oracle_price = if window > 0 {
            price_data.twap.val as i128
        } else {
            price_data.agg.price as i128
        };

        let oracle_conf = if window > 0 {
            price_data.twac.val as u128
        } else {
            price_data.agg.conf as u128
        };

        let oracle_mantissa = 10_u128.pow(price_data.expo.unsigned_abs());

        let mut oracle_scale_mult = 1;
        let mut oracle_scale_div = 1;

        if oracle_mantissa > MARK_PRICE_MANTISSA {
            oracle_scale_div = oracle_mantissa
                .checked_div(MARK_PRICE_MANTISSA)
                .ok_or_else(math_error!())?;
        } else {
            oracle_scale_mult = MARK_PRICE_MANTISSA
                .checked_div(oracle_mantissa)
                .ok_or_else(math_error!())?;
        }

        let oracle_price_scaled = (oracle_price)
            .checked_mul(oracle_scale_mult as i128)
            .ok_or_else(math_error!())?
            .checked_div(oracle_scale_div as i128)
            .ok_or_else(math_error!())?;
        let oracle_conf_scaled = (oracle_conf)
            .checked_mul(oracle_scale_mult)
            .ok_or_else(math_error!())?
            .checked_div(oracle_scale_div)
            .ok_or_else(math_error!())?;

        let oracle_delay = (now as i64)
            .checked_sub(price_data.valid_slot as i64)
            .ok_or_else(math_error!())?;

        return Ok((oracle_price_scaled, oracle_conf_scaled, oracle_delay));
    }

    pub fn get_oracle_price(
        &self,
        price_oracle: &AccountInfo,
        window: u32,
        now: i64,
    ) -> ClearingHouseResult<(i128, u128, i64)> {
        let (oracle_px, oracle_conf, oracle_delay) = match self.oracle_source {
            OracleSource::Pyth => self.get_pyth_price(price_oracle, window, now)?,
            OracleSource::Switchboard => (0, 0, 0),
        };
        return Ok((oracle_px, oracle_conf, oracle_delay));
    }
}
