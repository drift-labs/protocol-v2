#![allow(clippy::too_many_arguments)]
#![allow(unaligned_references)]
#![allow(clippy::bool_assert_comparison)]
#![allow(clippy::comparison_chain)]

use anchor_lang::prelude::*;
use borsh::BorshSerialize;

use instructions::*;
#[cfg(test)]
use math::amm;
use math::{bn, constants::*};
use state::oracle::OracleSource;

use crate::controller::position::PositionDirection;
use crate::state::perp_market::{ContractTier, MarketStatus};
use crate::state::spot_market::AssetTier;
use crate::state::state::FeeStructure;
use crate::state::state::*;
use crate::state::user::MarketType;

pub mod controller;
pub mod error;
pub mod ids;
pub mod instructions;
pub mod macros;
pub mod math;
mod signer;
pub mod state;
#[cfg(test)]
mod test_utils;
mod validation;

#[cfg(feature = "mainnet-beta")]
declare_id!("dammHkt7jmytvbS3nHTxQNEcP59aE57nxwV21YdqEDN");
#[cfg(not(feature = "mainnet-beta"))]
declare_id!("DUZwKJKAk2C9S88BYvQzck1M1i5hySQjxB4zW6tJ29Nw");

#[program]
pub mod clearing_house {
    use super::*;

    // User Instructions

    pub fn initialize_user(
        ctx: Context<InitializeUser>,
        sub_account_id: u8,
        name: [u8; 32],
    ) -> Result<()> {
        handle_initialize_user(ctx, sub_account_id, name)
    }

    pub fn initialize_user_stats(ctx: Context<InitializeUserStats>) -> Result<()> {
        handle_initialize_user_stats(ctx)
    }

    pub fn deposit(
        ctx: Context<Deposit>,
        market_index: u16,
        amount: u64,
        reduce_only: bool,
    ) -> Result<()> {
        handle_deposit(ctx, market_index, amount, reduce_only)
    }

    pub fn withdraw(
        ctx: Context<Withdraw>,
        market_index: u16,
        amount: u64,
        reduce_only: bool,
    ) -> anchor_lang::Result<()> {
        handle_withdraw(ctx, market_index, amount, reduce_only)
    }

    pub fn transfer_deposit(
        ctx: Context<TransferDeposit>,
        market_index: u16,
        amount: u64,
    ) -> anchor_lang::Result<()> {
        handle_transfer_deposit(ctx, market_index, amount)
    }

    pub fn place_order(ctx: Context<PlaceOrder>, params: OrderParams) -> Result<()> {
        handle_place_order(ctx, params)
    }

    pub fn cancel_order(ctx: Context<CancelOrder>, order_id: Option<u32>) -> Result<()> {
        handle_cancel_order(ctx, order_id)
    }

    pub fn cancel_order_by_user_id(ctx: Context<CancelOrder>, user_order_id: u8) -> Result<()> {
        handle_cancel_order_by_user_id(ctx, user_order_id)
    }

    pub fn cancel_orders(
        ctx: Context<CancelOrder>,
        market_type: Option<MarketType>,
        market_index: Option<u16>,
        direction: Option<PositionDirection>,
    ) -> Result<()> {
        handle_cancel_orders(ctx, market_type, market_index, direction)
    }

    pub fn place_and_take(
        ctx: Context<PlaceAndTake>,
        params: OrderParams,
        maker_order_id: Option<u32>,
    ) -> Result<()> {
        handle_place_and_take(ctx, params, maker_order_id)
    }

    pub fn place_and_make(
        ctx: Context<PlaceAndMake>,
        params: OrderParams,
        taker_order_id: u32,
    ) -> Result<()> {
        handle_place_and_make(ctx, params, taker_order_id)
    }

    pub fn place_spot_order(ctx: Context<PlaceOrder>, params: OrderParams) -> Result<()> {
        handle_place_spot_order(ctx, params)
    }

    pub fn place_and_take_spot_order(
        ctx: Context<PlaceAndTake>,
        params: OrderParams,
        fulfillment_type: Option<SpotFulfillmentType>,
        maker_order_id: Option<u32>,
    ) -> Result<()> {
        handle_place_and_take_spot_order(ctx, params, fulfillment_type, maker_order_id)
    }

    pub fn place_and_make_spot_order(
        ctx: Context<PlaceAndMake>,
        params: OrderParams,
        taker_order_id: u32,
    ) -> Result<()> {
        handle_place_and_make_spot_order(ctx, params, taker_order_id)
    }

    pub fn add_perp_lp_shares(
        ctx: Context<AddRemoveLiquidity>,
        n_shares: u64,
        market_index: u16,
    ) -> Result<()> {
        handle_add_perp_lp_shares(ctx, n_shares, market_index)
    }

    pub fn remove_perp_lp_shares(
        ctx: Context<AddRemoveLiquidity>,
        shares_to_burn: u64,
        market_index: u16,
    ) -> Result<()> {
        handle_remove_perp_lp_shares(ctx, shares_to_burn, market_index)
    }

    pub fn remove_perp_lp_shares_in_expiring_market(
        ctx: Context<RemoveLiquidityInExpiredMarket>,
        shares_to_burn: u64,
        market_index: u16,
    ) -> Result<()> {
        handle_remove_perp_lp_shares_in_expiring_market(ctx, shares_to_burn, market_index)
    }

    pub fn update_user_name(
        ctx: Context<UpdateUser>,
        _sub_account_id: u8,
        name: [u8; 32],
    ) -> Result<()> {
        handle_update_user_name(ctx, _sub_account_id, name)
    }

    pub fn update_user_custom_margin_ratio(
        ctx: Context<UpdateUser>,
        _sub_account_id: u8,
        margin_ratio: u32,
    ) -> Result<()> {
        handle_update_user_custom_margin_ratio(ctx, _sub_account_id, margin_ratio)
    }

    pub fn update_user_delegate(
        ctx: Context<UpdateUser>,
        _sub_account_id: u8,
        delegate: Pubkey,
    ) -> Result<()> {
        handle_update_user_delegate(ctx, _sub_account_id, delegate)
    }

    pub fn delete_user(ctx: Context<DeleteUser>) -> Result<()> {
        handle_delete_user(ctx)
    }

    // Keeper Instructions

    pub fn fill_order(
        ctx: Context<FillOrder>,
        order_id: Option<u32>,
        maker_order_id: Option<u32>,
    ) -> Result<()> {
        handle_fill_order(ctx, order_id, maker_order_id)
    }

    pub fn fill_spot_order(
        ctx: Context<FillOrder>,
        order_id: Option<u32>,
        fulfillment_type: Option<SpotFulfillmentType>,
        maker_order_id: Option<u32>,
    ) -> Result<()> {
        handle_fill_spot_order(ctx, order_id, fulfillment_type, maker_order_id)
    }

    pub fn trigger_order(ctx: Context<TriggerOrder>, order_id: u32) -> Result<()> {
        handle_trigger_order(ctx, order_id)
    }

    pub fn settle_pnl(ctx: Context<SettlePNL>, market_index: u16) -> Result<()> {
        handle_settle_pnl(ctx, market_index)
    }

    pub fn settle_funding_payment(ctx: Context<SettleFunding>) -> Result<()> {
        handle_settle_funding_payment(ctx)
    }

    pub fn settle_lp(ctx: Context<SettleLP>, market_index: u16) -> Result<()> {
        handle_settle_lp(ctx, market_index)
    }

    pub fn settle_expired_market(ctx: Context<UpdateAMM>, market_index: u16) -> Result<()> {
        handle_settle_expired_market(ctx, market_index)
    }

    pub fn liquidate_perp(
        ctx: Context<LiquidatePerp>,
        market_index: u16,
        liquidator_max_base_asset_amount: u64,
    ) -> Result<()> {
        handle_liquidate_perp(ctx, market_index, liquidator_max_base_asset_amount)
    }

    pub fn liquidate_spot(
        ctx: Context<LiquidateSpot>,
        asset_market_index: u16,
        liability_market_index: u16,
        liquidator_max_liability_transfer: u128,
    ) -> Result<()> {
        handle_liquidate_spot(
            ctx,
            asset_market_index,
            liability_market_index,
            liquidator_max_liability_transfer,
        )
    }

    pub fn liquidate_borrow_for_perp_pnl(
        ctx: Context<LiquidateBorrowForPerpPnl>,
        perp_market_index: u16,
        spot_market_index: u16,
        liquidator_max_liability_transfer: u128,
    ) -> Result<()> {
        handle_liquidate_borrow_for_perp_pnl(
            ctx,
            perp_market_index,
            spot_market_index,
            liquidator_max_liability_transfer,
        )
    }

    pub fn liquidate_perp_pnl_for_deposit(
        ctx: Context<LiquidatePerpPnlForDeposit>,
        perp_market_index: u16,
        spot_market_index: u16,
        liquidator_max_pnl_transfer: u128,
    ) -> Result<()> {
        handle_liquidate_perp_pnl_for_deposit(
            ctx,
            perp_market_index,
            spot_market_index,
            liquidator_max_pnl_transfer,
        )
    }

    pub fn resolve_perp_pnl_deficit(
        ctx: Context<ResolvePerpPnlDeficit>,
        spot_market_index: u16,
        perp_market_index: u16,
    ) -> Result<()> {
        handle_resolve_perp_pnl_deficit(ctx, spot_market_index, perp_market_index)
    }

    pub fn resolve_perp_bankruptcy(
        ctx: Context<ResolveBankruptcy>,
        quote_spot_market_index: u16,
        market_index: u16,
    ) -> Result<()> {
        handle_resolve_perp_bankruptcy(ctx, quote_spot_market_index, market_index)
    }

    pub fn resolve_spot_bankruptcy(
        ctx: Context<ResolveBankruptcy>,
        market_index: u16,
    ) -> Result<()> {
        handle_resolve_spot_bankruptcy(ctx, market_index)
    }

    pub fn settle_revenue_to_insurance_fund(
        ctx: Context<SettleRevenueToInsuranceFund>,
        spot_market_index: u16,
    ) -> Result<()> {
        handle_settle_revenue_to_insurance_fund(ctx, spot_market_index)
    }

    pub fn update_funding_rate(ctx: Context<UpdateFundingRate>, market_index: u16) -> Result<()> {
        handle_update_funding_rate(ctx, market_index)
    }

    pub fn update_spot_market_cumulative_interest(
        ctx: Context<UpdateSpotMarketCumulativeInterest>,
    ) -> Result<()> {
        handle_update_spot_market_cumulative_interest(ctx)
    }

    pub fn update_amms(ctx: Context<UpdateAMM>, market_indexes: [u16; 5]) -> Result<()> {
        handle_update_amms(ctx, market_indexes)
    }

    pub fn update_spot_market_expiry(
        ctx: Context<AdminUpdateSpotMarket>,
        expiry_ts: i64,
    ) -> Result<()> {
        handle_update_spot_market_expiry(ctx, expiry_ts)
    }

    pub fn update_user_quote_asset_insurance_stake(
        ctx: Context<UpdateUserQuoteAssetInsuranceStake>,
    ) -> Result<()> {
        handle_update_user_quote_asset_insurance_stake(ctx)
    }

    // IF stakers

    pub fn initialize_insurance_fund_stake(
        ctx: Context<InitializeInsuranceFundStake>,
        market_index: u16,
    ) -> Result<()> {
        handle_initialize_insurance_fund_stake(ctx, market_index)
    }

    pub fn add_insurance_fund_stake(
        ctx: Context<AddInsuranceFundStake>,
        market_index: u16,
        amount: u64,
    ) -> Result<()> {
        handle_add_insurance_fund_stake(ctx, market_index, amount)
    }

    pub fn request_remove_insurance_fund_stake(
        ctx: Context<RequestRemoveInsuranceFundStake>,
        market_index: u16,
        amount: u64,
    ) -> Result<()> {
        handle_request_remove_insurance_fund_stake(ctx, market_index, amount)
    }

    pub fn cancel_request_remove_insurance_fund_stake(
        ctx: Context<RequestRemoveInsuranceFundStake>,
        market_index: u16,
    ) -> Result<()> {
        handle_cancel_request_remove_insurance_fund_stake(ctx, market_index)
    }

    pub fn remove_insurance_fund_stake(
        ctx: Context<RemoveInsuranceFundStake>,
        market_index: u16,
    ) -> Result<()> {
        handle_remove_insurance_fund_stake(ctx, market_index)
    }

    // Admin Instructions

    pub fn initialize(ctx: Context<Initialize>) -> Result<()> {
        handle_initialize(ctx)
    }

    pub fn initialize_spot_market(
        ctx: Context<InitializeSpotMarket>,
        optimal_utilization: u32,
        optimal_borrow_rate: u32,
        max_borrow_rate: u32,
        oracle_source: OracleSource,
        initial_asset_weight: u128,
        maintenance_asset_weight: u128,
        initial_liability_weight: u128,
        maintenance_liability_weight: u128,
        imf_factor: u128,
        liquidation_fee: u128,
        active_status: bool,
    ) -> Result<()> {
        handle_initialize_spot_market(
            ctx,
            optimal_utilization,
            optimal_borrow_rate,
            max_borrow_rate,
            oracle_source,
            initial_asset_weight,
            maintenance_asset_weight,
            initial_liability_weight,
            maintenance_liability_weight,
            imf_factor,
            liquidation_fee,
            active_status,
        )
    }

    pub fn initialize_serum_fulfillment_config(
        ctx: Context<InitializeSerumFulfillmentConfig>,
        market_index: u16,
    ) -> Result<()> {
        handle_initialize_serum_fulfillment_config(ctx, market_index)
    }

    pub fn update_serum_vault(ctx: Context<UpdateSerumVault>) -> Result<()> {
        handle_update_serum_vault(ctx)
    }

    pub fn initialize_perp_market(
        ctx: Context<InitializePerpMarket>,
        amm_base_asset_reserve: u128,
        amm_quote_asset_reserve: u128,
        amm_periodicity: i64,
        amm_peg_multiplier: u128,
        oracle_source: OracleSource,
        margin_ratio_initial: u32,
        margin_ratio_maintenance: u32,
        liquidation_fee: u128,
        active_status: bool,
        name: [u8; 32],
    ) -> Result<()> {
        handle_initialize_perp_market(
            ctx,
            amm_base_asset_reserve,
            amm_quote_asset_reserve,
            amm_periodicity,
            amm_peg_multiplier,
            oracle_source,
            margin_ratio_initial,
            margin_ratio_maintenance,
            liquidation_fee,
            active_status,
            name,
        )
    }

    pub fn move_amm_price(
        ctx: Context<AdminUpdatePerpMarket>,
        base_asset_reserve: u128,
        quote_asset_reserve: u128,
        sqrt_k: u128,
    ) -> Result<()> {
        handle_move_amm_price(ctx, base_asset_reserve, quote_asset_reserve, sqrt_k)
    }

    pub fn update_perp_market_expiry(
        ctx: Context<AdminUpdatePerpMarket>,
        expiry_ts: i64,
    ) -> Result<()> {
        handle_update_perp_market_expiry(ctx, expiry_ts)
    }

    pub fn settle_expired_market_pools_to_revenue_pool(
        ctx: Context<SettleExpiredMarketPoolsToRevenuePool>,
    ) -> Result<()> {
        handle_settle_expired_market_pools_to_revenue_pool(ctx)
    }

    pub fn deposit_into_perp_market_fee_pool(
        ctx: Context<DepositIntoMarketFeePool>,
        amount: u64,
    ) -> Result<()> {
        handle_deposit_into_perp_market_fee_pool(ctx, amount)
    }

    pub fn repeg_amm_curve(ctx: Context<RepegCurve>, new_peg_candidate: u128) -> Result<()> {
        handle_repeg_amm_curve(ctx, new_peg_candidate)
    }

    pub fn update_perp_market_amm_oracle_twap(ctx: Context<RepegCurve>) -> Result<()> {
        handle_update_amm_oracle_twap(ctx)
    }

    pub fn reset_perp_market_amm_oracle_twap(ctx: Context<RepegCurve>) -> Result<()> {
        handle_reset_amm_oracle_twap(ctx)
    }

    pub fn update_k(ctx: Context<AdminUpdateK>, sqrt_k: u128) -> Result<()> {
        handle_update_k(ctx, sqrt_k)
    }

    pub fn update_perp_market_margin_ratio(
        ctx: Context<AdminUpdatePerpMarket>,
        margin_ratio_initial: u32,
        margin_ratio_maintenance: u32,
    ) -> Result<()> {
        handle_update_perp_market_margin_ratio(ctx, margin_ratio_initial, margin_ratio_maintenance)
    }

    pub fn update_perp_market_max_imbalances(
        ctx: Context<AdminUpdatePerpMarket>,
        unrealized_max_imbalance: u128,
        max_revenue_withdraw_per_period: u128,
        quote_max_insurance: u128,
    ) -> Result<()> {
        handle_update_perp_market_max_imbalances(
            ctx,
            unrealized_max_imbalance,
            max_revenue_withdraw_per_period,
            quote_max_insurance,
        )
    }

    pub fn update_perp_liquidation_fee(
        ctx: Context<AdminUpdatePerpMarket>,
        liquidator_fee: u128,
        if_liquidation_fee: u128,
    ) -> Result<()> {
        handle_update_perp_liquidation_fee(ctx, liquidator_fee, if_liquidation_fee)
    }

    pub fn update_insurance_fund_unstaking_period(
        ctx: Context<AdminUpdateSpotMarket>,
        insurance_fund_unstaking_period: i64,
    ) -> Result<()> {
        handle_update_insurance_fund_unstaking_period(ctx, insurance_fund_unstaking_period)
    }

    pub fn update_spot_market_liquidation_fee(
        ctx: Context<AdminUpdateSpotMarket>,
        liquidator_fee: u128,
        if_liquidation_fee: u128,
    ) -> Result<()> {
        handle_update_spot_market_liquidation_fee(ctx, liquidator_fee, if_liquidation_fee)
    }

    pub fn update_withdraw_guard_threshold(
        ctx: Context<AdminUpdateSpotMarket>,
        withdraw_guard_threshold: u128,
    ) -> Result<()> {
        handle_update_withdraw_guard_threshold(ctx, withdraw_guard_threshold)
    }

    pub fn update_spot_market_if_factor(
        ctx: Context<AdminUpdateSpotMarket>,
        spot_market_index: u16,
        user_if_factor: u32,
        total_if_factor: u32,
    ) -> Result<()> {
        handle_update_spot_market_if_factor(ctx, spot_market_index, user_if_factor, total_if_factor)
    }

    pub fn update_spot_market_revenue_settle_period(
        ctx: Context<AdminUpdateSpotMarket>,
        revenue_settle_period: i64,
    ) -> Result<()> {
        handle_update_spot_market_revenue_settle_period(ctx, revenue_settle_period)
    }

    pub fn update_spot_market_status(
        ctx: Context<AdminUpdateSpotMarket>,
        status: MarketStatus,
    ) -> Result<()> {
        handle_update_spot_market_status(ctx, status)
    }

    pub fn update_spot_market_asset_tier(
        ctx: Context<AdminUpdateSpotMarket>,
        asset_tier: AssetTier,
    ) -> Result<()> {
        handle_update_spot_market_asset_tier(ctx, asset_tier)
    }

    pub fn update_spot_market_margin_weights(
        ctx: Context<AdminUpdateSpotMarket>,
        initial_asset_weight: u128,
        maintenance_asset_weight: u128,
        initial_liability_weight: u128,
        maintenance_liability_weight: u128,
        imf_factor: u128,
    ) -> Result<()> {
        handle_update_spot_market_margin_weights(
            ctx,
            initial_asset_weight,
            maintenance_asset_weight,
            initial_liability_weight,
            maintenance_liability_weight,
            imf_factor,
        )
    }

    pub fn update_spot_market_max_token_deposits(
        ctx: Context<AdminUpdateSpotMarket>,
        max_token_deposits: u128,
    ) -> Result<()> {
        handle_update_spot_market_max_token_deposits(ctx, max_token_deposits)
    }

    pub fn update_spot_market_oracle(
        ctx: Context<AdminUpdateSpotMarket>,
        oracle: Pubkey,
        oracle_source: OracleSource,
    ) -> Result<()> {
        handle_update_spot_market_oracle(ctx, oracle, oracle_source)
    }

    pub fn update_perp_market_status(
        ctx: Context<AdminUpdatePerpMarket>,
        status: MarketStatus,
    ) -> Result<()> {
        handle_update_perp_market_status(ctx, status)
    }

    pub fn update_perp_market_contract_tier(
        ctx: Context<AdminUpdatePerpMarket>,
        contract_tier: ContractTier,
    ) -> Result<()> {
        handle_update_perp_market_contract_tier(ctx, contract_tier)
    }

    pub fn update_perp_market_imf_factor(
        ctx: Context<AdminUpdatePerpMarket>,
        imf_factor: u128,
    ) -> Result<()> {
        handle_update_perp_market_imf_factor(ctx, imf_factor)
    }

    pub fn update_perp_market_unrealized_asset_weight(
        ctx: Context<AdminUpdatePerpMarket>,
        unrealized_initial_asset_weight: u32,
        unrealized_maintenance_asset_weight: u32,
    ) -> Result<()> {
        handle_update_perp_market_unrealized_asset_weight(
            ctx,
            unrealized_initial_asset_weight,
            unrealized_maintenance_asset_weight,
        )
    }

    pub fn update_perp_market_concentration_coef(
        ctx: Context<AdminUpdatePerpMarket>,
        concentration_scale: u128,
    ) -> Result<()> {
        handle_update_perp_market_concentration_coef(ctx, concentration_scale)
    }

    pub fn update_perp_market_curve_update_intensity(
        ctx: Context<AdminUpdatePerpMarket>,
        curve_update_intensity: u8,
    ) -> Result<()> {
        handle_update_perp_market_curve_update_intensity(ctx, curve_update_intensity)
    }

    pub fn update_lp_cooldown_time(
        ctx: Context<AdminUpdateState>,
        lp_cooldown_time: u64,
    ) -> Result<()> {
        handle_update_lp_cooldown_time(ctx, lp_cooldown_time)
    }

    pub fn update_perp_fee_structure(
        ctx: Context<AdminUpdateState>,
        fee_structure: FeeStructure,
    ) -> Result<()> {
        handle_update_perp_fee_structure(ctx, fee_structure)
    }

    pub fn update_spot_fee_structure(
        ctx: Context<AdminUpdateState>,
        fee_structure: FeeStructure,
    ) -> Result<()> {
        handle_update_spot_fee_structure(ctx, fee_structure)
    }

    pub fn update_oracle_guard_rails(
        ctx: Context<AdminUpdateState>,
        oracle_guard_rails: OracleGuardRails,
    ) -> Result<()> {
        handle_update_oracle_guard_rails(ctx, oracle_guard_rails)
    }

    pub fn update_perp_market_oracle(
        ctx: Context<AdminUpdatePerpMarket>,
        oracle: Pubkey,
        oracle_source: OracleSource,
    ) -> Result<()> {
        handle_update_perp_market_oracle(ctx, oracle, oracle_source)
    }

    pub fn update_perp_market_base_spread(
        ctx: Context<AdminUpdatePerpMarket>,
        base_spread: u16,
    ) -> Result<()> {
        handle_update_perp_market_base_spread(ctx, base_spread)
    }

    pub fn update_amm_jit_intensity(
        ctx: Context<AdminUpdatePerpMarket>,
        amm_jit_intensity: u8,
    ) -> Result<()> {
        handle_update_amm_jit_intensity(ctx, amm_jit_intensity)
    }

    pub fn update_perp_market_max_spread(
        ctx: Context<AdminUpdatePerpMarket>,
        max_spread: u32,
    ) -> Result<()> {
        handle_update_perp_market_max_spread(ctx, max_spread)
    }

    pub fn update_perp_market_step_size_and_tick_size(
        ctx: Context<AdminUpdatePerpMarket>,
        step_size: u64,
        tick_size: u64,
    ) -> Result<()> {
        handle_update_perp_market_step_size_and_tick_size(ctx, step_size, tick_size)
    }

    pub fn update_perp_market_name(
        ctx: Context<AdminUpdatePerpMarket>,
        name: [u8; 32],
    ) -> Result<()> {
        handle_update_perp_market_name(ctx, name)
    }

    #[access_control(
        market_valid(&ctx.accounts.perp_market)
    )]
    pub fn update_perp_market_min_order_size(
        ctx: Context<AdminUpdatePerpMarket>,
        order_size: u64,
    ) -> Result<()> {
        handle_update_perp_market_min_order_size(ctx, order_size)
    }

    pub fn update_perp_market_max_slippage_ratio(
        ctx: Context<AdminUpdatePerpMarket>,
        max_slippage_ratio: u16,
    ) -> Result<()> {
        handle_update_perp_market_max_slippage_ratio(ctx, max_slippage_ratio)
    }

    pub fn update_perp_market_max_fill_reserve_fraction(
        ctx: Context<AdminUpdatePerpMarket>,
        max_fill_reserve_fraction: u16,
    ) -> Result<()> {
        handle_update_perp_market_max_fill_reserve_fraction(ctx, max_fill_reserve_fraction)
    }

    pub fn update_admin(ctx: Context<AdminUpdateState>, admin: Pubkey) -> Result<()> {
        handle_update_admin(ctx, admin)
    }

    pub fn update_whitelist_mint(
        ctx: Context<AdminUpdateState>,
        whitelist_mint: Pubkey,
    ) -> Result<()> {
        handle_update_whitelist_mint(ctx, whitelist_mint)
    }

    pub fn update_discount_mint(
        ctx: Context<AdminUpdateState>,
        discount_mint: Pubkey,
    ) -> Result<()> {
        handle_update_discount_mint(ctx, discount_mint)
    }

    pub fn update_exchange_status(
        ctx: Context<AdminUpdateState>,
        exchange_status: ExchangeStatus,
    ) -> Result<()> {
        handle_update_exchange_status(ctx, exchange_status)
    }

    pub fn update_perp_auction_duration(
        ctx: Context<AdminUpdateState>,
        min_perp_auction_duration: u8,
    ) -> Result<()> {
        handle_update_perp_auction_duration(ctx, min_perp_auction_duration)
    }

    pub fn update_spot_auction_duration(
        ctx: Context<AdminUpdateState>,
        default_spot_auction_duration: u8,
    ) -> Result<()> {
        handle_update_spot_auction_duration(ctx, default_spot_auction_duration)
    }

    pub fn admin_remove_insurance_fund_stake(
        ctx: Context<AdminRemoveInsuranceFundStake>,
        market_index: u16,
        amount: u64,
    ) -> Result<()> {
        handle_admin_remove_insurance_fund_stake(ctx, market_index, amount)
    }
}
