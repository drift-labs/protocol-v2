use anchor_lang::prelude::borsh::BorshSerialize;
use crate::solana_program::instruction::AccountMeta;
use crate::Pubkey;

/// Traits pulled out of anchor-lang library to remove dependency conflicts
/// for users.
pub trait Discriminator {
    /// The 8-byte discriminator used to identify the account or instruction type
    const DISCRIMINATOR: &'static [u8];

    /// Returns the discriminator for this type
    fn discriminator() -> &'static [u8] {
        Self::DISCRIMINATOR
    }
}

/// Trait for types that have an owner program
pub trait Owner {
    /// Returns the program ID that owns this account type
    fn owner() -> Pubkey;
}

/// Trait marker for zero-copy deserialization
pub trait ZeroCopy {}

/// Trait for converting types to Solana account metas
pub trait ToAccountMetas {
    /// `is_signer` is given as an optional override for the signer meta field.
    /// This covers the edge case when a program-derived-address needs to relay
    /// a transaction from a client to another program but sign the transaction
    /// before the relay. The client cannot mark the field as a signer, and so
    /// we have to override the is_signer meta field given by the client.
    fn to_account_metas(&self, is_signer: Option<bool>) -> Vec<AccountMeta>;
}

/// Calculates the data for an instruction invocation, where the data is
/// `Sha256(<namespace>:<method_name>)[..8] || BorshSerialize(args)`.
/// `args` is a borsh serialized struct of named fields for each argument given
/// to an instruction.
pub trait InstructionData: Discriminator + BorshSerialize {
    /// Serializes the instruction data with discriminator prefix
    fn data(&self) -> Vec<u8> {
        let mut d = Self::DISCRIMINATOR.to_vec();
        d.append(&mut anchor_lang::prelude::borsh::to_vec(self).expect("Should always serialize"));
        d
    }
}
