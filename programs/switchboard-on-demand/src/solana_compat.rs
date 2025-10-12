//! Solana version compatibility layer
//!
//! This module provides compatibility between different Solana versions,
//! ensuring the correct types and modules are available regardless of which
//! version of the Solana SDK is being used.

// ===== Compile-time feature compatibility checks =====

// Ensure only one Solana version is enabled
#[cfg(all(feature = "solana-v2", feature = "solana-v3"))]
compile_error!("Cannot enable both 'solana-v2' and 'solana-v3' features at the same time. Choose one.");

// Ensure only one client version is enabled
#[cfg(all(feature = "client", feature = "client-v3"))]
compile_error!("Cannot enable both 'client' and 'client-v3' features at the same time. Use 'client' for Solana v2 or 'client-v3' for Solana v3.");

#[cfg(all(feature = "client-v2", feature = "client-v3"))]
compile_error!("Cannot enable both 'client-v2' and 'client-v3' features at the same time. Use 'client-v2' for Solana v2 or 'client-v3' for Solana v3.");

// When anchor is enabled, use anchor's solana_program (v2.x)
#[cfg(feature = "anchor")]
pub use anchor_lang::solana_program;

// When anchor is NOT enabled, use version-specific solana_program
// v3 takes precedence when both v2 and v3 are enabled
#[cfg(all(not(feature = "anchor"), feature = "solana-v3"))]
pub extern crate solana_program_v3;
#[cfg(all(not(feature = "anchor"), feature = "solana-v3"))]
pub use solana_program_v3 as solana_program;

#[cfg(all(
    not(feature = "anchor"),
    not(feature = "solana-v3"),
    feature = "solana-v2"
))]
pub use solana_program as solana_program;

// Default to using anchor's solana_program when no specific version is enabled
#[cfg(all(
    not(feature = "anchor"),
    not(feature = "solana-v2"),
    not(feature = "solana-v3")
))]
pub use anchor_lang::solana_program;

// ===== solana_sdk (only when client is enabled) =====
// The client feature requires anchor-client, which provides solana_sdk

// When client is enabled, use anchor_client's solana_sdk (which is v2)
#[cfg(feature = "client")]
pub use anchor_client::solana_sdk;

// ===== solana_client (when client or client-v3 is enabled) =====
// Version-specific solana-client selection based on features

// When client-v3 is enabled, use solana-client v3
#[cfg(feature = "client-v3")]
pub use solana_client_v3 as solana_client;

// When client is enabled (default v2), use solana-client v2
#[cfg(feature = "client")]
pub use solana_client_v2 as solana_client;

// Re-export common types for easier access
pub use solana_program::{
    account_info::AccountInfo,
    hash,
    instruction::{AccountMeta, Instruction},
    msg,
    pubkey::Pubkey,
    sysvar,
};

// pubkey! macro is exported at the crate root
pub use solana_program::pubkey;

// System program ID constant (same across all versions)
pub const SYSTEM_PROGRAM_ID: Pubkey = pubkey!("11111111111111111111111111111111");

// Address lookup table program ID constant
pub const ADDRESS_LOOKUP_TABLE_PROGRAM_ID: Pubkey =
    pubkey!("AddressLookupTab1e1111111111111111111111111");

// Re-export sol_memcpy_ based on version
// In v2, it's a direct import from the definitions module
#[cfg(any(feature = "anchor", feature = "solana-v2"))]
extern "C" {
    pub fn sol_memcpy_(dst: *mut u8, src: *const u8, n: u64);
}

// In v3+, declare it as extern (syscalls module doesn't re-export it)
#[cfg(all(not(feature = "anchor"), not(feature = "solana-v2")))]
extern "C" {
    pub fn sol_memcpy_(dst: *mut u8, src: *const u8, n: u64);
}
