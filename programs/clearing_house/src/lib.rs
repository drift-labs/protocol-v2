#![allow(clippy::too_many_arguments)]
#![allow(unaligned_references)]
#![allow(clippy::bool_assert_comparison)]
#![allow(clippy::comparison_chain)]

use anchor_lang::prelude::*;
use borsh::BorshSerialize;

use context::*;
use error::ErrorCode;
use instructions::*;
#[cfg(test)]
use math::amm;
use math::{bn, constants::*, margin::*};
use state::oracle::OracleSource;

use crate::state::events::{LPAction, LPRecord};
use crate::state::market::{ContractTier, MarketStatus, PerpMarket};
use crate::state::spot_market::AssetTier;
use crate::state::user::PerpPosition;
use crate::state::{state::*, user::*};

pub mod context;
pub mod controller;
pub mod error;
pub mod ids;
pub mod instructions;
pub mod macros;
pub mod math;
pub mod optional_accounts;
mod signer;
pub mod state;
#[cfg(test)]
mod tests;
mod validation;

#[cfg(feature = "mainnet-beta")]
declare_id!("dammHkt7jmytvbS3nHTxQNEcP59aE57nxwV21YdqEDN");
#[cfg(not(feature = "mainnet-beta"))]
declare_id!("DUZwKJKAk2C9S88BYvQzck1M1i5hySQjxB4zW6tJ29Nw");

#[program]
pub mod clearing_house {
    use std::option::Option::Some;

    use crate::context::UpdateSpotMarketCumulativeInterest;
    use crate::controller::lp::burn_lp_shares;
    use crate::controller::position::get_position_index;
    use crate::instructions::{
        AdminUpdateK, AdminUpdateMarket, AdminUpdateSpotMarket, AdminUpdateState,
        DepositIntoMarketFeePool, Initialize, InitializeMarket, InitializeSerumFulfillmentConfig,
        InitializeSpotMarket, RepegCurve, SettleExpiredMarketPoolsToRevenuePool, UpdateSerumVault,
    };
    use crate::math;
    use crate::math::casting::Cast;
    use crate::math::insurance::if_shares_to_vault_amount;
    use crate::math::spot_balance::get_token_amount;
    use crate::optional_accounts::{
        get_maker_and_maker_stats, get_referrer_and_referrer_stats, get_serum_fulfillment_accounts,
        get_whitelist_token,
    };
    use crate::state::events::DepositRecord;
    use crate::state::events::{DepositDirection, NewUserRecord};
    use crate::state::insurance_fund_stake::InsuranceFundStake;
    use crate::state::oracle_map::OracleMap;
    use crate::state::perp_market_map::{
        get_market_set, get_market_set_for_user_positions, get_market_set_from_list, MarketSet,
        PerpMarketMap,
    };
    use crate::state::spot_market::{AssetTier, SpotBalanceType};
    use crate::state::spot_market_map::{
        get_writable_spot_market_set, SpotMarketMap, SpotMarketSet,
    };
    use crate::state::state::FeeStructure;
    use crate::validation::user::validate_user_deletion;
    use crate::validation::whitelist::validate_whitelist_token;

    use super::*;

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

    pub fn update_serum_vault(ctx: Context<UpdateSerumVault>) -> Result<()> {
        handle_update_serum_vault(ctx)
    }

    pub fn initialize_serum_fulfillment_config(
        ctx: Context<InitializeSerumFulfillmentConfig>,
        market_index: u16,
    ) -> Result<()> {
        handle_initialize_serum_fulfillment_config(ctx, market_index)
    }

    pub fn initialize_market(
        ctx: Context<InitializeMarket>,
        amm_base_asset_reserve: u128,
        amm_quote_asset_reserve: u128,
        amm_periodicity: i64,
        amm_peg_multiplier: u128,
        oracle_source: OracleSource,
        margin_ratio_initial: u32,
        margin_ratio_maintenance: u32,
        liquidation_fee: u128,
        active_status: bool,
    ) -> Result<()> {
        handle_initialize_market(
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
        )
    }

    pub fn deposit(
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

        validate!(!user.bankrupt, ErrorCode::UserBankrupt)?;

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

        let _market_map = PerpMarketMap::load(&MarketSet::new(), remaining_accounts_iter)?;

        if amount == 0 {
            return Err(ErrorCode::InsufficientDeposit.into());
        }

        validate!(!user.bankrupt, ErrorCode::UserBankrupt)?;

        let spot_market = &mut spot_market_map.get_ref_mut(&market_index)?;
        let oracle_price_data = oracle_map.get_price_data(&spot_market.oracle)?;

        controller::spot_balance::update_spot_market_cumulative_interest(
            spot_market,
            Some(oracle_price_data),
            now,
        )?;

        let spot_position = user.force_get_spot_position_mut(spot_market.market_index)?;

        let force_reduce_only = spot_market.is_reduce_only()?;

        // if reduce only, have to compare ix amount to current borrow amount
        let amount = if (force_reduce_only || reduce_only)
            && spot_position.balance_type == SpotBalanceType::Borrow
        {
            spot_position
                .get_token_amount(spot_market)?
                .cast::<u64>()?
                .min(amount)
        } else {
            amount
        };

        controller::spot_position::update_spot_position_balance(
            amount as u128,
            &SpotBalanceType::Deposit,
            spot_market,
            spot_position,
            false,
        )?;

        if spot_position.balance_type == SpotBalanceType::Deposit && spot_position.balance > 0 {
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

        controller::token::receive(
            &ctx.accounts.token_program,
            &ctx.accounts.user_token_account,
            &ctx.accounts.spot_market_vault,
            &ctx.accounts.authority,
            amount,
        )?;
        let oracle_price = oracle_price_data.price;
        let deposit_record = DepositRecord {
            ts: now,
            user_authority: user.authority,
            user: user_key,
            direction: DepositDirection::DEPOSIT,
            amount,
            oracle_price,
            market_deposit_balance: spot_market.deposit_balance,
            market_withdraw_balance: spot_market.borrow_balance,
            market_cumulative_deposit_interest: spot_market.cumulative_deposit_interest,
            market_cumulative_borrow_interest: spot_market.cumulative_borrow_interest,
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
                || deposits_token_amount <= spot_market.max_token_deposits,
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
    pub fn withdraw(
        ctx: Context<Withdraw>,
        market_index: u16,
        amount: u64,
        reduce_only: bool,
    ) -> Result<()> {
        let user_key = ctx.accounts.user.key();
        let user = &mut load_mut!(ctx.accounts.user)?;
        let clock = Clock::get()?;
        let now = clock.unix_timestamp;
        let state = &ctx.accounts.state;

        validate!(!user.bankrupt, ErrorCode::UserBankrupt)?;

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
        let market_map = PerpMarketMap::load(&MarketSet::new(), remaining_accounts_iter)?;

        let amount = {
            let spot_market = &mut spot_market_map.get_ref_mut(&market_index)?;
            let oracle_price_data = oracle_map.get_price_data(&spot_market.oracle)?;

            controller::spot_balance::update_spot_market_cumulative_interest(
                spot_market,
                Some(oracle_price_data),
                now,
            )?;

            let spot_position = user.force_get_spot_position_mut(spot_market.market_index)?;

            let force_reduce_only = spot_market.is_reduce_only()?;

            // if reduce only, have to compare ix amount to current deposit amount
            let amount = if (force_reduce_only || reduce_only)
                && spot_position.balance_type == SpotBalanceType::Deposit
            {
                spot_position
                    .get_token_amount(spot_market)?
                    .cast::<u64>()?
                    .min(amount)
            } else {
                amount
            };

            // prevents withdraw when limits hit
            controller::spot_balance::update_spot_position_balance_with_limits(
                amount as u128,
                &SpotBalanceType::Borrow,
                spot_market,
                spot_position,
            )?;

            amount
        };

        meets_withdraw_margin_requirement(user, &market_map, &spot_market_map, &mut oracle_map)?;

        let spot_market = spot_market_map.get_ref(&market_index)?;
        let oracle_price_data = oracle_map.get_price_data(&spot_market.oracle)?;
        let oracle_price = oracle_price_data.price;

        user.being_liquidated = false;

        controller::token::send_from_program_vault(
            &ctx.accounts.token_program,
            &ctx.accounts.spot_market_vault,
            &ctx.accounts.user_token_account,
            &ctx.accounts.clearing_house_signer,
            state.signer_nonce,
            amount,
        )?;

        let deposit_record = DepositRecord {
            ts: now,
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
            transfer_user: None,
        };
        emit!(deposit_record);

        // reload the spot market vault balance so it's up-to-date
        ctx.accounts.spot_market_vault.reload()?;
        math::spot_balance::validate_spot_balances(&spot_market)?;

        Ok(())
    }

    #[access_control(
        withdraw_not_paused(&ctx.accounts.state)
    )]
    pub fn transfer_deposit(
        ctx: Context<TransferDeposit>,
        market_index: u16,
        amount: u64,
    ) -> Result<()> {
        let authority_key = ctx.accounts.authority.key;
        let to_user_key = ctx.accounts.to_user.key();
        let from_user_key = ctx.accounts.from_user.key();

        let state = &ctx.accounts.state;
        let clock = Clock::get()?;

        let to_user = &mut load_mut!(ctx.accounts.to_user)?;
        let from_user = &mut load_mut!(ctx.accounts.from_user)?;

        validate!(
            !to_user.bankrupt,
            ErrorCode::UserBankrupt,
            "to_user bankrupt"
        )?;
        validate!(
            !from_user.bankrupt,
            ErrorCode::UserBankrupt,
            "from_user bankrupt"
        )?;

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
        let market_map = PerpMarketMap::load(&MarketSet::new(), remaining_accounts_iter)?;

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
                spot_market.status != MarketStatus::WithdrawPaused,
                ErrorCode::DailyWithdrawLimit
            )?;

            let from_spot_position =
                from_user.force_get_spot_position_mut(spot_market.market_index)?;

            controller::spot_position::update_spot_position_balance(
                amount as u128,
                &SpotBalanceType::Borrow,
                spot_market,
                from_spot_position,
                true,
            )?;
        }

        validate!(
            meets_withdraw_margin_requirement(
                from_user,
                &market_map,
                &spot_market_map,
                &mut oracle_map,
            )?,
            ErrorCode::InsufficientCollateral,
            "From user does not meet initial margin requirement"
        )?;

        from_user.being_liquidated = false;

        let oracle_price = {
            let spot_market = &spot_market_map.get_ref(&market_index)?;
            oracle_map.get_price_data(&spot_market.oracle)?.price
        };

        {
            let spot_market = &mut spot_market_map.get_ref_mut(&market_index)?;

            let deposit_record = DepositRecord {
                ts: clock.unix_timestamp,
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
                transfer_user: Some(to_user_key),
            };
            emit!(deposit_record);
        }

        {
            let spot_market = &mut spot_market_map.get_ref_mut(&market_index)?;
            let to_spot_position = to_user.force_get_spot_position_mut(spot_market.market_index)?;

            controller::spot_position::update_spot_position_balance(
                amount as u128,
                &SpotBalanceType::Deposit,
                spot_market,
                to_spot_position,
                false,
            )?;

            let deposit_record = DepositRecord {
                ts: clock.unix_timestamp,
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
                transfer_user: Some(from_user_key),
            };
            emit!(deposit_record);
        }

        Ok(())
    }

    #[access_control(
        funding_not_paused(&ctx.accounts.state)
    )]
    pub fn update_spot_market_cumulative_interest(
        ctx: Context<UpdateSpotMarketCumulativeInterest>,
    ) -> Result<()> {
        let spot_market = &mut load_mut!(ctx.accounts.spot_market)?;
        let now = Clock::get()?.unix_timestamp;
        controller::spot_balance::update_spot_market_cumulative_interest(spot_market, None, now)?;
        Ok(())
    }

    pub fn update_spot_market_expiry(
        ctx: Context<AdminUpdateSpotMarket>,
        expiry_ts: i64,
    ) -> Result<()> {
        handle_update_spot_market_expiry(ctx, expiry_ts)
    }

    #[access_control(
        amm_not_paused(&ctx.accounts.state)
    )]
    pub fn settle_lp<'info>(ctx: Context<SettleLP>, market_index: u16) -> Result<()> {
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
        let market_map =
            PerpMarketMap::load(&get_market_set(market_index), remaining_accounts_iter)?;

        let market = &mut market_map.get_ref_mut(&market_index)?;

        controller::funding::settle_funding_payment(user, &user_key, market, now)?;

        controller::lp::settle_lp(user, &user_key, market, now)?;

        Ok(())
    }

    #[access_control(
        amm_not_paused(&ctx.accounts.state)
    )]
    pub fn remove_liquidity<'info>(
        ctx: Context<AddRemoveLiquidity>,
        shares_to_burn: u64,
        market_index: u16,
    ) -> Result<()> {
        let user_key = ctx.accounts.user.key();
        let user = &mut load_mut!(ctx.accounts.user)?;

        let state = &ctx.accounts.state;
        let clock = Clock::get()?;
        let now = clock.unix_timestamp;

        let remaining_accounts_iter = &mut ctx.remaining_accounts.iter().peekable();

        let mut oracle_map = OracleMap::load(
            remaining_accounts_iter,
            clock.slot,
            Some(state.oracle_guard_rails),
        )?;
        let _spot_market_map = SpotMarketMap::load(&SpotMarketSet::new(), remaining_accounts_iter)?;
        let market_map =
            PerpMarketMap::load(&get_market_set(market_index), remaining_accounts_iter)?;
        {
            let mut market = market_map.get_ref_mut(&market_index)?;
            controller::funding::settle_funding_payment(user, &user_key, &mut market, now)?;
        }

        // standardize n shares to burn
        let shares_to_burn: u64 = {
            let market = market_map.get_ref(&market_index)?;
            crate::math::orders::standardize_base_asset_amount(
                shares_to_burn.cast()?,
                market.amm.base_asset_amount_step_size,
            )?
            .cast()?
        };

        if shares_to_burn == 0 {
            return Ok(());
        }

        let mut market = market_map.get_ref_mut(&market_index)?;

        let time_since_last_add_liquidity = now
            .checked_sub(user.last_lp_add_time)
            .ok_or_else(math_error!())?;

        validate!(
            time_since_last_add_liquidity >= market.amm.lp_cooldown_time,
            ErrorCode::TryingToRemoveLiquidityTooFast
        )?;

        let position_index = get_position_index(&user.perp_positions, market_index)?;
        let position = &mut user.perp_positions[position_index];

        validate!(
            position.lp_shares >= shares_to_burn,
            ErrorCode::InsufficientLPTokens
        )?;

        let oracle_price = oracle_map.get_price_data(&market.amm.oracle)?.price;
        let (position_delta, pnl) =
            burn_lp_shares(position, &mut market, shares_to_burn, oracle_price)?;

        emit!(LPRecord {
            ts: now,
            action: LPAction::RemoveLiquidity,
            user: user_key,
            n_shares: shares_to_burn,
            market_index,
            delta_base_asset_amount: position_delta.base_asset_amount,
            delta_quote_asset_amount: position_delta.quote_asset_amount,
            pnl,
        });

        Ok(())
    }

    #[access_control(
        amm_not_paused(&ctx.accounts.state)
    )]
    pub fn add_liquidity<'info>(
        ctx: Context<AddRemoveLiquidity>,
        n_shares: u64,
        market_index: u16,
    ) -> Result<()> {
        let user_key = ctx.accounts.user.key();
        let user = &mut load_mut!(ctx.accounts.user)?;
        let state = &ctx.accounts.state;
        let clock = Clock::get()?;
        let now = clock.unix_timestamp;
        let remaining_accounts_iter = &mut ctx.remaining_accounts.iter().peekable();

        let mut oracle_map = OracleMap::load(
            remaining_accounts_iter,
            clock.slot,
            Some(state.oracle_guard_rails),
        )?;
        let spot_market_map = SpotMarketMap::load(&SpotMarketSet::new(), remaining_accounts_iter)?;

        let market_map =
            PerpMarketMap::load(&get_market_set(market_index), remaining_accounts_iter)?;

        {
            let mut market = market_map.get_ref_mut(&market_index)?;
            controller::funding::settle_funding_payment(user, &user_key, &mut market, now)?;

            validate!(
                matches!(
                    market.status,
                    MarketStatus::Active
                        | MarketStatus::FundingPaused
                        | MarketStatus::FillPaused
                        | MarketStatus::WithdrawPaused
                ),
                ErrorCode::DefaultError,
                "Market Status doesn't allow for new LP liquidity"
            )?;
        }

        validate!(!user.bankrupt, ErrorCode::UserBankrupt)?;
        math::liquidation::validate_user_not_being_liquidated(
            user,
            &market_map,
            &spot_market_map,
            &mut oracle_map,
            state.liquidation_margin_buffer_ratio,
        )?;

        {
            let mut market = market_map.get_ref_mut(&market_index)?;

            validate!(
                n_shares >= market.amm.base_asset_amount_step_size,
                ErrorCode::DefaultError,
                "minting {} shares is less than step size {}",
                n_shares,
                market.amm.base_asset_amount_step_size,
            )?;

            // standardize n shares to mint
            let n_shares = crate::math::orders::standardize_base_asset_amount(
                n_shares.cast()?,
                market.amm.base_asset_amount_step_size,
            )?
            .cast::<u64>()?;

            controller::lp::mint_lp_shares(
                user.force_get_perp_position_mut(market_index)?,
                &mut market,
                n_shares,
            )?;

            user.last_lp_add_time = now;
        }

        // check margin requirements
        validate!(
            meets_initial_margin_requirement(user, &market_map, &spot_market_map, &mut oracle_map)?,
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

    #[access_control(
        exchange_not_paused(&ctx.accounts.state)
    )]
    pub fn place_order(ctx: Context<PlaceOrder>, params: OrderParams) -> Result<()> {
        let clock = &Clock::get()?;
        let state = &ctx.accounts.state;

        let remaining_accounts_iter = &mut ctx.remaining_accounts.iter().peekable();
        let mut oracle_map = OracleMap::load(
            remaining_accounts_iter,
            clock.slot,
            Some(state.oracle_guard_rails),
        )?;
        let spot_market_map = SpotMarketMap::load(&SpotMarketSet::new(), remaining_accounts_iter)?;
        let market_map = PerpMarketMap::load(&MarketSet::new(), remaining_accounts_iter)?;

        if params.immediate_or_cancel {
            msg!("immediate_or_cancel order must be in place_and_make or place_and_take");
            return Err(print_error!(ErrorCode::InvalidOrder)().into());
        }

        controller::orders::place_order(
            &ctx.accounts.state,
            &ctx.accounts.user,
            &market_map,
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
    pub fn cancel_order(ctx: Context<CancelOrder>, order_id: Option<u32>) -> Result<()> {
        let clock = &Clock::get()?;
        let state = &ctx.accounts.state;

        let remaining_accounts_iter = &mut ctx.remaining_accounts.iter().peekable();
        let mut oracle_map = OracleMap::load(
            remaining_accounts_iter,
            clock.slot,
            Some(state.oracle_guard_rails),
        )?;
        let spot_market_map = SpotMarketMap::load(&MarketSet::new(), remaining_accounts_iter)?;
        let market_map = PerpMarketMap::load(&MarketSet::new(), remaining_accounts_iter)?;

        let order_id = match order_id {
            Some(order_id) => order_id,
            None => load!(ctx.accounts.user)?.get_last_order_id(),
        };

        controller::orders::cancel_order_by_order_id(
            order_id,
            &ctx.accounts.user,
            &market_map,
            &spot_market_map,
            &mut oracle_map,
            clock,
        )?;

        Ok(())
    }

    #[access_control(
        exchange_not_paused(&ctx.accounts.state)
    )]
    pub fn cancel_order_by_user_id(ctx: Context<CancelOrder>, user_order_id: u8) -> Result<()> {
        let clock = &Clock::get()?;
        let state = &ctx.accounts.state;

        let remaining_accounts_iter = &mut ctx.remaining_accounts.iter().peekable();
        let mut oracle_map = OracleMap::load(
            remaining_accounts_iter,
            clock.slot,
            Some(state.oracle_guard_rails),
        )?;
        let spot_market_map = SpotMarketMap::load(&MarketSet::new(), remaining_accounts_iter)?;
        let market_map = PerpMarketMap::load(&MarketSet::new(), remaining_accounts_iter)?;

        controller::orders::cancel_order_by_user_order_id(
            user_order_id,
            &ctx.accounts.user,
            &market_map,
            &spot_market_map,
            &mut oracle_map,
            clock,
        )?;

        Ok(())
    }

    #[access_control(
        fill_not_paused(&ctx.accounts.state)
    )]
    pub fn fill_order<'info>(
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
        let market_map =
            PerpMarketMap::load(&get_market_set(market_index), remaining_accounts_iter)?;

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

    #[access_control(
        fill_not_paused(&ctx.accounts.state)
    )]
    pub fn place_and_take<'info>(
        ctx: Context<PlaceAndTake>,
        params: OrderParams,
        maker_order_id: Option<u32>,
    ) -> Result<()> {
        let clock = Clock::get()?;
        let state = &ctx.accounts.state;

        let remaining_accounts_iter = &mut ctx.remaining_accounts.iter().peekable();
        let mut oracle_map = OracleMap::load(
            remaining_accounts_iter,
            clock.slot,
            Some(state.oracle_guard_rails),
        )?;
        let spot_market_map = SpotMarketMap::load(&SpotMarketSet::new(), remaining_accounts_iter)?;

        let market_map = PerpMarketMap::load(
            &get_market_set(params.market_index),
            remaining_accounts_iter,
        )?;

        if params.post_only {
            msg!("post_only cant be used in place_and_take");
            return Err(print_error!(ErrorCode::InvalidOrder)().into());
        }

        let (maker, maker_stats) = match maker_order_id {
            Some(_) => {
                let (user, user_stats) = get_maker_and_maker_stats(remaining_accounts_iter)?;
                (Some(user), Some(user_stats))
            }
            None => (None, None),
        };

        let (referrer, referrer_stats) = get_referrer_and_referrer_stats(remaining_accounts_iter)?;

        let is_immediate_or_cancel = params.immediate_or_cancel;

        controller::repeg::update_amm(
            params.market_index,
            &market_map,
            &mut oracle_map,
            &ctx.accounts.state,
            &Clock::get()?,
        )?;

        controller::orders::place_order(
            &ctx.accounts.state,
            &ctx.accounts.user,
            &market_map,
            &spot_market_map,
            &mut oracle_map,
            &Clock::get()?,
            params,
        )?;

        let user = &mut ctx.accounts.user;
        let order_id = load!(user)?.get_last_order_id();

        controller::orders::fill_order(
            order_id,
            &ctx.accounts.state,
            user,
            &ctx.accounts.user_stats,
            &spot_market_map,
            &market_map,
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
                &market_map,
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
    pub fn place_and_make<'info>(
        ctx: Context<PlaceAndMake>,
        params: OrderParams,
        taker_order_id: u32,
    ) -> Result<()> {
        let clock = &Clock::get()?;
        let state = &ctx.accounts.state;

        let remaining_accounts_iter = &mut ctx.remaining_accounts.iter().peekable();
        let mut oracle_map = OracleMap::load(
            remaining_accounts_iter,
            clock.slot,
            Some(state.oracle_guard_rails),
        )?;
        let spot_market_map = SpotMarketMap::load(&SpotMarketSet::new(), remaining_accounts_iter)?;
        let market_map = PerpMarketMap::load(
            &get_market_set(params.market_index),
            remaining_accounts_iter,
        )?;

        let (referrer, referrer_stats) = get_referrer_and_referrer_stats(remaining_accounts_iter)?;

        if !params.immediate_or_cancel || !params.post_only || params.order_type != OrderType::Limit
        {
            msg!("place_and_make must use IOC post only limit order");
            return Err(print_error!(ErrorCode::InvalidOrder)().into());
        }

        controller::repeg::update_amm(
            params.market_index,
            &market_map,
            &mut oracle_map,
            state,
            clock,
        )?;

        controller::orders::place_order(
            state,
            &ctx.accounts.user,
            &market_map,
            &spot_market_map,
            &mut oracle_map,
            clock,
            params,
        )?;

        let order_id = load!(ctx.accounts.user)?.get_last_order_id();

        controller::orders::fill_order(
            taker_order_id,
            state,
            &ctx.accounts.taker,
            &ctx.accounts.taker_stats,
            &spot_market_map,
            &market_map,
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
                &market_map,
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
    pub fn trigger_order<'info>(ctx: Context<TriggerOrder>, order_id: u32) -> Result<()> {
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

    pub fn place_spot_order(ctx: Context<PlaceOrder>, params: OrderParams) -> Result<()> {
        let remaining_accounts_iter = &mut ctx.remaining_accounts.iter().peekable();
        let mut oracle_map = OracleMap::load(remaining_accounts_iter, Clock::get()?.slot, None)?;
        let spot_market_map = SpotMarketMap::load(&SpotMarketSet::new(), remaining_accounts_iter)?;
        let perp_market_map = PerpMarketMap::load(&MarketSet::new(), remaining_accounts_iter)?;

        if params.immediate_or_cancel {
            msg!("immediate_or_cancel order must be in place_and_make or place_and_take");
            return Err(print_error!(ErrorCode::InvalidOrder)().into());
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
    pub fn fill_spot_order<'info>(
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
    pub fn update_amms(ctx: Context<UpdateAMM>, market_indexes: [u16; 5]) -> Result<()> {
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
        withdraw_not_paused(&ctx.accounts.state)
    )]
    pub fn settle_pnl(ctx: Context<SettlePNL>, market_index: u16) -> Result<()> {
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
        let market_map =
            PerpMarketMap::load(&get_market_set(market_index), remaining_accounts_iter)?;

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
        withdraw_not_paused(&ctx.accounts.state)
    )]
    pub fn settle_expired_market(ctx: Context<UpdateAMM>, market_index: u16) -> Result<()> {
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
        let market_map =
            PerpMarketMap::load(&get_market_set(market_index), remaining_accounts_iter)?;

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

    #[allow(unused_must_use)]
    #[access_control(
        withdraw_not_paused(&ctx.accounts.state) &&
        amm_not_paused(&ctx.accounts.state)
    )]
    pub fn settle_expired_position(ctx: Context<SettlePNL>, market_index: u16) -> Result<()> {
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
        let market_map =
            PerpMarketMap::load(&get_market_set(market_index), remaining_accounts_iter)?;

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
        liq_not_paused(&ctx.accounts.state)
    )]
    pub fn liquidate_perp(
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
        let market_map =
            PerpMarketMap::load(&get_market_set(market_index), remaining_accounts_iter)?;

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
    pub fn liquidate_spot(
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
    pub fn liquidate_borrow_for_perp_pnl(
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
    pub fn liquidate_perp_pnl_for_deposit(
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
    pub fn resolve_perp_pnl_deficit(
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
    pub fn resolve_perp_bankruptcy(
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
        let market_map =
            PerpMarketMap::load(&get_market_set(market_index), remaining_accounts_iter)?;

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
    pub fn resolve_spot_bankruptcy(
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

    pub fn move_amm_price(
        ctx: Context<AdminUpdateMarket>,
        base_asset_reserve: u128,
        quote_asset_reserve: u128,
        sqrt_k: u128,
    ) -> Result<()> {
        handle_move_amm_price(ctx, base_asset_reserve, quote_asset_reserve, sqrt_k)
    }

    pub fn update_market_expiry(ctx: Context<AdminUpdateMarket>, expiry_ts: i64) -> Result<()> {
        handle_update_market_expiry(ctx, expiry_ts)
    }

    pub fn settle_expired_market_pools_to_revenue_pool(
        ctx: Context<SettleExpiredMarketPoolsToRevenuePool>,
    ) -> Result<()> {
        handle_settle_expired_market_pools_to_revenue_pool(ctx)
    }

    #[access_control(
        market_valid(&ctx.accounts.market)
    )]
    pub fn deposit_into_market_fee_pool(
        ctx: Context<DepositIntoMarketFeePool>,
        amount: u64,
    ) -> Result<()> {
        handle_deposit_into_market_fee_pool(ctx, amount)
    }

    pub fn repeg_amm_curve(ctx: Context<RepegCurve>, new_peg_candidate: u128) -> Result<()> {
        handle_repeg_amm_curve(ctx, new_peg_candidate)
    }

    pub fn update_amm_oracle_twap(ctx: Context<RepegCurve>) -> Result<()> {
        handle_update_amm_oracle_twap(ctx)
    }

    pub fn reset_amm_oracle_twap(ctx: Context<RepegCurve>) -> Result<()> {
        handle_reset_amm_oracle_twap(ctx)
    }

    pub fn initialize_user(
        ctx: Context<InitializeUser>,
        user_id: u8,
        name: [u8; 32],
    ) -> Result<()> {
        let user_key = ctx.accounts.user.key();
        let mut user = ctx
            .accounts
            .user
            .load_init()
            .or(Err(ErrorCode::UnableToLoadAccountLoader))?;
        *user = User {
            authority: ctx.accounts.authority.key(),
            user_id,
            name,
            next_order_id: 1,
            next_liquidation_id: 1,
            ..User::default()
        };

        let remaining_accounts_iter = &mut ctx.remaining_accounts.iter().peekable();

        let mut user_stats = load_mut!(ctx.accounts.user_stats)?;
        user_stats.number_of_users = user_stats
            .number_of_users
            .checked_add(1)
            .ok_or_else(math_error!())?;

        // Only try to add referrer if it is the first user
        if user_stats.number_of_users == 1 {
            let (referrer, referrer_stats) =
                get_referrer_and_referrer_stats(remaining_accounts_iter)?;
            let referrer =
                if let (Some(referrer), Some(referrer_stats)) = (referrer, referrer_stats) {
                    let referrer = load!(referrer)?;
                    let mut referrer_stats = load_mut!(referrer_stats)?;

                    validate!(referrer.user_id == 0, ErrorCode::InvalidReferrer)?;

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

        emit!(NewUserRecord {
            ts: Clock::get()?.unix_timestamp,
            user_authority: ctx.accounts.authority.key(),
            user: user_key,
            user_id,
            name,
            referrer: user_stats.referrer
        });

        Ok(())
    }

    pub fn initialize_user_stats(ctx: Context<InitializeUserStats>) -> Result<()> {
        let clock = Clock::get()?;

        let mut user_stats = ctx
            .accounts
            .user_stats
            .load_init()
            .or(Err(ErrorCode::UnableToLoadAccountLoader))?;

        *user_stats = UserStats {
            authority: ctx.accounts.authority.key(),
            number_of_users: 0,
            last_taker_volume_30d_ts: clock.unix_timestamp,
            last_maker_volume_30d_ts: clock.unix_timestamp,
            last_filler_volume_30d_ts: clock.unix_timestamp,
            ..UserStats::default()
        };

        let state = &mut ctx.accounts.state;
        checked_increment!(state.number_of_authorities, 1);

        Ok(())
    }

    pub fn update_user_name(ctx: Context<UpdateUser>, _user_id: u8, name: [u8; 32]) -> Result<()> {
        let mut user = load_mut!(ctx.accounts.user)?;
        user.name = name;
        Ok(())
    }

    pub fn update_user_custom_margin_ratio(
        ctx: Context<UpdateUser>,
        _user_id: u8,
        margin_ratio: u32,
    ) -> Result<()> {
        let mut user = load_mut!(ctx.accounts.user)?;
        user.custom_margin_ratio = margin_ratio;
        Ok(())
    }

    pub fn update_user_delegate(
        ctx: Context<UpdateUser>,
        _user_id: u8,
        delegate: Pubkey,
    ) -> Result<()> {
        let mut user = load_mut!(ctx.accounts.user)?;
        user.delegate = delegate;
        Ok(())
    }

    pub fn delete_user(ctx: Context<DeleteUser>) -> Result<()> {
        let user = &load!(ctx.accounts.user)?;
        let user_stats = &mut load_mut!(ctx.accounts.user_stats)?;

        validate_user_deletion(user, user_stats)?;

        checked_decrement!(user_stats.number_of_users, 1);

        Ok(())
    }

    #[access_control(
        funding_not_paused(&ctx.accounts.state)
    )]
    pub fn settle_funding_payment(ctx: Context<SettleFunding>) -> Result<()> {
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

    #[allow(unused_must_use)]
    #[access_control(
        market_valid(&ctx.accounts.market) &&
        funding_not_paused(&ctx.accounts.state) &&
        valid_oracle_for_market(&ctx.accounts.oracle, &ctx.accounts.market)
    )]
    pub fn update_funding_rate(ctx: Context<UpdateFundingRate>, market_index: u16) -> Result<()> {
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

    pub fn update_k(ctx: Context<AdminUpdateK>, sqrt_k: u128) -> Result<()> {
        handle_update_k(ctx, sqrt_k)
    }

    pub fn update_margin_ratio(
        ctx: Context<AdminUpdateMarket>,
        margin_ratio_initial: u32,
        margin_ratio_maintenance: u32,
    ) -> Result<()> {
        handle_update_margin_ratio(ctx, margin_ratio_initial, margin_ratio_maintenance)
    }

    pub fn update_market_max_imbalances(
        ctx: Context<AdminUpdateMarket>,
        unrealized_max_imbalance: u128,
        max_revenue_withdraw_per_period: u128,
        quote_max_insurance: u128,
    ) -> Result<()> {
        handle_update_market_max_imbalances(
            ctx,
            unrealized_max_imbalance,
            max_revenue_withdraw_per_period,
            quote_max_insurance,
        )
    }

    pub fn update_perp_liquidation_fee(
        ctx: Context<AdminUpdateMarket>,
        liquidator_fee: u128,
        if_liquidation_fee: u128,
    ) -> Result<()> {
        handle_update_perp_liquidation_fee(ctx, liquidator_fee, if_liquidation_fee)
    }

    pub fn update_insurance_withdraw_escrow_period(
        ctx: Context<AdminUpdateSpotMarket>,
        insurance_withdraw_escrow_period: i64,
    ) -> Result<()> {
        handle_update_insurance_withdraw_escrow_period(ctx, insurance_withdraw_escrow_period)
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

    pub fn update_perp_market_status(
        ctx: Context<AdminUpdateMarket>,
        status: MarketStatus,
    ) -> Result<()> {
        handle_update_perp_market_status(ctx, status)
    }

    pub fn update_perp_market_contract_tier(
        ctx: Context<AdminUpdateMarket>,
        contract_tier: ContractTier,
    ) -> Result<()> {
        handle_update_perp_market_contract_tier(ctx, contract_tier)
    }

    pub fn update_market_imf_factor(
        ctx: Context<AdminUpdateMarket>,
        imf_factor: u128,
    ) -> Result<()> {
        handle_update_market_imf_factor(ctx, imf_factor)
    }

    pub fn update_market_unrealized_asset_weight(
        ctx: Context<AdminUpdateMarket>,
        unrealized_initial_asset_weight: u32,
        unrealized_maintenance_asset_weight: u32,
    ) -> Result<()> {
        handle_update_market_unrealized_asset_weight(
            ctx,
            unrealized_initial_asset_weight,
            unrealized_maintenance_asset_weight,
        )
    }

    pub fn update_concentration_coef(
        ctx: Context<AdminUpdateMarket>,
        concentration_scale: u128,
    ) -> Result<()> {
        handle_update_concentration_coef(ctx, concentration_scale)
    }

    pub fn update_curve_update_intensity(
        ctx: Context<AdminUpdateMarket>,
        curve_update_intensity: u8,
    ) -> Result<()> {
        handle_update_curve_update_intensity(ctx, curve_update_intensity)
    }

    pub fn update_lp_cooldown_time(
        ctx: Context<AdminUpdateMarket>,
        lp_cooldown_time: i64,
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

    pub fn update_market_oracle(
        ctx: Context<AdminUpdateMarket>,
        oracle: Pubkey,
        oracle_source: OracleSource,
    ) -> Result<()> {
        handle_update_market_oracle(ctx, oracle, oracle_source)
    }

    pub fn update_market_minimum_quote_asset_trade_size(
        ctx: Context<AdminUpdateMarket>,
        minimum_trade_size: u128,
    ) -> Result<()> {
        handle_update_market_minimum_quote_asset_trade_size(ctx, minimum_trade_size)
    }

    pub fn update_market_base_spread(
        ctx: Context<AdminUpdateMarket>,
        base_spread: u16,
    ) -> Result<()> {
        handle_update_market_base_spread(ctx, base_spread)
    }

    pub fn update_amm_jit_intensity(
        ctx: Context<AdminUpdateMarket>,
        amm_jit_intensity: u8,
    ) -> Result<()> {
        handle_update_amm_jit_intensity(ctx, amm_jit_intensity)
    }

    pub fn update_market_max_spread(
        ctx: Context<AdminUpdateMarket>,
        max_spread: u32,
    ) -> Result<()> {
        handle_update_market_max_spread(ctx, max_spread)
    }

    pub fn update_market_base_asset_amount_step_size(
        ctx: Context<AdminUpdateMarket>,
        minimum_trade_size: u64,
    ) -> Result<()> {
        handle_update_market_base_asset_amount_step_size(ctx, minimum_trade_size)
    }

    pub fn update_market_max_slippage_ratio(
        ctx: Context<AdminUpdateMarket>,
        max_slippage_ratio: u16,
    ) -> Result<()> {
        handle_update_market_max_slippage_ratio(ctx, max_slippage_ratio)
    }

    pub fn update_max_base_asset_amount_ratio(
        ctx: Context<AdminUpdateMarket>,
        max_base_asset_amount_ratio: u16,
    ) -> Result<()> {
        handle_update_max_base_asset_amount_ratio(ctx, max_base_asset_amount_ratio)
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

    pub fn initialize_insurance_fund_stake(
        ctx: Context<InitializeInsuranceFundStake>,
        market_index: u16,
    ) -> Result<()> {
        let mut if_stake = ctx
            .accounts
            .insurance_fund_stake
            .load_init()
            .or(Err(ErrorCode::UnableToLoadAccountLoader))?;

        let clock = Clock::get()?;
        let now = clock.unix_timestamp;

        *if_stake = InsuranceFundStake::new(*ctx.accounts.authority.key, market_index, now);

        Ok(())
    }

    #[access_control(
        withdraw_not_paused(&ctx.accounts.state)
    )]
    pub fn settle_revenue_to_insurance_fund(
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

    pub fn add_insurance_fund_stake(
        ctx: Context<AddInsuranceFundStake>,
        market_index: u16,
        amount: u64,
    ) -> Result<()> {
        if amount == 0 {
            return Err(ErrorCode::InsufficientDeposit.into());
        }

        let clock = Clock::get()?;
        let now = clock.unix_timestamp;
        let insurance_fund_stake = &mut load_mut!(ctx.accounts.insurance_fund_stake)?;
        let user_stats = &mut load_mut!(ctx.accounts.user_stats)?;
        let spot_market = &mut load_mut!(ctx.accounts.spot_market)?;
        let state = &ctx.accounts.state;

        validate!(
            insurance_fund_stake.market_index == market_index,
            ErrorCode::DefaultError,
            "insurance_fund_stake does not match market_index"
        )?;

        validate!(
            insurance_fund_stake.last_withdraw_request_shares == 0
                && insurance_fund_stake.last_withdraw_request_value == 0,
            ErrorCode::DefaultError,
            "withdraw request in progress"
        )?;

        {
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

        controller::insurance::add_insurance_fund_stake(
            amount,
            ctx.accounts.insurance_fund_vault.amount,
            insurance_fund_stake,
            user_stats,
            spot_market,
            clock.unix_timestamp,
        )?;

        controller::token::receive(
            &ctx.accounts.token_program,
            &ctx.accounts.user_token_account,
            &ctx.accounts.insurance_fund_vault,
            &ctx.accounts.authority,
            amount,
        )?;

        Ok(())
    }

    pub fn request_remove_insurance_fund_stake(
        ctx: Context<RequestRemoveInsuranceFundStake>,
        market_index: u16,
        amount: u64,
    ) -> Result<()> {
        let clock = Clock::get()?;
        let insurance_fund_stake = &mut load_mut!(ctx.accounts.insurance_fund_stake)?;
        let user_stats = &mut load_mut!(ctx.accounts.user_stats)?;
        let spot_market = &mut load_mut!(ctx.accounts.spot_market)?;

        validate!(
            insurance_fund_stake.market_index == market_index,
            ErrorCode::DefaultError,
            "insurance_fund_stake does not match market_index"
        )?;

        validate!(
            insurance_fund_stake.last_withdraw_request_shares == 0,
            ErrorCode::DefaultError,
            "Withdraw request is already in progress"
        )?;

        let n_shares = math::insurance::vault_amount_to_if_shares(
            amount,
            spot_market.total_if_shares,
            ctx.accounts.insurance_fund_vault.amount,
        )?;

        validate!(
            n_shares > 0,
            ErrorCode::DefaultError,
            "Requested lp_shares = 0"
        )?;

        let user_if_shares = insurance_fund_stake.checked_if_shares(spot_market)?;
        validate!(user_if_shares >= n_shares, ErrorCode::InsufficientIFShares)?;

        controller::insurance::request_remove_insurance_fund_stake(
            n_shares,
            ctx.accounts.insurance_fund_vault.amount,
            insurance_fund_stake,
            user_stats,
            spot_market,
            clock.unix_timestamp,
        )?;

        Ok(())
    }

    pub fn cancel_request_remove_insurance_fund_stake(
        ctx: Context<RequestRemoveInsuranceFundStake>,
        market_index: u16,
    ) -> Result<()> {
        let clock = Clock::get()?;
        let now = clock.unix_timestamp;
        let insurance_fund_stake = &mut load_mut!(ctx.accounts.insurance_fund_stake)?;
        let user_stats = &mut load_mut!(ctx.accounts.user_stats)?;
        let spot_market = &mut load_mut!(ctx.accounts.spot_market)?;

        validate!(
            insurance_fund_stake.market_index == market_index,
            ErrorCode::DefaultError,
            "insurance_fund_stake does not match market_index"
        )?;

        validate!(
            insurance_fund_stake.last_withdraw_request_shares != 0,
            ErrorCode::DefaultError,
            "No withdraw request in progress"
        )?;

        controller::insurance::cancel_request_remove_insurance_fund_stake(
            ctx.accounts.insurance_fund_vault.amount,
            insurance_fund_stake,
            user_stats,
            spot_market,
            now,
        )?;

        Ok(())
    }

    #[access_control(
        withdraw_not_paused(&ctx.accounts.state)
    )]
    pub fn remove_insurance_fund_stake(
        ctx: Context<RemoveInsuranceFundStake>,
        market_index: u16,
    ) -> Result<()> {
        let clock = Clock::get()?;
        let now = clock.unix_timestamp;
        let insurance_fund_stake = &mut load_mut!(ctx.accounts.insurance_fund_stake)?;
        let user_stats = &mut load_mut!(ctx.accounts.user_stats)?;
        let spot_market = &mut load_mut!(ctx.accounts.spot_market)?;
        let state = &ctx.accounts.state;

        validate!(
            insurance_fund_stake.market_index == market_index,
            ErrorCode::DefaultError,
            "insurance_fund_stake does not match market_index"
        )?;

        let amount = controller::insurance::remove_insurance_fund_stake(
            ctx.accounts.insurance_fund_vault.amount,
            insurance_fund_stake,
            user_stats,
            spot_market,
            now,
        )?;

        controller::token::send_from_program_vault(
            &ctx.accounts.token_program,
            &ctx.accounts.insurance_fund_vault,
            &ctx.accounts.user_token_account,
            &ctx.accounts.clearing_house_signer,
            state.signer_nonce,
            amount,
        )?;

        validate!(
            ctx.accounts.insurance_fund_vault.amount > 0,
            ErrorCode::DefaultError,
            "insurance_fund_vault.amount must remain > 0"
        )?;

        Ok(())
    }

    pub fn admin_remove_insurance_fund_stake(
        ctx: Context<AdminRemoveInsuranceFundStake>,
        market_index: u16,
        amount: u64,
    ) -> Result<()> {
        handle_admin_remove_insurance_fund_stake(ctx, market_index, amount)
    }

    pub fn update_user_quote_asset_insurance_stake(
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
}

fn market_valid(market: &AccountLoader<PerpMarket>) -> Result<()> {
    if market.load()?.status == MarketStatus::Delisted {
        return Err(ErrorCode::MarketIndexNotInitialized.into());
    }
    Ok(())
}

fn valid_oracle_for_market(oracle: &AccountInfo, market: &AccountLoader<PerpMarket>) -> Result<()> {
    if !market.load()?.amm.oracle.eq(oracle.key) {
        return Err(ErrorCode::InvalidOracle.into());
    }
    Ok(())
}

fn liq_not_paused(state: &Account<State>) -> Result<()> {
    if matches!(
        state.exchange_status,
        ExchangeStatus::LiqPaused | ExchangeStatus::Paused
    ) {
        return Err(ErrorCode::ExchangePaused.into());
    }
    Ok(())
}

fn funding_not_paused(state: &Account<State>) -> Result<()> {
    if matches!(
        state.exchange_status,
        ExchangeStatus::FundingPaused | ExchangeStatus::Paused
    ) {
        return Err(ErrorCode::ExchangePaused.into());
    }
    Ok(())
}

fn amm_not_paused(state: &Account<State>) -> Result<()> {
    if matches!(
        state.exchange_status,
        ExchangeStatus::AmmPaused | ExchangeStatus::Paused
    ) {
        return Err(ErrorCode::ExchangePaused.into());
    }
    Ok(())
}

fn fill_not_paused(state: &Account<State>) -> Result<()> {
    if matches!(
        state.exchange_status,
        ExchangeStatus::FillPaused | ExchangeStatus::Paused
    ) {
        return Err(ErrorCode::ExchangePaused.into());
    }
    Ok(())
}

fn withdraw_not_paused(state: &Account<State>) -> Result<()> {
    if matches!(
        state.exchange_status,
        ExchangeStatus::WithdrawPaused | ExchangeStatus::Paused
    ) {
        return Err(ErrorCode::ExchangePaused.into());
    }
    Ok(())
}

fn exchange_not_paused(state: &Account<State>) -> Result<()> {
    if state.exchange_status == ExchangeStatus::Paused {
        return Err(ErrorCode::ExchangePaused.into());
    }
    Ok(())
}
