use std::cell::Ref;
use std::ops::DerefMut;

use anchor_lang::prelude::{AccountInfo, Pubkey};
use bytemuck::from_bytes;
use serum_dex::critbit::SlabView;
use serum_dex::matching::OrderBookState;
use serum_dex::state::Market;
use solana_program::msg;

use crate::error::{DriftResult, ErrorCode};
use crate::math::safe_unwrap::SafeUnwrap;
use crate::math::serum::calculate_price_from_serum_limit_price;
use crate::validate;

pub fn load_serum_market<'a>(
    account_info: &'a AccountInfo,
    program_id: &'a Pubkey,
) -> DriftResult<Market<'a>> {
    Market::load(account_info, program_id, false).map_err(|e| {
        msg!("{:?}", e);
        ErrorCode::InvalidSerumMarket
    })
}

pub fn load_open_orders<'a>(
    acc: &'a AccountInfo,
) -> DriftResult<Ref<'a, serum_dex::state::OpenOrders>> {
    Ok(Ref::map(strip_dex_padding(acc)?, from_bytes))
}

fn strip_dex_padding<'a>(acc: &'a AccountInfo) -> DriftResult<Ref<'a, [u8]>> {
    validate!(acc.data_len() >= 12, ErrorCode::InvalidSerumOpenOrders)?;
    let unpadded_data: Ref<[u8]> = Ref::map(
        acc.try_borrow_data()
            .map_err(|_e| ErrorCode::InvalidSerumOpenOrders)?,
        |data| {
            let data_len = data.len() - 12;
            let (_, rest) = data.split_at(5);
            let (mid, _) = rest.split_at(data_len);
            mid
        },
    );
    Ok(unpadded_data)
}

pub fn get_best_bid_and_ask<'a>(
    market_state_account_info: &'a AccountInfo,
    bids_account_info: &'a AccountInfo,
    asks_account_info: &'a AccountInfo,
    program_id: &'a Pubkey,
    base_decimals: u32,
) -> DriftResult<(Option<u64>, Option<u64>)> {
    let mut market = load_serum_market(market_state_account_info, program_id)?;

    let mut bids = market.load_bids_mut(bids_account_info).map_err(|e| {
        msg!("{:?}", e);
        ErrorCode::InvalidSerumBids
    })?;

    let mut asks = market.load_asks_mut(asks_account_info).map_err(|e| {
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
                base_decimals,
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
                base_decimals,
                order_book_state.market_state.coin_lot_size,
            )?;

            Some(price)
        }
        None => None,
    };

    Ok((best_bid, best_ask))
}
