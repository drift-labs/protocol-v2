use anchor_lang::prelude::*;

#[account(zero_copy)]
#[derive(Default, Eq, PartialEq, Debug)]
#[repr(packed)]
pub struct InsuranceFundStake {
    pub authority: Pubkey,
    pub bank_index: u64,
}
