//! Direct protocol-fee withdrawal.
//!
//! Protocol fees accrue as an excess `protocol_fee_pool` claim on each market
//! (perp fees are quote/USDC-denominated and drawn from the quote spot vault;
//! spot/lending fees are drawn from the market's own vault). These ixs let the
//! `FeeWithdraw` hot key move those fees directly to the associated token
//! account of the configured recipient — `State.protocol_fee_recipient_perp`
//! for perp (quote) fees, `State.protocol_fee_recipient_spot` for spot fees
//! (created on demand) — WITHOUT
//! touching the insurance fund or depositor backing: the withdrawal is capped
//! to the pool balance and re-validates `vault >= depositors_claim`, and the
//! recipient is hard-locked to the cold-admin-set treasury.
//!
//! One file per instruction: account context at the top, handler below.

mod withdraw_protocol_fees_perp;
mod withdraw_protocol_fees_spot;

pub use withdraw_protocol_fees_perp::*;
pub use withdraw_protocol_fees_spot::*;
