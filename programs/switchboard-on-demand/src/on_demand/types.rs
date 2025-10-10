use solana_program::sysvar::clock::Clock;

use crate::{solana_program, Pubkey, VerificationStatus};

/// MR_ENCLAVE measurement type (32 bytes)
pub type MrEnclave = [u8; 32];

/// TEE quote verification data structure
#[repr(C)]
#[derive(Debug, Copy, Clone, bytemuck::Zeroable, bytemuck::Pod)]
pub struct Quote {
    /// The address of the signer generated within an enclave.
    pub enclave_signer: Pubkey,
    /// The quotes MRENCLAVE measurement dictating the contents of the secure enclave.
    pub mr_enclave: [u8; 32],
    /// The VerificationStatus of the quote.
    pub verification_status: u8,
    padding1: [u8; 7],
    /// The unix timestamp when the quote was last verified.
    pub verification_timestamp: i64,
    /// The unix timestamp when the quotes verification status expires.
    pub valid_until: i64,
    /// The off-chain registry where the verifiers quote can be located.
    pub quote_registry: [u8; 32],
    /// Key to lookup the buffer data in decentralized storage solutions.
    pub registry_key: [u8; 64],
    /// The secp256k1 public key of the enclave signer. Derived from the enclave_signer.
    pub secp256k1_signer: [u8; 64],
    /// Last ED25519 signer public key
    pub last_ed25519_signer: Pubkey,
    /// Last SECP256K1 signer public key (64 bytes)
    pub last_secp256k1_signer: [u8; 64],
    /// Slot number when keys were last rotated
    pub last_rotate_slot: u64,
    /// Array of guardian approver public keys
    pub guardian_approvers: [Pubkey; 64],
    /// Number of active guardian approvers
    pub guardian_approvers_len: u8,
    padding2: [u8; 7],
    /// Reserved.
    pub _ebuf: [u8; 1024],
}
impl Default for Quote {
    fn default() -> Self {
        unsafe { std::mem::zeroed() }
    }
}
impl Quote {
    /// Checks if the quote is currently verified based on clock
    pub fn is_verified(&self, clock: &Clock) -> bool {
        match self.verification_status.into() {
            VerificationStatus::VerificationOverride => true,
            VerificationStatus::VerificationSuccess => self.valid_until > clock.unix_timestamp,
            _ => false,
        }
    }
}
