use bytemuck::{Pod, Zeroable};

use crate::anchor_traits::*;
#[allow(unused_imports)]
use crate::impl_account_deserialize;
use crate::{cfg_client, get_sb_program_id, Pubkey};

const STATE_SEED: &[u8] = b"STATE";

/// State epoch information for tracking global epochs
#[derive(Debug, Copy, Clone)]
pub struct StateEpochInfo {
    /// Unique identifier for this epoch
    pub id: u64,
    /// Reserved field for future use
    pub reserved1: u64,
    /// Slot number when this epoch ends
    pub slot_end: u64,
}

/// Global program state account containing configuration and epoch information
#[repr(C)]
#[derive(Debug, Copy, Clone)]
pub struct State {
    /// PDA bump seed for the state account
    pub bump: u8,
    /// Flag to disable MR_ENCLAVE verification for testing purposes only
    pub test_only_disable_mr_enclave_check: u8,
    padding1: [u8; 6],
    /// Authority pubkey that can modify program state
    pub authority: Pubkey,
    /// Guardian queue for program security operations
    pub guardian_queue: Pubkey,
    /// Reserved field for future expansion
    pub reserved1: u64,
    /// Length of each epoch in slots
    pub epoch_length: u64,
    /// Information about the current active epoch
    pub current_epoch: StateEpochInfo,
    /// Information about the next scheduled epoch
    pub next_epoch: StateEpochInfo,
    /// Information about the most recently finalized epoch
    pub finalized_epoch: StateEpochInfo,
    /// Stake pool account for staking operations
    pub stake_pool: Pubkey,
    /// Stake program used for staking operations
    pub stake_program: Pubkey,
    /// SWITCH token mint address
    pub switch_mint: Pubkey,
    /// Array of SGX advisory identifiers
    pub sgx_advisories: [u16; 32],
    /// Number of active SGX advisories in the array
    pub advisories_len: u8,
    _ebuf4: [u8; 15],
    _ebuf3: [u8; 256],
    _ebuf2: [u8; 512],
    _ebuf1: [u8; 1024],
}
unsafe impl Pod for State {}
unsafe impl Zeroable for State {}

cfg_client! {
    impl_account_deserialize!(State);
}

impl Discriminator for State {
    const DISCRIMINATOR: &'static [u8] = &[216, 146, 107, 94, 104, 75, 182, 177];
}

impl Owner for State {
    fn owner() -> Pubkey {
        if crate::utils::is_devnet() {
            get_sb_program_id("devnet")
        } else {
            get_sb_program_id("mainnet")
        }
    }
}

impl State {
    /// Returns the total size of the state account in bytes
    pub fn size() -> usize {
        8 + std::mem::size_of::<State>()
    }

    /// Gets the program-derived address for the global state account
    pub fn get_pda() -> Pubkey {
        let pid = if crate::utils::is_devnet() {
            get_sb_program_id("devnet")
        } else {
            get_sb_program_id("mainnet")
        };
        let (pda_key, _) = Pubkey::find_program_address(&[STATE_SEED], &pid);
        pda_key
    }

    /// Gets the program-derived address for the state account with optional program ID
    pub fn get_program_pda(program_id: Option<Pubkey>) -> Pubkey {
        let pid = if crate::utils::is_devnet() {
            get_sb_program_id("devnet")
        } else {
            get_sb_program_id("mainnet")
        };
        let (pda_key, _) = Pubkey::find_program_address(&[STATE_SEED], &program_id.unwrap_or(pid));
        pda_key
    }

    /// Alias for get_pda() for compatibility
    pub fn key() -> Pubkey {
        Self::get_pda()
    }

    /// Gets the program ID for the state account
    pub fn pid() -> Pubkey {
        if crate::utils::is_devnet() {
            get_sb_program_id("devnet")
        } else {
            get_sb_program_id("mainnet")
        }
    }

    cfg_client! {
        /// Fetches the global state account asynchronously from the Solana network
        pub async fn fetch_async(
            client: &crate::RpcClient,
        ) -> std::result::Result<Self, crate::OnDemandError> {
            let pubkey = State::get_pda().to_bytes().into();
            crate::client::fetch_zerocopy_account(client, pubkey).await
        }
    }
}
