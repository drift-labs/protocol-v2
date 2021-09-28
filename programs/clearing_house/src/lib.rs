use anchor_lang::prelude::*;
use bytemuck;

use anchor_spl::token::{self, Token, TokenAccount, Transfer};
use borsh::{BorshDeserialize, BorshSerialize};
use std::cell::{Ref, RefMut};
use std::cmp::{max, min};

mod bn;
mod curve;
mod market;
use market::{Market, Markets, OracleSource, AMM};
mod user;
use user::{MarketPosition, User, UserPositions};
mod history;
use history::{FundingPaymentHistory, FundingPaymentRecord, TradeHistory, TradeRecord};
mod constants;
mod error;
use constants::*;
use error::*;

declare_id!("GunoLs4qXiwE9Tpmv2Uj3ZSLtk8pmc9UmLtTm9bqhvK1");

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
            margin_ratio_initial: 950, // unit is 10% (+2 decimal places)
            margin_ratio_partial: 625,
            margin_ratio_maintenance: 500,
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
            quote_asset_notional_amount: 0,
            open_interest: 0,
            base_asset_volume: 0,
            peg_quote_asset_volume: 0,
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
                prev_funding_rate_ts: now,
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
        _settle_funding_payment(user, user_positions, markets, funding_payment_history);

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
        _settle_funding_payment(user, user_positions, markets, funding_payment_history);

        if (amount as u128) > user.collateral {
            return Err(ErrorCode::InsufficientCollateral.into());
        }

        // todo: what is scale? test a .01% max fee on net winnings withdrawled
        let net_winnings = (user.collateral as i128)
            .checked_sub(user.cumulative_deposits)
            .unwrap();
        let net_winnings_fee = max(net_winnings.checked_div(10000).unwrap(), 0) as u128;

        let withdrawl_fee = min(user.total_potential_fee, net_winnings_fee as i128);
        user.total_potential_fee = user.total_potential_fee.checked_sub(withdrawl_fee).unwrap();

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

        let margin_ratio = calculate_margin_ratio(user, user_positions, markets);
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
        incremental_quote_asset_notional_amount: u128,
        market_index: u64,
        limit_price: u128,
    ) -> ProgramResult {
        let user = &mut ctx.accounts.user;
        let clock = Clock::get().unwrap();
        let now = clock.unix_timestamp;

        let user_positions = &mut ctx.accounts.user_positions.load_mut().unwrap();
        let funding_payment_history = &mut ctx.accounts.funding_payment_history.load_mut().unwrap();
        _settle_funding_payment(
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
        let mut quote_asset_peg_fee = 0;

        if market_position.base_asset_amount == 0
            || market_position.base_asset_amount > 0 && direction == PositionDirection::Long
            || market_position.base_asset_amount < 0 && direction == PositionDirection::Short
        {
            let market = &mut ctx.accounts.markets.load_mut()?.markets
                [Markets::index_from_u64(market_index)];

            let (_quote_asset_peg_fee, trade_size_too_small) = increase_position(
                direction,
                incremental_quote_asset_notional_amount,
                market,
                market_position,
                now,
            );
            quote_asset_peg_fee = _quote_asset_peg_fee;

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
            if base_asset_value > incremental_quote_asset_notional_amount {
                let trade_size_too_small = reduce_position(
                    direction,
                    incremental_quote_asset_notional_amount,
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
                    incremental_quote_asset_notional_amount
                        .checked_sub(base_asset_value)
                        .unwrap();

                if incremental_quote_asset_notional_amount_resid < base_asset_value {
                    potentially_risk_increasing = false; //todo
                }

                _close_position(user, market, market_position, now);

                let (_quote_asset_peg_fee, trade_size_too_small) = increase_position(
                    direction,
                    incremental_quote_asset_notional_amount_resid,
                    market,
                    market_position,
                    now,
                );
                quote_asset_peg_fee = _quote_asset_peg_fee;

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
        let trade_history_account = &mut ctx.accounts.trade_history.load_mut()?;
        let record_id = trade_history_account.next_record_id();
        trade_history_account.append(TradeRecord {
            ts: now,
            record_id,
            user_authority: *ctx.accounts.authority.to_account_info().key,
            user: *user.to_account_info().key,
            direction,
            base_asset_amount: base_asset_amount_change,
            quote_asset_amount: incremental_quote_asset_notional_amount,
            mark_price_before: base_asset_price_with_mantissa_before,
            mark_price_after: base_asset_price_with_mantissa_after,
            market_index,
        });

        let margin_ratio_after =
            calculate_margin_ratio(user, user_positions, &ctx.accounts.markets.load().unwrap());
        if margin_ratio_after < ctx.accounts.state.margin_ratio_initial
            && potentially_risk_increasing
        {
            return Err(ErrorCode::InsufficientCollateral.into());
        }

        user.total_potential_fee = user
            .total_potential_fee
            .checked_add(quote_asset_peg_fee)
            .unwrap();

        if limit_price != 0 {
            let market = &ctx.accounts.markets.load().unwrap().markets
                [Markets::index_from_u64(market_index)];

            // todo: allow for average price limit? instead of most expensive slice?
            // todo: support partial fill
            let new_price = market.amm.base_asset_price_with_mantissa();

            // error if bought too high or sold too low
            if new_price > limit_price && direction == PositionDirection::Long
                || new_price < limit_price && direction == PositionDirection::Short
            {
                return Err(ErrorCode::SlippageOutsideLimit.into());
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
        _settle_funding_payment(
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
        _close_position(user, market, market_position, now);

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
            market_index,
        });

        Ok(())
    }

    pub fn liquidate(ctx: Context<Liquidate>) -> ProgramResult {
        let user = &mut ctx.accounts.user;
        let clock = Clock::get().unwrap();
        let now = clock.unix_timestamp;

        let (estimated_margin, base_asset_notional) = calculate_margin_ratio_full(
            user,
            &ctx.accounts.user_positions.load_mut().unwrap(),
            &ctx.accounts.markets.load().unwrap(),
        );

        let margin_ratio = _calculate_margin_ratio_inp(estimated_margin, base_asset_notional);
        if margin_ratio > ctx.accounts.state.margin_ratio_partial {
            return Err(ErrorCode::SufficientCollateral.into());
        }

        let marketss = &mut ctx.accounts.markets.load_mut().unwrap();
        let user_positionss = &mut ctx.accounts.user_positions.load_mut().unwrap();

        let mut liquidation_penalty = 0;
        let mut is_full_liquidation = true;
        if margin_ratio <= ctx.accounts.state.margin_ratio_maintenance {
            for market_position in user_positionss.positions.iter_mut() {
                if market_position.base_asset_amount == 0 {
                    continue;
                }

                let market =
                    &mut marketss.markets[Markets::index_from_u64(market_position.market_index)];

                _close_position(user, market, market_position, now)
            }
        } else {
            for market_position in user_positionss.positions.iter_mut() {
                if market_position.base_asset_amount == 0 {
                    continue;
                }

                let market =
                    &mut marketss.markets[Markets::index_from_u64(market_position.market_index)];

                let haircut = base_asset_notional
                    .checked_mul(PARTIAL_LIQUIDATION_TRIM_PCT)
                    .unwrap()
                    .checked_div(100)
                    .unwrap();

                let direction = if market_position.base_asset_amount > 0 {
                    PositionDirection::Short
                } else {
                    PositionDirection::Long
                };

                reduce_position(direction, haircut, user, market, market_position, now);
            }

            is_full_liquidation = false;
        }

        liquidation_penalty = if is_full_liquidation {
            user.collateral
        } else {
            estimated_margin
                .checked_mul(PARTIAL_LIQUIDATION_TRIM_PCT)
                .unwrap()
                .checked_div(100)
                .unwrap()
                .checked_div(10)
                .unwrap()
        };

        let (withdrawal_amount, _) = calculate_withdrawal_amounts(
            liquidation_penalty as u64,
            &ctx.accounts.collateral_vault,
            &ctx.accounts.insurance_vault,
        );

        user.collateral = user.collateral.checked_sub(liquidation_penalty).unwrap();
        // user.total_potential_fee = 0;

        // partial: 50%, 50%, full: 5% liquidator, 95% insurance fund
        let liquidator_cut_amount = if is_full_liquidation {
            withdrawal_amount.checked_div(20).unwrap()
        } else {
            withdrawal_amount.checked_div(2).unwrap()
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
        // todo: still need to reward liquidator a tiny amount

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
        _settle_funding_payment(
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
            market.amm.prev_funding_rate_ts = market.amm.last_funding_rate_ts;
            market.amm.last_funding_rate_ts = now;
            market.amm.last_mark_price_twap = market.amm.base_asset_price_with_mantissa();
            market.amm.last_mark_price_twap_ts = now;
        }

        Ok(())
    }
}

#[derive(Accounts)]
#[instruction(clearing_house_nonce: u8)]
pub struct Initialize<'info> {
    pub admin: Signer<'info>,
    #[account(
        init,
        seeds = [b"clearing_house".as_ref()],
        bump = clearing_house_nonce,
        payer = admin
    )]
    pub state: Box<Account<'info, State>>,
    pub collateral_vault: Box<Account<'info, TokenAccount>>,
    #[account(
        constraint = &insurance_vault.mint.eq(&collateral_vault.mint)
    )]
    pub insurance_vault: Box<Account<'info, TokenAccount>>,
    #[account(zero)]
    pub markets: Loader<'info, Markets>,
    #[account(zero)]
    pub funding_payment_history: Loader<'info, FundingPaymentHistory>,
    #[account(zero)]
    pub trade_history: Loader<'info, TradeHistory>,
    pub rent: Sysvar<'info, Rent>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(user_nonce: u8)]
pub struct InitializeUser<'info> {
    #[account(
        init,
        seeds = [b"user", authority.key.as_ref()],
        bump = user_nonce,
        payer = authority
    )]
    pub user: Box<Account<'info, User>>,
    #[account(
        init,
        payer = authority,
    )]
    pub user_positions: Loader<'info, UserPositions>,
    pub authority: Signer<'info>,
    pub rent: Sysvar<'info, Rent>,
    pub system_program: Program<'info, System>,
    pub clock: Sysvar<'info, Clock>,
}

#[derive(Accounts)]
pub struct InitializeMarket<'info> {
    pub admin: Signer<'info>,
    #[account(
        has_one = admin
    )]
    pub state: Box<Account<'info, State>>,
    #[account(mut)]
    pub markets: Loader<'info, Markets>,
    pub oracle: AccountInfo<'info>,
}

#[derive(Accounts)]
pub struct DepositCollateral<'info> {
    #[account(mut)]
    pub state: Box<Account<'info, State>>,
    #[account(mut, has_one = authority)]
    pub user: Box<Account<'info, User>>,
    pub authority: Signer<'info>,
    #[account(
        mut,
        constraint = &state.collateral_vault.eq(&collateral_vault.key())
    )]
    pub collateral_vault: Box<Account<'info, TokenAccount>>,
    #[account(mut)]
    pub user_collateral_account: Box<Account<'info, TokenAccount>>,
    pub token_program: Program<'info, Token>,
    pub markets: Loader<'info, Markets>,
    #[account(
        mut,
        has_one = user
    )]
    pub user_positions: Loader<'info, UserPositions>,
    #[account(mut)]
    pub funding_payment_history: Loader<'info, FundingPaymentHistory>,
}

#[derive(Accounts)]
pub struct WithdrawCollateral<'info> {
    #[account(mut)]
    pub state: Box<Account<'info, State>>,
    #[account(mut, has_one = authority)]
    pub user: Box<Account<'info, User>>,
    pub authority: Signer<'info>,
    #[account(
        mut,
        constraint = &state.collateral_vault.eq(&collateral_vault.key())
    )]
    pub collateral_vault: Box<Account<'info, TokenAccount>>,
    pub collateral_vault_authority: AccountInfo<'info>,
    #[account(
        mut,
        constraint = &state.insurance_vault.eq(&insurance_vault.key())
    )]
    pub insurance_vault: Box<Account<'info, TokenAccount>>,
    pub insurance_vault_authority: AccountInfo<'info>,
    #[account(mut)]
    pub user_collateral_account: Box<Account<'info, TokenAccount>>,
    pub token_program: Program<'info, Token>,
    pub markets: Loader<'info, Markets>,
    #[account(
        mut,
        has_one = user
    )]
    pub user_positions: Loader<'info, UserPositions>,
    #[account(mut)]
    pub funding_payment_history: Loader<'info, FundingPaymentHistory>,
}

#[derive(Accounts)]
pub struct AdminWithdrawCollateral<'info> {
    #[account(
        has_one = admin
    )]
    pub state: Box<Account<'info, State>>,
    pub admin: Signer<'info>,
    #[account(
        mut,
        constraint = &state.collateral_vault.eq(&collateral_vault.key())
    )]
    pub collateral_vault: Box<Account<'info, TokenAccount>>,
    pub collateral_vault_authority: AccountInfo<'info>,
    #[account(
        mut,
        constraint = &state.insurance_vault.eq(&insurance_vault.key())
    )]
    pub insurance_vault: Box<Account<'info, TokenAccount>>,
    #[account(mut)]
    pub token_program: Program<'info, Token>,
    pub markets: Loader<'info, Markets>,
}

#[derive(Accounts)]
pub struct OpenPosition<'info> {
    #[account(mut)]
    pub state: Box<Account<'info, State>>,
    #[account(
        mut,
        has_one = authority
    )]
    pub user: Box<Account<'info, User>>,
    pub authority: Signer<'info>,
    #[account(mut)]
    pub markets: Loader<'info, Markets>,
    #[account(
        mut,
        has_one = user
    )]
    pub user_positions: Loader<'info, UserPositions>,
    #[account(mut)]
    pub trade_history: Loader<'info, TradeHistory>,
    #[account(mut)]
    pub funding_payment_history: Loader<'info, FundingPaymentHistory>,
}

#[derive(Accounts)]
pub struct ClosePosition<'info> {
    #[account(mut)]
    pub state: Box<Account<'info, State>>,
    #[account(mut, has_one = authority)]
    pub user: Box<Account<'info, User>>,
    pub authority: Signer<'info>,
    #[account(mut)]
    pub markets: Loader<'info, Markets>,
    #[account(
        mut,
        has_one = user
    )]
    pub user_positions: Loader<'info, UserPositions>,
    #[account(mut)]
    pub trade_history_account: Loader<'info, TradeHistory>,
    #[account(mut)]
    pub funding_payment_history: Loader<'info, FundingPaymentHistory>,
}

#[derive(Accounts)]
pub struct Liquidate<'info> {
    pub state: Box<Account<'info, State>>,
    pub liquidator: Signer<'info>,
    #[account(mut)]
    pub user: Box<Account<'info, User>>,
    #[account(
        mut,
        constraint = &state.collateral_vault.eq(&collateral_vault.key())
    )]
    pub collateral_vault: Box<Account<'info, TokenAccount>>,
    pub collateral_vault_authority: AccountInfo<'info>,
    #[account(
        mut,
        constraint = &state.insurance_vault.eq(&insurance_vault.key())
    )]
    pub insurance_vault: Box<Account<'info, TokenAccount>>,
    pub insurance_vault_authority: AccountInfo<'info>,
    #[account(mut)]
    pub liquidator_account: Box<Account<'info, TokenAccount>>,
    pub token_program: Program<'info, Token>,
    #[account(mut)]
    pub markets: Loader<'info, Markets>,
    #[account(
        mut,
        has_one = user
    )]
    pub user_positions: Loader<'info, UserPositions>,
}

#[derive(Accounts)]
pub struct SettleFunding<'info> {
    #[account(mut)]
    pub user: Box<Account<'info, User>>,
    pub markets: Loader<'info, Markets>,
    #[account(
        mut,
        has_one = user
    )]
    pub user_positions: Loader<'info, UserPositions>,
    #[account(mut)]
    pub funding_payment_history: Loader<'info, FundingPaymentHistory>,
}

#[derive(Accounts)]
pub struct UpdateFundingRate<'info> {
    #[account(mut)]
    pub markets: Loader<'info, Markets>,
    pub oracle: AccountInfo<'info>,
}

#[derive(Accounts)]
pub struct RepegCurve<'info> {
    #[account(
        has_one = admin
    )]
    pub state: Box<Account<'info, State>>,
    #[account(mut)]
    pub markets: Loader<'info, Markets>,
    pub oracle: AccountInfo<'info>,
    pub admin: Signer<'info>,
}

#[derive(Accounts)]
pub struct MoveAMMPrice<'info> {
    #[account(
        has_one = admin,
        constraint = state.admin_controls_prices == true
    )]
    pub state: Box<Account<'info, State>>,
    pub admin: Signer<'info>,
    #[account(mut)]
    pub markets: Loader<'info, Markets>,
}

#[account]
#[derive(Default)]
pub struct State {
    pub admin: Pubkey,
    pub admin_controls_prices: bool,
    pub collateral_vault: Pubkey,
    pub collateral_vault_authority: Pubkey,
    pub collateral_vault_nonce: u8,
    pub funding_payment_history: Pubkey,
    pub insurance_vault: Pubkey,
    pub insurance_vault_authority: Pubkey,
    pub insurance_vault_nonce: u8,
    pub markets: Pubkey,
    pub margin_ratio_initial: u128,
    pub margin_ratio_maintenance: u128,
    pub margin_ratio_partial: u128,
    pub trade_history: Pubkey,
    pub collateral_deposits: u128,
}

#[derive(Clone, Copy)]
pub enum SwapDirection {
    Add,
    Remove,
}

#[derive(Clone, Copy, BorshSerialize, BorshDeserialize, PartialEq)]
pub enum PositionDirection {
    Long,
    Short,
}

impl Default for PositionDirection {
    // UpOnly
    fn default() -> Self {
        PositionDirection::Long
    }
}

fn increase_position(
    direction: PositionDirection,
    new_quote_asset_notional_amount: u128,
    market: &mut Market,
    market_position: &mut MarketPosition,
    now: i64,
) -> (i128, bool) {
    if new_quote_asset_notional_amount == 0 {
        return (0, false);
    }

    // Update funding rate if this is a new position
    if market_position.base_asset_amount == 0 {
        market_position.last_cumulative_funding_rate = market.amm.cumulative_funding_rate;
        market_position.last_cumulative_repeg_rebate = match direction {
            PositionDirection::Long => market.amm.cumulative_repeg_rebate_long,
            PositionDirection::Short => market.amm.cumulative_repeg_rebate_short,
        };
        market.open_interest = market.open_interest.checked_add(1).unwrap();
    }

    market_position.quote_asset_amount = market_position
        .quote_asset_amount
        .checked_add(new_quote_asset_notional_amount)
        .unwrap();
    market.quote_asset_notional_amount = market
        .quote_asset_notional_amount
        .checked_add(new_quote_asset_notional_amount)
        .unwrap();

    let swap_direction = match direction {
        PositionDirection::Long => SwapDirection::Add,
        PositionDirection::Short => SwapDirection::Remove,
    };

    let (base_asset_acquired, quote_asset_peg_fee_unpaid, trade_size_to_small) = market
        .amm
        .swap_quote_asset_with_fee(new_quote_asset_notional_amount, swap_direction, now);

    // update the position size on market and user
    market_position.base_asset_amount = market_position
        .base_asset_amount
        .checked_add(base_asset_acquired)
        .unwrap();
    market.base_asset_amount = market
        .base_asset_amount
        .checked_add(base_asset_acquired)
        .unwrap();

    if market_position.base_asset_amount > 0 {
        market.base_asset_amount_long = market
            .base_asset_amount_long
            .checked_add(base_asset_acquired)
            .unwrap();
    } else {
        market.base_asset_amount_short = market
            .base_asset_amount_short
            .checked_add(base_asset_acquired)
            .unwrap();
    }

    market.base_asset_volume = market
        .base_asset_volume
        .checked_add(base_asset_acquired.unsigned_abs())
        .unwrap();

    market.peg_quote_asset_volume = market
        .peg_quote_asset_volume
        .checked_add(new_quote_asset_notional_amount)
        .unwrap();

    return (quote_asset_peg_fee_unpaid, trade_size_to_small);
}

fn reduce_position<'info>(
    direction: PositionDirection,
    new_quote_asset_notional_amount: u128,
    user: &mut Account<'info, User>,
    market: &mut Market,
    market_position: &mut MarketPosition,
    now: i64,
) -> bool {
    let swap_direction = match direction {
        PositionDirection::Long => SwapDirection::Add,
        PositionDirection::Short => SwapDirection::Remove,
    };
    let (base_asset_value_before, pnl_before) =
        calculate_base_asset_value_and_pnl(market_position, &market.amm);
    let (base_asset_swapped, trade_size_too_small) =
        market
            .amm
            .swap_quote_asset(new_quote_asset_notional_amount, swap_direction, now);

    market_position.base_asset_amount = market_position
        .base_asset_amount
        .checked_add(base_asset_swapped)
        .unwrap();

    market.open_interest = market
        .open_interest
        .checked_sub((market_position.base_asset_amount == 0) as u128)
        .unwrap();
    market.base_asset_amount = market
        .base_asset_amount
        .checked_add(base_asset_swapped)
        .unwrap();

    if market_position.base_asset_amount > 0 {
        market.base_asset_amount_long = market
            .base_asset_amount_long
            .checked_add(base_asset_swapped)
            .unwrap();
    } else {
        market.base_asset_amount_short = market
            .base_asset_amount_short
            .checked_add(base_asset_swapped)
            .unwrap();
    }
    market_position.quote_asset_amount = market_position
        .quote_asset_amount
        .checked_sub(new_quote_asset_notional_amount)
        .unwrap();
    market.quote_asset_notional_amount = market
        .quote_asset_notional_amount
        .checked_sub(new_quote_asset_notional_amount)
        .unwrap();

    market.base_asset_volume = market
        .base_asset_volume
        .checked_add(base_asset_swapped.unsigned_abs())
        .unwrap();

    market.peg_quote_asset_volume = market
        .peg_quote_asset_volume
        .checked_add(new_quote_asset_notional_amount)
        .unwrap();

    let (base_asset_value_after, _pnl_after) =
        calculate_base_asset_value_and_pnl(market_position, &market.amm);

    assert_eq!(base_asset_value_before > base_asset_value_after, true);

    let base_asset_value_change = (base_asset_value_before as i128)
        .checked_sub(base_asset_value_after as i128)
        .unwrap()
        .abs();

    let pnl = pnl_before
        .checked_mul(base_asset_value_change)
        .unwrap()
        .checked_div(base_asset_value_before as i128)
        .unwrap();

    user.collateral = calculate_updated_collateral(user.collateral, pnl);

    return trade_size_too_small;
}

fn _close_position(
    user: &mut Account<User>,
    market: &mut Market,
    market_position: &mut MarketPosition,
    now: i64,
) {
    // If user has no base asset, return early
    if market_position.base_asset_amount == 0 {
        return;
    }

    let swap_direction = if market_position.base_asset_amount > 0 {
        SwapDirection::Add
    } else {
        SwapDirection::Remove
    };

    let (base_asset_value, pnl) = calculate_base_asset_value_and_pnl(&market_position, &market.amm);

    market.amm.swap_base_asset(
        market_position.base_asset_amount.unsigned_abs(),
        swap_direction,
        now,
    );

    user.collateral = calculate_updated_collateral(user.collateral, pnl);
    market_position.last_cumulative_funding_rate = 0;
    market_position.last_cumulative_repeg_rebate = 0;

    market.quote_asset_notional_amount = market
        .quote_asset_notional_amount
        .checked_sub(market_position.quote_asset_amount)
        .unwrap();

    market.base_asset_volume = market
        .base_asset_volume
        .checked_add(market_position.base_asset_amount.unsigned_abs())
        .unwrap();
    market.peg_quote_asset_volume = market
        .peg_quote_asset_volume
        .checked_add(base_asset_value)
        .unwrap(); //todo
    market.open_interest = market.open_interest.checked_sub(1).unwrap();

    market_position.quote_asset_amount = 0;

    market.base_asset_amount = market
        .base_asset_amount
        .checked_sub(market_position.base_asset_amount)
        .unwrap();

    if market_position.base_asset_amount > 0 {
        market.base_asset_amount_long = market
            .base_asset_amount_long
            .checked_sub(market_position.base_asset_amount)
            .unwrap();
    } else {
        market.base_asset_amount_short = market
            .base_asset_amount_short
            .checked_sub(market_position.base_asset_amount)
            .unwrap();
    }

    market_position.base_asset_amount = 0;
}

fn calculate_withdrawal_amounts(
    amount: u64,
    collateral_token_account: &TokenAccount,
    insurance_token_account: &TokenAccount,
) -> (u64, u64) {
    return if collateral_token_account.amount >= amount {
        (amount, 0)
    } else if insurance_token_account.amount
        > amount.checked_sub(collateral_token_account.amount).unwrap()
    {
        (
            collateral_token_account.amount,
            amount.checked_sub(collateral_token_account.amount).unwrap(),
        )
    } else {
        (
            collateral_token_account.amount,
            insurance_token_account.amount,
        )
    };
}

fn _settle_funding_payment(
    user: &mut User,
    user_positions: &mut RefMut<UserPositions>,
    markets: &Ref<Markets>,
    funding_payment_history: &mut RefMut<FundingPaymentHistory>,
) {
    let clock = Clock::get().unwrap();
    let now = clock.unix_timestamp;

    let user_key = user_positions.user;
    let mut funding_payment: i128 = 0;
    for market_position in user_positions.positions.iter_mut() {
        if market_position.base_asset_amount == 0 {
            continue;
        }

        let market = &markets.markets[Markets::index_from_u64(market_position.market_index)];
        let amm: &AMM = &market.amm;

        if amm.cumulative_funding_rate != market_position.last_cumulative_funding_rate {
            let market_funding_rate_payment =
                _calculate_funding_payment_notional(amm, market_position);

            let record_id = funding_payment_history.next_record_id();
            funding_payment_history.append(FundingPaymentRecord {
                ts: now,
                record_id,
                user_authority: user.authority,
                user: user_key,
                market_index: market_position.market_index,
                funding_payment: market_funding_rate_payment, //10e13
                user_last_cumulative_funding: market_position.last_cumulative_funding_rate, //10e14
                amm_cumulative_funding: amm.cumulative_funding_rate, //10e14
                base_asset_amount: market_position.base_asset_amount, //10e13
            });

            funding_payment = funding_payment
                .checked_add(market_funding_rate_payment)
                .unwrap();

            market_position.last_cumulative_funding_rate = amm.cumulative_funding_rate;
            market_position.last_funding_rate_ts = amm.last_funding_rate_ts;
        }

        _settle_repeg_profit_position(user, market_position, market);
    }

    // longs pay shorts the `funding_payment`
    let funding_payment_collateral = funding_payment
        .checked_div(
            BASE_ASSET_AMOUNT_PRECISION
                .checked_div(USDC_PRECISION)
                .unwrap() as i128,
        )
        .unwrap();

    user.collateral = calculate_updated_collateral(user.collateral, funding_payment_collateral);
}

fn _settle_repeg_profit_position(
    user: &mut User,
    market_position: &mut MarketPosition,
    market: &Market,
) {
    if market_position.base_asset_amount > 0
        && market_position.last_cumulative_repeg_rebate != market.amm.cumulative_repeg_rebate_long
        || market_position.base_asset_amount < 0
            && market_position.last_cumulative_repeg_rebate
                != market.amm.cumulative_repeg_rebate_short
    {
        let repeg_profit_share = if market_position.base_asset_amount > 0 {
            market
                .amm
                .cumulative_repeg_rebate_long
                .checked_sub(market_position.last_cumulative_repeg_rebate)
                .unwrap()
        } else {
            market
                .amm
                .cumulative_repeg_rebate_short
                .checked_sub(market_position.last_cumulative_repeg_rebate)
                .unwrap()
        };
        market_position.last_cumulative_repeg_rebate = if market_position.base_asset_amount > 0 {
            market.amm.cumulative_repeg_rebate_long
        } else {
            market.amm.cumulative_repeg_rebate_short
        };

        let repeg_profit_share_pnl = (repeg_profit_share as u128)
            .checked_mul(market_position.base_asset_amount.unsigned_abs())
            .unwrap()
            .checked_div(FUNDING_PAYMENT_MANTISSA)
            .unwrap();
        user.total_potential_fee = user
            .total_potential_fee
            .checked_sub(repeg_profit_share_pnl as i128)
            .unwrap();
    }
}

fn calculate_margin_ratio_full(
    user: &User,
    user_positions: &RefMut<UserPositions>,
    markets: &Ref<Markets>,
) -> (u128, u128) {
    let mut base_asset_value: u128 = 0;
    let mut unrealized_pnl: i128 = 0;

    // loop 1 to calculate unrealized_pnl
    for market_position in user_positions.positions.iter() {
        if market_position.base_asset_amount == 0 {
            continue;
        }

        let amm = &markets.markets[Markets::index_from_u64(market_position.market_index)].amm;
        let (position_base_asset_value, position_unrealized_pnl) =
            calculate_base_asset_value_and_pnl(market_position, amm);

        base_asset_value = base_asset_value
            .checked_add(position_base_asset_value)
            .unwrap();
        unrealized_pnl = unrealized_pnl.checked_add(position_unrealized_pnl).unwrap();
    }

    if base_asset_value == 0 {
        return (u128::MAX, base_asset_value);
    }

    let estimated_margin = calculate_updated_collateral(user.collateral, unrealized_pnl);

    return (estimated_margin, base_asset_value);
}

fn _calculate_margin_ratio_inp(estimated_margin: u128, base_asset_value: u128) -> u128 {
    if base_asset_value == 0 {
        return u128::MAX;
    }

    let margin_ratio = estimated_margin
        .checked_mul(10000)
        .unwrap()
        .checked_div(base_asset_value)
        .unwrap();

    return margin_ratio;
}

fn _calculate_funding_payment_notional(amm: &AMM, market_position: &MarketPosition) -> i128 {
    let funding_rate_delta = amm
        .cumulative_funding_rate
        .checked_sub(market_position.last_cumulative_funding_rate)
        .unwrap();
    let funding_rate_delta_sign: i128 = if funding_rate_delta > 0 { 1 } else { -1 } as i128;

    let funding_rate_payment_mag = bn::U256::from(funding_rate_delta.unsigned_abs())
        .checked_mul(bn::U256::from(
            market_position.base_asset_amount.unsigned_abs(),
        ))
        .unwrap()
        .checked_div(bn::U256::from(MARK_PRICE_MANTISSA))
        .unwrap()
        .checked_div(bn::U256::from(FUNDING_PAYMENT_MANTISSA))
        .unwrap()
        .try_to_u128()
        .unwrap() as i128;

    // funding_rate is: longs pay shorts
    let funding_rate_payment_sign: i128 = if market_position.base_asset_amount > 0 {
        -1
    } else {
        1
    } as i128;

    let funding_rate_payment = (funding_rate_payment_mag)
        .checked_mul(funding_rate_payment_sign)
        .unwrap()
        .checked_mul(funding_rate_delta_sign)
        .unwrap();

    return funding_rate_payment;
}

fn calculate_margin_ratio(
    user: &User,
    user_positions: &RefMut<UserPositions>,
    markets: &Ref<Markets>,
) -> u128 {
    let (estimated_margin, base_asset_value) =
        calculate_margin_ratio_full(user, user_positions, markets);
    let margin_ratio = _calculate_margin_ratio_inp(estimated_margin, base_asset_value);
    return margin_ratio;
}

fn calculate_base_asset_value_and_pnl(market_position: &MarketPosition, amm: &AMM) -> (u128, i128) {
    let swap_direction = if market_position.base_asset_amount > 0 {
        SwapDirection::Add
    } else {
        SwapDirection::Remove
    };
    let (quote_asset_acquired, pnl) = amm.find_swap_output_and_pnl(
        market_position.base_asset_amount.unsigned_abs(),
        market_position.quote_asset_amount,
        swap_direction,
    );
    return (quote_asset_acquired, pnl);
}

fn calculate_updated_collateral(collateral: u128, pnl: i128) -> u128 {
    return if pnl.is_negative() && pnl.unsigned_abs() > collateral {
        0
    } else if pnl > 0 {
        collateral.checked_add(pnl.unsigned_abs()).unwrap()
    } else {
        collateral.checked_sub(pnl.unsigned_abs()).unwrap()
    };
}

fn market_initialized(markets: &Loader<Markets>, market_index: u64) -> Result<()> {
    if !markets.load()?.markets[Markets::index_from_u64(market_index)].initialized {
        return Err(ErrorCode::MarketIndexNotInitialized.into());
    }
    Ok(())
}
