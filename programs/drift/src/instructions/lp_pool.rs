use anchor_lang::{prelude::*, Accounts, Key, Result};
use anchor_spl::token_interface::{Mint, TokenAccount, TokenInterface};

use crate::ids::DLP_WHITELIST;
use crate::{
    controller::{
        self,
        spot_balance::update_spot_balances,
        token::{burn_tokens, mint_tokens},
    },
    error::ErrorCode,
    get_then_update_id,
    ids::admin_hot_wallet,
    math::{
        self,
        casting::Cast,
        constants::{PERCENTAGE_PRECISION_I64, PRICE_PRECISION},
        oracle::{is_oracle_valid_for_action, oracle_validity, DriftAction, LogMode},
        safe_math::SafeMath,
    },
    math_error, msg, safe_decrement, safe_increment,
    state::{
        constituent_map::{ConstituentMap, ConstituentSet},
        events::{emit_stack, LPMintRedeemRecord, LPSwapRecord},
        lp_pool::{
            update_constituent_target_base_for_derivatives, AmmConstituentDatum,
            AmmConstituentMappingFixed, Constituent, ConstituentCorrelationsFixed,
            ConstituentTargetBaseFixed, LPPool, TargetsDatum, LP_POOL_SWAP_AUM_UPDATE_DELAY,
            MAX_AMM_CACHE_ORACLE_STALENESS_FOR_TARGET_CALC,
            MAX_AMM_CACHE_STALENESS_FOR_TARGET_CALC,
        },
        oracle::OraclePriceData,
        oracle_map::OracleMap,
        perp_market::{AmmCacheFixed, CacheInfo, AMM_POSITIONS_CACHE},
        perp_market_map::MarketSet,
        spot_market::{SpotBalanceType, SpotMarket},
        spot_market_map::get_writable_spot_market_set_from_many,
        state::State,
        traits::Size,
        user::MarketType,
        zero_copy::{AccountZeroCopy, AccountZeroCopyMut, ZeroCopyLoader},
    },
    validate,
};

use solana_program::sysvar::clock::Clock;

use super::optional_accounts::{load_maps, AccountMaps};
use crate::controller::spot_balance::update_spot_market_cumulative_interest;
use crate::controller::token::{receive, send_from_program_vault};
use crate::instructions::constraints::*;
use crate::state::lp_pool::{
    CONSTITUENT_PDA_SEED, CONSTITUENT_TARGET_BASE_PDA_SEED, LP_POOL_TOKEN_VAULT_PDA_SEED,
};

pub fn handle_update_constituent_target_base<'c: 'info, 'info>(
    ctx: Context<'_, '_, 'c, 'info, UpdateConstituentTargetBase<'info>>,
) -> Result<()> {
    let slot = Clock::get()?.slot;

    let lp_pool_key: &Pubkey = &ctx.accounts.lp_pool.key();
    let amm_cache_key: &Pubkey = &ctx.accounts.amm_cache.key();

    let amm_cache: AccountZeroCopy<'_, CacheInfo, AmmCacheFixed> =
        ctx.accounts.amm_cache.load_zc()?;

    amm_cache.check_oracle_staleness(slot, MAX_AMM_CACHE_ORACLE_STALENESS_FOR_TARGET_CALC)?;
    amm_cache.check_perp_market_staleness(slot, MAX_AMM_CACHE_STALENESS_FOR_TARGET_CALC)?;

    let expected_cache_pda = &Pubkey::create_program_address(
        &[
            AMM_POSITIONS_CACHE.as_ref(),
            amm_cache.fixed.bump.to_le_bytes().as_ref(),
        ],
        &crate::ID,
    )
    .map_err(|_| ErrorCode::InvalidPDA)?;
    validate!(
        expected_cache_pda.eq(amm_cache_key),
        ErrorCode::InvalidPDA,
        "Amm cache PDA does not match expected PDA"
    )?;

    let state = &ctx.accounts.state;
    let mut constituent_target_base: AccountZeroCopyMut<
        '_,
        TargetsDatum,
        ConstituentTargetBaseFixed,
    > = ctx.accounts.constituent_target_base.load_zc_mut()?;
    validate!(
        constituent_target_base.fixed.lp_pool.eq(lp_pool_key),
        ErrorCode::InvalidPDA,
        "Constituent target base lp pool pubkey does not match lp pool pubkey",
    )?;

    let num_constituents = constituent_target_base.len();
    for datum in constituent_target_base.iter() {
        msg!("weight datum: {:?}", datum);
    }

    let slot = Clock::get()?.slot;

    let amm_constituent_mapping: AccountZeroCopy<
        '_,
        AmmConstituentDatum,
        AmmConstituentMappingFixed,
    > = ctx.accounts.amm_constituent_mapping.load_zc()?;
    validate!(
        amm_constituent_mapping.fixed.lp_pool.eq(lp_pool_key),
        ErrorCode::InvalidPDA,
        "Amm constituent mapping lp pool pubkey does not match lp pool pubkey",
    )?;

    let remaining_accounts = &mut ctx.remaining_accounts.iter().peekable();
    let constituent_map =
        ConstituentMap::load(&ConstituentSet::new(), &lp_pool_key, remaining_accounts)?;

    let mut amm_inventories: Vec<(u16, i64, i64)> =
        Vec::with_capacity(amm_constituent_mapping.len() as usize);
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
            LogMode::ExchangeOracle,
            0,
        )?;

        if !is_oracle_valid_for_action(
            oracle_validity,
            Some(DriftAction::UpdateLpConstituentTargetBase),
        )? {
            msg!("Oracle data for perp market {} and constituent index {} is invalid. Skipping update",
                datum.perp_market_index, datum.constituent_index);
            continue;
        }

        amm_inventories.push((
            datum.perp_market_index,
            cache_info.position,
            cache_info.oracle_price,
        ));
    }

    if amm_inventories.is_empty() {
        msg!("No valid inventories found for constituent target weights update");
        return Ok(());
    }

    let mut constituent_indexes_and_decimals_and_prices: Vec<(u16, u8, i64)> =
        Vec::with_capacity(constituent_map.0.len());
    for (index, loader) in &constituent_map.0 {
        let constituent_ref = loader.load()?;
        constituent_indexes_and_decimals_and_prices.push((
            *index,
            constituent_ref.decimals,
            constituent_ref.last_oracle_price,
        ));
    }

    let exists_invalid_constituent_index = constituent_indexes_and_decimals_and_prices
        .iter()
        .any(|(index, _, _)| *index as u32 >= num_constituents);

    validate!(
        !exists_invalid_constituent_index,
        ErrorCode::InvalidUpdateConstituentTargetBaseArgument,
        "Constituent index larger than number of constituent target weights"
    )?;

    constituent_target_base.update_target_base(
        &amm_constituent_mapping,
        amm_inventories.as_slice(),
        constituent_indexes_and_decimals_and_prices.as_slice(),
        slot,
    )?;

    Ok(())
}

pub fn handle_update_lp_pool_aum<'c: 'info, 'info>(
    ctx: Context<'_, '_, 'c, 'info, UpdateLPPoolAum<'info>>,
) -> Result<()> {
    let mut lp_pool = ctx.accounts.lp_pool.load_mut()?;
    let state = &ctx.accounts.state;

    let slot = Clock::get()?.slot;
    let now = Clock::get()?.unix_timestamp;

    let remaining_accounts = &mut ctx.remaining_accounts.iter().peekable();

    let AccountMaps {
        perp_market_map: _,
        spot_market_map,
        oracle_map: _,
    } = load_maps(
        remaining_accounts,
        &MarketSet::new(),
        &MarketSet::new(),
        slot,
        Some(state.oracle_guard_rails),
    )?;

    let constituent_map =
        ConstituentMap::load(&ConstituentSet::new(), &lp_pool.pubkey, remaining_accounts)?;

    validate!(
        constituent_map.0.len() == lp_pool.constituents as usize,
        ErrorCode::WrongNumberOfConstituents,
        "Constituent map length does not match lp pool constituent count"
    )?;

    let mut constituent_target_base: AccountZeroCopyMut<
        '_,
        TargetsDatum,
        ConstituentTargetBaseFixed,
    > = ctx.accounts.constituent_target_base.load_zc_mut()?;
    validate!(
        constituent_target_base.fixed.lp_pool.eq(&lp_pool.pubkey),
        ErrorCode::InvalidPDA,
        "Constituent target base lp pool pubkey does not match lp pool pubkey",
    )?;

    let amm_cache_key: &Pubkey = &ctx.accounts.amm_cache.key();
    let amm_cache: AccountZeroCopyMut<'_, CacheInfo, AmmCacheFixed> =
        ctx.accounts.amm_cache.load_zc_mut()?;
    let expected_amm_pda = &Pubkey::create_program_address(
        &[
            AMM_POSITIONS_CACHE.as_ref(),
            amm_cache.fixed.bump.to_le_bytes().as_ref(),
        ],
        &crate::ID,
    )
    .map_err(|_| ErrorCode::InvalidPDA)?;
    validate!(
        amm_cache_key.eq(expected_amm_pda),
        ErrorCode::InvalidPDA,
        "Amm cache PDA does not match expected PDA"
    )?;

    let (aum, crypto_delta, derivative_groups) = lp_pool.update_aum(
        now,
        slot,
        &constituent_map,
        &spot_market_map,
        &constituent_target_base,
        &amm_cache,
    )?;

    // Set USDC stable weight
    let total_stable_target_base = aum
        .cast::<i128>()?
        .safe_sub(crypto_delta.abs())?
        .max(0_i128);
    constituent_target_base
        .get_mut(lp_pool.usdc_consituent_index as u32)
        .target_base = total_stable_target_base.cast::<i64>()?;

    msg!(
        "stable target base: {}",
        constituent_target_base
            .get(lp_pool.usdc_consituent_index as u32)
            .target_base
    );
    msg!("aum: {}, crypto_delta: {}", aum, crypto_delta);
    msg!("derivative groups: {:?}", derivative_groups);

    update_constituent_target_base_for_derivatives(
        aum,
        &derivative_groups,
        &constituent_map,
        &spot_market_map,
        &mut constituent_target_base,
    )?;

    Ok(())
}

#[access_control(
    fill_not_paused(&ctx.accounts.state)
)]
pub fn handle_lp_pool_swap<'c: 'info, 'info>(
    ctx: Context<'_, '_, 'c, 'info, LPPoolSwap<'info>>,
    in_market_index: u16,
    out_market_index: u16,
    in_amount: u64,
    min_out_amount: u64,
) -> Result<()> {
    validate!(
        in_market_index != out_market_index,
        ErrorCode::InvalidSpotMarketAccount,
        "In and out spot market indices cannot be the same"
    )?;

    let slot = Clock::get()?.slot;
    let now = Clock::get()?.unix_timestamp;
    let state = &ctx.accounts.state;
    let lp_pool = &ctx.accounts.lp_pool.load()?;
    let remaining_accounts = &mut ctx.remaining_accounts.iter().peekable();

    if slot.saturating_sub(lp_pool.last_aum_slot) > LP_POOL_SWAP_AUM_UPDATE_DELAY {
        msg!(
            "Must update LP pool AUM before swap, last_aum_slot: {}, current slot: {}",
            lp_pool.last_aum_slot,
            slot
        );
        return Err(ErrorCode::LpPoolAumDelayed.into());
    }

    let mut in_constituent = ctx.accounts.in_constituent.load_mut()?;
    let mut out_constituent = ctx.accounts.out_constituent.load_mut()?;

    let constituent_target_base: AccountZeroCopy<'_, TargetsDatum, ConstituentTargetBaseFixed> =
        ctx.accounts.constituent_target_base.load_zc()?;
    validate!(
        constituent_target_base.fixed.lp_pool.eq(&lp_pool.pubkey),
        ErrorCode::InvalidPDA,
        "Constituent target base lp pool pubkey does not match lp pool pubkey",
    )?;

    let constituent_correlations: AccountZeroCopy<'_, i64, ConstituentCorrelationsFixed> =
        ctx.accounts.constituent_correlations.load_zc()?;
    validate!(
        constituent_correlations.fixed.lp_pool.eq(&lp_pool.pubkey),
        ErrorCode::InvalidPDA,
        "Constituent correlations lp pool pubkey does not match lp pool pubkey",
    )?;

    let AccountMaps {
        perp_market_map: _,
        spot_market_map,
        mut oracle_map,
    } = load_maps(
        &mut ctx.remaining_accounts.iter().peekable(),
        &MarketSet::new(),
        &MarketSet::new(),
        slot,
        Some(state.oracle_guard_rails),
    )?;

    let in_spot_market = spot_market_map.get_ref(&in_market_index)?;
    let out_spot_market = spot_market_map.get_ref(&out_market_index)?;

    let in_oracle_id = in_spot_market.oracle_id();
    let out_oracle_id = out_spot_market.oracle_id();

    let (in_oracle, in_oracle_validity) = oracle_map.get_price_data_and_validity(
        MarketType::Spot,
        in_spot_market.market_index,
        &in_oracle_id,
        in_spot_market.historical_oracle_data.last_oracle_price_twap,
        in_spot_market.get_max_confidence_interval_multiplier()?,
        0,
    )?;
    let in_oracle = in_oracle.clone();

    let (out_oracle, out_oracle_validity) = oracle_map.get_price_data_and_validity(
        MarketType::Spot,
        out_spot_market.market_index,
        &out_oracle_id,
        out_spot_market
            .historical_oracle_data
            .last_oracle_price_twap,
        out_spot_market.get_max_confidence_interval_multiplier()?,
        0,
    )?;

    if !is_oracle_valid_for_action(in_oracle_validity, Some(DriftAction::LpPoolSwap))? {
        msg!(
            "In oracle data for spot market {} is invalid for lp pool swap.",
            in_spot_market.market_index,
        );
        return Err(ErrorCode::InvalidOracle.into());
    }

    if !is_oracle_valid_for_action(out_oracle_validity, Some(DriftAction::LpPoolSwap))? {
        msg!(
            "Out oracle data for spot market {} is invalid for lp pool swap.",
            out_spot_market.market_index,
        );
        return Err(ErrorCode::InvalidOracle.into());
    }

    let in_target_weight = constituent_target_base.get_target_weight(
        in_constituent.constituent_index,
        &in_spot_market,
        in_oracle.price,
        lp_pool.last_aum,
    )?;
    let out_target_weight = constituent_target_base.get_target_weight(
        out_constituent.constituent_index,
        &out_spot_market,
        out_oracle.price,
        lp_pool.last_aum,
    )?;

    let (in_amount, out_amount, in_fee, out_fee) = lp_pool.get_swap_amount(
        &in_oracle,
        &out_oracle,
        &in_constituent,
        &out_constituent,
        &in_spot_market,
        &out_spot_market,
        in_target_weight,
        out_target_weight,
        in_amount as u128,
        constituent_correlations.get_correlation(
            in_constituent.constituent_index,
            out_constituent.constituent_index,
        )?,
    )?;
    msg!(
        "in_amount: {}, out_amount: {}, in_fee: {}, out_fee: {}",
        in_amount,
        out_amount,
        in_fee,
        out_fee
    );
    let out_amount_net_fees = if out_fee > 0 {
        out_amount.safe_sub(out_fee.unsigned_abs())?
    } else {
        out_amount.safe_add(out_fee.unsigned_abs())?
    };

    validate!(
        out_amount_net_fees.cast::<u64>()? >= min_out_amount,
        ErrorCode::SlippageOutsideLimit,
        format!(
            "Slippage outside limit: out_amount_net_fees({}) < min_out_amount({})",
            out_amount_net_fees, min_out_amount
        )
        .as_str()
    )?;

    validate!(
        out_amount_net_fees.cast::<u64>()? <= out_constituent.token_balance,
        ErrorCode::InsufficientConstituentTokenBalance,
        format!(
            "Insufficient out constituent balance: out_amount_net_fees({}) > out_constituent.token_balance({})",
            out_amount_net_fees, out_constituent.token_balance
        )
        .as_str()
    )?;

    in_constituent.record_swap_fees(in_fee)?;
    out_constituent.record_swap_fees(out_fee)?;

    let in_swap_id = get_then_update_id!(in_constituent, next_swap_id);
    let out_swap_id = get_then_update_id!(out_constituent, next_swap_id);

    emit_stack::<_, { LPSwapRecord::SIZE }>(LPSwapRecord {
        ts: now,
        slot,
        authority: ctx.accounts.authority.key(),
        out_amount: out_amount_net_fees,
        in_amount,
        out_fee,
        in_fee,
        out_spot_market_index: out_market_index,
        in_spot_market_index: in_market_index,
        out_constituent_index: out_constituent.constituent_index,
        in_constituent_index: in_constituent.constituent_index,
        out_oracle_price: out_oracle.price,
        in_oracle_price: in_oracle.price,
        last_aum: lp_pool.last_aum,
        last_aum_slot: lp_pool.last_aum_slot,
        in_market_current_weight: in_constituent.get_weight(
            in_oracle.price,
            &in_spot_market,
            0,
            lp_pool.last_aum,
        )?,
        in_market_target_weight: in_target_weight,
        out_market_current_weight: out_constituent.get_weight(
            out_oracle.price,
            &out_spot_market,
            0,
            lp_pool.last_aum,
        )?,
        out_market_target_weight: out_target_weight,
        in_swap_id,
        out_swap_id,
    })?;

    receive(
        &ctx.accounts.token_program,
        &ctx.accounts.user_in_token_account,
        &ctx.accounts.constituent_in_token_account,
        &ctx.accounts.authority,
        in_amount.cast::<u64>()?,
        &Some((*ctx.accounts.in_market_mint).clone()),
        Some(remaining_accounts),
    )?;

    send_from_program_vault(
        &ctx.accounts.token_program,
        &ctx.accounts.constituent_out_token_account,
        &ctx.accounts.user_out_token_account,
        &ctx.accounts.drift_signer,
        state.signer_nonce,
        out_amount_net_fees.cast::<u64>()?,
        &Some((*ctx.accounts.out_market_mint).clone()),
        Some(remaining_accounts),
    )?;

    ctx.accounts.constituent_in_token_account.reload()?;
    ctx.accounts.constituent_out_token_account.reload()?;

    in_constituent.sync_token_balance(ctx.accounts.constituent_in_token_account.amount);
    out_constituent.sync_token_balance(ctx.accounts.constituent_out_token_account.amount);

    Ok(())
}

pub fn handle_view_lp_pool_swap_fees<'c: 'info, 'info>(
    ctx: Context<'_, '_, 'c, 'info, ViewLPPoolSwapFees<'info>>,
    in_market_index: u16,
    out_market_index: u16,
    in_amount: u64,
    in_target_weight: i64,
    out_target_weight: i64,
) -> Result<()> {
    let slot = Clock::get()?.slot;
    let state = &ctx.accounts.state;

    let lp_pool = &ctx.accounts.lp_pool.load()?;
    let in_constituent = ctx.accounts.in_constituent.load()?;
    let out_constituent = ctx.accounts.out_constituent.load()?;
    let constituent_correlations: AccountZeroCopy<'_, i64, ConstituentCorrelationsFixed> =
        ctx.accounts.constituent_correlations.load_zc()?;

    let AccountMaps {
        perp_market_map: _,
        spot_market_map,
        mut oracle_map,
    } = load_maps(
        &mut ctx.remaining_accounts.iter().peekable(),
        &MarketSet::new(),
        &MarketSet::new(),
        slot,
        Some(state.oracle_guard_rails),
    )?;

    let in_spot_market = spot_market_map.get_ref(&in_market_index)?;
    let out_spot_market = spot_market_map.get_ref(&out_market_index)?;

    let in_oracle_id = in_spot_market.oracle_id();
    let out_oracle_id = out_spot_market.oracle_id();

    let (in_oracle, _) = oracle_map.get_price_data_and_validity(
        MarketType::Spot,
        in_spot_market.market_index,
        &in_oracle_id,
        in_spot_market.historical_oracle_data.last_oracle_price_twap,
        in_spot_market.get_max_confidence_interval_multiplier()?,
        0,
    )?;
    let in_oracle = in_oracle.clone();

    let (out_oracle, _) = oracle_map.get_price_data_and_validity(
        MarketType::Spot,
        out_spot_market.market_index,
        &out_oracle_id,
        out_spot_market
            .historical_oracle_data
            .last_oracle_price_twap,
        out_spot_market.get_max_confidence_interval_multiplier()?,
        0,
    )?;

    let (in_amount, out_amount, in_fee, out_fee) = lp_pool.get_swap_amount(
        &in_oracle,
        &out_oracle,
        &in_constituent,
        &out_constituent,
        &in_spot_market,
        &out_spot_market,
        in_target_weight,
        out_target_weight,
        in_amount as u128,
        constituent_correlations.get_correlation(
            in_constituent.constituent_index,
            out_constituent.constituent_index,
        )?,
    )?;
    msg!(
        "in_amount: {}, out_amount: {}, in_fee: {}, out_fee: {}",
        in_amount,
        out_amount,
        in_fee,
        out_fee
    );
    Ok(())
}

#[access_control(
    fill_not_paused(&ctx.accounts.state)
)]
pub fn handle_lp_pool_add_liquidity<'c: 'info, 'info>(
    ctx: Context<'_, '_, 'c, 'info, LPPoolAddLiquidity<'info>>,
    in_market_index: u16,
    in_amount: u128,
    min_mint_amount: u64,
) -> Result<()> {
    #[cfg(not(feature = "anchor-test"))]
    validate!(
        DLP_WHITELIST.contains(&ctx.accounts.authority.key()),
        ErrorCode::UnauthorizedDlpAuthority,
        "User is not whitelisted for DLP deposits"
    )?;

    let slot = Clock::get()?.slot;
    let now = Clock::get()?.unix_timestamp;
    let state = &ctx.accounts.state;
    let mut lp_pool = ctx.accounts.lp_pool.load_mut()?;

    if slot.saturating_sub(lp_pool.last_aum_slot) > LP_POOL_SWAP_AUM_UPDATE_DELAY {
        msg!(
            "Must update LP pool AUM before swap, last_aum_slot: {}, current slot: {}",
            lp_pool.last_aum_slot,
            slot
        );
        return Err(ErrorCode::LpPoolAumDelayed.into());
    }

    let remaining_accounts = &mut ctx.remaining_accounts.iter().peekable();

    let mut in_constituent = ctx.accounts.in_constituent.load_mut()?;

    let constituent_target_base = ctx.accounts.constituent_target_base.load_zc()?;

    let AccountMaps {
        perp_market_map: _,
        spot_market_map,
        mut oracle_map,
    } = load_maps(
        remaining_accounts,
        &MarketSet::new(),
        &get_writable_spot_market_set_from_many(vec![in_market_index]),
        slot,
        Some(state.oracle_guard_rails),
    )?;

    let mut in_spot_market = spot_market_map.get_ref_mut(&in_market_index)?;

    let in_oracle_id = in_spot_market.oracle_id();

    let (in_oracle, in_oracle_validity) = oracle_map.get_price_data_and_validity(
        MarketType::Spot,
        in_spot_market.market_index,
        &in_oracle_id,
        in_spot_market.historical_oracle_data.last_oracle_price_twap,
        in_spot_market.get_max_confidence_interval_multiplier()?,
        0,
    )?;
    let in_oracle = in_oracle.clone();

    if !is_oracle_valid_for_action(in_oracle_validity, Some(DriftAction::LpPoolSwap))? {
        msg!(
            "In oracle data for spot market {} is invalid for lp pool swap.",
            in_spot_market.market_index,
        );
        return Err(ErrorCode::InvalidOracle.into());
    }

    // TODO: check self.aum validity

    update_spot_market_cumulative_interest(&mut in_spot_market, Some(&in_oracle), now)?;

    msg!("aum: {}", lp_pool.last_aum);
    let in_target_weight = if lp_pool.last_aum == 0 {
        PERCENTAGE_PRECISION_I64 // 100% weight if no aum
    } else {
        constituent_target_base.get_target_weight(
            in_constituent.constituent_index,
            &in_spot_market,
            in_oracle.price,
            lp_pool.last_aum, // TODO: add in_amount * in_oracle to est post add_liquidity aum
        )?
    };

    let dlp_total_supply = ctx.accounts.lp_mint.supply;

    let (lp_amount, in_amount, lp_fee_amount, in_fee_amount) = lp_pool
        .get_add_liquidity_mint_amount(
            now,
            &in_spot_market,
            &in_constituent,
            in_amount,
            &in_oracle,
            in_target_weight,
            dlp_total_supply,
        )?;
    msg!(
        "lp_amount: {}, in_amount: {}, lp_fee_amount: {}, in_fee_amount: {}",
        lp_amount,
        in_amount,
        lp_fee_amount,
        in_fee_amount
    );

    let lp_mint_amount_net_fees = if lp_fee_amount > 0 {
        lp_amount.safe_sub(lp_fee_amount.unsigned_abs() as u64)?
    } else {
        lp_amount.safe_add(lp_fee_amount.unsigned_abs() as u64)?
    };

    validate!(
        lp_mint_amount_net_fees >= min_mint_amount,
        ErrorCode::SlippageOutsideLimit,
        format!(
            "Slippage outside limit: lp_mint_amount_net_fees({}) < min_mint_amount({})",
            lp_mint_amount_net_fees, min_mint_amount
        )
        .as_str()
    )?;

    in_constituent.record_swap_fees(in_fee_amount)?;
    lp_pool.record_mint_redeem_fees(lp_fee_amount)?;

    receive(
        &ctx.accounts.token_program,
        &ctx.accounts.user_in_token_account,
        &ctx.accounts.constituent_in_token_account,
        &ctx.accounts.authority,
        in_amount.cast::<u64>()?,
        &Some((*ctx.accounts.in_market_mint).clone()),
        Some(remaining_accounts),
    )?;

    mint_tokens(
        &ctx.accounts.token_program,
        &ctx.accounts.lp_pool_token_vault,
        &ctx.accounts.drift_signer,
        state.signer_nonce,
        lp_amount,
        &ctx.accounts.lp_mint,
    )?;

    send_from_program_vault(
        &ctx.accounts.token_program,
        &ctx.accounts.lp_pool_token_vault,
        &ctx.accounts.user_lp_token_account,
        &ctx.accounts.drift_signer,
        state.signer_nonce,
        lp_mint_amount_net_fees,
        &Some((*ctx.accounts.lp_mint).clone()),
        Some(remaining_accounts),
    )?;

    lp_pool.last_aum = lp_pool.last_aum.safe_add(
        in_amount
            .cast::<u128>()?
            .safe_mul(in_oracle.price.cast::<u128>()?)?
            .safe_div(10_u128.pow(in_spot_market.decimals))?,
    )?;

    if lp_pool.last_aum > lp_pool.max_aum {
        return Err(ErrorCode::MaxDlpAumBreached.into());
    }

    ctx.accounts.constituent_in_token_account.reload()?;
    ctx.accounts.lp_mint.reload()?;

    in_constituent.sync_token_balance(ctx.accounts.constituent_in_token_account.amount);

    let dlp_total_supply = ctx.accounts.lp_mint.supply;
    let lp_price = if dlp_total_supply > 0 {
        lp_pool
            .last_aum
            .safe_mul(PRICE_PRECISION)?
            .safe_div(dlp_total_supply as u128)?
    } else {
        0
    };

    let mint_redeem_id = get_then_update_id!(lp_pool, next_mint_redeem_id);
    emit_stack::<_, { LPMintRedeemRecord::SIZE }>(LPMintRedeemRecord {
        ts: now,
        slot,
        authority: ctx.accounts.authority.key(),
        description: 1,
        amount: in_amount,
        fee: in_fee_amount,
        spot_market_index: in_market_index,
        constituent_index: in_constituent.constituent_index,
        oracle_price: in_oracle.price,
        mint: in_constituent.mint,
        lp_amount,
        lp_fee: lp_fee_amount,
        lp_price,
        mint_redeem_id,
        last_aum: lp_pool.last_aum,
        last_aum_slot: lp_pool.last_aum_slot,
        in_market_current_weight: in_constituent.get_weight(
            in_oracle.price,
            &in_spot_market,
            0,
            lp_pool.last_aum,
        )?,
        in_market_target_weight: in_target_weight,
    })?;

    Ok(())
}

pub fn handle_view_lp_pool_add_liquidity_fees<'c: 'info, 'info>(
    ctx: Context<'_, '_, 'c, 'info, ViewLPPoolAddLiquidityFees<'info>>,
    in_market_index: u16,
    in_amount: u128,
) -> Result<()> {
    let slot = Clock::get()?.slot;
    let now = Clock::get()?.unix_timestamp;
    let state = &ctx.accounts.state;
    let lp_pool = ctx.accounts.lp_pool.load_mut()?;

    if slot.saturating_sub(lp_pool.last_aum_slot) > LP_POOL_SWAP_AUM_UPDATE_DELAY {
        msg!(
            "Must update LP pool AUM before swap, last_aum_slot: {}, current slot: {}",
            lp_pool.last_aum_slot,
            slot
        );
        return Err(ErrorCode::LpPoolAumDelayed.into());
    }

    let remaining_accounts = &mut ctx.remaining_accounts.iter().peekable();
    let mut in_constituent = ctx.accounts.in_constituent.load_mut()?;

    let constituent_target_base = ctx.accounts.constituent_target_base.load_zc()?;

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

    let in_spot_market = spot_market_map.get_ref(&in_market_index)?;

    let in_oracle_id = in_spot_market.oracle_id();

    let (in_oracle, in_oracle_validity) = oracle_map.get_price_data_and_validity(
        MarketType::Spot,
        in_spot_market.market_index,
        &in_oracle_id,
        in_spot_market.historical_oracle_data.last_oracle_price_twap,
        in_spot_market.get_max_confidence_interval_multiplier()?,
        0,
    )?;
    let in_oracle = in_oracle.clone();

    if !is_oracle_valid_for_action(in_oracle_validity, Some(DriftAction::LpPoolSwap))? {
        msg!(
            "In oracle data for spot market {} is invalid for lp pool swap.",
            in_spot_market.market_index,
        );
        return Err(ErrorCode::InvalidOracle.into());
    }

    msg!("aum: {}", lp_pool.last_aum);
    let in_target_weight = if lp_pool.last_aum == 0 {
        PERCENTAGE_PRECISION_I64 // 100% weight if no aum
    } else {
        constituent_target_base.get_target_weight(
            in_constituent.constituent_index,
            &in_spot_market,
            in_oracle.price,
            lp_pool.last_aum, // TODO: add in_amount * in_oracle to est post add_liquidity aum
        )?
    };

    let dlp_total_supply = ctx.accounts.lp_mint.supply;

    let (lp_amount, in_amount, lp_fee_amount, in_fee_amount) = lp_pool
        .get_add_liquidity_mint_amount(
            now,
            &in_spot_market,
            &in_constituent,
            in_amount,
            &in_oracle,
            in_target_weight,
            dlp_total_supply,
        )?;
    msg!(
        "lp_amount: {}, in_amount: {}, lp_fee_amount: {}, in_fee_amount: {}",
        lp_amount,
        in_amount,
        lp_fee_amount,
        in_fee_amount
    );

    Ok(())
}

#[access_control(
    fill_not_paused(&ctx.accounts.state)
)]
pub fn handle_lp_pool_remove_liquidity<'c: 'info, 'info>(
    ctx: Context<'_, '_, 'c, 'info, LPPoolRemoveLiquidity<'info>>,
    out_market_index: u16,
    lp_to_burn: u64,
    min_amount_out: u128,
) -> Result<()> {
    let slot = Clock::get()?.slot;
    let now = Clock::get()?.unix_timestamp;
    let state = &ctx.accounts.state;
    let mut lp_pool = ctx.accounts.lp_pool.load_mut()?;

    if slot.saturating_sub(lp_pool.last_aum_slot) > LP_POOL_SWAP_AUM_UPDATE_DELAY {
        msg!(
            "Must update LP pool AUM before swap, last_aum_slot: {}, current slot: {}",
            lp_pool.last_aum_slot,
            slot
        );
        return Err(ErrorCode::LpPoolAumDelayed.into());
    }

    let mut out_constituent = ctx.accounts.out_constituent.load_mut()?;

    let constituent_target_base = ctx.accounts.constituent_target_base.load_zc()?;

    let remaining_accounts = &mut ctx.remaining_accounts.iter().peekable();

    let AccountMaps {
        perp_market_map: _,
        spot_market_map,
        mut oracle_map,
    } = load_maps(
        remaining_accounts,
        &MarketSet::new(),
        &get_writable_spot_market_set_from_many(vec![out_market_index]),
        slot,
        Some(state.oracle_guard_rails),
    )?;

    let mut out_spot_market = spot_market_map.get_ref_mut(&out_market_index)?;

    let out_oracle_id = out_spot_market.oracle_id();

    let (out_oracle, out_oracle_validity) = oracle_map.get_price_data_and_validity(
        MarketType::Spot,
        out_spot_market.market_index,
        &out_oracle_id,
        out_spot_market
            .historical_oracle_data
            .last_oracle_price_twap,
        out_spot_market.get_max_confidence_interval_multiplier()?,
        0,
    )?;
    let out_oracle = out_oracle.clone();

    // TODO: check self.aum validity

    if !is_oracle_valid_for_action(out_oracle_validity, Some(DriftAction::LpPoolSwap))? {
        msg!(
            "Out oracle data for spot market {} is invalid for lp pool swap.",
            out_spot_market.market_index,
        );
        return Err(ErrorCode::InvalidOracle.into());
    }

    update_spot_market_cumulative_interest(&mut out_spot_market, Some(&out_oracle), now)?;

    let out_target_weight = constituent_target_base.get_target_weight(
        out_constituent.constituent_index,
        &out_spot_market,
        out_oracle.price,
        lp_pool.last_aum, // TODO: remove out_amount * out_oracle to est post remove_liquidity aum
    )?;

    let dlp_total_supply = ctx.accounts.lp_mint.supply;

    let (lp_burn_amount, out_amount, lp_fee_amount, out_fee_amount) = lp_pool
        .get_remove_liquidity_amount(
            now,
            &out_spot_market,
            &out_constituent,
            lp_to_burn,
            &out_oracle,
            out_target_weight,
            dlp_total_supply,
        )?;
    msg!(
        "lp_burn_amount: {}, out_amount: {}, lp_fee_amount: {}, out_fee_amount: {}",
        lp_burn_amount,
        out_amount,
        lp_fee_amount,
        out_fee_amount
    );

    let lp_burn_amount_net_fees = if lp_fee_amount > 0 {
        lp_burn_amount.safe_sub(lp_fee_amount.unsigned_abs() as u64)?
    } else {
        lp_burn_amount.safe_add(lp_fee_amount.unsigned_abs() as u64)?
    };

    let out_amount_net_fees = if out_fee_amount > 0 {
        out_amount.safe_sub(out_fee_amount.unsigned_abs())?
    } else {
        out_amount.safe_add(out_fee_amount.unsigned_abs())?
    };
    let out_amount_net_fees =
        out_amount_net_fees.min(ctx.accounts.constituent_out_token_account.amount as u128);

    validate!(
        out_amount_net_fees >= min_amount_out,
        ErrorCode::SlippageOutsideLimit,
        format!(
            "Slippage outside limit: lp_mint_amount_net_fees({}) < min_mint_amount({})",
            out_amount_net_fees, min_amount_out
        )
        .as_str()
    )?;

    out_constituent.record_swap_fees(out_fee_amount)?;
    lp_pool.record_mint_redeem_fees(lp_fee_amount)?;

    receive(
        &ctx.accounts.token_program,
        &ctx.accounts.user_lp_token_account,
        &ctx.accounts.lp_pool_token_vault,
        &ctx.accounts.authority,
        lp_burn_amount,
        &None,
        Some(remaining_accounts),
    )?;

    burn_tokens(
        &ctx.accounts.token_program,
        &ctx.accounts.lp_pool_token_vault,
        &ctx.accounts.drift_signer,
        state.signer_nonce,
        lp_burn_amount_net_fees,
        &ctx.accounts.lp_mint,
    )?;

    send_from_program_vault(
        &ctx.accounts.token_program,
        &ctx.accounts.constituent_out_token_account,
        &ctx.accounts.user_out_token_account,
        &ctx.accounts.drift_signer,
        state.signer_nonce,
        out_amount_net_fees.cast::<u64>()?,
        &None,
        Some(remaining_accounts),
    )?;

    lp_pool.last_aum = lp_pool.last_aum.safe_sub(
        out_amount_net_fees
            .cast::<u128>()?
            .safe_mul(out_oracle.price.cast::<u128>()?)?
            .safe_div(10_u128.pow(out_spot_market.decimals))?,
    )?;

    ctx.accounts.constituent_out_token_account.reload()?;
    ctx.accounts.lp_mint.reload()?;

    out_constituent.sync_token_balance(ctx.accounts.constituent_out_token_account.amount);

    let dlp_total_supply = ctx.accounts.lp_mint.supply;
    let lp_price = if dlp_total_supply > 0 {
        lp_pool
            .last_aum
            .safe_mul(PRICE_PRECISION)?
            .safe_div(dlp_total_supply as u128)?
    } else {
        0
    };

    let mint_redeem_id = get_then_update_id!(lp_pool, next_mint_redeem_id);
    emit_stack::<_, { LPMintRedeemRecord::SIZE }>(LPMintRedeemRecord {
        ts: now,
        slot,
        authority: ctx.accounts.authority.key(),
        description: 0,
        amount: out_amount,
        fee: out_fee_amount,
        spot_market_index: out_market_index,
        constituent_index: out_constituent.constituent_index,
        oracle_price: out_oracle.price,
        mint: out_constituent.mint,
        lp_amount: lp_burn_amount,
        lp_fee: lp_fee_amount,
        lp_price,
        mint_redeem_id,
        last_aum: lp_pool.last_aum,
        last_aum_slot: lp_pool.last_aum_slot,
        in_market_current_weight: out_constituent.get_weight(
            out_oracle.price,
            &out_spot_market,
            0,
            lp_pool.last_aum,
        )?,
        in_market_target_weight: out_target_weight,
    })?;

    Ok(())
}

#[access_control(
    fill_not_paused(&ctx.accounts.state)
)]
pub fn handle_view_lp_pool_remove_liquidity_fees<'c: 'info, 'info>(
    ctx: Context<'_, '_, 'c, 'info, ViewLPPoolRemoveLiquidityFees<'info>>,
    out_market_index: u16,
    lp_to_burn: u64,
) -> Result<()> {
    let slot = Clock::get()?.slot;
    let now = Clock::get()?.unix_timestamp;
    let state = &ctx.accounts.state;
    let lp_pool = ctx.accounts.lp_pool.load_mut()?;

    if slot.saturating_sub(lp_pool.last_aum_slot) > LP_POOL_SWAP_AUM_UPDATE_DELAY {
        msg!(
            "Must update LP pool AUM before swap, last_aum_slot: {}, current slot: {}",
            lp_pool.last_aum_slot,
            slot
        );
        return Err(ErrorCode::LpPoolAumDelayed.into());
    }

    let out_constituent = ctx.accounts.out_constituent.load_mut()?;

    let constituent_target_base = ctx.accounts.constituent_target_base.load_zc()?;

    let remaining_accounts = &mut ctx.remaining_accounts.iter().peekable();

    let AccountMaps {
        perp_market_map: _,
        spot_market_map,
        mut oracle_map,
    } = load_maps(
        remaining_accounts,
        &MarketSet::new(),
        &get_writable_spot_market_set_from_many(vec![out_market_index]),
        slot,
        Some(state.oracle_guard_rails),
    )?;

    let out_spot_market = spot_market_map.get_ref_mut(&out_market_index)?;

    let out_oracle_id = out_spot_market.oracle_id();

    let (out_oracle, out_oracle_validity) = oracle_map.get_price_data_and_validity(
        MarketType::Spot,
        out_spot_market.market_index,
        &out_oracle_id,
        out_spot_market
            .historical_oracle_data
            .last_oracle_price_twap,
        out_spot_market.get_max_confidence_interval_multiplier()?,
        0,
    )?;
    let out_oracle = out_oracle.clone();

    // TODO: check self.aum validity

    if !is_oracle_valid_for_action(out_oracle_validity, Some(DriftAction::LpPoolSwap))? {
        msg!(
            "Out oracle data for spot market {} is invalid for lp pool swap.",
            out_spot_market.market_index,
        );
        return Err(ErrorCode::InvalidOracle.into());
    }

    let out_target_weight = constituent_target_base.get_target_weight(
        out_constituent.constituent_index,
        &out_spot_market,
        out_oracle.price,
        lp_pool.last_aum, // TODO: remove out_amount * out_oracle to est post remove_liquidity aum
    )?;

    let dlp_total_supply = ctx.accounts.lp_mint.supply;

    let (lp_burn_amount, out_amount, lp_fee_amount, out_fee_amount) = lp_pool
        .get_remove_liquidity_amount(
            now,
            &out_spot_market,
            &out_constituent,
            lp_to_burn,
            &out_oracle,
            out_target_weight,
            dlp_total_supply,
        )?;
    msg!(
        "lp_burn_amount: {}, out_amount: {}, lp_fee_amount: {}, out_fee_amount: {}",
        lp_burn_amount,
        out_amount,
        lp_fee_amount,
        out_fee_amount
    );

    Ok(())
}

pub fn handle_update_constituent_oracle_info<'c: 'info, 'info>(
    ctx: Context<'_, '_, 'c, 'info, UpdateConstituentOracleInfo<'info>>,
) -> Result<()> {
    let clock = Clock::get()?;
    let mut constituent = ctx.accounts.constituent.load_mut()?;
    let spot_market = ctx.accounts.spot_market.load()?;

    let oracle_id = spot_market.oracle_id();
    let mut oracle_map = OracleMap::load_one(
        &ctx.accounts.oracle,
        clock.slot,
        Some(ctx.accounts.state.oracle_guard_rails),
    )?;

    let oracle_data = oracle_map.get_price_data(&oracle_id)?;
    let oracle_data_slot = clock.slot - oracle_data.delay.max(0i64).cast::<u64>()?;
    if constituent.last_oracle_slot < oracle_data_slot {
        constituent.last_oracle_price = oracle_data.price;
        constituent.last_oracle_slot = oracle_data_slot;
    }

    Ok(())
}

pub fn handle_deposit_to_program_vault<'c: 'info, 'info>(
    ctx: Context<'_, '_, 'c, 'info, DepositWithdrawProgramVault<'info>>,
    amount: u64,
) -> Result<()> {
    let clock = Clock::get()?;

    let mut spot_market = ctx.accounts.spot_market.load_mut()?;
    let mut constituent = ctx.accounts.constituent.load_mut()?;
    let spot_market_vault = &ctx.accounts.spot_market_vault;
    let oracle_id = spot_market.oracle_id();
    let mut oracle_map = OracleMap::load_one(
        &ctx.accounts.oracle,
        clock.slot,
        Some(ctx.accounts.state.oracle_guard_rails),
    )?;
    let remaining_accounts = &mut ctx.remaining_accounts.iter().peekable();

    constituent.sync_token_balance(ctx.accounts.constituent_token_account.amount);
    let balance_before = constituent.get_full_balance(&spot_market)?;

    if amount == 0 {
        return Err(ErrorCode::InsufficientDeposit.into());
    }

    let deposit_plus_token_amount_before = amount.safe_add(spot_market_vault.amount)?;

    let oracle_data = oracle_map.get_price_data(&oracle_id)?;
    let oracle_data_slot = clock.slot - oracle_data.delay.max(0i64).cast::<u64>()?;
    if constituent.last_oracle_slot < oracle_data_slot {
        constituent.last_oracle_price = oracle_data.price;
        constituent.last_oracle_slot = oracle_data_slot;
    }

    controller::spot_balance::update_spot_market_cumulative_interest(
        &mut spot_market,
        Some(&oracle_data),
        clock.unix_timestamp,
    )?;

    controller::token::send_from_program_vault(
        &ctx.accounts.token_program,
        &ctx.accounts.constituent_token_account,
        &spot_market_vault,
        &ctx.accounts.drift_signer,
        ctx.accounts.state.signer_nonce,
        amount,
        &Some(*ctx.accounts.mint.clone()),
        Some(remaining_accounts),
    )?;

    // Adjust BLPosition for the new deposits
    let spot_position = &mut constituent.spot_balance;
    update_spot_balances(
        amount as u128,
        &SpotBalanceType::Deposit,
        &mut spot_market,
        spot_position,
        false,
    )?;

    safe_increment!(spot_position.cumulative_deposits, amount.cast()?);

    ctx.accounts.spot_market_vault.reload()?;
    ctx.accounts.constituent_token_account.reload()?;
    constituent.sync_token_balance(ctx.accounts.constituent_token_account.amount);
    spot_market.validate_max_token_deposits_and_borrows(false)?;

    validate!(
        ctx.accounts.spot_market_vault.amount == deposit_plus_token_amount_before,
        ErrorCode::LpInvariantFailed,
        "Spot market vault amount mismatch after deposit"
    )?;

    validate!(
        constituent
            .get_full_balance(&spot_market)?
            .abs_diff(balance_before)
            <= 1,
        ErrorCode::LpInvariantFailed,
        "Constituent balance mismatch after desposit to program vault"
    )?;

    Ok(())
}

pub fn handle_withdraw_from_program_vault<'c: 'info, 'info>(
    ctx: Context<'_, '_, 'c, 'info, DepositWithdrawProgramVault<'info>>,
    amount: u64,
) -> Result<()> {
    let state = &ctx.accounts.state;
    let clock = Clock::get()?;

    let mut spot_market = ctx.accounts.spot_market.load_mut()?;
    let mut constituent = ctx.accounts.constituent.load_mut()?;
    let spot_market_vault = &ctx.accounts.spot_market_vault;
    let oracle_id = spot_market.oracle_id();
    let mut oracle_map = OracleMap::load_one(
        &ctx.accounts.oracle,
        clock.slot,
        Some(ctx.accounts.state.oracle_guard_rails),
    )?;
    let remaining_accounts = &mut ctx.remaining_accounts.iter().peekable();

    constituent.sync_token_balance(ctx.accounts.constituent_token_account.amount);

    let balance_before = constituent.get_full_balance(&spot_market)?;

    if amount == 0 {
        return Err(ErrorCode::InsufficientDeposit.into());
    }

    let oracle_data = oracle_map.get_price_data(&oracle_id)?;
    let oracle_data_slot = clock.slot - oracle_data.delay.max(0i64).cast::<u64>()?;
    if constituent.last_oracle_slot < oracle_data_slot {
        constituent.last_oracle_price = oracle_data.price;
        constituent.last_oracle_slot = oracle_data_slot;
    }

    controller::spot_balance::update_spot_market_cumulative_interest(
        &mut spot_market,
        Some(&oracle_data),
        clock.unix_timestamp,
    )?;

    // Can only borrow up to the max
    let token_amount = constituent.spot_balance.get_token_amount(&spot_market)?;
    let amount_to_transfer = if constituent.spot_balance.balance_type == SpotBalanceType::Borrow {
        amount.min(
            constituent
                .max_borrow_token_amount
                .safe_sub(token_amount as u64)?,
        )
    } else {
        amount.min(
            constituent
                .max_borrow_token_amount
                .safe_add(token_amount as u64)?,
        )
    };

    controller::token::send_from_program_vault(
        &ctx.accounts.token_program,
        &spot_market_vault,
        &ctx.accounts.constituent_token_account,
        &ctx.accounts.drift_signer,
        state.signer_nonce,
        amount_to_transfer,
        &Some(*ctx.accounts.mint.clone()),
        Some(remaining_accounts),
    )?;
    ctx.accounts.constituent_token_account.reload()?;
    constituent.sync_token_balance(ctx.accounts.constituent_token_account.amount);

    // Adjust BLPosition for the new deposits
    let spot_position = &mut constituent.spot_balance;
    update_spot_balances(
        amount_to_transfer as u128,
        &SpotBalanceType::Borrow,
        &mut spot_market,
        spot_position,
        true,
    )?;

    safe_decrement!(
        spot_position.cumulative_deposits,
        amount_to_transfer.cast()?
    );

    ctx.accounts.spot_market_vault.reload()?;
    spot_market.validate_max_token_deposits_and_borrows(true)?;

    math::spot_withdraw::validate_spot_market_vault_amount(
        &spot_market,
        ctx.accounts.spot_market_vault.amount,
    )?;

    validate!(
        constituent
            .get_full_balance(&spot_market)?
            .abs_diff(balance_before)
            <= 1,
        ErrorCode::LpInvariantFailed,
        "Constituent balance mismatch after withdraw from program vault"
    )?;

    Ok(())
}

#[derive(Accounts)]
pub struct DepositWithdrawProgramVault<'info> {
    pub state: Box<Account<'info, State>>,
    #[account(
        mut,
        constraint = admin.key() == admin_hot_wallet::id() || admin.key() == state.admin
    )]
    pub admin: Signer<'info>,
    /// CHECK: program signer
    pub drift_signer: AccountInfo<'info>,
    #[account(mut)]
    pub constituent: AccountLoader<'info, Constituent>,
    #[account(
        mut,
        address = constituent.load()?.token_vault,
        constraint = &constituent.load()?.mint.eq(&constituent_token_account.mint),
        token::authority = drift_signer
    )]
    pub constituent_token_account: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(
        mut,
        owner = crate::ID,
        constraint = spot_market.load()?.market_index == constituent.load()?.spot_market_index
    )]
    pub spot_market: AccountLoader<'info, SpotMarket>,
    #[account(
        mut,
        address = spot_market.load()?.vault,
        token::authority = drift_signer,
    )]
    pub spot_market_vault: Box<InterfaceAccount<'info, TokenAccount>>,
    pub token_program: Interface<'info, TokenInterface>,
    #[account(
        address = spot_market.load()?.mint,
    )]
    pub mint: Box<InterfaceAccount<'info, Mint>>,
    /// CHECK: checked when loading oracle in oracle map
    pub oracle: AccountInfo<'info>,
}

#[derive(Accounts)]
pub struct UpdateConstituentOracleInfo<'info> {
    pub state: Box<Account<'info, State>>,
    #[account(mut)]
    pub keeper: Signer<'info>,
    #[account(mut)]
    pub constituent: AccountLoader<'info, Constituent>,
    #[account(
        owner = crate::ID,
        constraint = spot_market.load()?.market_index == constituent.load()?.spot_market_index
    )]
    pub spot_market: AccountLoader<'info, SpotMarket>,
    /// CHECK: checked when loading oracle in oracle map
    pub oracle: AccountInfo<'info>,
}

#[derive(Accounts)]
pub struct UpdateConstituentTargetBase<'info> {
    pub state: Box<Account<'info, State>>,
    #[account(mut)]
    pub keeper: Signer<'info>,
    /// CHECK: checked in AmmConstituentMappingZeroCopy checks
    pub amm_constituent_mapping: AccountInfo<'info>,
    /// CHECK: checked in ConstituentTargetBaseZeroCopy checks
    #[account(mut)]
    pub constituent_target_base: AccountInfo<'info>,
    /// CHECK: checked in AmmCacheZeroCopy checks
    pub amm_cache: AccountInfo<'info>,
    pub lp_pool: AccountLoader<'info, LPPool>,
}

#[derive(Accounts)]
pub struct UpdateLPPoolAum<'info> {
    pub state: Box<Account<'info, State>>,
    #[account(mut)]
    pub keeper: Signer<'info>,
    #[account(mut)]
    pub lp_pool: AccountLoader<'info, LPPool>,
    /// CHECK: checked in ConstituentTargetBaseZeroCopy checks
    #[account(mut)]
    pub constituent_target_base: AccountInfo<'info>,
    /// CHECK: checked in AmmCacheZeroCopy checks
    #[account(mut)]
    pub amm_cache: AccountInfo<'info>,
}

/// `in`/`out` is in the program's POV for this swap. So `user_in_token_account` is the user owned token account
/// for the `in` token for this swap.
#[derive(Accounts)]
#[instruction(
    in_market_index: u16,
    out_market_index: u16,
)]
pub struct LPPoolSwap<'info> {
    /// CHECK: forced drift_signer
    pub drift_signer: AccountInfo<'info>,
    pub state: Box<Account<'info, State>>,
    pub lp_pool: AccountLoader<'info, LPPool>,

    /// CHECK: checked in ConstituentTargetBaseZeroCopy checks and in ix
    pub constituent_target_base: AccountInfo<'info>,

    /// CHECK: checked in ConstituentCorrelationsZeroCopy checks and in ix
    pub constituent_correlations: AccountInfo<'info>,

    #[account(
        mut,
        address = in_constituent.load()?.token_vault,
    )]
    pub constituent_in_token_account: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(
        mut,
        address = out_constituent.load()?.token_vault,
    )]
    pub constituent_out_token_account: Box<InterfaceAccount<'info, TokenAccount>>,

    #[account(
        mut,
        constraint = user_in_token_account.mint.eq(&constituent_in_token_account.mint)
    )]
    pub user_in_token_account: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(
        mut,
        constraint = user_out_token_account.mint.eq(&constituent_out_token_account.mint)
    )]
    pub user_out_token_account: Box<InterfaceAccount<'info, TokenAccount>>,

    #[account(
        mut,
        seeds = [CONSTITUENT_PDA_SEED.as_ref(), lp_pool.key().as_ref(), in_market_index.to_le_bytes().as_ref()],
        bump=in_constituent.load()?.bump,
        constraint = in_constituent.load()?.mint.eq(&constituent_in_token_account.mint)
    )]
    pub in_constituent: AccountLoader<'info, Constituent>,
    #[account(
        mut,
        seeds = [CONSTITUENT_PDA_SEED.as_ref(), lp_pool.key().as_ref(), out_market_index.to_le_bytes().as_ref()],
        bump=out_constituent.load()?.bump,
        constraint = out_constituent.load()?.mint.eq(&constituent_out_token_account.mint)
    )]
    pub out_constituent: AccountLoader<'info, Constituent>,

    #[account(
        constraint = in_market_mint.key() == in_constituent.load()?.mint,
    )]
    pub in_market_mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(
        constraint = out_market_mint.key() == out_constituent.load()?.mint,
    )]
    pub out_market_mint: Box<InterfaceAccount<'info, Mint>>,

    pub authority: Signer<'info>,

    // TODO: in/out token program
    pub token_program: Interface<'info, TokenInterface>,
}

#[derive(Accounts)]
#[instruction(
    in_market_index: u16,
    out_market_index: u16,
)]
pub struct ViewLPPoolSwapFees<'info> {
    /// CHECK: forced drift_signer
    pub drift_signer: AccountInfo<'info>,
    pub state: Box<Account<'info, State>>,
    pub lp_pool: AccountLoader<'info, LPPool>,

    /// CHECK: checked in ConstituentTargetBaseZeroCopy checks and in ix
    pub constituent_target_base: AccountInfo<'info>,

    /// CHECK: checked in ConstituentCorrelationsZeroCopy checks and in ix
    pub constituent_correlations: AccountInfo<'info>,

    #[account(
        mut,
        address = in_constituent.load()?.token_vault,
    )]
    pub constituent_in_token_account: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(
        mut,
        address = out_constituent.load()?.token_vault,
    )]
    pub constituent_out_token_account: Box<InterfaceAccount<'info, TokenAccount>>,

    #[account(
        mut,
        seeds = [CONSTITUENT_PDA_SEED.as_ref(), lp_pool.key().as_ref(), in_market_index.to_le_bytes().as_ref()],
        bump=in_constituent.load()?.bump,
        constraint = in_constituent.load()?.mint.eq(&constituent_in_token_account.mint)
    )]
    pub in_constituent: AccountLoader<'info, Constituent>,
    #[account(
        mut,
        seeds = [CONSTITUENT_PDA_SEED.as_ref(), lp_pool.key().as_ref(), out_market_index.to_le_bytes().as_ref()],
        bump=out_constituent.load()?.bump,
        constraint = out_constituent.load()?.mint.eq(&constituent_out_token_account.mint)
    )]
    pub out_constituent: AccountLoader<'info, Constituent>,

    pub authority: Signer<'info>,

    // TODO: in/out token program
    pub token_program: Interface<'info, TokenInterface>,
}

#[derive(Accounts)]
#[instruction(
    in_market_index: u16,
)]
pub struct LPPoolAddLiquidity<'info> {
    /// CHECK: forced drift_signer
    pub drift_signer: AccountInfo<'info>,
    pub state: Box<Account<'info, State>>,
    #[account(mut)]
    pub lp_pool: AccountLoader<'info, LPPool>,
    pub authority: Signer<'info>,
    pub in_market_mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(
        mut,
        seeds = [CONSTITUENT_PDA_SEED.as_ref(), lp_pool.key().as_ref(), in_market_index.to_le_bytes().as_ref()],
        bump,
        constraint =
            in_constituent.load()?.mint.eq(&constituent_in_token_account.mint)
    )]
    pub in_constituent: AccountLoader<'info, Constituent>,

    #[account(
        mut,
        constraint = user_in_token_account.mint.eq(&constituent_in_token_account.mint)
    )]
    pub user_in_token_account: Box<InterfaceAccount<'info, TokenAccount>>,

    #[account(
        mut,
        seeds = ["CONSTITUENT_VAULT".as_ref(), lp_pool.key().as_ref(), in_market_index.to_le_bytes().as_ref()],
        bump,
    )]
    pub constituent_in_token_account: Box<InterfaceAccount<'info, TokenAccount>>,

    #[account(
        mut,
        constraint = user_lp_token_account.mint.eq(&lp_mint.key())
    )]
    pub user_lp_token_account: Box<InterfaceAccount<'info, TokenAccount>>,

    #[account(
        mut,
        constraint = lp_mint.key() == lp_pool.load()?.mint,
    )]
    pub lp_mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(
        seeds = [CONSTITUENT_TARGET_BASE_PDA_SEED.as_ref(), lp_pool.key().as_ref()],
        bump,
    )]
    /// CHECK: checked in ConstituentTargetBaseZeroCopy checks
    pub constituent_target_base: AccountInfo<'info>,

    #[account(
        mut,
        seeds = [LP_POOL_TOKEN_VAULT_PDA_SEED.as_ref(), lp_pool.key().as_ref()],
        bump,
    )]
    pub lp_pool_token_vault: Box<InterfaceAccount<'info, TokenAccount>>,

    pub token_program: Interface<'info, TokenInterface>,
}

#[derive(Accounts)]
#[instruction(
    in_market_index: u16,
)]
pub struct ViewLPPoolAddLiquidityFees<'info> {
    /// CHECK: forced drift_signer
    pub drift_signer: AccountInfo<'info>,
    pub state: Box<Account<'info, State>>,
    pub lp_pool: AccountLoader<'info, LPPool>,
    pub authority: Signer<'info>,
    pub in_market_mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(
        seeds = [CONSTITUENT_PDA_SEED.as_ref(), lp_pool.key().as_ref(), in_market_index.to_le_bytes().as_ref()],
        bump,
    )]
    pub in_constituent: AccountLoader<'info, Constituent>,

    #[account(
        constraint = lp_mint.key() == lp_pool.load()?.mint,
    )]
    pub lp_mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(
        seeds = [CONSTITUENT_TARGET_BASE_PDA_SEED.as_ref(), lp_pool.key().as_ref()],
        bump,
    )]
    /// CHECK: checked in ConstituentTargetBaseZeroCopy checks
    pub constituent_target_base: AccountInfo<'info>,
}

#[derive(Accounts)]
#[instruction(
    in_market_index: u16,
)]
pub struct LPPoolRemoveLiquidity<'info> {
    /// CHECK: forced drift_signer
    pub drift_signer: AccountInfo<'info>,
    pub state: Box<Account<'info, State>>,
    #[account(mut)]
    pub lp_pool: AccountLoader<'info, LPPool>,
    pub authority: Signer<'info>,
    pub out_market_mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(
        mut,
        seeds = [CONSTITUENT_PDA_SEED.as_ref(), lp_pool.key().as_ref(), in_market_index.to_le_bytes().as_ref()],
        bump,
        constraint =
            out_constituent.load()?.mint.eq(&constituent_out_token_account.mint)
    )]
    pub out_constituent: AccountLoader<'info, Constituent>,

    #[account(
        mut,
        constraint = user_out_token_account.mint.eq(&constituent_out_token_account.mint)
    )]
    pub user_out_token_account: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(
        mut,
        seeds = ["CONSTITUENT_VAULT".as_ref(), lp_pool.key().as_ref(), in_market_index.to_le_bytes().as_ref()],
        bump,
    )]
    pub constituent_out_token_account: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(
        mut,
        constraint = user_lp_token_account.mint.eq(&lp_mint.key())
    )]
    pub user_lp_token_account: Box<InterfaceAccount<'info, TokenAccount>>,

    #[account(
        mut,
        constraint = lp_mint.key() == lp_pool.load()?.mint,
    )]
    pub lp_mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(
        seeds = [CONSTITUENT_TARGET_BASE_PDA_SEED.as_ref(), lp_pool.key().as_ref()],
        bump,
    )]
    /// CHECK: checked in ConstituentTargetBaseZeroCopy checks
    pub constituent_target_base: AccountInfo<'info>,

    #[account(
        mut,
        seeds = [LP_POOL_TOKEN_VAULT_PDA_SEED.as_ref(), lp_pool.key().as_ref()],
        bump,
    )]
    pub lp_pool_token_vault: Box<InterfaceAccount<'info, TokenAccount>>,

    pub token_program: Interface<'info, TokenInterface>,
}

#[derive(Accounts)]
#[instruction(
    in_market_index: u16,
)]
pub struct ViewLPPoolRemoveLiquidityFees<'info> {
    /// CHECK: forced drift_signer
    pub drift_signer: AccountInfo<'info>,
    pub state: Box<Account<'info, State>>,
    pub lp_pool: AccountLoader<'info, LPPool>,
    pub authority: Signer<'info>,
    pub out_market_mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(
        seeds = [CONSTITUENT_PDA_SEED.as_ref(), lp_pool.key().as_ref(), in_market_index.to_le_bytes().as_ref()],
        bump,
    )]
    pub out_constituent: AccountLoader<'info, Constituent>,

    #[account(
        constraint = lp_mint.key() == lp_pool.load()?.mint,
    )]
    pub lp_mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(
        seeds = [CONSTITUENT_TARGET_BASE_PDA_SEED.as_ref(), lp_pool.key().as_ref()],
        bump,
    )]
    /// CHECK: checked in ConstituentTargetBaseZeroCopy checks
    pub constituent_target_base: AccountInfo<'info>,
}
