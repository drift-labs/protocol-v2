
use anchor_lang::prelude::*;
use anchor_lang::Discriminator;
use anchor_spl::token::{Token, TokenAccount};
use solana_program::program::invoke;
use solana_program::system_instruction::transfer;

use crate::controller::orders::{cancel_orders, ModifyOrderId};
use crate::controller::position::PositionDirection;
use crate::controller::spot_balance::update_revenue_pool_balances;
use crate::controller::spot_position::{
    charge_withdraw_fee, update_spot_balances_and_cumulative_deposits,
    update_spot_balances_and_cumulative_deposits_with_limits,
};
use crate::error::ErrorCode;
use crate::ids::{
    jupiter_mainnet_3, jupiter_mainnet_4, jupiter_mainnet_6, marinade_mainnet, serum_program,
};
use crate::instructions::constraints::*;
use crate::instructions::optional_accounts::{
    get_maker_and_maker_stats, get_referrer_and_referrer_stats, get_whitelist_token, load_maps,
    AccountMaps,
};
use crate::instructions::SpotFulfillmentType;
use crate::load_mut;
use crate::math::casting::Cast;
use crate::math::liquidation::is_user_being_liquidated;
use crate::math::margin::{
    calculate_max_withdrawable_amount, meets_initial_margin_requirement,
    meets_withdraw_margin_requirement, validate_spot_margin_trading, MarginRequirementType,
};
use crate::math::safe_math::SafeMath;
use crate::math::spot_balance::get_token_value;
use crate::math::spot_swap;
use crate::math::spot_swap::{calculate_swap_price, validate_price_bands_for_swap};
use crate::math_error;
use crate::print_error;
use crate::safe_decrement;
use crate::safe_increment;
use crate::state::events::{
    SwapSpotPoolRecord,
};
use crate::state::fill_mode::FillMode;
use crate::state::fulfillment_params::drift::MatchFulfillmentParams;
use crate::state::fulfillment_params::phoenix::PhoenixFulfillmentParams;
use crate::state::fulfillment_params::serum::SerumFulfillmentParams;
use crate::state::oracle::StrictOraclePrice;
use crate::state::order_params::{
    ModifyOrderParams, OrderParams, PlaceOrderOptions, PostOnlyParam,
};
use crate::state::perp_market::MarketStatus;
use crate::state::perp_market_map::{get_writable_perp_market_set, MarketSet};
use crate::state::spot_fulfillment_params::SpotFulfillmentParams;
use crate::state::spot_market::SpotBalanceType;
use crate::state::spot_market::SpotMarket;
use crate::state::spot_market_map::{
    get_writable_spot_market_set, get_writable_spot_market_set_from_many,
};
use crate::state::state::State;
use crate::state::traits::Size;
use crate::state::user::{MarketType, OrderType, ReferrerName, User, UserStats};
use crate::state::user_map::load_user_maps;
use crate::validate;
use crate::validation::user::validate_user_deletion;
use crate::validation::whitelist::validate_whitelist_token;
use crate::{controller, math};
use crate::{get_then_update_id, QUOTE_SPOT_MARKET_INDEX};
use crate::{load, THIRTEEN_DAY};
use anchor_lang::solana_program::sysvar::instructions;
use anchor_spl::associated_token::AssociatedToken;
use borsh::{BorshDeserialize, BorshSerialize};


#[access_control(
    withdraw_not_paused(&ctx.accounts.state)
)]
pub fn handle_swap_pool(
    ctx: Context<Withdraw>,
    market_index: u16,
    amount: u64,
    reduce_only: bool,
) -> anchor_lang::Result<()> {

    // take two spot market accounts and swap their fee/revenue pool
    // limits for what can be imposed on both revenue/fee pool size
    // quote fee pool must stay above $250
    // non-quote market revenue pool must stay above 5% emission for IF stakers
    // fill price is oracle +/- confidence + fee

    let in_fee_pool = 
    let out_revenue_pool = 



    let spot_reserve_record = SwapSpotPoolRecord {
        ts: now,
        authority: user.authority,
    };
    emit!(spot_reserve_record);
}