#![allow(clippy::too_many_arguments)]
#![allow(unaligned_references)]
#![allow(clippy::bool_assert_comparison)]

use anchor_lang::prelude::*;
use borsh::BorshSerialize;

use context::*;
use error::ErrorCode;
use math::{amm, bn, constants::*, margin::*};
use state::oracle::{get_oracle_price, OracleSource};

use crate::math::amm::get_update_k_result;
use crate::state::events::{LPAction, LPRecord};
use crate::state::market::Market;
use crate::state::user::MarketPosition;
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
declare_id!("3v1iEjbSSLSSYyt1pmx4UB5rqJGurmz71RibXF7X6UF3");

#[program]
pub mod clearing_house {
    use std::cmp::min;
    use std::option::Option::Some;

    use crate::controller::lp::burn_lp_shares;
    use crate::controller::lp::settle_lp_position;
    use crate::controller::position::{add_new_position, get_position_index};
    use crate::margin_validation::validate_margin;
    use crate::math;
    use crate::math::bank_balance::get_token_amount;
    use crate::math::casting::{cast, cast_to_i128, cast_to_u128, cast_to_u32};
    use crate::optional_accounts::{get_maker_and_maker_stats, get_referrer_and_referrer_stats};
    use crate::state::bank::{Bank, BankBalanceType};
    use crate::state::bank_map::{get_writable_banks, BankMap, WritableBanks};
    use crate::state::events::{CurveRecord, DepositRecord};
    use crate::state::events::{DepositDirection, NewUserRecord};
    use crate::state::market::{Market, PoolBalance};
    use crate::state::market_map::{
        get_market_set, get_market_set_for_user_positions, get_market_set_from_list, MarketMap,
        MarketSet,
    };
    use crate::state::oracle::OraclePriceData;
    use crate::state::oracle_map::OracleMap;
    use crate::state::state::OrderFillerRewardStructure;

    use super::*;
    use crate::state::insurance_fund_stake::InsuranceFundStake;

    pub fn initialize(ctx: Context<Initialize>, admin_controls_prices: bool) -> Result<()> {
        let (clearing_house_signer, clearing_house_signer_nonce) =
            Pubkey::find_program_address(&[b"clearing_house_signer".as_ref()], ctx.program_id);

        let insurance_vault = &ctx.accounts.insurance_vault;
        if insurance_vault.owner != clearing_house_signer {
            return Err(ErrorCode::InvalidInsuranceFundAuthority.into());
        }

        **ctx.accounts.state = State {
            admin: *ctx.accounts.admin.key,
            funding_paused: false,
            exchange_paused: false,
            admin_controls_prices,
            insurance_vault: insurance_vault.key(),
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
            signer: clearing_house_signer,
            signer_nonce: clearing_house_signer_nonce,
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

        // clearing house must be authority of collateral vault
        if ctx.accounts.bank_vault.owner != state.signer {
            return Err(ErrorCode::InvalidBankAuthority.into());
        }

        // clearing house must be authority of collateral vault
        if ctx.accounts.insurance_fund_vault.owner != state.signer {
            return Err(ErrorCode::InvalidInsuranceFundAuthority.into());
        }

        validate!(
            optimal_utilization <= BANK_UTILIZATION_PRECISION,
            ErrorCode::InvalidBankInitialization,
            "For bank, optimal_utilization must be < {}",
            BANK_UTILIZATION_PRECISION
        )?;

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
        let now = cast(Clock::get()?.unix_timestamp).or(Err(ErrorCode::UnableToCastUnixTime))?;

        **bank = Bank {
            bank_index,
            pubkey: bank_pubkey,
            oracle: ctx.accounts.oracle.key(),
            oracle_source,
            mint: ctx.accounts.bank_mint.key(),
            vault: *ctx.accounts.bank_vault.to_account_info().key,
            insurance_fund_vault: *ctx.accounts.insurance_fund_vault.to_account_info().key,
            revenue_pool: PoolBalance { balance: 0 },
            total_if_factor: 0,
            user_if_factor: 0,
            total_if_shares: 0,
            user_if_shares: 0,
            if_shares_base: 0,
            insurance_withdraw_escrow_period: 0,
            last_revenue_settle_ts: 0,
            revenue_settle_period: 0, // how often can be settled
            decimals: ctx.accounts.bank_mint.decimals,
            optimal_utilization,
            optimal_borrow_rate,
            max_borrow_rate,
            deposit_balance: 0,
            borrow_balance: 0,
            deposit_token_twap: 0,
            borrow_token_twap: 0,
            utilization_twap: 0, // todo: use for dynamic interest / additional guards
            cumulative_deposit_interest: BANK_CUMULATIVE_INTEREST_PRECISION,
            cumulative_borrow_interest: BANK_CUMULATIVE_INTEREST_PRECISION,
            last_interest_ts: now,
            last_twap_ts: now,
            initial_asset_weight,
            maintenance_asset_weight,
            initial_liability_weight,
            maintenance_liability_weight,
            imf_factor,
            liquidation_fee,
            liquidation_if_factor: 0,
            withdraw_guard_threshold: 0,
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

        let (min_base_asset_reserve, max_base_asset_reserve) =
            amm::calculate_bid_ask_bounds(amm_base_asset_reserve)?;

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

        let max_spread = margin_ratio_initial * (100 - 5) / 2; // init 10% below the oracle price threshold

        validate_margin(
            margin_ratio_initial,
            margin_ratio_maintenance,
            liquidation_fee,
            max_spread,
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
            revenue_withdraw_since_last_settle: 0,
            max_revenue_withdraw_per_period: 0,
            last_revenue_withdraw_ts: now,
            unrealized_initial_asset_weight: 100,     // 100%
            unrealized_maintenance_asset_weight: 100, // 100%
            unrealized_imf_factor: 0,
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
                last_funding_rate: 0,
                last_funding_rate_long: 0,
                last_funding_rate_short: 0,
                last_funding_rate_ts: now,
                funding_period: amm_periodicity,
                last_oracle_price_twap,
                last_oracle_price_twap_5min: oracle_price,
                last_mark_price_twap: init_mark_price,
                last_mark_price_twap_5min: init_mark_price,
                last_mark_price_twap_ts: now,
                sqrt_k: amm_base_asset_reserve,
                min_base_asset_reserve,
                max_base_asset_reserve,
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
                max_spread,
                last_bid_price_twap: init_mark_price,
                last_ask_price_twap: init_mark_price,
                net_base_asset_amount: 0,
                quote_asset_amount_long: 0,
                quote_asset_amount_short: 0,
                quote_entry_amount_long: 0,
                quote_entry_amount_short: 0,
                mark_std: 0,
                long_intensity_count: 0,
                long_intensity_volume: 0,
                short_intensity_count: 0,
                short_intensity_volume: 0,
                curve_update_intensity: 0,
                fee_pool: PoolBalance { balance: 0 },
                market_position_per_lp: MarketPosition {
                    market_index,
                    ..MarketPosition::default()
                },
                market_position: MarketPosition {
                    market_index,
                    ..MarketPosition::default()
                },
                last_update_slot: clock_slot,

                // lp stuff
                net_unsettled_lp_base_asset_amount: 0,
                user_lp_shares: 0,
                lp_cooldown_time: 1,  // TODO: what should this be?
                amm_jit_intensity: 0, // turn it off at the start

                last_oracle_valid: false,
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
        let user_stats = &mut load_mut!(ctx.accounts.user_stats)?;
        let clock = Clock::get()?;
        let now = clock.unix_timestamp;

        validate!(!user.bankrupt, ErrorCode::UserBankrupt)?;

        let remaining_accounts_iter = &mut ctx.remaining_accounts.iter().peekable();
        let mut oracle_map = OracleMap::load(remaining_accounts_iter, clock.slot)?;
        let bank_map = BankMap::load(&get_writable_banks(bank_index), remaining_accounts_iter)?;

        let _market_map = MarketMap::load(
            &WritableBanks::new(),
            &MarketSet::new(),
            remaining_accounts_iter,
        )?;

        if amount == 0 {
            return Err(ErrorCode::InsufficientDeposit.into());
        }

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
            false,
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
            referrer: user_stats.referrer,
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
        let user_stats = &mut load_mut!(ctx.accounts.user_stats)?;
        let clock = Clock::get()?;
        let now = clock.unix_timestamp;
        let state = &ctx.accounts.state;

        validate!(!user.bankrupt, ErrorCode::UserBankrupt)?;

        let remaining_accounts_iter = &mut ctx.remaining_accounts.iter().peekable();
        let mut oracle_map = OracleMap::load(remaining_accounts_iter, clock.slot)?;
        let bank_map = BankMap::load(&get_writable_banks(bank_index), remaining_accounts_iter)?;
        let market_map = MarketMap::load(
            &MarketSet::new(),
            &MarketSet::new(),
            remaining_accounts_iter,
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

            // prevents withdraw when limits hit
            controller::bank_balance::update_bank_balances_with_limits(
                amount as u128,
                &BankBalanceType::Borrow,
                bank,
                user_bank_balance,
            )?;

            // todo: prevents borrow when bank market's oracle invalid
            amount
        };

        if !meets_initial_margin_requirement(user, &market_map, &bank_map, &mut oracle_map)? {
            return Err(ErrorCode::InsufficientCollateral.into());
        }

        user.being_liquidated = false;

        let bank = bank_map.get_ref(&bank_index)?;
        controller::token::send_from_program_vault(
            &ctx.accounts.token_program,
            &ctx.accounts.bank_vault,
            &ctx.accounts.user_token_account,
            &ctx.accounts.clearing_house_signer,
            state.signer_nonce,
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
            referrer: user_stats.referrer,
            from: None,
            to: None,
        };
        emit!(deposit_record);

        // reload the bank vault balance so it's up-to-date
        ctx.accounts.bank_vault.reload()?;
        math::bank_balance::validate_bank_balances(&bank)?;

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
        let user_stats = &mut load_mut!(ctx.accounts.user_stats)?;

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
        let mut oracle_map = OracleMap::load(remaining_accounts_iter, clock.slot)?;
        let bank_map = BankMap::load(&get_writable_banks(bank_index), remaining_accounts_iter)?;
        let market_map = MarketMap::load(
            &MarketSet::new(),
            &MarketSet::new(),
            remaining_accounts_iter,
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
                true,
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
            referrer: user_stats.referrer,
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
                false,
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
            referrer: user_stats.referrer,
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

    #[access_control(
        exchange_not_paused(&ctx.accounts.state)
    )]
    pub fn settle_lp<'info>(ctx: Context<SettleLP>, market_index: u64) -> Result<()> {
        let user_key = ctx.accounts.user.key();
        let user = &mut load_mut!(ctx.accounts.user)?;
        let clock = Clock::get()?;
        let now = clock.unix_timestamp;

        let remaining_accounts_iter = &mut ctx.remaining_accounts.iter().peekable();
        let _oracle_map = OracleMap::load(remaining_accounts_iter, clock.slot)?;
        let _bank_map = BankMap::load(&WritableBanks::new(), remaining_accounts_iter)?;
        let market_map = MarketMap::load(
            &get_market_set(market_index),
            &MarketSet::new(),
            remaining_accounts_iter,
        )?;

        {
            let mut market = market_map.get_ref_mut(&market_index)?;
            controller::funding::settle_funding_payment(user, &user_key, &mut market, now)?;
        }

        let mut market = market_map.get_ref_mut(&market_index)?;
        let position_index = get_position_index(&user.positions, market_index)?;
        let position = &mut user.positions[position_index];

        let (position_delta, pnl) = settle_lp_position(position, &mut market)?;

        emit!(LPRecord {
            ts: now,
            action: LPAction::SettleLiquidity,
            user: user_key,
            market_index,
            delta_base_asset_amount: position_delta.base_asset_amount,
            delta_quote_asset_amount: position_delta.quote_asset_amount,
            pnl,
            n_shares: 0
        });

        Ok(())
    }

    #[access_control(
        exchange_not_paused(&ctx.accounts.state)
    )]
    pub fn remove_liquidity<'info>(
        ctx: Context<AddRemoveLiquidity>,
        shares_to_burn: u128,
        market_index: u64,
    ) -> Result<()> {
        let user_key = ctx.accounts.user.key();
        let user = &mut load_mut!(ctx.accounts.user)?;
        let clock = Clock::get()?;
        let now = clock.unix_timestamp;

        let remaining_accounts_iter = &mut ctx.remaining_accounts.iter().peekable();

        let mut oracle_map = OracleMap::load(remaining_accounts_iter, clock.slot)?;
        let _bank_map = BankMap::load(&WritableBanks::new(), remaining_accounts_iter)?;
        let market_map = MarketMap::load(
            &get_market_set(market_index),
            &MarketSet::new(),
            remaining_accounts_iter,
        )?;
        {
            let mut market = market_map.get_ref_mut(&market_index)?;
            controller::funding::settle_funding_payment(user, &user_key, &mut market, now)?;
        }

        // standardize n shares to burn
        let shares_to_burn = {
            let market = market_map.get_ref(&market_index)?;
            crate::math::orders::standardize_base_asset_amount(
                shares_to_burn,
                market.amm.base_asset_amount_step_size,
            )?
        };

        if shares_to_burn == 0 {
            return Ok(());
        }

        let mut market = market_map.get_ref_mut(&market_index)?;
        let position_index = get_position_index(&user.positions, market_index)?;
        let position = &mut user.positions[position_index];

        validate!(
            position.lp_shares >= shares_to_burn,
            ErrorCode::InsufficientLPTokens
        )?;

        let time_since_last_add_liquidity = now
            .checked_sub(position.last_lp_add_time)
            .ok_or_else(math_error!())?;

        validate!(
            time_since_last_add_liquidity >= market.amm.lp_cooldown_time,
            ErrorCode::TryingToRemoveLiquidityTooFast
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
        exchange_not_paused(&ctx.accounts.state)
    )]
    pub fn add_liquidity<'info>(
        ctx: Context<AddRemoveLiquidity>,
        n_shares: u128,
        market_index: u64,
    ) -> Result<()> {
        let user_key = ctx.accounts.user.key();
        let user = &mut load_mut!(ctx.accounts.user)?;
        let clock = Clock::get()?;
        let now = clock.unix_timestamp;
        let remaining_accounts_iter = &mut ctx.remaining_accounts.iter().peekable();

        let mut oracle_map = OracleMap::load(remaining_accounts_iter, clock.slot)?;
        let bank_map = BankMap::load(&WritableBanks::new(), remaining_accounts_iter)?;

        let market_map = MarketMap::load(
            &get_market_set(market_index),
            &MarketSet::new(),
            remaining_accounts_iter,
        )?;

        {
            let mut market = market_map.get_ref_mut(&market_index)?;
            controller::funding::settle_funding_payment(user, &user_key, &mut market, now)?;
        }

        let position_index = get_position_index(&user.positions, market_index)
            .or_else(|_| add_new_position(&mut user.positions, market_index))?;

        validate!(!user.bankrupt, ErrorCode::UserBankrupt)?;
        math::liquidation::validate_user_not_being_liquidated(
            user,
            &market_map,
            &bank_map,
            &mut oracle_map,
            ctx.accounts.state.liquidation_margin_buffer_ratio,
        )?;

        let position = &mut user.positions[position_index];

        {
            let mut market = market_map.get_ref_mut(&market_index)?;

            // standardize n shares to mint
            let n_shares = crate::math::orders::standardize_base_asset_amount(
                n_shares,
                market.amm.base_asset_amount_step_size,
            )?;

            controller::lp::mint_lp_shares(position, &mut market, n_shares, now)?;
        }

        // check margin requirements
        validate!(
            meets_initial_margin_requirement(user, &market_map, &bank_map, &mut oracle_map)?,
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

    pub fn place_order(ctx: Context<PlaceOrder>, params: OrderParams) -> Result<()> {
        let remaining_accounts_iter = &mut ctx.remaining_accounts.iter().peekable();
        let mut oracle_map = OracleMap::load(remaining_accounts_iter, Clock::get()?.slot)?;
        let bank_map = BankMap::load(&WritableBanks::new(), remaining_accounts_iter)?;
        let market_map = MarketMap::load(
            &MarketSet::new(),
            &get_market_set(params.market_index),
            remaining_accounts_iter,
        )?;

        if params.immediate_or_cancel {
            msg!("immediate_or_cancel order must be in place_and_make or place_and_take");
            return Err(print_error!(ErrorCode::InvalidOrder)().into());
        }

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
        let _bank_map = BankMap::load(&MarketSet::new(), remaining_accounts_iter)?;
        let market_map = MarketMap::load(
            &MarketSet::new(),
            &MarketSet::new(),
            remaining_accounts_iter,
        )?;

        let order_id = match order_id {
            Some(order_id) => order_id,
            None => load!(ctx.accounts.user)?.get_last_order_id(),
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
        let _bank_map = BankMap::load(&MarketSet::new(), remaining_accounts_iter)?;
        let market_map = MarketMap::load(
            &MarketSet::new(),
            &MarketSet::new(),
            remaining_accounts_iter,
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
        let mut oracle_map = OracleMap::load(remaining_accounts_iter, Clock::get()?.slot)?;
        let bank_map = BankMap::load(&WritableBanks::new(), remaining_accounts_iter)?;
        let market_map = MarketMap::load(
            &get_market_set(market_index),
            &MarketSet::new(),
            remaining_accounts_iter,
        )?;

        let (maker, maker_stats) = match maker_order_id {
            Some(_) => {
                let (user, user_stats) = get_maker_and_maker_stats(remaining_accounts_iter)?;
                (Some(user), Some(user_stats))
            }
            None => (None, None),
        };

        let (referrer, referrer_stats) = get_referrer_and_referrer_stats(remaining_accounts_iter)?;

        let clock = &Clock::get()?;

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
            &bank_map,
            &market_map,
            &mut oracle_map,
            &ctx.accounts.filler,
            &ctx.accounts.filler_stats,
            maker.as_ref(),
            maker_stats.as_ref(),
            maker_order_id,
            referrer.as_ref(),
            referrer_stats.as_ref(),
            &Clock::get()?,
        )?;

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
        let bank_map = BankMap::load(&WritableBanks::new(), remaining_accounts_iter)?;

        let market_map = MarketMap::load(
            &get_market_set(params.market_index),
            &MarketSet::new(),
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
        let base_asset_amount_to_fill = params.base_asset_amount;

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
            &bank_map,
            &mut oracle_map,
            &Clock::get()?,
            params,
        )?;

        let user = &mut ctx.accounts.user;
        let order_id = load!(user)?.get_last_order_id();

        let (base_asset_amount_filled, _) = controller::orders::fill_order(
            order_id,
            &ctx.accounts.state,
            user,
            &ctx.accounts.user_stats,
            &bank_map,
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
        let bank_map = BankMap::load(&WritableBanks::new(), remaining_accounts_iter)?;
        let market_map = MarketMap::load(
            &get_market_set(params.market_index),
            &MarketSet::new(),
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

        let order_id = load!(ctx.accounts.user)?.get_last_order_id();

        controller::orders::fill_order(
            taker_order_id,
            &ctx.accounts.state,
            &ctx.accounts.taker,
            &ctx.accounts.taker_stats,
            &bank_map,
            &market_map,
            &mut oracle_map,
            &ctx.accounts.user.clone(),
            &ctx.accounts.user_stats.clone(),
            Some(&ctx.accounts.user),
            Some(&ctx.accounts.user_stats),
            Some(order_id),
            referrer.as_ref(),
            referrer_stats.as_ref(),
            &Clock::get()?,
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
        let market_index = {
            let user = &load!(ctx.accounts.user)?;
            user.get_order(order_id)
                .map(|order| order.market_index)
                .ok_or(ErrorCode::OrderDoesNotExist)?
        };

        let remaining_accounts_iter = &mut ctx.remaining_accounts.iter().peekable();
        let mut oracle_map = OracleMap::load(remaining_accounts_iter, Clock::get()?.slot)?;
        BankMap::load(&WritableBanks::new(), remaining_accounts_iter)?;
        let market_map = MarketMap::load(
            &MarketSet::new(),
            &get_market_set(market_index),
            remaining_accounts_iter,
        )?;

        controller::repeg::update_amm(
            market_index,
            &market_map,
            &mut oracle_map,
            &ctx.accounts.state,
            &Clock::get()?,
        )?;

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
            &get_market_set_from_list(market_indexes),
            &MarketSet::new(),
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
        let market_map = MarketMap::load(
            &get_market_set(market_index),
            &MarketSet::new(),
            remaining_accounts_iter,
        )?;

        controller::repeg::update_amm(
            market_index,
            &market_map,
            &mut oracle_map,
            &ctx.accounts.state,
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
            &bank_map,
            &mut oracle_map,
            clock.unix_timestamp,
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
        let user_stats = &mut load_mut!(ctx.accounts.user_stats)?;
        let liquidator = &mut load_mut!(ctx.accounts.liquidator)?;
        let liquidator_stats = &mut load_mut!(ctx.accounts.liquidator_stats)?;

        let remaining_accounts_iter = &mut ctx.remaining_accounts.iter().peekable();
        let mut oracle_map = OracleMap::load(remaining_accounts_iter, clock.slot)?;
        let bank_map = BankMap::load(&WritableBanks::new(), remaining_accounts_iter)?;
        let market_map = MarketMap::load(
            &get_market_set(market_index),
            &MarketSet::new(),
            remaining_accounts_iter,
        )?;

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
        let market_map = MarketMap::load(
            &MarketSet::new(),
            &MarketSet::new(),
            remaining_accounts_iter,
        )?;

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
        let market_map = MarketMap::load(
            &MarketSet::new(),
            &MarketSet::new(),
            remaining_accounts_iter,
        )?;

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
        let market_map = MarketMap::load(
            &MarketSet::new(),
            &MarketSet::new(),
            remaining_accounts_iter,
        )?;

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

    #[access_control(
        exchange_not_paused(&ctx.accounts.state)
    )]
    pub fn resolve_perp_bankruptcy(
        ctx: Context<ResolvePerpBankruptcy>,
        bank_index: u64,
        market_index: u64,
    ) -> Result<()> {
        let clock = Clock::get()?;
        let now = clock.unix_timestamp;

        let user_key = ctx.accounts.user.key();
        let liquidator_key = ctx.accounts.liquidator.key();

        validate!(
            user_key != liquidator_key,
            ErrorCode::UserCantLiquidateThemself
        )?;

        validate!(bank_index == 0, ErrorCode::InvalidBankAccount)?;

        let user = &mut load_mut!(ctx.accounts.user)?;
        let liquidator = &mut load_mut!(ctx.accounts.liquidator)?;
        let state = &ctx.accounts.state;

        let remaining_accounts_iter = &mut ctx.remaining_accounts.iter().peekable();
        let mut oracle_map = OracleMap::load(remaining_accounts_iter, clock.slot)?;
        let bank_map = BankMap::load(&get_writable_banks(bank_index), remaining_accounts_iter)?;
        let market_map = MarketMap::load(
            &get_market_set(market_index),
            &MarketSet::new(),
            remaining_accounts_iter,
        )?;

        let pay_from_insurance = controller::liquidation::resolve_perp_bankruptcy(
            market_index,
            user,
            &user_key,
            liquidator,
            &liquidator_key,
            &market_map,
            &bank_map,
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
                &ctx.accounts.bank_vault,
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
        exchange_not_paused(&ctx.accounts.state)
    )]
    pub fn resolve_borrow_bankruptcy(
        ctx: Context<ResolvePerpBankruptcy>,
        bank_index: u64,
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
        let bank_map = BankMap::load(&get_writable_banks(bank_index), remaining_accounts_iter)?;
        let market_map = MarketMap::load(
            &MarketSet::new(),
            &MarketSet::new(),
            remaining_accounts_iter,
        )?;

        let pay_from_insurance = controller::liquidation::resolve_bank_bankruptcy(
            bank_index,
            user,
            &user_key,
            liquidator,
            &liquidator_key,
            &market_map,
            &bank_map,
            &mut oracle_map,
            now,
            ctx.accounts.insurance_fund_vault.amount,
        )?;

        if pay_from_insurance > 0 {
            controller::token::send_from_program_vault(
                &ctx.accounts.token_program,
                &ctx.accounts.insurance_fund_vault,
                &ctx.accounts.bank_vault,
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

        controller::token::send_from_program_vault(
            &ctx.accounts.token_program,
            &ctx.accounts.bank_vault,
            &ctx.accounts.recipient,
            &ctx.accounts.clearing_house_signer,
            ctx.accounts.state.signer_nonce,
            amount,
        )?;

        controller::bank_balance::update_bank_balances(
            cast_to_u128(amount)?,
            &BankBalanceType::Borrow,
            bank,
            &mut market.amm.fee_pool,
            false,
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
        controller::token::send_from_program_vault(
            &ctx.accounts.token_program,
            &ctx.accounts.insurance_vault,
            &ctx.accounts.recipient,
            &ctx.accounts.clearing_house_signer,
            ctx.accounts.state.signer_nonce,
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
            false,
        )?;

        controller::token::send_from_program_vault(
            &ctx.accounts.token_program,
            &ctx.accounts.insurance_vault,
            &ctx.accounts.bank_vault,
            &ctx.accounts.clearing_house_signer,
            ctx.accounts.state.signer_nonce,
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

        let mut user_stats = load_mut!(ctx.accounts.user_stats)?;
        user_stats.number_of_users = user_stats
            .number_of_users
            .checked_add(1)
            .ok_or_else(math_error!())?;

        // Only try to add referrer if it is the first user
        if user_stats.number_of_users == 1 {
            let remaining_accounts_iter = &mut ctx.remaining_accounts.iter().peekable();
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
            &get_market_set_for_user_positions(&user.positions),
            &MarketSet::new(),
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
        controller::repeg::_update_amm(market, oracle_price_data, state, now, clock_slot)?;

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

        let update_k_result = get_update_k_result(market, new_sqrt_k_u192, true)?;

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
            market.amm.max_spread,
        )?;

        market.margin_ratio_initial = margin_ratio_initial;
        market.margin_ratio_maintenance = margin_ratio_maintenance;
        Ok(())
    }

    #[access_control(
        market_initialized(&ctx.accounts.market)
    )]
    pub fn update_market_max_revenue_withdraw_per_period(
        ctx: Context<AdminUpdateMarket>,
        max_revenue_withdraw_per_period: u128,
    ) -> Result<()> {
        let market = &mut load_mut!(ctx.accounts.market)?;

        validate!(
            max_revenue_withdraw_per_period < 10_000 * QUOTE_PRECISION,
            ErrorCode::DefaultError,
            "max_revenue_withdraw_per_period must be less than 10k"
        )?;

        msg!(
            "market.max_revenue_withdraw_per_period: {:?} -> {:?}",
            market.max_revenue_withdraw_per_period,
            max_revenue_withdraw_per_period
        );

        market.max_revenue_withdraw_per_period = max_revenue_withdraw_per_period;
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
            market.amm.max_spread,
        )?;

        market.liquidation_fee = liquidation_fee;
        Ok(())
    }

    pub fn update_bank_insurance_withdraw_escrow_period(
        ctx: Context<AdminUpdateBank>,
        insurance_withdraw_escrow_period: i64,
    ) -> Result<()> {
        let bank = &mut load_mut!(ctx.accounts.bank)?;
        bank.insurance_withdraw_escrow_period = insurance_withdraw_escrow_period;
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

    pub fn update_bank_withdraw_guard_threshold(
        ctx: Context<AdminUpdateBank>,
        withdraw_guard_threshold: u128,
    ) -> Result<()> {
        let bank = &mut load_mut!(ctx.accounts.bank)?;
        msg!(
            "bank.withdraw_guard_threshold: {:?} -> {:?}",
            bank.withdraw_guard_threshold,
            withdraw_guard_threshold
        );
        bank.withdraw_guard_threshold = withdraw_guard_threshold;
        Ok(())
    }

    pub fn update_bank_if_factor(
        ctx: Context<AdminUpdateBank>,
        bank_index: u64,
        user_if_factor: u32,
        total_if_factor: u32,
        liquidation_if_factor: u32,
    ) -> Result<()> {
        let bank = &mut load_mut!(ctx.accounts.bank)?;

        validate!(
            bank.bank_index == bank_index,
            ErrorCode::DefaultError,
            "bank_index dne bank.index"
        )?;

        validate!(
            user_if_factor <= total_if_factor,
            ErrorCode::DefaultError,
            "user_if_factor must be <= total_if_factor"
        )?;

        validate!(
            total_if_factor <= cast_to_u32(BANK_INTEREST_PRECISION)?,
            ErrorCode::DefaultError,
            "total_if_factor must be <= 100%"
        )?;

        validate!(
            liquidation_if_factor <= cast_to_u32(LIQUIDATION_FEE_PRECISION / 20)?,
            ErrorCode::DefaultError,
            "liquidation_if_factor must be <= 5%"
        )?;

        msg!(
            "bank.user_if_factor: {:?} -> {:?}",
            bank.user_if_factor,
            user_if_factor
        );
        msg!(
            "bank.total_if_factor: {:?} -> {:?}",
            bank.total_if_factor,
            total_if_factor
        );
        msg!(
            "bank.liquidation_if_factor: {:?} -> {:?}",
            bank.liquidation_if_factor,
            liquidation_if_factor
        );

        bank.user_if_factor = user_if_factor;
        bank.total_if_factor = total_if_factor;
        bank.liquidation_if_factor = liquidation_if_factor;

        Ok(())
    }

    pub fn update_bank_revenue_settle_period(
        ctx: Context<AdminUpdateBank>,
        revenue_settle_period: i64,
    ) -> Result<()> {
        let bank = &mut load_mut!(ctx.accounts.bank)?;
        validate!(revenue_settle_period > 0, ErrorCode::DefaultError)?;
        msg!(
            "bank.revenue_settle_period: {:?} -> {:?}",
            bank.revenue_settle_period,
            revenue_settle_period
        );
        bank.revenue_settle_period = revenue_settle_period;
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
    pub fn update_market_unrealized_asset_weight(
        ctx: Context<AdminUpdateMarket>,
        unrealized_initial_asset_weight: u8,
        unrealized_maintenance_asset_weight: u8,
    ) -> Result<()> {
        validate!(
            unrealized_initial_asset_weight <= 100,
            ErrorCode::DefaultError,
            "invalid unrealized_initial_asset_weight",
        )?;
        validate!(
            unrealized_maintenance_asset_weight <= 100,
            ErrorCode::DefaultError,
            "invalid unrealized_maintenance_asset_weight",
        )?;
        validate!(
            unrealized_initial_asset_weight <= unrealized_maintenance_asset_weight,
            ErrorCode::DefaultError,
            "must enforce unrealized_initial_asset_weight <= unrealized_maintenance_asset_weight",
        )?;
        let market = &mut load_mut!(ctx.accounts.market)?;
        market.unrealized_initial_asset_weight = unrealized_initial_asset_weight;
        market.unrealized_maintenance_asset_weight = unrealized_maintenance_asset_weight;
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

    #[access_control(
        market_initialized(&ctx.accounts.market)
    )]
    pub fn update_lp_cooldown_time(
        ctx: Context<AdminUpdateMarket>,
        lp_cooldown_time: i64,
    ) -> Result<()> {
        let market = &mut ctx.accounts.market.load_mut()?;
        market.amm.lp_cooldown_time = lp_cooldown_time;
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
    pub fn update_amm_jit_intensity(
        ctx: Context<AdminUpdateMarket>,
        amm_jit_intensity: u8,
    ) -> Result<()> {
        validate!(
            (0..=100).contains(&amm_jit_intensity),
            ErrorCode::DefaultError,
            "invalid amm_jit_intensity",
        )?;

        let market = &mut load_mut!(ctx.accounts.market)?;
        market.amm.amm_jit_intensity = amm_jit_intensity;

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
                && (max_spread <= market.margin_ratio_initial * 100 / 2),
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
        if minimum_trade_size > 0 {
            market.amm.base_asset_amount_step_size = minimum_trade_size;
        } else {
            return Err(ErrorCode::DefaultError.into());
        }
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

    pub fn initialize_insurance_fund_stake(
        ctx: Context<InitializeInsuranceFundStake>,
        bank_index: u64,
    ) -> Result<()> {
        let mut if_stake = ctx
            .accounts
            .insurance_fund_stake
            .load_init()
            .or(Err(ErrorCode::UnableToLoadAccountLoader))?;

        let clock = Clock::get()?;
        let now = clock.unix_timestamp;

        *if_stake = InsuranceFundStake {
            authority: *ctx.accounts.authority.key,
            bank_index,
            if_shares: 0,
            last_withdraw_request_shares: 0,
            last_withdraw_request_value: 0,
            last_withdraw_request_ts: 0,
            cost_basis: 0,
            if_base: 0,
            last_valid_ts: now,
        };

        Ok(())
    }

    pub fn settle_revenue_to_insurance_fund(
        ctx: Context<SettleRevenueToInsuranceFund>,
        _bank_index: u64,
    ) -> Result<()> {
        let state = &ctx.accounts.state;
        let bank = &mut load_mut!(ctx.accounts.bank)?;

        let bank_vault_amount = ctx.accounts.bank_vault.amount;
        let insurance_vault_amount = ctx.accounts.insurance_fund_vault.amount;

        let clock = Clock::get()?;
        let now = clock.unix_timestamp;

        let time_until_next_update = math::helpers::on_the_hour_update(
            now,
            bank.last_revenue_settle_ts,
            bank.revenue_settle_period,
        )?;
        validate!(
            time_until_next_update == 0,
            ErrorCode::DefaultError,
            "Must wait {} seconds until next available settlement time",
            time_until_next_update
        )?;

        // uses proportion of revenue pool allocated to insurance fund
        let token_amount = controller::insurance::settle_revenue_to_insurance_fund(
            bank_vault_amount,
            insurance_vault_amount,
            bank,
            now,
        )?;

        controller::token::send_from_program_vault(
            &ctx.accounts.token_program,
            &ctx.accounts.bank_vault,
            &ctx.accounts.insurance_fund_vault,
            &ctx.accounts.clearing_house_signer,
            state.signer_nonce,
            token_amount as u64,
        )?;

        // todo: settle remaining revenue pool to a revenue vault

        bank.last_revenue_settle_ts = now;

        Ok(())
    }

    pub fn add_insurance_fund_stake(
        ctx: Context<AddInsuranceFundStake>,
        bank_index: u64,
        amount: u64,
    ) -> Result<()> {
        if amount == 0 {
            return Err(ErrorCode::InsufficientDeposit.into());
        }

        let clock = Clock::get()?;
        let insurance_fund_stake = &mut load_mut!(ctx.accounts.insurance_fund_stake)?;
        let user_stats = &mut load_mut!(ctx.accounts.user_stats)?;
        let bank = &mut load_mut!(ctx.accounts.bank)?;

        validate!(
            insurance_fund_stake.bank_index == bank_index,
            ErrorCode::DefaultError,
            "insurance_fund_stake does not match bank_index"
        )?;

        validate!(
            insurance_fund_stake.last_withdraw_request_shares == 0
                && insurance_fund_stake.last_withdraw_request_value == 0,
            ErrorCode::DefaultError,
            "withdraw request in progress"
        )?;

        controller::insurance::add_insurance_fund_stake(
            amount,
            ctx.accounts.insurance_fund_vault.amount,
            insurance_fund_stake,
            user_stats,
            bank,
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
        bank_index: u64,
        amount: u64,
    ) -> Result<()> {
        let clock = Clock::get()?;
        let insurance_fund_stake = &mut load_mut!(ctx.accounts.insurance_fund_stake)?;
        let user_stats = &mut load_mut!(ctx.accounts.user_stats)?;
        let bank = &mut load_mut!(ctx.accounts.bank)?;

        validate!(
            insurance_fund_stake.bank_index == bank_index,
            ErrorCode::DefaultError,
            "insurance_fund_stake does not match bank_index"
        )?;

        validate!(
            insurance_fund_stake.last_withdraw_request_shares == 0,
            ErrorCode::DefaultError,
            "Withdraw request is already in progress"
        )?;

        let n_shares = math::insurance::staked_amount_to_shares(
            amount,
            bank.total_if_shares,
            ctx.accounts.insurance_fund_vault.amount,
        )?;

        validate!(
            n_shares > 0,
            ErrorCode::DefaultError,
            "Requested lp_shares = 0"
        )?;

        validate!(
            insurance_fund_stake.if_shares >= n_shares,
            ErrorCode::InsufficientLPTokens
        )?;

        controller::insurance::request_remove_insurance_fund_stake(
            n_shares,
            ctx.accounts.insurance_fund_vault.amount,
            insurance_fund_stake,
            user_stats,
            bank,
            clock.unix_timestamp,
        )?;

        Ok(())
    }

    pub fn cancel_request_remove_insurance_fund_stake(
        ctx: Context<RequestRemoveInsuranceFundStake>,
        bank_index: u64,
    ) -> Result<()> {
        let clock = Clock::get()?;
        let now = clock.unix_timestamp;
        let insurance_fund_stake = &mut load_mut!(ctx.accounts.insurance_fund_stake)?;
        let user_stats = &mut load_mut!(ctx.accounts.user_stats)?;
        let bank = &mut load_mut!(ctx.accounts.bank)?;

        validate!(
            insurance_fund_stake.bank_index == bank_index,
            ErrorCode::DefaultError,
            "insurance_fund_stake does not match bank_index"
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
            bank,
            now,
        )?;

        Ok(())
    }

    pub fn remove_insurance_fund_stake(
        ctx: Context<RemoveInsuranceFundStake>,
        bank_index: u64,
    ) -> Result<()> {
        let clock = Clock::get()?;
        let now = clock.unix_timestamp;
        let insurance_fund_stake = &mut load_mut!(ctx.accounts.insurance_fund_stake)?;
        let user_stats = &mut load_mut!(ctx.accounts.user_stats)?;
        let bank = &mut load_mut!(ctx.accounts.bank)?;
        let state = &ctx.accounts.state;

        validate!(
            insurance_fund_stake.bank_index == bank_index,
            ErrorCode::DefaultError,
            "insurance_fund_stake does not match bank_index"
        )?;

        let amount = controller::insurance::remove_insurance_fund_stake(
            ctx.accounts.insurance_fund_vault.amount,
            insurance_fund_stake,
            user_stats,
            bank,
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
