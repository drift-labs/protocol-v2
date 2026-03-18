//! Rust SDK for quoting on Drift's PropAMM system (`midprice_pino`).
//!
//! Provides [`PropAmmClient`] for building and sending quotes, instruction
//! builders for the midprice-pino on-chain program, Pyth oracle parsing, and
//! fill monitoring via RPC polling or WebSocket subscription.
//!
//! # Quick start
//!
//! ```no_run
//! use std::sync::Arc;
//! use propamm_sdk::{PropAmmClient, OrderEntry, DRIFT_PROGRAM_ID, MIDPRICE_PINO_PROGRAM_ID};
//! use solana_keypair::read_keypair_file;
//!
//! # async fn run() -> Result<(), Box<dyn std::error::Error>> {
//! let payer = Arc::new(read_keypair_file("keypair.json")?);
//! let client = PropAmmClient::new(
//!     "http://127.0.0.1:8899",
//!     payer,
//!     0, // market_index
//!     0, // subaccount_index
//!     MIDPRICE_PINO_PROGRAM_ID,
//!     DRIFT_PROGRAM_ID,
//! );
//!
//! let slot = client.get_slot().await?;
//! let asks = vec![OrderEntry { offset: 1000, size: 1_000_000_000 }];
//! let bids = vec![OrderEntry { offset: -1000, size: 1_000_000_000 }];
//! let sig = client.quote(50_000_000_000, slot, &asks, &bids).await?;
//! # Ok(())
//! # }
//! ```

/// High-level async client for building and sending PropAMM transactions.
pub mod client;
/// Program IDs, precision constants, and instruction opcodes.
pub mod constants;
/// Solana instruction builders for midprice-pino and Drift Anchor programs.
pub mod instructions;
/// Fill monitoring via RPC polling or WebSocket subscription.
pub mod monitor;
/// Pyth v2 oracle price parsing.
pub mod oracle;
/// PDA derivation helpers for midprice, matcher, and Drift accounts.
pub mod pda;

pub use client::{ClientError, PropAmmClient};
pub use constants::{
    BASE_PRECISION, DRIFT_PROGRAM_ID, MIDPRICE_PINO_PROGRAM_ID, PRICE_PRECISION, QUOTE_PRECISION,
};
pub use instructions::OrderEntry;
pub use oracle::OraclePrice;

/// Re-export of [`midprice_book_view`] for parsing raw midprice account data.
pub use midprice_book_view;

/// Re-export of [`tokio`] for convenience (bot loops need the runtime).
pub use tokio;
