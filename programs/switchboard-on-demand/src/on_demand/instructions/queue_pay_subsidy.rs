use borsh::BorshSerialize;
use solana_program::instruction::AccountMeta;
use switchboard_common::cfg_client;

use crate::anchor_traits::*;
use crate::prelude::*;
use crate::solana_compat::{pubkey, SYSTEM_PROGRAM_ID};
use crate::{solana_program, Pubkey};

/// Jito vault public key constant
pub const JITO_VAULT_ID: Pubkey = pubkey!("Vau1t6sLNxnzB7ZDsef8TLbPLfyZMYXH8WTNqUdm9g8");

/// Queue subsidy payment instruction
pub struct QueuePaySubsidy {}

/// Parameters for queue subsidy payment instruction
#[derive(Clone, BorshSerialize, Debug)]
pub struct QueuePaySubsidyParams {}

impl InstructionData for QueuePaySubsidyParams {}
const DISCRIMINATOR: &[u8] = &[85, 84, 51, 251, 144, 57, 105, 200];
impl Discriminator for QueuePaySubsidy {
    const DISCRIMINATOR: &[u8] = DISCRIMINATOR;
}
impl Discriminator for QueuePaySubsidyParams {
    const DISCRIMINATOR: &[u8] = DISCRIMINATOR;
}

/// Arguments for building a queue subsidy payment instruction
#[derive(Clone, Debug)]
pub struct QueuePaySubsidyArgs {
    /// Queue account public key
    pub queue: Pubkey,
    /// Vault account public key
    pub vault: Pubkey,
    /// Payer account public key
    pub payer: Pubkey,
}
/// Account metas for queue subsidy payment instruction
pub struct QueuePaySubsidyAccounts {
    /// Queue account public key
    pub queue: Pubkey,
    /// Vault account public key
    pub vault: Pubkey,
    /// SWITCH mint public key
    pub switch_mint: Pubkey,
    /// Payer account public key
    pub payer: Pubkey,
    /// Additional account metas required for the instruction
    pub remaining_accounts: Vec<AccountMeta>,
}
impl ToAccountMetas for QueuePaySubsidyAccounts {
    fn to_account_metas(&self, _: Option<bool>) -> Vec<AccountMeta> {
        let program_state = State::get_pda();
        let token_program: Pubkey = spl_token::id().to_bytes().into();
        let associated_token_program = spl_associated_token_account::id();
        let system_program = SYSTEM_PROGRAM_ID;
        let wsol_mint: Pubkey = spl_token::native_mint::id().to_bytes().into();
        let subsidy_vault = get_associated_token_address(
            &program_state.to_bytes().into(),
            &self.switch_mint.to_bytes().into(),
        );
        let reward_vault = get_associated_token_address(
            &self.vault.to_bytes().into(),
            &self.switch_mint.to_bytes().into(),
        );
        let vault_config = Pubkey::find_program_address(&[b"config"], &JITO_VAULT_ID).0;

        let mut accounts = vec![
            AccountMeta::new(self.queue, false),
            AccountMeta::new_readonly(program_state, false),
            AccountMeta::new_readonly(system_program.to_bytes().into(), false),
            AccountMeta::new_readonly(self.vault, false),
            AccountMeta::new(reward_vault, false),
            AccountMeta::new(subsidy_vault, false),
            AccountMeta::new_readonly(token_program, false),
            AccountMeta::new_readonly(associated_token_program.to_bytes().into(), false),
            AccountMeta::new_readonly(wsol_mint, false),
            AccountMeta::new_readonly(self.switch_mint, false),
            AccountMeta::new_readonly(vault_config, false),
            AccountMeta::new(self.payer, true),
        ];
        accounts.extend(self.remaining_accounts.clone());
        accounts
    }
}

cfg_client! {
use anchor_client::solana_client::nonblocking::rpc_client::RpcClient;
use crate::get_sb_program_id;
use futures::future::join_all;
#[cfg(not(feature = "anchor"))]
use spl_associated_token_account::solana_program::address_lookup_table::AddressLookupTableAccount;
#[cfg(feature = "anchor")]
use spl_associated_token_account::solana_program::address_lookup_table::AddressLookupTableAccount;

impl QueuePaySubsidy {
    pub async fn build_ix(client: &RpcClient, args: QueuePaySubsidyArgs) -> Result<Instruction, OnDemandError> {
        let state = State::fetch_async(client).await?;
        let switch_mint = state.switch_mint;
        let pid = if crate::utils::is_devnet() {
            get_sb_program_id("devnet")
        } else {
            get_sb_program_id("mainnet")
        };
        let queue_data = QueueAccountData::fetch_async(client, args.queue).await?;
        let oracles = queue_data.oracle_keys[..queue_data.oracle_keys_len as usize].to_vec();
        let mut remaining_accounts = vec![];
        for oracle in oracles {
            let oracle_stats = OracleAccountData::stats_key(&oracle);
            remaining_accounts.push(AccountMeta::new_readonly(oracle, false));
            remaining_accounts.push(AccountMeta::new_readonly(oracle_stats, false));
            let oracle_data = OracleAccountData::fetch_async(client, oracle).await?;
            let operator = oracle_data.operator;
            if operator == Pubkey::default() {
                continue;
            }
            let oracle_subisidy_wallet = get_associated_token_address(&operator, &switch_mint);
            remaining_accounts.push(AccountMeta::new_readonly(operator, false));
            remaining_accounts.push(AccountMeta::new(oracle_subisidy_wallet, false));
        }
        let ix = crate::utils::build_ix(
            &pid,
            &QueuePaySubsidyAccounts {
                queue: args.queue,
                vault: args.vault,
                switch_mint: state.switch_mint,
                remaining_accounts,
                payer: args.payer,
            },
            &QueuePaySubsidyParams { },
        );
        crate::return_ix_compat!(ix)
    }

    pub async fn fetch_luts(client: &RpcClient, args: QueuePaySubsidyArgs) -> Result<Vec<AddressLookupTableAccount>, OnDemandError> {
        let queue_data = QueueAccountData::fetch_async(client, args.queue).await?;
        let queue_lut = queue_data.fetch_lut(&args.queue, client).await?;
        let oracles = queue_data.oracle_keys[..queue_data.oracle_keys_len as usize].to_vec();

        // Spawn parallel async tasks for fetching LUTs
        let lut_futures: Vec<_> = oracles
            .into_iter()
            .map(|oracle| {
                async move {
                    let oracle_data = OracleAccountData::fetch_async(client, oracle).await.ok()?;
                    oracle_data.fetch_lut(&oracle, client).await.ok()
                }
            })
        .collect();

        // Run all futures in parallel
        let mut luts: Vec<AddressLookupTableAccount> = join_all(lut_futures)
            .await
            .into_iter()
            .flatten()
            .collect();
        luts.push(queue_lut);

        Ok(luts)
    }
}
}
