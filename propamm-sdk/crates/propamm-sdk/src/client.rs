use std::sync::Arc;

use solana_commitment_config::CommitmentConfig;
use solana_instruction::Instruction;
use solana_keypair::Keypair;
use solana_pubkey::Pubkey;
use solana_rpc_client::nonblocking::rpc_client::RpcClient;
use solana_signature::Signature;
use solana_signer::Signer;
use solana_transaction::Transaction;
use thiserror::Error;

use crate::instructions::{self, OrderEntry};
use crate::oracle::{self, OraclePrice};
use crate::pda;

/// Errors returned by [`PropAmmClient`] methods.
#[derive(Debug, Error)]
pub enum ClientError {
    /// Solana RPC call failed.
    #[error("RPC error: {0}")]
    Rpc(#[from] solana_rpc_client_api::client_error::Error),
    /// Oracle account could not be parsed.
    #[error("Oracle error: {0}")]
    Oracle(#[from] oracle::OracleError),
    /// Expected account does not exist on-chain.
    #[error("Account not found: {0}")]
    AccountNotFound(Pubkey),
}

/// Convenience alias for `Result<T, ClientError>`.
pub type Result<T> = std::result::Result<T, ClientError>;

/// High-level async client for interacting with PropAMM midprice accounts.
///
/// Stateless per-call — no background threads. The quoting loop lives in the caller.
pub struct PropAmmClient {
    rpc: Arc<RpcClient>,
    payer: Arc<Keypair>,
    midprice_program_id: Pubkey,
    drift_program_id: Pubkey,
    market_index: u16,
    subaccount_index: u16,
    // Cached PDAs.
    midprice_address: Pubkey,
    matcher_address: Pubkey,
    perp_market_address: Pubkey,
}

impl PropAmmClient {
    /// Create a new [`PropAmmClient`].
    ///
    /// Derives all PDAs at construction time. No RPC calls are made.
    ///
    /// * `rpc_url` - Solana JSON-RPC endpoint URL.
    /// * `payer` - Keypair used to sign transactions (must be the midprice account authority).
    /// * `market_index` - Drift perp market index.
    /// * `subaccount_index` - Subaccount index for the midprice PDA derivation.
    /// * `midprice_program_id` - Deployed midprice-pino program ID.
    /// * `drift_program_id` - Deployed Drift program ID.
    pub fn new(
        rpc_url: &str,
        payer: Arc<Keypair>,
        market_index: u16,
        subaccount_index: u16,
        midprice_program_id: Pubkey,
        drift_program_id: Pubkey,
    ) -> Self {
        let rpc = Arc::new(RpcClient::new_with_commitment(
            rpc_url.to_string(),
            CommitmentConfig::confirmed(),
        ));

        let (midprice_address, _) = pda::midprice_pda(
            &midprice_program_id,
            &payer.pubkey(),
            market_index,
            subaccount_index,
        );
        let (matcher_address, _) = pda::prop_amm_matcher_pda(&drift_program_id);
        let (perp_market_address, _) = pda::perp_market_pda(&drift_program_id, market_index);

        Self {
            rpc,
            payer,
            midprice_program_id,
            drift_program_id,
            market_index,
            subaccount_index,
            midprice_address,
            matcher_address,
            perp_market_address,
        }
    }

    /// Create from an existing [`RpcClient`] (for sharing connections).
    ///
    /// * `rpc` - Shared RPC client instance.
    /// * `payer` - Keypair used to sign transactions (must be the midprice account authority).
    /// * `market_index` - Drift perp market index.
    /// * `subaccount_index` - Subaccount index for the midprice PDA derivation.
    /// * `midprice_program_id` - Deployed midprice-pino program ID.
    /// * `drift_program_id` - Deployed Drift program ID.
    pub fn with_rpc(
        rpc: Arc<RpcClient>,
        payer: Arc<Keypair>,
        market_index: u16,
        subaccount_index: u16,
        midprice_program_id: Pubkey,
        drift_program_id: Pubkey,
    ) -> Self {
        let (midprice_address, _) = pda::midprice_pda(
            &midprice_program_id,
            &payer.pubkey(),
            market_index,
            subaccount_index,
        );
        let (matcher_address, _) = pda::prop_amm_matcher_pda(&drift_program_id);
        let (perp_market_address, _) = pda::perp_market_pda(&drift_program_id, market_index);

        Self {
            rpc,
            payer,
            midprice_program_id,
            drift_program_id,
            market_index,
            subaccount_index,
            midprice_address,
            matcher_address,
            perp_market_address,
        }
    }

    /// Returns the derived midprice account PDA.
    pub fn midprice_address(&self) -> &Pubkey {
        &self.midprice_address
    }

    /// Returns the derived PropAMM matcher PDA.
    pub fn matcher_address(&self) -> &Pubkey {
        &self.matcher_address
    }

    /// Returns the derived perp market PDA.
    pub fn perp_market_address(&self) -> &Pubkey {
        &self.perp_market_address
    }

    /// Returns the perp market index this client was constructed with.
    pub fn market_index(&self) -> u16 {
        self.market_index
    }

    /// Returns a reference to the underlying [`RpcClient`].
    pub fn rpc(&self) -> &Arc<RpcClient> {
        &self.rpc
    }

    /// Returns a reference to the payer [`Keypair`].
    pub fn payer(&self) -> &Arc<Keypair> {
        &self.payer
    }

    // -- Account reads (async) --

    /// Fetch the raw midprice account data. Use `MidpriceBookView::new()` to parse.
    pub async fn fetch_midprice_account(&self) -> Result<Vec<u8>> {
        let account = self
            .rpc
            .get_account_with_commitment(&self.midprice_address, CommitmentConfig::confirmed())
            .await?
            .value
            .ok_or(ClientError::AccountNotFound(self.midprice_address))?;
        Ok(account.data)
    }

    /// Read the 8-byte sequence number from the midprice account (offset 104).
    pub async fn fetch_sequence_number(&self) -> Result<u64> {
        let data = self.fetch_midprice_account().await?;
        Ok(crate::monitor::read_sequence_number(&data).unwrap_or(0))
    }

    /// Fetch and parse a Pyth oracle price account.
    ///
    /// * `oracle_pubkey` - On-chain address of the Pyth v2 price account.
    pub async fn fetch_oracle_price(&self, oracle_pubkey: &Pubkey) -> Result<OraclePrice> {
        let account = self
            .rpc
            .get_account_with_commitment(oracle_pubkey, CommitmentConfig::confirmed())
            .await?
            .value
            .ok_or(ClientError::AccountNotFound(*oracle_pubkey))?;
        Ok(oracle::parse_pyth_price(&account.data)?)
    }

    /// Get the current slot.
    pub async fn get_slot(&self) -> Result<u64> {
        Ok(self.rpc.get_slot().await?)
    }

    // -- Instruction builders (sync) --

    /// Build an `update_mid_price` instruction.
    ///
    /// * `mid_price` - Reference price in [`PRICE_PRECISION`](crate::PRICE_PRECISION) (10^6).
    /// * `ref_slot` - Slot at which this price is valid (`valid_until_slot`).
    pub fn update_mid_price_ix(&self, mid_price: u64, ref_slot: u64) -> Instruction {
        instructions::update_mid_price(
            &self.midprice_program_id,
            &self.midprice_address,
            &self.payer.pubkey(),
            mid_price,
            ref_slot,
        )
    }

    /// Build a `set_orders` instruction.
    ///
    /// * `ref_slot` - Slot at which these orders are valid (`valid_until_slot`).
    /// * `asks` - Ask-side levels (positive offsets from mid price).
    /// * `bids` - Bid-side levels (negative offsets from mid price).
    pub fn set_orders_ix(
        &self,
        ref_slot: u64,
        asks: &[OrderEntry],
        bids: &[OrderEntry],
    ) -> Instruction {
        instructions::set_orders(
            &self.midprice_program_id,
            &self.midprice_address,
            &self.payer.pubkey(),
            ref_slot,
            asks,
            bids,
        )
    }

    /// Build a `set_quote_ttl` instruction.
    ///
    /// * `ttl_slots` - Number of slots after `valid_until_slot` before quotes expire.
    pub fn set_quote_ttl_ix(&self, ttl_slots: u64) -> Instruction {
        instructions::set_quote_ttl(
            &self.midprice_program_id,
            &self.midprice_address,
            &self.payer.pubkey(),
            ttl_slots,
        )
    }

    /// Build a `close_account` instruction.
    ///
    /// * `destination` - Account to receive refunded lamports. Defaults to the payer if `None`.
    pub fn close_account_ix(&self, destination: Option<Pubkey>) -> Instruction {
        let dest = destination.unwrap_or_else(|| self.payer.pubkey());
        instructions::close_account(
            &self.midprice_program_id,
            &self.midprice_address,
            &self.payer.pubkey(),
            &dest,
        )
    }

    // -- Convenience: combined update_mid_price + set_orders in one tx --

    /// Build, sign, and send a combined `update_mid_price` + `set_orders` transaction.
    ///
    /// * `mid_price` - Reference price in [`PRICE_PRECISION`](crate::PRICE_PRECISION) (10^6).
    /// * `ref_slot` - Slot at which the quote is valid (`valid_until_slot`).
    /// * `asks` - Ask-side levels (positive offsets from mid price).
    /// * `bids` - Bid-side levels (negative offsets from mid price).
    pub async fn quote(
        &self,
        mid_price: u64,
        ref_slot: u64,
        asks: &[OrderEntry],
        bids: &[OrderEntry],
    ) -> Result<Signature> {
        let ixs = vec![
            self.update_mid_price_ix(mid_price, ref_slot),
            self.set_orders_ix(ref_slot, asks, bids),
        ];
        self.send_tx(&ixs).await
    }

    // -- Initialization --

    /// Initialize the midprice account via Drift CPI.
    /// The midprice PDA must be pre-allocated (create_account) before calling.
    pub async fn initialize_midprice(&self) -> Result<Signature> {
        let ix = instructions::initialize_prop_amm_midprice(
            &self.drift_program_id,
            &self.payer.pubkey(),
            &self.midprice_address,
            &self.perp_market_address,
            &self.midprice_program_id,
            &self.matcher_address,
            self.subaccount_index,
        );
        self.send_tx(&[ix]).await
    }

    // -- Internal --

    /// Sign and send a transaction with the payer keypair.
    ///
    /// * `ixs` - Instructions to include in the transaction.
    pub async fn send_tx(&self, ixs: &[Instruction]) -> Result<Signature> {
        let recent_blockhash = self.rpc.get_latest_blockhash().await?;
        let tx = Transaction::new_signed_with_payer(
            ixs,
            Some(&self.payer.pubkey()),
            &[self.payer.as_ref()],
            recent_blockhash,
        );
        let sig = self.rpc.send_and_confirm_transaction(&tx).await?;
        Ok(sig)
    }
}
