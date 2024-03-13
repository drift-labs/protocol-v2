use crate::state::traits::Size;
use anchor_lang::prelude::*;
use solana_program::pubkey::Pubkey;

#[account(zero_copy(unsafe))]
#[derive(Default, Eq, PartialEq, Debug)]
#[repr(C)]
pub struct AdminElectionConfig {
    pub election_signer: Pubkey,
    pub padding: [u128; 16],
}

impl Size for AdminElectionConfig {
    const SIZE: usize = 32 + 264;
}

impl AdminElectionConfig {
    pub fn is_election_signer(&self, signer: Pubkey) -> bool {
        self.election_signer == signer
    }
}