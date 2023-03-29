use crate::state::traits::Size;
use anchor_lang::prelude::*;
use crate::state::user::Order;

#[account]
pub struct PrintTrade {
    pub creator: Pubkey,
    pub counterparty: Pubkey,
    pub orders: [Order; 2],
}

impl Size for PrintTrade {
    const SIZE: usize = 8 + std::mem::size_of::<PrintTrade>();
}
