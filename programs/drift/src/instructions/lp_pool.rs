use anchor_lang::{
    prelude::{Account, AccountInfo, AccountLoader, Context, Pubkey, Signer, SolanaSysvar},
    Accounts, Result,
};

use crate::state::{
    lp_pool::{
        AmmConstituentDatum, AmmConstituentMappingFixed, ConstituentTargetWeightsFixed, LPPool,
        WeightDatum,
    },
    perp_market_map::MarketSet,
    state::State,
    zero_copy::{AccountZeroCopy, AccountZeroCopyMut, ZeroCopyLoader},
};
use solana_program::sysvar::clock::Clock;

use super::optional_accounts::{load_maps, AccountMaps};

pub fn handle_update_dlp_target_weights<'info, 'c: 'info>(
    ctx: Context<'_, 'info, 'c, 'info, UpdateDlpTargetWeights<'info>>,
) -> Result<()> {
    let state = &ctx.accounts.state;
    let lp_pool = &ctx.accounts.lp_pool.load()?;
    let slot = Clock::get()?.slot;

    let amm_constituent_mapping: AccountZeroCopy<
        'info,
        AmmConstituentDatum,
        AmmConstituentMappingFixed,
    > = ctx.accounts.amm_constituent_mapping.load_zc()?;

    let target_weights: AccountZeroCopyMut<'info, WeightDatum, ConstituentTargetWeightsFixed> =
        ctx.accounts.constituent_target_weights.load_zc_mut()?;

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
    for (i, datum) in amm_constituent_mapping.iter().enumerate() {
        let perp_market = perp_market_map.get_ref(&datum.perp_market_index)?;
        let amm_inventory = perp_market.amm.get_protocol_owned_position()?;
        amm_inventories.push((datum.perp_market_index, amm_inventory));

        let oracle_data = oracle_map.get_price_data_and_guard_rails(&(
            perp_market.amm.oracle,
            perp_market.amm.oracle_source,
        ))?;

        oracle_prices.push(oracle_data.0.price);
    }

    target_weights.update_target_weights(
        &amm_constituent_mapping,
        amm_inventories.as_slice(),
        constituents,
        &oracle_prices.as_slice(),
        lp_pool.last_aum,
        slot,
    );

    Ok(())
}

#[derive(Accounts)]
pub struct UpdateDlpTargetWeights<'info> {
    pub state: Box<Account<'info, State>>,
    #[account(mut)]
    pub keeper: Signer<'info>,
    /// CHECK: checked in AmmConstituentMappingZeroCopy checks
    pub amm_constituent_mapping: AccountInfo<'info>,
    /// CHECK: checked in ConstituentTargetWeightsZeroCopy checks
    pub constituent_target_weights: AccountInfo<'info>,
    pub lp_pool: AccountLoader<'info, LPPool>,
}
