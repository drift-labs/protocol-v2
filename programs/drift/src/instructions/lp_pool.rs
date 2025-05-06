use anchor_lang::{prelude::*, Accounts, Key, Result};
use anchor_spl::token_interface::{Mint, TokenAccount, TokenInterface};

use crate::{
    controller::token::mint_tokens,
    error::ErrorCode,
    math::{
        casting::Cast,
        constants::PRICE_PRECISION_I128,
        oracle::{is_oracle_valid_for_action, oracle_validity, DriftAction},
        safe_math::SafeMath,
    },
    msg,
    state::{
        constituent_map::{ConstituentMap, ConstituentSet},
        events::{LPMintRedeemRecord, LPSwapRecord},
        lp_pool::{
            AmmConstituentDatum, AmmConstituentMappingFixed, Constituent, LPPool,
            WeightValidationFlags,
        },
        oracle::OraclePriceData,
        perp_market::{AmmCacheFixed, CacheInfo, AMM_POSITIONS_CACHE},
        perp_market_map::MarketSet,
        spot_market_map::get_writable_spot_market_set_from_many,
        state::State,
        user::MarketType,
        zero_copy::{AccountZeroCopy, ZeroCopyLoader},
    },
    validate,
};

use solana_program::sysvar::clock::Clock;

use super::optional_accounts::{load_maps, AccountMaps};
use crate::controller::spot_balance::update_spot_market_cumulative_interest;
use crate::controller::token::{receive, send_from_program_vault};
use crate::instructions::constraints::*;
use crate::state::lp_pool::{
    AMM_MAP_PDA_SEED, CONSTITUENT_PDA_SEED, CONSTITUENT_TARGET_WEIGHT_PDA_SEED,
};

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

    let mut in_constituent = ctx.accounts.in_constituent.load_mut()?;
    let mut out_constituent = ctx.accounts.out_constituent.load_mut()?;

    let constituent_target_weights = ctx.accounts.constituent_target_weights.load_zc()?;

    let AccountMaps {
        perp_market_map: _,
        spot_market_map,
        mut oracle_map,
    } = load_maps(
        &mut ctx.remaining_accounts.iter().peekable(),
        &MarketSet::new(),
        &get_writable_spot_market_set_from_many(vec![in_market_index, out_market_index]),
        slot,
        Some(state.oracle_guard_rails),
    )?;

    let mut in_spot_market = spot_market_map.get_ref_mut(&in_market_index)?;
    let mut out_spot_market = spot_market_map.get_ref_mut(&out_market_index)?;

    let in_oracle_id = in_spot_market.oracle_id();
    let out_oracle_id = out_spot_market.oracle_id();

    let (in_oracle, in_oracle_validity) = oracle_map.get_price_data_and_validity(
        MarketType::Spot,
        in_spot_market.market_index,
        &in_oracle_id,
        in_spot_market.historical_oracle_data.last_oracle_price_twap,
        in_spot_market.get_max_confidence_interval_multiplier()?,
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

    update_spot_market_cumulative_interest(&mut in_spot_market, Some(&in_oracle), now)?;
    update_spot_market_cumulative_interest(&mut out_spot_market, Some(&out_oracle), now)?;

    let in_target_weight =
        constituent_target_weights.get_target_weight(in_constituent.constituent_index)?;
    let out_target_weight =
        constituent_target_weights.get_target_weight(out_constituent.constituent_index)?;

    let (in_amount, out_amount, in_fee, out_fee) = lp_pool.get_swap_amount(
        &in_oracle,
        &out_oracle,
        &in_constituent,
        &out_constituent,
        &in_spot_market,
        &out_spot_market,
        in_target_weight,
        out_target_weight,
        in_amount,
    )?;
    msg!(
        "in_amount: {}, out_amount: {}, in_fee: {}, out_fee: {}",
        in_amount,
        out_amount,
        in_fee,
        out_fee
    );
    let out_amount_net_fees = if out_fee > 0 {
        out_amount.safe_sub(out_fee.unsigned_abs() as u64)?
    } else {
        out_amount.safe_add(out_fee.unsigned_abs() as u64)?
    };

    validate!(
        out_amount_net_fees >= min_out_amount,
        ErrorCode::SlippageOutsideLimit,
        format!(
            "Slippage outside limit: out_amount_net_fees({}) < min_out_amount({})",
            out_amount_net_fees, min_out_amount
        )
        .as_str()
    )?;

    validate!(
        out_amount_net_fees <= out_constituent.token_balance,
        ErrorCode::InsufficientConstituentTokenBalance,
        format!(
            "Insufficient out constituent balance: out_amount_net_fees({}) > out_constituent.token_balance({})",
            out_amount_net_fees, out_constituent.token_balance
        )
        .as_str()
    )?;

    in_constituent.record_swap_fees(in_fee)?;
    out_constituent.record_swap_fees(out_fee)?;

    emit!(LPSwapRecord {
        ts: now,
        authority: ctx.accounts.authority.key(),
        amount_out: out_amount_net_fees,
        amount_in: in_amount,
        fee_out: out_fee,
        fee_in: in_fee,
        out_spot_market_index: out_market_index,
        in_spot_market_index: in_market_index,
        out_constituent_index: out_constituent.constituent_index,
        in_constituent_index: in_constituent.constituent_index,
        out_oracle_price: out_oracle.price,
        in_oracle_price: in_oracle.price,
        mint_out: out_constituent.mint,
        mint_in: in_constituent.mint,
    });

    receive(
        &ctx.accounts.token_program,
        &ctx.accounts.user_in_token_account,
        &ctx.accounts.constituent_in_token_account,
        &ctx.accounts.authority,
        in_amount,
        &Some((*ctx.accounts.in_market_mint).clone()),
    )?;

    send_from_program_vault(
        &ctx.accounts.token_program,
        &ctx.accounts.constituent_out_token_account,
        &ctx.accounts.user_out_token_account,
        &ctx.accounts.drift_signer,
        state.signer_nonce,
        out_amount_net_fees,
        &Some((*ctx.accounts.out_market_mint).clone()),
    )?;

    ctx.accounts.constituent_in_token_account.reload()?;
    ctx.accounts.constituent_out_token_account.reload()?;

    in_constituent.sync_token_balance(ctx.accounts.constituent_in_token_account.amount);
    out_constituent.sync_token_balance(ctx.accounts.constituent_out_token_account.amount);

    Ok(())
}

#[access_control(
    fill_not_paused(&ctx.accounts.state)
)]
pub fn handle_lp_pool_add_liquidity<'c: 'info, 'info>(
    ctx: Context<'_, '_, 'c, 'info, LPPoolAddLiquidity<'info>>,
    in_market_index: u16,
    in_amount: u64,
    min_mint_amount: u64,
) -> Result<()> {
    let slot = Clock::get()?.slot;
    let now = Clock::get()?.unix_timestamp;
    let state = &ctx.accounts.state;
    let mut lp_pool = ctx.accounts.lp_pool.load_mut()?;

    let mut in_constituent = ctx.accounts.in_constituent.load_mut()?;

    let constituent_target_weights = ctx.accounts.constituent_target_weights.load_zc()?;

    let AccountMaps {
        perp_market_map: _,
        spot_market_map,
        mut oracle_map,
    } = load_maps(
        &mut ctx.remaining_accounts.iter().peekable(),
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
    )?;
    let in_oracle = in_oracle.clone();

    if !is_oracle_valid_for_action(in_oracle_validity, Some(DriftAction::LpPoolSwap))? {
        msg!(
            "In oracle data for spot market {} is invalid for lp pool swap.",
            in_spot_market.market_index,
        );
        return Err(ErrorCode::InvalidOracle.into());
    }

    update_spot_market_cumulative_interest(&mut in_spot_market, Some(&in_oracle), now)?;

    let in_target_weight =
        constituent_target_weights.get_target_weight(in_constituent.constituent_index)?;

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
        in_amount,
        &Some((*ctx.accounts.in_market_mint).clone()),
    )?;

    mint_tokens(
        &ctx.accounts.token_program,
        &ctx.accounts.user_lp_token_account,
        &ctx.accounts.drift_signer,
        state.signer_nonce,
        lp_mint_amount_net_fees,
        &ctx.accounts.lp_mint,
    )?;

    lp_pool.last_aum = lp_pool.last_aum.safe_add(
        in_amount
            .cast::<u128>()?
            .safe_mul(in_oracle.price.cast::<u128>()?)?
            .safe_div(10_u128.pow(in_spot_market.decimals))?,
    )?;

    ctx.accounts.constituent_in_token_account.reload()?;
    ctx.accounts.lp_mint.reload()?;

    in_constituent.sync_token_balance(ctx.accounts.constituent_in_token_account.amount);

    let dlp_total_supply = ctx.accounts.lp_mint.supply;
    emit!(LPMintRedeemRecord {
        ts: now,
        authority: ctx.accounts.authority.key(),
        is_minting: true,
        amount: lp_mint_amount_net_fees,
        fee: lp_fee_amount,
        spot_market_index: in_market_index,
        constituent_index: in_constituent.constituent_index,
        oracle_price: in_oracle.price,
        mint: in_constituent.mint,
        lp_mint: lp_pool.mint,
        lp_amount: lp_mint_amount_net_fees,
        lp_fee: lp_fee_amount,
        lp_nav: lp_pool.last_aum.safe_div(dlp_total_supply as u128)?,
    });

    Ok(())
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
    #[account(
        mut,
        seeds = [CONSTITUENT_TARGET_WEIGHT_PDA_SEED.as_ref(), lp_pool.key().as_ref()],
        bump,
    )]
    /// CHECK: checked in ConstituentTargetWeightsZeroCopy checks
    pub constituent_target_weights: AccountInfo<'info>,

    #[account(mut)]
    pub constituent_in_token_account: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut)]
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
        bump,
        constraint = in_constituent.load()?.mint.eq(&constituent_in_token_account.mint)
    )]
    pub in_constituent: AccountLoader<'info, Constituent>,
    #[account(
        mut,
        seeds = [CONSTITUENT_PDA_SEED.as_ref(), lp_pool.key().as_ref(), out_market_index.to_le_bytes().as_ref()],
        bump,
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
    lp_pool_name: [u8; 32],
    in_market_index: u16,
)]
pub struct LPPoolAddLiquidity<'info> {
    /// CHECK: forced drift_signer
    pub drift_signer: AccountInfo<'info>,
    pub state: Box<Account<'info, State>>,
    #[account(
        mut,
        seeds = [b"lp_pool", lp_pool_name.as_ref()],
        bump,
    )]
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
    #[account(mut)]
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
        mut,
        seeds = [CONSTITUENT_TARGET_WEIGHT_PDA_SEED.as_ref(), lp_pool.key().as_ref()],
        bump,
    )]
    /// CHECK: checked in ConstituentTargetWeightsZeroCopy checks
    pub constituent_target_weights: AccountInfo<'info>,

    pub token_program: Interface<'info, TokenInterface>,
}
