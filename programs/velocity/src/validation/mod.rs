//! Pre-instruction validation: checks that run before any state mutation.
//! Called from instruction handlers in `crate::instructions` before delegating to `crate::controller`.
//! `margin.rs` = post-trade margin sufficiency checks. `order.rs` = order parameter validation.
//! `user.rs` / `perp_market.rs` / `spot_market.rs` = account state pre-conditions.

pub mod fee_structure;
pub mod margin;
pub mod order;
pub mod perp_market;
pub mod position;
pub mod sig_verification;
pub mod spot_market;
pub mod user;
pub mod whitelist;
