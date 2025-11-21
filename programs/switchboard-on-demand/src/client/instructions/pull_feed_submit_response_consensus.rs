use super::get_discriminator;
use borsh::{BorshDeserialize, BorshSerialize};
use crate::AccountMeta;
use crate::Pubkey;
use anchor_client::solana_sdk::sysvar::instructions;

#[derive(Clone, Debug)]
pub struct PullFeedSubmitResponseConsensus {
    pub queue: Pubkey,
    pub program_state: Pubkey,
    pub recent_slothashes: Pubkey,
    pub payer: Pubkey,
    pub system_program: Pubkey,
    pub reward_vault: Pubkey,
    pub token_program: Pubkey,
    pub token_mint: Pubkey,
}

impl PullFeedSubmitResponseConsensus {
    pub fn to_account_metas(&self, _is_signer: Option<bool>) -> Vec<AccountMeta> {
        vec![
            AccountMeta::new_readonly(self.queue, false),
            AccountMeta::new_readonly(self.program_state, false),
            AccountMeta::new_readonly(self.recent_slothashes, false),
            AccountMeta::new(self.payer, true),
            AccountMeta::new_readonly(self.system_program, false),
            AccountMeta::new(self.reward_vault, false),
            AccountMeta::new_readonly(self.token_program, false),
            AccountMeta::new_readonly(self.token_mint, false),
            AccountMeta::new_readonly(instructions::id().to_bytes().into(), false),
        ]
    }
}

#[derive(Clone, BorshSerialize, BorshDeserialize)]
pub struct PullFeedSubmitResponseConsensusParams {
    pub slot: u64,
    pub values: Vec<i128>,
}

impl PullFeedSubmitResponseConsensusParams {
    pub fn to_vec(&self) -> Vec<u8> {
        let mut buffer: Vec<u8> = Vec::new();
        self.serialize(&mut buffer).unwrap();
        buffer
    }

    pub fn data(&self) -> Vec<u8> {
        let mut res = get_discriminator("pull_feed_submit_response_consensus").to_vec();
        res.extend_from_slice(&self.to_vec());
        res
    }
}
