//! Stateful protocol operations: fills, liquidations, position mutations, funding settlements.
//! Pure math lives in `crate::math`. Instruction handlers (account validation) live in `crate::instructions`.
//! AMM controller / refresh logic lives in `crate::amm`.
//! `orders.rs` = order lifecycle (placement, cancellation, fill matching for perp + spot).
//! `liquidation.rs` = margin checks, position reduction, social loss, insurance draws.
//! `position.rs` / `spot_position.rs` = position mutation primitives used by orders and liquidation.
//! `funding.rs` / `pnl.rs` = market maintenance operations run by keeper cranks.

pub mod funding;
pub mod insurance;
pub mod isolated_position;
pub mod liquidation;
pub mod market_stats;
#[path = "match.rs"]
pub mod matching;
pub mod orders;
pub mod pda;
pub mod perp_pools;
pub mod pnl;
pub mod position;
pub mod revenue_share;
pub mod spot_balance;
pub mod spot_position;
pub mod token;
