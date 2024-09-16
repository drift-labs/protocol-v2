use crate::controller::position::PositionDirection;
use crate::error::{DriftResult, ErrorCode};
use crate::instructions::SpotFulfillmentType;
use crate::math::safe_math::SafeMath;
use crate::math::safe_unwrap::SafeUnwrap;
use crate::math::serum::{
    calculate_price_from_serum_limit_price, calculate_serum_limit_price,
    calculate_serum_max_coin_qty, calculate_serum_max_native_pc_quantity,
};
use crate::math::spot_withdraw::validate_spot_market_vault_amount;
use crate::signer::get_signer_seeds;
use crate::state::events::OrderActionExplanation;
use crate::state::spot_fulfillment_params::{ExternalSpotFill, SpotFulfillmentParams};
use crate::state::spot_market::{SpotBalanceType, SpotFulfillmentConfigStatus, SpotMarket};
use crate::state::state::State;
use crate::state::traits::Size;
use crate::{load, validate};
use anchor_lang::accounts::account_loader::AccountLoader;
use anchor_lang::prelude::*;
use anchor_lang::{Key, ToAccountInfo};
use anchor_spl::token::{Token, TokenAccount};
use arrayref::array_ref;
use bytemuck::{cast_slice, from_bytes};
use serum_dex::critbit::SlabView;
use serum_dex::instruction::{NewOrderInstructionV3, SelfTradeBehavior};
use serum_dex::matching::{OrderBookState, Side};
use serum_dex::state::Market;
use solana_program::account_info::AccountInfo;
use solana_program::instruction::Instruction;
use solana_program::msg;
use std::cell::Ref;
use std::convert::TryFrom;
use std::num::NonZeroU64;
use std::ops::{Deref, DerefMut};

#[account(zero_copy(unsafe))]
#[derive(Default, PartialEq, Eq, Debug)]
#[repr(C)]
pub struct SerumV3FulfillmentConfig {
    pub pubkey: Pubkey,
    pub serum_program_id: Pubkey,
    pub serum_market: Pubkey,
    pub serum_request_queue: Pubkey,
    pub serum_event_queue: Pubkey,
    pub serum_bids: Pubkey,
    pub serum_asks: Pubkey,
    pub serum_base_vault: Pubkey,
    pub serum_quote_vault: Pubkey,
    pub serum_open_orders: Pubkey,
    pub serum_signer_nonce: u64,
    pub market_index: u16,
    pub fulfillment_type: SpotFulfillmentType,
    pub status: SpotFulfillmentConfigStatus,
    pub padding: [u8; 4],
}

impl Size for SerumV3FulfillmentConfig {
    const SIZE: usize = 344;
}

pub struct SerumContext<'a, 'b> {
    pub serum_program: &'a AccountInfo<'b>,
    pub serum_market: &'a AccountInfo<'b>,
    pub serum_open_orders: &'a AccountInfo<'b>,
}

impl<'a, 'b> SerumContext<'a, 'b> {
    pub fn load_serum_market(&self) -> DriftResult<Market> {
        Market::load(self.serum_market, self.serum_program.key, false).map_err(|e| {
            msg!("{:?}", e);
            ErrorCode::InvalidSerumMarket
        })
    }

    pub fn load_open_orders(&self) -> DriftResult<Ref<'a, serum_dex::state::OpenOrders>> {
        validate!(
            self.serum_open_orders.data_len() >= 12,
            ErrorCode::InvalidSerumOpenOrders
        )?;
        let unpadded_data: Ref<[u8]> = Ref::map(
            self.serum_open_orders
                .try_borrow_data()
                .map_err(|_e| ErrorCode::InvalidSerumOpenOrders)?,
            |data| {
                let data_len = data.len() - 12;
                let (_, rest) = data.split_at(5);
                let (mid, _) = rest.split_at(data_len);
                mid
            },
        );
        Ok(Ref::map(unpadded_data, from_bytes))
    }

    pub fn invoke_init_open_orders(
        &self,
        authority: &'a AccountInfo<'b>,
        rent: &Sysvar<'b, Rent>,
        nonce: u8,
    ) -> DriftResult {
        let signer_seeds = get_signer_seeds(&nonce);
        let signers_seeds = &[&signer_seeds[..]];

        let data = serum_dex::instruction::MarketInstruction::InitOpenOrders.pack();
        let instruction = Instruction {
            program_id: *self.serum_program.key,
            data,
            accounts: vec![
                AccountMeta::new(*self.serum_open_orders.key, false),
                AccountMeta::new_readonly(*authority.key, true),
                AccountMeta::new_readonly(*self.serum_market.key, false),
                AccountMeta::new_readonly(*rent.to_account_info().key, false),
            ],
        };

        let account_infos = [
            self.serum_program.clone(),
            self.serum_open_orders.clone(),
            authority.clone(),
            self.serum_market.clone(),
            rent.to_account_info(),
        ];
        solana_program::program::invoke_signed(&instruction, &account_infos, signers_seeds).map_err(
            |e| {
                msg!("{:?}", e);
                ErrorCode::FailedSerumCPI
            },
        )
    }

    pub fn to_serum_v3_fulfillment_config(
        &self,
        serum_fulfillment_config_key: &Pubkey,
        market_index: u16,
    ) -> DriftResult<SerumV3FulfillmentConfig> {
        let market_state = self.load_serum_market()?;
        let market_state_event_queue = market_state.event_q;
        let serum_event_queue =
            Pubkey::try_from_slice(cast_slice::<u64, u8>(&market_state_event_queue))
                .map_err(|_| ErrorCode::InvalidSerumMarket)?;

        let market_state_request_queue = market_state.req_q;
        let serum_request_queue =
            Pubkey::try_from_slice(cast_slice::<u64, u8>(&market_state_request_queue))
                .map_err(|_| ErrorCode::InvalidSerumMarket)?;

        let market_state_bids = market_state.bids;
        let serum_bids = Pubkey::try_from_slice(cast_slice::<u64, u8>(&market_state_bids))
            .map_err(|_| ErrorCode::InvalidSerumMarket)?;

        let market_state_asks = market_state.asks;
        let serum_asks = Pubkey::try_from_slice(cast_slice::<u64, u8>(&market_state_asks))
            .map_err(|_| ErrorCode::InvalidSerumMarket)?;

        let market_state_coin_vault = market_state.coin_vault;
        let serum_base_vault =
            Pubkey::try_from_slice(cast_slice::<u64, u8>(&market_state_coin_vault))
                .map_err(|_| ErrorCode::InvalidSerumMarket)?;

        let market_state_pc_vault = market_state.pc_vault;
        let serum_quote_vault =
            Pubkey::try_from_slice(cast_slice::<u64, u8>(&market_state_pc_vault))
                .map_err(|_| ErrorCode::InvalidSerumMarket)?;
        let serum_signer_nonce = market_state.vault_signer_nonce;

        Ok(SerumV3FulfillmentConfig {
            pubkey: *serum_fulfillment_config_key,
            serum_program_id: *self.serum_program.key,
            serum_market: *self.serum_market.key,
            serum_request_queue,
            serum_event_queue,
            serum_bids,
            serum_asks,
            serum_base_vault,
            serum_quote_vault,
            serum_open_orders: *self.serum_open_orders.key,
            serum_signer_nonce,
            market_index,
            fulfillment_type: SpotFulfillmentType::SerumV3,
            status: SpotFulfillmentConfigStatus::Enabled,
            padding: [0; 4],
        })
    }
}

pub struct SerumFulfillmentParams<'a, 'b> {
    pub drift_signer: &'a AccountInfo<'b>,
    pub serum_context: SerumContext<'a, 'b>,
    pub serum_request_queue: &'a AccountInfo<'b>,
    pub serum_event_queue: &'a AccountInfo<'b>,
    pub serum_bids: &'a AccountInfo<'b>,
    pub serum_asks: &'a AccountInfo<'b>,
    pub serum_base_vault: &'a AccountInfo<'b>,
    pub serum_quote_vault: &'a AccountInfo<'b>,
    pub token_program: Program<'b, Token>,
    pub base_market_vault: Box<Account<'b, TokenAccount>>,
    pub quote_market_vault: Box<Account<'b, TokenAccount>>,
    pub srm_vault: &'a AccountInfo<'b>,
    pub serum_signer: &'a AccountInfo<'b>,
    pub signer_nonce: u8,
    pub base_mint_decimals: u32,
    pub now: i64,
}

impl<'a, 'b> Deref for SerumFulfillmentParams<'a, 'b> {
    type Target = SerumContext<'a, 'b>;

    fn deref(&self) -> &Self::Target {
        &self.serum_context
    }
}

/// Constructor for SerumFulfillmentParams
impl<'a, 'b> SerumFulfillmentParams<'a, 'b> {
    #[allow(clippy::type_complexity)]
    pub fn new<'c: 'b>(
        account_info_iter: &'a mut std::iter::Peekable<std::slice::Iter<'c, AccountInfo<'b>>>,
        state: &State,
        base_market: &SpotMarket,
        quote_market: &SpotMarket,
        now: i64,
    ) -> DriftResult<Self> {
        let account_info_vec = account_info_iter.collect::<Vec<_>>();
        let account_infos = array_ref![account_info_vec, 0, 16];
        let [serum_fulfillment_config, serum_program, serum_market, serum_request_queue, serum_event_queue, serum_bids, serum_asks, serum_base_vault, serum_quote_vault, serum_open_orders, serum_signer, drift_signer, token_program, base_market_vault, quote_market_vault, srm_vault] =
            account_infos;

        let serum_fulfillment_config_loader: AccountLoader<SerumV3FulfillmentConfig> =
            AccountLoader::try_from(serum_fulfillment_config).map_err(|e| {
                msg!("{:?}", e);
                ErrorCode::InvalidFulfillmentConfig
            })?;
        let serum_fulfillment_config = load!(serum_fulfillment_config_loader)?;

        validate!(
            serum_fulfillment_config.status == SpotFulfillmentConfigStatus::Enabled,
            ErrorCode::SpotFulfillmentConfigDisabled
        )?;

        validate!(
            &state.signer == drift_signer.key,
            ErrorCode::InvalidFulfillmentConfig
        )?;

        validate!(
            serum_fulfillment_config.market_index == base_market.market_index,
            ErrorCode::InvalidFulfillmentConfig,
            "config market index {} does not equal base asset index {}",
            serum_fulfillment_config.market_index,
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
            &serum_fulfillment_config.serum_program_id == serum_program.key,
            ErrorCode::InvalidFulfillmentConfig
        )?;

        validate!(
            &serum_fulfillment_config.serum_market == serum_market.key,
            ErrorCode::InvalidFulfillmentConfig
        )?;

        validate!(
            &serum_fulfillment_config.serum_open_orders == serum_open_orders.key,
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

        validate!(
            &state.srm_vault == srm_vault.key,
            ErrorCode::InvalidFulfillmentConfig
        )?;

        Ok(SerumFulfillmentParams {
            drift_signer,
            serum_context: SerumContext {
                serum_program,
                serum_market,
                serum_open_orders,
            },
            serum_request_queue,
            serum_event_queue,
            serum_bids,
            serum_asks,
            serum_base_vault,
            serum_quote_vault,
            token_program,
            base_market_vault,
            quote_market_vault,
            serum_signer,
            srm_vault,
            signer_nonce: state.signer_nonce,
            base_mint_decimals: base_market.decimals,
            now,
        })
    }
}

/// CPI Wrappers into Serum/Openbook
impl<'a, 'b> SerumFulfillmentParams<'a, 'b> {
    pub fn invoke_new_order(
        &self,
        taker_direction: PositionDirection,
        order: NewOrderInstructionV3,
    ) -> DriftResult {
        let drift_vault = match taker_direction {
            PositionDirection::Long => self.quote_market_vault.to_account_info(),
            PositionDirection::Short => self.base_market_vault.to_account_info(),
        };

        let data = serum_dex::instruction::MarketInstruction::NewOrderV3(order).pack();
        let mut instruction = Instruction {
            program_id: *self.serum_program.key,
            data,
            accounts: vec![
                AccountMeta::new(*self.serum_market.key, false),
                AccountMeta::new(*self.serum_open_orders.key, false),
                AccountMeta::new(*self.serum_request_queue.key, false),
                AccountMeta::new(*self.serum_event_queue.key, false),
                AccountMeta::new(*self.serum_bids.key, false),
                AccountMeta::new(*self.serum_asks.key, false),
                AccountMeta::new(*drift_vault.key, false),
                AccountMeta::new_readonly(*self.drift_signer.key, true),
                AccountMeta::new(*self.serum_base_vault.key, false),
                AccountMeta::new(*self.serum_quote_vault.key, false),
                AccountMeta::new_readonly(*self.token_program.key, false),
                AccountMeta::new_readonly(*self.drift_signer.key, false),
            ],
        };

        if self.srm_vault.key != &Pubkey::default() {
            instruction
                .accounts
                .push(AccountMeta::new_readonly(*self.srm_vault.key, false));

            let account_infos = [
                self.serum_program.clone(), // Have to add account of the program id
                self.serum_market.clone(),
                self.serum_open_orders.clone(),
                self.serum_request_queue.clone(),
                self.serum_event_queue.clone(),
                self.serum_bids.clone(),
                self.serum_asks.clone(),
                drift_vault.clone(),
                self.drift_signer.clone(),
                self.serum_base_vault.clone(),
                self.serum_quote_vault.clone(),
                self.token_program.to_account_info(),
                self.srm_vault.clone(),
            ];

            let signer_seeds = get_signer_seeds(&self.signer_nonce);
            let signers_seeds = &[&signer_seeds[..]];

            solana_program::program::invoke_signed_unchecked(
                &instruction,
                &account_infos,
                signers_seeds,
            )
            .map_err(|e| {
                msg!("{:?}", e);
                ErrorCode::FailedSerumCPI
            })
        } else {
            let account_infos = [
                self.serum_program.clone(), // Have to add account of the program id
                self.serum_market.clone(),
                self.serum_open_orders.clone(),
                self.serum_request_queue.clone(),
                self.serum_event_queue.clone(),
                self.serum_bids.clone(),
                self.serum_asks.clone(),
                drift_vault.clone(),
                self.drift_signer.clone(),
                self.serum_base_vault.clone(),
                self.serum_quote_vault.clone(),
                self.token_program.to_account_info(),
            ];

            let signer_seeds = get_signer_seeds(&self.signer_nonce);
            let signers_seeds = &[&signer_seeds[..]];

            solana_program::program::invoke_signed_unchecked(
                &instruction,
                &account_infos,
                signers_seeds,
            )
            .map_err(|e| {
                msg!("{:?}", e);
                ErrorCode::FailedSerumCPI
            })
        }
    }

    pub fn invoke_settle_funds(&self) -> DriftResult {
        let data = serum_dex::instruction::MarketInstruction::SettleFunds.pack();
        let instruction = Instruction {
            program_id: *self.serum_program.key,
            data,
            accounts: vec![
                AccountMeta::new(*self.serum_market.key, false),
                AccountMeta::new(*self.serum_open_orders.key, false),
                AccountMeta::new_readonly(*self.drift_signer.key, true),
                AccountMeta::new(*self.serum_base_vault.key, false),
                AccountMeta::new(*self.serum_quote_vault.key, false),
                AccountMeta::new(self.base_market_vault.key(), false),
                AccountMeta::new(self.quote_market_vault.key(), false),
                AccountMeta::new_readonly(*self.serum_signer.key, false),
                AccountMeta::new_readonly(*self.token_program.key, false),
                AccountMeta::new(self.quote_market_vault.key(), false),
            ],
        };

        let account_infos = [
            self.serum_program.clone(),
            self.serum_market.clone(),
            self.serum_open_orders.clone(),
            self.drift_signer.clone(),
            self.serum_base_vault.clone(),
            self.serum_quote_vault.clone(),
            self.base_market_vault.to_account_info(),
            self.quote_market_vault.to_account_info(),
            self.serum_signer.clone(),
            self.token_program.to_account_info(),
        ];

        let signer_seeds = get_signer_seeds(&self.signer_nonce);
        let signers_seeds = &[&signer_seeds[..]];

        solana_program::program::invoke_signed_unchecked(
            &instruction,
            &account_infos,
            signers_seeds,
        )
        .map_err(|e| {
            msg!("{:?}", e);
            ErrorCode::FailedSerumCPI
        })
    }
}

impl<'a, 'b> SpotFulfillmentParams for SerumFulfillmentParams<'a, 'b> {
    fn is_external(&self) -> bool {
        true
    }

    fn get_best_bid_and_ask(&self) -> DriftResult<(Option<u64>, Option<u64>)> {
        let mut market = self.load_serum_market()?;

        let mut bids = market.load_bids_mut(self.serum_bids).map_err(|e| {
            msg!("{:?}", e);
            ErrorCode::InvalidSerumBids
        })?;

        let mut asks = market.load_asks_mut(self.serum_asks).map_err(|e| {
            msg!("{:?}", e);
            ErrorCode::InvalidSerumAsks
        })?;

        let order_book_state = OrderBookState {
            bids: bids.deref_mut(),
            asks: asks.deref_mut(),
            market_state: market.deref_mut(),
        };

        let best_bid = match order_book_state.bids.find_max() {
            Some(best_bid_h) => {
                let best_bid_ref = order_book_state
                    .bids
                    .get(best_bid_h)
                    .safe_unwrap()?
                    .as_leaf()
                    .safe_unwrap()?;

                let price = calculate_price_from_serum_limit_price(
                    best_bid_ref.price().get(),
                    order_book_state.market_state.pc_lot_size,
                    self.base_mint_decimals,
                    order_book_state.market_state.coin_lot_size,
                )?;

                Some(price)
            }
            None => None,
        };

        let best_ask = match order_book_state.asks.find_min() {
            Some(best_ask_h) => {
                let best_ask_ref = order_book_state
                    .asks
                    .get(best_ask_h)
                    .safe_unwrap()?
                    .as_leaf()
                    .safe_unwrap()?;

                let price = calculate_price_from_serum_limit_price(
                    best_ask_ref.price().get(),
                    order_book_state.market_state.pc_lot_size,
                    self.base_mint_decimals,
                    order_book_state.market_state.coin_lot_size,
                )?;

                Some(price)
            }
            None => None,
        };

        Ok((best_bid, best_ask))
    }

    fn fulfill_order(
        &mut self,
        taker_direction: PositionDirection,
        taker_price: u64,
        taker_base_asset_amount: u64,
        taker_max_quote_asset_amount: u64,
    ) -> DriftResult<ExternalSpotFill> {
        let market_state_before = self.load_serum_market()?;

        let serum_order_side = match taker_direction {
            PositionDirection::Long => Side::Bid,
            PositionDirection::Short => Side::Ask,
        };

        let serum_max_coin_qty = calculate_serum_max_coin_qty(
            taker_base_asset_amount,
            market_state_before.coin_lot_size,
        )?;

        let serum_limit_price = calculate_serum_limit_price(
            taker_price,
            market_state_before.pc_lot_size,
            self.base_mint_decimals,
            market_state_before.coin_lot_size,
            taker_direction,
        )?;

        let serum_max_native_pc_qty = calculate_serum_max_native_pc_quantity(
            serum_limit_price,
            serum_max_coin_qty,
            market_state_before.pc_lot_size,
        )?
        .min(taker_max_quote_asset_amount);

        if serum_max_coin_qty == 0 || serum_max_native_pc_qty == 0 {
            return Ok(ExternalSpotFill::empty());
        }

        let serum_order = NewOrderInstructionV3 {
            side: serum_order_side,
            limit_price: NonZeroU64::new(serum_limit_price).safe_unwrap()?,
            max_coin_qty: NonZeroU64::new(serum_max_coin_qty).safe_unwrap()?, // max base to deposit into serum
            max_native_pc_qty_including_fees: NonZeroU64::new(serum_max_native_pc_qty)
                .safe_unwrap()?, // max quote to deposit into serum
            self_trade_behavior: SelfTradeBehavior::AbortTransaction,
            order_type: serum_dex::matching::OrderType::ImmediateOrCancel,
            client_order_id: 0,
            limit: 10,
            max_ts: self.now,
        };

        let _market_fees_accrued_before = market_state_before.pc_fees_accrued;
        let base_before = self.base_market_vault.amount;
        let quote_before = self.quote_market_vault.amount;
        let market_rebates_accrued_before = market_state_before.referrer_rebates_accrued;

        drop(market_state_before);

        self.invoke_new_order(taker_direction, serum_order)?;

        let market_state_after = self.load_serum_market()?;

        let _market_fees_accrued_after = market_state_after.pc_fees_accrued;
        let market_rebates_accrued_after = market_state_after.referrer_rebates_accrued;

        drop(market_state_after);

        let open_orders_before = self.load_open_orders()?;
        let unsettled_referrer_rebate_before = open_orders_before.referrer_rebates_accrued;

        drop(open_orders_before);

        self.invoke_settle_funds()?;

        self.base_market_vault.reload().map_err(|_e| {
            msg!("Failed to reload base_market_vault");
            ErrorCode::FailedSerumCPI
        })?;
        self.quote_market_vault.reload().map_err(|_e| {
            msg!("Failed to reload quote_market_vault");
            ErrorCode::FailedSerumCPI
        })?;

        let base_after = self.base_market_vault.amount;
        let quote_after = self.quote_market_vault.amount;

        let open_orders_after = self.load_open_orders()?;
        let unsettled_referrer_rebate_after = open_orders_after.referrer_rebates_accrued;

        drop(open_orders_after);

        let settled_referred_rebate =
            unsettled_referrer_rebate_before.safe_sub(unsettled_referrer_rebate_after)?;

        let (base_update_direction, base_asset_amount_filled) = if base_after > base_before {
            (SpotBalanceType::Deposit, base_after.safe_sub(base_before)?)
        } else {
            (SpotBalanceType::Borrow, base_before.safe_sub(base_after)?)
        };

        if base_asset_amount_filled == 0 {
            msg!("No base filled on serum");
            return Ok(ExternalSpotFill::empty());
        }

        let serum_referrer_rebate =
            market_rebates_accrued_after.safe_sub(market_rebates_accrued_before)?;

        // rebate is half of taker fee
        let serum_fee = serum_referrer_rebate;

        let (quote_update_direction, quote_asset_amount_filled) =
            if base_update_direction == SpotBalanceType::Borrow {
                let quote_asset_amount_delta = quote_after
                    .safe_sub(quote_before)?
                    .safe_sub(settled_referred_rebate)?;

                (
                    SpotBalanceType::Deposit,
                    quote_asset_amount_delta
                        .safe_add(serum_fee)?
                        .safe_add(serum_referrer_rebate)?,
                )
            } else {
                let quote_asset_amount_delta = quote_before
                    .safe_add(settled_referred_rebate)?
                    .safe_sub(quote_after)?;

                (
                    SpotBalanceType::Borrow,
                    quote_asset_amount_delta
                        .safe_sub(serum_fee)?
                        .safe_sub(serum_referrer_rebate)?,
                )
            };

        Ok(ExternalSpotFill {
            base_asset_amount_filled,
            quote_asset_amount_filled,
            base_update_direction,
            quote_update_direction,
            fee: serum_fee,
            unsettled_referrer_rebate: serum_referrer_rebate,
            settled_referrer_rebate: settled_referred_rebate,
        })
    }

    fn get_order_action_explanation(&self) -> DriftResult<OrderActionExplanation> {
        Ok(OrderActionExplanation::OrderFillWithSerum)
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
