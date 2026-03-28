use {
    crate::{signature, signature::VerifiedMessage},
    anchor_lang::{prelude::*, solana_program::pubkey::PUBKEY_BYTES},
    solana_program::pubkey,
    std::mem::size_of,
};

pub use crate::signature::{ed25519_program_args, Ed25519SignatureOffsets};

pub const STORAGE_ID: Pubkey = pubkey!("3rdJbqfnagQ4yx9HXJViD4zc4xpiSqmFsKpPuSCQVyQL");

pub const ANCHOR_DISCRIMINATOR_BYTES: usize = 8;
pub const MAX_NUM_TRUSTED_SIGNERS: usize = 2;
pub const SPACE_FOR_TRUSTED_SIGNERS: usize = 5;
pub const EXTRA_SPACE: usize = 100;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, AnchorSerialize, AnchorDeserialize)]
pub struct TrustedSignerInfo {
    pub pubkey: Pubkey,
    pub expires_at: i64,
}

impl TrustedSignerInfo {
    const SERIALIZED_LEN: usize = PUBKEY_BYTES + size_of::<i64>();
}

#[account]
pub struct Storage {
    pub top_authority: Pubkey,
    pub treasury: Pubkey,
    pub single_update_fee_in_lamports: u64,
    pub num_trusted_signers: u8,
    pub trusted_signers: [TrustedSignerInfo; SPACE_FOR_TRUSTED_SIGNERS],
    pub _extra_space: [u8; EXTRA_SPACE],
}

impl Storage {
    const SERIALIZED_LEN: usize = PUBKEY_BYTES
        + PUBKEY_BYTES
        + size_of::<u64>()
        + size_of::<u8>()
        + TrustedSignerInfo::SERIALIZED_LEN * SPACE_FOR_TRUSTED_SIGNERS
        + EXTRA_SPACE;

    pub fn initialized_trusted_signers(&self) -> &[TrustedSignerInfo] {
        &self.trusted_signers[0..usize::from(self.num_trusted_signers)]
    }
}

pub const STORAGE_SEED: &[u8] = b"storage";

#[cfg(not(feature = "program"))]
#[allow(dead_code)]
pub mod program {}

pub fn verify_message_direct<'a>(
    pyth_storage_account: &Storage,
    instruction_sysvar: &AccountInfo,
    message_data: &'a [u8],
    ed25519_instruction_index: u16,
    signature_index: u8,
) -> Result<VerifiedMessage> {
    signature::verify_message(
        pyth_storage_account,
        instruction_sysvar,
        &message_data,
        ed25519_instruction_index,
        signature_index,
    )
    .map_err(|err| {
        msg!("signature verification error: {:?}", err);
        err.into()
    })
}
