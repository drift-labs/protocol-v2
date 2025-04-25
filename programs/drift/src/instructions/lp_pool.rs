use anchor_lang::{prelude::*, Accounts, Key, Result, ToAccountInfo};

use crate::{
    error::ErrorCode,
    math::oracle::{is_oracle_valid_for_action, DriftAction},
    msg,
    state::{
        lp_pool::{
            AmmConstituentDatum, AmmConstituentMappingFixed, ConstituentTargetWeightsFixed, LPPool,
            WeightDatum, WeightValidationFlags,
        },
        perp_market_map::MarketSet,
        state::State,
        user::MarketType,
        zero_copy::{AccountZeroCopy, AccountZeroCopyMut, ZeroCopyLoader},
    },
    validate,
};
use solana_program::sysvar::clock::Clock;

use super::optional_accounts::{load_maps, AccountMaps};
use crate::state::lp_pool::{AMM_MAP_PDA_SEED, CONSTITUENT_TARGET_WEIGHT_PDA_SEED};

pub fn handle_update_constituent_target_weights<'c: 'info, 'info>(
    ctx: Context<'_, '_, 'c, 'info, UpdateConstituentTargetWeights<'info>>,
    lp_pool_name: [u8; 32],
    constituent_indexes: Vec<u16>,
) -> Result<()> {
    let lp_pool = &ctx.accounts.lp_pool.load()?;
    let lp_pool_key = &ctx.accounts.lp_pool.key();

    let state = &ctx.accounts.state;
    let constituent_target_weights_key = &ctx.accounts.constituent_target_weights.key();
    let amm_mapping_key = &ctx.accounts.amm_constituent_mapping.key();

    // Validate lp pool pda
    let expected_lp_pda = &Pubkey::create_program_address(
        &[
            b"lp_pool",
            lp_pool_name.as_ref(),
            lp_pool.bump.to_le_bytes().as_ref(),
        ],
        &crate::ID,
    )
    .map_err(|_| ErrorCode::InvalidPDA)?;
    validate!(
        expected_lp_pda.eq(lp_pool_key),
        ErrorCode::InvalidPDA,
        "Lp pool PDA does not match expected PDA"
    )?;

    let mut constituent_target_weights: AccountZeroCopyMut<
        '_,
        WeightDatum,
        ConstituentTargetWeightsFixed,
    > = ctx.accounts.constituent_target_weights.load_zc_mut()?;

    let bump = constituent_target_weights.fixed.bump;
    let expected_pda = &Pubkey::create_program_address(
        &[
            CONSTITUENT_TARGET_WEIGHT_PDA_SEED.as_ref(),
            lp_pool.pubkey.as_ref(),
            bump.to_le_bytes().as_ref(),
        ],
        &crate::ID,
    )
    .map_err(|_| ErrorCode::InvalidPDA)?;
    validate!(
        expected_pda.eq(constituent_target_weights_key),
        ErrorCode::InvalidPDA,
        "Constituent target weights PDA does not match expected PDA"
    )?;

    let num_constituents = constituent_target_weights.len();
    for datum in constituent_target_weights.iter() {
        msg!("weight datum: {:?}", datum);
    }

    msg!("Number of constituents: {}", num_constituents);
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

    let amm_mapping_bump = amm_constituent_mapping.fixed.bump;
    let expected_map_pda = &Pubkey::create_program_address(
        &[
            AMM_MAP_PDA_SEED.as_ref(),
            lp_pool.pubkey.as_ref(),
            amm_mapping_bump.to_le_bytes().as_ref(),
        ],
        &crate::ID,
    )
    .map_err(|_| ErrorCode::InvalidPDA)?;
    validate!(
        expected_map_pda.eq(amm_mapping_key),
        ErrorCode::InvalidPDA,
        "Amm mapping PDA does not match expected PDA"
    )?;

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

#[derive(Accounts)]
#[instruction(
    lp_pool_name: [u8; 32],
)]
pub struct UpdateConstituentTargetWeights<'info> {
    pub state: Box<Account<'info, State>>,
    #[account(mut)]
    pub keeper: Signer<'info>,
    /// CHECK: checked in AmmConstituentMappingZeroCopy checks
    pub amm_constituent_mapping: AccountInfo<'info>,
    #[account(mut)]
    /// CHECK: checked in ConstituentTargetWeightsZeroCopy checks
    pub constituent_target_weights: AccountInfo<'info>,
    pub lp_pool: AccountLoader<'info, LPPool>,
}
