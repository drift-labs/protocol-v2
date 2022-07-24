use crate::state::user::{MarketPosition, Order, UserBankBalance};
use anchor_lang::prelude::{AccountInfo, Pubkey};
use anchor_lang::{Owner, ZeroCopy};
use bytes::BytesMut;

pub fn get_positions(position: MarketPosition) -> [MarketPosition; 5] {
    let mut positions = [MarketPosition::default(); 5];
    positions[0] = position;
    positions
}

pub fn get_orders(order: Order) -> [Order; 32] {
    let mut orders = [Order::default(); 32];
    orders[0] = order;
    orders
}

pub fn get_bank_balances(bank_balance: UserBankBalance) -> [UserBankBalance; 8] {
    let mut bank_balances = [UserBankBalance::default(); 8];
    bank_balances[0] = bank_balance;
    bank_balances
}

pub fn get_account_bytes<T: ZeroCopy + Owner>(account: &mut T) -> BytesMut {
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

#[macro_export]
macro_rules! create_account_info {
    ($account:expr, $type:ident, $name: ident) => {
        let key = Pubkey::default();
        let mut lamports = 0;
        let mut data = get_account_bytes(&mut $account);
        let owner = $type::owner();
        let $name = create_account_info(&key, true, &mut lamports, &mut data[..], &owner);
    };
    ($account:expr, $pubkey:expr, $type:ident, $name: ident) => {
        let mut lamports = 0;
        let mut data = get_account_bytes(&mut $account);
        let owner = $type::owner();
        let $name = create_account_info($pubkey, true, &mut lamports, &mut data[..], &owner);
    };
}
