use std::collections::BTreeMap;

use crate::error::{DriftResult, ErrorCode};
use crate::math::casting::Cast;
use crate::math::constants::{
    BASE_PRECISION_I128, PERCENTAGE_PRECISION, PERCENTAGE_PRECISION_I128, PERCENTAGE_PRECISION_I64,
    PERCENTAGE_PRECISION_U64, PRICE_PRECISION_I128, QUOTE_PRECISION_I128,
};
use crate::math::safe_math::SafeMath;
use crate::math::spot_balance::get_token_amount;
use crate::state::constituent_map::ConstituentMap;
use crate::state::perp_market::{AmmCache, AmmCacheFixed, CacheInfo};
use crate::state::spot_market_map::SpotMarketMap;
use anchor_lang::prelude::*;
use anchor_spl::token::Mint;
use borsh::{BorshDeserialize, BorshSerialize};

use super::oracle::OraclePriceData;
use super::spot_market::SpotMarket;
use super::zero_copy::{AccountZeroCopy, AccountZeroCopyMut, HasLen};
use crate::state::spot_market::{SpotBalance, SpotBalanceType};
use crate::state::traits::Size;
use crate::{impl_zero_copy_loader, validate};

pub const AMM_MAP_PDA_SEED: &str = "AMM_MAP";
pub const CONSTITUENT_PDA_SEED: &str = "CONSTITUENT";
pub const CONSTITUENT_TARGET_BASE_PDA_SEED: &str = "constituent_target_base";
pub const CONSTITUENT_CORRELATIONS_PDA_SEED: &str = "constituent_correlations";
pub const CONSTITUENT_VAULT_PDA_SEED: &str = "CONSTITUENT_VAULT";
pub const LP_POOL_TOKEN_VAULT_PDA_SEED: &str = "LP_POOL_TOKEN_VAULT";

pub const BASE_SWAP_FEE: i128 = 300; // 0.75% in PERCENTAGE_PRECISION
pub const MAX_SWAP_FEE: i128 = 75_000; // 0.75% in PERCENTAGE_PRECISION
pub const MIN_SWAP_FEE: i128 = 200; // 0.75% in PERCENTAGE_PRECISION

pub const MIN_AUM_EXECUTION_FEE: u128 = 10_000_000_000_000;

// Delay constants
#[cfg(feature = "anchor-test")]
pub const SETTLE_AMM_ORACLE_MAX_DELAY: u64 = 100;
#[cfg(not(feature = "anchor-test"))]
pub const SETTLE_AMM_ORACLE_MAX_DELAY: u64 = 10;
pub const LP_POOL_SWAP_AUM_UPDATE_DELAY: u64 = 0;
#[cfg(feature = "anchor-test")]
pub const MAX_AMM_CACHE_STALENESS_FOR_TARGET_CALC: u64 = 10000u64;
#[cfg(not(feature = "anchor-test"))]
pub const MAX_AMM_CACHE_STALENESS_FOR_TARGET_CALC: u64 = 0u64;

#[cfg(feature = "anchor-test")]
pub const MAX_CONSTITUENT_ORACLE_SLOT_STALENESS_FOR_AUM: u64 = 10000u64;
#[cfg(not(feature = "anchor-test"))]
pub const MAX_CONSTITUENT_ORACLE_SLOT_STALENESS_FOR_AUM: u64 = 2u64;

#[cfg(test)]
mod tests;

#[account(zero_copy(unsafe))]
#[derive(Default, Debug)]
#[repr(C)]
pub struct LPPool {
    /// name of vault, TODO: check type + size
    pub name: [u8; 32], // 32
    /// address of the vault.
    pub pubkey: Pubkey, // 32, 64
    // vault token mint
    pub mint: Pubkey, // 32, 96

    /// The current number of VaultConstituents in the vault, each constituent is pda(LPPool.address, constituent_index)
    /// which constituent is the quote, receives revenue pool distributions. (maybe this should just be implied idx 0)
    /// pub quote_constituent_index: u16,

    /// QUOTE_PRECISION: Max AUM, Prohibit minting new DLP beyond this
    pub max_aum: u128, // 8, 136

    /// QUOTE_PRECISION: AUM of the vault in USD, updated lazily
    pub last_aum: u128, // 8, 144

    /// timestamp of last AUM slot
    pub last_aum_slot: u64, // 8, 152
    /// timestamp of last AUM update
    pub last_aum_ts: i64, // 8, 160

    /// Oldest slot of constituent oracles
    pub oldest_oracle_slot: u64,

    /// timestamp of last vAMM revenue rebalance
    pub last_revenue_rebalance_ts: u64, // 8, 168
    pub revenue_rebalance_period: u64,

    /// Every mint/redeem has a monotonically increasing id. This is the next id to use
    pub next_mint_redeem_id: u64,

    /// all revenue settles recieved
    pub total_fees_received: u128, // 16, 176
    /// all revenues paid out
    pub total_fees_paid: u128, // 16, 192

    pub cumulative_usdc_sent_to_perp_markets: u128,
    pub cumulative_usdc_received_from_perp_markets: u128,

    pub total_mint_redeem_fees_paid: i128,

    pub min_mint_fee: i64,
    pub max_mint_fee_premium: i64,

    pub constituents: u16, // 2, 194

    pub bump: u8,

    pub usdc_consituent_index: u16,

    pub gamma_execution: u8,
    pub xi: u8,
    pub volatility: u64,
}

impl Size for LPPool {
    const SIZE: usize = 296;
}

impl LPPool {
    pub fn get_price(&self, mint: &Mint) -> Result<u128> {
        match mint.supply {
            0 => Ok(0),
            supply => {
                // TODO: assuming mint decimals = quote decimals = 6
                (supply as u128)
                    .checked_div(self.last_aum)
                    .ok_or(ErrorCode::MathError.into())
            }
        }
    }

    /// Get the swap price between two (non-LP token) constituents.
    /// Accounts for precision differences between in and out constituents
    /// returns swap price in PRICE_PRECISION
    pub fn get_swap_price(
        &self,
        in_decimals: u32,
        out_decimals: u32,
        in_oracle: &OraclePriceData,
        out_oracle: &OraclePriceData,
    ) -> DriftResult<(u64, u64)> {
        let in_price = in_oracle.price.cast::<u64>()?;
        let out_price = out_oracle.price.cast::<u64>()?;

        let (prec_diff_numerator, prec_diff_denominator) = if out_decimals > in_decimals {
            (10_u64.pow(out_decimals - in_decimals), 1)
        } else {
            (1, 10_u64.pow(in_decimals - out_decimals))
        };

        let swap_price_num = in_price.safe_mul(prec_diff_numerator)?;
        let swap_price_denom = out_price.safe_mul(prec_diff_denominator)?;

        Ok((swap_price_num, swap_price_denom))
    }

    /// in the respective token units. Amounts are gross fees and in
    /// token mint precision.
    /// Positive fees are paid, negative fees are rebated
    /// Returns (in_amount out_amount, in_fee, out_fee)
    pub fn get_swap_amount(
        &self,
        in_oracle: &OraclePriceData,
        out_oracle: &OraclePriceData,
        in_constituent: &Constituent,
        out_constituent: &Constituent,
        in_spot_market: &SpotMarket,
        out_spot_market: &SpotMarket,
        in_target_weight: i64,
        out_target_weight: i64,
        in_amount: u128,
        correlation: i64,
    ) -> DriftResult<(u128, u128, i128, i128)> {
        let (swap_price_num, swap_price_denom) = self.get_swap_price(
            in_spot_market.decimals,
            out_spot_market.decimals,
            in_oracle,
            out_oracle,
        )?;

        let (in_fee, out_fee) = self.get_swap_fees(
            in_spot_market,
            in_oracle.price,
            in_constituent,
            in_amount.cast::<i128>()?,
            in_target_weight,
            Some(out_spot_market),
            Some(out_oracle.price),
            Some(out_constituent),
            Some(out_target_weight),
            correlation,
        )?;
        let in_fee_amount = in_amount
            .cast::<i128>()?
            .safe_mul(in_fee)?
            .safe_div(PERCENTAGE_PRECISION_I128)?;

        let out_amount = in_amount
            .cast::<i128>()?
            .safe_sub(in_fee_amount)?
            .safe_mul(swap_price_num.cast::<i128>()?)?
            .safe_div(swap_price_denom.cast::<i128>()?)?
            .cast::<u128>()?;

        let out_fee_amount = out_amount
            .cast::<i128>()?
            .safe_mul(out_fee as i128)?
            .safe_div(PERCENTAGE_PRECISION_I128)?;

        Ok((in_amount, out_amount, in_fee_amount, out_fee_amount))
    }

    /// Calculates the amount of LP tokens to mint for a given input of constituent tokens.
    /// Returns the mint_amount in lp token precision and fee to charge in constituent mint precision
    pub fn get_add_liquidity_mint_amount(
        &self,
        now: i64,
        in_spot_market: &SpotMarket,
        in_constituent: &Constituent,
        in_amount: u128,
        in_oracle: &OraclePriceData,
        in_target_weight: i64,
        dlp_total_supply: u64,
    ) -> DriftResult<(u64, u128, i64, i128)> {
        let (in_fee_pct, out_fee_pct) = if self.last_aum == 0 {
            (0, 0)
        } else {
            self.get_swap_fees(
                in_spot_market,
                in_oracle.price,
                in_constituent,
                in_amount.cast::<i128>()?,
                in_target_weight,
                None,
                None,
                None,
                None,
                0,
            )?
        };
        let in_fee_pct = in_fee_pct.safe_add(out_fee_pct)?;
        let in_fee_amount = in_amount
            .cast::<i128>()?
            .safe_mul(in_fee_pct)?
            .safe_div(PERCENTAGE_PRECISION_I128)?;

        let in_amount_less_fees = in_amount
            .cast::<i128>()?
            .safe_sub(in_fee_amount)?
            .max(0)
            .cast::<u128>()?;

        let token_precision_denominator = 10_u128.pow(in_spot_market.decimals);
        let token_amount_usd = in_oracle
            .price
            .cast::<u128>()?
            .safe_mul(in_amount_less_fees)?;
        let lp_amount = if self.last_aum == 0 {
            token_amount_usd.safe_div(token_precision_denominator)?
        } else {
            token_amount_usd
                .safe_mul(dlp_total_supply.max(1) as u128)?
                .safe_div(self.last_aum.safe_mul(token_precision_denominator)?)?
        };

        let lp_fee_to_charge_pct = self.get_mint_redeem_fee(now, true)?;
        let lp_fee_to_charge = lp_amount
            .safe_mul(lp_fee_to_charge_pct as u128)?
            .safe_div(PERCENTAGE_PRECISION)?
            .cast::<i64>()?;

        Ok((
            lp_amount.cast::<u64>()?,
            in_amount,
            lp_fee_to_charge,
            in_fee_amount,
        ))
    }

    /// Calculates the amount of constituent tokens to receive for a given amount of LP tokens to burn
    /// Returns the mint_amount in lp token precision and fee to charge in constituent mint precision
    pub fn get_remove_liquidity_amount(
        &self,
        now: i64,
        out_spot_market: &SpotMarket,
        out_constituent: &Constituent,
        lp_burn_amount: u64,
        out_oracle: &OraclePriceData,
        out_target_weight: i64,
        dlp_total_supply: u64,
    ) -> DriftResult<(u64, u128, i64, i128)> {
        let lp_fee_to_charge_pct = self.get_mint_redeem_fee(now, false)?;
        let lp_fee_to_charge = lp_burn_amount
            .cast::<i128>()?
            .safe_mul(lp_fee_to_charge_pct.cast::<i128>()?)?
            .safe_div(PERCENTAGE_PRECISION_I128)?
            .cast::<i64>()?;

        let lp_amount_less_fees = (lp_burn_amount as i128).safe_sub(lp_fee_to_charge as i128)?;

        let token_precision_denominator = 10_u128.pow(out_spot_market.decimals);

        // Calculate proportion of LP tokens being burned
        let proportion = lp_amount_less_fees
            .cast::<u128>()?
            .safe_mul(PERCENTAGE_PRECISION)?
            .safe_mul(PERCENTAGE_PRECISION)?
            .safe_div(dlp_total_supply as u128)?;

        // Apply proportion to AUM and convert to token amount
        let out_amount = self
            .last_aum
            .safe_mul(proportion)?
            .safe_mul(token_precision_denominator)?
            .safe_div(PERCENTAGE_PRECISION)?
            .safe_div(PERCENTAGE_PRECISION)?
            .safe_div(out_oracle.price.cast::<u128>()?)?;

        let (in_fee_pct, out_fee_pct) = self.get_swap_fees(
            out_spot_market,
            out_oracle.price,
            out_constituent,
            out_amount.cast::<i128>()?.safe_mul(-1_i128)?,
            out_target_weight,
            None,
            None,
            None,
            None,
            0,
        )?;
        let out_fee_pct = in_fee_pct.safe_add(out_fee_pct)?;
        let out_fee_amount = out_amount
            .safe_mul(out_fee_pct.cast::<u128>()?)?
            .safe_div(PERCENTAGE_PRECISION)?
            .cast::<i128>()?;

        Ok((lp_burn_amount, out_amount, lp_fee_to_charge, out_fee_amount))
    }

    pub fn get_quadratic_fee_inventory(
        &self,
        gamma_covar: [[i128; 2]; 2],
        pre_notional_errors: [i128; 2],
        post_notional_errors: [i128; 2],
        trade_notional: i128,
    ) -> DriftResult<(i128, i128)> {
        let gamma_covar_error_pre_in = gamma_covar[0][0]
            .safe_mul(pre_notional_errors[0])?
            .safe_add(gamma_covar[0][1].safe_mul(pre_notional_errors[1])?)?
            .safe_div(PERCENTAGE_PRECISION_I128)?;
        let gamma_covar_error_pre_out = gamma_covar[1][0]
            .safe_mul(pre_notional_errors[0])?
            .safe_add(gamma_covar[1][1].safe_mul(pre_notional_errors[1])?)?
            .safe_div(PERCENTAGE_PRECISION_I128)?;

        let gamma_covar_error_post_in = gamma_covar[0][0]
            .safe_mul(post_notional_errors[0])?
            .safe_add(gamma_covar[0][1].safe_mul(post_notional_errors[1])?)?
            .safe_div(PERCENTAGE_PRECISION_I128)?;
        let gamma_covar_error_post_out = gamma_covar[1][0]
            .safe_mul(post_notional_errors[0])?
            .safe_add(gamma_covar[1][1].safe_mul(post_notional_errors[1])?)?
            .safe_div(PERCENTAGE_PRECISION_I128)?;

        let c_pre_in: i128 = gamma_covar_error_pre_in
            .safe_mul(pre_notional_errors[0])?
            .safe_div(2)?
            .safe_div(QUOTE_PRECISION_I128)?;
        let c_pre_out = gamma_covar_error_pre_out
            .safe_mul(pre_notional_errors[1])?
            .safe_div(2)?
            .safe_div(QUOTE_PRECISION_I128)?;

        let c_post_in: i128 = gamma_covar_error_post_in
            .safe_mul(post_notional_errors[0])?
            .safe_div(2)?
            .safe_div(QUOTE_PRECISION_I128)?;
        let c_post_out = gamma_covar_error_post_out
            .safe_mul(post_notional_errors[1])?
            .safe_div(2)?
            .safe_div(QUOTE_PRECISION_I128)?;

        let in_fee = c_post_in
            .safe_sub(c_pre_in)?
            .safe_mul(PERCENTAGE_PRECISION_I128)?
            .safe_div(trade_notional)?
            .safe_mul(QUOTE_PRECISION_I128)?
            .safe_div(self.last_aum.cast::<i128>()?)?;
        let out_fee = c_post_out
            .safe_sub(c_pre_out)?
            .safe_mul(PERCENTAGE_PRECISION_I128)?
            .safe_div(trade_notional)?
            .safe_mul(QUOTE_PRECISION_I128)?
            .safe_div(self.last_aum.cast::<i128>()?)?;

        Ok((in_fee, out_fee))
    }

    pub fn get_linear_fee_execution(
        &self,
        trade_notional: i128,
        kappa_execution: u64,
        xi: u8,
        spot_depth: u128,
    ) -> DriftResult<i128> {
        let trade_ratio: i128 = trade_notional
            .abs()
            .safe_mul(PERCENTAGE_PRECISION_I128)?
            .safe_div(spot_depth.cast::<i128>()?)?;

        trade_ratio
            .safe_mul(kappa_execution.safe_mul(xi as u64)?.cast::<i128>()?)?
            .safe_div(PERCENTAGE_PRECISION_I128)
    }

    pub fn get_quadratic_fee_execution(
        &self,
        trade_notional: i128,
        kappa_execution: u64,
        xi: u8,
        spot_depth: u128,
    ) -> DriftResult<i128> {
        let scaled_abs_trade_notional = trade_notional
            .abs()
            .safe_mul(PERCENTAGE_PRECISION_I128)?
            .safe_div(spot_depth.cast::<i128>()?)?;

        kappa_execution
            .cast::<i128>()?
            .safe_mul(xi.safe_mul(xi)?.cast::<i128>()?)?
            .safe_mul(scaled_abs_trade_notional.safe_mul(scaled_abs_trade_notional)?)?
            .safe_div(PERCENTAGE_PRECISION_I128)?
            .safe_div(PERCENTAGE_PRECISION_I128)
    }

    /// returns fee in PERCENTAGE_PRECISION
    pub fn get_swap_fees(
        &self,
        in_spot_market: &SpotMarket,
        in_oracle_price: i64,
        in_constituent: &Constituent,
        in_amount: i128,
        in_target_weight: i64,
        out_spot_market: Option<&SpotMarket>,
        out_oracle_price: Option<i64>,
        out_constituent: Option<&Constituent>,
        out_target_weight: Option<i64>,
        correlation: i64,
    ) -> DriftResult<(i128, i128)> {
        let notional_trade_size =
            in_constituent.get_notional(in_oracle_price, in_spot_market, in_amount, false)?;
        let out_amount = if out_oracle_price.is_some() {
            notional_trade_size
                .safe_div(out_oracle_price.unwrap().cast::<i128>()?)?
                .safe_mul(10_i128.pow(out_spot_market.unwrap().decimals as u32))?
        } else {
            0
        };

        // Compute scalars
        let in_volatility = in_constituent.volatility;
        let out_volatility = if out_constituent.is_some() {
            out_constituent.unwrap().volatility
        } else {
            self.volatility
        };
        let out_gamma_execution = if out_constituent.is_some() {
            out_constituent.unwrap().gamma_execution
        } else {
            self.gamma_execution
        };
        let out_gamma_inventory = if out_constituent.is_some() {
            out_constituent.unwrap().gamma_inventory
        } else {
            0
        };
        let out_xi = if out_constituent.is_some() {
            out_constituent.unwrap().xi
        } else {
            self.xi
        };

        let in_kappa_execution = in_volatility
            .safe_mul(in_volatility)?
            .safe_mul(in_constituent.gamma_execution as u64)?
            .safe_div(PERCENTAGE_PRECISION_U64)?
            .safe_div(2u64)?;

        let out_kappa_execution = out_volatility
            .safe_mul(out_volatility)?
            .safe_mul(out_gamma_execution as u64)?
            .safe_div(PERCENTAGE_PRECISION_U64)?
            .safe_div(2u64)?;

        // Compute notional targets and errors
        let in_notional_target = in_target_weight
            .cast::<i128>()?
            .safe_mul(self.last_aum.cast::<i128>()?)?
            .safe_div(PERCENTAGE_PRECISION_I128)?;
        let in_notional_before =
            in_constituent.get_notional(in_oracle_price, in_spot_market, 0, true)?;
        let in_notional_after =
            in_constituent.get_notional(in_oracle_price, in_spot_market, in_amount, true)?;
        let in_notional_error_pre = in_notional_before.safe_sub(in_notional_target)?;

        // keep aum fixed if it's a swap for calculating post error, othwerise
        // increase aum first
        let in_notional_error_post = if out_spot_market.is_some() {
            in_notional_after.safe_sub(in_notional_target)?
        } else {
            let adjusted_aum = self
                .last_aum
                .cast::<i128>()?
                .safe_add(notional_trade_size)?;
            let in_notional_target_post_mint_redeem = in_target_weight
                .cast::<i128>()?
                .safe_mul(adjusted_aum)?
                .safe_div(PERCENTAGE_PRECISION_I128)?;
            in_notional_after.safe_sub(in_notional_target_post_mint_redeem)?
        };

        let (out_notional_target, out_notional_before, out_notional_after) =
            if out_constituent.is_some() {
                (
                    out_target_weight
                        .unwrap()
                        .cast::<i128>()?
                        .safe_mul(self.last_aum.cast::<i128>()?)?
                        .safe_div(PERCENTAGE_PRECISION_I128)?,
                    out_constituent.unwrap().get_notional(
                        out_oracle_price.unwrap(),
                        out_spot_market.unwrap(),
                        0,
                        true,
                    )?,
                    out_constituent.unwrap().get_notional(
                        out_oracle_price.unwrap(),
                        out_spot_market.unwrap(),
                        out_amount.safe_mul(-1)?,
                        true,
                    )?,
                )
            } else {
                (0_i128, 0_i128, 0_i128)
            };

        let out_notional_error_pre = out_notional_before.safe_sub(out_notional_target)?;
        let out_notional_error_post = out_notional_after.safe_sub(out_notional_target)?;

        // Linear fee computation amount
        let in_fee_execution_linear = self.get_linear_fee_execution(
            notional_trade_size,
            in_kappa_execution,
            in_constituent.xi,
            self.last_aum.max(MIN_AUM_EXECUTION_FEE),
        )?;

        let out_fee_execution_linear = self.get_linear_fee_execution(
            notional_trade_size,
            out_kappa_execution,
            out_xi,
            self.last_aum.max(MIN_AUM_EXECUTION_FEE),
        )?;

        // Quadratic fee components
        let in_fee_execution_quadratic = self.get_quadratic_fee_execution(
            notional_trade_size,
            in_kappa_execution,
            in_constituent.xi,
            self.last_aum.max(MIN_AUM_EXECUTION_FEE), // use 10M at very least
        )?;
        let out_fee_execution_quadratic = self.get_quadratic_fee_execution(
            notional_trade_size,
            out_kappa_execution,
            out_xi,
            self.last_aum.max(MIN_AUM_EXECUTION_FEE),
        )?;
        let (in_quadratic_inventory_fee, out_quadratic_inventory_fee) = self
            .get_quadratic_fee_inventory(
                get_gamma_covar_matrix(
                    correlation,
                    in_constituent.gamma_inventory,
                    out_gamma_inventory,
                    in_constituent.volatility,
                    out_volatility,
                )?,
                [in_notional_error_pre, out_notional_error_pre],
                [in_notional_error_post, out_notional_error_post],
                notional_trade_size,
            )?;

        msg!(
            "fee breakdown - in_exec_linear: {}, in_exec_quad: {}, in_inv_quad: {}, out_exec_linear: {}, out_exec_quad: {}, out_inv_quad: {}",
            in_fee_execution_linear,
            in_fee_execution_quadratic,
            in_quadratic_inventory_fee,
            out_fee_execution_linear,
            out_fee_execution_quadratic,
            out_quadratic_inventory_fee
        );
        let total_in_fee = in_fee_execution_linear
            .safe_add(in_fee_execution_quadratic)?
            .safe_add(in_quadratic_inventory_fee)?
            .safe_add(BASE_SWAP_FEE.safe_div(2)?)?;
        let total_out_fee = out_fee_execution_linear
            .safe_add(out_fee_execution_quadratic)?
            .safe_add(out_quadratic_inventory_fee)?
            .safe_add(BASE_SWAP_FEE.safe_div(2)?)?;

        Ok((
            total_in_fee.min(MAX_SWAP_FEE.safe_div(2)?),
            total_out_fee.min(MAX_SWAP_FEE.safe_div(2)?),
        ))
    }

    /// Returns the fee to charge for a mint or redeem in PERCENTAGE_PRECISION
    pub fn get_mint_redeem_fee(&self, now: i64, is_minting: bool) -> DriftResult<i64> {
        let time_since_last_rebalance =
            now.safe_sub(self.last_revenue_rebalance_ts.cast::<i64>()?)?;
        if is_minting {
            // mint fee
            self.min_mint_fee.safe_add(
                self.max_mint_fee_premium.min(
                    self.max_mint_fee_premium
                        .safe_mul(time_since_last_rebalance)?
                        .safe_div(self.revenue_rebalance_period.cast::<i64>()?)?,
                ),
            )
        } else {
            // burn fee
            self.min_mint_fee.safe_add(
                0_i64.max(
                    self.max_mint_fee_premium.min(
                        self.revenue_rebalance_period
                            .cast::<i64>()?
                            .safe_sub(time_since_last_rebalance)?
                            .cast::<i64>()?
                            .safe_mul(self.max_mint_fee_premium.cast::<i64>()?)?
                            .safe_div(self.revenue_rebalance_period.cast::<i64>()?)?,
                    ),
                ),
            )
        }
    }

    pub fn record_mint_redeem_fees(&mut self, amount: i64) -> DriftResult {
        self.total_mint_redeem_fees_paid = self
            .total_mint_redeem_fees_paid
            .safe_add(amount.cast::<i128>()?)?;
        Ok(())
    }

    pub fn update_aum(
        &mut self,
        now: i64,
        slot: u64,
        constituent_map: &ConstituentMap,
        spot_market_map: &SpotMarketMap,
        constituent_target_base: &AccountZeroCopyMut<'_, TargetsDatum, ConstituentTargetBaseFixed>,
        amm_cache: &AccountZeroCopyMut<'_, CacheInfo, AmmCacheFixed>,
    ) -> DriftResult<(u128, i128, BTreeMap<u16, Vec<u16>>)> {
        let mut aum: u128 = 0;
        let mut crypto_delta = 0_i128;
        let mut oldest_slot = u64::MAX;
        let mut derivative_groups: BTreeMap<u16, Vec<u16>> = BTreeMap::new();
        for i in 0..self.constituents as usize {
            let constituent = constituent_map.get_ref(&(i as u16))?;
            if slot.saturating_sub(constituent.last_oracle_slot)
                > MAX_CONSTITUENT_ORACLE_SLOT_STALENESS_FOR_AUM
            {
                msg!(
                    "Constituent {} oracle slot is too stale: {}, current slot: {}",
                    constituent.constituent_index,
                    constituent.last_oracle_slot,
                    slot
                );
                return Err(ErrorCode::ConstituentOracleStale.into());
            }

            if constituent.constituent_derivative_index >= 0 && constituent.derivative_weight != 0 {
                if !derivative_groups
                    .contains_key(&(constituent.constituent_derivative_index as u16))
                {
                    derivative_groups.insert(
                        constituent.constituent_derivative_index as u16,
                        vec![constituent.constituent_index],
                    );
                } else {
                    derivative_groups
                        .get_mut(&(constituent.constituent_derivative_index as u16))
                        .unwrap()
                        .push(constituent.constituent_index);
                }
            }

            let spot_market = spot_market_map.get_ref(&constituent.spot_market_index)?;

            let oracle_slot = constituent.last_oracle_slot;

            if oracle_slot < oldest_slot {
                oldest_slot = oracle_slot;
            }

            // msg!("{} spot_market.decimals: {}", spot_market.market_index, spot_market.decimals);
            // let (numerator_scale, denominator_scale) = if spot_market.decimals > 6 {
            //     (10_i128.pow(spot_market.decimals - 6), 1)
            // } else {
            //     (1, 10_i128.pow(6 - spot_market.decimals))
            // };

            let constituent_aum = constituent
                .get_full_balance(&spot_market)?
                .safe_mul(constituent.last_oracle_price as i128)?
                .safe_div(10_i128.pow(spot_market.decimals))?
                .max(0);
            msg!(
                "constituent: {}, balance: {}, aum: {}, deriv index: {}",
                constituent.constituent_index,
                constituent.get_full_balance(&spot_market)?,
                constituent_aum,
                constituent.constituent_derivative_index
            );
            if constituent.constituent_index != self.usdc_consituent_index
                && constituent.constituent_derivative_index != self.usdc_consituent_index as i16
            {
                let constituent_target_notional = constituent_target_base
                    .get(constituent.constituent_index as u32)
                    .target_base
                    .safe_mul(constituent.last_oracle_price)?
                    .safe_div(10_i64.pow(constituent.decimals as u32))?;
                crypto_delta = crypto_delta.safe_add(constituent_target_notional.cast()?)?;
            }
            aum = aum.safe_add(constituent_aum.cast()?)?;
        }

        let mut aum_i128 = aum.cast::<i128>()?;
        for cache_datum in amm_cache.iter() {
            aum_i128 -= cache_datum.quote_owed_from_lp_pool as i128;
        }
        aum = aum_i128.max(0i128).cast::<u128>()?;

        self.oldest_oracle_slot = oldest_slot;
        self.last_aum = aum;
        self.last_aum_slot = slot;
        self.last_aum_ts = now;

        Ok((aum, crypto_delta, derivative_groups))
    }
}

#[zero_copy(unsafe)]
#[derive(Default, Eq, PartialEq, Debug, BorshDeserialize, BorshSerialize)]
#[repr(C)]
pub struct BLPosition {
    /// The scaled balance of the position. To get the token amount, multiply by the cumulative deposit/borrow
    /// interest of corresponding market.
    /// precision: token precision
    pub scaled_balance: u128,
    /// The cumulative deposits/borrows a user has made into a market
    /// precision: token mint precision
    pub cumulative_deposits: i64,
    /// The market index of the corresponding spot market
    pub market_index: u16,
    /// Whether the position is deposit or borrow
    pub balance_type: SpotBalanceType,
    pub padding: [u8; 5],
}

impl SpotBalance for BLPosition {
    fn market_index(&self) -> u16 {
        self.market_index
    }

    fn balance_type(&self) -> &SpotBalanceType {
        &self.balance_type
    }

    fn balance(&self) -> u128 {
        self.scaled_balance as u128
    }

    fn increase_balance(&mut self, delta: u128) -> DriftResult {
        self.scaled_balance = self.scaled_balance.safe_add(delta)?;
        Ok(())
    }

    fn decrease_balance(&mut self, delta: u128) -> DriftResult {
        self.scaled_balance = self.scaled_balance.safe_sub(delta)?;
        Ok(())
    }

    fn update_balance_type(&mut self, balance_type: SpotBalanceType) -> DriftResult {
        self.balance_type = balance_type;
        Ok(())
    }
}

impl BLPosition {
    pub fn get_token_amount(&self, spot_market: &SpotMarket) -> DriftResult<u128> {
        get_token_amount(self.scaled_balance, spot_market, &self.balance_type)
    }
}

#[account(zero_copy(unsafe))]
#[derive(Default, Debug, BorshDeserialize, BorshSerialize)]
#[repr(C)]
pub struct Constituent {
    /// address of the constituent
    pub pubkey: Pubkey,
    pub mint: Pubkey,
    pub lp_pool: Pubkey,
    pub token_vault: Pubkey,

    /// total fees received by the constituent. Positive = fees received, Negative = fees paid
    pub total_swap_fees: i128,

    /// spot borrow-lend balance for constituent
    pub spot_balance: BLPosition, // should be in constituent base asset

    /// max deviation from target_weight allowed for the constituent
    /// precision: PERCENTAGE_PRECISION
    pub max_weight_deviation: i64,
    /// min fee charged on swaps to/from this constituent
    /// precision: PERCENTAGE_PRECISION
    pub swap_fee_min: i64,
    /// max fee charged on swaps to/from this constituent
    /// precision: PERCENTAGE_PRECISION
    pub swap_fee_max: i64,

    /// ata token balance in token precision
    pub token_balance: u64,

    pub last_oracle_price: i64,
    pub last_oracle_slot: u64,

    pub oracle_staleness_threshold: u64,

    pub flash_loan_initial_token_amount: u64,
    /// Every swap to/from this constituent has a monotonically increasing id. This is the next id to use
    pub next_swap_id: u64,

    /// percentable of derivatve weight to go to this specific derivative PERCENTAGE_PRECISION. Zero if no derivative weight
    pub derivative_weight: u64,

    pub volatility: u64, // volatility in PERCENTAGE_PRECISION 1=1%

    // depeg threshold in relation top parent in PERCENTAGE_PRECISION
    pub constituent_derivative_depeg_threshold: u64,

    pub constituent_derivative_index: i16, // -1 if a parent index

    pub spot_market_index: u16,
    pub constituent_index: u16,

    pub decimals: u8,
    pub bump: u8,

    // Fee params
    pub gamma_inventory: u8,
    pub gamma_execution: u8,
    pub xi: u8,
    pub _padding: [u8; 5],
}

impl Size for Constituent {
    const SIZE: usize = 296;
}

impl Constituent {
    /// Returns the full balance of the Constituent, the total of the amount in Constituent's token
    /// account and in Drift Borrow-Lend.
    pub fn get_full_balance(&self, spot_market: &SpotMarket) -> DriftResult<i128> {
        match self.spot_balance.balance_type() {
            SpotBalanceType::Deposit => self.token_balance.cast::<i128>()?.safe_add(
                self.spot_balance
                    .get_token_amount(spot_market)?
                    .cast::<i128>()?,
            ),
            SpotBalanceType::Borrow => self.token_balance.cast::<i128>()?.safe_sub(
                self.spot_balance
                    .get_token_amount(spot_market)?
                    .cast::<i128>()?,
            ),
        }
    }

    pub fn record_swap_fees(&mut self, amount: i128) -> DriftResult {
        self.total_swap_fees = self.total_swap_fees.safe_add(amount)?;
        Ok(())
    }

    /// Current weight of this constituent = price * token_balance / lp_pool_aum
    /// Note: lp_pool_aum is from LPPool.last_aum, which is a lagged value updated via crank
    pub fn get_weight(
        &self,
        price: i64,
        spot_market: &SpotMarket,
        token_amount_delta: i128,
        lp_pool_aum: u128,
    ) -> DriftResult<i64> {
        if lp_pool_aum == 0 {
            return Ok(0);
        }
        let value_usd = self.get_notional(price, spot_market, token_amount_delta, true)?;

        value_usd
            .safe_mul(PERCENTAGE_PRECISION_I64.cast::<i128>()?)?
            .safe_div(lp_pool_aum.cast::<i128>()?)?
            .cast::<i64>()
    }

    pub fn get_notional(
        &self,
        price: i64,
        spot_market: &SpotMarket,
        token_amount: i128,
        is_delta: bool,
    ) -> DriftResult<i128> {
        let token_precision = 10_i128.pow(self.decimals as u32);
        let amount = if is_delta {
            let balance = self.get_full_balance(spot_market)?.cast::<i128>()?;
            balance.safe_add(token_amount)?
        } else {
            token_amount
        };

        let value_usd = amount.safe_mul(price.cast::<i128>()?)?;
        value_usd
            .safe_mul(QUOTE_PRECISION_I128)?
            .safe_div(PRICE_PRECISION_I128)?
            .safe_div(token_precision)
    }

    /// Returns the fee to charge for a swap to/from this constituent
    /// The fee is a linear interpolation between the swap_fee_min and swap_fee_max based on the post-swap deviation from the target weight
    /// precision: PERCENTAGE_PRECISION
    pub fn get_fee_to_charge(&self, post_swap_weight: i64, target_weight: i64) -> DriftResult<i64> {
        let min_weight = target_weight.safe_sub(self.max_weight_deviation as i64)?;
        let max_weight = target_weight.safe_add(self.max_weight_deviation as i64)?;
        let (slope_numerator, slope_denominator) = if post_swap_weight > target_weight {
            let num = self.swap_fee_max.safe_sub(self.swap_fee_min)?;
            let denom = max_weight.safe_sub(target_weight)?;
            (num, denom)
        } else {
            let num = self.swap_fee_min.safe_sub(self.swap_fee_max)?;
            let denom = target_weight.safe_sub(min_weight)?;
            (num, denom)
        };
        if slope_denominator == 0 {
            return Ok(self.swap_fee_min);
        }
        let b = self
            .swap_fee_min
            .safe_mul(slope_denominator)?
            .safe_sub(target_weight.safe_mul(slope_numerator)?)?;
        Ok(post_swap_weight
            .safe_mul(slope_numerator)?
            .safe_add(b)?
            .safe_div(slope_denominator)?
            .clamp(self.swap_fee_min, self.swap_fee_max))
    }

    pub fn sync_token_balance(&mut self, token_account_amount: u64) {
        self.token_balance = token_account_amount;
    }
}

#[zero_copy]
#[derive(Debug, BorshDeserialize, BorshSerialize)]
#[repr(C)]
pub struct AmmConstituentDatum {
    pub perp_market_index: u16,
    pub constituent_index: u16,
    pub _padding: [u8; 4],
    pub last_slot: u64,
    /// PERCENTAGE_PRECISION. The weight this constituent has on the perp market
    pub weight: i64,
}

impl Default for AmmConstituentDatum {
    fn default() -> Self {
        AmmConstituentDatum {
            perp_market_index: u16::MAX,
            constituent_index: u16::MAX,
            _padding: [0; 4],
            last_slot: 0,
            weight: 0,
        }
    }
}

#[zero_copy]
#[derive(Debug, Default)]
#[repr(C)]
pub struct AmmConstituentMappingFixed {
    pub lp_pool: Pubkey,
    pub bump: u8,
    pub _pad: [u8; 3],
    pub len: u32,
}

impl HasLen for AmmConstituentMappingFixed {
    fn len(&self) -> u32 {
        self.len
    }
}

#[account]
#[derive(Debug)]
#[repr(C)]
pub struct AmmConstituentMapping {
    pub lp_pool: Pubkey,
    pub bump: u8,
    _padding: [u8; 3],
    // PERCENTAGE_PRECISION. Each datum represents the target weight for a single (AMM, Constituent) pair.
    // An AMM may be partially backed by multiple Constituents
    pub weights: Vec<AmmConstituentDatum>,
}

impl AmmConstituentMapping {
    pub fn space(num_constituents: usize) -> usize {
        8 + 40 + num_constituents * 24
    }

    pub fn validate(&self) -> DriftResult<()> {
        validate!(
            self.weights.len() <= 128,
            ErrorCode::DefaultError,
            "Number of constituents len must be between 1 and 128"
        )?;
        Ok(())
    }
}

impl_zero_copy_loader!(
    AmmConstituentMapping,
    crate::id,
    AmmConstituentMappingFixed,
    AmmConstituentDatum
);

#[zero_copy]
#[derive(Debug, Default, BorshDeserialize, BorshSerialize)]
#[repr(C)]
pub struct TargetsDatum {
    pub cost_to_trade_bps: i32,
    pub _padding: [u8; 4],
    pub last_slot: u64,
    pub target_base: i64,
}

#[zero_copy]
#[derive(Debug, Default)]
#[repr(C)]
pub struct ConstituentTargetBaseFixed {
    pub lp_pool: Pubkey,
    pub bump: u8,
    _pad: [u8; 3],
    /// total elements in the flattened `data` vec
    pub len: u32,
}

impl HasLen for ConstituentTargetBaseFixed {
    fn len(&self) -> u32 {
        self.len
    }
}

#[account]
#[derive(Debug)]
#[repr(C)]
pub struct ConstituentTargetBase {
    pub lp_pool: Pubkey,
    pub bump: u8,
    _padding: [u8; 3],
    // PERCENTAGE_PRECISION. The weights of the target weight matrix. Updated async
    pub targets: Vec<TargetsDatum>,
}

impl ConstituentTargetBase {
    pub fn space(num_constituents: usize) -> usize {
        8 + 40 + num_constituents * 24
    }

    pub fn validate(&self) -> DriftResult<()> {
        validate!(
            self.targets.len() <= 128,
            ErrorCode::DefaultError,
            "Number of constituents len must be between 1 and 128"
        )?;

        validate!(
            !self.targets.iter().any(|t| t.cost_to_trade_bps == 0),
            ErrorCode::DefaultError,
            "cost_to_trade_bps must be non-zero"
        )?;

        Ok(())
    }
}

impl_zero_copy_loader!(
    ConstituentTargetBase,
    crate::id,
    ConstituentTargetBaseFixed,
    TargetsDatum
);

impl Default for ConstituentTargetBase {
    fn default() -> Self {
        ConstituentTargetBase {
            lp_pool: Pubkey::default(),
            bump: 0,
            _padding: [0; 3],
            targets: Vec::with_capacity(0),
        }
    }
}

#[derive(Clone, Copy, BorshSerialize, BorshDeserialize, PartialEq, Debug, Eq)]
pub enum WeightValidationFlags {
    NONE = 0b0000_0000,
    EnforceTotalWeight100 = 0b0000_0001,
    NoNegativeWeights = 0b0000_0010,
    NoOverweight = 0b0000_0100,
}

impl<'a> AccountZeroCopy<'a, TargetsDatum, ConstituentTargetBaseFixed> {
    pub fn get_target_weight(
        &self,
        constituent_index: u16,
        spot_market: &SpotMarket,
        price: i64,
        aum: u128,
    ) -> DriftResult<i64> {
        validate!(
            constituent_index < self.len() as u16,
            ErrorCode::InvalidConstituent,
            "Invalid constituent_index = {}, ConstituentTargetBase len = {}",
            constituent_index,
            self.len()
        )?;

        // TODO: validate spot market
        let datum = self.get(constituent_index as u32);
        let target_weight = calculate_target_weight(
            datum.target_base,
            &spot_market,
            price,
            aum,
            WeightValidationFlags::NONE,
        )?;
        Ok(target_weight)
    }
}

pub fn calculate_target_weight(
    target_base: i64,
    spot_market: &SpotMarket,
    price: i64,
    lp_pool_aum: u128,
    validation_flags: WeightValidationFlags,
) -> DriftResult<i64> {
    if lp_pool_aum == 0 {
        return Ok(0);
    }
    let notional: i128 = (target_base as i128)
        .safe_mul(price as i128)?
        .safe_div(10_i128.pow(spot_market.decimals))?;

    let target_weight = notional
        .safe_mul(PERCENTAGE_PRECISION_I128)?
        .safe_div(lp_pool_aum.cast::<i128>()?)?
        .cast::<i64>()?
        .clamp(-1 * PERCENTAGE_PRECISION_I64, PERCENTAGE_PRECISION_I64);

    // if (validation_flags as u8 & (WeightValidationFlags::NoNegativeWeights as u8) != 0)
    //     && target_weight < 0
    // {
    //     return Err(ErrorCode::DefaultError);
    // }
    // if (validation_flags as u8 & (WeightValidationFlags::NoOverweight as u8) != 0)
    //     && target_weight > PERCENTAGE_PRECISION_I64 as i128
    // {
    //     return Err(ErrorCode::DefaultError);
    // }

    // if (validation_flags as u8) & WeightValidationFlags::EnforceTotalWeight100 as u8 != 0 {
    //     let deviation = (total_weight - PERCENTAGE_PRECISION_I128).abs();
    //     let tolerance = 100;
    //     if deviation > tolerance {
    //         return Err(ErrorCode::DefaultError);
    //     }
    // }

    Ok(target_weight)
}

/// Update target base based on amm_inventory and mapping
impl<'a> AccountZeroCopyMut<'a, TargetsDatum, ConstituentTargetBaseFixed> {
    pub fn update_target_base(
        &mut self,
        mapping: &AccountZeroCopy<'a, AmmConstituentDatum, AmmConstituentMappingFixed>,
        // (perp market index, inventory, price)
        amm_inventory_and_prices: &[(u16, i64, i64)],
        constituents_indexes_and_decimals_and_prices: &[(u16, u8, i64)],
        slot: u64,
    ) -> DriftResult<Vec<i128>> {
        let mut results = Vec::with_capacity(constituents_indexes_and_decimals_and_prices.len());
        for (i, constituent_index_and_price) in constituents_indexes_and_decimals_and_prices
            .iter()
            .enumerate()
        {
            let mut target_notional = 0i128;
            let constituent_index = constituent_index_and_price.0;
            let decimals = constituent_index_and_price.1;
            let price = constituent_index_and_price.2;

            for (perp_market_index, inventory, price) in amm_inventory_and_prices.iter() {
                let idx = mapping.iter().position(|d| {
                    &d.perp_market_index == perp_market_index
                        && d.constituent_index == constituent_index
                });
                if idx.is_none() {
                    msg!(
                        "No mapping found for perp market index {} and constituent index {}",
                        perp_market_index,
                        constituent_index
                    );
                    continue;
                }

                let weight = mapping.get(idx.unwrap() as u32).weight; // PERCENTAGE_PRECISION

                let notional: i128 = (*inventory as i128)
                    .safe_mul(*price as i128)?
                    .safe_div(BASE_PRECISION_I128)?;

                target_notional += notional
                    .saturating_mul(weight as i128)
                    .saturating_div(PERCENTAGE_PRECISION_I128);
            }

            let cell = self.get_mut(i as u32);
            let target_base = target_notional
                .safe_mul(10_i128.pow(decimals as u32))?
                .safe_div(price as i128)?
                * -1; // Want to target opposite sign of total scaled notional inventory

            msg!(
                "updating constituent index {} target base to {} from target notional {}",
                constituent_index,
                target_base,
                target_notional,
            );
            cell.target_base = target_base.cast::<i64>()?;
            cell.last_slot = slot;

            results.push(target_base);
        }

        Ok(results)
    }
}

impl<'a> AccountZeroCopyMut<'a, AmmConstituentDatum, AmmConstituentMappingFixed> {
    pub fn add_amm_constituent_datum(&mut self, datum: AmmConstituentDatum) -> DriftResult<()> {
        let len = self.len();

        let mut open_slot_index: Option<u32> = None;
        for i in 0..len {
            let cell = self.get(i as u32);
            if cell.constituent_index == datum.constituent_index
                && cell.perp_market_index == datum.perp_market_index
            {
                return Err(ErrorCode::DefaultError);
            }
            if cell.last_slot == 0 && open_slot_index.is_none() {
                open_slot_index = Some(i);
            }
        }
        let open_slot = open_slot_index.ok_or_else(|| ErrorCode::DefaultError.into())?;

        let cell = self.get_mut(open_slot);
        *cell = datum;

        Ok(())
    }
}

#[zero_copy]
#[derive(Debug, Default)]
#[repr(C)]
pub struct ConstituentCorrelationsFixed {
    pub lp_pool: Pubkey,
    pub bump: u8,
    _pad: [u8; 3],
    /// total elements in the flattened `data` vec
    pub len: u32,
}

impl HasLen for ConstituentCorrelationsFixed {
    fn len(&self) -> u32 {
        self.len
    }
}

#[account]
#[derive(Debug)]
#[repr(C)]
pub struct ConstituentCorrelations {
    pub lp_pool: Pubkey,
    pub bump: u8,
    _padding: [u8; 3],
    // PERCENTAGE_PRECISION. The weights of the target weight matrix. Updated async
    pub correlations: Vec<i64>,
}

impl HasLen for ConstituentCorrelations {
    fn len(&self) -> u32 {
        self.correlations.len() as u32
    }
}

impl_zero_copy_loader!(
    ConstituentCorrelations,
    crate::id,
    ConstituentCorrelationsFixed,
    i64
);

impl ConstituentCorrelations {
    pub fn space(num_constituents: usize) -> usize {
        8 + 40 + num_constituents * num_constituents * 8
    }

    pub fn validate(&self) -> DriftResult<()> {
        let len = self.correlations.len();
        let num_constituents = (len as f32).sqrt() as usize; // f32 is plenty precise for matrix dims < 2^16
        validate!(
            num_constituents * num_constituents == self.correlations.len(),
            ErrorCode::DefaultError,
            "ConstituentCorrelation correlations len must be a perfect square"
        )?;

        for i in 0..num_constituents {
            for j in 0..num_constituents {
                let corr = self.correlations[i * num_constituents + j];
                validate!(
                    corr <= PERCENTAGE_PRECISION_I64,
                    ErrorCode::DefaultError,
                    "ConstituentCorrelation correlations must be between 0 and PERCENTAGE_PRECISION"
                )?;
                let corr_ji = self.correlations[j * num_constituents + i];
                validate!(
                    corr == corr_ji,
                    ErrorCode::DefaultError,
                    "ConstituentCorrelation correlations must be symmetric"
                )?;
            }
            let corr_ii = self.correlations[i * num_constituents + i];
            validate!(
                corr_ii == PERCENTAGE_PRECISION_I64,
                ErrorCode::DefaultError,
                "ConstituentCorrelation correlations diagonal must be PERCENTAGE_PRECISION"
            )?;
        }

        Ok(())
    }

    pub fn add_new_constituent(&mut self, new_constituent_correlations: &[i64]) -> DriftResult {
        // Add a new constituent at index N (where N = old size),
        // given a slice `new_corrs` of length `N` such that
        // new_corrs[i] == correlation[i, N].
        //
        // On entry:
        //   self.correlations.len() == N*N
        //
        // After:
        //   self.correlations.len() == (N+1)*(N+1)
        let len = self.correlations.len();
        let n = (len as f64).sqrt() as usize;
        validate!(
            n * n == len,
            ErrorCode::DefaultError,
            "existing correlations len must be a perfect square"
        )?;
        validate!(
            new_constituent_correlations.len() == n,
            ErrorCode::DefaultError,
            "new_corrs length must equal number of number of other constituents ({})",
            n
        )?;
        for &c in new_constituent_correlations {
            validate!(
                c <= PERCENTAGE_PRECISION_I64,
                ErrorCode::DefaultError,
                "correlation must be ≤ PERCENTAGE_PRECISION"
            )?;
        }

        let new_n = n + 1;
        let mut buf = Vec::with_capacity(new_n * new_n);

        for i in 0..n {
            buf.extend_from_slice(&self.correlations[i * n..i * n + n]);
            buf.push(new_constituent_correlations[i]);
        }

        buf.extend_from_slice(new_constituent_correlations);
        buf.push(PERCENTAGE_PRECISION_I64);

        self.correlations = buf;

        debug_assert_eq!(self.correlations.len(), new_n * new_n);

        Ok(())
    }

    pub fn set_correlation(&mut self, i: u16, j: u16, corr: i64) -> DriftResult {
        let num_constituents = (self.correlations.len() as f64).sqrt() as usize;
        validate!(
            i < num_constituents as u16,
            ErrorCode::InvalidConstituent,
            "Invalid constituent_index i = {}, ConstituentCorrelation len = {}",
            i,
            num_constituents
        )?;
        validate!(
            j < num_constituents as u16,
            ErrorCode::InvalidConstituent,
            "Invalid constituent_index j = {}, ConstituentCorrelation len = {}",
            j,
            num_constituents
        )?;
        validate!(
            corr <= PERCENTAGE_PRECISION_I64,
            ErrorCode::DefaultError,
            "ConstituentCorrelation correlations must be between 0 and PERCENTAGE_PRECISION"
        )?;

        self.correlations[(i as usize * num_constituents + j as usize) as usize] = corr;
        self.correlations[(j as usize * num_constituents + i as usize) as usize] = corr;

        self.validate()?;

        Ok(())
    }
}

impl<'a> AccountZeroCopy<'a, i64, ConstituentCorrelationsFixed> {
    pub fn get_correlation(&self, i: u16, j: u16) -> DriftResult<i64> {
        let num_constituents = (self.len() as f64).sqrt() as usize;
        validate!(
            i < num_constituents as u16,
            ErrorCode::InvalidConstituent,
            "Invalid constituent_index i = {}, ConstituentCorrelation len = {}",
            i,
            num_constituents
        )?;
        validate!(
            j < num_constituents as u16,
            ErrorCode::InvalidConstituent,
            "Invalid constituent_index j = {}, ConstituentCorrelation len = {}",
            j,
            num_constituents
        )?;

        let corr = self.get((i as usize * num_constituents + j as usize) as u32);
        Ok(*corr)
    }
}

pub fn get_gamma_covar_matrix(
    correlation_ij: i64,
    gamma_i: u8,
    gamma_j: u8,
    vol_i: u64,
    vol_j: u64,
) -> DriftResult<[[i128; 2]; 2]> {
    // Build the covariance matrix
    let mut covar_matrix = [[0i128; 2]; 2];
    let scaled_vol_i = vol_i as i128;
    let scaled_vol_j = vol_j as i128;
    covar_matrix[0][0] = scaled_vol_i
        .safe_mul(scaled_vol_i)?
        .safe_div(PERCENTAGE_PRECISION_I128)?;
    covar_matrix[1][1] = scaled_vol_j
        .safe_mul(scaled_vol_j)?
        .safe_div(PERCENTAGE_PRECISION_I128)?;
    covar_matrix[0][1] = scaled_vol_i
        .safe_mul(scaled_vol_j)?
        .safe_mul(correlation_ij as i128)?
        .safe_div(PERCENTAGE_PRECISION_I128)?
        .safe_div(PERCENTAGE_PRECISION_I128)?;
    covar_matrix[1][0] = covar_matrix[0][1];

    // Build the gamma matrix as a diagonal matrix
    let gamma_matrix = [[gamma_i as i128, 0i128], [0i128, gamma_j as i128]];

    // Multiply gamma_matrix with covar_matrix: product = gamma_matrix * covar_matrix
    let mut product = [[0i128; 2]; 2];
    for i in 0..2 {
        for j in 0..2 {
            for k in 0..2 {
                product[i][j] = product[i][j]
                    .checked_add(
                        gamma_matrix[i][k]
                            .checked_mul(covar_matrix[k][j])
                            .ok_or(ErrorCode::MathError)?,
                    )
                    .ok_or(ErrorCode::MathError)?;
            }
        }
    }

    Ok(product)
}

pub fn update_constituent_target_base_for_derivatives(
    aum: u128,
    derivative_groups: &BTreeMap<u16, Vec<u16>>,
    constituent_map: &ConstituentMap,
    spot_market_map: &SpotMarketMap,
    constituent_target_base: &mut AccountZeroCopyMut<'_, TargetsDatum, ConstituentTargetBaseFixed>,
) -> DriftResult<()> {
    for (parent_index, constituent_indexes) in derivative_groups.iter() {
        let parent_constituent = constituent_map.get_ref(&(parent_index))?;
        let parent_target_base = constituent_target_base
            .get(*parent_index as u32)
            .target_base;
        let target_parent_weight = calculate_target_weight(
            parent_target_base,
            &*spot_market_map.get_ref(&parent_constituent.spot_market_index)?,
            parent_constituent.last_oracle_price,
            aum,
            WeightValidationFlags::NONE,
        )?;
        let mut derivative_weights_sum = 0;
        for constituent_index in constituent_indexes {
            let constituent = constituent_map.get_ref(constituent_index)?;
            if constituent.last_oracle_price
                < parent_constituent
                    .last_oracle_price
                    .safe_mul(constituent.constituent_derivative_depeg_threshold as i64)?
                    .safe_div(PERCENTAGE_PRECISION_I64)?
            {
                msg!(
                    "Constituent {} last oracle price {} is too low compared to parent constituent {} last oracle price {}. Assuming depegging and setting target base to 0.",
                    constituent.constituent_index,
                    constituent.last_oracle_price,
                    parent_constituent.constituent_index,
                    parent_constituent.last_oracle_price
                );
                constituent_target_base
                    .get_mut(*constituent_index as u32)
                    .target_base = 0_i64;
                continue;
            }

            derivative_weights_sum += constituent.derivative_weight;

            let target_weight = target_parent_weight
                .safe_mul(constituent.derivative_weight as i64)?
                .safe_div(PERCENTAGE_PRECISION_I64)?;

            msg!(
                "constituent: {}, target weight: {}",
                constituent_index,
                target_weight,
            );
            let target_base = aum
                .cast::<i128>()?
                .safe_mul(target_weight as i128)?
                .safe_div(PERCENTAGE_PRECISION_I128)?
                .safe_mul(10_i128.pow(constituent.decimals as u32))?
                .safe_div(constituent.last_oracle_price as i128)?;

            msg!(
                "constituent: {}, target base: {}",
                constituent_index,
                target_base
            );
            constituent_target_base
                .get_mut(*constituent_index as u32)
                .target_base = target_base.cast::<i64>()?;
        }
        constituent_target_base
            .get_mut(*parent_index as u32)
            .target_base = parent_target_base
            .safe_mul(PERCENTAGE_PRECISION_U64.safe_sub(derivative_weights_sum)? as i64)?
            .safe_div(PERCENTAGE_PRECISION_I64)?;
    }

    Ok(())
}
