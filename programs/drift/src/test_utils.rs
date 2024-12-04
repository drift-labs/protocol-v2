use anchor_lang::prelude::{AccountInfo, Pubkey};
use anchor_lang::{Owner, ZeroCopy};
use bytes::BytesMut;
use pyth_pull::{PriceFeedMessage, PriceUpdateV2, VerificationLevel};

use crate::state::user::{Order, PerpPosition, SpotPosition};

pub fn get_positions(position: PerpPosition) -> [PerpPosition; 8] {
    let mut positions = [PerpPosition::default(); 8];
    positions[0] = position;
    positions
}

pub fn get_orders(order: Order) -> [Order; 32] {
    let mut orders = [Order::default(); 32];
    orders[0] = order;
    orders
}

#[macro_export]
macro_rules! get_orders {
    ($($order: expr),+) => {
        {
            let mut orders = [Order::default(); 32];
            let mut index = 0;
            $(
                index += 1;
                orders[index - 1] = $order;
            )+
            orders
        }
    };
}

pub fn get_spot_positions(spot_position: SpotPosition) -> [SpotPosition; 8] {
    let mut spot_positions = [SpotPosition::default(); 8];
    if spot_position.market_index == 0 {
        spot_positions[0] = spot_position;
    } else {
        spot_positions[1] = spot_position;
    }
    spot_positions
}

pub fn get_account_bytes<T: bytemuck::Pod>(account: &mut T) -> BytesMut {
    let mut bytes = BytesMut::new();
    let data = bytemuck::bytes_of_mut(account);
    bytes.extend_from_slice(data);
    bytes
}

pub fn get_anchor_account_bytes<T: ZeroCopy + Owner>(account: &mut T) -> BytesMut {
    let mut bytes = BytesMut::new();
    bytes.extend_from_slice(&T::discriminator());
    let data = bytemuck::bytes_of_mut(account);
    bytes.extend_from_slice(data);
    bytes
}

pub fn create_account_info<'a>(
    key: &'a Pubkey,
    is_writable: bool,
    lamports: &'a mut u64,
    bytes: &'a mut [u8],
    owner: &'a Pubkey,
) -> AccountInfo<'a> {
    AccountInfo::new(key, false, is_writable, lamports, bytes, owner, false, 0)
}

pub fn get_pyth_price(price: i64, expo: i32) -> PriceUpdateV2 {
    let price = price * 10_i64.pow(expo as u32);
    let price_message = PriceFeedMessage {
        feed_id: [0; 32],
        price,
        conf: 0,
        exponent: expo,
        publish_time: 0,
        prev_publish_time: 0,
        ema_price: price,
        ema_conf: 0,
    };
    let price_update = PriceUpdateV2 {
        verification_level: VerificationLevel::Partial { num_signatures: 2 },
        write_authority: Pubkey::default(),
        price_message,
        posted_slot: 0,
    };
    price_update
}

pub fn get_hardcoded_pyth_price(price: i64, expo: i32) -> PriceUpdateV2 {
    let price = price * 10_i64.pow(expo as u32);
    let price_message = PriceFeedMessage {
        feed_id: [0; 32],
        price,
        conf: 0,
        exponent: expo,
        publish_time: 0,
        prev_publish_time: 0,
        ema_price: price,
        ema_conf: 0,
    };
    let price_update = PriceUpdateV2 {
        verification_level: VerificationLevel::Partial { num_signatures: 2 },
        write_authority: Pubkey::default(),
        price_message,
        posted_slot: 0,
    };
    price_update
}

#[macro_export]
macro_rules! create_anchor_account_info {
    ($account:expr, $type:ident, $name: ident) => {
        let key = Pubkey::default();
        let mut lamports = 0;
        let mut data = get_anchor_account_bytes(&mut $account);
        let owner = $type::owner();
        let $name = create_account_info(&key, true, &mut lamports, &mut data[..], &owner);
    };
    ($account:expr, $pubkey:expr, $type:ident, $name: ident) => {
        let mut lamports = 0;
        let mut data = get_anchor_account_bytes(&mut $account);
        let owner = $type::owner();
        let $name = create_account_info($pubkey, true, &mut lamports, &mut data[..], &owner);
    };
}

#[macro_export]
macro_rules! create_account_info {
    ($account:expr, $owner:expr, $name: ident) => {
        let key = Pubkey::default();
        let mut lamports = 0;
        let mut data = get_account_bytes(&mut $account);
        let owner = $type::owner();
        let $name = create_account_info(&key, true, &mut lamports, &mut data[..], $owner);
    };
    ($account:expr, $pubkey:expr, $owner:expr, $name: ident) => {
        let mut lamports = 0;
        let mut data = get_account_bytes(&mut $account);
        let $name = create_account_info($pubkey, true, &mut lamports, &mut data[..], $owner);
    };
}
