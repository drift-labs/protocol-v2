use borsh::BorshSerialize;
use solana_program::instruction::{AccountMeta, Instruction};

use crate::anchor_traits::*;
use crate::prelude::*;
use crate::{get_sb_program_id, solana_program, Pubkey};

/// Switchboard permission types
#[repr(u32)]
#[derive(Copy, Clone)]
pub enum SwitchboardPermission {
    /// No permissions granted
    None = 0,
    /// Permission to send oracle heartbeat
    PermitOracleHeartbeat = 1 << 0,
    /// Permission to use oracle queue
    PermitOracleQueueUsage = 1 << 1,
}

/// Attestation permission set instruction
pub struct AttestationPermissionSet {}

/// Parameters for attestation permission set instruction
#[derive(Clone, BorshSerialize, Debug)]
pub struct AttestationPermissionSetParams {
    /// Permission type to modify
    pub permission: u8,
    /// Whether to enable or disable the permission
    pub enable: bool,
}

impl InstructionData for AttestationPermissionSetParams {}

const DISCRIMINATOR: &[u8] = &[211, 122, 185, 120, 129, 182, 55, 103];
impl Discriminator for AttestationPermissionSetParams {
    const DISCRIMINATOR: &[u8] = DISCRIMINATOR;
}

impl Discriminator for AttestationPermissionSet {
    const DISCRIMINATOR: &[u8] = DISCRIMINATOR;
}

/// Account metas for attestation permission set instruction
pub struct AttestationPermissionSetAccounts {
    /// Authority account public key
    pub authority: Pubkey,
    /// Granter account public key
    pub granter: Pubkey,
    /// Grantee account public key
    pub grantee: Pubkey,
}
impl ToAccountMetas for AttestationPermissionSetAccounts {
    fn to_account_metas(&self, _: Option<bool>) -> Vec<AccountMeta> {
        vec![
            AccountMeta::new_readonly(self.authority, true),
            AccountMeta::new_readonly(self.granter, false),
            AccountMeta::new(self.grantee, false),
        ]
    }
}

impl AttestationPermissionSet {
    /// Builds an attestation permission set instruction
    pub fn build_ix(
        granter: Pubkey,
        authority: Pubkey,
        grantee: Pubkey,
        permission: SwitchboardPermission,
        enable: bool,
    ) -> Result<Instruction, OnDemandError> {
        let pid = if crate::utils::is_devnet() {
            get_sb_program_id("devnet")
        } else {
            get_sb_program_id("mainnet")
        };
        Ok(crate::utils::build_ix(
            &pid,
            &AttestationPermissionSetAccounts {
                authority,
                granter,
                grantee,
            },
            &AttestationPermissionSetParams {
                permission: permission as u8,
                enable,
            },
        ))
    }
}
