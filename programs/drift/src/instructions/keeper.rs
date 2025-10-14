use std::cell::RefMut;
use std::convert::TryFrom;

use anchor_lang::prelude::*;
use anchor_lang::Discriminator;
use anchor_spl::associated_token::get_associated_token_address_with_program_id;
use anchor_spl::token_interface::{TokenAccount, TokenInterface};
use solana_program::instruction::Instruction;
use solana_program::pubkey;
use solana_program::sysvar::instructions::{
    self, load_current_index_checked, load_instruction_at_checked, ID as IX_ID,
};

use crate::controller::insurance::update_user_stats_if_stake_amount;
use crate::controller::liquidation::{
    liquidate_spot_with_swap_begin, liquidate_spot_with_swap_end,
};
use crate::controller::orders::cancel_orders;
use crate::controller::position::PositionDirection;
use crate::controller::spot_balance::update_spot_balances;
use crate::controller::token::{receive, send_from_program_vault};
use crate::error::ErrorCode;
use crate::ids::admin_hot_wallet;
use crate::ids::{
    dflow_mainnet_aggregator_4, jupiter_mainnet_3, jupiter_mainnet_4, jupiter_mainnet_6,
    serum_program, titan_mainnet_argos_v1,
};
use crate::instructions::constraints::*;
use crate::instructions::optional_accounts::get_revenue_share_escrow_account;
use crate::instructions::optional_accounts::{load_maps, AccountMaps};
use crate::math::casting::Cast;
use crate::math::constants::QUOTE_SPOT_MARKET_INDEX;
use crate::math::margin::get_margin_calculation_for_disable_high_leverage_mode;
use crate::math::margin::{calculate_user_equity, meets_settle_pnl_maintenance_margin_requirement};
use crate::math::orders::{estimate_price_from_side, find_bids_and_asks_from_users};
use crate::math::position::calculate_base_asset_value_and_pnl_with_oracle_price;
use crate::math::safe_math::SafeMath;
use crate::math::spot_withdraw::validate_spot_market_vault_amount;
use crate::optional_accounts::{get_token_mint, update_prelaunch_oracle};
use crate::state::events::{DeleteUserRecord, OrderActionExplanation, SignedMsgOrderRecord};
use crate::state::fill_mode::FillMode;
use crate::state::fulfillment_params::drift::MatchFulfillmentParams;
use crate::state::fulfillment_params::openbook_v2::OpenbookV2FulfillmentParams;
use crate::state::fulfillment_params::phoenix::PhoenixFulfillmentParams;
use crate::state::fulfillment_params::serum::SerumFulfillmentParams;
use crate::state::high_leverage_mode_config::HighLeverageModeConfig;
use crate::state::insurance_fund_stake::InsuranceFundStake;
use crate::state::oracle_map::OracleMap;
use crate::state::order_params::{OrderParams, PlaceOrderOptions};
use crate::state::paused_operations::{PerpOperation, SpotOperation};
use crate::state::perp_market::{ContractType, MarketStatus, PerpMarket};
use crate::state::perp_market_map::{
    get_market_set_for_spot_positions, get_market_set_for_user_positions, get_market_set_from_list,
    get_writable_perp_market_set, get_writable_perp_market_set_from_vec, MarketSet, PerpMarketMap,
};
use crate::state::revenue_share::RevenueShareEscrowZeroCopyMut;
use crate::state::revenue_share::RevenueShareOrder;
use crate::state::revenue_share::RevenueShareOrderBitFlag;
use crate::state::revenue_share_map::load_revenue_share_map;
use crate::state::settle_pnl_mode::SettlePnlMode;
use crate::state::signed_msg_user::{
    SignedMsgOrderId, SignedMsgUserOrdersLoader, SignedMsgUserOrdersZeroCopyMut,
    SIGNED_MSG_PDA_SEED,
};
use crate::state::spot_fulfillment_params::SpotFulfillmentParams;
use crate::state::spot_market::{SpotBalanceType, SpotMarket};
use crate::state::spot_market_map::{
    get_writable_spot_market_set, get_writable_spot_market_set_from_many, SpotMarketMap,
};
use crate::state::state::State;
use crate::state::user::{
    MarginMode, MarketType, OrderStatus, OrderTriggerCondition, OrderType, User, UserStats,
};
use crate::state::user_map::{load_user_map, load_user_maps, UserMap, UserStatsMap};
use crate::validation::sig_verification::verify_and_decode_ed25519_msg;
use crate::validation::user::{validate_user_deletion, validate_user_is_idle};
use crate::{
    controller, load, math, print_error, safe_decrement, OracleSource, GOV_SPOT_MARKET_INDEX,
};
use crate::{load_mut, QUOTE_PRECISION_U64};
use crate::{math_error, ID};
use crate::{validate, QUOTE_PRECISION_I128};
use anchor_spl::associated_token::AssociatedToken;

use crate::math::margin::calculate_margin_requirement_and_total_collateral_and_liability_info;
use crate::math::margin::MarginRequirementType;
use crate::state::margin_calculation::MarginContext;

use super::optional_accounts::get_high_leverage_mode_config;
use super::optional_accounts::get_token_interface;

#[access_control(
    fill_not_paused(&ctx.accounts.state)
)]
pub fn handle_fill_perp_order<'c: 'info, 'info>(
    ctx: Context<'_, '_, 'c, 'info, FillOrder<'info>>,
    order_id: Option<u32>,
) -> Result<()> {
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

fn fill_order<'c: 'info, 'info>(
    ctx: Context<'_, '_, 'c, 'info, FillOrder<'info>>,
    order_id: u32,
    market_index: u16,
) -> Result<()> {
    let clock = &Clock::get()?;
    let state = &ctx.accounts.state;

    let mut remaining_accounts_iter = &mut ctx.remaining_accounts.iter().peekable();
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

    let builder_codes_enabled = state.builder_codes_enabled();
    let builder_referral_enabled = state.builder_referral_enabled();
    let mut escrow = if builder_codes_enabled || builder_referral_enabled {
        get_revenue_share_escrow_account(
            &mut remaining_accounts_iter,
            &load!(ctx.accounts.user)?.authority,
        )?
    } else {
        None
    };

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
        &mut escrow.as_mut(),
        builder_referral_enabled,
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

#[derive(Clone, Copy, AnchorSerialize, AnchorDeserialize, PartialEq, Debug, Eq, Default)]
pub enum SpotFulfillmentType {
    #[default]
    SerumV3,
    Match,
    PhoenixV1,
    OpenbookV2,
}

#[access_control(
    fill_not_paused(&ctx.accounts.state)
)]
pub fn handle_fill_spot_order<'c: 'info, 'info>(
    ctx: Context<'_, '_, 'c, 'info, FillOrder<'info>>,
    order_id: Option<u32>,
    fulfillment_type: Option<SpotFulfillmentType>,
    _maker_order_id: Option<u32>,
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
    )
    .map_err(|e| {
        msg!("Err filling order id {} for user {}", order_id, user_key);
        e
    })?;

    Ok(())
}

fn fill_spot_order<'c: 'info, 'info>(
    ctx: Context<'_, '_, 'c, 'info, FillOrder<'info>>,
    order_id: u32,
    market_index: u16,
    fulfillment_type: SpotFulfillmentType,
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

    let (makers_and_referrer, makers_and_referrer_stats) = match fulfillment_type {
        SpotFulfillmentType::Match => load_user_maps(remaining_accounts_iter, true)?,
        _ => (UserMap::empty(), UserStatsMap::empty()),
    };

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
        SpotFulfillmentType::OpenbookV2 => {
            let base_market = spot_market_map.get_ref(&market_index)?;
            let quote_market = spot_market_map.get_quote_spot_market()?;
            Box::new(OpenbookV2FulfillmentParams::new(
                remaining_accounts_iter,
                &ctx.accounts.state,
                &base_market,
                &quote_market,
                clock.unix_timestamp,
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
        &makers_and_referrer,
        &makers_and_referrer_stats,
        None,
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
pub fn handle_trigger_order<'c: 'info, 'info>(
    ctx: Context<'_, '_, 'c, 'info, TriggerOrder<'info>>,
    order_id: u32,
) -> Result<()> {
    let (market_type, market_index) = match load!(ctx.accounts.user)?.get_order(order_id) {
        Some(order) => (order.market_type, order.market_index),
        None => {
            msg!("order_id not found {}", order_id);
            return Ok(());
        }
    };

    let (writeable_perp_markets, writeable_spot_markets) = match market_type {
        MarketType::Spot => (
            MarketSet::new(),
            get_writable_spot_market_set_from_many(vec![QUOTE_SPOT_MARKET_INDEX, market_index]),
        ),
        MarketType::Perp => (MarketSet::new(), MarketSet::new()),
    };

    let AccountMaps {
        perp_market_map,
        spot_market_map,
        mut oracle_map,
    } = load_maps(
        &mut ctx.remaining_accounts.iter().peekable(),
        &writeable_perp_markets,
        &writeable_spot_markets,
        Clock::get()?.slot,
        None,
    )?;

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
pub fn handle_force_cancel_orders<'c: 'info, 'info>(
    ctx: Context<'_, '_, 'c, 'info, ForceCancelOrder>,
) -> Result<()> {
    let AccountMaps {
        perp_market_map,
        spot_market_map,
        mut oracle_map,
    } = load_maps(
        &mut ctx.remaining_accounts.iter().peekable(),
        &MarketSet::new(),
        &get_writable_spot_market_set(QUOTE_SPOT_MARKET_INDEX),
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
pub fn handle_update_user_idle<'c: 'info, 'info>(
    ctx: Context<'_, '_, 'c, 'info, UpdateUserIdle<'info>>,
) -> Result<()> {
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
pub fn handle_log_user_balances<'c: 'info, 'info>(
    ctx: Context<'_, '_, 'c, 'info, LogUserBalances<'info>>,
) -> Result<()> {
    let user_key = ctx.accounts.user.key();
    let user = load!(ctx.accounts.user)?;

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

    msg!(
        "Authority key {} subaccount id {} user key {}",
        user.authority,
        user.sub_account_id,
        user_key
    );

    msg!("Equity {}", equity);

    for spot_position in user.spot_positions.iter() {
        if spot_position.scaled_balance == 0 {
            continue;
        }

        let spot_market = spot_market_map.get_ref(&spot_position.market_index)?;
        let token_amount = spot_position.get_signed_token_amount(&spot_market)?;
        msg!(
            "Spot position {} balance {}",
            spot_position.market_index,
            token_amount
        );
    }

    for perp_position in user.perp_positions.iter() {
        if perp_position.is_available() {
            continue;
        }

        let perp_market = perp_market_map.get_ref(&perp_position.market_index)?;
        let oracle_price = oracle_map.get_price_data(&perp_market.oracle_id())?.price;
        let (_, unrealized_pnl) =
            calculate_base_asset_value_and_pnl_with_oracle_price(&perp_position, oracle_price)?;

        if unrealized_pnl == 0 {
            continue;
        }

        msg!(
            "Perp position {} unrealized pnl {}",
            perp_position.market_index,
            unrealized_pnl
        );
    }

    Ok(())
}

#[access_control(
    exchange_not_paused(&ctx.accounts.state)
)]
pub fn handle_update_user_fuel_bonus<'c: 'info, 'info>(
    ctx: Context<'_, '_, 'c, 'info, UpdateUserFuelBonus<'info>>,
) -> Result<()> {
    let mut user = load_mut!(ctx.accounts.user)?;
    let user_stats = &mut load_mut!(ctx.accounts.user_stats)?;
    let clock = Clock::get()?;
    let now = clock.unix_timestamp;

    let AccountMaps {
        perp_market_map,
        spot_market_map,
        mut oracle_map,
    } = load_maps(
        &mut ctx.remaining_accounts.iter().peekable(),
        &MarketSet::new(),
        &MarketSet::new(),
        clock.slot,
        None,
    )?;

    let user_margin_calculation =
        calculate_margin_requirement_and_total_collateral_and_liability_info(
            &user,
            &perp_market_map,
            &spot_market_map,
            &mut oracle_map,
            MarginContext::standard(MarginRequirementType::Initial).fuel_numerator(&user, now),
        )?;

    user_stats.update_fuel_bonus(
        &mut user,
        user_margin_calculation.fuel_deposits,
        user_margin_calculation.fuel_borrows,
        user_margin_calculation.fuel_positions,
        now,
    )?;

    Ok(())
}

#[access_control(
    exchange_not_paused(&ctx.accounts.state)
)]
pub fn handle_update_user_stats_referrer_info<'c: 'info, 'info>(
    ctx: Context<'_, '_, 'c, 'info, UpdateUserStatsReferrerInfo<'info>>,
) -> Result<()> {
    let mut user_stats = load_mut!(ctx.accounts.user_stats)?;

    user_stats.update_referrer_status();

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

pub fn handle_place_signed_msg_taker_order<'c: 'info, 'info>(
    ctx: Context<'_, '_, 'c, 'info, PlaceSignedMsgTakerOrder<'info>>,
    signed_msg_order_params_message_bytes: Vec<u8>,
    is_delegate_signer: bool,
) -> Result<()> {
    let state = &ctx.accounts.state;

    let mut remaining_accounts = ctx.remaining_accounts.iter().peekable();
    // TODO: generalize to support multiple market types
    let AccountMaps {
        perp_market_map,
        spot_market_map,
        mut oracle_map,
    } = load_maps(
        &mut remaining_accounts,
        &MarketSet::new(),
        &MarketSet::new(),
        Clock::get()?.slot,
        Some(state.oracle_guard_rails),
    )?;

    let high_leverage_mode_config = get_high_leverage_mode_config(&mut remaining_accounts)?;

    let taker_key = ctx.accounts.user.key();
    let mut taker = load_mut!(ctx.accounts.user)?;
    let mut signed_msg_taker = ctx.accounts.signed_msg_user_orders.load_mut()?;

    let escrow = if state.builder_codes_enabled() {
        get_revenue_share_escrow_account(&mut remaining_accounts, &taker.authority)?
    } else {
        None
    };

    place_signed_msg_taker_order(
        taker_key,
        &mut taker,
        &mut signed_msg_taker,
        signed_msg_order_params_message_bytes,
        &ctx.accounts.ix_sysvar.to_account_info(),
        &perp_market_map,
        &spot_market_map,
        &mut oracle_map,
        high_leverage_mode_config,
        escrow,
        state,
        is_delegate_signer,
    )?;
    Ok(())
}

pub fn place_signed_msg_taker_order<'c: 'info, 'info>(
    taker_key: Pubkey,
    taker: &mut RefMut<User>,
    signed_msg_account: &mut SignedMsgUserOrdersZeroCopyMut,
    taker_order_params_message_bytes: Vec<u8>,
    ix_sysvar: &AccountInfo<'info>,
    perp_market_map: &PerpMarketMap,
    spot_market_map: &SpotMarketMap,
    oracle_map: &mut OracleMap,
    high_leverage_mode_config: Option<AccountLoader<HighLeverageModeConfig>>,
    escrow: Option<RevenueShareEscrowZeroCopyMut<'info>>,
    state: &State,
    is_delegate_signer: bool,
) -> Result<()> {
    // Authenticate the signed msg order param message
    let ix_idx = load_current_index_checked(ix_sysvar)?;
    validate!(
        ix_idx > 0,
        ErrorCode::InvalidVerificationIxIndex,
        "instruction index must be greater than 0 for one sig verifies"
    )?;

    // Verify data from verify ix
    let ix: Instruction = load_instruction_at_checked(ix_idx as usize - 1, ix_sysvar)?;

    let signer = if is_delegate_signer {
        taker.delegate.to_bytes()
    } else {
        taker.authority.to_bytes()
    };
    let verified_message_and_signature = verify_and_decode_ed25519_msg(
        &ix,
        ix_sysvar,
        ix_idx,
        &signer,
        &taker_order_params_message_bytes[..],
        is_delegate_signer,
    )?;

    let mut escrow_zc: Option<RevenueShareEscrowZeroCopyMut<'info>> = None;
    let mut builder_fee_bps: Option<u16> = None;
    if state.builder_codes_enabled()
        && verified_message_and_signature.builder_idx.is_some()
        && verified_message_and_signature
            .builder_fee_tenth_bps
            .is_some()
    {
        if let Some(mut escrow) = escrow {
            let builder_idx = verified_message_and_signature.builder_idx.unwrap();
            let builder_fee = verified_message_and_signature
                .builder_fee_tenth_bps
                .unwrap();

            validate!(
                escrow.fixed.authority == taker.authority,
                ErrorCode::InvalidUserAccount,
                "RevenueShareEscrow account must be owned by taker",
            )?;

            let builder = escrow.get_approved_builder_mut(builder_idx)?;

            if builder.is_revoked() {
                return Err(ErrorCode::BuilderRevoked.into());
            }

            if builder_fee > builder.max_fee_tenth_bps {
                return Err(ErrorCode::InvalidBuilderFee.into());
            }

            builder_fee_bps = Some(builder_fee);
            escrow_zc = Some(escrow);
        } else {
            msg!("Order has builder fee but no escrow account found, in the future this tx will fail.");
        }
    }

    if is_delegate_signer {
        validate!(
            verified_message_and_signature.delegate_signed_taker_pubkey == Some(taker_key),
            ErrorCode::SignedMsgUserContextUserMismatch,
            "Delegate signed msg for taker pubkey different than supplied pubkey"
        )?;
    } else {
        // Verify taker passed to the ix matches pda derived from subaccount id + authority
        let taker_pda = Pubkey::find_program_address(
            &[
                "user".as_bytes(),
                &taker.authority.to_bytes(),
                &verified_message_and_signature
                    .sub_account_id
                    .unwrap()
                    .to_le_bytes(),
            ],
            &ID,
        );
        validate!(
            taker_pda.0 == taker_key,
            ErrorCode::SignedMsgUserContextUserMismatch,
            "Taker key does not match pda"
        )?;
    };

    let signature = verified_message_and_signature.signature;
    let clock = &Clock::get()?;

    // First order must be a taker order
    let matching_taker_order_params = &verified_message_and_signature.signed_msg_order_params;
    if matching_taker_order_params.market_type != MarketType::Perp
        || !matching_taker_order_params.has_valid_auction_params()?
    {
        msg!("First order must be a perp taker order");
        return Err(print_error!(ErrorCode::InvalidSignedMsgOrderParam)().into());
    }

    // Set max slot for the order early so we set correct signed msg order id
    let order_slot = verified_message_and_signature.slot;
    if order_slot < clock.slot.saturating_sub(500) {
        msg!(
            "SignedMsg order slot {} is too old: must be within 500 slots of current slot",
            order_slot
        );
        return Err(print_error!(ErrorCode::InvalidSignedMsgOrderParam)().into());
    }
    let market_index = matching_taker_order_params.market_index;
    let max_slot = if matching_taker_order_params.order_type == OrderType::Limit {
        order_slot.safe_add(
            matching_taker_order_params
                .auction_duration
                .unwrap_or(0)
                .cast::<u64>()?,
        )?
    } else {
        order_slot.safe_add(
            matching_taker_order_params
                .auction_duration
                .unwrap()
                .cast::<u64>()?,
        )?
    };

    // Dont place order if max slot already passed
    if max_slot < clock.slot {
        msg!(
            "SignedMsg order max_slot {} < current slot {}",
            max_slot,
            clock.slot
        );
        return Ok(());
    }

    if let Some(max_margin_ratio) = verified_message_and_signature.max_margin_ratio {
        taker.update_perp_position_max_margin_ratio(market_index, max_margin_ratio)?;
    }

    // Dont place order if signed msg order already exists
    let mut taker_order_id_to_use = taker.next_order_id;
    let mut signed_msg_order_id =
        SignedMsgOrderId::new(verified_message_and_signature.uuid, max_slot, 0);
    if signed_msg_account
        .check_exists_and_prune_stale_signed_msg_order_ids(signed_msg_order_id, clock.slot)
    {
        msg!("SignedMsg order already exists for taker {:?}", taker_key);
        return Ok(());
    }

    // Good to place orders, do stop loss and take profit orders first
    if let Some(stop_loss_order_params) = verified_message_and_signature.stop_loss_order_params {
        taker_order_id_to_use += 1;
        let stop_loss_order = OrderParams {
            order_type: OrderType::TriggerMarket,
            direction: matching_taker_order_params.direction.opposite(),
            trigger_price: Some(stop_loss_order_params.trigger_price),
            base_asset_amount: stop_loss_order_params.base_asset_amount,
            trigger_condition: if matching_taker_order_params.direction == PositionDirection::Long {
                OrderTriggerCondition::Below
            } else {
                OrderTriggerCondition::Above
            },
            market_index,
            market_type: MarketType::Perp,
            reduce_only: true,
            ..OrderParams::default()
        };

        let mut builder_order = if let Some(ref mut escrow) = escrow_zc {
            let new_order_id = taker_order_id_to_use - 1;
            let new_order_index = taker
                .orders
                .iter()
                .position(|order| order.is_available())
                .ok_or(ErrorCode::MaxNumberOfOrders)?;
            match escrow.add_order(RevenueShareOrder::new(
                verified_message_and_signature.builder_idx.unwrap(),
                taker.sub_account_id,
                new_order_id,
                builder_fee_bps.unwrap(),
                MarketType::Perp,
                market_index,
                RevenueShareOrderBitFlag::Open as u8,
                new_order_index as u8,
            )) {
                Ok(order_idx) => escrow.get_order_mut(order_idx).ok(),
                Err(_) => {
                    msg!("Failed to add stop loss order, escrow is full");
                    None
                }
            }
        } else {
            None
        };

        controller::orders::place_perp_order(
            state,
            taker,
            taker_key,
            perp_market_map,
            spot_market_map,
            oracle_map,
            &None,
            clock,
            stop_loss_order,
            PlaceOrderOptions {
                enforce_margin_check: false,
                existing_position_direction_override: Some(matching_taker_order_params.direction),
                ..PlaceOrderOptions::default()
            },
            &mut builder_order,
        )?;
    }

    if let Some(take_profit_order_params) = verified_message_and_signature.take_profit_order_params
    {
        taker_order_id_to_use += 1;
        let take_profit_order = OrderParams {
            order_type: OrderType::TriggerMarket,
            direction: matching_taker_order_params.direction.opposite(),
            trigger_price: Some(take_profit_order_params.trigger_price),
            base_asset_amount: take_profit_order_params.base_asset_amount,
            trigger_condition: if matching_taker_order_params.direction == PositionDirection::Long {
                OrderTriggerCondition::Above
            } else {
                OrderTriggerCondition::Below
            },
            market_index,
            market_type: MarketType::Perp,
            reduce_only: true,
            ..OrderParams::default()
        };

        let mut builder_order = if let Some(ref mut escrow) = escrow_zc {
            let new_order_id = taker_order_id_to_use - 1;
            let new_order_index = taker
                .orders
                .iter()
                .position(|order| order.is_available())
                .ok_or(ErrorCode::MaxNumberOfOrders)?;
            match escrow.add_order(RevenueShareOrder::new(
                verified_message_and_signature.builder_idx.unwrap(),
                taker.sub_account_id,
                new_order_id,
                builder_fee_bps.unwrap(),
                MarketType::Perp,
                market_index,
                RevenueShareOrderBitFlag::Open as u8,
                new_order_index as u8,
            )) {
                Ok(order_idx) => escrow.get_order_mut(order_idx).ok(),
                Err(_) => {
                    msg!("Failed to add take profit order, escrow is full");
                    None
                }
            }
        } else {
            None
        };

        controller::orders::place_perp_order(
            state,
            taker,
            taker_key,
            perp_market_map,
            spot_market_map,
            oracle_map,
            &None,
            clock,
            take_profit_order,
            PlaceOrderOptions {
                enforce_margin_check: false,
                existing_position_direction_override: Some(matching_taker_order_params.direction),
                ..PlaceOrderOptions::default()
            },
            &mut builder_order,
        )?;
    }
    signed_msg_order_id.order_id = taker_order_id_to_use;
    signed_msg_account.add_signed_msg_order_id(signed_msg_order_id)?;

    let mut builder_order = if let Some(ref mut escrow) = escrow_zc {
        let new_order_id = taker_order_id_to_use;
        let new_order_index = taker
            .orders
            .iter()
            .position(|order| order.is_available())
            .ok_or(ErrorCode::MaxNumberOfOrders)?;
        match escrow.add_order(RevenueShareOrder::new(
            verified_message_and_signature.builder_idx.unwrap(),
            taker.sub_account_id,
            new_order_id,
            builder_fee_bps.unwrap(),
            MarketType::Perp,
            market_index,
            RevenueShareOrderBitFlag::Open as u8,
            new_order_index as u8,
        )) {
            Ok(order_idx) => escrow.get_order_mut(order_idx).ok(),
            Err(_) => {
                msg!("Failed to add order, escrow is full");
                None
            }
        }
    } else {
        None
    };

    controller::orders::place_perp_order(
        state,
        taker,
        taker_key,
        perp_market_map,
        spot_market_map,
        oracle_map,
        &high_leverage_mode_config,
        &clock,
        *matching_taker_order_params,
        PlaceOrderOptions {
            enforce_margin_check: true,
            signed_msg_taker_order_slot: Some(order_slot),
            ..PlaceOrderOptions::default()
        },
        &mut builder_order,
    )?;

    let order_params_hash =
        base64::encode(solana_program::hash::hash(&signature.try_to_vec().unwrap()).as_ref());

    emit!(SignedMsgOrderRecord {
        user: taker_key,
        signed_msg_order_max_slot: signed_msg_order_id.max_slot,
        signed_msg_order_uuid: signed_msg_order_id.uuid,
        user_order_id: signed_msg_order_id.order_id,
        matching_order_params: matching_taker_order_params.clone(),
        hash: order_params_hash,
        ts: clock.unix_timestamp,
    });

    if let Some(ref mut escrow) = escrow_zc {
        escrow.revoke_completed_orders(taker)?;
    };

    Ok(())
}

#[access_control(
    settle_pnl_not_paused(&ctx.accounts.state)
)]
pub fn handle_settle_pnl<'c: 'info, 'info>(
    ctx: Context<'_, '_, 'c, 'info, SettlePNL>,
    market_index: u16,
) -> Result<()> {
    let clock = Clock::get()?;
    let state = &ctx.accounts.state;

    let user_key = ctx.accounts.user.key();
    let user = &mut load_mut!(ctx.accounts.user)?;

    validate!(
        user.pool_id == 0,
        ErrorCode::InvalidPoolId,
        "user have pool_id 0"
    )?;

    let mut remaining_accounts = ctx.remaining_accounts.iter().peekable();

    let AccountMaps {
        perp_market_map,
        spot_market_map,
        mut oracle_map,
    } = load_maps(
        &mut remaining_accounts,
        &get_writable_perp_market_set(market_index),
        &get_writable_spot_market_set(QUOTE_SPOT_MARKET_INDEX),
        clock.slot,
        Some(state.oracle_guard_rails),
    )?;

    let (mut builder_escrow, maybe_rev_share_map) =
        if state.builder_codes_enabled() || state.builder_referral_enabled() {
            (
                get_revenue_share_escrow_account(&mut remaining_accounts, &user.authority)?,
                load_revenue_share_map(&mut remaining_accounts).ok(),
            )
        } else {
            (None, None)
        };

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
        )?;

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
            None,
            SettlePnlMode::MustSettle,
        )?;
    }

    if state.builder_codes_enabled() || state.builder_referral_enabled() {
        if let Some(ref mut escrow) = builder_escrow {
            escrow.revoke_completed_orders(user)?;
            if let Some(ref builder_map) = maybe_rev_share_map {
                controller::revenue_share::sweep_completed_revenue_share_for_market(
                    market_index,
                    escrow,
                    &perp_market_map,
                    &spot_market_map,
                    builder_map,
                    clock.unix_timestamp,
                    state.builder_codes_enabled(),
                    state.builder_referral_enabled(),
                )?;
            } else {
                msg!("Builder Users not provided, but RevenueEscrow was provided");
            }
        }
    }

    let spot_market = spot_market_map.get_quote_spot_market()?;
    validate_spot_market_vault_amount(&spot_market, ctx.accounts.spot_market_vault.amount)?;

    Ok(())
}

#[access_control(
    settle_pnl_not_paused(&ctx.accounts.state)
)]
pub fn handle_settle_multiple_pnls<'c: 'info, 'info>(
    ctx: Context<'_, '_, 'c, 'info, SettlePNL>,
    market_indexes: Vec<u16>,
    mode: SettlePnlMode,
) -> Result<()> {
    let clock = Clock::get()?;
    let state = &ctx.accounts.state;

    let user_key = ctx.accounts.user.key();
    let user = &mut load_mut!(ctx.accounts.user)?;

    let mut remaining_accounts = ctx.remaining_accounts.iter().peekable();

    let AccountMaps {
        perp_market_map,
        spot_market_map,
        mut oracle_map,
    } = load_maps(
        &mut remaining_accounts,
        &get_writable_perp_market_set_from_vec(&market_indexes),
        &get_writable_spot_market_set(QUOTE_SPOT_MARKET_INDEX),
        clock.slot,
        Some(state.oracle_guard_rails),
    )?;

    let (mut builder_escrow, maybe_rev_share_map) =
        if state.builder_codes_enabled() || state.builder_referral_enabled() {
            (
                get_revenue_share_escrow_account(&mut remaining_accounts, &user.authority)?,
                load_revenue_share_map(&mut remaining_accounts).ok(),
            )
        } else {
            (None, None)
        };

    let meets_margin_requirement = meets_settle_pnl_maintenance_margin_requirement(
        user,
        &perp_market_map,
        &spot_market_map,
        &mut oracle_map,
    )?;

    for market_index in market_indexes.iter() {
        let market_in_settlement =
            perp_market_map.get_ref(market_index)?.status == MarketStatus::Settlement;

        if market_in_settlement {
            amm_not_paused(state)?;

            controller::pnl::settle_expired_position(
                *market_index,
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
                *market_index,
                &perp_market_map,
                &mut oracle_map,
                state,
                &clock,
            )?;

            controller::pnl::settle_pnl(
                *market_index,
                user,
                ctx.accounts.authority.key,
                &user_key,
                &perp_market_map,
                &spot_market_map,
                &mut oracle_map,
                &clock,
                state,
                Some(meets_margin_requirement),
                mode,
            )?;
        }

        if state.builder_codes_enabled() || state.builder_referral_enabled() {
            if let Some(ref mut escrow) = builder_escrow {
                escrow.revoke_completed_orders(user)?;
                if let Some(ref builder_map) = maybe_rev_share_map {
                    controller::revenue_share::sweep_completed_revenue_share_for_market(
                        *market_index,
                        escrow,
                        &perp_market_map,
                        &spot_market_map,
                        builder_map,
                        clock.unix_timestamp,
                        state.builder_codes_enabled(),
                        state.builder_referral_enabled(),
                    )?;
                } else {
                    msg!("Builder Users not provided, but RevenueEscrow was provided");
                }
            }
        }
    }

    let spot_market = spot_market_map.get_quote_spot_market()?;
    validate_spot_market_vault_amount(&spot_market, ctx.accounts.spot_market_vault.amount)?;

    Ok(())
}

#[access_control(
    funding_not_paused(&ctx.accounts.state)
)]
pub fn handle_settle_funding_payment<'c: 'info, 'info>(
    ctx: Context<'_, '_, 'c, 'info, SettleFunding>,
) -> Result<()> {
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
    liq_not_paused(&ctx.accounts.state)
)]
pub fn handle_liquidate_perp<'c: 'info, 'info>(
    ctx: Context<'_, '_, 'c, 'info, LiquidatePerp<'info>>,
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
pub fn handle_liquidate_perp_with_fill<'c: 'info, 'info>(
    ctx: Context<'_, '_, 'c, 'info, LiquidatePerp<'info>>,
    market_index: u16,
) -> Result<()> {
    let clock = Clock::get()?;
    let state = &ctx.accounts.state;

    let user_key = ctx.accounts.user.key();
    let liquidator_key = ctx.accounts.liquidator.key();

    validate!(
        user_key != liquidator_key,
        ErrorCode::UserCantLiquidateThemself
    )?;

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

    controller::liquidation::liquidate_perp_with_fill(
        market_index,
        &ctx.accounts.user,
        &user_key,
        &ctx.accounts.user_stats,
        &ctx.accounts.liquidator,
        &liquidator_key,
        &ctx.accounts.liquidator_stats,
        &makers_and_referrer,
        &makers_and_referrer_stats,
        &perp_market_map,
        &spot_market_map,
        &mut oracle_map,
        &clock,
        state,
    )?;

    Ok(())
}

#[access_control(
    liq_not_paused(&ctx.accounts.state)
)]
pub fn handle_liquidate_spot<'c: 'info, 'info>(
    ctx: Context<'_, '_, 'c, 'info, LiquidateSpot<'info>>,
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
    let user_stats = &mut load_mut!(ctx.accounts.user_stats)?;
    let liquidator = &mut load_mut!(ctx.accounts.liquidator)?;
    let liquidator_stats = &mut load_mut!(ctx.accounts.liquidator_stats)?;

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
        user_stats,
        liquidator,
        &liquidator_key,
        liquidator_stats,
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
pub fn handle_liquidate_spot_with_swap_begin<'c: 'info, 'info>(
    ctx: Context<'_, '_, 'c, 'info, LiquidateSpotWithSwap<'info>>,
    asset_market_index: u16,
    liability_market_index: u16,
    swap_amount: u64,
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
    let user_stats = &mut load_mut!(ctx.accounts.user_stats)?;
    let liquidator = &mut load_mut!(ctx.accounts.liquidator)?;
    let liquidator_stats = &mut load_mut!(ctx.accounts.liquidator_stats)?;

    let remaining_accounts_iter = &mut ctx.remaining_accounts.iter().peekable();
    let AccountMaps {
        perp_market_map,
        spot_market_map,
        mut oracle_map,
    } = load_maps(
        remaining_accounts_iter,
        &MarketSet::new(),
        &get_writable_spot_market_set_from_many(vec![asset_market_index, liability_market_index]),
        clock.slot,
        Some(state.oracle_guard_rails),
    )?;

    let _token_interface = get_token_interface(remaining_accounts_iter)?;
    let mint = get_token_mint(remaining_accounts_iter)?;

    let mut asset_spot_market = spot_market_map.get_ref_mut(&asset_market_index)?;
    validate!(
        asset_spot_market.flash_loan_initial_token_amount == 0
            && asset_spot_market.flash_loan_amount == 0,
        ErrorCode::InvalidLiquidateSpotWithSwap,
        "begin_swap ended in invalid state"
    )?;

    let asset_oracle_data = oracle_map.get_price_data(&asset_spot_market.oracle_id())?;
    controller::spot_balance::update_spot_market_cumulative_interest(
        &mut asset_spot_market,
        Some(asset_oracle_data),
        now,
    )?;

    let mut liability_spot_market = spot_market_map.get_ref_mut(&liability_market_index)?;

    validate!(
        liability_spot_market.flash_loan_initial_token_amount == 0
            && liability_spot_market.flash_loan_amount == 0,
        ErrorCode::InvalidLiquidateSpotWithSwap,
        "begin_swap ended in invalid state"
    )?;

    let liability_oracle_data = oracle_map.get_price_data(&liability_spot_market.oracle_id())?;
    controller::spot_balance::update_spot_market_cumulative_interest(
        &mut liability_spot_market,
        Some(liability_oracle_data),
        now,
    )?;

    drop(liability_spot_market);
    drop(asset_spot_market);

    validate!(
        asset_market_index != liability_market_index,
        ErrorCode::InvalidSwap,
        "asset and liability market the same"
    )?;

    validate!(
        swap_amount != 0,
        ErrorCode::InvalidSwap,
        "swap_amount cannot be zero"
    )?;

    liquidate_spot_with_swap_begin(
        asset_market_index,
        liability_market_index,
        swap_amount,
        user,
        &user_key,
        user_stats,
        liquidator,
        &liquidator_key,
        liquidator_stats,
        &perp_market_map,
        &spot_market_map,
        &mut oracle_map,
        now,
        clock.slot,
        state,
    )?;

    let mut asset_spot_market = spot_market_map.get_ref_mut(&asset_market_index)?;
    let mut liability_spot_market = spot_market_map.get_ref_mut(&liability_market_index)?;

    let asset_vault = &ctx.accounts.asset_spot_market_vault;
    let asset_token_account = &ctx.accounts.asset_token_account;

    asset_spot_market.flash_loan_amount = swap_amount;
    asset_spot_market.flash_loan_initial_token_amount = asset_token_account.amount;

    let liability_token_account = &ctx.accounts.liability_token_account;

    liability_spot_market.flash_loan_initial_token_amount = liability_token_account.amount;

    let asset_spot_has_transfer_hook = asset_spot_market.has_transfer_hook();
    let liability_spot_has_transfer_hook = liability_spot_market.has_transfer_hook();

    validate!(
        !(asset_spot_has_transfer_hook && liability_spot_has_transfer_hook),
        ErrorCode::InvalidSwap,
        "both asset and liability spot markets cannot both have transfer hooks"
    )?;

    controller::token::send_from_program_vault(
        &ctx.accounts.token_program,
        asset_vault,
        &ctx.accounts.asset_token_account,
        &ctx.accounts.drift_signer,
        state.signer_nonce,
        swap_amount,
        &mint,
        if asset_spot_market.has_transfer_hook() {
            Some(remaining_accounts_iter)
        } else {
            None
        },
    )?;

    let ixs = ctx.accounts.instructions.as_ref();
    let current_index = instructions::load_current_index_checked(ixs)? as usize;

    let current_ix = instructions::load_instruction_at_checked(current_index, ixs)?;
    validate!(
        current_ix.program_id == *ctx.program_id,
        ErrorCode::InvalidLiquidateSpotWithSwap,
        "LiquidateSpotWithSwapBegin must be a top-level instruction (cant be cpi)"
    )?;

    let mut index = current_index + 1;
    let mut found_end = false;
    loop {
        let ix = match instructions::load_instruction_at_checked(index, ixs) {
            Ok(ix) => ix,
            Err(ProgramError::InvalidArgument) => break,
            Err(e) => return Err(e.into()),
        };

        // Check that the drift program key is not used
        if ix.program_id == crate::id() {
            // must be the last ix -- this could possibly be relaxed
            validate!(
                !found_end,
                ErrorCode::InvalidLiquidateSpotWithSwap,
                "the transaction must not contain a Drift instruction after FlashLoanEnd"
            )?;
            found_end = true;

            // must be the SwapEnd instruction
            let discriminator = crate::instruction::LiquidateSpotWithSwapEnd::discriminator();
            validate!(
                ix.data[0..8] == discriminator,
                ErrorCode::InvalidLiquidateSpotWithSwap,
                "last drift ix must be end of swap"
            )?;

            validate!(
                ctx.accounts.authority.key() == ix.accounts[1].pubkey,
                ErrorCode::InvalidLiquidateSpotWithSwap,
                "the authority passed to SwapBegin and End must match"
            )?;

            validate!(
                ctx.accounts.liquidator.key() == ix.accounts[2].pubkey,
                ErrorCode::InvalidLiquidateSpotWithSwap,
                "the liquidator passed to SwapBegin and End must match"
            )?;

            validate!(
                ctx.accounts.user.key() == ix.accounts[4].pubkey,
                ErrorCode::InvalidLiquidateSpotWithSwap,
                "the user passed to SwapBegin and End must match"
            )?;

            validate!(
                ctx.accounts.liability_spot_market_vault.key() == ix.accounts[6].pubkey,
                ErrorCode::InvalidLiquidateSpotWithSwap,
                "the liability_spot_market_vault passed to SwapBegin and End must match"
            )?;

            validate!(
                ctx.accounts.asset_spot_market_vault.key() == ix.accounts[7].pubkey,
                ErrorCode::InvalidLiquidateSpotWithSwap,
                "the asset_spot_market_vault passed to SwapBegin and End must match"
            )?;

            validate!(
                ctx.accounts.liability_token_account.key() == ix.accounts[8].pubkey,
                ErrorCode::InvalidLiquidateSpotWithSwap,
                "the liability_token_account passed to SwapBegin and End must match"
            )?;

            validate!(
                ctx.accounts.asset_token_account.key() == ix.accounts[9].pubkey,
                ErrorCode::InvalidLiquidateSpotWithSwap,
                "the asset_token_account passed to SwapBegin and End must match"
            )?;

            validate!(
                ctx.remaining_accounts.len() == ix.accounts.len() - 13,
                ErrorCode::InvalidLiquidateSpotWithSwap,
                "begin and end ix must have the same number of accounts"
            )?;

            for i in 13..ix.accounts.len() {
                validate!(
                    *ctx.remaining_accounts[i - 13].key == ix.accounts[i].pubkey,
                    ErrorCode::InvalidLiquidateSpotWithSwap,
                    "begin and end ix must have the same accounts. {}th account mismatch. begin: {}, end: {}",
                    i,
                    ctx.remaining_accounts[i - 13].key,
                    ix.accounts[i].pubkey
                )?;
            }
        } else {
            if found_end {
                for meta in ix.accounts.iter() {
                    validate!(
                        meta.is_writable == false,
                        ErrorCode::InvalidLiquidateSpotWithSwap,
                        "instructions after swap end must not have writable accounts"
                    )?;
                }
            } else {
                let whitelisted_programs = vec![
                    serum_program::id(),
                    AssociatedToken::id(),
                    jupiter_mainnet_3::ID,
                    jupiter_mainnet_4::ID,
                    jupiter_mainnet_6::ID,
                    dflow_mainnet_aggregator_4::ID,
                    titan_mainnet_argos_v1::ID,
                ];
                validate!(
                    whitelisted_programs.contains(&ix.program_id),
                    ErrorCode::InvalidLiquidateSpotWithSwap,
                    "only allowed to pass in ixs to ATA, openbook, Jupiter v3/v4/v6, dflow, or titan programs"
                )?;

                for meta in ix.accounts.iter() {
                    validate!(
                        meta.pubkey != crate::id(),
                        ErrorCode::InvalidLiquidateSpotWithSwap,
                        "instructions between begin and end must not be drift instructions"
                    )?;
                }
            }
        }

        index += 1;
    }

    validate!(
        found_end,
        ErrorCode::InvalidLiquidateSpotWithSwap,
        "found no LiquidateSpotWithSwapEnd instruction in transaction"
    )?;

    Ok(())
}

#[access_control(
    liq_not_paused(&ctx.accounts.state)
)]
pub fn handle_liquidate_spot_with_swap_end<'c: 'info, 'info>(
    ctx: Context<'_, '_, 'c, 'info, LiquidateSpotWithSwap<'info>>,
    asset_market_index: u16,
    liability_market_index: u16,
) -> Result<()> {
    let state = &ctx.accounts.state;
    let clock = Clock::get()?;
    let slot = clock.slot;
    let now = clock.unix_timestamp;

    let remaining_accounts = &mut ctx.remaining_accounts.iter().peekable();
    let AccountMaps {
        perp_market_map,
        spot_market_map,
        mut oracle_map,
    } = load_maps(
        remaining_accounts,
        &MarketSet::new(),
        &get_writable_spot_market_set_from_many(vec![asset_market_index, liability_market_index]),
        clock.slot,
        Some(state.oracle_guard_rails),
    )?;
    let liability_token_program = get_token_interface(remaining_accounts)?;

    let asset_mint = get_token_mint(remaining_accounts)?;
    let liability_mint = get_token_mint(remaining_accounts)?;

    let user_key = ctx.accounts.user.key();
    let mut user = load_mut!(&ctx.accounts.user)?;
    let mut user_stats = load_mut!(&ctx.accounts.user_stats)?;

    let liquidator_key = ctx.accounts.liquidator.key();
    let mut liquidator = load_mut!(&ctx.accounts.liquidator)?;
    let mut liquidator_stats = load_mut!(&ctx.accounts.liquidator_stats)?;

    let mut asset_spot_market = spot_market_map.get_ref_mut(&asset_market_index)?;

    validate!(
        asset_spot_market.flash_loan_amount != 0,
        ErrorCode::InvalidSwap,
        "the asset_spot_market must have a flash loan amount set"
    )?;

    let mut liability_spot_market = spot_market_map.get_ref_mut(&liability_market_index)?;

    let asset_vault = &mut ctx.accounts.asset_spot_market_vault;
    let asset_token_account = &mut ctx.accounts.asset_token_account;

    let mut amount_in = asset_spot_market.flash_loan_amount;
    if asset_token_account.amount > asset_spot_market.flash_loan_initial_token_amount {
        let residual = asset_token_account
            .amount
            .safe_sub(asset_spot_market.flash_loan_initial_token_amount)?;

        controller::token::receive(
            &ctx.accounts.token_program,
            asset_token_account,
            asset_vault,
            &ctx.accounts.authority,
            residual,
            &asset_mint,
            if asset_spot_market.has_transfer_hook() {
                Some(remaining_accounts)
            } else {
                None
            },
        )?;
        asset_token_account.reload()?;
        asset_vault.reload()?;

        amount_in = amount_in.safe_sub(residual)?;
    }

    asset_spot_market.flash_loan_initial_token_amount = 0;
    asset_spot_market.flash_loan_amount = 0;

    let liability_vault = &mut ctx.accounts.liability_spot_market_vault;
    let liability_token_account = &mut ctx.accounts.liability_token_account;

    let mut amount_out = 0_u64;
    if liability_token_account.amount > liability_spot_market.flash_loan_initial_token_amount {
        amount_out = liability_token_account
            .amount
            .safe_sub(liability_spot_market.flash_loan_initial_token_amount)?;

        if let Some(token_interface) = liability_token_program {
            controller::token::receive(
                &token_interface,
                liability_token_account,
                liability_vault,
                &ctx.accounts.authority,
                amount_out,
                &liability_mint,
                if liability_spot_market.has_transfer_hook() {
                    Some(remaining_accounts)
                } else {
                    None
                },
            )?;
        } else {
            controller::token::receive(
                &ctx.accounts.token_program,
                liability_token_account,
                liability_vault,
                &ctx.accounts.authority,
                amount_out,
                &liability_mint,
                if liability_spot_market.has_transfer_hook() {
                    Some(remaining_accounts)
                } else {
                    None
                },
            )?;
        }

        liability_vault.reload()?;
    }

    validate!(
        amount_out != 0,
        ErrorCode::InvalidSwap,
        "amount_out must be greater than 0"
    )?;

    liability_spot_market.flash_loan_initial_token_amount = 0;
    liability_spot_market.flash_loan_amount = 0;

    drop(liability_spot_market);
    drop(asset_spot_market);

    liquidate_spot_with_swap_end(
        asset_market_index,
        liability_market_index,
        &mut user,
        &user_key,
        &mut user_stats,
        &mut liquidator,
        &liquidator_key,
        &mut liquidator_stats,
        &perp_market_map,
        &spot_market_map,
        &mut oracle_map,
        now,
        slot,
        state,
        amount_in.cast()?,
        amount_out.cast()?,
    )?;

    let liability_spot_market = spot_market_map.get_ref_mut(&liability_market_index)?;

    validate!(
        liability_spot_market.flash_loan_initial_token_amount == 0
            && liability_spot_market.flash_loan_amount == 0,
        ErrorCode::InvalidSwap,
        "end_swap ended in invalid state"
    )?;

    math::spot_withdraw::validate_spot_market_vault_amount(
        &liability_spot_market,
        liability_vault.amount,
    )?;

    let asset_spot_market = spot_market_map.get_ref_mut(&asset_market_index)?;

    validate!(
        asset_spot_market.flash_loan_initial_token_amount == 0
            && asset_spot_market.flash_loan_amount == 0,
        ErrorCode::InvalidSwap,
        "end_swap ended in invalid state"
    )?;

    math::spot_withdraw::validate_spot_market_vault_amount(&asset_spot_market, asset_vault.amount)?;

    Ok(())
}

#[access_control(
    liq_not_paused(&ctx.accounts.state)
)]
pub fn handle_liquidate_borrow_for_perp_pnl<'c: 'info, 'info>(
    ctx: Context<'_, '_, 'c, 'info, LiquidateBorrowForPerpPnl<'info>>,
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
pub fn handle_liquidate_perp_pnl_for_deposit<'c: 'info, 'info>(
    ctx: Context<'_, '_, 'c, 'info, LiquidatePerpPnlForDeposit<'info>>,
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
    liq_not_paused(&ctx.accounts.state)
)]
pub fn handle_set_user_status_to_being_liquidated<'c: 'info, 'info>(
    ctx: Context<'_, '_, 'c, 'info, SetUserStatusToBeingLiquidated<'info>>,
) -> Result<()> {
    let state = &ctx.accounts.state;
    let clock = Clock::get()?;
    let user = &mut load_mut!(ctx.accounts.user)?;

    let AccountMaps {
        perp_market_map,
        spot_market_map,
        mut oracle_map,
    } = load_maps(
        &mut ctx.remaining_accounts.iter().peekable(),
        &MarketSet::new(),
        &MarketSet::new(),
        clock.slot,
        Some(state.oracle_guard_rails),
    )?;

    controller::liquidation::set_user_status_to_being_liquidated(
        user,
        &perp_market_map,
        &spot_market_map,
        &mut oracle_map,
        clock.slot,
        &state,
    )?;

    Ok(())
}

#[access_control(
    withdraw_not_paused(&ctx.accounts.state)
)]
pub fn handle_resolve_perp_pnl_deficit<'c: 'info, 'info>(
    ctx: Context<'_, '_, 'c, 'info, ResolvePerpPnlDeficit<'info>>,
    spot_market_index: u16,
    perp_market_index: u16,
) -> Result<()> {
    let clock = Clock::get()?;
    let now = clock.unix_timestamp;

    validate!(spot_market_index == 0, ErrorCode::InvalidSpotMarketAccount)?;
    let state = &ctx.accounts.state;

    let remaining_accounts_iter = &mut ctx.remaining_accounts.iter().peekable();
    let AccountMaps {
        perp_market_map,
        spot_market_map,
        mut oracle_map,
    } = load_maps(
        remaining_accounts_iter,
        &get_writable_perp_market_set(perp_market_index),
        &get_writable_spot_market_set(spot_market_index),
        clock.slot,
        Some(state.oracle_guard_rails),
    )?;

    let mint = get_token_mint(remaining_accounts_iter)?;

    controller::repeg::update_amm(
        perp_market_index,
        &perp_market_map,
        &mut oracle_map,
        state,
        &clock,
    )?;

    {
        let spot_market = &mut spot_market_map.get_ref_mut(&spot_market_index)?;
        if spot_market.has_transfer_hook() {
            controller::insurance::attempt_settle_revenue_to_insurance_fund(
                &ctx.accounts.spot_market_vault,
                &ctx.accounts.insurance_fund_vault,
                spot_market,
                now,
                &ctx.accounts.token_program,
                &ctx.accounts.drift_signer,
                state,
                &mint,
                Some(&mut remaining_accounts_iter.clone()),
            )?;
        } else {
            controller::insurance::attempt_settle_revenue_to_insurance_fund(
                &ctx.accounts.spot_market_vault,
                &ctx.accounts.insurance_fund_vault,
                spot_market,
                now,
                &ctx.accounts.token_program,
                &ctx.accounts.drift_signer,
                state,
                &mint,
                None,
            )?;
        };

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

        let oracle_price = oracle_map.get_price_data(&perp_market.oracle_id())?.price;
        controller::orders::validate_market_within_price_band(perp_market, state, oracle_price)?;

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

        let spot_market = &mut spot_market_map.get_ref_mut(&spot_market_index)?;
        controller::token::send_from_program_vault(
            &ctx.accounts.token_program,
            &ctx.accounts.insurance_fund_vault,
            &ctx.accounts.spot_market_vault,
            &ctx.accounts.drift_signer,
            state.signer_nonce,
            pay_from_insurance,
            &mint,
            if spot_market.has_transfer_hook() {
                Some(remaining_accounts_iter)
            } else {
                None
            },
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
pub fn handle_resolve_perp_bankruptcy<'c: 'info, 'info>(
    ctx: Context<'_, '_, 'c, 'info, ResolveBankruptcy<'info>>,
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
        quote_spot_market_index == QUOTE_SPOT_MARKET_INDEX,
        ErrorCode::InvalidSpotMarketAccount
    )?;

    let user = &mut load_mut!(ctx.accounts.user)?;
    let liquidator = &mut load_mut!(ctx.accounts.liquidator)?;
    let state = &ctx.accounts.state;

    let remaining_accounts_iter = &mut ctx.remaining_accounts.iter().peekable();
    let AccountMaps {
        perp_market_map,
        spot_market_map,
        mut oracle_map,
    } = load_maps(
        remaining_accounts_iter,
        &get_writable_perp_market_set(market_index),
        &get_writable_spot_market_set(quote_spot_market_index),
        clock.slot,
        Some(state.oracle_guard_rails),
    )?;

    let mint = get_token_mint(remaining_accounts_iter)?;

    {
        let spot_market = &mut spot_market_map.get_ref_mut(&quote_spot_market_index)?;
        let mut transfer_hook_remaining_accounts_iter = remaining_accounts_iter.clone();
        let remaining_accounts = if spot_market.has_transfer_hook() {
            Some(&mut transfer_hook_remaining_accounts_iter)
        } else {
            None
        };
        controller::insurance::attempt_settle_revenue_to_insurance_fund(
            &ctx.accounts.spot_market_vault,
            &ctx.accounts.insurance_fund_vault,
            spot_market,
            now,
            &ctx.accounts.token_program,
            &ctx.accounts.drift_signer,
            state,
            &mint,
            remaining_accounts,
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

        let spot_market = &spot_market_map.get_ref(&quote_spot_market_index)?;
        let mut transfer_hook_remaining_accounts_iter = remaining_accounts_iter.clone();
        let remaining_accounts = if spot_market.has_transfer_hook() {
            Some(&mut transfer_hook_remaining_accounts_iter)
        } else {
            None
        };

        controller::token::send_from_program_vault(
            &ctx.accounts.token_program,
            &ctx.accounts.insurance_fund_vault,
            &ctx.accounts.spot_market_vault,
            &ctx.accounts.drift_signer,
            state.signer_nonce,
            pay_from_insurance,
            &mint,
            remaining_accounts,
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
pub fn handle_resolve_spot_bankruptcy<'c: 'info, 'info>(
    ctx: Context<'_, '_, 'c, 'info, ResolveBankruptcy<'info>>,
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
    let AccountMaps {
        perp_market_map,
        spot_market_map,
        mut oracle_map,
    } = load_maps(
        remaining_accounts_iter,
        &MarketSet::new(),
        &get_writable_spot_market_set(market_index),
        clock.slot,
        Some(state.oracle_guard_rails),
    )?;

    let mint = get_token_mint(remaining_accounts_iter)?;

    {
        let spot_market = &mut spot_market_map.get_ref_mut(&market_index)?;
        let mut transfer_hook_remaining_accounts_iter = remaining_accounts_iter.clone();
        let remaining_accounts = if spot_market.has_transfer_hook() {
            Some(&mut transfer_hook_remaining_accounts_iter)
        } else {
            None
        };
        controller::insurance::attempt_settle_revenue_to_insurance_fund(
            &ctx.accounts.spot_market_vault,
            &ctx.accounts.insurance_fund_vault,
            spot_market,
            now,
            &ctx.accounts.token_program,
            &ctx.accounts.drift_signer,
            state,
            &mint,
            remaining_accounts,
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
        let spot_market = &spot_market_map.get_ref(&market_index)?;
        let mut transfer_hook_remaining_accounts_iter = remaining_accounts_iter.clone();
        let remaining_accounts = if spot_market.has_transfer_hook() {
            Some(&mut transfer_hook_remaining_accounts_iter)
        } else {
            None
        };
        controller::token::send_from_program_vault(
            &ctx.accounts.token_program,
            &ctx.accounts.insurance_fund_vault,
            &ctx.accounts.spot_market_vault,
            &ctx.accounts.drift_signer,
            ctx.accounts.state.signer_nonce,
            pay_from_insurance,
            &mint,
            remaining_accounts,
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

    let oracle_price_data = oracle_map.get_price_data(&perp_market.oracle_id())?;
    let mm_oracle_price_data = perp_market.get_mm_oracle_price_data(
        *oracle_price_data,
        clock_slot,
        &state.oracle_guard_rails.validity,
    )?;
    controller::repeg::_update_amm(perp_market, &mm_oracle_price_data, state, now, clock_slot)?;

    validate!(
        matches!(
            perp_market.status,
            MarketStatus::Active | MarketStatus::ReduceOnly
        ),
        ErrorCode::MarketActionPaused,
        "Market funding is paused",
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
    valid_oracle_for_perp_market(&ctx.accounts.oracle, &ctx.accounts.perp_market)
)]
pub fn handle_update_prelaunch_oracle(ctx: Context<UpdatePrelaunchOracle>) -> Result<()> {
    let clock = Clock::get()?;
    let clock_slot = clock.slot;
    let oracle_map = OracleMap::load_one(&ctx.accounts.oracle, clock_slot, None)?;

    let perp_market = &load!(ctx.accounts.perp_market)?;

    validate!(
        perp_market.amm.oracle_source == OracleSource::Prelaunch,
        ErrorCode::DefaultError,
        "wrong oracle source"
    )?;

    update_prelaunch_oracle(perp_market, &oracle_map, clock_slot)?;

    Ok(())
}

#[access_control(
    perp_market_valid(&ctx.accounts.perp_market)
    funding_not_paused(&ctx.accounts.state)
    valid_oracle_for_perp_market(&ctx.accounts.oracle, &ctx.accounts.perp_market)
)]
pub fn handle_update_perp_bid_ask_twap<'c: 'info, 'info>(
    ctx: Context<'_, '_, 'c, 'info, UpdatePerpBidAskTwap<'info>>,
) -> Result<()> {
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

    let oracle_price_data = oracle_map.get_price_data(&perp_market.oracle_id())?;
    let mm_oracle_price_data = perp_market.get_mm_oracle_price_data(
        *oracle_price_data,
        slot,
        &state.oracle_guard_rails.validity,
    )?;
    controller::repeg::_update_amm(perp_market, &mm_oracle_price_data, state, now, slot)?;

    let remaining_accounts_iter = &mut ctx.remaining_accounts.iter().peekable();
    let makers = load_user_map(remaining_accounts_iter, false)?;

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

    if perp_market.contract_type == ContractType::Prediction
        && perp_market.is_operation_paused(PerpOperation::AmmFill)
        && (estimated_bid.is_none() || estimated_ask.is_none())
    {
        msg!("skipping mark twap update for disabled amm prediction market");
        return Ok(());
    }
    let before_bid_price_twap = perp_market.amm.last_bid_price_twap;
    let before_ask_price_twap = perp_market.amm.last_ask_price_twap;
    let before_mark_twap_ts = perp_market.amm.last_mark_price_twap_ts;

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
        "after amm bid twap = {} -> {} 
        ask twap = {} -> {} 
        ts = {} -> {}",
        before_bid_price_twap,
        perp_market.amm.last_bid_price_twap,
        before_ask_price_twap,
        perp_market.amm.last_ask_price_twap,
        before_mark_twap_ts,
        perp_market.amm.last_mark_price_twap_ts
    );

    if perp_market.amm.last_bid_price_twap == before_bid_price_twap
        || perp_market.amm.last_ask_price_twap == before_ask_price_twap
    {
        validate!(
            perp_market
                .amm
                .last_mark_price_twap_ts
                .safe_sub(before_mark_twap_ts)?
                >= 60
                || estimated_bid.unwrap_or(0) == before_bid_price_twap
                || estimated_ask.unwrap_or(0) == before_ask_price_twap,
            ErrorCode::CantUpdatePerpBidAskTwap,
            "bid or ask twap unchanged from small ts delta update",
        )?;
    }

    let funding_paused =
        state.funding_paused()? || perp_market.is_operation_paused(PerpOperation::UpdateFunding);
    controller::funding::update_funding_rate(
        perp_market.market_index,
        perp_market,
        &mut oracle_map,
        now,
        slot,
        &state.oracle_guard_rails,
        funding_paused,
        None,
    )?;

    Ok(())
}

#[access_control(
    withdraw_not_paused(&ctx.accounts.state)
)]
pub fn handle_settle_revenue_to_insurance_fund<'c: 'info, 'info>(
    ctx: Context<'_, '_, 'c, 'info, SettleRevenueToInsuranceFund<'info>>,
    spot_market_index: u16,
) -> Result<()> {
    let state = &ctx.accounts.state;
    let spot_market = &mut load_mut!(ctx.accounts.spot_market)?;

    let remaining_accounts_iter = &mut ctx.remaining_accounts.iter().peekable();
    let mint = get_token_mint(remaining_accounts_iter)?;

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
        true,
    )?;

    spot_market.insurance_fund.last_revenue_settle_ts = now;

    controller::token::send_from_program_vault(
        &ctx.accounts.token_program,
        &ctx.accounts.spot_market_vault,
        &ctx.accounts.insurance_fund_vault,
        &ctx.accounts.drift_signer,
        state.signer_nonce,
        token_amount,
        &mint,
        if spot_market.has_transfer_hook() {
            Some(remaining_accounts_iter)
        } else {
            None
        },
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

    let oracle_price_data = oracle_map.get_price_data(&spot_market.oracle_id())?;

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
pub fn handle_update_amms<'c: 'info, 'info>(
    ctx: Context<'_, '_, 'c, 'info, UpdateAMM<'info>>,
    market_indexes: Vec<u16>,
) -> Result<()> {
    if market_indexes.len() > 5 {
        msg!("Too many markets passed, max 5");
        return Err(ErrorCode::DefaultError.into());
    }
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

#[access_control(
    exchange_not_paused(&ctx.accounts.state)
)]
pub fn view_amm_liquidity<'c: 'info, 'info>(
    ctx: Context<'_, '_, 'c, 'info, UpdateAMM<'info>>,
    market_indexes: Vec<u16>,
) -> Result<()> {
    if market_indexes.len() > 5 {
        msg!("Too many markets passed, max 5");
        return Err(ErrorCode::DefaultError.into());
    }
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

    for (_key, market_account_loader) in market_map.0.iter_mut() {
        let market = &mut load_mut!(market_account_loader)?;
        let oracle_price_data = &oracle_map.get_price_data(&market.oracle_id())?;

        let reserve_price = market.amm.reserve_price()?;
        let (bid, ask) = market.amm.bid_ask_price(reserve_price)?;
        crate::dlog!(bid, ask, oracle_price_data.price);
    }

    Ok(())
}

pub fn handle_update_user_quote_asset_insurance_stake(
    ctx: Context<UpdateUserQuoteAssetInsuranceStake>,
) -> Result<()> {
    let insurance_fund_stake = &mut load_mut!(ctx.accounts.insurance_fund_stake)?;
    let user_stats = &mut load_mut!(ctx.accounts.user_stats)?;
    let spot_market = &mut load_mut!(ctx.accounts.spot_market)?;

    validate!(
        insurance_fund_stake.market_index == 0,
        ErrorCode::IncorrectSpotMarketAccountPassed,
        "insurance_fund_stake is not for quote market"
    )?;

    if insurance_fund_stake.market_index == 0 && spot_market.market_index == 0 {
        let clock = Clock::get()?;
        let now = clock.unix_timestamp;

        update_user_stats_if_stake_amount(
            0,
            ctx.accounts.insurance_fund_vault.amount,
            insurance_fund_stake,
            user_stats,
            spot_market,
            now,
        )?;
    }

    Ok(())
}

pub fn handle_update_user_gov_token_insurance_stake(
    ctx: Context<UpdateUserGovTokenInsuranceStake>,
) -> Result<()> {
    let insurance_fund_stake = &mut load_mut!(ctx.accounts.insurance_fund_stake)?;
    let user_stats = &mut load_mut!(ctx.accounts.user_stats)?;
    let spot_market = &mut load_mut!(ctx.accounts.spot_market)?;

    validate!(
        insurance_fund_stake.market_index == GOV_SPOT_MARKET_INDEX,
        ErrorCode::IncorrectSpotMarketAccountPassed,
        "insurance_fund_stake is not for governance market index = {}",
        GOV_SPOT_MARKET_INDEX
    )?;

    if insurance_fund_stake.market_index == GOV_SPOT_MARKET_INDEX
        && spot_market.market_index == GOV_SPOT_MARKET_INDEX
    {
        let clock = Clock::get()?;
        let now = clock.unix_timestamp;

        update_user_stats_if_stake_amount(
            0,
            ctx.accounts.insurance_fund_vault.amount,
            insurance_fund_stake,
            user_stats,
            spot_market,
            now,
        )?;
    }

    Ok(())
}

pub fn handle_disable_user_high_leverage_mode<'c: 'info, 'info>(
    ctx: Context<'_, '_, 'c, 'info, DisableUserHighLeverageMode<'info>>,
    disable_maintenance: bool,
) -> Result<()> {
    let state = &ctx.accounts.state;
    let mut user = load_mut!(ctx.accounts.user)?;

    let slot = Clock::get()?.slot;

    let AccountMaps {
        perp_market_map,
        spot_market_map,
        mut oracle_map,
    } = load_maps(
        &mut ctx.remaining_accounts.iter().peekable(),
        &MarketSet::new(),
        &MarketSet::new(),
        slot,
        Some(state.oracle_guard_rails),
    )?;

    let in_high_leverage_mode = user.is_high_leverage_mode(MarginRequirementType::Maintenance);
    validate!(
        in_high_leverage_mode,
        ErrorCode::DefaultError,
        "user is not in high leverage mode"
    )?;

    let old_margin_mode = user.margin_mode;

    if disable_maintenance {
        validate!(
            user.margin_mode == MarginMode::HighLeverageMaintenance,
            ErrorCode::DefaultError,
            "user must be in high leverage maintenance mode"
        )?;

        user.margin_mode = MarginMode::Default;
    } else {
        let mut has_high_leverage_pos = false;
        for position in user.perp_positions.iter().filter(|p| !p.is_available()) {
            let perp_market = perp_market_map.get_ref(&position.market_index)?;
            if perp_market.is_high_leverage_mode_enabled() {
                has_high_leverage_pos = true;
                break;
            }
        }

        if !has_high_leverage_pos {
            user.margin_mode = MarginMode::Default;
        } else {
            validate!(
                user.margin_mode == MarginMode::HighLeverage,
                ErrorCode::DefaultError,
                "user must be in high leverage mode"
            )?;

            user.margin_mode = MarginMode::HighLeverageMaintenance;
        }
    }

    let margin_calc = get_margin_calculation_for_disable_high_leverage_mode(
        &mut user,
        &perp_market_map,
        &spot_market_map,
        &mut oracle_map,
    )?;

    if margin_calc.num_perp_liabilities > 0 {
        let mut requires_invariant_check = false;

        for position in user.perp_positions.iter().filter(|p| !p.is_available()) {
            let perp_market = perp_market_map.get_ref(&position.market_index)?;
            if perp_market.is_high_leverage_mode_enabled() {
                requires_invariant_check = true;
                break; // Exit early if invariant check is required
            }
        }

        if requires_invariant_check {
            validate!(
                margin_calc.meets_margin_requirement_with_buffer(),
                ErrorCode::DefaultError,
                "User does not meet margin requirement with buffer"
            )?;
        }
    }

    // only check if signer is not user authority
    if user.authority != *ctx.accounts.authority.key {
        let slots_since_last_active = slot.safe_sub(user.last_active_slot)?;

        let min_slots_inactive = 2250; // 15 * 60 / .4

        validate!(
            slots_since_last_active >= min_slots_inactive || user.idle,
            ErrorCode::DefaultError,
            "user not inactive for long enough: {} < {}",
            slots_since_last_active,
            min_slots_inactive
        )?;
    }

    let mut config = load_mut!(ctx.accounts.high_leverage_mode_config)?;

    if old_margin_mode == MarginMode::HighLeverageMaintenance {
        config.current_maintenance_users = config.current_maintenance_users.safe_sub(1)?;
    } else {
        config.current_users = config.current_users.safe_sub(1)?;
    }

    if user.margin_mode == MarginMode::HighLeverageMaintenance {
        config.current_maintenance_users = config.current_maintenance_users.safe_add(1)?;
    }

    config.validate()?;

    Ok(())
}

pub fn handle_force_delete_user<'c: 'info, 'info>(
    ctx: Context<'_, '_, 'c, 'info, ForceDeleteUser<'info>>,
) -> Result<()> {
    #[cfg(not(feature = "anchor-test"))]
    {
        validate!(
            *ctx.accounts.keeper.key == admin_hot_wallet::id(),
            ErrorCode::DefaultError,
            "only admin hot wallet can force delete user"
        )?;
    }

    // Pyra accounts are exempt from force_delete_user

    let pyra_program = pubkey!("6JjHXLheGSNvvexgzMthEcgjkcirDrGduc3HAKB2P1v2");
    validate!(
        *ctx.accounts.authority.owner != pyra_program,
        ErrorCode::DefaultError,
        "pyra accounts are exempt from force_delete_user"
    )?;

    let state = &ctx.accounts.state;

    let keeper_key = *ctx.accounts.keeper.key;

    let user_key = ctx.accounts.user.key();
    let user = &mut load_mut!(ctx.accounts.user)?;
    let user_stats = &mut load_mut!(ctx.accounts.user_stats)?;

    let slot = Clock::get()?.slot;
    let now = Clock::get()?.unix_timestamp;
    let AccountMaps {
        perp_market_map,
        spot_market_map,
        mut oracle_map,
    } = load_maps(
        &mut ctx.remaining_accounts.iter().peekable(),
        &MarketSet::new(),
        &get_market_set_for_spot_positions(&user.spot_positions),
        slot,
        Some(state.oracle_guard_rails),
    )?;

    // check the user equity

    let (user_equity, _) =
        calculate_user_equity(user, &perp_market_map, &spot_market_map, &mut oracle_map)?;

    let max_equity = QUOTE_PRECISION_I128 / 20;
    validate!(
        user_equity <= max_equity,
        ErrorCode::DefaultError,
        "user equity must be less than {}",
        max_equity
    )?;

    #[cfg(not(feature = "anchor-test"))]
    {
        let slots_since_last_active = slot.safe_sub(user.last_active_slot)?;

        validate!(
            slots_since_last_active >= 18144000, // 60 * 60 * 24 * 7 * 4 * 3 / .4 (~3 months)
            ErrorCode::DefaultError,
            "user not inactive for long enough: {}",
            slots_since_last_active
        )?;
    }

    // cancel all open orders
    cancel_orders(
        user,
        &user_key,
        Some(&keeper_key),
        &perp_market_map,
        &spot_market_map,
        &mut oracle_map,
        now,
        slot,
        OrderActionExplanation::None,
        None,
        None,
        None,
    )?;

    for spot_position in user.spot_positions.iter_mut() {
        if spot_position.is_available() {
            continue;
        }

        let spot_market = &mut spot_market_map.get_ref_mut(&spot_position.market_index)?;
        let oracle_price_data = oracle_map.get_price_data(&spot_market.oracle_id())?;

        controller::spot_balance::update_spot_market_cumulative_interest(
            spot_market,
            Some(oracle_price_data),
            now,
        )?;

        let token_amount = spot_position.get_token_amount(spot_market)?;
        let balance_type = spot_position.balance_type;

        let token_program_pubkey = spot_market.get_token_program();

        let token_program = &ctx
            .remaining_accounts
            .iter()
            .find(|acc| acc.key() == token_program_pubkey)
            .map(|acc| Interface::try_from(acc))
            .unwrap()
            .unwrap();

        let spot_market_mint = &spot_market.mint;
        let mint_account_info = ctx
            .remaining_accounts
            .iter()
            .find(|acc| acc.key() == spot_market_mint.key())
            .map(|acc| InterfaceAccount::try_from(acc).unwrap());

        let keeper_vault = get_associated_token_address_with_program_id(
            &keeper_key,
            spot_market_mint,
            &token_program_pubkey,
        );
        let keeper_vault_account_info = ctx
            .remaining_accounts
            .iter()
            .find(|acc| acc.key() == keeper_vault.key())
            .map(|acc| InterfaceAccount::try_from(acc))
            .unwrap()
            .unwrap();

        let spot_market_vault = spot_market.vault;
        let mut spot_market_vault_account_info = ctx
            .remaining_accounts
            .iter()
            .find(|acc| acc.key() == spot_market_vault.key())
            .map(|acc| InterfaceAccount::try_from(acc))
            .unwrap()
            .unwrap();

        if balance_type == SpotBalanceType::Deposit {
            update_spot_balances(
                token_amount,
                &SpotBalanceType::Borrow,
                spot_market,
                spot_position,
                true,
            )?;

            // TODO: support transfer hook tokens
            send_from_program_vault(
                &token_program,
                &spot_market_vault_account_info,
                &keeper_vault_account_info,
                &ctx.accounts.drift_signer,
                state.signer_nonce,
                token_amount.cast()?,
                &mint_account_info,
                None,
            )?;
        } else {
            update_spot_balances(
                token_amount,
                &SpotBalanceType::Deposit,
                spot_market,
                spot_position,
                false,
            )?;

            // TODO: support transfer hook tokens
            receive(
                token_program,
                &keeper_vault_account_info,
                &spot_market_vault_account_info,
                &ctx.accounts.keeper.to_account_info(),
                token_amount.cast()?,
                &mint_account_info,
                None,
            )?;
        }

        spot_market_vault_account_info.reload()?;
        math::spot_withdraw::validate_spot_market_vault_amount(
            spot_market,
            spot_market_vault_account_info.amount,
        )?;
    }

    validate_user_deletion(
        user,
        user_stats,
        &ctx.accounts.state,
        Clock::get()?.unix_timestamp,
    )?;

    safe_decrement!(user_stats.number_of_sub_accounts, 1);

    let state = &mut ctx.accounts.state;
    safe_decrement!(state.number_of_sub_accounts, 1);

    emit!(DeleteUserRecord {
        ts: now,
        user_authority: *ctx.accounts.authority.key,
        user: user_key,
        sub_account_id: user.sub_account_id,
        keeper: Some(*ctx.accounts.keeper.key),
    });

    Ok(())
}

pub fn handle_pause_spot_market_deposit_withdraw(
    ctx: Context<PauseSpotMarketDepositWithdraw>,
) -> Result<()> {
    let spot_market = &mut load_mut!(ctx.accounts.spot_market)?;

    let result =
        validate_spot_market_vault_amount(spot_market, ctx.accounts.spot_market_vault.amount);

    validate!(
        matches!(result, Err(ErrorCode::SpotMarketVaultInvariantViolated)),
        ErrorCode::DefaultError,
        "spot market vault amount is valid"
    )?;

    spot_market.paused_operations = spot_market.paused_operations | SpotOperation::Deposit as u8;
    spot_market.paused_operations = spot_market.paused_operations | SpotOperation::Withdraw as u8;

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
pub struct LogUserBalances<'info> {
    pub state: Box<Account<'info, State>>,
    pub authority: Signer<'info>,
    #[account(mut)]
    pub user: AccountLoader<'info, User>,
}

#[derive(Accounts)]
pub struct UpdateUserFuelBonus<'info> {
    pub state: Box<Account<'info, State>>,
    pub authority: Signer<'info>,
    #[account(mut)]
    pub user: AccountLoader<'info, User>,
    #[account(
        mut,
        constraint = is_stats_for_user(&user, &user_stats)?
    )]
    pub user_stats: AccountLoader<'info, UserStats>,
}

#[derive(Accounts)]
pub struct UpdateUserStatsReferrerInfo<'info> {
    pub state: Box<Account<'info, State>>,
    pub authority: Signer<'info>,
    #[account(mut)]
    pub user_stats: AccountLoader<'info, UserStats>,
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
    pub spot_market_vault: Box<InterfaceAccount<'info, TokenAccount>>,
}

#[derive(Accounts)]
pub struct PlaceSignedMsgTakerOrder<'info> {
    pub state: Box<Account<'info, State>>,
    #[account(mut)]
    pub user: AccountLoader<'info, User>,
    #[account(
        mut,
        constraint = is_stats_for_user(&user, &user_stats)?
    )]
    pub user_stats: AccountLoader<'info, UserStats>,
    #[account(
        mut,
        seeds = [SIGNED_MSG_PDA_SEED.as_ref(), user.load()?.authority.as_ref()],
        bump,
    )]
    /// CHECK: checked in SignedMsgUserOrdersZeroCopy checks
    pub signed_msg_user_orders: AccountInfo<'info>,
    pub authority: Signer<'info>,
    /// CHECK: The address check is needed because otherwise
    /// the supplied Sysvar could be anything else.
    /// The Instruction Sysvar has not been implemented
    /// in the Anchor framework yet, so this is the safe approach.
    #[account(address = IX_ID)]
    pub ix_sysvar: AccountInfo<'info>,
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
pub struct SetUserStatusToBeingLiquidated<'info> {
    pub state: Box<Account<'info, State>>,
    #[account(mut)]
    pub user: AccountLoader<'info, User>,
    pub authority: Signer<'info>,
}

#[derive(Accounts)]
#[instruction(asset_market_index: u16, liability_market_index: u16, )]
pub struct LiquidateSpotWithSwap<'info> {
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
        seeds = [b"spot_market_vault".as_ref(), liability_market_index.to_le_bytes().as_ref()],
        bump,
    )]
    pub liability_spot_market_vault: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(
        mut,
        seeds = [b"spot_market_vault".as_ref(), asset_market_index.to_le_bytes().as_ref()],
        bump,
    )]
    pub asset_spot_market_vault: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(
        mut,
        constraint = &liability_spot_market_vault.mint.eq(&liability_token_account.mint),
        token::authority = authority
    )]
    pub liability_token_account: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(
        mut,
        constraint = &asset_spot_market_vault.mint.eq(&asset_token_account.mint),
        token::authority = authority
    )]
    pub asset_token_account: Box<InterfaceAccount<'info, TokenAccount>>,
    pub token_program: Interface<'info, TokenInterface>,
    #[account(
        constraint = state.signer.eq(&drift_signer.key())
    )]
    /// CHECK: forced drift_signer
    pub drift_signer: AccountInfo<'info>,
    /// Instructions Sysvar for instruction introspection
    /// CHECK: fixed instructions sysvar account
    #[account(address = instructions::ID)]
    pub instructions: UncheckedAccount<'info>,
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
    pub spot_market_vault: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(
        mut,
        seeds = [b"insurance_fund_vault".as_ref(), spot_market_index.to_le_bytes().as_ref()], // todo: market_index=0 hardcode for perps?
        bump,
    )]
    pub insurance_fund_vault: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(
        constraint = state.signer.eq(&drift_signer.key())
    )]
    /// CHECK: forced drift_signer
    pub drift_signer: AccountInfo<'info>,
    pub token_program: Interface<'info, TokenInterface>,
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
    pub spot_market_vault: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(
        mut,
        seeds = [b"insurance_fund_vault".as_ref(), spot_market_index.to_le_bytes().as_ref()], // todo: market_index=0 hardcode for perps?
        bump,
    )]
    pub insurance_fund_vault: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(
        constraint = state.signer.eq(&drift_signer.key())
    )]
    /// CHECK: forced drift_signer
    pub drift_signer: AccountInfo<'info>,
    pub token_program: Interface<'info, TokenInterface>,
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
    pub spot_market_vault: Box<InterfaceAccount<'info, TokenAccount>>,
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
    pub insurance_fund_vault: Box<InterfaceAccount<'info, TokenAccount>>,
    pub token_program: Interface<'info, TokenInterface>,
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
    pub spot_market_vault: Box<InterfaceAccount<'info, TokenAccount>>,
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
        mut,
        seeds = [b"spot_market", 0_u16.to_le_bytes().as_ref()],
        bump
    )]
    pub spot_market: AccountLoader<'info, SpotMarket>,
    #[account(
        mut,
        constraint = is_stats_for_if_stake(&insurance_fund_stake, &user_stats)?
    )]
    pub insurance_fund_stake: AccountLoader<'info, InsuranceFundStake>,
    #[account(mut)]
    pub user_stats: AccountLoader<'info, UserStats>,
    pub signer: Signer<'info>,
    #[account(
        mut,
        seeds = [b"insurance_fund_vault".as_ref(), 0_u16.to_le_bytes().as_ref()],
        bump,
    )]
    pub insurance_fund_vault: Box<InterfaceAccount<'info, TokenAccount>>,
}

#[derive(Accounts)]
pub struct UpdateUserGovTokenInsuranceStake<'info> {
    pub state: Box<Account<'info, State>>,
    #[account(
        mut,
        seeds = [b"spot_market", 15_u16.to_le_bytes().as_ref()],
        bump
    )]
    pub spot_market: AccountLoader<'info, SpotMarket>,
    #[account(
        mut,
        constraint = is_stats_for_if_stake(&insurance_fund_stake, &user_stats)?
    )]
    pub insurance_fund_stake: AccountLoader<'info, InsuranceFundStake>,
    #[account(mut)]
    pub user_stats: AccountLoader<'info, UserStats>,
    pub signer: Signer<'info>,
    #[account(
        mut,
        seeds = [b"insurance_fund_vault".as_ref(), 15_u16.to_le_bytes().as_ref()],
        bump,
    )]
    pub insurance_fund_vault: Box<InterfaceAccount<'info, TokenAccount>>,
}

#[derive(Accounts)]
pub struct UpdatePrelaunchOracle<'info> {
    pub state: Box<Account<'info, State>>,
    pub perp_market: AccountLoader<'info, PerpMarket>,
    #[account(mut)]
    /// CHECK: checked in ix
    pub oracle: AccountInfo<'info>,
}

#[derive(Accounts)]
pub struct DisableUserHighLeverageMode<'info> {
    pub state: Box<Account<'info, State>>,
    pub authority: Signer<'info>,
    #[account(mut)]
    pub user: AccountLoader<'info, User>,
    #[account(mut)]
    pub high_leverage_mode_config: AccountLoader<'info, HighLeverageModeConfig>,
}

#[derive(Accounts)]
pub struct ForceDeleteUser<'info> {
    #[account(
        mut,
        has_one = authority,
        close = authority
    )]
    pub user: AccountLoader<'info, User>,
    #[account(
        mut,
        has_one = authority
    )]
    pub user_stats: AccountLoader<'info, UserStats>,
    #[account(mut)]
    pub state: Box<Account<'info, State>>,
    /// CHECK: authority
    #[account(mut)]
    pub authority: AccountInfo<'info>,
    #[account(mut)]
    pub keeper: Signer<'info>,
    /// CHECK: forced drift_signer
    pub drift_signer: AccountInfo<'info>,
}

#[derive(Accounts)]
pub struct PauseSpotMarketDepositWithdraw<'info> {
    pub state: Box<Account<'info, State>>,
    pub keeper: Signer<'info>,
    #[account(mut)]
    pub spot_market: AccountLoader<'info, SpotMarket>,
    #[account(
        seeds = [b"spot_market_vault".as_ref(), spot_market.load()?.market_index.to_le_bytes().as_ref()],
        bump,
    )]
    pub spot_market_vault: Box<InterfaceAccount<'info, TokenAccount>>,
}
