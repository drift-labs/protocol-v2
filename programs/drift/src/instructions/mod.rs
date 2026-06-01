//! Anchor instruction handlers: account constraints, deserialization, and delegation to `controller`.
//! `user.rs` = trading (orders, deposits, LP positions).
//! `keeper.rs` = crank instructions (funding updates, PnL settlement, liquidations, fills).
//! `admin.rs` = governance (market init/update, oracle config, fees, insurance).
//! AMM-specific admin ixs (repeg, update_k, recenter, spread/jit config, fee-pool plumbing) live in `crate::amm::admin`.
//! `lp_pool.rs` / `lp_admin.rs` = LP pool management.
//! `constraints.rs` = shared Anchor account constraint helpers.

pub use crate::amm::admin::*;

pub use admin::*;
pub use constraints::*;
pub use if_staker::*;
pub use keeper::*;
pub use lp_admin::*;
pub use lp_pool::*;
pub use pyth_lazer_oracle::*;
pub use user::*;

mod admin;
mod constraints;
mod if_staker;
mod keeper;
mod lp_admin;
mod lp_pool;
pub mod optional_accounts;
mod pyth_lazer_oracle;
mod user;
