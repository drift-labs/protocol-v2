#![no_std]

//! Layout constants and read/write views for PropAMM accounts (V1 interface).
//!
//! ## Standardized PropAMMAccountHeaderV1 layout
//!
//! | Offset | Size | Field |
//! |--------|------|-------|
//! | 0 | 8 | Discriminator (`"prammacc"`) |
//! | 8 | 1 | Version (u8, must be 1) |
//! | 9 | 1 | Flags (u8, must be 0 in V1) |
//! | 10 | 2 | Header length (u16 LE, >= 96) |
//! | 12 | 2 | Market index (u16 LE) |
//! | 14 | 32 | Maker subaccount (Pubkey, Drift User PDA) |
//! | 46 | 8 | Sequence number (u64 LE, monotonically increasing, wraps) |
//! | 54 | 8 | Valid until slot (u64 LE, live iff current_slot <= valid_until_slot) |
//! | 62 | 8 | Reference price (u64 LE, reprices whole ladder in O(1)) |
//! | 70 | 4 | Quote data offset (u32 LE, start of quote block) |
//! | 74 | 4 | Quote data length (u32 LE, total bytes of quote block) |
//! | 78 | 2 | Ask length (u16 LE) |
//! | 80 | 2 | Bid length (u16 LE) |
//! | 82 | 2 | Ask head (u16 LE, index of first non-empty ask) |
//! | 84 | 2 | Bid head (u16 LE, index of first non-empty bid) |
//! | 86 | 2 | Level entry size (u16 LE, stride per level, >= 10) |
//! | 88 | 8 | Reserved (zero) |
//!
//! ## Quote block (at quote_data_offset)
//!
//! Asks \[0, ask_len) then bids \[ask_len, ask_len+bid_len).
//! Each level is at least 10 bytes: `tick_count: u16 LE` + `base_asset_amount: u64 LE`.
//! Effective price = `reference_price ± tick_count * tick_size` (+ for asks, − for bids).
//! Maximum levels per book: 128 (asks + bids combined).

// -- Standardized header constants --

pub const DISCRIMINATOR_OFFSET: usize = 0;
pub const DISCRIMINATOR_SIZE: usize = 8;
pub const PROPAMM_ACCOUNT_DISCRIMINATOR: [u8; 8] = [b'p', b'r', b'a', b'm', b'm', b'a', b'c', b'c'];

pub const VERSION_OFFSET: usize = DISCRIMINATOR_OFFSET + DISCRIMINATOR_SIZE; // 8
pub const VERSION_V1: u8 = 1;

pub const FLAGS_OFFSET: usize = VERSION_OFFSET + 1; // 9

pub const HEADER_LEN_OFFSET: usize = FLAGS_OFFSET + 1; // 10

pub const MARKET_INDEX_OFFSET: usize = HEADER_LEN_OFFSET + 2; // 12

pub const MAKER_SUBACCOUNT_OFFSET: usize = MARKET_INDEX_OFFSET + 2; // 14

pub const SEQUENCE_NUMBER_OFFSET: usize = MAKER_SUBACCOUNT_OFFSET + 32; // 46

pub const VALID_UNTIL_SLOT_OFFSET: usize = SEQUENCE_NUMBER_OFFSET + 8; // 54

pub const REFERENCE_PRICE_OFFSET: usize = VALID_UNTIL_SLOT_OFFSET + 8; // 62

pub const QUOTE_DATA_OFFSET_FIELD: usize = REFERENCE_PRICE_OFFSET + 8; // 70

pub const QUOTE_DATA_LEN_FIELD: usize = QUOTE_DATA_OFFSET_FIELD + 4; // 74

pub const ASK_LEN_OFFSET: usize = QUOTE_DATA_LEN_FIELD + 4; // 78

pub const BID_LEN_OFFSET: usize = ASK_LEN_OFFSET + 2; // 80

pub const ASK_HEAD_OFFSET: usize = BID_LEN_OFFSET + 2; // 82

pub const BID_HEAD_OFFSET: usize = ASK_HEAD_OFFSET + 2; // 84

pub const LEVEL_ENTRY_SIZE_OFFSET: usize = BID_HEAD_OFFSET + 2; // 86

pub const RESERVED_OFFSET: usize = LEVEL_ENTRY_SIZE_OFFSET + 2; // 88
const RESERVED_SIZE: usize = 8;

/// Size of the standardized V1 header in bytes.
pub const STANDARDIZED_HEADER_SIZE: usize = RESERVED_OFFSET + RESERVED_SIZE; // 96

/// Default (and minimum) level entry size: tick_count u16 + base_asset_amount u64.
pub const LEVEL_ENTRY_SIZE: usize = 10;

/// Maximum number of levels (asks + bids combined).
pub const MAX_ORDERS: usize = 128;

/// Minimum account data length for a valid PropAMM account (header only, no levels).
pub const ACCOUNT_MIN_LEN: usize = STANDARDIZED_HEADER_SIZE; // 96

// -----------------------------------------------------------------------------
// apply_fills instruction (CPI from exchange: remove filled levels, update books)
// -----------------------------------------------------------------------------

/// Instruction discriminator for apply_fills.
pub const APPLY_FILLS_OPCODE: u8 = 3;

/// Per-fill entry in apply_fills payload: abs_index (u16) + is_ask (u8) + fill_size (u64) = 11 bytes.
pub const APPLY_FILL_ENTRY_SIZE: usize = 11;
/// market_index at start of payload (u16 LE).
pub const APPLY_FILLS_MARKET_INDEX_SIZE: usize = 2;
/// num_fills per maker (u16 LE).
pub const APPLY_FILLS_NUM_FILLS_SIZE: usize = 2;
/// expected_sequence per maker (u64 LE).
pub const APPLY_FILLS_SEQ_NUM_SIZE: usize = 8;

/// Sink for building apply_fills instruction data without allocating inside this crate.
pub trait ApplyFillsSink {
    fn extend_from_slice(&mut self, bytes: &[u8]);
}

/// Writes full apply_fills instruction data (opcode + market_index + per-maker batches).
/// Each batch is (expected_sequence, fills) where each fill is (abs_index, is_ask, fill_size).
pub fn write_apply_fills_instruction_data<S: ApplyFillsSink>(
    sink: &mut S,
    market_index: u16,
    maker_batches: &[(u64, &[(u16, bool, u64)])],
) {
    sink.extend_from_slice(&[APPLY_FILLS_OPCODE]);
    sink.extend_from_slice(&market_index.to_le_bytes());
    for (expected_sequence, fills) in maker_batches.iter() {
        sink.extend_from_slice(&(fills.len() as u16).to_le_bytes());
        sink.extend_from_slice(&expected_sequence.to_le_bytes());
        for (abs_index, is_ask, fill_size) in fills.iter() {
            sink.extend_from_slice(&abs_index.to_le_bytes());
            sink.extend_from_slice(&[u8::from(*is_ask)]);
            sink.extend_from_slice(&fill_size.to_le_bytes());
        }
    }
}

// -----------------------------------------------------------------------------
// First crossing level (matching: find first book level that crosses taker's limit)
// -----------------------------------------------------------------------------

/// Which side of the book the taker is taking (Long = taking asks, Short = taking bids).
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum TakingSide {
    /// Taker is buyer; scan asks, cross when maker_price <= taker_limit.
    TakingAsks,
    /// Taker is seller; scan bids, cross when maker_price >= taker_limit.
    TakingBids,
}

/// First book level that crosses the taker's limit price (price, size, abs_index, is_ask).
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct FirstCrossingLevel {
    pub price: u64,
    pub size: u64,
    pub abs_index: usize,
    pub is_ask: bool,
}

fn maker_price_from_ticks(
    reference_price: u64,
    tick_count: u16,
    tick_size: u64,
    is_ask: bool,
) -> Option<u64> {
    if tick_count == 0 {
        return None;
    }
    let delta = (tick_count as u64).checked_mul(tick_size)?;
    if is_ask {
        reference_price.checked_add(delta)
    } else {
        reference_price.checked_sub(delta)
    }
}

fn is_crossing(side: TakingSide, taker_limit_price: u64, maker_price: u64) -> bool {
    match side {
        TakingSide::TakingAsks => maker_price <= taker_limit_price,
        TakingSide::TakingBids => maker_price >= taker_limit_price,
    }
}

// -----------------------------------------------------------------------------

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum BookError {
    InvalidData,
    InvalidOrders,
}

pub struct MidpriceBookView<'a> {
    data: &'a [u8],
    orders_data_offset: usize,
    entry_size: usize,
}

pub struct MidpriceBookViewMut<'a> {
    data: &'a mut [u8],
    orders_data_offset: usize,
    entry_size: usize,
}

/// Validate header fields and return (quote_data_offset, level_entry_size).
fn detect_layout(data: &[u8]) -> Result<(usize, usize), BookError> {
    if data.len() < STANDARDIZED_HEADER_SIZE {
        return Err(BookError::InvalidData);
    }
    let version = data[VERSION_OFFSET];
    if version != VERSION_V1 {
        return Err(BookError::InvalidData);
    }
    if data[FLAGS_OFFSET] != 0 {
        return Err(BookError::InvalidData);
    }
    let header_len = read_u16(data, HEADER_LEN_OFFSET) as usize;
    if header_len < STANDARDIZED_HEADER_SIZE {
        return Err(BookError::InvalidData);
    }
    let quote_data_offset = read_u32(data, QUOTE_DATA_OFFSET_FIELD) as usize;
    let entry_size = read_u16(data, LEVEL_ENTRY_SIZE_OFFSET) as usize;
    if entry_size < LEVEL_ENTRY_SIZE {
        return Err(BookError::InvalidData);
    }
    Ok((quote_data_offset, entry_size))
}

impl<'a> MidpriceBookView<'a> {
    pub fn new(data: &'a [u8]) -> Result<Self, BookError> {
        if data.len() < STANDARDIZED_HEADER_SIZE {
            return Err(BookError::InvalidData);
        }
        if data[DISCRIMINATOR_OFFSET..DISCRIMINATOR_OFFSET + DISCRIMINATOR_SIZE]
            != PROPAMM_ACCOUNT_DISCRIMINATOR
        {
            return Err(BookError::InvalidData);
        }
        let (orders_data_offset, entry_size) = detect_layout(data)?;
        let v = Self {
            data,
            orders_data_offset,
            entry_size,
        };
        v.validate_bounds()?;
        Ok(v)
    }

    /// Maker subaccount pubkey (Drift User PDA, 32 bytes).
    pub fn maker_subaccount(&self) -> Result<[u8; 32], BookError> {
        self.data[MAKER_SUBACCOUNT_OFFSET..MAKER_SUBACCOUNT_OFFSET + 32]
            .try_into()
            .map_err(|_| BookError::InvalidData)
    }

    /// Reference price (reprices whole ladder in O(1)).
    pub fn reference_price(&self) -> u64 {
        read_u64(self.data, REFERENCE_PRICE_OFFSET)
    }

    /// Absolute slot deadline for quote liveness.
    pub fn valid_until_slot(&self) -> u64 {
        read_u64(self.data, VALID_UNTIL_SLOT_OFFSET)
    }

    pub fn sequence_number(&self) -> u64 {
        read_u64(self.data, SEQUENCE_NUMBER_OFFSET)
    }

    pub fn market_index(&self) -> u16 {
        read_u16(self.data, MARKET_INDEX_OFFSET)
    }

    pub fn ask_len(&self) -> u16 {
        read_u16(self.data, ASK_LEN_OFFSET)
    }

    pub fn bid_len(&self) -> u16 {
        read_u16(self.data, BID_LEN_OFFSET)
    }

    pub fn ask_head(&self) -> u16 {
        read_u16(self.data, ASK_HEAD_OFFSET)
    }

    pub fn bid_head(&self) -> u16 {
        read_u16(self.data, BID_HEAD_OFFSET)
    }

    /// Level entry stride in bytes (10 default, may be larger if extended).
    pub fn level_entry_size(&self) -> usize {
        self.entry_size
    }

    pub fn order_tick_count_u16(&self, index: usize) -> Result<u16, BookError> {
        let base = entry_base(
            self.data,
            index,
            self.total_orders(),
            self.orders_data_offset,
            self.entry_size,
        )?;
        Ok(u16::from_le_bytes(
            self.data[base..base + 2]
                .try_into()
                .map_err(|_| BookError::InvalidData)?,
        ))
    }

    pub fn order_size_u64(&self, index: usize) -> Result<u64, BookError> {
        let base = entry_base(
            self.data,
            index,
            self.total_orders(),
            self.orders_data_offset,
            self.entry_size,
        )?;
        Ok(u64::from_le_bytes(
            self.data[base + 2..base + 10]
                .try_into()
                .map_err(|_| BookError::InvalidData)?,
        ))
    }

    pub fn total_orders(&self) -> usize {
        self.ask_len() as usize + self.bid_len() as usize
    }

    /// First level in the book that crosses the taker's limit (if any).
    /// `start_from_abs_index`: if provided, start scanning from this index; otherwise start from ask_head (TakingAsks) or bid_head (TakingBids).
    pub fn find_first_crossing_level(
        &self,
        side: TakingSide,
        reference_price: u64,
        taker_limit_price: u64,
        start_from_abs_index: Option<usize>,
        tick_size: u64,
    ) -> Result<Option<FirstCrossingLevel>, BookError> {
        let ask_len = self.ask_len() as usize;
        let bid_len = self.bid_len() as usize;
        let ask_head = self.ask_head() as usize;
        let bid_head = self.bid_head() as usize;

        let (default_start, end, is_ask) = match side {
            TakingSide::TakingAsks => (ask_head, ask_len, true),
            TakingSide::TakingBids => (ask_len + bid_head, ask_len + bid_len, false),
        };
        let start = start_from_abs_index
            .unwrap_or(default_start)
            .max(default_start);

        for abs_index in start..end {
            let size = self.order_size_u64(abs_index)?;
            if size == 0 {
                continue;
            }
            let tick_count = self.order_tick_count_u16(abs_index)?;
            let Some(price) =
                maker_price_from_ticks(reference_price, tick_count, tick_size, is_ask)
            else {
                continue;
            };
            if !is_crossing(side, taker_limit_price, price) {
                return Ok(None);
            }
            return Ok(Some(FirstCrossingLevel {
                price,
                size,
                abs_index,
                is_ask,
            }));
        }
        Ok(None)
    }

    pub fn validate_bounds(&self) -> Result<(), BookError> {
        validate_bounds_inner(self.data, self.orders_data_offset, self.entry_size)
    }
}

impl<'a> MidpriceBookViewMut<'a> {
    pub fn new(data: &'a mut [u8]) -> Result<Self, BookError> {
        let (orders_data_offset, entry_size) = detect_layout(data)?;
        let v = Self {
            data,
            orders_data_offset,
            entry_size,
        };
        v.validate_bounds()?;
        Ok(v)
    }

    pub fn ask_len(&self) -> u16 {
        read_u16(self.data, ASK_LEN_OFFSET)
    }

    pub fn bid_len(&self) -> u16 {
        read_u16(self.data, BID_LEN_OFFSET)
    }

    pub fn ask_head(&self) -> u16 {
        read_u16(self.data, ASK_HEAD_OFFSET)
    }

    pub fn bid_head(&self) -> u16 {
        read_u16(self.data, BID_HEAD_OFFSET)
    }

    pub fn sequence_number(&self) -> u64 {
        read_u64(self.data, SEQUENCE_NUMBER_OFFSET)
    }

    pub fn increment_sequence_number(&mut self) -> u64 {
        let next = self.sequence_number().wrapping_add(1);
        write_u64(self.data, SEQUENCE_NUMBER_OFFSET, next);
        next
    }

    pub fn set_lengths_and_reset_heads(
        &mut self,
        ask_len: u16,
        bid_len: u16,
    ) -> Result<(), BookError> {
        write_u16(self.data, ASK_LEN_OFFSET, ask_len);
        write_u16(self.data, BID_LEN_OFFSET, bid_len);
        write_u16(self.data, ASK_HEAD_OFFSET, 0);
        write_u16(self.data, BID_HEAD_OFFSET, 0);
        // Update quote_data_len to match new level count.
        let total = ask_len as usize + bid_len as usize;
        let entry_size = read_u16(self.data, LEVEL_ENTRY_SIZE_OFFSET) as usize;
        write_u32(self.data, QUOTE_DATA_LEN_FIELD, (total * entry_size) as u32);
        self.validate_bounds()
    }

    pub fn set_order_size_u64(&mut self, index: usize, size: u64) -> Result<(), BookError> {
        let base = entry_base(
            self.data,
            index,
            self.total_orders(),
            self.orders_data_offset,
            self.entry_size,
        )?;
        self.data[base + 2..base + 10].copy_from_slice(&size.to_le_bytes());
        Ok(())
    }

    pub fn order_size_u64(&self, index: usize) -> Result<u64, BookError> {
        let base = entry_base(
            self.data,
            index,
            self.total_orders(),
            self.orders_data_offset,
            self.entry_size,
        )?;
        Ok(u64::from_le_bytes(
            self.data[base + 2..base + 10]
                .try_into()
                .map_err(|_| BookError::InvalidData)?,
        ))
    }

    pub fn advance_ask_head_while_empty(&mut self) -> Result<u16, BookError> {
        let ask_len = self.ask_len() as usize;
        let mut ask_head = self.ask_head() as usize;
        while ask_head < ask_len {
            let sz = self.order_size_u64(ask_head)?;
            if sz != 0 {
                break;
            }
            ask_head += 1;
        }
        let ask_head_u16 = u16::try_from(ask_head).map_err(|_| BookError::InvalidOrders)?;
        write_u16(self.data, ASK_HEAD_OFFSET, ask_head_u16);
        Ok(ask_head_u16)
    }

    pub fn advance_bid_head_while_empty(&mut self) -> Result<u16, BookError> {
        let ask_len = self.ask_len() as usize;
        let bid_len = self.bid_len() as usize;
        let mut bid_head = self.bid_head() as usize;
        while bid_head < bid_len {
            let abs_index = ask_len + bid_head;
            let sz = self.order_size_u64(abs_index)?;
            if sz != 0 {
                break;
            }
            bid_head += 1;
        }
        let bid_head_u16 = u16::try_from(bid_head).map_err(|_| BookError::InvalidOrders)?;
        write_u16(self.data, BID_HEAD_OFFSET, bid_head_u16);
        Ok(bid_head_u16)
    }

    pub fn total_orders(&self) -> usize {
        self.ask_len() as usize + self.bid_len() as usize
    }

    pub fn validate_bounds(&self) -> Result<(), BookError> {
        validate_bounds_inner(self.data, self.orders_data_offset, self.entry_size)
    }
}

fn validate_bounds_inner(
    data: &[u8],
    orders_data_offset: usize,
    entry_size: usize,
) -> Result<(), BookError> {
    let ask_len = read_u16(data, ASK_LEN_OFFSET) as usize;
    let bid_len = read_u16(data, BID_LEN_OFFSET) as usize;
    let ask_head = read_u16(data, ASK_HEAD_OFFSET) as usize;
    let bid_head = read_u16(data, BID_HEAD_OFFSET) as usize;
    let total = ask_len
        .checked_add(bid_len)
        .ok_or(BookError::InvalidOrders)?;
    if total > MAX_ORDERS {
        return Err(BookError::InvalidOrders);
    }
    if ask_head > ask_len || bid_head > bid_len {
        return Err(BookError::InvalidOrders);
    }
    let data_bytes = total
        .checked_mul(entry_size)
        .ok_or(BookError::InvalidOrders)?;
    let end = orders_data_offset
        .checked_add(data_bytes)
        .ok_or(BookError::InvalidOrders)?;
    if end > data.len() {
        return Err(BookError::InvalidData);
    }
    Ok(())
}

fn entry_base(
    data: &[u8],
    index: usize,
    total_orders: usize,
    orders_data_offset: usize,
    entry_size: usize,
) -> Result<usize, BookError> {
    if index >= total_orders {
        return Err(BookError::InvalidOrders);
    }
    let data_bytes = total_orders
        .checked_mul(entry_size)
        .ok_or(BookError::InvalidOrders)?;
    let end = orders_data_offset
        .checked_add(data_bytes)
        .ok_or(BookError::InvalidOrders)?;
    if end > data.len() {
        return Err(BookError::InvalidData);
    }
    orders_data_offset
        .checked_add(index * entry_size)
        .ok_or(BookError::InvalidOrders)
}

fn read_u16(data: &[u8], offset: usize) -> u16 {
    u16::from_le_bytes([data[offset], data[offset + 1]])
}

fn write_u16(data: &mut [u8], offset: usize, value: u16) {
    data[offset..offset + 2].copy_from_slice(&value.to_le_bytes());
}

fn read_u32(data: &[u8], offset: usize) -> u32 {
    u32::from_le_bytes([
        data[offset],
        data[offset + 1],
        data[offset + 2],
        data[offset + 3],
    ])
}

fn write_u32(data: &mut [u8], offset: usize, value: u32) {
    data[offset..offset + 4].copy_from_slice(&value.to_le_bytes());
}

fn read_u64(data: &[u8], offset: usize) -> u64 {
    let bytes: [u8; 8] = [
        data[offset],
        data[offset + 1],
        data[offset + 2],
        data[offset + 3],
        data[offset + 4],
        data[offset + 5],
        data[offset + 6],
        data[offset + 7],
    ];
    u64::from_le_bytes(bytes)
}

fn write_u64(data: &mut [u8], offset: usize, value: u64) {
    data[offset..offset + 8].copy_from_slice(&value.to_le_bytes());
}

// ---------------------------------------------------------------------------
// Test utilities: account buffer builder for downstream test code
// ---------------------------------------------------------------------------

#[cfg(any(test, feature = "test-utils"))]
extern crate alloc;

/// Builder for constructing PropAMM account buffers in tests.
/// Gated behind `#[cfg(test)]` or `feature = "test-utils"`.
#[cfg(any(test, feature = "test-utils"))]
pub mod test_utils {
    use super::*;
    use alloc::vec;
    use alloc::vec::Vec;

    /// A level entry for the builder: tick count + size.
    #[derive(Clone, Copy)]
    pub struct Level {
        pub tick_count: u16,
        pub size: u64,
    }

    /// Build a PropAMM V1 account buffer with the given parameters.
    /// Quote data starts right after the standardized header (offset 96).
    pub fn build_midprice_account(
        reference_price: u64,
        maker_subaccount: &[u8; 32],
        market_index: u16,
        valid_until_slot: u64,
        asks: &[Level],
        bids: &[Level],
    ) -> Vec<u8> {
        let total = asks.len() + bids.len();
        assert!(total <= MAX_ORDERS);
        let quote_data_start = STANDARDIZED_HEADER_SIZE;
        let mut data = vec![0u8; quote_data_start + total * LEVEL_ENTRY_SIZE];

        // Header
        data[DISCRIMINATOR_OFFSET..DISCRIMINATOR_OFFSET + DISCRIMINATOR_SIZE]
            .copy_from_slice(&PROPAMM_ACCOUNT_DISCRIMINATOR);
        data[VERSION_OFFSET] = VERSION_V1;
        data[FLAGS_OFFSET] = 0;
        write_u16(
            &mut data,
            HEADER_LEN_OFFSET,
            STANDARDIZED_HEADER_SIZE as u16,
        );
        write_u16(&mut data, MARKET_INDEX_OFFSET, market_index);
        data[MAKER_SUBACCOUNT_OFFSET..MAKER_SUBACCOUNT_OFFSET + 32]
            .copy_from_slice(maker_subaccount);
        write_u64(&mut data, VALID_UNTIL_SLOT_OFFSET, valid_until_slot);
        write_u64(&mut data, REFERENCE_PRICE_OFFSET, reference_price);
        write_u32(&mut data, QUOTE_DATA_OFFSET_FIELD, quote_data_start as u32);
        write_u32(
            &mut data,
            QUOTE_DATA_LEN_FIELD,
            (total * LEVEL_ENTRY_SIZE) as u32,
        );
        write_u16(&mut data, ASK_LEN_OFFSET, asks.len() as u16);
        write_u16(&mut data, BID_LEN_OFFSET, bids.len() as u16);
        write_u16(&mut data, ASK_HEAD_OFFSET, 0);
        write_u16(&mut data, BID_HEAD_OFFSET, 0);
        write_u16(&mut data, LEVEL_ENTRY_SIZE_OFFSET, LEVEL_ENTRY_SIZE as u16);

        // Levels: asks then bids
        let mut off = quote_data_start;
        for level in asks.iter().chain(bids.iter()) {
            data[off..off + 2].copy_from_slice(&level.tick_count.to_le_bytes());
            data[off + 2..off + 10].copy_from_slice(&level.size.to_le_bytes());
            off += LEVEL_ENTRY_SIZE;
        }

        data
    }
}

#[cfg(test)]
mod tests {
    extern crate std;
    use super::*;
    use std::vec;

    /// For tests, quote data starts right after the standardized header.
    const TEST_QUOTE_DATA_START: usize = STANDARDIZED_HEADER_SIZE;

    fn make_buffer(num_orders: usize) -> std::vec::Vec<u8> {
        vec![0u8; TEST_QUOTE_DATA_START + num_orders * LEVEL_ENTRY_SIZE]
    }

    fn init_header(buf: &mut [u8]) {
        buf[DISCRIMINATOR_OFFSET..DISCRIMINATOR_OFFSET + DISCRIMINATOR_SIZE]
            .copy_from_slice(&PROPAMM_ACCOUNT_DISCRIMINATOR);
        buf[VERSION_OFFSET] = VERSION_V1;
        buf[FLAGS_OFFSET] = 0;
        write_u16(buf, HEADER_LEN_OFFSET, STANDARDIZED_HEADER_SIZE as u16);
        write_u32(buf, QUOTE_DATA_OFFSET_FIELD, TEST_QUOTE_DATA_START as u32);
        write_u32(buf, QUOTE_DATA_LEN_FIELD, 0);
        write_u16(buf, LEVEL_ENTRY_SIZE_OFFSET, LEVEL_ENTRY_SIZE as u16);
    }

    #[test]
    fn test_layout_offsets() {
        assert_eq!(DISCRIMINATOR_OFFSET, 0);
        assert_eq!(DISCRIMINATOR_SIZE, 8);
        assert_eq!(VERSION_OFFSET, 8);
        assert_eq!(FLAGS_OFFSET, 9);
        assert_eq!(HEADER_LEN_OFFSET, 10);
        assert_eq!(MARKET_INDEX_OFFSET, 12);
        assert_eq!(MAKER_SUBACCOUNT_OFFSET, 14);
        assert_eq!(SEQUENCE_NUMBER_OFFSET, 46);
        assert_eq!(VALID_UNTIL_SLOT_OFFSET, 54);
        assert_eq!(REFERENCE_PRICE_OFFSET, 62);
        assert_eq!(QUOTE_DATA_OFFSET_FIELD, 70);
        assert_eq!(QUOTE_DATA_LEN_FIELD, 74);
        assert_eq!(ASK_LEN_OFFSET, 78);
        assert_eq!(BID_LEN_OFFSET, 80);
        assert_eq!(ASK_HEAD_OFFSET, 82);
        assert_eq!(BID_HEAD_OFFSET, 84);
        assert_eq!(LEVEL_ENTRY_SIZE_OFFSET, 86);
        assert_eq!(RESERVED_OFFSET, 88);
        assert_eq!(STANDARDIZED_HEADER_SIZE, 96);
        assert_eq!(ACCOUNT_MIN_LEN, 96);
    }

    #[test]
    fn test_sequence_number_starts_at_zero() {
        let mut buf = make_buffer(0);
        init_header(&mut buf);
        let view = MidpriceBookView::new(&buf).unwrap();
        assert_eq!(view.sequence_number(), 0);
    }

    #[test]
    fn test_sequence_number_increment() {
        let mut buf = make_buffer(0);
        init_header(&mut buf);

        {
            let mut view = MidpriceBookViewMut::new(&mut buf).unwrap();
            assert_eq!(view.sequence_number(), 0);
            let v1 = view.increment_sequence_number();
            assert_eq!(v1, 1);
            let v2 = view.increment_sequence_number();
            assert_eq!(v2, 2);
            let v3 = view.increment_sequence_number();
            assert_eq!(v3, 3);
        }
        {
            let view = MidpriceBookView::new(&buf).unwrap();
            assert_eq!(view.sequence_number(), 3);
        }
    }

    #[test]
    fn test_sequence_number_wraps() {
        let mut buf = make_buffer(0);
        init_header(&mut buf);
        write_u64(&mut buf, SEQUENCE_NUMBER_OFFSET, u64::MAX);

        let mut view = MidpriceBookViewMut::new(&mut buf).unwrap();
        let v = view.increment_sequence_number();
        assert_eq!(v, 0);
    }

    #[test]
    fn test_orders_with_new_layout() {
        let mut buf = make_buffer(2);
        init_header(&mut buf);

        {
            let mut view = MidpriceBookViewMut::new(&mut buf).unwrap();
            view.set_lengths_and_reset_heads(1, 1).unwrap();
        }
        let tick_count: u16 = 100;
        let size_val: u64 = 5_000_000_000;
        buf[TEST_QUOTE_DATA_START..TEST_QUOTE_DATA_START + 2]
            .copy_from_slice(&tick_count.to_le_bytes());
        buf[TEST_QUOTE_DATA_START + 2..TEST_QUOTE_DATA_START + 10]
            .copy_from_slice(&size_val.to_le_bytes());

        let view = MidpriceBookView::new(&buf).unwrap();
        assert_eq!(view.ask_len(), 1);
        assert_eq!(view.bid_len(), 1);
        assert_eq!(view.total_orders(), 2);
        assert_eq!(view.order_tick_count_u16(0).unwrap(), tick_count);
        assert_eq!(view.order_size_u64(0).unwrap(), size_val);
        assert_eq!(view.level_entry_size(), LEVEL_ENTRY_SIZE);
    }

    #[test]
    fn test_larger_stride() {
        let entry_size: usize = 24;
        let num_orders: usize = 2;
        let mut buf = vec![0u8; TEST_QUOTE_DATA_START + num_orders * entry_size];
        init_header(&mut buf);
        write_u16(&mut buf, LEVEL_ENTRY_SIZE_OFFSET, entry_size as u16);
        write_u32(
            &mut buf,
            QUOTE_DATA_LEN_FIELD,
            (num_orders * entry_size) as u32,
        );

        write_u16(&mut buf, ASK_LEN_OFFSET, 1);
        write_u16(&mut buf, BID_LEN_OFFSET, 1);

        let tick_count1: u16 = 100;
        let size_val: u64 = 200;
        buf[TEST_QUOTE_DATA_START..TEST_QUOTE_DATA_START + 2]
            .copy_from_slice(&tick_count1.to_le_bytes());
        buf[TEST_QUOTE_DATA_START + 2..TEST_QUOTE_DATA_START + 10]
            .copy_from_slice(&size_val.to_le_bytes());

        let tick_count2: u16 = 300;
        let size_val2: u64 = 400;
        buf[TEST_QUOTE_DATA_START + entry_size..TEST_QUOTE_DATA_START + entry_size + 2]
            .copy_from_slice(&tick_count2.to_le_bytes());
        buf[TEST_QUOTE_DATA_START + entry_size + 2..TEST_QUOTE_DATA_START + entry_size + 10]
            .copy_from_slice(&size_val2.to_le_bytes());

        let view = MidpriceBookView::new(&buf).unwrap();
        assert_eq!(view.level_entry_size(), entry_size);
        assert_eq!(view.order_tick_count_u16(0).unwrap(), tick_count1);
        assert_eq!(view.order_size_u64(0).unwrap(), size_val);
        assert_eq!(view.order_tick_count_u16(1).unwrap(), tick_count2);
        assert_eq!(view.order_size_u64(1).unwrap(), size_val2);
    }

    #[test]
    fn test_entry_size_below_min_rejected() {
        let mut buf = make_buffer(0);
        init_header(&mut buf);
        write_u16(&mut buf, LEVEL_ENTRY_SIZE_OFFSET, 8);

        assert!(MidpriceBookView::new(&buf).is_err());
    }

    #[test]
    fn test_unknown_version_rejected() {
        let mut buf = make_buffer(0);
        init_header(&mut buf);
        buf[VERSION_OFFSET] = 2; // only 1 is valid

        assert!(MidpriceBookView::new(&buf).is_err());
    }

    #[test]
    fn test_nonzero_flags_rejected() {
        let mut buf = make_buffer(0);
        init_header(&mut buf);
        buf[FLAGS_OFFSET] = 1;

        assert!(MidpriceBookView::new(&buf).is_err());
    }

    #[test]
    fn test_reference_price_and_valid_until_slot() {
        let mut buf = make_buffer(0);
        init_header(&mut buf);
        write_u64(&mut buf, REFERENCE_PRICE_OFFSET, 42_000_000);
        write_u64(&mut buf, VALID_UNTIL_SLOT_OFFSET, 999);

        let view = MidpriceBookView::new(&buf).unwrap();
        assert_eq!(view.reference_price(), 42_000_000);
        assert_eq!(view.valid_until_slot(), 999);
    }

    #[test]
    fn test_maker_subaccount() {
        let mut buf = make_buffer(0);
        init_header(&mut buf);
        let key = [7u8; 32];
        buf[MAKER_SUBACCOUNT_OFFSET..MAKER_SUBACCOUNT_OFFSET + 32].copy_from_slice(&key);

        let view = MidpriceBookView::new(&buf).unwrap();
        assert_eq!(view.maker_subaccount().unwrap(), key);
    }

    // -----------------------------------------------------------------------
    // CU comparison: current 16-byte entries vs compressed alternatives
    // -----------------------------------------------------------------------

    /// Scan the current (u16 tick_count + u64 size) 10-byte layout.
    fn scan_current(
        buf: &[u8],
        reference_price: u64,
        tick_size: u64,
        n_asks: usize,
        n_bids: usize,
    ) -> (u64, u64) {
        let mut price_sum: u64 = 0;
        let mut size_sum: u64 = 0;
        let n = n_asks + n_bids;
        for i in 0..n {
            let base = TEST_QUOTE_DATA_START + i * LEVEL_ENTRY_SIZE;
            let tick_count = u16::from_le_bytes(buf[base..base + 2].try_into().unwrap()) as u64;
            let size = u64::from_le_bytes(buf[base + 2..base + 10].try_into().unwrap());
            let delta = tick_count.wrapping_mul(tick_size);
            let price = if i < n_asks {
                reference_price.wrapping_add(delta)
            } else {
                reference_price.wrapping_sub(delta)
            };
            price_sum = price_sum.wrapping_add(price);
            size_sum = size_sum.wrapping_add(size);
        }
        (price_sum, size_sum)
    }

    #[test]
    fn cu_comparison_correctness() {
        let reference_price: u64 = 50_000_000_000;
        let tick_size: u64 = 100_000;
        let n_asks = 2;
        let n_bids = 2;
        let n = n_asks + n_bids;

        // Tick counts (unsigned) and sizes
        let tick_counts: [u16; 4] = [10, 20, 10, 20];
        let sizes: [u64; 4] = [5_000_000_000, 3_000_000_000, 4_000_000_000, 2_000_000_000];

        let mut buf = vec![0u8; TEST_QUOTE_DATA_START + n * LEVEL_ENTRY_SIZE];
        for i in 0..n {
            let base = TEST_QUOTE_DATA_START + i * LEVEL_ENTRY_SIZE;
            buf[base..base + 2].copy_from_slice(&tick_counts[i].to_le_bytes());
            buf[base + 2..base + 10].copy_from_slice(&sizes[i].to_le_bytes());
        }
        let (ps, ss) = scan_current(&buf, reference_price, tick_size, n_asks, n_bids);

        // Manually verify first ask: ref + 10*100_000 = 50_001_000_000
        // and first bid: ref - 10*100_000 = 49_999_000_000
        let expected_price_sum = (reference_price + 10 * tick_size)
            + (reference_price + 20 * tick_size)
            + (reference_price - 10 * tick_size)
            + (reference_price - 20 * tick_size);
        assert_eq!(ps, expected_price_sum, "price sum mismatch");
        let expected_size_sum: u64 = sizes.iter().sum();
        assert_eq!(ss, expected_size_sum, "size sum mismatch");
    }
}
