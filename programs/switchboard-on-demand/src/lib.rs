#![allow(clippy::crate_in_macro_def)]
#![allow(clippy::repr_packed_without_abi)]
#![allow(clippy::manual_is_multiple_of)]
#![doc(html_logo_url = "https://i.imgur.com/2cZloJp.png")]
#![allow(unexpected_cfgs)]
#![allow(unused_attributes)]
#![allow(clippy::result_large_err)]
//! # Switchboard On-Demand Oracle SDK
//!
//! Official Rust SDK for Switchboard On-Demand Oracles on Solana.
//!
//! This SDK provides secure, efficient access to real-time oracle data with
//! comprehensive validation and zero-copy performance optimizations.
//!
//! ## Quick Start
//!
//! ```rust,no_run
//! use switchboard_on_demand::prelude::*;
//! # use solana_program::account_info::AccountInfo;
//! # let queue_account: AccountInfo = todo!();
//! # let slothash_sysvar: AccountInfo = todo!();
//! # let instructions_sysvar: AccountInfo = todo!();
//! # let clock_slot: u64 = 0;
//!
//! // Configure the verifier with required accounts
//! let quote = QuoteVerifier::new()
//!     .queue(&queue_account)
//!     .slothash_sysvar(&slothash_sysvar)
//!     .ix_sysvar(&instructions_sysvar)
//!     .clock_slot(clock_slot)
//!     .max_age(150)
//!     .verify_instruction_at(0)?;
//!
//! // Access feed data
//! for feed in quote.feeds() {
//!     println!("Feed {}: {}", feed.hex_id(), feed.value());
//! }
//! # Ok::<(), Box<dyn std::error::Error>>(())
//! ```
//!
//! ## Security Considerations
//!
//! - Always validate oracle data freshness with appropriate `max_age` values
//! - Use minimum sample counts for critical operations
//! - Verify feed signatures in production environments
//! - Monitor for stale data and implement appropriate fallback mechanisms
//!
//! ## Feature Flags
//!
//! - `client` - Enable RPC client functionality
//! - `anchor` - Enable Anchor framework integration

// ===== Feature compatibility checks =====
// These compile errors catch mutually exclusive features at build time

#[cfg(all(feature = "solana-v2", feature = "solana-v3"))]
compile_error!("Cannot enable both 'solana-v2' and 'solana-v3' features. Choose one: use 'solana-v2' for production or 'solana-v3' for experimental builds.");

#[cfg(all(feature = "client", feature = "client-v3"))]
compile_error!("Cannot enable both 'client' (v2) and 'client-v3' features. Use 'client' for Solana v2 or 'client-v3' for Solana v3.");

#[cfg(all(feature = "client-v2", feature = "client-v3"))]
compile_error!("Cannot enable both 'client-v2' and 'client-v3' features. Choose one client version.");

// When both solana-v2 and client features are enabled, provide type compatibility layers
#[cfg(all(feature = "solana-v2", feature = "client"))]
pub mod v2_client_compat;

#[cfg(all(feature = "solana-v2", feature = "client"))]
pub mod instruction_compat;

#[cfg(all(feature = "solana-v2", feature = "client"))]
pub use instruction_compat::CompatInstruction;
#[cfg(all(feature = "solana-v2", feature = "client"))]
pub use v2_client_compat::IntoV2Instruction;

// Implement the conversion trait at crate root so it's always available
#[cfg(all(feature = "solana-v2", feature = "client"))]
impl instruction_compat::mixed_version::IntoInstructionBytes
    for anchor_lang::solana_program::instruction::Instruction
{
    fn into_bytes(self) -> ([u8; 32], Vec<([u8; 32], bool, bool)>, Vec<u8>) {
        let program_id_bytes = self.program_id.to_bytes();
        let accounts_data: Vec<([u8; 32], bool, bool)> = self
            .accounts
            .into_iter()
            .map(|meta| (meta.pubkey.to_bytes(), meta.is_signer, meta.is_writable))
            .collect();
        (program_id_bytes, accounts_data, self.data)
    }
}

mod macros;
#[allow(unused_imports)]
use std::sync::Arc;

/// Current SDK version
pub const VERSION: &str = env!("CARGO_PKG_VERSION");

/// SDK name for identification
pub const SDK_NAME: &str = "switchboard-on-demand";

/// Supported Switchboard On-Demand program versions on Solana
pub const SUPPORTED_PROGRAM_VERSIONS: &[&str] = &["0.7.0"];

/// Minimum supported Solana version for compatibility
pub const MIN_SOLANA_VERSION: &str = "1.18.0";

/// Decimal number utilities for handling Switchboard oracle data
pub mod decimal;
pub use decimal::*;

/// Small vector types with compact length prefixes for Borsh serialization
pub mod smallvec;

/// Core oracle functionality for on-demand data feeds
pub mod on_demand;
pub use on_demand::*;

/// Utility functions and helpers
pub mod utils;
pub use utils::*;

/// Traits extracted from anchor-lang to avoid dependency conflicts
pub mod anchor_traits;
pub use anchor_traits::*;

/// Solana program ID constants
pub mod program_id;
pub use program_id::*;

/// Solana account definitions and parsers
pub mod accounts;
/// Solana instruction builders and processors
pub mod instructions;
/// Common type definitions
pub mod types;

/// Re-exports of commonly used types and traits for convenience
pub mod prelude;

/// Solana version compatibility layer
pub mod solana_compat;

// Re-export everything from solana_compat for internal use
pub use solana_compat::{solana_program, AccountMeta, Instruction, Pubkey, SYSTEM_PROGRAM_ID};

// Re-export solana_sdk for client code (when client feature is enabled)
#[cfg(feature = "client")]
pub use solana_compat::solana_sdk;

/// Solana sysvar utilities
pub mod sysvar;
pub use sysvar::*;

/// AccountInfo compatibility layer
mod account_info_compat;
pub use account_info_compat::{AccountInfo, AsAccountInfo};

cfg_client! {
    use anchor_client::solana_sdk::signer::keypair::Keypair;
    pub type AnchorClient = anchor_client::Client<Arc<Keypair>>;
    pub type RpcClient = anchor_client::solana_client::nonblocking::rpc_client::RpcClient;

    /// Client functionality for off-chain interactions with Switchboard On-Demand
    ///
    /// This module provides comprehensive tools for interacting with the Switchboard
    /// Oracle Network and Crossbar API, including:
    /// - Gateway and Crossbar API clients
    /// - Pull feed management
    /// - Oracle job definitions
    /// - Transaction builders
    /// - Cryptographic utilities
    ///
    /// Enable this module with the `client` feature flag.
    ///
    /// Access client functionality via the `client` module to avoid naming conflicts.
    /// For example: `use switchboard_on_demand::client::{Gateway, PullFeed};`
    pub mod client;

    /// Returns the appropriate Switchboard On-Demand program ID for the current network.
    ///
    /// This client-compatible version returns anchor_lang::prelude::Pubkey type.
    pub fn get_switchboard_on_demand_program_id() -> anchor_lang::prelude::Pubkey {
        use anchor_lang::prelude::Pubkey;
        if is_devnet() {
            Pubkey::from(crate::ON_DEMAND_DEVNET_PID.to_bytes())
        } else {
            Pubkey::from(crate::ON_DEMAND_MAINNET_PID.to_bytes())
        }
    }

    /// Determines if the devnet environment is enabled for client usage.
    pub fn is_devnet() -> bool {
        cfg!(feature = "devnet") || std::env::var("SB_ENV").unwrap_or_default() == "devnet"
    }

    /// Seed bytes for deriving the Switchboard state account PDA.
    pub const STATE_SEED: &[u8] = b"STATE";

    /// Seed bytes for deriving oracle feed statistics account PDAs.
    pub const ORACLE_FEED_STATS_SEED: &[u8] = b"OracleFeedStats";

    /// Seed bytes for deriving oracle randomness statistics account PDAs.
    pub const ORACLE_RANDOMNESS_STATS_SEED: &[u8] = b"OracleRandomnessStats";

    /// Seed bytes for deriving oracle statistics account PDAs.
    pub const ORACLE_STATS_SEED: &[u8] = b"OracleStats";

    /// Seed bytes for deriving lookup table signer account PDAs.
    pub const LUT_SIGNER_SEED: &[u8] = b"LutSigner";

    /// Seed bytes for deriving delegation account PDAs.
    pub const DELEGATION_SEED: &[u8] = b"Delegation";

    /// Seed bytes for deriving delegation group account PDAs.
    pub const DELEGATION_GROUP_SEED: &[u8] = b"Group";

    /// Seed bytes for deriving reward pool vault account PDAs.
    pub const REWARD_POOL_VAULT_SEED: &[u8] = b"RewardPool";
}
