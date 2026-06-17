#![cfg(feature = "titan")]
//! Titan SDK helpers
use crate::solana_sdk::{message::AddressLookupTableAccount, pubkey::Pubkey};
pub use titan_swap_api_client::{
    quote::{Provider, QuoteRequest, QuoteResponse, SwapMode},
    swap::SwapResponse,
    TitanClient,
};

use crate::{
    types::{SdkError, SdkResult},
    utils, DriftClient,
};

/// Default Titan API url
const DEFAULT_TITAN_API_URL: &str = "https://api.titan.exchange";

/// Titan swap instructions and metadata
pub struct TitanSwapInfo {
    pub quote: QuoteResponse,
    pub ixs: SwapResponse,
    pub luts: Vec<AddressLookupTableAccount>,
}

pub trait TitanSwapApi {
    fn titan_swap_query(
        &self,
        user_authority: &Pubkey,
        amount: u64,
        max_accounts: Option<usize>,
        swap_mode: SwapMode,
        slippage_bps: u16,
        in_market: u16,
        out_market: u16,
        only_direct_routes: Option<bool>,
        excluded_dexes: Option<String>,
        providers: Option<Provider>,
    ) -> impl std::future::Future<Output = SdkResult<TitanSwapInfo>> + Send;
}

impl TitanSwapApi for DriftClient {
    /// Fetch Titan swap ixs and metadata for a token swap
    ///
    /// This function queries Titan API to get the optimal swap route and corresponding instructions
    /// for swapping between two tokens.
    ///
    /// # Arguments
    ///
    /// * `user_authority` - The public key of the user's wallet that will execute the swap
    /// * `amount` - The amount of input tokens to swap, in native units (smallest denomination)
    /// * `swap_mode` - The type of swap to perform (e.g. ExactIn, ExactOut)
    /// * `slippage_bps` - Maximum allowed slippage in basis points (1 bp = 0.01%)
    /// * `in_market` - The market index of the token to swap from
    /// * `out_market` - The market index of the token to swap to
    /// * `only_direct_routes` - If Some(true), only consider direct swap routes between the tokens
    /// * `excluded_dexes` - Optional comma-separated string of DEX names to exclude from routing
    ///
    /// # Returns
    ///
    /// Returns a `Result` containing `TitanSwapInfo` with the swap instructions and route details
    /// if successful, or a `SdkError` if the operation fails.
    async fn titan_swap_query(
        &self,
        user_authority: &Pubkey,
        amount: u64,
        max_accounts: Option<usize>,
        swap_mode: SwapMode,
        slippage_bps: u16,
        in_market: u16,
        out_market: u16,
        only_direct_routes: Option<bool>,
        excluded_dexes: Option<String>,
        providers: Option<Provider>,
    ) -> SdkResult<TitanSwapInfo> {
        let in_market = self.try_get_spot_market_account(in_market)?;
        let out_market = self.try_get_spot_market_account(out_market)?;

        let titan_url = std::env::var("TITAN_BASE_URL").unwrap_or(DEFAULT_TITAN_API_URL.into());
        let auth_token = std::env::var("TITAN_AUTH_TOKEN").map_err(|err| {
            log::error!("titan auth token missing: {err:?}");
            SdkError::Generic("TITAN_AUTH_TOKEN must be set".into())
        })?;
        let client = TitanClient::new(auth_token, Some(titan_url));

        let quote_request = QuoteRequest {
            input_mint: in_market.mint,
            output_mint: out_market.mint,
            amount,
            user_pubkey: *user_authority,
            max_accounts,
            swap_mode: Some(swap_mode),
            slippage_bps,
            only_direct_routes,
            excluded_dexes,
            providers,
            ..Default::default()
        };

        // GET /quote
        let quote_response = client.quote(&quote_request).await.map_err(|err| {
            log::error!("titan api request: {err:?}");
            SdkError::Generic(err.to_string())
        })?;

        // Build swap instructions
        let swap_response = client.swap(&quote_response).map_err(|err| {
            log::error!("titan swap build error: {err:?}");
            SdkError::Generic(err.to_string())
        })?;

        // Fetch ALTs
        let res = self
            .rpc()
            .get_multiple_accounts(swap_response.address_lookup_table_addresses.as_slice())
            .await?;

        let luts = res
            .iter()
            .zip(swap_response.address_lookup_table_addresses.iter())
            .map(|(acc, key)| {
                utils::deserialize_alt(*key, acc.as_ref().expect("deser LUT")).expect("deser LUT")
            })
            .collect();

        Ok(TitanSwapInfo {
            luts,
            quote: quote_response,
            ixs: swap_response,
        })
    }
}
