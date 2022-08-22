use anchor_lang::prelude::*;
use borsh::{BorshDeserialize, BorshSerialize};

use crate::state::user::Order;
use anchor_lang::Discriminator;
use std::io::Write;

#[event]
pub struct NewUserRecord {
    pub ts: i64,
    pub user_authority: Pubkey,
    pub user: Pubkey,
    pub user_id: u8,
    pub name: [u8; 32],
    pub referrer: Pubkey,
}

#[event]
pub struct DepositRecord {
    pub ts: i64,
    pub user_authority: Pubkey,
    pub user: Pubkey,
    pub direction: DepositDirection,
    pub amount: u64,
    pub bank_index: u64,
    pub oracle_price: i128,
    pub referrer: Pubkey,
    pub from: Option<Pubkey>,
    pub to: Option<Pubkey>,
}

#[derive(Clone, Copy, BorshSerialize, BorshDeserialize, PartialEq, Eq)]
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
    pub total_fee_minus_distributions: i128,
    pub adjustment_cost: i128,
    pub oracle_price: i128,
    pub fill_record: u128,
}

#[event]
pub struct OrderRecord {
    pub ts: i64,
    pub slot: u64,
    pub taker: Pubkey,
    pub maker: Pubkey,
    pub taker_order: Order,
    pub maker_order: Order,
    pub maker_pnl: i128,
    pub taker_pnl: i128,
    pub action: OrderAction,
    pub action_explanation: OrderActionExplanation,
    pub filler: Pubkey,
    pub fill_record_id: u64,
    pub market_index: u64,
    pub base_asset_amount_filled: u128,
    pub quote_asset_amount_filled: u128,
    pub maker_rebate: u128,
    pub taker_fee: u128,
    pub filler_reward: u128,
    pub referrer: Pubkey,
    pub referrer_reward: u128,
    pub referee_discount: u128,
    pub quote_asset_amount_surplus: u128,
    pub oracle_price: i128,
}

#[derive(Clone, Copy, BorshSerialize, BorshDeserialize, PartialEq, Eq)]
pub enum OrderAction {
    Place,
    Cancel,
    Fill,
    Trigger,
    Expire,
}

#[derive(Clone, Copy, BorshSerialize, BorshDeserialize, PartialEq, Eq)]
pub enum OrderActionExplanation {
    None,
    BreachedMarginRequirement,
    OraclePriceBreachedLimitPrice,
    MarketOrderFilledToLimitPrice,
    MarketOrderAuctionExpired,
    CanceledForLiquidation,
    OrderFilledWithAMM,
    OrderFilledWithMatch,
}

impl Default for OrderAction {
    // UpOnly
    fn default() -> Self {
        OrderAction::Place
    }
}

#[event]
#[derive(Default)]
pub struct LiquidationRecord {
    pub ts: i64,
    pub liquidation_type: LiquidationType,
    pub user: Pubkey,
    pub liquidator: Pubkey,
    pub margin_requirement: u128,
    pub total_collateral: i128,
    pub liquidation_id: u16,
    pub bankrupt: bool,
    pub liquidate_perp: LiquidatePerpRecord,
    pub liquidate_borrow: LiquidateBorrowRecord,
    pub liquidate_borrow_for_perp_pnl: LiquidateBorrowForPerpPnlRecord,
    pub liquidate_perp_pnl_for_deposit: LiquidatePerpPnlForDepositRecord,
    pub perp_bankruptcy: PerpBankruptcyRecord,
    pub borrow_bankruptcy: BorrowBankruptcyRecord,
}

#[derive(Clone, Copy, BorshSerialize, BorshDeserialize, PartialEq, Eq)]
pub enum LiquidationType {
    LiquidatePerp,
    LiquidateBorrow,
    LiquidateBorrowForPerpPnl,
    LiquidatePerpPnlForDeposit,
    PerpBankruptcy,
    BorrowBankruptcy,
}

impl Default for LiquidationType {
    // UpOnly
    fn default() -> Self {
        LiquidationType::LiquidatePerp
    }
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug, Default)]
pub struct LiquidatePerpRecord {
    pub market_index: u64,
    pub order_ids: Vec<u64>,
    pub canceled_orders_fee: u128,
    pub oracle_price: i128,
    pub base_asset_amount: i128,
    pub quote_asset_amount: i128,
    pub user_pnl: i128,
    pub liquidator_pnl: i128,
    pub fill_record_id: u64,
    pub user_order_id: u64,
    pub liquidator_order_id: u64,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug, Default)]
pub struct LiquidateBorrowRecord {
    pub asset_bank_index: u64,
    pub asset_price: i128,
    pub asset_transfer: u128,
    pub liability_bank_index: u64,
    pub liability_price: i128,
    pub liability_transfer: u128,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug, Default)]
pub struct LiquidateBorrowForPerpPnlRecord {
    pub market_index: u64,
    pub market_oracle_price: i128,
    pub pnl_transfer: u128,
    pub liability_bank_index: u64,
    pub liability_price: i128,
    pub liability_transfer: u128,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug, Default)]
pub struct LiquidatePerpPnlForDepositRecord {
    pub market_index: u64,
    pub market_oracle_price: i128,
    pub pnl_transfer: u128,
    pub asset_bank_index: u64,
    pub asset_price: i128,
    pub asset_transfer: u128,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug, Default)]
pub struct PerpBankruptcyRecord {
    pub market_index: u64,
    pub pnl: i128,
    pub cumulative_funding_rate_delta: i128,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug, Default)]
pub struct BorrowBankruptcyRecord {
    pub bank_index: u64,
    pub borrow_amount: u128,
    pub cumulative_deposit_interest_delta: u128,
}

#[event]
#[derive(Default)]
pub struct SettlePnlRecord {
    pub ts: i64,
    pub user: Pubkey,
    pub market_index: u64,
    pub pnl: i128,
    pub base_asset_amount: i128,
    pub quote_asset_amount_after: i128,
    pub quote_entry_amount: i128,
    pub settle_price: i128,
}

pub fn emit_stack<T: AnchorSerialize + Discriminator, const N: usize>(event: T) {
    let mut data_buf = [0u8; N];
    let mut out_buf = [0u8; N];

    emit_buffers(event, &mut data_buf[..], &mut out_buf[..])
}

pub fn emit_buffers<T: AnchorSerialize + Discriminator>(
    event: T,
    data_buf: &mut [u8],
    out_buf: &mut [u8],
) {
    let mut data_writer = std::io::Cursor::new(data_buf);
    data_writer
        .write_all(&<T as Discriminator>::discriminator())
        .unwrap();
    borsh::to_writer(&mut data_writer, &event).unwrap();
    let data_len = data_writer.position() as usize;

    let out_len = base64::encode_config_slice(
        &data_writer.into_inner()[0..data_len],
        base64::STANDARD,
        out_buf,
    );

    let msg_bytes = &out_buf[0..out_len];
    let msg_str = unsafe { std::str::from_utf8_unchecked(msg_bytes) };

    msg!(msg_str);
}
