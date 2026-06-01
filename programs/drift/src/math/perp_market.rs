//! Pure math over `PerpMarket` state — no account I/O, no mutation.
//!
//! Cross-cutting computations that read both AMM and PerpMarket fields. For
//! pure-AMM curve math (reserves, spread, swap) see `crate::amm::math`; for
//! AMM account-level mutations see `crate::amm::controller`.

use crate::amm::math::amm::calculate_net_user_pnl;
use crate::error::DriftResult;
use crate::math::casting::Cast;
use crate::math::safe_math::SafeMath;
use crate::math::spot_balance::get_token_amount;
use crate::state::perp_market::PerpMarket;
use crate::state::spot_market::{SpotBalance, SpotMarket};

/// Recompute the AMM's `total_fee_minus_distributions` summary value from
/// underlying pool balances, the AMM's net counterparty PnL, and accumulated
/// liquidation fees. Used by admin and repeg paths to correct integer-math
/// drift that accumulates in `amm.total_fee_minus_distributions` over time.
///
/// Returns the recomputed value; callers decide whether to overwrite the
/// stored field.
pub fn calculate_perp_market_amm_summary_stats(
    perp_market: &PerpMarket,
    spot_market: &SpotMarket,
    perp_market_oracle_price: i64,
    exclude_liquidation_fee: bool,
) -> DriftResult<i128> {
    let pnl_pool_token_amount = get_token_amount(
        perp_market.pnl_pool.scaled_balance,
        spot_market,
        perp_market.pnl_pool.balance_type(),
    )?;

    let fee_pool_token_amount = perp_market.amm.fee_pool_token_amount(spot_market)?;

    let pnl_tokens_available: i128 = pnl_pool_token_amount
        .safe_add(fee_pool_token_amount)?
        .cast()?;

    let net_user_pnl = calculate_net_user_pnl(
        &perp_market.amm,
        perp_market_oracle_price,
        perp_market.quote_asset_amount,
        perp_market.net_unsettled_funding_pnl,
    )?;

    // amm's mm_fee can be incorrect with drifting integer math error
    let mut new_total_fee_minus_distributions = pnl_tokens_available.safe_sub(net_user_pnl)?;

    if exclude_liquidation_fee {
        new_total_fee_minus_distributions = new_total_fee_minus_distributions
            .safe_sub(perp_market.total_liquidation_fee.cast()?)?;
    }

    Ok(new_total_fee_minus_distributions)
}
