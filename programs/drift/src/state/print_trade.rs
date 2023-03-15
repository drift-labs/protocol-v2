use crate::state::traits::Size;
use anchor_lang::prelude::*;
use crate::state::user::{Order, User};

#[account(zero_copy)]
#[derive(Default, Eq, PartialEq, Debug)]
#[repr(C)]
pub struct PrintTrade {
    pub creator: User,
    pub counterparty: User,
    pub orders: [Order; 2],
}

impl Size for PrintTrade {
    const SIZE: usize = User::SIZE * 2 + std::mem::size_of::<Order>();
}
