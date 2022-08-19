use anchor_lang::prelude::*;

#[account(zero_copy)]
#[derive(Default, Eq, PartialEq, Debug)]
#[repr(packed)]
pub struct InsuranceFundStake {
    pub authority: Pubkey,
    pub bank_index: u64,
    pub lp_shares: u128,
    pub last_withdraw_request_shares: u128, // get zero as 0 when not in escrow
    pub last_withdraw_request_value: u128,
    pub last_withdraw_request_ts: i64,
}
