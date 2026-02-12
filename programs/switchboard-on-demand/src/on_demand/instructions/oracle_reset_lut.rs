use borsh::BorshSerialize;
use solana_program::instruction::AccountMeta;

use crate::anchor_traits::*;
use crate::prelude::*;
use crate::solana_compat::SYSTEM_PROGRAM_ID;
use crate::{cfg_client, solana_program, Pubkey};

/// Oracle address lookup table reset instruction
pub struct OracleResetLut {}

/// Parameters for oracle address lookup table reset instruction
#[derive(Clone, BorshSerialize, Debug)]
pub struct OracleResetLutParams {
    /// Recent slot number for the reset
    pub recent_slot: u64,
}

impl InstructionData for OracleResetLutParams {}

impl Discriminator for OracleResetLut {
    const DISCRIMINATOR: &'static [u8] = &[147, 244, 108, 198, 152, 219, 0, 22];
}
impl Discriminator for OracleResetLutParams {
    const DISCRIMINATOR: &'static [u8] = OracleResetLut::DISCRIMINATOR;
}

/// Arguments for building an oracle address lookup table reset instruction
pub struct OracleResetLutArgs {
    /// Oracle account public key
    pub oracle: Pubkey,
    /// Payer account public key
    pub payer: Pubkey,
    /// Recent slot number for the reset
    pub recent_slot: u64,
}
/// Account metas for oracle address lookup table reset instruction
pub struct OracleResetLutAccounts {
    /// Oracle account public key
    pub oracle: Pubkey,
    /// Authority account public key
    pub authority: Pubkey,
    /// Payer account public key
    pub payer: Pubkey,
    /// System program public key
    pub system_program: Pubkey,
    /// Global state account public key
    pub state: Pubkey,
    /// Address lookup table signer account
    pub lut_signer: Pubkey,
    /// Address lookup table account
    pub lut: Pubkey,
    /// Address lookup table program public key
    pub address_lookup_table_program: Pubkey,
}
impl ToAccountMetas for OracleResetLutAccounts {
    fn to_account_metas(&self, _: Option<bool>) -> Vec<AccountMeta> {
        let state_pubkey = State::get_pda();
        vec![
            AccountMeta::new(self.oracle, false),
            AccountMeta::new_readonly(self.authority, true),
            AccountMeta::new(self.payer, false),
            AccountMeta::new_readonly(SYSTEM_PROGRAM_ID.to_bytes().into(), false),
            AccountMeta::new_readonly(state_pubkey, false),
            AccountMeta::new_readonly(self.lut_signer, false),
            AccountMeta::new(self.lut, false),
            AccountMeta::new_readonly(ADDRESS_LOOKUP_TABLE_PROGRAM_ID.to_bytes().into(), false),
        ]
    }
}

cfg_client! {
use anchor_client::solana_client::nonblocking::rpc_client::RpcClient;
use spl_associated_token_account::solana_program::address_lookup_table::instruction::derive_lookup_table_address;
use crate::get_sb_program_id;
use crate::find_lut_signer;

impl OracleResetLut {
    pub async fn build_ix(client: &RpcClient, args: OracleResetLutArgs) -> Result<Instruction, OnDemandError> {
        let oracle_data = OracleAccountData::fetch_async(client, args.oracle).await?;
        let authority = oracle_data.authority;
        let payer = oracle_data.authority;
        let lut_signer: Pubkey = find_lut_signer(&args.oracle);
        let lut = derive_lookup_table_address(&lut_signer.to_bytes().into(), args.recent_slot).0;
        let address_lookup_table_program = crate::on_demand::ADDRESS_LOOKUP_TABLE_PROGRAM_ID;
        let pid = if crate::utils::is_devnet() {
            get_sb_program_id("devnet")
        } else {
            get_sb_program_id("mainnet")
        };
        let ix = crate::utils::build_ix(
            &pid,
            &OracleResetLutAccounts {
                oracle: args.oracle,
                state: State::get_pda(),
                authority,
                lut_signer,
                lut: lut.to_bytes().into(),
                address_lookup_table_program,
                payer,
                system_program: SYSTEM_PROGRAM_ID.to_bytes().into(),
            },
            &OracleResetLutParams {
                recent_slot: args.recent_slot,
            }
        );
        crate::return_ix_compat!(ix)
    }
}
}
