use anchor_lang::prelude::{
    borsh::{BorshDeserialize, BorshSerialize},
    *,
};
use crate::context::PlaceTakeOrder;

declare_id!("opnb2LAfJYbRMAHHvqjCwQxanZn7ReEHp1k81EohpZb");

pub mod account;
// pub mod order;
pub mod context;
pub mod constants;

pub use crate::account::*;
pub use crate::context::*;
pub use crate::constants::*;

#[program]
mod openbook_v2 {
    #![allow(dead_code)]
    #![allow(unused_variables)]
    #![allow(clippy::too_many_arguments)]

    use super::*;

    pub(crate) fn place_take_order(
        ctx: Context<PlaceTakeOrder>,
        side: Side,
        price_lots: i64,
        max_base_lots: i64,
        max_quote_lots_including_fees: i64,
        order_type: PlaceOrderType,
        limit: u8,
    ) -> Result<()> {
        Ok(())
    }
}