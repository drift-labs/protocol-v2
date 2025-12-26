use borsh::BorshSerialize;
use solana_program::instruction::{AccountMeta, Instruction};

use crate::anchor_traits::*;
use crate::prelude::*;
use crate::{get_sb_program_id, solana_program, Pubkey};

/// Queue garbage collection instruction
pub struct QueueGarbageCollect {}

/// Parameters for queue garbage collection instruction
#[derive(Clone, BorshSerialize, Debug)]
pub struct QueueGarbageCollectParams {
    /// Index of the oracle to garbage collect
    pub idx: u32,
}

impl InstructionData for QueueGarbageCollectParams {}
const DISCRIMINATOR: &[u8] = &[187, 208, 104, 247, 16, 91, 96, 98];
impl Discriminator for QueueGarbageCollect {
    const DISCRIMINATOR: &[u8] = DISCRIMINATOR;
}
impl Discriminator for QueueGarbageCollectParams {
    const DISCRIMINATOR: &[u8] = DISCRIMINATOR;
}

/// Arguments for building a queue garbage collection instruction
pub struct QueueGarbageCollectArgs {
    /// Queue account public key
    pub queue: Pubkey,
    /// Oracle account public key
    pub oracle: Pubkey,
    /// Index of the oracle to garbage collect
    pub idx: u32,
}
/// Account metas for queue garbage collection instruction
pub struct QueueGarbageCollectAccounts {
    /// Queue account public key
    pub queue: Pubkey,
    /// Oracle account public key
    pub oracle: Pubkey,
}
impl ToAccountMetas for QueueGarbageCollectAccounts {
    fn to_account_metas(&self, _: Option<bool>) -> Vec<AccountMeta> {
        vec![
            AccountMeta::new(self.queue, false),
            AccountMeta::new(self.oracle, false),
        ]
    }
}

impl QueueGarbageCollect {
    /// Builds a queue garbage collection instruction
    pub fn build_ix(args: QueueGarbageCollectArgs) -> Result<Instruction, OnDemandError> {
        let pid = if crate::utils::is_devnet() {
            get_sb_program_id("devnet")
        } else {
            get_sb_program_id("mainnet")
        };
        Ok(crate::utils::build_ix(
            &pid,
            &QueueGarbageCollectAccounts {
                queue: args.queue,
                oracle: args.oracle,
            },
            &QueueGarbageCollectParams { idx: args.idx },
        ))
    }
}
