use anchor_lang::{prelude::*, Accounts, Key, Result};
use anchor_spl::token_interface::{Mint, TokenAccount, TokenInterface};

use crate::error::ErrorCode;
use crate::math::{
    oracle::{is_oracle_valid_for_action, DriftAction},
    safe_math::SafeMath,
};
use crate::msg;
use crate::state::constituent_map::{ConstituentMap, ConstituentSet};
use crate::state::spot_market::SpotBalanceType;
use crate::state::{
    lp_pool::{
        AmmConstituentDatum, AmmConstituentMappingFixed, Constituent, LPPool, WeightValidationFlags,
    },
    perp_market_map::MarketSet,
    state::State,
    user::MarketType,
    zero_copy::{AccountZeroCopy, ZeroCopyLoader},
};
use crate::validate;

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

    let AccountMaps {
        perp_market_map,
        spot_market_map: _,
        mut oracle_map,
    } = load_maps(
        &mut ctx.remaining_accounts.iter().peekable(),
        &MarketSet::new(),
        &MarketSet::new(),
        slot,
        Some(state.oracle_guard_rails),
    )?;

    let mut amm_inventories: Vec<(u16, i64)> = vec![];
    let mut oracle_prices: Vec<i64> = vec![];
    for (_, datum) in amm_constituent_mapping.iter().enumerate() {
        let perp_market = perp_market_map.get_ref(&datum.perp_market_index)?;

        let oracle_data = oracle_map.get_price_data_and_validity(
            MarketType::Perp,
            datum.perp_market_index,
            &perp_market.oracle_id(),
            perp_market
                .amm
                .historical_oracle_data
                .last_oracle_price_twap,
            perp_market.get_max_confidence_interval_multiplier()?,
        )?;

        if !is_oracle_valid_for_action(
            oracle_data.1,
            Some(DriftAction::UpdateDlpConstituentTargetWeights),
        )? {
            msg!("Oracle data for perp market {} and constituent index {} is invalid. Skipping update",
                datum.perp_market_index, datum.constituent_index);
            continue;
        }

        let amm_inventory = perp_market.amm.get_protocol_owned_position()?;
        amm_inventories.push((datum.perp_market_index, amm_inventory));
        oracle_prices.push(oracle_data.0.price);
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

        let oracle_price: Option<i64> = {
            if !is_oracle_valid_for_action(oracle_data.1, Some(DriftAction::UpdateLpPoolAum))? {
                msg!(
                    "Oracle data for spot market {} is invalid. Skipping update",
                    spot_market.market_index,
                );
                if slot - constituent.last_oracle_slot > 400 {
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
        constituent.last_oracle_slot = slot;

        let constituent_aum = constituent
            .get_full_balance(&spot_market)?
            .safe_mul(oracle_price.unwrap() as i128)?;
        aum = aum.safe_add(constituent_aum as u128)?;
    }

    lp_pool.last_aum = aum;
    lp_pool.last_aum_slot = slot;
    lp_pool.last_aum_ts = Clock::get()?.unix_timestamp;

    Ok(())
}

#[access_control(
    fill_not_paused(&ctx.accounts.state)
)]
pub fn handle_lp_pool_swap<'c: 'info, 'info>(
    ctx: Context<'_, '_, 'c, 'info, LPSwap<'info>>,
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

    let in_constituent_token_account = &ctx.accounts.constituent_in_token_account;
    let out_constituent_token_account = &ctx.accounts.constituent_out_token_account;

    let constituent_target_weights = ctx.accounts.constituent_target_weights.load_zc()?;

    let AccountMaps {
        perp_market_map,
        spot_market_map,
        mut oracle_map,
    } = load_maps(
        &mut ctx.remaining_accounts.iter().peekable(),
        &MarketSet::new(),
        &MarketSet::new(),
        slot,
        Some(state.oracle_guard_rails),
    )?;

    let mut in_spot_market = spot_market_map.get_ref_mut(&in_market_index)?;
    let mut out_spot_market = spot_market_map.get_ref_mut(&out_market_index)?;

    let in_oracle_id = in_spot_market.oracle_id();
    let out_oracle_id = out_spot_market.oracle_id();

    let in_oracle = *oracle_map.get_price_data(&in_oracle_id)?;
    let out_oracle = *oracle_map.get_price_data(&out_oracle_id)?;

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

    in_constituent.record_swap_fees(in_fee)?;
    out_constituent.record_swap_fees(out_fee)?;

    // interactions: CPIs

    let (transfer_from_vault, transfer_from_constituent) = out_constituent
        .get_amount_from_vaults_to_withdraw(
            out_constituent_token_account.amount,
            out_amount_net_fees,
        )?;

    // transfer in from user token account to token vault
    receive(
        &ctx.accounts.token_program,
        &ctx.accounts.user_in_token_account,
        &ctx.accounts.constituent_in_token_account,
        &ctx.accounts.authority,
        in_amount,
        &Some((*ctx.accounts.in_market_mint).clone()),
    )?;
    ctx.accounts.constituent_in_token_account.reload()?;

    // transfer out from token vault to constituent token account
    if transfer_from_vault > 0 {
        send_from_program_vault(
            &ctx.accounts.token_program,
            &ctx.accounts.out_spot_market_vault,
            &ctx.accounts.constituent_out_token_account,
            &ctx.accounts.drift_signer,
            state.signer_nonce,
            transfer_from_vault,
            &Some((*ctx.accounts.out_market_mint).clone()),
        )?;
    }
    ctx.accounts.constituent_out_token_account.reload()?;

    // transfer out from constituent token account to user token account

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

#[derive(Accounts)]
pub struct LPSwap<'info> {
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

    #[account(mut)]
    pub user_in_token_account: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut)]
    pub user_out_token_account: Box<InterfaceAccount<'info, TokenAccount>>,

    #[account(
        mut,
        constraint = &in_spot_market_vault.mint.eq(&in_market_mint.key())
    )]
    pub in_spot_market_vault: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(
        mut,
        constraint = &out_spot_market_vault.mint.eq(&out_market_mint.key())
    )]
    pub out_spot_market_vault: Box<InterfaceAccount<'info, TokenAccount>>,

    #[account(mut)]
    pub in_constituent: AccountLoader<'info, Constituent>,
    #[account(mut)]
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
