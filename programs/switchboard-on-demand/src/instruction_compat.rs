//! Instruction compatibility layer for mixed Solana SDK versions
//!
//! When both solana-v2 and client features are enabled, this module provides
//! a unified Instruction type that can be used throughout the codebase.

#[cfg(all(feature = "solana-v2", feature = "client"))]
use anchor_lang::solana_program as v3_program;

#[cfg(all(feature = "solana-v2", feature = "client"))]
use crate::solana_compat as v2_compat;

/// When both features are enabled, create wrapper types that can convert between versions
#[cfg(all(feature = "solana-v2", feature = "client"))]
pub mod mixed_version {
    use super::*;

    /// Wrapper for instructions that need to work with both SDK versions
    pub struct CompatInstruction {
        inner_v3: v3_program::instruction::Instruction,
    }

    impl CompatInstruction {
        /// Create from v3 Instruction (used by build_ix when anchor is enabled)
        pub fn from_v3(ix: v3_program::instruction::Instruction) -> Self {
            Self { inner_v3: ix }
        }

        /// Convert to v2 Instruction for return values
        pub fn to_v2(self) -> v2_compat::Instruction {
            v2_compat::Instruction {
                program_id: v2_compat::Pubkey::from(self.inner_v3.program_id.to_bytes()),
                accounts: self
                    .inner_v3
                    .accounts
                    .into_iter()
                    .map(|meta| v2_compat::AccountMeta {
                        pubkey: v2_compat::Pubkey::from(meta.pubkey.to_bytes()),
                        is_signer: meta.is_signer,
                        is_writable: meta.is_writable,
                    })
                    .collect(),
                data: self.inner_v3.data,
            }
        }

        /// Access the inner v3 instruction mutably
        pub fn inner_mut(&mut self) -> &mut v3_program::instruction::Instruction {
            &mut self.inner_v3
        }

        /// Access the inner v3 instruction
        pub fn inner(&self) -> &v3_program::instruction::Instruction {
            &self.inner_v3
        }
    }

    /// Implement From for v3_program path
    impl From<v3_program::instruction::Instruction> for CompatInstruction {
        fn from(ix: v3_program::instruction::Instruction) -> Self {
            Self::from_v3(ix)
        }
    }

    /// Generic conversion function that works with any Instruction type using unsafe transmute
    ///
    /// This is safe because all Solana Instruction types (v2, v3, anchor) have identical memory layout:
    /// - program_id: Pubkey (32 bytes)
    /// - accounts: Vec<AccountMeta>
    /// - data: Vec<u8>
    ///
    /// SAFETY: The caller must ensure the input type has the exact same memory layout as
    /// v3_program::instruction::Instruction
    pub unsafe fn convert_any_instruction_to_compat_unsafe<T>(ix: T) -> CompatInstruction {
        // Transmute to v3 instruction - this is safe because all Solana Instruction types
        // have identical memory layout
        let v3_ix: v3_program::instruction::Instruction = std::mem::transmute_copy(&ix);
        std::mem::forget(ix); // Prevent double-free
        CompatInstruction::from_v3(v3_ix)
    }

    /// Safe wrapper for trait-based conversion
    pub fn convert_any_instruction_to_compat<T>(ix: T) -> CompatInstruction
    where
        T: IntoInstructionBytes,
    {
        let (program_id_bytes, accounts_data, data) = ix.into_bytes();

        // Reconstruct as v3 Instruction
        let v3_ix = v3_program::instruction::Instruction {
            program_id: v3_program::pubkey::Pubkey::from(program_id_bytes),
            accounts: accounts_data
                .into_iter()
                .map(|(pubkey_bytes, is_signer, is_writable)| {
                    if is_writable {
                        if is_signer {
                            v3_program::instruction::AccountMeta::new(
                                v3_program::pubkey::Pubkey::from(pubkey_bytes),
                                true,
                            )
                        } else {
                            v3_program::instruction::AccountMeta::new(
                                v3_program::pubkey::Pubkey::from(pubkey_bytes),
                                false,
                            )
                        }
                    } else if is_signer {
                        v3_program::instruction::AccountMeta::new_readonly(
                            v3_program::pubkey::Pubkey::from(pubkey_bytes),
                            true,
                        )
                    } else {
                        v3_program::instruction::AccountMeta::new_readonly(
                            v3_program::pubkey::Pubkey::from(pubkey_bytes),
                            false,
                        )
                    }
                })
                .collect(),
            data,
        };

        CompatInstruction::from_v3(v3_ix)
    }

    /// Trait for extracting bytes from any Instruction type
    ///
    /// This trait is implemented at the crate root (lib.rs) to ensure it's always in scope
    pub trait IntoInstructionBytes {
        fn into_bytes(self) -> ([u8; 32], Vec<([u8; 32], bool, bool)>, Vec<u8>);
    }
}

/// Macro helper to convert any instruction type
#[cfg(all(feature = "solana-v2", feature = "client"))]
#[macro_export]
macro_rules! to_compat_ix {
    ($ix:expr) => {{
        $crate::instruction_compat::mixed_version::convert_any_instruction_to_compat($ix)
    }};
}

/// Re-export for convenience
#[cfg(all(feature = "solana-v2", feature = "client"))]
pub use mixed_version::CompatInstruction;
