//! Pure math over `PerpMarket` state — no account I/O, no mutation.
//!
//! Cross-cutting computations that read both AMM and PerpMarket fields. For
//! pure-AMM curve math (reserves, spread, swap) see `crate::vlp::amm::math`; for
//! AMM account-level mutations see `crate::vlp::amm::controller`.

use crate::error::VelocityResult;
use crate::math::casting::Cast;
use crate::math::safe_math::SafeMath;
use crate::math::spot_balance::get_token_amount;
use crate::state::perp_market::PerpMarket;
use crate::state::spot_market::{SpotBalance, SpotMarket};
use crate::vlp::amm::math::amm::calculate_net_user_pnl;

/// Recompute the AMM's `total_fee_minus_distributions` summary value from the
/// market's balance-sheet identity. Used by admin paths to correct
/// integer-math drift that accumulates in `amm.total_fee_minus_distributions`
/// over time.
///
/// Identity: everything the market's pools hold that is neither claimable by
/// users (`net_user_pnl`) nor earmarked for the protocol / insurance fund
/// (the pending counters) is the AMM's equity. `pending_amm_provision` is
/// deliberately NOT subtracted — the provision is already booked into tfmd at
/// fill while its token backing (counted in the pools) waits in the pnl pool
/// for tokenization; subtracting both sides would double-count it. The same
/// symmetry is why liquidation fees need no special handling: their accrual
/// raises the pendings exactly as it lowers `net_user_pnl`, and the sweep
/// lowers the pendings exactly as it drains pool tokens.
///
/// Returns the recomputed value; callers decide whether to overwrite the
/// stored field.
pub fn calculate_perp_market_amm_summary_stats(
    perp_market: &PerpMarket,
    spot_market: &SpotMarket,
    perp_market_oracle_price: i64,
) -> VelocityResult<i128> {
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

    pnl_tokens_available
        .safe_sub(net_user_pnl)?
        .safe_sub(perp_market.fee_ledger.pending_protocol_fee.cast()?)?
        .safe_sub(perp_market.fee_ledger.pending_if_fee.cast()?)
}
