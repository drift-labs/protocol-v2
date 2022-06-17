#![allow(clippy::too_many_arguments)]
#![allow(unaligned_references)]

use anchor_lang::prelude::*;
use borsh::BorshSerialize;

use context::*;
use controller::position::PositionDirection;
use error::ErrorCode;
use math::{amm, bn, constants::*, fees, margin::*, orders::*};
use state::oracle::{get_oracle_price, OracleSource};

use crate::state::market::Market;
use crate::state::{market::AMM, order_state::*, state::*, user::*};

mod account_loader;
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

#[cfg(feature = "mainnet-beta")]
declare_id!("dammHkt7jmytvbS3nHTxQNEcP59aE57nxwV21YdqEDN");
#[cfg(not(feature = "mainnet-beta"))]
declare_id!("AsW7LnXB9UA1uec9wi9MctYTgTz7YH9snhxd16GsFaGX");

#[program]
pub mod clearing_house {
    use std::ops::Div;
    use std::option::Option::Some;

    use crate::account_loader::{load, load_mut};
    use crate::controller::position::{add_new_position, get_position_index};
    use crate::margin_validation::validate_margin;
    use crate::math;
    use crate::math::amm::{
        calculate_mark_twap_spread_pct, is_oracle_mark_too_divergent, normalise_oracle_price,
    };
    use crate::math::casting::{cast, cast_to_i128, cast_to_u128, cast_to_u64};
    use crate::math::slippage::{calculate_slippage, calculate_slippage_pct};
    use crate::optional_accounts::{get_discount_token, get_referrer, get_referrer_for_fill_order};
    use crate::state::bank::Bank;
    use crate::state::events::TradeRecord;
    use crate::state::events::{CurveRecord, DepositRecord};
    use crate::state::events::{DepositDirection, LiquidationRecord};
    use crate::state::market::Market;
    use crate::state::market_map::{
        get_market_oracles, get_writable_markets, get_writable_markets_for_user_positions,
        MarketMap, MarketOracles, WritableMarkets,
    };
    use crate::state::oracle::OraclePriceData;
    use crate::state::order_state::{OrderFillerRewardStructure, OrderState};
    use crate::state::user::OrderType;

    use super::*;
    use crate::controller::bank_balance::update_bank_balances;
    use crate::math::bank_balance::get_token_amount;
    use crate::state::bank_map::{get_writable_banks, BankMap};
    use crate::state::oracle_map::OracleMap;
    use std::cmp::min;

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
            number_of_markets: 0,
            number_of_banks: 0,
            padding0: 0,
            padding1: 0,
            padding2: 0,
            padding3: 0,
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
        };

        Ok(())
    }

    pub fn initialize_order_state(
        ctx: Context<InitializeOrderState>,
        _order_house_nonce: u8,
    ) -> Result<()> {
        let state = &mut ctx.accounts.state;

        if !state.order_state.eq(&Pubkey::default()) {
            return Err(ErrorCode::OrderStateAlreadyInitialized.into());
        }

        state.order_state = ctx.accounts.order_state.key();

        **ctx.accounts.order_state = OrderState {
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
        amm_base_asset_reserve: u128,
        amm_quote_asset_reserve: u128,
        amm_periodicity: i64,
        amm_peg_multiplier: u128,
        oracle_source: OracleSource,
        margin_ratio_initial: u32,
        margin_ratio_partial: u32,
        margin_ratio_maintenance: u32,
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
            margin_ratio_initial,
            margin_ratio_maintenance,
        )?;

        let state = &mut ctx.accounts.state;
        let market_index = state.number_of_markets;
        **market = Market {
            initialized: true,
            pubkey: *market_pubkey,
            market_index,
            base_asset_amount_long: 0,
            base_asset_amount_short: 0,
            base_asset_amount: 0,
            open_interest: 0,
            margin_ratio_initial, // unit is 20% (+2 decimal places)
            margin_ratio_partial,
            margin_ratio_maintenance,
            next_trade_record_id: 1,
            next_funding_rate_record_id: 1,
            next_curve_record_id: 1,
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
                cumulative_repeg_rebate_long: 0,
                cumulative_repeg_rebate_short: 0,
                cumulative_funding_rate_long: 0,
                cumulative_funding_rate_short: 0,
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
                minimum_quote_asset_trade_size: 10000000,
                last_oracle_price_twap_ts: now,
                last_oracle_price: oracle_price,
                minimum_base_asset_trade_size: 10000000,
                base_spread: 0,
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
        let user = &mut load_mut(&ctx.accounts.user)?;
        let clock = Clock::get()?;
        let now = clock.unix_timestamp;

        let remaining_accounts_iter = &mut ctx.remaining_accounts.iter().peekable();
        let _oracle_map = OracleMap::load(remaining_accounts_iter, clock.slot)?;
        let bank_map = BankMap::load(&get_writable_banks(bank_index), remaining_accounts_iter)?;

        let market_map = MarketMap::load(
            &WritableMarkets::new(),
            &MarketOracles::new(),
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

        controller::funding::settle_funding_payment(user, &user_key, &market_map, now)?;

        controller::token::receive(
            &ctx.accounts.token_program,
            &ctx.accounts.user_token_account,
            &ctx.accounts.bank_vault,
            &ctx.accounts.authority,
            amount,
        )?;

        let deposit_record = DepositRecord {
            ts: now,
            user_authority: user.authority,
            user: user_key,
            direction: DepositDirection::DEPOSIT,
            amount,
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
        let user = &mut load_mut(&ctx.accounts.user)?;
        let clock = Clock::get()?;
        let now = clock.unix_timestamp;

        let remaining_accounts_iter = &mut ctx.remaining_accounts.iter().peekable();
        let mut oracle_map = OracleMap::load(remaining_accounts_iter, clock.slot)?;
        let bank_map = BankMap::load(&get_writable_banks(bank_index), remaining_accounts_iter)?;
        let market_map = MarketMap::load(
            &WritableMarkets::new(),
            &MarketOracles::new(),
            remaining_accounts_iter,
        )?;

        controller::funding::settle_funding_payment(user, &user_key, &market_map, now)?;

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
                false,
            )?;

            amount
        };

        if !meets_initial_margin_requirement(user, &market_map, &bank_map, &mut oracle_map)? {
            return Err(ErrorCode::InsufficientCollateral.into());
        }

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

        let deposit_record = DepositRecord {
            ts: now,
            user_authority: user.authority,
            user: user_key,
            direction: DepositDirection::WITHDRAW,
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

        let to_user = &mut load_mut(&ctx.accounts.to_user)?;
        let from_user = &mut load_mut(&ctx.accounts.from_user)?;

        let remaining_accounts_iter = &mut ctx.remaining_accounts.iter().peekable();
        let mut oracle_map = OracleMap::load(remaining_accounts_iter, clock.slot)?;
        let bank_map = BankMap::load(&get_writable_banks(bank_index), remaining_accounts_iter)?;
        let market_map = MarketMap::load(
            &WritableMarkets::new(),
            &MarketOracles::new(),
            remaining_accounts_iter,
        )?;

        let bank = &mut bank_map.get_ref_mut(&bank_index)?;
        controller::bank_balance::update_bank_cumulative_interest(bank, clock.unix_timestamp)?;

        {
            let from_user_bank_balance = match from_user.get_bank_balance_mut(bank.bank_index) {
                Some(user_bank_balance) => user_bank_balance,
                None => from_user.add_bank_balance(bank_index, BankBalanceType::Deposit)?,
            };

            controller::bank_balance::update_bank_balances(
                amount as u128,
                &BankBalanceType::Borrow,
                bank,
                from_user_bank_balance,
                false,
            )?;
        }

        validate!(
            meets_initial_margin_requirement(from_user, &market_map, &bank_map, &mut oracle_map)?,
            ErrorCode::InsufficientCollateral,
            "From user does not meet initial margin requirement"
        )?;

        let deposit_record = DepositRecord {
            ts: clock.unix_timestamp,
            user_authority: *authority_key,
            user: from_user_key,
            direction: DepositDirection::WITHDRAW,
            amount,
            bank_index,
            from: None,
            to: Some(to_user_key),
        };
        emit!(deposit_record);

        {
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
        let bank = &mut load_mut(&ctx.accounts.bank)?;
        let now = Clock::get()?.unix_timestamp;
        controller::bank_balance::update_bank_cumulative_interest(bank, now)?;
        Ok(())
    }

    #[allow(unused_must_use)]
    #[access_control(
        exchange_not_paused(&ctx.accounts.state)
    )]
    pub fn open_position<'info>(
        ctx: Context<OpenPosition>,
        direction: PositionDirection,
        quote_asset_amount: u128,
        market_index: u64,
        limit_price: u128,
        optional_accounts: ManagePositionOptionalAccounts,
    ) -> Result<()> {
        let user_key = ctx.accounts.user.key();
        let user = &mut load_mut(&ctx.accounts.user)?;
        let clock = Clock::get()?;
        let now = clock.unix_timestamp;
        let clock_slot = clock.slot;

        let remaining_accounts_iter = &mut ctx.remaining_accounts.iter().peekable();
        let mut oracle_map = OracleMap::load(remaining_accounts_iter, clock.slot)?;
        let bank_map = BankMap::load(
            &get_writable_banks(QUOTE_ASSET_BANK_INDEX),
            remaining_accounts_iter,
        )?;
        let market_map = MarketMap::load(
            &get_writable_markets(market_index),
            &get_market_oracles(market_index, &ctx.accounts.oracle),
            remaining_accounts_iter,
        )?;

        if quote_asset_amount == 0 {
            return Err(ErrorCode::TradeSizeTooSmall.into());
        }

        // Settle user's funding payments so that collateral is up to date
        controller::funding::settle_funding_payment(user, &user_key, &market_map, now)?;

        // Get existing position or add a new position for market
        let position_index = get_position_index(&user.positions, market_index)
            .or_else(|_| add_new_position(&mut user.positions, market_index))?;

        // Collect data about position/market before trade is executed so that it can be stored in trade record
        let mark_price_before: u128;
        let oracle_mark_spread_pct_before: i128;
        let is_oracle_valid: bool;
        {
            let market = &mut market_map.get_ref_mut(&market_index)?;
            mark_price_before = market.amm.mark_price()?;
            let oracle_price_data = &market
                .amm
                .get_oracle_price(&ctx.accounts.oracle, clock_slot)?;
            oracle_mark_spread_pct_before = amm::calculate_oracle_mark_spread_pct(
                &market.amm,
                oracle_price_data,
                Some(mark_price_before),
            )?;
            is_oracle_valid = amm::is_oracle_valid(
                &market.amm,
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
        let quote_asset_amount_surplus;
        let pnl;
        {
            let market = &mut market_map.get_ref_mut(&market_index)?;
            let (
                _potentially_risk_increasing,
                _,
                _base_asset_amount,
                _quote_asset_amount,
                _quote_asset_amount_surplus,
                _pnl,
            ) = controller::position::update_position_with_quote_asset_amount(
                quote_asset_amount,
                direction,
                market,
                user,
                position_index,
                mark_price_before,
                now,
            )?;

            potentially_risk_increasing = _potentially_risk_increasing;
            base_asset_amount = _base_asset_amount;
            quote_asset_amount = _quote_asset_amount;
            quote_asset_amount_surplus = _quote_asset_amount_surplus;
            pnl = _pnl;
        }

        // Collect data about position/market after trade is executed so that it can be stored in trade record
        let mark_price_after: u128;
        let oracle_price_after: i128;
        let oracle_mark_spread_pct_after: i128;
        {
            let market = &market_map.get_ref(&market_index)?;
            mark_price_after = market.amm.mark_price()?;
            let oracle_price_data = &market
                .amm
                .get_oracle_price(&ctx.accounts.oracle, clock_slot)?;
            oracle_mark_spread_pct_after = amm::calculate_oracle_mark_spread_pct(
                &market.amm,
                oracle_price_data,
                Some(mark_price_after),
            )?;
            oracle_price_after = oracle_price_data.price;
        }

        // Trade fails if it's risk increasing and it brings the user below the initial margin ratio level
        let meets_initial_margin_requirement =
            meets_initial_margin_requirement(user, &market_map, &bank_map, &mut oracle_map)?;
        if !meets_initial_margin_requirement && potentially_risk_increasing {
            return Err(ErrorCode::InsufficientCollateral.into());
        }

        // Calculate the fee to charge the user
        let (discount_token, referrer) = optional_accounts::get_discount_token_and_referrer(
            optional_accounts,
            remaining_accounts_iter,
            &ctx.accounts.state.discount_mint,
            &user_key,
            &ctx.accounts.authority.key(),
        )?;
        let (user_fee, fee_to_market, token_discount, referrer_reward, referee_discount) =
            fees::calculate_fee_for_trade(
                quote_asset_amount,
                &ctx.accounts.state.fee_structure,
                discount_token,
                &referrer,
                quote_asset_amount_surplus,
            )?;

        // Increment the clearing house's total fee variables
        {
            let market = &mut market_map.get_ref_mut(&market_index)?;
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

        // Update user balance to account for fee and pnl
        {
            let bank = &mut bank_map.get_quote_asset_bank_mut()?;
            let user_bank_balance = user.get_quote_asset_bank_balance_mut();

            update_bank_balances(
                user_fee,
                &BankBalanceType::Borrow,
                bank,
                user_bank_balance,
                true,
            )?;

            update_bank_balances(
                pnl.unsigned_abs(),
                if pnl > 0 {
                    &BankBalanceType::Deposit
                } else {
                    &BankBalanceType::Borrow
                },
                bank,
                user_bank_balance,
                true,
            )?;
        }

        // Increment the user's total fee variables
        user.total_fee_paid = user
            .total_fee_paid
            .checked_add(cast(user_fee)?)
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
        if let Some(referrer) = referrer {
            let referrer = &mut load_mut(&referrer)?;
            referrer.total_referral_reward = referrer
                .total_referral_reward
                .checked_add(referrer_reward)
                .ok_or_else(math_error!())?;
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

        // emit trade record
        {
            let market = &mut market_map.get_ref_mut(&market_index)?;
            let trade_record = TradeRecord {
                ts: now,
                record_id: get_then_update_id!(market, next_trade_record_id),
                user_authority: *ctx.accounts.authority.to_account_info().key,
                user: user_key,
                direction,
                base_asset_amount,
                quote_asset_amount,
                mark_price_before,
                mark_price_after,
                fee: cast(user_fee)?,
                token_discount,
                quote_asset_amount_surplus,
                referee_discount,
                liquidation: false,
                market_index,
                oracle_price: oracle_price_after,
            };
            emit!(trade_record);
        }

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
            let market = &mut market_map.get_ref_mut(&market_index)?;
            let price_oracle = &ctx.accounts.oracle;
            controller::funding::update_funding_rate(
                market_index,
                market,
                price_oracle,
                now,
                clock_slot,
                &ctx.accounts.state.oracle_guard_rails,
                ctx.accounts.state.funding_paused,
                Some(mark_price_before),
            )?;
        }

        Ok(())
    }

    #[access_control(
        exchange_not_paused(&ctx.accounts.state)
    )]
    pub fn close_position(
        ctx: Context<ClosePosition>,
        market_index: u64,
        optional_accounts: ManagePositionOptionalAccounts,
    ) -> Result<()> {
        let user_key = ctx.accounts.user.key();
        let user = &mut load_mut(&ctx.accounts.user)?;
        let clock = Clock::get()?;
        let now = clock.unix_timestamp;
        let clock_slot = clock.slot;

        let remaining_accounts_iter = &mut ctx.remaining_accounts.iter().peekable();
        let _oracle_map = OracleMap::load(remaining_accounts_iter, clock.slot)?;
        let bank_map = BankMap::load(
            &get_writable_banks(QUOTE_ASSET_BANK_INDEX),
            remaining_accounts_iter,
        )?;
        let market_map = MarketMap::load(
            &get_writable_markets(market_index),
            &get_market_oracles(market_index, &ctx.accounts.oracle),
            remaining_accounts_iter,
        )?;

        // Settle user's funding payments so that collateral is up to date
        controller::funding::settle_funding_payment(user, &user_key, &market_map, now)?;

        let position_index = get_position_index(&user.positions, market_index)?;

        let market = &mut market_map.get_ref_mut(&market_index)?;

        // Collect data about market before trade is executed so that it can be stored in trade record
        let mark_price_before = market.amm.mark_price()?;
        let oracle_price_data = &market
            .amm
            .get_oracle_price(&ctx.accounts.oracle, clock_slot)?;
        let oracle_mark_spread_pct_before = amm::calculate_oracle_mark_spread_pct(
            &market.amm,
            oracle_price_data,
            Some(mark_price_before),
        )?;

        let existing_base_asset_amount = user.positions[position_index].base_asset_amount;
        let direction_to_close =
            math::position::direction_to_close_position(existing_base_asset_amount);
        let (quote_asset_amount, base_asset_amount, quote_asset_amount_surplus, pnl) =
            controller::position::close(
                market,
                &mut user.positions[position_index],
                now,
                None,
                Some(mark_price_before),
                true,
            )?;
        let base_asset_amount = base_asset_amount.unsigned_abs();

        // Calculate the fee to charge the user
        let (discount_token, referrer) = optional_accounts::get_discount_token_and_referrer(
            optional_accounts,
            remaining_accounts_iter,
            &ctx.accounts.state.discount_mint,
            &user_key,
            &ctx.accounts.authority.key(),
        )?;
        let (user_fee, fee_to_market, token_discount, referrer_reward, referee_discount) =
            fees::calculate_fee_for_trade(
                quote_asset_amount,
                &ctx.accounts.state.fee_structure,
                discount_token,
                &referrer,
                quote_asset_amount_surplus,
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

        // Update user balance to account for fee and pnl
        {
            let bank = &mut bank_map.get_quote_asset_bank_mut()?;
            let user_bank_balance = user.get_quote_asset_bank_balance_mut();

            update_bank_balances(
                user_fee,
                &BankBalanceType::Borrow,
                bank,
                user_bank_balance,
                true,
            )?;

            update_bank_balances(
                pnl.unsigned_abs(),
                if pnl > 0 {
                    &BankBalanceType::Deposit
                } else {
                    &BankBalanceType::Borrow
                },
                bank,
                user_bank_balance,
                true,
            )?;
        }

        // Increment the user's total fee variables
        user.total_fee_paid = user
            .total_fee_paid
            .checked_add(cast(user_fee)?)
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
        if let Some(referrer) = referrer {
            let referrer = &mut load_mut(&referrer)?;
            referrer.total_referral_reward = referrer
                .total_referral_reward
                .checked_add(referrer_reward)
                .ok_or_else(math_error!())?;
        }

        // Collect data about market after trade is executed so that it can be stored in trade record
        let mark_price_after = market.amm.mark_price()?;
        let price_oracle = &ctx.accounts.oracle;

        let oracle_mark_spread_pct_after = amm::calculate_oracle_mark_spread_pct(
            &market.amm,
            oracle_price_data,
            Some(mark_price_after),
        )?;
        let oracle_price_after = oracle_price_data.price;

        let is_oracle_valid = amm::is_oracle_valid(
            &market.amm,
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

        // emit trade record
        let trade_record = TradeRecord {
            ts: now,
            record_id: get_then_update_id!(market, next_trade_record_id),
            user_authority: *ctx.accounts.authority.to_account_info().key,
            user: user_key,
            direction: direction_to_close,
            base_asset_amount,
            quote_asset_amount,
            mark_price_before,
            mark_price_after,
            liquidation: false,
            fee: cast(user_fee)?,
            token_discount,
            quote_asset_amount_surplus,
            referee_discount,
            market_index,
            oracle_price: oracle_price_after,
        };
        emit!(trade_record);

        // Try to update the funding rate at the end of every trade
        controller::funding::update_funding_rate(
            market_index,
            market,
            price_oracle,
            now,
            clock_slot,
            &ctx.accounts.state.oracle_guard_rails,
            ctx.accounts.state.funding_paused,
            Some(mark_price_before),
        )?;

        Ok(())
    }

    pub fn place_order(ctx: Context<PlaceOrder>, params: OrderParams) -> Result<()> {
        let remaining_accounts_iter = &mut ctx.remaining_accounts.iter().peekable();
        let _oracle_map = OracleMap::load(remaining_accounts_iter, Clock::get()?.slot)?;
        let _bank_map = BankMap::load(&WritableMarkets::new(), remaining_accounts_iter)?;
        let market_map = MarketMap::load(
            &WritableMarkets::new(),
            &get_market_oracles(params.market_index, &ctx.accounts.oracle),
            remaining_accounts_iter,
        )?;

        let discount_token = get_discount_token(
            params.optional_accounts.discount_token,
            remaining_accounts_iter,
            &ctx.accounts.state.discount_mint,
            ctx.accounts.authority.key,
        )?;
        let referrer = get_referrer(
            params.optional_accounts.referrer,
            remaining_accounts_iter,
            &ctx.accounts.user.key(),
            None,
        )?;

        let oracle = Some(&ctx.accounts.oracle);

        if params.order_type == OrderType::Market {
            msg!("market order must be in place and fill");
            return Err(ErrorCode::MarketOrderMustBeInPlaceAndFill.into());
        }

        if params.immediate_or_cancel {
            msg!("immediate_or_cancel order must be in place and fill");
            return Err(print_error!(ErrorCode::InvalidOrder)().into());
        }

        controller::orders::place_order(
            &ctx.accounts.state,
            &ctx.accounts.order_state,
            &ctx.accounts.user,
            &market_map,
            discount_token,
            &referrer,
            &Clock::get()?,
            params,
            oracle,
        )?;

        Ok(())
    }

    pub fn cancel_order(ctx: Context<CancelOrder>, order_id: u64) -> Result<()> {
        let market_oracles = {
            let user = &load(&ctx.accounts.user)?;
            let order_index = user
                .orders
                .iter()
                .position(|order| order.order_id == order_id)
                .ok_or_else(print_error!(ErrorCode::OrderDoesNotExist))?;
            let order = &user.orders[order_index];

            &get_market_oracles(order.market_index, &ctx.accounts.oracle)
        };

        let remaining_accounts_iter = &mut ctx.remaining_accounts.iter().peekable();
        let mut oracle_map = OracleMap::load(remaining_accounts_iter, Clock::get()?.slot)?;
        let bank_map = BankMap::load(&WritableMarkets::new(), remaining_accounts_iter)?;
        let market_map = MarketMap::load(
            &WritableMarkets::new(),
            market_oracles,
            remaining_accounts_iter,
        )?;

        let oracle = Some(&ctx.accounts.oracle);

        controller::orders::cancel_order_by_order_id(
            &ctx.accounts.state,
            order_id,
            &ctx.accounts.user,
            &market_map,
            &bank_map,
            &mut oracle_map,
            &Clock::get()?,
            oracle,
        )?;

        Ok(())
    }

    pub fn cancel_order_by_user_id(ctx: Context<CancelOrder>, user_order_id: u8) -> Result<()> {
        let market_oracles = {
            let user = &load(&ctx.accounts.user)?;

            let order_index = user
                .orders
                .iter()
                .position(|order| order.user_order_id == user_order_id)
                .ok_or_else(print_error!(ErrorCode::OrderDoesNotExist))?;
            let order = &user.orders[order_index];

            &get_market_oracles(order.market_index, &ctx.accounts.oracle)
        };
        let remaining_accounts_iter = &mut ctx.remaining_accounts.iter().peekable();
        let mut oracle_map = OracleMap::load(remaining_accounts_iter, Clock::get()?.slot)?;
        let bank_map = BankMap::load(&WritableMarkets::new(), remaining_accounts_iter)?;
        let market_map = MarketMap::load(
            &WritableMarkets::new(),
            market_oracles,
            remaining_accounts_iter,
        )?;

        let oracle = Some(&ctx.accounts.oracle);
        controller::orders::cancel_order_by_user_order_id(
            &ctx.accounts.state,
            user_order_id,
            &ctx.accounts.user,
            &market_map,
            &bank_map,
            &mut oracle_map,
            &Clock::get()?,
            oracle,
        )?;

        Ok(())
    }

    #[access_control(
        exchange_not_paused(&ctx.accounts.state)
    )]
    pub fn fill_order<'info>(ctx: Context<FillOrder>, order_id: u64) -> Result<()> {
        let (writable_markets, market_oracles) = {
            let user = &load(&ctx.accounts.user)?;
            let order_index = user
                .orders
                .iter()
                .position(|order| order.order_id == order_id)
                .ok_or_else(print_error!(ErrorCode::OrderDoesNotExist))?;
            let order = &user.orders[order_index];

            (
                &get_writable_markets(order.market_index),
                &get_market_oracles(order.market_index, &ctx.accounts.oracle),
            )
        };

        let remaining_accounts_iter = &mut ctx.remaining_accounts.iter().peekable();
        let mut oracle_map = OracleMap::load(remaining_accounts_iter, Clock::get()?.slot)?;
        let mut bank_map = BankMap::load(
            &get_writable_banks(QUOTE_ASSET_BANK_INDEX),
            remaining_accounts_iter,
        )?;
        let market_map =
            MarketMap::load(writable_markets, market_oracles, remaining_accounts_iter)?;

        let referrer = get_referrer_for_fill_order(
            remaining_accounts_iter,
            &ctx.accounts.user.key(),
            order_id,
            &ctx.accounts.user,
        )?;

        let base_asset_amount = controller::orders::fill_order(
            order_id,
            &ctx.accounts.state,
            &ctx.accounts.order_state,
            &ctx.accounts.user,
            &market_map,
            &mut bank_map,
            &mut oracle_map,
            &ctx.accounts.oracle,
            &ctx.accounts.filler,
            referrer,
            &Clock::get()?,
        )?;

        if base_asset_amount == 0 {
            return Err(print_error!(ErrorCode::CouldNotFillOrder)().into());
        }

        Ok(())
    }

    #[access_control(
        exchange_not_paused(&ctx.accounts.state)
    )]
    pub fn place_and_fill_order<'info>(
        ctx: Context<PlaceAndFillOrder>,
        params: OrderParams,
    ) -> Result<()> {
        let remaining_accounts_iter = &mut ctx.remaining_accounts.iter().peekable();
        let mut oracle_map = OracleMap::load(remaining_accounts_iter, Clock::get()?.slot)?;
        let mut bank_map = BankMap::load(
            &get_writable_banks(QUOTE_ASSET_BANK_INDEX),
            remaining_accounts_iter,
        )?;
        let market_map = MarketMap::load(
            &get_writable_markets(params.market_index),
            &get_market_oracles(params.market_index, &ctx.accounts.oracle),
            remaining_accounts_iter,
        )?;

        let discount_token = get_discount_token(
            params.optional_accounts.discount_token,
            remaining_accounts_iter,
            &ctx.accounts.state.discount_mint,
            ctx.accounts.authority.key,
        )?;
        let referrer = get_referrer(
            params.optional_accounts.referrer,
            remaining_accounts_iter,
            &ctx.accounts.user.key(),
            None,
        )?;
        let is_immediate_or_cancel = params.immediate_or_cancel;
        let base_asset_amount_to_fill = params.base_asset_amount;

        controller::orders::place_order(
            &ctx.accounts.state,
            &ctx.accounts.order_state,
            &ctx.accounts.user,
            &market_map,
            discount_token,
            &referrer,
            &Clock::get()?,
            params,
            Some(&ctx.accounts.oracle),
        )?;

        let user = &mut ctx.accounts.user;
        let order_id = {
            let user = load(user)?;
            if user.next_order_id == 1 {
                u64::MAX
            } else {
                user.next_order_id - 1
            }
        };

        let base_asset_amount_filled = controller::orders::fill_order(
            order_id,
            &ctx.accounts.state,
            &ctx.accounts.order_state,
            user,
            &market_map,
            &mut bank_map,
            &mut oracle_map,
            &ctx.accounts.oracle,
            &user.clone(),
            referrer,
            &Clock::get()?,
        )?;

        if is_immediate_or_cancel && base_asset_amount_to_fill != base_asset_amount_filled {
            controller::orders::cancel_order_by_order_id(
                &ctx.accounts.state,
                order_id,
                &ctx.accounts.user,
                &market_map,
                &bank_map,
                &mut oracle_map,
                &Clock::get()?,
                Some(&ctx.accounts.oracle),
            )?;
        }

        Ok(())
    }

    #[access_control(
        exchange_not_paused(&ctx.accounts.state)
    )]
    pub fn liquidate(ctx: Context<Liquidate>) -> Result<()> {
        let state = &ctx.accounts.state;
        let user_key = ctx.accounts.user.key();
        let user = &mut load_mut(&ctx.accounts.user)?;
        let clock = Clock::get()?;
        let now = clock.unix_timestamp;
        let clock_slot = clock.slot;

        let remaining_accounts_iter = &mut ctx.remaining_accounts.iter().peekable();
        let mut oracle_map = OracleMap::load(remaining_accounts_iter, clock.slot)?;
        let bank_map = BankMap::load(
            &get_writable_banks(QUOTE_ASSET_BANK_INDEX),
            remaining_accounts_iter,
        )?;
        let market_map = MarketMap::load(
            &get_writable_markets_for_user_positions(&user.positions),
            &MarketOracles::new(), // oracles validated in calculate liquidation status
            remaining_accounts_iter,
        )?;

        // Settle user's funding payments so that collateral is up to date
        controller::funding::settle_funding_payment(user, &user_key, &market_map, now)?;

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
            &market_map,
            &bank_map,
            &mut oracle_map,
            &ctx.accounts.state.oracle_guard_rails,
            clock_slot,
        )?;

        // Verify that the user is in liquidation territory
        let collateral = {
            let bank = bank_map.get_quote_asset_bank()?;
            let user_bank_balance = user.get_quote_asset_bank_balance_mut();
            get_token_amount(
                user_bank_balance.balance,
                &bank,
                &user_bank_balance.balance_type,
            )?
        };

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
            let maximum_liquidation_fee = total_collateral
                .checked_mul(state.full_liquidation_penalty_percentage_numerator)
                .ok_or_else(math_error!())?
                .checked_div(state.full_liquidation_penalty_percentage_denominator)
                .ok_or_else(math_error!())?;
            for market_status in market_statuses.iter() {
                if market_status.base_asset_value == 0 {
                    continue;
                }

                let market = &mut market_map.get_ref_mut(&market_status.market_index)?;
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

                let position_index =
                    get_position_index(&user.positions, market_status.market_index)?;
                let existing_base_asset_amount = user.positions[position_index].base_asset_amount;

                let mark_price_before_i128 = cast_to_i128(mark_price_before)?;
                let close_position_slippage = match market_status.close_position_slippage {
                    Some(close_position_slippage) => close_position_slippage,
                    None => calculate_slippage(
                        market_status.base_asset_value,
                        existing_base_asset_amount.unsigned_abs(),
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
                        let market_index = market_status.market_index;
                        msg!(
                            "oracle_mark_divergence_after_close {} for market {}",
                            oracle_mark_divergence_after_close,
                            market_index,
                        );
                        continue;
                    }
                }

                let direction_to_close =
                    math::position::direction_to_close_position(existing_base_asset_amount);

                // just reduce position if position is too big
                let (quote_asset_amount, base_asset_amount, pnl) = if close_slippage_pct_too_large {
                    let quote_asset_amount = market_status
                        .base_asset_value
                        .checked_mul(MAX_LIQUIDATION_SLIPPAGE_U128)
                        .ok_or_else(math_error!())?
                        .checked_div(close_position_slippage_pct.unsigned_abs())
                        .ok_or_else(math_error!())?;

                    let (base_asset_amount, _, pnl) = controller::position::reduce(
                        direction_to_close,
                        quote_asset_amount,
                        market,
                        &mut user.positions[position_index],
                        now,
                        Some(mark_price_before),
                        false,
                    )?;

                    (quote_asset_amount, base_asset_amount, pnl)
                } else {
                    let (quote_asset_amount, base_asset_amount, _, pnl) =
                        controller::position::close(
                            market,
                            &mut user.positions[position_index],
                            now,
                            None,
                            Some(mark_price_before),
                            false,
                        )?;
                    (quote_asset_amount, base_asset_amount, pnl)
                };

                {
                    let bank = &mut bank_map.get_quote_asset_bank_mut()?;
                    let user_bank_balance = user.get_quote_asset_bank_balance_mut();

                    update_bank_balances(
                        pnl.unsigned_abs(),
                        if pnl > 0 {
                            &BankBalanceType::Deposit
                        } else {
                            &BankBalanceType::Borrow
                        },
                        bank,
                        user_bank_balance,
                        true,
                    )?;
                }

                let base_asset_amount = base_asset_amount.unsigned_abs();
                base_asset_value_closed = base_asset_value_closed
                    .checked_add(quote_asset_amount)
                    .ok_or_else(math_error!())?;
                let mark_price_after = market.amm.mark_price()?;

                let trade_record = TradeRecord {
                    ts: now,
                    record_id: get_then_update_id!(market, next_trade_record_id),
                    user_authority: user.authority,
                    user: user_key,
                    direction: direction_to_close,
                    base_asset_amount,
                    quote_asset_amount,
                    mark_price_before,
                    mark_price_after,
                    fee: 0,
                    token_discount: 0,
                    quote_asset_amount_surplus: 0,
                    referee_discount: 0,
                    liquidation: true,
                    market_index: market_status.market_index,
                    oracle_price: market_status.oracle_status.price_data.price,
                };
                emit!(trade_record);

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
                let market = &mut market_map.get_ref_mut(&market_status.market_index)?;
                let mark_price_before = market_status.mark_price_before;

                let oracle_is_valid = oracle_status.is_valid;
                if !oracle_is_valid {
                    msg!("!oracle_is_valid");
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

                let position_index =
                    get_position_index(&user.positions, market_status.market_index)?;
                let existing_base_asset_amount = user.positions[position_index].base_asset_amount;

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
                        existing_base_asset_amount.unsigned_abs(),
                        mark_price_before_i128,
                    )?
                    .div(4),
                };

                let reduce_position_slippage_pct =
                    calculate_slippage_pct(reduce_position_slippage, mark_price_before_i128)?;

                let reduce_slippage_pct_too_large = reduce_position_slippage_pct
                    > MAX_LIQUIDATION_SLIPPAGE
                    || reduce_position_slippage_pct < -MAX_LIQUIDATION_SLIPPAGE;

                if reduce_slippage_pct_too_large {
                    msg!(
                        "reduce_position_slippage_pct {}",
                        reduce_position_slippage_pct
                    );
                }

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
                    math::position::direction_to_close_position(existing_base_asset_amount);

                let (base_asset_amount, _, pnl) = controller::position::reduce(
                    direction_to_reduce,
                    quote_asset_amount,
                    market,
                    &mut user.positions[position_index],
                    now,
                    Some(mark_price_before),
                    false,
                )?;

                {
                    let bank = &mut bank_map.get_quote_asset_bank_mut()?;
                    let user_bank_balance = user.get_quote_asset_bank_balance_mut();

                    update_bank_balances(
                        pnl.unsigned_abs(),
                        if pnl > 0 {
                            &BankBalanceType::Deposit
                        } else {
                            &BankBalanceType::Borrow
                        },
                        bank,
                        user_bank_balance,
                        true,
                    )?;
                }

                let base_asset_amount = base_asset_amount.unsigned_abs();

                let mark_price_after = market.amm.mark_price()?;

                let trade_record = TradeRecord {
                    ts: now,
                    record_id: get_then_update_id!(market, next_trade_record_id),
                    user_authority: user.authority,
                    user: user_key,
                    direction: direction_to_reduce,
                    base_asset_amount,
                    quote_asset_amount,
                    mark_price_before,
                    mark_price_after,
                    fee: 0,
                    token_discount: 0,
                    quote_asset_amount_surplus: 0,
                    referee_discount: 0,
                    liquidation: true,
                    market_index: market_status.market_index,
                    oracle_price: market_status.oracle_status.price_data.price,
                };
                emit!(trade_record);

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

        let withdrawal_amount = cast_to_u64(liquidation_fee)?;

        {
            let bank = &mut bank_map.get_quote_asset_bank_mut()?;
            let user_bank_balance = user.get_quote_asset_bank_balance_mut();
            update_bank_balances(
                liquidation_fee,
                &BankBalanceType::Borrow,
                bank,
                user_bank_balance,
                true,
            )?;
        }

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

        let liquidate_key = ctx.accounts.liquidator.key();
        if fee_to_liquidator > 0 {
            let bank = &mut bank_map.get_quote_asset_bank_mut()?;
            // handle edge case where user liquidates themselves
            if liquidate_key.eq(&user_key) {
                let user_bank_balance = user.get_quote_asset_bank_balance_mut();
                update_bank_balances(
                    fee_to_liquidator as u128,
                    &BankBalanceType::Deposit,
                    bank,
                    user_bank_balance,
                    true,
                )?;
            } else {
                let liquidator = &mut load_mut(&ctx.accounts.liquidator)?;
                let user_bank_balance = liquidator.get_quote_asset_bank_balance_mut();
                update_bank_balances(
                    fee_to_liquidator as u128,
                    &BankBalanceType::Deposit,
                    bank,
                    user_bank_balance,
                    true,
                )?;
            };
        }

        if fee_to_insurance_fund > 0 {
            let bank = bank_map.get_quote_asset_bank()?;
            controller::token::send_from_bank_vault(
                &ctx.accounts.token_program,
                &ctx.accounts.bank_vault,
                &ctx.accounts.insurance_vault,
                &ctx.accounts.bank_vault_authority,
                0,
                bank.vault_authority_nonce,
                fee_to_insurance_fund,
            )?
        }

        emit!(LiquidationRecord {
            ts: now,
            user: user_key,
            user_authority: user.authority,
            partial: !is_full_liquidation,
            base_asset_value,
            base_asset_value_closed,
            liquidation_fee,
            fee_to_liquidator,
            fee_to_insurance_fund,
            liquidator: ctx.accounts.liquidator.as_ref().key(),
            total_collateral,
            collateral,
            unrealized_pnl,
            margin_ratio,
        });

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
        let market = &mut ctx.accounts.market.load_mut()?;
        controller::amm::move_price(&mut market.amm, base_asset_reserve, quote_asset_reserve)?;
        Ok(())
    }

    #[access_control(
        market_initialized(&ctx.accounts.market)
    )]
    pub fn withdraw_fees(ctx: Context<WithdrawFees>, amount: u64) -> Result<()> {
        let market = &mut ctx.accounts.market.load_mut()?;

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

        let bank = ctx.accounts.bank.load()?;
        controller::token::send_from_bank_vault(
            &ctx.accounts.token_program,
            &ctx.accounts.bank_vault,
            &ctx.accounts.recipient,
            &ctx.accounts.bank_vault_authority,
            0,
            bank.vault_authority_nonce,
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
        let market = &mut ctx.accounts.market.load_mut()?;

        // The admin can move fees from the insurance fund back to the protocol so that money in
        // the insurance fund can be used to make market more optimal
        // 100% goes to user fee pool (symmetric funding, repeg, and k adjustments)
        market.amm.total_fee_minus_distributions = market
            .amm
            .total_fee_minus_distributions
            .checked_add(cast(amount)?)
            .ok_or_else(math_error!())?;

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

        let market = &mut ctx.accounts.market.load_mut()?;
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
            base_asset_amount: market.base_asset_amount,
            open_interest: market.open_interest,
            total_fee: market.amm.total_fee,
            total_fee_minus_distributions: market.amm.total_fee_minus_distributions,
            adjustment_cost,
            oracle_price,
            trade_record: 0,
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

        let market = &mut ctx.accounts.market.load_mut()?;
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

        let market = &mut ctx.accounts.market.load_mut()?;
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

        let remaining_accounts_iter = &mut ctx.remaining_accounts.iter().peekable();
        let market_map = MarketMap::load(
            &WritableMarkets::new(),
            &MarketOracles::new(), // oracles validated in calculate liquidation status
            remaining_accounts_iter,
        )?;

        let user_key = ctx.accounts.user.key();
        let user = &mut load_mut(&ctx.accounts.user)?;
        controller::funding::settle_funding_payment(user, &user_key, &market_map, now)?;
        Ok(())
    }

    #[allow(unused_must_use)]
    #[access_control(
        market_initialized(&ctx.accounts.market) &&
        exchange_not_paused(&ctx.accounts.state) &&
        valid_oracle_for_market(&ctx.accounts.oracle, &ctx.accounts.market)
    )]
    pub fn update_funding_rate(ctx: Context<UpdateFundingRate>, market_index: u64) -> Result<()> {
        let market = &mut ctx.accounts.market.load_mut()?;
        let price_oracle = &ctx.accounts.oracle;
        let clock = Clock::get()?;
        let now = clock.unix_timestamp;
        let clock_slot = clock.slot;

        controller::funding::update_funding_rate(
            market_index,
            market,
            price_oracle,
            now,
            clock_slot,
            &ctx.accounts.state.oracle_guard_rails,
            ctx.accounts.state.funding_paused,
            None,
        )?;

        Ok(())
    }

    #[allow(unused_must_use)]
    #[access_control(
        market_initialized(&ctx.accounts.market) &&
        valid_oracle_for_market(&ctx.accounts.oracle, &ctx.accounts.market) &&
        exchange_not_paused(&ctx.accounts.state)
    )]
    pub fn update_k(ctx: Context<AdminUpdateK>, sqrt_k: u128, market_index: u64) -> Result<()> {
        let clock = Clock::get()?;
        let now = clock.unix_timestamp;

        let market = &mut ctx.accounts.market.load_mut()?;

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

        let k_sqrt_check = bn::U192::from(amm.base_asset_reserve)
            .checked_mul(bn::U192::from(amm.quote_asset_reserve))
            .ok_or_else(math_error!())?
            .integer_sqrt()
            .try_to_u128()?;

        let k_err = cast_to_i128(k_sqrt_check)?
            .checked_sub(cast_to_i128(amm.sqrt_k)?)
            .ok_or_else(math_error!())?;

        if k_err.unsigned_abs() > 100 {
            let sqrt_k = amm.sqrt_k;
            msg!("k_err={:?}, {:?} != {:?}", k_err, k_sqrt_check, sqrt_k);
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
        });

        Ok(())
    }

    #[access_control(
        market_initialized(&ctx.accounts.market)
    )]
    pub fn update_margin_ratio(
        ctx: Context<AdminUpdateMarket>,
        margin_ratio_initial: u32,
        margin_ratio_partial: u32,
        margin_ratio_maintenance: u32,
    ) -> Result<()> {
        validate_margin(
            margin_ratio_initial,
            margin_ratio_partial,
            margin_ratio_maintenance,
        )?;

        let market = &mut ctx.accounts.market.load_mut()?;
        market.margin_ratio_initial = margin_ratio_initial;
        market.margin_ratio_partial = margin_ratio_partial;
        market.margin_ratio_maintenance = margin_ratio_maintenance;
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
        ctx: Context<AdminUpdateOrderState>,
        order_filler_reward_structure: OrderFillerRewardStructure,
    ) -> Result<()> {
        ctx.accounts.order_state.order_filler_reward_structure = order_filler_reward_structure;
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
        let market = &mut ctx.accounts.market.load_mut()?;
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
        let market = &mut ctx.accounts.market.load_mut()?;
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
        let market = &mut ctx.accounts.market.load_mut()?;
        market.amm.base_spread = base_spread;
        Ok(())
    }

    #[access_control(
        market_initialized(&ctx.accounts.market)
    )]
    pub fn update_market_minimum_base_asset_trade_size(
        ctx: Context<AdminUpdateMarket>,
        minimum_trade_size: u128,
    ) -> Result<()> {
        let market = &mut ctx.accounts.market.load_mut()?;
        market.amm.minimum_base_asset_trade_size = minimum_trade_size;
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
