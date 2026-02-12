use borsh::BorshSerialize;
use solana_program::instruction::AccountMeta;

use crate::anchor_traits::*;
use crate::prelude::*;
use crate::solana_compat::{ADDRESS_LOOKUP_TABLE_PROGRAM_ID, SYSTEM_PROGRAM_ID};
use crate::{cfg_client, solana_program, Pubkey};

/// Oracle address lookup table synchronization instruction
pub struct OracleSyncLut {}

/// Parameters for oracle address lookup table synchronization instruction
#[derive(Clone, BorshSerialize, Debug)]
pub struct OracleSyncLutParams {}

impl InstructionData for OracleSyncLutParams {}

const DISCRIMINATOR: &[u8] = &[138, 99, 12, 59, 18, 170, 171, 45];
impl Discriminator for OracleSyncLut {
    const DISCRIMINATOR: &[u8] = DISCRIMINATOR;
}
impl Discriminator for OracleSyncLutParams {
    const DISCRIMINATOR: &[u8] = DISCRIMINATOR;
}

/// Arguments for building an oracle address lookup table synchronization instruction
pub struct OracleSyncLutArgs {
    /// Oracle account public key
    pub oracle: Pubkey,
    /// Vault account public key
    pub vault: Pubkey,
    /// Payer account public key
    pub payer: Pubkey,
}
/// Account metas for oracle address lookup table synchronization instruction
pub struct OracleSyncLutAccounts {
    /// Oracle account public key
    pub oracle: Pubkey,
    /// Queue account public key
    pub queue: Pubkey,
    /// Network coordination node public key
    pub ncn: Pubkey,
    /// Vault account public key
    pub vault: Pubkey,
    /// Global state account public key
    pub state: Pubkey,
    /// Authority account public key
    pub authority: Pubkey,
    /// Operator account public key
    pub operator: Pubkey,
    /// NCN operator state account public key
    pub ncn_operator_state: Pubkey,
    /// Operator vault ticket account public key
    pub operator_vault_ticket: Pubkey,
    /// Vault operator delegation account public key
    pub vault_operator_delegation: Pubkey,
    /// Address lookup table signer account
    pub lut_signer: Pubkey,
    /// Address lookup table account
    pub lut: Pubkey,
    /// Address lookup table program public key
    pub address_lookup_table_program: Pubkey,
    /// Payer account public key
    pub payer: Pubkey,
    /// System program public key
    pub system_program: Pubkey,
}
impl ToAccountMetas for OracleSyncLutAccounts {
    fn to_account_metas(&self, _: Option<bool>) -> Vec<AccountMeta> {
        let state_pubkey = State::get_pda();
        vec![
            AccountMeta::new(self.oracle, false),
            AccountMeta::new_readonly(self.queue, false),
            AccountMeta::new_readonly(self.ncn, false),
            AccountMeta::new_readonly(self.vault, false),
            AccountMeta::new_readonly(state_pubkey, false),
            AccountMeta::new_readonly(self.authority, true),
            AccountMeta::new_readonly(self.operator, false),
            AccountMeta::new_readonly(self.ncn_operator_state, false),
            AccountMeta::new_readonly(self.operator_vault_ticket, false),
            AccountMeta::new_readonly(self.vault_operator_delegation, false),
            AccountMeta::new_readonly(self.lut_signer, false),
            AccountMeta::new(self.lut, false),
            AccountMeta::new_readonly(ADDRESS_LOOKUP_TABLE_PROGRAM_ID, false),
            AccountMeta::new(self.payer, true),
            AccountMeta::new_readonly(SYSTEM_PROGRAM_ID, false),
        ]
    }
}

cfg_client! {
use anchor_client::solana_client::nonblocking::rpc_client::RpcClient;
use spl_associated_token_account::solana_program::address_lookup_table::instruction::derive_lookup_table_address;
use crate::get_sb_program_id;
use crate::find_lut_signer;

const JITO_VAULT_ID: Pubkey = solana_program::pubkey!("Vau1t6sLNxnzB7ZDsef8TLbPLfyZMYXH8WTNqUdm9g8");
const JITO_RESTAKING_ID: Pubkey = solana_program::pubkey!("RestkWeAVL8fRGgzhfeoqFhsqKRchg6aa1XrcH96z4Q");

impl OracleSyncLut {
    pub async fn build_ix(client: &RpcClient, args: OracleSyncLutArgs) -> Result<Instruction, OnDemandError> {
        let oracle_data = OracleAccountData::fetch_async(client, args.oracle).await?;
        let queue = oracle_data.queue;
        let queue_data = QueueAccountData::fetch_async(client, queue).await?;
        let authority = oracle_data.authority;
        let operator = oracle_data.operator;
        let payer = oracle_data.authority;
        let lut_signer: Pubkey = find_lut_signer(&queue);
        let lut = derive_lookup_table_address(&lut_signer.to_bytes().into(), queue_data.lut_slot).0;
        let ncn_operator_state = Pubkey::find_program_address(
            &[
                b"ncn_operator_state",
                &queue_data.ncn.to_bytes(),
                &operator.to_bytes(),
            ],
            &JITO_RESTAKING_ID,
        ).0;
        let operator_vault_ticket = Pubkey::find_program_address(
            &[
                b"operator_vault_ticket",
                &operator.to_bytes(),
                &args.vault.to_bytes(),
            ],
            &JITO_RESTAKING_ID,
        ).0;
        let vault_operator_delegation = Pubkey::find_program_address(
            &[
                b"vault_operator_delegation",
                &args.vault.to_bytes(),
                &operator.to_bytes(),
            ],
            &JITO_VAULT_ID,
        ).0;
        let pid = if crate::utils::is_devnet() {
            get_sb_program_id("devnet")
        } else {
            get_sb_program_id("mainnet")
        };
        let ix = crate::utils::build_ix(
            &pid,
            &OracleSyncLutAccounts {
                oracle: args.oracle,
                queue,
                ncn: queue_data.ncn,
                vault: args.vault,
                state: State::get_pda(),
                authority,
                operator,
                ncn_operator_state,
                operator_vault_ticket,
                vault_operator_delegation,
                lut_signer,
                lut: lut.to_bytes().into(),
                address_lookup_table_program: ADDRESS_LOOKUP_TABLE_PROGRAM_ID,
                payer,
                system_program: SYSTEM_PROGRAM_ID,
            },
            &OracleSyncLutParams { },
        );
        crate::return_ix_compat!(ix)
    }
}
}
