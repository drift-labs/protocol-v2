use std::cmp::max;

use anchor_lang::prelude::*;
use anchor_spl::token::{self, Transfer};
use borsh::{BorshDeserialize, BorshSerialize};
use bytemuck;

use error::*;
use instructions::*;
use math::{bn, constants::*, curve, fees, margin::*, position::*, withdrawal::*};
use state::{
    history::TradeRecord,
    market::{Market, Markets, OracleSource, AMM},
    state::State,
    user::{MarketPosition, User},
};
use trade::*;

mod error;
mod funding;
mod instructions;
mod math;
mod state;
mod trade;
declare_id!("HdfkJg9RcFZnBNEKrUvxR7srWwzYWRSkfLSQYjY9jg1Z");

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

        let init_mark_price = curve::calculate_base_asset_price_with_mantissa(
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
        funding::settle_funding_payment(user, user_positions, markets, funding_payment_history);

        let cpi_accounts = Transfer {
            from: ctx
                .accounts
                .user_collateral_account
                .to_account_info()
                .clone(),
            to: ctx.accounts.collateral_vault.to_account_info().clone(),
            authority: ctx.accounts.authority.to_account_info().clone(),
        };
        let cpi_program = ctx.accounts.token_program.to_account_info();
        let cpi_context = CpiContext::new(cpi_program, cpi_accounts);
        token::transfer(cpi_context, amount).unwrap();

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
        funding::settle_funding_payment(user, user_positions, markets, funding_payment_history);

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

        let signature_seeds = [
            ctx.accounts.state.collateral_vault.as_ref(),
            bytemuck::bytes_of(&ctx.accounts.state.collateral_vault_nonce),
        ];
        let signers = &[&signature_seeds[..]];
        let cpi_accounts = Transfer {
            from: ctx.accounts.collateral_vault.to_account_info().clone(),
            to: ctx
                .accounts
                .user_collateral_account
                .to_account_info()
                .clone(),
            authority: ctx
                .accounts
                .collateral_vault_authority
                .to_account_info()
                .clone(),
        };
        let cpi_program = ctx.accounts.token_program.to_account_info();
        let cpi_context = CpiContext::new_with_signer(cpi_program, cpi_accounts, signers);
        token::transfer(cpi_context, collateral_account_withdrawal).unwrap();

        ctx.accounts.state.collateral_deposits = ctx
            .accounts
            .state
            .collateral_deposits
            .checked_sub(collateral_account_withdrawal as u128)
            .unwrap();

        if insurance_account_withdrawal > 0 {
            let signature_seeds = [
                ctx.accounts.state.insurance_vault.as_ref(),
                bytemuck::bytes_of(&ctx.accounts.state.insurance_vault_nonce),
            ];
            let signers = &[&signature_seeds[..]];
            let cpi_accounts = Transfer {
                from: ctx.accounts.insurance_vault.to_account_info().clone(),
                to: ctx
                    .accounts
                    .user_collateral_account
                    .to_account_info()
                    .clone(),
                authority: ctx
                    .accounts
                    .insurance_vault_authority
                    .to_account_info()
                    .clone(),
            };
            let cpi_program = ctx.accounts.token_program.to_account_info();
            let cpi_context = CpiContext::new_with_signer(cpi_program, cpi_accounts, signers);
            token::transfer(cpi_context, insurance_account_withdrawal).unwrap();
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
        funding::settle_funding_payment(
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

            let trade_size_too_small = trade::increase_position(
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
                let trade_size_too_small = trade::reduce_position(
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

                trade::close_position(user, market, market_position, now);

                let trade_size_too_small = trade::increase_position(
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

            let entry_price = curve::calculate_base_asset_price_with_mantissa(
                quote_asset_amount,
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
        funding::settle_funding_payment(
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
        trade::close_position(user, market, market_position, now);

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

                trade::close_position(user, market, market_position, now)
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

                trade::reduce_position(
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
            let signature_seeds = [
                ctx.accounts.state.collateral_vault.as_ref(),
                bytemuck::bytes_of(&ctx.accounts.state.collateral_vault_nonce),
            ];
            let signers = &[&signature_seeds[..]];
            let cpi_accounts = Transfer {
                from: ctx.accounts.collateral_vault.to_account_info().clone(),
                to: ctx.accounts.liquidator_account.to_account_info().clone(),
                authority: ctx
                    .accounts
                    .collateral_vault_authority
                    .to_account_info()
                    .clone(),
            };
            let cpi_program = ctx.accounts.token_program.to_account_info();
            let cpi_context = CpiContext::new_with_signer(cpi_program, cpi_accounts, signers);
            token::transfer(cpi_context, liquidator_cut_amount).unwrap();
        }

        if insurance_fund_cut_amount > 0 {
            let signature_seeds = [
                ctx.accounts.state.collateral_vault.as_ref(),
                bytemuck::bytes_of(&ctx.accounts.state.collateral_vault_nonce),
            ];
            let signers = &[&signature_seeds[..]];
            let cpi_accounts = Transfer {
                from: ctx.accounts.collateral_vault.to_account_info().clone(),
                to: ctx.accounts.insurance_vault.to_account_info().clone(),
                authority: ctx
                    .accounts
                    .collateral_vault_authority
                    .to_account_info()
                    .clone(),
            };
            let cpi_program = ctx.accounts.token_program.to_account_info();
            let cpi_context = CpiContext::new_with_signer(cpi_program, cpi_accounts, signers);
            token::transfer(cpi_context, insurance_fund_cut_amount).unwrap();
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
        market.amm.move_price(base_asset_amount, quote_asset_amount);
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
            let signature_seeds = [
                ctx.accounts.state.collateral_vault.as_ref(),
                bytemuck::bytes_of(&ctx.accounts.state.collateral_vault_nonce),
            ];
            let signers = &[&signature_seeds[..]];
            let cpi_accounts = Transfer {
                from: ctx.accounts.collateral_vault.to_account_info().clone(),
                to: ctx.accounts.insurance_vault.to_account_info().clone(),
                authority: ctx
                    .accounts
                    .collateral_vault_authority
                    .to_account_info()
                    .clone(),
            };
            let cpi_program = ctx.accounts.token_program.to_account_info();
            let cpi_context = CpiContext::new_with_signer(cpi_program, cpi_accounts, signers);
            token::transfer(cpi_context, amount).unwrap();
        }

        Ok(())
    }

    #[access_control(
        market_initialized(&ctx.accounts.markets, market_index)
    )]
    pub fn repeg_amm_curve(
        ctx: Context<RepegCurve>,
        new_peg: u128,
        market_index: u64,
    ) -> ProgramResult {
        let market =
            &mut ctx.accounts.markets.load_mut()?.markets[Markets::index_from_u64(market_index)];
        let amm = &mut market.amm;
        if new_peg == amm.peg_multiplier {
            return Err(ErrorCode::InvalidRepegRedundant.into());
        }

        let mut new_peg_candidate = new_peg;

        let price_oracle = &ctx.accounts.oracle;
        let (oracle_px, oracle_conf) = amm.get_oracle_price(price_oracle, 0);
        let cur_peg = amm.peg_multiplier;

        let current_mark = amm.base_asset_price_with_mantissa();

        if new_peg_candidate == 0 {
            // try to find semi-opt solution
            new_peg_candidate = amm.find_valid_repeg(oracle_px, oracle_conf);

            if new_peg_candidate == amm.peg_multiplier {
                return Err(ErrorCode::InvalidRepegRedundant.into());
            }
        }

        let price_spread_0 = (cur_peg as i128)
            .checked_mul(PRICE_TO_PEG_PRECISION_RATIO as i128)
            .unwrap()
            .checked_sub(oracle_px)
            .unwrap();
        let price_spread_1 = (new_peg_candidate as i128)
            .checked_mul(PRICE_TO_PEG_PRECISION_RATIO as i128)
            .unwrap()
            .checked_sub(oracle_px)
            .unwrap();

        if price_spread_1.abs() > price_spread_0.abs() {
            // decrease
            return Err(ErrorCode::InvalidRepegDirection.into());
        }

        let mut pnl_r = amm.cumulative_fee_realized;
        //todo: replace with Market.base_asset_amount
        let base_asset_amount_i = amm.sqrt_k as i128;
        let net_market_position = base_asset_amount_i
            .checked_sub(amm.base_asset_reserve as i128)
            .unwrap();

        let pnl = amm.calculate_repeg_candidate_pnl(new_peg_candidate);

        if net_market_position != 0 && pnl == 0 {
            return Err(ErrorCode::InvalidRepegProfitability.into());
        }

        if pnl >= 0 {
            pnl_r = pnl_r.checked_add(pnl.unsigned_abs()).unwrap();
        } else if pnl.abs() as u128 > pnl_r {
            return Err(ErrorCode::InvalidRepegProfitability.into());
        } else {
            pnl_r = (pnl_r).checked_sub(pnl.unsigned_abs()).unwrap();
            if pnl_r < amm.cumulative_fee.checked_div(2).unwrap() {
                return Err(ErrorCode::InvalidRepegProfitability.into());
            }

            // profit sharing with only those who held the rewarded position before repeg
            if new_peg_candidate < amm.peg_multiplier {
                if market.base_asset_amount_short.unsigned_abs() > 0 {
                    let repeg_profit_per_unit = pnl
                        .unsigned_abs()
                        .checked_mul(FUNDING_PAYMENT_MANTISSA)
                        .unwrap()
                        .checked_div(market.base_asset_amount_short.unsigned_abs())
                        .unwrap();

                    amm.cumulative_repeg_rebate_short = amm
                        .cumulative_repeg_rebate_short
                        .checked_add(repeg_profit_per_unit)
                        .unwrap();
                }
            } else {
                if market.base_asset_amount_long.unsigned_abs() > 0 {
                    let repeg_profit_per_unit = pnl
                        .unsigned_abs()
                        .checked_mul(FUNDING_PAYMENT_MANTISSA)
                        .unwrap()
                        .checked_div(market.base_asset_amount_long.unsigned_abs())
                        .unwrap();

                    amm.cumulative_repeg_rebate_long = amm
                        .cumulative_repeg_rebate_long
                        .checked_add(repeg_profit_per_unit)
                        .unwrap();
                }
            }

            amm.move_to_price(current_mark);
        }

        amm.cumulative_fee_realized = pnl_r;
        amm.peg_multiplier = new_peg_candidate;

        Ok(())
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
        funding::settle_funding_payment(
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

        let time_since_last_update = now - market.amm.last_funding_rate_ts;

        market.amm.last_mark_price_twap = market.amm.get_new_twap(now);
        market.amm.last_mark_price_twap_ts = now;

        if time_since_last_update >= market.amm.funding_period {
            let one_hour: u32 = 3600;
            let period_adjustment = (24_i64)
                .checked_mul(one_hour as i64)
                .unwrap()
                .checked_div(max(1, market.amm.funding_period))
                .unwrap();
            // funding period = 1 hour, window = 1 day
            // low periodicity => quickly updating/settled funding rates => lower funding rate payment per interval
            let price_spread = market.amm.get_oracle_mark_spread(price_oracle, one_hour);
            let funding_rate = price_spread
                .checked_mul(FUNDING_PAYMENT_MANTISSA as i128)
                .unwrap()
                .checked_div(period_adjustment as i128)
                .unwrap();

            let mut haircut_numerator = 0;

            if market.base_asset_amount == 0 {
                market.amm.cumulative_funding_rate_long = market
                    .amm
                    .cumulative_funding_rate_long
                    .checked_add(funding_rate)
                    .unwrap();

                market.amm.cumulative_funding_rate_short = market
                    .amm
                    .cumulative_funding_rate_short
                    .checked_add(funding_rate)
                    .unwrap();
            } else if market.base_asset_amount > 0 {
                // assert(market.base_asset_amount_long > market.base_asset_amount);
                // more longs that shorts

                if market.base_asset_amount_short.unsigned_abs() > 0 {
                    haircut_numerator = market.base_asset_amount_short.unsigned_abs();
                }

                let funding_rate_long_haircut = haircut_numerator
                    .checked_mul(MARK_PRICE_MANTISSA)
                    .unwrap()
                    .checked_div(market.base_asset_amount_long as u128)
                    .unwrap();

                let funding_rate_long = funding_rate
                    .checked_mul(funding_rate_long_haircut as i128)
                    .unwrap()
                    .checked_div(MARK_PRICE_MANTISSA as i128)
                    .unwrap();

                market.amm.cumulative_funding_rate_long = market
                    .amm
                    .cumulative_funding_rate_long
                    .checked_add(funding_rate_long)
                    .unwrap();

                market.amm.cumulative_funding_rate_short = market
                    .amm
                    .cumulative_funding_rate_short
                    .checked_add(funding_rate)
                    .unwrap();
            } else {
                // more shorts than longs
                if market.base_asset_amount_long.unsigned_abs() > 0 {
                    haircut_numerator = market.base_asset_amount_long.unsigned_abs();
                }

                let funding_rate_short_haircut = haircut_numerator
                    .checked_mul(MARK_PRICE_MANTISSA)
                    .unwrap()
                    .checked_div(market.base_asset_amount_short.unsigned_abs())
                    .unwrap();

                let funding_rate_short = funding_rate
                    .checked_mul(funding_rate_short_haircut as i128)
                    .unwrap()
                    .checked_div(MARK_PRICE_MANTISSA as i128)
                    .unwrap();

                market.amm.cumulative_funding_rate_short = market
                    .amm
                    .cumulative_funding_rate_short
                    .checked_add(funding_rate_short)
                    .unwrap();

                market.amm.cumulative_funding_rate_long = market
                    .amm
                    .cumulative_funding_rate_long
                    .checked_add(funding_rate)
                    .unwrap();
            }

            let cum_funding_rate = market
                .amm
                .cumulative_funding_rate
                .checked_add(funding_rate)
                .unwrap();

            market.amm.cumulative_funding_rate = cum_funding_rate;
            market.amm.last_funding_rate = funding_rate;
            market.amm.last_funding_rate_ts = now;
            market.amm.last_mark_price_twap = market.amm.base_asset_price_with_mantissa();
            market.amm.last_mark_price_twap_ts = now;
        }

        Ok(())
    }
}

fn market_initialized(markets: &Loader<Markets>, market_index: u64) -> Result<()> {
    if !markets.load()?.markets[Markets::index_from_u64(market_index)].initialized {
        return Err(ErrorCode::MarketIndexNotInitialized.into());
    }
    Ok(())
}
