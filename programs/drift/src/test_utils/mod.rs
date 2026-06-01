use anchor_lang::prelude::{AccountInfo, Pubkey};
use anchor_lang::{Owner, ZeroCopy};
use base64;
use bytes::BytesMut;

#[cfg(test)]
pub mod legacy_snapshot;

use crate::state::pyth_lazer_oracle::PythLazerOracle;
use pyth::pc::Price;

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

/// Serializes `account` into a buffer where `bytes[disc_len..]` is aligned to `align_of::<T>()`,
/// satisfying `AccountLoader::try_from`'s alignment requirement on Rust ≥ 1.77.
pub fn get_anchor_account_bytes<T: ZeroCopy + Owner>(account: &mut T) -> AlignedAccountBytes {
    let disc = T::DISCRIMINATOR;
    let struct_bytes = bytemuck::bytes_of_mut(account);
    let struct_align = std::mem::align_of::<T>();
    let disc_len = disc.len();
    let data_len = disc_len + struct_bytes.len();

    let alloc_align = struct_align.max(16);
    let alloc_size = data_len + alloc_align;
    let layout = std::alloc::Layout::from_size_align(alloc_size, alloc_align).unwrap();
    let base = unsafe { std::alloc::alloc_zeroed(layout) };
    assert!(!base.is_null());

    let base_addr = base as usize;
    let remainder = (base_addr + disc_len) % struct_align;
    let offset = if remainder == 0 {
        0
    } else {
        struct_align - remainder
    };
    let data_ptr = unsafe { base.add(offset) };

    unsafe {
        std::ptr::copy_nonoverlapping(disc.as_ptr(), data_ptr, disc_len);
        std::ptr::copy_nonoverlapping(
            struct_bytes.as_ptr(),
            data_ptr.add(disc_len),
            struct_bytes.len(),
        );
    }

    AlignedAccountBytes {
        base,
        data_ptr,
        data_len,
        layout,
    }
}

pub struct AlignedAccountBytes {
    base: *mut u8,
    data_ptr: *mut u8,
    data_len: usize,
    layout: std::alloc::Layout,
}

impl std::ops::Deref for AlignedAccountBytes {
    type Target = [u8];
    fn deref(&self) -> &[u8] {
        unsafe { std::slice::from_raw_parts(self.data_ptr, self.data_len) }
    }
}

impl std::ops::DerefMut for AlignedAccountBytes {
    fn deref_mut(&mut self) -> &mut [u8] {
        unsafe { std::slice::from_raw_parts_mut(self.data_ptr, self.data_len) }
    }
}

impl Drop for AlignedAccountBytes {
    fn drop(&mut self) {
        unsafe { std::alloc::dealloc(self.base, self.layout) }
    }
}

/// Decodes a base64 Anchor account blob into an aligned buffer ready for `AccountLoader::try_from`.
///
/// If the decoded buffer is shorter than `sizeof::<T>()` (e.g. it predates an
/// account-size growth from a layout-extending refactor), the missing tail
/// bytes are zero-extended. This means tests using historical snapshots can
/// continue to validate behavior against new struct fields *as long as* those
/// new fields appear at the end of the struct — their zero default is what
/// gets loaded.
///
/// # Safety
/// Decoded bytes must be a valid `T` preceded by an 8-byte discriminator
/// (with trailing zero-padding to `sizeof::<T>()` interpretable as a valid
/// `T`).
pub unsafe fn aligned_account_bytes_from_b64<T: ZeroCopy + Owner>(
    b64: &str,
) -> AlignedAccountBytes {
    let decoded = base64::decode(b64).unwrap();
    let disc_len = 8;
    let required = disc_len + std::mem::size_of::<T>();
    let mut buf = vec![0u8; required.max(decoded.len())];
    buf[..decoded.len()].copy_from_slice(&decoded);
    let mut account: T = std::ptr::read_unaligned(buf[disc_len..].as_ptr() as *const T);
    get_anchor_account_bytes(&mut account)
}

pub fn create_account_info<'a>(
    key: &'a Pubkey,
    is_writable: bool,
    lamports: &'a mut u64,
    bytes: &'a mut [u8],
    owner: &'a Pubkey,
) -> AccountInfo<'a> {
    AccountInfo::new(key, false, is_writable, lamports, bytes, owner, false)
}

pub fn get_pyth_price(price: i64, expo: i32) -> PythLazerOracle {
    let mut pyth_price = PythLazerOracle::default();
    let price = price * 10_i64.pow(expo as u32);
    pyth_price.price = price;
    pyth_price.publish_time = 0;
    pyth_price.posted_slot = 0;
    pyth_price.exponent = expo;
    pyth_price
}

/// Creates a PythLazerOracle with price as raw mantissa (no multiply). Use when the price is already
/// in the correct form for the given exponent (e.g. 990000 with expo 6 for $0.99).
pub fn get_pyth_price_mantissa(price: i64, expo: i32) -> PythLazerOracle {
    let mut pyth_price = PythLazerOracle::default();
    pyth_price.price = price;
    pyth_price.publish_time = 0;
    pyth_price.posted_slot = 0;
    pyth_price.exponent = expo;
    pyth_price
}

pub fn get_hardcoded_pyth_price(price: i64, expo: i32) -> Price {
    let mut pyth_price = Price::default();
    pyth_price.agg.price = price;
    pyth_price.twap = price;
    pyth_price.expo = expo;
    pyth_price
}

#[macro_export]
macro_rules! create_anchor_account_info {
    ($account:expr, $type:ident, $name: ident) => {
        let key = anchor_lang::prelude::Pubkey::default();
        let mut lamports = 0;
        let mut data = $crate::test_utils::get_anchor_account_bytes(&mut $account);
        let owner = <$type as anchor_lang::Owner>::owner();
        let $name = $crate::test_utils::create_account_info(
            &key,
            true,
            &mut lamports,
            &mut data[..],
            &owner,
        );
    };
    ($account:expr, $pubkey:expr, $type:ident, $name: ident) => {
        let mut lamports = 0;
        let mut data = $crate::test_utils::get_anchor_account_bytes(&mut $account);
        let owner = <$type as anchor_lang::Owner>::owner();
        let $name = $crate::test_utils::create_account_info(
            $pubkey,
            true,
            &mut lamports,
            &mut data[..],
            &owner,
        );
    };
}

#[macro_export]
macro_rules! create_account_info {
    ($account:expr, $owner:expr, $name: ident) => {
        let key = anchor_lang::prelude::Pubkey::default();
        let mut lamports = 0;
        let mut data = $crate::test_utils::get_account_bytes(&mut $account);
        let $name = $crate::test_utils::create_account_info(
            &key,
            true,
            &mut lamports,
            &mut data[..],
            $owner,
        );
    };
    ($account:expr, $pubkey:expr, $owner:expr, $name: ident) => {
        let mut lamports = 0;
        let mut data = $crate::test_utils::get_account_bytes(&mut $account);
        let $name = $crate::test_utils::create_account_info(
            $pubkey,
            true,
            &mut lamports,
            &mut data[..],
            $owner,
        );
    };
}
