use anchor_lang::prelude::*;
use borsh::{BorshDeserialize, BorshSerialize};

use context::*;
use controller::position::PositionDirection;
use error::*;
use math::{amm, bn, constants::*, fees, margin::*, position::*, withdrawal::*};
use state::{
    history::trade::TradeRecord,
    market::{Market, Markets, OracleSource, AMM},
    state::*,
    user::{MarketPosition, User},
};

pub mod context;
pub mod controller;
pub mod error;
pub mod math;
pub mod optional_accounts;
pub mod state;
mod user_initialization;

#[cfg(feature = "mainnet-beta")]
declare_id!("dammHkt7jmytvbS3nHTxQNEcP59aE57nxwV21YdqEDN");
#[cfg(not(feature = "mainnet-beta"))]
declare_id!("AsW7LnXB9UA1uec9wi9MctYTgTz7YH9snhxd16GsFaGX");

#[program]
pub mod clearing_house {
    use crate::math;
    use crate::state::history::curve::CurveRecord;
    use crate::state::history::deposit::{DepositDirection, DepositRecord};
    use crate::state::history::liquidation::LiquidationRecord;

    use super::*;
    use crate::math::casting::{cast, cast_to_i128, cast_to_u128};

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
            padding0: 0,
            padding1: 0,
            padding2: 0,
            padding3: 0,
            padding4: 0,
            padding5: 0,
            padding6: 0,
            padding7: 0,
        };

        return Ok(());
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
        let curve_history = ctx.accounts.curve_history.to_account_info().key;

        state.deposit_history = *deposit_history;
        state.trade_history = *trade_history;
        state.funding_rate_history = *funding_rate_history;
        state.funding_payment_history = *funding_payment_history;
        state.liquidation_history = *liquidation_history;
        state.curve_history = *curve_history;

        Ok(())
    }

    pub fn initialize_market(
        ctx: Context<InitializeMarket>,
        market_index: u64,
        amm_base_asset_reserve: u128,
        amm_quote_asset_reserve: u128,
        amm_periodicity: i64,
        amm_peg_multiplier: u128,
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
        let (_, oracle_price_twap, _, _, _) = market
            .amm
            .get_oracle_price(&ctx.accounts.oracle, clock_slot)
            .unwrap();

        let market = Market {
            initialized: true,
            base_asset_amount_long: 0,
            base_asset_amount_short: 0,
            base_asset_amount: 0,
            open_interest: 0,
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
                minimum_trade_size: 10000000,
                last_oracle_price_twap_ts: now,
                padding0: 0,
                padding1: 0,
                padding2: 0,
                padding3: 0,
                padding4: 0,
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

        // Verify that the user doesn't enter liquidation territory if they withdraw
        let (_total_collateral, _unrealized_pnl, _base_asset_value, margin_ratio) =
            calculate_margin_ratio(user, user_positions, markets)?;
        if margin_ratio < ctx.accounts.state.margin_ratio_initial {
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

        // Check if the user has an existing position for the market
        let mut market_position = user_positions
            .positions
            .iter_mut()
            .find(|market_position| market_position.is_for(market_index));

        // If they don't have an existing position, look into the positions account for a spot for space
        // for a new position
        if market_position.is_none() {
            let available_position_index = user_positions
                .positions
                .iter()
                .position(|market_position| !market_position.is_open_position());

            if available_position_index.is_none() {
                return Err(ErrorCode::MaxNumberOfPositions.into());
            }

            let new_market_position = MarketPosition {
                market_index,
                base_asset_amount: 0,
                quote_asset_amount: 0,
                last_cumulative_funding_rate: 0,
                last_cumulative_repeg_rebate: 0,
                last_funding_rate_ts: 0,
                stop_profit_price: 0,
                stop_profit_amount: 0,
                stop_loss_price: 0,
                stop_loss_amount: 0,
                transfer_to: Pubkey::default(),
                padding0: 0,
                padding1: 0,
            };

            user_positions.positions[available_position_index.unwrap()] = new_market_position;

            market_position =
                Some(&mut user_positions.positions[available_position_index.unwrap()]);
        }

        let market_position = market_position.unwrap();

        // A trade is risk increasing if it increases the users leverage
        // If a trade is risk increasing and brings the user's margin ratio below initial requirement
        // the trade fails
        // If a trade is risk increasing and it pushes the mark price too far away from the oracle price
        // the trade fails
        let mut potentially_risk_increasing = true;

        // Collect data about position/market before trade is executed so that it can be stored in trade history
        let mark_price_before: u128;
        let oracle_mark_spread_pct_before: i128;
        let is_oracle_valid: bool;
        {
            let market = &mut ctx.accounts.markets.load_mut()?.markets
                [Markets::index_from_u64(market_index)];
            mark_price_before = market.amm.mark_price()?;
            let (oracle_price, _, _oracle_mark_spread_pct_before) =
                amm::calculate_oracle_mark_spread_pct(
                    &market.amm,
                    &ctx.accounts.oracle,
                    0,
                    clock_slot,
                    None,
                )?;
            oracle_mark_spread_pct_before = _oracle_mark_spread_pct_before;
            is_oracle_valid = amm::is_oracle_valid(
                &market.amm,
                &ctx.accounts.oracle,
                clock_slot,
                &ctx.accounts.state.oracle_guard_rails.validity,
            )?;

            if is_oracle_valid {
                amm::update_oracle_price_twap(&mut market.amm, now, oracle_price)?;
            }
        }

        let mut quote_asset_amount = quote_asset_amount;
        let base_asset_amount;
        // The trade increases the the user position if
        // 1) the user does not have a position
        // 2) the trade is in the same direction as the user's existing position
        let increase_position = market_position.base_asset_amount == 0
            || market_position.base_asset_amount > 0 && direction == PositionDirection::Long
            || market_position.base_asset_amount < 0 && direction == PositionDirection::Short;
        if increase_position {
            let market = &mut ctx.accounts.markets.load_mut()?.markets
                [Markets::index_from_u64(market_index)];

            base_asset_amount = controller::position::increase(
                direction,
                quote_asset_amount,
                market,
                market_position,
                now,
            )?
            .unsigned_abs();
        } else {
            let market = &mut ctx.accounts.markets.load_mut()?.markets
                [Markets::index_from_u64(market_index)];

            let (base_asset_value, _unrealized_pnl) =
                calculate_base_asset_value_and_pnl(market_position, &market.amm)?;

            // if the quote_asset_amount is close enough in value to base_asset_value,
            // round the quote_asset_amount to be the same as base_asset_value
            if amm::should_round_trade(&market.amm, quote_asset_amount, base_asset_value)? {
                quote_asset_amount = base_asset_value;
            }

            // we calculate what the user's position is worth if they closed to determine
            // if they are reducing or closing and reversing their position
            if base_asset_value > quote_asset_amount {
                base_asset_amount = controller::position::reduce(
                    direction,
                    quote_asset_amount,
                    user,
                    market,
                    market_position,
                    now,
                    None,
                )?
                .unsigned_abs();

                potentially_risk_increasing = false;
            } else {
                // after closing existing position, how large should trade be in opposite direction
                let quote_asset_amount_after_close = quote_asset_amount
                    .checked_sub(base_asset_value)
                    .ok_or_else(math_error!())?;

                // If the value of the new position is less than value of the old position, consider it risk decreasing
                if quote_asset_amount_after_close < base_asset_value {
                    potentially_risk_increasing = false;
                }

                let (_, base_asset_amount_closed) =
                    controller::position::close(user, market, market_position, now)?;
                let base_asset_amount_closed = base_asset_amount_closed.unsigned_abs();

                let base_asset_amount_opened = controller::position::increase(
                    direction,
                    quote_asset_amount_after_close,
                    market,
                    market_position,
                    now,
                )?
                .unsigned_abs();

                base_asset_amount = base_asset_amount_closed
                    .checked_add(base_asset_amount_opened)
                    .ok_or_else(math_error!())?;
            }
        }

        // Collect data about position/market after trade is executed so that it can be stored in trade history
        let mark_price_after: u128;
        let oracle_price_after: i128;
        let oracle_mark_spread_pct_after: i128;
        {
            let market = &mut ctx.accounts.markets.load_mut()?.markets
                [Markets::index_from_u64(market_index)];
            mark_price_after = market.amm.mark_price()?;
            let (_oracle_price_after, _oracle_mark_spread_after, _oracle_mark_spread_pct_after) =
                amm::calculate_oracle_mark_spread_pct(
                    &market.amm,
                    &ctx.accounts.oracle,
                    0,
                    clock_slot,
                    Some(mark_price_after),
                )?;
            oracle_price_after = _oracle_price_after;
            oracle_mark_spread_pct_after = _oracle_mark_spread_pct_after;
        }

        // Trade fails if it's risk increasing and it brings the user below the initial margin ratio level
        let (
            _total_collateral_after,
            _unrealized_pnl_after,
            _base_asset_value_after,
            margin_ratio_after,
        ) = calculate_margin_ratio(user, user_positions, &ctx.accounts.markets.load()?)?;
        if margin_ratio_after < ctx.accounts.state.margin_ratio_initial
            && potentially_risk_increasing
        {
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
            fees::calculate(
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
        if limit_price != 0 {
            let market =
                &ctx.accounts.markets.load()?.markets[Markets::index_from_u64(market_index)];

            let quote_asset_reserve_amount = math::quote_asset::asset_to_reserve_amount(
                quote_asset_amount,
                market.amm.peg_multiplier,
            )?;

            let entry_price = amm::calculate_price(
                quote_asset_reserve_amount,
                base_asset_amount,
                market.amm.peg_multiplier,
            )?;

            match direction {
                PositionDirection::Long => {
                    if entry_price > limit_price {
                        return Err(ErrorCode::SlippageOutsideLimit.into());
                    }
                }
                PositionDirection::Short => {
                    if entry_price < limit_price {
                        return Err(ErrorCode::SlippageOutsideLimit.into());
                    }
                }
            }
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
                &price_oracle,
                now,
                clock_slot,
                funding_rate_history,
                &ctx.accounts.state.oracle_guard_rails,
                ctx.accounts.state.funding_paused,
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

        // Try to find user's position for specified market. Return Err if there is none
        let market_position = user_positions
            .positions
            .iter_mut()
            .find(|market_position| market_position.is_for(market_index));
        if market_position.is_none() {
            return Err(ErrorCode::UserHasNoPositionInMarket.into());
        }
        let market_position = market_position.unwrap();

        let market =
            &mut ctx.accounts.markets.load_mut()?.markets[Markets::index_from_u64(market_index)];

        // Collect data about market before trade is executed so that it can be stored in trade history
        let mark_price_before = market.amm.mark_price()?;
        let (oracle_price, _, oracle_mark_spread_pct_before) =
            amm::calculate_oracle_mark_spread_pct(
                &market.amm,
                &ctx.accounts.oracle,
                0,
                clock_slot,
                Some(mark_price_before),
            )?;
        let direction_to_close =
            math::position::direction_to_close_position(market_position.base_asset_amount);
        let (quote_asset_amount, base_asset_amount) =
            controller::position::close(user, market, market_position, now)?;
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
            fees::calculate(
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

        let (oracle_price_after, _oracle_mark_spread_after, oracle_mark_spread_pct_after) =
            amm::calculate_oracle_mark_spread_pct(
                &market.amm,
                &ctx.accounts.oracle,
                0,
                clock_slot,
                Some(mark_price_after),
            )?;

        let is_oracle_valid = amm::is_oracle_valid(
            &market.amm,
            &ctx.accounts.oracle,
            clock_slot,
            &ctx.accounts.state.oracle_guard_rails.validity,
        )?;
        if is_oracle_valid {
            amm::update_oracle_price_twap(&mut market.amm, now, oracle_price_after)?;
        }

        // Trade fails if the trade is risk increasing and it pushes to mark price too far
        // away from the oracle price
        let is_oracle_mark_too_divergent_before = amm::is_oracle_mark_too_divergent(
            oracle_mark_spread_pct_after,
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
            &price_oracle,
            now,
            clock_slot,
            funding_rate_history,
            &ctx.accounts.state.oracle_guard_rails,
            ctx.accounts.state.funding_paused,
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

        // Verify that the user is in liquidation territory
        let collateral = user.collateral;
        let (total_collateral, unrealized_pnl, base_asset_value, margin_ratio) =
            calculate_margin_ratio(user, user_positions, &ctx.accounts.markets.load()?)?;
        if margin_ratio > ctx.accounts.state.margin_ratio_partial {
            return Err(ErrorCode::SufficientCollateral.into());
        }

        // Keep track to the value of positions closed. For full liquidation this is the user's entire position,
        // for partial it is less (it's based on the clearing house state)
        let mut base_asset_value_closed: u128 = 0;
        let is_full_liquidation = margin_ratio <= ctx.accounts.state.margin_ratio_maintenance;
        if is_full_liquidation {
            let markets = &mut ctx.accounts.markets.load_mut()?;
            for market_position in user_positions.positions.iter_mut() {
                if market_position.base_asset_amount == 0 {
                    continue;
                }

                let market =
                    &mut markets.markets[Markets::index_from_u64(market_position.market_index)];

                // Block the liquidation if the oracle is invalid or the oracle and mark are too divergent
                let oracle_account_info = ctx
                    .remaining_accounts
                    .iter()
                    .find(|account_info| account_info.key.eq(&market.amm.oracle))
                    .ok_or(ErrorCode::OracleNotFound)?;
                let (liquidations_blocked, oracle_price) = math::oracle::block_operation(
                    &market.amm,
                    &oracle_account_info,
                    clock_slot,
                    &state.oracle_guard_rails,
                    None,
                )?;
                if liquidations_blocked {
                    return Err(ErrorCode::LiquidationsBlockedByOracle.into());
                }

                let direction_to_close =
                    math::position::direction_to_close_position(market_position.base_asset_amount);

                let mark_price_before = market.amm.mark_price()?;
                let (base_asset_value, base_asset_amount) =
                    controller::position::close(user, market, market_position, now)?;
                let base_asset_amount = base_asset_amount.unsigned_abs();
                base_asset_value_closed += base_asset_value;
                let mark_price_after = market.amm.mark_price()?;

                let record_id = trade_history.next_record_id();
                trade_history.append(TradeRecord {
                    ts: now,
                    record_id,
                    user_authority: user.authority,
                    user: *user.to_account_info().key,
                    direction: direction_to_close,
                    base_asset_amount,
                    quote_asset_amount: base_asset_value,
                    mark_price_before,
                    mark_price_after,
                    fee: 0,
                    token_discount: 0,
                    referrer_reward: 0,
                    referee_discount: 0,
                    liquidation: true,
                    market_index: market_position.market_index,
                    oracle_price,
                });
            }
        } else {
            let markets = &mut ctx.accounts.markets.load_mut()?;
            for market_position in user_positions.positions.iter_mut() {
                if market_position.base_asset_amount == 0 {
                    continue;
                }

                let market =
                    &mut markets.markets[Markets::index_from_u64(market_position.market_index)];

                let mark_price_before = market.amm.mark_price()?;

                let oracle_account_info = ctx
                    .remaining_accounts
                    .iter()
                    .find(|account_info| account_info.key.eq(&market.amm.oracle))
                    .ok_or(ErrorCode::OracleNotFound)?;
                let (liquidations_blocked, oracle_price) = math::oracle::block_operation(
                    &market.amm,
                    &oracle_account_info,
                    clock_slot,
                    &state.oracle_guard_rails,
                    Some(mark_price_before),
                )?;
                if liquidations_blocked {
                    return Err(ErrorCode::LiquidationsBlockedByOracle.into());
                }

                let (base_asset_value, _pnl) =
                    calculate_base_asset_value_and_pnl(market_position, &market.amm)?;

                let base_asset_value_to_close = base_asset_value
                    .checked_mul(state.partial_liquidation_close_percentage_numerator.into())
                    .ok_or_else(math_error!())?
                    .checked_div(
                        state
                            .partial_liquidation_close_percentage_denominator
                            .into(),
                    )
                    .ok_or_else(math_error!())?;
                base_asset_value_closed += base_asset_value_to_close;

                let direction_to_reduce =
                    math::position::direction_to_close_position(market_position.base_asset_amount);

                let base_asset_amount_change = controller::position::reduce(
                    direction_to_reduce,
                    base_asset_value_to_close,
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
                    base_asset_amount: base_asset_amount_change,
                    quote_asset_amount: base_asset_value_to_close,
                    mark_price_before,
                    mark_price_after,
                    fee: 0,
                    token_discount: 0,
                    referrer_reward: 0,
                    referee_discount: 0,
                    liquidation: true,
                    market_index: market_position.market_index,
                    oracle_price,
                });
            }
        }

        let liquidation_fee = if is_full_liquidation {
            user.collateral
                .checked_mul(state.full_liquidation_penalty_percentage_numerator.into())
                .ok_or_else(math_error!())?
                .checked_div(state.full_liquidation_penalty_percentage_denominator.into())
                .ok_or_else(math_error!())?
        } else {
            total_collateral
                .checked_mul(
                    state
                        .partial_liquidation_penalty_percentage_numerator
                        .into(),
                )
                .ok_or_else(math_error!())?
                .checked_div(
                    state
                        .partial_liquidation_penalty_percentage_denominator
                        .into(),
                )
                .ok_or_else(math_error!())?
        };

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
        curve_history.append(CurveRecord {
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
            adjustment_cost: adjustment_cost,
        });

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
        )?;

        Ok(())
    }

    #[allow(unused_must_use)]
    #[access_control(
        market_initialized(&ctx.accounts.markets, market_index) &&
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

        let curve_history = &mut ctx.accounts.curve_history.load_mut()?;
        let record_id = curve_history.next_record_id();
        curve_history.append(CurveRecord {
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
        });

        Ok(())
    }

    pub fn update_margin_ratio(
        ctx: Context<AdminUpdateState>,
        margin_ratio_initial: u128,
        margin_ratio_partial: u128,
        margin_ratio_maintenance: u128,
    ) -> ProgramResult {
        ctx.accounts.state.margin_ratio_initial = margin_ratio_initial;
        ctx.accounts.state.margin_ratio_partial = margin_ratio_partial;
        ctx.accounts.state.margin_ratio_maintenance = margin_ratio_maintenance;
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
    pub fn update_market_minimum_trade_size(
        ctx: Context<AdminUpdateMarket>,
        market_index: u64,
        minimum_trade_size: u128,
    ) -> ProgramResult {
        let market =
            &mut ctx.accounts.markets.load_mut()?.markets[Markets::index_from_u64(market_index)];
        market.amm.minimum_trade_size = minimum_trade_size;
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

fn exchange_not_paused(state: &Box<Account<State>>) -> Result<()> {
    if state.exchange_paused {
        return Err(ErrorCode::ExchangePaused.into());
    }
    Ok(())
}

fn admin_controls_prices(state: &Box<Account<State>>) -> Result<()> {
    if !state.admin_controls_prices {
        return Err(ErrorCode::AdminControlsPricesDisabled.into());
    }
    Ok(())
}
