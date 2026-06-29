//! AMM-specific admin instruction handlers.
//!
//! Houses governance instructions whose responsibility is the perp-market vAMM
//! curve and its fee/spread/state caches. Non-AMM perp-market admin
//! instructions (margin ratios, contract tier, status flags, etc.) remain in
//! `admin.rs`. The `AdminUpdatePerpMarket` / `HotAdminUpdatePerpMarket`
//! `#[derive(Accounts)]` structs are shared with non-AMM perp-market admin
//! instructions and continue to live in `admin.rs`.

use std::convert::TryInto;

use anchor_lang::prelude::*;
use anchor_lang::Discriminator;
use anchor_spl::token_interface::{TokenAccount, TokenInterface};

use crate::instructions::optional_accounts::get_token_mint;
use crate::instructions::*;
use crate::{
    auth::{check_hot, check_warm},
    controller,
    controller::spot_balance::execute_transfer_between_pools,
    error::ErrorCode,
    load, load_mut,
    math::{
        bn,
        casting::Cast,
        constants::{
            AMM_TIMES_PEG_TO_QUOTE_PRECISION_RATIO, MAX_SQRT_K, MAX_UPDATE_K_PRICE_CHANGE,
        },
        helpers::get_proportion_u128,
        safe_math::SafeMath,
    },
    msg,
    state::{
        events::{TransferFeeAndPnlPoolDirection, TransferFeeAndPnlPoolRecord},
        oracle::{get_oracle_price, OraclePriceData},
        perp_market::{PerpMarket, PoolBalance},
        spot_market::{SpotBalanceType, SpotMarket},
        state::{HotRole, State},
    },
    validate,
    validation::perp_market::validate_perp_market,
    vlp::amm::math::{amm, cp_curve::get_update_k_result},
    vlp::amm_cache::{AmmCache, CacheInfo, AMM_POSITIONS_CACHE},
};

pub fn handle_initialize_amm_cache(ctx: Context<InitializeAmmCache>) -> Result<()> {
    let amm_cache = &mut ctx.accounts.amm_cache;
    amm_cache.bump = ctx.bumps.amm_cache;

    Ok(())
}

pub fn handle_add_market_to_amm_cache(ctx: Context<AddMarketToAmmCache>) -> Result<()> {
    let amm_cache = &mut ctx.accounts.amm_cache;
    let perp_market = ctx.accounts.perp_market.load()?;

    for cache_info in amm_cache.cache.iter() {
        validate!(
            cache_info.market_index != perp_market.market_index,
            ErrorCode::DefaultError,
            "Market index {} already in amm cache",
            perp_market.market_index
        )?;
    }

    let current_size = amm_cache.cache.len();
    let new_size = current_size.saturating_add(1);

    msg!(
        "resizing amm cache from {} entries to {}",
        current_size,
        new_size
    );

    amm_cache.cache.resize_with(new_size, || CacheInfo {
        market_index: perp_market.market_index,
        ..CacheInfo::default()
    });

    Ok(())
}

pub fn handle_delete_amm_cache(_ctx: Context<DeleteAmmCache>) -> Result<()> {
    msg!("deleted amm cache");
    Ok(())
}

#[access_control(
    perp_market_valid(&ctx.accounts.perp_market)
)]
pub fn handle_move_amm_price(
    ctx: Context<AdminUpdatePerpMarket>,
    base_asset_reserve: u128,
    quote_asset_reserve: u128,
    sqrt_k: u128,
) -> Result<()> {
    let perp_market = &mut load_mut!(ctx.accounts.perp_market)?;

    msg!(
        "moving amm price for perp market {}",
        perp_market.market_index
    );

    let base_asset_reserve_before = perp_market.amm.base_asset_reserve;
    let quote_asset_reserve_before = perp_market.amm.quote_asset_reserve;
    let sqrt_k_before = perp_market.amm.sqrt_k;
    let max_base_asset_reserve_before = perp_market.amm.max_base_asset_reserve;
    let min_base_asset_reserve_before = perp_market.amm.min_base_asset_reserve;

    perp_market
        .amm
        .move_price(base_asset_reserve, quote_asset_reserve, sqrt_k)?;
    validate_perp_market(perp_market)?;

    let base_asset_reserve_after = perp_market.amm.base_asset_reserve;
    let quote_asset_reserve_after = perp_market.amm.quote_asset_reserve;
    let sqrt_k_after = perp_market.amm.sqrt_k;
    let max_base_asset_reserve_after = perp_market.amm.max_base_asset_reserve;
    let min_base_asset_reserve_after = perp_market.amm.min_base_asset_reserve;

    msg!(
        "base_asset_reserve {} -> {}",
        base_asset_reserve_before,
        base_asset_reserve_after
    );

    msg!(
        "quote_asset_reserve {} -> {}",
        quote_asset_reserve_before,
        quote_asset_reserve_after
    );

    msg!("sqrt_k {} -> {}", sqrt_k_before, sqrt_k_after);

    msg!(
        "max_base_asset_reserve {} -> {}",
        max_base_asset_reserve_before,
        max_base_asset_reserve_after
    );

    msg!(
        "min_base_asset_reserve {} -> {}",
        min_base_asset_reserve_before,
        min_base_asset_reserve_after
    );

    Ok(())
}

#[access_control(
    perp_market_valid(&ctx.accounts.perp_market)
)]
pub fn handle_recenter_perp_market_amm(
    ctx: Context<AdminUpdatePerpMarket>,
    peg_multiplier: u128,
    sqrt_k: u128,
) -> Result<()> {
    let perp_market = &mut load_mut!(ctx.accounts.perp_market)?;

    msg!(
        "recentering amm for perp market {}",
        perp_market.market_index
    );

    let base_asset_reserve_before = perp_market.amm.base_asset_reserve;
    let quote_asset_reserve_before = perp_market.amm.quote_asset_reserve;
    let sqrt_k_before = perp_market.amm.sqrt_k;
    let peg_multiplier_before = perp_market.amm.peg_multiplier;
    let max_base_asset_reserve_before = perp_market.amm.max_base_asset_reserve;
    let min_base_asset_reserve_before = perp_market.amm.min_base_asset_reserve;

    perp_market.amm.recenter(peg_multiplier, sqrt_k)?;
    validate_perp_market(perp_market)?;

    let base_asset_reserve_after = perp_market.amm.base_asset_reserve;
    let quote_asset_reserve_after = perp_market.amm.quote_asset_reserve;
    let sqrt_k_after = perp_market.amm.sqrt_k;
    let peg_multiplier_after = perp_market.amm.peg_multiplier;
    let max_base_asset_reserve_after = perp_market.amm.max_base_asset_reserve;
    let min_base_asset_reserve_after = perp_market.amm.min_base_asset_reserve;

    msg!(
        "base_asset_reserve {} -> {}",
        base_asset_reserve_before,
        base_asset_reserve_after
    );

    msg!(
        "quote_asset_reserve {} -> {}",
        quote_asset_reserve_before,
        quote_asset_reserve_after
    );

    msg!("sqrt_k {} -> {}", sqrt_k_before, sqrt_k_after);

    msg!(
        "peg_multiplier {} -> {}",
        peg_multiplier_before,
        peg_multiplier_after
    );

    msg!(
        "max_base_asset_reserve {} -> {}",
        max_base_asset_reserve_before,
        max_base_asset_reserve_after
    );

    msg!(
        "min_base_asset_reserve {} -> {}",
        min_base_asset_reserve_before,
        min_base_asset_reserve_after
    );

    Ok(())
}

#[access_control(
    perp_market_valid(&ctx.accounts.perp_market)
)]
pub fn handle_recenter_perp_market_amm_crank(
    ctx: Context<AdminUpdatePerpMarketAmmSummaryStats>,
    depth: Option<u128>,
) -> Result<()> {
    let perp_market = &mut load_mut!(ctx.accounts.perp_market)?;

    let clock = Clock::get()?;
    let price_oracle = &ctx.accounts.oracle;

    let OraclePriceData {
        price: oracle_price,
        ..
    } = get_oracle_price(&perp_market.oracle_source, price_oracle, clock.slot)?;

    msg!(
        "recentering amm crank for perp market {}",
        perp_market.market_index
    );

    let base_asset_reserve_before = perp_market.amm.base_asset_reserve;
    let quote_asset_reserve_before = perp_market.amm.quote_asset_reserve;
    let sqrt_k_before = perp_market.amm.sqrt_k;
    let peg_multiplier_before = perp_market.amm.peg_multiplier;
    let max_base_asset_reserve_before = perp_market.amm.max_base_asset_reserve;
    let min_base_asset_reserve_before = perp_market.amm.min_base_asset_reserve;

    let mut sqrt_k = sqrt_k_before;
    let peg_multiplier: u128 = oracle_price.cast()?;
    let (max_bids_before, max_asks_before) =
        amm::calculate_market_open_bids_asks(&perp_market.amm)?;

    if let Some(depth) = depth {
        let base_depth = max_bids_before
            .safe_add(max_asks_before.abs())?
            .safe_div(2)?
            .unsigned_abs();
        let quote_depth = base_depth
            .safe_mul(peg_multiplier)?
            .safe_div(AMM_TIMES_PEG_TO_QUOTE_PRECISION_RATIO)?;
        sqrt_k = get_proportion_u128(sqrt_k, depth, quote_depth)?;
    }

    perp_market.amm.recenter(peg_multiplier, sqrt_k)?;
    validate_perp_market(perp_market)?;

    let base_asset_reserve_after = perp_market.amm.base_asset_reserve;
    let quote_asset_reserve_after = perp_market.amm.quote_asset_reserve;
    let sqrt_k_after = perp_market.amm.sqrt_k;
    let peg_multiplier_after = perp_market.amm.peg_multiplier;
    let max_base_asset_reserve_after = perp_market.amm.max_base_asset_reserve;
    let min_base_asset_reserve_after = perp_market.amm.min_base_asset_reserve;

    msg!(
        "base_asset_reserve {} -> {}",
        base_asset_reserve_before,
        base_asset_reserve_after
    );

    msg!(
        "quote_asset_reserve {} -> {}",
        quote_asset_reserve_before,
        quote_asset_reserve_after
    );

    msg!("sqrt_k {} -> {}", sqrt_k_before, sqrt_k_after);

    msg!(
        "peg_multiplier {} -> {}",
        peg_multiplier_before,
        peg_multiplier_after
    );

    msg!(
        "max_base_asset_reserve {} -> {}",
        max_base_asset_reserve_before,
        max_base_asset_reserve_after
    );

    msg!(
        "min_base_asset_reserve {} -> {}",
        min_base_asset_reserve_before,
        min_base_asset_reserve_after
    );

    let (max_bids_after, max_asks_after) = amm::calculate_market_open_bids_asks(&perp_market.amm)?;

    msg!("max_bids {} -> {}", max_bids_before, max_bids_after);

    msg!("max_asks {} -> {}", max_asks_before, max_asks_after);
    Ok(())
}

#[derive(Debug, Clone, Copy, AnchorSerialize, AnchorDeserialize, PartialEq, Eq)]
pub struct UpdatePerpMarketSummaryStatsParams {
    pub net_unsettled_funding_pnl: Option<i64>,
    pub update_amm_summary_stats: Option<bool>,
}

#[access_control(
    perp_market_valid(&ctx.accounts.perp_market)
    valid_oracle_for_perp_market(&ctx.accounts.oracle, &ctx.accounts.perp_market)
)]
pub fn handle_update_perp_market_amm_summary_stats(
    ctx: Context<AdminUpdatePerpMarketAmmSummaryStats>,
    params: UpdatePerpMarketSummaryStatsParams,
) -> Result<()> {
    let perp_market = &mut load_mut!(ctx.accounts.perp_market)?;
    let spot_market = &mut load!(ctx.accounts.spot_market)?;

    msg!(
        "updating amm summary stats for perp market {}",
        perp_market.market_index
    );

    msg!(
        "updating amm summary stats for spot market {}",
        spot_market.market_index
    );

    let clock = Clock::get()?;
    let price_oracle = &ctx.accounts.oracle;

    let OraclePriceData {
        price: oracle_price,
        ..
    } = get_oracle_price(&perp_market.oracle_source, price_oracle, clock.slot)?;

    if let Some(net_unsettled_funding_pnl) = params.net_unsettled_funding_pnl {
        msg!(
            "net_unsettled_funding_pnl {} -> {}",
            perp_market.net_unsettled_funding_pnl,
            net_unsettled_funding_pnl
        );
        perp_market.net_unsettled_funding_pnl = net_unsettled_funding_pnl;
    }

    if params.update_amm_summary_stats == Some(true) {
        let new_total_fee_minus_distributions =
            crate::vlp::amm::controller::calculate_perp_market_amm_summary_stats(
                perp_market,
                spot_market,
                oracle_price,
            )?;

        msg!(
            "updating amm summary stats for market index = {}",
            perp_market.market_index,
        );

        msg!(
            "total_fee_minus_distributions: {:?} -> {:?}",
            perp_market.amm.total_fee_minus_distributions,
            new_total_fee_minus_distributions,
        );

        let fee_difference = new_total_fee_minus_distributions
            .safe_sub(perp_market.amm.total_fee_minus_distributions)?;

        msg!(
            "perp_market.amm.total_fee: {} -> {}",
            perp_market.amm.total_fee,
            perp_market.amm.total_fee.saturating_add(fee_difference)
        );

        msg!(
            "perp_market.amm.total_mm_fee: {} -> {}",
            perp_market.amm.total_mm_fee,
            perp_market.amm.total_mm_fee.saturating_add(fee_difference)
        );

        perp_market
            .amm
            .apply_summary_stats_correction(fee_difference, new_total_fee_minus_distributions);
    }
    validate_perp_market(perp_market)?;

    Ok(())
}

#[access_control(
    perp_market_valid(&ctx.accounts.perp_market)
)]
pub fn handle_deposit_into_perp_market_fee_pool<'c: 'info, 'info>(
    ctx: Context<'info, DepositIntoMarketFeePool<'info>>,
    amount: u64,
) -> Result<()> {
    let perp_market = &mut load_mut!(ctx.accounts.perp_market)?;

    let remaining_accounts_iter = &mut ctx.remaining_accounts.iter().peekable();

    let mint = get_token_mint(remaining_accounts_iter)?;

    msg!(
        "depositing {} into perp market {} fee pool",
        amount,
        perp_market.market_index
    );

    msg!(
        "perp_market.amm.total_fee_minus_distributions: {:?} -> {:?}",
        perp_market.amm.total_fee_minus_distributions,
        perp_market
            .amm
            .total_fee_minus_distributions
            .safe_add(amount.cast()?)?,
    );

    <crate::vlp::amm::AMM as crate::vlp::amm::quoter::AmmContract>::record_credit(
        &mut perp_market.amm,
        amount,
    )?;

    let quote_spot_market = &mut load_mut!(ctx.accounts.quote_spot_market)?;

    controller::spot_balance::update_spot_market_cumulative_interest(
        &mut *quote_spot_market,
        None,
        Clock::get()?.unix_timestamp,
    )?;

    controller::spot_balance::update_spot_balances(
        amount.cast::<u128>()?,
        &SpotBalanceType::Deposit,
        quote_spot_market,
        &mut perp_market.amm.fee_pool,
        false,
    )?;

    controller::token::receive(
        &ctx.accounts.token_program,
        &ctx.accounts.source_vault,
        &ctx.accounts.spot_market_vault,
        &ctx.accounts.admin.to_account_info(),
        amount,
        &mint,
        if quote_spot_market.has_transfer_hook() {
            Some(remaining_accounts_iter)
        } else {
            None
        },
    )?;

    Ok(())
}

#[access_control(
    perp_market_valid(&ctx.accounts.perp_market)
    valid_oracle_for_perp_market(&ctx.accounts.oracle, &ctx.accounts.perp_market)
)]
pub fn handle_repeg_amm_curve(ctx: Context<RepegCurve>, new_peg_candidate: u128) -> Result<()> {
    let clock = Clock::get()?;
    let now = clock.unix_timestamp;
    let clock_slot = clock.slot;

    let perp_market = &mut load_mut!(ctx.accounts.perp_market)?;
    msg!(
        "repegging amm curve for perp market {}",
        perp_market.market_index
    );

    let price_oracle = &ctx.accounts.oracle;
    let OraclePriceData {
        price: oracle_price,
        ..
    } = get_oracle_price(&perp_market.oracle_source, price_oracle, clock.slot)?;

    let peg_multiplier_before = perp_market.amm.peg_multiplier;
    let base_asset_reserve_before = perp_market.amm.base_asset_reserve;
    let quote_asset_reserve_before = perp_market.amm.quote_asset_reserve;
    let sqrt_k_before = perp_market.amm.sqrt_k;

    let oracle_validity_rails = ctx.accounts.state.load()?.oracle_guard_rails;

    let adjustment_cost = crate::vlp::amm::refresh::repeg(
        perp_market,
        price_oracle,
        new_peg_candidate,
        clock_slot,
        &oracle_validity_rails,
    )?;

    let peg_multiplier_after = perp_market.amm.peg_multiplier;
    let base_asset_reserve_after = perp_market.amm.base_asset_reserve;
    let quote_asset_reserve_after = perp_market.amm.quote_asset_reserve;
    let sqrt_k_after = perp_market.amm.sqrt_k;

    msg!(
        "perp_market.amm.peg_multiplier {} -> {}",
        peg_multiplier_before,
        peg_multiplier_after
    );

    msg!(
        "perp_market.amm.base_asset_reserve {} -> {}",
        base_asset_reserve_before,
        base_asset_reserve_after
    );

    msg!(
        "perp_market.amm.quote_asset_reserve {} -> {}",
        quote_asset_reserve_before,
        quote_asset_reserve_after
    );

    msg!(
        "perp_market.amm.sqrt_k {} -> {}",
        sqrt_k_before,
        sqrt_k_after
    );

    emit!(crate::state::events::AmmCurveChanged {
        ts: now,
        market_index: perp_market.market_index,
        peg_multiplier_before,
        base_asset_reserve_before,
        quote_asset_reserve_before,
        sqrt_k_before,
        peg_multiplier_after,
        base_asset_reserve_after,
        quote_asset_reserve_after,
        sqrt_k_after,
        adjustment_cost,
        total_fee_minus_distributions_after: perp_market.amm.total_fee_minus_distributions,
        oracle_price,
    });

    Ok(())
}

#[access_control(
    perp_market_valid(&ctx.accounts.perp_market)
    valid_oracle_for_perp_market(&ctx.accounts.oracle, &ctx.accounts.perp_market)
)]
pub fn handle_update_amm_oracle_twap(ctx: Context<RepegCurve>) -> Result<()> {
    // allow update to amm's oracle twap iff price gap is reduced and thus more tame funding
    // otherwise if oracle error or funding flip: set oracle twap to mark twap (0 gap)

    let clock = Clock::get()?;
    let now = clock.unix_timestamp;

    let perp_market = &mut load_mut!(ctx.accounts.perp_market)?;
    msg!(
        "updating amm oracle twap for perp market {}",
        perp_market.market_index
    );
    let price_oracle = &ctx.accounts.oracle;
    let oracle_twap =
        perp_market
            .amm
            .get_oracle_twap(price_oracle, clock.slot, perp_market.oracle_source)?;

    if let Some(oracle_twap) = oracle_twap {
        let oracle_mark_gap_before = perp_market
            .market_stats
            .last_mark_price_twap
            .cast::<i64>()?
            .safe_sub(
                perp_market
                    .market_stats
                    .historical_oracle_data
                    .last_oracle_price_twap,
            )?;

        let oracle_mark_gap_after = perp_market
            .market_stats
            .last_mark_price_twap
            .cast::<i64>()?
            .safe_sub(oracle_twap)?;

        if (oracle_mark_gap_after > 0 && oracle_mark_gap_before < 0)
            || (oracle_mark_gap_after < 0 && oracle_mark_gap_before > 0)
        {
            msg!(
                "perp_market.market_stats.historical_oracle_data.last_oracle_price_twap {} -> {}",
                perp_market
                    .market_stats
                    .historical_oracle_data
                    .last_oracle_price_twap,
                perp_market
                    .market_stats
                    .last_mark_price_twap
                    .cast::<i64>()?
            );
            msg!(
                "perp_market.market_stats.historical_oracle_data.last_oracle_price_twap_ts {} -> {}",
                perp_market
                    .market_stats
                    .historical_oracle_data
                    .last_oracle_price_twap_ts,
                now
            );
            perp_market
                .market_stats
                .historical_oracle_data
                .last_oracle_price_twap = perp_market
                .market_stats
                .last_mark_price_twap
                .cast::<i64>()?;
            perp_market
                .market_stats
                .historical_oracle_data
                .last_oracle_price_twap_ts = now;
        } else if oracle_mark_gap_after.unsigned_abs() <= oracle_mark_gap_before.unsigned_abs() {
            msg!(
                "perp_market.market_stats.historical_oracle_data.last_oracle_price_twap {} -> {}",
                perp_market
                    .market_stats
                    .historical_oracle_data
                    .last_oracle_price_twap,
                oracle_twap
            );
            msg!(
                "perp_market.market_stats.historical_oracle_data.last_oracle_price_twap_ts {} -> {}",
                perp_market
                    .market_stats
                    .historical_oracle_data
                    .last_oracle_price_twap_ts,
                now
            );
            perp_market
                .market_stats
                .historical_oracle_data
                .last_oracle_price_twap = oracle_twap;
            perp_market
                .market_stats
                .historical_oracle_data
                .last_oracle_price_twap_ts = now;
        } else {
            return Err(ErrorCode::PriceBandsBreached.into());
        }
    } else {
        return Err(ErrorCode::InvalidOracle.into());
    }

    Ok(())
}

#[access_control(
    perp_market_valid(&ctx.accounts.perp_market)
    valid_oracle_for_perp_market(&ctx.accounts.oracle, &ctx.accounts.perp_market)
)]
pub fn handle_update_k(ctx: Context<AdminUpdateK>, sqrt_k: u128) -> Result<()> {
    let clock = Clock::get()?;
    let now = clock.unix_timestamp;

    let perp_market = &mut load_mut!(ctx.accounts.perp_market)?;

    msg!("updating k for perp market {}", perp_market.market_index);

    let price_before = crate::vlp::amm::math::amm::calculate_price(
        perp_market.amm.quote_asset_reserve,
        perp_market.amm.base_asset_reserve,
        perp_market.amm.peg_multiplier,
    )?;

    let peg_multiplier_before = perp_market.amm.peg_multiplier;
    let base_asset_reserve_before = perp_market.amm.base_asset_reserve;
    let quote_asset_reserve_before = perp_market.amm.quote_asset_reserve;
    let sqrt_k_before = perp_market.amm.sqrt_k;

    let k_increasing = sqrt_k > perp_market.amm.sqrt_k;

    let new_sqrt_k_u192 = bn::U192::from(sqrt_k);

    let update_k_result =
        get_update_k_result(&perp_market.amm, perp_market.status, new_sqrt_k_u192, true)?;

    let adjustment_cost: i128 =
        crate::vlp::amm::math::cp_curve::adjust_k_cost(&perp_market.amm, &update_k_result)?;

    perp_market.amm.apply_k_update(&update_k_result)?;

    if k_increasing {
        validate!(
            adjustment_cost >= 0,
            ErrorCode::InvalidUpdateK,
            "adjustment_cost negative when k increased",
        )?;
    } else {
        validate!(
            adjustment_cost <= 0,
            ErrorCode::InvalidUpdateK,
            "adjustment_cost positive when k decreased",
        )?;
    }

    if adjustment_cost > 0 {
        // tfmd contains only the AMM's own equity post-isolation: the whole
        // surplus is spendable on a k change
        let max_cost = perp_market.amm.total_fee_minus_distributions;

        validate!(
            adjustment_cost <= max_cost,
            ErrorCode::InvalidUpdateK,
            "adjustment_cost={} > max_cost={} for k change",
            adjustment_cost,
            max_cost
        )?;
    }

    validate!(
        !k_increasing || perp_market.amm.sqrt_k < MAX_SQRT_K,
        ErrorCode::InvalidUpdateK,
        "cannot increase sqrt_k={} past MAX_SQRT_K",
        perp_market.amm.sqrt_k
    )?;

    // No floor check on admin update_k — admin authority overrides the
    // protocol fee reserve. Pass `false` for check_lower_bound.
    perp_market.amm.apply_cost(adjustment_cost, false)?;

    let amm = &perp_market.amm;

    let price_after = crate::vlp::amm::math::amm::calculate_price(
        amm.quote_asset_reserve,
        amm.base_asset_reserve,
        amm.peg_multiplier,
    )?;

    let price_change_too_large = price_before
        .cast::<i128>()?
        .safe_sub(price_after.cast::<i128>()?)?
        .unsigned_abs()
        .gt(&MAX_UPDATE_K_PRICE_CHANGE);

    if price_change_too_large {
        msg!(
            "{:?} -> {:?} (> {:?})",
            price_before,
            price_after,
            MAX_UPDATE_K_PRICE_CHANGE
        );
        return Err(ErrorCode::InvalidUpdateK.into());
    }

    let k_sqrt_check = bn::U192::from(amm.base_asset_reserve)
        .safe_mul(bn::U192::from(amm.quote_asset_reserve))?
        .integer_sqrt()
        .try_to_u128()?;

    let k_err = k_sqrt_check
        .cast::<i128>()?
        .safe_sub(amm.sqrt_k.cast::<i128>()?)?;

    if k_err.unsigned_abs() > 100 {
        msg!("k_err={:?}, {:?} != {:?}", k_err, k_sqrt_check, amm.sqrt_k);
        return Err(ErrorCode::InvalidUpdateK.into());
    }

    let peg_multiplier_after = amm.peg_multiplier;
    let base_asset_reserve_after = amm.base_asset_reserve;
    let quote_asset_reserve_after = amm.quote_asset_reserve;
    let sqrt_k_after = amm.sqrt_k;

    msg!(
        "perp_market.amm.peg_multiplier {} -> {}",
        peg_multiplier_before,
        peg_multiplier_after
    );

    msg!(
        "perp_market.amm.base_asset_reserve {} -> {}",
        base_asset_reserve_before,
        base_asset_reserve_after
    );

    msg!(
        "perp_market.amm.quote_asset_reserve {} -> {}",
        quote_asset_reserve_before,
        quote_asset_reserve_after
    );

    msg!(
        "perp_market.amm.sqrt_k {} -> {}",
        sqrt_k_before,
        sqrt_k_after
    );

    let total_fee_minus_distributions = amm.total_fee_minus_distributions;

    let OraclePriceData {
        price: oracle_price,
        ..
    } = get_oracle_price(&perp_market.oracle_source, &ctx.accounts.oracle, clock.slot)?;

    emit!(crate::state::events::AmmCurveChanged {
        ts: now,
        market_index: perp_market.market_index,
        peg_multiplier_before,
        base_asset_reserve_before,
        quote_asset_reserve_before,
        sqrt_k_before,
        peg_multiplier_after,
        base_asset_reserve_after,
        quote_asset_reserve_after,
        sqrt_k_after,
        adjustment_cost,
        total_fee_minus_distributions_after: total_fee_minus_distributions,
        oracle_price,
    });

    Ok(())
}

#[access_control(
    perp_market_valid(&ctx.accounts.perp_market)
    valid_oracle_for_perp_market(&ctx.accounts.oracle, &ctx.accounts.perp_market)
)]
pub fn handle_reset_amm_oracle_twap(ctx: Context<RepegCurve>) -> Result<()> {
    // admin failsafe to reset amm oracle_twap to the mark_twap

    let perp_market = &mut load_mut!(ctx.accounts.perp_market)?;

    msg!(
        "resetting amm oracle twap for perp market {}",
        perp_market.market_index
    );
    msg!(
        "perp_market.market_stats.historical_oracle_data.last_oracle_price_twap: {:?} -> {:?}",
        perp_market
            .market_stats
            .historical_oracle_data
            .last_oracle_price_twap,
        perp_market
            .market_stats
            .last_mark_price_twap
            .cast::<i64>()?
    );

    msg!(
        "perp_market.market_stats.historical_oracle_data.last_oracle_price_twap_ts: {:?} -> {:?}",
        perp_market
            .market_stats
            .historical_oracle_data
            .last_oracle_price_twap_ts,
        perp_market.market_stats.last_mark_price_twap_ts
    );

    perp_market
        .market_stats
        .historical_oracle_data
        .last_oracle_price_twap = perp_market
        .market_stats
        .last_mark_price_twap
        .cast::<i64>()?;
    perp_market
        .market_stats
        .historical_oracle_data
        .last_oracle_price_twap_ts = perp_market.market_stats.last_mark_price_twap_ts;

    Ok(())
}

#[access_control(
    perp_market_valid(&ctx.accounts.perp_market)
)]
pub fn handle_update_perp_market_curve_update_intensity(
    ctx: Context<HotAdminUpdatePerpMarket>,
    curve_update_intensity: u8,
) -> Result<()> {
    // (0, 100] is for repeg / formulaic k intensity
    // (100, 200] is for reference price offset intensity
    validate!(
        curve_update_intensity <= 200,
        ErrorCode::DefaultError,
        "invalid curve_update_intensity",
    )?;
    let perp_market = &mut load_mut!(ctx.accounts.perp_market)?;
    msg!("perp market {}", perp_market.market_index);

    msg!(
        "perp_market.amm.curve_update_intensity: {} -> {}",
        perp_market.amm.curve_update_intensity,
        curve_update_intensity
    );

    perp_market.amm.curve_update_intensity = curve_update_intensity;
    Ok(())
}

#[access_control(
    perp_market_valid(&ctx.accounts.perp_market)
)]
pub fn handle_update_perp_market_reference_price_offset_deadband_pct(
    ctx: Context<HotAdminUpdatePerpMarket>,
    reference_price_offset_deadband_pct: u8,
) -> Result<()> {
    validate!(
        reference_price_offset_deadband_pct <= 100,
        ErrorCode::DefaultError,
        "invalid reference_price_offset_deadband_pct",
    )?;
    let perp_market = &mut load_mut!(ctx.accounts.perp_market)?;
    msg!("perp market {}", perp_market.market_index);

    msg!(
        "perp_market.amm.reference_price_offset_deadband_pct: {} -> {}",
        perp_market.amm.reference_price_offset_deadband_pct,
        reference_price_offset_deadband_pct
    );

    let liquidity_ratio =
        crate::vlp::amm::math::spread::calculate_inventory_liquidity_ratio_for_reference_price_offset(
            perp_market.amm.base_asset_amount_with_amm,
            perp_market.amm.base_asset_reserve,
            perp_market.amm.min_base_asset_reserve,
            perp_market.amm.max_base_asset_reserve,
        )?;

    let signed_liquidity_ratio = liquidity_ratio.safe_mul(
        perp_market
            .amm
            .get_protocol_owned_position()?
            .signum()
            .cast()?,
    )?;

    msg!("current signed liquidity ratio: {}", signed_liquidity_ratio);

    perp_market.amm.reference_price_offset_deadband_pct = reference_price_offset_deadband_pct;
    Ok(())
}

#[access_control(
    perp_market_valid(&ctx.accounts.perp_market)
)]
pub fn handle_update_perp_market_base_spread(
    ctx: Context<AdminUpdatePerpMarket>,
    base_spread: u32,
) -> Result<()> {
    let perp_market = &mut load_mut!(ctx.accounts.perp_market)?;
    msg!("perp market {}", perp_market.market_index);

    msg!(
        "perp_market.amm.base_spread: {:?} -> {:?}",
        perp_market.amm.base_spread,
        base_spread
    );

    perp_market.amm.base_spread = base_spread;
    // `long_spread` / `short_spread` are cached on the AMM and refreshed from
    // this new `base_spread` by `crate::vlp::amm::math::spread::update_amm_quote_state`
    // on the next crank / fill setup.
    Ok(())
}

#[access_control(
    perp_market_valid(&ctx.accounts.perp_market)
)]
pub fn handle_update_amm_jit_intensity(
    ctx: Context<HotAdminUpdatePerpMarket>,
    amm_jit_intensity: u8,
) -> Result<()> {
    validate!(
        (0..=100).contains(&amm_jit_intensity),
        ErrorCode::DefaultError,
        "invalid amm_jit_intensity",
    )?;

    let perp_market = &mut load_mut!(ctx.accounts.perp_market)?;
    msg!("perp market {}", perp_market.market_index);

    msg!(
        "perp_market.amm.amm_jit_intensity: {} -> {}",
        perp_market.amm.amm_jit_intensity,
        amm_jit_intensity
    );

    perp_market.amm.amm_jit_intensity = amm_jit_intensity;

    Ok(())
}

#[access_control(
    perp_market_valid(&ctx.accounts.perp_market)
)]
pub fn handle_update_perp_market_max_spread(
    ctx: Context<HotAdminUpdatePerpMarket>,
    max_spread: u32,
) -> Result<()> {
    let perp_market = &mut load_mut!(ctx.accounts.perp_market)?;
    msg!("perp market {}", perp_market.market_index);

    validate!(
        max_spread >= perp_market.amm.base_spread,
        ErrorCode::DefaultError,
        "invalid max_spread < base_spread",
    )?;

    validate!(
        max_spread <= perp_market.margin_ratio_initial * 100,
        ErrorCode::DefaultError,
        "invalid max_spread > market.margin_ratio_initial * 100",
    )?;

    msg!(
        "perp_market.amm.max_spread: {:?} -> {:?}",
        perp_market.amm.max_spread,
        max_spread
    );

    perp_market.amm.max_spread = max_spread;

    Ok(())
}

#[access_control(
    perp_market_valid(&ctx.accounts.perp_market)
)]
pub fn handle_update_perp_market_max_slippage_ratio(
    ctx: Context<AdminUpdatePerpMarket>,
    max_slippage_ratio: u16,
) -> Result<()> {
    validate!(max_slippage_ratio > 0, ErrorCode::DefaultError)?;
    let perp_market = &mut load_mut!(ctx.accounts.perp_market)?;
    msg!("perp market {}", perp_market.market_index);

    msg!(
        "perp_market.amm.max_slippage_ratio: {:?} -> {:?}",
        perp_market.amm.max_slippage_ratio,
        max_slippage_ratio
    );

    perp_market.amm.max_slippage_ratio = max_slippage_ratio;
    Ok(())
}

#[access_control(
    perp_market_valid(&ctx.accounts.perp_market)
)]
pub fn handle_update_perp_market_max_fill_reserve_fraction(
    ctx: Context<AdminUpdatePerpMarket>,
    max_fill_reserve_fraction: u16,
) -> Result<()> {
    validate!(max_fill_reserve_fraction > 0, ErrorCode::DefaultError)?;
    let perp_market = &mut load_mut!(ctx.accounts.perp_market)?;
    msg!("perp market {}", perp_market.market_index);

    msg!(
        "perp_market.amm.max_fill_reserve_fraction: {:?} -> {:?}",
        perp_market.amm.max_fill_reserve_fraction,
        max_fill_reserve_fraction
    );

    perp_market.amm.max_fill_reserve_fraction = max_fill_reserve_fraction;
    Ok(())
}

#[access_control(
    perp_market_valid(&ctx.accounts.perp_market)
)]
pub fn handle_update_perp_market_amm_spread_adjustment(
    ctx: Context<HotAdminUpdatePerpMarket>,
    amm_spread_adjustment: i8,
    amm_inventory_spread_adjustment: i8,
    reference_price_offset: i32,
) -> Result<()> {
    let perp_market = &mut load_mut!(ctx.accounts.perp_market)?;
    msg!("perp market {}", perp_market.market_index);

    msg!(
        "perp_market.amm.amm_spread_adjustment: {:?} -> {:?}",
        perp_market.amm.amm_spread_adjustment,
        amm_spread_adjustment
    );

    perp_market.amm.amm_spread_adjustment = amm_spread_adjustment;

    msg!(
        "perp_market.amm.amm_inventory_spread_adjustment: {:?} -> {:?}",
        perp_market.amm.amm_inventory_spread_adjustment,
        amm_inventory_spread_adjustment
    );

    perp_market.amm.amm_inventory_spread_adjustment = amm_inventory_spread_adjustment;

    // The `reference_price_offset` parameter is ignored: the cached
    // `amm.reference_price_offset` is a per-crank output, recomputed by
    // `crate::vlp::amm::math::spread::update_amm_quote_state` from inventory +
    // MarketStats rather than set by admin. The parameter is retained for
    // IDL/wire-protocol stability; operators should remove it once the SDK
    // is updated.
    let _ = reference_price_offset;

    Ok(())
}

#[access_control(
    perp_market_valid(&ctx.accounts.perp_market)
)]
pub fn handle_update_perp_market_funding_bias_sensitivity(
    ctx: Context<HotAdminUpdatePerpMarket>,
    funding_bias_sensitivity: u8,
) -> Result<()> {
    let perp_market = &mut load_mut!(ctx.accounts.perp_market)?;
    msg!("perp market {}", perp_market.market_index);

    msg!(
        "perp_market.amm.funding_bias_sensitivity: {:?} -> {:?}",
        perp_market.amm.funding_bias_sensitivity,
        funding_bias_sensitivity
    );

    perp_market.amm.funding_bias_sensitivity = funding_bias_sensitivity;
    Ok(())
}

pub fn handle_update_amm_spread_adjustment_native(
    accounts: &[AccountInfo],
    data: &[u8],
) -> Result<()> {
    // Pre-Anchor native dispatch: re-establish the ownership + discriminator
    // guarantees Anchor would provide (see `crate::auth::require_native_account`)
    // before trusting any byte. Accounts: [0] perp_market (mut), [1] signer,
    // [2] state. hot_amm_spread_adjust lives at State bytes 392..424 (guarded by
    // `state/traits/tests.rs::native_instruction_offsets`).
    crate::auth::require_native_account(
        &accounts[2],
        State::DISCRIMINATOR,
        ErrorCode::InvalidNativeStateAccount,
    )?;
    crate::auth::require_native_account(
        &accounts[0],
        PerpMarket::DISCRIMINATOR,
        ErrorCode::InvalidNativePerpMarketAccount,
    )?;

    #[cfg(not(feature = "anchor-test"))]
    {
        let state = accounts[2].data.borrow();
        let signer_account = &accounts[1];
        let hot_key = Pubkey::new_from_array(state[392..424].try_into().unwrap());
        require!(
            signer_account.is_signer && *signer_account.key == hot_key,
            ErrorCode::Unauthorized
        );
    }

    let mut perp_market_data = accounts[0].data.borrow_mut();
    let perp_market: &mut PerpMarket =
        bytemuck::from_bytes_mut(&mut perp_market_data[8..8 + std::mem::size_of::<PerpMarket>()]);
    perp_market.amm.amm_spread_adjustment = data[0] as i8;

    Ok(())
}

#[access_control(
    perp_market_valid(&ctx.accounts.perp_market_with_fee_pool)
    perp_market_valid(&ctx.accounts.perp_market_with_pnl_pool)
)]
pub fn handle_transfer_fee_and_pnl_pool<'c: 'info, 'info>(
    ctx: Context<'info, TransferFeeAndPnlPool<'info>>,
    amount: u64,
    direction: TransferFeeAndPnlPoolDirection,
) -> Result<()> {
    let clock = Clock::get()?;
    let now = clock.unix_timestamp;
    let slot = clock.slot;

    let spot_market = &mut load_mut!(ctx.accounts.spot_market)?;

    controller::spot_balance::update_spot_market_cumulative_interest(spot_market, None, now)?;

    let same_market = ctx.accounts.perp_market_with_fee_pool.key()
        == ctx.accounts.perp_market_with_pnl_pool.key();

    if same_market {
        let mut perp_market = load_mut!(ctx.accounts.perp_market_with_fee_pool)?;

        let fee_pool = &mut perp_market.amm.fee_pool as *mut PoolBalance;
        let pnl_pool = &mut perp_market.pnl_pool as *mut PoolBalance;

        execute_transfer_between_pools(
            amount,
            spot_market,
            unsafe { &mut *fee_pool },
            unsafe { &mut *pnl_pool },
            perp_market.market_index,
            perp_market.market_index,
            direction,
        )?;

        // NO tfmd adjustment for a same-market move: under the
        // balance-sheet identity (tfmd = pools − net_user_pnl − pendings)
        // both pools sit inside one perimeter, so the transfer is
        // equity-neutral — adjusting the ledger would desync it from the
        // recompute.

        let transfer_record = TransferFeeAndPnlPoolRecord {
            ts: now,
            slot,
            perp_market_index_with_fee_pool: perp_market.market_index,
            perp_market_index_with_pnl_pool: perp_market.market_index,
            direction,
            amount,
        };

        emit!(transfer_record);
    } else {
        let mut perp_market_with_fee_pool = load_mut!(ctx.accounts.perp_market_with_fee_pool)?;
        let mut perp_market_with_pnl_pool = load_mut!(ctx.accounts.perp_market_with_pnl_pool)?;

        let fee_pool_market_index = perp_market_with_fee_pool.market_index;
        let pnl_pool_market_index = perp_market_with_pnl_pool.market_index;

        let fee_pool = &mut perp_market_with_fee_pool.amm.fee_pool;
        let pnl_pool = &mut perp_market_with_pnl_pool.pnl_pool;

        execute_transfer_between_pools(
            amount,
            spot_market,
            fee_pool,
            pnl_pool,
            fee_pool_market_index,
            pnl_pool_market_index,
            direction,
        )?;

        // cross-market: tokens genuinely leave/enter the fee-pool market's
        // perimeter, so its AMM ledger adjusts. The pnl-pool-side market
        // accrues implied-vs-stored drift instead (its pools changed without
        // a ledger entry) — reconciled by the summary-stats recompute ix.
        perp_market_with_fee_pool.amm.total_fee_minus_distributions = match direction {
            TransferFeeAndPnlPoolDirection::FeeToPnlPool => perp_market_with_fee_pool
                .amm
                .total_fee_minus_distributions
                .safe_sub(amount.cast()?)?,
            TransferFeeAndPnlPoolDirection::PnlToFeePool => perp_market_with_fee_pool
                .amm
                .total_fee_minus_distributions
                .safe_add(amount.cast()?)?,
        };

        let transfer_record = TransferFeeAndPnlPoolRecord {
            ts: now,
            slot,
            perp_market_index_with_fee_pool: fee_pool_market_index,
            perp_market_index_with_pnl_pool: pnl_pool_market_index,
            direction,
            amount,
        };

        emit!(transfer_record);
    }

    Ok(())
}

#[derive(Accounts)]
pub struct InitializeAmmCache<'info> {
    #[account(
        mut,
        constraint = check_warm(&admin.key(), &state)?
    )]
    pub admin: Signer<'info>,
    pub state: AccountLoader<'info, State>,
    #[account(
        init,
        seeds = [AMM_POSITIONS_CACHE.as_bytes()],
        space = AmmCache::init_space(),
        bump,
        payer = admin
    )]
    pub amm_cache: Box<Account<'info, AmmCache>>,
    pub rent: Sysvar<'info, Rent>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct AddMarketToAmmCache<'info> {
    #[account(
        mut,
        constraint = check_warm(&admin.key(), &state)?
    )]
    pub admin: Signer<'info>,
    pub state: AccountLoader<'info, State>,
    #[account(
        mut,
        seeds = [AMM_POSITIONS_CACHE.as_bytes()],
        bump,
        realloc = AmmCache::space(amm_cache.cache.len() + 1),
        realloc::payer = admin,
        realloc::zero = false,
    )]
    pub amm_cache: Box<Account<'info, AmmCache>>,
    pub perp_market: AccountLoader<'info, PerpMarket>,
    pub rent: Sysvar<'info, Rent>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct DeleteAmmCache<'info> {
    #[account(
        mut,
        constraint = check_warm(&admin.key(), &state)?
    )]
    pub admin: Signer<'info>,
    pub state: AccountLoader<'info, State>,
    #[account(
        mut,
        seeds = [AMM_POSITIONS_CACHE.as_bytes()],
        bump,
        close = admin,
    )]
    pub amm_cache: Box<Account<'info, AmmCache>>,
}

#[derive(Accounts)]
pub struct AdminUpdatePerpMarketAmmSummaryStats<'info> {
    #[account(constraint = check_hot(&admin.key(), &state, HotRole::AmmCrank)?)]
    pub admin: Signer<'info>,
    pub state: AccountLoader<'info, State>,
    #[account(mut)]
    pub perp_market: AccountLoader<'info, PerpMarket>,
    #[account(
        seeds = [b"spot_market", perp_market.load()?.quote_spot_market_index.to_le_bytes().as_ref()],
        bump,
    )]
    pub spot_market: AccountLoader<'info, SpotMarket>,
    /// CHECK: checked in `admin_update_perp_market_summary_stats` ix constraint
    pub oracle: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct DepositIntoMarketFeePool<'info> {
    #[account(mut)]
    pub state: AccountLoader<'info, State>,
    #[account(mut)]
    pub perp_market: AccountLoader<'info, PerpMarket>,
    #[account(constraint = check_hot(&admin.key(), &state, HotRole::VaultDeposit)?)]
    pub admin: Signer<'info>,
    #[account(
        mut,
        token::authority = admin
    )]
    pub source_vault: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(
        constraint = state.load()?.signer.eq(&velocity_signer.key())
    )]
    /// CHECK: withdraw fails if this isn't vault owner
    pub velocity_signer: UncheckedAccount<'info>,
    #[account(
        mut,
        seeds = [b"spot_market", 0_u16.to_le_bytes().as_ref()],
        bump,
    )]
    pub quote_spot_market: AccountLoader<'info, SpotMarket>,
    #[account(
        mut,
        seeds = [b"spot_market_vault".as_ref(), 0_u16.to_le_bytes().as_ref()],
        bump,
    )]
    pub spot_market_vault: Box<InterfaceAccount<'info, TokenAccount>>,
    pub token_program: Interface<'info, TokenInterface>,
}

#[derive(Accounts)]
pub struct RepegCurve<'info> {
    pub state: AccountLoader<'info, State>,
    #[account(mut)]
    pub perp_market: AccountLoader<'info, PerpMarket>,
    /// CHECK: checked in `repeg_curve` ix constraint
    pub oracle: UncheckedAccount<'info>,
    #[account(constraint = check_warm(&admin.key(), &state)?)]
    pub admin: Signer<'info>,
}

#[derive(Accounts)]
pub struct AdminUpdateK<'info> {
    #[account(constraint = check_warm(&admin.key(), &state)?)]
    pub admin: Signer<'info>,
    pub state: AccountLoader<'info, State>,
    #[account(mut)]
    pub perp_market: AccountLoader<'info, PerpMarket>,
    /// CHECK: checked in `admin_update_k` ix constraint
    pub oracle: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct TransferFeeAndPnlPool<'info> {
    pub state: AccountLoader<'info, State>,
    #[account(constraint = check_warm(&admin.key(), &state)?)]
    pub admin: Signer<'info>,
    #[account(mut)]
    pub perp_market_with_fee_pool: AccountLoader<'info, PerpMarket>,
    #[account(mut)]
    pub perp_market_with_pnl_pool: AccountLoader<'info, PerpMarket>,
    #[account(
        mut,
        seeds = [b"spot_market", 0_u16.to_le_bytes().as_ref()],
        bump,
    )]
    pub spot_market: AccountLoader<'info, SpotMarket>,
    #[account(
        mut,
        seeds = [b"spot_market_vault".as_ref(), 0_u16.to_le_bytes().as_ref()],
        bump,
    )]
    pub spot_market_vault: Box<InterfaceAccount<'info, TokenAccount>>,
}

#[access_control(
    perp_market_valid(&ctx.accounts.perp_market)
)]
pub fn handle_update_perp_market_concentration_coef(
    ctx: Context<AdminUpdatePerpMarket>,
    concentration_scale: u128,
) -> Result<()> {
    validate!(
        concentration_scale > 0,
        ErrorCode::DefaultError,
        "invalid concentration_scale",
    )?;

    let perp_market = &mut load_mut!(ctx.accounts.perp_market)?;
    msg!("perp market {}", perp_market.market_index);

    let prev_concentration_coef = perp_market.amm.concentration_coef;
    perp_market
        .amm
        .update_concentration_coef(concentration_scale)?;
    let new_concentration_coef = perp_market.amm.concentration_coef;

    msg!(
        "perp_market.amm.concentration_coef: {} -> {}",
        prev_concentration_coef,
        new_concentration_coef
    );

    Ok(())
}

#[cfg(test)]
mod native_auth_tests {
    //! Tests for the pre-Anchor native dispatch authentication on
    //! `handle_update_amm_spread_adjustment_native`. Run under `cargo test`
    //! (default features, no `anchor-test`), so the signer check is compiled in.
    use super::*;
    use crate::create_anchor_account_info;
    use crate::state::perp_market::PerpMarket;
    use crate::state::state::State;
    use crate::test_utils::get_anchor_account_bytes;
    use anchor_lang::prelude::{AccountInfo, Pubkey};

    fn signer_info<'a>(
        key: &'a Pubkey,
        is_signer: bool,
        lamports: &'a mut u64,
        data: &'a mut [u8],
        owner: &'a Pubkey,
    ) -> AccountInfo<'a> {
        AccountInfo::new(key, is_signer, false, lamports, data, owner, false)
    }

    #[test]
    fn spread_native_rejects_forged_state() {
        let attacker = Pubkey::new_unique();
        let mut state = State::default();
        state.hot_amm_spread_adjust = attacker;
        let mut state_bytes = get_anchor_account_bytes(&mut state);
        let foreign_owner = Pubkey::new_unique();
        let state_key = Pubkey::new_unique();
        let mut state_lamports = 0u64;
        let forged_state = AccountInfo::new(
            &state_key,
            false,
            false,
            &mut state_lamports,
            &mut state_bytes[..],
            &foreign_owner, // NOT crate::ID
            false,
        );

        let mut perp_market = PerpMarket::default();
        create_anchor_account_info!(perp_market, PerpMarket, perp_market_info);

        let mut sig_lamports = 0u64;
        let mut sig_data: [u8; 0] = [];
        let sig_owner = Pubkey::new_unique();
        let signer = signer_info(
            &attacker,
            true,
            &mut sig_lamports,
            &mut sig_data,
            &sig_owner,
        );

        let accounts = [perp_market_info, signer, forged_state];
        let err = handle_update_amm_spread_adjustment_native(&accounts, &[7i8 as u8]).unwrap_err();
        assert_eq!(err, ErrorCode::InvalidNativeStateAccount.into());
    }

    #[test]
    fn spread_native_rejects_non_perp_market_in_market_slot() {
        let hot_key = Pubkey::new_unique();
        let mut state = State::default();
        state.hot_amm_spread_adjust = hot_key;
        create_anchor_account_info!(state, State, state_info);

        let mut not_a_market = State::default();
        create_anchor_account_info!(not_a_market, State, not_a_market_info);

        let mut sig_lamports = 0u64;
        let mut sig_data: [u8; 0] = [];
        let sig_owner = Pubkey::new_unique();
        let signer = signer_info(&hot_key, true, &mut sig_lamports, &mut sig_data, &sig_owner);

        let accounts = [not_a_market_info, signer, state_info];
        let err = handle_update_amm_spread_adjustment_native(&accounts, &[7i8 as u8]).unwrap_err();
        assert_eq!(err, ErrorCode::InvalidNativePerpMarketAccount.into());
    }

    #[test]
    fn spread_native_rejects_unauthorized_signer() {
        let hot_key = Pubkey::new_unique();
        let mut state = State::default();
        state.hot_amm_spread_adjust = hot_key;
        create_anchor_account_info!(state, State, state_info);

        let mut perp_market = PerpMarket::default();
        create_anchor_account_info!(perp_market, PerpMarket, perp_market_info);

        let attacker = Pubkey::new_unique();
        let mut sig_lamports = 0u64;
        let mut sig_data: [u8; 0] = [];
        let sig_owner = Pubkey::new_unique();
        let signer = signer_info(
            &attacker,
            true,
            &mut sig_lamports,
            &mut sig_data,
            &sig_owner,
        );

        let accounts = [perp_market_info, signer, state_info];
        let err = handle_update_amm_spread_adjustment_native(&accounts, &[7i8 as u8]).unwrap_err();
        assert_eq!(err, ErrorCode::Unauthorized.into());
    }

    #[test]
    fn spread_native_happy_path_writes_adjustment() {
        let hot_key = Pubkey::new_unique();
        let mut state = State::default();
        state.hot_amm_spread_adjust = hot_key;
        create_anchor_account_info!(state, State, state_info);

        let mut perp_market = PerpMarket::default();
        create_anchor_account_info!(perp_market, PerpMarket, perp_market_info);

        let mut sig_lamports = 0u64;
        let mut sig_data: [u8; 0] = [];
        let sig_owner = Pubkey::new_unique();
        let signer = signer_info(&hot_key, true, &mut sig_lamports, &mut sig_data, &sig_owner);

        let expected: i8 = -5;
        let accounts = [perp_market_info, signer, state_info];
        handle_update_amm_spread_adjustment_native(&accounts, &[expected as u8]).unwrap();

        // Reload the market account and confirm the adjustment landed.
        let loader = AccountLoader::<PerpMarket>::try_from(&accounts[0]).unwrap();
        assert_eq!(loader.load().unwrap().amm.amm_spread_adjustment, expected);
    }
}
