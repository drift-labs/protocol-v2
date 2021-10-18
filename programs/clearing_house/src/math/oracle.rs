use crate::error::ClearingHouseResult;
use crate::math::amm;
use crate::state::market::AMM;
use crate::state::state::OracleGuardRails;
use anchor_lang::prelude::AccountInfo;
use solana_program::clock::Slot;

pub fn block_operation(
    amm: &AMM,
    oracle_account_info: &AccountInfo,
    clock_slot: Slot,
    guard_rails: &OracleGuardRails,
    precomputed_mark_price: Option<u128>,
) -> ClearingHouseResult<(bool, i128)> {
    let oracle_is_valid =
        amm::is_oracle_valid(amm, oracle_account_info, clock_slot, &guard_rails.validity)?;
    let (oracle_price, _, oracle_mark_spread_pct) = amm::calculate_oracle_mark_spread_pct(
        &amm,
        &oracle_account_info,
        0,
        clock_slot,
        precomputed_mark_price,
    )?;
    let is_oracle_mark_too_divergent =
        amm::is_oracle_mark_too_divergent(oracle_mark_spread_pct, &guard_rails.price_divergence)?;

    let block = !oracle_is_valid || is_oracle_mark_too_divergent;
    return Ok((block, oracle_price));
}
