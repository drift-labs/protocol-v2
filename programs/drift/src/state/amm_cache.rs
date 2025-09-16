use std::convert::TryFrom;

use crate::error::{DriftResult, ErrorCode};
use crate::math::amm::calculate_net_user_pnl;
use crate::math::casting::Cast;
use crate::math::oracle::{oracle_validity, LogMode};
use crate::math::safe_math::SafeMath;
use crate::math::spot_balance::get_token_amount;
use crate::state::oracle::MMOraclePriceData;
use crate::state::oracle_map::OracleIdentifier;
use crate::state::perp_market::PerpMarket;
use crate::state::spot_market::{SpotBalance, SpotMarket};
use crate::state::state::State;
use crate::state::traits::Size;
use crate::state::zero_copy::HasLen;
use crate::state::zero_copy::{AccountZeroCopy, AccountZeroCopyMut};
use crate::validate;
use crate::OracleSource;
use crate::{impl_zero_copy_loader, OracleGuardRails};

use anchor_lang::prelude::*;

use super::user::MarketType;

pub const AMM_POSITIONS_CACHE: &str = "amm_cache";

#[account]
#[derive(Debug)]
#[repr(C)]
pub struct AmmCache {
    pub bump: u8,
    _padding: [u8; 3],
    pub cache: Vec<CacheInfo>,
}

#[zero_copy]
#[derive(AnchorSerialize, AnchorDeserialize, Debug)]
#[repr(C)]
pub struct CacheInfo {
    pub oracle: Pubkey,
    pub last_fee_pool_token_amount: u128,
    pub last_net_pnl_pool_token_amount: i128,
    pub last_exchange_fees: u128,
    pub last_settle_amm_ex_fees: u128,
    pub last_settle_amm_pnl: i128,
    /// BASE PRECISION
    pub position: i64,
    pub slot: u64,
    pub last_settle_amount: u64,
    pub last_settle_slot: u64,
    pub last_settle_ts: i64,
    pub quote_owed_from_lp_pool: i64,
    pub oracle_price: i64,
    pub oracle_slot: u64,
    pub oracle_source: u8,
    pub oracle_validity: u8,
    pub lp_status_for_perp_market: u8,
    pub _padding: [u8; 13],
}

impl Size for CacheInfo {
    const SIZE: usize = 192;
}

impl Default for CacheInfo {
    fn default() -> Self {
        CacheInfo {
            position: 0i64,
            slot: 0u64,
            oracle_price: 0i64,
            oracle_slot: 0u64,
            oracle_validity: 0u8,
            oracle: Pubkey::default(),
            last_fee_pool_token_amount: 0u128,
            last_net_pnl_pool_token_amount: 0i128,
            last_exchange_fees: 0u128,
            last_settle_amount: 0u64,
            last_settle_slot: 0u64,
            last_settle_ts: 0i64,
            last_settle_amm_pnl: 0i128,
            last_settle_amm_ex_fees: 0u128,
            oracle_source: 0u8,
            quote_owed_from_lp_pool: 0i64,
            lp_status_for_perp_market: 0u8,
            _padding: [0u8; 13],
        }
    }
}

impl CacheInfo {
    pub fn get_oracle_source(&self) -> DriftResult<OracleSource> {
        Ok(OracleSource::try_from(self.oracle_source)?)
    }

    pub fn oracle_id(&self) -> DriftResult<OracleIdentifier> {
        let oracle_source = self.get_oracle_source()?;
        Ok((self.oracle, oracle_source))
    }

    pub fn get_last_available_amm_token_amount(&self) -> DriftResult<i128> {
        let last_available_balance = self
            .last_fee_pool_token_amount
            .cast::<i128>()?
            .safe_add(self.last_net_pnl_pool_token_amount)?;
        Ok(last_available_balance)
    }

    pub fn update_perp_market_fields(&mut self, perp_market: &PerpMarket) -> DriftResult<()> {
        self.oracle = perp_market.amm.oracle;
        self.oracle_source = u8::from(perp_market.amm.oracle_source);
        self.position = perp_market
            .amm
            .get_protocol_owned_position()?
            .safe_mul(-1)?;
        self.lp_status_for_perp_market = perp_market.lp_status;
        Ok(())
    }

    pub fn update_oracle_info(
        &mut self,
        clock_slot: u64,
        oracle_price_data: &MMOraclePriceData,
        perp_market: &PerpMarket,
        oracle_guard_rails: &OracleGuardRails,
    ) -> DriftResult<()> {
        let safe_oracle_data = oracle_price_data.get_safe_oracle_price_data();
        self.oracle_price = safe_oracle_data.price;
        self.oracle_slot = clock_slot.safe_sub(safe_oracle_data.delay.max(0) as u64)?;
        self.slot = clock_slot;
        let validity = oracle_validity(
            MarketType::Perp,
            perp_market.market_index,
            perp_market
                .amm
                .historical_oracle_data
                .last_oracle_price_twap,
            &safe_oracle_data,
            &oracle_guard_rails.validity,
            perp_market.get_max_confidence_interval_multiplier()?,
            &perp_market.amm.oracle_source,
            LogMode::SafeMMOracle,
            perp_market.amm.oracle_slot_delay_override,
        )?;
        self.oracle_validity = u8::from(validity);
        Ok(())
    }
}

#[zero_copy]
#[derive(Default, Debug)]
#[repr(C)]
pub struct AmmCacheFixed {
    pub bump: u8,
    _pad: [u8; 3],
    pub len: u32,
}

impl HasLen for AmmCacheFixed {
    fn len(&self) -> u32 {
        self.len
    }
}

impl AmmCache {
    pub fn space(num_markets: usize) -> usize {
        8 + 8 + 4 + num_markets * CacheInfo::SIZE
    }

    pub fn validate(&self, state: &State) -> DriftResult<()> {
        validate!(
            self.cache.len() == state.number_of_markets as usize,
            ErrorCode::DefaultError,
            "Number of amm positions is different than number of markets"
        )?;
        Ok(())
    }

    pub fn update_perp_market_fields(&mut self, perp_market: &PerpMarket) -> DriftResult<()> {
        let cache_info = self.cache.get_mut(perp_market.market_index as usize);
        if let Some(cache_info) = cache_info {
            cache_info.update_perp_market_fields(perp_market)?;
        } else {
            msg!(
                "Updating amm cache from admin with perp market index not found in cache: {}",
                perp_market.market_index
            );
            return Err(ErrorCode::DefaultError.into());
        }

        Ok(())
    }

    pub fn update_oracle_info(
        &mut self,
        clock_slot: u64,
        market_index: u16,
        oracle_price_data: &MMOraclePriceData,
        perp_market: &PerpMarket,
        oracle_guard_rails: &OracleGuardRails,
    ) -> DriftResult<()> {
        let cache_info = self.cache.get_mut(market_index as usize);
        if let Some(cache_info) = cache_info {
            cache_info.update_oracle_info(
                clock_slot,
                oracle_price_data,
                perp_market,
                oracle_guard_rails,
            )?;
        } else {
            msg!(
                "Updating amm cache from admin with perp market index not found in cache: {}",
                market_index
            );
            return Err(ErrorCode::DefaultError.into());
        }

        Ok(())
    }
}

impl_zero_copy_loader!(AmmCache, crate::id, AmmCacheFixed, CacheInfo);

impl<'a> AccountZeroCopy<'a, CacheInfo, AmmCacheFixed> {
    pub fn check_settle_staleness(&self, slot: u64, threshold_slot_diff: u64) -> DriftResult<()> {
        for (i, cache_info) in self.iter().enumerate() {
            if cache_info.slot == 0 {
                continue;
            }
            if cache_info.last_settle_slot < slot.saturating_sub(threshold_slot_diff) {
                msg!("AMM settle data is stale for perp market {}", i);
                return Err(ErrorCode::AMMCacheStale.into());
            }
        }
        Ok(())
    }

    pub fn check_perp_market_staleness(&self, slot: u64, threshold: u64) -> DriftResult<()> {
        for (i, cache_info) in self.iter().enumerate() {
            if cache_info.slot == 0 {
                continue;
            }
            if cache_info.slot < slot.saturating_sub(threshold) {
                msg!("Perp market cache info is stale for perp market {}", i);
                return Err(ErrorCode::AMMCacheStale.into());
            }
        }
        Ok(())
    }

    pub fn check_oracle_staleness(&self, slot: u64, threshold: u64) -> DriftResult<()> {
        for (i, cache_info) in self.iter().enumerate() {
            if cache_info.slot == 0 {
                continue;
            }
            if cache_info.oracle_slot < slot.saturating_sub(threshold) {
                msg!(
                    "Perp market cache info is stale for perp market {}. oracle slot: {}, slot: {}",
                    i,
                    cache_info.oracle_slot,
                    slot
                );
                return Err(ErrorCode::AMMCacheStale.into());
            }
        }
        Ok(())
    }
}

impl<'a> AccountZeroCopyMut<'a, CacheInfo, AmmCacheFixed> {
    pub fn update_amount_owed_from_lp_pool(
        &mut self,
        perp_market: &PerpMarket,
        quote_market: &SpotMarket,
    ) -> DriftResult<()> {
        if perp_market.lp_fee_transfer_scalar == 0
            && perp_market.lp_exchange_fee_excluscion_scalar == 0
        {
            msg!(
                "lp_fee_transfer_scalar and lp_net_pnl_transfer_scalar are 0 for perp market {}. not updating quote amount owed in cache",
                perp_market.market_index
            );
            return Ok(());
        }

        let cached_info = self.get_mut(perp_market.market_index as u32);

        let fee_pool_token_amount = get_token_amount(
            perp_market.amm.fee_pool.scaled_balance,
            &quote_market,
            perp_market.amm.fee_pool.balance_type(),
        )?;

        let net_pnl_pool_token_amount = get_token_amount(
            perp_market.pnl_pool.scaled_balance,
            &quote_market,
            perp_market.pnl_pool.balance_type(),
        )?
        .cast::<i128>()?
        .safe_sub(calculate_net_user_pnl(
            &perp_market.amm,
            cached_info.oracle_price,
        )?)?;

        let amm_amount_available =
            net_pnl_pool_token_amount.safe_add(fee_pool_token_amount.cast::<i128>()?)?;

        if cached_info.last_net_pnl_pool_token_amount == 0
            && cached_info.last_fee_pool_token_amount == 0
            && cached_info.last_exchange_fees == 0
        {
            cached_info.last_fee_pool_token_amount = fee_pool_token_amount;
            cached_info.last_net_pnl_pool_token_amount = net_pnl_pool_token_amount;
            cached_info.last_exchange_fees = perp_market.amm.total_exchange_fee;
            cached_info.last_settle_amm_ex_fees = perp_market.amm.total_exchange_fee;
            cached_info.last_settle_amm_pnl = net_pnl_pool_token_amount;
            return Ok(());
        }

        let exchange_fee_delta = perp_market
            .amm
            .total_exchange_fee
            .saturating_sub(cached_info.last_exchange_fees);

        let amount_to_send_to_lp_pool = amm_amount_available
            .safe_sub(cached_info.get_last_available_amm_token_amount()?)?
            .safe_mul(perp_market.lp_fee_transfer_scalar as i128)?
            .safe_div_ceil(100)?
            .safe_sub(
                exchange_fee_delta
                    .cast::<i128>()?
                    .safe_mul(perp_market.lp_exchange_fee_excluscion_scalar as i128)?
                    .safe_div_ceil(100)?,
            )?;

        cached_info.quote_owed_from_lp_pool = cached_info
            .quote_owed_from_lp_pool
            .safe_sub(amount_to_send_to_lp_pool.cast::<i64>()?)?;

        cached_info.last_fee_pool_token_amount = fee_pool_token_amount;
        cached_info.last_net_pnl_pool_token_amount = net_pnl_pool_token_amount;
        cached_info.last_exchange_fees = perp_market.amm.total_exchange_fee;

        Ok(())
    }

    pub fn update_perp_market_fields(&mut self, perp_market: &PerpMarket) -> DriftResult<()> {
        let cache_info = self.get_mut(perp_market.market_index as u32);
        cache_info.update_perp_market_fields(perp_market)?;

        Ok(())
    }
}
