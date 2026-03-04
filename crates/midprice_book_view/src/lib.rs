#![no_std]

/// u64 at start of account: layout/version discriminator for upgrade pathways.
pub const LAYOUT_VERSION_OFFSET: usize = 0;
const LAYOUT_VERSION_SIZE: usize = 8;
/// Initial layout version written on account creation (v1: no authorized_exchange field; exchange is hardcoded Drift).
pub const LAYOUT_VERSION_INITIAL: u64 = 1;

pub const AUTHORITY_OFFSET: usize = LAYOUT_VERSION_OFFSET + LAYOUT_VERSION_SIZE; // 8
pub const MID_PRICE_OFFSET: usize = AUTHORITY_OFFSET + 32; // 40
pub const REF_SLOT_OFFSET: usize = MID_PRICE_OFFSET + 16; // 56
pub const MARKET_INDEX_OFFSET: usize = REF_SLOT_OFFSET + 8; // 64
/// Drift User subaccount index this midprice account is tied to (u16 LE).
pub const SUBACCOUNT_INDEX_OFFSET: usize = MARKET_INDEX_OFFSET + 2; // 66
pub const ASK_LEN_OFFSET: usize = SUBACCOUNT_INDEX_OFFSET + 2; // 68
pub const BID_LEN_OFFSET: usize = ASK_LEN_OFFSET + 2; // 70
pub const ASK_HEAD_OFFSET: usize = BID_LEN_OFFSET + 2; // 72
pub const BID_HEAD_OFFSET: usize = ASK_HEAD_OFFSET + 2; // 74
pub const QUOTE_TTL_OFFSET: usize = BID_HEAD_OFFSET + 2; // 76
pub const SEQUENCE_NUMBER_OFFSET: usize = QUOTE_TTL_OFFSET + 8; // 84
pub const ORDERS_DATA_OFFSET: usize = SEQUENCE_NUMBER_OFFSET + 8; // 92
pub const ORDER_ENTRY_SIZE: usize = 16; // (offset: i64, size: u64)
pub const MAX_ORDERS: usize = 128;
pub const ACCOUNT_MIN_LEN: usize = ORDERS_DATA_OFFSET;

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

    pub fn subaccount_index(&self) -> u16 {
        read_u16(self.data, SUBACCOUNT_INDEX_OFFSET)
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
        buf[LAYOUT_VERSION_OFFSET..LAYOUT_VERSION_OFFSET + 8]
            .copy_from_slice(&LAYOUT_VERSION_INITIAL.to_le_bytes());
    }

    #[test]
    fn test_layout_offsets() {
        assert_eq!(LAYOUT_VERSION_OFFSET, 0);
        assert_eq!(AUTHORITY_OFFSET, 8);
        assert_eq!(MID_PRICE_OFFSET, 40);
        assert_eq!(REF_SLOT_OFFSET, 56);
        assert_eq!(MARKET_INDEX_OFFSET, 64);
        assert_eq!(SUBACCOUNT_INDEX_OFFSET, 66);
        assert_eq!(ASK_LEN_OFFSET, 68);
        assert_eq!(BID_LEN_OFFSET, 70);
        assert_eq!(ASK_HEAD_OFFSET, 72);
        assert_eq!(BID_HEAD_OFFSET, 74);
        assert_eq!(QUOTE_TTL_OFFSET, 76);
        assert_eq!(SEQUENCE_NUMBER_OFFSET, 84);
        assert_eq!(ORDERS_DATA_OFFSET, 92);
        assert_eq!(ACCOUNT_MIN_LEN, 92);
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
