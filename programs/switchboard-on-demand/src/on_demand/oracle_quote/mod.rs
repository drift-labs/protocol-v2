//! Oracle quote verification and data extraction
//!
//! This module provides functionality for verifying and extracting data from oracle quotes
//! that have been cryptographically signed by multiple oracles. The main components are:
//!
//! - [`OracleQuote`] - A verified quote containing oracle feed data
//! - [`QuoteVerifier`] - Builder pattern for configuring and performing verification
//! - [`PackedFeedInfo`] and [`PackedQuoteHeader`] - Zero-copy data structures for efficient access
//!
//! # Usage with Anchor
//!
//! The QuoteVerifier is designed to work seamlessly with Anchor's account wrapper types:
//!
//! ```rust,ignore
//! use anchor_lang::prelude::*;
//! use switchboard_on_demand::QuoteVerifier;
//!
//! pub fn verify_oracle_data(ctx: Context<VerifyCtx>) -> Result<()> {
//!     // Destructure accounts - works without lifetime issues
//!     let VerifyCtx { queue, oracle, sysvars, .. } = ctx.accounts;
//!     let clock_slot = switchboard_on_demand::clock::get_slot(&sysvars.clock);
//!
//!     // Build and verify - accepts Anchor wrapper types directly
//!     let quote = QuoteVerifier::new()
//!         .queue(&queue)                    // Works with AccountLoader<QueueAccountData>
//!         .slothash_sysvar(&sysvars.slothashes)     // Works with Sysvar<SlotHashes>
//!         .ix_sysvar(&sysvars.instructions)         // Works with Sysvar<Instructions>
//!         .clock_slot(clock_slot)           // Uses clock slot
//!         .max_age(150)
//!         .verify_account(&oracle)?;        // Works with AccountLoader<SwitchboardQuote>
//!
//!     // Access verified feed data
//!     for feed in quote.feeds() {
//!         msg!("Feed {}: ${}", feed.hex_id(), feed.value());
//!     }
//!     Ok(())
//! }
//! ```
//!
//! # Key Features
//!
//! - **Anchor Integration**: All methods accept types implementing `AsAccountInfo`
//! - **Flexible API**: Works with both raw `AccountInfo` and Anchor wrapper types
//! - **Lifetime Safety**: No unsafe code, proper lifetime management through ownership
//! - **Context Destructuring**: Supports destructuring Anchor contexts without lifetime issues

pub mod feed_info;
pub use feed_info::*;
pub mod quote;
pub use quote::*;
pub mod quote_verifier;
pub use quote_verifier::*;
pub mod instruction_parser;
pub use instruction_parser::*;
/// Oracle quote account utilities for Anchor integration
pub mod quote_account;
pub use quote_account::{OracleSignature, SwitchboardQuote};
/// Extension trait for Anchor account wrappers
#[cfg(feature = "anchor")]
pub mod quote_ext;
#[cfg(feature = "anchor")]
pub use quote_ext::SwitchboardQuoteExt;
