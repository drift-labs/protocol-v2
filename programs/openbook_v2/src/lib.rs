#![allow(clippy::too_many_arguments)]

use anchor_lang::prelude::{
    borsh::{BorshDeserialize, BorshSerialize},
    *,
};

declare_id!("opnb2LAfJYbRMAHHvqjCwQxanZn7ReEHp1k81EohpZb");

pub mod account;
// pub mod order;
pub mod constants;
pub mod context;

pub use crate::account::*;
pub use crate::constants::*;
pub use crate::context::*;

#[program]
mod openbook_v2 {
    #![allow(dead_code)]
    #![allow(unused_variables)]

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

    pub(crate) fn create_market(
        ctx: Context<CreateMarket>,
        name: String,
        oracle_config: OracleConfigParams,
        quote_lot_size: i64,
        base_lot_size: i64,
        maker_fee: i64,
        taker_fee: i64,
        time_expiry: i64,
    ) -> Result<()> {
        Ok(())
    }

    pub(crate) fn create_open_orders_indexer(ctx: Context<CreateOpenOrdersIndexer>) -> Result<()> {
        Ok(())
    }

    pub(crate) fn create_open_orders_account(
        ctx: Context<CreateOpenOrdersAccount>,
        name: String,
    ) -> Result<()> {
        Ok(())
    }

    pub(crate) fn place_order(
        ctx: Context<PlaceOrder>,
        side: Side,
        price_lots: i64,
        max_base_lots: i64,
        max_quote_lots_including_fees: i64,
        client_order_id: u64,
        order_type: PlaceOrderType,
        expiry_timestamp: u64,
        self_trade_behavior: SelfTradeBehavior,
        limit: u8,
    ) -> Result<()> {
        Ok(())
    }
}
