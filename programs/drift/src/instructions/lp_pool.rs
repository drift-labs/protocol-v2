use anchor_lang::{prelude::*, Accounts, Key, Result};
use anchor_spl::token_interface::{Mint, TokenAccount, TokenInterface};

use crate::ids::lp_pool_swap_wallet;
use crate::math::constants::PRICE_PRECISION_I64;
use crate::state::events::{DepositDirection, LPBorrowLendDepositRecord};
use crate::state::paused_operations::ConstituentLpOperation;
use crate::validation::whitelist::validate_whitelist_token;
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
        constants::PERCENTAGE_PRECISION_I64,
        oracle::{is_oracle_valid_for_action, DriftAction},
        safe_math::SafeMath,
    },
    math_error, msg, safe_decrement, safe_increment,
    state::{
        amm_cache::{AmmCacheFixed, CacheInfo, AMM_POSITIONS_CACHE},
        constituent_map::{ConstituentMap, ConstituentSet},
        events::{emit_stack, LPMintRedeemRecord, LPSwapRecord},
        lp_pool::{
            update_constituent_target_base_for_derivatives, AmmConstituentDatum,
            AmmConstituentMappingFixed, Constituent, ConstituentCorrelationsFixed,
            ConstituentTargetBaseFixed, LPPool, TargetsDatum, LP_POOL_SWAP_AUM_UPDATE_DELAY,
        },
        oracle_map::OracleMap,
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
use std::iter::Peekable;
use std::slice::Iter;

use solana_program::sysvar::clock::Clock;

use super::optional_accounts::{get_whitelist_token, load_maps, AccountMaps};
use crate::controller::spot_balance::update_spot_market_cumulative_interest;
use crate::controller::token::{receive, send_from_program_vault_with_signature_seeds};
use crate::instructions::constraints::*;
use crate::state::lp_pool::{
    AmmInventoryAndPricesAndSlots, ConstituentIndexAndDecimalAndPrice, CONSTITUENT_PDA_SEED,
    LP_POOL_TOKEN_VAULT_PDA_SEED,
};

pub fn handle_update_constituent_target_base<'c: 'info, 'info>(
    ctx: Context<'_, '_, 'c, 'info, UpdateConstituentTargetBase<'info>>,
) -> Result<()> {
    let slot = Clock::get()?.slot;

    let lp_pool_key: &Pubkey = &ctx.accounts.lp_pool.key();
    let lp_pool = ctx.accounts.lp_pool.load()?;
    let constituent_target_base_key: &Pubkey = &ctx.accounts.constituent_target_base.key();

    let amm_cache: AccountZeroCopy<'_, CacheInfo, AmmCacheFixed> =
        ctx.accounts.amm_cache.load_zc()?;

    let mut constituent_target_base: AccountZeroCopyMut<
        '_,
        TargetsDatum,
        ConstituentTargetBaseFixed,
    > = ctx.accounts.constituent_target_base.load_zc_mut()?;
    validate!(
        constituent_target_base.fixed.lp_pool.eq(lp_pool_key)
            && constituent_target_base_key.eq(&lp_pool.constituent_target_base),
        ErrorCode::InvalidPDA,
        "Constituent target base lp pool pubkey does not match lp pool pubkey",
    )?;

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

    let mut amm_inventories: Vec<AmmInventoryAndPricesAndSlots> =
        Vec::with_capacity(amm_cache.len() as usize);
    for (_, cache_info) in amm_cache.iter().enumerate() {
        if cache_info.lp_status_for_perp_market == 0 {
            continue;
        }

        amm_inventories.push(AmmInventoryAndPricesAndSlots {
            inventory: {
                let scaled_position = cache_info
                    .position
                    .safe_mul(cache_info.amm_position_scalar as i64)?
                    .safe_div(100)?;

                scaled_position.clamp(
                    -cache_info.amm_inventory_limit,
                    cache_info.amm_inventory_limit,
                )
            },
            price: cache_info.oracle_price,
            last_oracle_slot: cache_info.oracle_slot,
            last_position_slot: cache_info.slot,
        });
    }
    msg!("amm inventories: {:?}", amm_inventories);

    if amm_inventories.is_empty() {
        msg!("No valid inventories found for constituent target weights update");
        return Ok(());
    }

    let mut constituent_indexes_and_decimals_and_prices: Vec<ConstituentIndexAndDecimalAndPrice> =
        Vec::with_capacity(constituent_map.0.len());
    for (index, loader) in &constituent_map.0 {
        let constituent_ref = loader.load()?;
        constituent_indexes_and_decimals_and_prices.push(ConstituentIndexAndDecimalAndPrice {
            constituent_index: *index,
            decimals: constituent_ref.decimals,
            price: constituent_ref.last_oracle_price,
        });
    }

    constituent_target_base.update_target_base(
        &amm_constituent_mapping,
        amm_inventories.as_slice(),
        constituent_indexes_and_decimals_and_prices.as_mut_slice(),
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

    let constituent_map =
        ConstituentMap::load(&ConstituentSet::new(), &lp_pool.pubkey, remaining_accounts)?;

    validate!(
        constituent_map.0.len() == lp_pool.constituents as usize,
        ErrorCode::WrongNumberOfConstituents,
        "Constituent map length does not match lp pool constituent count"
    )?;

    let constituent_target_base_key = &ctx.accounts.constituent_target_base.key();
    let mut constituent_target_base: AccountZeroCopyMut<
        '_,
        TargetsDatum,
        ConstituentTargetBaseFixed,
    > = ctx.accounts.constituent_target_base.load_zc_mut()?;
    validate!(
        constituent_target_base.fixed.lp_pool.eq(&lp_pool.pubkey)
            && constituent_target_base_key.eq(&lp_pool.constituent_target_base),
        ErrorCode::InvalidPDA,
        "Constituent target base lp pool pubkey does not match lp pool pubkey",
    )?;

    let amm_cache: AccountZeroCopyMut<'_, CacheInfo, AmmCacheFixed> =
        ctx.accounts.amm_cache.load_zc_mut()?;

    let (aum, crypto_delta, derivative_groups) = lp_pool.update_aum(
        slot,
        &constituent_map,
        &spot_market_map,
        &mut oracle_map,
        &constituent_target_base,
        &amm_cache,
    )?;

    // Set USDC stable weight
    msg!("aum: {}", aum);
    let total_stable_target_base = aum.cast::<i128>()?.safe_sub(crypto_delta)?;
    constituent_target_base
        .get_mut(lp_pool.quote_consituent_index as u32)
        .target_base = total_stable_target_base.cast::<i64>()?;

    msg!(
        "stable target base: {}",
        constituent_target_base
            .get(lp_pool.quote_consituent_index as u32)
            .target_base
    );
    msg!("aum: {}, crypto_delta: {}", aum, crypto_delta);
    msg!("derivative groups: {:?}", derivative_groups);

    update_constituent_target_base_for_derivatives(
        aum,
        &derivative_groups,
        &constituent_map,
        &spot_market_map,
        &mut oracle_map,
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
    let state = &ctx.accounts.state;
    validate!(
        state.allow_swap_lp_pool(),
        ErrorCode::DefaultError,
        "Swapping with LP Pool is disabled"
    )?;

    validate!(
        in_market_index != out_market_index,
        ErrorCode::InvalidSpotMarketAccount,
        "In and out spot market indices cannot be the same"
    )?;

    let slot = Clock::get()?.slot;
    let now = Clock::get()?.unix_timestamp;
    let lp_pool_key = ctx.accounts.lp_pool.key();
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

    in_constituent.does_constituent_allow_operation(ConstituentLpOperation::Swap)?;
    out_constituent.does_constituent_allow_operation(ConstituentLpOperation::Swap)?;

    let constituent_target_base_key = &ctx.accounts.constituent_target_base.key();
    let constituent_target_base: AccountZeroCopy<'_, TargetsDatum, ConstituentTargetBaseFixed> =
        ctx.accounts.constituent_target_base.load_zc()?;
    validate!(
        constituent_target_base.fixed.lp_pool.eq(&lp_pool_key)
            && constituent_target_base_key.eq(&lp_pool.constituent_target_base),
        ErrorCode::InvalidPDA,
        "Constituent target base lp pool pubkey does not match lp pool pubkey",
    )?;

    let constituent_correlations_key = &ctx.accounts.constituent_correlations.key();
    let constituent_correlations: AccountZeroCopy<'_, i64, ConstituentCorrelationsFixed> =
        ctx.accounts.constituent_correlations.load_zc()?;
    validate!(
        constituent_correlations.fixed.lp_pool.eq(&lp_pool_key)
            && constituent_correlations_key.eq(&lp_pool.constituent_correlations),
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

    if in_constituent.is_reduce_only()?
        && !in_constituent.is_operation_reducing(&in_spot_market, true)?
    {
        msg!("In constituent in reduce only mode");
        return Err(ErrorCode::InvalidConstituentOperation.into());
    }

    if out_constituent.is_reduce_only()?
        && !out_constituent.is_operation_reducing(&out_spot_market, false)?
    {
        msg!("Out constituent in reduce only mode");
        return Err(ErrorCode::InvalidConstituentOperation.into());
    }

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
    let in_target_datum = constituent_target_base.get(in_constituent.constituent_index as u32);
    let in_target_position_slot_delay = slot.saturating_sub(in_target_datum.last_position_slot);
    let in_target_oracle_slot_delay = slot.saturating_sub(in_target_datum.last_oracle_slot);
    let out_target_datum = constituent_target_base.get(out_constituent.constituent_index as u32);
    let out_target_position_slot_delay = slot.saturating_sub(out_target_datum.last_position_slot);
    let out_target_oracle_slot_delay = slot.saturating_sub(out_target_datum.last_oracle_slot);

    let (in_amount, out_amount, in_fee, out_fee) = lp_pool.get_swap_amount(
        in_target_position_slot_delay,
        out_target_position_slot_delay,
        in_target_oracle_slot_delay,
        out_target_oracle_slot_delay,
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
        out_amount_net_fees.cast::<u64>()? <= out_constituent.vault_token_balance,
        ErrorCode::InsufficientConstituentTokenBalance,
        format!(
            "Insufficient out constituent balance: out_amount_net_fees({}) > out_constituent.token_balance({})",
            out_amount_net_fees, out_constituent.vault_token_balance
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
        lp_pool: lp_pool_key,
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

    send_from_program_vault_with_signature_seeds(
        &ctx.accounts.token_program,
        &ctx.accounts.constituent_out_token_account,
        &ctx.accounts.user_out_token_account,
        &ctx.accounts.constituent_out_token_account.to_account_info(),
        &Constituent::get_vault_signer_seeds(
            &out_constituent.lp_pool,
            &out_constituent.spot_market_index,
            &out_constituent.vault_bump,
        ),
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

    let constituent_target_base: AccountZeroCopy<'_, TargetsDatum, ConstituentTargetBaseFixed> =
        ctx.accounts.constituent_target_base.load_zc()?;

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

    let in_target_datum = constituent_target_base.get(in_constituent.constituent_index as u32);
    let in_target_position_slot_delay = slot.saturating_sub(in_target_datum.last_position_slot);
    let in_target_oracle_slot_delay = slot.saturating_sub(in_target_datum.last_oracle_slot);
    let out_target_datum = constituent_target_base.get(out_constituent.constituent_index as u32);
    let out_target_position_slot_delay = slot.saturating_sub(out_target_datum.last_position_slot);
    let out_target_oracle_slot_delay = slot.saturating_sub(out_target_datum.last_oracle_slot);

    let (in_amount, out_amount, in_fee, out_fee) = lp_pool.get_swap_amount(
        in_target_position_slot_delay,
        out_target_position_slot_delay,
        in_target_oracle_slot_delay,
        out_target_oracle_slot_delay,
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
    let state = &ctx.accounts.state;

    validate!(
        state.allow_mint_redeem_lp_pool(),
        ErrorCode::MintRedeemLpPoolDisabled,
        "Mint/redeem LP pool is disabled"
    )?;

    let mut in_constituent = ctx.accounts.in_constituent.load_mut()?;
    in_constituent.does_constituent_allow_operation(ConstituentLpOperation::Deposit)?;

    let slot = Clock::get()?.slot;
    let now = Clock::get()?.unix_timestamp;
    let lp_pool_key = ctx.accounts.lp_pool.key();
    let mut lp_pool = ctx.accounts.lp_pool.load_mut()?;

    lp_pool.sync_token_supply(ctx.accounts.lp_mint.supply);
    let lp_price_before = lp_pool.get_price(lp_pool.token_supply)?;

    if slot.saturating_sub(lp_pool.last_aum_slot) > LP_POOL_SWAP_AUM_UPDATE_DELAY {
        msg!(
            "Must update LP pool AUM before swap, last_aum_slot: {}, current slot: {}",
            lp_pool.last_aum_slot,
            slot
        );
        return Err(ErrorCode::LpPoolAumDelayed.into());
    }

    let remaining_accounts = &mut ctx.remaining_accounts.iter().peekable();

    let constituent_target_base_key = &ctx.accounts.constituent_target_base.key();
    let constituent_target_base: AccountZeroCopy<'_, TargetsDatum, ConstituentTargetBaseFixed> =
        ctx.accounts.constituent_target_base.load_zc()?;
    validate!(
        constituent_target_base.fixed.lp_pool.eq(&lp_pool_key)
            && constituent_target_base_key.eq(&lp_pool.constituent_target_base),
        ErrorCode::InvalidPDA,
        "Constituent target base lp pool pubkey does not match lp pool pubkey",
    )?;

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

    let whitelist_mint = &lp_pool.whitelist_mint;
    if !whitelist_mint.eq(&Pubkey::default()) {
        validate_whitelist_token(
            get_whitelist_token(remaining_accounts)?,
            whitelist_mint,
            &ctx.accounts.authority.key(),
        )?;
    }

    let mut in_spot_market = spot_market_map.get_ref_mut(&in_market_index)?;

    if in_constituent.is_reduce_only()?
        && !in_constituent.is_operation_reducing(&in_spot_market, true)?
    {
        msg!("In constituent in reduce only mode");
        return Err(ErrorCode::InvalidConstituentOperation.into());
    }

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

    let in_target_datum = constituent_target_base.get(in_constituent.constituent_index as u32);
    let in_target_position_slot_delay = slot.saturating_sub(in_target_datum.last_position_slot);
    let in_target_oracle_slot_delay = slot.saturating_sub(in_target_datum.last_oracle_slot);

    let (lp_amount, in_amount, lp_fee_amount, in_fee_amount) = lp_pool
        .get_add_liquidity_mint_amount(
            in_target_position_slot_delay,
            in_target_oracle_slot_delay,
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

    let lp_name = lp_pool.name;
    let lp_bump = lp_pool.bump;

    let lp_vault_signer_seeds = LPPool::get_lp_pool_signer_seeds(&lp_name, &lp_bump);

    drop(lp_pool);

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
        &ctx.accounts.lp_pool.to_account_info(),
        &lp_vault_signer_seeds,
        lp_amount,
        &ctx.accounts.lp_mint,
    )?;

    send_from_program_vault_with_signature_seeds(
        &ctx.accounts.token_program,
        &ctx.accounts.lp_pool_token_vault,
        &ctx.accounts.user_lp_token_account,
        &ctx.accounts.lp_pool.to_account_info(),
        &lp_vault_signer_seeds,
        lp_mint_amount_net_fees,
        &Some((*ctx.accounts.lp_mint).clone()),
        Some(remaining_accounts),
    )?;

    let mut lp_pool = ctx.accounts.lp_pool.load_mut()?;

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
    lp_pool.sync_token_supply(ctx.accounts.lp_mint.supply);

    in_constituent.sync_token_balance(ctx.accounts.constituent_in_token_account.amount);

    ctx.accounts.lp_mint.reload()?;
    let lp_price_after = lp_pool.get_price(lp_pool.token_supply)?;
    let price_diff = (lp_price_after.cast::<i128>()?).safe_sub(lp_price_before.cast::<i128>()?)?;

    if lp_price_before > 0 && price_diff.signum() != 0 && in_fee_amount.signum() != 0 {
        validate!(
            price_diff.signum() == in_fee_amount.signum() || price_diff == 0,
            ErrorCode::LpInvariantFailed,
            "Adding liquidity resulted in price direction != fee sign, price_diff: {}, in_fee_amount: {}",
            price_diff,
            in_fee_amount
        )?;
    }

    let mint_redeem_id = get_then_update_id!(lp_pool, mint_redeem_id);
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
        lp_price: lp_price_after,
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
        lp_pool: lp_pool_key,
    })?;

    Ok(())
}

pub fn handle_view_lp_pool_add_liquidity_fees<'c: 'info, 'info>(
    ctx: Context<'_, '_, 'c, 'info, ViewLPPoolAddLiquidityFees<'info>>,
    in_market_index: u16,
    in_amount: u128,
) -> Result<()> {
    let slot = Clock::get()?.slot;
    let state = &ctx.accounts.state;
    let lp_pool = ctx.accounts.lp_pool.load()?;

    if slot.saturating_sub(lp_pool.last_aum_slot) > LP_POOL_SWAP_AUM_UPDATE_DELAY {
        msg!(
            "Must update LP pool AUM before swap, last_aum_slot: {}, current slot: {}",
            lp_pool.last_aum_slot,
            slot
        );
        return Err(ErrorCode::LpPoolAumDelayed.into());
    }

    let remaining_accounts = &mut ctx.remaining_accounts.iter().peekable();
    let in_constituent = ctx.accounts.in_constituent.load()?;

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

    let in_target_datum = constituent_target_base.get(in_constituent.constituent_index as u32);
    let in_target_position_slot_delay = slot.saturating_sub(in_target_datum.last_position_slot);
    let in_target_oracle_slot_delay = slot.saturating_sub(in_target_datum.last_oracle_slot);

    let (lp_amount, in_amount, lp_fee_amount, in_fee_amount) = lp_pool
        .get_add_liquidity_mint_amount(
            in_target_position_slot_delay,
            in_target_oracle_slot_delay,
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

    validate!(
        state.allow_mint_redeem_lp_pool(),
        ErrorCode::MintRedeemLpPoolDisabled,
        "Mint/redeem LP pool is disabled"
    )?;

    let lp_pool_key = ctx.accounts.lp_pool.key();
    let mut lp_pool = ctx.accounts.lp_pool.load_mut()?;
    lp_pool.sync_token_supply(ctx.accounts.lp_mint.supply);

    let lp_price_before = lp_pool.get_price(lp_pool.token_supply)?;

    let mut out_constituent = ctx.accounts.out_constituent.load_mut()?;
    out_constituent.does_constituent_allow_operation(ConstituentLpOperation::Withdraw)?;

    // Verify previous settle
    let amm_cache: AccountZeroCopy<'_, CacheInfo, _> = ctx.accounts.amm_cache.load_zc()?;
    for (i, _) in amm_cache.iter().enumerate() {
        let cache_info = amm_cache.get(i as u32);
        if cache_info.last_fee_pool_token_amount != 0 && cache_info.last_settle_slot != slot {
            msg!(
                "Market {} has not been settled in current slot. Last slot: {}",
                i,
                cache_info.last_settle_slot
            );
            return Err(ErrorCode::AMMCacheStale.into());
        }
    }

    if slot.saturating_sub(lp_pool.last_aum_slot) > LP_POOL_SWAP_AUM_UPDATE_DELAY {
        msg!(
            "Must update LP pool AUM before swap, last_aum_slot: {}, current slot: {}",
            lp_pool.last_aum_slot,
            slot
        );
        return Err(ErrorCode::LpPoolAumDelayed.into());
    }

    let constituent_target_base_key = &ctx.accounts.constituent_target_base.key();
    let constituent_target_base: AccountZeroCopy<'_, TargetsDatum, ConstituentTargetBaseFixed> =
        ctx.accounts.constituent_target_base.load_zc()?;
    validate!(
        constituent_target_base.fixed.lp_pool.eq(&lp_pool_key)
            && constituent_target_base_key.eq(&lp_pool.constituent_target_base),
        ErrorCode::InvalidPDA,
        "Constituent target base lp pool pubkey does not match lp pool pubkey",
    )?;

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

    if out_constituent.is_reduce_only()?
        && !out_constituent.is_operation_reducing(&out_spot_market, false)?
    {
        msg!("Out constituent in reduce only mode");
        return Err(ErrorCode::InvalidConstituentOperation.into());
    }

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
    let out_oracle = *out_oracle;

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

    let out_target_datum = constituent_target_base.get(out_constituent.constituent_index as u32);
    let out_target_position_slot_delay = slot.saturating_sub(out_target_datum.last_position_slot);
    let out_target_oracle_slot_delay = slot.saturating_sub(out_target_datum.last_oracle_slot);

    let (lp_burn_amount, out_amount, lp_fee_amount, out_fee_amount) = lp_pool
        .get_remove_liquidity_amount(
            out_target_position_slot_delay,
            out_target_oracle_slot_delay,
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

    validate!(
        out_amount_net_fees >= min_amount_out,
        ErrorCode::SlippageOutsideLimit,
        "Slippage outside limit: out_amount_net_fees({}) < min_amount_out({})",
        out_amount_net_fees,
        min_amount_out
    )?;

    if out_amount_net_fees > out_constituent.vault_token_balance.cast()? {
        let transfer_amount = out_amount_net_fees
            .cast::<u64>()?
            .safe_sub(out_constituent.vault_token_balance)?;
        msg!(
            "transfering from program vault to constituent vault: {}",
            transfer_amount
        );
        transfer_from_program_vault(
            transfer_amount,
            &mut out_spot_market,
            &mut out_constituent,
            out_oracle.price,
            &ctx.accounts.state,
            &mut ctx.accounts.spot_market_token_account,
            &mut ctx.accounts.constituent_out_token_account,
            &ctx.accounts.token_program,
            &ctx.accounts.drift_signer,
            &None,
            Some(remaining_accounts),
        )?;
    }

    validate!(
        out_amount_net_fees <= out_constituent.vault_token_balance.cast()?,
        ErrorCode::InsufficientConstituentTokenBalance,
        "Insufficient out constituent balance: out_amount_net_fees({}) > out_constituent.token_balance({})",
        out_amount_net_fees,
        out_constituent.vault_token_balance
    )?;

    out_constituent.record_swap_fees(out_fee_amount)?;
    lp_pool.record_mint_redeem_fees(lp_fee_amount)?;

    let lp_name = lp_pool.name;
    let lp_bump = lp_pool.bump;

    let lp_vault_signer_seeds = LPPool::get_lp_pool_signer_seeds(&lp_name, &lp_bump);

    drop(lp_pool);

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
        &ctx.accounts.lp_pool.to_account_info(),
        &lp_vault_signer_seeds,
        lp_burn_amount_net_fees,
        &ctx.accounts.lp_mint,
    )?;

    send_from_program_vault_with_signature_seeds(
        &ctx.accounts.token_program,
        &ctx.accounts.constituent_out_token_account,
        &ctx.accounts.user_out_token_account,
        &ctx.accounts.constituent_out_token_account.to_account_info(),
        &Constituent::get_vault_signer_seeds(
            &out_constituent.lp_pool,
            &out_constituent.spot_market_index,
            &out_constituent.vault_bump,
        ),
        out_amount_net_fees.cast::<u64>()?,
        &None,
        Some(remaining_accounts),
    )?;

    let mut lp_pool = ctx.accounts.lp_pool.load_mut()?;

    lp_pool.last_aum = lp_pool.last_aum.safe_sub(
        out_amount_net_fees
            .cast::<u128>()?
            .safe_mul(out_oracle.price.cast::<u128>()?)?
            .safe_div(10_u128.pow(out_spot_market.decimals))?,
    )?;

    ctx.accounts.constituent_out_token_account.reload()?;
    ctx.accounts.lp_mint.reload()?;
    lp_pool.sync_token_supply(ctx.accounts.lp_mint.supply);

    out_constituent.sync_token_balance(ctx.accounts.constituent_out_token_account.amount);

    ctx.accounts.lp_mint.reload()?;
    let lp_price_after = lp_pool.get_price(lp_pool.token_supply)?;

    let price_diff = (lp_price_after.cast::<i128>()?).safe_sub(lp_price_before.cast::<i128>()?)?;
    if price_diff.signum() != 0 && out_fee_amount.signum() != 0 {
        validate!(
            price_diff.signum() == out_fee_amount.signum(),
            ErrorCode::LpInvariantFailed,
            "Removing liquidity resulted in price direction != fee sign, price_diff: {}, out_fee_amount: {}",
            price_diff,
            out_fee_amount
        )?;
    }

    let mint_redeem_id = get_then_update_id!(lp_pool, mint_redeem_id);
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
        lp_price: lp_price_after,
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
        lp_pool: lp_pool_key,
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
    let state = &ctx.accounts.state;
    let lp_pool = ctx.accounts.lp_pool.load()?;

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
        lp_pool.last_aum,
    )?;

    let dlp_total_supply = ctx.accounts.lp_mint.supply;

    let out_target_datum = constituent_target_base.get(out_constituent.constituent_index as u32);
    let out_target_position_slot_delay = slot.saturating_sub(out_target_datum.last_position_slot);
    let out_target_oracle_slot_delay = slot.saturating_sub(out_target_datum.last_oracle_slot);

    let (lp_burn_amount, out_amount, lp_fee_amount, out_fee_amount) = lp_pool
        .get_remove_liquidity_amount(
            out_target_position_slot_delay,
            out_target_oracle_slot_delay,
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
    ctx: Context<'_, '_, 'c, 'info, DepositProgramVault<'info>>,
    amount: u64,
) -> Result<()> {
    let clock = Clock::get()?;

    let mut spot_market = ctx.accounts.spot_market.load_mut()?;
    let spot_market_vault = &ctx.accounts.spot_market_vault;
    let oracle_id = spot_market.oracle_id();
    let mut oracle_map = OracleMap::load_one(
        &ctx.accounts.oracle,
        clock.slot,
        Some(ctx.accounts.state.oracle_guard_rails),
    )?;
    let remaining_accounts = &mut ctx.remaining_accounts.iter().peekable();

    let mut constituent = ctx.accounts.constituent.load_mut()?;
    let lp_pool_key = constituent.lp_pool;

    if amount == 0 {
        return Err(ErrorCode::InsufficientDeposit.into());
    }
    let deposit_plus_token_amount_before = amount.safe_add(spot_market_vault.amount)?;

    let oracle_data = oracle_map.get_price_data(&oracle_id)?;

    controller::spot_balance::update_spot_market_cumulative_interest(
        &mut spot_market,
        Some(&oracle_data),
        clock.unix_timestamp,
    )?;
    let token_balance_after_cumulative_interest_update = constituent
        .spot_balance
        .get_signed_token_amount(&spot_market)?;

    let interest_accrued_token_amount = token_balance_after_cumulative_interest_update
        .cast::<i64>()?
        .safe_sub(constituent.last_spot_balance_token_amount)?;

    constituent.sync_token_balance(ctx.accounts.constituent_token_account.amount);
    let balance_before = constituent.get_full_token_amount(&spot_market)?;

    controller::token::send_from_program_vault_with_signature_seeds(
        &ctx.accounts.token_program,
        &ctx.accounts.constituent_token_account,
        &spot_market_vault,
        &ctx.accounts.constituent_token_account.to_account_info(),
        &Constituent::get_vault_signer_seeds(
            &constituent.lp_pool,
            &constituent.spot_market_index,
            &constituent.vault_bump,
        ),
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

    let balance_after = constituent.get_full_token_amount(&spot_market)?;
    let balance_diff_notional = if spot_market.decimals > 6 {
        balance_after
            .abs_diff(balance_before)
            .cast::<i64>()?
            .safe_mul(oracle_data.price)?
            .safe_div(PRICE_PRECISION_I64)?
            .safe_div(10_i64.pow(spot_market.decimals - 6))?
    } else {
        balance_after
            .abs_diff(balance_before)
            .cast::<i64>()?
            .safe_mul(10_i64.pow(6 - spot_market.decimals))?
            .safe_mul(oracle_data.price)?
            .safe_div(PRICE_PRECISION_I64)?
    };

    msg!("Balance difference (notional): {}", balance_diff_notional);

    validate!(
        balance_diff_notional <= PRICE_PRECISION_I64 / 100,
        ErrorCode::LpInvariantFailed,
        "Constituent balance mismatch after withdraw from program vault"
    )?;

    let new_token_balance = constituent
        .spot_balance
        .get_signed_token_amount(&spot_market)?
        .cast::<i64>()?;

    emit!(LPBorrowLendDepositRecord {
        ts: clock.unix_timestamp,
        slot: clock.slot,
        spot_market_index: spot_market.market_index,
        constituent_index: constituent.constituent_index,
        direction: DepositDirection::Deposit,
        token_balance: new_token_balance,
        last_token_balance: constituent.last_spot_balance_token_amount,
        interest_accrued_token_amount,
        amount_deposit_withdraw: amount,
        lp_pool: lp_pool_key,
    });
    constituent.last_spot_balance_token_amount = new_token_balance;
    constituent.cumulative_spot_interest_accrued_token_amount = constituent
        .cumulative_spot_interest_accrued_token_amount
        .safe_add(interest_accrued_token_amount)?;

    Ok(())
}

pub fn handle_withdraw_from_program_vault<'c: 'info, 'info>(
    ctx: Context<'_, '_, 'c, 'info, WithdrawProgramVault<'info>>,
    amount: u64,
) -> Result<()> {
    let state = &ctx.accounts.state;
    let clock = Clock::get()?;

    let mut spot_market = ctx.accounts.spot_market.load_mut()?;

    let oracle_id = spot_market.oracle_id();
    let mut oracle_map = OracleMap::load_one(
        &ctx.accounts.oracle,
        clock.slot,
        Some(ctx.accounts.state.oracle_guard_rails),
    )?;
    let remaining_accounts = &mut ctx.remaining_accounts.iter().peekable();

    let mut constituent = ctx.accounts.constituent.load_mut()?;

    if amount == 0 {
        return Err(ErrorCode::InsufficientDeposit.into());
    }

    let oracle_data = oracle_map.get_price_data(&oracle_id)?;
    let oracle_data_slot = clock.slot - oracle_data.delay.max(0i64).cast::<u64>()?;

    controller::spot_balance::update_spot_market_cumulative_interest(
        &mut spot_market,
        Some(oracle_data),
        clock.unix_timestamp,
    )?;
    let token_balance_after_cumulative_interest_update = constituent
        .spot_balance
        .get_signed_token_amount(&spot_market)?;

    let interest_accrued_token_amount = token_balance_after_cumulative_interest_update
        .cast::<i64>()?
        .safe_sub(constituent.last_spot_balance_token_amount)?;

    let mint = &Some(*ctx.accounts.mint.clone());
    transfer_from_program_vault(
        amount,
        &mut spot_market,
        &mut constituent,
        oracle_data.price,
        &state,
        &mut ctx.accounts.spot_market_vault,
        &mut ctx.accounts.constituent_token_account,
        &ctx.accounts.token_program,
        &ctx.accounts.drift_signer,
        mint,
        Some(remaining_accounts),
    )?;

    let new_token_balance = constituent
        .spot_balance
        .get_signed_token_amount(&spot_market)?
        .cast::<i64>()?;

    emit!(LPBorrowLendDepositRecord {
        ts: clock.unix_timestamp,
        slot: clock.slot,
        spot_market_index: spot_market.market_index,
        constituent_index: constituent.constituent_index,
        direction: DepositDirection::Withdraw,
        token_balance: new_token_balance,
        last_token_balance: constituent.last_spot_balance_token_amount,
        interest_accrued_token_amount,
        amount_deposit_withdraw: amount,
        lp_pool: constituent.lp_pool,
    });
    constituent.last_spot_balance_token_amount = new_token_balance;
    constituent.cumulative_spot_interest_accrued_token_amount = constituent
        .cumulative_spot_interest_accrued_token_amount
        .safe_add(interest_accrued_token_amount)?;

    Ok(())
}

fn transfer_from_program_vault<'info>(
    amount: u64,
    spot_market: &mut SpotMarket,
    constituent: &mut Constituent,
    oracle_price: i64,
    state: &State,
    spot_market_vault: &mut InterfaceAccount<'info, TokenAccount>,
    constituent_token_account: &mut InterfaceAccount<'info, TokenAccount>,
    token_program: &Interface<'info, TokenInterface>,
    drift_signer: &AccountInfo<'info>,
    mint: &Option<InterfaceAccount<'info, Mint>>,
    remaining_accounts: Option<&mut Peekable<Iter<'info, AccountInfo<'info>>>>,
) -> Result<()> {
    constituent.sync_token_balance(constituent_token_account.amount);

    let balance_before = constituent.get_full_token_amount(&spot_market)?;

    // Adding some 5% flexibility to max threshold to prevent race conditions
    let buffer = constituent
        .max_borrow_token_amount
        .safe_mul(5)?
        .safe_div(100)?;
    let max_transfer = constituent
        .max_borrow_token_amount
        .safe_add(buffer)?
        .cast::<i128>()?
        .safe_add(
            constituent
                .spot_balance
                .get_signed_token_amount(spot_market)?,
        )?
        .max(0)
        .cast::<u64>()?;

    validate!(
        max_transfer >= amount,
        ErrorCode::LpInvariantFailed,
        "Max transfer ({}) is less than amount ({})",
        max_transfer,
        amount
    )?;

    // Execute transfer and sync new balance in the constituent account
    controller::token::send_from_program_vault(
        token_program,
        spot_market_vault,
        constituent_token_account,
        drift_signer,
        state.signer_nonce,
        amount,
        mint,
        remaining_accounts,
    )?;
    constituent_token_account.reload()?;
    constituent.sync_token_balance(constituent_token_account.amount);

    // Adjust BLPosition for the new deposits
    let spot_position = &mut constituent.spot_balance;
    update_spot_balances(
        amount as u128,
        &SpotBalanceType::Borrow,
        spot_market,
        spot_position,
        true,
    )?;

    safe_decrement!(spot_position.cumulative_deposits, amount.cast()?);

    // Re-check spot market invariants
    spot_market_vault.reload()?;
    spot_market.validate_max_token_deposits_and_borrows(true)?;
    math::spot_withdraw::validate_spot_market_vault_amount(&spot_market, spot_market_vault.amount)?;

    // Verify withdraw fully accounted for in BLPosition
    let balance_after = constituent.get_full_token_amount(&spot_market)?;

    let balance_diff_notional = if spot_market.decimals > 6 {
        balance_after
            .abs_diff(balance_before)
            .cast::<i64>()?
            .safe_mul(oracle_price)?
            .safe_div(PRICE_PRECISION_I64)?
            .safe_div(10_i64.pow(spot_market.decimals - 6))?
    } else {
        balance_after
            .abs_diff(balance_before)
            .cast::<i64>()?
            .safe_mul(10_i64.pow(6 - spot_market.decimals))?
            .safe_mul(oracle_price)?
            .safe_div(PRICE_PRECISION_I64)?
    };

    #[cfg(feature = "mainnet-beta")]
    validate!(
        balance_diff_notional <= PRICE_PRECISION_I64 / 100,
        ErrorCode::LpInvariantFailed,
        "Constituent balance mismatch after withdraw from program vault, {}",
        balance_diff_notional
    )?;
    #[cfg(not(feature = "mainnet-beta"))]
    validate!(
        balance_diff_notional <= PRICE_PRECISION_I64 / 10,
        ErrorCode::LpInvariantFailed,
        "Constituent balance mismatch after withdraw from program vault, {}",
        balance_diff_notional
    )?;

    Ok(())
}

#[derive(Accounts)]
pub struct DepositProgramVault<'info> {
    pub state: Box<Account<'info, State>>,
    #[account(
        mut,
        constraint = admin.key() == admin_hot_wallet::id() || admin.key() == state.admin || admin.key() == lp_pool_swap_wallet::id()
    )]
    pub admin: Signer<'info>,
    #[account(mut)]
    pub constituent: AccountLoader<'info, Constituent>,
    #[account(
        mut,
        address = constituent.load()?.vault,
        constraint = &constituent.load()?.mint.eq(&constituent_token_account.mint),
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
pub struct WithdrawProgramVault<'info> {
    pub state: Box<Account<'info, State>>,
    #[account(
        mut,
        constraint = admin.key() == admin_hot_wallet::id() || admin.key() == state.admin || admin.key() == lp_pool_swap_wallet::id()
    )]
    pub admin: Signer<'info>,
    /// CHECK: program signer
    pub drift_signer: AccountInfo<'info>,
    #[account(mut)]
    pub constituent: AccountLoader<'info, Constituent>,
    #[account(
        mut,
        address = constituent.load()?.vault,
        constraint = &constituent.load()?.mint.eq(&constituent_token_account.mint),
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
    pub state: Box<Account<'info, State>>,
    pub lp_pool: AccountLoader<'info, LPPool>,

    /// CHECK: checked in ConstituentTargetBaseZeroCopy checks and in ix
    pub constituent_target_base: AccountInfo<'info>,

    /// CHECK: checked in ConstituentCorrelationsZeroCopy checks and in ix
    pub constituent_correlations: AccountInfo<'info>,

    #[account(
        mut,
        address = in_constituent.load()?.vault,
    )]
    pub constituent_in_token_account: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(
        mut,
        address = out_constituent.load()?.vault,
    )]
    pub constituent_out_token_account: Box<InterfaceAccount<'info, TokenAccount>>,

    #[account(
        mut,
        constraint = user_in_token_account.mint.eq(&constituent_in_token_account.mint) && user_in_token_account.owner == authority.key()
    )]
    pub user_in_token_account: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(
        mut,
        constraint = user_out_token_account.mint.eq(&constituent_out_token_account.mint) && user_out_token_account.owner == authority.key()
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
        address = in_constituent.load()?.vault,
    )]
    pub constituent_in_token_account: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(
        mut,
        address = out_constituent.load()?.vault,
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
        constraint = user_in_token_account.mint.eq(&constituent_in_token_account.mint) && user_in_token_account.owner == authority.key()
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
    /// CHECK: checked in ConstituentTargetBaseZeroCopy checks and address checked in code
    pub constituent_target_base: AccountInfo<'info>,
}

#[derive(Accounts)]
#[instruction(
    out_market_index: u16,
)]
pub struct LPPoolRemoveLiquidity<'info> {
    pub state: Box<Account<'info, State>>,
    #[account(
        constraint = drift_signer.key() == state.signer
    )]
    /// CHECK: drift_signer
    pub drift_signer: AccountInfo<'info>,
    #[account(mut)]
    pub lp_pool: AccountLoader<'info, LPPool>,
    pub authority: Signer<'info>,
    pub out_market_mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(
        mut,
        seeds = [CONSTITUENT_PDA_SEED.as_ref(), lp_pool.key().as_ref(), out_market_index.to_le_bytes().as_ref()],
        bump,
        constraint =
            out_constituent.load()?.mint.eq(&constituent_out_token_account.mint)
    )]
    pub out_constituent: AccountLoader<'info, Constituent>,

    #[account(
        mut,
        constraint = user_out_token_account.mint.eq(&constituent_out_token_account.mint) && user_out_token_account.owner == authority.key()
    )]
    pub user_out_token_account: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(
        mut,
        seeds = ["CONSTITUENT_VAULT".as_ref(), lp_pool.key().as_ref(), out_market_index.to_le_bytes().as_ref()],
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
        seeds = [b"spot_market_vault".as_ref(), out_market_index.to_le_bytes().as_ref()],
        bump,
    )]
    pub spot_market_token_account: Box<InterfaceAccount<'info, TokenAccount>>,

    #[account(
        mut,
        constraint = lp_mint.key() == lp_pool.load()?.mint,
    )]
    pub lp_mint: Box<InterfaceAccount<'info, Mint>>,
    /// CHECK: checked in ConstituentTargetBaseZeroCopy checks and address checked in code
    pub constituent_target_base: AccountInfo<'info>,

    #[account(
        mut,
        seeds = [LP_POOL_TOKEN_VAULT_PDA_SEED.as_ref(), lp_pool.key().as_ref()],
        bump,
    )]
    pub lp_pool_token_vault: Box<InterfaceAccount<'info, TokenAccount>>,

    pub token_program: Interface<'info, TokenInterface>,

    #[account(
        seeds = [AMM_POSITIONS_CACHE.as_ref()],
        bump,
    )]
    /// CHECK: checked in AmmCacheZeroCopy checks
    pub amm_cache: AccountInfo<'info>,
}

#[derive(Accounts)]
#[instruction(
    in_market_index: u16,
)]
pub struct ViewLPPoolRemoveLiquidityFees<'info> {
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

    /// CHECK: checked in ConstituentTargetBaseZeroCopy checks and address checked in code
    pub constituent_target_base: AccountInfo<'info>,
}
