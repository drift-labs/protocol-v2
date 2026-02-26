#![no_std]

/// u64 at start of account: layout/version discriminator for upgrade pathways.
pub const LAYOUT_VERSION_OFFSET: usize = 0;
const LAYOUT_VERSION_SIZE: usize = 8;
/// Initial layout version written on account creation.
pub const LAYOUT_VERSION_INITIAL: u64 = 1;

pub const AUTHORITY_OFFSET: usize = LAYOUT_VERSION_OFFSET + LAYOUT_VERSION_SIZE; // 8
pub const AUTHORIZED_EXCHANGE_PROGRAM_ID_OFFSET: usize = AUTHORITY_OFFSET + 32; // 40
pub const MID_PRICE_OFFSET: usize = AUTHORIZED_EXCHANGE_PROGRAM_ID_OFFSET + 32; // 72
pub const REF_SLOT_OFFSET: usize = MID_PRICE_OFFSET + 16; // 88
pub const MARKET_INDEX_OFFSET: usize = REF_SLOT_OFFSET + 8; // 96
pub const ASK_LEN_OFFSET: usize = MARKET_INDEX_OFFSET + 2; // 98
pub const BID_LEN_OFFSET: usize = ASK_LEN_OFFSET + 2; // 100
pub const ASK_HEAD_OFFSET: usize = BID_LEN_OFFSET + 2; // 102
pub const BID_HEAD_OFFSET: usize = ASK_HEAD_OFFSET + 2; // 104
pub const ORDERS_DATA_OFFSET: usize = BID_HEAD_OFFSET + 2; // 106
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
