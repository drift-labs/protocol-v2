use crate::error::{ClearingHouseResult, ErrorCode};
use crate::validate;
use anchor_lang::prelude::{AccountInfo, Pubkey};
use bytemuck::from_bytes;
use serum_dex::state::MarketState;
use solana_program::msg;
use std::cell::{Ref, RefMut};

pub fn load_market_state<'a>(
    account_info: &'a AccountInfo,
    program_id: &'a Pubkey,
) -> ClearingHouseResult<RefMut<'a, MarketState>> {
    MarketState::load(account_info, program_id, false).map_err(|e| {
        msg!("{:?}", e);
        ErrorCode::InvalidSerumMarket
    })
}

pub fn load_open_orders<'a>(
    acc: &'a AccountInfo,
) -> ClearingHouseResult<Ref<'a, serum_dex::state::OpenOrders>> {
    Ok(Ref::map(strip_dex_padding(acc)?, from_bytes))
}

fn strip_dex_padding<'a>(acc: &'a AccountInfo) -> ClearingHouseResult<Ref<'a, [u8]>> {
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
