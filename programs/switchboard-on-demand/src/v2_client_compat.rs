//! Type compatibility layer for using solana-v2 with client features
//!
//! When both features are enabled, this module provides conversion utilities
//! between Solana SDK v2 types (used by on-chain code) and Solana SDK v3 types
//! (used by anchor-client).

use anchor_client::solana_sdk;

/// Convert v3 Instruction to v2 Instruction
///
/// This accepts the specific anchor_lang::solana_program::instruction::Instruction type
/// and converts it to v2 by extracting bytes and reconstructing.
pub fn instruction_v3_to_v2(
    ix: anchor_lang::solana_program::instruction::Instruction,
) -> crate::solana_compat::Instruction {
    crate::solana_compat::Instruction {
        program_id: crate::solana_compat::Pubkey::from(ix.program_id.to_bytes()),
        accounts: ix
            .accounts
            .into_iter()
            .map(|meta| crate::solana_compat::AccountMeta {
                pubkey: crate::solana_compat::Pubkey::from(meta.pubkey.to_bytes()),
                is_signer: meta.is_signer,
                is_writable: meta.is_writable,
            })
            .collect(),
        data: ix.data,
    }
}

/// Trait for converting any instruction type to v2
pub trait IntoV2Instruction {
    fn into_v2_instruction(self) -> crate::solana_compat::Instruction;
}

/// Implement for anchor_lang's solana_program Instruction type
///
/// When anchor feature is enabled, `use anchor_lang::solana_program` brings this type into scope,
/// and this is what cfg_client! blocks use
impl IntoV2Instruction for anchor_lang::solana_program::instruction::Instruction {
    fn into_v2_instruction(self) -> crate::solana_compat::Instruction {
        crate::solana_compat::Instruction {
            program_id: crate::solana_compat::Pubkey::from(self.program_id.to_bytes()),
            accounts: self
                .accounts
                .into_iter()
                .map(|meta| crate::solana_compat::AccountMeta {
                    pubkey: crate::solana_compat::Pubkey::from(meta.pubkey.to_bytes()),
                    is_signer: meta.is_signer,
                    is_writable: meta.is_writable,
                })
                .collect(),
            data: self.data,
        }
    }
}

/// Convert a Solana v2 Instruction to v3 Instruction
pub fn instruction_v2_to_v3(
    ix: crate::solana_compat::Instruction,
) -> solana_sdk::instruction::Instruction {
    solana_sdk::instruction::Instruction {
        program_id: pubkey_v2_to_v3(ix.program_id),
        accounts: ix.accounts.into_iter().map(account_meta_v2_to_v3).collect(),
        data: ix.data,
    }
}

/// Convert a Solana v3 Pubkey to v2 Pubkey
pub fn pubkey_v3_to_v2(pubkey: solana_sdk::pubkey::Pubkey) -> crate::solana_compat::Pubkey {
    crate::solana_compat::Pubkey::from(pubkey.to_bytes())
}

/// Convert a Solana v2 Pubkey to v3 Pubkey
pub fn pubkey_v2_to_v3(pubkey: crate::solana_compat::Pubkey) -> solana_sdk::pubkey::Pubkey {
    solana_sdk::pubkey::Pubkey::from(pubkey.to_bytes())
}

/// Convert a Solana v3 AccountMeta to v2 AccountMeta
pub fn account_meta_v3_to_v2(
    meta: solana_sdk::instruction::AccountMeta,
) -> crate::solana_compat::AccountMeta {
    crate::solana_compat::AccountMeta {
        pubkey: pubkey_v3_to_v2(meta.pubkey),
        is_signer: meta.is_signer,
        is_writable: meta.is_writable,
    }
}

/// Convert a Solana v2 AccountMeta to v3 AccountMeta
pub fn account_meta_v2_to_v3(
    meta: crate::solana_compat::AccountMeta,
) -> solana_sdk::instruction::AccountMeta {
    if meta.is_writable {
        if meta.is_signer {
            solana_sdk::instruction::AccountMeta::new(pubkey_v2_to_v3(meta.pubkey), true)
        } else {
            solana_sdk::instruction::AccountMeta::new(pubkey_v2_to_v3(meta.pubkey), false)
        }
    } else if meta.is_signer {
        solana_sdk::instruction::AccountMeta::new_readonly(pubkey_v2_to_v3(meta.pubkey), true)
    } else {
        solana_sdk::instruction::AccountMeta::new_readonly(pubkey_v2_to_v3(meta.pubkey), false)
    }
}
