#![allow(unused)] // unused when target_os is not solana
use crate::controller::position::PositionDirection;
use crate::error::{DriftResult, ErrorCode};
use crate::instructions::SpotFulfillmentType;
use crate::math::safe_math::SafeMath;
use crate::math::serum::{
    calculate_price_from_serum_limit_price, calculate_serum_limit_price,
    calculate_serum_max_coin_qty,
};
use crate::math::spot_withdraw::validate_spot_market_vault_amount;
use crate::signer::get_signer_seeds;
use crate::state::events::OrderActionExplanation;
use crate::state::load_ref::load_ref;
use crate::state::spot_fulfillment_params::{ExternalSpotFill, SpotFulfillmentParams};
use crate::state::spot_market::{SpotBalanceType, SpotFulfillmentConfigStatus, SpotMarket};
use crate::state::state::State;
use crate::state::traits::Size;
use crate::{load, validate};
use anchor_lang::prelude::*;
use anchor_lang::prelude::{Account, Program, System};
use anchor_lang::{account, InstructionData, Key};
use anchor_spl::token::{Token, TokenAccount};
use arrayref::array_ref;
use openbook_v2_light::instruction::PlaceTakeOrder;
use openbook_v2_light::{
    BookSide, Market, PlaceOrderType, Side, OPEN_ORDERS_ACCOUNT_DISCRIMINATOR,
};
use solana_program::account_info::AccountInfo;
use solana_program::instruction::{AccountMeta, Instruction};
use solana_program::program::invoke_signed_unchecked;
use solana_program::pubkey::Pubkey;
use std::cell::Ref;
use std::convert::TryFrom;

#[account(zero_copy(unsafe))]
#[derive(Default, PartialEq, Eq, Debug)]
#[repr(C)]
pub struct OpenbookV2FulfillmentConfig {
    pub pubkey: Pubkey,                        //32
    pub openbook_v2_program_id: Pubkey,        // 64
    pub openbook_v2_market: Pubkey,            // 96
    pub openbook_v2_market_authority: Pubkey,  // 128
    pub openbook_v2_event_heap: Pubkey,        // 160
    pub openbook_v2_bids: Pubkey,              // 192
    pub openbook_v2_asks: Pubkey,              // 224
    pub openbook_v2_base_vault: Pubkey,        // 256
    pub openbook_v2_quote_vault: Pubkey,       // 288
    pub market_index: u16,                     // 290
    pub fulfillment_type: SpotFulfillmentType, // 291
    pub status: SpotFulfillmentConfigStatus,   // 292
    pub padding: [u8; 4],                      // 296
}

impl Size for OpenbookV2FulfillmentConfig {
    const SIZE: usize = 304;
}

pub struct OpenbookV2Context<'a, 'b> {
    pub openbook_v2_program: &'a AccountInfo<'b>,
    pub openbook_v2_market: &'a AccountInfo<'b>,
}

impl<'a, 'b> OpenbookV2Context<'a, 'b> {
    pub fn load_openbook_v2_market(&self) -> DriftResult<Market> {
        let market =
            load_ref(self.openbook_v2_market).map_err(|_| ErrorCode::FailedOpenbookV2CPI)?;
        Ok(*market)
    }

    pub fn to_openbook_v2_fulfillment_config(
        &self,
        openbook_v2_fulfillment_config_key: &Pubkey,
        market_index: u16,
    ) -> DriftResult<OpenbookV2FulfillmentConfig> {
        let market = self
            .load_openbook_v2_market()
            .map_err(|_| ErrorCode::FailedOpenbookV2CPI)?;
        Ok(OpenbookV2FulfillmentConfig {
            pubkey: *openbook_v2_fulfillment_config_key,
            openbook_v2_program_id: *self.openbook_v2_program.key,
            openbook_v2_market: *self.openbook_v2_market.key,
            openbook_v2_market_authority: market.market_authority,
            openbook_v2_event_heap: market.event_heap,
            openbook_v2_bids: market.bids,
            openbook_v2_asks: market.asks,
            openbook_v2_base_vault: market.market_base_vault,
            openbook_v2_quote_vault: market.market_quote_vault,
            market_index,
            fulfillment_type: SpotFulfillmentType::OpenbookV2,
            status: SpotFulfillmentConfigStatus::Enabled,
            padding: [0; 4],
        })
    }
}

pub struct OpenbookV2FulfillmentParams<'a, 'b> {
    pub drift_signer: &'a AccountInfo<'b>, // same as penalty payer
    pub openbook_v2_context: OpenbookV2Context<'a, 'b>,
    pub openbook_v2_market_authority: &'a AccountInfo<'b>,
    pub openbook_v2_event_heap: &'a AccountInfo<'b>,
    pub openbook_v2_bids: &'a AccountInfo<'b>,
    pub openbook_v2_asks: &'a AccountInfo<'b>,
    pub openbook_v2_base_vault: &'a AccountInfo<'b>,
    pub openbook_v2_quote_vault: &'a AccountInfo<'b>,
    pub base_market_vault: Box<Account<'b, TokenAccount>>,
    pub quote_market_vault: Box<Account<'b, TokenAccount>>,
    pub token_program: Program<'b, Token>,
    pub system_program: Program<'b, System>,
    pub signer_nonce: u8,
    pub now: i64,
    pub remaining_ooa_accounts: Vec<UncheckedAccount<'b>>,
}

impl<'a, 'b> OpenbookV2FulfillmentParams<'a, 'b> {
    #[allow(clippy::type_complexity)]
    pub fn new<'c: 'b>(
        account_info_iter: &'a mut std::iter::Peekable<std::slice::Iter<'c, AccountInfo<'b>>>,
        state: &State,
        base_market: &SpotMarket,
        quote_market: &SpotMarket,
        now: i64,
    ) -> DriftResult<Self> {
        let account_info_vec = account_info_iter.collect::<Vec<_>>();
        let mut remaining_ooa_accounts = account_info_vec
            .iter()
            .skip(14)
            .filter(|acc| {
                acc.data
                    .borrow()
                    .starts_with(&OPEN_ORDERS_ACCOUNT_DISCRIMINATOR)
            })
            .map(|acc| UncheckedAccount::try_from(*acc))
            .collect::<Vec<_>>();
        remaining_ooa_accounts.truncate(3);
        let account_infos = array_ref![account_info_vec, 0, 14];
        let [openbook_v2_fulfillment_config, drift_signer, openbook_v2_program, openbook_v2_market, openbook_v2_market_authority, openbook_v2_event_heap, openbook_v2_bids, openbook_v2_asks, openbook_v2_base_vault, openbook_v2_quote_vault, base_market_vault, quote_market_vault, token_program, system_program] =
            account_infos;
        let openbook_v2_fulfillment_config_loader: AccountLoader<OpenbookV2FulfillmentConfig> =
            AccountLoader::try_from(openbook_v2_fulfillment_config).map_err(|e| {
                msg!("{:?}", e);
                ErrorCode::InvalidFulfillmentConfig
            })?;
        let openbook_v2_fulfillment_config = load!(openbook_v2_fulfillment_config_loader)?;

        validate!(
            openbook_v2_fulfillment_config.status == SpotFulfillmentConfigStatus::Enabled,
            ErrorCode::SpotFulfillmentConfigDisabled
        )?;

        validate!(
            &state.signer == drift_signer.key,
            ErrorCode::InvalidFulfillmentConfig
        )?;

        validate!(
            openbook_v2_fulfillment_config.market_index == base_market.market_index,
            ErrorCode::InvalidFulfillmentConfig,
            "config market index {} does not equal base asset index {}",
            openbook_v2_fulfillment_config.market_index,
            base_market.market_index
        )?;

        validate!(
            &base_market.vault == base_market_vault.key,
            ErrorCode::InvalidFulfillmentConfig
        )?;

        validate!(
            &quote_market.vault == quote_market_vault.key,
            ErrorCode::InvalidFulfillmentConfig
        )?;
        validate!(
            &openbook_v2_fulfillment_config.openbook_v2_program_id == openbook_v2_program.key,
            ErrorCode::InvalidFulfillmentConfig
        )?;

        validate!(
            &openbook_v2_fulfillment_config.openbook_v2_market_authority
                == openbook_v2_market_authority.key,
            ErrorCode::InvalidFulfillmentConfig
        )?;

        validate!(
            &openbook_v2_fulfillment_config.openbook_v2_event_heap == openbook_v2_event_heap.key,
            ErrorCode::InvalidFulfillmentConfig,
            "Openbook V2 eventheap key does not match"
        )?;
        validate!(
            &openbook_v2_fulfillment_config.openbook_v2_bids == openbook_v2_bids.key,
            ErrorCode::InvalidFulfillmentConfig,
            "Openbook V2 bids key does not match"
        )?;
        validate!(
            &openbook_v2_fulfillment_config.openbook_v2_asks == openbook_v2_asks.key,
            ErrorCode::InvalidFulfillmentConfig,
            "Openbook V2 asks key does not match"
        )?;
        validate!(
            &openbook_v2_fulfillment_config.openbook_v2_base_vault == openbook_v2_base_vault.key,
            ErrorCode::InvalidFulfillmentConfig,
            "OpenbookV2 quote vault key does not match"
        )?;

        validate!(
            &openbook_v2_fulfillment_config.openbook_v2_quote_vault == openbook_v2_quote_vault.key,
            ErrorCode::InvalidFulfillmentConfig,
            "OpenbookV2 quote vault key does not match"
        )?;

        validate!(
            &openbook_v2_fulfillment_config.openbook_v2_market == openbook_v2_market.key,
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
        let token_program: Program<Token> = Program::try_from(*token_program).map_err(|e| {
            msg!("{:?}", e);
            ErrorCode::InvalidFulfillmentConfig
        })?;
        let system_program: Program<System> = Program::try_from(*system_program).map_err(|e| {
            msg!("{:?}", e);
            ErrorCode::InvalidFulfillmentConfig
        })?;
        Ok(OpenbookV2FulfillmentParams {
            drift_signer,
            openbook_v2_context: OpenbookV2Context {
                openbook_v2_program,
                openbook_v2_market,
            },
            openbook_v2_market_authority,
            openbook_v2_event_heap,
            openbook_v2_bids,
            openbook_v2_asks,
            openbook_v2_base_vault,
            openbook_v2_quote_vault,
            base_market_vault,
            quote_market_vault,
            token_program,
            system_program,
            signer_nonce: state.signer_nonce,
            now,
            remaining_ooa_accounts,
        })
    }
}

impl<'a, 'b> OpenbookV2FulfillmentParams<'a, 'b> {
    pub fn invoke_new_order(&self, data: Vec<u8>) -> DriftResult {
        let mut accounts = vec![
            AccountMeta::new(*self.drift_signer.key, true),
            AccountMeta::new(*self.drift_signer.key, true),
            AccountMeta::new(*self.openbook_v2_context.openbook_v2_market.key, false),
            AccountMeta::new_readonly(*self.openbook_v2_market_authority.key, false),
            AccountMeta::new(*self.openbook_v2_bids.key, false),
            AccountMeta::new(*self.openbook_v2_asks.key, false),
            AccountMeta::new(*self.openbook_v2_base_vault.key, false),
            AccountMeta::new(*self.openbook_v2_quote_vault.key, false),
            AccountMeta::new(*self.openbook_v2_event_heap.key, false),
            AccountMeta::new(self.base_market_vault.key(), false),
            AccountMeta::new(self.quote_market_vault.key(), false),
            AccountMeta::new_readonly(*self.openbook_v2_context.openbook_v2_program.key, false),
            AccountMeta::new_readonly(*self.openbook_v2_context.openbook_v2_program.key, false),
            AccountMeta::new_readonly(*self.token_program.key, false),
            AccountMeta::new_readonly(*self.system_program.key, false),
            AccountMeta::new_readonly(*self.openbook_v2_context.openbook_v2_program.key, false),
        ];
        let mut account_infos = vec![
            self.openbook_v2_context.openbook_v2_program.clone(),
            self.drift_signer.clone(),
            self.drift_signer.clone(),
            self.openbook_v2_context.openbook_v2_market.clone(),
            self.openbook_v2_market_authority.clone(),
            self.openbook_v2_bids.clone(),
            self.openbook_v2_asks.clone(),
            self.openbook_v2_base_vault.clone(),
            self.openbook_v2_quote_vault.clone(),
            self.openbook_v2_event_heap.clone(),
            self.base_market_vault.to_account_info(),
            self.quote_market_vault.to_account_info(),
            self.openbook_v2_context.openbook_v2_program.clone(),
            self.openbook_v2_context.openbook_v2_program.clone(),
            self.token_program.to_account_info(),
            self.system_program.to_account_info(),
            self.openbook_v2_context.openbook_v2_program.clone(),
        ];
        for unchecked_account in self.remaining_ooa_accounts.iter() {
            accounts.push(AccountMeta::new(*unchecked_account.key, false));
            account_infos.push(unchecked_account.to_account_info());
        }
        let new_place_take_order_instruction = Instruction {
            program_id: *self.openbook_v2_context.openbook_v2_program.key,
            accounts,
            data,
        };
        let signer_seeds = get_signer_seeds(&self.signer_nonce);
        let signers_seeds = &[&signer_seeds[..]];

        invoke_signed_unchecked(
            &new_place_take_order_instruction,
            &account_infos,
            signers_seeds,
        )
        .map_err(|e| {
            msg!("{:?}", e);
            ErrorCode::FailedOpenbookV2CPI
        })?;

        Ok(())
    }
}

impl<'a, 'b> SpotFulfillmentParams for OpenbookV2FulfillmentParams<'a, 'b> {
    fn is_external(&self) -> bool {
        true
    }
    fn fulfill_order(
        &mut self,
        taker_direction: PositionDirection,
        taker_price: u64,
        taker_base_asset_amount: u64,
        taker_max_quote_asset_amount: u64,
    ) -> DriftResult<ExternalSpotFill> {
        // load openbook v2 market
        let market = self.openbook_v2_context.load_openbook_v2_market()?;
        // coin - base
        // pc - quote

        let serum_max_coin_qty =
            calculate_serum_max_coin_qty(taker_base_asset_amount, market.base_lot_size as u64)?;

        let price_lots = calculate_serum_limit_price(
            taker_price,
            market.quote_lot_size as u64,
            market.base_decimals as u32,
            market.base_lot_size as u64,
            taker_direction,
        )?;

        let max_quote_lots_including_fees = (market.quote_lot_size as u64)
            .safe_mul(price_lots)?
            .safe_mul(serum_max_coin_qty)?
            .min(taker_max_quote_asset_amount) as i64;
        let max_base_lots = taker_base_asset_amount as i64 / market.base_lot_size;
        // let max_quote_lots_including_fees = if taker_max_quote_asset_amount == u64::MAX { (price_lots as i64 * max_base_lots)/market.quote_lot_size } else {taker_max_quote_asset_amount as i64/market.quote_lot_size};

        let openbook_v2_order_side = match taker_direction {
            PositionDirection::Long => Side::Bid,
            PositionDirection::Short => Side::Ask,
        };
        // the openbook v2 will take care of what is better if the price_lots or max_base or max_quote
        let args = PlaceTakeOrder {
            side: openbook_v2_order_side,
            price_lots: price_lots as i64, // i64::MAX, // 8
            // price_lots: i64::MAX,
            max_base_lots,                      // 8
            max_quote_lots_including_fees,      // 8
            order_type: PlaceOrderType::Market, // 1
            limit: 20,                          // why 50?
                                                // total - 27
        };
        let data = args.data();
        let base_before = self.base_market_vault.amount;
        let quote_before = self.quote_market_vault.amount;

        self.invoke_new_order(data)?;

        self.base_market_vault.reload().map_err(|_e| {
            msg!("Failed to reload base_market_vault");
            ErrorCode::FailedOpenbookV2CPI
        })?;
        self.quote_market_vault.reload().map_err(|_e| {
            msg!("Failed to reload quote_market_vault");
            ErrorCode::FailedOpenbookV2CPI
        })?;

        let base_after = self.base_market_vault.amount;
        let quote_after = self.quote_market_vault.amount;

        let (base_update_direction, base_asset_amount_filled) = if base_after > base_before {
            (SpotBalanceType::Deposit, base_after.safe_sub(base_before)?)
        } else {
            (SpotBalanceType::Borrow, base_before.safe_sub(base_after)?)
        };

        if base_asset_amount_filled == 0 {
            msg!("No base filled on openbook v2");
            return Ok(ExternalSpotFill::empty());
        }

        let (quote_update_direction, quote_asset_amount_filled) =
            if base_update_direction == SpotBalanceType::Borrow {
                let quote_asset_amount_delta = quote_after.safe_sub(quote_before)?;
                (SpotBalanceType::Deposit, quote_asset_amount_delta)
            } else {
                let quote_asset_amount_delta = quote_before.safe_sub(quote_after)?;
                (SpotBalanceType::Borrow, quote_asset_amount_delta)
            };
        Ok(ExternalSpotFill {
            base_asset_amount_filled,
            quote_asset_amount_filled,
            base_update_direction,
            quote_update_direction,
            fee: 0,
            unsettled_referrer_rebate: 0,
            settled_referrer_rebate: 0,
        })
    }
    fn get_best_bid_and_ask(&self) -> DriftResult<(Option<u64>, Option<u64>)> {
        let market = self.openbook_v2_context.load_openbook_v2_market()?;
        let bid_data = self.openbook_v2_bids.data.borrow();
        let bid = bytemuck::try_from_bytes::<BookSide>(&bid_data[8..]).map_err(|_| {
            msg!("Failed to parse OpenbookV2 bids");
            ErrorCode::FailedOpenbookV2CPI
        })?;
        let ask_data = self.openbook_v2_asks.data.borrow();
        let ask = bytemuck::try_from_bytes::<BookSide>(&ask_data[8..]).map_err(|_| {
            msg!("Failed to parse OpenbookV2 asks");
            ErrorCode::FailedOpenbookV2CPI
        })?;
        let bid_price: Option<u64> = match bid.find_max() {
            Some(bid) => {
                let bid_price = calculate_price_from_serum_limit_price(
                    bid,
                    market.quote_lot_size as u64,
                    market.base_decimals as u32,
                    market.base_lot_size as u64,
                )?;
                Some(bid_price)
            }
            None => None,
        };
        let ask_price: Option<u64> = match ask.find_min() {
            Some(ask) => {
                let ask_price = calculate_price_from_serum_limit_price(
                    ask,
                    market.quote_lot_size as u64,
                    market.base_decimals as u32,
                    market.base_lot_size as u64,
                )?;
                Some(ask_price)
            }
            None => None,
        };
        Ok((bid_price, ask_price))
    }

    fn get_order_action_explanation(&self) -> DriftResult<OrderActionExplanation> {
        Ok(OrderActionExplanation::OrderFilledWithOpenbookV2)
    }

    fn validate_vault_amounts(
        &self,
        base_market: &Ref<SpotMarket>,
        quote_market: &Ref<SpotMarket>,
    ) -> DriftResult {
        validate_spot_market_vault_amount(base_market, self.base_market_vault.amount)?;
        validate_spot_market_vault_amount(quote_market, self.quote_market_vault.amount)?;
        Ok(())
    }

    fn validate_markets(
        &self,
        base_market: &SpotMarket,
        quote_market: &SpotMarket,
    ) -> DriftResult<()> {
        validate!(
            self.base_market_vault.mint == base_market.mint,
            ErrorCode::DefaultError,
            "base mints dont match"
        )?;

        validate!(
            self.quote_market_vault.mint == quote_market.mint,
            ErrorCode::DefaultError,
            "base mints dont match"
        )?;

        Ok(())
    }
}

#[cfg(test)]
mod openbook_v2_test {
    use crate::math::serum::calculate_price_from_serum_limit_price;

    #[test]
    fn test_calculate_price_from_serum_limit_price() {
        // price +- 6.6.2024 170.0
        let openbook_v2_price = 170_000;
        // values from https://solscan.io/account/CFSMrBssNG8Ud1edW59jNLnq2cwrQ9uY5cM3wXmqRJj3#anchorData
        let price = calculate_price_from_serum_limit_price(
            openbook_v2_price,
            1,       // quote_lot_size
            9,       // base decimals
            1000000, // base_lot_size
        )
        .unwrap();
        assert_eq!(170_000_000, price);
    }
}
