use crate::state::traits::Size;
use anchor_lang::prelude::*;
use solana_program::pubkey::Pubkey;

#[account(zero_copy(unsafe))]
#[derive(Default, Eq, PartialEq, Debug)]
#[repr(C)]
pub struct AdminConfig {
    pub fast_signer: Pubkey,
    pub slow_signer: Pubkey,
    pub padding: [u128; 16],
}

impl Size for AdminConfig {
    const SIZE: usize = 328;
}

impl AdminConfig {
    pub fn is_fast_signer(&self, signer: Pubkey) -> bool {
        self.fast_signer == signer
    }

    pub fn is_slow_signer(&self, signer: Pubkey) -> bool {
        self.slow_signer == signer
    }
}
