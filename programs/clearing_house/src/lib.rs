#![allow(clippy::too_many_arguments)]
#![allow(unaligned_references)]

use anchor_lang::prelude::*;
use borsh::BorshSerialize;

use context::*;
use error::ErrorCode;
use math::{amm, bn, constants::*, margin::*};
use state::oracle::{get_oracle_price, OracleSource};

use crate::math::amm::get_update_k_result;
use crate::state::market::Market;
use crate::state::{market::AMM, state::*, user::*};

pub mod context;
pub mod controller;
pub mod error;
pub mod ids;
pub mod macros;
mod margin_validation;
pub mod math;
pub mod optional_accounts;
pub mod order_validation;
pub mod state;
#[cfg(test)]
mod tests;

#[cfg(feature = "mainnet-beta")]
declare_id!("dammHkt7jmytvbS3nHTxQNEcP59aE57nxwV21YdqEDN");
#[cfg(not(feature = "mainnet-beta"))]
declare_id!("4oyTJnAQ9FqJj1y9mPytbWsLeeHmBzGYfuFqypwyQvuh");

#[program]
pub mod clearing_house {
    use std::cmp::min;
    use std::option::Option::Some;

    use crate::controller::position::get_position_index;
    use crate::margin_validation::validate_margin;
    use crate::math;
    use crate::math::bank_balance::get_token_amount;
    use crate::math::casting::{cast, cast_to_i128, cast_to_u128};
    use crate::optional_accounts::get_maker;
    use crate::state::bank::{Bank, BankBalanceType};
    use crate::state::bank_map::{get_writable_banks, BankMap, WritableBanks};
    use crate::state::events::DepositDirection;
    use crate::state::events::{CurveRecord, DepositRecord};
    use crate::state::market::{Market, PoolBalance};
    use crate::state::market_map::{
        get_writable_markets, get_writable_markets_for_user_positions,
        get_writable_markets_for_user_positions_and_order, get_writable_markets_list, MarketMap,
        WritableMarkets,
    };
    use crate::state::oracle::OraclePriceData;
    use crate::state::oracle_map::OracleMap;
    use crate::state::state::OrderFillerRewardStructure;

    use super::*;

    pub fn initialize(ctx: Context<Initialize>, admin_controls_prices: bool) -> Result<()> {
        let insurance_account_key = ctx.accounts.insurance_vault.to_account_info().key;
        let (insurance_account_authority, insurance_account_nonce) =
            Pubkey::find_program_address(&[insurance_account_key.as_ref()], ctx.program_id);

        // clearing house must be authority of insurance vault
        if ctx.accounts.insurance_vault.owner != insurance_account_authority {
            return Err(ErrorCode::InvalidInsuranceAccountAuthority.into());
        }

        **ctx.accounts.state = State {
            admin: *ctx.accounts.admin.key,
            funding_paused: false,
            exchange_paused: false,
            admin_controls_prices,
            insurance_vault: *insurance_account_key,
            insurance_vault_authority: insurance_account_authority,
            insurance_vault_nonce: insurance_account_nonce,
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
            fee_structure: FeeStructure::default(),
            whitelist_mint: Pubkey::default(),
            discount_mint: Pubkey::default(),
            oracle_guard_rails: OracleGuardRails::default(),
            number_of_markets: 0,
            number_of_banks: 0,
            min_order_quote_asset_amount: 500_000, // 50 cents
            min_auction_duration: 10,
            max_auction_duration: 60,
            liquidation_margin_buffer_ratio: 50, // 2%
            padding0: 0,
            padding1: 0,
        };

        Ok(())
    }

    pub fn initialize_bank(
        ctx: Context<InitializeBank>,
        optimal_utilization: u128,
        optimal_borrow_rate: u128,
        max_borrow_rate: u128,
        oracle_source: OracleSource,
        initial_asset_weight: u128,
        maintenance_asset_weight: u128,
        initial_liability_weight: u128,
        maintenance_liability_weight: u128,
        imf_factor: u128,
        liquidation_fee: u128,
    ) -> Result<()> {
        let state = &mut ctx.accounts.state;
        let bank_pubkey = ctx.accounts.bank.key();

        let (vault_authority, vault_authority_nonce) = Pubkey::find_program_address(
            &[
                b"bank_vault_authority".as_ref(),
                state.number_of_banks.to_le_bytes().as_ref(),
            ],
            ctx.program_id,
        );

        // clearing house must be authority of collateral vault
        if ctx.accounts.bank_vault.owner != vault_authority {
            return Err(ErrorCode::InvalidBankAuthority.into());
        }

        let bank_index = get_then_update_id!(state, number_of_banks);
        if bank_index == 0 {
            validate!(
                initial_asset_weight == BANK_WEIGHT_PRECISION,
                ErrorCode::InvalidBankInitialization,
                "For quote asset bank, initial asset weight must be {}",
                BANK_WEIGHT_PRECISION
            )?;

            validate!(
                maintenance_asset_weight == BANK_WEIGHT_PRECISION,
                ErrorCode::InvalidBankInitialization,
                "For quote asset bank, maintenance asset weight must be {}",
                BANK_WEIGHT_PRECISION
            )?;

            validate!(
                initial_liability_weight == BANK_WEIGHT_PRECISION,
                ErrorCode::InvalidBankInitialization,
                "For quote asset bank, initial liability weight must be {}",
                BANK_WEIGHT_PRECISION
            )?;

            validate!(
                maintenance_liability_weight == BANK_WEIGHT_PRECISION,
                ErrorCode::InvalidBankInitialization,
                "For quote asset bank, maintenance liability weight must be {}",
                BANK_WEIGHT_PRECISION
            )?;

            validate!(
                ctx.accounts.oracle.key == &Pubkey::default(),
                ErrorCode::InvalidBankInitialization,
                "For quote asset bank, oracle must be default public key"
            )?;

            validate!(
                oracle_source == OracleSource::QuoteAsset,
                ErrorCode::InvalidBankInitialization,
                "For quote asset bank, oracle source must be QuoteAsset"
            )?;

            validate!(
                ctx.accounts.bank_mint.decimals == 6,
                ErrorCode::InvalidBankInitialization,
                "For quote asset bank, mint decimals must be 6"
            )?;
        } else {
            validate!(
                initial_asset_weight > 0 && initial_asset_weight < BANK_WEIGHT_PRECISION,
                ErrorCode::InvalidBankInitialization,
                "Initial asset weight must be between 0 {}",
                BANK_WEIGHT_PRECISION
            )?;

            validate!(
                maintenance_asset_weight > 0 && maintenance_asset_weight < BANK_WEIGHT_PRECISION,
                ErrorCode::InvalidBankInitialization,
                "Maintenance asset weight must be between 0 {}",
                BANK_WEIGHT_PRECISION
            )?;

            validate!(
                initial_liability_weight > BANK_WEIGHT_PRECISION,
                ErrorCode::InvalidBankInitialization,
                "Initial liability weight must be greater than {}",
                BANK_WEIGHT_PRECISION
            )?;

            validate!(
                maintenance_liability_weight > BANK_WEIGHT_PRECISION,
                ErrorCode::InvalidBankInitialization,
                "Maintenance liability weight must be greater than {}",
                BANK_WEIGHT_PRECISION
            )?;

            validate!(
                ctx.accounts.bank_mint.decimals >= 6,
                ErrorCode::InvalidBankInitialization,
                "Mint decimals must be greater than or equal to 6"
            )?;

            let oracle_price = get_oracle_price(
                &oracle_source,
                &ctx.accounts.oracle,
                cast(Clock::get()?.unix_timestamp)?,
            );

            validate!(
                oracle_price.is_ok(),
                ErrorCode::InvalidBankInitialization,
                "Unable to read oracle price for {}",
                ctx.accounts.oracle.key,
            )?;
        }

        let bank = &mut ctx.accounts.bank.load_init()?;
        **bank = Bank {
            bank_index,
            pubkey: bank_pubkey,
            mint: ctx.accounts.bank_mint.key(),
            vault: *ctx.accounts.bank_vault.to_account_info().key,
            vault_authority,
            vault_authority_nonce,
            decimals: ctx.accounts.bank_mint.decimals,
            optimal_utilization,
            optimal_borrow_rate,
            max_borrow_rate,
            deposit_balance: 0,
            borrow_balance: 0,
            cumulative_deposit_interest: BANK_CUMULATIVE_INTEREST_PRECISION,
            cumulative_borrow_interest: BANK_CUMULATIVE_INTEREST_PRECISION,
            last_updated: cast(Clock::get()?.unix_timestamp)
                .or(Err(ErrorCode::UnableToCastUnixTime))?,
            oracle_source,
            oracle: ctx.accounts.oracle.key(),
            initial_asset_weight,
            maintenance_asset_weight,
            initial_liability_weight,
            maintenance_liability_weight,
            imf_factor,
            liquidation_fee,
        };

        Ok(())
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
    ) -> Result<()> {
        let market_pubkey = ctx.accounts.market.to_account_info().key;
        let market = &mut ctx.accounts.market.load_init()?;
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
            delay: oracle_delay,
            ..
        } = match oracle_source {
            OracleSource::Pyth => market
                .amm
                .get_pyth_price(&ctx.accounts.oracle, clock_slot)
                .unwrap(),
            OracleSource::Switchboard => market
                .amm
                .get_switchboard_price(&ctx.accounts.oracle, clock_slot)
                .unwrap(),
            OracleSource::QuoteAsset => panic!(),
        };

        let last_oracle_price_twap = match oracle_source {
            OracleSource::Pyth => market.amm.get_pyth_twap(&ctx.accounts.oracle)?,
            OracleSource::Switchboard => oracle_price,
            OracleSource::QuoteAsset => panic!(),
        };

        validate_margin(
            margin_ratio_initial,
            margin_ratio_maintenance,
            liquidation_fee,
        )?;

        let state = &mut ctx.accounts.state;
        let market_index = state.number_of_markets;
        **market = Market {
            initialized: true,
            pubkey: *market_pubkey,
            market_index,
            base_asset_amount_long: 0,
            base_asset_amount_short: 0,
            // base_asset_amount: 0,
            open_interest: 0,
            margin_ratio_initial, // unit is 20% (+2 decimal places)
            margin_ratio_maintenance,
            imf_factor: 0,
            next_fill_record_id: 1,
            next_funding_rate_record_id: 1,
            next_curve_record_id: 1,
            pnl_pool: PoolBalance { balance: 0 },
            unsettled_loss: 0,
            unsettled_profit: 0,
            unsettled_initial_asset_weight: 100,     // 100%
            unsettled_maintenance_asset_weight: 100, // 100%
            unsettled_imf_factor: 0,
            liquidation_fee,
            padding0: 0,
            padding1: 0,
            padding2: 0,
            padding3: 0,
            padding4: 0,
            amm: AMM {
                oracle: *ctx.accounts.oracle.key,
                oracle_source,
                base_asset_reserve: amm_base_asset_reserve,
                quote_asset_reserve: amm_quote_asset_reserve,
                terminal_quote_asset_reserve: amm_quote_asset_reserve,
                ask_base_asset_reserve: amm_base_asset_reserve,
                ask_quote_asset_reserve: amm_quote_asset_reserve,
                bid_base_asset_reserve: amm_base_asset_reserve,
                bid_quote_asset_reserve: amm_quote_asset_reserve,
                cumulative_repeg_rebate_long: 0,
                cumulative_repeg_rebate_short: 0,
                cumulative_funding_rate_long: 0,
                cumulative_funding_rate_short: 0,
                cumulative_funding_rate_lp: 0,
                last_funding_rate: 0,
                last_funding_rate_ts: now,
                funding_period: amm_periodicity,
                last_oracle_price_twap,
                last_mark_price_twap: init_mark_price,
                last_mark_price_twap_ts: now,
                sqrt_k: amm_base_asset_reserve,
                peg_multiplier: amm_peg_multiplier,
                total_fee: 0,
                total_fee_withdrawn: 0,
                total_fee_minus_distributions: 0,
                total_mm_fee: 0,
                total_exchange_fee: 0,
                net_revenue_since_last_funding: 0,
                minimum_quote_asset_trade_size: 10000000,
                last_oracle_price_twap_ts: now,
                last_oracle_normalised_price: oracle_price,
                last_oracle_price: oracle_price,
                last_oracle_conf_pct: 0,
                last_oracle_delay: oracle_delay,
                last_oracle_mark_spread_pct: 0, // todo
                base_asset_amount_step_size: 10000000,
                max_slippage_ratio: 50,           // ~2%
                max_base_asset_amount_ratio: 100, // moves price ~2%
                base_spread: 0,
                long_spread: 0,
                short_spread: 0,
                max_spread: (margin_ratio_initial * 100),
                last_bid_price_twap: init_mark_price,
                last_ask_price_twap: init_mark_price,
                net_base_asset_amount: 0,
                quote_asset_amount_long: 0,
                quote_asset_amount_short: 0,
                mark_std: 0,
                long_intensity_count: 0,
                long_intensity_volume: 0,
                short_intensity_count: 0,
                short_intensity_volume: 0,
                curve_update_intensity: 0,
                fee_pool: PoolBalance { balance: 0 },
                last_update_slot: clock_slot,
                padding0: 0,
                padding1: 0,
                padding2: 0,
                padding3: 0,
            },
        };

        state.number_of_markets = state
            .number_of_markets
            .checked_add(1)
            .ok_or_else(math_error!())?;

        Ok(())
    }

    pub fn deposit(
        ctx: Context<Deposit>,
        bank_index: u64,
        amount: u64,
        reduce_only: bool,
    ) -> Result<()> {
        let user_key = ctx.accounts.user.key();
        let user = &mut load_mut!(ctx.accounts.user)?;
        let clock = Clock::get()?;
        let now = clock.unix_timestamp;

        let remaining_accounts_iter = &mut ctx.remaining_accounts.iter().peekable();
        let mut oracle_map = OracleMap::load(remaining_accounts_iter, clock.slot)?;
        let bank_map = BankMap::load(&get_writable_banks(bank_index), remaining_accounts_iter)?;

        let mut market_map = MarketMap::load(
            &get_writable_markets_for_user_positions(&user.positions),
            remaining_accounts_iter,
        )?;

        if amount == 0 {
            return Err(ErrorCode::InsufficientDeposit.into());
        }

        controller::repeg::update_amms(
            &mut market_map,
            &mut oracle_map,
            &ctx.accounts.state,
            &Clock::get()?,
        )?;

        let bank = &mut bank_map.get_ref_mut(&bank_index)?;
        controller::bank_balance::update_bank_cumulative_interest(bank, now)?;

        let user_bank_balance = match user.get_bank_balance_mut(bank.bank_index) {
            Some(user_bank_balance) => user_bank_balance,
            None => user.add_bank_balance(bank_index, BankBalanceType::Deposit)?,
        };

        // if reduce only, have to compare ix amount to current borrow amount
        let amount = if reduce_only && user_bank_balance.balance_type == BankBalanceType::Borrow {
            let borrow_token_amount = get_token_amount(
                user_bank_balance.balance,
                bank,
                &user_bank_balance.balance_type,
            )?;
            min(borrow_token_amount as u64, amount)
        } else {
            amount
        };

        controller::bank_balance::update_bank_balances(
            amount as u128,
            &BankBalanceType::Deposit,
            bank,
            user_bank_balance,
        )?;

        controller::token::receive(
            &ctx.accounts.token_program,
            &ctx.accounts.user_token_account,
            &ctx.accounts.bank_vault,
            &ctx.accounts.authority,
            amount,
        )?;

        let oracle_price = oracle_map.get_price_data(&bank.oracle)?.price;
        let deposit_record = DepositRecord {
            ts: now,
            user_authority: user.authority,
            user: user_key,
            direction: DepositDirection::DEPOSIT,
            amount,
            oracle_price,
            bank_index,
            from: None,
            to: None,
        };
        emit!(deposit_record);

        Ok(())
    }

    #[access_control(
        exchange_not_paused(&ctx.accounts.state)
    )]
    pub fn withdraw(
        ctx: Context<Withdraw>,
        bank_index: u64,
        amount: u64,
        reduce_only: bool,
    ) -> Result<()> {
        let user_key = ctx.accounts.user.key();
        let user = &mut load_mut!(ctx.accounts.user)?;
        let clock = Clock::get()?;
        let now = clock.unix_timestamp;

        let remaining_accounts_iter = &mut ctx.remaining_accounts.iter().peekable();
        let mut oracle_map = OracleMap::load(remaining_accounts_iter, clock.slot)?;
        let bank_map = BankMap::load(&get_writable_banks(bank_index), remaining_accounts_iter)?;
        let mut market_map = MarketMap::load(&WritableMarkets::new(), remaining_accounts_iter)?;

        controller::repeg::update_amms(
            &mut market_map,
            &mut oracle_map,
            &ctx.accounts.state,
            &clock,
        )?;

        let amount = {
            let bank = &mut bank_map.get_ref_mut(&bank_index)?;
            controller::bank_balance::update_bank_cumulative_interest(bank, now)?;

            let user_bank_balance = match user.get_bank_balance_mut(bank.bank_index) {
                Some(user_bank_balance) => user_bank_balance,
                None => user.add_bank_balance(bank_index, BankBalanceType::Deposit)?,
            };

            // if reduce only, have to compare ix amount to current deposit amount
            let amount =
                if reduce_only && user_bank_balance.balance_type == BankBalanceType::Deposit {
                    let borrow_token_amount = get_token_amount(
                        user_bank_balance.balance,
                        bank,
                        &user_bank_balance.balance_type,
                    )?;
                    min(borrow_token_amount as u64, amount)
                } else {
                    amount
                };

            controller::bank_balance::update_bank_balances(
                amount as u128,
                &BankBalanceType::Borrow,
                bank,
                user_bank_balance,
            )?;

            amount
        };

        if !meets_initial_margin_requirement(user, &market_map, &bank_map, &mut oracle_map)? {
            return Err(ErrorCode::InsufficientCollateral.into());
        }

        user.being_liquidated = false;

        let bank = bank_map.get_ref(&bank_index)?;
        controller::token::send_from_bank_vault(
            &ctx.accounts.token_program,
            &ctx.accounts.bank_vault,
            &ctx.accounts.user_token_account,
            &ctx.accounts.bank_vault_authority,
            bank_index,
            bank.vault_authority_nonce,
            amount,
        )?;

        let oracle_price = oracle_map.get_price_data(&bank.oracle)?.price;
        let deposit_record = DepositRecord {
            ts: now,
            user_authority: user.authority,
            user: user_key,
            direction: DepositDirection::WITHDRAW,
            oracle_price,
            amount,
            bank_index,
            from: None,
            to: None,
        };
        emit!(deposit_record);

        Ok(())
    }

    pub fn transfer_deposit(
        ctx: Context<TransferDeposit>,
        bank_index: u64,
        amount: u64,
    ) -> Result<()> {
        let authority_key = ctx.accounts.authority.key;
        let to_user_key = ctx.accounts.to_user.key();
        let from_user_key = ctx.accounts.from_user.key();
        let clock = Clock::get()?;

        let to_user = &mut load_mut!(ctx.accounts.to_user)?;
        let from_user = &mut load_mut!(ctx.accounts.from_user)?;

        let remaining_accounts_iter = &mut ctx.remaining_accounts.iter().peekable();
        let mut oracle_map = OracleMap::load(remaining_accounts_iter, clock.slot)?;
        let bank_map = BankMap::load(&get_writable_banks(bank_index), remaining_accounts_iter)?;
        let mut market_map = MarketMap::load(&WritableMarkets::new(), remaining_accounts_iter)?;

        controller::repeg::update_amms(
            &mut market_map,
            &mut oracle_map,
            &ctx.accounts.state,
            &Clock::get()?,
        )?;

        {
            let bank = &mut bank_map.get_ref_mut(&bank_index)?;
            controller::bank_balance::update_bank_cumulative_interest(bank, clock.unix_timestamp)?;
        }

        {
            let bank = &mut bank_map.get_ref_mut(&bank_index)?;
            let from_user_bank_balance = match from_user.get_bank_balance_mut(bank.bank_index) {
                Some(user_bank_balance) => user_bank_balance,
                None => from_user.add_bank_balance(bank_index, BankBalanceType::Deposit)?,
            };

            controller::bank_balance::update_bank_balances(
                amount as u128,
                &BankBalanceType::Borrow,
                bank,
                from_user_bank_balance,
            )?;
        }

        validate!(
            meets_initial_margin_requirement(from_user, &market_map, &bank_map, &mut oracle_map)?,
            ErrorCode::InsufficientCollateral,
            "From user does not meet initial margin requirement"
        )?;

        from_user.being_liquidated = false;

        let oracle_price = {
            let bank = &bank_map.get_ref(&bank_index)?;
            oracle_map.get_price_data(&bank.oracle)?.price
        };

        let deposit_record = DepositRecord {
            ts: clock.unix_timestamp,
            user_authority: *authority_key,
            user: from_user_key,
            direction: DepositDirection::WITHDRAW,
            amount,
            oracle_price,
            bank_index,
            from: None,
            to: Some(to_user_key),
        };
        emit!(deposit_record);

        {
            let bank = &mut bank_map.get_ref_mut(&bank_index)?;
            let to_user_bank_balance = match to_user.get_bank_balance_mut(bank.bank_index) {
                Some(user_bank_balance) => user_bank_balance,
                None => to_user.add_bank_balance(bank_index, BankBalanceType::Deposit)?,
            };

            controller::bank_balance::update_bank_balances(
                amount as u128,
                &BankBalanceType::Deposit,
                bank,
                to_user_bank_balance,
            )?;
        }

        let deposit_record = DepositRecord {
            ts: clock.unix_timestamp,
            user_authority: *authority_key,
            user: to_user_key,
            direction: DepositDirection::DEPOSIT,
            amount,
            oracle_price,
            bank_index,
            from: Some(from_user_key),
            to: None,
        };
        emit!(deposit_record);

        Ok(())
    }

    pub fn update_bank_cumulative_interest(
        ctx: Context<UpdateBankCumulativeInterest>,
    ) -> Result<()> {
        let bank = &mut load_mut!(ctx.accounts.bank)?;
        let now = Clock::get()?.unix_timestamp;
        controller::bank_balance::update_bank_cumulative_interest(bank, now)?;
        Ok(())
    }

    pub fn place_order(ctx: Context<PlaceOrder>, params: OrderParams) -> Result<()> {
        let remaining_accounts_iter = &mut ctx.remaining_accounts.iter().peekable();
        let mut oracle_map = OracleMap::load(remaining_accounts_iter, Clock::get()?.slot)?;
        let bank_map = BankMap::load(&WritableBanks::new(), remaining_accounts_iter)?;
        let mut market_map = MarketMap::load(&WritableMarkets::new(), remaining_accounts_iter)?;

        if params.immediate_or_cancel {
            msg!("immediate_or_cancel order must be in place_and_make or place_and_take");
            return Err(print_error!(ErrorCode::InvalidOrder)().into());
        }

        controller::repeg::update_amms(
            &mut market_map,
            &mut oracle_map,
            &ctx.accounts.state,
            &Clock::get()?,
        )?;

        controller::orders::place_order(
            &ctx.accounts.state,
            &ctx.accounts.user,
            &market_map,
            &bank_map,
            &mut oracle_map,
            &Clock::get()?,
            params,
        )?;

        Ok(())
    }

    pub fn cancel_order(ctx: Context<CancelOrder>, order_id: Option<u64>) -> Result<()> {
        let remaining_accounts_iter = &mut ctx.remaining_accounts.iter().peekable();
        let mut oracle_map = OracleMap::load(remaining_accounts_iter, Clock::get()?.slot)?;
        let _bank_map = BankMap::load(&WritableMarkets::new(), remaining_accounts_iter)?;
        let mut market_map = MarketMap::load(&WritableMarkets::new(), remaining_accounts_iter)?;

        controller::repeg::update_amms(
            &mut market_map,
            &mut oracle_map,
            &ctx.accounts.state,
            &Clock::get()?,
        )?;

        let order_id = match order_id {
            Some(order_id) => order_id,
            None => {
                let user = load!(ctx.accounts.user)?;
                user.next_order_id - 1
            }
        };

        controller::orders::cancel_order_by_order_id(
            order_id,
            &ctx.accounts.user,
            &market_map,
            &mut oracle_map,
            &Clock::get()?,
        )?;

        Ok(())
    }

    pub fn cancel_order_by_user_id(ctx: Context<CancelOrder>, user_order_id: u8) -> Result<()> {
        let remaining_accounts_iter = &mut ctx.remaining_accounts.iter().peekable();
        let mut oracle_map = OracleMap::load(remaining_accounts_iter, Clock::get()?.slot)?;
        let _bank_map = BankMap::load(&WritableMarkets::new(), remaining_accounts_iter)?;
        let mut market_map = MarketMap::load(&WritableMarkets::new(), remaining_accounts_iter)?;

        controller::repeg::update_amms(
            &mut market_map,
            &mut oracle_map,
            &ctx.accounts.state,
            &Clock::get()?,
        )?;

        controller::orders::cancel_order_by_user_order_id(
            user_order_id,
            &ctx.accounts.user,
            &market_map,
            &mut oracle_map,
            &Clock::get()?,
        )?;

        Ok(())
    }

    #[access_control(
        exchange_not_paused(&ctx.accounts.state)
    )]
    pub fn fill_order<'info>(
        ctx: Context<FillOrder>,
        order_id: Option<u64>,
        maker_order_id: Option<u64>,
    ) -> Result<()> {
        let (order_id, writable_markets) = {
            let user = &load!(ctx.accounts.user)?;
            // if there is no order id, use the users last order id
            let order_id = order_id.unwrap_or(user.next_order_id - 1);
            let order_index = user
                .orders
                .iter()
                .position(|order| order.order_id == order_id)
                .ok_or_else(print_error!(ErrorCode::OrderDoesNotExist))?;
            let order = &user.orders[order_index];

            (order_id, &get_writable_markets(order.market_index))
        };

        let remaining_accounts_iter = &mut ctx.remaining_accounts.iter().peekable();
        let mut oracle_map = OracleMap::load(remaining_accounts_iter, Clock::get()?.slot)?;
        let bank_map = BankMap::load(
            &get_writable_banks(QUOTE_ASSET_BANK_INDEX),
            remaining_accounts_iter,
        )?;
        let mut market_map = MarketMap::load(writable_markets, remaining_accounts_iter)?;

        let maker = match maker_order_id {
            Some(_) => Some(get_maker(remaining_accounts_iter)?),
            None => None,
        };

        controller::repeg::update_amms(
            &mut market_map,
            &mut oracle_map,
            &ctx.accounts.state,
            &Clock::get()?,
        )?;

        let (_, updated_user_state) = controller::orders::fill_order(
            order_id,
            &ctx.accounts.state,
            &ctx.accounts.user,
            &bank_map,
            &market_map,
            &mut oracle_map,
            &ctx.accounts.filler,
            maker.as_ref(),
            maker_order_id,
            &Clock::get()?,
        )?;

        if !updated_user_state {
            return Err(print_error!(ErrorCode::FillOrderDidNotUpdateState)().into());
        }

        Ok(())
    }

    #[access_control(
        exchange_not_paused(&ctx.accounts.state)
    )]
    pub fn place_and_take<'info>(
        ctx: Context<PlaceAndTake>,
        params: OrderParams,
        maker_order_id: Option<u64>,
    ) -> Result<()> {
        let remaining_accounts_iter = &mut ctx.remaining_accounts.iter().peekable();
        let mut oracle_map = OracleMap::load(remaining_accounts_iter, Clock::get()?.slot)?;
        let bank_map = BankMap::load(
            &get_writable_banks(QUOTE_ASSET_BANK_INDEX),
            remaining_accounts_iter,
        )?;
        let mut market_map = MarketMap::load(
            &get_writable_markets_for_user_positions_and_order(
                &load!(ctx.accounts.user)?.positions,
                params.market_index,
            ),
            remaining_accounts_iter,
        )?;

        if params.post_only {
            msg!("post_only cant be used in place_and_take");
            return Err(print_error!(ErrorCode::InvalidOrder)().into());
        }

        let maker = match maker_order_id {
            Some(_) => Some(get_maker(remaining_accounts_iter)?),
            None => None,
        };

        let is_immediate_or_cancel = params.immediate_or_cancel;
        let base_asset_amount_to_fill = params.base_asset_amount;

        controller::repeg::update_amms(
            &mut market_map,
            &mut oracle_map,
            &ctx.accounts.state,
            &Clock::get()?,
        )?;

        controller::orders::place_order(
            &ctx.accounts.state,
            &ctx.accounts.user,
            &market_map,
            &bank_map,
            &mut oracle_map,
            &Clock::get()?,
            params,
        )?;

        let user = &mut ctx.accounts.user;
        let order_id = {
            let user = load!(user)?;
            if user.next_order_id == 1 {
                u64::MAX
            } else {
                user.next_order_id - 1
            }
        };

        let (base_asset_amount_filled, _) = controller::orders::fill_order(
            order_id,
            &ctx.accounts.state,
            user,
            &bank_map,
            &market_map,
            &mut oracle_map,
            &user.clone(),
            maker.as_ref(),
            maker_order_id,
            &Clock::get()?,
        )?;

        if is_immediate_or_cancel && base_asset_amount_to_fill != base_asset_amount_filled {
            controller::orders::cancel_order_by_order_id(
                order_id,
                &ctx.accounts.user,
                &market_map,
                &mut oracle_map,
                &Clock::get()?,
            )?;
        }

        Ok(())
    }

    #[access_control(
        exchange_not_paused(&ctx.accounts.state)
    )]
    pub fn place_and_make<'info>(
        ctx: Context<PlaceAndMake>,
        params: OrderParams,
        taker_order_id: u64,
    ) -> Result<()> {
        let remaining_accounts_iter = &mut ctx.remaining_accounts.iter().peekable();
        let mut oracle_map = OracleMap::load(remaining_accounts_iter, Clock::get()?.slot)?;
        let bank_map = BankMap::load(
            &get_writable_banks(QUOTE_ASSET_BANK_INDEX),
            remaining_accounts_iter,
        )?;
        let mut market_map = MarketMap::load(
            &get_writable_markets_for_user_positions_and_order(
                &load!(ctx.accounts.user)?.positions,
                params.market_index,
            ),
            remaining_accounts_iter,
        )?;

        if !params.immediate_or_cancel || !params.post_only || params.order_type != OrderType::Limit
        {
            msg!("place_and_make must use IOC post only limit order");
            return Err(print_error!(ErrorCode::InvalidOrder)().into());
        }

        let base_asset_amount_to_fill = params.base_asset_amount;

        controller::repeg::update_amms(
            &mut market_map,
            &mut oracle_map,
            &ctx.accounts.state,
            &Clock::get()?,
        )?;

        controller::orders::place_order(
            &ctx.accounts.state,
            &ctx.accounts.user,
            &market_map,
            &bank_map,
            &mut oracle_map,
            &Clock::get()?,
            params,
        )?;

        let user = &mut ctx.accounts.user;
        let order_id = {
            let user = load!(user)?;
            if user.next_order_id == 1 {
                u64::MAX
            } else {
                user.next_order_id - 1
            }
        };

        let (base_asset_amount_filled, _) = controller::orders::fill_order(
            taker_order_id,
            &ctx.accounts.state,
            &ctx.accounts.taker,
            &bank_map,
            &market_map,
            &mut oracle_map,
            &user.clone(),
            Some(&ctx.accounts.user),
            Some(order_id),
            &Clock::get()?,
        )?;

        if base_asset_amount_to_fill != base_asset_amount_filled {
            controller::orders::cancel_order_by_order_id(
                order_id,
                &ctx.accounts.user,
                &market_map,
                &mut oracle_map,
                &Clock::get()?,
            )?;
        }

        Ok(())
    }

    #[access_control(
        exchange_not_paused(&ctx.accounts.state)
    )]
    pub fn trigger_order<'info>(ctx: Context<TriggerOrder>, order_id: u64) -> Result<()> {
        let remaining_accounts_iter = &mut ctx.remaining_accounts.iter().peekable();
        let mut oracle_map = OracleMap::load(remaining_accounts_iter, Clock::get()?.slot)?;
        BankMap::load(&WritableBanks::new(), remaining_accounts_iter)?;
        let market_map = MarketMap::load(&WritableMarkets::new(), remaining_accounts_iter)?;

        controller::orders::trigger_order(
            order_id,
            &ctx.accounts.state,
            &ctx.accounts.user,
            &market_map,
            &mut oracle_map,
            &ctx.accounts.filler,
            &Clock::get()?,
        )?;

        Ok(())
    }

    #[access_control(
        exchange_not_paused(&ctx.accounts.state)
    )]
    pub fn update_amms(ctx: Context<UpdateAMM>, market_indexes: [u64; 5]) -> Result<()> {
        // up to ~60k compute units (per amm) worst case

        let clock = Clock::get()?;

        let state = &ctx.accounts.state;

        let remaining_accounts_iter = &mut ctx.remaining_accounts.iter().peekable();
        let oracle_map = &mut OracleMap::load(remaining_accounts_iter, clock.slot)?;
        let market_map = &mut MarketMap::load(
            &get_writable_markets_list(market_indexes),
            remaining_accounts_iter,
        )?;

        controller::repeg::update_amms(market_map, oracle_map, state, &clock)?;

        Ok(())
    }

    #[access_control(
        exchange_not_paused(&ctx.accounts.state)
    )]
    pub fn settle_pnl(ctx: Context<SettlePNL>, market_index: u64) -> Result<()> {
        let clock = Clock::get()?;
        let remaining_accounts_iter = &mut ctx.remaining_accounts.iter().peekable();
        let mut oracle_map = OracleMap::load(remaining_accounts_iter, clock.slot)?;
        let bank_map = BankMap::load(
            &get_writable_banks(QUOTE_ASSET_BANK_INDEX),
            remaining_accounts_iter,
        )?;
        let mut market_map =
            MarketMap::load(&get_writable_markets(market_index), remaining_accounts_iter)?;

        controller::repeg::update_amms(
            &mut market_map,
            &mut oracle_map,
            &ctx.accounts.state,
            &clock,
        )?;

        {
            let bank = &mut bank_map.get_quote_asset_bank_mut()?;
            controller::bank_balance::update_bank_cumulative_interest(bank, clock.unix_timestamp)?;
        }

        let user = &mut load_mut!(ctx.accounts.user)?;
        let position_index = get_position_index(&user.positions, market_index)?;

        // cannot settle pnl this way on a user who is in liquidation territory
        if !(meets_maintenance_margin_requirement(user, &market_map, &bank_map, &mut oracle_map)?) {
            return Err(ErrorCode::InsufficientCollateralForSettlingPNL.into());
        }

        let market_position = &mut user.positions[position_index];
        let bank = &mut bank_map.get_quote_asset_bank_mut()?;
        let market = &mut market_map.get_ref_mut(&market_index)?;

        let oracle_price = oracle_map.get_price_data(&market.amm.oracle)?.price;
        controller::position::update_cost_basis(market, market_position, oracle_price)?;

        let user_unsettled_pnl = market_position.unsettled_pnl;

        let pnl_to_settle_with_user =
            controller::amm::update_pool_balances(market, bank, user_unsettled_pnl)?;

        if user_unsettled_pnl == 0 {
            msg!("User has no unsettled pnl for market {}", market_index);
            return Ok(());
        } else if pnl_to_settle_with_user == 0 {
            msg!(
                "Pnl Pool cannot currently settle with user for market {}",
                market_index
            );
            return Ok(());
        }

        validate!(
            pnl_to_settle_with_user < 0 || user.authority.eq(&ctx.accounts.authority.key()),
            ErrorCode::UserMustSettleTheirOwnPositiveUnsettledPNL,
            "User must settle their own unsettled pnl when its positive",
        )?;

        controller::bank_balance::update_bank_balances(
            pnl_to_settle_with_user.unsigned_abs(),
            if pnl_to_settle_with_user > 0 {
                &BankBalanceType::Deposit
            } else {
                &BankBalanceType::Borrow
            },
            bank,
            user.get_quote_asset_bank_balance_mut(),
        )?;

        let user_position = &mut user.positions[position_index];

        controller::position::update_unsettled_pnl(
            user_position,
            market,
            -pnl_to_settle_with_user,
        )?;

        Ok(())
    }

    #[access_control(
        exchange_not_paused(&ctx.accounts.state)
    )]
    pub fn liquidate_perp(
        ctx: Context<LiquidatePerp>,
        market_index: u64,
        liquidator_max_base_asset_amount: u128,
    ) -> Result<()> {
        let clock = Clock::get()?;
        let now = clock.unix_timestamp;
        let slot = clock.slot;

        let user_key = ctx.accounts.user.key();
        let liquidator_key = ctx.accounts.liquidator.key();

        validate!(
            user_key != liquidator_key,
            ErrorCode::UserCantLiquidateThemself
        )?;

        let user = &mut load_mut!(ctx.accounts.user)?;
        let liquidator = &mut load_mut!(ctx.accounts.liquidator)?;

        let remaining_accounts_iter = &mut ctx.remaining_accounts.iter().peekable();
        let mut oracle_map = OracleMap::load(remaining_accounts_iter, clock.slot)?;
        let bank_map = BankMap::load(&WritableBanks::new(), remaining_accounts_iter)?;
        let market_map =
            MarketMap::load(&get_writable_markets(market_index), remaining_accounts_iter)?;

        controller::liquidation::liquidate_perp(
            market_index,
            liquidator_max_base_asset_amount,
            user,
            &user_key,
            liquidator,
            &liquidator_key,
            &market_map,
            &bank_map,
            &mut oracle_map,
            slot,
            now,
            ctx.accounts.state.liquidation_margin_buffer_ratio,
            ctx.accounts.state.fee_structure.cancel_order_fee,
        )?;

        Ok(())
    }

    #[access_control(
        exchange_not_paused(&ctx.accounts.state)
    )]
    pub fn liquidate_borrow(
        ctx: Context<LiquidateBorrow>,
        asset_bank_index: u64,
        liability_bank_index: u64,
        liquidator_max_liability_transfer: u128,
    ) -> Result<()> {
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
        let mut oracle_map = OracleMap::load(remaining_accounts_iter, clock.slot)?;

        let mut writable_banks = WritableBanks::new();
        writable_banks.insert(asset_bank_index);
        writable_banks.insert(liability_bank_index);
        let bank_map = BankMap::load(&writable_banks, remaining_accounts_iter)?;
        let market_map = MarketMap::load(&WritableMarkets::new(), remaining_accounts_iter)?;

        controller::liquidation::liquidate_borrow(
            asset_bank_index,
            liability_bank_index,
            liquidator_max_liability_transfer,
            user,
            &user_key,
            liquidator,
            &liquidator_key,
            &market_map,
            &bank_map,
            &mut oracle_map,
            now,
            ctx.accounts.state.liquidation_margin_buffer_ratio,
        )?;

        Ok(())
    }

    #[access_control(
        exchange_not_paused(&ctx.accounts.state)
    )]
    pub fn liquidate_borrow_for_perp_pnl(
        ctx: Context<LiquidateBorrowForPerpPnl>,
        perp_market_index: u64,
        liability_bank_index: u64,
        liquidator_max_liability_transfer: u128,
    ) -> Result<()> {
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
        let mut oracle_map = OracleMap::load(remaining_accounts_iter, clock.slot)?;

        let mut writable_banks = WritableBanks::new();
        writable_banks.insert(liability_bank_index);
        let bank_map = BankMap::load(&writable_banks, remaining_accounts_iter)?;
        let market_map = MarketMap::load(&WritableMarkets::new(), remaining_accounts_iter)?;

        controller::liquidation::liquidate_borrow_for_perp_pnl(
            perp_market_index,
            liability_bank_index,
            liquidator_max_liability_transfer,
            user,
            &user_key,
            liquidator,
            &liquidator_key,
            &market_map,
            &bank_map,
            &mut oracle_map,
            now,
            ctx.accounts.state.liquidation_margin_buffer_ratio,
        )?;

        Ok(())
    }

    #[access_control(
        exchange_not_paused(&ctx.accounts.state)
    )]
    pub fn liquidate_perp_pnl_for_deposit(
        ctx: Context<LiquidatePerpPnlForDeposit>,
        perp_market_index: u64,
        asset_bank_index: u64,
        liquidator_max_pnl_transfer: u128,
    ) -> Result<()> {
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
        let mut oracle_map = OracleMap::load(remaining_accounts_iter, clock.slot)?;

        let mut writable_banks = WritableBanks::new();
        writable_banks.insert(asset_bank_index);
        let bank_map = BankMap::load(&writable_banks, remaining_accounts_iter)?;
        let market_map = MarketMap::load(&WritableMarkets::new(), remaining_accounts_iter)?;

        controller::liquidation::liquidate_perp_pnl_for_deposit(
            perp_market_index,
            asset_bank_index,
            liquidator_max_pnl_transfer,
            user,
            &user_key,
            liquidator,
            &liquidator_key,
            &market_map,
            &bank_map,
            &mut oracle_map,
            now,
            ctx.accounts.state.liquidation_margin_buffer_ratio,
        )?;

        Ok(())
    }

    #[allow(unused_must_use)]
    #[access_control(
        market_initialized(&ctx.accounts.market) &&
        exchange_not_paused(&ctx.accounts.state) &&
        admin_controls_prices(&ctx.accounts.state)
    )]
    pub fn move_amm_price(
        ctx: Context<MoveAMMPrice>,
        base_asset_reserve: u128,
        quote_asset_reserve: u128,
    ) -> Result<()> {
        let market = &mut load_mut!(ctx.accounts.market)?;
        controller::amm::move_price(&mut market.amm, base_asset_reserve, quote_asset_reserve)?;
        Ok(())
    }

    #[access_control(
        market_initialized(&ctx.accounts.market)
    )]
    pub fn withdraw_from_market_to_insurance_vault(
        ctx: Context<WithdrawFromMarketToInsuranceVault>,
        amount: u64,
    ) -> Result<()> {
        let market = &mut load_mut!(ctx.accounts.market)?;

        // A portion of fees must always remain in protocol to be used to keep markets optimal
        let max_withdraw = market
            .amm
            .total_exchange_fee
            .checked_mul(SHARE_OF_FEES_ALLOCATED_TO_CLEARING_HOUSE_NUMERATOR)
            .ok_or_else(math_error!())?
            .checked_div(SHARE_OF_FEES_ALLOCATED_TO_CLEARING_HOUSE_DENOMINATOR)
            .ok_or_else(math_error!())?
            .checked_sub(market.amm.total_fee_withdrawn)
            .ok_or_else(math_error!())?;

        let bank = &mut load_mut!(ctx.accounts.bank)?;

        let amm_fee_pool_token_amount =
            get_token_amount(market.amm.fee_pool.balance, bank, &BankBalanceType::Deposit)?;

        if cast_to_u128(amount)? > max_withdraw {
            msg!("withdraw size exceeds max_withdraw: {:?}", max_withdraw);
            return Err(ErrorCode::AdminWithdrawTooLarge.into());
        }

        if cast_to_u128(amount)? > amm_fee_pool_token_amount {
            msg!(
                "withdraw size exceeds amm_fee_pool_token_amount: {:?}",
                amm_fee_pool_token_amount
            );
            return Err(ErrorCode::AdminWithdrawTooLarge.into());
        }

        controller::token::send_from_bank_vault(
            &ctx.accounts.token_program,
            &ctx.accounts.bank_vault,
            &ctx.accounts.recipient,
            &ctx.accounts.bank_vault_authority,
            0,
            bank.vault_authority_nonce,
            amount,
        )?;

        controller::bank_balance::update_bank_balances(
            cast_to_u128(amount)?,
            &BankBalanceType::Borrow,
            bank,
            &mut market.amm.fee_pool,
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
    ) -> Result<()> {
        controller::token::send_from_insurance_vault(
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
        market_initialized(&ctx.accounts.market)
    )]
    pub fn withdraw_from_insurance_vault_to_market(
        ctx: Context<WithdrawFromInsuranceVaultToMarket>,
        amount: u64,
    ) -> Result<()> {
        let market = &mut load_mut!(ctx.accounts.market)?;

        // The admin can move fees from the insurance fund back to the protocol so that money in
        // the insurance fund can be used to make market more optimal
        // 100% goes to user fee pool (symmetric funding, repeg, and k adjustments)
        market.amm.total_fee_minus_distributions = market
            .amm
            .total_fee_minus_distributions
            .checked_add(cast(amount)?)
            .ok_or_else(math_error!())?;

        let bank = &mut load_mut!(ctx.accounts.bank)?;

        controller::bank_balance::update_bank_balances(
            cast_to_u128(amount)?,
            &BankBalanceType::Deposit,
            bank,
            &mut market.amm.fee_pool,
        )?;

        controller::token::send_from_insurance_vault(
            &ctx.accounts.token_program,
            &ctx.accounts.insurance_vault,
            &ctx.accounts.bank_vault,
            &ctx.accounts.insurance_vault_authority,
            ctx.accounts.state.insurance_vault_nonce,
            amount,
        )?;
        Ok(())
    }

    #[allow(unused_must_use)]
    #[access_control(
        market_initialized(&ctx.accounts.market) &&
        exchange_not_paused(&ctx.accounts.state) &&
        valid_oracle_for_market(&ctx.accounts.oracle, &ctx.accounts.market)
    )]
    pub fn repeg_amm_curve(ctx: Context<RepegCurve>, new_peg_candidate: u128) -> Result<()> {
        let clock = Clock::get()?;
        let now = clock.unix_timestamp;
        let clock_slot = clock.slot;

        let market = &mut load_mut!(ctx.accounts.market)?;
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

        emit!(CurveRecord {
            ts: now,
            record_id: get_then_update_id!(market, next_curve_record_id),
            market_index: market.market_index,
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
            net_base_asset_amount: market.amm.net_base_asset_amount,
            open_interest: market.open_interest,
            total_fee: market.amm.total_fee,
            total_fee_minus_distributions: market.amm.total_fee_minus_distributions,
            adjustment_cost,
            oracle_price,
            fill_record: 0,
        });

        Ok(())
    }

    #[allow(unused_must_use)]
    #[access_control(
        market_initialized(&ctx.accounts.market) &&
        valid_oracle_for_market(&ctx.accounts.oracle, &ctx.accounts.market)
    )]
    pub fn update_amm_oracle_twap(ctx: Context<RepegCurve>) -> Result<()> {
        // allow update to amm's oracle twap iff price gap is reduced and thus more tame funding
        // otherwise if oracle error or funding flip: set oracle twap to mark twap (0 gap)

        let clock = Clock::get()?;
        let now = clock.unix_timestamp;

        let market = &mut load_mut!(ctx.accounts.market)?;
        let price_oracle = &ctx.accounts.oracle;
        let oracle_twap = market.amm.get_oracle_twap(price_oracle)?;

        if let Some(oracle_twap) = oracle_twap {
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
        market_initialized(&ctx.accounts.market) &&
        valid_oracle_for_market(&ctx.accounts.oracle, &ctx.accounts.market)
     )]
    pub fn reset_amm_oracle_twap(ctx: Context<RepegCurve>) -> Result<()> {
        // if oracle is invalid, failsafe to reset amm oracle_twap to the mark_twap

        let clock = Clock::get()?;
        let now = clock.unix_timestamp;
        let clock_slot = clock.slot;

        let market = &mut load_mut!(ctx.accounts.market)?;
        let price_oracle = &ctx.accounts.oracle;
        let oracle_price_data = &market.amm.get_oracle_price(price_oracle, clock_slot)?;

        let is_oracle_valid = amm::is_oracle_valid(
            &market.amm,
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
        user_id: u8,
        name: [u8; 32],
    ) -> Result<()> {
        let mut user = ctx
            .accounts
            .user
            .load_init()
            .or(Err(ErrorCode::UnableToLoadAccountLoader))?;
        user.authority = ctx.accounts.authority.key();
        user.user_id = user_id;
        user.name = name;
        user.next_order_id = 1;
        Ok(())
    }

    #[access_control(
        exchange_not_paused(&ctx.accounts.state)
    )]
    pub fn settle_funding_payment(ctx: Context<SettleFunding>) -> Result<()> {
        let clock = Clock::get()?;
        let now = clock.unix_timestamp;

        let user_key = ctx.accounts.user.key();
        let user = &mut load_mut!(ctx.accounts.user)?;

        let remaining_accounts_iter = &mut ctx.remaining_accounts.iter().peekable();
        let market_map = MarketMap::load(
            &get_writable_markets_for_user_positions(&user.positions),
            remaining_accounts_iter,
        )?;

        controller::funding::settle_funding_payments(user, &user_key, &market_map, now)?;
        Ok(())
    }

    #[allow(unused_must_use)]
    #[access_control(
        market_initialized(&ctx.accounts.market) &&
        exchange_not_paused(&ctx.accounts.state) &&
        valid_oracle_for_market(&ctx.accounts.oracle, &ctx.accounts.market)
    )]
    pub fn update_funding_rate(ctx: Context<UpdateFundingRate>, market_index: u64) -> Result<()> {
        let market = &mut load_mut!(ctx.accounts.market)?;
        let clock = Clock::get()?;
        let now = clock.unix_timestamp;
        let clock_slot = clock.slot;
        let state = &ctx.accounts.state;
        let mut oracle_map = OracleMap::load_one(&ctx.accounts.oracle, clock_slot)?;

        let oracle_price_data = &oracle_map.get_price_data(&market.amm.oracle)?;
        controller::repeg::update_amm(market, oracle_price_data, state, now, clock_slot)?;

        validate!(
            (clock_slot == market.amm.last_update_slot || market.amm.curve_update_intensity == 0),
            ErrorCode::AMMNotUpdatedInSameSlot,
            "AMM must be updated in a prior instruction within same slot"
        )?;

        let is_updated = controller::funding::update_funding_rate(
            market_index,
            market,
            &mut oracle_map,
            now,
            &state.oracle_guard_rails,
            state.funding_paused,
            None,
        )?;

        if !is_updated {
            return Err(ErrorCode::InvalidFundingProfitability.into());
        }

        Ok(())
    }

    #[allow(unused_must_use)]
    #[access_control(
        market_initialized(&ctx.accounts.market) &&
        valid_oracle_for_market(&ctx.accounts.oracle, &ctx.accounts.market) &&
        exchange_not_paused(&ctx.accounts.state)
    )]
    pub fn update_k(ctx: Context<AdminUpdateK>, sqrt_k: u128) -> Result<()> {
        let clock = Clock::get()?;
        let now = clock.unix_timestamp;

        let market = &mut load_mut!(ctx.accounts.market)?;

        let base_asset_amount_long = market.base_asset_amount_long.unsigned_abs();
        let base_asset_amount_short = market.base_asset_amount_short.unsigned_abs();
        let net_base_asset_amount = market.amm.net_base_asset_amount;
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

        let new_sqrt_k_u192 = bn::U192::from(sqrt_k);

        let update_k_result = get_update_k_result(market, new_sqrt_k_u192)?;

        let adjustment_cost = math::amm::adjust_k_cost(market, &update_k_result)?;

        math::amm::update_k(market, &update_k_result);

        if adjustment_cost > 0 {
            let max_cost = market
                .amm
                .total_fee_minus_distributions
                .checked_sub(cast_to_i128(market.amm.total_fee_withdrawn)?)
                .ok_or_else(math_error!())?;
            if adjustment_cost > max_cost {
                return Err(ErrorCode::InvalidUpdateK.into());
            }
        }

        market.amm.total_fee_minus_distributions = market
            .amm
            .total_fee_minus_distributions
            .checked_add(adjustment_cost)
            .ok_or_else(math_error!())?;

        market.amm.net_revenue_since_last_funding = market
            .amm
            .net_revenue_since_last_funding
            .checked_add(adjustment_cost as i64)
            .ok_or_else(math_error!())?;

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
            msg!(
                "{:?} -> {:?} (> {:?})",
                price_before,
                price_after,
                UPDATE_K_ALLOWED_PRICE_CHANGE
            );
            return Err(ErrorCode::InvalidUpdateK.into());
        }

        let k_sqrt_check = bn::U192::from(amm.base_asset_reserve)
            .checked_mul(bn::U192::from(amm.quote_asset_reserve))
            .ok_or_else(math_error!())?
            .integer_sqrt()
            .try_to_u128()?;

        let k_err = cast_to_i128(k_sqrt_check)?
            .checked_sub(cast_to_i128(amm.sqrt_k)?)
            .ok_or_else(math_error!())?;

        if k_err.unsigned_abs() > 100 {
            msg!("k_err={:?}, {:?} != {:?}", k_err, k_sqrt_check, amm.sqrt_k);
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

        emit!(CurveRecord {
            ts: now,
            record_id: get_then_update_id!(market, next_curve_record_id),
            market_index: market.market_index,
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
            net_base_asset_amount,
            open_interest,
            adjustment_cost,
            total_fee,
            total_fee_minus_distributions,
            oracle_price,
            fill_record: 0,
        });

        Ok(())
    }

    #[access_control(
        market_initialized(&ctx.accounts.market)
    )]
    pub fn update_margin_ratio(
        ctx: Context<AdminUpdateMarket>,
        margin_ratio_initial: u32,
        margin_ratio_maintenance: u32,
    ) -> Result<()> {
        let market = &mut load_mut!(ctx.accounts.market)?;
        validate_margin(
            margin_ratio_initial,
            margin_ratio_maintenance,
            market.liquidation_fee,
        )?;

        market.margin_ratio_initial = margin_ratio_initial;
        market.margin_ratio_maintenance = margin_ratio_maintenance;
        Ok(())
    }

    #[access_control(
        market_initialized(&ctx.accounts.market)
    )]
    pub fn update_perp_liquidation_fee(
        ctx: Context<AdminUpdateMarket>,
        liquidation_fee: u128,
    ) -> Result<()> {
        let market = &mut load_mut!(ctx.accounts.market)?;
        validate!(
            liquidation_fee < LIQUIDATION_FEE_PRECISION,
            ErrorCode::DefaultError,
            "Liquidation fee must be less than 100%"
        )?;

        validate_margin(
            market.margin_ratio_initial,
            market.margin_ratio_maintenance,
            liquidation_fee,
        )?;

        market.liquidation_fee = liquidation_fee;
        Ok(())
    }

    pub fn update_bank_liquidation_fee(
        ctx: Context<AdminUpdateBank>,
        liquidation_fee: u128,
    ) -> Result<()> {
        let bank = &mut load_mut!(ctx.accounts.bank)?;
        validate!(
            liquidation_fee < LIQUIDATION_FEE_PRECISION,
            ErrorCode::DefaultError,
            "Liquidation fee must be less than 100%"
        )?;

        bank.liquidation_fee = liquidation_fee;
        Ok(())
    }

    #[access_control(
        market_initialized(&ctx.accounts.market)
    )]
    pub fn update_market_imf_factor(
        ctx: Context<AdminUpdateMarket>,
        imf_factor: u128,
    ) -> Result<()> {
        validate!(
            imf_factor <= BANK_IMF_PRECISION,
            ErrorCode::DefaultError,
            "invalid imf factor",
        )?;
        let market = &mut load_mut!(ctx.accounts.market)?;
        market.imf_factor = imf_factor;
        Ok(())
    }

    #[access_control(
        market_initialized(&ctx.accounts.market)
    )]
    pub fn update_market_unsettled_asset_weight(
        ctx: Context<AdminUpdateMarket>,
        unsettled_initial_asset_weight: u8,
        unsettled_maintenance_asset_weight: u8,
    ) -> Result<()> {
        validate!(
            unsettled_initial_asset_weight <= 100,
            ErrorCode::DefaultError,
            "invalid unsettled_initial_asset_weight",
        )?;
        validate!(
            unsettled_maintenance_asset_weight <= 100,
            ErrorCode::DefaultError,
            "invalid unsettled_maintenance_asset_weight",
        )?;
        validate!(
            unsettled_initial_asset_weight <= unsettled_maintenance_asset_weight,
            ErrorCode::DefaultError,
            "must enforce unsettled_initial_asset_weight <= unsettled_maintenance_asset_weight",
        )?;
        let market = &mut load_mut!(ctx.accounts.market)?;
        market.unsettled_initial_asset_weight = unsettled_initial_asset_weight;
        market.unsettled_maintenance_asset_weight = unsettled_maintenance_asset_weight;
        Ok(())
    }

    #[access_control(
        market_initialized(&ctx.accounts.market)
    )]
    pub fn update_curve_update_intensity(
        ctx: Context<AdminUpdateMarket>,
        curve_update_intensity: u8,
    ) -> Result<()> {
        validate!(
            curve_update_intensity <= 100,
            ErrorCode::DefaultError,
            "invalid curve_update_intensity",
        )?;
        let market = &mut load_mut!(ctx.accounts.market)?;
        market.amm.curve_update_intensity = curve_update_intensity;
        Ok(())
    }

    pub fn update_partial_liquidation_close_percentage(
        ctx: Context<AdminUpdateState>,
        numerator: u128,
        denominator: u128,
    ) -> Result<()> {
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
    ) -> Result<()> {
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
    ) -> Result<()> {
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
    ) -> Result<()> {
        ctx.accounts
            .state
            .partial_liquidation_liquidator_share_denominator = denominator;
        Ok(())
    }

    pub fn update_full_liquidation_liquidator_share_denominator(
        ctx: Context<AdminUpdateState>,
        denominator: u64,
    ) -> Result<()> {
        ctx.accounts
            .state
            .full_liquidation_liquidator_share_denominator = denominator;
        Ok(())
    }

    pub fn update_fee(ctx: Context<AdminUpdateState>, fees: FeeStructure) -> Result<()> {
        ctx.accounts.state.fee_structure = fees;
        Ok(())
    }

    pub fn update_order_filler_reward_structure(
        ctx: Context<AdminUpdateState>,
        order_filler_reward_structure: OrderFillerRewardStructure,
    ) -> Result<()> {
        ctx.accounts.state.fee_structure.filler_reward_structure = order_filler_reward_structure;
        Ok(())
    }

    pub fn update_oracle_guard_rails(
        ctx: Context<AdminUpdateState>,
        oracle_guard_rails: OracleGuardRails,
    ) -> Result<()> {
        ctx.accounts.state.oracle_guard_rails = oracle_guard_rails;
        Ok(())
    }

    #[access_control(
        market_initialized(&ctx.accounts.market)
    )]
    pub fn update_market_oracle(
        ctx: Context<AdminUpdateMarket>,
        oracle: Pubkey,
        oracle_source: OracleSource,
    ) -> Result<()> {
        let market = &mut load_mut!(ctx.accounts.market)?;
        market.amm.oracle = oracle;
        market.amm.oracle_source = oracle_source;
        Ok(())
    }

    #[access_control(
        market_initialized(&ctx.accounts.market)
    )]
    pub fn update_market_minimum_quote_asset_trade_size(
        ctx: Context<AdminUpdateMarket>,
        minimum_trade_size: u128,
    ) -> Result<()> {
        let market = &mut load_mut!(ctx.accounts.market)?;
        market.amm.minimum_quote_asset_trade_size = minimum_trade_size;
        Ok(())
    }

    #[access_control(
        market_initialized(&ctx.accounts.market)
    )]
    pub fn update_market_base_spread(
        ctx: Context<AdminUpdateMarket>,
        base_spread: u16,
    ) -> Result<()> {
        let market = &mut load_mut!(ctx.accounts.market)?;
        market.amm.base_spread = base_spread;
        market.amm.long_spread = (base_spread / 2) as u128;
        market.amm.short_spread = (base_spread / 2) as u128;
        Ok(())
    }

    #[access_control(
        market_initialized(&ctx.accounts.market)
    )]
    pub fn update_market_max_spread(
        ctx: Context<AdminUpdateMarket>,
        max_spread: u32,
    ) -> Result<()> {
        let market = &mut load_mut!(ctx.accounts.market)?;
        validate!(
            (max_spread > market.amm.base_spread as u32)
                && (max_spread <= market.margin_ratio_initial * 100),
            ErrorCode::DefaultError,
            "invalid max_spread",
        )?;

        market.amm.max_spread = max_spread;

        Ok(())
    }

    #[access_control(
        market_initialized(&ctx.accounts.market)
    )]
    pub fn update_market_base_asset_amount_step_size(
        ctx: Context<AdminUpdateMarket>,
        minimum_trade_size: u128,
    ) -> Result<()> {
        let market = &mut load_mut!(ctx.accounts.market)?;
        market.amm.base_asset_amount_step_size = minimum_trade_size;
        Ok(())
    }

    #[access_control(
        market_initialized(&ctx.accounts.market)
    )]
    pub fn update_market_max_slippage_ratio(
        ctx: Context<AdminUpdateMarket>,
        max_slippage_ratio: u16,
    ) -> Result<()> {
        validate!(max_slippage_ratio > 0, ErrorCode::DefaultError)?;
        let market = &mut load_mut!(ctx.accounts.market)?;
        market.amm.max_slippage_ratio = max_slippage_ratio;
        Ok(())
    }

    #[access_control(
        market_initialized(&ctx.accounts.market)
    )]
    pub fn update_max_base_asset_amount_ratio(
        ctx: Context<AdminUpdateMarket>,
        max_base_asset_amount_ratio: u16,
    ) -> Result<()> {
        validate!(max_base_asset_amount_ratio > 0, ErrorCode::DefaultError)?;
        let market = &mut load_mut!(ctx.accounts.market)?;
        market.amm.max_base_asset_amount_ratio = max_base_asset_amount_ratio;
        Ok(())
    }

    pub fn update_admin(ctx: Context<AdminUpdateState>, admin: Pubkey) -> Result<()> {
        ctx.accounts.state.admin = admin;
        Ok(())
    }

    pub fn update_whitelist_mint(
        ctx: Context<AdminUpdateState>,
        whitelist_mint: Pubkey,
    ) -> Result<()> {
        ctx.accounts.state.whitelist_mint = whitelist_mint;
        Ok(())
    }

    pub fn update_discount_mint(
        ctx: Context<AdminUpdateState>,
        discount_mint: Pubkey,
    ) -> Result<()> {
        ctx.accounts.state.discount_mint = discount_mint;
        Ok(())
    }

    pub fn update_exchange_paused(
        ctx: Context<AdminUpdateState>,
        exchange_paused: bool,
    ) -> Result<()> {
        ctx.accounts.state.exchange_paused = exchange_paused;
        Ok(())
    }

    pub fn disable_admin_controls_prices(ctx: Context<AdminUpdateState>) -> Result<()> {
        ctx.accounts.state.admin_controls_prices = false;
        Ok(())
    }

    pub fn update_funding_paused(
        ctx: Context<AdminUpdateState>,
        funding_paused: bool,
    ) -> Result<()> {
        ctx.accounts.state.funding_paused = funding_paused;
        Ok(())
    }

    pub fn update_auction_duration(
        ctx: Context<AdminUpdateState>,
        min_auction_duration: u8,
        max_auction_duration: u8,
    ) -> Result<()> {
        validate!(
            min_auction_duration <= max_auction_duration,
            ErrorCode::DefaultError,
            "min auction duration must be less than or equal to max auction duration",
        )?;

        ctx.accounts.state.min_auction_duration = min_auction_duration;
        ctx.accounts.state.max_auction_duration = max_auction_duration;
        Ok(())
    }
}

fn market_initialized(market: &AccountLoader<Market>) -> Result<()> {
    if !market.load()?.initialized {
        return Err(ErrorCode::MarketIndexNotInitialized.into());
    }
    Ok(())
}

fn valid_oracle_for_market(oracle: &AccountInfo, market: &AccountLoader<Market>) -> Result<()> {
    if !market.load()?.amm.oracle.eq(oracle.key) {
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
