//! Jupiter SDK helpers
use crate::solana_sdk::{message::AddressLookupTableAccount, pubkey::Pubkey};
pub use jupiter_swap_api_client::{
    quote::{QuoteResponse, SwapMode},
    swap::SwapInstructionsResponse,
    transaction_config::TransactionConfig,
    JupiterSwapApiClient,
};

use crate::{
    types::{SdkError, SdkResult},
    utils, DriftClient,
};

/// Default Jupiter API url (updated from lite-api.jup.ag which is deprecated as of Jan 31, 2026)
/// See: https://dev.jup.ag/portal/migrate-from-lite-api
const DEFAULT_JUPITER_API_URL: &str = "https://api.jup.ag/swap/v1";

/// jupiter swap IXs and metadata for building a swap Tx
pub struct JupiterSwapInfo {
    pub quote: QuoteResponse,
    pub ixs: SwapInstructionsResponse,
    pub luts: Vec<AddressLookupTableAccount>,
}

pub trait JupiterSwapApi {
    fn jupiter_swap_query(
        &self,
        user_authority: &Pubkey,
        amount: u64,
        swap_mode: SwapMode,
        in_market: u16,
        out_market: u16,
        slippage_bps: u16,
        only_direct_routes: Option<bool>,
        excluded_dexes: Option<String>,
        transaction_config: Option<TransactionConfig>,
    ) -> impl std::future::Future<Output = SdkResult<JupiterSwapInfo>> + Send;
}

impl JupiterSwapApi for DriftClient {
    /// Fetch Jupiter swap ixs and metadata for a token swap
    ///
    /// This function queries Jupiter API to get the optimal swap route and corresponding instructions
    /// for swapping between two tokens.
    ///
    /// # Arguments
    ///
    /// * `rpc` - A Solana RPC client
    /// * `user_authority` - The public key of the user's wallet that will execute the swap
    /// * `amount` - The amount of input tokens to swap, in native units (smallest denomination)
    /// * `swap_mode` - The type of swap to perform (e.g. ExactIn, ExactOut)
    /// * `slippage_bps` - Maximum allowed slippage in basis points (1 bp = 0.01%)
    /// * `in_market` - The market index of the token to swap from
    /// * `out_market` - The market index of the token to swap to
    /// * `only_direct_routes` - If Some(true), only consider direct swap routes between the tokens
    /// * `excluded_dexes` - Optional comma-separated string of DEX names to exclude from routing
    /// * `transaction_config` - Optional configuration for the swap transaction
    ///
    /// # Returns
    ///
    /// Returns a `Result` containing `JupiterSwapInfo` with the swap instructions and route details
    /// if successful, or a `SdkError` if the operation fails.
    ///
    /// # Example
    ///
    /// ```no_run
    /// use solana_pubkey::Pubkey;
    ///
    /// let swap_info = jupiter_swap_query(
    ///     rpc_client,
    ///     user_wallet.pubkey(),
    ///     1_000_000, // 1 USDC
    ///     SwapMode::ExactIn,
    ///     50, // 0.5% slippage
    ///     usdc_mint,
    ///     sol_mint,
    ///     Some(true),
    ///     None,
    ///     None
    /// ).await?;
    /// ```
    async fn jupiter_swap_query(
        &self,
        user_authority: &Pubkey,
        amount: u64,
        swap_mode: SwapMode,
        slippage_bps: u16,
        in_market: u16,
        out_market: u16,
        only_direct_routes: Option<bool>,
        excluded_dexes: Option<String>,
        transaction_config: Option<TransactionConfig>,
    ) -> SdkResult<JupiterSwapInfo> {
        let jupiter_url =
            std::env::var("JUPITER_API_URL").unwrap_or(DEFAULT_JUPITER_API_URL.into());
        let jup_client = match std::env::var("JUPITER_API_KEY") {
            Ok(api_key) => JupiterSwapApiClient::new_with_api_key(jupiter_url, api_key),
            Err(_) => {
                log::warn!(
                    "JUPITER_API_KEY not set. Jupiter API requests may fail after Jan 31, 2026. \
                     Get a free API key at https://portal.jup.ag"
                );
                JupiterSwapApiClient::new(jupiter_url)
            }
        };

        let in_market = self.try_get_spot_market_account(in_market)?;
        let out_market = self.try_get_spot_market_account(out_market)?;

        // GET /quote
        let quote_request = jupiter_swap_api_client::quote::QuoteRequest {
            amount,
            swap_mode: Some(swap_mode),
            input_mint: in_market.mint,
            output_mint: out_market.mint,
            slippage_bps,
            only_direct_routes,
            excluded_dexes,
            ..Default::default()
        };

        let quote_response = jup_client.quote(&quote_request).await.map_err(|err| {
            log::error!("jupiter api request: {err:?}");
            SdkError::Generic(err.to_string())
        })?;
        // POST /swap-instructions
        let swap_instructions = jup_client
            .swap_instructions(&jupiter_swap_api_client::swap::SwapRequest {
                user_public_key: *user_authority,
                quote_response: quote_response.clone(),
                config: transaction_config.unwrap_or_default(),
            })
            .await
            .map_err(|err| {
                log::error!("jupiter api request: {err:?}");
                SdkError::Generic(err.to_string())
            })?;

        let res = self
            .rpc()
            .get_multiple_accounts(swap_instructions.address_lookup_table_addresses.as_slice())
            .await?;

        let luts = res
            .iter()
            .zip(swap_instructions.address_lookup_table_addresses.iter())
            .map(|(acc, key)| {
                utils::deserialize_alt(*key, acc.as_ref().expect("deser LUT")).expect("deser LUT")
            })
            .collect();

        Ok(JupiterSwapInfo {
            luts,
            quote: quote_response,
            ixs: swap_instructions,
        })
    }
}
