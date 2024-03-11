use crate::error::{DriftResult, ErrorCode};

use crate::math::spot_withdraw::validate_spot_market_vault_amount;
use crate::state::events::OrderActionExplanation;

use crate::state::spot_fulfillment_params::{ExternalSpotFill, SpotFulfillmentParams};
use crate::state::spot_market::SpotMarket;

use crate::{validate, PositionDirection};

use anchor_lang::prelude::Account;

use anchor_spl::token::TokenAccount;
use arrayref::array_ref;

use solana_program::account_info::AccountInfo;
use solana_program::msg;
use std::cell::Ref;

pub struct MatchFulfillmentParams<'a> {
    pub base_market_vault: Box<Account<'a, TokenAccount>>,
    pub quote_market_vault: Box<Account<'a, TokenAccount>>,
}

impl<'a> MatchFulfillmentParams<'a> {
    pub fn new<'b, 'c>(
        account_info_iter: &'b mut std::iter::Peekable<std::slice::Iter<'c, AccountInfo<'a>>>,
        base_market: &SpotMarket,
        quote_market: &SpotMarket,
    ) -> DriftResult<MatchFulfillmentParams<'a>> {
        let account_info_vec = account_info_iter.collect::<Vec<_>>();
        let account_infos = array_ref![account_info_vec, 0, 2];
        let [base_market_vault, quote_market_vault] = account_infos;
        let a: i32 = 2;

        validate!(
            &base_market.vault == base_market_vault.key,
            ErrorCode::InvalidFulfillmentConfig
        )?;

        validate!(
            &quote_market.vault == quote_market_vault.key,
            ErrorCode::InvalidFulfillmentConfig
        )?;

        let base_market_vault: Box<Account<TokenAccount>> =
            Box::new(Account::try_from(base_market_vault).map_err(|e| {
                msg!("{:?}", e);
                ErrorCode::InvalidFulfillmentConfig
            })?);
        let quote_market_vault: Box<Account<TokenAccount>> =
            Box::new(Account::try_from(quote_market_vault).map_err(|e| {
                msg!("{:?}", e);
                ErrorCode::InvalidFulfillmentConfig
            })?);

        Ok(MatchFulfillmentParams {
            base_market_vault,
            quote_market_vault,
        })
    }
}

impl<'a> SpotFulfillmentParams for MatchFulfillmentParams<'a> {
    fn is_external(&self) -> bool {
        false
    }

    fn get_best_bid_and_ask(&self) -> DriftResult<(Option<u64>, Option<u64>)> {
        Err(ErrorCode::InvalidSpotFulfillmentParams)
    }

    fn fulfill_order(
        &mut self,
        _taker_direction: PositionDirection,
        _taker_price: u64,
        _taker_base_asset_amount: u64,
        _taker_max_quote_asset_amount: u64,
    ) -> DriftResult<ExternalSpotFill> {
        Err(ErrorCode::InvalidSpotFulfillmentParams)
    }

    fn get_order_action_explanation(&self) -> DriftResult<OrderActionExplanation> {
        Err(ErrorCode::InvalidSpotFulfillmentParams)
    }

    fn validate_vault_amounts(
        &self,
        base_market: &Ref<SpotMarket>,
        quote_market: &Ref<SpotMarket>,
    ) -> DriftResult<()> {
        validate_spot_market_vault_amount(base_market, self.base_market_vault.amount)?;

        validate_spot_market_vault_amount(quote_market, self.quote_market_vault.amount)?;

        Ok(())
    }
}
