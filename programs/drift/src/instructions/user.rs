use anchor_lang::{prelude::*, AnchorDeserialize, AnchorSerialize};
use anchor_spl::token::{Token, TokenAccount};

use crate::controller::orders::cancel_orders;
use crate::controller::position::PositionDirection;
use crate::error::ErrorCode;
use crate::get_then_update_id;
use crate::instructions::constraints::*;
use crate::instructions::optional_accounts::{
    get_maker_and_maker_stats, get_optional_user_and_user_stats, get_serum_fulfillment_accounts,
    get_spot_market_vaults, get_whitelist_token, load_maps, AccountMaps,
};
use crate::instructions::SpotFulfillmentType;
use crate::load;
use crate::load_mut;
use crate::math::casting::Cast;
use crate::math::liquidation::is_user_being_liquidated;
use crate::math::margin::{
    calculate_max_withdrawable_amount, meets_initial_margin_requirement,
    meets_withdraw_margin_requirement, validate_spot_margin_trading,
};
use crate::math::safe_math::SafeMath;
use crate::math::spot_balance::get_token_amount;
use crate::math::spot_withdraw::validate_spot_market_vault_amount;
use crate::math_error;
use crate::print_error;
use crate::safe_decrement;
use crate::safe_increment;
use crate::state::events::{
    DepositDirection, DepositRecord, LPAction, LPRecord, NewUserRecord, OrderActionExplanation,
};
use crate::state::perp_market::MarketStatus;
use crate::state::perp_market_map::{get_writable_perp_market_set, MarketSet};
use crate::state::spot_market::SpotBalanceType;
use crate::state::spot_market_map::get_writable_spot_market_set;
use crate::state::state::State;
use crate::state::user::{MarketType, OrderTriggerCondition, OrderType, User, UserStats};
use crate::validate;
use crate::validation::user::validate_user_deletion;
use crate::validation::whitelist::validate_whitelist_token;
use crate::{controller, math};

pub fn handle_initialize_user(
    ctx: Context<InitializeUser>,
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
    if user_stats.number_of_sub_accounts == 1 {
        let (referrer, referrer_stats) = get_optional_user_and_user_stats(remaining_accounts_iter)?;
        let referrer = if let (Some(referrer), Some(referrer_stats)) = (referrer, referrer_stats) {
            let referrer = load!(referrer)?;
            let mut referrer_stats = load_mut!(referrer_stats)?;

            validate!(referrer.sub_account_id == 0, ErrorCode::InvalidReferrer)?;

            validate!(
                referrer.authority == referrer_stats.authority,
                ErrorCode::ReferrerAndReferrerStatsAuthorityUnequal
            )?;

            referrer_stats.is_referrer = true;

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

    user_stats.max_sub_account_id = user_stats.max_sub_account_id.max(sub_account_id);

    emit!(NewUserRecord {
        ts: Clock::get()?.unix_timestamp,
        user_authority: ctx.accounts.authority.key(),
        user: user_key,
        sub_account_id,
        name,
        referrer: user_stats.referrer
    });

    Ok(())
}

pub fn handle_initialize_user_stats(ctx: Context<InitializeUserStats>) -> Result<()> {
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
        ..UserStats::default()
    };

    let state = &mut ctx.accounts.state;
    safe_increment!(state.number_of_authorities, 1);

    Ok(())
}

pub fn handle_deposit(
    ctx: Context<Deposit>,
    market_index: u16,
    amount: u64,
    reduce_only: bool,
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
        &MarketSet::new(),
        &get_writable_spot_market_set(market_index),
        clock.slot,
        Some(state.oracle_guard_rails),
    )?;

    if amount == 0 {
        return Err(ErrorCode::InsufficientDeposit.into());
    }

    validate!(!user.is_bankrupt, ErrorCode::UserBankrupt)?;

    let spot_market = &mut spot_market_map.get_ref_mut(&market_index)?;
    let oracle_price_data = &oracle_map.get_price_data(&spot_market.oracle)?.clone();

    validate!(
        !matches!(spot_market.status, MarketStatus::Initialized),
        ErrorCode::MarketBeingInitialized,
        "Market is being initialized"
    )?;

    controller::spot_balance::update_spot_market_cumulative_interest(
        spot_market,
        Some(oracle_price_data),
        now,
    )?;

    let position_index = user.force_get_spot_position_index(spot_market.market_index)?;

    let force_reduce_only = spot_market.is_reduce_only()?;

    // if reduce only, have to compare ix amount to current borrow amount
    let amount = if (force_reduce_only || reduce_only)
        && user.spot_positions[position_index].balance_type == SpotBalanceType::Borrow
    {
        user.spot_positions[position_index]
            .get_token_amount(spot_market)?
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
        spot_market,
        spot_position,
        false,
        None,
    )?;

    if spot_position.balance_type == SpotBalanceType::Deposit && spot_position.scaled_balance > 0 {
        validate!(
            matches!(
                spot_market.status,
                MarketStatus::Active
                    | MarketStatus::FundingPaused
                    | MarketStatus::AmmPaused
                    | MarketStatus::FillPaused
                    | MarketStatus::WithdrawPaused
            ),
            ErrorCode::MarketActionPaused,
            "spot_market in reduce only mode",
        )?;
    }

    if user.is_being_liquidated {
        // try to update liquidation status if user is was already being liq'd
        user.is_being_liquidated = is_user_being_liquidated(
            user,
            &perp_market_map,
            &spot_market_map,
            &mut oracle_map,
            state.liquidation_margin_buffer_ratio,
        )?;
    }

    controller::token::receive(
        &ctx.accounts.token_program,
        &ctx.accounts.user_token_account,
        &ctx.accounts.spot_market_vault,
        &ctx.accounts.authority,
        amount,
    )?;
    ctx.accounts.spot_market_vault.reload()?;

    let deposit_record_id = get_then_update_id!(spot_market, next_deposit_record_id);
    let oracle_price = oracle_price_data.price;
    let deposit_record = DepositRecord {
        ts: now,
        deposit_record_id,
        user_authority: user.authority,
        user: user_key,
        direction: DepositDirection::DEPOSIT,
        amount,
        oracle_price,
        market_deposit_balance: spot_market.deposit_balance,
        market_withdraw_balance: spot_market.borrow_balance,
        market_cumulative_deposit_interest: spot_market.cumulative_deposit_interest,
        market_cumulative_borrow_interest: spot_market.cumulative_borrow_interest,
        total_deposits_after,
        total_withdraws_after,
        market_index,
        transfer_user: None,
    };
    emit!(deposit_record);

    let deposits_token_amount = get_token_amount(
        spot_market.deposit_balance,
        spot_market,
        &SpotBalanceType::Deposit,
    )?;

    validate!(
        spot_market.max_token_deposits == 0
            || deposits_token_amount <= spot_market.max_token_deposits.cast()?,
        ErrorCode::MaxDeposit,
        "max deposits: {} new deposits {}",
        spot_market.max_token_deposits,
        deposits_token_amount
    )?;

    Ok(())
}

#[access_control(
    withdraw_not_paused(&ctx.accounts.state)
)]
pub fn handle_withdraw(
    ctx: Context<Withdraw>,
    market_index: u16,
    amount: u64,
    reduce_only: bool,
) -> anchor_lang::Result<()> {
    let user_key = ctx.accounts.user.key();
    let user = &mut load_mut!(ctx.accounts.user)?;
    let clock = Clock::get()?;
    let now = clock.unix_timestamp;
    let state = &ctx.accounts.state;

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

    validate!(!user.is_bankrupt, ErrorCode::UserBankrupt)?;

    let spot_market_is_reduce_only = {
        let spot_market = &mut spot_market_map.get_ref_mut(&market_index)?;
        let oracle_price_data = oracle_map.get_price_data(&spot_market.oracle)?;

        controller::spot_balance::update_spot_market_cumulative_interest(
            spot_market,
            Some(oracle_price_data),
            now,
        )?;

        spot_market.is_reduce_only()?
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

        let spot_position = user.force_get_spot_position_mut(market_index)?;

        let spot_market = &mut spot_market_map.get_ref_mut(&market_index)?;
        // prevents withdraw when limits hit
        controller::spot_position::update_spot_balances_and_cumulative_deposits_with_limits(
            amount as u128,
            &SpotBalanceType::Borrow,
            spot_market,
            spot_position,
        )?;

        amount
    };

    meets_withdraw_margin_requirement(user, &perp_market_map, &spot_market_map, &mut oracle_map)?;

    validate_spot_margin_trading(user, &spot_market_map, &mut oracle_map)?;

    user.is_being_liquidated = false;

    let mut spot_market = spot_market_map.get_ref_mut(&market_index)?;
    let oracle_price_data = oracle_map.get_price_data(&spot_market.oracle)?;
    let oracle_price = oracle_price_data.price;

    user.increment_total_withdraws(
        amount,
        oracle_price_data.price,
        spot_market.get_precision().cast()?,
    )?;

    let deposit_record_id = get_then_update_id!(spot_market, next_deposit_record_id);
    let deposit_record = DepositRecord {
        ts: now,
        deposit_record_id,
        user_authority: user.authority,
        user: user_key,
        direction: DepositDirection::WITHDRAW,
        oracle_price,
        amount,
        market_index,
        market_deposit_balance: spot_market.deposit_balance,
        market_withdraw_balance: spot_market.borrow_balance,
        market_cumulative_deposit_interest: spot_market.cumulative_deposit_interest,
        market_cumulative_borrow_interest: spot_market.cumulative_borrow_interest,
        total_deposits_after: user.total_deposits,
        total_withdraws_after: user.total_withdraws,
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
    )?;

    // reload the spot market vault balance so it's up-to-date
    ctx.accounts.spot_market_vault.reload()?;
    math::spot_withdraw::validate_spot_market_vault_amount(
        &spot_market,
        ctx.accounts.spot_market_vault.amount,
    )?;

    Ok(())
}

#[access_control(
    withdraw_not_paused(&ctx.accounts.state)
)]
pub fn handle_transfer_deposit(
    ctx: Context<TransferDeposit>,
    market_index: u16,
    amount: u64,
) -> anchor_lang::Result<()> {
    let authority_key = ctx.accounts.authority.key;
    let to_user_key = ctx.accounts.to_user.key();
    let from_user_key = ctx.accounts.from_user.key();

    let state = &ctx.accounts.state;
    let clock = Clock::get()?;

    let to_user = &mut load_mut!(ctx.accounts.to_user)?;
    let from_user = &mut load_mut!(ctx.accounts.from_user)?;

    validate!(
        !to_user.is_bankrupt,
        ErrorCode::UserBankrupt,
        "to_user bankrupt"
    )?;
    validate!(
        !from_user.is_bankrupt,
        ErrorCode::UserBankrupt,
        "from_user bankrupt"
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
        let oracle_price_data = oracle_map.get_price_data(&spot_market.oracle)?;
        controller::spot_balance::update_spot_market_cumulative_interest(
            spot_market,
            Some(oracle_price_data),
            clock.unix_timestamp,
        )?;
    }

    {
        let spot_market = &mut spot_market_map.get_ref_mut(&market_index)?;
        validate!(
            matches!(
                spot_market.status,
                MarketStatus::Active
                    | MarketStatus::AmmPaused
                    | MarketStatus::FundingPaused
                    | MarketStatus::FillPaused
                    | MarketStatus::ReduceOnly
                    | MarketStatus::Settlement
            ),
            ErrorCode::MarketWithdrawPaused,
            "Spot Market {} withdraws are currently paused",
            spot_market.market_index
        )?;

        let from_spot_position = from_user.force_get_spot_position_mut(spot_market.market_index)?;

        // prevents withdraw when limits hit
        controller::spot_position::update_spot_balances_and_cumulative_deposits_with_limits(
            amount as u128,
            &SpotBalanceType::Borrow,
            spot_market,
            from_spot_position,
        )?;
    }

    validate!(
        meets_withdraw_margin_requirement(
            from_user,
            &perp_market_map,
            &spot_market_map,
            &mut oracle_map,
        )?,
        ErrorCode::InsufficientCollateral,
        "From user does not meet initial margin requirement"
    )?;

    validate_spot_margin_trading(from_user, &spot_market_map, &mut oracle_map)?;

    from_user.is_being_liquidated = false;

    let oracle_price = {
        let spot_market = &spot_market_map.get_ref(&market_index)?;
        oracle_map.get_price_data(&spot_market.oracle)?.price
    };

    {
        let spot_market = &mut spot_market_map.get_ref_mut(&market_index)?;

        from_user.increment_total_withdraws(
            amount,
            oracle_price,
            spot_market.get_precision().cast()?,
        )?;

        let deposit_record_id = get_then_update_id!(spot_market, next_deposit_record_id);
        let deposit_record = DepositRecord {
            ts: clock.unix_timestamp,
            deposit_record_id,
            user_authority: *authority_key,
            user: from_user_key,
            direction: DepositDirection::WITHDRAW,
            amount,
            oracle_price,
            market_index,
            market_deposit_balance: spot_market.deposit_balance,
            market_withdraw_balance: spot_market.borrow_balance,
            market_cumulative_deposit_interest: spot_market.cumulative_deposit_interest,
            market_cumulative_borrow_interest: spot_market.cumulative_borrow_interest,
            total_deposits_after: from_user.total_deposits,
            total_withdraws_after: from_user.total_withdraws,
            transfer_user: Some(to_user_key),
        };
        emit!(deposit_record);
    }

    {
        let spot_market = &mut spot_market_map.get_ref_mut(&market_index)?;

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

        let deposit_record_id = get_then_update_id!(spot_market, next_deposit_record_id);
        let deposit_record = DepositRecord {
            ts: clock.unix_timestamp,
            deposit_record_id,
            user_authority: *authority_key,
            user: to_user_key,
            direction: DepositDirection::DEPOSIT,
            amount,
            oracle_price,
            market_index,
            market_deposit_balance: spot_market.deposit_balance,
            market_withdraw_balance: spot_market.borrow_balance,
            market_cumulative_deposit_interest: spot_market.cumulative_deposit_interest,
            market_cumulative_borrow_interest: spot_market.cumulative_borrow_interest,
            total_deposits_after,
            total_withdraws_after,
            transfer_user: Some(from_user_key),
        };
        emit!(deposit_record);
    }

    let spot_market = spot_market_map.get_ref(&market_index)?;
    math::spot_withdraw::validate_spot_market_vault_amount(
        &spot_market,
        ctx.accounts.spot_market_vault.amount,
    )?;

    Ok(())
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Default)]
pub struct OrderParams {
    pub order_type: OrderType,
    pub market_type: MarketType,
    pub direction: PositionDirection,
    pub user_order_id: u8,
    pub base_asset_amount: u64,
    pub price: u64,
    pub market_index: u16,
    pub reduce_only: bool,
    pub post_only: bool,
    pub immediate_or_cancel: bool,
    pub max_ts: Option<i64>,
    pub trigger_price: Option<u64>,
    pub trigger_condition: OrderTriggerCondition,
    pub oracle_price_offset: Option<i32>,
    pub auction_duration: Option<u8>,
    pub auction_start_price: Option<u64>,
    pub auction_end_price: Option<u64>,
}

#[access_control(
    exchange_not_paused(&ctx.accounts.state)
)]
pub fn handle_place_perp_order(ctx: Context<PlaceOrder>, params: OrderParams) -> Result<()> {
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

    controller::orders::place_perp_order(
        &ctx.accounts.state,
        &ctx.accounts.user,
        &perp_market_map,
        &spot_market_map,
        &mut oracle_map,
        clock,
        params,
    )?;

    Ok(())
}

#[access_control(
    exchange_not_paused(&ctx.accounts.state)
)]
pub fn handle_cancel_order(ctx: Context<CancelOrder>, order_id: Option<u32>) -> Result<()> {
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
pub fn handle_cancel_order_by_user_id(ctx: Context<CancelOrder>, user_order_id: u8) -> Result<()> {
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
pub fn handle_cancel_orders(
    ctx: Context<CancelOrder>,
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
    fill_not_paused(&ctx.accounts.state)
)]
pub fn handle_place_and_take_perp_order<'info>(
    ctx: Context<PlaceAndTake>,
    params: OrderParams,
    maker_order_id: Option<u32>,
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

    if params.post_only {
        msg!("post_only cant be used in place_and_take");
        return Err(print_error!(ErrorCode::InvalidOrderPostOnly)().into());
    }

    let (maker, maker_stats) = match maker_order_id {
        Some(_) => {
            let (user, user_stats) = get_maker_and_maker_stats(remaining_accounts_iter)?;
            (Some(user), Some(user_stats))
        }
        None => (None, None),
    };

    let (referrer, referrer_stats) = get_optional_user_and_user_stats(remaining_accounts_iter)?;

    let is_immediate_or_cancel = params.immediate_or_cancel;

    controller::repeg::update_amm(
        params.market_index,
        &perp_market_map,
        &mut oracle_map,
        &ctx.accounts.state,
        &Clock::get()?,
    )?;

    controller::orders::place_perp_order(
        &ctx.accounts.state,
        &ctx.accounts.user,
        &perp_market_map,
        &spot_market_map,
        &mut oracle_map,
        &Clock::get()?,
        params,
    )?;

    let user = &mut ctx.accounts.user;
    let order_id = load!(user)?.get_last_order_id();

    controller::orders::fill_perp_order(
        order_id,
        &ctx.accounts.state,
        user,
        &ctx.accounts.user_stats,
        &spot_market_map,
        &perp_market_map,
        &mut oracle_map,
        &user.clone(),
        &ctx.accounts.user_stats.clone(),
        maker.as_ref(),
        maker_stats.as_ref(),
        maker_order_id,
        referrer.as_ref(),
        referrer_stats.as_ref(),
        &Clock::get()?,
    )?;

    let order_exists = load!(ctx.accounts.user)?
        .orders
        .iter()
        .any(|order| order.order_id == order_id);

    if is_immediate_or_cancel && order_exists {
        controller::orders::cancel_order_by_order_id(
            order_id,
            &ctx.accounts.user,
            &perp_market_map,
            &spot_market_map,
            &mut oracle_map,
            &Clock::get()?,
        )?;
    }

    Ok(())
}

#[access_control(
    fill_not_paused(&ctx.accounts.state)
)]
pub fn handle_place_and_make_perp_order<'info>(
    ctx: Context<PlaceAndMake>,
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

    let (referrer, referrer_stats) = get_optional_user_and_user_stats(remaining_accounts_iter)?;

    if !params.immediate_or_cancel || !params.post_only || params.order_type != OrderType::Limit {
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

    controller::orders::place_perp_order(
        state,
        &ctx.accounts.user,
        &perp_market_map,
        &spot_market_map,
        &mut oracle_map,
        clock,
        params,
    )?;

    let order_id = load!(ctx.accounts.user)?.get_last_order_id();

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
        Some(&ctx.accounts.user),
        Some(&ctx.accounts.user_stats),
        Some(order_id),
        referrer.as_ref(),
        referrer_stats.as_ref(),
        clock,
    )?;

    let order_exists = load!(ctx.accounts.user)?
        .orders
        .iter()
        .any(|order| order.order_id == order_id);

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

pub fn handle_place_spot_order(ctx: Context<PlaceOrder>, params: OrderParams) -> Result<()> {
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

    controller::orders::place_spot_order(
        &ctx.accounts.state,
        &ctx.accounts.user,
        &perp_market_map,
        &spot_market_map,
        &mut oracle_map,
        &Clock::get()?,
        params,
    )?;

    Ok(())
}

#[access_control(
    fill_not_paused(&ctx.accounts.state)
)]
pub fn handle_place_and_take_spot_order<'info>(
    ctx: Context<PlaceAndTake>,
    params: OrderParams,
    fulfillment_type: Option<SpotFulfillmentType>,
    maker_order_id: Option<u32>,
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
        &get_writable_perp_market_set(params.market_index),
        &MarketSet::new(),
        clock.slot,
        None,
    )?;

    if params.post_only {
        msg!("post_only cant be used in place_and_take");
        return Err(print_error!(ErrorCode::InvalidOrderPostOnly)().into());
    }

    let (maker, maker_stats) = match maker_order_id {
        Some(_) => {
            let (user, user_stats) = get_maker_and_maker_stats(remaining_accounts_iter)?;
            (Some(user), Some(user_stats))
        }
        None => (None, None),
    };

    let (_referrer, _referrer_stats) = get_optional_user_and_user_stats(remaining_accounts_iter)?;

    let is_immediate_or_cancel = params.immediate_or_cancel;

    let mut serum_fulfillment_params = match fulfillment_type {
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

    controller::orders::place_spot_order(
        &ctx.accounts.state,
        &ctx.accounts.user,
        &perp_market_map,
        &spot_market_map,
        &mut oracle_map,
        &Clock::get()?,
        params,
    )?;

    let user = &mut ctx.accounts.user;
    let order_id = load!(user)?.get_last_order_id();

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
        maker.as_ref(),
        maker_stats.as_ref(),
        maker_order_id,
        &Clock::get()?,
        &mut serum_fulfillment_params,
    )?;

    let order_exists = load!(ctx.accounts.user)?
        .orders
        .iter()
        .any(|order| order.order_id == order_id);

    if is_immediate_or_cancel && order_exists {
        controller::orders::cancel_order_by_order_id(
            order_id,
            &ctx.accounts.user,
            &perp_market_map,
            &spot_market_map,
            &mut oracle_map,
            &Clock::get()?,
        )?;
    }

    match serum_fulfillment_params {
        Some(serum_fulfillment_params) => {
            let base_market = spot_market_map.get_ref(&market_index)?;
            validate_spot_market_vault_amount(
                &base_market,
                serum_fulfillment_params.base_market_vault.amount,
            )?;
            let quote_market = spot_market_map.get_quote_spot_market()?;
            validate_spot_market_vault_amount(
                &quote_market,
                serum_fulfillment_params.quote_market_vault.amount,
            )?;
        }
        None => {
            let base_market = spot_market_map.get_ref(&market_index)?;
            let quote_market = spot_market_map.get_quote_spot_market()?;
            let (base_market_vault, quote_market_vault) =
                get_spot_market_vaults(remaining_accounts_iter, &base_market, &quote_market)?;
            validate_spot_market_vault_amount(&base_market, base_market_vault.amount)?;
            validate_spot_market_vault_amount(&quote_market, quote_market_vault.amount)?;
        }
    }

    Ok(())
}

#[access_control(
    fill_not_paused(&ctx.accounts.state)
)]
pub fn handle_place_and_make_spot_order<'info>(
    ctx: Context<PlaceAndMake>,
    params: OrderParams,
    taker_order_id: u32,
    fulfillment_type: Option<SpotFulfillmentType>,
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
        None,
    )?;

    let (_referrer, _referrer_stats) = get_optional_user_and_user_stats(remaining_accounts_iter)?;

    if !params.immediate_or_cancel || !params.post_only || params.order_type != OrderType::Limit {
        msg!("place_and_make must use IOC post only limit order");
        return Err(print_error!(ErrorCode::InvalidOrderIOCPostOnly)().into());
    }

    let market_index = params.market_index;
    let mut serum_fulfillment_params = match fulfillment_type {
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

    controller::orders::place_spot_order(
        state,
        &ctx.accounts.user,
        &perp_market_map,
        &spot_market_map,
        &mut oracle_map,
        clock,
        params,
    )?;

    let order_id = load!(ctx.accounts.user)?.get_last_order_id();

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
        Some(&ctx.accounts.user),
        Some(&ctx.accounts.user_stats),
        Some(order_id),
        clock,
        &mut serum_fulfillment_params,
    )?;

    let order_exists = load!(ctx.accounts.user)?
        .orders
        .iter()
        .any(|order| order.order_id == order_id);

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

    match serum_fulfillment_params {
        Some(serum_fulfillment_params) => {
            let base_market = spot_market_map.get_ref(&market_index)?;
            validate_spot_market_vault_amount(
                &base_market,
                serum_fulfillment_params.base_market_vault.amount,
            )?;
            let quote_market = spot_market_map.get_quote_spot_market()?;
            validate_spot_market_vault_amount(
                &quote_market,
                serum_fulfillment_params.quote_market_vault.amount,
            )?;
        }
        None => {
            let base_market = spot_market_map.get_ref(&market_index)?;
            let quote_market = spot_market_map.get_quote_spot_market()?;
            let (base_market_vault, quote_market_vault) =
                get_spot_market_vaults(remaining_accounts_iter, &base_market, &quote_market)?;
            validate_spot_market_vault_amount(&base_market, base_market_vault.amount)?;
            validate_spot_market_vault_amount(&quote_market, quote_market_vault.amount)?;
        }
    }

    Ok(())
}

#[access_control(
    amm_not_paused(&ctx.accounts.state)
)]
pub fn handle_add_perp_lp_shares<'info>(
    ctx: Context<AddRemoveLiquidity>,
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

    validate!(!user.is_bankrupt, ErrorCode::UserBankrupt)?;
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
            matches!(
                market.status,
                MarketStatus::Active
                    | MarketStatus::FundingPaused
                    | MarketStatus::FillPaused
                    | MarketStatus::WithdrawPaused
            ),
            ErrorCode::MarketStatusInvalidForNewLP,
            "Market Status doesn't allow for new LP liquidity"
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
    validate!(
        meets_initial_margin_requirement(
            user,
            &perp_market_map,
            &spot_market_map,
            &mut oracle_map
        )?,
        ErrorCode::InsufficientCollateral,
        "User does not meet initial margin requirement"
    )?;

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

pub fn handle_remove_perp_lp_shares_in_expiring_market(
    ctx: Context<RemoveLiquidityInExpiredMarket>,
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

    Ok(())
}

#[access_control(
    amm_not_paused(&ctx.accounts.state)
)]
pub fn handle_remove_perp_lp_shares(
    ctx: Context<AddRemoveLiquidity>,
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

pub fn handle_update_user_delegate(
    ctx: Context<UpdateUser>,
    _sub_account_id: u16,
    delegate: Pubkey,
) -> Result<()> {
    let mut user = load_mut!(ctx.accounts.user)?;
    user.delegate = delegate;
    Ok(())
}

pub fn handle_delete_user(ctx: Context<DeleteUser>) -> Result<()> {
    let user = &load!(ctx.accounts.user)?;
    let user_stats = &mut load_mut!(ctx.accounts.user_stats)?;

    validate_user_deletion(user, user_stats)?;

    safe_decrement!(user_stats.number_of_sub_accounts, 1);

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
        space = std::mem::size_of::<User>() + 8,
        bump,
        payer = payer
    )]
    pub user: AccountLoader<'info, User>,
    #[account(
        mut,
        has_one = authority
    )]
    pub user_stats: AccountLoader<'info, UserStats>,
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
        space = std::mem::size_of::<UserStats>() + 8,
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
    pub spot_market_vault: Box<Account<'info, TokenAccount>>,
    #[account(
        mut,
        constraint = &spot_market_vault.mint.eq(&user_token_account.mint),
        token::authority = authority
    )]
    pub user_token_account: Box<Account<'info, TokenAccount>>,
    pub token_program: Program<'info, Token>,
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
    pub spot_market_vault: Box<Account<'info, TokenAccount>>,
    #[account(
        constraint = state.signer.eq(&drift_signer.key())
    )]
    /// CHECK: forced drift_signer
    pub drift_signer: AccountInfo<'info>,
    #[account(
        mut,
        constraint = &spot_market_vault.mint.eq(&user_token_account.mint)
    )]
    pub user_token_account: Box<Account<'info, TokenAccount>>,
    pub token_program: Program<'info, Token>,
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
    pub spot_market_vault: Box<Account<'info, TokenAccount>>,
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
    pub state: Box<Account<'info, State>>,
    pub authority: Signer<'info>,
}
