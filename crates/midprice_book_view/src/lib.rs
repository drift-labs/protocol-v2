#![no_std]

//! Layout constants and read/write views for midprice accounts.
//!
//! ## Account layout
//!
//! | Offset | Size | Field |
//! |--------|------|-------|
//! | 0 | 4 | Discriminator (`"midp"`) |
//! | 4 | 8 | Layout version (u64 LE) |
//! | 12 | 32 | Authority pubkey |
//! | 44 | 16 | Mid price (u64 LE price + 8 bytes reserved) |
//! | 60 | 8 | Ref slot (u64 LE, slot of last quote-setting write) |
//! | 68 | 2 | Market index (u16 LE) |
//! | 70 | 2 | Subaccount index (u16 LE) |
//! | 72 | 8 | Order tick size (u64 LE, 0 = any price accepted) |
//! | 80 | 8 | Min order size (u64 LE) |
//! | 88 | 2 | Ask length (u16 LE) |
//! | 90 | 2 | Bid length (u16 LE) |
//! | 92 | 2 | Ask head (u16 LE, index of first non-empty ask) |
//! | 94 | 2 | Bid head (u16 LE, index of first non-empty bid relative to ask_len) |
//! | 96 | 8 | Quote TTL in slots (u64 LE, 0 = no expiry) |
//! | 104 | 8 | Sequence number (u64 LE, monotonically increasing, wraps) |
//! | 112 | 2 | Order entry size (u16 LE, stride per order, default 16) |
//! | 114 | 6 | Reserved (zero) |
//! | 120+ | N × entry_size | Order entries: asks \[0, ask_len), then bids \[ask_len, ask_len+bid_len) |
//!
//! Each order entry is at least 16 bytes: `offset: i64 LE` + `size: u64 LE`.
//! The `order_entry_size` field gives the stride; future versions may append
//! fields after the first 16 bytes of each entry.
//! Effective price = `mid_price + offset` (positive offset = ask, negative = bid).
//! `ACCOUNT_MIN_LEN` = 120 (header only, no orders).
//! Maximum orders per book: 128 (asks + bids combined).

/// 4-byte account discriminator at the very start (identifies midprice accounts).
pub const ACCOUNT_DISCRIMINATOR_OFFSET: usize = 0;
pub const ACCOUNT_DISCRIMINATOR_SIZE: usize = 4;
/// Magic "midp" (midprice) to identify account type without relying on SpotMarket scan.
pub const MIDPRICE_ACCOUNT_DISCRIMINATOR: [u8; 4] = [b'm', b'i', b'd', b'p'];

/// u64 layout/version discriminator for upgrade pathways (after account discriminator).
pub const LAYOUT_VERSION_OFFSET: usize = ACCOUNT_DISCRIMINATOR_OFFSET + ACCOUNT_DISCRIMINATOR_SIZE; // 4
const LAYOUT_VERSION_SIZE: usize = 8;
/// Layout version written on account creation
pub const LAYOUT_VERSION_INITIAL: u64 = 0;

pub const AUTHORITY_OFFSET: usize = LAYOUT_VERSION_OFFSET + LAYOUT_VERSION_SIZE; // 12
pub const MID_PRICE_OFFSET: usize = AUTHORITY_OFFSET + 32; // 44
pub const REF_SLOT_OFFSET: usize = MID_PRICE_OFFSET + 16; // 60
pub const MARKET_INDEX_OFFSET: usize = REF_SLOT_OFFSET + 8; // 68
/// Drift User subaccount index this midprice account is tied to (u16 LE).
pub const SUBACCOUNT_INDEX_OFFSET: usize = MARKET_INDEX_OFFSET + 2; // 70
/// Order tick size (u64 LE) and min order size (u64 LE) stored at init; updated via update_tick_sizes (CPI from exchange).
pub const ORDER_TICK_SIZE_OFFSET: usize = SUBACCOUNT_INDEX_OFFSET + 2; // 72
pub const MIN_ORDER_SIZE_OFFSET: usize = ORDER_TICK_SIZE_OFFSET + 8; // 80
pub const ASK_LEN_OFFSET: usize = MIN_ORDER_SIZE_OFFSET + 8; // 88
pub const BID_LEN_OFFSET: usize = ASK_LEN_OFFSET + 2; // 90
pub const ASK_HEAD_OFFSET: usize = BID_LEN_OFFSET + 2; // 92
pub const BID_HEAD_OFFSET: usize = ASK_HEAD_OFFSET + 2; // 94
pub const QUOTE_TTL_OFFSET: usize = BID_HEAD_OFFSET + 2; // 96
pub const SEQUENCE_NUMBER_OFFSET: usize = QUOTE_TTL_OFFSET + 8; // 104
/// Order entry size field (u16 LE) at offset 112.
pub const ORDER_ENTRY_SIZE_OFFSET: usize = SEQUENCE_NUMBER_OFFSET + 8; // 112
/// Reserved bytes at offset 114..120.
pub const RESERVED_OFFSET: usize = ORDER_ENTRY_SIZE_OFFSET + 2; // 114
const RESERVED_SIZE: usize = 6;
/// Start of order data.
pub const ORDERS_DATA_OFFSET: usize = RESERVED_OFFSET + RESERVED_SIZE; // 120
/// Default (and minimum) order entry size in bytes: offset i64 + size u64.
pub const ORDER_ENTRY_SIZE: usize = 16;
pub const MAX_ORDERS: usize = 128;
pub const ACCOUNT_MIN_LEN: usize = ORDERS_DATA_OFFSET; // 120

// -----------------------------------------------------------------------------
// apply_fills instruction (CPI from exchange: remove filled orders, update books)
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
    /// Taker is buyer; scan asks (offset > 0), cross when maker_price <= taker_limit.
    TakingAsks,
    /// Taker is seller; scan bids (offset < 0), cross when maker_price >= taker_limit.
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

fn maker_price_from_offset(mid_price: u64, offset: i64) -> Option<u64> {
    if offset == 0 {
        return None;
    }
    if offset > 0 {
        mid_price.checked_add(offset as u64)
    } else {
        mid_price.checked_sub(offset.unsigned_abs() as u64)
    }
}

fn is_crossing(side: TakingSide, taker_limit_price: u64, maker_price: u64, offset: i64) -> bool {
    match side {
        TakingSide::TakingAsks => offset > 0 && maker_price <= taker_limit_price,
        TakingSide::TakingBids => offset < 0 && maker_price >= taker_limit_price,
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

/// Validate layout version and return the runtime entry size.
fn detect_layout(data: &[u8]) -> Result<(usize, usize), BookError> {
    if data.len() < ACCOUNT_MIN_LEN {
        return Err(BookError::InvalidData);
    }
    let version = read_u64(data, LAYOUT_VERSION_OFFSET);
    if version != LAYOUT_VERSION_INITIAL {
        return Err(BookError::InvalidData);
    }
    let entry_size = read_u16(data, ORDER_ENTRY_SIZE_OFFSET) as usize;
    if entry_size < ORDER_ENTRY_SIZE {
        return Err(BookError::InvalidData);
    }
    Ok((ORDERS_DATA_OFFSET, entry_size))
}

impl<'a> MidpriceBookView<'a> {
    pub fn new(data: &'a [u8]) -> Result<Self, BookError> {
        if data.len() < ACCOUNT_MIN_LEN {
            return Err(BookError::InvalidData);
        }
        if data[ACCOUNT_DISCRIMINATOR_OFFSET
            ..ACCOUNT_DISCRIMINATOR_OFFSET + ACCOUNT_DISCRIMINATOR_SIZE]
            != MIDPRICE_ACCOUNT_DISCRIMINATOR
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

    /// Authority pubkey (32 bytes) this midprice account is keyed by.
    pub fn authority(&self) -> Result<[u8; 32], BookError> {
        self.data[AUTHORITY_OFFSET..AUTHORITY_OFFSET + 32]
            .try_into()
            .map_err(|_| BookError::InvalidData)
    }

    /// Mid price value (low 8 bytes of the 16-byte price field).
    pub fn mid_price_u64(&self) -> u64 {
        read_u64(self.data, MID_PRICE_OFFSET)
    }

    /// Reference slot for quote TTL.
    pub fn ref_slot(&self) -> u64 {
        read_u64(self.data, REF_SLOT_OFFSET)
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

    pub fn quote_ttl_slots(&self) -> u64 {
        read_u64(self.data, QUOTE_TTL_OFFSET)
    }

    pub fn sequence_number(&self) -> u64 {
        read_u64(self.data, SEQUENCE_NUMBER_OFFSET)
    }

    pub fn subaccount_index(&self) -> u16 {
        read_u16(self.data, SUBACCOUNT_INDEX_OFFSET)
    }

    /// Market index this midprice account is tied to (u16 LE).
    pub fn market_index(&self) -> u16 {
        read_u16(self.data, MARKET_INDEX_OFFSET)
    }

    /// Order tick size (0 = any price allowed).
    pub fn order_tick_size(&self) -> u64 {
        read_u64(self.data, ORDER_TICK_SIZE_OFFSET)
    }

    /// Minimum order size.
    pub fn min_order_size(&self) -> u64 {
        read_u64(self.data, MIN_ORDER_SIZE_OFFSET)
    }

    /// Order entry stride in bytes (16 default, may be larger if extended).
    pub fn order_entry_size(&self) -> usize {
        self.entry_size
    }

    pub fn order_offset_i64(&self, index: usize) -> Result<i64, BookError> {
        let base = entry_base(
            self.data,
            index,
            self.total_orders(),
            self.orders_data_offset,
            self.entry_size,
        )?;
        Ok(i64::from_le_bytes(
            self.data[base..base + 8]
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
            self.data[base + 8..base + 16]
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
        mid_price: u64,
        taker_limit_price: u64,
        start_from_abs_index: Option<usize>,
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
            let offset = self.order_offset_i64(abs_index)?;
            let Some(price) = maker_price_from_offset(mid_price, offset) else {
                continue;
            };
            if !is_crossing(side, taker_limit_price, price, offset) {
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

    pub fn quote_ttl_slots(&self) -> u64 {
        read_u64(self.data, QUOTE_TTL_OFFSET)
    }

    pub fn sequence_number(&self) -> u64 {
        read_u64(self.data, SEQUENCE_NUMBER_OFFSET)
    }

    pub fn set_quote_ttl_slots(&mut self, value: u64) {
        write_u64(self.data, QUOTE_TTL_OFFSET, value);
    }

    pub fn set_order_tick_size(&mut self, value: u64) {
        write_u64(self.data, ORDER_TICK_SIZE_OFFSET, value);
    }

    pub fn set_min_order_size(&mut self, value: u64) {
        write_u64(self.data, MIN_ORDER_SIZE_OFFSET, value);
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
        self.data[base + 8..base + 16].copy_from_slice(&size.to_le_bytes());
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
            self.data[base + 8..base + 16]
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

#[cfg(test)]
mod tests {
    extern crate std;
    use super::*;
    use std::vec;

    fn make_buffer(num_orders: usize) -> std::vec::Vec<u8> {
        vec![0u8; ORDERS_DATA_OFFSET + num_orders * ORDER_ENTRY_SIZE]
    }

    fn init_header(buf: &mut [u8]) {
        buf[ACCOUNT_DISCRIMINATOR_OFFSET
            ..ACCOUNT_DISCRIMINATOR_OFFSET + ACCOUNT_DISCRIMINATOR_SIZE]
            .copy_from_slice(&MIDPRICE_ACCOUNT_DISCRIMINATOR);
        buf[LAYOUT_VERSION_OFFSET..LAYOUT_VERSION_OFFSET + 8]
            .copy_from_slice(&LAYOUT_VERSION_INITIAL.to_le_bytes());
        buf[ORDER_ENTRY_SIZE_OFFSET..ORDER_ENTRY_SIZE_OFFSET + 2]
            .copy_from_slice(&(ORDER_ENTRY_SIZE as u16).to_le_bytes());
    }

    #[test]
    fn test_layout_offsets() {
        assert_eq!(ACCOUNT_DISCRIMINATOR_OFFSET, 0);
        assert_eq!(ACCOUNT_DISCRIMINATOR_SIZE, 4);
        assert_eq!(LAYOUT_VERSION_OFFSET, 4);
        assert_eq!(AUTHORITY_OFFSET, 12);
        assert_eq!(MID_PRICE_OFFSET, 44);
        assert_eq!(REF_SLOT_OFFSET, 60);
        assert_eq!(MARKET_INDEX_OFFSET, 68);
        assert_eq!(SUBACCOUNT_INDEX_OFFSET, 70);
        assert_eq!(ORDER_TICK_SIZE_OFFSET, 72);
        assert_eq!(MIN_ORDER_SIZE_OFFSET, 80);
        assert_eq!(ASK_LEN_OFFSET, 88);
        assert_eq!(BID_LEN_OFFSET, 90);
        assert_eq!(ASK_HEAD_OFFSET, 92);
        assert_eq!(BID_HEAD_OFFSET, 94);
        assert_eq!(QUOTE_TTL_OFFSET, 96);
        assert_eq!(SEQUENCE_NUMBER_OFFSET, 104);
        assert_eq!(ORDER_ENTRY_SIZE_OFFSET, 112);
        assert_eq!(RESERVED_OFFSET, 114);
        assert_eq!(ORDERS_DATA_OFFSET, 120);
        assert_eq!(ACCOUNT_MIN_LEN, 120);
    }

    #[test]
    fn test_quote_ttl_read_write() {
        let mut buf = make_buffer(0);
        init_header(&mut buf);

        {
            let view = MidpriceBookView::new(&buf).unwrap();
            assert_eq!(view.quote_ttl_slots(), 0);
        }
        {
            let mut view = MidpriceBookViewMut::new(&mut buf).unwrap();
            view.set_quote_ttl_slots(150);
        }
        {
            let view = MidpriceBookView::new(&buf).unwrap();
            assert_eq!(view.quote_ttl_slots(), 150);
        }
        {
            let mut view = MidpriceBookViewMut::new(&mut buf).unwrap();
            assert_eq!(view.quote_ttl_slots(), 150);
            view.set_quote_ttl_slots(u64::MAX);
        }
        {
            let view = MidpriceBookView::new(&buf).unwrap();
            assert_eq!(view.quote_ttl_slots(), u64::MAX);
        }
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
        let offset_val: i64 = 1_000_000;
        let size_val: u64 = 5_000_000_000;
        buf[ORDERS_DATA_OFFSET..ORDERS_DATA_OFFSET + 8].copy_from_slice(&offset_val.to_le_bytes());
        buf[ORDERS_DATA_OFFSET + 8..ORDERS_DATA_OFFSET + 16]
            .copy_from_slice(&size_val.to_le_bytes());

        let view = MidpriceBookView::new(&buf).unwrap();
        assert_eq!(view.ask_len(), 1);
        assert_eq!(view.bid_len(), 1);
        assert_eq!(view.total_orders(), 2);
        assert_eq!(view.order_offset_i64(0).unwrap(), offset_val);
        assert_eq!(view.order_size_u64(0).unwrap(), size_val);
        assert_eq!(view.order_entry_size(), ORDER_ENTRY_SIZE);
    }

    #[test]
    fn test_larger_stride() {
        // entry_size = 24 (16 standard + 8 extra bytes per entry)
        let entry_size: usize = 24;
        let num_orders: usize = 2;
        let mut buf = vec![0u8; ORDERS_DATA_OFFSET + num_orders * entry_size];
        init_header(&mut buf);
        // Override entry size to 24
        buf[ORDER_ENTRY_SIZE_OFFSET..ORDER_ENTRY_SIZE_OFFSET + 2]
            .copy_from_slice(&(entry_size as u16).to_le_bytes());

        write_u16(&mut buf, ASK_LEN_OFFSET, 1);
        write_u16(&mut buf, BID_LEN_OFFSET, 1);

        // Write first entry at ORDERS_DATA_OFFSET
        let offset_val: i64 = 100;
        let size_val: u64 = 200;
        buf[ORDERS_DATA_OFFSET..ORDERS_DATA_OFFSET + 8].copy_from_slice(&offset_val.to_le_bytes());
        buf[ORDERS_DATA_OFFSET + 8..ORDERS_DATA_OFFSET + 16]
            .copy_from_slice(&size_val.to_le_bytes());

        // Write second entry at stride offset (24 bytes later)
        let offset_val2: i64 = -300;
        let size_val2: u64 = 400;
        buf[ORDERS_DATA_OFFSET + entry_size..ORDERS_DATA_OFFSET + entry_size + 8]
            .copy_from_slice(&offset_val2.to_le_bytes());
        buf[ORDERS_DATA_OFFSET + entry_size + 8..ORDERS_DATA_OFFSET + entry_size + 16]
            .copy_from_slice(&size_val2.to_le_bytes());

        let view = MidpriceBookView::new(&buf).unwrap();
        assert_eq!(view.order_entry_size(), entry_size);
        assert_eq!(view.order_offset_i64(0).unwrap(), offset_val);
        assert_eq!(view.order_size_u64(0).unwrap(), size_val);
        assert_eq!(view.order_offset_i64(1).unwrap(), offset_val2);
        assert_eq!(view.order_size_u64(1).unwrap(), size_val2);
    }

    #[test]
    fn test_entry_size_below_min_rejected() {
        let mut buf = make_buffer(0);
        init_header(&mut buf);
        // Set entry_size = 8 (below minimum of 16)
        buf[ORDER_ENTRY_SIZE_OFFSET..ORDER_ENTRY_SIZE_OFFSET + 2]
            .copy_from_slice(&8u16.to_le_bytes());

        assert!(MidpriceBookView::new(&buf).is_err());
    }

    #[test]
    fn test_unknown_version_rejected() {
        let mut buf = make_buffer(0);
        init_header(&mut buf);
        // Set version to 1 (only 0 is valid)
        buf[LAYOUT_VERSION_OFFSET..LAYOUT_VERSION_OFFSET + 8].copy_from_slice(&1u64.to_le_bytes());

        assert!(MidpriceBookView::new(&buf).is_err());
    }

    // -----------------------------------------------------------------------
    // CU comparison: current 16-byte entries vs compressed alternatives
    // -----------------------------------------------------------------------
    //
    // We test four representations:
    //
    // A) Current:    i64 offset + u64 size = 16 bytes.  No reconstruction.
    // B) Tick-based: i32 offset_ticks + u32 size_ticks = 8 bytes.
    //                Reconstruct: offset = stored * tick_size, size = stored * min_order_size.
    //                Cost: +2 mul per order.
    // C) BPS offset: i16 offset_bps + u64 size = 10 bytes.
    //                Reconstruct: offset = stored * mid_price / 10_000.
    //                Cost: +1 mul + 1 div per order (div is expensive on BPF: ~5 CU).
    // D) Tick offset only: i32 offset_ticks + u64 size = 12 bytes.
    //                Reconstruct: offset = stored * tick_size.
    //                Cost: +1 mul per order.
    //
    // On Solana BPF, load32 and load64 cost the same (1 CU each).
    // The only difference is reconstruction arithmetic.

    fn scan_current(buf: &[u8], mid_price: u64, n: usize) -> (u64, u64) {
        let mut price_sum: u64 = 0;
        let mut size_sum: u64 = 0;
        for i in 0..n {
            let base = ORDERS_DATA_OFFSET + i * 16;
            let offset = i64::from_le_bytes(buf[base..base + 8].try_into().unwrap());
            let size = u64::from_le_bytes(buf[base + 8..base + 16].try_into().unwrap());
            let price = if offset > 0 {
                mid_price.wrapping_add(offset as u64)
            } else {
                mid_price.wrapping_sub(offset.unsigned_abs())
            };
            price_sum = price_sum.wrapping_add(price);
            size_sum = size_sum.wrapping_add(size);
        }
        (price_sum, size_sum)
    }

    // B) i32 offset_ticks + u32 size_ticks = 8 bytes
    fn scan_tick_compressed(
        buf: &[u8],
        mid_price: u64,
        tick_size: u64,
        min_order_size: u64,
        n: usize,
    ) -> (u64, u64) {
        let mut price_sum: u64 = 0;
        let mut size_sum: u64 = 0;
        for i in 0..n {
            let base = ORDERS_DATA_OFFSET + i * 8;
            let offset_ticks = i32::from_le_bytes(buf[base..base + 4].try_into().unwrap()) as i64;
            let size_ticks = u32::from_le_bytes(buf[base + 4..base + 8].try_into().unwrap()) as u64;
            let offset = offset_ticks.wrapping_mul(tick_size as i64); // +1 mul
            let size = size_ticks.wrapping_mul(min_order_size); // +1 mul
            let price = if offset > 0 {
                mid_price.wrapping_add(offset as u64)
            } else {
                mid_price.wrapping_sub(offset.unsigned_abs())
            };
            price_sum = price_sum.wrapping_add(price);
            size_sum = size_sum.wrapping_add(size);
        }
        (price_sum, size_sum)
    }

    // C) i16 offset_bps + u64 size = 10 bytes
    fn scan_bps_offset(buf: &[u8], mid_price: u64, n: usize) -> (u64, u64) {
        let mut price_sum: u64 = 0;
        let mut size_sum: u64 = 0;
        for i in 0..n {
            let base = ORDERS_DATA_OFFSET + i * 10;
            let offset_bps = i16::from_le_bytes(buf[base..base + 2].try_into().unwrap()) as i64;
            let size = u64::from_le_bytes(buf[base + 2..base + 10].try_into().unwrap());
            // Reconstruct: offset = offset_bps * mid_price / 10_000
            let offset = offset_bps
                .wrapping_mul(mid_price as i64) // +1 mul
                / 10_000; // +1 div (~5 CU on BPF)
            let price = if offset > 0 {
                mid_price.wrapping_add(offset as u64)
            } else {
                mid_price.wrapping_sub(offset.unsigned_abs())
            };
            price_sum = price_sum.wrapping_add(price);
            size_sum = size_sum.wrapping_add(size);
        }
        (price_sum, size_sum)
    }

    // D) i32 offset_ticks + u64 size = 12 bytes
    fn scan_tick_offset_only(buf: &[u8], mid_price: u64, tick_size: u64, n: usize) -> (u64, u64) {
        let mut price_sum: u64 = 0;
        let mut size_sum: u64 = 0;
        for i in 0..n {
            let base = ORDERS_DATA_OFFSET + i * 12;
            let offset_ticks = i32::from_le_bytes(buf[base..base + 4].try_into().unwrap()) as i64;
            let size = u64::from_le_bytes(buf[base + 4..base + 12].try_into().unwrap());
            let offset = offset_ticks.wrapping_mul(tick_size as i64); // +1 mul
            let price = if offset > 0 {
                mid_price.wrapping_add(offset as u64)
            } else {
                mid_price.wrapping_sub(offset.unsigned_abs())
            };
            price_sum = price_sum.wrapping_add(price);
            size_sum = size_sum.wrapping_add(size);
        }
        (price_sum, size_sum)
    }

    /// Correctness: all four schemes produce the same prices and sizes.
    #[test]
    fn test_cu_all_schemes_equivalent() {
        let mid_price: u64 = 100_000_000; // $100 in 1e-6
        let tick_size: u64 = 1_000; // $0.001
        let min_order_size: u64 = 1_000;
        let n: usize = 64;

        // A) current: i64 offset + u64 size = 16B
        let mut buf_a = vec![0u8; ORDERS_DATA_OFFSET + n * 16];
        init_header(&mut buf_a);
        write_u16(&mut buf_a, ASK_LEN_OFFSET, n as u16);
        for i in 0..n {
            let offset: i64 = (i as i64 + 1) * tick_size as i64;
            let size: u64 = (i as u64 + 1) * min_order_size;
            let base = ORDERS_DATA_OFFSET + i * 16;
            buf_a[base..base + 8].copy_from_slice(&offset.to_le_bytes());
            buf_a[base + 8..base + 16].copy_from_slice(&size.to_le_bytes());
        }

        // B) tick compressed: i32 + u32 = 8B
        let mut buf_b = vec![0u8; ORDERS_DATA_OFFSET + n * 8];
        init_header(&mut buf_b);
        write_u16(&mut buf_b, ASK_LEN_OFFSET, n as u16);
        for i in 0..n {
            let base = ORDERS_DATA_OFFSET + i * 8;
            buf_b[base..base + 4].copy_from_slice(&((i as i32 + 1).to_le_bytes()));
            buf_b[base + 4..base + 8].copy_from_slice(&((i as u32 + 1).to_le_bytes()));
        }

        // C) bps offset: i16 + u64 = 10B
        let mut buf_c = vec![0u8; ORDERS_DATA_OFFSET + n * 10];
        init_header(&mut buf_c);
        write_u16(&mut buf_c, ASK_LEN_OFFSET, n as u16);
        for i in 0..n {
            // offset_bps = offset * 10_000 / mid_price = (i+1)*1000 * 10000 / 100_000_000 = (i+1)/10
            // This loses precision for small ticks — that's the point of the test.
            let offset_bps: i16 =
                ((i as i64 + 1) * tick_size as i64 * 10_000 / mid_price as i64) as i16;
            let size: u64 = (i as u64 + 1) * min_order_size;
            let base = ORDERS_DATA_OFFSET + i * 10;
            buf_c[base..base + 2].copy_from_slice(&offset_bps.to_le_bytes());
            buf_c[base + 2..base + 10].copy_from_slice(&size.to_le_bytes());
        }

        // D) tick offset only: i32 + u64 = 12B
        let mut buf_d = vec![0u8; ORDERS_DATA_OFFSET + n * 12];
        init_header(&mut buf_d);
        write_u16(&mut buf_d, ASK_LEN_OFFSET, n as u16);
        for i in 0..n {
            let base = ORDERS_DATA_OFFSET + i * 12;
            buf_d[base..base + 4].copy_from_slice(&((i as i32 + 1).to_le_bytes()));
            let size: u64 = (i as u64 + 1) * min_order_size;
            buf_d[base + 4..base + 12].copy_from_slice(&size.to_le_bytes());
        }

        let (pa, sa) = scan_current(&buf_a, mid_price, n);
        let (pb, sb) = scan_tick_compressed(&buf_b, mid_price, tick_size, min_order_size, n);
        let (pd, sd) = scan_tick_offset_only(&buf_d, mid_price, tick_size, n);

        // A, B, D must be identical (lossless tick encoding)
        assert_eq!(pa, pb, "tick-compressed prices must match current");
        assert_eq!(sa, sb, "tick-compressed sizes must match current");
        assert_eq!(pa, pd, "tick-offset prices must match current");
        assert_eq!(sa, sd, "tick-offset sizes must match current");

        // C (bps) is lossy — check it's close but NOT exact for small offsets
        let (pc, sc) = scan_bps_offset(&buf_c, mid_price, n);
        assert_eq!(sc, sa, "bps sizes must match (size not compressed)");
        // bps truncates: offset_bps=0 for offset < 1 bps of mid_price.
        // With tick=1000 and mid=100M, 1 tick = 0.001% = 0.1 bps → rounds to 0.
        // First ~10 orders have offset_bps=0, so prices collapse to mid_price.
        assert_ne!(
            pc, pa,
            "bps prices should differ from current due to rounding loss"
        );
    }

    /// BPS precision loss demonstration: sub-bps ticks are destroyed.
    #[test]
    fn test_bps_precision_loss() {
        // tick_size = 1000 (0.001 USDC), mid_price = 100_000_000 ($100)
        // 1 bps of $100 = $0.01 = 10_000 units. Tick is 1000 units = 0.1 bps.
        // So the first 9 tick levels (offset 1000..9000) all map to offset_bps=0.
        let mid_price: u64 = 100_000_000;
        let tick_size: u64 = 1_000;

        let mut lost_levels = 0u32;
        for i in 1..=100 {
            let offset = i * tick_size as i64;
            let offset_bps = (offset * 10_000) / mid_price as i64;
            if offset_bps == 0 {
                lost_levels += 1;
            }
        }
        assert!(
            lost_levels >= 9,
            "BPS encoding destroys {} of 100 near-mid levels (sub-bps ticks lost)",
            lost_levels
        );
    }

    /// i32 offset-in-ticks range: safe for all realistic markets.
    #[test]
    fn test_tick_offset_i32_range() {
        // i32 max = 2,147,483,647 ticks
        // BTC at tick=$0.10 (tick_size=100_000): max offset = $214,748 from mid. Fine.
        // Meme coin at tick=$0.000001 (tick_size=1): max offset = $2,147 from mid. Fine
        //   because meme coins trade at fractions of a cent.
        let max_ticks = i32::MAX as u64;

        // BTC: tick = $0.10
        let btc_tick = 100_000u64;
        let btc_max_offset_usd = max_ticks * btc_tick / 1_000_000;
        assert!(
            btc_max_offset_usd > 200_000,
            "BTC: i32 ticks covers ±${}",
            btc_max_offset_usd
        );

        // SOL: tick = $0.001
        let sol_tick = 1_000u64;
        let sol_max_offset_usd = max_ticks * sol_tick / 1_000_000;
        assert!(
            sol_max_offset_usd > 2_000,
            "SOL: i32 ticks covers ±${}",
            sol_max_offset_usd
        );
    }

    /// i32 offset in RAW UNITS (no tick division) breaks for BTC.
    /// This is why raw i32 doesn't work but i32-in-ticks does.
    #[test]
    fn test_raw_i32_offset_breaks_btc() {
        let max_i32: u64 = i32::MAX as u64; // 2,147,483,647
        let btc_mid: u64 = 100_000_000_000; // $100k in 1e-6
        let five_pct = btc_mid / 20; // $5,000 = 5_000_000_000
        assert!(
            five_pct > max_i32,
            "5% BTC spread ({}) exceeds raw i32 max ({})",
            five_pct,
            max_i32
        );
    }

    /// u32 size-in-min_order_size: breaks when min_order_size=1.
    #[test]
    fn test_u32_size_in_ticks_breaks_when_min_is_1() {
        let max_u32: u64 = u32::MAX as u64;
        // With min=1, max expressible = 4.29B base units = 4.29 tokens at 9 decimals.
        assert!(
            max_u32 < 10_000_000_000u64,
            "u32 with min=1 caps at {}",
            max_u32
        );
    }

    /// Wall-clock micro-benchmark of all four schemes.
    /// Run with `cargo test -- --nocapture cu_microbench`.
    #[test]
    fn cu_microbench_all_schemes() {
        use std::hint::black_box;
        use std::time::Instant;

        let mid_price: u64 = 100_000_000;
        let tick_size: u64 = 1_000;
        let min_order_size: u64 = 1_000;
        let n: usize = 128;
        let iters: usize = 100_000;

        // Build all buffers
        let mut buf_a = vec![0u8; ORDERS_DATA_OFFSET + n * 16];
        init_header(&mut buf_a);
        write_u16(&mut buf_a, ASK_LEN_OFFSET, n as u16);
        let mut buf_b = vec![0u8; ORDERS_DATA_OFFSET + n * 8];
        init_header(&mut buf_b);
        write_u16(&mut buf_b, ASK_LEN_OFFSET, n as u16);
        let mut buf_c = vec![0u8; ORDERS_DATA_OFFSET + n * 10];
        init_header(&mut buf_c);
        write_u16(&mut buf_c, ASK_LEN_OFFSET, n as u16);
        let mut buf_d = vec![0u8; ORDERS_DATA_OFFSET + n * 12];
        init_header(&mut buf_d);
        write_u16(&mut buf_d, ASK_LEN_OFFSET, n as u16);

        for i in 0..n {
            let off: i64 = (i as i64 + 1) * tick_size as i64;
            let sz: u64 = (i as u64 + 1) * min_order_size;
            let bps: i16 = ((i as i64 + 1) * tick_size as i64 * 10_000 / mid_price as i64) as i16;

            let ba = ORDERS_DATA_OFFSET + i * 16;
            buf_a[ba..ba + 8].copy_from_slice(&off.to_le_bytes());
            buf_a[ba + 8..ba + 16].copy_from_slice(&sz.to_le_bytes());

            let bb = ORDERS_DATA_OFFSET + i * 8;
            buf_b[bb..bb + 4].copy_from_slice(&((i as i32 + 1).to_le_bytes()));
            buf_b[bb + 4..bb + 8].copy_from_slice(&((i as u32 + 1).to_le_bytes()));

            let bc = ORDERS_DATA_OFFSET + i * 10;
            buf_c[bc..bc + 2].copy_from_slice(&bps.to_le_bytes());
            buf_c[bc + 2..bc + 10].copy_from_slice(&sz.to_le_bytes());

            let bd = ORDERS_DATA_OFFSET + i * 12;
            buf_d[bd..bd + 4].copy_from_slice(&((i as i32 + 1).to_le_bytes()));
            buf_d[bd + 4..bd + 12].copy_from_slice(&sz.to_le_bytes());
        }

        // Warm up all paths
        for _ in 0..1000 {
            black_box(scan_current(black_box(&buf_a), black_box(mid_price), n));
            black_box(scan_tick_compressed(
                black_box(&buf_b),
                black_box(mid_price),
                black_box(tick_size),
                black_box(min_order_size),
                n,
            ));
            black_box(scan_bps_offset(black_box(&buf_c), black_box(mid_price), n));
            black_box(scan_tick_offset_only(
                black_box(&buf_d),
                black_box(mid_price),
                black_box(tick_size),
                n,
            ));
        }

        let bench = |_name: &str, f: &dyn Fn()| -> u128 {
            let t = Instant::now();
            for _ in 0..iters {
                f();
            }
            let ns = t.elapsed().as_nanos();
            ns
        };

        let ns_a = bench("A", &|| {
            black_box(scan_current(black_box(&buf_a), black_box(mid_price), n));
        });
        let ns_b = bench("B", &|| {
            black_box(scan_tick_compressed(
                black_box(&buf_b),
                black_box(mid_price),
                black_box(tick_size),
                black_box(min_order_size),
                n,
            ));
        });
        let ns_c = bench("C", &|| {
            black_box(scan_bps_offset(black_box(&buf_c), black_box(mid_price), n));
        });
        let ns_d = bench("D", &|| {
            black_box(scan_tick_offset_only(
                black_box(&buf_d),
                black_box(mid_price),
                black_box(tick_size),
                n,
            ));
        });

        let pct = |v: u128| -> i64 {
            if ns_a == 0 {
                return 0;
            }
            ((v as i128 - ns_a as i128) * 100 / ns_a as i128) as i64
        };

        std::println!(
            "\n--- Order scan benchmark ({} iters × {} orders) ---",
            iters,
            n
        );
        std::println!(
            "  A) Current      i64+u64  16B/entry : {:>12} ns (baseline)",
            ns_a
        );
        std::println!(
            "  B) Tick-both    i32+u32   8B/entry : {:>12} ns ({:+}%  +2 mul/order)",
            ns_b,
            pct(ns_b)
        );
        std::println!(
            "  C) BPS offset   i16+u64  10B/entry : {:>12} ns ({:+}%  +1 mul +1 div/order)",
            ns_c,
            pct(ns_c)
        );
        std::println!(
            "  D) Tick-offset  i32+u64  12B/entry : {:>12} ns ({:+}%  +1 mul/order)",
            ns_d,
            pct(ns_d)
        );
        std::println!();
        std::println!("  BPF note: load32 and load64 cost 1 CU each (no savings on reads).");
        std::println!("  Every compressed scheme pays MORE arithmetic with ZERO load savings.");
        std::println!(
            "  BPS also loses sub-bps precision (first ~10 tick levels collapse to 0).\n"
        );
    }
}
