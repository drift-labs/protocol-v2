use super::get_discriminator;
use borsh::{BorshDeserialize, BorshSerialize};
use crate::AccountMeta;
use crate::Pubkey;

#[derive(Clone, Debug)]
pub struct PullFeedSubmitResponse {
    pub feed: Pubkey,
    pub queue: Pubkey,
    pub program_state: Pubkey,
    pub recent_slothashes: Pubkey,
    pub payer: Pubkey,
    pub system_program: Pubkey,
    pub reward_vault: Pubkey,
    pub token_program: Pubkey,
    pub token_mint: Pubkey,
}

impl PullFeedSubmitResponse {
    pub fn to_account_metas(&self, _is_signer: Option<bool>) -> Vec<AccountMeta> {
        vec![
            AccountMeta::new(self.feed, false),
            AccountMeta::new_readonly(self.queue, false),
            AccountMeta::new_readonly(self.program_state, false),
            AccountMeta::new_readonly(self.recent_slothashes, false),
            AccountMeta::new(self.payer, true),
            AccountMeta::new_readonly(self.system_program, false),
            AccountMeta::new(self.reward_vault, false),
            AccountMeta::new_readonly(self.token_program, false),
            AccountMeta::new_readonly(self.token_mint, false),
        ]
    }
}

// 82 bytes
#[derive(Clone, BorshSerialize, BorshDeserialize)]
pub struct Submission {
    pub value: i128,
    pub signature: [u8; 64],
    pub recovery_id: u8,
    // If the oracle failed to produce response at the user request slot and it
    // responds with an older signed vlaue state which slot its signed with by
    // offset of requested.
    pub offset: u8,
}
#[derive(Clone, BorshSerialize, BorshDeserialize)]
pub struct PullFeedSubmitResponseParams {
    pub slot: u64,
    pub submissions: Vec<Submission>,
}
impl PullFeedSubmitResponseParams {
    pub fn to_vec(&self) -> Vec<u8> {
        let mut buffer: Vec<u8> = Vec::new();
        self.serialize(&mut buffer).unwrap();
        buffer
    }

    pub fn data(&self) -> Vec<u8> {
        let mut res = get_discriminator("pull_feed_submit_response").to_vec();
        res.extend_from_slice(&self.to_vec());
        res
    }
}
