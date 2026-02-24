use borsh::BorshSerialize;
use solana_program::instruction::{AccountMeta, Instruction};
use solana_program::sysvar::slot_hashes;

use crate::anchor_traits::*;
use crate::prelude::*;
use crate::{get_sb_program_id, solana_program, Pubkey};

/// Guardian quote verification instruction
pub struct GuardianQuoteVerify {}

/// Parameters for guardian quote verification instruction
#[derive(Clone, Debug)]
pub struct GuardianQuoteVerifyParams {
    /// Unix timestamp of the verification
    pub timestamp: i64,
    /// MR_ENCLAVE measurement from the trusted execution environment
    pub mr_enclave: [u8; 32],
    /// Index of the oracle in the queue
    pub idx: u32,
    /// ED25519 public key for signature verification
    pub ed25519_key: Pubkey,
    /// SECP256K1 public key (64 bytes)
    pub secp256k1_key: [u8; 64],
    /// Slot number for this verification
    pub slot: u64,
    /// ECDSA signature (64 bytes)
    pub signature: [u8; 64],
    /// Recovery ID for signature verification
    pub recovery_id: u8,
    /// List of security advisories
    pub advisories: Vec<u32>,
}

impl BorshSerialize for GuardianQuoteVerifyParams {
    fn serialize<W: std::io::Write>(&self, writer: &mut W) -> std::io::Result<()> {
        self.timestamp.serialize(writer)?;
        self.mr_enclave.serialize(writer)?;
        self.idx.serialize(writer)?;
        writer.write_all(self.ed25519_key.as_ref())?;
        self.secp256k1_key.serialize(writer)?;
        self.slot.serialize(writer)?;
        self.signature.serialize(writer)?;
        self.recovery_id.serialize(writer)?;
        self.advisories.serialize(writer)?;
        Ok(())
    }
}

impl InstructionData for GuardianQuoteVerifyParams {}

impl Discriminator for GuardianQuoteVerifyParams {
    const DISCRIMINATOR: &[u8] = GuardianQuoteVerify::DISCRIMINATOR;
}

const DISCRIMINATOR: &[u8] = &[168, 36, 93, 156, 157, 150, 148, 45];
impl Discriminator for GuardianQuoteVerify {
    const DISCRIMINATOR: &[u8] = DISCRIMINATOR;
}

/// Arguments for building a guardian quote verification instruction
pub struct GuardianQuoteVerifyArgs {
    /// Guardian account public key
    pub guardian: Pubkey,
    /// Oracle account public key
    pub oracle: Pubkey,
    /// Authority account public key
    pub authority: Pubkey,
    /// Guardian queue account public key
    pub guardian_queue: Pubkey,
    /// Unix timestamp of the verification
    pub timestamp: i64,
    /// MR_ENCLAVE measurement from the trusted execution environment
    pub mr_enclave: [u8; 32],
    /// Index of the oracle in the queue
    pub idx: u32,
    /// ED25519 public key for signature verification
    pub ed25519_key: Pubkey,
    /// SECP256K1 public key (64 bytes)
    pub secp256k1_key: [u8; 64],
    /// Slot number for this verification
    pub slot: u64,
    /// ECDSA signature (64 bytes)
    pub signature: [u8; 64],
    /// Recovery ID for signature verification
    pub recovery_id: u8,
    /// List of security advisories
    pub advisories: Vec<u32>,
}
/// Account metas for guardian quote verification instruction
pub struct GuardianQuoteVerifyAccounts {
    /// Guardian account public key
    pub guardian: Pubkey,
    /// Oracle account public key
    pub oracle: Pubkey,
    /// Authority account public key
    pub authority: Pubkey,
    /// Guardian queue account public key
    pub guardian_queue: Pubkey,
    /// Global state account public key
    pub state: Pubkey,
    /// Recent slot hashes sysvar account
    pub recent_slothashes: Pubkey,
}
impl ToAccountMetas for GuardianQuoteVerifyAccounts {
    fn to_account_metas(&self, _: Option<bool>) -> Vec<AccountMeta> {
        vec![
            AccountMeta::new(self.guardian, false),
            AccountMeta::new(self.oracle, false),
            AccountMeta::new_readonly(self.authority, true),
            AccountMeta::new(self.guardian_queue, false),
            AccountMeta::new_readonly(self.state, false),
            AccountMeta::new_readonly(self.recent_slothashes, false),
        ]
    }
}

impl GuardianQuoteVerify {
    /// Builds a guardian quote verification instruction
    pub fn build_ix(args: GuardianQuoteVerifyArgs) -> Result<Instruction, OnDemandError> {
        let pid = if crate::utils::is_devnet() {
            get_sb_program_id("devnet")
        } else {
            get_sb_program_id("mainnet")
        };
        Ok(crate::utils::build_ix(
            &pid,
            &GuardianQuoteVerifyAccounts {
                guardian: args.guardian,
                oracle: args.oracle,
                authority: args.authority,
                guardian_queue: args.guardian_queue,
                state: State::get_pda(),
                recent_slothashes: slot_hashes::ID,
            },
            &GuardianQuoteVerifyParams {
                timestamp: args.timestamp,
                mr_enclave: args.mr_enclave,
                idx: args.idx,
                ed25519_key: args.ed25519_key,
                secp256k1_key: args.secp256k1_key,
                slot: args.slot,
                signature: args.signature,
                recovery_id: args.recovery_id,
                advisories: args.advisories,
            },
        ))
    }
}
