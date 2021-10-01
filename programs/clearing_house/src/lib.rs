use anchor_lang::prelude::*;
use borsh::{BorshDeserialize, BorshSerialize};

use controller::position::PositionDirection;
use error::*;
use instructions::*;
use math::{amm, bn, constants::*, fees, margin::*, position::*, withdrawal::*};
use state::{
    history::TradeRecord,
    market::{Market, Markets, OracleSource, AMM},
    state::State,
    user::{MarketPosition, User},
};

mod controller;
mod error;
mod instructions;
mod math;
mod state;
declare_id!("CBoHNBhdJ7dv5BCovoDBH7dH7qKfA595dpRhodugJbqx");

#[program]
pub mod clearing_house {
    use super::*;

    pub fn initialize(
        ctx: Context<Initialize>,
        _clearing_house_nonce: u8,
        admin_controls_prices: bool,
    ) -> ProgramResult {
        let collateral_account_key = ctx.accounts.collateral_vault.to_account_info().key;
        let (collateral_account_authority, collateral_account_nonce) =
            Pubkey::find_program_address(&[collateral_account_key.as_ref()], ctx.program_id);

        if ctx.accounts.collateral_vault.owner != collateral_account_authority {
            return Err(ErrorCode::InvalidCollateralAccountAuthority.into());
        }

        let insurance_account_key = ctx.accounts.insurance_vault.to_account_info().key;
        let (insurance_account_authority, insurance_account_nonce) =
            Pubkey::find_program_address(&[insurance_account_key.as_ref()], ctx.program_id);

        if ctx.accounts.insurance_vault.owner != insurance_account_authority {
            return Err(ErrorCode::InvalidInsuranceAccountAuthority.into());
        }

        ctx.accounts.markets.load_init()?;
        ctx.accounts.funding_payment_history.load_init()?;
        ctx.accounts.trade_history.load_init()?;

        **ctx.accounts.state = State {
            admin: *ctx.accounts.admin.key,
            admin_controls_prices,
            collateral_vault: *collateral_account_key,
            collateral_vault_authority: collateral_account_authority,
            collateral_vault_nonce: collateral_account_nonce,
            funding_payment_history: *ctx.accounts.funding_payment_history.to_account_info().key,
            insurance_vault: *insurance_account_key,
            insurance_vault_authority: insurance_account_authority,
            insurance_vault_nonce: insurance_account_nonce,
            markets: *ctx.accounts.markets.to_account_info().key,
            margin_ratio_initial: 950, // unit is 9.5% (+2 decimal places)
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
            fee_numerator: DEFAULT_FEE_NUMERATOR,
            fee_denominator: DEFAULT_FEE_DENOMINATOR,
            trade_history: *ctx.accounts.trade_history.to_account_info().key,
            collateral_deposits: 0,
        };

        return Ok(());
    }

    pub fn initialize_market(
        ctx: Context<InitializeMarket>,
        market_index: u64,
        amm_base_asset_amount: u128,
        amm_quote_asset_amount: u128,
        amm_periodicity: i64,
        amm_peg_multiplier: u128,
    ) -> ProgramResult {
        let markets = &mut ctx.accounts.markets.load_mut().unwrap();
        let market = &markets.markets[Markets::index_from_u64(market_index)];
        let clock = Clock::get().unwrap();
        let now = clock.unix_timestamp;

        if market.initialized {
            return Err(ErrorCode::MarketIndexAlreadyInitialized.into());
        }

        if amm_base_asset_amount != amm_quote_asset_amount {
            return Err(ErrorCode::InvalidInitialPeg.into());
        }

        let init_mark_price = amm::calculate_base_asset_price_with_mantissa(
            amm_quote_asset_amount,
            amm_base_asset_amount,
            amm_peg_multiplier,
        );

        // Verify there's no overflow
        let _k = bn::U256::from(amm_base_asset_amount)
            .checked_mul(bn::U256::from(amm_quote_asset_amount))
            .unwrap();

        let market = Market {
            initialized: true,
            base_asset_amount_long: 0,
            base_asset_amount_short: 0,
            base_asset_amount: 0,
            open_interest: 0,
            amm: AMM {
                oracle: *ctx.accounts.oracle.key,
                oracle_source: OracleSource::Pyth,
                base_asset_reserve: amm_base_asset_amount,
                quote_asset_reserve: amm_quote_asset_amount,
                cumulative_funding_rate: 0,
                cumulative_repeg_rebate_long: 0,
                cumulative_repeg_rebate_short: 0,
                cumulative_funding_rate_long: 0,
                cumulative_funding_rate_short: 0,
                last_funding_rate: 0,
                last_funding_rate_ts: now,
                funding_period: amm_periodicity,
                last_mark_price_twap: init_mark_price,
                last_mark_price_twap_ts: now,
                sqrt_k: amm_base_asset_amount,
                peg_multiplier: amm_peg_multiplier,
                cumulative_fee: 0,
                cumulative_fee_realized: 0,
            },
        };

        markets.markets[Markets::index_from_u64(market_index)] = market;

        Ok(())
    }

    pub fn deposit_collateral(ctx: Context<DepositCollateral>, amount: u64) -> ProgramResult {
        if amount == 0 {
            return Err(ErrorCode::InsufficientDeposit.into());
        }

        let user = &mut ctx.accounts.user;
        user.collateral = user.collateral.checked_add(amount as u128).unwrap();
        user.cumulative_deposits = user
            .cumulative_deposits
            .checked_add(amount as i128)
            .unwrap();

        let markets = &ctx.accounts.markets.load().unwrap();
        let user_positions = &mut ctx.accounts.user_positions.load_mut().unwrap();
        let funding_payment_history = &mut ctx.accounts.funding_payment_history.load_mut().unwrap();
        controller::funding::settle_funding_payment(
            user,
            user_positions,
            markets,
            funding_payment_history,
        );

        controller::token::receive(
            &ctx.accounts.token_program,
            &ctx.accounts.user_collateral_account,
            &ctx.accounts.collateral_vault,
            &ctx.accounts.authority,
            amount,
        );

        ctx.accounts.state.collateral_deposits = ctx
            .accounts
            .state
            .collateral_deposits
            .checked_add(amount as u128)
            .unwrap();

        Ok(())
    }

    pub fn withdraw_collateral(ctx: Context<WithdrawCollateral>, amount: u64) -> ProgramResult {
        let user = &mut ctx.accounts.user;

        let markets = &ctx.accounts.markets.load().unwrap();
        let user_positions = &mut ctx.accounts.user_positions.load_mut().unwrap();
        let funding_payment_history = &mut ctx.accounts.funding_payment_history.load_mut().unwrap();
        controller::funding::settle_funding_payment(
            user,
            user_positions,
            markets,
            funding_payment_history,
        );

        if (amount as u128) > user.collateral {
            return Err(ErrorCode::InsufficientCollateral.into());
        }

        let (collateral_account_withdrawal, insurance_account_withdrawal) =
            calculate_withdrawal_amounts(
                amount,
                &ctx.accounts.collateral_vault,
                &ctx.accounts.insurance_vault,
            );

        user.collateral = user
            .collateral
            .checked_sub(collateral_account_withdrawal as u128)
            .unwrap()
            .checked_sub(insurance_account_withdrawal as u128)
            .unwrap();

        let (_estimated_margin, _estimated_base_asset_value, margin_ratio) =
            calculate_margin_ratio(user, user_positions, markets);
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
        );

        ctx.accounts.state.collateral_deposits = ctx
            .accounts
            .state
            .collateral_deposits
            .checked_sub(collateral_account_withdrawal as u128)
            .unwrap();

        if insurance_account_withdrawal > 0 {
            controller::token::send(
                &ctx.accounts.token_program,
                &ctx.accounts.insurance_vault,
                &ctx.accounts.user_collateral_account,
                &ctx.accounts.insurance_vault_authority,
                ctx.accounts.state.insurance_vault_nonce,
                insurance_account_withdrawal,
            );
        }
        Ok(())
    }

    #[access_control(
        market_initialized(&ctx.accounts.markets, market_index)
    )]
    pub fn open_position<'info>(
        ctx: Context<OpenPosition>,
        direction: PositionDirection,
        quote_asset_amount: u128,
        market_index: u64,
        limit_price: u128,
    ) -> ProgramResult {
        let user = &mut ctx.accounts.user;
        let clock = Clock::get().unwrap();
        let now = clock.unix_timestamp;

        let user_positions = &mut ctx.accounts.user_positions.load_mut().unwrap();
        let funding_payment_history = &mut ctx.accounts.funding_payment_history.load_mut().unwrap();
        controller::funding::settle_funding_payment(
            user,
            user_positions,
            &ctx.accounts.markets.load().unwrap(),
            funding_payment_history,
        );

        let mut market_position = user_positions
            .positions
            .iter_mut()
            .find(|market_position| market_position.market_index == market_index);

        if market_position.is_none() {
            let available_position_index = user_positions
                .positions
                .iter()
                .position(|market_position| market_position.base_asset_amount == 0);

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
            };

            user_positions.positions[available_position_index.unwrap()] = new_market_position;

            market_position =
                Some(&mut user_positions.positions[available_position_index.unwrap()]);
        }

        let market_position = market_position.unwrap();
        let base_asset_amount_before = market_position.base_asset_amount;
        let base_asset_price_with_mantissa_before: u128;
        {
            let market = &mut ctx.accounts.markets.load_mut()?.markets
                [Markets::index_from_u64(market_index)];
            base_asset_price_with_mantissa_before = market.amm.base_asset_price_with_mantissa();
        }
        let mut potentially_risk_increasing = true;

        if market_position.base_asset_amount == 0
            || market_position.base_asset_amount > 0 && direction == PositionDirection::Long
            || market_position.base_asset_amount < 0 && direction == PositionDirection::Short
        {
            let market = &mut ctx.accounts.markets.load_mut()?.markets
                [Markets::index_from_u64(market_index)];

            let trade_size_too_small = controller::position::increase(
                direction,
                quote_asset_amount,
                market,
                market_position,
                now,
            );

            if trade_size_too_small {
                return Err(ErrorCode::TradeSizeTooSmall.into());
            }
        } else {
            let market = &mut ctx.accounts.markets.load_mut()?.markets
                [Markets::index_from_u64(market_index)];

            let (base_asset_value, _unrealized_pnl) =
                calculate_base_asset_value_and_pnl(market_position, &market.amm);
            // we calculate what the user's position is worth if they closed to determine
            // if they are reducing or closing and reversing their position
            if base_asset_value > quote_asset_amount {
                let trade_size_too_small = controller::position::reduce(
                    direction,
                    quote_asset_amount,
                    user,
                    market,
                    market_position,
                    now,
                );

                if trade_size_too_small {
                    return Err(ErrorCode::TradeSizeTooSmall.into());
                }

                potentially_risk_increasing = false;
            } else {
                let incremental_quote_asset_notional_amount_resid =
                    quote_asset_amount.checked_sub(base_asset_value).unwrap();

                if incremental_quote_asset_notional_amount_resid < base_asset_value {
                    potentially_risk_increasing = false; //todo
                }

                controller::position::close(user, market, market_position, now);

                let trade_size_too_small = controller::position::increase(
                    direction,
                    incremental_quote_asset_notional_amount_resid,
                    market,
                    market_position,
                    now,
                );

                if trade_size_too_small {
                    return Err(ErrorCode::TradeSizeTooSmall.into());
                }
            }
        }

        let base_asset_amount_change = market_position
            .base_asset_amount
            .checked_sub(base_asset_amount_before)
            .unwrap()
            .unsigned_abs();
        let base_asset_price_with_mantissa_after: u128;
        {
            let market = &mut ctx.accounts.markets.load_mut()?.markets
                [Markets::index_from_u64(market_index)];
            base_asset_price_with_mantissa_after = market.amm.base_asset_price_with_mantissa();
        }

        let fee = fees::calculate(
            quote_asset_amount,
            ctx.accounts.state.fee_numerator,
            ctx.accounts.state.fee_denominator,
        );
        {
            let market = &mut ctx.accounts.markets.load_mut()?.markets
                [Markets::index_from_u64(market_index)];
            market.amm.cumulative_fee = market.amm.cumulative_fee.checked_add(fee).unwrap();
            market.amm.cumulative_fee_realized =
                market.amm.cumulative_fee_realized.checked_add(fee).unwrap();
        }

        user.collateral = user.collateral.checked_sub(fee).unwrap();

        user.total_fee_paid = user.total_fee_paid.checked_add(fee).unwrap();

        let (_estimated_margin_after, _estimated_base_asset_value_after, margin_ratio_after) =
            calculate_margin_ratio(user, user_positions, &ctx.accounts.markets.load().unwrap());
        if margin_ratio_after < ctx.accounts.state.margin_ratio_initial
            && potentially_risk_increasing
        {
            return Err(ErrorCode::InsufficientCollateral.into());
        }

        let trade_history_account = &mut ctx.accounts.trade_history.load_mut()?;
        let record_id = trade_history_account.next_record_id();
        trade_history_account.append(TradeRecord {
            ts: now,
            record_id,
            user_authority: *ctx.accounts.authority.to_account_info().key,
            user: *user.to_account_info().key,
            direction,
            base_asset_amount: base_asset_amount_change,
            quote_asset_amount,
            mark_price_before: base_asset_price_with_mantissa_before,
            mark_price_after: base_asset_price_with_mantissa_after,
            fee,
            market_index,
        });

        if limit_price != 0 {
            let market = &ctx.accounts.markets.load().unwrap().markets
                [Markets::index_from_u64(market_index)];

            let unpegged_quote_asset_amount = quote_asset_amount
                .checked_mul(MARK_PRICE_MANTISSA)
                .unwrap()
                .checked_div(market.amm.peg_multiplier)
                .unwrap();

            let entry_price = amm::calculate_base_asset_price_with_mantissa(
                unpegged_quote_asset_amount,
                base_asset_amount_change,
                market.amm.peg_multiplier,
            );

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

        Ok(())
    }

    #[access_control(
        market_initialized(&ctx.accounts.markets, market_index)
    )]
    pub fn close_position(ctx: Context<ClosePosition>, market_index: u64) -> ProgramResult {
        let user = &mut ctx.accounts.user;
        let clock = Clock::get().unwrap();
        let now = clock.unix_timestamp;

        let user_positions = &mut ctx.accounts.user_positions.load_mut().unwrap();
        let funding_payment_history = &mut ctx.accounts.funding_payment_history.load_mut().unwrap();
        controller::funding::settle_funding_payment(
            user,
            user_positions,
            &ctx.accounts.markets.load().unwrap(),
            funding_payment_history,
        );

        let market_position = user_positions
            .positions
            .iter_mut()
            .find(|market_position| market_position.market_index == market_index);

        if market_position.is_none() {
            return Err(ErrorCode::UserHasNoPositionInMarket.into());
        }
        let market_position = market_position.unwrap();

        let market = &mut ctx.accounts.markets.load_mut().unwrap().markets
            [Markets::index_from_u64(market_index)];

        // base_asset_value is the base_asset_amount priced in quote_asset, so we can use this
        // as quote_asset_notional_amount in trade history
        let (base_asset_value, _pnl) =
            calculate_base_asset_value_and_pnl(market_position, &market.amm);
        let trade_history_account = &mut ctx.accounts.trade_history_account.load_mut()?;
        let record_id = trade_history_account.next_record_id();
        let base_asset_price_with_mantissa_before = market.amm.base_asset_price_with_mantissa();
        let direction = if market_position.base_asset_amount > 0 {
            PositionDirection::Short
        } else {
            PositionDirection::Long
        };
        let base_asset_amount = market_position.base_asset_amount.unsigned_abs();
        controller::position::close(user, market, market_position, now);

        let fee = fees::calculate(
            base_asset_value,
            ctx.accounts.state.fee_numerator,
            ctx.accounts.state.fee_denominator,
        );
        market.amm.cumulative_fee = market.amm.cumulative_fee.checked_add(fee).unwrap();
        market.amm.cumulative_fee_realized =
            market.amm.cumulative_fee_realized.checked_add(fee).unwrap();

        user.collateral = user.collateral.checked_sub(fee).unwrap();

        user.total_fee_paid = user.total_fee_paid.checked_add(fee).unwrap();

        let base_asset_price_with_mantissa_after = market.amm.base_asset_price_with_mantissa();
        trade_history_account.append(TradeRecord {
            ts: now,
            record_id,
            user_authority: *ctx.accounts.authority.to_account_info().key,
            user: *user.to_account_info().key,
            direction,
            base_asset_amount,
            quote_asset_amount: base_asset_value,
            mark_price_before: base_asset_price_with_mantissa_before,
            mark_price_after: base_asset_price_with_mantissa_after,
            fee,
            market_index,
        });

        Ok(())
    }

    pub fn liquidate(ctx: Context<Liquidate>) -> ProgramResult {
        let state = &ctx.accounts.state;
        let user = &mut ctx.accounts.user;
        let clock = Clock::get().unwrap();
        let now = clock.unix_timestamp;

        let (_estimated_margin, _base_asset_notional, margin_ratio) = calculate_margin_ratio(
            user,
            &ctx.accounts.user_positions.load_mut().unwrap(),
            &ctx.accounts.markets.load().unwrap(),
        );
        if margin_ratio > ctx.accounts.state.margin_ratio_partial {
            return Err(ErrorCode::SufficientCollateral.into());
        }

        let user_positions = &mut ctx.accounts.user_positions.load_mut().unwrap();

        let mut is_full_liquidation = true;
        if margin_ratio <= ctx.accounts.state.margin_ratio_maintenance {
            let markets = &mut ctx.accounts.markets.load_mut().unwrap();
            for market_position in user_positions.positions.iter_mut() {
                if market_position.base_asset_amount == 0 {
                    continue;
                }

                let market =
                    &mut markets.markets[Markets::index_from_u64(market_position.market_index)];

                controller::position::close(user, market, market_position, now)
            }
        } else {
            let markets = &mut ctx.accounts.markets.load_mut().unwrap();
            for market_position in user_positions.positions.iter_mut() {
                if market_position.base_asset_amount == 0 {
                    continue;
                }

                let market =
                    &mut markets.markets[Markets::index_from_u64(market_position.market_index)];

                let (base_asset_value, _pnl) =
                    calculate_base_asset_value_and_pnl(market_position, &market.amm);
                let base_asset_value_to_close = base_asset_value
                    .checked_mul(state.partial_liquidation_close_percentage_numerator.into())
                    .unwrap()
                    .checked_div(
                        state
                            .partial_liquidation_close_percentage_denominator
                            .into(),
                    )
                    .unwrap();

                let direction = if market_position.base_asset_amount > 0 {
                    PositionDirection::Short
                } else {
                    PositionDirection::Long
                };

                controller::position::reduce(
                    direction,
                    base_asset_value_to_close,
                    user,
                    market,
                    market_position,
                    now,
                );
            }

            is_full_liquidation = false;
        }

        let liquidation_penalty = if is_full_liquidation {
            user.collateral
                .checked_mul(state.full_liquidation_penalty_percentage_numerator.into())
                .unwrap()
                .checked_div(state.full_liquidation_penalty_percentage_denominator.into())
                .unwrap()
        } else {
            let markets = &ctx.accounts.markets.load().unwrap();
            let (estimated_margin_after, _base_asset_notional_after, _margin_ratio_after) =
                calculate_margin_ratio(user, user_positions, markets);

            estimated_margin_after
                .checked_mul(
                    state
                        .partial_liquidation_penalty_percentage_numerator
                        .into(),
                )
                .unwrap()
                .checked_div(
                    state
                        .partial_liquidation_penalty_percentage_denominator
                        .into(),
                )
                .unwrap()
        };

        let (withdrawal_amount, _) = calculate_withdrawal_amounts(
            liquidation_penalty as u64,
            &ctx.accounts.collateral_vault,
            &ctx.accounts.insurance_vault,
        );

        user.collateral = user.collateral.checked_sub(liquidation_penalty).unwrap();

        let liquidator_cut_amount = if is_full_liquidation {
            withdrawal_amount
                .checked_div(state.full_liquidation_liquidator_share_denominator)
                .unwrap()
        } else {
            withdrawal_amount
                .checked_div(state.partial_liquidation_liquidator_share_denominator)
                .unwrap()
        };

        let insurance_fund_cut_amount = withdrawal_amount
            .checked_sub(liquidator_cut_amount)
            .unwrap();

        if liquidator_cut_amount > 0 {
            controller::token::send(
                &ctx.accounts.token_program,
                &ctx.accounts.collateral_vault,
                &ctx.accounts.liquidator_account,
                &ctx.accounts.collateral_vault_authority,
                ctx.accounts.state.collateral_vault_nonce,
                liquidator_cut_amount,
            );
        }

        if insurance_fund_cut_amount > 0 {
            controller::token::send(
                &ctx.accounts.token_program,
                &ctx.accounts.collateral_vault,
                &ctx.accounts.insurance_vault,
                &ctx.accounts.collateral_vault_authority,
                ctx.accounts.state.collateral_vault_nonce,
                insurance_fund_cut_amount,
            );
        }

        Ok(())
    }

    #[access_control(
        market_initialized(&ctx.accounts.markets, market_index)
    )]
    pub fn move_amm_price(
        ctx: Context<MoveAMMPrice>,
        base_asset_amount: u128,
        quote_asset_amount: u128,
        market_index: u64,
    ) -> ProgramResult {
        let markets = &mut ctx.accounts.markets.load_mut().unwrap();
        let market = &mut markets.markets[Markets::index_from_u64(market_index)];
        controller::amm::move_price(&mut market.amm, base_asset_amount, quote_asset_amount);
        Ok(())
    }

    #[access_control(
        market_initialized(&ctx.accounts.markets, market_index)
    )]
    pub fn admin_withdraw_collateral(
        ctx: Context<AdminWithdrawCollateral>,
        amount: u64,
        market_index: u64,
    ) -> ProgramResult {
        let markets = &mut ctx.accounts.markets.load_mut().unwrap();
        let market = &mut markets.markets[Markets::index_from_u64(market_index)];

        let max_withdraw = ctx
            .accounts
            .state
            .collateral_deposits
            .checked_sub(market.amm.cumulative_fee_realized)
            .unwrap();
        if amount <= max_withdraw as u64 {
            controller::token::send(
                &ctx.accounts.token_program,
                &ctx.accounts.collateral_vault,
                &ctx.accounts.insurance_vault,
                &ctx.accounts.collateral_vault_authority,
                ctx.accounts.state.collateral_vault_nonce,
                amount,
            );
        }

        Ok(())
    }

    #[access_control(
        market_initialized(&ctx.accounts.markets, market_index)
    )]
    pub fn repeg_amm_curve(
        ctx: Context<RepegCurve>,
        new_peg_candidate: u128,
        market_index: u64,
    ) -> ProgramResult {
        let market =
            &mut ctx.accounts.markets.load_mut()?.markets[Markets::index_from_u64(market_index)];
        let price_oracle = &ctx.accounts.oracle;

        return controller::repeg::repeg(market, price_oracle, new_peg_candidate);
    }

    pub fn initialize_user(ctx: Context<InitializeUser>, _user_nonce: u8) -> ProgramResult {
        let user = &mut ctx.accounts.user;
        user.authority = *ctx.accounts.authority.key;
        user.collateral = 0;
        user.cumulative_deposits = 0;
        user.positions = *ctx.accounts.user_positions.to_account_info().key;

        let user_positions = &mut ctx.accounts.user_positions.load_init()?;
        user_positions.user = *ctx.accounts.user.to_account_info().key;

        Ok(())
    }

    pub fn settle_funding_payment(ctx: Context<SettleFunding>) -> ProgramResult {
        controller::funding::settle_funding_payment(
            &mut ctx.accounts.user,
            &mut ctx.accounts.user_positions.load_mut().unwrap(),
            &ctx.accounts.markets.load().unwrap(),
            &mut ctx.accounts.funding_payment_history.load_mut().unwrap(),
        );
        Ok(())
    }

    #[access_control(
        market_initialized(&ctx.accounts.markets, market_index)
    )]
    pub fn update_funding_rate(
        ctx: Context<UpdateFundingRate>,
        market_index: u64,
    ) -> ProgramResult {
        let market =
            &mut ctx.accounts.markets.load_mut()?.markets[Markets::index_from_u64(market_index)];
        let price_oracle = &ctx.accounts.oracle;
        let clock = Clock::get().unwrap();
        let now = clock.unix_timestamp;

        controller::funding::update_funding_rate(market, price_oracle, now);

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

    pub fn update_fee(
        ctx: Context<AdminUpdateState>,
        fee_numerator: u128,
        fee_denominator: u128,
    ) -> ProgramResult {
        ctx.accounts.state.fee_numerator = fee_numerator;
        ctx.accounts.state.fee_denominator = fee_denominator;
        Ok(())
    }

    pub fn update_admin(ctx: Context<AdminUpdateState>, admin: Pubkey) -> ProgramResult {
        ctx.accounts.state.admin = admin;
        Ok(())
    }
}

fn market_initialized(markets: &Loader<Markets>, market_index: u64) -> Result<()> {
    if !markets.load()?.markets[Markets::index_from_u64(market_index)].initialized {
        return Err(ErrorCode::MarketIndexNotInitialized.into());
    }
    Ok(())
}
