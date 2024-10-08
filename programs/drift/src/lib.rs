#![allow(clippy::too_many_arguments)]
#![allow(clippy::bool_assert_comparison)]
#![allow(clippy::comparison_chain)]

use anchor_lang::prelude::*;

use instructions::*;
#[cfg(test)]
use math::amm;
use math::{bn, constants::*};
use state::oracle::OracleSource;

use crate::controller::position::PositionDirection;
use crate::state::oracle::PrelaunchOracleParams;
use crate::state::order_params::{ModifyOrderParams, OrderParams};
use crate::state::perp_market::{ContractTier, MarketStatus};
use crate::state::settle_pnl_mode::SettlePnlMode;
use crate::state::spot_market::AssetTier;
use crate::state::spot_market::SpotFulfillmentConfigStatus;
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
declare_id!("dRiftyHA39MWEi3m9aunc5MzRF1JYuBsbn6VPcn33UH");
#[cfg(not(feature = "mainnet-beta"))]
declare_id!("dRiftyHA39MWEi3m9aunc5MzRF1JYuBsbn6VPcn33UH");

#[program]
pub mod drift {
    use super::*;
    use crate::state::spot_market::SpotFulfillmentConfigStatus;

    // User Instructions

    pub fn initialize_user<'c: 'info, 'info>(
        ctx: Context<'_, '_, 'c, 'info, InitializeUser<'info>>,
        sub_account_id: u16,
        name: [u8; 32],
    ) -> Result<()> {
        handle_initialize_user(ctx, sub_account_id, name)
    }

    pub fn initialize_user_stats<'c: 'info, 'info>(
        ctx: Context<'_, '_, 'c, 'info, InitializeUserStats>,
    ) -> Result<()> {
        handle_initialize_user_stats(ctx)
    }

    pub fn initialize_referrer_name(
        ctx: Context<InitializeReferrerName>,
        name: [u8; 32],
    ) -> Result<()> {
        handle_initialize_referrer_name(ctx, name)
    }

    pub fn deposit<'c: 'info, 'info>(
        ctx: Context<'_, '_, 'c, 'info, Deposit<'info>>,
        market_index: u16,
        amount: u64,
        reduce_only: bool,
    ) -> Result<()> {
        handle_deposit(ctx, market_index, amount, reduce_only)
    }

    pub fn withdraw<'c: 'info, 'info>(
        ctx: Context<'_, '_, 'c, 'info, Withdraw<'info>>,
        market_index: u16,
        amount: u64,
        reduce_only: bool,
    ) -> anchor_lang::Result<()> {
        handle_withdraw(ctx, market_index, amount, reduce_only)
    }

    pub fn transfer_deposit<'c: 'info, 'info>(
        ctx: Context<'_, '_, 'c, 'info, TransferDeposit<'info>>,
        market_index: u16,
        amount: u64,
    ) -> anchor_lang::Result<()> {
        handle_transfer_deposit(ctx, market_index, amount)
    }

    pub fn place_perp_order<'c: 'info, 'info>(
        ctx: Context<'_, '_, 'c, 'info, PlaceOrder>,
        params: OrderParams,
    ) -> Result<()> {
        handle_place_perp_order(ctx, params)
    }

    pub fn cancel_order<'c: 'info, 'info>(
        ctx: Context<'_, '_, 'c, 'info, CancelOrder>,
        order_id: Option<u32>,
    ) -> Result<()> {
        handle_cancel_order(ctx, order_id)
    }

    pub fn cancel_order_by_user_id<'c: 'info, 'info>(
        ctx: Context<'_, '_, 'c, 'info, CancelOrder>,
        user_order_id: u8,
    ) -> Result<()> {
        handle_cancel_order_by_user_id(ctx, user_order_id)
    }

    pub fn cancel_orders<'c: 'info, 'info>(
        ctx: Context<'_, '_, 'c, 'info, CancelOrder<'info>>,
        market_type: Option<MarketType>,
        market_index: Option<u16>,
        direction: Option<PositionDirection>,
    ) -> Result<()> {
        handle_cancel_orders(ctx, market_type, market_index, direction)
    }

    pub fn cancel_orders_by_ids<'c: 'info, 'info>(
        ctx: Context<'_, '_, 'c, 'info, CancelOrder>,
        order_ids: Vec<u32>,
    ) -> Result<()> {
        handle_cancel_orders_by_ids(ctx, order_ids)
    }

    pub fn modify_order<'c: 'info, 'info>(
        ctx: Context<'_, '_, 'c, 'info, CancelOrder<'info>>,
        order_id: Option<u32>,
        modify_order_params: ModifyOrderParams,
    ) -> Result<()> {
        handle_modify_order(ctx, order_id, modify_order_params)
    }

    pub fn modify_order_by_user_id<'c: 'info, 'info>(
        ctx: Context<'_, '_, 'c, 'info, CancelOrder<'info>>,
        user_order_id: u8,
        modify_order_params: ModifyOrderParams,
    ) -> Result<()> {
        handle_modify_order_by_user_order_id(ctx, user_order_id, modify_order_params)
    }

    pub fn place_and_take_perp_order<'c: 'info, 'info>(
        ctx: Context<'_, '_, 'c, 'info, PlaceAndTake<'info>>,
        params: OrderParams,
        success_condition: Option<u32>,
    ) -> Result<()> {
        handle_place_and_take_perp_order(ctx, params, success_condition)
    }

    pub fn place_and_make_perp_order<'c: 'info, 'info>(
        ctx: Context<'_, '_, 'c, 'info, PlaceAndMake<'info>>,
        params: OrderParams,
        taker_order_id: u32,
    ) -> Result<()> {
        handle_place_and_make_perp_order(ctx, params, taker_order_id)
    }

    pub fn place_swift_taker_order<'c: 'info, 'info>(
        ctx: Context<'_, '_, 'c, 'info, PlaceSwiftTakerOrder<'info>>,
        swift_message_bytes: Vec<u8>,
        swift_order_params_message_bytes: Vec<u8>,
        swift_message_signature: [u8; 64],
    ) -> Result<()> {
        handle_place_swift_taker_order(
            ctx,
            swift_message_bytes,
            swift_order_params_message_bytes,
            swift_message_signature,
        )
    }

    pub fn place_spot_order<'c: 'info, 'info>(
        ctx: Context<'_, '_, 'c, 'info, PlaceOrder>,
        params: OrderParams,
    ) -> Result<()> {
        handle_place_spot_order(ctx, params)
    }

    pub fn place_and_take_spot_order<'c: 'info, 'info>(
        ctx: Context<'_, '_, 'c, 'info, PlaceAndTake<'info>>,
        params: OrderParams,
        fulfillment_type: Option<SpotFulfillmentType>,
        maker_order_id: Option<u32>,
    ) -> Result<()> {
        handle_place_and_take_spot_order(
            ctx,
            params,
            fulfillment_type.unwrap_or(SpotFulfillmentType::Match),
            maker_order_id,
        )
    }

    pub fn place_and_make_spot_order<'c: 'info, 'info>(
        ctx: Context<'_, '_, 'c, 'info, PlaceAndMake<'info>>,
        params: OrderParams,
        taker_order_id: u32,
        fulfillment_type: Option<SpotFulfillmentType>,
    ) -> Result<()> {
        handle_place_and_make_spot_order(
            ctx,
            params,
            taker_order_id,
            fulfillment_type.unwrap_or(SpotFulfillmentType::Match),
        )
    }

    pub fn place_orders<'c: 'info, 'info>(
        ctx: Context<'_, '_, 'c, 'info, PlaceOrder>,
        params: Vec<OrderParams>,
    ) -> Result<()> {
        handle_place_orders(ctx, params)
    }

    pub fn begin_swap<'c: 'info, 'info>(
        ctx: Context<'_, '_, 'c, 'info, Swap<'info>>,
        in_market_index: u16,
        out_market_index: u16,
        amount_in: u64,
    ) -> Result<()> {
        handle_begin_swap(ctx, in_market_index, out_market_index, amount_in)
    }

    pub fn end_swap<'c: 'info, 'info>(
        ctx: Context<'_, '_, 'c, 'info, Swap<'info>>,
        in_market_index: u16,
        out_market_index: u16,
        limit_price: Option<u64>,
        reduce_only: Option<SwapReduceOnly>,
    ) -> Result<()> {
        handle_end_swap(
            ctx,
            in_market_index,
            out_market_index,
            limit_price,
            reduce_only,
        )
    }

    pub fn add_perp_lp_shares<'c: 'info, 'info>(
        ctx: Context<'_, '_, 'c, 'info, AddRemoveLiquidity<'info>>,
        n_shares: u64,
        market_index: u16,
    ) -> Result<()> {
        handle_add_perp_lp_shares(ctx, n_shares, market_index)
    }

    pub fn remove_perp_lp_shares<'c: 'info, 'info>(
        ctx: Context<'_, '_, 'c, 'info, AddRemoveLiquidity<'info>>,
        shares_to_burn: u64,
        market_index: u16,
    ) -> Result<()> {
        handle_remove_perp_lp_shares(ctx, shares_to_burn, market_index)
    }

    pub fn remove_perp_lp_shares_in_expiring_market<'c: 'info, 'info>(
        ctx: Context<'_, '_, 'c, 'info, RemoveLiquidityInExpiredMarket<'info>>,
        shares_to_burn: u64,
        market_index: u16,
    ) -> Result<()> {
        handle_remove_perp_lp_shares_in_expiring_market(ctx, shares_to_burn, market_index)
    }

    pub fn update_user_name(
        ctx: Context<UpdateUser>,
        _sub_account_id: u16,
        name: [u8; 32],
    ) -> Result<()> {
        handle_update_user_name(ctx, _sub_account_id, name)
    }

    pub fn update_user_custom_margin_ratio(
        ctx: Context<UpdateUser>,
        _sub_account_id: u16,
        margin_ratio: u32,
    ) -> Result<()> {
        handle_update_user_custom_margin_ratio(ctx, _sub_account_id, margin_ratio)
    }

    pub fn update_user_margin_trading_enabled<'c: 'info, 'info>(
        ctx: Context<'_, '_, 'c, 'info, UpdateUser<'info>>,
        _sub_account_id: u16,
        margin_trading_enabled: bool,
    ) -> Result<()> {
        handle_update_user_margin_trading_enabled(ctx, _sub_account_id, margin_trading_enabled)
    }

    pub fn update_user_delegate(
        ctx: Context<UpdateUser>,
        _sub_account_id: u16,
        delegate: Pubkey,
    ) -> Result<()> {
        handle_update_user_delegate(ctx, _sub_account_id, delegate)
    }

    pub fn update_user_reduce_only(
        ctx: Context<UpdateUser>,
        _sub_account_id: u16,
        reduce_only: bool,
    ) -> Result<()> {
        handle_update_user_reduce_only(ctx, _sub_account_id, reduce_only)
    }

    pub fn update_user_advanced_lp(
        ctx: Context<UpdateUser>,
        _sub_account_id: u16,
        advanced_lp: bool,
    ) -> Result<()> {
        handle_update_user_advanced_lp(ctx, _sub_account_id, advanced_lp)
    }

    pub fn delete_user<'c: 'info, 'info>(
        ctx: Context<'_, '_, 'c, 'info, DeleteUser>,
    ) -> Result<()> {
        handle_delete_user(ctx)
    }

    pub fn reclaim_rent(ctx: Context<ReclaimRent>) -> Result<()> {
        handle_reclaim_rent(ctx)
    }

    // Keeper Instructions

    pub fn fill_perp_order<'c: 'info, 'info>(
        ctx: Context<'_, '_, 'c, 'info, FillOrder<'info>>,
        order_id: Option<u32>,
        _maker_order_id: Option<u32>,
    ) -> Result<()> {
        handle_fill_perp_order(ctx, order_id)
    }

    pub fn revert_fill(ctx: Context<RevertFill>) -> Result<()> {
        handle_revert_fill(ctx)
    }

    pub fn fill_spot_order<'c: 'info, 'info>(
        ctx: Context<'_, '_, 'c, 'info, FillOrder<'info>>,
        order_id: Option<u32>,
        fulfillment_type: Option<SpotFulfillmentType>,
        maker_order_id: Option<u32>,
    ) -> Result<()> {
        handle_fill_spot_order(ctx, order_id, fulfillment_type, maker_order_id)
    }

    pub fn trigger_order<'c: 'info, 'info>(
        ctx: Context<'_, '_, 'c, 'info, TriggerOrder<'info>>,
        order_id: u32,
    ) -> Result<()> {
        handle_trigger_order(ctx, order_id)
    }

    pub fn force_cancel_orders<'c: 'info, 'info>(
        ctx: Context<'_, '_, 'c, 'info, ForceCancelOrder<'info>>,
    ) -> Result<()> {
        handle_force_cancel_orders(ctx)
    }

    pub fn update_user_idle<'c: 'info, 'info>(
        ctx: Context<'_, '_, 'c, 'info, UpdateUserIdle<'info>>,
    ) -> Result<()> {
        handle_update_user_idle(ctx)
    }

    pub fn update_user_open_orders_count(ctx: Context<UpdateUserIdle>) -> Result<()> {
        handle_update_user_open_orders_count(ctx)
    }

    pub fn admin_disable_update_perp_bid_ask_twap(
        ctx: Context<AdminDisableBidAskTwapUpdate>,
        disable: bool,
    ) -> Result<()> {
        handle_admin_disable_update_perp_bid_ask_twap(ctx, disable)
    }

    pub fn settle_pnl<'c: 'info, 'info>(
        ctx: Context<'_, '_, 'c, 'info, SettlePNL>,
        market_index: u16,
    ) -> Result<()> {
        handle_settle_pnl(ctx, market_index)
    }

    pub fn settle_multiple_pnls<'c: 'info, 'info>(
        ctx: Context<'_, '_, 'c, 'info, SettlePNL>,
        market_indexes: Vec<u16>,
        mode: SettlePnlMode,
    ) -> Result<()> {
        handle_settle_multiple_pnls(ctx, market_indexes, mode)
    }

    pub fn settle_funding_payment<'c: 'info, 'info>(
        ctx: Context<'_, '_, 'c, 'info, SettleFunding>,
    ) -> Result<()> {
        handle_settle_funding_payment(ctx)
    }

    pub fn settle_lp<'c: 'info, 'info>(
        ctx: Context<'_, '_, 'c, 'info, SettleLP>,
        market_index: u16,
    ) -> Result<()> {
        handle_settle_lp(ctx, market_index)
    }

    pub fn settle_expired_market<'c: 'info, 'info>(
        ctx: Context<'_, '_, 'c, 'info, AdminUpdatePerpMarket<'info>>,
        market_index: u16,
    ) -> Result<()> {
        handle_settle_expired_market(ctx, market_index)
    }

    pub fn liquidate_perp<'c: 'info, 'info>(
        ctx: Context<'_, '_, 'c, 'info, LiquidatePerp<'info>>,
        market_index: u16,
        liquidator_max_base_asset_amount: u64,
        limit_price: Option<u64>,
    ) -> Result<()> {
        handle_liquidate_perp(
            ctx,
            market_index,
            liquidator_max_base_asset_amount,
            limit_price,
        )
    }

    pub fn liquidate_perp_with_fill<'c: 'info, 'info>(
        ctx: Context<'_, '_, 'c, 'info, LiquidatePerp<'info>>,
        market_index: u16,
    ) -> Result<()> {
        handle_liquidate_perp_with_fill(ctx, market_index)
    }

    pub fn liquidate_spot<'c: 'info, 'info>(
        ctx: Context<'_, '_, 'c, 'info, LiquidateSpot<'info>>,
        asset_market_index: u16,
        liability_market_index: u16,
        liquidator_max_liability_transfer: u128,
        limit_price: Option<u64>, // asset/liaiblity
    ) -> Result<()> {
        handle_liquidate_spot(
            ctx,
            asset_market_index,
            liability_market_index,
            liquidator_max_liability_transfer,
            limit_price,
        )
    }

    pub fn liquidate_borrow_for_perp_pnl<'c: 'info, 'info>(
        ctx: Context<'_, '_, 'c, 'info, LiquidateBorrowForPerpPnl<'info>>,
        perp_market_index: u16,
        spot_market_index: u16,
        liquidator_max_liability_transfer: u128,
        limit_price: Option<u64>,
    ) -> Result<()> {
        handle_liquidate_borrow_for_perp_pnl(
            ctx,
            perp_market_index,
            spot_market_index,
            liquidator_max_liability_transfer,
            limit_price,
        )
    }

    pub fn liquidate_perp_pnl_for_deposit<'c: 'info, 'info>(
        ctx: Context<'_, '_, 'c, 'info, LiquidatePerpPnlForDeposit<'info>>,
        perp_market_index: u16,
        spot_market_index: u16,
        liquidator_max_pnl_transfer: u128,
        limit_price: Option<u64>,
    ) -> Result<()> {
        handle_liquidate_perp_pnl_for_deposit(
            ctx,
            perp_market_index,
            spot_market_index,
            liquidator_max_pnl_transfer,
            limit_price,
        )
    }

    pub fn set_user_status_to_being_liquidated<'c: 'info, 'info>(
        ctx: Context<'_, '_, 'c, 'info, SetUserStatusToBeingLiquidated<'info>>,
    ) -> Result<()> {
        handle_set_user_status_to_being_liquidated(ctx)
    }

    pub fn resolve_perp_pnl_deficit<'c: 'info, 'info>(
        ctx: Context<'_, '_, 'c, 'info, ResolvePerpPnlDeficit<'info>>,
        spot_market_index: u16,
        perp_market_index: u16,
    ) -> Result<()> {
        handle_resolve_perp_pnl_deficit(ctx, spot_market_index, perp_market_index)
    }

    pub fn resolve_perp_bankruptcy<'c: 'info, 'info>(
        ctx: Context<'_, '_, 'c, 'info, ResolveBankruptcy<'info>>,
        quote_spot_market_index: u16,
        market_index: u16,
    ) -> Result<()> {
        handle_resolve_perp_bankruptcy(ctx, quote_spot_market_index, market_index)
    }

    pub fn resolve_spot_bankruptcy<'c: 'info, 'info>(
        ctx: Context<'_, '_, 'c, 'info, ResolveBankruptcy<'info>>,
        market_index: u16,
    ) -> Result<()> {
        handle_resolve_spot_bankruptcy(ctx, market_index)
    }

    pub fn settle_revenue_to_insurance_fund<'c: 'info, 'info>(
        ctx: Context<'_, '_, 'c, 'info, SettleRevenueToInsuranceFund<'info>>,
        spot_market_index: u16,
    ) -> Result<()> {
        handle_settle_revenue_to_insurance_fund(ctx, spot_market_index)
    }

    pub fn update_funding_rate(ctx: Context<UpdateFundingRate>, market_index: u16) -> Result<()> {
        handle_update_funding_rate(ctx, market_index)
    }

    pub fn update_prelaunch_oracle(ctx: Context<UpdatePrelaunchOracle>) -> Result<()> {
        handle_update_prelaunch_oracle(ctx)
    }

    pub fn update_perp_bid_ask_twap<'c: 'info, 'info>(
        ctx: Context<'_, '_, 'c, 'info, UpdatePerpBidAskTwap<'info>>,
    ) -> Result<()> {
        handle_update_perp_bid_ask_twap(ctx)
    }

    pub fn update_spot_market_cumulative_interest(
        ctx: Context<UpdateSpotMarketCumulativeInterest>,
    ) -> Result<()> {
        handle_update_spot_market_cumulative_interest(ctx)
    }

    pub fn update_amms<'c: 'info, 'info>(
        ctx: Context<'_, '_, 'c, 'info, UpdateAMM<'info>>,
        market_indexes: [u16; 5],
    ) -> Result<()> {
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

    pub fn update_user_gov_token_insurance_stake(
        ctx: Context<UpdateUserGovTokenInsuranceStake>,
    ) -> Result<()> {
        handle_update_user_gov_token_insurance_stake(ctx)
    }

    // IF stakers

    pub fn initialize_insurance_fund_stake(
        ctx: Context<InitializeInsuranceFundStake>,
        market_index: u16,
    ) -> Result<()> {
        handle_initialize_insurance_fund_stake(ctx, market_index)
    }

    pub fn add_insurance_fund_stake<'c: 'info, 'info>(
        ctx: Context<'_, '_, 'c, 'info, AddInsuranceFundStake<'info>>,
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

    pub fn remove_insurance_fund_stake<'c: 'info, 'info>(
        ctx: Context<'_, '_, 'c, 'info, RemoveInsuranceFundStake<'info>>,
        market_index: u16,
    ) -> Result<()> {
        handle_remove_insurance_fund_stake(ctx, market_index)
    }

    pub fn transfer_protocol_if_shares(
        ctx: Context<TransferProtocolIfShares>,
        market_index: u16,
        shares: u128,
    ) -> Result<()> {
        handle_transfer_protocol_if_shares(ctx, market_index, shares)
    }

    pub fn update_pyth_pull_oracle(
        ctx: Context<UpdatePythPullOraclePriceFeed>,
        feed_id: [u8; 32],
        params: Vec<u8>,
    ) -> Result<()> {
        handle_update_pyth_pull_oracle(ctx, feed_id, params)
    }

    pub fn post_pyth_pull_oracle_update_atomic(
        ctx: Context<PostPythPullOracleUpdateAtomic>,
        feed_id: [u8; 32],
        params: Vec<u8>,
    ) -> Result<()> {
        handle_post_pyth_pull_oracle_update_atomic(ctx, feed_id, params)
    }

    pub fn post_multi_pyth_pull_oracle_updates_atomic<'c: 'info, 'info>(
        ctx: Context<'_, '_, 'c, 'info, PostPythPullMultiOracleUpdatesAtomic<'info>>,
        params: Vec<u8>,
    ) -> Result<()> {
        handle_post_multi_pyth_pull_oracle_updates_atomic(ctx, params)
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
        initial_asset_weight: u32,
        maintenance_asset_weight: u32,
        initial_liability_weight: u32,
        maintenance_liability_weight: u32,
        imf_factor: u32,
        liquidator_fee: u32,
        if_liquidation_fee: u32,
        active_status: bool,
        asset_tier: AssetTier,
        scale_initial_asset_weight_start: u64,
        withdraw_guard_threshold: u64,
        order_tick_size: u64,
        order_step_size: u64,
        if_total_factor: u32,
        name: [u8; 32],
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
            liquidator_fee,
            if_liquidation_fee,
            active_status,
            asset_tier,
            scale_initial_asset_weight_start,
            withdraw_guard_threshold,
            order_tick_size,
            order_step_size,
            if_total_factor,
            name,
        )
    }

    pub fn delete_initialized_spot_market(
        ctx: Context<DeleteInitializedSpotMarket>,
        market_index: u16,
    ) -> Result<()> {
        handle_delete_initialized_spot_market(ctx, market_index)
    }

    pub fn initialize_serum_fulfillment_config(
        ctx: Context<InitializeSerumFulfillmentConfig>,
        market_index: u16,
    ) -> Result<()> {
        handle_initialize_serum_fulfillment_config(ctx, market_index)
    }

    pub fn update_serum_fulfillment_config_status(
        ctx: Context<UpdateSerumFulfillmentConfig>,
        status: SpotFulfillmentConfigStatus,
    ) -> Result<()> {
        handle_update_serum_fulfillment_config_status(ctx, status)
    }

    pub fn initialize_openbook_v2_fulfillment_config(
        ctx: Context<InitializeOpenbookV2FulfillmentConfig>,
        market_index: u16,
    ) -> Result<()> {
        handle_initialize_openbook_v2_fulfillment_config(ctx, market_index)
    }

    pub fn openbook_v2_fulfillment_config_status(
        ctx: Context<UpdateOpenbookV2FulfillmentConfig>,
        status: SpotFulfillmentConfigStatus,
    ) -> Result<()> {
        handle_update_openbook_v2_fulfillment_config_status(ctx, status)
    }
    pub fn initialize_phoenix_fulfillment_config(
        ctx: Context<InitializePhoenixFulfillmentConfig>,
        market_index: u16,
    ) -> Result<()> {
        handle_initialize_phoenix_fulfillment_config(ctx, market_index)
    }

    pub fn phoenix_fulfillment_config_status(
        ctx: Context<UpdatePhoenixFulfillmentConfig>,
        status: SpotFulfillmentConfigStatus,
    ) -> Result<()> {
        handle_update_phoenix_fulfillment_config_status(ctx, status)
    }

    pub fn update_serum_vault(ctx: Context<UpdateSerumVault>) -> Result<()> {
        handle_update_serum_vault(ctx)
    }

    pub fn initialize_perp_market<'c: 'info, 'info>(
        ctx: Context<'_, '_, 'c, 'info, InitializePerpMarket<'info>>,
        market_index: u16,
        amm_base_asset_reserve: u128,
        amm_quote_asset_reserve: u128,
        amm_periodicity: i64,
        amm_peg_multiplier: u128,
        oracle_source: OracleSource,
        contract_tier: ContractTier,
        margin_ratio_initial: u32,
        margin_ratio_maintenance: u32,
        liquidator_fee: u32,
        if_liquidation_fee: u32,
        imf_factor: u32,
        active_status: bool,
        base_spread: u32,
        max_spread: u32,
        max_open_interest: u128,
        max_revenue_withdraw_per_period: u64,
        quote_max_insurance: u64,
        order_step_size: u64,
        order_tick_size: u64,
        min_order_size: u64,
        concentration_coef_scale: u128,
        curve_update_intensity: u8,
        amm_jit_intensity: u8,
        name: [u8; 32],
    ) -> Result<()> {
        handle_initialize_perp_market(
            ctx,
            market_index,
            amm_base_asset_reserve,
            amm_quote_asset_reserve,
            amm_periodicity,
            amm_peg_multiplier,
            oracle_source,
            contract_tier,
            margin_ratio_initial,
            margin_ratio_maintenance,
            liquidator_fee,
            if_liquidation_fee,
            imf_factor,
            active_status,
            base_spread,
            max_spread,
            max_open_interest,
            max_revenue_withdraw_per_period,
            quote_max_insurance,
            order_step_size,
            order_tick_size,
            min_order_size,
            concentration_coef_scale,
            curve_update_intensity,
            amm_jit_intensity,
            name,
        )
    }

    pub fn initialize_prediction_market<'c: 'info, 'info>(
        ctx: Context<'_, '_, 'c, 'info, AdminUpdatePerpMarket<'info>>,
    ) -> Result<()> {
        handle_initialize_prediction_market(ctx)
    }

    pub fn delete_initialized_perp_market(
        ctx: Context<DeleteInitializedPerpMarket>,
        market_index: u16,
    ) -> Result<()> {
        handle_delete_initialized_perp_market(ctx, market_index)
    }

    pub fn move_amm_price(
        ctx: Context<AdminUpdatePerpMarket>,
        base_asset_reserve: u128,
        quote_asset_reserve: u128,
        sqrt_k: u128,
    ) -> Result<()> {
        handle_move_amm_price(ctx, base_asset_reserve, quote_asset_reserve, sqrt_k)
    }

    pub fn recenter_perp_market_amm(
        ctx: Context<AdminUpdatePerpMarket>,
        peg_multiplier: u128,
        sqrt_k: u128,
    ) -> Result<()> {
        handle_recenter_perp_market_amm(ctx, peg_multiplier, sqrt_k)
    }

    pub fn update_perp_market_amm_summary_stats(
        ctx: Context<AdminUpdatePerpMarketAmmSummaryStats>,
        params: UpdatePerpMarketSummaryStatsParams,
    ) -> Result<()> {
        handle_update_perp_market_amm_summary_stats(ctx, params)
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

    pub fn deposit_into_perp_market_fee_pool<'c: 'info, 'info>(
        ctx: Context<'_, '_, 'c, 'info, DepositIntoMarketFeePool<'info>>,
        amount: u64,
    ) -> Result<()> {
        handle_deposit_into_perp_market_fee_pool(ctx, amount)
    }

    pub fn deposit_into_spot_market_vault<'c: 'info, 'info>(
        ctx: Context<'_, '_, 'c, 'info, DepositIntoSpotMarketVault<'info>>,
        amount: u64,
    ) -> Result<()> {
        handle_deposit_into_spot_market_vault(ctx, amount)
    }

    pub fn deposit_into_spot_market_revenue_pool<'c: 'info, 'info>(
        ctx: Context<'_, '_, 'c, 'info, RevenuePoolDeposit<'info>>,
        amount: u64,
    ) -> Result<()> {
        handle_deposit_into_spot_market_revenue_pool(ctx, amount)
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

    pub fn update_perp_market_funding_period(
        ctx: Context<AdminUpdatePerpMarket>,
        funding_period: i64,
    ) -> Result<()> {
        handle_update_perp_market_funding_period(ctx, funding_period)
    }

    pub fn update_perp_market_max_imbalances(
        ctx: Context<AdminUpdatePerpMarket>,
        unrealized_max_imbalance: u64,
        max_revenue_withdraw_per_period: u64,
        quote_max_insurance: u64,
    ) -> Result<()> {
        handle_update_perp_market_max_imbalances(
            ctx,
            unrealized_max_imbalance,
            max_revenue_withdraw_per_period,
            quote_max_insurance,
        )
    }

    pub fn update_perp_market_liquidation_fee(
        ctx: Context<AdminUpdatePerpMarket>,
        liquidator_fee: u32,
        if_liquidation_fee: u32,
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
        liquidator_fee: u32,
        if_liquidation_fee: u32,
    ) -> Result<()> {
        handle_update_spot_market_liquidation_fee(ctx, liquidator_fee, if_liquidation_fee)
    }

    pub fn update_withdraw_guard_threshold(
        ctx: Context<AdminUpdateSpotMarket>,
        withdraw_guard_threshold: u64,
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

    pub fn update_spot_market_paused_operations(
        ctx: Context<AdminUpdateSpotMarket>,
        paused_operations: u8,
    ) -> Result<()> {
        handle_update_spot_market_paused_operations(ctx, paused_operations)
    }

    pub fn update_spot_market_asset_tier(
        ctx: Context<AdminUpdateSpotMarket>,
        asset_tier: AssetTier,
    ) -> Result<()> {
        handle_update_spot_market_asset_tier(ctx, asset_tier)
    }

    pub fn update_spot_market_margin_weights(
        ctx: Context<AdminUpdateSpotMarket>,
        initial_asset_weight: u32,
        maintenance_asset_weight: u32,
        initial_liability_weight: u32,
        maintenance_liability_weight: u32,
        imf_factor: u32,
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

    pub fn update_spot_market_borrow_rate(
        ctx: Context<AdminUpdateSpotMarket>,
        optimal_utilization: u32,
        optimal_borrow_rate: u32,
        max_borrow_rate: u32,
        min_borrow_rate: Option<u8>,
    ) -> Result<()> {
        handle_update_spot_market_borrow_rate(
            ctx,
            optimal_utilization,
            optimal_borrow_rate,
            max_borrow_rate,
            min_borrow_rate,
        )
    }

    pub fn update_spot_market_max_token_deposits(
        ctx: Context<AdminUpdateSpotMarket>,
        max_token_deposits: u64,
    ) -> Result<()> {
        handle_update_spot_market_max_token_deposits(ctx, max_token_deposits)
    }

    pub fn update_spot_market_max_token_borrows(
        ctx: Context<AdminUpdateSpotMarket>,
        max_token_borrows_fraction: u16,
    ) -> Result<()> {
        handle_update_spot_market_max_token_borrows(ctx, max_token_borrows_fraction)
    }

    pub fn update_spot_market_scale_initial_asset_weight_start(
        ctx: Context<AdminUpdateSpotMarket>,
        scale_initial_asset_weight_start: u64,
    ) -> Result<()> {
        handle_update_spot_market_scale_initial_asset_weight_start(
            ctx,
            scale_initial_asset_weight_start,
        )
    }

    pub fn update_spot_market_oracle(
        ctx: Context<AdminUpdateSpotMarketOracle>,
        oracle: Pubkey,
        oracle_source: OracleSource,
    ) -> Result<()> {
        handle_update_spot_market_oracle(ctx, oracle, oracle_source)
    }

    pub fn update_spot_market_step_size_and_tick_size(
        ctx: Context<AdminUpdateSpotMarket>,
        step_size: u64,
        tick_size: u64,
    ) -> Result<()> {
        handle_update_spot_market_step_size_and_tick_size(ctx, step_size, tick_size)
    }

    pub fn update_spot_market_min_order_size(
        ctx: Context<AdminUpdateSpotMarket>,
        order_size: u64,
    ) -> Result<()> {
        handle_update_spot_market_min_order_size(ctx, order_size)
    }

    pub fn update_spot_market_orders_enabled(
        ctx: Context<AdminUpdateSpotMarket>,
        orders_enabled: bool,
    ) -> Result<()> {
        handle_update_spot_market_orders_enabled(ctx, orders_enabled)
    }

    pub fn update_spot_market_if_paused_operations(
        ctx: Context<AdminUpdateSpotMarket>,
        paused_operations: u8,
    ) -> Result<()> {
        handle_update_spot_market_if_paused_operations(ctx, paused_operations)
    }

    pub fn update_spot_market_name(
        ctx: Context<AdminUpdateSpotMarket>,
        name: [u8; 32],
    ) -> Result<()> {
        handle_update_spot_market_name(ctx, name)
    }

    pub fn update_perp_market_status(
        ctx: Context<AdminUpdatePerpMarket>,
        status: MarketStatus,
    ) -> Result<()> {
        handle_update_perp_market_status(ctx, status)
    }

    pub fn update_perp_market_paused_operations(
        ctx: Context<AdminUpdatePerpMarket>,
        paused_operations: u8,
    ) -> Result<()> {
        handle_update_perp_market_paused_operations(ctx, paused_operations)
    }

    pub fn update_perp_market_contract_tier(
        ctx: Context<AdminUpdatePerpMarket>,
        contract_tier: ContractTier,
    ) -> Result<()> {
        handle_update_perp_market_contract_tier(ctx, contract_tier)
    }

    pub fn update_perp_market_imf_factor(
        ctx: Context<AdminUpdatePerpMarket>,
        imf_factor: u32,
        unrealized_pnl_imf_factor: u32,
    ) -> Result<()> {
        handle_update_perp_market_imf_factor(ctx, imf_factor, unrealized_pnl_imf_factor)
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

    pub fn update_perp_market_target_base_asset_amount_per_lp(
        ctx: Context<AdminUpdatePerpMarket>,
        target_base_asset_amount_per_lp: i32,
    ) -> Result<()> {
        handle_update_perp_market_target_base_asset_amount_per_lp(
            ctx,
            target_base_asset_amount_per_lp,
        )
    }

    pub fn update_perp_market_per_lp_base(
        ctx: Context<AdminUpdatePerpMarket>,
        per_lp_base: i8,
    ) -> Result<()> {
        handle_update_perp_market_per_lp_base(ctx, per_lp_base)
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

    pub fn update_initial_pct_to_liquidate(
        ctx: Context<AdminUpdateState>,
        initial_pct_to_liquidate: u16,
    ) -> Result<()> {
        handle_update_initial_pct_to_liquidate(ctx, initial_pct_to_liquidate)
    }

    pub fn update_liquidation_duration(
        ctx: Context<AdminUpdateState>,
        liquidation_duration: u8,
    ) -> Result<()> {
        handle_update_liquidation_duration(ctx, liquidation_duration)
    }

    pub fn update_liquidation_margin_buffer_ratio(
        ctx: Context<AdminUpdateState>,
        liquidation_margin_buffer_ratio: u32,
    ) -> Result<()> {
        handle_update_liquidation_margin_buffer_ratio(ctx, liquidation_margin_buffer_ratio)
    }

    pub fn update_oracle_guard_rails(
        ctx: Context<AdminUpdateState>,
        oracle_guard_rails: OracleGuardRails,
    ) -> Result<()> {
        handle_update_oracle_guard_rails(ctx, oracle_guard_rails)
    }

    pub fn update_state_settlement_duration(
        ctx: Context<AdminUpdateState>,
        settlement_duration: u16,
    ) -> Result<()> {
        handle_update_state_settlement_duration(ctx, settlement_duration)
    }

    pub fn update_state_max_number_of_sub_accounts(
        ctx: Context<AdminUpdateState>,
        max_number_of_sub_accounts: u16,
    ) -> Result<()> {
        handle_update_state_max_number_of_sub_accounts(ctx, max_number_of_sub_accounts)
    }

    pub fn update_state_max_initialize_user_fee(
        ctx: Context<AdminUpdateState>,
        max_initialize_user_fee: u16,
    ) -> Result<()> {
        handle_update_state_max_initialize_user_fee(ctx, max_initialize_user_fee)
    }

    pub fn update_perp_market_oracle(
        ctx: Context<RepegCurve>,
        oracle: Pubkey,
        oracle_source: OracleSource,
    ) -> Result<()> {
        handle_update_perp_market_oracle(ctx, oracle, oracle_source)
    }

    pub fn update_perp_market_base_spread(
        ctx: Context<AdminUpdatePerpMarket>,
        base_spread: u32,
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

    pub fn update_perp_market_max_open_interest(
        ctx: Context<AdminUpdatePerpMarket>,
        max_open_interest: u128,
    ) -> Result<()> {
        handle_update_perp_market_max_open_interest(ctx, max_open_interest)
    }

    pub fn update_perp_market_number_of_users(
        ctx: Context<AdminUpdatePerpMarket>,
        number_of_users: Option<u32>,
        number_of_users_with_base: Option<u32>,
    ) -> Result<()> {
        handle_update_perp_market_number_of_users(ctx, number_of_users, number_of_users_with_base)
    }

    pub fn update_perp_market_fee_adjustment(
        ctx: Context<AdminUpdatePerpMarket>,
        fee_adjustment: i16,
    ) -> Result<()> {
        handle_update_perp_market_fee_adjustment(ctx, fee_adjustment)
    }

    pub fn update_spot_market_fee_adjustment(
        ctx: Context<AdminUpdateSpotMarket>,
        fee_adjustment: i16,
    ) -> Result<()> {
        handle_update_spot_market_fee_adjustment(ctx, fee_adjustment)
    }

    pub fn update_perp_market_fuel(
        ctx: Context<AdminUpdatePerpMarket>,
        fuel_boost_taker: Option<u8>,
        fuel_boost_maker: Option<u8>,
        fuel_boost_position: Option<u8>,
    ) -> Result<()> {
        handle_update_perp_market_fuel(ctx, fuel_boost_taker, fuel_boost_maker, fuel_boost_position)
    }

    pub fn update_spot_market_fuel(
        ctx: Context<AdminUpdateSpotMarket>,
        fuel_boost_deposits: Option<u8>,
        fuel_boost_borrows: Option<u8>,
        fuel_boost_taker: Option<u8>,
        fuel_boost_maker: Option<u8>,
        fuel_boost_insurance: Option<u8>,
    ) -> Result<()> {
        handle_update_spot_market_fuel(
            ctx,
            fuel_boost_deposits,
            fuel_boost_borrows,
            fuel_boost_taker,
            fuel_boost_maker,
            fuel_boost_insurance,
        )
    }

    pub fn init_user_fuel(
        ctx: Context<InitUserFuel>,
        fuel_boost_deposits: Option<u32>,
        fuel_boost_borrows: Option<u32>,
        fuel_boost_taker: Option<u32>,
        fuel_boost_maker: Option<u32>,
        fuel_boost_insurance: Option<u32>,
    ) -> Result<()> {
        handle_init_user_fuel(
            ctx,
            fuel_boost_deposits,
            fuel_boost_borrows,
            fuel_boost_taker,
            fuel_boost_maker,
            fuel_boost_insurance,
        )
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
        exchange_status: u8,
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

    pub fn initialize_protocol_if_shares_transfer_config(
        ctx: Context<InitializeProtocolIfSharesTransferConfig>,
    ) -> Result<()> {
        handle_initialize_protocol_if_shares_transfer_config(ctx)
    }

    pub fn update_protocol_if_shares_transfer_config(
        ctx: Context<UpdateProtocolIfSharesTransferConfig>,
        whitelisted_signers: Option<[Pubkey; 4]>,
        max_transfer_per_epoch: Option<u128>,
    ) -> Result<()> {
        handle_update_protocol_if_shares_transfer_config(
            ctx,
            whitelisted_signers,
            max_transfer_per_epoch,
        )
    }

    pub fn initialize_prelaunch_oracle(
        ctx: Context<InitializePrelaunchOracle>,
        params: PrelaunchOracleParams,
    ) -> Result<()> {
        handle_initialize_prelaunch_oracle(ctx, params)
    }

    pub fn update_prelaunch_oracle_params(
        ctx: Context<UpdatePrelaunchOracleParams>,
        params: PrelaunchOracleParams,
    ) -> Result<()> {
        handle_update_prelaunch_oracle_params(ctx, params)
    }

    pub fn delete_prelaunch_oracle(
        ctx: Context<DeletePrelaunchOracle>,
        perp_market_index: u16,
    ) -> Result<()> {
        handle_delete_prelaunch_oracle(ctx, perp_market_index)
    }

    pub fn initialize_pyth_pull_oracle(
        ctx: Context<InitPythPullPriceFeed>,
        feed_id: [u8; 32],
    ) -> Result<()> {
        handle_initialize_pyth_pull_oracle(ctx, feed_id)
    }
}

#[cfg(not(feature = "no-entrypoint"))]
use solana_security_txt::security_txt;
#[cfg(not(feature = "no-entrypoint"))]
security_txt! {
    name: "Drift v2",
    project_url: "https://drift.trade",
    contacts: "link:https://docs.drift.trade/security/bug-bounty",
    policy: "https://github.com/drift-labs/protocol-v2/blob/main/SECURITY.md",
    preferred_languages: "en",
    source_code: "https://github.com/drift-labs/protocol-v2"
}
