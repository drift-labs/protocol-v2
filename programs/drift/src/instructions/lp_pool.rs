use anchor_lang::{prelude::*, Accounts, Key, Result};

use crate::{
    error::ErrorCode,
    math::{
        casting::Cast,
        constants::{
            PRICE_PRECISION_I128, QUOTE_PRECISION, QUOTE_PRECISION_I128, SPOT_BALANCE_PRECISION,
            SPOT_WEIGHT_PRECISION_I128,
        },
        oracle::{is_oracle_valid_for_action, oracle_validity, DriftAction},
        safe_math::SafeMath,
    },
    msg,
    state::{
        constituent_map::{ConstituentMap, ConstituentSet},
        lp_pool::{
            AmmConstituentDatum, AmmConstituentMappingFixed, LPPool, WeightValidationFlags,
            CONSTITUENT_PDA_SEED,
        },
        oracle::OraclePriceData,
        perp_market::{AmmCacheFixed, CacheInfo, AMM_POSITIONS_CACHE},
        perp_market_map::MarketSet,
        state::State,
        user::MarketType,
        zero_copy::{AccountZeroCopy, ZeroCopyLoader},
    },
    validate,
};
use solana_program::sysvar::clock::Clock;

use super::optional_accounts::{load_maps, AccountMaps};
use crate::state::lp_pool::{AMM_MAP_PDA_SEED, CONSTITUENT_TARGET_WEIGHT_PDA_SEED};

pub fn handle_update_constituent_target_weights<'c: 'info, 'info>(
    ctx: Context<'_, '_, 'c, 'info, UpdateConstituentTargetWeights<'info>>,
    constituent_indexes: Vec<u16>,
) -> Result<()> {
    let lp_pool = &ctx.accounts.lp_pool.load()?;
    let state = &ctx.accounts.state;
    let mut constituent_target_weights = ctx.accounts.constituent_target_weights.load_zc_mut()?;

    let amm_cache: AccountZeroCopy<'_, CacheInfo, AmmCacheFixed> =
        ctx.accounts.amm_cache.load_zc()?;

    let num_constituents = constituent_target_weights.len();
    let exists_invalid_constituent_index = constituent_indexes
        .iter()
        .any(|index| *index as u32 >= num_constituents);

    validate!(
        !exists_invalid_constituent_index,
        ErrorCode::InvalidUpdateConstituentTargetWeightsArgument,
        "Constituent index larger than number of constituent target weights"
    )?;

    let slot = Clock::get()?.slot;

    let amm_constituent_mapping: AccountZeroCopy<
        '_,
        AmmConstituentDatum,
        AmmConstituentMappingFixed,
    > = ctx.accounts.amm_constituent_mapping.load_zc()?;

    let mut amm_inventories: Vec<(u16, i64)> = vec![];
    let mut oracle_prices: Vec<i64> = vec![];
    for (_, datum) in amm_constituent_mapping.iter().enumerate() {
        let cache_info = amm_cache.get(datum.perp_market_index as u32);

        let oracle_validity = oracle_validity(
            MarketType::Perp,
            datum.perp_market_index,
            cache_info.last_oracle_price_twap,
            &OraclePriceData {
                price: cache_info.oracle_price,
                confidence: cache_info.oracle_confidence,
                delay: cache_info.oracle_delay,
                has_sufficient_number_of_data_points: true,
            },
            &state.oracle_guard_rails.validity,
            cache_info.max_confidence_interval_multiplier,
            &cache_info.get_oracle_source()?,
            true,
        )?;

        if !is_oracle_valid_for_action(
            oracle_validity,
            Some(DriftAction::UpdateDlpConstituentTargetWeights),
        )? {
            msg!("Oracle data for perp market {} and constituent index {} is invalid. Skipping update",
                datum.perp_market_index, datum.constituent_index);
            continue;
        }

        amm_inventories.push((datum.perp_market_index, cache_info.position));
        oracle_prices.push(cache_info.oracle_price);
    }

    if amm_inventories.is_empty() {
        msg!("No valid inventories found for constituent target weights update");
        return Ok(());
    }

    constituent_target_weights.update_target_weights(
        &amm_constituent_mapping,
        amm_inventories.as_slice(),
        constituent_indexes.as_slice(),
        &oracle_prices.as_slice(),
        lp_pool.last_aum,
        slot,
        WeightValidationFlags::NONE,
    )?;

    Ok(())
}

pub fn handle_update_lp_pool_aum<'c: 'info, 'info>(
    ctx: Context<'_, '_, 'c, 'info, UpdateLPPoolAum<'info>>,
) -> Result<()> {
    let mut lp_pool = ctx.accounts.lp_pool.load_mut()?;
    let state = &ctx.accounts.state;

    let slot = Clock::get()?.slot;

    let remaining_accounts = &mut ctx.remaining_accounts.iter().peekable();

    let AccountMaps {
        perp_market_map: _,
        spot_market_map,
        mut oracle_map,
    } = load_maps(
        remaining_accounts,
        &MarketSet::new(),
        &MarketSet::new(),
        slot,
        Some(state.oracle_guard_rails),
    )?;

    let constituent_map = ConstituentMap::load(&ConstituentSet::new(), remaining_accounts)?;

    validate!(
        constituent_map.0.len() == lp_pool.constituents as usize,
        ErrorCode::WrongNumberOfConstituents,
        "Constituent map length does not match lp pool constituent count"
    )?;

    let mut aum: u128 = 0;
    let mut oldest_slot = u64::MAX;
    for i in 0..lp_pool.constituents as usize {
        let mut constituent = constituent_map.get_ref_mut(&(i as u16))?;

        // Validate PDA
        let expected_pda = Pubkey::find_program_address(
            &[
                CONSTITUENT_PDA_SEED.as_ref(),
                lp_pool.pubkey.as_ref(),
                constituent.spot_market_index.to_le_bytes().as_ref(),
            ],
            &crate::ID,
        );
        validate!(
            expected_pda.0 == constituent.pubkey,
            ErrorCode::InvalidConstituent,
            "Constituent PDA does not match expected PDA"
        )?;

        let spot_market = spot_market_map.get_ref(&constituent.spot_market_index)?;

        let oracle_data = oracle_map.get_price_data_and_validity(
            MarketType::Spot,
            constituent.spot_market_index,
            &spot_market.oracle_id(),
            spot_market.historical_oracle_data.last_oracle_price_twap,
            spot_market.get_max_confidence_interval_multiplier()?,
        )?;

        let oracle_slot = slot - oracle_data.0.delay.max(0i64).cast::<u64>()?;
        let oracle_price: Option<i64> = {
            if !is_oracle_valid_for_action(oracle_data.1, Some(DriftAction::UpdateLpPoolAum))? {
                msg!(
                    "Oracle data for spot market {} is invalid. Skipping update",
                    spot_market.market_index,
                );
                if slot.saturating_sub(constituent.last_oracle_slot)
                    >= constituent.oracle_staleness_threshold
                {
                    None
                } else {
                    Some(constituent.last_oracle_price)
                }
            } else {
                Some(oracle_data.0.price)
            }
        };

        if oracle_price.is_none() {
            msg!("hi");
            return Err(ErrorCode::OracleTooStaleForLPAUMUpdate.into());
        }

        constituent.last_oracle_price = oracle_price.unwrap();
        constituent.last_oracle_slot = oracle_slot;

        if oracle_slot < oldest_slot {
            oldest_slot = oracle_slot;
        }

        let (numerator_scale, denominator_scale) = if spot_market.decimals > 6 {
            (10_i128.pow(spot_market.decimals - 6), 1)
        } else {
            (1, 10_i128.pow(6 - spot_market.decimals))
        };

        let constituent_aum = constituent
            .get_full_balance(&spot_market)?
            .safe_mul(numerator_scale)?
            .safe_div(denominator_scale)?
            .safe_mul(oracle_price.unwrap() as i128)?
            .safe_div(PRICE_PRECISION_I128)?
            .max(0);
        aum = aum.safe_add(constituent_aum.cast()?)?;
    }

    lp_pool.oldest_oracle_slot = oldest_slot;
    lp_pool.last_aum = aum;
    lp_pool.last_aum_slot = slot;
    lp_pool.last_aum_ts = Clock::get()?.unix_timestamp;

    Ok(())
}

#[derive(Accounts)]
#[instruction(
    lp_pool_name: [u8; 32],
)]
pub struct UpdateLPPoolAum<'info> {
    pub state: Box<Account<'info, State>>,
    #[account(mut)]
    pub keeper: Signer<'info>,
    #[account(
        mut,
        seeds = [b"lp_pool", lp_pool_name.as_ref()],
        bump,
    )]
    pub lp_pool: AccountLoader<'info, LPPool>,
}

#[derive(Accounts)]
#[instruction(
    lp_pool_name: [u8; 32],
)]
pub struct UpdateConstituentTargetWeights<'info> {
    pub state: Box<Account<'info, State>>,
    #[account(mut)]
    pub keeper: Signer<'info>,
    #[account(
        seeds = [AMM_MAP_PDA_SEED.as_ref(), lp_pool.key().as_ref()],
        bump,
    )]
    /// CHECK: checked in AmmConstituentMappingZeroCopy checks
    pub amm_constituent_mapping: AccountInfo<'info>,
    #[account(
        mut,
        seeds = [CONSTITUENT_TARGET_WEIGHT_PDA_SEED.as_ref(), lp_pool.key().as_ref()],
        bump,
    )]
    /// CHECK: checked in ConstituentTargetWeightsZeroCopy checks
    pub constituent_target_weights: AccountInfo<'info>,
    #[account(
        mut,
        seeds = [AMM_POSITIONS_CACHE.as_ref()],
        bump,
    )]
    /// CHECK: checked in ConstituentTargetWeightsZeroCopy checks
    pub amm_cache: AccountInfo<'info>,
    #[account(
        seeds = [b"lp_pool", lp_pool_name.as_ref()],
        bump,
    )]
    pub lp_pool: AccountLoader<'info, LPPool>,
}
