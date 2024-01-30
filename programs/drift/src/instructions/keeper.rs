use anchor_lang::prelude::*;
use anchor_spl::token::{Token, TokenAccount};

use crate::error::ErrorCode;
use crate::instructions::constraints::*;
use crate::instructions::optional_accounts::{
    get_maker_and_maker_stats, get_referrer_and_referrer_stats, load_maps, AccountMaps,
};
use crate::math::constants::QUOTE_SPOT_MARKET_INDEX;
use crate::math::insurance::if_shares_to_vault_amount;
use crate::math::margin::calculate_user_equity;
use crate::math::orders::{estimate_price_from_side, find_bids_and_asks_from_users};
use crate::math::spot_withdraw::validate_spot_market_vault_amount;
use crate::state::fill_mode::FillMode;
use crate::state::fulfillment_params::drift::MatchFulfillmentParams;
use crate::state::fulfillment_params::phoenix::PhoenixFulfillmentParams;
use crate::state::fulfillment_params::serum::SerumFulfillmentParams;
use crate::state::insurance_fund_stake::InsuranceFundStake;
use crate::state::oracle_map::OracleMap;
use crate::state::paused_operations::PerpOperation;
use crate::state::perp_market::{MarketStatus, PerpMarket};
use crate::state::perp_market_map::{
    get_market_set_for_user_positions, get_market_set_from_list, get_writable_perp_market_set,
    MarketSet, PerpMarketMap,
};
use crate::state::spot_fulfillment_params::SpotFulfillmentParams;
use crate::state::spot_market::SpotMarket;
use crate::state::spot_market_map::{
    get_writable_spot_market_set, get_writable_spot_market_set_from_many,
};
use crate::state::state::State;
use crate::state::user::{MarketType, OrderStatus, User, UserStats};
use crate::state::user_map::load_user_maps;
use crate::validation::user::validate_user_is_idle;
use crate::{controller, load, math};
use crate::{load_mut, QUOTE_PRECISION_U64};
use crate::{validate, QUOTE_PRECISION_I128};

#[access_control(
    fill_not_paused(&ctx.accounts.state)
)]
pub fn handle_fill_perp_order<'info>(ctx: Context<FillOrder>, order_id: Option<u32>) -> Result<()> {
    let (order_id, market_index) = {
        let user = &load!(ctx.accounts.user)?;
        // if there is no order id, use the users last order id
        let order_id = order_id.unwrap_or_else(|| user.get_last_order_id());
        let market_index = match user.get_order(order_id) {
            Some(order) => order.market_index,
            None => {
                msg!("Order does not exist {}", order_id);
                return Ok(());
            }
        };
        (order_id, market_index)
    };

    let user_key = &ctx.accounts.user.key();
    fill_order(ctx, order_id, market_index).map_err(|e| {
        msg!(
            "Err filling order id {} for user {} for market index {}",
            order_id,
            user_key,
            market_index
        );
        e
    })?;

    Ok(())
}

fn fill_order(ctx: Context<FillOrder>, order_id: u32, market_index: u16) -> Result<()> {
    let clock = &Clock::get()?;
    let state = &ctx.accounts.state;

    let remaining_accounts_iter = &mut ctx.remaining_accounts.iter().peekable();
    let AccountMaps {
        perp_market_map,
        spot_market_map,
        mut oracle_map,
    } = load_maps(
        remaining_accounts_iter,
        &get_writable_perp_market_set(market_index),
        &MarketSet::new(),
        clock.slot,
        Some(state.oracle_guard_rails),
    )?;

    let (makers_and_referrer, makers_and_referrer_stats) =
        load_user_maps(remaining_accounts_iter, true)?;

    controller::repeg::update_amm(
        market_index,
        &perp_market_map,
        &mut oracle_map,
        &ctx.accounts.state,
        clock,
    )?;

    controller::orders::fill_perp_order(
        order_id,
        &ctx.accounts.state,
        &ctx.accounts.user,
        &ctx.accounts.user_stats,
        &spot_market_map,
        &perp_market_map,
        &mut oracle_map,
        &ctx.accounts.filler,
        &ctx.accounts.filler_stats,
        &makers_and_referrer,
        &makers_and_referrer_stats,
        None,
        clock,
        FillMode::Fill,
    )?;

    Ok(())
}

#[access_control(
    fill_not_paused(&ctx.accounts.state)
)]
pub fn handle_revert_fill<'info>(ctx: Context<RevertFill>) -> Result<()> {
    let filler = load_mut!(ctx.accounts.filler)?;
    let clock = Clock::get()?;

    validate!(
        filler.last_active_slot == clock.slot,
        ErrorCode::RevertFill,
        "filler last active slot ({}) != current slot ({})",
        filler.last_active_slot,
        clock.slot
    )?;

    Ok(())
}

#[derive(Clone, Copy, AnchorSerialize, AnchorDeserialize, PartialEq, Debug, Eq)]
pub enum SpotFulfillmentType {
    SerumV3,
    Match,
    PhoenixV1,
}

impl Default for SpotFulfillmentType {
    fn default() -> Self {
        SpotFulfillmentType::SerumV3
    }
}

#[access_control(
    fill_not_paused(&ctx.accounts.state)
)]
pub fn handle_fill_spot_order<'a, 'b, 'c, 'info>(
    ctx: Context<'a, 'b, 'c, 'info, FillOrder<'info>>,
    order_id: Option<u32>,
    fulfillment_type: Option<SpotFulfillmentType>,
    maker_order_id: Option<u32>,
) -> Result<()> {
    let (order_id, market_index) = {
        let user = &load!(ctx.accounts.user)?;
        // if there is no order id, use the users last order id
        let order_id = order_id.unwrap_or_else(|| user.get_last_order_id());
        let market_index = user
            .get_order(order_id)
            .map(|order| order.market_index)
            .ok_or(ErrorCode::OrderDoesNotExist)?;

        (order_id, market_index)
    };

    let user_key = &ctx.accounts.user.key();
    fill_spot_order(
        ctx,
        order_id,
        market_index,
        fulfillment_type.unwrap_or(SpotFulfillmentType::Match),
        maker_order_id,
    )
    .map_err(|e| {
        msg!("Err filling order id {} for user {}", order_id, user_key);
        e
    })?;

    Ok(())
}

fn fill_spot_order<'info>(
    ctx: Context<'_, '_, '_, 'info, FillOrder<'info>>,
    order_id: u32,
    market_index: u16,
    fulfillment_type: SpotFulfillmentType,
    maker_order_id: Option<u32>,
) -> Result<()> {
    let clock = Clock::get()?;

    let remaining_accounts_iter = &mut ctx.remaining_accounts.iter().peekable();
    let AccountMaps {
        perp_market_map,
        spot_market_map,
        mut oracle_map,
    } = load_maps(
        remaining_accounts_iter,
        &MarketSet::new(),
        &get_writable_spot_market_set_from_many(vec![QUOTE_SPOT_MARKET_INDEX, market_index]),
        Clock::get()?.slot,
        None,
    )?;

    let (maker, maker_stats) = match maker_order_id {
        Some(_) => {
            let (user, user_stats) = get_maker_and_maker_stats(remaining_accounts_iter)?;
            (Some(user), Some(user_stats))
        }
        None => (None, None),
    };

    let (_referrer, _referrer_stats) = get_referrer_and_referrer_stats(remaining_accounts_iter)?;

    let mut fulfillment_params: Box<dyn SpotFulfillmentParams> = match fulfillment_type {
        SpotFulfillmentType::SerumV3 => {
            let base_market = spot_market_map.get_ref(&market_index)?;
            let quote_market = spot_market_map.get_quote_spot_market()?;
            Box::new(SerumFulfillmentParams::new(
                remaining_accounts_iter,
                &ctx.accounts.state,
                &base_market,
                &quote_market,
                clock.unix_timestamp,
            )?)
        }
        SpotFulfillmentType::PhoenixV1 => {
            let base_market = spot_market_map.get_ref(&market_index)?;
            let quote_market = spot_market_map.get_quote_spot_market()?;
            Box::new(PhoenixFulfillmentParams::new(
                remaining_accounts_iter,
                &ctx.accounts.state,
                &base_market,
                &quote_market,
            )?)
        }
        SpotFulfillmentType::Match => {
            let base_market = spot_market_map.get_ref(&market_index)?;
            let quote_market = spot_market_map.get_quote_spot_market()?;
            Box::new(MatchFulfillmentParams::new(
                remaining_accounts_iter,
                &base_market,
                &quote_market,
            )?)
        }
    };

    controller::orders::fill_spot_order(
        order_id,
        &ctx.accounts.state,
        &ctx.accounts.user,
        &ctx.accounts.user_stats,
        &spot_market_map,
        &perp_market_map,
        &mut oracle_map,
        &ctx.accounts.filler,
        &ctx.accounts.filler_stats,
        maker.as_ref(),
        maker_stats.as_ref(),
        maker_order_id,
        &clock,
        fulfillment_params.as_mut(),
    )?;

    let base_market = spot_market_map.get_ref(&market_index)?;
    let quote_market = spot_market_map.get_quote_spot_market()?;
    fulfillment_params.validate_vault_amounts(&base_market, &quote_market)?;

    Ok(())
}

#[access_control(
    exchange_not_paused(&ctx.accounts.state)
)]
pub fn handle_trigger_order<'info>(ctx: Context<TriggerOrder>, order_id: u32) -> Result<()> {
    let AccountMaps {
        perp_market_map,
        spot_market_map,
        mut oracle_map,
    } = load_maps(
        &mut ctx.remaining_accounts.iter().peekable(),
        &MarketSet::new(),
        &MarketSet::new(),
        Clock::get()?.slot,
        None,
    )?;

    let market_type = match load!(ctx.accounts.user)?.get_order(order_id) {
        Some(order) => order.market_type,
        None => {
            msg!("order_id not found {}", order_id);
            return Ok(());
        }
    };

    match market_type {
        MarketType::Perp => controller::orders::trigger_order(
            order_id,
            &ctx.accounts.state,
            &ctx.accounts.user,
            &spot_market_map,
            &perp_market_map,
            &mut oracle_map,
            &ctx.accounts.filler,
            &Clock::get()?,
        )?,
        MarketType::Spot => controller::orders::trigger_spot_order(
            order_id,
            &ctx.accounts.state,
            &ctx.accounts.user,
            &spot_market_map,
            &perp_market_map,
            &mut oracle_map,
            &ctx.accounts.filler,
            &Clock::get()?,
        )?,
    }

    Ok(())
}

#[access_control(
    exchange_not_paused(&ctx.accounts.state)
)]
pub fn handle_force_cancel_orders<'info>(ctx: Context<ForceCancelOrder>) -> Result<()> {
    let AccountMaps {
        perp_market_map,
        spot_market_map,
        mut oracle_map,
    } = load_maps(
        &mut ctx.remaining_accounts.iter().peekable(),
        &MarketSet::new(),
        &MarketSet::new(),
        Clock::get()?.slot,
        None,
    )?;

    controller::orders::force_cancel_orders(
        &ctx.accounts.state,
        &ctx.accounts.user,
        &spot_market_map,
        &perp_market_map,
        &mut oracle_map,
        &ctx.accounts.filler,
        &Clock::get()?,
    )?;

    Ok(())
}

#[access_control(
    exchange_not_paused(&ctx.accounts.state)
)]
pub fn handle_update_user_idle<'info>(ctx: Context<UpdateUserIdle>) -> Result<()> {
    let mut user = load_mut!(ctx.accounts.user)?;
    let clock = Clock::get()?;

    let AccountMaps {
        perp_market_map,
        spot_market_map,
        mut oracle_map,
    } = load_maps(
        &mut ctx.remaining_accounts.iter().peekable(),
        &MarketSet::new(),
        &MarketSet::new(),
        Clock::get()?.slot,
        None,
    )?;

    let (equity, _) =
        calculate_user_equity(&user, &perp_market_map, &spot_market_map, &mut oracle_map)?;

    // user flipped to idle faster if equity is less than 1000
    let accelerated = equity < QUOTE_PRECISION_I128 * 1000;

    validate_user_is_idle(&user, clock.slot, accelerated)?;

    user.idle = true;

    Ok(())
}

#[access_control(
    exchange_not_paused(&ctx.accounts.state)
)]
pub fn handle_update_user_open_orders_count<'info>(ctx: Context<UpdateUserIdle>) -> Result<()> {
    let mut user = load_mut!(ctx.accounts.user)?;

    let mut open_orders = 0_u8;
    let mut open_auctions = 0_u8;

    for order in user.orders.iter() {
        if order.status == OrderStatus::Open {
            open_orders += 1;
        }

        if order.has_auction() {
            open_auctions += 1;
        }
    }

    user.open_orders = open_orders;
    user.has_open_order = open_orders > 0;
    user.open_auctions = open_auctions;
    user.has_open_auction = open_auctions > 0;

    Ok(())
}

#[access_control(
    settle_pnl_not_paused(&ctx.accounts.state)
)]
pub fn handle_settle_pnl(ctx: Context<SettlePNL>, market_index: u16) -> Result<()> {
    let clock = Clock::get()?;
    let state = &ctx.accounts.state;

    let user_key = ctx.accounts.user.key();
    let user = &mut load_mut!(ctx.accounts.user)?;

    let AccountMaps {
        perp_market_map,
        spot_market_map,
        mut oracle_map,
    } = load_maps(
        &mut ctx.remaining_accounts.iter().peekable(),
        &get_writable_perp_market_set(market_index),
        &get_writable_spot_market_set(QUOTE_SPOT_MARKET_INDEX),
        clock.slot,
        Some(state.oracle_guard_rails),
    )?;

    let market_in_settlement =
        perp_market_map.get_ref(&market_index)?.status == MarketStatus::Settlement;

    if market_in_settlement {
        amm_not_paused(state)?;

        controller::pnl::settle_expired_position(
            market_index,
            user,
            &user_key,
            &perp_market_map,
            &spot_market_map,
            &mut oracle_map,
            &clock,
            state,
        )?;

        user.update_last_active_slot(clock.slot);
    } else {
        controller::repeg::update_amm(
            market_index,
            &perp_market_map,
            &mut oracle_map,
            state,
            &clock,
        )
        .map(|_| ErrorCode::InvalidOracleForSettlePnl)?;

        controller::pnl::settle_pnl(
            market_index,
            user,
            ctx.accounts.authority.key,
            &user_key,
            &perp_market_map,
            &spot_market_map,
            &mut oracle_map,
            &clock,
            state,
        )
        .map(|_| ErrorCode::InvalidOracleForSettlePnl)?;

        user.update_last_active_slot(clock.slot);
    }

    let spot_market = spot_market_map.get_quote_spot_market()?;
    validate_spot_market_vault_amount(&spot_market, ctx.accounts.spot_market_vault.amount)?;

    Ok(())
}

#[access_control(
    funding_not_paused(&ctx.accounts.state)
)]
pub fn handle_settle_funding_payment(ctx: Context<SettleFunding>) -> Result<()> {
    let clock = Clock::get()?;
    let now = clock.unix_timestamp;

    let user_key = ctx.accounts.user.key();
    let user = &mut load_mut!(ctx.accounts.user)?;

    let AccountMaps {
        perp_market_map, ..
    } = load_maps(
        &mut ctx.remaining_accounts.iter().peekable(),
        &get_market_set_for_user_positions(&user.perp_positions),
        &MarketSet::new(),
        clock.slot,
        None,
    )?;

    controller::funding::settle_funding_payments(user, &user_key, &perp_market_map, now)?;
    user.update_last_active_slot(clock.slot);
    Ok(())
}

#[access_control(
    amm_not_paused(&ctx.accounts.state)
)]
pub fn handle_settle_lp<'info>(ctx: Context<SettleLP>, market_index: u16) -> Result<()> {
    let user_key = ctx.accounts.user.key();
    let user = &mut load_mut!(ctx.accounts.user)?;

    let state = &ctx.accounts.state;
    let clock = Clock::get()?;
    let now = clock.unix_timestamp;

    let AccountMaps {
        perp_market_map, ..
    } = load_maps(
        &mut ctx.remaining_accounts.iter().peekable(),
        &get_writable_perp_market_set(market_index),
        &MarketSet::new(),
        clock.slot,
        Some(state.oracle_guard_rails),
    )?;

    let market = &mut perp_market_map.get_ref_mut(&market_index)?;
    controller::lp::settle_funding_payment_then_lp(user, &user_key, market, now)?;
    user.update_last_active_slot(clock.slot);

    Ok(())
}

#[access_control(
    settle_pnl_not_paused(&ctx.accounts.state)
)]
pub fn handle_settle_expired_market(ctx: Context<UpdateAMM>, market_index: u16) -> Result<()> {
    let clock = Clock::get()?;
    let _now = clock.unix_timestamp;
    let state = &ctx.accounts.state;

    let AccountMaps {
        perp_market_map,
        spot_market_map,
        mut oracle_map,
    } = load_maps(
        &mut ctx.remaining_accounts.iter().peekable(),
        &get_writable_perp_market_set(market_index),
        &get_writable_spot_market_set(QUOTE_SPOT_MARKET_INDEX),
        clock.slot,
        Some(state.oracle_guard_rails),
    )?;

    controller::repeg::update_amm(
        market_index,
        &perp_market_map,
        &mut oracle_map,
        state,
        &clock,
    )?;

    controller::repeg::settle_expired_market(
        market_index,
        &perp_market_map,
        &mut oracle_map,
        &spot_market_map,
        state,
        &clock,
    )?;

    Ok(())
}

#[access_control(
    liq_not_paused(&ctx.accounts.state)
)]
pub fn handle_liquidate_perp(
    ctx: Context<LiquidatePerp>,
    market_index: u16,
    liquidator_max_base_asset_amount: u64,
    limit_price: Option<u64>,
) -> Result<()> {
    let clock = Clock::get()?;
    let now = clock.unix_timestamp;
    let slot = clock.slot;
    let state = &ctx.accounts.state;

    let user_key = ctx.accounts.user.key();
    let liquidator_key = ctx.accounts.liquidator.key();

    validate!(
        user_key != liquidator_key,
        ErrorCode::UserCantLiquidateThemself
    )?;

    let user = &mut load_mut!(ctx.accounts.user)?;
    let user_stats = &mut load_mut!(ctx.accounts.user_stats)?;
    let liquidator = &mut load_mut!(ctx.accounts.liquidator)?;
    let liquidator_stats = &mut load_mut!(ctx.accounts.liquidator_stats)?;

    let AccountMaps {
        perp_market_map,
        spot_market_map,
        mut oracle_map,
    } = load_maps(
        &mut ctx.remaining_accounts.iter().peekable(),
        &get_writable_perp_market_set(market_index),
        &MarketSet::new(),
        clock.slot,
        Some(state.oracle_guard_rails),
    )?;

    controller::liquidation::liquidate_perp(
        market_index,
        liquidator_max_base_asset_amount,
        limit_price,
        user,
        &user_key,
        user_stats,
        liquidator,
        &liquidator_key,
        liquidator_stats,
        &perp_market_map,
        &spot_market_map,
        &mut oracle_map,
        slot,
        now,
        state,
    )?;

    Ok(())
}

#[access_control(
    liq_not_paused(&ctx.accounts.state)
)]
pub fn handle_liquidate_spot(
    ctx: Context<LiquidateSpot>,
    asset_market_index: u16,
    liability_market_index: u16,
    liquidator_max_liability_transfer: u128,
    limit_price: Option<u64>,
) -> Result<()> {
    let clock = Clock::get()?;
    let now = clock.unix_timestamp;
    let state = &ctx.accounts.state;

    let user_key = ctx.accounts.user.key();
    let liquidator_key = ctx.accounts.liquidator.key();

    validate!(
        user_key != liquidator_key,
        ErrorCode::UserCantLiquidateThemself
    )?;

    let user = &mut load_mut!(ctx.accounts.user)?;
    let liquidator = &mut load_mut!(ctx.accounts.liquidator)?;

    let AccountMaps {
        perp_market_map,
        spot_market_map,
        mut oracle_map,
    } = load_maps(
        &mut ctx.remaining_accounts.iter().peekable(),
        &MarketSet::new(),
        &get_writable_spot_market_set_from_many(vec![asset_market_index, liability_market_index]),
        clock.slot,
        Some(state.oracle_guard_rails),
    )?;

    controller::liquidation::liquidate_spot(
        asset_market_index,
        liability_market_index,
        liquidator_max_liability_transfer,
        limit_price,
        user,
        &user_key,
        liquidator,
        &liquidator_key,
        &perp_market_map,
        &spot_market_map,
        &mut oracle_map,
        now,
        clock.slot,
        state,
    )?;

    Ok(())
}

#[access_control(
    liq_not_paused(&ctx.accounts.state)
)]
pub fn handle_liquidate_borrow_for_perp_pnl(
    ctx: Context<LiquidateBorrowForPerpPnl>,
    perp_market_index: u16,
    spot_market_index: u16,
    liquidator_max_liability_transfer: u128,
    limit_price: Option<u64>, // currently unimplemented
) -> Result<()> {
    let clock = Clock::get()?;
    let now = clock.unix_timestamp;
    let state = &ctx.accounts.state;

    let user_key = ctx.accounts.user.key();
    let liquidator_key = ctx.accounts.liquidator.key();

    validate!(
        user_key != liquidator_key,
        ErrorCode::UserCantLiquidateThemself
    )?;

    let user = &mut load_mut!(ctx.accounts.user)?;
    let liquidator = &mut load_mut!(ctx.accounts.liquidator)?;

    let AccountMaps {
        perp_market_map,
        spot_market_map,
        mut oracle_map,
    } = load_maps(
        &mut ctx.remaining_accounts.iter().peekable(),
        &MarketSet::new(),
        &get_writable_spot_market_set(spot_market_index),
        clock.slot,
        Some(state.oracle_guard_rails),
    )?;

    controller::liquidation::liquidate_borrow_for_perp_pnl(
        perp_market_index,
        spot_market_index,
        liquidator_max_liability_transfer,
        limit_price,
        user,
        &user_key,
        liquidator,
        &liquidator_key,
        &perp_market_map,
        &spot_market_map,
        &mut oracle_map,
        now,
        clock.slot,
        state.liquidation_margin_buffer_ratio,
        state.initial_pct_to_liquidate as u128,
        state.liquidation_duration as u128,
    )?;

    Ok(())
}

#[access_control(
    liq_not_paused(&ctx.accounts.state)
)]
pub fn handle_liquidate_perp_pnl_for_deposit(
    ctx: Context<LiquidatePerpPnlForDeposit>,
    perp_market_index: u16,
    spot_market_index: u16,
    liquidator_max_pnl_transfer: u128,
    limit_price: Option<u64>, // currently unimplemented
) -> Result<()> {
    let state = &ctx.accounts.state;
    let clock = Clock::get()?;
    let now = clock.unix_timestamp;

    let user_key = ctx.accounts.user.key();
    let liquidator_key = ctx.accounts.liquidator.key();

    validate!(
        user_key != liquidator_key,
        ErrorCode::UserCantLiquidateThemself
    )?;

    let user = &mut load_mut!(ctx.accounts.user)?;
    let liquidator = &mut load_mut!(ctx.accounts.liquidator)?;

    let AccountMaps {
        perp_market_map,
        spot_market_map,
        mut oracle_map,
    } = load_maps(
        &mut ctx.remaining_accounts.iter().peekable(),
        &MarketSet::new(),
        &get_writable_spot_market_set(spot_market_index),
        clock.slot,
        Some(state.oracle_guard_rails),
    )?;

    controller::liquidation::liquidate_perp_pnl_for_deposit(
        perp_market_index,
        spot_market_index,
        liquidator_max_pnl_transfer,
        limit_price,
        user,
        &user_key,
        liquidator,
        &liquidator_key,
        &perp_market_map,
        &spot_market_map,
        &mut oracle_map,
        now,
        clock.slot,
        state.liquidation_margin_buffer_ratio,
        state.initial_pct_to_liquidate as u128,
        state.liquidation_duration as u128,
    )?;

    Ok(())
}

#[access_control(
    withdraw_not_paused(&ctx.accounts.state)
)]
pub fn handle_resolve_perp_pnl_deficit(
    ctx: Context<ResolvePerpPnlDeficit>,
    spot_market_index: u16,
    perp_market_index: u16,
) -> Result<()> {
    let clock = Clock::get()?;
    let now = clock.unix_timestamp;

    validate!(spot_market_index == 0, ErrorCode::InvalidSpotMarketAccount)?;
    let state = &ctx.accounts.state;

    let AccountMaps {
        perp_market_map,
        spot_market_map,
        mut oracle_map,
    } = load_maps(
        &mut ctx.remaining_accounts.iter().peekable(),
        &get_writable_perp_market_set(perp_market_index),
        &get_writable_spot_market_set(spot_market_index),
        clock.slot,
        Some(state.oracle_guard_rails),
    )?;

    controller::repeg::update_amm(
        perp_market_index,
        &perp_market_map,
        &mut oracle_map,
        state,
        &clock,
    )?;

    {
        let spot_market = &mut spot_market_map.get_ref_mut(&spot_market_index)?;
        controller::insurance::attempt_settle_revenue_to_insurance_fund(
            &ctx.accounts.spot_market_vault,
            &ctx.accounts.insurance_fund_vault,
            spot_market,
            now,
            &ctx.accounts.token_program,
            &ctx.accounts.drift_signer,
            state,
        )?;

        // reload the spot market vault balance so it's up-to-date
        ctx.accounts.spot_market_vault.reload()?;
        ctx.accounts.insurance_fund_vault.reload()?;
        math::spot_withdraw::validate_spot_market_vault_amount(
            spot_market,
            ctx.accounts.spot_market_vault.amount,
        )?;
    }

    let insurance_vault_amount = ctx.accounts.insurance_fund_vault.amount;
    let spot_market_vault_amount = ctx.accounts.spot_market_vault.amount;

    let pay_from_insurance = {
        let spot_market = &mut spot_market_map.get_ref_mut(&spot_market_index)?;
        let perp_market = &mut perp_market_map.get_ref_mut(&perp_market_index)?;

        if perp_market.amm.curve_update_intensity > 0 {
            validate!(
                perp_market.amm.last_oracle_valid,
                ErrorCode::InvalidOracle,
                "Oracle Price detected as invalid"
            )?;

            validate!(
                oracle_map.slot == perp_market.amm.last_update_slot,
                ErrorCode::AMMNotUpdatedInSameSlot,
                "AMM must be updated in a prior instruction within same slot"
            )?;
        }

        validate!(
            !perp_market.is_in_settlement(now),
            ErrorCode::MarketActionPaused,
            "Market is in settlement mode",
        )?;

        controller::orders::validate_market_within_price_band(perp_market, state, true, None)?;

        controller::insurance::resolve_perp_pnl_deficit(
            spot_market_vault_amount,
            insurance_vault_amount,
            spot_market,
            perp_market,
            clock.unix_timestamp,
        )?
    };

    if pay_from_insurance > 0 {
        validate!(
            pay_from_insurance < ctx.accounts.insurance_fund_vault.amount,
            ErrorCode::InsufficientCollateral,
            "Insurance Fund balance InsufficientCollateral for payment: !{} < {}",
            pay_from_insurance,
            ctx.accounts.insurance_fund_vault.amount
        )?;

        controller::token::send_from_program_vault(
            &ctx.accounts.token_program,
            &ctx.accounts.insurance_fund_vault,
            &ctx.accounts.spot_market_vault,
            &ctx.accounts.drift_signer,
            state.signer_nonce,
            pay_from_insurance,
        )?;

        validate!(
            ctx.accounts.insurance_fund_vault.amount > 0,
            ErrorCode::InvalidIFDetected,
            "insurance_fund_vault.amount must remain > 0"
        )?;
    }

    // todo: validate amounts transfered and spot_market before and after are zero-sum

    Ok(())
}

#[access_control(
    withdraw_not_paused(&ctx.accounts.state)
)]
pub fn handle_resolve_perp_bankruptcy(
    ctx: Context<ResolveBankruptcy>,
    quote_spot_market_index: u16,
    market_index: u16,
) -> Result<()> {
    let clock = Clock::get()?;
    let now = clock.unix_timestamp;

    let user_key = ctx.accounts.user.key();
    let liquidator_key = ctx.accounts.liquidator.key();

    validate!(
        user_key != liquidator_key,
        ErrorCode::UserCantLiquidateThemself
    )?;

    validate!(
        quote_spot_market_index == 0,
        ErrorCode::InvalidSpotMarketAccount
    )?;

    let user = &mut load_mut!(ctx.accounts.user)?;
    let liquidator = &mut load_mut!(ctx.accounts.liquidator)?;
    let state = &ctx.accounts.state;

    let AccountMaps {
        perp_market_map,
        spot_market_map,
        mut oracle_map,
    } = load_maps(
        &mut ctx.remaining_accounts.iter().peekable(),
        &get_writable_perp_market_set(market_index),
        &get_writable_spot_market_set(quote_spot_market_index),
        clock.slot,
        Some(state.oracle_guard_rails),
    )?;

    {
        let spot_market = &mut spot_market_map.get_ref_mut(&quote_spot_market_index)?;
        controller::insurance::attempt_settle_revenue_to_insurance_fund(
            &ctx.accounts.spot_market_vault,
            &ctx.accounts.insurance_fund_vault,
            spot_market,
            now,
            &ctx.accounts.token_program,
            &ctx.accounts.drift_signer,
            state,
        )?;

        // reload the spot market vault balance so it's up-to-date
        ctx.accounts.spot_market_vault.reload()?;
        ctx.accounts.insurance_fund_vault.reload()?;
        math::spot_withdraw::validate_spot_market_vault_amount(
            spot_market,
            ctx.accounts.spot_market_vault.amount,
        )?;
    }

    let pay_from_insurance = controller::liquidation::resolve_perp_bankruptcy(
        market_index,
        user,
        &user_key,
        liquidator,
        &liquidator_key,
        &perp_market_map,
        &spot_market_map,
        &mut oracle_map,
        now,
        ctx.accounts.insurance_fund_vault.amount,
    )?;

    if pay_from_insurance > 0 {
        validate!(
            pay_from_insurance < ctx.accounts.insurance_fund_vault.amount,
            ErrorCode::InsufficientCollateral,
            "Insurance Fund balance InsufficientCollateral for payment: !{} < {}",
            pay_from_insurance,
            ctx.accounts.insurance_fund_vault.amount
        )?;

        controller::token::send_from_program_vault(
            &ctx.accounts.token_program,
            &ctx.accounts.insurance_fund_vault,
            &ctx.accounts.spot_market_vault,
            &ctx.accounts.drift_signer,
            state.signer_nonce,
            pay_from_insurance,
        )?;

        validate!(
            ctx.accounts.insurance_fund_vault.amount > 0,
            ErrorCode::InvalidIFDetected,
            "insurance_fund_vault.amount must remain > 0"
        )?;
    }

    {
        let spot_market = &mut spot_market_map.get_ref_mut(&quote_spot_market_index)?;
        // reload the spot market vault balance so it's up-to-date
        ctx.accounts.spot_market_vault.reload()?;
        math::spot_withdraw::validate_spot_market_vault_amount(
            spot_market,
            ctx.accounts.spot_market_vault.amount,
        )?;
    }

    Ok(())
}

#[access_control(
    withdraw_not_paused(&ctx.accounts.state)
)]
pub fn handle_resolve_spot_bankruptcy(
    ctx: Context<ResolveBankruptcy>,
    market_index: u16,
) -> Result<()> {
    let state = &ctx.accounts.state;
    let clock = Clock::get()?;
    let now = clock.unix_timestamp;

    let user_key = ctx.accounts.user.key();
    let liquidator_key = ctx.accounts.liquidator.key();

    validate!(
        user_key != liquidator_key,
        ErrorCode::UserCantLiquidateThemself
    )?;

    let user = &mut load_mut!(ctx.accounts.user)?;
    let liquidator = &mut load_mut!(ctx.accounts.liquidator)?;

    let AccountMaps {
        perp_market_map,
        spot_market_map,
        mut oracle_map,
    } = load_maps(
        &mut ctx.remaining_accounts.iter().peekable(),
        &MarketSet::new(),
        &get_writable_spot_market_set(market_index),
        clock.slot,
        Some(state.oracle_guard_rails),
    )?;

    {
        let spot_market = &mut spot_market_map.get_ref_mut(&market_index)?;
        controller::insurance::attempt_settle_revenue_to_insurance_fund(
            &ctx.accounts.spot_market_vault,
            &ctx.accounts.insurance_fund_vault,
            spot_market,
            now,
            &ctx.accounts.token_program,
            &ctx.accounts.drift_signer,
            state,
        )?;

        // reload the spot market vault balance so it's up-to-date
        ctx.accounts.spot_market_vault.reload()?;
        ctx.accounts.insurance_fund_vault.reload()?;
        math::spot_withdraw::validate_spot_market_vault_amount(
            spot_market,
            ctx.accounts.spot_market_vault.amount,
        )?;
    }

    let pay_from_insurance = controller::liquidation::resolve_spot_bankruptcy(
        market_index,
        user,
        &user_key,
        liquidator,
        &liquidator_key,
        &perp_market_map,
        &spot_market_map,
        &mut oracle_map,
        now,
        ctx.accounts.insurance_fund_vault.amount,
    )?;

    if pay_from_insurance > 0 {
        controller::token::send_from_program_vault(
            &ctx.accounts.token_program,
            &ctx.accounts.insurance_fund_vault,
            &ctx.accounts.spot_market_vault,
            &ctx.accounts.drift_signer,
            ctx.accounts.state.signer_nonce,
            pay_from_insurance,
        )?;

        validate!(
            ctx.accounts.insurance_fund_vault.amount > 0,
            ErrorCode::InvalidIFDetected,
            "insurance_fund_vault.amount must remain > 0"
        )?;
    }

    {
        let spot_market = &mut spot_market_map.get_ref_mut(&market_index)?;
        // reload the spot market vault balance so it's up-to-date
        ctx.accounts.spot_market_vault.reload()?;
        math::spot_withdraw::validate_spot_market_vault_amount(
            spot_market,
            ctx.accounts.spot_market_vault.amount,
        )?;
    }

    Ok(())
}

#[access_control(
    perp_market_valid(&ctx.accounts.perp_market)
    funding_not_paused(&ctx.accounts.state)
    valid_oracle_for_perp_market(&ctx.accounts.oracle, &ctx.accounts.perp_market)
)]
pub fn handle_update_funding_rate(
    ctx: Context<UpdateFundingRate>,
    perp_market_index: u16,
) -> Result<()> {
    let perp_market = &mut load_mut!(ctx.accounts.perp_market)?;
    let clock = Clock::get()?;
    let now = clock.unix_timestamp;
    let clock_slot = clock.slot;
    let state = &ctx.accounts.state;
    let mut oracle_map = OracleMap::load_one(
        &ctx.accounts.oracle,
        clock_slot,
        Some(state.oracle_guard_rails),
    )?;

    let oracle_price_data = &oracle_map.get_price_data(&perp_market.amm.oracle)?;
    controller::repeg::_update_amm(perp_market, oracle_price_data, state, now, clock_slot)?;

    validate!(
        matches!(
            perp_market.status,
            MarketStatus::Active | MarketStatus::ReduceOnly
        ),
        ErrorCode::MarketActionPaused,
        "Market funding is paused",
    )?;

    validate!(
        ((clock_slot == perp_market.amm.last_update_slot && perp_market.amm.last_oracle_valid)
            || perp_market.amm.curve_update_intensity == 0),
        ErrorCode::AMMNotUpdatedInSameSlot,
        "AMM must be updated in a prior instruction within same slot"
    )?;

    let funding_paused =
        state.funding_paused()? || perp_market.is_operation_paused(PerpOperation::UpdateFunding);

    let is_updated = controller::funding::update_funding_rate(
        perp_market_index,
        perp_market,
        &mut oracle_map,
        now,
        clock_slot,
        &state.oracle_guard_rails,
        funding_paused,
        None,
    )?;

    if !is_updated {
        let time_until_next_update = crate::math::helpers::on_the_hour_update(
            now,
            perp_market.amm.last_funding_rate_ts,
            perp_market.amm.funding_period,
        )?;
        msg!(
            "time_until_next_update = {:?} seconds",
            time_until_next_update
        );
        return Err(ErrorCode::FundingWasNotUpdated.into());
    }

    Ok(())
}

#[access_control(
    perp_market_valid(&ctx.accounts.perp_market)
    funding_not_paused(&ctx.accounts.state)
    valid_oracle_for_perp_market(&ctx.accounts.oracle, &ctx.accounts.perp_market)
)]
pub fn handle_update_perp_bid_ask_twap(ctx: Context<UpdatePerpBidAskTwap>) -> Result<()> {
    let perp_market = &mut load_mut!(ctx.accounts.perp_market)?;
    let clock = Clock::get()?;
    let now = clock.unix_timestamp;
    let slot = clock.slot;
    let state = &ctx.accounts.state;
    let mut oracle_map =
        OracleMap::load_one(&ctx.accounts.oracle, slot, Some(state.oracle_guard_rails))?;

    let keeper_stats = load!(ctx.accounts.keeper_stats)?;
    validate!(
        !keeper_stats.disable_update_perp_bid_ask_twap,
        ErrorCode::CantUpdatePerpBidAskTwap,
        "Keeper stats disable_update_perp_bid_ask_twap is true"
    )?;

    let min_if_stake = 1000 * QUOTE_PRECISION_U64;
    validate!(
        keeper_stats.if_staked_quote_asset_amount >= min_if_stake,
        ErrorCode::CantUpdatePerpBidAskTwap,
        "Keeper doesnt have min if stake. stake = {} min if stake = {}",
        keeper_stats.if_staked_quote_asset_amount,
        min_if_stake
    )?;

    let oracle_price_data = oracle_map.get_price_data(&perp_market.amm.oracle)?;
    controller::repeg::_update_amm(perp_market, oracle_price_data, state, now, slot)?;

    let remaining_accounts_iter = &mut ctx.remaining_accounts.iter().peekable();
    let (makers, _) = load_user_maps(remaining_accounts_iter, false)?;

    let depth = perp_market.get_market_depth_for_funding_rate()?;

    let (bids, asks) =
        find_bids_and_asks_from_users(perp_market, oracle_price_data, &makers, slot, now)?;
    let estimated_bid = estimate_price_from_side(&bids, depth)?;
    let estimated_ask = estimate_price_from_side(&asks, depth)?;

    msg!(
        "estimated_bid = {:?} estimated_ask = {:?}",
        estimated_bid,
        estimated_ask
    );

    msg!(
        "before amm ask twap = {} bid twap = {} ts = {}",
        perp_market.amm.last_bid_price_twap,
        perp_market.amm.last_ask_price_twap,
        perp_market.amm.last_mark_price_twap_ts
    );

    let sanitize_clamp_denominator = perp_market.get_sanitize_clamp_denominator()?;
    math::amm::update_mark_twap_crank(
        &mut perp_market.amm,
        now,
        oracle_price_data,
        estimated_bid,
        estimated_ask,
        sanitize_clamp_denominator,
    )?;

    msg!(
        "after amm ask twap = {} bid twap = {} ts = {}",
        perp_market.amm.last_bid_price_twap,
        perp_market.amm.last_ask_price_twap,
        perp_market.amm.last_mark_price_twap_ts
    );

    Ok(())
}

#[access_control(
    withdraw_not_paused(&ctx.accounts.state)
)]
pub fn handle_settle_revenue_to_insurance_fund(
    ctx: Context<SettleRevenueToInsuranceFund>,
    spot_market_index: u16,
) -> Result<()> {
    let state = &ctx.accounts.state;
    let spot_market = &mut load_mut!(ctx.accounts.spot_market)?;

    validate!(
        spot_market_index == spot_market.market_index,
        ErrorCode::InvalidSpotMarketAccount,
        "invalid spot_market passed"
    )?;

    validate!(
        spot_market.insurance_fund.revenue_settle_period > 0,
        ErrorCode::RevenueSettingsCannotSettleToIF,
        "invalid revenue_settle_period settings on spot market"
    )?;

    let spot_vault_amount = ctx.accounts.spot_market_vault.amount;
    let insurance_vault_amount = ctx.accounts.insurance_fund_vault.amount;

    let clock = Clock::get()?;
    let now = clock.unix_timestamp;

    let time_until_next_update = math::helpers::on_the_hour_update(
        now,
        spot_market.insurance_fund.last_revenue_settle_ts,
        spot_market.insurance_fund.revenue_settle_period,
    )?;

    validate!(
        time_until_next_update == 0,
        ErrorCode::RevenueSettingsCannotSettleToIF,
        "Must wait {} seconds until next available settlement time",
        time_until_next_update
    )?;

    // uses proportion of revenue pool allocated to insurance fund
    let token_amount = controller::insurance::settle_revenue_to_insurance_fund(
        spot_vault_amount,
        insurance_vault_amount,
        spot_market,
        now,
    )?;

    spot_market.insurance_fund.last_revenue_settle_ts = now;

    controller::token::send_from_program_vault(
        &ctx.accounts.token_program,
        &ctx.accounts.spot_market_vault,
        &ctx.accounts.insurance_fund_vault,
        &ctx.accounts.drift_signer,
        state.signer_nonce,
        token_amount,
    )?;

    // reload the spot market vault balance so it's up-to-date
    ctx.accounts.spot_market_vault.reload()?;
    math::spot_withdraw::validate_spot_market_vault_amount(
        spot_market,
        ctx.accounts.spot_market_vault.amount,
    )?;

    Ok(())
}

#[access_control(
    spot_market_valid(&ctx.accounts.spot_market)
    exchange_not_paused(&ctx.accounts.state)
    valid_oracle_for_spot_market(&ctx.accounts.oracle, &ctx.accounts.spot_market)
)]
pub fn handle_update_spot_market_cumulative_interest(
    ctx: Context<UpdateSpotMarketCumulativeInterest>,
) -> Result<()> {
    let spot_market = &mut load_mut!(ctx.accounts.spot_market)?;
    let state = &ctx.accounts.state;
    let clock = Clock::get()?;
    let now = clock.unix_timestamp;
    let clock_slot = clock.slot;

    let mut oracle_map = OracleMap::load_one(
        &ctx.accounts.oracle,
        clock_slot,
        Some(state.oracle_guard_rails),
    )?;

    let oracle_price_data = oracle_map.get_price_data(&spot_market.oracle)?;

    if !state.funding_paused()? {
        controller::spot_balance::update_spot_market_cumulative_interest(
            spot_market,
            Some(oracle_price_data),
            now,
        )?;
    } else {
        // even if funding is paused still update twap stats
        controller::spot_balance::update_spot_market_twap_stats(
            spot_market,
            Some(oracle_price_data),
            now,
        )?;
    }

    math::spot_withdraw::validate_spot_market_vault_amount(
        spot_market,
        ctx.accounts.spot_market_vault.amount,
    )?;

    Ok(())
}

#[access_control(
    exchange_not_paused(&ctx.accounts.state)
)]
pub fn handle_update_amms(ctx: Context<UpdateAMM>, market_indexes: [u16; 5]) -> Result<()> {
    // up to ~60k compute units (per amm) worst case

    let clock = Clock::get()?;

    let state = &ctx.accounts.state;

    let remaining_accounts_iter = &mut ctx.remaining_accounts.iter().peekable();
    let oracle_map = &mut OracleMap::load(remaining_accounts_iter, clock.slot, None)?;
    let market_map = &mut PerpMarketMap::load(
        &get_market_set_from_list(market_indexes),
        remaining_accounts_iter,
    )?;

    controller::repeg::update_amms(market_map, oracle_map, state, &clock)?;

    Ok(())
}

pub fn handle_update_user_quote_asset_insurance_stake(
    ctx: Context<UpdateUserQuoteAssetInsuranceStake>,
) -> Result<()> {
    let insurance_fund_stake = &mut load_mut!(ctx.accounts.insurance_fund_stake)?;
    let user_stats = &mut load_mut!(ctx.accounts.user_stats)?;
    let quote_spot_market = &mut load_mut!(ctx.accounts.spot_market)?;

    validate!(
        insurance_fund_stake.market_index == 0,
        ErrorCode::IncorrectSpotMarketAccountPassed,
        "insurance_fund_stake is not for quote market"
    )?;

    user_stats.if_staked_quote_asset_amount = if_shares_to_vault_amount(
        insurance_fund_stake.checked_if_shares(quote_spot_market)?,
        quote_spot_market.insurance_fund.total_shares,
        ctx.accounts.insurance_fund_vault.amount,
    )?;

    Ok(())
}

#[derive(Accounts)]
pub struct FillOrder<'info> {
    pub state: Box<Account<'info, State>>,
    pub authority: Signer<'info>,
    #[account(
        mut,
        constraint = can_sign_for_user(&filler, &authority)?
    )]
    pub filler: AccountLoader<'info, User>,
    #[account(
        mut,
        constraint = is_stats_for_user(&filler, &filler_stats)?
    )]
    pub filler_stats: AccountLoader<'info, UserStats>,
    #[account(mut)]
    pub user: AccountLoader<'info, User>,
    #[account(
        mut,
        constraint = is_stats_for_user(&user, &user_stats)?
    )]
    pub user_stats: AccountLoader<'info, UserStats>,
}

#[derive(Accounts)]
pub struct RevertFill<'info> {
    pub state: Box<Account<'info, State>>,
    pub authority: Signer<'info>,
    #[account(
        mut,
        constraint = can_sign_for_user(&filler, &authority)?
    )]
    pub filler: AccountLoader<'info, User>,
    #[account(
        mut,
        constraint = is_stats_for_user(&filler, &filler_stats)?
    )]
    pub filler_stats: AccountLoader<'info, UserStats>,
}

#[derive(Accounts)]
pub struct TriggerOrder<'info> {
    pub state: Box<Account<'info, State>>,
    pub authority: Signer<'info>,
    #[account(
        mut,
        constraint = can_sign_for_user(&filler, &authority)?
    )]
    pub filler: AccountLoader<'info, User>,
    #[account(mut)]
    pub user: AccountLoader<'info, User>,
}

#[derive(Accounts)]
pub struct ForceCancelOrder<'info> {
    pub state: Box<Account<'info, State>>,
    pub authority: Signer<'info>,
    #[account(
        mut,
        constraint = can_sign_for_user(&filler, &authority)?
    )]
    pub filler: AccountLoader<'info, User>,
    #[account(mut)]
    pub user: AccountLoader<'info, User>,
}

#[derive(Accounts)]
pub struct UpdateUserIdle<'info> {
    pub state: Box<Account<'info, State>>,
    pub authority: Signer<'info>,
    #[account(
        mut,
        constraint = can_sign_for_user(&filler, &authority)?
    )]
    pub filler: AccountLoader<'info, User>,
    #[account(mut)]
    pub user: AccountLoader<'info, User>,
}

#[derive(Accounts)]
pub struct SettlePNL<'info> {
    pub state: Box<Account<'info, State>>,
    #[account(mut)]
    pub user: AccountLoader<'info, User>,
    pub authority: Signer<'info>,
    #[account(
        seeds = [b"spot_market_vault".as_ref(), 0_u16.to_le_bytes().as_ref()],
        bump
    )]
    pub spot_market_vault: Box<Account<'info, TokenAccount>>,
}

#[derive(Accounts)]
pub struct SettleFunding<'info> {
    pub state: Box<Account<'info, State>>,
    #[account(mut)]
    pub user: AccountLoader<'info, User>,
}

#[derive(Accounts)]
pub struct SettleLP<'info> {
    pub state: Box<Account<'info, State>>,
    #[account(mut)]
    pub user: AccountLoader<'info, User>,
}

#[derive(Accounts)]
pub struct LiquidatePerp<'info> {
    pub state: Box<Account<'info, State>>,
    pub authority: Signer<'info>,
    #[account(
        mut,
        constraint = can_sign_for_user(&liquidator, &authority)?
    )]
    pub liquidator: AccountLoader<'info, User>,
    #[account(
        mut,
        constraint = is_stats_for_user(&liquidator, &liquidator_stats)?
    )]
    pub liquidator_stats: AccountLoader<'info, UserStats>,
    #[account(mut)]
    pub user: AccountLoader<'info, User>,
    #[account(
        mut,
        constraint = is_stats_for_user(&user, &user_stats)?
    )]
    pub user_stats: AccountLoader<'info, UserStats>,
}

#[derive(Accounts)]
pub struct LiquidateSpot<'info> {
    pub state: Box<Account<'info, State>>,
    pub authority: Signer<'info>,
    #[account(
        mut,
        constraint = can_sign_for_user(&liquidator, &authority)?
    )]
    pub liquidator: AccountLoader<'info, User>,
    #[account(
        mut,
        constraint = is_stats_for_user(&liquidator, &liquidator_stats)?
    )]
    pub liquidator_stats: AccountLoader<'info, UserStats>,
    #[account(mut)]
    pub user: AccountLoader<'info, User>,
    #[account(
        mut,
        constraint = is_stats_for_user(&user, &user_stats)?
    )]
    pub user_stats: AccountLoader<'info, UserStats>,
}

#[derive(Accounts)]
pub struct LiquidateBorrowForPerpPnl<'info> {
    pub state: Box<Account<'info, State>>,
    pub authority: Signer<'info>,
    #[account(
        mut,
        constraint = can_sign_for_user(&liquidator, &authority)?
    )]
    pub liquidator: AccountLoader<'info, User>,
    #[account(
        mut,
        constraint = is_stats_for_user(&liquidator, &liquidator_stats)?
    )]
    pub liquidator_stats: AccountLoader<'info, UserStats>,
    #[account(mut)]
    pub user: AccountLoader<'info, User>,
    #[account(
        mut,
        constraint = is_stats_for_user(&user, &user_stats)?
    )]
    pub user_stats: AccountLoader<'info, UserStats>,
}

#[derive(Accounts)]
pub struct LiquidatePerpPnlForDeposit<'info> {
    pub state: Box<Account<'info, State>>,
    pub authority: Signer<'info>,
    #[account(
        mut,
        constraint = can_sign_for_user(&liquidator, &authority)?
    )]
    pub liquidator: AccountLoader<'info, User>,
    #[account(
        mut,
        constraint = is_stats_for_user(&liquidator, &liquidator_stats)?
    )]
    pub liquidator_stats: AccountLoader<'info, UserStats>,
    #[account(mut)]
    pub user: AccountLoader<'info, User>,
    #[account(
        mut,
        constraint = is_stats_for_user(&user, &user_stats)?
    )]
    pub user_stats: AccountLoader<'info, UserStats>,
}

#[derive(Accounts)]
#[instruction(spot_market_index: u16,)]
pub struct ResolveBankruptcy<'info> {
    pub state: Box<Account<'info, State>>,
    pub authority: Signer<'info>,
    #[account(
        mut,
        constraint = can_sign_for_user(&liquidator, &authority)?
    )]
    pub liquidator: AccountLoader<'info, User>,
    #[account(
        mut,
        constraint = is_stats_for_user(&liquidator, &liquidator_stats)?
    )]
    pub liquidator_stats: AccountLoader<'info, UserStats>,
    #[account(mut)]
    pub user: AccountLoader<'info, User>,
    #[account(
        mut,
        constraint = is_stats_for_user(&user, &user_stats)?
    )]
    pub user_stats: AccountLoader<'info, UserStats>,
    #[account(
        mut,
        seeds = [b"spot_market_vault".as_ref(), spot_market_index.to_le_bytes().as_ref()],
        bump,
    )]
    pub spot_market_vault: Box<Account<'info, TokenAccount>>,
    #[account(
        mut,
        seeds = [b"insurance_fund_vault".as_ref(), spot_market_index.to_le_bytes().as_ref()], // todo: market_index=0 hardcode for perps?
        bump,
    )]
    pub insurance_fund_vault: Box<Account<'info, TokenAccount>>,
    #[account(
        constraint = state.signer.eq(&drift_signer.key())
    )]
    /// CHECK: forced drift_signer
    pub drift_signer: AccountInfo<'info>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
#[instruction(spot_market_index: u16,)]
pub struct ResolvePerpPnlDeficit<'info> {
    pub state: Box<Account<'info, State>>,
    pub authority: Signer<'info>,
    #[account(
        mut,
        seeds = [b"spot_market_vault".as_ref(), spot_market_index.to_le_bytes().as_ref()],
        bump,
    )]
    pub spot_market_vault: Box<Account<'info, TokenAccount>>,
    #[account(
        mut,
        seeds = [b"insurance_fund_vault".as_ref(), spot_market_index.to_le_bytes().as_ref()], // todo: market_index=0 hardcode for perps?
        bump,
    )]
    pub insurance_fund_vault: Box<Account<'info, TokenAccount>>,
    #[account(
        constraint = state.signer.eq(&drift_signer.key())
    )]
    /// CHECK: forced drift_signer
    pub drift_signer: AccountInfo<'info>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
#[instruction(market_index: u16,)]
pub struct SettleRevenueToInsuranceFund<'info> {
    pub state: Box<Account<'info, State>>,
    #[account(
        mut,
        seeds = [b"spot_market", market_index.to_le_bytes().as_ref()],
        bump
    )]
    pub spot_market: AccountLoader<'info, SpotMarket>,
    #[account(
        mut,
        seeds = [b"spot_market_vault".as_ref(), market_index.to_le_bytes().as_ref()],
        bump,
    )]
    pub spot_market_vault: Box<Account<'info, TokenAccount>>,
    #[account(
        constraint = state.signer.eq(&drift_signer.key())
    )]
    /// CHECK: forced drift_signer
    pub drift_signer: AccountInfo<'info>,
    #[account(
        mut,
        seeds = [b"insurance_fund_vault".as_ref(), market_index.to_le_bytes().as_ref()],
        bump,
    )]
    pub insurance_fund_vault: Box<Account<'info, TokenAccount>>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct UpdateSpotMarketCumulativeInterest<'info> {
    pub state: Box<Account<'info, State>>,
    #[account(mut)]
    pub spot_market: AccountLoader<'info, SpotMarket>,
    /// CHECK: checked in `update_spot_market_cumulative_interest` ix constraint
    pub oracle: AccountInfo<'info>,
    #[account(
        seeds = [b"spot_market_vault".as_ref(), spot_market.load()?.market_index.to_le_bytes().as_ref()],
        bump,
    )]
    pub spot_market_vault: Box<Account<'info, TokenAccount>>,
}

#[derive(Accounts)]
pub struct UpdateAMM<'info> {
    pub state: Box<Account<'info, State>>,
    pub authority: Signer<'info>,
}

#[derive(Accounts)]
pub struct UpdateFundingRate<'info> {
    pub state: Box<Account<'info, State>>,
    #[account(mut)]
    pub perp_market: AccountLoader<'info, PerpMarket>,
    /// CHECK: checked in `update_funding_rate` ix constraint
    pub oracle: AccountInfo<'info>,
}

#[derive(Accounts)]
pub struct UpdatePerpBidAskTwap<'info> {
    pub state: Box<Account<'info, State>>,
    #[account(mut)]
    pub perp_market: AccountLoader<'info, PerpMarket>,
    /// CHECK: checked in `update_funding_rate` ix constraint
    pub oracle: AccountInfo<'info>,
    pub keeper_stats: AccountLoader<'info, UserStats>,
    pub authority: Signer<'info>,
}

#[derive(Accounts)]
pub struct UpdateUserQuoteAssetInsuranceStake<'info> {
    pub state: Box<Account<'info, State>>,
    #[account(
        seeds = [b"spot_market", 0_u16.to_le_bytes().as_ref()],
        bump
    )]
    pub spot_market: AccountLoader<'info, SpotMarket>,
    #[account(
        mut,
        has_one = authority,
    )]
    pub insurance_fund_stake: AccountLoader<'info, InsuranceFundStake>,
    #[account(
        mut,
        has_one = authority,
    )]
    pub user_stats: AccountLoader<'info, UserStats>,
    pub authority: Signer<'info>,
    #[account(
        mut,
        seeds = [b"insurance_fund_vault".as_ref(), 0_u16.to_le_bytes().as_ref()],
        bump,
    )]
    pub insurance_fund_vault: Box<Account<'info, TokenAccount>>,
}
