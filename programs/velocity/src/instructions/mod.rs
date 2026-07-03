//! Anchor instruction handlers: account constraints, deserialization, and delegation to `controller`.
//! `user.rs` = trading (orders, deposits, LP positions).
//! `keeper.rs` = crank instructions (funding updates, PnL settlement, liquidations, fills).
//! `admin.rs` = governance (market init/update, oracle config, fees, insurance).
//! AMM-specific admin ixs (repeg, update_k, recenter, spread/jit config, fee-pool plumbing) live in `crate::vlp::amm::admin`.
//! LP-pool management ixs live in `crate::vlp::hedge::{admin, instructions}`.
//! `constraints.rs` = shared Anchor account constraint helpers.

pub use crate::vlp::amm::admin::*;
#[cfg(feature = "vlp-hedge")]
pub use crate::vlp::hedge::admin::*;
#[cfg(feature = "vlp-hedge")]
pub use crate::vlp::hedge::instructions::*;
#[cfg(feature = "vlp-hedge")]
pub use crate::vlp::hedge::settle::*;

pub use admin::*;
pub use constraints::*;
pub use if_staker::*;
pub use keeper::*;
pub use protocol_fees::*;
pub use pyth_lazer_oracle::*;
pub use user::*;

mod admin;
pub mod constraints;
mod if_staker;
mod keeper;
pub mod optional_accounts;
mod protocol_fees;
mod pyth_lazer_oracle;
mod user;
