use crate::state::traits::Size;
use anchor_lang::prelude::*;

#[account(zero_copy)]
#[derive(Default, Eq, PartialEq, Debug)]
#[repr(C)]
pub struct PrintTrade {}

impl Size for PrintTrade {
    const SIZE: usize = 8;
}
