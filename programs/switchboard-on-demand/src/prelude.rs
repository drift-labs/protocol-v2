// Note: Most client items are NOT re-exported in prelude to avoid naming conflicts.
// Access client functionality via: use switchboard_on_demand::client::{Gateway, PullFeed};
pub use std::result::Result;

pub use rust_decimal;
pub use solana_program::entrypoint::ProgramResult;
pub use solana_program::instruction::{AccountMeta, Instruction};
pub use solana_program::program::{invoke, invoke_signed};

pub use crate::accounts::*;
// Client utility functions
#[cfg(feature = "client")]
pub use crate::client::utils::{ix_to_tx, ix_to_tx_v0};
pub use crate::decimal::*;
pub use crate::instructions::*;
// Use solana_program and Pubkey from the compat layer
pub use crate::solana_compat::{pubkey, solana_program, Pubkey};
pub use crate::sysvar::*;
pub use crate::types::*;
pub use crate::utils::check_pubkey_eq;
pub use crate::AsAccountInfo;
// When both solana-v2 and client are enabled, export the conversion trait
#[cfg(all(feature = "solana-v2", feature = "client"))]
pub use crate::IntoV2Instruction;
