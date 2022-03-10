#![allow(clippy::too_many_arguments)]
use anchor_lang::prelude::*;
use borsh::{BorshDeserialize, BorshSerialize};

use context::*;
use controller::position::{add_new_position, get_position_index, PositionDirection};
use error::*;
use math::{amm, bn, constants::*, fees, margin::*, orders::*, withdrawal::*};

use crate::state::{
    history::trade::TradeRecord,
    market::{Market, Markets, OracleSource, AMM},
    order_state::*,
    state::*,
    user::{MarketPosition, User, UserPositions},
    user_orders::*,
};

pub mod context;
pub mod controller;
pub mod error;
mod margin_validation;
pub mod math;
pub mod optional_accounts;
pub mod order_validation;
pub mod state;
mod user_initialization;

#[cfg(feature = "mainnet-beta")]
declare_id!("dammHkt7jmytvbS3nHTxQNEcP59aE57nxwV21YdqEDN");
#[cfg(not(feature = "mainnet-beta"))]
declare_id!("AsW7LnXB9UA1uec9wi9MctYTgTz7YH9snhxd16GsFaGX");

#[program]
pub mod clearing_house {
    use crate::math;
    use crate::optional_accounts::{get_discount_token, get_referrer, get_referrer_for_fill_order};
    use crate::state::history::curve::ExtendedCurveRecord;
    use crate::state::history::deposit::{DepositDirection, DepositRecord};
    use crate::state::history::liquidation::LiquidationRecord;

    use super::*;
    use crate::margin_validation::validate_margin;
    use crate::math::amm::{
        calculate_mark_twap_spread_pct, is_oracle_mark_too_divergent, normalise_oracle_price,
    };
    use crate::math::casting::{cast, cast_to_i128, cast_to_u128};
    use crate::math::slippage::{calculate_slippage, calculate_slippage_pct};
    use crate::state::market::OraclePriceData;
    use crate::state::order_state::{OrderFillerRewardStructure, OrderState};
    use std::ops::Div;

    pub fn initialize(
        ctx: Context<Initialize>,
        _clearing_house_nonce: u8,
        _collateral_vault_nonce: u8,
        _insurance_vault_nonce: u8,
        admin_controls_prices: bool,
    ) -> ProgramResult {
        let collateral_account_key = ctx.accounts.collateral_vault.to_account_info().key;
        let (collateral_account_authority, collateral_account_nonce) =
            Pubkey::find_program_address(&[collateral_account_key.as_ref()], ctx.program_id);

        // clearing house must be authority of collateral vault
        if ctx.accounts.collateral_vault.owner != collateral_account_authority {
            return Err(ErrorCode::InvalidCollateralAccountAuthority.into());
        }

        let insurance_account_key = ctx.accounts.insurance_vault.to_account_info().key;
        let (insurance_account_authority, insurance_account_nonce) =
            Pubkey::find_program_address(&[insurance_account_key.as_ref()], ctx.program_id);

        // clearing house must be authority of insurance vault
        if ctx.accounts.insurance_vault.owner != insurance_account_authority {
            return Err(ErrorCode::InvalidInsuranceAccountAuthority.into());
        }

        ctx.accounts.markets.load_init()?;

        **ctx.accounts.state = State {
            admin: *ctx.accounts.admin.key,
            funding_paused: false,
            exchange_paused: false,
            admin_controls_prices,
            collateral_mint: *ctx.accounts.collateral_mint.to_account_info().key,
            collateral_vault: *collateral_account_key,
            collateral_vault_authority: collateral_account_authority,
            collateral_vault_nonce: collateral_account_nonce,
            deposit_history: Pubkey::default(),
            trade_history: Pubkey::default(),
            funding_rate_history: Pubkey::default(),
            funding_payment_history: Pubkey::default(),
            liquidation_history: Pubkey::default(),
            curve_history: Pubkey::default(),
            insurance_vault: *insurance_account_key,
            insurance_vault_authority: insurance_account_authority,
            insurance_vault_nonce: insurance_account_nonce,
            markets: *ctx.accounts.markets.to_account_info().key,
            margin_ratio_initial: 2000, // unit is 20% (+2 decimal places)
            margin_ratio_partial: 625,
            margin_ratio_maintenance: 500,
            partial_liquidation_close_percentage_numerator: 25,
            partial_liquidation_close_percentage_denominator: 100,
            partial_liquidation_penalty_percentage_numerator: 25,
            partial_liquidation_penalty_percentage_denominator: 1000,
            full_liquidation_penalty_percentage_numerator: 1,
            full_liquidation_penalty_percentage_denominator: 1,
            partial_liquidation_liquidator_share_denominator: 2,
            full_liquidation_liquidator_share_denominator: 20,
            fee_structure: FeeStructure {
                fee_numerator: DEFAULT_FEE_NUMERATOR,
                fee_denominator: DEFAULT_FEE_DENOMINATOR,
                discount_token_tiers: DiscountTokenTiers {
                    first_tier: DiscountTokenTier {
                        minimum_balance: DEFAULT_DISCOUNT_TOKEN_FIRST_TIER_MINIMUM_BALANCE,
                        discount_numerator: DEFAULT_DISCOUNT_TOKEN_FIRST_TIER_DISCOUNT_NUMERATOR,
                        discount_denominator:
                            DEFAULT_DISCOUNT_TOKEN_FIRST_TIER_DISCOUNT_DENOMINATOR,
                    },
                    second_tier: DiscountTokenTier {
                        minimum_balance: DEFAULT_DISCOUNT_TOKEN_SECOND_TIER_MINIMUM_BALANCE,
                        discount_numerator: DEFAULT_DISCOUNT_TOKEN_SECOND_TIER_DISCOUNT_NUMERATOR,
                        discount_denominator:
                            DEFAULT_DISCOUNT_TOKEN_SECOND_TIER_DISCOUNT_DENOMINATOR,
                    },
                    third_tier: DiscountTokenTier {
                        minimum_balance: DEFAULT_DISCOUNT_TOKEN_THIRD_TIER_MINIMUM_BALANCE,
                        discount_numerator: DEFAULT_DISCOUNT_TOKEN_THIRD_TIER_DISCOUNT_NUMERATOR,
                        discount_denominator:
                            DEFAULT_DISCOUNT_TOKEN_THIRD_TIER_DISCOUNT_DENOMINATOR,
                    },
                    fourth_tier: DiscountTokenTier {
                        minimum_balance: DEFAULT_DISCOUNT_TOKEN_FOURTH_TIER_MINIMUM_BALANCE,
                        discount_numerator: DEFAULT_DISCOUNT_TOKEN_FOURTH_TIER_DISCOUNT_NUMERATOR,
                        discount_denominator:
                            DEFAULT_DISCOUNT_TOKEN_FOURTH_TIER_DISCOUNT_DENOMINATOR,
                    },
                },
                referral_discount: ReferralDiscount {
                    referrer_reward_numerator: DEFAULT_REFERRER_REWARD_NUMERATOR,
                    referrer_reward_denominator: DEFAULT_REFERRER_REWARD_DENOMINATOR,
                    referee_discount_numerator: DEFAULT_REFEREE_DISCOUNT_NUMERATOR,
                    referee_discount_denominator: DEFAULT_REFEREE_DISCOUNT_DENOMINATOR,
                },
            },
            whitelist_mint: Pubkey::default(),
            discount_mint: Pubkey::default(),
            max_deposit: 0,
            oracle_guard_rails: OracleGuardRails {
                price_divergence: PriceDivergenceGuardRails {
                    mark_oracle_divergence_numerator: 1,
                    mark_oracle_divergence_denominator: 10,
                },
                validity: ValidityGuardRails {
                    slots_before_stale: 1000,
                    confidence_interval_max_size: 4,
                    too_volatile_ratio: 5,
                },
                use_for_liquidations: true,
            },
            order_state: Pubkey::default(),
            extended_curve_history: Pubkey::default(),
            padding0: 0,
            padding1: 0,
            padding2: 0,
            padding3: 0,
        };

        Ok(())
    }

    pub fn initialize_history(ctx: Context<InitializeHistory>) -> ProgramResult {
        let state = &mut ctx.accounts.state;

        // If all of the history account keys are set to the default, assume they haven't been initialized tet
        if !state.deposit_history.eq(&Pubkey::default())
            && !state.trade_history.eq(&Pubkey::default())
            && !state.liquidation_history.eq(&Pubkey::default())
            && !state.funding_payment_history.eq(&Pubkey::default())
            && !state.funding_rate_history.eq(&Pubkey::default())
            && !state.curve_history.eq(&Pubkey::default())
        {
            return Err(ErrorCode::HistoryAlreadyInitialized.into());
        }

        ctx.accounts.deposit_history.load_init()?;
        ctx.accounts.trade_history.load_init()?;
        ctx.accounts.funding_payment_history.load_init()?;
        ctx.accounts.funding_rate_history.load_init()?;
        ctx.accounts.liquidation_history.load_init()?;
        ctx.accounts.curve_history.load_init()?;

        let deposit_history = ctx.accounts.deposit_history.to_account_info().key;
        let trade_history = ctx.accounts.trade_history.to_account_info().key;
        let funding_payment_history = ctx.accounts.funding_payment_history.to_account_info().key;
        let funding_rate_history = ctx.accounts.funding_rate_history.to_account_info().key;
        let liquidation_history = ctx.accounts.liquidation_history.to_account_info().key;
        let extended_curve_history = ctx.accounts.curve_history.to_account_info().key;

        state.deposit_history = *deposit_history;
        state.trade_history = *trade_history;
        state.funding_rate_history = *funding_rate_history;
        state.funding_payment_history = *funding_payment_history;
        state.liquidation_history = *liquidation_history;
        state.extended_curve_history = *extended_curve_history;

        Ok(())
    }

    pub fn initialize_order_state(
        ctx: Context<InitializeOrderState>,
        _order_house_nonce: u8,
    ) -> ProgramResult {
        let state = &mut ctx.accounts.state;

        if !state.order_state.eq(&Pubkey::default()) {
            return Err(ErrorCode::OrderStateAlreadyInitialized.into());
        }

        state.order_state = ctx.accounts.order_state.key();
        ctx.accounts.order_history.load_init()?;

        **ctx.accounts.order_state = OrderState {
            order_history: ctx.accounts.order_history.key(),
            order_filler_reward_structure: OrderFillerRewardStructure {
                reward_numerator: 1,
                reward_denominator: 10,
                time_based_reward_lower_bound: 10_000, // 1 cent
            },
            min_order_quote_asset_amount: 500_000, // 50 cents
            padding: [0; 10],
        };

        Ok(())
    }

    pub fn initialize_market(
        ctx: Context<InitializeMarket>,
        market_index: u64,
        amm_base_asset_reserve: u128,
        amm_quote_asset_reserve: u128,
        amm_periodicity: i64,
        amm_peg_multiplier: u128,
        margin_ratio_initial: u32,
        margin_ratio_partial: u32,
        margin_ratio_maintenance: u32,
    ) -> ProgramResult {
        let markets = &mut ctx.accounts.markets.load_mut()?;
        let market = &markets.markets[Markets::index_from_u64(market_index)];
        let clock = Clock::get()?;
        let now = clock.unix_timestamp;
        let clock_slot = clock.slot;

        if market.initialized {
            return Err(ErrorCode::MarketIndexAlreadyInitialized.into());
        }

        if amm_base_asset_reserve != amm_quote_asset_reserve {
            return Err(ErrorCode::InvalidInitialPeg.into());
        }

        let init_mark_price = amm::calculate_price(
            amm_quote_asset_reserve,
            amm_base_asset_reserve,
            amm_peg_multiplier,
        )?;

        // Verify there's no overflow
        let _k = bn::U192::from(amm_base_asset_reserve)
            .checked_mul(bn::U192::from(amm_quote_asset_reserve))
            .ok_or_else(math_error!())?;

        // Verify oracle is readable
        let OraclePriceData {
            price: oracle_price,
            twap: oracle_price_twap,
            ..
        } = market
            .amm
            .get_oracle_price(&ctx.accounts.oracle, clock_slot)
            .unwrap();

        validate_margin(
            margin_ratio_initial,
            margin_ratio_initial,
            margin_ratio_maintenance,
        )?;

        let market = Market {
            initialized: true,
            base_asset_amount_long: 0,
            base_asset_amount_short: 0,
            base_asset_amount: 0,
            open_interest: 0,
            margin_ratio_initial, // unit is 20% (+2 decimal places)
            margin_ratio_partial,
            margin_ratio_maintenance,
            padding0: 0,
            padding1: 0,
            padding2: 0,
            padding3: 0,
            padding4: 0,
            amm: AMM {
                oracle: *ctx.accounts.oracle.key,
                oracle_source: OracleSource::Pyth,
                base_asset_reserve: amm_base_asset_reserve,
                quote_asset_reserve: amm_quote_asset_reserve,
                cumulative_repeg_rebate_long: 0,
                cumulative_repeg_rebate_short: 0,
                cumulative_funding_rate_long: 0,
                cumulative_funding_rate_short: 0,
                last_funding_rate: 0,
                last_funding_rate_ts: now,
                funding_period: amm_periodicity,
                last_oracle_price_twap: oracle_price_twap,
                last_mark_price_twap: init_mark_price,
                last_mark_price_twap_ts: now,
                sqrt_k: amm_base_asset_reserve,
                peg_multiplier: amm_peg_multiplier,
                total_fee: 0,
                total_fee_withdrawn: 0,
                total_fee_minus_distributions: 0,
                minimum_quote_asset_trade_size: 10000000,
                last_oracle_price_twap_ts: now,
                last_oracle_price: oracle_price,
                minimum_base_asset_trade_size: 10000000,
                padding1: 0,
                padding2: 0,
                padding3: 0,
            },
        };

        markets.markets[Markets::index_from_u64(market_index)] = market;

        Ok(())
    }

    pub fn deposit_collateral(ctx: Context<DepositCollateral>, amount: u64) -> ProgramResult {
        let user = &mut ctx.accounts.user;
        let clock = Clock::get()?;
        let now = clock.unix_timestamp;

        if amount == 0 {
            return Err(ErrorCode::InsufficientDeposit.into());
        }

        let collateral_before = user.collateral;
        let cumulative_deposits_before = user.cumulative_deposits;

        user.collateral = user
            .collateral
            .checked_add(cast(amount)?)
            .ok_or_else(math_error!())?;
        user.cumulative_deposits = user
            .cumulative_deposits
            .checked_add(cast(amount)?)
            .ok_or_else(math_error!())?;

        let markets = &ctx.accounts.markets.load()?;
        let user_positions = &mut ctx.accounts.user_positions.load_mut()?;
        let funding_payment_history = &mut ctx.accounts.funding_payment_history.load_mut()?;
        controller::funding::settle_funding_payment(
            user,
            user_positions,
            markets,
            funding_payment_history,
            now,
        )?;

        controller::token::receive(
            &ctx.accounts.token_program,
            &ctx.accounts.user_collateral_account,
            &ctx.accounts.collateral_vault,
            &ctx.accounts.authority,
            amount,
        )?;

        let deposit_history = &mut ctx.accounts.deposit_history.load_mut()?;
        let record_id = deposit_history.next_record_id();
        deposit_history.append(DepositRecord {
            ts: now,
            record_id,
            user_authority: user.authority,
            user: user.to_account_info().key(),
            direction: DepositDirection::DEPOSIT,
            collateral_before,
            cumulative_deposits_before,
            amount,
        });

        if ctx.accounts.state.max_deposit > 0
            && user.cumulative_deposits > cast(ctx.accounts.state.max_deposit)?
        {
            return Err(ErrorCode::UserMaxDeposit.into());
        }

        Ok(())
    }

    #[access_control(
        exchange_not_paused(&ctx.accounts.state)
    )]
    pub fn withdraw_collateral(ctx: Context<WithdrawCollateral>, amount: u64) -> ProgramResult {
        let user = &mut ctx.accounts.user;
        let clock = Clock::get()?;
        let now = clock.unix_timestamp;

        let collateral_before = user.collateral;
        let cumulative_deposits_before = user.cumulative_deposits;

        let markets = &ctx.accounts.markets.load()?;
        let user_positions = &mut ctx.accounts.user_positions.load_mut()?;
        let funding_payment_history = &mut ctx.accounts.funding_payment_history.load_mut()?;
        controller::funding::settle_funding_payment(
            user,
            user_positions,
            markets,
            funding_payment_history,
            now,
        )?;

        if cast_to_u128(amount)? > user.collateral {
            return Err(ErrorCode::InsufficientCollateral.into());
        }

        let (collateral_account_withdrawal, insurance_account_withdrawal) =
            calculate_withdrawal_amounts(
                amount,
                &ctx.accounts.collateral_vault,
                &ctx.accounts.insurance_vault,
            )?;

        // amount_withdrawn can be less than amount if there is an insufficient balance in collateral and insurance vault
        let amount_withdraw = collateral_account_withdrawal
            .checked_add(insurance_account_withdrawal)
            .ok_or_else(math_error!())?;

        user.cumulative_deposits = user
            .cumulative_deposits
            .checked_sub(cast(amount_withdraw)?)
            .ok_or_else(math_error!())?;

        user.collateral = user
            .collateral
            .checked_sub(cast(collateral_account_withdrawal)?)
            .ok_or_else(math_error!())?
            .checked_sub(cast(insurance_account_withdrawal)?)
            .ok_or_else(math_error!())?;

        if !meets_initial_margin_requirement(user, user_positions, markets)? {
            return Err(ErrorCode::InsufficientCollateral.into());
        }

        controller::token::send(
            &ctx.accounts.token_program,
            &ctx.accounts.collateral_vault,
            &ctx.accounts.user_collateral_account,
            &ctx.accounts.collateral_vault_authority,
            ctx.accounts.state.collateral_vault_nonce,
            collateral_account_withdrawal,
        )?;

        if insurance_account_withdrawal > 0 {
            controller::token::send(
                &ctx.accounts.token_program,
                &ctx.accounts.insurance_vault,
                &ctx.accounts.user_collateral_account,
                &ctx.accounts.insurance_vault_authority,
                ctx.accounts.state.insurance_vault_nonce,
                insurance_account_withdrawal,
            )?;
        }

        let deposit_history = &mut ctx.accounts.deposit_history.load_mut()?;
        let record_id = deposit_history.next_record_id();
        deposit_history.append(DepositRecord {
            ts: now,
            record_id,
            user_authority: user.authority,
            user: user.to_account_info().key(),
            direction: DepositDirection::WITHDRAW,
            collateral_before,
            cumulative_deposits_before,
            amount: amount_withdraw,
        });

        Ok(())
    }

    #[allow(unused_must_use)]
    #[access_control(
        market_initialized(&ctx.accounts.markets, market_index) &&
        exchange_not_paused(&ctx.accounts.state) &&
        valid_oracle_for_market(&ctx.accounts.oracle, &ctx.accounts.markets, market_index)
    )]
    pub fn open_position<'info>(
        ctx: Context<OpenPosition>,
        direction: PositionDirection,
        quote_asset_amount: u128,
        market_index: u64,
        limit_price: u128,
        optional_accounts: ManagePositionOptionalAccounts,
    ) -> ProgramResult {
        let user = &mut ctx.accounts.user;
        let clock = Clock::get()?;
        let now = clock.unix_timestamp;
        let clock_slot = clock.slot;

        if quote_asset_amount == 0 {
            return Err(ErrorCode::TradeSizeTooSmall.into());
        }

        // Settle user's funding payments so that collateral is up to date
        let user_positions = &mut ctx.accounts.user_positions.load_mut()?;
        let funding_payment_history = &mut ctx.accounts.funding_payment_history.load_mut()?;
        controller::funding::settle_funding_payment(
            user,
            user_positions,
            &ctx.accounts.markets.load()?,
            funding_payment_history,
            now,
        )?;

        // Get existing position or add a new position for market
        let position_index = get_position_index(user_positions, market_index)
            .or_else(|_| add_new_position(user_positions, market_index))?;
        let market_position = &mut user_positions.positions[position_index];

        // Collect data about position/market before trade is executed so that it can be stored in trade history
        let mark_price_before: u128;
        let oracle_mark_spread_pct_before: i128;
        let is_oracle_valid: bool;
        {
            let market = &mut ctx.accounts.markets.load_mut()?.markets
                [Markets::index_from_u64(market_index)];
            mark_price_before = market.amm.mark_price()?;
            let oracle_price_data = &market
                .amm
                .get_oracle_price(&ctx.accounts.oracle, clock_slot)?;
            oracle_mark_spread_pct_before = amm::calculate_oracle_mark_spread_pct(
                &market.amm,
                oracle_price_data,
                0,
                Some(mark_price_before),
            )?;
            is_oracle_valid = amm::is_oracle_valid(
                oracle_price_data,
                &ctx.accounts.state.oracle_guard_rails.validity,
            )?;
            if is_oracle_valid {
                let normalised_oracle_price = normalise_oracle_price(
                    &market.amm,
                    oracle_price_data,
                    Some(mark_price_before),
                )?;
                amm::update_oracle_price_twap(&mut market.amm, now, normalised_oracle_price)?;
            }
        }

        // A trade is risk increasing if it increases the users leverage
        // If a trade is risk increasing and brings the user's margin ratio below initial requirement
        // the trade fails
        // If a trade is risk increasing and it pushes the mark price too far away from the oracle price
        // the trade fails
        let potentially_risk_increasing;
        let base_asset_amount;
        let mut quote_asset_amount = quote_asset_amount;
        {
            let markets = &mut ctx.accounts.markets.load_mut()?;
            let market = markets.get_market_mut(market_index);
            let (_potentially_risk_increasing, _, _base_asset_amount, _quote_asset_amount) =
                controller::position::update_position_with_quote_asset_amount(
                    quote_asset_amount,
                    direction,
                    market,
                    user,
                    market_position,
                    mark_price_before,
                    now,
                )?;

            potentially_risk_increasing = _potentially_risk_increasing;
            base_asset_amount = _base_asset_amount;
            quote_asset_amount = _quote_asset_amount;
        }

        // Collect data about position/market after trade is executed so that it can be stored in trade history
        let mark_price_after: u128;
        let oracle_price_after: i128;
        let oracle_mark_spread_pct_after: i128;
        {
            let market = &mut ctx.accounts.markets.load_mut()?.markets
                [Markets::index_from_u64(market_index)];
            mark_price_after = market.amm.mark_price()?;
            let oracle_price_data = &market
                .amm
                .get_oracle_price(&ctx.accounts.oracle, clock_slot)?;
            oracle_mark_spread_pct_after = amm::calculate_oracle_mark_spread_pct(
                &market.amm,
                oracle_price_data,
                0,
                Some(mark_price_after),
            )?;
            oracle_price_after = oracle_price_data.price;
        }

        // Trade fails if it's risk increasing and it brings the user below the initial margin ratio level
        let meets_initial_margin_requirement =
            meets_initial_margin_requirement(user, user_positions, &ctx.accounts.markets.load()?)?;
        if !meets_initial_margin_requirement && potentially_risk_increasing {
            return Err(ErrorCode::InsufficientCollateral.into());
        }

        // Calculate the fee to charge the user
        let (discount_token, referrer) = optional_accounts::get_discount_token_and_referrer(
            optional_accounts,
            ctx.remaining_accounts,
            &ctx.accounts.state.discount_mint,
            &user.key(),
            &ctx.accounts.authority.key(),
        )?;
        let (user_fee, fee_to_market, token_discount, referrer_reward, referee_discount) =
            fees::calculate_fee_for_market_order(
                quote_asset_amount,
                &ctx.accounts.state.fee_structure,
                discount_token,
                &referrer,
            )?;

        // Increment the clearing house's total fee variables
        {
            let market = &mut ctx.accounts.markets.load_mut()?.markets
                [Markets::index_from_u64(market_index)];
            market.amm.total_fee = market
                .amm
                .total_fee
                .checked_add(fee_to_market)
                .ok_or_else(math_error!())?;
            market.amm.total_fee_minus_distributions = market
                .amm
                .total_fee_minus_distributions
                .checked_add(fee_to_market)
                .ok_or_else(math_error!())?;
        }

        // Subtract the fee from user's collateral
        user.collateral = user.collateral.checked_sub(user_fee).or(Some(0)).unwrap();

        // Increment the user's total fee variables
        user.total_fee_paid = user
            .total_fee_paid
            .checked_add(user_fee)
            .ok_or_else(math_error!())?;
        user.total_token_discount = user
            .total_token_discount
            .checked_add(token_discount)
            .ok_or_else(math_error!())?;
        user.total_referee_discount = user
            .total_referee_discount
            .checked_add(referee_discount)
            .ok_or_else(math_error!())?;

        // Update the referrer's collateral with their reward
        if referrer.is_some() {
            let mut referrer = referrer.unwrap();
            referrer.total_referral_reward = referrer
                .total_referral_reward
                .checked_add(referrer_reward)
                .ok_or_else(math_error!())?;
            referrer.exit(ctx.program_id)?;
        }

        // Trade fails if the trade is risk increasing and it pushes to mark price too far
        // away from the oracle price
        let is_oracle_mark_too_divergent_before = amm::is_oracle_mark_too_divergent(
            oracle_mark_spread_pct_before,
            &ctx.accounts.state.oracle_guard_rails.price_divergence,
        )?;
        let is_oracle_mark_too_divergent_after = amm::is_oracle_mark_too_divergent(
            oracle_mark_spread_pct_after,
            &ctx.accounts.state.oracle_guard_rails.price_divergence,
        )?;

        // if oracle-mark divergence pushed outside limit, block trade
        if is_oracle_mark_too_divergent_after
            && !is_oracle_mark_too_divergent_before
            && is_oracle_valid
        {
            return Err(ErrorCode::OracleMarkSpreadLimit.into());
        }

        // if oracle-mark divergence outside limit and risk-increasing, block trade
        if is_oracle_mark_too_divergent_after
            && oracle_mark_spread_pct_after.unsigned_abs()
                >= oracle_mark_spread_pct_before.unsigned_abs()
            && is_oracle_valid
            && potentially_risk_increasing
        {
            return Err(ErrorCode::OracleMarkSpreadLimit.into());
        }

        // Add to the trade history account
        let trade_history_account = &mut ctx.accounts.trade_history.load_mut()?;
        let record_id = trade_history_account.next_record_id();
        trade_history_account.append(TradeRecord {
            ts: now,
            record_id,
            user_authority: *ctx.accounts.authority.to_account_info().key,
            user: *user.to_account_info().key,
            direction,
            base_asset_amount,
            quote_asset_amount,
            mark_price_before,
            mark_price_after,
            fee: user_fee,
            token_discount,
            referrer_reward,
            referee_discount,
            liquidation: false,
            market_index,
            oracle_price: oracle_price_after,
        });

        // If the user adds a limit price to their trade, check that their entry price is better than the limit price
        if limit_price != 0
            && !limit_price_satisfied(
                limit_price,
                quote_asset_amount,
                base_asset_amount,
                direction,
            )?
        {
            return Err(ErrorCode::SlippageOutsideLimit.into());
        }

        // Try to update the funding rate at the end of every trade
        {
            let market = &mut ctx.accounts.markets.load_mut()?.markets
                [Markets::index_from_u64(market_index)];
            let price_oracle = &ctx.accounts.oracle;
            let funding_rate_history = &mut ctx.accounts.funding_rate_history.load_mut()?;
            controller::funding::update_funding_rate(
                market_index,
                market,
                price_oracle,
                now,
                clock_slot,
                funding_rate_history,
                &ctx.accounts.state.oracle_guard_rails,
                ctx.accounts.state.funding_paused,
                Some(mark_price_before),
            )?;
        }

        Ok(())
    }

    #[allow(unused_must_use)]
    #[access_control(
        market_initialized(&ctx.accounts.markets, market_index) &&
        exchange_not_paused(&ctx.accounts.state) &&
        valid_oracle_for_market(&ctx.accounts.oracle, &ctx.accounts.markets, market_index)
    )]
    pub fn close_position(
        ctx: Context<ClosePosition>,
        market_index: u64,
        optional_accounts: ManagePositionOptionalAccounts,
    ) -> ProgramResult {
        let user = &mut ctx.accounts.user;
        let clock = Clock::get()?;
        let now = clock.unix_timestamp;
        let clock_slot = clock.slot;

        // Settle user's funding payments so that collateral is up to date
        let user_positions = &mut ctx.accounts.user_positions.load_mut()?;
        let funding_payment_history = &mut ctx.accounts.funding_payment_history.load_mut()?;
        controller::funding::settle_funding_payment(
            user,
            user_positions,
            &ctx.accounts.markets.load()?,
            funding_payment_history,
            now,
        )?;

        let position_index = get_position_index(user_positions, market_index)?;
        let market_position = &mut user_positions.positions[position_index];

        let market =
            &mut ctx.accounts.markets.load_mut()?.markets[Markets::index_from_u64(market_index)];

        // Collect data about market before trade is executed so that it can be stored in trade history
        let mark_price_before = market.amm.mark_price()?;
        let oracle_price_data = &market
            .amm
            .get_oracle_price(&ctx.accounts.oracle, clock_slot)?;
        let oracle_mark_spread_pct_before = amm::calculate_oracle_mark_spread_pct(
            &market.amm,
            oracle_price_data,
            0,
            Some(mark_price_before),
        )?;
        let direction_to_close =
            math::position::direction_to_close_position(market_position.base_asset_amount);
        let (quote_asset_amount, base_asset_amount) = controller::position::close(
            user,
            market,
            market_position,
            now,
            Some(mark_price_before),
        )?;
        let base_asset_amount = base_asset_amount.unsigned_abs();

        // Calculate the fee to charge the user
        let (discount_token, referrer) = optional_accounts::get_discount_token_and_referrer(
            optional_accounts,
            ctx.remaining_accounts,
            &ctx.accounts.state.discount_mint,
            &user.key(),
            &ctx.accounts.authority.key(),
        )?;
        let (user_fee, fee_to_market, token_discount, referrer_reward, referee_discount) =
            fees::calculate_fee_for_market_order(
                quote_asset_amount,
                &ctx.accounts.state.fee_structure,
                discount_token,
                &referrer,
            )?;

        // Increment the clearing house's total fee variables
        market.amm.total_fee = market
            .amm
            .total_fee
            .checked_add(fee_to_market)
            .ok_or_else(math_error!())?;
        market.amm.total_fee_minus_distributions = market
            .amm
            .total_fee_minus_distributions
            .checked_add(fee_to_market)
            .ok_or_else(math_error!())?;

        // Subtract the fee from user's collateral
        user.collateral = user.collateral.checked_sub(user_fee).or(Some(0)).unwrap();

        // Increment the user's total fee variables
        user.total_fee_paid = user
            .total_fee_paid
            .checked_add(user_fee)
            .ok_or_else(math_error!())?;
        user.total_token_discount = user
            .total_token_discount
            .checked_add(token_discount)
            .ok_or_else(math_error!())?;
        user.total_referee_discount = user
            .total_referee_discount
            .checked_add(referee_discount)
            .ok_or_else(math_error!())?;

        // Update the referrer's collateral with their reward
        if referrer.is_some() {
            let mut referrer = referrer.unwrap();
            referrer.total_referral_reward = referrer
                .total_referral_reward
                .checked_add(referrer_reward)
                .ok_or_else(math_error!())?;
            referrer.exit(ctx.program_id)?;
        }

        // Collect data about market after trade is executed so that it can be stored in trade history
        let mark_price_after = market.amm.mark_price()?;
        let price_oracle = &ctx.accounts.oracle;

        let oracle_mark_spread_pct_after = amm::calculate_oracle_mark_spread_pct(
            &market.amm,
            oracle_price_data,
            0,
            Some(mark_price_after),
        )?;
        let oracle_price_after = oracle_price_data.price;

        let is_oracle_valid = amm::is_oracle_valid(
            oracle_price_data,
            &ctx.accounts.state.oracle_guard_rails.validity,
        )?;
        if is_oracle_valid {
            let normalised_oracle_price =
                normalise_oracle_price(&market.amm, oracle_price_data, Some(mark_price_before))?;
            amm::update_oracle_price_twap(&mut market.amm, now, normalised_oracle_price)?;
        }

        // Trade fails if the trade is risk increasing and it pushes to mark price too far
        // away from the oracle price
        let is_oracle_mark_too_divergent_before = amm::is_oracle_mark_too_divergent(
            oracle_mark_spread_pct_before,
            &ctx.accounts.state.oracle_guard_rails.price_divergence,
        )?;
        let is_oracle_mark_too_divergent_after = amm::is_oracle_mark_too_divergent(
            oracle_mark_spread_pct_after,
            &ctx.accounts.state.oracle_guard_rails.price_divergence,
        )?;

        // if closing position pushes outside of oracle-mark divergence limit, block trade
        if (is_oracle_mark_too_divergent_after && !is_oracle_mark_too_divergent_before)
            && is_oracle_valid
        {
            return Err(ErrorCode::OracleMarkSpreadLimit.into());
        }

        // Add to the trade history account
        let trade_history_account = &mut ctx.accounts.trade_history.load_mut()?;
        let record_id = trade_history_account.next_record_id();
        trade_history_account.append(TradeRecord {
            ts: now,
            record_id,
            user_authority: *ctx.accounts.authority.to_account_info().key,
            user: *user.to_account_info().key,
            direction: direction_to_close,
            base_asset_amount,
            quote_asset_amount,
            mark_price_before,
            mark_price_after,
            liquidation: false,
            fee: user_fee,
            token_discount,
            referrer_reward,
            referee_discount,
            market_index,
            oracle_price: oracle_price_after,
        });

        // Try to update the funding rate at the end of every trade
        let funding_rate_history = &mut ctx.accounts.funding_rate_history.load_mut()?;
        controller::funding::update_funding_rate(
            market_index,
            market,
            price_oracle,
            now,
            clock_slot,
            funding_rate_history,
            &ctx.accounts.state.oracle_guard_rails,
            ctx.accounts.state.funding_paused,
            Some(mark_price_before),
        )?;

        Ok(())
    }

    #[allow(unused_must_use)]
    #[access_control(
        market_initialized(&ctx.accounts.markets, params.market_index)
    )]
    pub fn place_order<'info>(ctx: Context<PlaceOrder>, params: OrderParams) -> ProgramResult {
        let account_info_iter = &mut ctx.remaining_accounts.iter();
        let discount_token = get_discount_token(
            params.optional_accounts.discount_token,
            account_info_iter,
            &ctx.accounts.state.discount_mint,
            ctx.accounts.authority.key,
        )?;
        let referrer = get_referrer(
            params.optional_accounts.referrer,
            account_info_iter,
            &ctx.accounts.user.key(),
            None,
        )?;

        if params.order_type == OrderType::Market {
            return Err(ErrorCode::MarketOrderMustBeInPlaceAndFill.into());
        }

        controller::orders::place_order(
            &ctx.accounts.state,
            &ctx.accounts.order_state,
            &mut ctx.accounts.user,
            &ctx.accounts.user_positions,
            &ctx.accounts.markets,
            &ctx.accounts.user_orders,
            &ctx.accounts.funding_payment_history,
            &ctx.accounts.order_history,
            discount_token,
            &referrer,
            &Clock::get()?,
            params,
        )?;

        Ok(())
    }

    pub fn cancel_order(ctx: Context<CancelOrder>, order_id: u128) -> ProgramResult {
        controller::orders::cancel_order_by_order_id(
            order_id,
            &mut ctx.accounts.user,
            &ctx.accounts.user_positions,
            &ctx.accounts.markets,
            &ctx.accounts.user_orders,
            &ctx.accounts.funding_payment_history,
            &ctx.accounts.order_history,
            &Clock::get()?,
        )?;

        Ok(())
    }

    pub fn cancel_order_by_user_id(ctx: Context<CancelOrder>, user_order_id: u8) -> ProgramResult {
        controller::orders::cancel_order_by_user_order_id(
            user_order_id,
            &mut ctx.accounts.user,
            &ctx.accounts.user_positions,
            &ctx.accounts.markets,
            &ctx.accounts.user_orders,
            &ctx.accounts.funding_payment_history,
            &ctx.accounts.order_history,
            &Clock::get()?,
        )?;

        Ok(())
    }

    #[access_control(
        exchange_not_paused(&ctx.accounts.state)
    )]
    pub fn fill_order<'info>(ctx: Context<FillOrder>, order_id: u128) -> ProgramResult {
        let account_info_iter = &mut ctx.remaining_accounts.iter();
        let referrer = get_referrer_for_fill_order(
            account_info_iter,
            &ctx.accounts.user.key(),
            order_id,
            &ctx.accounts.user_orders,
        )?;

        let base_asset_amount = controller::orders::fill_order(
            order_id,
            &ctx.accounts.state,
            &ctx.accounts.order_state,
            &mut ctx.accounts.user,
            &ctx.accounts.user_positions,
            &ctx.accounts.markets,
            &ctx.accounts.oracle,
            &ctx.accounts.user_orders,
            &mut ctx.accounts.filler,
            &ctx.accounts.funding_payment_history,
            &ctx.accounts.trade_history,
            &ctx.accounts.order_history,
            &ctx.accounts.funding_rate_history,
            referrer,
            &Clock::get()?,
        )?;

        if base_asset_amount == 0 {
            return Err(print_error!(ErrorCode::CouldNotFillOrder)().into());
        }

        Ok(())
    }

    #[allow(unused_must_use)]
    #[access_control(
        exchange_not_paused(&ctx.accounts.state) &&
        market_initialized(&ctx.accounts.markets, params.market_index) &&
        valid_oracle_for_market(&ctx.accounts.oracle, &ctx.accounts.markets, params.market_index)
    )]
    pub fn place_and_fill_order<'info>(
        ctx: Context<PlaceAndFillOrder>,
        params: OrderParams,
    ) -> ProgramResult {
        let account_info_iter = &mut ctx.remaining_accounts.iter();
        let discount_token = get_discount_token(
            params.optional_accounts.discount_token,
            account_info_iter,
            &ctx.accounts.state.discount_mint,
            ctx.accounts.authority.key,
        )?;
        let referrer = get_referrer(
            params.optional_accounts.referrer,
            account_info_iter,
            &ctx.accounts.user.key(),
            None,
        )?;

        controller::orders::place_order(
            &ctx.accounts.state,
            &ctx.accounts.order_state,
            &mut ctx.accounts.user,
            &ctx.accounts.user_positions,
            &ctx.accounts.markets,
            &ctx.accounts.user_orders,
            &ctx.accounts.funding_payment_history,
            &ctx.accounts.order_history,
            discount_token,
            &referrer,
            &Clock::get()?,
            params,
        )?;

        let order_id;
        {
            let order_history = &ctx.accounts.order_history.load()?;
            order_id = order_history.last_order_id;
        }

        let user = &mut ctx.accounts.user;
        controller::orders::fill_order(
            order_id,
            &ctx.accounts.state,
            &ctx.accounts.order_state,
            user,
            &ctx.accounts.user_positions,
            &ctx.accounts.markets,
            &ctx.accounts.oracle,
            &ctx.accounts.user_orders,
            &mut user.clone(),
            &ctx.accounts.funding_payment_history,
            &ctx.accounts.trade_history,
            &ctx.accounts.order_history,
            &ctx.accounts.funding_rate_history,
            referrer,
            &Clock::get()?,
        )?;

        Ok(())
    }

    #[access_control(
        exchange_not_paused(&ctx.accounts.state)
    )]
    pub fn liquidate(ctx: Context<Liquidate>) -> ProgramResult {
        let state = &ctx.accounts.state;
        let user = &mut ctx.accounts.user;
        let trade_history = &mut ctx.accounts.trade_history.load_mut()?;
        let clock = Clock::get()?;
        let now = clock.unix_timestamp;
        let clock_slot = clock.slot;

        // Settle user's funding payments so that collateral is up to date
        let user_positions = &mut ctx.accounts.user_positions.load_mut()?;
        let funding_payment_history = &mut ctx.accounts.funding_payment_history.load_mut()?;
        controller::funding::settle_funding_payment(
            user,
            user_positions,
            &ctx.accounts.markets.load()?,
            funding_payment_history,
            now,
        )?;

        let LiquidationStatus {
            liquidation_type,
            total_collateral,
            adjusted_total_collateral,
            unrealized_pnl,
            base_asset_value,
            market_statuses,
            mut margin_requirement,
            margin_ratio,
        } = calculate_liquidation_status(
            user,
            user_positions,
            &ctx.accounts.markets.load()?,
            ctx.remaining_accounts,
            &ctx.accounts.state.oracle_guard_rails,
            clock_slot,
        )?;

        // Verify that the user is in liquidation territory
        let collateral = user.collateral;
        if liquidation_type == LiquidationType::NONE {
            msg!("total_collateral {}", total_collateral);
            msg!("adjusted_total_collateral {}", adjusted_total_collateral);
            msg!("margin_requirement {}", margin_requirement);
            return Err(ErrorCode::SufficientCollateral.into());
        }

        let is_dust_position = adjusted_total_collateral <= QUOTE_PRECISION;

        // Keep track to the value of positions closed. For full liquidation this is the user's entire position,
        // for partial it is less (it's based on the clearing house state)
        let mut base_asset_value_closed: u128 = 0;
        let mut liquidation_fee = 0_u128;
        // have to fully liquidate dust positions to make it worth it for liquidators
        let is_full_liquidation = liquidation_type == LiquidationType::FULL || is_dust_position;
        if is_full_liquidation {
            let markets = &mut ctx.accounts.markets.load_mut()?;

            let maximum_liquidation_fee = total_collateral
                .checked_mul(state.full_liquidation_penalty_percentage_numerator)
                .ok_or_else(math_error!())?
                .checked_div(state.full_liquidation_penalty_percentage_denominator)
                .ok_or_else(math_error!())?;
            for market_status in market_statuses.iter() {
                if market_status.base_asset_value == 0 {
                    continue;
                }

                let market = markets.get_market_mut(market_status.market_index);
                let mark_price_before = market_status.mark_price_before;
                let oracle_status = &market_status.oracle_status;

                // if the oracle is invalid and the mark moves too far from twap, dont liquidate
                let oracle_is_valid = oracle_status.is_valid;
                if !oracle_is_valid {
                    let mark_twap_divergence =
                        calculate_mark_twap_spread_pct(&market.amm, mark_price_before)?;
                    let mark_twap_too_divergent =
                        mark_twap_divergence.unsigned_abs() >= MAX_MARK_TWAP_DIVERGENCE;

                    if mark_twap_too_divergent {
                        let market_index = market_status.market_index;
                        msg!(
                            "mark_twap_divergence {} for market {}",
                            mark_twap_divergence,
                            market_index
                        );
                        continue;
                    }
                }

                let market_position = &mut user_positions
                    .positions
                    .iter_mut()
                    .find(|position| position.market_index == market_status.market_index)
                    .unwrap();

                let mark_price_before_i128 = cast_to_i128(mark_price_before)?;
                let close_position_slippage = match market_status.close_position_slippage {
                    Some(close_position_slippage) => close_position_slippage,
                    None => calculate_slippage(
                        market_status.base_asset_value,
                        market_position.base_asset_amount.unsigned_abs(),
                        mark_price_before_i128,
                    )?,
                };
                let close_position_slippage_pct =
                    calculate_slippage_pct(close_position_slippage, mark_price_before_i128)?;

                let close_slippage_pct_too_large = close_position_slippage_pct
                    > MAX_LIQUIDATION_SLIPPAGE
                    || close_position_slippage_pct < -MAX_LIQUIDATION_SLIPPAGE;

                let oracle_mark_divergence_after_close = if !close_slippage_pct_too_large {
                    oracle_status
                        .oracle_mark_spread_pct
                        .checked_add(close_position_slippage_pct)
                        .ok_or_else(math_error!())?
                } else if close_position_slippage_pct > 0 {
                    oracle_status
                        .oracle_mark_spread_pct
                        // approximates price impact based on slippage
                        .checked_add(MAX_LIQUIDATION_SLIPPAGE * 2)
                        .ok_or_else(math_error!())?
                } else {
                    oracle_status
                        .oracle_mark_spread_pct
                        // approximates price impact based on slippage
                        .checked_sub(MAX_LIQUIDATION_SLIPPAGE * 2)
                        .ok_or_else(math_error!())?
                };

                let oracle_mark_too_divergent_after_close = is_oracle_mark_too_divergent(
                    oracle_mark_divergence_after_close,
                    &state.oracle_guard_rails.price_divergence,
                )?;

                // if closing pushes outside the oracle mark threshold, don't liquidate
                if oracle_is_valid && oracle_mark_too_divergent_after_close {
                    // but only skip the liquidation if it makes the divergence worse
                    if oracle_status.oracle_mark_spread_pct.unsigned_abs()
                        < oracle_mark_divergence_after_close.unsigned_abs()
                    {
                        let market_index = market_position.market_index;
                        msg!(
                            "oracle_mark_divergence_after_close {} for market {}",
                            oracle_mark_divergence_after_close,
                            market_index,
                        );
                        continue;
                    }
                }

                let direction_to_close =
                    math::position::direction_to_close_position(market_position.base_asset_amount);

                // just reduce position if position is too big
                let (quote_asset_amount, base_asset_amount) = if close_slippage_pct_too_large {
                    let quote_asset_amount = market_status
                        .base_asset_value
                        .checked_mul(MAX_LIQUIDATION_SLIPPAGE_U128)
                        .ok_or_else(math_error!())?
                        .checked_div(close_position_slippage_pct.unsigned_abs())
                        .ok_or_else(math_error!())?;

                    let base_asset_amount = controller::position::reduce(
                        direction_to_close,
                        quote_asset_amount,
                        user,
                        market,
                        market_position,
                        now,
                        Some(mark_price_before),
                    )?;

                    (quote_asset_amount, base_asset_amount)
                } else {
                    controller::position::close(
                        user,
                        market,
                        market_position,
                        now,
                        Some(mark_price_before),
                    )?
                };

                let base_asset_amount = base_asset_amount.unsigned_abs();
                base_asset_value_closed = base_asset_value_closed
                    .checked_add(quote_asset_amount)
                    .ok_or_else(math_error!())?;
                let mark_price_after = market.amm.mark_price()?;

                let record_id = trade_history.next_record_id();
                trade_history.append(TradeRecord {
                    ts: now,
                    record_id,
                    user_authority: user.authority,
                    user: *user.to_account_info().key,
                    direction: direction_to_close,
                    base_asset_amount,
                    quote_asset_amount,
                    mark_price_before,
                    mark_price_after,
                    fee: 0,
                    token_discount: 0,
                    referrer_reward: 0,
                    referee_discount: 0,
                    liquidation: true,
                    market_index: market_position.market_index,
                    oracle_price: market_status.oracle_status.price_data.price,
                });

                margin_requirement = margin_requirement
                    .checked_sub(
                        market_status
                            .maintenance_margin_requirement
                            .checked_mul(quote_asset_amount)
                            .ok_or_else(math_error!())?
                            .checked_div(market_status.base_asset_value)
                            .ok_or_else(math_error!())?,
                    )
                    .ok_or_else(math_error!())?;

                let market_liquidation_fee = maximum_liquidation_fee
                    .checked_mul(quote_asset_amount)
                    .ok_or_else(math_error!())?
                    .checked_div(base_asset_value)
                    .ok_or_else(math_error!())?;

                liquidation_fee = liquidation_fee
                    .checked_add(market_liquidation_fee)
                    .ok_or_else(math_error!())?;

                let adjusted_total_collateral_after_fee = adjusted_total_collateral
                    .checked_sub(liquidation_fee)
                    .ok_or_else(math_error!())?;

                if !is_dust_position && margin_requirement < adjusted_total_collateral_after_fee {
                    break;
                }
            }
        } else {
            let markets = &mut ctx.accounts.markets.load_mut()?;

            let maximum_liquidation_fee = total_collateral
                .checked_mul(state.partial_liquidation_penalty_percentage_numerator)
                .ok_or_else(math_error!())?
                .checked_div(state.partial_liquidation_penalty_percentage_denominator)
                .ok_or_else(math_error!())?;
            let maximum_base_asset_value_closed = base_asset_value
                .checked_mul(state.partial_liquidation_close_percentage_numerator)
                .ok_or_else(math_error!())?
                .checked_div(state.partial_liquidation_close_percentage_denominator)
                .ok_or_else(math_error!())?;
            for market_status in market_statuses.iter() {
                if market_status.base_asset_value == 0 {
                    continue;
                }

                let oracle_status = &market_status.oracle_status;
                let market = markets.get_market_mut(market_status.market_index);
                let mark_price_before = market_status.mark_price_before;

                let oracle_is_valid = oracle_status.is_valid;
                if !oracle_is_valid {
                    let mark_twap_divergence =
                        calculate_mark_twap_spread_pct(&market.amm, mark_price_before)?;
                    let mark_twap_too_divergent =
                        mark_twap_divergence.unsigned_abs() >= MAX_MARK_TWAP_DIVERGENCE;

                    if mark_twap_too_divergent {
                        let market_index = market_status.market_index;
                        msg!(
                            "mark_twap_divergence {} for market {}",
                            mark_twap_divergence,
                            market_index
                        );
                        continue;
                    }
                }

                let market_position = &mut user_positions
                    .positions
                    .iter_mut()
                    .find(|position| position.market_index == market_status.market_index)
                    .unwrap();

                let mut quote_asset_amount = market_status
                    .base_asset_value
                    .checked_mul(state.partial_liquidation_close_percentage_numerator)
                    .ok_or_else(math_error!())?
                    .checked_div(state.partial_liquidation_close_percentage_denominator)
                    .ok_or_else(math_error!())?;

                let mark_price_before_i128 = cast_to_i128(mark_price_before)?;
                let reduce_position_slippage = match market_status.close_position_slippage {
                    Some(close_position_slippage) => close_position_slippage.div(4),
                    None => calculate_slippage(
                        market_status.base_asset_value,
                        market_position.base_asset_amount.unsigned_abs(),
                        mark_price_before_i128,
                    )?
                    .div(4),
                };

                let reduce_position_slippage_pct =
                    calculate_slippage_pct(reduce_position_slippage, mark_price_before_i128)?;

                msg!(
                    "reduce_position_slippage_pct {}",
                    reduce_position_slippage_pct
                );

                let reduce_slippage_pct_too_large = reduce_position_slippage_pct
                    > MAX_LIQUIDATION_SLIPPAGE
                    || reduce_position_slippage_pct < -MAX_LIQUIDATION_SLIPPAGE;

                let oracle_mark_divergence_after_reduce = if !reduce_slippage_pct_too_large {
                    oracle_status
                        .oracle_mark_spread_pct
                        .checked_add(reduce_position_slippage_pct)
                        .ok_or_else(math_error!())?
                } else if reduce_position_slippage_pct > 0 {
                    oracle_status
                        .oracle_mark_spread_pct
                        // approximates price impact based on slippage
                        .checked_add(MAX_LIQUIDATION_SLIPPAGE * 2)
                        .ok_or_else(math_error!())?
                } else {
                    oracle_status
                        .oracle_mark_spread_pct
                        // approximates price impact based on slippage
                        .checked_sub(MAX_LIQUIDATION_SLIPPAGE * 2)
                        .ok_or_else(math_error!())?
                };

                let oracle_mark_too_divergent_after_reduce = is_oracle_mark_too_divergent(
                    oracle_mark_divergence_after_reduce,
                    &state.oracle_guard_rails.price_divergence,
                )?;

                // if reducing pushes outside the oracle mark threshold, don't liquidate
                if oracle_is_valid && oracle_mark_too_divergent_after_reduce {
                    // but only skip the liquidation if it makes the divergence worse
                    if oracle_status.oracle_mark_spread_pct.unsigned_abs()
                        < oracle_mark_divergence_after_reduce.unsigned_abs()
                    {
                        msg!(
                            "oracle_mark_spread_pct_after_reduce {}",
                            oracle_mark_divergence_after_reduce
                        );
                        return Err(ErrorCode::OracleMarkSpreadLimit.into());
                    }
                }

                if reduce_slippage_pct_too_large {
                    quote_asset_amount = quote_asset_amount
                        .checked_mul(MAX_LIQUIDATION_SLIPPAGE_U128)
                        .ok_or_else(math_error!())?
                        .checked_div(reduce_position_slippage_pct.unsigned_abs())
                        .ok_or_else(math_error!())?;
                }

                base_asset_value_closed = base_asset_value_closed
                    .checked_add(quote_asset_amount)
                    .ok_or_else(math_error!())?;

                let direction_to_reduce =
                    math::position::direction_to_close_position(market_position.base_asset_amount);

                let base_asset_amount = controller::position::reduce(
                    direction_to_reduce,
                    quote_asset_amount,
                    user,
                    market,
                    market_position,
                    now,
                    Some(mark_price_before),
                )?
                .unsigned_abs();

                let mark_price_after = market.amm.mark_price()?;

                let record_id = trade_history.next_record_id();
                trade_history.append(TradeRecord {
                    ts: now,
                    record_id,
                    user_authority: user.authority,
                    user: *user.to_account_info().key,
                    direction: direction_to_reduce,
                    base_asset_amount,
                    quote_asset_amount,
                    mark_price_before,
                    mark_price_after,
                    fee: 0,
                    token_discount: 0,
                    referrer_reward: 0,
                    referee_discount: 0,
                    liquidation: true,
                    market_index: market_position.market_index,
                    oracle_price: market_status.oracle_status.price_data.price,
                });

                margin_requirement = margin_requirement
                    .checked_sub(
                        market_status
                            .partial_margin_requirement
                            .checked_mul(quote_asset_amount)
                            .ok_or_else(math_error!())?
                            .checked_div(market_status.base_asset_value)
                            .ok_or_else(math_error!())?,
                    )
                    .ok_or_else(math_error!())?;

                let market_liquidation_fee = maximum_liquidation_fee
                    .checked_mul(quote_asset_amount)
                    .ok_or_else(math_error!())?
                    .checked_div(maximum_base_asset_value_closed)
                    .ok_or_else(math_error!())?;

                liquidation_fee = liquidation_fee
                    .checked_add(market_liquidation_fee)
                    .ok_or_else(math_error!())?;

                let adjusted_total_collateral_after_fee = adjusted_total_collateral
                    .checked_sub(liquidation_fee)
                    .ok_or_else(math_error!())?;

                if margin_requirement < adjusted_total_collateral_after_fee {
                    break;
                }
            }
        }

        if base_asset_value_closed == 0 {
            return Err(print_error!(ErrorCode::NoPositionsLiquidatable)().into());
        }

        let (withdrawal_amount, _) = calculate_withdrawal_amounts(
            cast(liquidation_fee)?,
            &ctx.accounts.collateral_vault,
            &ctx.accounts.insurance_vault,
        )?;

        user.collateral = user
            .collateral
            .checked_sub(liquidation_fee)
            .ok_or_else(math_error!())?;

        let fee_to_liquidator = if is_full_liquidation {
            withdrawal_amount
                .checked_div(state.full_liquidation_liquidator_share_denominator)
                .ok_or_else(math_error!())?
        } else {
            withdrawal_amount
                .checked_div(state.partial_liquidation_liquidator_share_denominator)
                .ok_or_else(math_error!())?
        };

        let fee_to_insurance_fund = withdrawal_amount
            .checked_sub(fee_to_liquidator)
            .ok_or_else(math_error!())?;

        if fee_to_liquidator > 0 {
            let liquidator = &mut ctx.accounts.liquidator;
            liquidator.collateral = liquidator
                .collateral
                .checked_add(cast(fee_to_liquidator)?)
                .ok_or_else(math_error!())?;
        }

        if fee_to_insurance_fund > 0 {
            controller::token::send(
                &ctx.accounts.token_program,
                &ctx.accounts.collateral_vault,
                &ctx.accounts.insurance_vault,
                &ctx.accounts.collateral_vault_authority,
                ctx.accounts.state.collateral_vault_nonce,
                fee_to_insurance_fund,
            )?;
        }

        let liquidation_history = &mut ctx.accounts.liquidation_history.load_mut()?;
        let record_id = liquidation_history.next_record_id();

        liquidation_history.append(LiquidationRecord {
            ts: now,
            record_id,
            user: user.to_account_info().key(),
            user_authority: user.authority,
            partial: !is_full_liquidation,
            base_asset_value,
            base_asset_value_closed,
            liquidation_fee,
            fee_to_liquidator,
            fee_to_insurance_fund,
            liquidator: ctx.accounts.liquidator.to_account_info().key(),
            total_collateral,
            collateral,
            unrealized_pnl,
            margin_ratio,
        });

        Ok(())
    }

    #[allow(unused_must_use)]
    #[access_control(
        market_initialized(&ctx.accounts.markets, market_index) &&
        exchange_not_paused(&ctx.accounts.state) &&
        admin_controls_prices(&ctx.accounts.state)
    )]
    pub fn move_amm_price(
        ctx: Context<MoveAMMPrice>,
        base_asset_reserve: u128,
        quote_asset_reserve: u128,
        market_index: u64,
    ) -> ProgramResult {
        let markets = &mut ctx.accounts.markets.load_mut()?;
        let market = &mut markets.markets[Markets::index_from_u64(market_index)];
        controller::amm::move_price(&mut market.amm, base_asset_reserve, quote_asset_reserve)?;
        Ok(())
    }

    #[access_control(
        market_initialized(&ctx.accounts.markets, market_index)
    )]
    pub fn withdraw_fees(
        ctx: Context<WithdrawFees>,
        market_index: u64,
        amount: u64,
    ) -> ProgramResult {
        let state = &mut ctx.accounts.state;
        let markets = &mut ctx.accounts.markets.load_mut()?;
        let market = &mut markets.markets[Markets::index_from_u64(market_index)];

        // A portion of fees must always remain in protocol to be used to keep markets optimal
        let max_withdraw = market
            .amm
            .total_fee
            .checked_mul(SHARE_OF_FEES_ALLOCATED_TO_CLEARING_HOUSE_NUMERATOR)
            .ok_or_else(math_error!())?
            .checked_div(SHARE_OF_FEES_ALLOCATED_TO_CLEARING_HOUSE_DENOMINATOR)
            .ok_or_else(math_error!())?
            .checked_sub(market.amm.total_fee_withdrawn)
            .ok_or_else(math_error!())?;

        if cast_to_u128(amount)? > max_withdraw {
            return Err(ErrorCode::AdminWithdrawTooLarge.into());
        }

        controller::token::send(
            &ctx.accounts.token_program,
            &ctx.accounts.collateral_vault,
            &ctx.accounts.recipient,
            &ctx.accounts.collateral_vault_authority,
            state.collateral_vault_nonce,
            amount,
        )?;

        market.amm.total_fee_withdrawn = market
            .amm
            .total_fee_withdrawn
            .checked_add(cast(amount)?)
            .ok_or_else(math_error!())?;

        Ok(())
    }

    pub fn withdraw_from_insurance_vault(
        ctx: Context<WithdrawFromInsuranceVault>,
        amount: u64,
    ) -> ProgramResult {
        controller::token::send(
            &ctx.accounts.token_program,
            &ctx.accounts.insurance_vault,
            &ctx.accounts.recipient,
            &ctx.accounts.insurance_vault_authority,
            ctx.accounts.state.insurance_vault_nonce,
            amount,
        )?;
        Ok(())
    }

    #[access_control(
        market_initialized(&ctx.accounts.markets, market_index)
    )]
    pub fn withdraw_from_insurance_vault_to_market(
        ctx: Context<WithdrawFromInsuranceVaultToMarket>,
        market_index: u64,
        amount: u64,
    ) -> ProgramResult {
        let markets = &mut ctx.accounts.markets.load_mut()?;
        let market = &mut markets.markets[Markets::index_from_u64(market_index)];

        // The admin can move fees from the insurance fund back to the protocol so that money in
        // the insurance fund can be used to make market more optimal
        // 100% goes to user fee pool (symmetric funding, repeg, and k adjustments)
        market.amm.total_fee_minus_distributions = market
            .amm
            .total_fee_minus_distributions
            .checked_add(cast(amount)?)
            .ok_or_else(math_error!())?;

        controller::token::send(
            &ctx.accounts.token_program,
            &ctx.accounts.insurance_vault,
            &ctx.accounts.collateral_vault,
            &ctx.accounts.insurance_vault_authority,
            ctx.accounts.state.insurance_vault_nonce,
            amount,
        )?;
        Ok(())
    }

    #[allow(unused_must_use)]
    #[access_control(
        market_initialized(&ctx.accounts.markets, market_index) &&
        exchange_not_paused(&ctx.accounts.state) &&
        valid_oracle_for_market(&ctx.accounts.oracle, &ctx.accounts.markets, market_index)
    )]
    pub fn repeg_amm_curve(
        ctx: Context<RepegCurve>,
        new_peg_candidate: u128,
        market_index: u64,
    ) -> ProgramResult {
        let clock = Clock::get()?;
        let now = clock.unix_timestamp;
        let clock_slot = clock.slot;

        let market =
            &mut ctx.accounts.markets.load_mut()?.markets[Markets::index_from_u64(market_index)];
        let price_oracle = &ctx.accounts.oracle;
        let OraclePriceData {
            price: oracle_price,
            ..
        } = market.amm.get_oracle_price(price_oracle, 0)?;

        let peg_multiplier_before = market.amm.peg_multiplier;
        let base_asset_reserve_before = market.amm.base_asset_reserve;
        let quote_asset_reserve_before = market.amm.quote_asset_reserve;
        let sqrt_k_before = market.amm.sqrt_k;

        let oracle_validity_rails = &ctx.accounts.state.oracle_guard_rails;

        let adjustment_cost = controller::repeg::repeg(
            market,
            price_oracle,
            new_peg_candidate,
            clock_slot,
            oracle_validity_rails,
        )?;

        let peg_multiplier_after = market.amm.peg_multiplier;
        let base_asset_reserve_after = market.amm.base_asset_reserve;
        let quote_asset_reserve_after = market.amm.quote_asset_reserve;
        let sqrt_k_after = market.amm.sqrt_k;

        let curve_history = &mut ctx.accounts.curve_history.load_mut()?;
        let record_id = curve_history.next_record_id();
        curve_history.append(ExtendedCurveRecord {
            ts: now,
            record_id,
            market_index,
            peg_multiplier_before,
            base_asset_reserve_before,
            quote_asset_reserve_before,
            sqrt_k_before,
            peg_multiplier_after,
            base_asset_reserve_after,
            quote_asset_reserve_after,
            sqrt_k_after,
            base_asset_amount_long: market.base_asset_amount_long.unsigned_abs(),
            base_asset_amount_short: market.base_asset_amount_short.unsigned_abs(),
            base_asset_amount: market.base_asset_amount,
            open_interest: market.open_interest,
            total_fee: market.amm.total_fee,
            total_fee_minus_distributions: market.amm.total_fee_minus_distributions,
            adjustment_cost,
            oracle_price,
            trade_record: 0,
            padding: [0; 5],
        });

        Ok(())
    }

    #[allow(unused_must_use)]
    #[access_control(
        market_initialized(&ctx.accounts.markets, market_index) &&
        valid_oracle_for_market(&ctx.accounts.oracle, &ctx.accounts.markets, market_index)
     )]
    pub fn update_amm_oracle_twap(ctx: Context<RepegCurve>, market_index: u64) -> ProgramResult {
        // allow update to amm's oracle twap iff price gap is reduced and thus more tame funding
        // otherwise if oracle error or funding flip: set oracle twap to mark twap (0 gap)

        let clock = Clock::get()?;
        let now = clock.unix_timestamp;
        let clock_slot = clock.slot;

        let market =
            &mut ctx.accounts.markets.load_mut()?.markets[Markets::index_from_u64(market_index)];
        let price_oracle = &ctx.accounts.oracle;
        let oracle_price_data = &market.amm.get_oracle_price(price_oracle, clock_slot)?;
        let oracle_twap = oracle_price_data.twap;

        let is_oracle_valid = amm::is_oracle_valid(
            oracle_price_data,
            &ctx.accounts.state.oracle_guard_rails.validity,
        )?;

        if is_oracle_valid {
            let oracle_mark_gap_before = cast_to_i128(market.amm.last_mark_price_twap)?
                .checked_sub(market.amm.last_oracle_price_twap)
                .ok_or_else(math_error!())?;

            let oracle_mark_gap_after = cast_to_i128(market.amm.last_mark_price_twap)?
                .checked_sub(oracle_twap)
                .ok_or_else(math_error!())?;

            if (oracle_mark_gap_after > 0 && oracle_mark_gap_before < 0)
                || (oracle_mark_gap_after < 0 && oracle_mark_gap_before > 0)
            {
                market.amm.last_oracle_price_twap = cast_to_i128(market.amm.last_mark_price_twap)?;
                market.amm.last_oracle_price_twap_ts = now;
            } else if oracle_mark_gap_after.unsigned_abs() <= oracle_mark_gap_before.unsigned_abs()
            {
                market.amm.last_oracle_price_twap = oracle_twap;
                market.amm.last_oracle_price_twap_ts = now;
            } else {
                return Err(ErrorCode::OracleMarkSpreadLimit.into());
            }
        } else {
            return Err(ErrorCode::InvalidOracle.into());
        }

        Ok(())
    }

    #[allow(unused_must_use)]
    #[access_control(
        market_initialized(&ctx.accounts.markets, market_index) &&
        valid_oracle_for_market(&ctx.accounts.oracle, &ctx.accounts.markets, market_index)
     )]
    pub fn reset_amm_oracle_twap(ctx: Context<RepegCurve>, market_index: u64) -> ProgramResult {
        // if oracle is invalid, failsafe to reset amm oracle_twap to the mark_twap

        let clock = Clock::get()?;
        let now = clock.unix_timestamp;
        let clock_slot = clock.slot;

        let market =
            &mut ctx.accounts.markets.load_mut()?.markets[Markets::index_from_u64(market_index)];
        let price_oracle = &ctx.accounts.oracle;
        let oracle_price_data = &market.amm.get_oracle_price(price_oracle, clock_slot)?;

        let is_oracle_valid = amm::is_oracle_valid(
            oracle_price_data,
            &ctx.accounts.state.oracle_guard_rails.validity,
        )?;

        if !is_oracle_valid {
            market.amm.last_oracle_price_twap = cast_to_i128(market.amm.last_mark_price_twap)?;
            market.amm.last_oracle_price_twap_ts = now;
        }

        Ok(())
    }

    pub fn initialize_user(
        ctx: Context<InitializeUser>,
        _user_nonce: u8,
        optional_accounts: InitializeUserOptionalAccounts,
    ) -> ProgramResult {
        user_initialization::initialize(
            &ctx.accounts.state,
            &mut ctx.accounts.user,
            &ctx.accounts.user_positions,
            &ctx.accounts.authority,
            ctx.remaining_accounts,
            optional_accounts,
        )
    }

    pub fn initialize_user_with_explicit_payer(
        ctx: Context<InitializeUserWithExplicitPayer>,
        _user_nonce: u8,
        optional_accounts: InitializeUserOptionalAccounts,
    ) -> ProgramResult {
        user_initialization::initialize(
            &ctx.accounts.state,
            &mut ctx.accounts.user,
            &ctx.accounts.user_positions,
            &ctx.accounts.authority,
            ctx.remaining_accounts,
            optional_accounts,
        )
    }

    pub fn initialize_user_orders(
        ctx: Context<InitializeUserOrders>,
        _user_orders_nonce: u8,
    ) -> ProgramResult {
        let orders = &mut ctx.accounts.user_orders.load_init()?;
        orders.user = ctx.accounts.user.key();
        Ok(())
    }

    pub fn initialize_user_orders_with_explicit_payer(
        ctx: Context<InitializeUserOrdersWithExplicitPayer>,
        _user_orders_nonce: u8,
    ) -> ProgramResult {
        let orders = &mut ctx.accounts.user_orders.load_init()?;
        orders.user = ctx.accounts.user.key();
        Ok(())
    }

    pub fn delete_user(ctx: Context<DeleteUser>) -> ProgramResult {
        let user = &ctx.accounts.user;

        // Block the delete if the user still has collateral
        if user.collateral > 0 {
            return Err(ErrorCode::CantDeleteUserWithCollateral.into());
        }

        Ok(())
    }

    #[access_control(
        exchange_not_paused(&ctx.accounts.state)
    )]
    pub fn settle_funding_payment(ctx: Context<SettleFunding>) -> ProgramResult {
        let clock = Clock::get()?;
        let now = clock.unix_timestamp;
        controller::funding::settle_funding_payment(
            &mut ctx.accounts.user,
            &mut ctx.accounts.user_positions.load_mut()?,
            &ctx.accounts.markets.load()?,
            &mut ctx.accounts.funding_payment_history.load_mut()?,
            now,
        )?;
        Ok(())
    }

    #[allow(unused_must_use)]
    #[access_control(
        market_initialized(&ctx.accounts.markets, market_index) &&
        exchange_not_paused(&ctx.accounts.state) &&
        valid_oracle_for_market(&ctx.accounts.oracle, &ctx.accounts.markets, market_index)
    )]
    pub fn update_funding_rate(
        ctx: Context<UpdateFundingRate>,
        market_index: u64,
    ) -> ProgramResult {
        let market =
            &mut ctx.accounts.markets.load_mut()?.markets[Markets::index_from_u64(market_index)];
        let price_oracle = &ctx.accounts.oracle;
        let clock = Clock::get()?;
        let now = clock.unix_timestamp;
        let clock_slot = clock.slot;

        let funding_rate_history = &mut ctx.accounts.funding_rate_history.load_mut()?;
        controller::funding::update_funding_rate(
            market_index,
            market,
            price_oracle,
            now,
            clock_slot,
            funding_rate_history,
            &ctx.accounts.state.oracle_guard_rails,
            ctx.accounts.state.funding_paused,
            None,
        )?;

        Ok(())
    }

    #[allow(unused_must_use)]
    #[access_control(
        market_initialized(&ctx.accounts.markets, market_index) &&
        valid_oracle_for_market(&ctx.accounts.oracle, &ctx.accounts.markets, market_index) &&
        exchange_not_paused(&ctx.accounts.state)
    )]
    pub fn update_k(ctx: Context<AdminUpdateK>, sqrt_k: u128, market_index: u64) -> ProgramResult {
        let clock = Clock::get()?;
        let now = clock.unix_timestamp;

        let markets = &mut ctx.accounts.markets.load_mut()?;
        let market = &mut markets.markets[Markets::index_from_u64(market_index)];

        let base_asset_amount_long = market.base_asset_amount_long.unsigned_abs();
        let base_asset_amount_short = market.base_asset_amount_short.unsigned_abs();
        let base_asset_amount = market.base_asset_amount;
        let open_interest = market.open_interest;

        let price_before = math::amm::calculate_price(
            market.amm.quote_asset_reserve,
            market.amm.base_asset_reserve,
            market.amm.peg_multiplier,
        )?;

        let peg_multiplier_before = market.amm.peg_multiplier;
        let base_asset_reserve_before = market.amm.base_asset_reserve;
        let quote_asset_reserve_before = market.amm.quote_asset_reserve;
        let sqrt_k_before = market.amm.sqrt_k;

        let adjustment_cost = math::amm::adjust_k_cost(market, bn::U256::from(sqrt_k))?;

        if adjustment_cost > 0 {
            let max_cost = market
                .amm
                .total_fee_minus_distributions
                .checked_sub(market.amm.total_fee_withdrawn)
                .ok_or_else(math_error!())?;
            if adjustment_cost.unsigned_abs() > max_cost {
                return Err(ErrorCode::InvalidUpdateK.into());
            } else {
                market.amm.total_fee_minus_distributions = market
                    .amm
                    .total_fee_minus_distributions
                    .checked_sub(adjustment_cost.unsigned_abs())
                    .ok_or_else(math_error!())?;
            }
        } else {
            market.amm.total_fee_minus_distributions = market
                .amm
                .total_fee_minus_distributions
                .checked_add(adjustment_cost.unsigned_abs())
                .ok_or_else(math_error!())?;
        }

        let amm = &market.amm;

        let price_after = math::amm::calculate_price(
            amm.quote_asset_reserve,
            amm.base_asset_reserve,
            amm.peg_multiplier,
        )?;

        let price_change_too_large = cast_to_i128(price_before)?
            .checked_sub(cast_to_i128(price_after)?)
            .ok_or_else(math_error!())?
            .unsigned_abs()
            .gt(&UPDATE_K_ALLOWED_PRICE_CHANGE);

        if price_change_too_large {
            return Err(ErrorCode::InvalidUpdateK.into());
        }

        let peg_multiplier_after = amm.peg_multiplier;
        let base_asset_reserve_after = amm.base_asset_reserve;
        let quote_asset_reserve_after = amm.quote_asset_reserve;
        let sqrt_k_after = amm.sqrt_k;

        let total_fee = amm.total_fee;
        let total_fee_minus_distributions = amm.total_fee_minus_distributions;

        let OraclePriceData {
            price: oracle_price,
            ..
        } = amm.get_oracle_price(&ctx.accounts.oracle, 0)?;

        let curve_history = &mut ctx.accounts.curve_history.load_mut()?;
        let record_id = curve_history.next_record_id();
        curve_history.append(ExtendedCurveRecord {
            ts: now,
            record_id,
            market_index,
            peg_multiplier_before,
            base_asset_reserve_before,
            quote_asset_reserve_before,
            sqrt_k_before,
            peg_multiplier_after,
            base_asset_reserve_after,
            quote_asset_reserve_after,
            sqrt_k_after,
            base_asset_amount_long,
            base_asset_amount_short,
            base_asset_amount,
            open_interest,
            adjustment_cost,
            total_fee,
            total_fee_minus_distributions,
            oracle_price,
            trade_record: 0,
            padding: [0; 5],
        });

        Ok(())
    }

    pub fn update_curve_history(ctx: Context<UpdateCurveHistory>) -> ProgramResult {
        let curve_history = &ctx.accounts.curve_history.load()?;
        let extended_curve_history = &mut ctx.accounts.extended_curve_history.load_init()?;

        for old_record in curve_history.curve_records.iter() {
            if old_record.record_id != 0 {
                let new_record = ExtendedCurveRecord {
                    ts: old_record.ts,
                    record_id: old_record.record_id,
                    market_index: old_record.market_index,
                    peg_multiplier_before: old_record.peg_multiplier_before,
                    base_asset_reserve_before: old_record.base_asset_reserve_before,
                    quote_asset_reserve_before: old_record.quote_asset_reserve_before,
                    sqrt_k_before: old_record.sqrt_k_before,
                    peg_multiplier_after: old_record.peg_multiplier_after,
                    base_asset_reserve_after: old_record.base_asset_reserve_after,
                    quote_asset_reserve_after: old_record.quote_asset_reserve_after,
                    sqrt_k_after: old_record.sqrt_k_after,
                    base_asset_amount_long: old_record.base_asset_amount_long,
                    base_asset_amount_short: old_record.base_asset_amount_short,
                    base_asset_amount: old_record.base_asset_amount,
                    open_interest: old_record.open_interest,
                    total_fee: old_record.total_fee,
                    total_fee_minus_distributions: old_record.total_fee_minus_distributions,
                    adjustment_cost: old_record.adjustment_cost,
                    oracle_price: 0,
                    trade_record: 0,
                    padding: [0; 5],
                };
                extended_curve_history.append(new_record);
            }
        }

        let state = &mut ctx.accounts.state;
        state.extended_curve_history = ctx.accounts.extended_curve_history.key();
        Ok(())
    }

    #[access_control(
        market_initialized(&ctx.accounts.markets, market_index)
    )]
    pub fn update_margin_ratio(
        ctx: Context<AdminUpdateMarket>,
        market_index: u64,
        margin_ratio_initial: u32,
        margin_ratio_partial: u32,
        margin_ratio_maintenance: u32,
    ) -> ProgramResult {
        validate_margin(
            margin_ratio_initial,
            margin_ratio_partial,
            margin_ratio_maintenance,
        )?;

        let market =
            &mut ctx.accounts.markets.load_mut()?.markets[Markets::index_from_u64(market_index)];
        market.margin_ratio_initial = margin_ratio_initial;
        market.margin_ratio_partial = margin_ratio_partial;
        market.margin_ratio_maintenance = margin_ratio_maintenance;
        Ok(())
    }

    pub fn update_partial_liquidation_close_percentage(
        ctx: Context<AdminUpdateState>,
        numerator: u128,
        denominator: u128,
    ) -> ProgramResult {
        ctx.accounts
            .state
            .partial_liquidation_close_percentage_numerator = numerator;
        ctx.accounts
            .state
            .partial_liquidation_close_percentage_denominator = denominator;
        Ok(())
    }

    pub fn update_partial_liquidation_penalty_percentage(
        ctx: Context<AdminUpdateState>,
        numerator: u128,
        denominator: u128,
    ) -> ProgramResult {
        ctx.accounts
            .state
            .partial_liquidation_penalty_percentage_numerator = numerator;
        ctx.accounts
            .state
            .partial_liquidation_penalty_percentage_denominator = denominator;
        Ok(())
    }

    pub fn update_full_liquidation_penalty_percentage(
        ctx: Context<AdminUpdateState>,
        numerator: u128,
        denominator: u128,
    ) -> ProgramResult {
        ctx.accounts
            .state
            .full_liquidation_penalty_percentage_numerator = numerator;
        ctx.accounts
            .state
            .full_liquidation_penalty_percentage_denominator = denominator;
        Ok(())
    }

    pub fn update_partial_liquidation_liquidator_share_denominator(
        ctx: Context<AdminUpdateState>,
        denominator: u64,
    ) -> ProgramResult {
        ctx.accounts
            .state
            .partial_liquidation_liquidator_share_denominator = denominator;
        Ok(())
    }

    pub fn update_full_liquidation_liquidator_share_denominator(
        ctx: Context<AdminUpdateState>,
        denominator: u64,
    ) -> ProgramResult {
        ctx.accounts
            .state
            .full_liquidation_liquidator_share_denominator = denominator;
        Ok(())
    }

    pub fn update_fee(ctx: Context<AdminUpdateState>, fees: FeeStructure) -> ProgramResult {
        ctx.accounts.state.fee_structure = fees;
        Ok(())
    }

    pub fn update_order_filler_reward_structure(
        ctx: Context<AdminUpdateOrderState>,
        order_filler_reward_structure: OrderFillerRewardStructure,
    ) -> ProgramResult {
        ctx.accounts.order_state.order_filler_reward_structure = order_filler_reward_structure;
        Ok(())
    }

    pub fn update_oracle_guard_rails(
        ctx: Context<AdminUpdateState>,
        oracle_guard_rails: OracleGuardRails,
    ) -> ProgramResult {
        ctx.accounts.state.oracle_guard_rails = oracle_guard_rails;
        Ok(())
    }

    #[access_control(
        market_initialized(&ctx.accounts.markets, market_index)
    )]
    pub fn update_market_oracle(
        ctx: Context<AdminUpdateMarket>,
        market_index: u64,
        oracle: Pubkey,
        oracle_source: OracleSource,
    ) -> ProgramResult {
        let market =
            &mut ctx.accounts.markets.load_mut()?.markets[Markets::index_from_u64(market_index)];
        market.amm.oracle = oracle;
        market.amm.oracle_source = oracle_source;
        Ok(())
    }

    #[access_control(
        market_initialized(&ctx.accounts.markets, market_index)
    )]
    pub fn update_market_minimum_quote_asset_trade_size(
        ctx: Context<AdminUpdateMarket>,
        market_index: u64,
        minimum_trade_size: u128,
    ) -> ProgramResult {
        let market =
            &mut ctx.accounts.markets.load_mut()?.markets[Markets::index_from_u64(market_index)];
        market.amm.minimum_quote_asset_trade_size = minimum_trade_size;
        Ok(())
    }

    #[access_control(
        market_initialized(&ctx.accounts.markets, market_index)
    )]
    pub fn update_market_minimum_base_asset_trade_size(
        ctx: Context<AdminUpdateMarket>,
        market_index: u64,
        minimum_trade_size: u128,
    ) -> ProgramResult {
        let market =
            &mut ctx.accounts.markets.load_mut()?.markets[Markets::index_from_u64(market_index)];
        market.amm.minimum_base_asset_trade_size = minimum_trade_size;
        Ok(())
    }

    pub fn update_admin(ctx: Context<AdminUpdateState>, admin: Pubkey) -> ProgramResult {
        ctx.accounts.state.admin = admin;
        Ok(())
    }

    pub fn update_whitelist_mint(
        ctx: Context<AdminUpdateState>,
        whitelist_mint: Pubkey,
    ) -> ProgramResult {
        ctx.accounts.state.whitelist_mint = whitelist_mint;
        Ok(())
    }

    pub fn update_discount_mint(
        ctx: Context<AdminUpdateState>,
        discount_mint: Pubkey,
    ) -> ProgramResult {
        ctx.accounts.state.discount_mint = discount_mint;
        Ok(())
    }

    pub fn update_max_deposit(ctx: Context<AdminUpdateState>, max_deposit: u128) -> ProgramResult {
        ctx.accounts.state.max_deposit = max_deposit;
        Ok(())
    }

    pub fn update_exchange_paused(
        ctx: Context<AdminUpdateState>,
        exchange_paused: bool,
    ) -> ProgramResult {
        ctx.accounts.state.exchange_paused = exchange_paused;
        Ok(())
    }

    pub fn disable_admin_controls_prices(ctx: Context<AdminUpdateState>) -> ProgramResult {
        ctx.accounts.state.admin_controls_prices = false;
        Ok(())
    }

    pub fn update_funding_paused(
        ctx: Context<AdminUpdateState>,
        funding_paused: bool,
    ) -> ProgramResult {
        ctx.accounts.state.funding_paused = funding_paused;
        Ok(())
    }
}

fn market_initialized(markets: &AccountLoader<Markets>, market_index: u64) -> Result<()> {
    if !markets.load()?.markets[Markets::index_from_u64(market_index)].initialized {
        return Err(ErrorCode::MarketIndexNotInitialized.into());
    }
    Ok(())
}

fn valid_oracle_for_market(
    oracle: &AccountInfo,
    markets: &AccountLoader<Markets>,
    market_index: u64,
) -> Result<()> {
    if !markets.load()?.markets[Markets::index_from_u64(market_index)]
        .amm
        .oracle
        .eq(oracle.key)
    {
        return Err(ErrorCode::InvalidOracle.into());
    }
    Ok(())
}

fn exchange_not_paused(state: &Account<State>) -> Result<()> {
    if state.exchange_paused {
        return Err(ErrorCode::ExchangePaused.into());
    }
    Ok(())
}

fn admin_controls_prices(state: &Account<State>) -> Result<()> {
    if !state.admin_controls_prices {
        return Err(ErrorCode::AdminControlsPricesDisabled.into());
    }
    Ok(())
}
