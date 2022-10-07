use anchor_lang::prelude::*;
use anchor_spl::token::{Token, TokenAccount};

use crate::error::ErrorCode;
use crate::instructions::constraints::*;
use crate::load;
use crate::load_mut;
use crate::math::constants::QUOTE_SPOT_MARKET_INDEX;
use crate::math::insurance::if_shares_to_vault_amount;
use crate::optional_accounts::{
    get_maker_and_maker_stats, get_referrer_and_referrer_stats, get_serum_fulfillment_accounts,
};
use crate::state::insurance_fund_stake::InsuranceFundStake;
use crate::state::market::{MarketStatus, PerpMarket};
use crate::state::oracle_map::OracleMap;
use crate::state::perp_market_map::{
    get_market_set, get_market_set_for_user_positions, get_market_set_from_list, MarketSet,
    PerpMarketMap,
};
use crate::state::spot_market::SpotMarket;
use crate::state::spot_market_map::{get_writable_spot_market_set, SpotMarketMap, SpotMarketSet};
use crate::state::state::{ExchangeStatus, State};
use crate::state::user::{MarketType, User, UserStats};
use crate::validate;
use crate::{controller, math};

#[access_control(
    fill_not_paused(&ctx.accounts.state)
)]
pub fn handle_fill_order<'info>(
    ctx: Context<FillOrder>,
    order_id: Option<u32>,
    maker_order_id: Option<u32>,
) -> Result<()> {
    let clock = &Clock::get()?;
    let state = &ctx.accounts.state;

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

    let remaining_accounts_iter = &mut ctx.remaining_accounts.iter().peekable();
    let mut oracle_map = OracleMap::load(
        remaining_accounts_iter,
        clock.slot,
        Some(state.oracle_guard_rails),
    )?;
    let spot_market_map = SpotMarketMap::load(&SpotMarketSet::new(), remaining_accounts_iter)?;
    let market_map = PerpMarketMap::load(&get_market_set(market_index), remaining_accounts_iter)?;

    let (maker, maker_stats) = match maker_order_id {
        Some(_) => {
            let (user, user_stats) = get_maker_and_maker_stats(remaining_accounts_iter)?;
            (Some(user), Some(user_stats))
        }
        None => (None, None),
    };

    let (referrer, referrer_stats) = get_referrer_and_referrer_stats(remaining_accounts_iter)?;

    controller::repeg::update_amm(
        market_index,
        &market_map,
        &mut oracle_map,
        &ctx.accounts.state,
        clock,
    )?;

    controller::orders::fill_order(
        order_id,
        &ctx.accounts.state,
        &ctx.accounts.user,
        &ctx.accounts.user_stats,
        &spot_market_map,
        &market_map,
        &mut oracle_map,
        &ctx.accounts.filler,
        &ctx.accounts.filler_stats,
        maker.as_ref(),
        maker_stats.as_ref(),
        maker_order_id,
        referrer.as_ref(),
        referrer_stats.as_ref(),
        clock,
    )?;

    Ok(())
}

#[derive(Clone, Copy, AnchorSerialize, AnchorDeserialize, PartialEq, Debug, Eq)]
pub enum SpotFulfillmentType {
    SerumV3,
    None,
}

impl Default for SpotFulfillmentType {
    fn default() -> Self {
        SpotFulfillmentType::SerumV3
    }
}

#[access_control(
    fill_not_paused(&ctx.accounts.state)
)]
pub fn handle_fill_spot_order<'info>(
    ctx: Context<FillOrder>,
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

    let remaining_accounts_iter = &mut ctx.remaining_accounts.iter().peekable();
    let mut oracle_map = OracleMap::load(remaining_accounts_iter, Clock::get()?.slot, None)?;
    let mut writable_spot_markets = SpotMarketSet::new();
    writable_spot_markets.insert(QUOTE_SPOT_MARKET_INDEX);
    writable_spot_markets.insert(market_index);
    let spot_market_map = SpotMarketMap::load(&writable_spot_markets, remaining_accounts_iter)?;
    let market_map = PerpMarketMap::load(&MarketSet::new(), remaining_accounts_iter)?;

    let (maker, maker_stats) = match maker_order_id {
        Some(_) => {
            let (user, user_stats) = get_maker_and_maker_stats(remaining_accounts_iter)?;
            (Some(user), Some(user_stats))
        }
        None => (None, None),
    };

    let serum_fulfillment_params = match fulfillment_type {
        Some(SpotFulfillmentType::SerumV3) => {
            let base_market = spot_market_map.get_ref(&market_index)?;
            let quote_market = spot_market_map.get_quote_spot_market()?;
            get_serum_fulfillment_accounts(
                remaining_accounts_iter,
                &ctx.accounts.state,
                &base_market,
                &quote_market,
            )?
        }
        _ => None,
    };

    controller::orders::fill_spot_order(
        order_id,
        &ctx.accounts.state,
        &ctx.accounts.user,
        &ctx.accounts.user_stats,
        &spot_market_map,
        &market_map,
        &mut oracle_map,
        &ctx.accounts.filler,
        &ctx.accounts.filler_stats,
        maker.as_ref(),
        maker_stats.as_ref(),
        maker_order_id,
        &Clock::get()?,
        serum_fulfillment_params,
    )?;

    Ok(())
}

#[access_control(
    exchange_not_paused(&ctx.accounts.state)
)]
pub fn handle_trigger_order<'info>(ctx: Context<TriggerOrder>, order_id: u32) -> Result<()> {
    let remaining_accounts_iter = &mut ctx.remaining_accounts.iter().peekable();
    let mut oracle_map = OracleMap::load(remaining_accounts_iter, Clock::get()?.slot, None)?;
    let spot_market_map = SpotMarketMap::load(&SpotMarketSet::new(), remaining_accounts_iter)?;
    let perp_market_map = PerpMarketMap::load(&MarketSet::new(), remaining_accounts_iter)?;

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
    withdraw_not_paused(&ctx.accounts.state)
)]
pub fn handle_settle_pnl(ctx: Context<SettlePNL>, market_index: u16) -> Result<()> {
    let clock = Clock::get()?;
    let state = &ctx.accounts.state;

    let remaining_accounts_iter = &mut ctx.remaining_accounts.iter().peekable();
    let mut oracle_map = OracleMap::load(
        remaining_accounts_iter,
        clock.slot,
        Some(state.oracle_guard_rails),
    )?;
    let spot_market_map = SpotMarketMap::load(
        &get_writable_spot_market_set(QUOTE_SPOT_MARKET_INDEX),
        remaining_accounts_iter,
    )?;
    let market_map = PerpMarketMap::load(&get_market_set(market_index), remaining_accounts_iter)?;

    controller::repeg::update_amm(
        market_index,
        &market_map,
        &mut oracle_map,
        state,
        &Clock::get()?,
    )?;

    let user_key = ctx.accounts.user.key();
    let user = &mut load_mut!(ctx.accounts.user)?;

    controller::pnl::settle_pnl(
        market_index,
        user,
        ctx.accounts.authority.key,
        &user_key,
        &market_map,
        &spot_market_map,
        &mut oracle_map,
        clock.unix_timestamp,
        state,
    )?;

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

    let remaining_accounts_iter = &mut ctx.remaining_accounts.iter().peekable();
    let market_map = PerpMarketMap::load(
        &get_market_set_for_user_positions(&user.perp_positions),
        remaining_accounts_iter,
    )?;

    controller::funding::settle_funding_payments(user, &user_key, &market_map, now)?;
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

    let remaining_accounts_iter = &mut ctx.remaining_accounts.iter().peekable();
    let _oracle_map = OracleMap::load(
        remaining_accounts_iter,
        clock.slot,
        Some(state.oracle_guard_rails),
    )?;
    let _spot_market_map = SpotMarketMap::load(&SpotMarketSet::new(), remaining_accounts_iter)?;
    let market_map = PerpMarketMap::load(&get_market_set(market_index), remaining_accounts_iter)?;

    let market = &mut market_map.get_ref_mut(&market_index)?;

    controller::funding::settle_funding_payment(user, &user_key, market, now)?;

    controller::lp::settle_lp(user, &user_key, market, now)?;

    Ok(())
}

#[allow(unused_must_use)]
#[access_control(
    withdraw_not_paused(&ctx.accounts.state) &&
    amm_not_paused(&ctx.accounts.state)
)]
pub fn handle_settle_expired_position(ctx: Context<SettlePNL>, market_index: u16) -> Result<()> {
    let clock = Clock::get()?;
    let state = &ctx.accounts.state;

    let remaining_accounts_iter = &mut ctx.remaining_accounts.iter().peekable();
    let mut oracle_map = OracleMap::load(
        remaining_accounts_iter,
        clock.slot,
        Some(state.oracle_guard_rails),
    )?;
    let spot_market_map = SpotMarketMap::load(
        &get_writable_spot_market_set(QUOTE_SPOT_MARKET_INDEX),
        remaining_accounts_iter,
    )?;
    let market_map = PerpMarketMap::load(&get_market_set(market_index), remaining_accounts_iter)?;

    let user_key = ctx.accounts.user.key();
    let user = &mut load_mut!(ctx.accounts.user)?;

    math::liquidation::validate_user_not_being_liquidated(
        user,
        &market_map,
        &spot_market_map,
        &mut oracle_map,
        state.liquidation_margin_buffer_ratio,
    )?;

    validate!(!user.bankrupt, ErrorCode::UserBankrupt)?;

    // todo: cancel all user open orders in market

    controller::pnl::settle_expired_position(
        market_index,
        user,
        &user_key,
        &market_map,
        &spot_market_map,
        &mut oracle_map,
        clock.unix_timestamp,
        state,
    )?;

    Ok(())
}

#[access_control(
    withdraw_not_paused(&ctx.accounts.state)
)]
pub fn handle_settle_expired_market(ctx: Context<UpdateAMM>, market_index: u16) -> Result<()> {
    let clock = Clock::get()?;
    let _now = clock.unix_timestamp;
    let state = &ctx.accounts.state;

    let remaining_accounts_iter = &mut ctx.remaining_accounts.iter().peekable();
    let mut oracle_map = OracleMap::load(
        remaining_accounts_iter,
        clock.slot,
        Some(state.oracle_guard_rails),
    )?;
    let spot_market_map = SpotMarketMap::load(
        &get_writable_spot_market_set(QUOTE_SPOT_MARKET_INDEX),
        remaining_accounts_iter,
    )?;
    let market_map = PerpMarketMap::load(&get_market_set(market_index), remaining_accounts_iter)?;

    controller::repeg::update_amm(market_index, &market_map, &mut oracle_map, state, &clock)?;

    controller::repeg::settle_expired_market(
        market_index,
        &market_map,
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

    let remaining_accounts_iter = &mut ctx.remaining_accounts.iter().peekable();
    let mut oracle_map = OracleMap::load(
        remaining_accounts_iter,
        clock.slot,
        Some(state.oracle_guard_rails),
    )?;
    let spot_market_map = SpotMarketMap::load(&SpotMarketSet::new(), remaining_accounts_iter)?;
    let market_map = PerpMarketMap::load(&get_market_set(market_index), remaining_accounts_iter)?;

    controller::liquidation::liquidate_perp(
        market_index,
        liquidator_max_base_asset_amount,
        user,
        &user_key,
        user_stats,
        liquidator,
        &liquidator_key,
        liquidator_stats,
        &market_map,
        &spot_market_map,
        &mut oracle_map,
        slot,
        now,
        state.liquidation_margin_buffer_ratio,
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

    let remaining_accounts_iter = &mut ctx.remaining_accounts.iter().peekable();
    let mut oracle_map = OracleMap::load(
        remaining_accounts_iter,
        clock.slot,
        Some(state.oracle_guard_rails),
    )?;

    let mut writable_spot_markets = SpotMarketSet::new();
    writable_spot_markets.insert(asset_market_index);
    writable_spot_markets.insert(liability_market_index);
    let spot_market_map = SpotMarketMap::load(&writable_spot_markets, remaining_accounts_iter)?;
    let perp_market_map = PerpMarketMap::load(&MarketSet::new(), remaining_accounts_iter)?;

    controller::liquidation::liquidate_spot(
        asset_market_index,
        liability_market_index,
        liquidator_max_liability_transfer,
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

    let remaining_accounts_iter = &mut ctx.remaining_accounts.iter().peekable();
    let mut oracle_map = OracleMap::load(
        remaining_accounts_iter,
        clock.slot,
        Some(state.oracle_guard_rails),
    )?;

    let mut writable_spot_markets = SpotMarketSet::new();
    writable_spot_markets.insert(spot_market_index);
    let spot_market_map = SpotMarketMap::load(&writable_spot_markets, remaining_accounts_iter)?;
    let perp_market_map = PerpMarketMap::load(&MarketSet::new(), remaining_accounts_iter)?;

    controller::liquidation::liquidate_borrow_for_perp_pnl(
        perp_market_index,
        spot_market_index,
        liquidator_max_liability_transfer,
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

    let remaining_accounts_iter = &mut ctx.remaining_accounts.iter().peekable();
    let mut oracle_map = OracleMap::load(
        remaining_accounts_iter,
        clock.slot,
        Some(state.oracle_guard_rails),
    )?;

    let mut writable_spot_markets = SpotMarketSet::new();
    writable_spot_markets.insert(spot_market_index);
    let spot_market_map = SpotMarketMap::load(&writable_spot_markets, remaining_accounts_iter)?;
    let market_map = PerpMarketMap::load(&MarketSet::new(), remaining_accounts_iter)?;

    controller::liquidation::liquidate_perp_pnl_for_deposit(
        perp_market_index,
        spot_market_index,
        liquidator_max_pnl_transfer,
        user,
        &user_key,
        liquidator,
        &liquidator_key,
        &market_map,
        &spot_market_map,
        &mut oracle_map,
        now,
        clock.slot,
        state.liquidation_margin_buffer_ratio,
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

    let remaining_accounts_iter = &mut ctx.remaining_accounts.iter().peekable();
    let mut oracle_map = OracleMap::load(
        remaining_accounts_iter,
        clock.slot,
        Some(state.oracle_guard_rails),
    )?;
    let spot_market_map = SpotMarketMap::load(
        &get_writable_spot_market_set(spot_market_index),
        remaining_accounts_iter,
    )?;
    let market_map =
        PerpMarketMap::load(&get_market_set(perp_market_index), remaining_accounts_iter)?;

    controller::repeg::update_amm(
        perp_market_index,
        &market_map,
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
            &ctx.accounts.clearing_house_signer,
            state,
        )?;
    }

    let insurance_vault_amount = ctx.accounts.insurance_fund_vault.amount;
    let spot_market_vault_amount = ctx.accounts.spot_market_vault.amount;

    let pay_from_insurance = {
        let spot_market = &mut spot_market_map.get_ref_mut(&spot_market_index)?;
        let perp_market = &mut market_map.get_ref_mut(&perp_market_index)?;

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
            perp_market.is_active(now)?,
            ErrorCode::DefaultError,
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
            &ctx.accounts.clearing_house_signer,
            state.signer_nonce,
            pay_from_insurance,
        )?;

        validate!(
            ctx.accounts.insurance_fund_vault.amount > 0,
            ErrorCode::DefaultError,
            "insurance_fund_vault.amount must remain > 0"
        )?;
    }

    // todo: validate amounts transfered and bank before and after are zero-sum

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

    let remaining_accounts_iter = &mut ctx.remaining_accounts.iter().peekable();
    let mut oracle_map = OracleMap::load(
        remaining_accounts_iter,
        clock.slot,
        Some(state.oracle_guard_rails),
    )?;
    let spot_market_map = SpotMarketMap::load(
        &get_writable_spot_market_set(quote_spot_market_index),
        remaining_accounts_iter,
    )?;
    let market_map = PerpMarketMap::load(&get_market_set(market_index), remaining_accounts_iter)?;

    {
        let spot_market = &mut spot_market_map.get_ref_mut(&quote_spot_market_index)?;
        controller::insurance::attempt_settle_revenue_to_insurance_fund(
            &ctx.accounts.spot_market_vault,
            &ctx.accounts.insurance_fund_vault,
            spot_market,
            now,
            &ctx.accounts.token_program,
            &ctx.accounts.clearing_house_signer,
            state,
        )?;
    }

    let pay_from_insurance = controller::liquidation::resolve_perp_bankruptcy(
        market_index,
        user,
        &user_key,
        liquidator,
        &liquidator_key,
        &market_map,
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
            &ctx.accounts.clearing_house_signer,
            state.signer_nonce,
            pay_from_insurance,
        )?;

        validate!(
            ctx.accounts.insurance_fund_vault.amount > 0,
            ErrorCode::DefaultError,
            "insurance_fund_vault.amount must remain > 0"
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

    let remaining_accounts_iter = &mut ctx.remaining_accounts.iter().peekable();
    let mut oracle_map = OracleMap::load(
        remaining_accounts_iter,
        clock.slot,
        Some(state.oracle_guard_rails),
    )?;
    let spot_market_map = SpotMarketMap::load(
        &get_writable_spot_market_set(market_index),
        remaining_accounts_iter,
    )?;

    {
        let spot_market = &mut spot_market_map.get_ref_mut(&market_index)?;
        controller::insurance::attempt_settle_revenue_to_insurance_fund(
            &ctx.accounts.spot_market_vault,
            &ctx.accounts.insurance_fund_vault,
            spot_market,
            now,
            &ctx.accounts.token_program,
            &ctx.accounts.clearing_house_signer,
            state,
        )?;
    }

    let market_map = PerpMarketMap::load(&MarketSet::new(), remaining_accounts_iter)?;

    let pay_from_insurance = controller::liquidation::resolve_spot_bankruptcy(
        market_index,
        user,
        &user_key,
        liquidator,
        &liquidator_key,
        &market_map,
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
            &ctx.accounts.clearing_house_signer,
            ctx.accounts.state.signer_nonce,
            pay_from_insurance,
        )?;

        validate!(
            ctx.accounts.insurance_fund_vault.amount > 0,
            ErrorCode::DefaultError,
            "insurance_fund_vault.amount must remain > 0"
        )?;
    }

    Ok(())
}

#[allow(unused_must_use)]
#[access_control(
    market_valid(&ctx.accounts.market) &&
    funding_not_paused(&ctx.accounts.state) &&
    valid_oracle_for_market(&ctx.accounts.oracle, &ctx.accounts.market)
)]
pub fn handle_update_funding_rate(
    ctx: Context<UpdateFundingRate>,
    market_index: u16,
) -> Result<()> {
    let market = &mut load_mut!(ctx.accounts.market)?;
    let clock = Clock::get()?;
    let now = clock.unix_timestamp;
    let clock_slot = clock.slot;
    let state = &ctx.accounts.state;
    let mut oracle_map = OracleMap::load_one(
        &ctx.accounts.oracle,
        clock_slot,
        Some(state.oracle_guard_rails),
    )?;

    let oracle_price_data = &oracle_map.get_price_data(&market.amm.oracle)?;
    controller::repeg::_update_amm(market, oracle_price_data, state, now, clock_slot)?;

    validate!(
        matches!(market.status, MarketStatus::Active),
        ErrorCode::MarketActionPaused,
        "Market funding is paused",
    )?;

    validate!(
        ((clock_slot == market.amm.last_update_slot && market.amm.last_oracle_valid)
            || market.amm.curve_update_intensity == 0),
        ErrorCode::AMMNotUpdatedInSameSlot,
        "AMM must be updated in a prior instruction within same slot"
    )?;

    let is_updated = controller::funding::update_funding_rate(
        market_index,
        market,
        &mut oracle_map,
        now,
        &state.oracle_guard_rails,
        matches!(state.exchange_status, ExchangeStatus::FundingPaused),
        None,
    )?;

    if !is_updated {
        return Err(ErrorCode::InvalidFundingProfitability.into());
    }

    Ok(())
}

#[access_control(
    withdraw_not_paused(&ctx.accounts.state)
)]
pub fn handle_settle_revenue_to_insurance_fund(
    ctx: Context<SettleRevenueToInsuranceFund>,
    _market_index: u16,
) -> Result<()> {
    let state = &ctx.accounts.state;
    let spot_market = &mut load_mut!(ctx.accounts.spot_market)?;

    validate!(
        spot_market.revenue_settle_period > 0,
        ErrorCode::DefaultError,
        "invalid revenue_settle_period settings on spot market"
    )?;

    let spot_vault_amount = ctx.accounts.spot_market_vault.amount;
    let insurance_vault_amount = ctx.accounts.insurance_fund_vault.amount;

    let clock = Clock::get()?;
    let now = clock.unix_timestamp;

    let time_until_next_update = math::helpers::on_the_hour_update(
        now,
        spot_market.last_revenue_settle_ts,
        spot_market.revenue_settle_period,
    )?;

    validate!(
        time_until_next_update == 0,
        ErrorCode::DefaultError,
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

    controller::token::send_from_program_vault(
        &ctx.accounts.token_program,
        &ctx.accounts.spot_market_vault,
        &ctx.accounts.insurance_fund_vault,
        &ctx.accounts.clearing_house_signer,
        state.signer_nonce,
        token_amount as u64,
    )?;

    spot_market.last_revenue_settle_ts = now;

    Ok(())
}

#[access_control(
    funding_not_paused(&ctx.accounts.state)
)]
pub fn handle_update_spot_market_cumulative_interest(
    ctx: Context<UpdateSpotMarketCumulativeInterest>,
) -> Result<()> {
    let spot_market = &mut load_mut!(ctx.accounts.spot_market)?;
    let now = Clock::get()?.unix_timestamp;
    controller::spot_balance::update_spot_market_cumulative_interest(spot_market, None, now)?;
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
        ErrorCode::DefaultError,
        "insurance_fund_stake is not for quote market"
    )?;

    user_stats.staked_quote_asset_amount = if_shares_to_vault_amount(
        insurance_fund_stake.checked_if_shares(quote_spot_market)?,
        quote_spot_market.total_if_shares,
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
pub struct SettlePNL<'info> {
    pub state: Box<Account<'info, State>>,
    #[account(mut)]
    pub user: AccountLoader<'info, User>,
    pub authority: Signer<'info>,
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
        constraint = state.signer.eq(&clearing_house_signer.key())
    )]
    /// CHECK: forced clearing_house_signer
    pub clearing_house_signer: AccountInfo<'info>,
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
        constraint = state.signer.eq(&clearing_house_signer.key())
    )]
    /// CHECK: forced clearing_house_signer
    pub clearing_house_signer: AccountInfo<'info>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
#[instruction(market_index: u16,)]
pub struct SettleRevenueToInsuranceFund<'info> {
    pub state: Box<Account<'info, State>>,
    #[account(
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
        constraint = state.signer.eq(&clearing_house_signer.key())
    )]
    /// CHECK: forced clearing_house_signer
    pub clearing_house_signer: AccountInfo<'info>,
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
    pub market: AccountLoader<'info, PerpMarket>,
    /// CHECK: checked in `update_funding_rate` ix constraint
    pub oracle: AccountInfo<'info>,
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
