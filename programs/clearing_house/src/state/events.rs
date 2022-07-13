use anchor_lang::prelude::*;
use borsh::{BorshDeserialize, BorshSerialize};

use crate::state::user::Order;

#[event]
pub struct DepositRecord {
    pub ts: i64,
    pub user_authority: Pubkey,
    pub user: Pubkey,
    pub direction: DepositDirection,
    pub amount: u64,
    pub bank_index: u64,
    pub from: Option<Pubkey>,
    pub to: Option<Pubkey>,
}

#[derive(Clone, Copy, BorshSerialize, BorshDeserialize, PartialEq)]
pub enum DepositDirection {
    DEPOSIT,
    WITHDRAW,
}

impl Default for DepositDirection {
    // UpOnly
    fn default() -> Self {
        DepositDirection::DEPOSIT
    }
}

#[event]
pub struct FundingPaymentRecord {
    pub ts: i64,
    pub user_authority: Pubkey,
    pub user: Pubkey,
    pub market_index: u64,
    pub funding_payment: i128,
    pub base_asset_amount: i128,
    pub user_last_cumulative_funding: i128,
    pub user_last_funding_rate_ts: i64,
    pub amm_cumulative_funding_long: i128,
    pub amm_cumulative_funding_short: i128,
}

#[event]
pub struct FundingRateRecord {
    pub ts: i64,
    pub record_id: u64,
    pub market_index: u64,
    pub funding_rate: i128,
    pub cumulative_funding_rate_long: i128,
    pub cumulative_funding_rate_short: i128,
    pub oracle_price_twap: i128,
    pub mark_price_twap: u128,
}

#[event]
pub struct CurveRecord {
    pub ts: i64,
    pub record_id: u64,
    pub market_index: u64,
    pub peg_multiplier_before: u128,
    pub base_asset_reserve_before: u128,
    pub quote_asset_reserve_before: u128,
    pub sqrt_k_before: u128,
    pub peg_multiplier_after: u128,
    pub base_asset_reserve_after: u128,
    pub quote_asset_reserve_after: u128,
    pub sqrt_k_after: u128,
    pub base_asset_amount_long: u128,
    pub base_asset_amount_short: u128,
    pub net_base_asset_amount: i128,
    pub open_interest: u128,
    pub total_fee: u128,
    pub total_fee_minus_distributions: u128,
    pub adjustment_cost: i128,
    pub oracle_price: i128,
    pub fill_record: u128,
}

#[event]
pub struct LiquidationRecord {
    pub ts: i64,
    pub user_authority: Pubkey,
    pub user: Pubkey,
    pub partial: bool,
    pub base_asset_value: u128,
    pub base_asset_value_closed: u128,
    pub liquidation_fee: u128,
    pub fee_to_liquidator: u64,
    pub fee_to_insurance_fund: u64,
    pub liquidator: Pubkey,
    pub total_collateral: u128,
    pub collateral: u128,
    pub unrealized_pnl: i128,
    pub margin_ratio: u128,
}

#[event]
pub struct OrderRecord {
    pub ts: i64,
    pub taker: Pubkey,
    pub maker: Pubkey,
    pub taker_order: Order,
    pub maker_order: Order,
    pub action: OrderAction,
    pub filler: Pubkey,
    pub fill_record_id: u64,
    pub market_index: u64,
    pub base_asset_amount_filled: u128,
    pub quote_asset_amount_filled: u128,
    pub maker_rebate: u128,
    pub taker_fee: u128,
    pub filler_reward: u128,
    pub quote_asset_amount_surplus: u128,
    pub oracle_price: i128,
}

#[derive(Clone, Copy, BorshSerialize, BorshDeserialize, PartialEq)]
pub enum OrderAction {
    Place,
    Cancel,
    Fill,
    Expire,
}

impl Default for OrderAction {
    // UpOnly
    fn default() -> Self {
        OrderAction::Place
    }
}
