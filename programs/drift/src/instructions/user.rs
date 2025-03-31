use std::convert::TryFrom;
use std::ops::DerefMut;

use anchor_lang::prelude::*;
use anchor_lang::Discriminator;
use anchor_spl::{
    token::Token,
    token_2022::Token2022,
    token_interface::{TokenAccount, TokenInterface},
};
use solana_program::program::invoke;
use solana_program::system_instruction::transfer;

use crate::controller::orders::{cancel_orders, ModifyOrderId};
use crate::controller::position::update_position_and_market;
use crate::controller::position::PositionDirection;
use crate::controller::spot_balance::update_revenue_pool_balances;
use crate::controller::spot_position::{
    update_spot_balances_and_cumulative_deposits,
    update_spot_balances_and_cumulative_deposits_with_limits,
};
use crate::error::ErrorCode;
use crate::ids::admin_hot_wallet;
use crate::ids::{
    jupiter_mainnet_3, jupiter_mainnet_4, jupiter_mainnet_6, lighthouse, marinade_mainnet,
    serum_program,
};
use crate::instructions::constraints::*;
use crate::instructions::optional_accounts::{
    get_referrer_and_referrer_stats, get_whitelist_token, load_maps, AccountMaps,
};
use crate::instructions::SpotFulfillmentType;
use crate::math::casting::Cast;
use crate::math::liquidation::is_user_being_liquidated;
use crate::math::margin::calculate_margin_requirement_and_total_collateral_and_liability_info;
use crate::math::margin::meets_initial_margin_requirement;
use crate::math::margin::{
    calculate_max_withdrawable_amount, meets_maintenance_margin_requirement,
    meets_place_order_margin_requirement, validate_spot_margin_trading, MarginRequirementType,
};
use crate::math::oracle::is_oracle_valid_for_action;
use crate::math::oracle::DriftAction;
use crate::math::orders::get_position_delta_for_fill;
use crate::math::orders::is_multiple_of_step_size;
use crate::math::orders::standardize_price_i64;
use crate::math::position::calculate_base_asset_value_with_oracle_price;
use crate::math::safe_math::SafeMath;
use crate::math::spot_balance::get_token_value;
use crate::math::spot_swap;
use crate::math::spot_swap::{calculate_swap_price, validate_price_bands_for_swap};
use crate::math_error;
use crate::optional_accounts::{get_token_interface, get_token_mint};
use crate::print_error;
use crate::safe_decrement;
use crate::safe_increment;
use crate::state::events::emit_stack;
use crate::state::events::OrderAction;
use crate::state::events::OrderActionRecord;
use crate::state::events::OrderRecord;
use crate::state::events::{
    DepositDirection, DepositExplanation, DepositRecord, FuelSeasonRecord, FuelSweepRecord,
    LPAction, LPRecord, NewUserRecord, OrderActionExplanation, SwapRecord,
};
use crate::state::fill_mode::FillMode;
use crate::state::fulfillment_params::drift::MatchFulfillmentParams;
use crate::state::fulfillment_params::openbook_v2::OpenbookV2FulfillmentParams;
use crate::state::fulfillment_params::phoenix::PhoenixFulfillmentParams;
use crate::state::fulfillment_params::serum::SerumFulfillmentParams;
use crate::state::high_leverage_mode_config::HighLeverageModeConfig;
use crate::state::margin_calculation::MarginContext;
use crate::state::oracle::StrictOraclePrice;
use crate::state::order_params::{
    parse_optional_params, ModifyOrderParams, OrderParams, PlaceAndTakeOrderSuccessCondition,
    PlaceOrderOptions, PostOnlyParam,
};
use crate::state::paused_operations::{PerpOperation, SpotOperation};
use crate::state::perp_market::ContractType;
use crate::state::perp_market::MarketStatus;
use crate::state::perp_market_map::{get_writable_perp_market_set, MarketSet};
use crate::state::protected_maker_mode_config::ProtectedMakerModeConfig;
use crate::state::signed_msg_user::SignedMsgOrderId;
use crate::state::signed_msg_user::SignedMsgUserOrdersLoader;
use crate::state::signed_msg_user::SignedMsgWsDelegates;
use crate::state::signed_msg_user::SIGNED_MSG_WS_PDA_SEED;
use crate::state::signed_msg_user::{SignedMsgUserOrders, SIGNED_MSG_PDA_SEED};
use crate::state::spot_fulfillment_params::SpotFulfillmentParams;
use crate::state::spot_market::SpotBalanceType;
use crate::state::spot_market::SpotMarket;
use crate::state::spot_market_map::{
    get_writable_spot_market_set, get_writable_spot_market_set_from_many,
};
use crate::state::state::State;
use crate::state::traits::Size;
use crate::state::user::Order;
use crate::state::user::OrderStatus;
use crate::state::user::ReferrerStatus;
use crate::state::user::{
    FuelOverflow, FuelOverflowProvider, MarginMode, MarketType, OrderType, ReferrerName, User,
    UserStats,
};
use crate::state::user_map::{load_user_maps, UserMap, UserStatsMap};
use crate::validate;
use crate::validation::position::validate_perp_position_with_perp_market;
use crate::validation::user::validate_user_deletion;
use crate::validation::whitelist::validate_whitelist_token;
use crate::{controller, math};
use crate::{get_then_update_id, QUOTE_SPOT_MARKET_INDEX};
use crate::{load, THIRTEEN_DAY};
use crate::{load_mut, ExchangeStatus};
use anchor_lang::solana_program::sysvar::instructions;
use anchor_spl::associated_token::AssociatedToken;
use borsh::{BorshDeserialize, BorshSerialize};
use solana_program::sysvar::instructions::ID as IX_ID;

pub fn handle_initialize_user<'c: 'info, 'info>(
    ctx: Context<'_, '_, 'c, 'info, InitializeUser<'info>>,
    sub_account_id: u16,
    name: [u8; 32],
) -> Result<()> {
    let user_key = ctx.accounts.user.key();
    let mut user = ctx
        .accounts
        .user
        .load_init()
        .or(Err(ErrorCode::UnableToLoadAccountLoader))?;
    user.authority = ctx.accounts.authority.key();
    user.sub_account_id = sub_account_id;
    user.name = name;
    user.next_order_id = 1;
    user.next_liquidation_id = 1;

    let remaining_accounts_iter = &mut ctx.remaining_accounts.iter().peekable();

    let mut user_stats = load_mut!(ctx.accounts.user_stats)?;
    user_stats.number_of_sub_accounts = user_stats.number_of_sub_accounts.safe_add(1)?;

    // Only try to add referrer if it is the first user
    if user_stats.number_of_sub_accounts_created == 0 {
        let (referrer, referrer_stats) = get_referrer_and_referrer_stats(remaining_accounts_iter)?;
        let referrer = if let (Some(referrer), Some(referrer_stats)) = (referrer, referrer_stats) {
            let referrer = load!(referrer)?;
            let mut referrer_stats = load_mut!(referrer_stats)?;

            validate!(referrer.sub_account_id == 0, ErrorCode::InvalidReferrer)?;

            validate!(
                referrer.authority == referrer_stats.authority,
                ErrorCode::ReferrerAndReferrerStatsAuthorityUnequal
            )?;

            referrer_stats.referrer_status |= ReferrerStatus::IsReferrer as u8;
            user_stats.referrer_status |= ReferrerStatus::IsReferred as u8;

            referrer.authority
        } else {
            Pubkey::default()
        };

        user_stats.referrer = referrer;
    }

    let whitelist_mint = &ctx.accounts.state.whitelist_mint;
    if !whitelist_mint.eq(&Pubkey::default()) {
        validate_whitelist_token(
            get_whitelist_token(remaining_accounts_iter)?,
            whitelist_mint,
            &ctx.accounts.authority.key(),
        )?;
    }

    validate!(
        sub_account_id == user_stats.number_of_sub_accounts_created,
        ErrorCode::InvalidUserSubAccountId,
        "Invalid sub account id {}, must be {}",
        sub_account_id,
        user_stats.number_of_sub_accounts_created
    )?;

    user_stats.number_of_sub_accounts_created =
        user_stats.number_of_sub_accounts_created.safe_add(1)?;

    let state = &mut ctx.accounts.state;
    safe_increment!(state.number_of_sub_accounts, 1);

    let max_number_of_sub_accounts = state.max_number_of_sub_accounts();

    validate!(
        max_number_of_sub_accounts == 0
            || state.number_of_sub_accounts <= max_number_of_sub_accounts,
        ErrorCode::MaxNumberOfUsers
    )?;

    let now_ts = Clock::get()?.unix_timestamp;

    user.last_fuel_bonus_update_ts = now_ts.cast()?;

    emit!(NewUserRecord {
        ts: now_ts,
        user_authority: ctx.accounts.authority.key(),
        user: user_key,
        sub_account_id,
        name,
        referrer: user_stats.referrer
    });

    drop(user);

    let init_fee = state.get_init_user_fee()?;

    if init_fee > 0 {
        let payer_lamports = ctx.accounts.payer.to_account_info().try_lamports()?;
        if payer_lamports < init_fee {
            msg!("payer lamports {} init fee {}", payer_lamports, init_fee);
            return Err(ErrorCode::CantPayUserInitFee.into());
        }

        invoke(
            &transfer(
                &ctx.accounts.payer.key(),
                &ctx.accounts.user.key(),
                init_fee,
            ),
            &[
                ctx.accounts.payer.to_account_info(),
                ctx.accounts.user.to_account_info(),
                ctx.accounts.system_program.to_account_info(),
            ],
        )?;
    }

    Ok(())
}

pub fn handle_initialize_user_stats<'c: 'info, 'info>(
    ctx: Context<'_, '_, 'c, 'info, InitializeUserStats>,
) -> Result<()> {
    let clock = Clock::get()?;

    let mut user_stats = ctx
        .accounts
        .user_stats
        .load_init()
        .or(Err(ErrorCode::UnableToLoadAccountLoader))?;

    *user_stats = UserStats {
        authority: ctx.accounts.authority.key(),
        number_of_sub_accounts: 0,
        last_taker_volume_30d_ts: clock.unix_timestamp,
        last_maker_volume_30d_ts: clock.unix_timestamp,
        last_filler_volume_30d_ts: clock.unix_timestamp,
        last_fuel_if_bonus_update_ts: clock.unix_timestamp.cast()?,
        ..UserStats::default()
    };

    let state = &mut ctx.accounts.state;
    safe_increment!(state.number_of_authorities, 1);

    let max_number_of_sub_accounts = state.max_number_of_sub_accounts();

    validate!(
        max_number_of_sub_accounts == 0
            || state.number_of_authorities <= max_number_of_sub_accounts,
        ErrorCode::MaxNumberOfUsers
    )?;

    Ok(())
}

pub fn handle_initialize_referrer_name(
    ctx: Context<InitializeReferrerName>,
    name: [u8; 32],
) -> Result<()> {
    let authority_key = ctx.accounts.authority.key();
    let user_stats_key = ctx.accounts.user_stats.key();
    let user_key = ctx.accounts.user.key();
    let mut referrer_name = ctx
        .accounts
        .referrer_name
        .load_init()
        .or(Err(ErrorCode::UnableToLoadAccountLoader))?;

    let user = load!(ctx.accounts.user)?;

    validate!(
        user.sub_account_id == 0,
        ErrorCode::InvalidReferrer,
        "must be subaccount 0"
    )?;

    validate!(
        user.pool_id == 0,
        ErrorCode::InvalidReferrer,
        "must be pool_id 0"
    )?;

    referrer_name.authority = authority_key;
    referrer_name.user = user_key;
    referrer_name.user_stats = user_stats_key;
    referrer_name.name = name;

    Ok(())
}

pub fn handle_initialize_signed_msg_user_orders<'c: 'info, 'info>(
    ctx: Context<'_, '_, 'c, 'info, InitializeSignedMsgUserOrders<'info>>,
    num_orders: u16,
) -> Result<()> {
    let signed_msg_user_orders = &mut ctx.accounts.signed_msg_user_orders;
    signed_msg_user_orders.authority_pubkey = ctx.accounts.authority.key();
    signed_msg_user_orders
        .signed_msg_order_data
        .resize_with(num_orders as usize, SignedMsgOrderId::default);
    signed_msg_user_orders.validate()?;
    Ok(())
}

pub fn handle_resize_signed_msg_user_orders<'c: 'info, 'info>(
    ctx: Context<'_, '_, 'c, 'info, ResizeSignedMsgUserOrders<'info>>,
    num_orders: u16,
) -> Result<()> {
    let signed_msg_user_orders = &mut ctx.accounts.signed_msg_user_orders;
    let user = load!(ctx.accounts.user)?;
    if ctx.accounts.payer.key != ctx.accounts.authority.key
        && ctx.accounts.payer.key != &user.delegate.key()
    {
        validate!(
            num_orders as usize >= signed_msg_user_orders.signed_msg_order_data.len(),
            ErrorCode::InvalidSignedMsgUserOrdersResize,
            "Invalid shrinking resize for payer != user authority or delegate"
        )?;
    }

    signed_msg_user_orders
        .signed_msg_order_data
        .resize_with(num_orders as usize, SignedMsgOrderId::default);
    signed_msg_user_orders.validate()?;
    Ok(())
}

pub fn handle_initialize_signed_msg_ws_delegates<'c: 'info, 'info>(
    ctx: Context<'_, '_, 'c, 'info, InitializeSignedMsgWsDelegates<'info>>,
    delegates: Vec<Pubkey>,
) -> Result<()> {
    ctx.accounts
        .signed_msg_ws_delegates
        .delegates
        .extend(delegates);
    Ok(())
}

pub fn handle_change_signed_msg_ws_delegate_status<'c: 'info, 'info>(
    ctx: Context<'_, '_, 'c, 'info, ChangeSignedMsgWsDelegateStatus<'info>>,
    delegate: Pubkey,
    add: bool,
) -> Result<()> {
    if add {
        ctx.accounts
            .signed_msg_ws_delegates
            .delegates
            .push(delegate);
    } else {
        ctx.accounts
            .signed_msg_ws_delegates
            .delegates
            .retain(|&pubkey| pubkey != delegate);
    }

    Ok(())
}

pub fn handle_initialize_fuel_overflow<'c: 'info, 'info>(
    ctx: Context<'_, '_, 'c, 'info, InitializeFuelOverflow<'info>>,
) -> Result<()> {
    let mut user_stats = load_mut!(&ctx.accounts.user_stats)?;
    validate!(
        user_stats.can_sweep_fuel(),
        ErrorCode::UserFuelOverflowThresholdNotMet,
        "User fuel sweep threshold not met"
    )?;

    let mut fuel_overflow = ctx
        .accounts
        .fuel_overflow
        .load_init()
        .or(Err(ErrorCode::UnableToLoadAccountLoader))?;

    *fuel_overflow = FuelOverflow {
        authority: ctx.accounts.authority.key(),
        ..FuelOverflow::default()
    };
    user_stats.update_fuel_overflow_status(true);

    Ok(())
}

pub fn handle_sweep_fuel<'c: 'info, 'info>(
    ctx: Context<'_, '_, 'c, 'info, SweepFuel<'info>>,
) -> anchor_lang::Result<()> {
    let mut user_stats = load_mut!(&ctx.accounts.user_stats)?;
    validate!(
        user_stats.can_sweep_fuel(),
        ErrorCode::UserFuelOverflowThresholdNotMet,
        "User fuel sweep threshold not met"
    )?;

    let mut fuel_overflow = load_mut!(&ctx.accounts.fuel_overflow)?;

    let clock = Clock::get()?;
    emit!(FuelSweepRecord {
        ts: clock.unix_timestamp.cast()?,
        authority: ctx.accounts.authority.key(),
        user_stats_fuel_insurance: user_stats.fuel_insurance,
        user_stats_fuel_deposits: user_stats.fuel_deposits,
        user_stats_fuel_borrows: user_stats.fuel_borrows,
        user_stats_fuel_positions: user_stats.fuel_positions,
        user_stats_fuel_taker: user_stats.fuel_taker,
        user_stats_fuel_maker: user_stats.fuel_maker,
        fuel_overflow_fuel_insurance: fuel_overflow.fuel_insurance,
        fuel_overflow_fuel_deposits: fuel_overflow.fuel_deposits,
        fuel_overflow_fuel_borrows: fuel_overflow.fuel_borrows,
        fuel_overflow_fuel_positions: fuel_overflow.fuel_positions,
        fuel_overflow_fuel_taker: fuel_overflow.fuel_taker,
        fuel_overflow_fuel_maker: fuel_overflow.fuel_maker,
    });

    fuel_overflow.update_from_user_stats(&user_stats, clock.unix_timestamp.cast()?)?;
    user_stats.reset_fuel();

    Ok(())
}

pub fn handle_reset_fuel_season<'c: 'info, 'info>(
    ctx: Context<'_, '_, 'c, 'info, ResetFuelSeason<'info>>,
) -> Result<()> {
    let mut user_stats = load_mut!(&ctx.accounts.user_stats)?;

    let fuel_overflow = ctx.fuel_overflow();
    user_stats.validate_fuel_overflow(&fuel_overflow)?;

    let clock = Clock::get()?;
    if let Some(fuel_overflow_account) = fuel_overflow {
        // if FuelOverflow exists, sweep before resetting user_stats
        let mut fuel_overflow = load_mut!(fuel_overflow_account)?;
        emit!(FuelSweepRecord {
            ts: clock.unix_timestamp.cast()?,
            authority: ctx.accounts.authority.key(),
            user_stats_fuel_insurance: user_stats.fuel_insurance,
            user_stats_fuel_deposits: user_stats.fuel_deposits,
            user_stats_fuel_borrows: user_stats.fuel_borrows,
            user_stats_fuel_positions: user_stats.fuel_positions,
            user_stats_fuel_taker: user_stats.fuel_taker,
            user_stats_fuel_maker: user_stats.fuel_maker,
            fuel_overflow_fuel_insurance: fuel_overflow.fuel_insurance,
            fuel_overflow_fuel_deposits: fuel_overflow.fuel_deposits,
            fuel_overflow_fuel_borrows: fuel_overflow.fuel_borrows,
            fuel_overflow_fuel_positions: fuel_overflow.fuel_positions,
            fuel_overflow_fuel_taker: fuel_overflow.fuel_taker,
            fuel_overflow_fuel_maker: fuel_overflow.fuel_maker,
        });
        fuel_overflow.update_from_user_stats(&user_stats, clock.unix_timestamp.cast()?)?;

        emit!(FuelSeasonRecord {
            ts: clock.unix_timestamp.cast()?,
            authority: ctx.accounts.authority.key(),
            fuel_insurance: fuel_overflow.fuel_insurance,
            fuel_deposits: fuel_overflow.fuel_deposits,
            fuel_borrows: fuel_overflow.fuel_borrows,
            fuel_positions: fuel_overflow.fuel_positions,
            fuel_taker: fuel_overflow.fuel_taker,
            fuel_maker: fuel_overflow.fuel_maker,
            fuel_total: fuel_overflow.total_fuel()?,
        });
        fuel_overflow.reset_fuel(clock.unix_timestamp.cast()?);
    } else {
        emit!(FuelSeasonRecord {
            ts: clock.unix_timestamp.cast()?,
            authority: ctx.accounts.authority.key(),
            fuel_insurance: user_stats.fuel_insurance.cast()?,
            fuel_deposits: user_stats.fuel_deposits.cast()?,
            fuel_borrows: user_stats.fuel_borrows.cast()?,
            fuel_positions: user_stats.fuel_positions.cast()?,
            fuel_taker: user_stats.fuel_taker.cast()?,
            fuel_maker: user_stats.fuel_maker.cast()?,
            fuel_total: user_stats.total_fuel()?,
        });
    };

    user_stats.reset_fuel();

    Ok(())
}

#[access_control(
    deposit_not_paused(&ctx.accounts.state)
)]
pub fn handle_deposit<'c: 'info, 'info>(
    ctx: Context<'_, '_, 'c, 'info, Deposit<'info>>,
    market_index: u16,
    amount: u64,
    reduce_only: bool,
) -> Result<()> {
    let user_key = ctx.accounts.user.key();
    let user = &mut load_mut!(ctx.accounts.user)?;

    let state = &ctx.accounts.state;
    let clock = Clock::get()?;
    let now = clock.unix_timestamp;
    let slot = clock.slot;

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

    if amount == 0 {
        return Err(ErrorCode::InsufficientDeposit.into());
    }

    validate!(!user.is_bankrupt(), ErrorCode::UserBankrupt)?;

    let mut spot_market = spot_market_map.get_ref_mut(&market_index)?;
    let oracle_price_data = *oracle_map.get_price_data(&spot_market.oracle_id())?;

    validate!(
        user.pool_id == spot_market.pool_id,
        ErrorCode::InvalidPoolId,
        "user pool id ({}) != market pool id ({})",
        user.pool_id,
        spot_market.pool_id
    )?;

    validate!(
        !matches!(spot_market.status, MarketStatus::Initialized),
        ErrorCode::MarketBeingInitialized,
        "Market is being initialized"
    )?;

    controller::spot_balance::update_spot_market_cumulative_interest(
        &mut spot_market,
        Some(&oracle_price_data),
        now,
    )?;

    let position_index = user.force_get_spot_position_index(spot_market.market_index)?;

    let is_borrow_before = user.spot_positions[position_index].is_borrow();

    let force_reduce_only = spot_market.is_reduce_only();

    // if reduce only, have to compare ix amount to current borrow amount
    let amount = if (force_reduce_only || reduce_only)
        && user.spot_positions[position_index].balance_type == SpotBalanceType::Borrow
    {
        user.spot_positions[position_index]
            .get_token_amount(&spot_market)?
            .cast::<u64>()?
            .min(amount)
    } else {
        amount
    };

    user.increment_total_deposits(
        amount,
        oracle_price_data.price,
        spot_market.get_precision().cast()?,
    )?;

    let total_deposits_after = user.total_deposits;
    let total_withdraws_after = user.total_withdraws;

    let spot_position = &mut user.spot_positions[position_index];
    controller::spot_position::update_spot_balances_and_cumulative_deposits(
        amount as u128,
        &SpotBalanceType::Deposit,
        &mut spot_market,
        spot_position,
        false,
        None,
    )?;

    let token_amount = spot_position.get_token_amount(&spot_market)?;
    if token_amount == 0 {
        validate!(
            spot_position.scaled_balance == 0,
            ErrorCode::InvalidSpotPosition,
            "deposit left user with invalid position. scaled balance = {} token amount = {}",
            spot_position.scaled_balance,
            token_amount
        )?;
    }

    if spot_position.balance_type == SpotBalanceType::Deposit && spot_position.scaled_balance > 0 {
        validate!(
            matches!(spot_market.status, MarketStatus::Active),
            ErrorCode::MarketActionPaused,
            "spot_market not active",
        )?;
    }

    drop(spot_market);
    if user.is_being_liquidated() {
        // try to update liquidation status if user is was already being liq'd
        let is_being_liquidated = is_user_being_liquidated(
            user,
            &perp_market_map,
            &spot_market_map,
            &mut oracle_map,
            state.liquidation_margin_buffer_ratio,
        )?;

        if !is_being_liquidated {
            user.exit_liquidation();
        }
    }

    user.update_last_active_slot(slot);

    let spot_market = &mut spot_market_map.get_ref_mut(&market_index)?;

    controller::token::receive(
        &ctx.accounts.token_program,
        &ctx.accounts.user_token_account,
        &ctx.accounts.spot_market_vault,
        &ctx.accounts.authority,
        amount,
        &mint,
    )?;
    ctx.accounts.spot_market_vault.reload()?;

    let deposit_record_id = get_then_update_id!(spot_market, next_deposit_record_id);
    let oracle_price = oracle_price_data.price;
    let explanation = if is_borrow_before {
        DepositExplanation::RepayBorrow
    } else {
        DepositExplanation::None
    };
    let deposit_record = DepositRecord {
        ts: now,
        deposit_record_id,
        user_authority: user.authority,
        user: user_key,
        direction: DepositDirection::Deposit,
        amount,
        oracle_price,
        market_deposit_balance: spot_market.deposit_balance,
        market_withdraw_balance: spot_market.borrow_balance,
        market_cumulative_deposit_interest: spot_market.cumulative_deposit_interest,
        market_cumulative_borrow_interest: spot_market.cumulative_borrow_interest,
        total_deposits_after,
        total_withdraws_after,
        market_index,
        explanation,
        transfer_user: None,
    };
    emit!(deposit_record);

    spot_market.validate_max_token_deposits_and_borrows(false)?;

    Ok(())
}

#[access_control(
    withdraw_not_paused(&ctx.accounts.state)
)]
pub fn handle_withdraw<'c: 'info, 'info>(
    ctx: Context<'_, '_, 'c, 'info, Withdraw<'info>>,
    market_index: u16,
    amount: u64,
    reduce_only: bool,
) -> anchor_lang::Result<()> {
    let user_key = ctx.accounts.user.key();
    let user = &mut load_mut!(ctx.accounts.user)?;
    let mut user_stats = load_mut!(ctx.accounts.user_stats)?;
    let clock = Clock::get()?;
    let now = clock.unix_timestamp;
    let slot = clock.slot;
    let state = &ctx.accounts.state;

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

    validate!(!user.is_bankrupt(), ErrorCode::UserBankrupt)?;

    let spot_market_is_reduce_only = {
        let spot_market = &mut spot_market_map.get_ref_mut(&market_index)?;
        let oracle_price_data = oracle_map.get_price_data(&spot_market.oracle_id())?;

        controller::spot_balance::update_spot_market_cumulative_interest(
            spot_market,
            Some(oracle_price_data),
            now,
        )?;

        spot_market.is_reduce_only()
    };

    let amount = {
        let reduce_only = reduce_only || spot_market_is_reduce_only;

        let position_index = user.force_get_spot_position_index(market_index)?;

        let amount = if reduce_only {
            validate!(
                user.spot_positions[position_index].balance_type == SpotBalanceType::Deposit,
                ErrorCode::ReduceOnlyWithdrawIncreasedRisk
            )?;

            let max_withdrawable_amount = calculate_max_withdrawable_amount(
                market_index,
                user,
                &perp_market_map,
                &spot_market_map,
                &mut oracle_map,
            )?;

            let spot_market = &spot_market_map.get_ref(&market_index)?;
            let existing_deposit_amount = user.spot_positions[position_index]
                .get_token_amount(spot_market)?
                .cast::<u64>()?;

            amount
                .min(max_withdrawable_amount)
                .min(existing_deposit_amount)
        } else {
            amount
        };

        let spot_market = &mut spot_market_map.get_ref_mut(&market_index)?;
        let oracle_price_data = oracle_map.get_price_data(&spot_market.oracle_id())?;

        user.increment_total_withdraws(
            amount,
            oracle_price_data.price,
            spot_market.get_precision().cast()?,
        )?;

        // prevents withdraw when limits hit
        controller::spot_position::update_spot_balances_and_cumulative_deposits_with_limits(
            amount as u128,
            &SpotBalanceType::Borrow,
            spot_market,
            user,
        )?;

        amount
    };

    user.meets_withdraw_margin_requirement_and_increment_fuel_bonus(
        &perp_market_map,
        &spot_market_map,
        &mut oracle_map,
        MarginRequirementType::Initial,
        market_index,
        amount as u128,
        &mut user_stats,
        now,
    )?;

    validate_spot_margin_trading(user, &perp_market_map, &spot_market_map, &mut oracle_map)?;

    if user.is_being_liquidated() {
        user.exit_liquidation();
    }

    user.update_last_active_slot(slot);

    let mut spot_market = spot_market_map.get_ref_mut(&market_index)?;
    let oracle_price = oracle_map.get_price_data(&spot_market.oracle_id())?.price;

    let is_borrow = user
        .get_spot_position(market_index)
        .map_or(false, |pos| pos.is_borrow());
    let deposit_explanation = if is_borrow {
        DepositExplanation::Borrow
    } else {
        DepositExplanation::None
    };

    let deposit_record_id = get_then_update_id!(spot_market, next_deposit_record_id);
    let deposit_record = DepositRecord {
        ts: now,
        deposit_record_id,
        user_authority: user.authority,
        user: user_key,
        direction: DepositDirection::Withdraw,
        oracle_price,
        amount,
        market_index,
        market_deposit_balance: spot_market.deposit_balance,
        market_withdraw_balance: spot_market.borrow_balance,
        market_cumulative_deposit_interest: spot_market.cumulative_deposit_interest,
        market_cumulative_borrow_interest: spot_market.cumulative_borrow_interest,
        total_deposits_after: user.total_deposits,
        total_withdraws_after: user.total_withdraws,
        explanation: deposit_explanation,
        transfer_user: None,
    };
    emit!(deposit_record);

    controller::token::send_from_program_vault(
        &ctx.accounts.token_program,
        &ctx.accounts.spot_market_vault,
        &ctx.accounts.user_token_account,
        &ctx.accounts.drift_signer,
        state.signer_nonce,
        amount,
        &mint,
    )?;

    // reload the spot market vault balance so it's up-to-date
    ctx.accounts.spot_market_vault.reload()?;
    math::spot_withdraw::validate_spot_market_vault_amount(
        &spot_market,
        ctx.accounts.spot_market_vault.amount,
    )?;

    spot_market.validate_max_token_deposits_and_borrows(is_borrow)?;

    Ok(())
}

#[access_control(
    deposit_not_paused(&ctx.accounts.state)
    withdraw_not_paused(&ctx.accounts.state)
)]
pub fn handle_transfer_deposit<'c: 'info, 'info>(
    ctx: Context<'_, '_, 'c, 'info, TransferDeposit<'info>>,
    market_index: u16,
    amount: u64,
) -> anchor_lang::Result<()> {
    let authority_key = ctx.accounts.authority.key;
    let to_user_key = ctx.accounts.to_user.key();
    let from_user_key = ctx.accounts.from_user.key();

    let state = &ctx.accounts.state;
    let clock = Clock::get()?;
    let slot = clock.slot;

    let to_user = &mut load_mut!(ctx.accounts.to_user)?;
    let from_user = &mut load_mut!(ctx.accounts.from_user)?;
    let user_stats = &mut load_mut!(ctx.accounts.user_stats)?;

    let clock = Clock::get()?;
    let now = clock.unix_timestamp;

    validate!(
        !to_user.is_bankrupt(),
        ErrorCode::UserBankrupt,
        "to_user bankrupt"
    )?;

    validate!(
        !from_user.is_bankrupt(),
        ErrorCode::UserBankrupt,
        "from_user bankrupt"
    )?;

    validate!(
        from_user_key != to_user_key,
        ErrorCode::CantTransferBetweenSameUserAccount,
        "cant transfer between the same user account"
    )?;

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
        let oracle_price_data = oracle_map.get_price_data(&spot_market.oracle_id())?;
        controller::spot_balance::update_spot_market_cumulative_interest(
            spot_market,
            Some(oracle_price_data),
            clock.unix_timestamp,
        )?;
    }

    let oracle_price = {
        let spot_market = &spot_market_map.get_ref(&market_index)?;
        oracle_map.get_price_data(&spot_market.oracle_id())?.price
    };

    {
        let spot_market = &mut spot_market_map.get_ref_mut(&market_index)?;

        validate!(
            from_user.pool_id == spot_market.pool_id,
            ErrorCode::InvalidPoolId,
            "user pool id ({}) != market pool id ({})",
            from_user.pool_id,
            spot_market.pool_id
        )?;

        from_user.increment_total_withdraws(
            amount,
            oracle_price,
            spot_market.get_precision().cast()?,
        )?;

        // prevents withdraw when limits hit
        controller::spot_position::update_spot_balances_and_cumulative_deposits_with_limits(
            amount as u128,
            &SpotBalanceType::Borrow,
            spot_market,
            from_user,
        )?;
    }

    from_user.meets_withdraw_margin_requirement_and_increment_fuel_bonus(
        &perp_market_map,
        &spot_market_map,
        &mut oracle_map,
        MarginRequirementType::Initial,
        market_index,
        amount as u128,
        user_stats,
        now,
    )?;

    validate_spot_margin_trading(
        from_user,
        &perp_market_map,
        &spot_market_map,
        &mut oracle_map,
    )?;

    if from_user.is_being_liquidated() {
        from_user.exit_liquidation();
    }

    from_user.update_last_active_slot(slot);

    {
        let spot_market = &mut spot_market_map.get_ref_mut(&market_index)?;

        let deposit_record_id = get_then_update_id!(spot_market, next_deposit_record_id);
        let deposit_record = DepositRecord {
            ts: clock.unix_timestamp,
            deposit_record_id,
            user_authority: *authority_key,
            user: from_user_key,
            direction: DepositDirection::Withdraw,
            amount,
            oracle_price,
            market_index,
            market_deposit_balance: spot_market.deposit_balance,
            market_withdraw_balance: spot_market.borrow_balance,
            market_cumulative_deposit_interest: spot_market.cumulative_deposit_interest,
            market_cumulative_borrow_interest: spot_market.cumulative_borrow_interest,
            total_deposits_after: from_user.total_deposits,
            total_withdraws_after: from_user.total_withdraws,
            explanation: DepositExplanation::Transfer,
            transfer_user: Some(to_user_key),
        };
        emit!(deposit_record);
    }

    {
        let spot_market = &mut spot_market_map.get_ref_mut(&market_index)?;

        validate!(
            to_user.pool_id == spot_market.pool_id,
            ErrorCode::InvalidPoolId,
            "user pool id ({}) != market pool id ({})",
            to_user.pool_id,
            spot_market.pool_id
        )?;

        to_user.increment_total_deposits(
            amount,
            oracle_price,
            spot_market.get_precision().cast()?,
        )?;

        let total_deposits_after = to_user.total_deposits;
        let total_withdraws_after = to_user.total_withdraws;

        let to_spot_position = to_user.force_get_spot_position_mut(spot_market.market_index)?;

        controller::spot_position::update_spot_balances_and_cumulative_deposits(
            amount as u128,
            &SpotBalanceType::Deposit,
            spot_market,
            to_spot_position,
            false,
            None,
        )?;

        let token_amount = to_spot_position.get_token_amount(spot_market)?;
        if token_amount == 0 {
            validate!(
                to_spot_position.scaled_balance == 0,
                ErrorCode::InvalidSpotPosition,
                "deposit left to_user with invalid position. scaled balance = {} token amount = {}",
                to_spot_position.scaled_balance,
                token_amount
            )?;
        }

        let deposit_record_id = get_then_update_id!(spot_market, next_deposit_record_id);
        let deposit_record = DepositRecord {
            ts: clock.unix_timestamp,
            deposit_record_id,
            user_authority: *authority_key,
            user: to_user_key,
            direction: DepositDirection::Deposit,
            amount,
            oracle_price,
            market_index,
            market_deposit_balance: spot_market.deposit_balance,
            market_withdraw_balance: spot_market.borrow_balance,
            market_cumulative_deposit_interest: spot_market.cumulative_deposit_interest,
            market_cumulative_borrow_interest: spot_market.cumulative_borrow_interest,
            total_deposits_after,
            total_withdraws_after,
            explanation: DepositExplanation::Transfer,
            transfer_user: Some(from_user_key),
        };
        emit!(deposit_record);
    }

    to_user.update_last_active_slot(slot);

    let spot_market = spot_market_map.get_ref(&market_index)?;
    math::spot_withdraw::validate_spot_market_vault_amount(
        &spot_market,
        ctx.accounts.spot_market_vault.amount,
    )?;

    Ok(())
}

#[access_control(
    deposit_not_paused(&ctx.accounts.state)
    withdraw_not_paused(&ctx.accounts.state)
)]
pub fn handle_transfer_pools<'c: 'info, 'info>(
    ctx: Context<'_, '_, 'c, 'info, TransferPools<'info>>,
    deposit_from_market_index: u16,
    deposit_to_market_index: u16,
    borrow_from_market_index: u16,
    borrow_to_market_index: u16,
    deposit_amount: Option<u64>,
    borrow_amount: Option<u64>,
) -> anchor_lang::Result<()> {
    let authority_key = ctx.accounts.authority.key;
    let to_user_key = ctx.accounts.to_user.key();
    let from_user_key = ctx.accounts.from_user.key();

    let state = &ctx.accounts.state;
    let clock = Clock::get()?;
    let slot = clock.slot;

    let to_user = &mut load_mut!(ctx.accounts.to_user)?;
    let from_user = &mut load_mut!(ctx.accounts.from_user)?;
    let user_stats = &mut load_mut!(ctx.accounts.user_stats)?;

    let clock = Clock::get()?;

    validate!(
        !to_user.is_bankrupt(),
        ErrorCode::UserBankrupt,
        "to_user bankrupt"
    )?;
    validate!(
        !from_user.is_bankrupt(),
        ErrorCode::UserBankrupt,
        "from_user bankrupt"
    )?;

    validate!(
        from_user_key != to_user_key,
        ErrorCode::CantTransferBetweenSameUserAccount,
        "cant transfer between the same user account"
    )?;

    validate!(
        from_user.pool_id != to_user.pool_id,
        ErrorCode::InvalidPoolId,
        "cant transfer between the same pool"
    )?;

    let AccountMaps {
        perp_market_map,
        spot_market_map,
        mut oracle_map,
    } = load_maps(
        &mut ctx.remaining_accounts.iter().peekable(),
        &MarketSet::new(),
        &get_writable_spot_market_set_from_many(vec![
            deposit_from_market_index,
            deposit_to_market_index,
            borrow_from_market_index,
            borrow_to_market_index,
        ]),
        clock.slot,
        Some(state.oracle_guard_rails),
    )?;

    let mut deposit_from_spot_market = spot_market_map.get_ref_mut(&deposit_from_market_index)?;
    let mut deposit_to_spot_market = spot_market_map.get_ref_mut(&deposit_to_market_index)?;
    let mut borrow_from_spot_market = spot_market_map.get_ref_mut(&borrow_from_market_index)?;
    let mut borrow_to_spot_market = spot_market_map.get_ref_mut(&borrow_to_market_index)?;

    validate!(
        deposit_from_spot_market.mint == deposit_to_spot_market.mint,
        ErrorCode::InvalidPoolId,
        "deposit from and to spot markets must have the same mint"
    )?;

    validate!(
        borrow_from_spot_market.mint == borrow_to_spot_market.mint,
        ErrorCode::InvalidPoolId,
        "borrow from and to spot markets must have the same mint"
    )?;

    validate!(
        deposit_from_spot_market.pool_id == borrow_from_spot_market.pool_id,
        ErrorCode::InvalidPoolId,
        "deposit from and borrow from spot markets must have the same pool id"
    )?;

    validate!(
        deposit_to_spot_market.pool_id == borrow_to_spot_market.pool_id,
        ErrorCode::InvalidPoolId,
        "deposit to and borrow to spot markets must have the same pool id"
    )?;

    validate!(
        deposit_from_spot_market.pool_id != deposit_to_spot_market.pool_id,
        ErrorCode::InvalidPoolId,
        "deposit from and to spot markets must have different pool ids"
    )?;

    let deposit_from_oracle_price_data =
        *oracle_map.get_price_data(&deposit_from_spot_market.oracle_id())?;
    let deposit_to_oracle_price_data =
        *oracle_map.get_price_data(&deposit_to_spot_market.oracle_id())?;
    let borrow_from_oracle_price_data =
        *oracle_map.get_price_data(&borrow_from_spot_market.oracle_id())?;
    let borrow_to_oracle_price_data =
        *oracle_map.get_price_data(&borrow_to_spot_market.oracle_id())?;

    controller::spot_balance::update_spot_market_cumulative_interest(
        &mut deposit_from_spot_market,
        Some(&deposit_from_oracle_price_data),
        clock.unix_timestamp,
    )?;

    controller::spot_balance::update_spot_market_cumulative_interest(
        &mut deposit_to_spot_market,
        Some(&deposit_to_oracle_price_data),
        clock.unix_timestamp,
    )?;

    controller::spot_balance::update_spot_market_cumulative_interest(
        &mut borrow_from_spot_market,
        Some(&borrow_from_oracle_price_data),
        clock.unix_timestamp,
    )?;

    controller::spot_balance::update_spot_market_cumulative_interest(
        &mut borrow_to_spot_market,
        Some(&borrow_to_oracle_price_data),
        clock.unix_timestamp,
    )?;

    let deposit_transfer = if let Some(0) = deposit_amount {
        0_u64
    } else {
        let spot_position = from_user.force_get_spot_position_mut(deposit_from_market_index)?;
        validate!(
            spot_position.balance_type == SpotBalanceType::Deposit,
            ErrorCode::InvalidSpotPosition,
            "deposit from market must be a deposit spot position"
        )?;

        let token_amount = spot_position
            .get_token_amount(&deposit_from_spot_market)?
            .cast::<u64>()?;

        let amount = match deposit_amount {
            Some(amount) => amount,
            None => token_amount,
        };

        validate!(
            amount <= token_amount,
            ErrorCode::InvalidSpotPosition,
            "deposit amount is greater than the spot position token amount"
        )?;

        amount
    };

    if deposit_transfer > 0 {
        from_user.increment_total_withdraws(
            deposit_transfer,
            deposit_from_oracle_price_data.price,
            deposit_from_spot_market.get_precision().cast()?,
        )?;

        controller::spot_position::update_spot_balances_and_cumulative_deposits_with_limits(
            deposit_transfer as u128,
            &SpotBalanceType::Borrow,
            &mut deposit_from_spot_market,
            from_user,
        )?;

        let deposit_record_id =
            get_then_update_id!(deposit_from_spot_market, next_deposit_record_id);
        let deposit_record = DepositRecord {
            ts: clock.unix_timestamp,
            deposit_record_id,
            user_authority: *authority_key,
            user: from_user_key,
            direction: DepositDirection::Withdraw,
            amount: deposit_transfer,
            oracle_price: deposit_from_oracle_price_data.price,
            market_index: deposit_from_market_index,
            market_deposit_balance: deposit_from_spot_market.deposit_balance,
            market_withdraw_balance: deposit_from_spot_market.borrow_balance,
            market_cumulative_deposit_interest: deposit_from_spot_market
                .cumulative_deposit_interest,
            market_cumulative_borrow_interest: deposit_from_spot_market.cumulative_borrow_interest,
            total_deposits_after: from_user.total_deposits,
            total_withdraws_after: from_user.total_withdraws,
            explanation: DepositExplanation::Transfer,
            transfer_user: Some(to_user_key),
        };
        emit!(deposit_record);

        to_user.increment_total_deposits(
            deposit_transfer,
            deposit_to_oracle_price_data.price,
            deposit_to_spot_market.get_precision().cast()?,
        )?;

        controller::spot_position::update_spot_balances_and_cumulative_deposits_with_limits(
            deposit_transfer as u128,
            &SpotBalanceType::Deposit,
            &mut deposit_to_spot_market,
            to_user,
        )?;

        let deposit_record_id = get_then_update_id!(deposit_to_spot_market, next_deposit_record_id);
        let deposit_record = DepositRecord {
            ts: clock.unix_timestamp,
            deposit_record_id,
            user_authority: *authority_key,
            user: to_user_key,
            direction: DepositDirection::Deposit,
            amount: deposit_transfer,
            oracle_price: deposit_to_oracle_price_data.price,
            market_index: deposit_to_market_index,
            market_deposit_balance: deposit_to_spot_market.deposit_balance,
            market_withdraw_balance: deposit_to_spot_market.borrow_balance,
            market_cumulative_deposit_interest: deposit_to_spot_market.cumulative_deposit_interest,
            market_cumulative_borrow_interest: deposit_to_spot_market.cumulative_borrow_interest,
            total_deposits_after: to_user.total_deposits,
            total_withdraws_after: to_user.total_withdraws,
            explanation: DepositExplanation::Transfer,
            transfer_user: Some(from_user_key),
        };
        emit!(deposit_record);
    }

    let borrow_transfer = if let Some(0) = borrow_amount {
        0_u64
    } else {
        let spot_position = from_user.force_get_spot_position_mut(borrow_from_market_index)?;

        validate!(
            spot_position.balance_type == SpotBalanceType::Borrow,
            ErrorCode::InvalidSpotPosition,
            "borrow from market must be a borrow spot position"
        )?;

        let token_amount = spot_position
            .get_token_amount(&borrow_from_spot_market)?
            .cast::<u64>()?;

        let amount = match borrow_amount {
            Some(amount) => amount,
            None => token_amount,
        };

        validate!(
            amount <= token_amount,
            ErrorCode::InvalidSpotPosition,
            "borrow amount is greater than the spot position token amount"
        )?;

        amount
    };

    if borrow_transfer > 0 {
        from_user.increment_total_deposits(
            borrow_transfer,
            borrow_from_oracle_price_data.price,
            borrow_from_spot_market.get_precision().cast()?,
        )?;

        controller::spot_position::update_spot_balances_and_cumulative_deposits_with_limits(
            borrow_transfer as u128,
            &SpotBalanceType::Deposit,
            &mut borrow_from_spot_market,
            from_user,
        )?;

        let deposit_record_id =
            get_then_update_id!(borrow_from_spot_market, next_deposit_record_id);
        let deposit_record = DepositRecord {
            ts: clock.unix_timestamp,
            deposit_record_id,
            user_authority: *authority_key,
            user: from_user_key,
            direction: DepositDirection::Deposit,
            amount: borrow_transfer,
            oracle_price: borrow_from_oracle_price_data.price,
            market_index: borrow_from_market_index,
            market_deposit_balance: borrow_from_spot_market.deposit_balance,
            market_withdraw_balance: borrow_from_spot_market.borrow_balance,
            market_cumulative_deposit_interest: borrow_from_spot_market.cumulative_deposit_interest,
            market_cumulative_borrow_interest: borrow_from_spot_market.cumulative_borrow_interest,
            total_deposits_after: from_user.total_deposits,
            total_withdraws_after: from_user.total_withdraws,
            explanation: DepositExplanation::Transfer,
            transfer_user: Some(to_user_key),
        };
        emit!(deposit_record);

        to_user.increment_total_withdraws(
            borrow_transfer,
            borrow_to_oracle_price_data.price,
            borrow_to_spot_market.get_precision().cast()?,
        )?;

        controller::spot_position::update_spot_balances_and_cumulative_deposits_with_limits(
            borrow_transfer as u128,
            &SpotBalanceType::Borrow,
            &mut borrow_to_spot_market,
            to_user,
        )?;

        let deposit_record_id = get_then_update_id!(borrow_to_spot_market, next_deposit_record_id);
        let deposit_record = DepositRecord {
            ts: clock.unix_timestamp,
            deposit_record_id,
            user_authority: *authority_key,
            user: to_user_key,
            direction: DepositDirection::Withdraw,
            amount: borrow_transfer,
            oracle_price: borrow_to_oracle_price_data.price,
            market_index: borrow_to_market_index,
            market_deposit_balance: borrow_to_spot_market.deposit_balance,
            market_withdraw_balance: borrow_to_spot_market.borrow_balance,
            market_cumulative_deposit_interest: borrow_to_spot_market.cumulative_deposit_interest,
            market_cumulative_borrow_interest: borrow_to_spot_market.cumulative_borrow_interest,
            total_deposits_after: to_user.total_deposits,
            total_withdraws_after: to_user.total_withdraws,
            explanation: DepositExplanation::Transfer,
            transfer_user: Some(from_user_key),
        };
        emit!(deposit_record);
    }

    drop(deposit_from_spot_market);
    drop(deposit_to_spot_market);
    drop(borrow_from_spot_market);
    drop(borrow_to_spot_market);

    from_user.meets_withdraw_margin_requirement_and_increment_fuel_bonus_swap(
        &perp_market_map,
        &spot_market_map,
        &mut oracle_map,
        MarginRequirementType::Initial,
        deposit_from_market_index,
        deposit_transfer.cast::<i128>()?,
        borrow_from_market_index,
        -borrow_transfer.cast::<i128>()?,
        user_stats,
        clock.unix_timestamp,
    )?;

    to_user.meets_withdraw_margin_requirement_and_increment_fuel_bonus_swap(
        &perp_market_map,
        &spot_market_map,
        &mut oracle_map,
        MarginRequirementType::Initial,
        deposit_to_market_index,
        -deposit_transfer.cast::<i128>()?,
        borrow_to_market_index,
        borrow_transfer.cast::<i128>()?,
        user_stats,
        clock.unix_timestamp,
    )?;

    validate_spot_margin_trading(
        from_user,
        &perp_market_map,
        &spot_market_map,
        &mut oracle_map,
    )?;

    from_user.update_last_active_slot(slot);

    validate_spot_margin_trading(to_user, &perp_market_map, &spot_market_map, &mut oracle_map)?;

    to_user.update_last_active_slot(slot);

    if from_user.is_being_liquidated() {
        from_user.exit_liquidation();
    }

    if to_user.is_being_liquidated() {
        to_user.exit_liquidation();
    }

    let deposit_from_spot_market = spot_market_map.get_ref(&deposit_from_market_index)?;
    let deposit_to_spot_market = spot_market_map.get_ref(&deposit_to_market_index)?;
    let borrow_from_spot_market = spot_market_map.get_ref(&borrow_from_market_index)?;
    let borrow_to_spot_market = spot_market_map.get_ref(&borrow_to_market_index)?;

    if deposit_transfer > 0 {
        let token_program_pubkey = deposit_from_spot_market.get_token_program();
        let token_program = &ctx
            .remaining_accounts
            .iter()
            .find(|acc| acc.key() == token_program_pubkey)
            .map(|acc| Interface::try_from(acc))
            .unwrap()
            .unwrap();

        let spot_market_mint = &deposit_from_spot_market.mint;
        let mint_account_info = ctx
            .remaining_accounts
            .iter()
            .find(|acc| acc.key() == spot_market_mint.key())
            .map(|acc| InterfaceAccount::try_from(acc).unwrap());

        controller::token::send_from_program_vault(
            token_program,
            &ctx.accounts.deposit_from_spot_market_vault,
            &ctx.accounts.deposit_to_spot_market_vault,
            &ctx.accounts.drift_signer,
            state.signer_nonce,
            deposit_transfer,
            &mint_account_info,
        )?;
    }

    if borrow_transfer > 0 {
        let token_program_pubkey = borrow_to_spot_market.get_token_program();
        let token_program = &ctx
            .remaining_accounts
            .iter()
            .find(|acc| acc.key() == token_program_pubkey)
            .map(|acc| Interface::try_from(acc))
            .unwrap()
            .unwrap();

        let spot_market_mint = &borrow_to_spot_market.mint;
        let mint_account_info = ctx
            .remaining_accounts
            .iter()
            .find(|acc| acc.key() == spot_market_mint.key())
            .map(|acc| InterfaceAccount::try_from(acc).unwrap());

        controller::token::send_from_program_vault(
            token_program,
            &ctx.accounts.borrow_to_spot_market_vault,
            &ctx.accounts.borrow_from_spot_market_vault,
            &ctx.accounts.drift_signer,
            state.signer_nonce,
            borrow_transfer,
            &mint_account_info,
        )?;
    }

    ctx.accounts.deposit_from_spot_market_vault.reload()?;
    math::spot_withdraw::validate_spot_market_vault_amount(
        &deposit_from_spot_market,
        ctx.accounts.deposit_from_spot_market_vault.amount,
    )?;

    ctx.accounts.deposit_to_spot_market_vault.reload()?;
    math::spot_withdraw::validate_spot_market_vault_amount(
        &deposit_to_spot_market,
        ctx.accounts.deposit_to_spot_market_vault.amount,
    )?;

    ctx.accounts.borrow_from_spot_market_vault.reload()?;
    math::spot_withdraw::validate_spot_market_vault_amount(
        &borrow_from_spot_market,
        ctx.accounts.borrow_from_spot_market_vault.amount,
    )?;

    ctx.accounts.borrow_to_spot_market_vault.reload()?;
    math::spot_withdraw::validate_spot_market_vault_amount(
        &borrow_to_spot_market,
        ctx.accounts.borrow_to_spot_market_vault.amount,
    )?;

    Ok(())
}

#[access_control(
    fill_not_paused(&ctx.accounts.state)
)]
pub fn handle_transfer_perp_position<'c: 'info, 'info>(
    ctx: Context<'_, '_, 'c, 'info, TransferPerpPosition<'info>>,
    market_index: u16,
    amount: Option<i64>,
) -> anchor_lang::Result<()> {
    let to_user_key = ctx.accounts.to_user.key();
    let from_user_key = ctx.accounts.from_user.key();

    let state = &ctx.accounts.state;
    let clock = Clock::get()?;
    let slot = clock.slot;

    let mut to_user = &mut load_mut!(ctx.accounts.to_user)?;
    let mut from_user = &mut load_mut!(ctx.accounts.from_user)?;

    let clock = Clock::get()?;
    let now = clock.unix_timestamp;

    validate!(
        !to_user.is_bankrupt(),
        ErrorCode::UserBankrupt,
        "to_user bankrupt"
    )?;

    validate!(
        !from_user.is_bankrupt(),
        ErrorCode::UserBankrupt,
        "from_user bankrupt"
    )?;

    validate!(
        from_user_key != to_user_key,
        ErrorCode::CantTransferBetweenSameUserAccount,
        "cant transfer between the same user account"
    )?;

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

    controller::repeg::update_amm(
        market_index,
        &perp_market_map,
        &mut oracle_map,
        &ctx.accounts.state,
        &clock,
    )?;

    controller::lp::settle_funding_payment_then_lp(
        &mut from_user,
        &from_user_key,
        perp_market_map.get_ref_mut(&market_index)?.deref_mut(),
        now,
    )?;

    controller::lp::settle_funding_payment_then_lp(
        &mut to_user,
        &to_user_key,
        perp_market_map.get_ref_mut(&market_index)?.deref_mut(),
        now,
    )?;

    let oi_before;
    let oracle_price;
    let step_size;
    let tick_size;
    {
        let perp_market = perp_market_map.get_ref(&market_index)?;
        oi_before = perp_market.get_open_interest();
        let (oracle_price_data, oracle_validity) = oracle_map.get_price_data_and_validity(
            MarketType::Perp,
            market_index,
            &perp_market.oracle_id(),
            perp_market
                .amm
                .historical_oracle_data
                .last_oracle_price_twap,
            perp_market.get_max_confidence_interval_multiplier()?,
        )?;
        step_size = perp_market.amm.order_step_size;
        tick_size = perp_market.amm.order_tick_size;

        validate!(
            is_oracle_valid_for_action(oracle_validity, Some(DriftAction::MarginCalc))?,
            ErrorCode::InvalidTransferPerpPosition,
            "oracle is not valid for action"
        )?;

        validate!(
            !perp_market.is_operation_paused(PerpOperation::Fill),
            ErrorCode::InvalidTransferPerpPosition,
            "perp market fills paused"
        )?;

        oracle_price = oracle_price_data.price;
    }

    let (transfer_amount, direction_to_close) = if let Some(amount) = amount {
        let existing_position = from_user.force_get_perp_position_mut(market_index)?;
        let existing_base_asset_amount = existing_position.base_asset_amount;

        validate!(
            amount.signum() == existing_base_asset_amount.signum(),
            ErrorCode::InvalidTransferPerpPosition,
            "transfer perp position must reduce position (direction is opposite)"
        )?;

        validate!(
            amount.abs() <= existing_base_asset_amount.abs(),
            ErrorCode::InvalidTransferPerpPosition,
            "transfer perp position amount is greater than existing position"
        )?;

        validate!(
            is_multiple_of_step_size(amount.unsigned_abs(), step_size)?,
            ErrorCode::InvalidTransferPerpPosition,
            "transfer perp position amount is not a multiple of step size"
        )?;

        (amount, existing_position.get_direction_to_close())
    } else {
        let position = from_user.force_get_perp_position_mut(market_index)?;

        validate!(
            position.base_asset_amount != 0,
            ErrorCode::InvalidTransferPerpPosition,
            "from user has no position"
        )?;

        (
            position.base_asset_amount,
            position.get_direction_to_close(),
        )
    };

    let transfer_price =
        standardize_price_i64(oracle_price, tick_size.cast()?, direction_to_close)?;

    let base_asset_value = calculate_base_asset_value_with_oracle_price(
        transfer_amount.cast::<i128>()?,
        transfer_price,
    )?
    .cast::<u64>()?;

    let transfer_amount_abs = transfer_amount.unsigned_abs();

    let from_user_position_delta =
        get_position_delta_for_fill(transfer_amount_abs, base_asset_value, direction_to_close)?;

    let to_user_position_delta = get_position_delta_for_fill(
        transfer_amount_abs,
        base_asset_value,
        direction_to_close.opposite(),
    )?;

    let to_user_existing_position_direction = to_user
        .force_get_perp_position_mut(market_index)
        .map(|position| position.get_direction())?;

    {
        let mut market = perp_market_map.get_ref_mut(&market_index)?;

        let from_user_position = from_user.force_get_perp_position_mut(market_index)?;

        update_position_and_market(from_user_position, &mut market, &from_user_position_delta)?;

        let to_user_position = to_user.force_get_perp_position_mut(market_index)?;

        update_position_and_market(to_user_position, &mut market, &to_user_position_delta)?;

        validate_perp_position_with_perp_market(from_user_position, &market)?;
        validate_perp_position_with_perp_market(to_user_position, &market)?;
    }

    let from_user_margin_calculation =
        calculate_margin_requirement_and_total_collateral_and_liability_info(
            &from_user,
            &perp_market_map,
            &spot_market_map,
            &mut oracle_map,
            MarginContext::standard(MarginRequirementType::Maintenance)
                .fuel_perp_delta(market_index, transfer_amount),
        )?;

    validate!(
        from_user_margin_calculation.meets_margin_requirement(),
        ErrorCode::InsufficientCollateral,
        "from user margin requirement is greater than total collateral"
    )?;

    let to_user_margin_requirement =
        calculate_margin_requirement_and_total_collateral_and_liability_info(
            &to_user,
            &perp_market_map,
            &spot_market_map,
            &mut oracle_map,
            MarginContext::standard(MarginRequirementType::Initial)
                .fuel_perp_delta(market_index, -transfer_amount),
        )?;

    validate!(
        to_user_margin_requirement.meets_margin_requirement(),
        ErrorCode::InsufficientCollateral,
        "to user margin requirement is greater than total collateral"
    )?;

    let mut perp_market = perp_market_map.get_ref_mut(&market_index)?;
    let oi_after = perp_market.get_open_interest();

    validate!(
        oi_after <= oi_before,
        ErrorCode::InvalidTransferPerpPosition,
        "open interest must not increase after transfer. oi_before: {}, oi_after: {}",
        oi_before,
        oi_after
    )?;

    from_user.update_last_active_slot(slot);
    to_user.update_last_active_slot(slot);

    let from_user_order_id = get_then_update_id!(from_user, next_order_id);
    let from_user_order = Order {
        slot,
        base_asset_amount: transfer_amount_abs,
        order_id: from_user_order_id,
        market_index,
        status: OrderStatus::Open,
        order_type: OrderType::Limit,
        market_type: MarketType::Perp,
        price: transfer_price.unsigned_abs(),
        direction: direction_to_close,
        existing_position_direction: direction_to_close.opposite(),
        ..Order::default()
    };

    emit_stack::<_, { OrderRecord::SIZE }>(OrderRecord {
        ts: now,
        user: from_user_key,
        order: from_user_order,
    })?;

    let to_user_order_id = get_then_update_id!(to_user, next_order_id);
    let to_user_order = Order {
        slot,
        base_asset_amount: transfer_amount_abs,
        order_id: to_user_order_id,
        market_index,
        status: OrderStatus::Open,
        order_type: OrderType::Limit,
        market_type: MarketType::Perp,
        price: transfer_price.unsigned_abs(),
        direction: direction_to_close.opposite(),
        existing_position_direction: to_user_existing_position_direction,
        ..Order::default()
    };

    emit_stack::<_, { OrderRecord::SIZE }>(OrderRecord {
        ts: now,
        user: to_user_key,
        order: to_user_order,
    })?;

    let fill_record_id = get_then_update_id!(perp_market, next_fill_record_id);

    let fill_record = OrderActionRecord {
        ts: now,
        action: OrderAction::Fill,
        action_explanation: OrderActionExplanation::TransferPerpPosition,
        market_index,
        market_type: MarketType::Perp,
        filler: None,
        filler_reward: None,
        fill_record_id: Some(fill_record_id),
        base_asset_amount_filled: Some(transfer_amount_abs),
        quote_asset_amount_filled: Some(base_asset_value),
        taker_fee: None,
        maker_fee: None,
        referrer_reward: None,
        quote_asset_amount_surplus: None,
        spot_fulfillment_method_fee: None,
        taker: Some(to_user_key),
        taker_order_id: Some(to_user_order_id),
        taker_order_direction: Some(direction_to_close.opposite()),
        taker_order_base_asset_amount: Some(transfer_amount_abs),
        taker_order_cumulative_base_asset_amount_filled: Some(transfer_amount_abs),
        taker_order_cumulative_quote_asset_amount_filled: Some(base_asset_value),
        maker: Some(from_user_key),
        maker_order_id: Some(from_user_order_id),
        maker_order_direction: Some(direction_to_close),
        maker_order_base_asset_amount: Some(transfer_amount_abs),
        maker_order_cumulative_base_asset_amount_filled: Some(transfer_amount_abs),
        maker_order_cumulative_quote_asset_amount_filled: Some(base_asset_value),
        oracle_price,
        bit_flags: 0,
    };

    emit_stack::<_, { OrderActionRecord::SIZE }>(fill_record)?;

    Ok(())
}

#[access_control(
    exchange_not_paused(&ctx.accounts.state)
)]
pub fn handle_place_perp_order<'c: 'info, 'info>(
    ctx: Context<'_, '_, 'c, 'info, PlaceOrder>,
    params: OrderParams,
) -> Result<()> {
    let clock = &Clock::get()?;
    let state = &ctx.accounts.state;

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

    if params.immediate_or_cancel {
        msg!("immediate_or_cancel order must be in place_and_make or place_and_take");
        return Err(print_error!(ErrorCode::InvalidOrderIOC)().into());
    }

    let user_key = ctx.accounts.user.key();
    let mut user = load_mut!(ctx.accounts.user)?;

    controller::orders::place_perp_order(
        &ctx.accounts.state,
        &mut user,
        user_key,
        &perp_market_map,
        &spot_market_map,
        &mut oracle_map,
        clock,
        params,
        PlaceOrderOptions::default(),
    )?;

    Ok(())
}

#[access_control(
    exchange_not_paused(&ctx.accounts.state)
)]
pub fn handle_cancel_order<'c: 'info, 'info>(
    ctx: Context<'_, '_, 'c, 'info, CancelOrder>,
    order_id: Option<u32>,
) -> Result<()> {
    let clock = &Clock::get()?;
    let state = &ctx.accounts.state;

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

    let order_id = match order_id {
        Some(order_id) => order_id,
        None => load!(ctx.accounts.user)?.get_last_order_id(),
    };

    controller::orders::cancel_order_by_order_id(
        order_id,
        &ctx.accounts.user,
        &perp_market_map,
        &spot_market_map,
        &mut oracle_map,
        clock,
    )?;

    Ok(())
}

#[access_control(
    exchange_not_paused(&ctx.accounts.state)
)]
pub fn handle_cancel_order_by_user_id<'c: 'info, 'info>(
    ctx: Context<'_, '_, 'c, 'info, CancelOrder>,
    user_order_id: u8,
) -> Result<()> {
    let clock = &Clock::get()?;
    let state = &ctx.accounts.state;

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

    controller::orders::cancel_order_by_user_order_id(
        user_order_id,
        &ctx.accounts.user,
        &perp_market_map,
        &spot_market_map,
        &mut oracle_map,
        clock,
    )?;

    Ok(())
}

#[access_control(
    exchange_not_paused(&ctx.accounts.state)
)]
pub fn handle_cancel_orders_by_ids<'c: 'info, 'info>(
    ctx: Context<'_, '_, 'c, 'info, CancelOrder>,
    order_ids: Vec<u32>,
) -> Result<()> {
    let clock = &Clock::get()?;
    let state = &ctx.accounts.state;

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

    for order_id in order_ids {
        controller::orders::cancel_order_by_order_id(
            order_id,
            &ctx.accounts.user,
            &perp_market_map,
            &spot_market_map,
            &mut oracle_map,
            clock,
        )?;
    }

    Ok(())
}

#[access_control(
    exchange_not_paused(&ctx.accounts.state)
)]
pub fn handle_cancel_orders<'c: 'info, 'info>(
    ctx: Context<'_, '_, 'c, 'info, CancelOrder<'info>>,
    market_type: Option<MarketType>,
    market_index: Option<u16>,
    direction: Option<PositionDirection>,
) -> Result<()> {
    let clock = &Clock::get()?;
    let state = &ctx.accounts.state;

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

    let user_key = ctx.accounts.user.key();
    let mut user = load_mut!(ctx.accounts.user)?;

    cancel_orders(
        &mut user,
        &user_key,
        None,
        &perp_market_map,
        &spot_market_map,
        &mut oracle_map,
        clock.unix_timestamp,
        clock.slot,
        OrderActionExplanation::None,
        market_type,
        market_index,
        direction,
    )?;

    Ok(())
}

#[access_control(
    exchange_not_paused(&ctx.accounts.state)
)]
pub fn handle_modify_order<'c: 'info, 'info>(
    ctx: Context<'_, '_, 'c, 'info, CancelOrder<'info>>,
    order_id: Option<u32>,
    modify_order_params: ModifyOrderParams,
) -> Result<()> {
    let clock = &Clock::get()?;
    let state = &ctx.accounts.state;

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

    let order_id = match order_id {
        Some(order_id) => order_id,
        None => load!(ctx.accounts.user)?.get_last_order_id(),
    };

    controller::orders::modify_order(
        ModifyOrderId::OrderId(order_id),
        modify_order_params,
        &ctx.accounts.user,
        state,
        &perp_market_map,
        &spot_market_map,
        &mut oracle_map,
        clock,
    )?;

    Ok(())
}

#[access_control(
    exchange_not_paused(&ctx.accounts.state)
)]
pub fn handle_modify_order_by_user_order_id<'c: 'info, 'info>(
    ctx: Context<'_, '_, 'c, 'info, CancelOrder<'info>>,
    user_order_id: u8,
    modify_order_params: ModifyOrderParams,
) -> Result<()> {
    let clock = &Clock::get()?;
    let state = &ctx.accounts.state;

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

    controller::orders::modify_order(
        ModifyOrderId::UserOrderId(user_order_id),
        modify_order_params,
        &ctx.accounts.user,
        state,
        &perp_market_map,
        &spot_market_map,
        &mut oracle_map,
        clock,
    )?;

    Ok(())
}

#[access_control(
    exchange_not_paused(&ctx.accounts.state)
)]
pub fn handle_place_orders<'c: 'info, 'info>(
    ctx: Context<'_, '_, 'c, 'info, PlaceOrder>,
    params: Vec<OrderParams>,
) -> Result<()> {
    let clock = &Clock::get()?;
    let state = &ctx.accounts.state;

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

    validate!(
        params.len() <= 32,
        ErrorCode::DefaultError,
        "max 32 order params"
    )?;

    let user_key = ctx.accounts.user.key();
    let mut user = load_mut!(ctx.accounts.user)?;

    let num_orders = params.len();
    for (i, params) in params.iter().enumerate() {
        validate!(
            !params.immediate_or_cancel,
            ErrorCode::InvalidOrderIOC,
            "immediate_or_cancel order must be in place_and_make or place_and_take"
        )?;

        // only enforce margin on last order and only try to expire on first order
        let options = PlaceOrderOptions {
            signed_msg_taker_order_slot: None,
            enforce_margin_check: i == num_orders - 1,
            try_expire_orders: i == 0,
            risk_increasing: false,
            explanation: OrderActionExplanation::None,
            existing_position_direction_override: None,
        };

        if params.market_type == MarketType::Perp {
            controller::orders::place_perp_order(
                &ctx.accounts.state,
                &mut user,
                user_key,
                &perp_market_map,
                &spot_market_map,
                &mut oracle_map,
                clock,
                *params,
                options,
            )?;
        } else {
            controller::orders::place_spot_order(
                &ctx.accounts.state,
                &mut user,
                user_key,
                &perp_market_map,
                &spot_market_map,
                &mut oracle_map,
                clock,
                *params,
                options,
            )?;
        }
    }

    Ok(())
}

#[access_control(
    fill_not_paused(&ctx.accounts.state)
)]
pub fn handle_place_and_take_perp_order<'c: 'info, 'info>(
    ctx: Context<'_, '_, 'c, 'info, PlaceAndTake<'info>>,
    params: OrderParams,
    optional_params: Option<u32>, // u32 for backwards compatibility
) -> Result<()> {
    let clock = Clock::get()?;
    let state = &ctx.accounts.state;

    let remaining_accounts_iter = &mut ctx.remaining_accounts.iter().peekable();
    let AccountMaps {
        perp_market_map,
        spot_market_map,
        mut oracle_map,
    } = load_maps(
        remaining_accounts_iter,
        &get_writable_perp_market_set(params.market_index),
        &MarketSet::new(),
        clock.slot,
        Some(state.oracle_guard_rails),
    )?;

    if params.post_only != PostOnlyParam::None {
        msg!("post_only cant be used in place_and_take");
        return Err(print_error!(ErrorCode::InvalidOrderPostOnly)().into());
    }

    let (makers_and_referrer, makers_and_referrer_stats) =
        load_user_maps(remaining_accounts_iter, true)?;

    let is_immediate_or_cancel = params.immediate_or_cancel;

    controller::repeg::update_amm(
        params.market_index,
        &perp_market_map,
        &mut oracle_map,
        &ctx.accounts.state,
        &Clock::get()?,
    )?;

    let user_key = ctx.accounts.user.key();
    let mut user = load_mut!(ctx.accounts.user)?;
    let clock = Clock::get()?;

    let (success_condition, auction_duration_percentage) = parse_optional_params(optional_params);

    controller::orders::place_perp_order(
        &ctx.accounts.state,
        &mut user,
        user_key,
        &perp_market_map,
        &spot_market_map,
        &mut oracle_map,
        &clock,
        params,
        PlaceOrderOptions::default(),
    )?;

    drop(user);

    let user = &mut ctx.accounts.user;
    let order_id = load!(user)?.get_last_order_id();

    let (base_asset_amount_filled, _) = controller::orders::fill_perp_order(
        order_id,
        &ctx.accounts.state,
        user,
        &ctx.accounts.user_stats,
        &spot_market_map,
        &perp_market_map,
        &mut oracle_map,
        &user.clone(),
        &ctx.accounts.user_stats.clone(),
        &makers_and_referrer,
        &makers_and_referrer_stats,
        None,
        &Clock::get()?,
        FillMode::PlaceAndTake(
            is_immediate_or_cancel || optional_params.is_some(),
            auction_duration_percentage,
        ),
    )?;

    let order_unfilled = load!(ctx.accounts.user)?
        .orders
        .iter()
        .any(|order| order.order_id == order_id && order.status == OrderStatus::Open);

    if is_immediate_or_cancel && order_unfilled {
        controller::orders::cancel_order_by_order_id(
            order_id,
            &ctx.accounts.user,
            &perp_market_map,
            &spot_market_map,
            &mut oracle_map,
            &Clock::get()?,
        )?;
    }

    if success_condition == PlaceAndTakeOrderSuccessCondition::PartialFill as u8 {
        validate!(
            base_asset_amount_filled > 0,
            ErrorCode::PlaceAndTakeOrderSuccessConditionFailed,
            "no partial fill"
        )?;
    } else if success_condition == PlaceAndTakeOrderSuccessCondition::FullFill as u8 {
        validate!(
            base_asset_amount_filled > 0 && !order_unfilled,
            ErrorCode::PlaceAndTakeOrderSuccessConditionFailed,
            "no full fill"
        )?;
    }

    Ok(())
}

#[access_control(
    fill_not_paused(&ctx.accounts.state)
)]
pub fn handle_place_and_make_perp_order<'c: 'info, 'info>(
    ctx: Context<'_, '_, 'c, 'info, PlaceAndMake<'info>>,
    params: OrderParams,
    taker_order_id: u32,
) -> Result<()> {
    let clock = &Clock::get()?;
    let state = &ctx.accounts.state;

    let remaining_accounts_iter = &mut ctx.remaining_accounts.iter().peekable();
    let AccountMaps {
        perp_market_map,
        spot_market_map,
        mut oracle_map,
    } = load_maps(
        remaining_accounts_iter,
        &get_writable_perp_market_set(params.market_index),
        &MarketSet::new(),
        Clock::get()?.slot,
        Some(state.oracle_guard_rails),
    )?;

    if !params.immediate_or_cancel
        || params.post_only == PostOnlyParam::None
        || params.order_type != OrderType::Limit
    {
        msg!("place_and_make must use IOC post only limit order");
        return Err(print_error!(ErrorCode::InvalidOrderIOCPostOnly)().into());
    }

    controller::repeg::update_amm(
        params.market_index,
        &perp_market_map,
        &mut oracle_map,
        state,
        clock,
    )?;

    let user_key = ctx.accounts.user.key();
    let mut user = load_mut!(ctx.accounts.user)?;

    controller::orders::place_perp_order(
        state,
        &mut user,
        user_key,
        &perp_market_map,
        &spot_market_map,
        &mut oracle_map,
        clock,
        params,
        PlaceOrderOptions::default(),
    )?;

    let (order_id, authority) = (user.get_last_order_id(), user.authority);

    drop(user);

    let (mut makers_and_referrer, mut makers_and_referrer_stats) =
        load_user_maps(remaining_accounts_iter, true)?;
    makers_and_referrer.insert(ctx.accounts.user.key(), ctx.accounts.user.clone())?;
    makers_and_referrer_stats.insert(authority, ctx.accounts.user_stats.clone())?;

    controller::orders::fill_perp_order(
        taker_order_id,
        state,
        &ctx.accounts.taker,
        &ctx.accounts.taker_stats,
        &spot_market_map,
        &perp_market_map,
        &mut oracle_map,
        &ctx.accounts.user.clone(),
        &ctx.accounts.user_stats.clone(),
        &makers_and_referrer,
        &makers_and_referrer_stats,
        Some(order_id),
        clock,
        FillMode::PlaceAndMake,
    )?;

    let order_exists = load!(ctx.accounts.user)?
        .orders
        .iter()
        .any(|order| order.order_id == order_id && order.status == OrderStatus::Open);

    if order_exists {
        controller::orders::cancel_order_by_order_id(
            order_id,
            &ctx.accounts.user,
            &perp_market_map,
            &spot_market_map,
            &mut oracle_map,
            clock,
        )?;
    }

    Ok(())
}

#[access_control(
    fill_not_paused(&ctx.accounts.state)
)]
pub fn handle_place_and_make_signed_msg_perp_order<'c: 'info, 'info>(
    ctx: Context<'_, '_, 'c, 'info, PlaceAndMakeSignedMsg<'info>>,
    params: OrderParams,
    signed_msg_order_uuid: [u8; 8],
) -> Result<()> {
    let clock = &Clock::get()?;
    let state = &ctx.accounts.state;

    let remaining_accounts_iter = &mut ctx.remaining_accounts.iter().peekable();
    let AccountMaps {
        perp_market_map,
        spot_market_map,
        mut oracle_map,
    } = load_maps(
        remaining_accounts_iter,
        &get_writable_perp_market_set(params.market_index),
        &MarketSet::new(),
        Clock::get()?.slot,
        Some(state.oracle_guard_rails),
    )?;

    if !params.immediate_or_cancel
        || params.post_only == PostOnlyParam::None
        || params.order_type != OrderType::Limit
    {
        msg!("place_and_make must use IOC post only limit order");
        return Err(print_error!(ErrorCode::InvalidOrderIOCPostOnly)().into());
    }

    controller::repeg::update_amm(
        params.market_index,
        &perp_market_map,
        &mut oracle_map,
        state,
        clock,
    )?;

    let user_key = ctx.accounts.user.key();
    let mut user = load_mut!(ctx.accounts.user)?;

    controller::orders::place_perp_order(
        state,
        &mut user,
        user_key,
        &perp_market_map,
        &spot_market_map,
        &mut oracle_map,
        clock,
        params,
        PlaceOrderOptions::default(),
    )?;

    let (order_id, authority) = (user.get_last_order_id(), user.authority);

    drop(user);

    let (mut makers_and_referrer, mut makers_and_referrer_stats) =
        load_user_maps(remaining_accounts_iter, true)?;
    makers_and_referrer.insert(ctx.accounts.user.key(), ctx.accounts.user.clone())?;
    makers_and_referrer_stats.insert(authority, ctx.accounts.user_stats.clone())?;

    let taker_signed_msg_account = ctx.accounts.taker_signed_msg_user_orders.load()?;
    let taker_order_id = taker_signed_msg_account
        .iter()
        .find(|signed_msg_order_id| signed_msg_order_id.uuid == signed_msg_order_uuid)
        .ok_or(ErrorCode::SignedMsgOrderDoesNotExist)?
        .order_id;

    controller::orders::fill_perp_order(
        taker_order_id,
        state,
        &ctx.accounts.taker,
        &ctx.accounts.taker_stats,
        &spot_market_map,
        &perp_market_map,
        &mut oracle_map,
        &ctx.accounts.user.clone(),
        &ctx.accounts.user_stats.clone(),
        &makers_and_referrer,
        &makers_and_referrer_stats,
        Some(order_id),
        clock,
        FillMode::PlaceAndMake,
    )?;

    let order_exists = load!(ctx.accounts.user)?
        .orders
        .iter()
        .any(|order| order.order_id == order_id && order.status == OrderStatus::Open);

    if order_exists {
        controller::orders::cancel_order_by_order_id(
            order_id,
            &ctx.accounts.user,
            &perp_market_map,
            &spot_market_map,
            &mut oracle_map,
            clock,
        )?;
    }

    Ok(())
}

pub fn handle_place_spot_order<'c: 'info, 'info>(
    ctx: Context<'_, '_, 'c, 'info, PlaceOrder>,
    params: OrderParams,
) -> Result<()> {
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

    if params.immediate_or_cancel {
        msg!("immediate_or_cancel order must be in place_and_make or place_and_take");
        return Err(print_error!(ErrorCode::InvalidOrderIOC)().into());
    }

    let user_key = ctx.accounts.user.key();
    let mut user = load_mut!(ctx.accounts.user)?;

    controller::orders::place_spot_order(
        &ctx.accounts.state,
        &mut user,
        user_key,
        &perp_market_map,
        &spot_market_map,
        &mut oracle_map,
        &Clock::get()?,
        params,
        PlaceOrderOptions::default(),
    )?;

    Ok(())
}

#[access_control(
    fill_not_paused(&ctx.accounts.state)
)]
pub fn handle_place_and_take_spot_order<'c: 'info, 'info>(
    ctx: Context<'_, '_, 'c, 'info, PlaceAndTake<'info>>,
    params: OrderParams,
    fulfillment_type: SpotFulfillmentType,
    _maker_order_id: Option<u32>,
) -> Result<()> {
    let clock = Clock::get()?;
    let market_index = params.market_index;

    let remaining_accounts_iter = &mut ctx.remaining_accounts.iter().peekable();
    let AccountMaps {
        perp_market_map,
        spot_market_map,
        mut oracle_map,
    } = load_maps(
        remaining_accounts_iter,
        &MarketSet::new(),
        &get_writable_spot_market_set_from_many(vec![QUOTE_SPOT_MARKET_INDEX, market_index]),
        clock.slot,
        None,
    )?;

    if params.post_only != PostOnlyParam::None {
        msg!("post_only cant be used in place_and_take");
        return Err(print_error!(ErrorCode::InvalidOrderPostOnly)().into());
    }

    let (makers_and_referrer, makers_and_referrer_stats) = match fulfillment_type {
        SpotFulfillmentType::Match => load_user_maps(remaining_accounts_iter, true)?,
        _ => (UserMap::empty(), UserStatsMap::empty()),
    };

    let is_immediate_or_cancel = params.immediate_or_cancel;

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

    let user_key = ctx.accounts.user.key();
    let mut user = load_mut!(ctx.accounts.user)?;

    let order_id_before = user.get_last_order_id();

    controller::orders::place_spot_order(
        &ctx.accounts.state,
        &mut user,
        user_key,
        &perp_market_map,
        &spot_market_map,
        &mut oracle_map,
        &clock,
        params,
        PlaceOrderOptions::default(),
    )?;

    drop(user);

    let user = &mut ctx.accounts.user;
    let order_id = load!(user)?.get_last_order_id();

    if order_id == order_id_before {
        msg!("new order failed to be placed");
        return Err(print_error!(ErrorCode::InvalidOrder)().into());
    }

    controller::orders::fill_spot_order(
        order_id,
        &ctx.accounts.state,
        user,
        &ctx.accounts.user_stats,
        &spot_market_map,
        &perp_market_map,
        &mut oracle_map,
        &user.clone(),
        &ctx.accounts.user_stats.clone(),
        &makers_and_referrer,
        &makers_and_referrer_stats,
        None,
        &clock,
        fulfillment_params.as_mut(),
    )?;

    let order_unfilled = load!(ctx.accounts.user)?
        .orders
        .iter()
        .any(|order| order.order_id == order_id && order.status == OrderStatus::Open);

    if is_immediate_or_cancel && order_unfilled {
        controller::orders::cancel_order_by_order_id(
            order_id,
            &ctx.accounts.user,
            &perp_market_map,
            &spot_market_map,
            &mut oracle_map,
            &clock,
        )?;
    }

    let base_market = spot_market_map.get_ref(&market_index)?;
    let quote_market = spot_market_map.get_quote_spot_market()?;
    fulfillment_params.validate_vault_amounts(&base_market, &quote_market)?;

    Ok(())
}

#[access_control(
    fill_not_paused(&ctx.accounts.state)
)]
pub fn handle_place_and_make_spot_order<'c: 'info, 'info>(
    ctx: Context<'_, '_, 'c, 'info, PlaceAndMake<'info>>,
    params: OrderParams,
    taker_order_id: u32,
    fulfillment_type: SpotFulfillmentType,
) -> Result<()> {
    let clock = &Clock::get()?;
    let state = &ctx.accounts.state;

    let remaining_accounts_iter = &mut ctx.remaining_accounts.iter().peekable();
    let AccountMaps {
        perp_market_map,
        spot_market_map,
        mut oracle_map,
    } = load_maps(
        remaining_accounts_iter,
        &MarketSet::new(),
        &get_writable_spot_market_set_from_many(vec![QUOTE_SPOT_MARKET_INDEX, params.market_index]),
        Clock::get()?.slot,
        None,
    )?;

    let (_referrer, _referrer_stats) = get_referrer_and_referrer_stats(remaining_accounts_iter)?;

    if !params.immediate_or_cancel
        || params.post_only == PostOnlyParam::None
        || params.order_type != OrderType::Limit
    {
        msg!("place_and_make must use IOC post only limit order");
        return Err(print_error!(ErrorCode::InvalidOrderIOCPostOnly)().into());
    }

    let market_index = params.market_index;

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

    let user_key = ctx.accounts.user.key();
    let mut user = load_mut!(ctx.accounts.user)?;
    let authority = user.authority;

    controller::orders::place_spot_order(
        state,
        &mut user,
        user_key,
        &perp_market_map,
        &spot_market_map,
        &mut oracle_map,
        clock,
        params,
        PlaceOrderOptions::default(),
    )?;

    drop(user);

    let order_id = load!(ctx.accounts.user)?.get_last_order_id();

    let mut makers_and_referrer = UserMap::empty();
    let mut makers_and_referrer_stats = UserStatsMap::empty();
    makers_and_referrer.insert(ctx.accounts.user.key(), ctx.accounts.user.clone())?;
    makers_and_referrer_stats.insert(authority, ctx.accounts.user_stats.clone())?;

    controller::orders::fill_spot_order(
        taker_order_id,
        state,
        &ctx.accounts.taker,
        &ctx.accounts.taker_stats,
        &spot_market_map,
        &perp_market_map,
        &mut oracle_map,
        &ctx.accounts.user.clone(),
        &ctx.accounts.user_stats.clone(),
        &makers_and_referrer,
        &makers_and_referrer_stats,
        Some(order_id),
        clock,
        fulfillment_params.as_mut(),
    )?;

    let order_exists = load!(ctx.accounts.user)?
        .orders
        .iter()
        .any(|order| order.order_id == order_id && order.status == OrderStatus::Open);

    if order_exists {
        controller::orders::cancel_order_by_order_id(
            order_id,
            &ctx.accounts.user,
            &perp_market_map,
            &spot_market_map,
            &mut oracle_map,
            clock,
        )?;
    }

    let base_market = spot_market_map.get_ref(&market_index)?;
    let quote_market = spot_market_map.get_quote_spot_market()?;
    fulfillment_params.validate_vault_amounts(&base_market, &quote_market)?;

    Ok(())
}

#[access_control(
    amm_not_paused(&ctx.accounts.state)
)]
pub fn handle_add_perp_lp_shares<'c: 'info, 'info>(
    ctx: Context<'_, '_, 'c, 'info, AddRemoveLiquidity<'info>>,
    n_shares: u64,
    market_index: u16,
) -> Result<()> {
    let user_key = ctx.accounts.user.key();
    let user = &mut load_mut!(ctx.accounts.user)?;
    let state = &ctx.accounts.state;
    let clock = Clock::get()?;
    let now = clock.unix_timestamp;

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

    validate!(!user.is_bankrupt(), ErrorCode::UserBankrupt)?;
    math::liquidation::validate_user_not_being_liquidated(
        user,
        &perp_market_map,
        &spot_market_map,
        &mut oracle_map,
        state.liquidation_margin_buffer_ratio,
    )?;

    {
        let mut market = perp_market_map.get_ref_mut(&market_index)?;

        validate!(
            matches!(market.status, MarketStatus::Active),
            ErrorCode::MarketStatusInvalidForNewLP,
            "Market Status doesn't allow for new LP liquidity"
        )?;

        validate!(
            !matches!(market.contract_type, ContractType::Prediction),
            ErrorCode::MarketStatusInvalidForNewLP,
            "Contract Type doesn't allow for LP liquidity"
        )?;

        validate!(
            !market.is_operation_paused(PerpOperation::AmmFill),
            ErrorCode::MarketStatusInvalidForNewLP,
            "Market amm fills paused"
        )?;

        validate!(
            n_shares >= market.amm.order_step_size,
            ErrorCode::NewLPSizeTooSmall,
            "minting {} shares is less than step size {}",
            n_shares,
            market.amm.order_step_size,
        )?;

        controller::funding::settle_funding_payment(user, &user_key, &mut market, now)?;

        // standardize n shares to mint
        let n_shares = crate::math::orders::standardize_base_asset_amount(
            n_shares.cast()?,
            market.amm.order_step_size,
        )?
        .cast::<u64>()?;

        controller::lp::mint_lp_shares(
            user.force_get_perp_position_mut(market_index)?,
            &mut market,
            n_shares,
        )?;

        user.last_add_perp_lp_shares_ts = now;
    }

    // check margin requirements
    meets_place_order_margin_requirement(
        user,
        &perp_market_map,
        &spot_market_map,
        &mut oracle_map,
        true,
    )?;

    user.update_last_active_slot(clock.slot);

    emit!(LPRecord {
        ts: now,
        action: LPAction::AddLiquidity,
        user: user_key,
        n_shares,
        market_index,
        ..LPRecord::default()
    });

    Ok(())
}

pub fn handle_remove_perp_lp_shares_in_expiring_market<'c: 'info, 'info>(
    ctx: Context<'_, '_, 'c, 'info, RemoveLiquidityInExpiredMarket<'info>>,
    shares_to_burn: u64,
    market_index: u16,
) -> Result<()> {
    let user_key = ctx.accounts.user.key();
    let user = &mut load_mut!(ctx.accounts.user)?;

    let state = &ctx.accounts.state;
    let clock = Clock::get()?;
    let now = clock.unix_timestamp;

    let AccountMaps {
        perp_market_map,
        mut oracle_map,
        ..
    } = load_maps(
        &mut ctx.remaining_accounts.iter().peekable(),
        &get_writable_perp_market_set(market_index),
        &MarketSet::new(),
        clock.slot,
        Some(state.oracle_guard_rails),
    )?;

    // additional validate
    {
        let market = perp_market_map.get_ref(&market_index)?;
        validate!(
            market.is_reduce_only()?,
            ErrorCode::PerpMarketNotInReduceOnly,
            "Can only permissionless burn when market is in reduce only"
        )?;
    }

    controller::lp::remove_perp_lp_shares(
        perp_market_map,
        &mut oracle_map,
        state,
        user,
        user_key,
        shares_to_burn,
        market_index,
        now,
    )?;

    user.update_last_active_slot(clock.slot);

    Ok(())
}

#[access_control(
    amm_not_paused(&ctx.accounts.state)
)]
pub fn handle_remove_perp_lp_shares<'c: 'info, 'info>(
    ctx: Context<'_, '_, 'c, 'info, AddRemoveLiquidity<'info>>,
    shares_to_burn: u64,
    market_index: u16,
) -> Result<()> {
    let user_key = ctx.accounts.user.key();
    let user = &mut load_mut!(ctx.accounts.user)?;

    let state = &ctx.accounts.state;
    let clock = Clock::get()?;
    let now = clock.unix_timestamp;

    let AccountMaps {
        perp_market_map,
        mut oracle_map,
        ..
    } = load_maps(
        &mut ctx.remaining_accounts.iter().peekable(),
        &get_writable_perp_market_set(market_index),
        &MarketSet::new(),
        clock.slot,
        Some(state.oracle_guard_rails),
    )?;

    controller::lp::remove_perp_lp_shares(
        perp_market_map,
        &mut oracle_map,
        state,
        user,
        user_key,
        shares_to_burn,
        market_index,
        now,
    )?;

    user.update_last_active_slot(clock.slot);

    Ok(())
}

pub fn handle_update_user_name(
    ctx: Context<UpdateUser>,
    _sub_account_id: u16,
    name: [u8; 32],
) -> Result<()> {
    let mut user = load_mut!(ctx.accounts.user)?;
    user.name = name;
    Ok(())
}

pub fn handle_update_user_custom_margin_ratio(
    ctx: Context<UpdateUser>,
    _sub_account_id: u16,
    margin_ratio: u32,
) -> Result<()> {
    let mut user = load_mut!(ctx.accounts.user)?;
    user.max_margin_ratio = margin_ratio;
    Ok(())
}

pub fn handle_update_user_margin_trading_enabled<'c: 'info, 'info>(
    ctx: Context<'_, '_, 'c, 'info, UpdateUser<'info>>,
    _sub_account_id: u16,
    margin_trading_enabled: bool,
) -> Result<()> {
    let remaining_accounts_iter = &mut ctx.remaining_accounts.iter().peekable();
    let AccountMaps {
        perp_market_map,
        spot_market_map,
        mut oracle_map,
        ..
    } = load_maps(
        remaining_accounts_iter,
        &MarketSet::new(),
        &MarketSet::new(),
        Clock::get()?.slot,
        None,
    )?;

    let mut user = load_mut!(ctx.accounts.user)?;
    user.is_margin_trading_enabled = margin_trading_enabled;

    validate_spot_margin_trading(&user, &perp_market_map, &spot_market_map, &mut oracle_map)
        .map_err(|_| ErrorCode::MarginOrdersOpen)?;

    Ok(())
}

pub fn handle_update_user_pool_id<'c: 'info, 'info>(
    ctx: Context<'_, '_, 'c, 'info, UpdateUser<'info>>,
    _sub_account_id: u16,
    pool_id: u8,
) -> Result<()> {
    let remaining_accounts_iter = &mut ctx.remaining_accounts.iter().peekable();
    let AccountMaps {
        perp_market_map,
        spot_market_map,
        mut oracle_map,
        ..
    } = load_maps(
        remaining_accounts_iter,
        &MarketSet::new(),
        &MarketSet::new(),
        Clock::get()?.slot,
        None,
    )?;

    let mut user = load_mut!(ctx.accounts.user)?;
    user.pool_id = pool_id;

    // will throw if user has deposits/positions in other pools
    meets_initial_margin_requirement(&user, &perp_market_map, &spot_market_map, &mut oracle_map)?;

    Ok(())
}

pub fn handle_update_user_delegate(
    ctx: Context<UpdateUser>,
    _sub_account_id: u16,
    delegate: Pubkey,
) -> Result<()> {
    let mut user = load_mut!(ctx.accounts.user)?;
    user.delegate = delegate;
    Ok(())
}

pub fn handle_update_user_reduce_only(
    ctx: Context<UpdateUser>,
    _sub_account_id: u16,
    reduce_only: bool,
) -> Result<()> {
    let mut user = load_mut!(ctx.accounts.user)?;

    validate!(!user.is_being_liquidated(), ErrorCode::LiquidationsOngoing)?;

    user.update_reduce_only_status(reduce_only)?;
    Ok(())
}

pub fn handle_update_user_advanced_lp(
    ctx: Context<UpdateUser>,
    _sub_account_id: u16,
    advanced_lp: bool,
) -> Result<()> {
    let mut user = load_mut!(ctx.accounts.user)?;

    validate!(!user.is_being_liquidated(), ErrorCode::LiquidationsOngoing)?;

    user.update_advanced_lp_status(advanced_lp)?;
    Ok(())
}

pub fn handle_update_user_protected_maker_orders(
    ctx: Context<UpdateUserProtectedMakerMode>,
    _sub_account_id: u16,
    protected_maker_orders: bool,
) -> Result<()> {
    let mut user = load_mut!(ctx.accounts.user)?;

    validate!(!user.is_being_liquidated(), ErrorCode::LiquidationsOngoing)?;

    validate!(
        protected_maker_orders != user.is_protected_maker(),
        ErrorCode::DefaultError,
        "user already {} protected maker mode",
        if protected_maker_orders {
            "in"
        } else {
            "out of"
        }
    )?;

    user.update_protected_maker_orders_status(protected_maker_orders)?;

    let mut config = load_mut!(ctx.accounts.protected_maker_mode_config)?;

    if protected_maker_orders {
        validate!(
            !config.is_reduce_only(),
            ErrorCode::DefaultError,
            "protected maker mode config reduce only"
        )?;

        config.current_users = config.current_users.safe_add(1)?;
    } else {
        config.current_users = config.current_users.safe_sub(1)?;
    }

    config.validate()?;

    Ok(())
}

pub fn handle_delete_user(ctx: Context<DeleteUser>) -> Result<()> {
    let user = &load!(ctx.accounts.user)?;
    let user_stats = &mut load_mut!(ctx.accounts.user_stats)?;

    validate_user_deletion(
        user,
        user_stats,
        &ctx.accounts.state,
        Clock::get()?.unix_timestamp,
    )?;

    safe_decrement!(user_stats.number_of_sub_accounts, 1);

    let state = &mut ctx.accounts.state;
    safe_decrement!(state.number_of_sub_accounts, 1);

    Ok(())
}

pub fn handle_delete_signed_msg_user_orders(
    _ctx: Context<DeleteSignedMsgUserOrders>,
) -> Result<()> {
    Ok(())
}

pub fn handle_reclaim_rent(ctx: Context<ReclaimRent>) -> Result<()> {
    let user_size = ctx.accounts.user.to_account_info().data_len();
    let minimum_lamports = ctx.accounts.rent.minimum_balance(user_size);
    let current_lamports = ctx.accounts.user.to_account_info().try_lamports()?;
    let reclaim_amount = current_lamports.saturating_sub(minimum_lamports);

    validate!(
        reclaim_amount > 0,
        ErrorCode::CantReclaimRent,
        "user account has no excess lamports to reclaim"
    )?;

    **ctx
        .accounts
        .user
        .to_account_info()
        .try_borrow_mut_lamports()? = minimum_lamports;

    **ctx
        .accounts
        .authority
        .to_account_info()
        .try_borrow_mut_lamports()? += reclaim_amount;

    let user_stats = &mut load!(ctx.accounts.user_stats)?;

    // Skip age check if is no max sub accounts
    let max_sub_accounts = ctx.accounts.state.max_number_of_sub_accounts();
    let estimated_user_stats_age = user_stats.get_age_ts(Clock::get()?.unix_timestamp);
    validate!(
        max_sub_accounts == 0 || estimated_user_stats_age >= THIRTEEN_DAY,
        ErrorCode::CantReclaimRent,
        "user stats too young to reclaim rent. age ={} minimum = {}",
        estimated_user_stats_age,
        THIRTEEN_DAY
    )?;

    Ok(())
}

#[access_control(
    deposit_not_paused(&ctx.accounts.state)
)]
pub fn handle_deposit_into_spot_market_revenue_pool<'c: 'info, 'info>(
    ctx: Context<'_, '_, 'c, 'info, RevenuePoolDeposit<'info>>,
    amount: u64,
) -> Result<()> {
    if amount == 0 {
        return Err(ErrorCode::InsufficientDeposit.into());
    }

    let mut spot_market = load_mut!(ctx.accounts.spot_market)?;

    let remaining_accounts_iter = &mut ctx.remaining_accounts.iter().peekable();

    let mint = get_token_mint(remaining_accounts_iter)?;

    validate!(
        !spot_market.is_in_settlement(Clock::get()?.unix_timestamp),
        ErrorCode::DefaultError,
        "spot market {} not active",
        spot_market.market_index
    )?;

    controller::spot_balance::update_revenue_pool_balances(
        amount.cast::<u128>()?,
        &SpotBalanceType::Deposit,
        &mut spot_market,
    )?;

    controller::token::receive(
        &ctx.accounts.token_program,
        &ctx.accounts.user_token_account,
        &ctx.accounts.spot_market_vault,
        &ctx.accounts.authority,
        amount,
        &mint,
    )?;

    spot_market.validate_max_token_deposits_and_borrows(false)?;
    ctx.accounts.spot_market_vault.reload()?;
    math::spot_withdraw::validate_spot_market_vault_amount(
        &spot_market,
        ctx.accounts.spot_market_vault.amount,
    )?;

    Ok(())
}

pub fn handle_enable_user_high_leverage_mode<'c: 'info, 'info>(
    ctx: Context<'_, '_, 'c, 'info, EnableUserHighLeverageMode>,
    _sub_account_id: u16,
) -> Result<()> {
    let state = &ctx.accounts.state;
    let mut user = load_mut!(ctx.accounts.user)?;

    let AccountMaps {
        perp_market_map,
        spot_market_map,
        mut oracle_map,
    } = load_maps(
        &mut ctx.remaining_accounts.iter().peekable(),
        &MarketSet::new(),
        &MarketSet::new(),
        Clock::get()?.slot,
        Some(state.oracle_guard_rails),
    )?;

    validate!(
        user.margin_mode != MarginMode::HighLeverage,
        ErrorCode::DefaultError,
        "user already in high leverage mode"
    )?;

    meets_maintenance_margin_requirement(
        &user,
        &perp_market_map,
        &spot_market_map,
        &mut oracle_map,
    )?;

    user.margin_mode = MarginMode::HighLeverage;

    let mut config = load_mut!(ctx.accounts.high_leverage_mode_config)?;

    validate!(
        !config.is_reduce_only(),
        ErrorCode::DefaultError,
        "high leverage mode config reduce only"
    )?;

    config.current_users = config.current_users.safe_add(1)?;

    config.validate()?;

    Ok(())
}

#[access_control(
    fill_not_paused(&ctx.accounts.state)
)]
pub fn handle_begin_swap<'c: 'info, 'info>(
    ctx: Context<'_, '_, 'c, 'info, Swap<'info>>,
    in_market_index: u16,
    out_market_index: u16,
    amount_in: u64,
) -> Result<()> {
    let state = &ctx.accounts.state;
    let clock = Clock::get()?;
    let now = clock.unix_timestamp;

    let remaining_accounts_iter = &mut ctx.remaining_accounts.iter().peekable();
    let AccountMaps {
        perp_market_map,
        spot_market_map,
        mut oracle_map,
    } = load_maps(
        remaining_accounts_iter,
        &MarketSet::new(),
        &get_writable_spot_market_set_from_many(vec![in_market_index, out_market_index]),
        clock.slot,
        Some(state.oracle_guard_rails),
    )?;

    let _token_interface = get_token_interface(remaining_accounts_iter)?;
    let mint = get_token_mint(remaining_accounts_iter)?;

    let mut user = load_mut!(&ctx.accounts.user)?;
    let delegate_is_signer = user.delegate == ctx.accounts.authority.key();

    validate!(!user.is_bankrupt(), ErrorCode::UserBankrupt)?;

    math::liquidation::validate_user_not_being_liquidated(
        &mut user,
        &perp_market_map,
        &spot_market_map,
        &mut oracle_map,
        ctx.accounts.state.liquidation_margin_buffer_ratio,
    )?;

    let mut in_spot_market = spot_market_map.get_ref_mut(&in_market_index)?;

    validate!(
        in_spot_market.fills_enabled(),
        ErrorCode::MarketFillOrderPaused,
        "Swaps disabled for {}",
        in_market_index
    )?;

    validate!(
        in_spot_market.flash_loan_initial_token_amount == 0
            && in_spot_market.flash_loan_amount == 0,
        ErrorCode::InvalidSwap,
        "begin_swap ended in invalid state"
    )?;

    let in_oracle_data = oracle_map.get_price_data(&in_spot_market.oracle_id())?;
    controller::spot_balance::update_spot_market_cumulative_interest(
        &mut in_spot_market,
        Some(in_oracle_data),
        now,
    )?;

    let mut out_spot_market = spot_market_map.get_ref_mut(&out_market_index)?;

    validate!(
        out_spot_market.fills_enabled(),
        ErrorCode::MarketFillOrderPaused,
        "Swaps disabled for {}",
        out_market_index
    )?;

    validate!(
        out_spot_market.flash_loan_initial_token_amount == 0
            && out_spot_market.flash_loan_amount == 0,
        ErrorCode::InvalidSwap,
        "begin_swap ended in invalid state"
    )?;

    let out_oracle_data = oracle_map.get_price_data(&out_spot_market.oracle_id())?;
    controller::spot_balance::update_spot_market_cumulative_interest(
        &mut out_spot_market,
        Some(out_oracle_data),
        now,
    )?;

    validate!(
        in_market_index != out_market_index,
        ErrorCode::InvalidSwap,
        "in and out market the same"
    )?;

    validate!(
        amount_in != 0,
        ErrorCode::InvalidSwap,
        "amount_out cannot be zero"
    )?;

    let in_vault = &ctx.accounts.in_spot_market_vault;
    let in_token_account = &ctx.accounts.in_token_account;

    in_spot_market.flash_loan_amount = amount_in;
    in_spot_market.flash_loan_initial_token_amount = in_token_account.amount;

    let out_token_account = &ctx.accounts.out_token_account;

    out_spot_market.flash_loan_initial_token_amount = out_token_account.amount;

    controller::token::send_from_program_vault(
        &ctx.accounts.token_program,
        in_vault,
        &ctx.accounts.in_token_account,
        &ctx.accounts.drift_signer,
        state.signer_nonce,
        amount_in,
        &mint,
    )?;

    let ixs = ctx.accounts.instructions.as_ref();
    let current_index = instructions::load_current_index_checked(ixs)? as usize;

    let current_ix = instructions::load_instruction_at_checked(current_index, ixs)?;
    validate!(
        current_ix.program_id == *ctx.program_id,
        ErrorCode::InvalidSwap,
        "SwapBegin must be a top-level instruction (cant be cpi)"
    )?;

    // The only other drift program allowed is SwapEnd
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
                ErrorCode::InvalidSwap,
                "the transaction must not contain a Drift instruction after FlashLoanEnd"
            )?;
            found_end = true;

            // must be the SwapEnd instruction
            let discriminator = crate::instruction::EndSwap::discriminator();
            validate!(
                ix.data[0..8] == discriminator,
                ErrorCode::InvalidSwap,
                "last drift ix must be end of swap"
            )?;

            validate!(
                ctx.accounts.user.key() == ix.accounts[1].pubkey,
                ErrorCode::InvalidSwap,
                "the user passed to SwapBegin and End must match"
            )?;

            validate!(
                ctx.accounts.authority.key() == ix.accounts[3].pubkey,
                ErrorCode::InvalidSwap,
                "the authority passed to SwapBegin and End must match"
            )?;

            validate!(
                ctx.accounts.out_spot_market_vault.key() == ix.accounts[4].pubkey,
                ErrorCode::InvalidSwap,
                "the out_spot_market_vault passed to SwapBegin and End must match"
            )?;

            validate!(
                ctx.accounts.in_spot_market_vault.key() == ix.accounts[5].pubkey,
                ErrorCode::InvalidSwap,
                "the in_spot_market_vault passed to SwapBegin and End must match"
            )?;

            validate!(
                ctx.accounts.out_token_account.key() == ix.accounts[6].pubkey,
                ErrorCode::InvalidSwap,
                "the out_token_account passed to SwapBegin and End must match"
            )?;

            validate!(
                ctx.accounts.in_token_account.key() == ix.accounts[7].pubkey,
                ErrorCode::InvalidSwap,
                "the in_token_account passed to SwapBegin and End must match"
            )?;

            validate!(
                ctx.remaining_accounts.len() == ix.accounts.len() - 11,
                ErrorCode::InvalidSwap,
                "begin and end ix must have the same number of accounts"
            )?;

            for i in 11..ix.accounts.len() {
                validate!(
                    *ctx.remaining_accounts[i - 11].key == ix.accounts[i].pubkey,
                    ErrorCode::InvalidSwap,
                    "begin and end ix must have the same accounts. {}th account mismatch. begin: {}, end: {}",
                    i,
                    ctx.remaining_accounts[i - 11].key,
                    ix.accounts[i].pubkey
                )?;
            }
        } else {
            if found_end {
                if ix.program_id == lighthouse::ID {
                    continue;
                }

                for meta in ix.accounts.iter() {
                    validate!(
                        meta.is_writable == false,
                        ErrorCode::InvalidSwap,
                        "instructions after swap end must not have writable accounts"
                    )?;
                }
            } else {
                let mut whitelisted_programs = vec![
                    serum_program::id(),
                    AssociatedToken::id(),
                    jupiter_mainnet_3::ID,
                    jupiter_mainnet_4::ID,
                    jupiter_mainnet_6::ID,
                ];
                if !delegate_is_signer {
                    whitelisted_programs.push(Token::id());
                    whitelisted_programs.push(Token2022::id());
                    whitelisted_programs.push(marinade_mainnet::ID);
                }
                validate!(
                    whitelisted_programs.contains(&ix.program_id),
                    ErrorCode::InvalidSwap,
                    "only allowed to pass in ixs to token, openbook, and Jupiter v3/v4/v6 programs"
                )?;

                for meta in ix.accounts.iter() {
                    validate!(
                        meta.pubkey != crate::id(),
                        ErrorCode::InvalidSwap,
                        "instructions between begin and end must not be drift instructions"
                    )?;
                }
            }
        }

        index += 1;
    }

    validate!(
        found_end,
        ErrorCode::InvalidSwap,
        "found no SwapEnd instruction in transaction"
    )?;

    Ok(())
}

#[derive(Clone, Copy, BorshSerialize, BorshDeserialize, PartialEq, Debug, Eq)]
pub enum SwapReduceOnly {
    In,
    Out,
}

#[access_control(
    fill_not_paused(&ctx.accounts.state)
)]
pub fn handle_end_swap<'c: 'info, 'info>(
    ctx: Context<'_, '_, 'c, 'info, Swap<'info>>,
    in_market_index: u16,
    out_market_index: u16,
    limit_price: Option<u64>,
    reduce_only: Option<SwapReduceOnly>,
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
        &get_writable_spot_market_set_from_many(vec![in_market_index, out_market_index]),
        clock.slot,
        Some(state.oracle_guard_rails),
    )?;
    let out_token_program = get_token_interface(remaining_accounts)?;

    let in_mint = get_token_mint(remaining_accounts)?;
    let out_mint = get_token_mint(remaining_accounts)?;

    let user_key = ctx.accounts.user.key();
    let mut user = load_mut!(&ctx.accounts.user)?;

    let mut user_stats = load_mut!(&ctx.accounts.user_stats)?;

    let exchange_status = state.get_exchange_status()?;

    validate!(
        !exchange_status.contains(ExchangeStatus::DepositPaused | ExchangeStatus::WithdrawPaused),
        ErrorCode::ExchangePaused
    )?;

    let mut in_spot_market = spot_market_map.get_ref_mut(&in_market_index)?;

    validate!(
        !in_spot_market.is_operation_paused(SpotOperation::Withdraw),
        ErrorCode::MarketFillOrderPaused,
        "withdraw from market {} paused",
        in_market_index
    )?;

    validate!(
        in_spot_market.flash_loan_amount != 0,
        ErrorCode::InvalidSwap,
        "the in_spot_market must have a flash loan amount set"
    )?;

    let in_oracle_data = oracle_map.get_price_data(&in_spot_market.oracle_id())?;
    let in_oracle_price = in_oracle_data.price;

    let mut out_spot_market = spot_market_map.get_ref_mut(&out_market_index)?;

    validate!(
        !out_spot_market.is_operation_paused(SpotOperation::Deposit),
        ErrorCode::MarketFillOrderPaused,
        "deposit to market {} paused",
        out_market_index
    )?;

    let out_oracle_data = oracle_map.get_price_data(&out_spot_market.oracle_id())?;
    let out_oracle_price = out_oracle_data.price;

    let in_vault = &mut ctx.accounts.in_spot_market_vault;
    let in_token_account = &mut ctx.accounts.in_token_account;

    let mut amount_in = in_spot_market.flash_loan_amount;
    if in_token_account.amount > in_spot_market.flash_loan_initial_token_amount {
        let residual = in_token_account
            .amount
            .safe_sub(in_spot_market.flash_loan_initial_token_amount)?;

        controller::token::receive(
            &ctx.accounts.token_program,
            in_token_account,
            in_vault,
            &ctx.accounts.authority,
            residual,
            &in_mint,
        )?;
        in_token_account.reload()?;
        in_vault.reload()?;

        amount_in = amount_in.safe_sub(residual)?;
    }

    let in_token_amount_before = user
        .force_get_spot_position_mut(in_market_index)?
        .get_signed_token_amount(&in_spot_market)?;

    // checks deposit/borrow limits
    update_spot_balances_and_cumulative_deposits_with_limits(
        amount_in.cast()?,
        &SpotBalanceType::Borrow,
        &mut in_spot_market,
        &mut user,
    )?;

    let in_token_amount_after = user
        .force_get_spot_position_mut(in_market_index)?
        .get_signed_token_amount(&in_spot_market)?;

    let in_position_is_reduced =
        in_token_amount_before > 0 && in_token_amount_before.unsigned_abs() >= amount_in.cast()?;

    if !in_position_is_reduced {
        validate!(
            !in_spot_market.is_reduce_only(),
            ErrorCode::SpotMarketReduceOnly,
            "in spot market is reduce only but token amount before ({}) < amount in ({})",
            in_token_amount_before,
            amount_in
        )?;

        validate!(
            reduce_only != Some(SwapReduceOnly::In),
            ErrorCode::InvalidSwap,
            "reduce only violated. In position before ({}) < amount in ({})",
            in_token_amount_before,
            amount_in
        )?;

        validate!(
            user.is_margin_trading_enabled,
            ErrorCode::MarginTradingDisabled,
            "swap lead to increase in liability for in market {}",
            in_market_index
        )?;

        validate!(
            !user.is_reduce_only(),
            ErrorCode::UserReduceOnly,
            "swap lead to increase in liability for in market {}",
            in_market_index
        )?;
    }

    math::spot_withdraw::validate_spot_market_vault_amount(&in_spot_market, in_vault.amount)?;

    in_spot_market.flash_loan_initial_token_amount = 0;
    in_spot_market.flash_loan_amount = 0;

    let out_vault = &mut ctx.accounts.out_spot_market_vault;
    let out_token_account = &mut ctx.accounts.out_token_account;

    let mut amount_out = 0_u64;
    if out_token_account.amount > out_spot_market.flash_loan_initial_token_amount {
        amount_out = out_token_account
            .amount
            .safe_sub(out_spot_market.flash_loan_initial_token_amount)?;

        if let Some(token_interface) = out_token_program {
            controller::token::receive(
                &token_interface,
                out_token_account,
                out_vault,
                &ctx.accounts.authority,
                amount_out,
                &out_mint,
            )?;
        } else {
            controller::token::receive(
                &ctx.accounts.token_program,
                out_token_account,
                out_vault,
                &ctx.accounts.authority,
                amount_out,
                &out_mint,
            )?;
        }

        out_vault.reload()?;
    }

    if let Some(limit_price) = limit_price {
        let swap_price = calculate_swap_price(
            amount_out.cast()?,
            amount_in.cast()?,
            out_spot_market.decimals,
            in_spot_market.decimals,
        )?;

        validate!(
            swap_price >= limit_price.cast()?,
            ErrorCode::SwapLimitPriceBreached,
            "swap_price ({}) < limit price ({})",
            swap_price,
            limit_price
        )?;
    }

    let fee = 0_u64; // no fee
    let amount_out_after_fee = amount_out.safe_sub(fee)?;

    out_spot_market.total_swap_fee = out_spot_market.total_swap_fee.saturating_add(fee);

    let fee_value = get_token_value(fee.cast()?, out_spot_market.decimals, out_oracle_price)?;

    // update fees
    user.update_cumulative_spot_fees(-fee_value.cast()?)?;
    user_stats.increment_total_fees(fee_value.cast()?)?;

    if fee != 0 {
        // update taker volume
        let amount_out_value = get_token_value(
            amount_out.cast()?,
            out_spot_market.decimals,
            out_oracle_price,
        )?;
        user_stats.update_taker_volume_30d(
            out_spot_market.fuel_boost_taker,
            amount_out_value.cast()?,
            now,
        )?;
    }

    validate!(
        amount_out != 0,
        ErrorCode::InvalidSwap,
        "amount_out must be greater than 0"
    )?;

    let out_token_amount_before = user
        .force_get_spot_position_mut(out_market_index)?
        .get_signed_token_amount(&out_spot_market)?;

    update_spot_balances_and_cumulative_deposits(
        amount_out_after_fee.cast()?,
        &SpotBalanceType::Deposit,
        &mut out_spot_market,
        user.force_get_spot_position_mut(out_market_index)?,
        false,
        Some(amount_out.cast()?),
    )?;

    let out_token_amount_after = user
        .force_get_spot_position_mut(out_market_index)?
        .get_signed_token_amount(&out_spot_market)?;

    // update fees
    update_revenue_pool_balances(fee.cast()?, &SpotBalanceType::Deposit, &mut out_spot_market)?;

    let out_position_is_reduced = out_token_amount_before < 0
        && out_token_amount_before.unsigned_abs() >= amount_out_after_fee.cast()?;

    if !out_position_is_reduced {
        validate!(
            !out_spot_market.is_reduce_only(),
            ErrorCode::SpotMarketReduceOnly,
            "out spot market is reduce only but token amount before ({}) < amount out ({})",
            out_token_amount_before,
            amount_out
        )?;

        validate!(
            reduce_only != Some(SwapReduceOnly::Out),
            ErrorCode::InvalidSwap,
            "reduce only violated. Out position before ({}) < amount out ({})",
            out_token_amount_before,
            amount_out
        )?;

        validate!(
            !user.is_reduce_only(),
            ErrorCode::UserReduceOnly,
            "swap lead to increase in deposit for in market {}, can only pay off borrow",
            out_market_index
        )?;
    }

    math::spot_withdraw::validate_spot_market_vault_amount(&out_spot_market, out_vault.amount)?;

    out_spot_market.flash_loan_initial_token_amount = 0;
    out_spot_market.flash_loan_amount = 0;

    out_spot_market.validate_max_token_deposits_and_borrows(false)?;

    let in_strict_price = StrictOraclePrice::new(
        in_oracle_price,
        in_spot_market
            .historical_oracle_data
            .last_oracle_price_twap_5min,
        true,
    );

    let out_strict_price = StrictOraclePrice::new(
        out_oracle_price,
        out_spot_market
            .historical_oracle_data
            .last_oracle_price_twap_5min,
        true,
    );

    let (margin_type, _) = spot_swap::select_margin_type_for_swap(
        &in_spot_market,
        &out_spot_market,
        &in_strict_price,
        &out_strict_price,
        in_token_amount_before,
        out_token_amount_before,
        in_token_amount_after,
        out_token_amount_after,
        MarginRequirementType::Initial,
    )?;

    drop(out_spot_market);
    drop(in_spot_market);

    user.meets_withdraw_margin_requirement_and_increment_fuel_bonus_swap(
        &perp_market_map,
        &spot_market_map,
        &mut oracle_map,
        margin_type,
        in_market_index,
        in_token_amount_before.safe_sub(in_token_amount_after)?,
        out_market_index,
        out_token_amount_before.safe_sub(out_token_amount_after)?,
        &mut user_stats,
        now,
    )?;

    user.update_last_active_slot(slot);

    let swap_record = SwapRecord {
        ts: now,
        amount_in,
        amount_out,
        out_market_index,
        in_market_index,
        in_oracle_price,
        out_oracle_price,
        user: user_key,
        fee,
    };
    emit!(swap_record);

    let out_spot_market = spot_market_map.get_ref_mut(&out_market_index)?;

    validate!(
        out_spot_market.flash_loan_initial_token_amount == 0
            && out_spot_market.flash_loan_amount == 0,
        ErrorCode::InvalidSwap,
        "end_swap ended in invalid state"
    )?;

    let in_spot_market = spot_market_map.get_ref_mut(&in_market_index)?;

    validate!(
        in_spot_market.flash_loan_initial_token_amount == 0
            && in_spot_market.flash_loan_amount == 0,
        ErrorCode::InvalidSwap,
        "end_swap ended in invalid state"
    )?;

    validate_price_bands_for_swap(
        &in_spot_market,
        &out_spot_market,
        amount_in,
        amount_out,
        in_oracle_price,
        out_oracle_price,
        state
            .oracle_guard_rails
            .max_oracle_twap_5min_percent_divergence(),
    )?;

    Ok(())
}

#[derive(Accounts)]
#[instruction(
    sub_account_id: u16,
)]
pub struct InitializeUser<'info> {
    #[account(
        init,
        seeds = [b"user", authority.key.as_ref(), sub_account_id.to_le_bytes().as_ref()],
        space = User::SIZE,
        bump,
        payer = payer
    )]
    pub user: AccountLoader<'info, User>,
    #[account(
        mut,
        has_one = authority
    )]
    pub user_stats: AccountLoader<'info, UserStats>,
    #[account(mut)]
    pub state: Box<Account<'info, State>>,
    pub authority: Signer<'info>,
    #[account(mut)]
    pub payer: Signer<'info>,
    pub rent: Sysvar<'info, Rent>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct InitializeUserStats<'info> {
    #[account(
        init,
        seeds = [b"user_stats", authority.key.as_ref()],
        space = UserStats::SIZE,
        bump,
        payer = payer
    )]
    pub user_stats: AccountLoader<'info, UserStats>,
    #[account(mut)]
    pub state: Box<Account<'info, State>>,
    pub authority: Signer<'info>,
    #[account(mut)]
    pub payer: Signer<'info>,
    pub rent: Sysvar<'info, Rent>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(num_orders: u16)]
pub struct InitializeSignedMsgUserOrders<'info> {
    #[account(
        init,
        seeds = [SIGNED_MSG_PDA_SEED.as_ref(), authority.key().as_ref()],
        space = SignedMsgUserOrders::space(num_orders as usize),
        bump,
        payer = payer
    )]
    pub signed_msg_user_orders: Box<Account<'info, SignedMsgUserOrders>>,
    /// CHECK: Just a normal authority account
    pub authority: AccountInfo<'info>,
    #[account(mut)]
    pub payer: Signer<'info>,
    pub rent: Sysvar<'info, Rent>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(num_orders: u16)]
pub struct ResizeSignedMsgUserOrders<'info> {
    #[account(
        mut,
        seeds = [SIGNED_MSG_PDA_SEED.as_ref(), authority.key().as_ref()],
        bump,
        realloc = SignedMsgUserOrders::space(num_orders as usize),
        realloc::payer = payer,
        realloc::zero = false,
    )]
    pub signed_msg_user_orders: Box<Account<'info, SignedMsgUserOrders>>,
    /// CHECK: authority
    pub authority: AccountInfo<'info>,
    pub user: AccountLoader<'info, User>,
    #[account(mut)]
    pub payer: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(delegates: Vec<Pubkey>)]
pub struct InitializeSignedMsgWsDelegates<'info> {
    #[account(
        seeds = [SIGNED_MSG_WS_PDA_SEED.as_ref(), authority.key().as_ref()],
        bump,
        init,
        space = 8 + 4 + delegates.len() * 32,
        payer=authority
    )]
    pub signed_msg_ws_delegates: Account<'info, SignedMsgWsDelegates>,
    #[account(mut)]
    pub authority: Signer<'info>,
    pub rent: Sysvar<'info, Rent>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(_delegate: Pubkey, add: bool)]
pub struct ChangeSignedMsgWsDelegateStatus<'info> {
    #[account(
        mut,
        seeds = [SIGNED_MSG_WS_PDA_SEED.as_ref(), authority.key().as_ref()],
        bump,
        realloc = SignedMsgWsDelegates::space(&signed_msg_ws_delegates, add),
        realloc::payer = authority,
        realloc::zero = false,
    )]
    pub signed_msg_ws_delegates: Account<'info, SignedMsgWsDelegates>,
    #[account(mut)]
    pub authority: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct InitializeFuelOverflow<'info> {
    #[account(
        init,
        seeds = [b"fuel_overflow", authority.key.as_ref()],
        space = FuelOverflow::SIZE,
        bump,
        payer = payer
    )]
    pub fuel_overflow: AccountLoader<'info, FuelOverflow>,
    #[account(
        mut,
        has_one = authority
    )]
    pub user_stats: AccountLoader<'info, UserStats>,
    /// CHECK: authority
    pub authority: AccountInfo<'info>,
    #[account(mut)]
    pub payer: Signer<'info>,
    pub rent: Sysvar<'info, Rent>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct SweepFuel<'info> {
    #[account(
        mut,
        has_one = authority,
    )]
    pub fuel_overflow: AccountLoader<'info, FuelOverflow>,
    #[account(
        mut,
        has_one = authority
    )]
    pub user_stats: AccountLoader<'info, UserStats>,
    /// CHECK: authority
    pub authority: AccountInfo<'info>,
    pub signer: Signer<'info>,
}

#[derive(Accounts)]
pub struct ResetFuelSeason<'info> {
    #[account(
        mut,
        has_one = authority
    )]
    pub user_stats: AccountLoader<'info, UserStats>,
    /// CHECK: authority
    pub authority: AccountInfo<'info>,
    pub state: Box<Account<'info, State>>,
    #[account(
        constraint = admin.key() == admin_hot_wallet::id() || admin.key() == state.admin
    )]
    pub admin: Signer<'info>,
}

#[derive(Accounts)]
#[instruction(
    name: [u8; 32],
)]
pub struct InitializeReferrerName<'info> {
    #[account(
        init,
        seeds = [b"referrer_name", name.as_ref()],
        space = ReferrerName::SIZE,
        bump,
        payer = payer
    )]
    pub referrer_name: AccountLoader<'info, ReferrerName>,
    #[account(
        mut,
        constraint = can_sign_for_user(&user, &authority)?
    )]
    pub user: AccountLoader<'info, User>,
    #[account(
        mut,
        constraint = is_stats_for_user(&user, &user_stats)?
    )]
    pub user_stats: AccountLoader<'info, UserStats>,
    pub authority: Signer<'info>,
    #[account(mut)]
    pub payer: Signer<'info>,
    pub rent: Sysvar<'info, Rent>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(market_index: u16,)]
pub struct Deposit<'info> {
    pub state: Box<Account<'info, State>>,
    #[account(
        mut,
        constraint = can_sign_for_user(&user, &authority)?
    )]
    pub user: AccountLoader<'info, User>,
    #[account(
        mut,
        constraint = is_stats_for_user(&user, &user_stats)?
    )]
    pub user_stats: AccountLoader<'info, UserStats>,
    pub authority: Signer<'info>,
    #[account(
        mut,
        seeds = [b"spot_market_vault".as_ref(), market_index.to_le_bytes().as_ref()],
        bump,
    )]
    pub spot_market_vault: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(
        mut,
        constraint = &spot_market_vault.mint.eq(&user_token_account.mint),
        token::authority = authority
    )]
    pub user_token_account: Box<InterfaceAccount<'info, TokenAccount>>,
    pub token_program: Interface<'info, TokenInterface>,
}

#[derive(Accounts)]
pub struct RevenuePoolDeposit<'info> {
    pub state: Box<Account<'info, State>>,
    #[account(mut)]
    pub spot_market: AccountLoader<'info, SpotMarket>,
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(
        mut,
        seeds = [b"spot_market_vault".as_ref(), spot_market.load()?.market_index.to_le_bytes().as_ref()],
        bump,
    )]
    pub spot_market_vault: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(
        mut,
        constraint = &spot_market_vault.mint.eq(&user_token_account.mint),
        token::authority = authority
    )]
    pub user_token_account: Box<InterfaceAccount<'info, TokenAccount>>,
    pub token_program: Interface<'info, TokenInterface>,
}

#[derive(Accounts)]
#[instruction(market_index: u16,)]
pub struct Withdraw<'info> {
    pub state: Box<Account<'info, State>>,
    #[account(
        mut,
        has_one = authority,
    )]
    pub user: AccountLoader<'info, User>,
    #[account(
        mut,
        has_one = authority
    )]
    pub user_stats: AccountLoader<'info, UserStats>,
    pub authority: Signer<'info>,
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
        constraint = &spot_market_vault.mint.eq(&user_token_account.mint)
    )]
    pub user_token_account: Box<InterfaceAccount<'info, TokenAccount>>,
    pub token_program: Interface<'info, TokenInterface>,
}

#[derive(Accounts)]
#[instruction(market_index: u16,)]
pub struct TransferDeposit<'info> {
    #[account(
        mut,
        has_one = authority,
    )]
    pub from_user: AccountLoader<'info, User>,
    #[account(
        mut,
        has_one = authority,
    )]
    pub to_user: AccountLoader<'info, User>,
    #[account(
        mut,
        has_one = authority
    )]
    pub user_stats: AccountLoader<'info, UserStats>,
    pub authority: Signer<'info>,
    pub state: Box<Account<'info, State>>,
    #[account(
        seeds = [b"spot_market_vault".as_ref(), market_index.to_le_bytes().as_ref()],
        bump,
    )]
    pub spot_market_vault: Box<InterfaceAccount<'info, TokenAccount>>,
}

#[derive(Accounts)]
#[instruction(
    deposit_from_market_index: u16,
    deposit_to_market_index: u16,
    borrow_from_market_index: u16,
    borrow_to_market_index: u16,
)]
pub struct TransferPools<'info> {
    #[account(
        mut,
        has_one = authority,
    )]
    pub from_user: AccountLoader<'info, User>,
    #[account(
        mut,
        has_one = authority,
    )]
    pub to_user: AccountLoader<'info, User>,
    #[account(
        mut,
        has_one = authority
    )]
    pub user_stats: AccountLoader<'info, UserStats>,
    pub authority: Signer<'info>,
    pub state: Box<Account<'info, State>>,
    #[account(
        mut,
        seeds = [b"spot_market_vault".as_ref(), deposit_from_market_index.to_le_bytes().as_ref()],
        bump,
    )]
    pub deposit_from_spot_market_vault: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(
        mut,
        seeds = [b"spot_market_vault".as_ref(), deposit_to_market_index.to_le_bytes().as_ref()],
        bump,
    )]
    pub deposit_to_spot_market_vault: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(
        mut,
        seeds = [b"spot_market_vault".as_ref(), borrow_from_market_index.to_le_bytes().as_ref()],
        bump,
    )]
    pub borrow_from_spot_market_vault: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(
        mut,
        seeds = [b"spot_market_vault".as_ref(), borrow_to_market_index.to_le_bytes().as_ref()],
        bump,
    )]
    pub borrow_to_spot_market_vault: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(
        constraint = state.signer.eq(&drift_signer.key())
    )]
    /// CHECK: forced drift_signer
    pub drift_signer: AccountInfo<'info>,
}

#[derive(Accounts)]
pub struct TransferPerpPosition<'info> {
    #[account(
        mut,
        constraint = can_sign_for_user(&from_user, &authority)? && is_stats_for_user(&from_user, &user_stats)?
    )]
    pub from_user: AccountLoader<'info, User>,
    #[account(
        mut,
        constraint = can_sign_for_user(&to_user, &authority)? && is_stats_for_user(&to_user, &user_stats)?
    )]
    pub to_user: AccountLoader<'info, User>,
    #[account(mut)]
    pub user_stats: AccountLoader<'info, UserStats>,
    pub authority: Signer<'info>,
    pub state: Box<Account<'info, State>>,
}

#[derive(Accounts)]
pub struct PlaceOrder<'info> {
    pub state: Box<Account<'info, State>>,
    #[account(
        mut,
        constraint = can_sign_for_user(&user, &authority)?
    )]
    pub user: AccountLoader<'info, User>,
    pub authority: Signer<'info>,
}

#[derive(Accounts)]
pub struct CancelOrder<'info> {
    pub state: Box<Account<'info, State>>,
    #[account(
        mut,
        constraint = can_sign_for_user(&user, &authority)?
    )]
    pub user: AccountLoader<'info, User>,
    pub authority: Signer<'info>,
}

#[derive(Accounts)]
pub struct PlaceAndTake<'info> {
    pub state: Box<Account<'info, State>>,
    #[account(
        mut,
        constraint = can_sign_for_user(&user, &authority)?
    )]
    pub user: AccountLoader<'info, User>,
    #[account(
        mut,
        constraint = is_stats_for_user(&user, &user_stats)?
    )]
    pub user_stats: AccountLoader<'info, UserStats>,
    pub authority: Signer<'info>,
}

#[derive(Accounts)]
pub struct PlaceAndMake<'info> {
    pub state: Box<Account<'info, State>>,
    #[account(
        mut,
        constraint = can_sign_for_user(&user, &authority)?
    )]
    pub user: AccountLoader<'info, User>,
    #[account(
        mut,
        constraint = is_stats_for_user(&user, &user_stats)?
    )]
    pub user_stats: AccountLoader<'info, UserStats>,
    #[account(mut)]
    pub taker: AccountLoader<'info, User>,
    #[account(
        mut,
        constraint = is_stats_for_user(&taker, &taker_stats)?
    )]
    pub taker_stats: AccountLoader<'info, UserStats>,
    pub authority: Signer<'info>,
}

#[derive(Accounts)]
pub struct PlaceAndMakeSignedMsg<'info> {
    pub state: Box<Account<'info, State>>,
    #[account(
        mut,
        constraint = can_sign_for_user(&user, &authority)?
    )]
    pub user: AccountLoader<'info, User>,
    #[account(
        mut,
        constraint = is_stats_for_user(&user, &user_stats)?
    )]
    pub user_stats: AccountLoader<'info, UserStats>,
    #[account(mut)]
    pub taker: AccountLoader<'info, User>,
    #[account(
        mut,
        constraint = is_stats_for_user(&taker, &taker_stats)?
    )]
    pub taker_stats: AccountLoader<'info, UserStats>,
    #[account(
        seeds = [SIGNED_MSG_PDA_SEED.as_ref(), taker.load()?.authority.as_ref()],
        bump,
    )]
    /// CHECK: checked in SignedMsgUserOrdersZeroCopy checks
    pub taker_signed_msg_user_orders: AccountInfo<'info>,
    pub authority: Signer<'info>,
}

#[derive(Accounts)]
pub struct PlaceAndMatchRFQOrders<'info> {
    pub state: Box<Account<'info, State>>,
    #[account(mut)]
    pub user: AccountLoader<'info, User>,
    #[account(
        mut,
        constraint = is_stats_for_user(&user, &user_stats)?
    )]
    pub user_stats: AccountLoader<'info, UserStats>,
    pub authority: Signer<'info>,
    /// CHECK: The address check is needed because otherwise
    /// the supplied Sysvar could be anything else.
    /// The Instruction Sysvar has not been implemented
    /// in the Anchor framework yet, so this is the safe approach.
    #[account(address = IX_ID)]
    pub ix_sysvar: AccountInfo<'info>,
}

#[derive(Accounts)]
pub struct AddRemoveLiquidity<'info> {
    pub state: Box<Account<'info, State>>,
    #[account(
        mut,
        constraint = can_sign_for_user(&user, &authority)?,
    )]
    pub user: AccountLoader<'info, User>,
    pub authority: Signer<'info>,
}

#[derive(Accounts)]
pub struct RemoveLiquidityInExpiredMarket<'info> {
    pub state: Box<Account<'info, State>>,
    #[account(mut)]
    pub user: AccountLoader<'info, User>,
}

#[derive(Accounts)]
#[instruction(
    sub_account_id: u16,
)]
pub struct UpdateUser<'info> {
    #[account(
        mut,
        seeds = [b"user", authority.key.as_ref(), sub_account_id.to_le_bytes().as_ref()],
        bump,
    )]
    pub user: AccountLoader<'info, User>,
    pub authority: Signer<'info>,
}

#[derive(Accounts)]
pub struct DeleteUser<'info> {
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
    #[account(mut)]
    pub authority: Signer<'info>,
}

#[derive(Accounts)]
pub struct DeleteSignedMsgUserOrders<'info> {
    #[account(
        mut,
        close = authority,
        seeds = [SIGNED_MSG_PDA_SEED.as_ref(), authority.key().as_ref()],
        bump,
    )]
    pub signed_msg_user_orders: Box<Account<'info, SignedMsgUserOrders>>,
    #[account(mut)]
    pub state: Box<Account<'info, State>>,
    pub authority: Signer<'info>,
}

#[derive(Accounts)]
pub struct ReclaimRent<'info> {
    #[account(
        mut,
        has_one = authority,
    )]
    pub user: AccountLoader<'info, User>,
    #[account(
        mut,
        has_one = authority
    )]
    pub user_stats: AccountLoader<'info, UserStats>,
    pub state: Box<Account<'info, State>>,
    pub authority: Signer<'info>,
    pub rent: Sysvar<'info, Rent>,
}

#[derive(Accounts)]
#[instruction(in_market_index: u16, out_market_index: u16, )]
pub struct Swap<'info> {
    pub state: Box<Account<'info, State>>,
    #[account(
        mut,
        constraint = can_sign_for_user(&user, &authority)?
    )]
    pub user: AccountLoader<'info, User>,
    #[account(
        mut,
        constraint = is_stats_for_user(&user, &user_stats)?
    )]
    pub user_stats: AccountLoader<'info, UserStats>,
    pub authority: Signer<'info>,
    #[account(
        mut,
        seeds = [b"spot_market_vault".as_ref(), out_market_index.to_le_bytes().as_ref()],
        bump,
    )]
    pub out_spot_market_vault: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(
        mut,
        seeds = [b"spot_market_vault".as_ref(), in_market_index.to_le_bytes().as_ref()],
        bump,
    )]
    pub in_spot_market_vault: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(
        mut,
        constraint = &out_spot_market_vault.mint.eq(&out_token_account.mint),
        token::authority = authority
    )]
    pub out_token_account: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(
        mut,
        constraint = &in_spot_market_vault.mint.eq(&in_token_account.mint),
        token::authority = authority
    )]
    pub in_token_account: Box<InterfaceAccount<'info, TokenAccount>>,
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
#[instruction(
    sub_account_id: u16,
)]
pub struct EnableUserHighLeverageMode<'info> {
    pub state: Box<Account<'info, State>>,
    #[account(
        mut,
        constraint = can_sign_for_user(&user, &authority)?
    )]
    pub user: AccountLoader<'info, User>,
    pub authority: Signer<'info>,
    #[account(mut)]
    pub high_leverage_mode_config: AccountLoader<'info, HighLeverageModeConfig>,
}

#[derive(Accounts)]
pub struct UpdateUserProtectedMakerMode<'info> {
    pub state: Box<Account<'info, State>>,
    #[account(
        mut,
        constraint = can_sign_for_user(&user, &authority)?
    )]
    pub user: AccountLoader<'info, User>,
    pub authority: Signer<'info>,
    #[account(mut)]
    pub protected_maker_mode_config: AccountLoader<'info, ProtectedMakerModeConfig>,
}
