use anchor_lang::{
    prelude::{Account, AccountInfo, Program, Pubkey},
    ToAccountInfo,
};
use anchor_spl::token::{accessor, Token, TokenAccount};
use phoenix::{
    program::{create_new_order_instruction_with_custom_token_accounts, MarketHeader},
    quantities::{Ticks, WrapperU64},
    state::{
        markets::{FIFOOrderId, FIFORestingOrder, Market},
        OrderPacket, Side,
    },
};
use solana_program::{msg, program::invoke};

use crate::error::{DriftResult, ErrorCode};

#[derive(Clone)]
pub struct PhoenixFulfillmentParams<'a, 'b> {
    pub phoenix_program: &'a AccountInfo<'b>,
    pub phoenix_log_authority: &'a AccountInfo<'b>,
    pub phoenix_market: &'a AccountInfo<'b>,
    pub trader: &'a AccountInfo<'b>,
    pub trader_base_token_account: &'a AccountInfo<'b>,
    pub trader_quote_token_account: &'a AccountInfo<'b>,
    pub phoenix_base_vault: Box<Account<'b, TokenAccount>>,
    pub phoenix_quote_vault: Box<Account<'b, TokenAccount>>,
    pub token_program: Program<'b, Token>,
}

impl<'a, 'b> PhoenixFulfillmentParams<'a, 'b> {
    pub fn to_account_infos(&self) -> [AccountInfo<'b>; 9] {
        [
            self.phoenix_program.clone(),
            self.phoenix_log_authority.clone(),
            self.phoenix_market.clone(),
            self.trader.clone(),
            self.trader_base_token_account.clone(),
            self.trader_quote_token_account.clone(),
            self.phoenix_base_vault.to_account_info(),
            self.phoenix_quote_vault.to_account_info(),
            self.token_program.to_account_info(),
        ]
    }
}

pub fn get_best_bid_and_ask_from_phoenix_market<'a, 'b>(
    header: &MarketHeader,
    market: &'a dyn Market<Pubkey, FIFOOrderId, FIFORestingOrder, OrderPacket>,
) -> DriftResult<(Option<u64>, Option<u64>)> {
    // Conversion: price_in_ticks (T) * tick_size (QL/BU * T) * quote_lot_size (QA/QL) / raw_base_units_per_base_unit (rBU/BU)
    // Yields: price (QA/rBU)
    let best_bid = market.get_book(Side::Bid).iter().next().map(|(o, _)| {
        (o.price_in_ticks * market.get_tick_size()).as_u64() * header.get_quote_lot_size().as_u64()
            / header.raw_base_units_per_base_unit as u64
    });
    let best_ask = market.get_book(Side::Ask).iter().next().map(|(o, _)| {
        (o.price_in_ticks * market.get_tick_size()).as_u64() * header.get_quote_lot_size().as_u64()
            / header.raw_base_units_per_base_unit as u64
    });
    Ok((best_bid, best_ask))
}

pub fn calculate_phoenix_limit_price<'a, 'b>(
    header: &MarketHeader,
    market: &'a dyn Market<Pubkey, FIFOOrderId, FIFORestingOrder, OrderPacket>,
    price: u64,
) -> Option<Ticks> {
    Some(
        price * header.raw_base_units_per_base_unit as u64
            / (header.get_quote_lot_size().as_u64() * market.get_tick_size().as_u64()),
    )
    .map(Ticks::new)
}

pub fn invoke_phoenix_ioc<'a, 'b>(
    phoenix_fulfillment_params: &mut PhoenixFulfillmentParams<'a, 'b>,
    order_packet: OrderPacket,
) -> DriftResult {
    let PhoenixFulfillmentParams {
        phoenix_market,
        trader,
        trader_base_token_account,
        trader_quote_token_account,
        ..
    } = phoenix_fulfillment_params;

    let base_mint = accessor::mint(&trader_base_token_account).map_err(|_| {
        msg!("Failed to get base mint from trader base token account");
        ErrorCode::FailedToGetMint
    })?;
    let quote_mint = accessor::mint(&trader_quote_token_account).map_err(|_| {
        msg!("Failed to get base mint from trader quote token account");
        ErrorCode::FailedToGetMint
    })?;

    let new_order_instruction = create_new_order_instruction_with_custom_token_accounts(
        phoenix_market.key,
        trader.key,
        trader_base_token_account.key,
        trader_quote_token_account.key,
        &base_mint,
        &quote_mint,
        &order_packet,
    );

    invoke(
        &new_order_instruction,
        &phoenix_fulfillment_params.to_account_infos(),
    )
    .map_err(|e| {
        msg!("{:?}", e);
        ErrorCode::FailedPhoenixCPI
    })?;

    Ok(())
}
