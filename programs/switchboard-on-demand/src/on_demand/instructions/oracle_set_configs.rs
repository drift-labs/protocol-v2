use borsh::BorshSerialize;
use solana_program::instruction::AccountMeta;

use crate::anchor_traits::*;
#[cfg(feature = "client")]
use crate::prelude::*;
use crate::{cfg_client, solana_program, Pubkey};

/// Oracle configuration setting instruction
pub struct OracleSetConfigs {}

/// Parameters for oracle configuration setting instruction
#[derive(Clone, BorshSerialize, Debug)]
pub struct OracleSetConfigsParams {
    /// New authority public key (optional, 32 bytes)
    pub new_authority: Option<[u8; 32]>,
    /// New SECP256K1 authority key (optional, 64 bytes)
    pub new_secp_authority: Option<[u8; 64]>,
}

impl InstructionData for OracleSetConfigsParams {}

impl Discriminator for OracleSetConfigs {
    const DISCRIMINATOR: &'static [u8] = &[129, 111, 223, 4, 191, 188, 70, 180];
}
impl Discriminator for OracleSetConfigsParams {
    const DISCRIMINATOR: &'static [u8] = OracleSetConfigs::DISCRIMINATOR;
}

/// Arguments for building an oracle configuration setting instruction
pub struct OracleSetConfigsArgs {
    /// Oracle account public key
    pub oracle: Pubkey,
    /// Authority account public key
    pub authority: Pubkey,
    /// SECP256K1 authority key (64 bytes)
    pub secp_authority: [u8; 64],
}
/// Account metas for oracle configuration setting instruction
pub struct OracleSetConfigsAccounts {
    /// Oracle account public key
    pub oracle: Pubkey,
    /// Authority account public key
    pub authority: Pubkey,
}
impl ToAccountMetas for OracleSetConfigsAccounts {
    fn to_account_metas(&self, _: Option<bool>) -> Vec<AccountMeta> {
        vec![
            AccountMeta::new(self.oracle, false),
            AccountMeta::new_readonly(self.authority, true),
        ]
    }
}

cfg_client! {
use anchor_client::solana_client::nonblocking::rpc_client::RpcClient;
use crate::get_sb_program_id;

impl OracleSetConfigs {
    pub async fn build_ix(_client: &RpcClient, args: OracleSetConfigsArgs) -> Result<Instruction, OnDemandError> {
        let pid = if crate::utils::is_devnet() {
            get_sb_program_id("devnet")
        } else {
            get_sb_program_id("mainnet")
        };
        let ix = crate::utils::build_ix(
            &pid,
            &OracleSetConfigsAccounts {
                oracle: args.oracle,
                authority: args.authority,
            },
            &OracleSetConfigsParams {
                new_authority: Some(args.authority.to_bytes()),
                new_secp_authority: Some(args.secp_authority),
            },
        );
        crate::return_ix_compat!(ix)
    }
}
}
