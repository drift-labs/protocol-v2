#![no_std]

/// 4-byte account discriminator at the very start (identifies midprice accounts).
pub const ACCOUNT_DISCRIMINATOR_OFFSET: usize = 0;
pub const ACCOUNT_DISCRIMINATOR_SIZE: usize = 4;
/// Magic "midp" (midprice) to identify account type without relying on SpotMarket scan.
pub const MIDPRICE_ACCOUNT_DISCRIMINATOR: [u8; 4] = [b'm', b'i', b'd', b'p'];

/// u64 layout/version discriminator for upgrade pathways (after account discriminator).
pub const LAYOUT_VERSION_OFFSET: usize = ACCOUNT_DISCRIMINATOR_OFFSET + ACCOUNT_DISCRIMINATOR_SIZE; // 4
const LAYOUT_VERSION_SIZE: usize = 8;
/// Initial layout version written on account creation
pub const LAYOUT_VERSION_INITIAL: u64 = 1;

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
pub const ORDERS_DATA_OFFSET: usize = SEQUENCE_NUMBER_OFFSET + 8; // 112
pub const ORDER_ENTRY_SIZE: usize = 16; // (offset: i64, size: u64)
pub const MAX_ORDERS: usize = 128;
pub const ACCOUNT_MIN_LEN: usize = ORDERS_DATA_OFFSET;

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
}

pub struct MidpriceBookViewMut<'a> {
    data: &'a mut [u8],
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
        let v = Self { data };
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

    pub fn order_offset_i64(&self, index: usize) -> Result<i64, BookError> {
        let base = entry_base(self.data, index, self.total_orders())?;
        Ok(i64::from_le_bytes(
            self.data[base..base + 8]
                .try_into()
                .map_err(|_| BookError::InvalidData)?,
        ))
    }

    pub fn order_size_u64(&self, index: usize) -> Result<u64, BookError> {
        let base = entry_base(self.data, index, self.total_orders())?;
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
        let ask_len = self.ask_len() as usize;
        let bid_len = self.bid_len() as usize;
        let ask_head = self.ask_head() as usize;
        let bid_head = self.bid_head() as usize;
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
            .checked_mul(ORDER_ENTRY_SIZE)
            .ok_or(BookError::InvalidOrders)?;
        let end = ORDERS_DATA_OFFSET
            .checked_add(data_bytes)
            .ok_or(BookError::InvalidOrders)?;
        if end > self.data.len() {
            return Err(BookError::InvalidData);
        }
        Ok(())
    }
}

impl<'a> MidpriceBookViewMut<'a> {
    pub fn new(data: &'a mut [u8]) -> Result<Self, BookError> {
        if data.len() < ACCOUNT_MIN_LEN {
            return Err(BookError::InvalidData);
        }
        let v = Self { data };
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
        let base = entry_base(self.data, index, self.total_orders())?;
        self.data[base + 8..base + 16].copy_from_slice(&size.to_le_bytes());
        Ok(())
    }

    pub fn order_size_u64(&self, index: usize) -> Result<u64, BookError> {
        let base = entry_base(self.data, index, self.total_orders())?;
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
        MidpriceBookView { data: self.data }.validate_bounds()
    }
}

fn entry_base(data: &[u8], index: usize, total_orders: usize) -> Result<usize, BookError> {
    if index >= total_orders {
        return Err(BookError::InvalidOrders);
    }
    let data_bytes = total_orders
        .checked_mul(ORDER_ENTRY_SIZE)
        .ok_or(BookError::InvalidOrders)?;
    let end = ORDERS_DATA_OFFSET
        .checked_add(data_bytes)
        .ok_or(BookError::InvalidOrders)?;
    if end > data.len() {
        return Err(BookError::InvalidData);
    }
    ORDERS_DATA_OFFSET
        .checked_add(index * ORDER_ENTRY_SIZE)
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
        assert_eq!(ORDERS_DATA_OFFSET, 112);
        assert_eq!(ACCOUNT_MIN_LEN, 112);
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
    }
}
