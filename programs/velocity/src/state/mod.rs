//! On-chain account structs and their accessor/mutation methods.
//! Zero-copy types (`User`, `PerpMarket`, `SpotMarket`) use `AccountLoader` for efficient deserialization.
//! `user.rs` = `User` account (positions, orders, subaccounts). `perp_market.rs` / `spot_market.rs` = market state.
//! `oracle.rs` / `oracle_map.rs` = oracle source types and per-instruction oracle loading.
//! `order_params.rs` = `OrderParams` and `ModifyOrderParams` (shared between SDK and on-chain).
//! `events.rs` = all emitted program events (OrderRecord, FillRecord, LiquidationRecord, etc.).
//! `margin_calculation.rs` = margin calculation context and result types.

pub mod events;
pub mod fill_mode;
pub mod fulfillment;
pub mod fulfillment_params;
pub mod insurance_fund_stake;
pub mod liquidation_mode;
pub mod load_ref;
pub mod margin_calculation;
pub mod market_status;
pub mod oracle;
pub mod oracle_map;
pub mod order_params;
pub mod paused_operations;
pub mod perp_market;
pub mod perp_market_map;
pub mod pyth_lazer_oracle;
pub mod quoter;
pub mod revenue_share;
pub mod revenue_share_map;
pub mod scale_order_params;
pub mod settle_pnl_mode;
pub mod signed_msg_user;
pub mod spot_fulfillment_params;
pub mod spot_market;
pub mod spot_market_map;
#[allow(clippy::module_inception)]
pub mod state;
pub mod traits;
pub mod user;
pub mod user_map;
pub mod zero_copy;
