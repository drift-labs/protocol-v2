use borsh::BorshSerialize;
use solana_program::instruction::AccountMeta;

use crate::anchor_traits::*;
use crate::prelude::*;
use crate::{cfg_client, solana_program, Pubkey};

/// Oracle heartbeat instruction version 2
pub struct OracleHeartbeatV2;

/// Parameters for oracle heartbeat instruction version 2
#[derive(Clone, BorshSerialize, Debug)]
pub struct OracleHeartbeatV2Params {
    /// Optional URI for the oracle endpoint (64 bytes)
    pub uri: Option<[u8; 64]>,
}

impl InstructionData for OracleHeartbeatV2Params {}

impl Discriminator for OracleHeartbeatV2 {
    const DISCRIMINATOR: &'static [u8] = &[122, 231, 66, 32, 226, 62, 144, 103];
}
impl Discriminator for OracleHeartbeatV2Params {
    const DISCRIMINATOR: &'static [u8] = OracleHeartbeatV2::DISCRIMINATOR;
}

/// Arguments for building an oracle heartbeat instruction version 2
pub struct OracleHeartbeatV2Args {
    /// Oracle account public key
    pub oracle: Pubkey,
    /// Oracle signer public key
    pub oracle_signer: Pubkey,
    /// Garbage collection node public key
    pub gc_node: Pubkey,
    /// Optional URI for the oracle endpoint (64 bytes)
    pub uri: Option<[u8; 64]>,
}
/// Account metas for oracle heartbeat instruction version 2
pub struct OracleHeartbeatV2Accounts {
    /// Oracle account public key
    pub oracle: Pubkey,
    /// Oracle signer public key
    pub oracle_signer: Pubkey,
    /// Queue account public key
    pub queue: Pubkey,
    /// Garbage collection node public key
    pub gc_node: Pubkey,
}
impl ToAccountMetas for OracleHeartbeatV2Accounts {
    fn to_account_metas(&self, _: Option<bool>) -> Vec<AccountMeta> {
        let state_pubkey = State::get_pda();
        let accts = vec![
            AccountMeta::new(self.oracle, false),
            AccountMeta::new(OracleAccountData::stats_key(&self.oracle), false),
            AccountMeta::new_readonly(self.oracle_signer, true),
            AccountMeta::new(self.queue, false),
            AccountMeta::new(self.gc_node, false),
            AccountMeta::new(state_pubkey, false),
        ];
        accts
    }
}

cfg_client! {
use anchor_client::solana_client::nonblocking::rpc_client::RpcClient;
use crate::get_sb_program_id;

impl OracleHeartbeatV2 {
    pub async fn build_ix(client: &RpcClient, args: OracleHeartbeatV2Args) -> Result<Instruction, OnDemandError> {
        let oracle_data = OracleAccountData::fetch_async(client, args.oracle).await?;
        let pid = if crate::utils::is_devnet() {
            get_sb_program_id("devnet")
        } else {
            get_sb_program_id("mainnet")
        };
        let ix = crate::utils::build_ix(
            &pid,
            &OracleHeartbeatV2Accounts {
                oracle: args.oracle,
                oracle_signer: args.oracle_signer,
                queue: oracle_data.queue,
                gc_node: args.gc_node,
            },
            &OracleHeartbeatV2Params { uri: args.uri },
        );
        crate::return_ix_compat!(ix)
    }
}
}
