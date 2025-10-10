#![allow(unused_attributes)]
use switchboard_common::cfg_client;

use crate::anchor_traits::*;
use crate::{get_sb_program_id, Pubkey};

/// Oracle performance information for a specific epoch
#[derive(Default)]
#[repr(C)]
#[derive(bytemuck::Zeroable, bytemuck::Pod, Debug, Copy, Clone)]
pub struct OracleEpochInfo {
    /// Unique identifier for this epoch
    pub id: u64,
    /// Reserved field for future use
    pub reserved1: u64,
    /// Slot number when this epoch ended
    pub slot_end: u64,
    /// Penalty score for oracle misbehavior
    pub slash_score: u64,
    /// Reward score based on oracle performance
    pub reward_score: u64,
    /// Stake-weighted performance score
    pub stake_score: u64,
}

/// Information about mega-slot performance tracking
#[derive(Default)]
#[repr(C)]
#[derive(bytemuck::Zeroable, bytemuck::Pod, Debug, Copy, Clone)]
pub struct MegaSlotInfo {
    /// Reserved field for future use
    pub reserved1: u64,
    /// Slot number when this mega-slot ended
    pub slot_end: u64,
    /// Performance target for this period
    pub perf_goal: i64,
    /// Current count of oracle signatures
    pub current_signature_count: i64,
}

/// Oracle statistics account data for performance tracking
#[repr(C)]
#[derive(bytemuck::Zeroable, bytemuck::Pod, Debug, Copy, Clone)]
pub struct OracleStatsAccountData {
    /// Owner of the oracle stats account
    pub owner: Pubkey,
    /// Oracle public key these stats belong to
    pub oracle: Pubkey,
    /// The last epoch that has completed. cleared after registered with the
    /// staking program.
    pub finalized_epoch: OracleEpochInfo,
    /// The current epoch info being used by the oracle. for stake. Will moved
    /// to finalized_epoch as soon as the epoch is over.
    pub current_epoch: OracleEpochInfo,
    /// Performance information for mega-slot tracking
    pub mega_slot_info: MegaSlotInfo,
    /// Slot of the last stake transfer
    pub last_transfer_slot: u64,
    /// PDA bump seed for this account
    pub bump: u8,
    /// Padding bytes for alignment
    pub padding1: [u8; 7],
    /// Reserved.
    pub _ebuf: [u8; 1024],
}
impl Owner for OracleStatsAccountData {
    fn owner() -> Pubkey {
        if crate::utils::is_devnet() {
            get_sb_program_id("devnet")
        } else {
            get_sb_program_id("mainnet")
        }
    }
}
impl Discriminator for OracleStatsAccountData {
    const DISCRIMINATOR: &'static [u8] = &[180, 157, 178, 234, 240, 27, 152, 179];
}
cfg_client! {
    use crate::impl_account_deserialize;

    impl_account_deserialize!(OracleStatsAccountData);
}
impl OracleStatsAccountData {
    cfg_client! {

        pub async fn fetch_async(
            client: &crate::RpcClient,
            pubkey: Pubkey,
        ) -> std::result::Result<Self, crate::OnDemandError> {
            let pubkey = pubkey.to_bytes().into();
            crate::client::fetch_zerocopy_account(client, pubkey).await
        }

    }
}
