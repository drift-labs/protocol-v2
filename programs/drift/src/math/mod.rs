//! Pure numeric logic: margin, fees, funding, oracle validation.
//! No account I/O — all functions are deterministic given inputs.
//! `margin.rs` = margin requirement and free collateral calculations.
//! `orders.rs` / `matching.rs` = order price validation and maker/taker matching logic.
//! `funding.rs` = funding rate calculation. `oracle.rs` = oracle validity and TWAP divergence checks.
//! `liquidation.rs` = liquidation fee and amount math. `fees.rs` = taker/maker fee tiers.
//! AMM pricing math lives in `crate::amm::math`.

pub mod auction;
pub mod bankruptcy;
pub mod bn;
pub mod casting;
pub mod ceil_div;
pub mod constants;
pub mod fees;
mod floor_div;
pub mod fulfillment;
pub mod funding;
pub mod helpers;
pub mod insurance;
pub mod liquidation;
pub mod lp_pool;
pub mod margin;
pub mod matching;
pub mod oracle;
pub mod orders;
pub mod perp_market;
pub mod position;
pub mod quote_asset;
pub mod safe_math;
pub mod safe_unwrap;
pub mod spot_balance;
pub mod spot_swap;
pub mod spot_withdraw;
pub mod stats;
