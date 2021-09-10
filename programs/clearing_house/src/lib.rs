#![feature(unsigned_abs)]

use anchor_lang::prelude::*;
use bytemuck;
use solana_program::msg;

use anchor_lang::Key;
use anchor_spl::token::{self, TokenAccount, Transfer};
use borsh::{BorshDeserialize, BorshSerialize};
use integer_sqrt::IntegerSquareRoot;
use std::cell::{Ref, RefMut};
use std::cmp::{max, min};
use std::str::FromStr;

pub const MANTISSA: u128 = 1000000; //expo = -6
pub const MARGIN_MANTISSA: u128 = 10000;
pub const FUNDING_MANTISSA: u128 = 10000; // expo = -9

#[program]
pub mod clearing_house {
    use super::*;

    #[state]
    pub struct ClearingHouse {
        pub admin: Pubkey,
        pub admin_controls_prices: bool,
        pub collateral_account: Pubkey,
        pub collateral_account_authority: Pubkey,
        pub collateral_account_nonce: u8,
        pub funding_rate_history: Pubkey,
        pub insurance_account: Pubkey,
        pub insurance_account_authority: Pubkey,
        pub insurance_account_nonce: u8,
        pub markets_account: Pubkey,
        pub margin_ratio_initial: u128,     //initial margin
        pub margin_ratio_maintenence: u128, // maintenance margin
        pub margin_ratio_partial: u128,     // todo: support partial liquidation
        pub trade_history_account: Pubkey,

        pub allocated_deposits: u128,
    }

    impl ClearingHouse {
        pub fn new(
            ctx: Context<InitializeClearingHouse>,
            admin_controls_prices: bool,
        ) -> Result<Self> {
            let collateral_account_key = ctx.accounts.collateral_account.to_account_info().key;
            let (collateral_account_authority, collateral_account_nonce) =
                Pubkey::find_program_address(&[collateral_account_key.as_ref()], ctx.program_id);

            if ctx.accounts.collateral_account.owner != collateral_account_authority {
                return Err(ErrorCode::InvalidCollateralAccountAuthority.into());
            }

            let insurance_account_key = ctx.accounts.insurance_account.to_account_info().key;
            let (insurance_account_authority, insurance_account_nonce) =
                Pubkey::find_program_address(&[insurance_account_key.as_ref()], ctx.program_id);

            if ctx.accounts.insurance_account.owner != insurance_account_authority {
                return Err(ErrorCode::InvalidInsuranceAccountAuthority.into());
            }

            ctx.accounts.markets_account.load_init()?;
            ctx.accounts.funding_rate_history.load_init()?;
            ctx.accounts.trade_history_account.load_init()?;

            Ok(Self {
                admin: *ctx.accounts.admin.key,
                admin_controls_prices,
                collateral_account: *collateral_account_key,
                collateral_account_authority,
                collateral_account_nonce,
                funding_rate_history: *ctx.accounts.funding_rate_history.to_account_info().key,
                insurance_account: *insurance_account_key,
                insurance_account_authority,
                insurance_account_nonce,
                markets_account: *ctx.accounts.markets_account.to_account_info().key,
                margin_ratio_initial: 1000, // unit is 10% (+2 decimal places)
                margin_ratio_partial: 625,
                margin_ratio_maintenence: 500,
                trade_history_account: *ctx.accounts.trade_history_account.to_account_info().key,
                allocated_deposits: 0,
            })
        }

        #[access_control(admin(&self, &ctx.accounts.admin))]
        pub fn uninitialize_market(
            &self,
            ctx: Context<UninitializeMarket>,
            market_index: u64,
        ) -> ProgramResult {
            let markets_account = &mut ctx.accounts.markets_account.load_mut().unwrap();
            let market = &markets_account.markets[MarketsAccount::index_from_u64(market_index)];
            let now = ctx.accounts.clock.unix_timestamp;

            if market.initialized == false {
                return Err(ErrorCode::MarketIndexNotInitialized.into());
            }

            let mut mm = *market;
            mm.initialized = false;

            markets_account.markets[MarketsAccount::index_from_u64(market_index)] = mm;

            Ok(())
        }

        #[access_control(admin(&self, &ctx.accounts.admin))]
        pub fn initialize_market(
            &self,
            ctx: Context<InitializeMarket>,
            market_index: u64,
            amm_base_asset_amount: u128,
            amm_quote_asset_amount: u128,
            amm_periodicity: i64,
            amm_peg_multiplier: u128,
        ) -> ProgramResult {
            let markets_account = &mut ctx.accounts.markets_account.load_mut().unwrap();
            let market = &markets_account.markets[MarketsAccount::index_from_u64(market_index)];
            let now = ctx.accounts.clock.unix_timestamp;

            if market.initialized {
                return Err(ErrorCode::MarketIndexAlreadyInitialized.into());
            }

            if amm_peg_multiplier < MANTISSA.checked_div(10).unwrap() {
                return Err(ErrorCode::InvalidInitialPeg.into());
            }

            let init_mark_price = amm_quote_asset_amount
                .checked_mul(amm_peg_multiplier)
                .unwrap()
                .checked_div(amm_base_asset_amount)
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
                arb_volume: 0,
                creation_ts: now,
                amm: AMM {
                    oracle: *ctx.accounts.oracle.key,
                    oracle_src: OracleSource::Pyth,
                    base_asset_amount: amm_base_asset_amount,
                    quote_asset_amount: amm_quote_asset_amount,
                    k: amm_base_asset_amount
                        .checked_mul(amm_quote_asset_amount)
                        .unwrap(),
                    cum_funding_rate: 0,
                    cum_long_repeg_profit: 0,
                    cum_short_repeg_profit: 0,
                    cum_long_funding_rate: 0,
                    cum_short_funding_rate: 0,
                    funding_rate: 0,
                    funding_rate_ts: now,
                    prev_funding_rate_ts: now,
                    periodicity: amm_periodicity,
                    mark_twap: init_mark_price,
                    mark_twap_ts: now,
                    spread_threshold: 100000,
                    volume1: 0,
                    volume2: 0,
                    base_asset_amount_i: amm_base_asset_amount,
                    peg_multiplier: amm_peg_multiplier,
                    cum_slippage: 0,
                    cum_slippage_profit: 0,
                },
            };

            markets_account.markets[MarketsAccount::index_from_u64(market_index)] = market;

            Ok(())
        }

        #[access_control(
            collateral_account(&self, &ctx.accounts.clearing_house_collateral_account)
            token_program(&ctx.accounts.token_program)
            users_positions_account_matches_user_account(&ctx.accounts.user_account, &ctx.accounts.user_positions_account)
        )]
        pub fn deposit_collateral(
            &mut self,
            ctx: Context<DepositCollateral>,
            amount: u64,
        ) -> ProgramResult {
            if amount == 0 {
                return Err(ErrorCode::InsufficientDeposit.into());
            }

            let user_account = &mut ctx.accounts.user_account;
            user_account.collateral = user_account.collateral.checked_add(amount as u128).unwrap();
            user_account.initial_purchase = user_account
                .initial_purchase
                .checked_add(amount as i128)
                .unwrap();

            let markets_account = &ctx.accounts.markets_account.load().unwrap();
            let user_positions_account =
                &mut ctx.accounts.user_positions_account.load_mut().unwrap();
            let funding_rate_history = &mut ctx.accounts.funding_rate_history.load_mut().unwrap();
            _settle_funding_payment(
                user_account,
                user_positions_account,
                markets_account,
                funding_rate_history,
            );

            let cpi_accounts = Transfer {
                from: ctx
                    .accounts
                    .user_collateral_account
                    .to_account_info()
                    .clone(),
                to: ctx
                    .accounts
                    .clearing_house_collateral_account
                    .to_account_info()
                    .clone(),
                authority: ctx.accounts.authority.to_account_info().clone(),
            };
            let cpi_program = ctx.accounts.token_program.clone();
            let cpi_context = CpiContext::new(cpi_program, cpi_accounts);
            token::transfer(cpi_context, amount).unwrap();

            self.allocated_deposits = self.allocated_deposits.checked_add(amount as u128).unwrap();

            Ok(())
        }

        #[access_control(
            collateral_account(&self, &ctx.accounts.clearing_house_collateral_account)
            insurance_account(&self, &ctx.accounts.clearing_house_insurance_account)
            token_program(&ctx.accounts.token_program)
            users_positions_account_matches_user_account(&ctx.accounts.user_account, &ctx.accounts.user_positions_account)
        )]
        pub fn withdraw_collateral(
            &mut self,
            ctx: Context<WithdrawCollateral>,
            amount: u64,
        ) -> ProgramResult {
            let user_account = &mut ctx.accounts.user_account;

            let markets_account = &ctx.accounts.markets_account.load().unwrap();
            let user_positions_account =
                &mut ctx.accounts.user_positions_account.load_mut().unwrap();
            let funding_rate_history = &mut ctx.accounts.funding_rate_history.load_mut().unwrap();
            _settle_funding_payment(
                user_account,
                user_positions_account,
                markets_account,
                funding_rate_history,
            );

            if (amount as u128) > user_account.collateral {
                return Err(ErrorCode::InsufficientCollateral.into());
            }

            // todo: what is scale? test a .01% max fee on net winnings withdrawled
            let net_winnings = (user_account.collateral as i128)
                .checked_sub(user_account.initial_purchase)
                .unwrap();
            let net_winnings_fee = max(net_winnings.checked_div(10000).unwrap(), 0) as u128;

            let withdrawl_fee = min(user_account.total_potential_fee, net_winnings_fee as i128);
            user_account.total_potential_fee = user_account
                .total_potential_fee
                .checked_sub(withdrawl_fee)
                .unwrap();

            let (collateral_account_withdrawal, insurance_account_withdrawal) =
                calculate_withdrawal_amounts(
                    amount,
                    &ctx.accounts.clearing_house_collateral_account,
                    &ctx.accounts.clearing_house_insurance_account,
                );

            user_account.collateral = user_account
                .collateral
                .checked_sub(collateral_account_withdrawal as u128)
                .unwrap()
                .checked_sub(insurance_account_withdrawal as u128)
                .unwrap();

            let margin_ratio =
                calculate_margin_ratio(user_account, user_positions_account, markets_account);
            if margin_ratio < self.margin_ratio_initial {
                return Err(ErrorCode::InsufficientCollateral.into());
            }

            let signature_seeds = [
                self.collateral_account.as_ref(),
                bytemuck::bytes_of(&self.collateral_account_nonce),
            ];
            let signers = &[&signature_seeds[..]];
            let cpi_accounts = Transfer {
                from: ctx
                    .accounts
                    .clearing_house_collateral_account
                    .to_account_info()
                    .clone(),
                to: ctx
                    .accounts
                    .user_collateral_account
                    .to_account_info()
                    .clone(),
                authority: ctx
                    .accounts
                    .clearing_house_collateral_account_authority
                    .to_account_info()
                    .clone(),
            };
            let cpi_program = ctx.accounts.token_program.clone();
            let cpi_context = CpiContext::new_with_signer(cpi_program, cpi_accounts, signers);
            token::transfer(cpi_context, collateral_account_withdrawal).unwrap();

            self.allocated_deposits = self
                .allocated_deposits
                .checked_sub(collateral_account_withdrawal as u128)
                .unwrap();

            if insurance_account_withdrawal > 0 {
                let signature_seeds = [
                    self.insurance_account.as_ref(),
                    bytemuck::bytes_of(&self.insurance_account_nonce),
                ];
                let signers = &[&signature_seeds[..]];
                let cpi_accounts = Transfer {
                    from: ctx
                        .accounts
                        .clearing_house_insurance_account
                        .to_account_info()
                        .clone(),
                    to: ctx
                        .accounts
                        .user_collateral_account
                        .to_account_info()
                        .clone(),
                    authority: ctx
                        .accounts
                        .clearing_house_insurance_account_authority
                        .to_account_info()
                        .clone(),
                };
                let cpi_program = ctx.accounts.token_program.clone();
                let cpi_context = CpiContext::new_with_signer(cpi_program, cpi_accounts, signers);
                token::transfer(cpi_context, insurance_account_withdrawal).unwrap();
            }
            Ok(())
        }

        #[access_control(
            users_positions_account_matches_user_account(&ctx.accounts.user_account, &ctx.accounts.user_positions_account)
            market_initialized(&ctx.accounts.markets_account, market_index)
        )]
        pub fn open_position<'info>(
            &mut self,
            ctx: Context<OpenPosition>,
            direction: PositionDirection,
            incremental_quote_asset_notional_amount: u128,
            market_index: u64,
            limit_price: u128,
        ) -> ProgramResult {
            let user_account = &mut ctx.accounts.user_account;
            let now = ctx.accounts.clock.unix_timestamp;
            let incremental_quote_asset_notional_amount_intended =
                incremental_quote_asset_notional_amount;
            let mut incremental_quote_asset_notional_amount_partial =
                incremental_quote_asset_notional_amount;

            let user_positions_account =
                &mut ctx.accounts.user_positions_account.load_mut().unwrap();
            let funding_rate_history = &mut ctx.accounts.funding_rate_history.load_mut().unwrap();
            _settle_funding_payment(
                user_account,
                user_positions_account,
                &ctx.accounts.markets_account.load().unwrap(),
                funding_rate_history,
            );

            let mut market_position = user_positions_account
                .positions
                .iter_mut()
                .find(|market_position| market_position.market_index == market_index);

            if market_position.is_none() {
                let available_position_index = user_positions_account
                    .positions
                    .iter()
                    .position(|market_position| market_position.base_asset_amount == 0);

                if available_position_index.is_none() {
                    return Err(ErrorCode::MaxNumberOfPositions.into());
                }

                let new_market_position = MarketPosition {
                    market_index,
                    base_asset_amount: 0,
                    quote_asset_notional_amount: 0,
                    last_cum_funding: 0,
                    last_cum_repeg_profit: 0,
                };

                user_positions_account.positions[available_position_index.unwrap()] =
                    new_market_position;

                market_position =
                    Some(&mut user_positions_account.positions[available_position_index.unwrap()]);
            }

            let market_position = market_position.unwrap();
            let base_asset_amount_before = market_position.base_asset_amount;
            let mut base_asset_price_with_mantissa_before: u128;
            {
                let market = &mut ctx.accounts.markets_account.load_mut()?.markets
                    [MarketsAccount::index_from_u64(market_index)];
                base_asset_price_with_mantissa_before = market.amm.base_asset_price_with_mantissa();
            }
            let mut potentially_risk_increasing = true;
            let mut quote_asset_peg_fee = 0;

            if market_position.base_asset_amount == 0
                || market_position.base_asset_amount > 0 && direction == PositionDirection::Long
                || market_position.base_asset_amount < 0 && direction == PositionDirection::Short
            {
                let market = &mut ctx.accounts.markets_account.load_mut()?.markets
                    [MarketsAccount::index_from_u64(market_index)];

                if limit_price != 0 {
                    incremental_quote_asset_notional_amount_partial = min(
                        incremental_quote_asset_notional_amount,
                        market
                            .amm
                            .calc_target_price_trade_vector(limit_price)
                            .unsigned_abs(),
                    );
                    if incremental_quote_asset_notional_amount_partial == 0 {
                        msg!(
                            "LIMIT BECAME 0 {:?}",
                            incremental_quote_asset_notional_amount_partial
                        );
                        return Err(ErrorCode::SlippageOutsideLimit.into());
                    }
                }

                quote_asset_peg_fee = increase_position(
                    direction,
                    incremental_quote_asset_notional_amount_partial,
                    market,
                    market_position,
                    now,
                );
            } else {
                let market = &mut ctx.accounts.markets_account.load_mut()?.markets
                    [MarketsAccount::index_from_u64(market_index)];

                if limit_price != 0 {
                    incremental_quote_asset_notional_amount_partial = min(
                        incremental_quote_asset_notional_amount,
                        market
                            .amm
                            .calc_target_price_trade_vector(limit_price)
                            .unsigned_abs(),
                    );
                    if incremental_quote_asset_notional_amount_partial == 0 {
                        msg!("{:?}", incremental_quote_asset_notional_amount_partial);
                        return Err(ErrorCode::SlippageOutsideLimit.into());
                    }
                }

                let (base_asset_value, _unrealized_pnl) =
                    calculate_base_asset_value_and_pnl(market_position, &market.amm);
                // we calculate what the user's position is worth if they closed to determine
                // if they are reducing or closing and reversing their position
                if base_asset_value > incremental_quote_asset_notional_amount {
                    reduce_position(
                        direction,
                        incremental_quote_asset_notional_amount_partial,
                        user_account,
                        market,
                        market_position,
                        now,
                    );
                    potentially_risk_increasing = false;
                } else {
                    let incremental_quote_asset_notional_amount_resid =
                        incremental_quote_asset_notional_amount
                            .checked_sub(base_asset_value)
                            .unwrap();

                    if incremental_quote_asset_notional_amount_resid
                        < market_position.quote_asset_notional_amount
                    {
                        potentially_risk_increasing = false; //todo
                    }

                    close_position(user_account, market, market_position, now);

                    quote_asset_peg_fee = increase_position(
                        direction,
                        incremental_quote_asset_notional_amount_resid,
                        market,
                        market_position,
                        now,
                    );
                }
            }

            let base_asset_amount_change = market_position
                .base_asset_amount
                .checked_sub(base_asset_amount_before)
                .unwrap()
                .unsigned_abs();
            let mut base_asset_price_with_mantissa_after: u128;
            {
                let market = &mut ctx.accounts.markets_account.load_mut()?.markets
                    [MarketsAccount::index_from_u64(market_index)];
                base_asset_price_with_mantissa_after = market.amm.base_asset_price_with_mantissa();
            }
            let trade_history_account = &mut ctx.accounts.trade_history_account.load_mut()?;
            let record_id = trade_history_account.next_record_id();
            trade_history_account.append(TradeRecord {
                ts: now,
                record_id,
                user_public_key: *ctx.accounts.authority.to_account_info().key,
                user_clearing_house_public_key: *user_account.to_account_info().key,
                direction,
                base_asset_amount: base_asset_amount_change,
                quote_asset_notional_amount: incremental_quote_asset_notional_amount_partial,
                base_asset_price_with_mantissa_before,
                base_asset_price_with_mantissa_after,
                market_index,
            });

            let margin_ratio_after = calculate_margin_ratio(
                user_account,
                user_positions_account,
                &ctx.accounts.markets_account.load().unwrap(),
            );
            if margin_ratio_after < self.margin_ratio_initial && potentially_risk_increasing {
                msg!(
                    "margin ratio violation: {:?} {:?}",
                    margin_ratio_after,
                    self.margin_ratio_initial
                );
                return Err(ErrorCode::InsufficientCollateral.into());
            }

            user_account.total_potential_fee = user_account
                .total_potential_fee
                .checked_add(quote_asset_peg_fee)
                .unwrap();

            if margin_ratio_after < MARGIN_MANTISSA && potentially_risk_increasing {
                // todo: add a dol_fee/2 * leverage surcharge
                assert_eq!(margin_ratio_after > 0, true);
                let leverage = MARGIN_MANTISSA
                    .checked_mul(MANTISSA)
                    .unwrap()
                    .checked_div(margin_ratio_after)
                    .unwrap();

                let dol_fee_surcharge = (quote_asset_peg_fee as u128)
                    .checked_mul(leverage)
                    .unwrap()
                    .checked_div(MANTISSA)
                    .unwrap()
                    .checked_div(2)
                    .unwrap();

                // user_account.total_potential_fee = user_account
                // .total_potential_fee
                // .checked_add(dol_fee_surcharge)
                // .unwrap();
            }

            if limit_price != 0 {
                let market = &ctx.accounts.markets_account.load().unwrap().markets
                    [MarketsAccount::index_from_u64(market_index)];

                // todo: allow for average price limit? instead of most expensive slice?
                // todo: support partial fill
                let new_price = market.amm.base_asset_price_with_mantissa();

                // error if bought too high or sold too low
                if new_price > limit_price && direction == PositionDirection::Long
                    || new_price < limit_price && direction == PositionDirection::Short
                {
                    msg!(
                        "LIMIT2 {:?}",
                        incremental_quote_asset_notional_amount_partial
                    );
                    return Err(ErrorCode::SlippageOutsideLimit.into());
                }
            }

            // todo: should not occur
            if incremental_quote_asset_notional_amount_partial
                > incremental_quote_asset_notional_amount_intended
            {
                msg!("{:?}", incremental_quote_asset_notional_amount_partial);
                return Err(ErrorCode::SlippageOutsideLimit.into());
            }

            Ok(())
        }

        #[access_control(
            users_positions_account_matches_user_account(&ctx.accounts.user_account, &ctx.accounts.user_positions_account)
            market_initialized(&ctx.accounts.markets_account, market_index)
        )]
        pub fn close_position(
            &mut self,
            ctx: Context<ClosePosition>,
            market_index: u64,
        ) -> ProgramResult {
            let user_account = &mut ctx.accounts.user_account;
            let now = ctx.accounts.clock.unix_timestamp;

            let user_positions_account =
                &mut ctx.accounts.user_positions_account.load_mut().unwrap();
            let funding_rate_history = &mut ctx.accounts.funding_rate_history.load_mut().unwrap();
            _settle_funding_payment(
                user_account,
                user_positions_account,
                &ctx.accounts.markets_account.load().unwrap(),
                funding_rate_history,
            );

            let market_position = user_positions_account
                .positions
                .iter_mut()
                .find(|market_position| market_position.market_index == market_index);

            if market_position.is_none() {
                return Err(ErrorCode::UserHasNoPositionInMarket.into());
            }
            let market_position = market_position.unwrap();

            let market = &mut ctx.accounts.markets_account.load_mut().unwrap().markets
                [MarketsAccount::index_from_u64(market_index)];

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
            close_position(user_account, market, market_position, now);

            let base_asset_price_with_mantissa_after = market.amm.base_asset_price_with_mantissa();
            trade_history_account.append(TradeRecord {
                ts: now,
                record_id,
                user_public_key: *ctx.accounts.authority.to_account_info().key,
                user_clearing_house_public_key: *user_account.to_account_info().key,
                direction,
                base_asset_amount,
                quote_asset_notional_amount: base_asset_value,
                base_asset_price_with_mantissa_before,
                base_asset_price_with_mantissa_after,
                market_index,
            });

            Ok(())
        }

        #[access_control(
            collateral_account(&self, &ctx.accounts.clearing_house_collateral_account)
            token_program(&ctx.accounts.token_program)
            users_positions_account_matches_user_account(&ctx.accounts.user_account, &ctx.accounts.user_positions_account)
        )]
        pub fn liquidate(&self, ctx: Context<Liquidate>) -> ProgramResult {
            let user_account = &mut ctx.accounts.user_account;
            let now = ctx.accounts.clock.unix_timestamp;

            let (estimated_margin, base_asset_notional) = calculate_margin_ratio_full(
                user_account,
                &ctx.accounts.user_positions_account.load_mut().unwrap(),
                &ctx.accounts.markets_account.load().unwrap(),
            );

            let margin_ratio = _calculate_margin_ratio_inp(estimated_margin, base_asset_notional);
            if margin_ratio > self.margin_ratio_partial {
                return Err(ErrorCode::SufficientCollateral.into());
            }

            let markets_accounts = &mut ctx.accounts.markets_account.load_mut().unwrap();
            let user_positions_accounts =
                &mut ctx.accounts.user_positions_account.load_mut().unwrap();

            let mut liquidation_penalty = user_account.collateral;

            if margin_ratio <= self.margin_ratio_maintenence {
                for market_position in user_positions_accounts.positions.iter_mut() {
                    if market_position.base_asset_amount == 0 {
                        continue;
                    }

                    let market = &mut markets_accounts.markets
                        [MarketsAccount::index_from_u64(market_position.market_index)];

                    close_position(user_account, market, market_position, now)
                }
            } else {
                let trim_pct = 25;
                assert_eq!(trim_pct < 100, true); // make sure partial is partial

                for market_position in user_positions_accounts.positions.iter_mut() {
                    if market_position.base_asset_amount == 0 {
                        continue;
                    }

                    let market = &mut markets_accounts.markets
                        [MarketsAccount::index_from_u64(market_position.market_index)];

                    // remove a haircut = .25 * base_asset_notional
                    let haircut = base_asset_notional
                        .checked_mul(trim_pct)
                        .unwrap()
                        .checked_div(100)
                        .unwrap();

                    let mut direction = PositionDirection::Short;

                    if market_position.base_asset_amount < 0 {
                        direction = PositionDirection::Long;
                    }

                    reduce_position(
                        direction,
                        haircut,
                        user_account,
                        market,
                        market_position,
                        now,
                    );

                    // charge user up to 5% of their haircut notional
                    // haircut * .05 (maintence margin)
                    let max_partial_liquidation_penalty = haircut
                        .checked_mul(self.margin_ratio_maintenence.checked_div(100).unwrap()) // .05 => 5 * 100 / 10000
                        .unwrap()
                        .checked_div(100)
                        .unwrap();

                    // if market impact was high enough to bankrupt user, take all remaining collateral
                    liquidation_penalty =
                        min(user_account.collateral, max_partial_liquidation_penalty);
                }
            }

            liquidation_penalty = min(user_account.collateral, liquidation_penalty);

            let (withdrawal_amount, _) = calculate_withdrawal_amounts(
                liquidation_penalty as u64,
                &ctx.accounts.clearing_house_collateral_account,
                &ctx.accounts.clearing_house_insurance_account,
            );

            user_account.collateral = 0;
            user_account.total_potential_fee = 0;

            let split_withdrawal_amount = withdrawal_amount.checked_div(2).unwrap();
            if split_withdrawal_amount > 0 {
                let signature_seeds = [
                    self.collateral_account.as_ref(),
                    bytemuck::bytes_of(&self.collateral_account_nonce),
                ];
                let signers = &[&signature_seeds[..]];
                let cpi_accounts = Transfer {
                    from: ctx
                        .accounts
                        .clearing_house_collateral_account
                        .to_account_info()
                        .clone(),
                    to: ctx.accounts.liquidator_account.to_account_info().clone(),
                    authority: ctx
                        .accounts
                        .clearing_house_collateral_account_authority
                        .to_account_info()
                        .clone(),
                };
                let cpi_program = ctx.accounts.token_program.clone();
                let cpi_context = CpiContext::new_with_signer(cpi_program, cpi_accounts, signers);
                token::transfer(cpi_context, split_withdrawal_amount).unwrap();

                let signature_seeds = [
                    self.collateral_account.as_ref(),
                    bytemuck::bytes_of(&self.collateral_account_nonce),
                ];
                let signers = &[&signature_seeds[..]];
                let cpi_accounts = Transfer {
                    from: ctx
                        .accounts
                        .clearing_house_collateral_account
                        .to_account_info()
                        .clone(),
                    to: ctx
                        .accounts
                        .clearing_house_insurance_account
                        .to_account_info()
                        .clone(),
                    authority: ctx
                        .accounts
                        .clearing_house_collateral_account_authority
                        .to_account_info()
                        .clone(),
                };
                let cpi_program = ctx.accounts.token_program.clone();
                let cpi_context = CpiContext::new_with_signer(cpi_program, cpi_accounts, signers);
                token::transfer(cpi_context, split_withdrawal_amount).unwrap();
            }
            // todo: still need to reward liquidator a tiny amount

            Ok(())
        }

        #[access_control(
            admin(&self, &ctx.accounts.admin)
            admin_controls_prices(&self)
            market_initialized(&ctx.accounts.markets_account, market_index)
        )]
        pub fn move_amm_price(
            &self,
            ctx: Context<MoveAMMPrice>,
            base_asset_amount: u128,
            quote_asset_amount: u128,
            market_index: u64,
        ) -> ProgramResult {
            let now = ctx.accounts.clock.unix_timestamp;

            let markets_account = &mut ctx.accounts.markets_account.load_mut().unwrap();
            let market = &mut markets_account.markets[MarketsAccount::index_from_u64(market_index)];
            market.amm.move_price(base_asset_amount, quote_asset_amount);
            Ok(())
        }

        #[access_control(
            admin(&self, &ctx.accounts.admin)
            admin_controls_prices(&self)
            market_initialized(&ctx.accounts.markets_account, market_index)
        )]
        pub fn admin_withdraw_collateral(
            &self,
            ctx: Context<AdminWithdrawCollateral>,
            amount: u64,
            market_index: u64,
        ) -> ProgramResult {
            let markets_account = &mut ctx.accounts.markets_account.load_mut().unwrap();
            let market = &mut markets_account.markets[MarketsAccount::index_from_u64(market_index)];

            let max_withdraw = self
                .allocated_deposits
                .checked_sub(market.amm.cum_slippage_profit)
                .unwrap();
            if amount <= max_withdraw as u64 {
                let signature_seeds = [
                    self.collateral_account.as_ref(),
                    bytemuck::bytes_of(&self.collateral_account_nonce),
                ];
                let signers = &[&signature_seeds[..]];
                let cpi_accounts = Transfer {
                    from: ctx
                        .accounts
                        .clearing_house_collateral_account
                        .to_account_info()
                        .clone(),
                    to: ctx
                        .accounts
                        .clearing_house_insurance_account
                        .to_account_info()
                        .clone(),
                    authority: ctx
                        .accounts
                        .clearing_house_collateral_account_authority
                        .to_account_info()
                        .clone(),
                };
                let cpi_program = ctx.accounts.token_program.clone();
                let cpi_context = CpiContext::new_with_signer(cpi_program, cpi_accounts, signers);
                token::transfer(cpi_context, amount).unwrap();
            }

            Ok(())
        }

        #[access_control(
            market_initialized(&ctx.accounts.markets_account, market_index)
            // admin(&self, &ctx.accounts.admin)
        )]
        pub fn repeg_amm_curve(
            &self,
            ctx: Context<RepegCurve>,
            new_peg: u128,
            market_index: u64,
        ) -> ProgramResult {
            let now = ctx.accounts.clock.unix_timestamp;
            let market = &mut ctx.accounts.markets_account.load_mut()?.markets
                [MarketsAccount::index_from_u64(market_index)];
            let amm = &mut market.amm;
            if new_peg == amm.peg_multiplier {
                msg!("InvalidRepegRedundant1");
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
                    msg!("InvalidRepegRedundant");
                    return Err(ErrorCode::InvalidRepegRedundant.into());
                }
            }

            let price_spread_0 = (cur_peg as i128).checked_sub(oracle_px).unwrap();
            let price_spread_1 = (new_peg_candidate as i128).checked_sub(oracle_px).unwrap();

            // if price_spread_1.abs() > price_spread_0.abs() {
            //     // decrease
            //     return Err(ErrorCode::InvalidRepegDirection.into());
            // }

            let mut pnl_r = amm.cum_slippage_profit;
            //todo: replace with Market.base_asset_amount
            let base_asset_amount_i = amm.base_asset_amount_i as i128;
            let market_position = base_asset_amount_i
                .checked_sub(amm.base_asset_amount as i128)
                .unwrap();

            let mut pnl: i128 = 0;
            if new_peg_candidate > cur_peg {
                pnl = (new_peg_candidate.checked_sub(cur_peg).unwrap() as i128)
                    .checked_mul(market_position)
                    .unwrap();
            } else {
                pnl = (cur_peg.checked_sub(new_peg_candidate).unwrap() as i128)
                    .checked_mul(market_position)
                    .unwrap();
            }

            // assert_ne!(pnl, 0);

            if pnl > 0 {
                pnl_r = pnl_r.checked_add(pnl.abs() as u128).unwrap();
            } else if pnl.abs() as u128 > pnl_r {
                msg!("InvalidRepegProfitability");
                return Err(ErrorCode::InvalidRepegProfitability.into());
            } else {
                pnl_r = (pnl_r).checked_sub(pnl.unsigned_abs()).unwrap();

                // profit sharing with only those who held the rewarded position before repeg
                if new_peg_candidate > amm.peg_multiplier {
                    let repeg_profit_per_unit = pnl
                        .unsigned_abs()
                        .checked_div(market.base_asset_amount_short.unsigned_abs())
                        .unwrap();
                    amm.cum_short_repeg_profit = amm
                        .cum_short_repeg_profit
                        .checked_add(repeg_profit_per_unit)
                        .unwrap();
                } else {
                    let repeg_profit_per_unit = pnl
                        .unsigned_abs()
                        .checked_div(market.base_asset_amount_long.unsigned_abs())
                        .unwrap();
                    amm.cum_long_repeg_profit = amm
                        .cum_long_repeg_profit
                        .checked_add(repeg_profit_per_unit)
                        .unwrap();
                }

                if pnl_r < amm.cum_slippage.checked_div(2).unwrap() {
                    msg!("InvalidRepegProfitability2");
                    return Err(ErrorCode::InvalidRepegProfitability.into());
                }
            }

            amm.cum_slippage_profit = pnl_r;
            amm.peg_multiplier = new_peg_candidate;
            amm.move_to_price(current_mark);

            Ok(())
        }
    }

    pub fn initialize_user_account(
        ctx: Context<InitializeUserAccount>,
        _user_account_nonce: u8,
    ) -> ProgramResult {
        let now = ctx.accounts.clock.unix_timestamp;
        let user_account = &mut ctx.accounts.user_account;
        user_account.authority = *ctx.accounts.authority.key;
        user_account.collateral = 0;
        user_account.initial_purchase = 0;
        user_account.positions = *ctx.accounts.user_positions_account.to_account_info().key;
        user_account.creation_ts = now;

        let user_positions_account = &mut ctx.accounts.user_positions_account.load_init()?;
        user_positions_account.user_account = *ctx.accounts.user_account.to_account_info().key;

        Ok(())
    }

    pub fn settle_funding_payment(ctx: Context<SettleFunding>) -> ProgramResult {
        _settle_funding_payment(
            &mut ctx.accounts.user_account,
            &mut ctx.accounts.user_positions_account.load_mut().unwrap(),
            &ctx.accounts.markets_account.load().unwrap(),
            &mut ctx.accounts.funding_rate_history.load_mut().unwrap(),
        );
        Ok(())
    }

    #[access_control(
        market_initialized(&ctx.accounts.markets_account, market_index)
    )]
    pub fn update_funding_rate(
        ctx: Context<UpdateFundingRate>,
        market_index: u64,
    ) -> ProgramResult {
        let market = &mut ctx.accounts.markets_account.load_mut()?.markets
            [MarketsAccount::index_from_u64(market_index)];

        let price_oracle = &ctx.accounts.oracle;

        let now = ctx.accounts.clock.unix_timestamp;
        let time_since_last_update = now - market.amm.funding_rate_ts;

        market.amm.mark_twap = market.amm.get_new_twap(now);
        market.amm.mark_twap_ts = now;

        if time_since_last_update >= market.amm.periodicity {
            let one_hour: u32 = 3600;
            let period_adjustment = (24_i64)
                .checked_mul(one_hour as i64)
                .unwrap()
                .checked_div(max(1, market.amm.periodicity))
                .unwrap();
            // funding period = 1 hour, window = 1 day
            // low periodicity => quickly updating/settled funding rates => lower funding rate payment per interval
            let price_spread = market.amm.get_oracle_mark_spread(price_oracle, one_hour);
            let funding_rate = price_spread
                .checked_mul(FUNDING_MANTISSA as i128)
                .unwrap()
                .checked_div(period_adjustment as i128)
                .unwrap();

            let mut haircut_numerator = 0;

            if market.base_asset_amount == 0 {
                market.amm.cum_long_funding_rate = market
                    .amm
                    .cum_long_funding_rate
                    .checked_add(funding_rate)
                    .unwrap();

                market.amm.cum_short_funding_rate = market
                    .amm
                    .cum_short_funding_rate
                    .checked_add(funding_rate)
                    .unwrap();
            } else if market.base_asset_amount > 0 {
                // assert(market.base_asset_amount_long > market.base_asset_amount);
                // more longs that shorts

                if market.base_asset_amount_short.unsigned_abs() > 0 {
                    haircut_numerator = market.base_asset_amount_short.unsigned_abs();
                }

                let funding_rate_long_haircut = haircut_numerator
                    .checked_mul(MANTISSA)
                    .unwrap()
                    .checked_div(market.base_asset_amount_long as u128)
                    .unwrap();

                let funding_rate_long = funding_rate
                    .checked_mul(funding_rate_long_haircut as i128)
                    .unwrap()
                    .checked_div(MANTISSA as i128)
                    .unwrap();

                market.amm.cum_long_funding_rate = market
                    .amm
                    .cum_long_funding_rate
                    .checked_add(funding_rate_long)
                    .unwrap();

                market.amm.cum_short_funding_rate = market
                    .amm
                    .cum_short_funding_rate
                    .checked_add(funding_rate)
                    .unwrap();
            } else {
                // more shorts than longs
                if market.base_asset_amount_long.unsigned_abs() > 0 {
                    haircut_numerator = market.base_asset_amount_long.unsigned_abs();
                }

                let funding_rate_short_haircut = haircut_numerator
                    .checked_mul(MANTISSA)
                    .unwrap()
                    .checked_div(market.base_asset_amount_short.unsigned_abs())
                    .unwrap();

                let funding_rate_short = funding_rate
                    .checked_mul(funding_rate_short_haircut as i128)
                    .unwrap()
                    .checked_div(MANTISSA as i128)
                    .unwrap();

                market.amm.cum_short_funding_rate = market
                    .amm
                    .cum_short_funding_rate
                    .checked_add(funding_rate_short)
                    .unwrap();

                market.amm.cum_long_funding_rate = market
                    .amm
                    .cum_long_funding_rate
                    .checked_add(funding_rate)
                    .unwrap();
            }

            let cum_funding_rate = market
                .amm
                .cum_funding_rate
                .checked_add(funding_rate)
                .unwrap();

            market.amm.cum_funding_rate = cum_funding_rate;
            market.amm.funding_rate = funding_rate;
            market.amm.prev_funding_rate_ts = market.amm.funding_rate_ts;
            market.amm.funding_rate_ts = now;
            // todo: is unused anyways? (funding_rate_ts-mark_twap_ts = 0)
            market.amm.mark_twap = market.amm.base_asset_price_with_mantissa();
            market.amm.mark_twap_ts = now;
        }

        Ok(())
    }
}

#[derive(Accounts)]
pub struct InitializeClearingHouse<'info> {
    #[account(signer)]
    pub admin: AccountInfo<'info>,
    pub collateral_account: CpiAccount<'info, TokenAccount>,
    pub insurance_account: CpiAccount<'info, TokenAccount>,
    #[account(init)]
    pub markets_account: Loader<'info, MarketsAccount>,
    #[account(init)]
    pub funding_rate_history: Loader<'info, FundingRateHistory>,
    #[account(init)]
    pub trade_history_account: Loader<'info, TradeHistoryAccount>,
    pub rent: Sysvar<'info, Rent>,
}

#[derive(Accounts)]
#[instruction(user_account_nonce: u8)]
pub struct InitializeUserAccount<'info> {
    #[account(
        init,
        seeds = [b"user", authority.key.as_ref(), &[user_account_nonce]],
        payer = authority
    )]
    pub user_account: ProgramAccount<'info, UserAccount>,
    #[account(init)]
    pub user_positions_account: Loader<'info, UserPositionsAccount>,
    #[account(signer)]
    pub authority: AccountInfo<'info>,
    pub rent: Sysvar<'info, Rent>,
    pub system_program: AccountInfo<'info>,

    pub clock: Sysvar<'info, Clock>,
}

#[derive(Accounts)]
pub struct InitializeMarket<'info> {
    #[account(signer)]
    pub admin: AccountInfo<'info>,
    #[account(mut)]
    pub markets_account: Loader<'info, MarketsAccount>,
    pub oracle: AccountInfo<'info>,

    pub clock: Sysvar<'info, Clock>,
}

#[derive(Accounts)]
pub struct UninitializeMarket<'info> {
    #[account(signer)]
    pub admin: AccountInfo<'info>,
    #[account(mut)]
    pub markets_account: Loader<'info, MarketsAccount>,
    pub clock: Sysvar<'info, Clock>,
}

#[derive(Accounts)]
pub struct DepositCollateral<'info> {
    #[account(mut, has_one = authority)]
    pub user_account: ProgramAccount<'info, UserAccount>,
    #[account(signer)]
    pub authority: AccountInfo<'info>,
    #[account(mut)]
    pub clearing_house_collateral_account: CpiAccount<'info, TokenAccount>,
    #[account(mut)]
    pub user_collateral_account: CpiAccount<'info, TokenAccount>,
    pub token_program: AccountInfo<'info>,
    pub markets_account: Loader<'info, MarketsAccount>,
    #[account(mut)]
    pub user_positions_account: Loader<'info, UserPositionsAccount>,
    #[account(mut)]
    pub funding_rate_history: Loader<'info, FundingRateHistory>,
}

#[derive(Accounts)]
pub struct WithdrawCollateral<'info> {
    #[account(mut, has_one = authority)]
    pub user_account: ProgramAccount<'info, UserAccount>,
    #[account(signer)]
    pub authority: AccountInfo<'info>,
    #[account(mut)]
    pub clearing_house_collateral_account: CpiAccount<'info, TokenAccount>,
    pub clearing_house_collateral_account_authority: AccountInfo<'info>,
    #[account(mut)]
    pub clearing_house_insurance_account: CpiAccount<'info, TokenAccount>,
    pub clearing_house_insurance_account_authority: AccountInfo<'info>,
    #[account(mut)]
    pub user_collateral_account: CpiAccount<'info, TokenAccount>,
    pub token_program: AccountInfo<'info>,
    pub markets_account: Loader<'info, MarketsAccount>,
    #[account(mut)]
    pub user_positions_account: Loader<'info, UserPositionsAccount>,
    #[account(mut)]
    pub funding_rate_history: Loader<'info, FundingRateHistory>,
}

#[derive(Accounts)]
pub struct AdminWithdrawCollateral<'info> {
    #[account(signer)]
    pub admin: AccountInfo<'info>,
    #[account(mut)]
    pub clearing_house_collateral_account: CpiAccount<'info, TokenAccount>,
    pub clearing_house_collateral_account_authority: AccountInfo<'info>,
    #[account(mut)]
    pub clearing_house_insurance_account: CpiAccount<'info, TokenAccount>,
    pub clearing_house_insurance_account_authority: AccountInfo<'info>,
    #[account(mut)]
    pub token_program: AccountInfo<'info>,
    pub markets_account: Loader<'info, MarketsAccount>,
}

#[derive(Accounts)]
pub struct OpenPosition<'info> {
    #[account(mut, has_one = authority)]
    pub user_account: ProgramAccount<'info, UserAccount>,
    #[account(signer)]
    pub authority: AccountInfo<'info>,
    #[account(mut)]
    pub markets_account: Loader<'info, MarketsAccount>,
    #[account(mut)]
    pub user_positions_account: Loader<'info, UserPositionsAccount>,
    #[account(mut)]
    pub trade_history_account: Loader<'info, TradeHistoryAccount>,
    #[account(mut)]
    pub funding_rate_history: Loader<'info, FundingRateHistory>,
    pub clock: Sysvar<'info, Clock>,
}

#[derive(Accounts)]
pub struct ClosePosition<'info> {
    #[account(mut, has_one = authority)]
    pub user_account: ProgramAccount<'info, UserAccount>,
    #[account(signer)]
    pub authority: AccountInfo<'info>,
    #[account(mut)]
    pub markets_account: Loader<'info, MarketsAccount>,
    #[account(mut)]
    pub user_positions_account: Loader<'info, UserPositionsAccount>,
    #[account(mut)]
    pub trade_history_account: Loader<'info, TradeHistoryAccount>,
    #[account(mut)]
    pub funding_rate_history: Loader<'info, FundingRateHistory>,
    pub clock: Sysvar<'info, Clock>,
}

#[derive(Accounts)]
pub struct Liquidate<'info> {
    #[account(signer)]
    pub liquidator: AccountInfo<'info>,
    #[account(mut)]
    pub user_account: ProgramAccount<'info, UserAccount>,
    pub liquidator_user_account: ProgramAccount<'info, UserAccount>,
    #[account(mut)]
    pub clearing_house_collateral_account: CpiAccount<'info, TokenAccount>,
    pub clearing_house_collateral_account_authority: AccountInfo<'info>,
    #[account(mut)]
    pub clearing_house_insurance_account: CpiAccount<'info, TokenAccount>,
    pub clearing_house_insurance_account_authority: AccountInfo<'info>,
    #[account(mut)]
    pub liquidator_account: CpiAccount<'info, TokenAccount>,
    pub token_program: AccountInfo<'info>,
    #[account(mut)]
    pub markets_account: Loader<'info, MarketsAccount>,
    #[account(mut)]
    pub user_positions_account: Loader<'info, UserPositionsAccount>,

    pub clock: Sysvar<'info, Clock>,
}

#[derive(Accounts)]
pub struct SettleFunding<'info> {
    #[account(mut)]
    pub user_account: ProgramAccount<'info, UserAccount>,
    pub markets_account: Loader<'info, MarketsAccount>,
    #[account(mut)]
    pub user_positions_account: Loader<'info, UserPositionsAccount>,
    #[account(mut)]
    pub funding_rate_history: Loader<'info, FundingRateHistory>,
}

#[derive(Accounts)]
pub struct UpdateFundingRate<'info> {
    #[account(mut)]
    pub markets_account: Loader<'info, MarketsAccount>,
    pub oracle: AccountInfo<'info>,
    pub clock: Sysvar<'info, Clock>,

    #[account(mut)]
    pub clearing_house_insurance_account: CpiAccount<'info, TokenAccount>,
    pub clearing_house_insurance_account_authority: AccountInfo<'info>,
}

#[derive(Accounts)]
pub struct RepegCurve<'info> {
    #[account(mut)]
    pub markets_account: Loader<'info, MarketsAccount>,
    pub oracle: AccountInfo<'info>,
    #[account(signer)]
    pub admin: AccountInfo<'info>,

    pub clock: Sysvar<'info, Clock>,
}

#[derive(Accounts)]
pub struct MoveAMMPrice<'info> {
    #[account(signer)]
    pub admin: AccountInfo<'info>,
    #[account(mut)]
    pub markets_account: Loader<'info, MarketsAccount>,

    pub clock: Sysvar<'info, Clock>,
}

#[associated]
#[derive(Default)]
pub struct UserAccount {
    pub authority: Pubkey,
    pub collateral: u128,
    pub initial_purchase: i128,
    pub total_potential_fee: i128,
    pub positions: Pubkey,

    pub creation_ts: i64,
}

#[account(zero_copy)]
pub struct UserPositionsAccount {
    pub user_account: Pubkey,
    pub positions: [MarketPosition; 10],
}

#[account(zero_copy)]
pub struct TradeHistoryAccount {
    head: u64,
    trade_records: [TradeRecord; 1000],
}

impl TradeHistoryAccount {
    fn append(&mut self, pos: TradeRecord) {
        self.trade_records[TradeHistoryAccount::index_of(self.head)] = pos;
        self.head = (self.head + 1) % 1000;
    }
    fn index_of(counter: u64) -> usize {
        std::convert::TryInto::try_into(counter).unwrap()
    }

    fn next_record_id(&self) -> u128 {
        let prev_trade_id = if self.head == 0 { 999 } else { self.head - 1 };
        let prev_trade = &self.trade_records[TradeHistoryAccount::index_of(prev_trade_id)];
        return prev_trade.record_id + 1;
    }
}

#[zero_copy]
pub struct TradeRecord {
    pub ts: i64,
    pub record_id: u128,
    pub user_public_key: Pubkey,
    pub user_clearing_house_public_key: Pubkey,
    pub direction: PositionDirection,
    pub base_asset_amount: u128,
    pub quote_asset_notional_amount: u128,
    pub base_asset_price_with_mantissa_before: u128,
    pub base_asset_price_with_mantissa_after: u128,
    pub market_index: u64,
}

#[derive(Clone, Copy)]
pub enum OracleSource {
    Pyth,
    Switchboard,
}

#[account(zero_copy)]
pub struct MarketsAccount {
    pub account_index: u64,
    pub markets: [Market; 1000],
}

impl MarketsAccount {
    pub fn index_from_u64(index: u64) -> usize {
        return std::convert::TryInto::try_into(index).unwrap();
    }
}

#[zero_copy]
pub struct Market {
    pub initialized: bool,
    pub base_asset_amount_long: i128,
    pub base_asset_amount_short: i128,
    pub base_asset_amount: i128,           // net market bias
    pub quote_asset_notional_amount: u128, //outstanding notional?
    pub open_interest: u128,               // number of users in a position
    pub base_asset_volume: u128,           // amt of base asset volume since inception
    pub peg_quote_asset_volume: u128,      // amt of quote asset volume since inception
    pub arb_volume: u128,                  // amt of volume bringing mark -> oracle
    pub amm: AMM,

    pub creation_ts: i64,
    // todo: margin requirement per market
    // unit scale: 20% == 2000
    // pub margin_ratio_i: u128, // initial
    // pub margin_ratio_p: u128, // partial
    // pub margin_ratio_m: u128, // maintenance
}

#[zero_copy]
pub struct AMM {
    pub oracle: Pubkey,
    pub oracle_src: OracleSource,
    pub base_asset_amount: u128,
    pub quote_asset_amount: u128,
    pub k: u128,
    pub cum_funding_rate: i128,
    pub cum_long_repeg_profit: u128,
    pub cum_short_repeg_profit: u128,
    pub cum_long_funding_rate: i128,
    pub cum_short_funding_rate: i128,
    pub funding_rate: i128,
    pub funding_rate_ts: i64,
    pub prev_funding_rate_ts: i64,
    pub periodicity: i64,
    pub mark_twap: u128,
    pub mark_twap_ts: i64,
    pub spread_threshold: u64,

    pub volume1: u128,
    pub volume2: u128,
    pub base_asset_amount_i: u128,
    pub peg_multiplier: u128,      // amm equilibrium price
    pub cum_slippage: u128,        //re-pegging
    pub cum_slippage_profit: u128, //re-pegging
}

impl AMM {
    pub fn swap_quote_asset_with_fee(
        &mut self,
        quote_asset_swap_amount: u128,
        direction: SwapDirection,
        now: i64,
    ) -> (i128, i128) {
        // fee inspired by https://curve.fi/files/crypto-pools-paper.pdf

        let unpegged_quote_asset_amount = quote_asset_swap_amount
            .checked_mul(MANTISSA)
            .unwrap()
            .checked_div(self.peg_multiplier)
            .unwrap();
        assert_ne!(unpegged_quote_asset_amount, 0);

        let initial_base_asset_amount = self.base_asset_amount;
        let (new_base_asset_amount, new_quote_asset_amount) = AMM::find_swap_output(
            unpegged_quote_asset_amount,
            self.quote_asset_amount,
            direction,
            self.k,
        );

        let thousand: u128 = 1000;

        let lambda_fee: u128 = 1;
        let cp_prod = new_base_asset_amount
            .checked_mul(new_quote_asset_amount)
            .unwrap();
        let cs_sum = new_base_asset_amount
            .checked_add(new_quote_asset_amount)
            .unwrap();
        let g_fee_denom_1 = cp_prod
            .checked_mul(thousand)
            .unwrap()
            .checked_div(cs_sum.checked_div(2).unwrap().checked_pow(2).unwrap())
            .unwrap();

        let g_fee_denom = lambda_fee
            .checked_add(thousand.checked_sub(g_fee_denom_1).unwrap())
            .unwrap();
        let g_fee = lambda_fee
            .checked_mul(thousand)
            .unwrap()
            .checked_div(g_fee_denom)
            .unwrap();

        let g_fee_recip = thousand.checked_sub(g_fee).unwrap();

        let f_mid: u128 = 50; // .5 bps, .005%
        let f_out: u128 = 200; // 20 bps, .2%
        let f = f_mid
            .checked_mul(g_fee)
            .unwrap()
            .checked_add(f_out.checked_mul(g_fee_recip).unwrap())
            .unwrap();
        let fee = quote_asset_swap_amount
            .checked_mul(f)
            .unwrap()
            .checked_div(thousand)
            .unwrap();

        //todo, change and pass spec test
        let quote_asset_swap_amount_fee = 0;
        // let quote_asset_swap_amount_fee = fee.checked_div(MANTISSA).unwrap();
        let quote_asset_swap_amount_less_fee = quote_asset_swap_amount
            .checked_sub(quote_asset_swap_amount_fee)
            .unwrap();

        let acquired_base_asset_amount =
            self.swap_quote_asset(quote_asset_swap_amount_less_fee, direction, now);

        self.cum_slippage = self.cum_slippage.checked_add(fee).unwrap();
        self.cum_slippage_profit = self.cum_slippage_profit.checked_add(fee).unwrap();

        let fee_unpaid = fee.checked_sub(quote_asset_swap_amount_fee).unwrap();

        return (acquired_base_asset_amount, fee_unpaid as i128);
    }

    pub fn swap_quote_asset(
        &mut self,
        quote_asset_swap_amount: u128,
        direction: SwapDirection,
        now: i64,
    ) -> i128 {
        let unpegged_quote_asset_amount = quote_asset_swap_amount
            .checked_mul(MANTISSA)
            .unwrap()
            .checked_div(self.peg_multiplier)
            .unwrap();

        // min tick size a funciton of the peg.
        // 1000000 (expo 6) units of USDC = $1
        // ex: peg=40000 => min tick size of $1 / (1000000/40000) = $.04
        // my understanding is orders will be shrunk to the lowest tick size
        assert_ne!(unpegged_quote_asset_amount, 0);

        let initial_base_asset_amount = self.base_asset_amount;
        let (new_base_asset_amount, new_quote_asset_amount) = AMM::find_swap_output(
            unpegged_quote_asset_amount,
            self.quote_asset_amount,
            direction,
            self.k,
        );

        self.base_asset_amount = new_base_asset_amount;
        self.quote_asset_amount = new_quote_asset_amount;

        self.mark_twap = self.get_new_twap(now);
        self.mark_twap_ts = now;

        return (initial_base_asset_amount as i128)
            .checked_sub(new_base_asset_amount as i128)
            .unwrap();
    }

    pub fn swap_base_asset(
        &mut self,
        base_asset_swap_amount: u128,
        direction: SwapDirection,
        now: i64,
    ) {
        let (new_quote_asset_amount, new_base_asset_amount) = AMM::find_swap_output(
            base_asset_swap_amount,
            self.base_asset_amount,
            direction,
            self.k,
        );
        self.mark_twap = self.get_new_twap(now);
        self.mark_twap_ts = now;

        self.base_asset_amount = new_base_asset_amount;
        self.quote_asset_amount = new_quote_asset_amount;
    }

    fn find_swap_output(
        swap_amount: u128,
        input_asset_amount: u128,
        direction: SwapDirection,
        invariant: u128,
    ) -> (u128, u128) {
        let new_input_amount = match direction {
            SwapDirection::Add => input_asset_amount.checked_add(swap_amount).unwrap(),
            SwapDirection::Remove => input_asset_amount.checked_sub(swap_amount).unwrap(),
        };

        let new_output_amount = invariant.checked_div(new_input_amount).unwrap();

        return (new_output_amount, new_input_amount);
    }

    fn find_swap_output_and_pnl(
        self,
        base_swap_amount: u128,
        quote_asset_notional_amount: u128,
        direction: SwapDirection,
    ) -> (u128, i128) {
        let initial_quote_asset_amount = self.quote_asset_amount;

        let (new_quote_asset_amount, new_base_asset_amount) =
            AMM::find_swap_output(base_swap_amount, self.base_asset_amount, direction, self.k);

        let mut quote_asset_acquired = match direction {
            SwapDirection::Add => initial_quote_asset_amount
                .checked_sub(new_quote_asset_amount)
                .unwrap(),

            SwapDirection::Remove => new_quote_asset_amount
                .checked_sub(initial_quote_asset_amount)
                .unwrap(),
        };

        quote_asset_acquired = quote_asset_acquired
            .checked_mul(self.peg_multiplier)
            .unwrap()
            .checked_div(MANTISSA)
            .unwrap();

        let mut pnl = match direction {
            SwapDirection::Add => (quote_asset_acquired as i128)
                .checked_sub(quote_asset_notional_amount as i128)
                .unwrap(),

            SwapDirection::Remove => (quote_asset_notional_amount as i128)
                .checked_sub(quote_asset_acquired as i128)
                .unwrap(),
        };

        return (quote_asset_acquired, pnl);
    }

    pub fn base_asset_price_with_mantissa(&self) -> u128 {
        let ast_px = self
            .quote_asset_amount
            .checked_mul(self.peg_multiplier)
            .unwrap()
            .checked_div(self.base_asset_amount)
            .unwrap();
        return ast_px;
    }

    pub fn get_switchboard_price(&self, price_oracle: &AccountInfo, window: u32) -> (i128, u128) {
        // todo: switchboard roadmap for twap
        // assert_eq!(window, 0);

        // let switchboard_feed_account = price_oracle;
        // // use switchboard_program::{
        // //     get_aggregator, get_aggregator_result, AggregatorState, FastRoundResultAccountData,
        // //     RoundResult, SwitchboardAccountType,
        // // };

        // let mut out = 0.0;
        // let account_buf = switchboard_feed_account.try_borrow_data().unwrap();
        // if account_buf.len() == 0 {
        //     msg!("The provided account is empty.");
        //     // return Err(ErrorCode::InvalidOracle.into());
        // }
        // if account_buf[0] == switchboard_program::SwitchboardAccountType::TYPE_AGGREGATOR as u8 {
        //     let aggregator: switchboard_program::AggregatorState =
        //         switchboard_program::get_aggregator(switchboard_feed_account)
        //             .map_err(|e| {
        //                 msg!("Aggregator parse failed. Please double check the provided address.");
        //                 return e;
        //             })
        //             .unwrap();
        //     let round_result: switchboard_program::RoundResult = switchboard_program::get_aggregator_result(&aggregator)
        //         .map_err(|e| {
        //             msg!("Failed to parse an aggregator round. Has update been called on the aggregator?");
        //             return e;
        //         }).unwrap();
        //     out = round_result.result.unwrap_or(0.0);
        //     // out = feed_data.result;
        // } else if account_buf[0]
        //     == switchboard_program::SwitchboardAccountType::TYPE_AGGREGATOR_RESULT_PARSE_OPTIMIZED
        //         as u8
        // {
        //     let feed_data =
        //         switchboard_program::FastRoundResultAccountData::deserialize(&account_buf).unwrap();
        //     out = feed_data.result.result;
        //     // out = feed_data.result;
        // } else {
        //     // return Err(ErrorCode::InvalidOracle.into());
        // }
        // // msg!("Current feed result is {}!", &lexical::to_string(out));

        // return out as i128;
        return (0, 0);
    }

    pub fn get_pyth_price(&self, price_oracle: &AccountInfo, window: u32) -> (i128, u128) {
        let pyth_price_data = price_oracle.try_borrow_data().unwrap();
        let price_data = pyth_client::cast::<pyth_client::Price>(&pyth_price_data);

        // todo: support some interpolated number based on window_size
        // currently only support (0, 1hour+] (since funding_rate_ts)
        // window can check spread over a time window instead
        let oracle_price = if window > 0 {
            price_data.twap.val as i128
        } else {
            price_data.agg.price as i128
        };

        let oracle_conf = if window > 0 {
            price_data.twac.val as u128
        } else {
            price_data.agg.conf as u128
        };

        let oracle_mantissa = 10_u128.pow(price_data.expo.unsigned_abs());

        let oracle_price_scaled = (oracle_price)
            .checked_mul(MANTISSA as i128)
            .unwrap()
            .checked_div(oracle_mantissa as i128)
            .unwrap();
        let oracle_conf_scaled = (oracle_conf)
            .checked_mul(MANTISSA)
            .unwrap()
            .checked_div(oracle_mantissa)
            .unwrap();

        return (oracle_price_scaled, oracle_conf_scaled);
    }

    pub fn get_oracle_price(&self, price_oracle: &AccountInfo, window: u32) -> (i128, u128) {
        let (oracle_px, oracle_conf) = match self.oracle_src {
            OracleSource::Pyth => self.get_pyth_price(price_oracle, window),
            OracleSource::Switchboard => self.get_switchboard_price(price_oracle, window),
        };
        return (oracle_px, oracle_conf);
    }

    pub fn get_new_twap(&self, now: i64) -> u128 {
        let since_last = max(1, now - self.mark_twap_ts);
        let since_start = max(1, self.mark_twap_ts - self.funding_rate_ts);
        let denom = (since_last + since_start) as u128;

        let mark_mantissa = 1; // todo store and then reset to equal oracle after each funding rate update

        let prev_twap_99 = self.mark_twap.checked_mul(since_start as u128).unwrap();
        let latest_price_01 = self
            .base_asset_price_with_mantissa()
            .checked_mul(since_last as u128)
            .unwrap();
        let new_twap = prev_twap_99
            .checked_add(latest_price_01 as u128)
            .unwrap()
            .checked_div(denom)
            .unwrap();
        return new_twap;
    }

    pub fn get_oracle_mark_spread(&self, price_oracle: &AccountInfo, window: u32) -> i128 {
        let pyth_price_data = price_oracle.try_borrow_data().unwrap();
        let price_data = pyth_client::cast::<pyth_client::Price>(&pyth_price_data);
        let oracle_mantissa = 10_u128.pow(price_data.expo.unsigned_abs());

        let oracle_price = (price_data.agg.price as i128)
            .checked_mul(MANTISSA as i128)
            .unwrap()
            .checked_div(oracle_mantissa as i128)
            .unwrap();
        let mark_price = self.base_asset_price_with_mantissa() as i128;

        // todo: support some interpolated number based on window_size
        // currently only support (0, 1hour+] (since funding_rate_ts)
        // window can check spread over a time window instead
        if window > 0 {
            let oracle_price = (price_data.twap.val as i128)
                .checked_mul(MANTISSA as i128)
                .unwrap()
                .checked_div(oracle_mantissa as i128)
                .unwrap();

            //todo: update .mark_twap on the fly and check 1. clock_diff 2. conf band with oracle

            // let mark_price = self.get_new_twap(now);
            // let clock_diff = price_data.time_since_last_update;

            let mark_price = self.mark_twap as i128;
        }

        let funding_numerator = mark_price.checked_sub(oracle_price).unwrap();
        let funding_denominator = oracle_price;

        let price_spread: i128;
        if funding_denominator.abs() > funding_numerator.abs() {
            price_spread = funding_numerator
                .checked_mul(MANTISSA as i128)
                .unwrap()
                .checked_div(funding_denominator)
                .unwrap();
        } else {
            price_spread = funding_numerator
                .checked_mul(MANTISSA as i128)
                .unwrap()
                .checked_div(funding_denominator)
                .unwrap();
        }

        return price_spread;
    }

    pub fn is_arb_trade(&self, price_oracle: &AccountInfo, base_asset_amount: i128) -> bool {
        // arb_op > 0 -> mark > oracle
        let arb_op = self.get_oracle_mark_spread(price_oracle, 0);

        // todo: calculate post_trade arb
        if arb_op < 0 {
            return base_asset_amount > 0;
        } else {
            return base_asset_amount < 0;
        }
    }

    pub fn is_spread_limit(&self, price_oracle: &AccountInfo, now: i64) -> [bool; 2] {
        // set a limit up and limit down as guard rails for risk increasing orders
        // risk increasing order = non-reducing `open_position`

        let percentage_threshold = self.spread_threshold;
        let current_spread = self.get_oracle_mark_spread(price_oracle, 0);

        return [
            current_spread > percentage_threshold as i128, // limit_up
            current_spread < -1 * percentage_threshold as i128, // limit_down
        ];
    }

    pub fn estimated_next_funding_rate(&self, price_oracle: &AccountInfo, now: i64) -> i128 {
        // let now = ctx.accounts.clock.unix_timestamp;
        let time_since_last_update = now - self.funding_rate_ts;

        // should always be true
        if time_since_last_update < self.periodicity {
            // todo: call update_funding_rate here?
            // self.update_funding_rate()
            return 0;
        } else {
            let one_hour = 3600;
            let period_adjustment = 24; // funding period = 1 hour, window = 1 day

            let price_spread = self.get_oracle_mark_spread(price_oracle, one_hour);
            let funding_rate = price_spread.checked_div(period_adjustment).unwrap();
            let est_funding_rate = funding_rate
                .checked_div(self.periodicity as i128)
                .unwrap()
                .checked_mul(time_since_last_update as i128)
                .unwrap();
            return est_funding_rate;
        }
    }

    pub fn move_price(&mut self, base_asset_amount: u128, quote_asset_amount: u128) {
        self.base_asset_amount = base_asset_amount;
        self.quote_asset_amount = quote_asset_amount;

        self.k = base_asset_amount.checked_mul(quote_asset_amount).unwrap();
    }

    pub fn calc_target_price_trade_vector(&mut self, target_price: u128) -> i128 {
        // positive => LONG magnitude
        // negative => SHORT magnitude
        let new_base_asset_amount_squared = self
            .k
            .checked_div(target_price)
            .unwrap()
            .checked_mul(self.peg_multiplier)
            .unwrap();

        let new_base_asset_amount = new_base_asset_amount_squared.integer_sqrt();
        let new_quote_asset_amount = self.k.checked_div(new_base_asset_amount).unwrap();

        return (new_quote_asset_amount as i128)
            .checked_sub(self.quote_asset_amount as i128)
            .unwrap();
    }

    pub fn move_to_price(&mut self, target_price: u128) {
        let new_base_asset_amount_squared = self
            .k
            .checked_div(target_price)
            .unwrap()
            .checked_mul(self.peg_multiplier)
            .unwrap();

        let new_base_asset_amount = new_base_asset_amount_squared.integer_sqrt();
        let new_quote_asset_amount = self.k.checked_div(new_base_asset_amount).unwrap();

        self.base_asset_amount = new_base_asset_amount;
        self.quote_asset_amount = new_quote_asset_amount;
    }

    pub fn find_valid_repeg(&mut self, oracle_px: i128, oracle_conf: u128) -> u128 {
        // amm.oracle

        let x_eq_0 = self.peg_multiplier;
        let peg_spread_0 = (x_eq_0 as i128).checked_sub(oracle_px).unwrap();

        if (peg_spread_0.unsigned_abs().lt(&oracle_conf)) {
            return x_eq_0;
        }

        let mut i = 1; // max move is half way to oracle
        let mut x_eq = x_eq_0;

        while i < 1000 {
            let base: i128 = 2;
            let step = base.pow(i);
            let redux = peg_spread_0.checked_div(step).unwrap();

            if peg_spread_0 < 0 {
                x_eq = x_eq_0.checked_add(redux.abs() as u128).unwrap();
            } else {
                x_eq = x_eq_0.checked_sub(redux.abs() as u128).unwrap();
            }

            let peg_spread_1 = (x_eq as i128).checked_sub(oracle_px).unwrap();

            let mut pnl_r = self.cum_slippage_profit;
            //todo: replace with Market.base_asset_amount
            let base_asset_amount_i = self.base_asset_amount_i as i128;
            let market_position = base_asset_amount_i
                .checked_sub(self.base_asset_amount as i128)
                .unwrap();

            let mut pnl = 0;
            if x_eq > x_eq_0 {
                let pnl = (x_eq.checked_sub(x_eq_0).unwrap() as i128)
                    .checked_mul(market_position)
                    .unwrap();
            } else {
                let pnl = (x_eq_0.checked_sub(x_eq).unwrap() as i128)
                    .checked_mul(market_position)
                    .unwrap();
            }

            if pnl > 0 {
                pnl_r = pnl_r.checked_add(pnl).unwrap();
            } else {
                pnl_r = pnl_r.checked_sub(pnl).unwrap();
            }

            if pnl_r >= self.cum_slippage.checked_div(2).unwrap() {
                break;
            }

            i = i + 1;
        }

        return x_eq;
    }
}

#[account(zero_copy)]
pub struct FundingRateHistory {
    head: u64,
    funding_rate_records: [FundingRateRecord; 1000],
}

impl FundingRateHistory {
    fn append(&mut self, pos: FundingRateRecord) {
        self.funding_rate_records[FundingRateHistory::index_of(self.head)] = pos;
        self.head = (self.head + 1) % 1000;
    }
    fn index_of(counter: u64) -> usize {
        std::convert::TryInto::try_into(counter).unwrap()
    }

    fn next_record_id(&self) -> u128 {
        let prev_record_id = if self.head == 0 { 999 } else { self.head - 1 };
        let prev_record = &self.funding_rate_records[FundingRateHistory::index_of(prev_record_id)];
        return prev_record.record_id + 1;
    }
}

#[zero_copy]
pub struct FundingRateRecord {
    pub ts: i64,
    pub record_id: u128,
    pub user_public_key: Pubkey,
    pub user_clearing_house_public_key: Pubkey,
    pub market_index: u64,
    pub funding_rate_payment: i128,
    pub base_asset_amount: i128,
    pub user_last_cumulative_funding: i128,
    pub amm_cumulative_funding: i128,
}

#[derive(Clone, Copy)]
pub enum SwapDirection {
    Add,
    Remove,
}

#[zero_copy]
pub struct MarketPosition {
    pub market_index: u64,
    pub base_asset_amount: i128,
    pub quote_asset_notional_amount: u128,
    pub last_cum_funding: i128,
    pub last_cum_repeg_profit: u128,
}

#[error]
pub enum ErrorCode {
    #[msg("Clearing house not collateral account owner")]
    InvalidCollateralAccountAuthority,
    #[msg("Clearing house not insurance account owner")]
    InvalidInsuranceAccountAuthority,
    #[msg("Signer must be ClearingHouse admin")]
    Unauthorized,
    #[msg("Invalid Collateral Account")]
    InvalidCollateralAccount,
    #[msg("Invalid Insurance Account")]
    InvalidInsuranceAccount,
    #[msg("Invalid Token Program")]
    InvalidTokenProgram,
    #[msg("Insufficient deposit")]
    InsufficientDeposit,
    #[msg("Insufficient collateral")]
    InsufficientCollateral,
    #[msg("Sufficient collateral")]
    SufficientCollateral,
    #[msg("Max number of positions taken")]
    MaxNumberOfPositions,
    #[msg("Admin Controls Prices Disabled")]
    AdminControlsPricesDisabled,
    #[msg("Market Index Not Initialized")]
    MarketIndexNotInitialized,
    #[msg("Market Index Already Initialized")]
    MarketIndexAlreadyInitialized,
    #[msg("User Account And User Positions Account Mismatch")]
    UserAccountAndUserPositionsAccountMismatch,
    #[msg("User Has No Position In Market")]
    UserHasNoPositionInMarket,
    #[msg("AMM peg in v0 must be > MANTISSA/10 (e.g. .1)")]
    InvalidInitialPeg,
    #[msg("AMM repeg already configured with amt given")]
    InvalidRepegRedundant,
    #[msg("AMM repeg incorrect repeg direction")]
    InvalidRepegDirection,
    #[msg("AMM repeg out of bounds size")]
    InvalidRepegSize,
    #[msg("AMM repeg out of bounds pnl")]
    InvalidRepegProfitability,
    #[msg("Slippage Outside Limit Price")]
    SlippageOutsideLimit,
}

#[derive(Clone, Copy, BorshSerialize, BorshDeserialize, PartialEq)]
pub enum PositionDirection {
    Long,
    Short,
}

fn increase_position(
    direction: PositionDirection,
    new_quote_asset_notional_amount: u128,
    market: &mut Market,
    market_position: &mut MarketPosition,
    now: i64,
) -> i128 {
    if new_quote_asset_notional_amount == 0 {
        return 0;
    }

    // Update funding rate if this is a new position
    if market_position.base_asset_amount == 0 {
        market_position.last_cum_funding = market.amm.cum_funding_rate;
        market_position.last_cum_repeg_profit = match direction {
            PositionDirection::Long => market.amm.cum_long_repeg_profit,
            PositionDirection::Short => market.amm.cum_short_repeg_profit,
        };
        market.open_interest = market.open_interest.checked_add(1).unwrap();
    }

    market_position.quote_asset_notional_amount = market_position
        .quote_asset_notional_amount
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

    let (base_asset_acquired, quote_asset_peg_fee_unpaid) =
        market
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

    return quote_asset_peg_fee_unpaid;
}

fn reduce_position<'info>(
    direction: PositionDirection,
    new_quote_asset_notional_amount: u128,
    user_account: &mut ProgramAccount<'info, UserAccount>,
    market: &mut Market,
    market_position: &mut MarketPosition,
    now: i64,
) {
    let swap_direction = match direction {
        PositionDirection::Long => SwapDirection::Add,
        PositionDirection::Short => SwapDirection::Remove,
    };
    let (base_asset_value_before, pnl_before) =
        calculate_base_asset_value_and_pnl(market_position, &market.amm);
    let base_asset_swapped =
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
    market_position.quote_asset_notional_amount = market_position
        .quote_asset_notional_amount
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

    let (base_asset_value_after, pnl_after) =
        calculate_base_asset_value_and_pnl(market_position, &market.amm);
    let pnl = calculate_realized_pnl(
        base_asset_value_before,
        base_asset_value_after,
        pnl_before,
        swap_direction,
    );

    user_account.collateral = calculate_updated_collateral(user_account.collateral, pnl);
}

// Todo Make this work with new market structure
fn transfer_position<'info>(
    user_account_to: &mut ProgramAccount<UserAccount>,
    market_position_to: &mut MarketPosition,
    user_account_from: &mut ProgramAccount<UserAccount>,
    market_position_from: &mut MarketPosition,
    market: &mut Market,
) {
    // allow user to take over another users position at fair market value
    // e.g. liquidator can take over positions at zero market impact (todo: need better incentive?)
    // iff user.margin below maintence req
    let (base_asset_value, pnl) =
        calculate_base_asset_value_and_pnl(market_position_from, &market.amm);
    let realized_collateral = calculate_updated_collateral(user_account_from.collateral, pnl);
    user_account_from.collateral = realized_collateral;

    // todo: add support for partial take over
    let position_transfer = market_position_from.base_asset_amount;

    market_position_to.base_asset_amount = market_position_to
        .base_asset_amount
        .checked_add(position_transfer)
        .unwrap();

    if market_position_to.last_cum_funding == 0 {
        market_position_to.last_cum_funding = market.amm.cum_funding_rate;
    }

    if market_position_to.base_asset_amount == 0 {
        market.open_interest = market.open_interest.checked_sub(1).unwrap();
    }

    market_position_to.quote_asset_notional_amount = market_position_to
        .quote_asset_notional_amount
        .checked_sub(base_asset_value)
        .unwrap();

    market_position_from.base_asset_amount = 0;
    market_position_from.quote_asset_notional_amount = 0;
    market_position_from.last_cum_funding = 0;
}

fn close_position(
    user_account: &mut ProgramAccount<UserAccount>,
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

    user_account.collateral = calculate_updated_collateral(user_account.collateral, pnl);
    market_position.last_cum_funding = 0;
    market_position.last_cum_repeg_profit = 0;

    market.quote_asset_notional_amount = market
        .quote_asset_notional_amount
        .checked_sub(market_position.quote_asset_notional_amount)
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

    market_position.quote_asset_notional_amount = 0;

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

fn calculate_realized_pnl(
    base_asset_value_before: u128,
    base_asset_value_after: u128,
    pnl_before: i128,
    swap_direction: SwapDirection,
) -> i128 {
    // checks the value change before/after position adj to scale the pnl of selling all
    // effectively realizes the average price a user paid for position against the price to close now

    // todo: checked_mul porition needs to be unsigned_abs??
    let value_change = (base_asset_value_before as i128)
        .checked_sub(base_asset_value_after as i128)
        .unwrap()
        .unsigned_abs();

    let pnl = pnl_before.checked_mul(value_change as i128).unwrap();

    let pnlpct = match swap_direction {
        SwapDirection::Add => pnl.checked_div(base_asset_value_after as i128).unwrap(),
        SwapDirection::Remove => pnl.checked_div(base_asset_value_before as i128).unwrap(),
    };

    return pnl_before;
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
    user_account: &mut UserAccount,
    user_positions_account: &mut RefMut<UserPositionsAccount>,
    markets_account: &Ref<MarketsAccount>,
    funding_rate_history: &mut RefMut<FundingRateHistory>,
) {
    let clock = Clock::get().unwrap();
    let now = clock.unix_timestamp;

    let user_account_key = user_positions_account.user_account;
    let mut funding_payment: i128 = 0;
    for market_position in user_positions_account.positions.iter_mut() {
        if market_position.base_asset_amount == 0 {
            continue;
        }

        let market =
            markets_account.markets[MarketsAccount::index_from_u64(market_position.market_index)];
        let amm: &AMM = &market.amm;

        if amm.cum_funding_rate != market_position.last_cum_funding {
            let market_funding_rate_payment =
                _calculate_funding_payment_notional(amm, market_position);

            let record_id = funding_rate_history.next_record_id();
            funding_rate_history.append(FundingRateRecord {
                ts: now,
                record_id,
                user_public_key: user_account.authority,
                user_clearing_house_public_key: user_account_key,
                market_index: market_position.market_index,
                funding_rate_payment: market_funding_rate_payment,
                user_last_cumulative_funding: market_position.last_cum_funding,
                amm_cumulative_funding: amm.cum_funding_rate,
                base_asset_amount: market_position.base_asset_amount,
            });

            funding_payment = funding_payment
                .checked_add(market_funding_rate_payment)
                .unwrap();
        }

        if market_position.base_asset_amount > 0
            && market_position.last_cum_repeg_profit != amm.cum_long_repeg_profit
            || market_position.base_asset_amount < 0
                && market_position.last_cum_repeg_profit != amm.cum_short_repeg_profit
        {
            let repeg_profit_share = if market_position.base_asset_amount > 0 {
                market
                    .amm
                    .cum_long_repeg_profit
                    .checked_sub(market_position.last_cum_repeg_profit)
                    .unwrap()
            } else {
                market
                    .amm
                    .cum_short_repeg_profit
                    .checked_sub(market_position.last_cum_repeg_profit)
                    .unwrap()
            };
            let repeg_profit_share_pnl = (repeg_profit_share as u128)
                .checked_mul(market_position.base_asset_amount.unsigned_abs())
                .unwrap();
            user_account.total_potential_fee = user_account
                .total_potential_fee
                .checked_sub(repeg_profit_share_pnl as i128)
                .unwrap();
        }

        market_position.last_cum_funding = amm.cum_funding_rate;
    }

    // longs pay shorts the `funding_payment`
    let funding_payment_collateral = funding_payment
        .checked_div(FUNDING_MANTISSA as i128)
        .unwrap();

    user_account.collateral =
        calculate_updated_collateral(user_account.collateral, funding_payment_collateral);
}

fn calculate_margin_ratio_full(
    user_account: &UserAccount,
    user_positions_account: &RefMut<UserPositionsAccount>,
    markets_account: &Ref<MarketsAccount>,
) -> (u128, u128) {
    let mut base_asset_value: u128 = 0;
    let mut unrealized_pnl: i128 = 0;

    // loop 1 to calculate unrealized_pnl
    for market_position in user_positions_account.positions.iter() {
        if market_position.base_asset_amount == 0 {
            continue;
        }

        let amm = &markets_account.markets
            [MarketsAccount::index_from_u64(market_position.market_index)]
        .amm;
        let (position_base_asset_value, position_unrealized_pnl) =
            calculate_base_asset_value_and_pnl(market_position, amm);

        base_asset_value = base_asset_value
            .checked_add(position_base_asset_value)
            .unwrap();
        unrealized_pnl = unrealized_pnl.checked_add(position_unrealized_pnl).unwrap();
    }

    // todo: add this once total_potential_fee looks good
    // unrealized_pnl = unrealized_pnl
    //     .checked_sub(user_account.total_potential_fee as i128)
    //     .unwrap();

    if base_asset_value == 0 {
        return (u128::MAX, base_asset_value);
    }

    let estimated_margin = calculate_updated_collateral(user_account.collateral, unrealized_pnl);

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
        .cum_funding_rate
        .checked_sub(market_position.last_cum_funding)
        .unwrap();

    return funding_rate_delta
        .checked_mul(market_position.base_asset_amount)
        .unwrap()
        .checked_mul(amm.base_asset_price_with_mantissa() as i128)
        .unwrap()
        .checked_div(MANTISSA as i128)
        .unwrap()
        .checked_div(MANTISSA as i128)
        .unwrap()
        .checked_mul(-1)
        .unwrap();
}

fn calculate_margin_ratio(
    user_account: &UserAccount,
    user_positions_account: &RefMut<UserPositionsAccount>,
    markets_account: &Ref<MarketsAccount>,
) -> u128 {
    let (estimated_margin, base_asset_value) =
        calculate_margin_ratio_full(user_account, user_positions_account, markets_account);
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
        market_position.quote_asset_notional_amount,
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

fn admin<'info>(state: &clearing_house::ClearingHouse, signer: &AccountInfo<'info>) -> Result<()> {
    if !signer.key.eq(&state.admin) {
        return Err(ErrorCode::Unauthorized.into());
    }
    Ok(())
}

fn collateral_account<'info>(
    state: &clearing_house::ClearingHouse,
    collateral_account: &CpiAccount<'info, TokenAccount>,
) -> Result<()> {
    if !collateral_account
        .to_account_info()
        .key
        .eq(&state.collateral_account)
    {
        return Err(ErrorCode::InvalidCollateralAccount.into());
    }
    Ok(())
}

fn insurance_account<'info>(
    state: &clearing_house::ClearingHouse,
    insurance_account: &CpiAccount<'info, TokenAccount>,
) -> Result<()> {
    if !insurance_account
        .to_account_info()
        .key
        .eq(&state.insurance_account)
    {
        return Err(ErrorCode::InvalidInsuranceAccount.into());
    }
    Ok(())
}

fn token_program<'info>(token_program: &AccountInfo<'info>) -> Result<()> {
    let canonicl_token_program =
        Pubkey::from_str("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA").unwrap();
    if !token_program.key.eq(&canonicl_token_program) {
        return Err(ErrorCode::InvalidTokenProgram.into());
    }
    Ok(())
}

fn admin_controls_prices<'info>(state: &clearing_house::ClearingHouse) -> Result<()> {
    if !state.admin_controls_prices {
        return Err(ErrorCode::AdminControlsPricesDisabled.into());
    }
    Ok(())
}

fn users_positions_account_matches_user_account<'info>(
    user_account: &ProgramAccount<'info, UserAccount>,
    user_positions_account: &Loader<'info, UserPositionsAccount>,
) -> Result<()> {
    if !user_account
        .positions
        .eq(&user_positions_account.to_account_info().key)
    {
        return Err(ErrorCode::UserAccountAndUserPositionsAccountMismatch.into());
    }
    Ok(())
}

fn market_initialized(markets_account: &Loader<MarketsAccount>, market_index: u64) -> Result<()> {
    if !markets_account.load()?.markets[MarketsAccount::index_from_u64(market_index)].initialized {
        return Err(ErrorCode::MarketIndexNotInitialized.into());
    }
    Ok(())
}
