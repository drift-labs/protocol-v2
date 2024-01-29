use std::convert::identity;
use std::mem::size_of;

use anchor_lang::prelude::*;
use anchor_spl::token::{Mint, Token, TokenAccount};
use phoenix::quantities::WrapperU64;
use serum_dex::state::ToAlignedBytes;
use solana_program::msg;

use crate::error::ErrorCode;
use crate::instructions::constraints::*;
use crate::load_mut;
use crate::math::casting::Cast;
use crate::math::constants::{
    DEFAULT_BASE_ASSET_AMOUNT_STEP_SIZE, DEFAULT_LIQUIDATION_MARGIN_BUFFER_RATIO,
    DEFAULT_QUOTE_ASSET_AMOUNT_TICK_SIZE, FEE_POOL_TO_REVENUE_POOL_THRESHOLD, IF_FACTOR_PRECISION,
    INSURANCE_A_MAX, INSURANCE_B_MAX, INSURANCE_C_MAX, INSURANCE_SPECULATIVE_MAX,
    LIQUIDATION_FEE_PRECISION, MAX_CONCENTRATION_COEFFICIENT, MAX_SQRT_K,
    MAX_UPDATE_K_PRICE_CHANGE, QUOTE_SPOT_MARKET_INDEX, SPOT_CUMULATIVE_INTEREST_PRECISION,
    SPOT_IMF_PRECISION, SPOT_WEIGHT_PRECISION, THIRTEEN_DAY, TWENTY_FOUR_HOUR,
};
use crate::math::cp_curve::get_update_k_result;
use crate::math::oracle::{is_oracle_valid_for_action, DriftAction};
use crate::math::orders::is_multiple_of_step_size;
use crate::math::repeg::get_total_fee_lower_bound;
use crate::math::safe_math::SafeMath;
use crate::math::spot_balance::get_token_amount;
use crate::math::{amm, bn, oracle};
use crate::math_error;
use crate::state::events::CurveRecord;
use crate::state::fulfillment_params::phoenix::PhoenixMarketContext;
use crate::state::fulfillment_params::phoenix::PhoenixV1FulfillmentConfig;
use crate::state::fulfillment_params::serum::SerumContext;
use crate::state::fulfillment_params::serum::SerumV3FulfillmentConfig;
use crate::state::insurance_fund_stake::ProtocolIfSharesTransferConfig;
use crate::state::oracle::{
    get_oracle_price, get_pyth_price, HistoricalIndexData, HistoricalOracleData, OraclePriceData,
    OracleSource,
};
use crate::state::paused_operations::{PerpOperation, SpotOperation};
use crate::state::perp_market::{
    ContractTier, ContractType, InsuranceClaim, MarketStatus, PerpMarket, PoolBalance, AMM,
};
use crate::state::spot_market::{
    AssetTier, InsuranceFund, SpotBalanceType, SpotFulfillmentConfigStatus, SpotMarket,
};
use crate::state::state::{ExchangeStatus, FeeStructure, OracleGuardRails, State};
use crate::state::traits::Size;
use crate::state::user::UserStats;
use crate::validate;
use crate::validation::fee_structure::validate_fee_structure;
use crate::validation::margin::{validate_margin, validate_margin_weights};
use crate::validation::perp_market::validate_perp_market;
use crate::validation::spot_market::validate_borrow_rate;
use crate::{controller, QUOTE_PRECISION_I64};
use crate::{get_then_update_id, EPOCH_DURATION};
use crate::{load, FEE_ADJUSTMENT_MAX};
use crate::{math, safe_decrement, safe_increment};

pub fn handle_initialize(ctx: Context<Initialize>) -> Result<()> {
    let (drift_signer, drift_signer_nonce) =
        Pubkey::find_program_address(&[b"drift_signer".as_ref()], ctx.program_id);

    **ctx.accounts.state = State {
        admin: *ctx.accounts.admin.key,
        exchange_status: ExchangeStatus::active(),
        whitelist_mint: Pubkey::default(),
        discount_mint: Pubkey::default(),
        oracle_guard_rails: OracleGuardRails::default(),
        number_of_authorities: 0,
        number_of_sub_accounts: 0,
        number_of_markets: 0,
        number_of_spot_markets: 0,
        min_perp_auction_duration: 10,
        default_market_order_time_in_force: 60,
        default_spot_auction_duration: 10,
        liquidation_margin_buffer_ratio: DEFAULT_LIQUIDATION_MARGIN_BUFFER_RATIO,
        settlement_duration: 0, // extra duration after market expiry to allow settlement
        signer: drift_signer,
        signer_nonce: drift_signer_nonce,
        srm_vault: Pubkey::default(),
        perp_fee_structure: FeeStructure::perps_default(),
        spot_fee_structure: FeeStructure::spot_default(),
        lp_cooldown_time: 0,
        liquidation_duration: 0,
        initial_pct_to_liquidate: 0,
        max_number_of_sub_accounts: 0,
        max_initialize_user_fee: 0,
        padding: [0; 10],
    };

    Ok(())
}

pub fn handle_initialize_spot_market(
    ctx: Context<InitializeSpotMarket>,
    optimal_utilization: u32,
    optimal_borrow_rate: u32,
    max_borrow_rate: u32,
    oracle_source: OracleSource,
    initial_asset_weight: u32,
    maintenance_asset_weight: u32,
    initial_liability_weight: u32,
    maintenance_liability_weight: u32,
    imf_factor: u32,
    liquidator_fee: u32,
    active_status: bool,
    name: [u8; 32],
) -> Result<()> {
    let state = &mut ctx.accounts.state;
    let spot_market_pubkey = ctx.accounts.spot_market.key();

    // protocol must be authority of collateral vault
    if ctx.accounts.spot_market_vault.owner != state.signer {
        return Err(ErrorCode::InvalidSpotMarketAuthority.into());
    }

    // protocol must be authority of collateral vault
    if ctx.accounts.insurance_fund_vault.owner != state.signer {
        return Err(ErrorCode::InvalidInsuranceFundAuthority.into());
    }

    validate_borrow_rate(optimal_utilization, optimal_borrow_rate, max_borrow_rate)?;

    let spot_market_index = get_then_update_id!(state, number_of_spot_markets);

    if oracle_source == OracleSource::QuoteAsset {
        // catches inconsistent parameters
        validate!(
            ctx.accounts.oracle.key == &Pubkey::default(),
            ErrorCode::InvalidSpotMarketInitialization,
            "For OracleSource::QuoteAsset, oracle must be default public key"
        )?;

        validate!(
            spot_market_index == QUOTE_SPOT_MARKET_INDEX,
            ErrorCode::InvalidSpotMarketInitialization,
            "For OracleSource::QuoteAsset, spot_market_index must be QUOTE_SPOT_MARKET_INDEX"
        )?;
    }

    let oracle_price_data = get_oracle_price(
        &oracle_source,
        &ctx.accounts.oracle,
        Clock::get()?.unix_timestamp.cast()?,
    );

    let (historical_oracle_data_default, historical_index_data_default) =
        if spot_market_index == QUOTE_SPOT_MARKET_INDEX {
            validate!(
                ctx.accounts.oracle.key == &Pubkey::default(),
                ErrorCode::InvalidSpotMarketInitialization,
                "For quote asset spot market, oracle must be default public key"
            )?;

            validate!(
                oracle_source == OracleSource::QuoteAsset,
                ErrorCode::InvalidSpotMarketInitialization,
                "For quote asset spot market, oracle source must be QuoteAsset"
            )?;

            validate!(
                ctx.accounts.spot_market_mint.decimals == 6,
                ErrorCode::InvalidSpotMarketInitialization,
                "For quote asset spot market, mint decimals must be 6"
            )?;

            (
                HistoricalOracleData::default_quote_oracle(),
                HistoricalIndexData::default_quote_oracle(),
            )
        } else {
            validate!(
                ctx.accounts.spot_market_mint.decimals >= 6,
                ErrorCode::InvalidSpotMarketInitialization,
                "Mint decimals must be greater than or equal to 6"
            )?;

            validate!(
                oracle_price_data.is_ok(),
                ErrorCode::InvalidSpotMarketInitialization,
                "Unable to read oracle price for {}",
                ctx.accounts.oracle.key,
            )?;

            (
                HistoricalOracleData::default_with_current_oracle(oracle_price_data?),
                HistoricalIndexData::default_with_current_oracle(oracle_price_data?)?,
            )
        };

    validate_margin_weights(
        spot_market_index,
        initial_asset_weight,
        maintenance_asset_weight,
        initial_liability_weight,
        maintenance_liability_weight,
        imf_factor,
    )?;

    let spot_market = &mut ctx.accounts.spot_market.load_init()?;
    let clock = Clock::get()?;
    let now = clock
        .unix_timestamp
        .cast()
        .or(Err(ErrorCode::UnableToCastUnixTime))?;

    let decimals = ctx.accounts.spot_market_mint.decimals.cast::<u32>()?;
    let order_step_size = 10_u64.pow(2 + decimals - 6); // 10 for usdc/btc, 10000 for sol

    **spot_market = SpotMarket {
        market_index: spot_market_index,
        pubkey: spot_market_pubkey,
        status: if active_status {
            MarketStatus::Active
        } else {
            MarketStatus::Initialized
        },
        name,
        asset_tier: if spot_market_index == QUOTE_SPOT_MARKET_INDEX {
            AssetTier::Collateral
        } else {
            AssetTier::Isolated
        },
        expiry_ts: 0,
        oracle: ctx.accounts.oracle.key(),
        oracle_source,
        historical_oracle_data: historical_oracle_data_default,
        historical_index_data: historical_index_data_default,
        mint: ctx.accounts.spot_market_mint.key(),
        vault: *ctx.accounts.spot_market_vault.to_account_info().key,
        revenue_pool: PoolBalance {
            scaled_balance: 0,
            market_index: spot_market_index,
            ..PoolBalance::default()
        }, // in base asset
        decimals,
        optimal_utilization,
        optimal_borrow_rate,
        max_borrow_rate,
        deposit_balance: 0,
        borrow_balance: 0,
        max_token_deposits: 0,
        deposit_token_twap: 0,
        borrow_token_twap: 0,
        utilization_twap: 0, // todo: use for dynamic interest / additional guards
        cumulative_deposit_interest: SPOT_CUMULATIVE_INTEREST_PRECISION,
        cumulative_borrow_interest: SPOT_CUMULATIVE_INTEREST_PRECISION,
        total_social_loss: 0,
        total_quote_social_loss: 0,
        last_interest_ts: now,
        last_twap_ts: now,
        initial_asset_weight,
        maintenance_asset_weight,
        initial_liability_weight,
        maintenance_liability_weight,
        imf_factor,
        liquidator_fee,
        if_liquidation_fee: LIQUIDATION_FEE_PRECISION / 100, // 1%
        withdraw_guard_threshold: 0,
        order_step_size,
        order_tick_size: DEFAULT_QUOTE_ASSET_AMOUNT_TICK_SIZE,
        min_order_size: order_step_size,
        max_position_size: 0,
        next_fill_record_id: 1,
        next_deposit_record_id: 1,
        spot_fee_pool: PoolBalance::default(), // in quote asset
        total_spot_fee: 0,
        orders_enabled: spot_market_index != 0,
        paused_operations: 0,
        padding1: [0; 5],
        flash_loan_amount: 0,
        flash_loan_initial_token_amount: 0,
        total_swap_fee: 0,
        scale_initial_asset_weight_start: 0,
        padding: [0; 48],
        insurance_fund: InsuranceFund {
            vault: *ctx.accounts.insurance_fund_vault.to_account_info().key,
            unstaking_period: THIRTEEN_DAY,
            ..InsuranceFund::default()
        },
    };

    Ok(())
}

pub fn handle_initialize_serum_fulfillment_config(
    ctx: Context<InitializeSerumFulfillmentConfig>,
    market_index: u16,
) -> Result<()> {
    validate!(
        market_index != QUOTE_SPOT_MARKET_INDEX,
        ErrorCode::InvalidSpotMarketAccount,
        "Cant add serum market to quote asset"
    )?;

    let base_spot_market = load!(&ctx.accounts.base_spot_market)?;
    let quote_spot_market = load!(&ctx.accounts.quote_spot_market)?;

    let serum_program_id = crate::ids::serum_program::id();
    validate!(
        ctx.accounts.serum_program.key() == serum_program_id,
        ErrorCode::InvalidSerumProgram
    )?;

    let serum_market_key = ctx.accounts.serum_market.key();

    let serum_context = SerumContext {
        serum_program: &ctx.accounts.serum_program,
        serum_market: &ctx.accounts.serum_market,
        serum_open_orders: &ctx.accounts.serum_open_orders,
    };

    let market_state = serum_context.load_serum_market()?;

    validate!(
        identity(market_state.coin_mint) == base_spot_market.mint.to_aligned_bytes(),
        ErrorCode::InvalidSerumMarket,
        "Invalid base mint"
    )?;

    validate!(
        identity(market_state.pc_mint) == quote_spot_market.mint.to_aligned_bytes(),
        ErrorCode::InvalidSerumMarket,
        "Invalid quote mint"
    )?;

    let market_step_size = market_state.coin_lot_size;
    let valid_step_size = base_spot_market.order_step_size >= market_step_size
        && base_spot_market
            .order_step_size
            .rem_euclid(market_step_size)
            == 0;

    validate!(
        valid_step_size,
        ErrorCode::InvalidSerumMarket,
        "base market step size ({}) not a multiple of serum step size ({})",
        base_spot_market.order_step_size,
        market_step_size
    )?;

    let market_tick_size = market_state.pc_lot_size;
    let valid_tick_size = base_spot_market.order_tick_size >= market_tick_size
        && base_spot_market
            .order_tick_size
            .rem_euclid(market_tick_size)
            == 0;

    validate!(
        valid_tick_size,
        ErrorCode::InvalidSerumMarket,
        "base market tick size ({}) not a multiple of serum tick size ({})",
        base_spot_market.order_tick_size,
        market_tick_size
    )?;

    drop(market_state);

    let open_orders_seeds: &[&[u8]] = &[b"serum_open_orders", serum_market_key.as_ref()];
    controller::pda::seed_and_create_pda(
        ctx.program_id,
        &ctx.accounts.admin.to_account_info(),
        &Rent::get()?,
        size_of::<serum_dex::state::OpenOrders>() + 12,
        &serum_program_id,
        &ctx.accounts.system_program.to_account_info(),
        &ctx.accounts.serum_open_orders,
        open_orders_seeds,
    )?;

    let open_orders = serum_context.load_open_orders()?;
    validate!(
        open_orders.account_flags == 0,
        ErrorCode::InvalidSerumOpenOrders,
        "Serum open orders already initialized"
    )?;
    drop(open_orders);

    serum_context.invoke_init_open_orders(
        &ctx.accounts.drift_signer,
        &ctx.accounts.rent,
        ctx.accounts.state.signer_nonce,
    )?;

    let serum_fulfillment_config_key = ctx.accounts.serum_fulfillment_config.key();
    let mut serum_fulfillment_config = ctx.accounts.serum_fulfillment_config.load_init()?;
    *serum_fulfillment_config = serum_context
        .to_serum_v3_fulfillment_config(&serum_fulfillment_config_key, market_index)?;

    Ok(())
}

pub fn handle_update_serum_fulfillment_config_status(
    ctx: Context<UpdateSerumFulfillmentConfig>,
    status: SpotFulfillmentConfigStatus,
) -> Result<()> {
    let mut config = load_mut!(ctx.accounts.serum_fulfillment_config)?;
    config.status = status;
    Ok(())
}

pub fn handle_update_serum_vault(ctx: Context<UpdateSerumVault>) -> Result<()> {
    let vault = &ctx.accounts.srm_vault;
    validate!(
        vault.mint == crate::ids::srm_mint::id() || vault.mint == crate::ids::msrm_mint::id(),
        ErrorCode::InvalidSrmVault,
        "vault did not hav srm or msrm mint"
    )?;

    validate!(
        vault.owner == ctx.accounts.state.signer,
        ErrorCode::InvalidVaultOwner,
        "vault owner was not program signer"
    )?;

    let state = &mut ctx.accounts.state;
    state.srm_vault = vault.key();

    Ok(())
}

pub fn handle_initialize_phoenix_fulfillment_config(
    ctx: Context<InitializePhoenixFulfillmentConfig>,
    market_index: u16,
) -> Result<()> {
    validate!(
        market_index != QUOTE_SPOT_MARKET_INDEX,
        ErrorCode::InvalidSpotMarketAccount,
        "Cannot add phoenix market to quote asset"
    )?;

    let base_spot_market = load!(&ctx.accounts.base_spot_market)?;
    let quote_spot_market = load!(&ctx.accounts.quote_spot_market)?;

    let phoenix_program_id = phoenix::id();

    validate!(
        ctx.accounts.phoenix_program.key() == phoenix_program_id,
        ErrorCode::InvalidPhoenixProgram
    )?;

    let phoenix_market_context = PhoenixMarketContext::new(&ctx.accounts.phoenix_market)?;

    validate!(
        phoenix_market_context.header.base_params.mint_key == base_spot_market.mint,
        ErrorCode::InvalidPhoenixMarket,
        "Invalid base mint"
    )?;

    validate!(
        phoenix_market_context.header.quote_params.mint_key == quote_spot_market.mint,
        ErrorCode::InvalidPhoenixMarket,
        "Invalid quote mint"
    )?;

    let market_step_size = phoenix_market_context.header.get_base_lot_size().as_u64();
    let valid_step_size = base_spot_market.order_step_size >= market_step_size
        && base_spot_market
            .order_step_size
            .rem_euclid(market_step_size)
            == 0;

    validate!(
        valid_step_size,
        ErrorCode::InvalidPhoenixMarket,
        "base market step size ({}) not a multiple of Phoenix base lot size ({})",
        base_spot_market.order_step_size,
        market_step_size
    )?;

    let phoenix_fulfillment_config_key = ctx.accounts.phoenix_fulfillment_config.key();
    let mut phoenix_fulfillment_config = ctx.accounts.phoenix_fulfillment_config.load_init()?;
    *phoenix_fulfillment_config = phoenix_market_context
        .to_phoenix_v1_fulfillment_config(&phoenix_fulfillment_config_key, market_index);

    Ok(())
}

pub fn handle_update_phoenix_fulfillment_config_status(
    ctx: Context<UpdatePhoenixFulfillmentConfig>,
    status: SpotFulfillmentConfigStatus,
) -> Result<()> {
    let mut config = load_mut!(ctx.accounts.phoenix_fulfillment_config)?;
    config.status = status;
    Ok(())
}

pub fn handle_initialize_perp_market(
    ctx: Context<InitializePerpMarket>,
    market_index: u16,
    amm_base_asset_reserve: u128,
    amm_quote_asset_reserve: u128,
    amm_periodicity: i64,
    amm_peg_multiplier: u128,
    oracle_source: OracleSource,
    margin_ratio_initial: u32,
    margin_ratio_maintenance: u32,
    liquidator_fee: u32,
    active_status: bool,
    name: [u8; 32],
) -> Result<()> {
    let perp_market_pubkey = ctx.accounts.perp_market.to_account_info().key;
    let perp_market = &mut ctx.accounts.perp_market.load_init()?;
    let clock = Clock::get()?;
    let now = clock.unix_timestamp;
    let clock_slot = clock.slot;

    if amm_base_asset_reserve != amm_quote_asset_reserve {
        return Err(ErrorCode::InvalidInitialPeg.into());
    }

    let init_reserve_price = amm::calculate_price(
        amm_quote_asset_reserve,
        amm_base_asset_reserve,
        amm_peg_multiplier,
    )?;

    assert_eq!(amm_peg_multiplier, init_reserve_price.cast::<u128>()?);

    let concentration_coef = MAX_CONCENTRATION_COEFFICIENT;

    // Verify there's no overflow
    let _k =
        bn::U192::from(amm_base_asset_reserve).safe_mul(bn::U192::from(amm_quote_asset_reserve))?;

    let (min_base_asset_reserve, max_base_asset_reserve) =
        amm::calculate_bid_ask_bounds(concentration_coef, amm_base_asset_reserve)?;

    // Verify oracle is readable
    let (oracle_price, oracle_delay, last_oracle_price_twap) = match oracle_source {
        OracleSource::Pyth => {
            let OraclePriceData {
                price: oracle_price,
                delay: oracle_delay,
                ..
            } = get_pyth_price(&ctx.accounts.oracle, clock_slot, 1)?;
            let last_oracle_price_twap = perp_market.amm.get_pyth_twap(&ctx.accounts.oracle, 1)?;
            (oracle_price, oracle_delay, last_oracle_price_twap)
        }
        OracleSource::Pyth1K => {
            let OraclePriceData {
                price: oracle_price,
                delay: oracle_delay,
                ..
            } = get_pyth_price(&ctx.accounts.oracle, clock_slot, 1000)?;
            let last_oracle_price_twap =
                perp_market.amm.get_pyth_twap(&ctx.accounts.oracle, 1000)?;
            (oracle_price, oracle_delay, last_oracle_price_twap)
        }
        OracleSource::Pyth1M => {
            let OraclePriceData {
                price: oracle_price,
                delay: oracle_delay,
                ..
            } = get_pyth_price(&ctx.accounts.oracle, clock_slot, 1000000)?;
            let last_oracle_price_twap = perp_market
                .amm
                .get_pyth_twap(&ctx.accounts.oracle, 1000000)?;
            (oracle_price, oracle_delay, last_oracle_price_twap)
        }
        OracleSource::PythStableCoin => {
            let OraclePriceData {
                price: oracle_price,
                delay: oracle_delay,
                ..
            } = get_pyth_price(&ctx.accounts.oracle, clock_slot, 1)?;
            (oracle_price, oracle_delay, QUOTE_PRECISION_I64)
        }
        OracleSource::Switchboard => {
            msg!("Switchboard oracle cant be used for perp market");
            return Err(ErrorCode::InvalidOracle.into());
        }
        OracleSource::QuoteAsset => {
            msg!("Quote asset oracle cant be used for perp market");
            return Err(ErrorCode::InvalidOracle.into());
        }
    };

    let max_spread = (margin_ratio_initial - margin_ratio_maintenance) * (100 - 5);

    // todo? should ensure peg within 1 cent of current oracle?
    // validate!(
    //     amm_peg_multiplier.cast::<i128>()?
    //         .safe_sub(oracle_price)
    //         ?
    //         .unsigned_abs()
    //         < PRICE_PRECISION / 100,
    //     ErrorCode::InvalidInitialPeg
    // )?;

    validate_margin(
        margin_ratio_initial,
        margin_ratio_maintenance,
        liquidator_fee,
        max_spread,
    )?;

    let state = &mut ctx.accounts.state;
    validate!(
        market_index == state.number_of_markets,
        ErrorCode::MarketIndexAlreadyInitialized,
        "market_index={} != state.number_of_markets={}",
        market_index,
        state.number_of_markets
    )?;

    **perp_market = PerpMarket {
        contract_type: ContractType::Perpetual,
        contract_tier: ContractTier::Speculative, // default
        status: if active_status {
            MarketStatus::Active
        } else {
            MarketStatus::Initialized
        },
        name,
        expiry_price: 0,
        expiry_ts: 0,
        pubkey: *perp_market_pubkey,
        market_index,
        number_of_users_with_base: 0,
        number_of_users: 0,
        margin_ratio_initial, // unit is 20% (+2 decimal places)
        margin_ratio_maintenance,
        imf_factor: 0,
        next_fill_record_id: 1,
        next_funding_rate_record_id: 1,
        next_curve_record_id: 1,
        pnl_pool: PoolBalance::default(),
        insurance_claim: InsuranceClaim::default(),
        unrealized_pnl_initial_asset_weight: SPOT_WEIGHT_PRECISION.cast()?, // 100%
        unrealized_pnl_maintenance_asset_weight: SPOT_WEIGHT_PRECISION.cast()?, // 100%
        unrealized_pnl_imf_factor: 0,
        unrealized_pnl_max_imbalance: 0,
        liquidator_fee,
        if_liquidation_fee: LIQUIDATION_FEE_PRECISION / 100, // 1%
        paused_operations: 0,
        quote_spot_market_index: 0,
        fee_adjustment: 0,
        padding: [0; 46],
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
            cumulative_funding_rate_long: 0,
            cumulative_funding_rate_short: 0,
            total_social_loss: 0,
            last_funding_rate: 0,
            last_funding_rate_long: 0,
            last_funding_rate_short: 0,
            last_24h_avg_funding_rate: 0,
            last_funding_rate_ts: now,
            funding_period: amm_periodicity,
            last_mark_price_twap: init_reserve_price,
            last_mark_price_twap_5min: init_reserve_price,
            last_mark_price_twap_ts: now,
            sqrt_k: amm_base_asset_reserve,
            concentration_coef,
            min_base_asset_reserve,
            max_base_asset_reserve,
            peg_multiplier: amm_peg_multiplier,
            total_fee: 0,
            total_fee_withdrawn: 0,
            total_fee_minus_distributions: 0,
            total_mm_fee: 0,
            total_exchange_fee: 0,
            total_liquidation_fee: 0,
            net_revenue_since_last_funding: 0,
            historical_oracle_data: HistoricalOracleData {
                last_oracle_price: oracle_price,
                last_oracle_delay: oracle_delay,
                last_oracle_price_twap,
                last_oracle_price_twap_5min: oracle_price,
                last_oracle_price_twap_ts: now,
                ..HistoricalOracleData::default()
            },
            last_oracle_normalised_price: oracle_price,
            last_oracle_conf_pct: 0,
            last_oracle_reserve_price_spread_pct: 0, // todo
            order_step_size: DEFAULT_BASE_ASSET_AMOUNT_STEP_SIZE,
            order_tick_size: DEFAULT_QUOTE_ASSET_AMOUNT_TICK_SIZE,
            min_order_size: DEFAULT_BASE_ASSET_AMOUNT_STEP_SIZE,
            max_position_size: 0,
            max_slippage_ratio: 50,         // ~2%
            max_fill_reserve_fraction: 100, // moves price ~2%
            base_spread: 0,
            long_spread: 0,
            short_spread: 0,
            max_spread,
            last_bid_price_twap: init_reserve_price,
            last_ask_price_twap: init_reserve_price,
            base_asset_amount_with_amm: 0,
            base_asset_amount_long: 0,
            base_asset_amount_short: 0,
            quote_asset_amount: 0,
            quote_entry_amount_long: 0,
            quote_entry_amount_short: 0,
            quote_break_even_amount_long: 0,
            quote_break_even_amount_short: 0,
            max_open_interest: 0,
            mark_std: 0,
            oracle_std: 0,
            volume_24h: 0,
            long_intensity_count: 0,
            long_intensity_volume: 0,
            short_intensity_count: 0,
            short_intensity_volume: 0,
            last_trade_ts: now,
            curve_update_intensity: 0,
            fee_pool: PoolBalance::default(),
            base_asset_amount_per_lp: 0,
            quote_asset_amount_per_lp: 0,
            last_update_slot: clock_slot,

            // lp stuff
            base_asset_amount_with_unsettled_lp: 0,
            user_lp_shares: 0,
            amm_jit_intensity: 0, // turn it off at the start

            last_oracle_valid: false,
            target_base_asset_amount_per_lp: 0,
            per_lp_base: 0,
            padding1: 0,
            padding2: 0,
            total_fee_earned_per_lp: 0,
            net_unsettled_funding_pnl: 0,
            quote_asset_amount_with_unsettled_lp: 0,
            reference_price_offset: 0,
            padding: [0; 12],
        },
    };

    safe_increment!(state.number_of_markets, 1);

    Ok(())
}

pub fn handle_delete_initialized_perp_market(
    ctx: Context<DeleteInitializedPerpMarket>,
    market_index: u16,
) -> Result<()> {
    let perp_market = &mut ctx.accounts.perp_market.load()?;
    let state = &mut ctx.accounts.state;

    // to preserve all protocol invariants, can only remove the last market if it hasn't been "activated"

    validate!(
        state.number_of_markets - 1 == market_index,
        ErrorCode::InvalidMarketAccountforDeletion,
        "state.number_of_markets={} != market_index={}",
        state.number_of_markets,
        market_index
    )?;
    validate!(
        perp_market.status == MarketStatus::Initialized,
        ErrorCode::InvalidMarketAccountforDeletion,
        "perp_market.status != Initialized",
    )?;
    validate!(
        perp_market.number_of_users == 0,
        ErrorCode::InvalidMarketAccountforDeletion,
        "perp_market.number_of_users={} != 0",
        perp_market.number_of_users,
    )?;
    validate!(
        perp_market.market_index == market_index,
        ErrorCode::InvalidMarketAccountforDeletion,
        "market_index={} != perp_market.market_index={}",
        market_index,
        perp_market.market_index
    )?;

    safe_decrement!(state.number_of_markets, 1);

    Ok(())
}

#[access_control(
    spot_market_valid(&ctx.accounts.spot_market)
)]
pub fn handle_update_spot_market_oracle(
    ctx: Context<AdminUpdateSpotMarketOracle>,
    oracle: Pubkey,
    oracle_source: OracleSource,
) -> Result<()> {
    let spot_market = &mut load_mut!(ctx.accounts.spot_market)?;
    let clock = Clock::get()?;

    // Verify oracle is readable
    let OraclePriceData {
        price: _oracle_price,
        delay: _oracle_delay,
        ..
    } = get_oracle_price(&oracle_source, &ctx.accounts.oracle, clock.slot)?;

    spot_market.oracle = oracle;
    spot_market.oracle_source = oracle_source;
    Ok(())
}

#[access_control(
    spot_market_valid(&ctx.accounts.spot_market)
)]
pub fn handle_update_spot_market_expiry(
    ctx: Context<AdminUpdateSpotMarket>,
    expiry_ts: i64,
) -> Result<()> {
    let spot_market = &mut load_mut!(ctx.accounts.spot_market)?;
    let now = Clock::get()?.unix_timestamp;

    validate!(
        now < expiry_ts,
        ErrorCode::DefaultError,
        "Market expiry ts must later than current clock timestamp"
    )?;

    spot_market.status = MarketStatus::ReduceOnly;
    spot_market.expiry_ts = expiry_ts;

    Ok(())
}

#[access_control(
    perp_market_valid(&ctx.accounts.perp_market)
)]
pub fn handle_update_perp_market_expiry(
    ctx: Context<AdminUpdatePerpMarket>,
    expiry_ts: i64,
) -> Result<()> {
    let clock = Clock::get()?;
    let perp_market = &mut load_mut!(ctx.accounts.perp_market)?;
    validate!(
        clock.unix_timestamp < expiry_ts,
        ErrorCode::DefaultError,
        "Market expiry ts must later than current clock timestamp"
    )?;

    // automatically enter reduce only
    perp_market.status = MarketStatus::ReduceOnly;
    perp_market.expiry_ts = expiry_ts;

    Ok(())
}

#[access_control(
    perp_market_valid(&ctx.accounts.perp_market)
)]
pub fn handle_move_amm_price(
    ctx: Context<AdminUpdatePerpMarket>,
    base_asset_reserve: u128,
    quote_asset_reserve: u128,
    sqrt_k: u128,
) -> Result<()> {
    let perp_market = &mut load_mut!(ctx.accounts.perp_market)?;
    controller::amm::move_price(
        &mut perp_market.amm,
        base_asset_reserve,
        quote_asset_reserve,
        sqrt_k,
    )?;
    validate_perp_market(perp_market)?;

    Ok(())
}

#[access_control(
    perp_market_valid(&ctx.accounts.perp_market)
)]
pub fn handle_recenter_perp_market_amm(
    ctx: Context<AdminUpdatePerpMarket>,
    peg_multiplier: u128,
    sqrt_k: u128,
) -> Result<()> {
    let perp_market = &mut load_mut!(ctx.accounts.perp_market)?;
    controller::amm::recenter_perp_market_amm(&mut perp_market.amm, peg_multiplier, sqrt_k)?;
    validate_perp_market(perp_market)?;

    Ok(())
}

#[access_control(
    perp_market_valid(&ctx.accounts.perp_market)
)]
pub fn handle_settle_expired_market_pools_to_revenue_pool(
    ctx: Context<SettleExpiredMarketPoolsToRevenuePool>,
) -> Result<()> {
    let perp_market = &mut load_mut!(ctx.accounts.perp_market)?;
    let spot_market = &mut load_mut!(ctx.accounts.spot_market)?;
    let state = &ctx.accounts.state;

    let clock = Clock::get()?;
    let now = clock.unix_timestamp;

    controller::spot_balance::update_spot_market_cumulative_interest(spot_market, None, now)?;

    validate!(
        spot_market.market_index == QUOTE_SPOT_MARKET_INDEX,
        ErrorCode::DefaultError,
        "spot_market must be perp market's quote asset"
    )?;

    validate!(
        perp_market.status == MarketStatus::Settlement,
        ErrorCode::DefaultError,
        "Market must in Settlement"
    )?;

    validate!(
        perp_market.amm.base_asset_amount_long == 0
            && perp_market.amm.base_asset_amount_short == 0
            && perp_market.number_of_users_with_base == 0,
        ErrorCode::DefaultError,
        "outstanding base_asset_amounts must be balanced"
    )?;

    validate!(
        math::amm::calculate_net_user_cost_basis(&perp_market.amm)? == 0,
        ErrorCode::DefaultError,
        "outstanding quote_asset_amounts must be balanced"
    )?;

    // block when settlement_duration is default/unconfigured
    validate!(
        state.settlement_duration != 0,
        ErrorCode::DefaultError,
        "invalid state.settlement_duration (is 0)"
    )?;

    let escrow_period_before_transfer = if state.settlement_duration > 1 {
        // minimum of TWENTY_FOUR_HOUR to examine settlement process
        TWENTY_FOUR_HOUR
            .safe_add(state.settlement_duration.cast()?)?
            .safe_sub(1)?
    } else {
        // for testing / expediting if settlement_duration not default but 1
        state.settlement_duration.cast::<i64>()?
    };

    validate!(
        now > perp_market
            .expiry_ts
            .safe_add(escrow_period_before_transfer)?,
        ErrorCode::DefaultError,
        "must be escrow_period_before_transfer={} after market.expiry_ts",
        escrow_period_before_transfer
    )?;

    let fee_pool_token_amount = get_token_amount(
        perp_market.amm.fee_pool.scaled_balance,
        spot_market,
        &SpotBalanceType::Deposit,
    )?;
    let pnl_pool_token_amount = get_token_amount(
        perp_market.pnl_pool.scaled_balance,
        spot_market,
        &SpotBalanceType::Deposit,
    )?;

    controller::spot_balance::update_spot_balances(
        fee_pool_token_amount,
        &SpotBalanceType::Borrow,
        spot_market,
        &mut perp_market.amm.fee_pool,
        false,
    )?;

    controller::spot_balance::update_spot_balances(
        pnl_pool_token_amount,
        &SpotBalanceType::Borrow,
        spot_market,
        &mut perp_market.pnl_pool,
        false,
    )?;

    controller::spot_balance::update_revenue_pool_balances(
        pnl_pool_token_amount.safe_add(fee_pool_token_amount)?,
        &SpotBalanceType::Deposit,
        spot_market,
    )?;

    math::spot_withdraw::validate_spot_balances(spot_market)?;

    perp_market.status = MarketStatus::Delisted;

    Ok(())
}

#[access_control(
    perp_market_valid(&ctx.accounts.perp_market)
)]
pub fn handle_deposit_into_perp_market_fee_pool(
    ctx: Context<DepositIntoMarketFeePool>,
    amount: u64,
) -> Result<()> {
    let perp_market = &mut load_mut!(ctx.accounts.perp_market)?;

    perp_market.amm.total_fee_minus_distributions = perp_market
        .amm
        .total_fee_minus_distributions
        .safe_add(amount.cast()?)?;

    let quote_spot_market = &mut load_mut!(ctx.accounts.quote_spot_market)?;

    controller::spot_balance::update_spot_balances(
        amount.cast::<u128>()?,
        &SpotBalanceType::Deposit,
        quote_spot_market,
        &mut perp_market.amm.fee_pool,
        false,
    )?;

    controller::token::receive(
        &ctx.accounts.token_program,
        &ctx.accounts.source_vault,
        &ctx.accounts.spot_market_vault,
        &ctx.accounts.admin.to_account_info(),
        amount,
    )?;

    Ok(())
}

#[access_control(
    perp_market_valid(&ctx.accounts.perp_market)
    valid_oracle_for_perp_market(&ctx.accounts.oracle, &ctx.accounts.perp_market)
)]
pub fn handle_repeg_amm_curve(ctx: Context<RepegCurve>, new_peg_candidate: u128) -> Result<()> {
    let clock = Clock::get()?;
    let now = clock.unix_timestamp;
    let clock_slot = clock.slot;

    let perp_market = &mut load_mut!(ctx.accounts.perp_market)?;
    let price_oracle = &ctx.accounts.oracle;
    let OraclePriceData {
        price: oracle_price,
        ..
    } = get_oracle_price(&perp_market.amm.oracle_source, price_oracle, clock.slot)?;

    let peg_multiplier_before = perp_market.amm.peg_multiplier;
    let base_asset_reserve_before = perp_market.amm.base_asset_reserve;
    let quote_asset_reserve_before = perp_market.amm.quote_asset_reserve;
    let sqrt_k_before = perp_market.amm.sqrt_k;

    let oracle_validity_rails = &ctx.accounts.state.oracle_guard_rails;

    let adjustment_cost = controller::repeg::repeg(
        perp_market,
        price_oracle,
        new_peg_candidate,
        clock_slot,
        oracle_validity_rails,
    )?;

    let peg_multiplier_after = perp_market.amm.peg_multiplier;
    let base_asset_reserve_after = perp_market.amm.base_asset_reserve;
    let quote_asset_reserve_after = perp_market.amm.quote_asset_reserve;
    let sqrt_k_after = perp_market.amm.sqrt_k;

    emit!(CurveRecord {
        ts: now,
        record_id: get_then_update_id!(perp_market, next_curve_record_id),
        market_index: perp_market.market_index,
        peg_multiplier_before,
        base_asset_reserve_before,
        quote_asset_reserve_before,
        sqrt_k_before,
        peg_multiplier_after,
        base_asset_reserve_after,
        quote_asset_reserve_after,
        sqrt_k_after,
        base_asset_amount_long: perp_market.amm.base_asset_amount_long.unsigned_abs(),
        base_asset_amount_short: perp_market.amm.base_asset_amount_short.unsigned_abs(),
        base_asset_amount_with_amm: perp_market.amm.base_asset_amount_with_amm,
        number_of_users: perp_market.number_of_users,
        total_fee: perp_market.amm.total_fee,
        total_fee_minus_distributions: perp_market.amm.total_fee_minus_distributions,
        adjustment_cost,
        oracle_price,
        fill_record: 0,
    });

    Ok(())
}

#[access_control(
    perp_market_valid(&ctx.accounts.perp_market)
    valid_oracle_for_perp_market(&ctx.accounts.oracle, &ctx.accounts.perp_market)
)]
pub fn handle_update_amm_oracle_twap(ctx: Context<RepegCurve>) -> Result<()> {
    // allow update to amm's oracle twap iff price gap is reduced and thus more tame funding
    // otherwise if oracle error or funding flip: set oracle twap to mark twap (0 gap)

    let clock = Clock::get()?;
    let now = clock.unix_timestamp;

    let perp_market = &mut load_mut!(ctx.accounts.perp_market)?;
    let price_oracle = &ctx.accounts.oracle;
    let oracle_twap = perp_market.amm.get_oracle_twap(price_oracle)?;

    if let Some(oracle_twap) = oracle_twap {
        let oracle_mark_gap_before = perp_market
            .amm
            .last_mark_price_twap
            .cast::<i64>()?
            .safe_sub(
                perp_market
                    .amm
                    .historical_oracle_data
                    .last_oracle_price_twap,
            )?;

        let oracle_mark_gap_after = perp_market
            .amm
            .last_mark_price_twap
            .cast::<i64>()?
            .safe_sub(oracle_twap)?;

        if (oracle_mark_gap_after > 0 && oracle_mark_gap_before < 0)
            || (oracle_mark_gap_after < 0 && oracle_mark_gap_before > 0)
        {
            perp_market
                .amm
                .historical_oracle_data
                .last_oracle_price_twap = perp_market.amm.last_mark_price_twap.cast::<i64>()?;
            perp_market
                .amm
                .historical_oracle_data
                .last_oracle_price_twap_ts = now;
        } else if oracle_mark_gap_after.unsigned_abs() <= oracle_mark_gap_before.unsigned_abs() {
            perp_market
                .amm
                .historical_oracle_data
                .last_oracle_price_twap = oracle_twap;
            perp_market
                .amm
                .historical_oracle_data
                .last_oracle_price_twap_ts = now;
        } else {
            return Err(ErrorCode::PriceBandsBreached.into());
        }
    } else {
        return Err(ErrorCode::InvalidOracle.into());
    }

    Ok(())
}

#[access_control(
    perp_market_valid(&ctx.accounts.perp_market)
    valid_oracle_for_perp_market(&ctx.accounts.oracle, &ctx.accounts.perp_market)
)]
pub fn handle_update_k(ctx: Context<AdminUpdateK>, sqrt_k: u128) -> Result<()> {
    let clock = Clock::get()?;
    let now = clock.unix_timestamp;

    let perp_market = &mut load_mut!(ctx.accounts.perp_market)?;

    let base_asset_amount_long = perp_market.amm.base_asset_amount_long.unsigned_abs();
    let base_asset_amount_short = perp_market.amm.base_asset_amount_short.unsigned_abs();
    let base_asset_amount_with_amm = perp_market.amm.base_asset_amount_with_amm;
    let number_of_users = perp_market.number_of_users_with_base;

    let price_before = math::amm::calculate_price(
        perp_market.amm.quote_asset_reserve,
        perp_market.amm.base_asset_reserve,
        perp_market.amm.peg_multiplier,
    )?;

    let peg_multiplier_before = perp_market.amm.peg_multiplier;
    let base_asset_reserve_before = perp_market.amm.base_asset_reserve;
    let quote_asset_reserve_before = perp_market.amm.quote_asset_reserve;
    let sqrt_k_before = perp_market.amm.sqrt_k;

    let k_increasing = sqrt_k > perp_market.amm.sqrt_k;

    let new_sqrt_k_u192 = bn::U192::from(sqrt_k);

    let update_k_result = get_update_k_result(perp_market, new_sqrt_k_u192, true)?;

    let adjustment_cost: i128 = math::cp_curve::adjust_k_cost(perp_market, &update_k_result)?;

    math::cp_curve::update_k(perp_market, &update_k_result)?;

    if k_increasing {
        validate!(
            adjustment_cost >= 0,
            ErrorCode::InvalidUpdateK,
            "adjustment_cost negative when k increased",
        )?;
    } else {
        validate!(
            adjustment_cost <= 0,
            ErrorCode::InvalidUpdateK,
            "adjustment_cost positive when k decreased",
        )?;
    }

    if adjustment_cost > 0 {
        let max_cost = perp_market
            .amm
            .total_fee_minus_distributions
            .safe_sub(get_total_fee_lower_bound(perp_market)?.cast()?)?
            .safe_sub(perp_market.amm.total_fee_withdrawn.cast()?)?;

        validate!(
            adjustment_cost <= max_cost,
            ErrorCode::InvalidUpdateK,
            "adjustment_cost={} > max_cost={} for k change",
            adjustment_cost,
            max_cost
        )?;
    }

    validate!(
        !k_increasing || perp_market.amm.sqrt_k < MAX_SQRT_K,
        ErrorCode::InvalidUpdateK,
        "cannot increase sqrt_k={} past MAX_SQRT_K",
        perp_market.amm.sqrt_k
    )?;

    validate!(
        perp_market.amm.sqrt_k > perp_market.amm.user_lp_shares,
        ErrorCode::InvalidUpdateK,
        "cannot decrease sqrt_k={} below user_lp_shares={}",
        perp_market.amm.sqrt_k,
        perp_market.amm.user_lp_shares
    )?;

    perp_market.amm.total_fee_minus_distributions = perp_market
        .amm
        .total_fee_minus_distributions
        .safe_sub(adjustment_cost)?;

    perp_market.amm.net_revenue_since_last_funding = perp_market
        .amm
        .net_revenue_since_last_funding
        .safe_sub(adjustment_cost as i64)?;

    let amm = &perp_market.amm;

    let price_after = math::amm::calculate_price(
        amm.quote_asset_reserve,
        amm.base_asset_reserve,
        amm.peg_multiplier,
    )?;

    let price_change_too_large = price_before
        .cast::<i128>()?
        .safe_sub(price_after.cast::<i128>()?)?
        .unsigned_abs()
        .gt(&MAX_UPDATE_K_PRICE_CHANGE);

    if price_change_too_large {
        msg!(
            "{:?} -> {:?} (> {:?})",
            price_before,
            price_after,
            MAX_UPDATE_K_PRICE_CHANGE
        );
        return Err(ErrorCode::InvalidUpdateK.into());
    }

    let k_sqrt_check = bn::U192::from(amm.base_asset_reserve)
        .safe_mul(bn::U192::from(amm.quote_asset_reserve))?
        .integer_sqrt()
        .try_to_u128()?;

    let k_err = k_sqrt_check
        .cast::<i128>()?
        .safe_sub(amm.sqrt_k.cast::<i128>()?)?;

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
    } = get_oracle_price(
        &perp_market.amm.oracle_source,
        &ctx.accounts.oracle,
        clock.slot,
    )?;

    emit!(CurveRecord {
        ts: now,
        record_id: get_then_update_id!(perp_market, next_curve_record_id),
        market_index: perp_market.market_index,
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
        base_asset_amount_with_amm,
        number_of_users,
        adjustment_cost,
        total_fee,
        total_fee_minus_distributions,
        oracle_price,
        fill_record: 0,
    });

    Ok(())
}

#[access_control(
    perp_market_valid(&ctx.accounts.perp_market)
    valid_oracle_for_perp_market(&ctx.accounts.oracle, &ctx.accounts.perp_market)
)]
pub fn handle_reset_amm_oracle_twap(ctx: Context<RepegCurve>) -> Result<()> {
    // if oracle is invalid, failsafe to reset amm oracle_twap to the mark_twap

    let state = &ctx.accounts.state;

    let clock = Clock::get()?;
    let now = clock.unix_timestamp;
    let clock_slot = clock.slot;

    let perp_market = &mut load_mut!(ctx.accounts.perp_market)?;
    let price_oracle = &ctx.accounts.oracle;
    let oracle_price_data =
        &get_oracle_price(&perp_market.amm.oracle_source, price_oracle, clock_slot)?;

    let oracle_validity = oracle::oracle_validity(
        perp_market
            .amm
            .historical_oracle_data
            .last_oracle_price_twap,
        oracle_price_data,
        &state.oracle_guard_rails.validity,
    )?;

    let is_oracle_valid =
        is_oracle_valid_for_action(oracle_validity, Some(DriftAction::UpdateFunding))?;

    if !is_oracle_valid {
        perp_market
            .amm
            .historical_oracle_data
            .last_oracle_price_twap = perp_market.amm.last_mark_price_twap.cast::<i64>()?;
        perp_market
            .amm
            .historical_oracle_data
            .last_oracle_price_twap_ts = now;
    }

    Ok(())
}

#[access_control(
    perp_market_valid(&ctx.accounts.perp_market)
)]
pub fn handle_update_perp_market_margin_ratio(
    ctx: Context<AdminUpdatePerpMarket>,
    margin_ratio_initial: u32,
    margin_ratio_maintenance: u32,
) -> Result<()> {
    let perp_market = &mut load_mut!(ctx.accounts.perp_market)?;
    validate_margin(
        margin_ratio_initial,
        margin_ratio_maintenance,
        perp_market.liquidator_fee,
        perp_market.amm.max_spread,
    )?;

    perp_market.margin_ratio_initial = margin_ratio_initial;
    perp_market.margin_ratio_maintenance = margin_ratio_maintenance;
    Ok(())
}

#[access_control(
    perp_market_valid(&ctx.accounts.perp_market)
)]
pub fn handle_update_perp_market_max_imbalances(
    ctx: Context<AdminUpdatePerpMarket>,
    unrealized_max_imbalance: u64,
    max_revenue_withdraw_per_period: u64,
    quote_max_insurance: u64,
) -> Result<()> {
    let perp_market = &mut load_mut!(ctx.accounts.perp_market)?;

    let max_insurance_for_tier = match perp_market.contract_tier {
        ContractTier::A => INSURANCE_A_MAX,
        ContractTier::B => INSURANCE_B_MAX,
        ContractTier::C => INSURANCE_C_MAX,
        ContractTier::Speculative => INSURANCE_SPECULATIVE_MAX,
        ContractTier::Isolated => INSURANCE_SPECULATIVE_MAX,
    };

    validate!(
        max_revenue_withdraw_per_period
            <= max_insurance_for_tier.max(FEE_POOL_TO_REVENUE_POOL_THRESHOLD.cast()?)
            && unrealized_max_imbalance <= max_insurance_for_tier + 1
            && quote_max_insurance <= max_insurance_for_tier,
        ErrorCode::DefaultError,
        "all maxs must be less than max_insurance for ContractTier ={}",
        max_insurance_for_tier
    )?;

    validate!(
        perp_market.insurance_claim.quote_settled_insurance <= quote_max_insurance,
        ErrorCode::DefaultError,
        "quote_max_insurance must be above market.insurance_claim.quote_settled_insurance={}",
        perp_market.insurance_claim.quote_settled_insurance
    )?;

    msg!(
        "market.max_revenue_withdraw_per_period: {:?} -> {:?}",
        perp_market.insurance_claim.max_revenue_withdraw_per_period,
        max_revenue_withdraw_per_period
    );

    msg!(
        "market.unrealized_max_imbalance: {:?} -> {:?}",
        perp_market.unrealized_pnl_max_imbalance,
        unrealized_max_imbalance
    );

    msg!(
        "market.quote_max_insurance: {:?} -> {:?}",
        perp_market.insurance_claim.quote_max_insurance,
        quote_max_insurance
    );

    perp_market.insurance_claim.max_revenue_withdraw_per_period = max_revenue_withdraw_per_period;
    perp_market.unrealized_pnl_max_imbalance = unrealized_max_imbalance;
    perp_market.insurance_claim.quote_max_insurance = quote_max_insurance;

    // ensure altered max_revenue_withdraw_per_period doesn't break invariant check
    crate::validation::perp_market::validate_perp_market(perp_market)?;

    Ok(())
}

#[access_control(
    perp_market_valid(&ctx.accounts.perp_market)
)]
pub fn handle_update_perp_market_name(
    ctx: Context<AdminUpdatePerpMarket>,
    name: [u8; 32],
) -> Result<()> {
    let mut perp_market = load_mut!(ctx.accounts.perp_market)?;
    perp_market.name = name;
    Ok(())
}

#[access_control(
    spot_market_valid(&ctx.accounts.spot_market)
)]
pub fn handle_update_spot_market_name(
    ctx: Context<AdminUpdateSpotMarket>,
    name: [u8; 32],
) -> Result<()> {
    let mut spot_market = load_mut!(ctx.accounts.spot_market)?;
    spot_market.name = name;
    Ok(())
}

#[access_control(
    perp_market_valid(&ctx.accounts.perp_market)
)]
pub fn handle_update_perp_liquidation_fee(
    ctx: Context<AdminUpdatePerpMarket>,
    liquidator_fee: u32,
    if_liquidation_fee: u32,
) -> Result<()> {
    let perp_market = &mut load_mut!(ctx.accounts.perp_market)?;
    validate!(
        liquidator_fee < LIQUIDATION_FEE_PRECISION,
        ErrorCode::DefaultError,
        "Liquidation fee must be less than 100%"
    )?;

    validate!(
        if_liquidation_fee < LIQUIDATION_FEE_PRECISION,
        ErrorCode::DefaultError,
        "If liquidation fee must be less than 100%"
    )?;

    validate_margin(
        perp_market.margin_ratio_initial,
        perp_market.margin_ratio_maintenance,
        liquidator_fee,
        perp_market.amm.max_spread,
    )?;

    perp_market.liquidator_fee = liquidator_fee;
    perp_market.if_liquidation_fee = if_liquidation_fee;
    Ok(())
}

#[access_control(
    spot_market_valid(&ctx.accounts.spot_market)
)]
pub fn handle_update_insurance_fund_unstaking_period(
    ctx: Context<AdminUpdateSpotMarket>,
    insurance_fund_unstaking_period: i64,
) -> Result<()> {
    let spot_market = &mut load_mut!(ctx.accounts.spot_market)?;
    spot_market.insurance_fund.unstaking_period = insurance_fund_unstaking_period;
    Ok(())
}

#[access_control(
    spot_market_valid(&ctx.accounts.spot_market)
)]
pub fn handle_update_spot_market_liquidation_fee(
    ctx: Context<AdminUpdateSpotMarket>,
    liquidator_fee: u32,
    if_liquidation_fee: u32,
) -> Result<()> {
    let spot_market = &mut load_mut!(ctx.accounts.spot_market)?;
    validate!(
        liquidator_fee < LIQUIDATION_FEE_PRECISION,
        ErrorCode::DefaultError,
        "Liquidation fee must be less than 100%"
    )?;

    validate!(
        if_liquidation_fee <= LIQUIDATION_FEE_PRECISION / 20,
        ErrorCode::DefaultError,
        "if_liquidation_fee must be <= 5%"
    )?;

    spot_market.liquidator_fee = liquidator_fee;
    spot_market.if_liquidation_fee = if_liquidation_fee;
    Ok(())
}

#[access_control(
    spot_market_valid(&ctx.accounts.spot_market)
)]
pub fn handle_update_withdraw_guard_threshold(
    ctx: Context<AdminUpdateSpotMarket>,
    withdraw_guard_threshold: u64,
) -> Result<()> {
    let spot_market = &mut load_mut!(ctx.accounts.spot_market)?;
    msg!(
        "spot_market.withdraw_guard_threshold: {:?} -> {:?}",
        spot_market.withdraw_guard_threshold,
        withdraw_guard_threshold
    );
    spot_market.withdraw_guard_threshold = withdraw_guard_threshold;
    Ok(())
}

#[access_control(
    spot_market_valid(&ctx.accounts.spot_market)
)]
pub fn handle_update_spot_market_if_factor(
    ctx: Context<AdminUpdateSpotMarket>,
    spot_market_index: u16,
    user_if_factor: u32,
    total_if_factor: u32,
) -> Result<()> {
    let spot_market = &mut load_mut!(ctx.accounts.spot_market)?;

    validate!(
        spot_market.market_index == spot_market_index,
        ErrorCode::DefaultError,
        "spot_market_index dne spot_market.index"
    )?;

    validate!(
        user_if_factor <= total_if_factor,
        ErrorCode::DefaultError,
        "user_if_factor must be <= total_if_factor"
    )?;

    validate!(
        total_if_factor <= IF_FACTOR_PRECISION.cast()?,
        ErrorCode::DefaultError,
        "total_if_factor must be <= 100%"
    )?;

    msg!(
        "spot_market.user_if_factor: {:?} -> {:?}",
        spot_market.insurance_fund.user_factor,
        user_if_factor
    );
    msg!(
        "spot_market.total_if_factor: {:?} -> {:?}",
        spot_market.insurance_fund.total_factor,
        total_if_factor
    );

    spot_market.insurance_fund.user_factor = user_if_factor;
    spot_market.insurance_fund.total_factor = total_if_factor;

    Ok(())
}

#[access_control(
    spot_market_valid(&ctx.accounts.spot_market)
)]
pub fn handle_update_spot_market_revenue_settle_period(
    ctx: Context<AdminUpdateSpotMarket>,
    revenue_settle_period: i64,
) -> Result<()> {
    let spot_market = &mut load_mut!(ctx.accounts.spot_market)?;
    validate!(revenue_settle_period > 0, ErrorCode::DefaultError)?;
    msg!(
        "spot_market.revenue_settle_period: {:?} -> {:?}",
        spot_market.insurance_fund.revenue_settle_period,
        revenue_settle_period
    );
    spot_market.insurance_fund.revenue_settle_period = revenue_settle_period;
    Ok(())
}

#[access_control(
    spot_market_valid(&ctx.accounts.spot_market)
)]
pub fn handle_update_spot_market_status(
    ctx: Context<AdminUpdateSpotMarket>,
    status: MarketStatus,
) -> Result<()> {
    status.validate_not_deprecated()?;
    let spot_market = &mut load_mut!(ctx.accounts.spot_market)?;
    spot_market.status = status;
    Ok(())
}

#[access_control(
spot_market_valid(&ctx.accounts.spot_market)
)]
pub fn handle_update_spot_market_paused_operations(
    ctx: Context<AdminUpdateSpotMarket>,
    paused_operations: u8,
) -> Result<()> {
    let spot_market = &mut load_mut!(ctx.accounts.spot_market)?;
    spot_market.paused_operations = paused_operations;

    SpotOperation::log_all_operations_paused(spot_market.paused_operations);

    Ok(())
}

#[access_control(
    spot_market_valid(&ctx.accounts.spot_market)
)]
pub fn handle_update_spot_market_asset_tier(
    ctx: Context<AdminUpdateSpotMarket>,
    asset_tier: AssetTier,
) -> Result<()> {
    let spot_market = &mut load_mut!(ctx.accounts.spot_market)?;

    if spot_market.initial_asset_weight > 0 {
        validate!(
            matches!(asset_tier, AssetTier::Collateral | AssetTier::Protected),
            ErrorCode::DefaultError,
            "initial_asset_weight > 0 so AssetTier must be collateral or protected"
        )?;
    }

    spot_market.asset_tier = asset_tier;
    Ok(())
}

#[access_control(
    spot_market_valid(&ctx.accounts.spot_market)
)]
pub fn handle_update_spot_market_margin_weights(
    ctx: Context<AdminUpdateSpotMarket>,
    initial_asset_weight: u32,
    maintenance_asset_weight: u32,
    initial_liability_weight: u32,
    maintenance_liability_weight: u32,
    imf_factor: u32,
) -> Result<()> {
    let spot_market = &mut load_mut!(ctx.accounts.spot_market)?;

    validate_margin_weights(
        spot_market.market_index,
        initial_asset_weight,
        maintenance_asset_weight,
        initial_liability_weight,
        maintenance_liability_weight,
        imf_factor,
    )?;

    spot_market.initial_asset_weight = initial_asset_weight;
    spot_market.maintenance_asset_weight = maintenance_asset_weight;
    spot_market.initial_liability_weight = initial_liability_weight;
    spot_market.maintenance_liability_weight = maintenance_liability_weight;
    spot_market.imf_factor = imf_factor;

    Ok(())
}

#[access_control(
    spot_market_valid(&ctx.accounts.spot_market)
)]
pub fn handle_update_spot_market_borrow_rate(
    ctx: Context<AdminUpdateSpotMarket>,
    optimal_utilization: u32,
    optimal_borrow_rate: u32,
    max_borrow_rate: u32,
) -> Result<()> {
    let spot_market = &mut load_mut!(ctx.accounts.spot_market)?;
    validate_borrow_rate(optimal_utilization, optimal_borrow_rate, max_borrow_rate)?;
    spot_market.optimal_utilization = optimal_utilization;
    spot_market.optimal_borrow_rate = optimal_borrow_rate;
    spot_market.max_borrow_rate = max_borrow_rate;
    Ok(())
}

#[access_control(
    spot_market_valid(&ctx.accounts.spot_market)
)]
pub fn handle_update_spot_market_max_token_deposits(
    ctx: Context<AdminUpdateSpotMarket>,
    max_token_deposits: u64,
) -> Result<()> {
    let spot_market = &mut load_mut!(ctx.accounts.spot_market)?;
    spot_market.max_token_deposits = max_token_deposits;
    Ok(())
}

#[access_control(
spot_market_valid(&ctx.accounts.spot_market)
)]
pub fn handle_update_spot_market_scale_initial_asset_weight_start(
    ctx: Context<AdminUpdateSpotMarket>,
    scale_initial_asset_weight_start: u64,
) -> Result<()> {
    let spot_market = &mut load_mut!(ctx.accounts.spot_market)?;
    spot_market.scale_initial_asset_weight_start = scale_initial_asset_weight_start;
    Ok(())
}

#[access_control(
    spot_market_valid(&ctx.accounts.spot_market)
)]
pub fn handle_update_spot_market_orders_enabled(
    ctx: Context<AdminUpdateSpotMarket>,
    orders_enabled: bool,
) -> Result<()> {
    let spot_market = &mut load_mut!(ctx.accounts.spot_market)?;
    spot_market.orders_enabled = orders_enabled;
    Ok(())
}

#[access_control(
    perp_market_valid(&ctx.accounts.perp_market)
)]
pub fn handle_update_perp_market_status(
    ctx: Context<AdminUpdatePerpMarket>,
    status: MarketStatus,
) -> Result<()> {
    validate!(
        !matches!(status, MarketStatus::Delisted | MarketStatus::Settlement),
        ErrorCode::DefaultError,
        "must set settlement/delist through another instruction",
    )?;

    status.validate_not_deprecated()?;

    let perp_market = &mut load_mut!(ctx.accounts.perp_market)?;
    perp_market.status = status;
    Ok(())
}

#[access_control(
    perp_market_valid(&ctx.accounts.perp_market)
)]
pub fn handle_update_perp_market_paused_operations(
    ctx: Context<AdminUpdatePerpMarket>,
    paused_operations: u8,
) -> Result<()> {
    let perp_market = &mut load_mut!(ctx.accounts.perp_market)?;
    perp_market.paused_operations = paused_operations;

    PerpOperation::log_all_operations_paused(perp_market.paused_operations);

    Ok(())
}

#[access_control(
    perp_market_valid(&ctx.accounts.perp_market)
)]
pub fn handle_update_perp_market_contract_tier(
    ctx: Context<AdminUpdatePerpMarket>,
    contract_tier: ContractTier,
) -> Result<()> {
    let perp_market = &mut load_mut!(ctx.accounts.perp_market)?;
    perp_market.contract_tier = contract_tier;
    Ok(())
}

#[access_control(
    perp_market_valid(&ctx.accounts.perp_market)
)]
pub fn handle_update_perp_market_imf_factor(
    ctx: Context<AdminUpdatePerpMarket>,
    imf_factor: u32,
    unrealized_pnl_imf_factor: u32,
) -> Result<()> {
    validate!(
        imf_factor <= SPOT_IMF_PRECISION,
        ErrorCode::DefaultError,
        "invalid imf factor",
    )?;
    validate!(
        unrealized_pnl_imf_factor <= SPOT_IMF_PRECISION,
        ErrorCode::DefaultError,
        "invalid unrealized pnl imf factor",
    )?;
    let perp_market = &mut load_mut!(ctx.accounts.perp_market)?;
    perp_market.imf_factor = imf_factor;
    perp_market.unrealized_pnl_imf_factor = unrealized_pnl_imf_factor;
    Ok(())
}

#[access_control(
    perp_market_valid(&ctx.accounts.perp_market)
)]
pub fn handle_update_perp_market_unrealized_asset_weight(
    ctx: Context<AdminUpdatePerpMarket>,
    unrealized_initial_asset_weight: u32,
    unrealized_maintenance_asset_weight: u32,
) -> Result<()> {
    validate!(
        unrealized_initial_asset_weight <= SPOT_WEIGHT_PRECISION.cast()?,
        ErrorCode::DefaultError,
        "invalid unrealized_initial_asset_weight",
    )?;
    validate!(
        unrealized_maintenance_asset_weight <= SPOT_WEIGHT_PRECISION.cast()?,
        ErrorCode::DefaultError,
        "invalid unrealized_maintenance_asset_weight",
    )?;
    validate!(
        unrealized_initial_asset_weight <= unrealized_maintenance_asset_weight,
        ErrorCode::DefaultError,
        "must enforce unrealized_initial_asset_weight <= unrealized_maintenance_asset_weight",
    )?;
    let perp_market = &mut load_mut!(ctx.accounts.perp_market)?;
    perp_market.unrealized_pnl_initial_asset_weight = unrealized_initial_asset_weight;
    perp_market.unrealized_pnl_maintenance_asset_weight = unrealized_maintenance_asset_weight;
    Ok(())
}

#[access_control(
    perp_market_valid(&ctx.accounts.perp_market)
)]
pub fn handle_update_perp_market_concentration_coef(
    ctx: Context<AdminUpdatePerpMarket>,
    concentration_scale: u128,
) -> Result<()> {
    validate!(
        concentration_scale > 0,
        ErrorCode::DefaultError,
        "invalid concentration_scale",
    )?;

    let perp_market = &mut load_mut!(ctx.accounts.perp_market)?;
    let prev_concentration_coef = perp_market.amm.concentration_coef;
    controller::amm::update_concentration_coef(&mut perp_market.amm, concentration_scale)?;
    let new_concentration_coef = perp_market.amm.concentration_coef;

    msg!(
        "perp_market.amm.concentration_coef: {} -> {}",
        prev_concentration_coef,
        new_concentration_coef
    );

    Ok(())
}

#[access_control(
    perp_market_valid(&ctx.accounts.perp_market)
)]
pub fn handle_update_perp_market_curve_update_intensity(
    ctx: Context<AdminUpdatePerpMarket>,
    curve_update_intensity: u8,
) -> Result<()> {
    // (0, 100] is for repeg / formulaic k intensity
    // (100, 200] is for reference price offset intensity
    validate!(
        curve_update_intensity <= 200,
        ErrorCode::DefaultError,
        "invalid curve_update_intensity",
    )?;
    let perp_market = &mut load_mut!(ctx.accounts.perp_market)?;
    perp_market.amm.curve_update_intensity = curve_update_intensity;
    Ok(())
}

#[access_control(
    perp_market_valid(&ctx.accounts.perp_market)
)]
pub fn handle_update_perp_market_target_base_asset_amount_per_lp(
    ctx: Context<AdminUpdatePerpMarket>,
    target_base_asset_amount_per_lp: i32,
) -> Result<()> {
    let perp_market = &mut load_mut!(ctx.accounts.perp_market)?;
    perp_market.amm.target_base_asset_amount_per_lp = target_base_asset_amount_per_lp;
    Ok(())
}

pub fn handle_update_perp_market_per_lp_base(
    ctx: Context<AdminUpdatePerpMarket>,
    per_lp_base: i8,
) -> Result<()> {
    let perp_market = &mut load_mut!(ctx.accounts.perp_market)?;

    let old_per_lp_base = perp_market.amm.per_lp_base;
    msg!(
        "updated perp_market per_lp_base {} -> {}",
        old_per_lp_base,
        per_lp_base
    );

    let expo_diff = per_lp_base.safe_sub(old_per_lp_base)?;

    validate!(
        expo_diff.abs() == 1,
        ErrorCode::DefaultError,
        "invalid expo update (must be 1)",
    )?;

    validate!(
        per_lp_base.abs() <= 9,
        ErrorCode::DefaultError,
        "only consider lp_base within range of AMM_RESERVE_PRECISION",
    )?;

    controller::lp::apply_lp_rebase_to_perp_market(perp_market, expo_diff)?;

    Ok(())
}

pub fn handle_update_lp_cooldown_time(
    ctx: Context<AdminUpdateState>,
    lp_cooldown_time: u64,
) -> Result<()> {
    ctx.accounts.state.lp_cooldown_time = lp_cooldown_time;
    Ok(())
}

pub fn handle_update_perp_fee_structure(
    ctx: Context<AdminUpdateState>,
    fee_structure: FeeStructure,
) -> Result<()> {
    validate_fee_structure(&fee_structure)?;

    ctx.accounts.state.perp_fee_structure = fee_structure;
    Ok(())
}

pub fn handle_update_spot_fee_structure(
    ctx: Context<AdminUpdateState>,
    fee_structure: FeeStructure,
) -> Result<()> {
    validate_fee_structure(&fee_structure)?;
    ctx.accounts.state.spot_fee_structure = fee_structure;
    Ok(())
}

pub fn handle_update_initial_pct_to_liquidate(
    ctx: Context<AdminUpdateState>,
    initial_pct_to_liquidate: u16,
) -> Result<()> {
    ctx.accounts.state.initial_pct_to_liquidate = initial_pct_to_liquidate;
    Ok(())
}

pub fn handle_update_liquidation_duration(
    ctx: Context<AdminUpdateState>,
    liquidation_duration: u8,
) -> Result<()> {
    ctx.accounts.state.liquidation_duration = liquidation_duration;
    Ok(())
}

pub fn handle_update_liquidation_margin_buffer_ratio(
    ctx: Context<AdminUpdateState>,
    liquidation_margin_buffer_ratio: u32,
) -> Result<()> {
    ctx.accounts.state.liquidation_margin_buffer_ratio = liquidation_margin_buffer_ratio;
    Ok(())
}

pub fn handle_update_oracle_guard_rails(
    ctx: Context<AdminUpdateState>,
    oracle_guard_rails: OracleGuardRails,
) -> Result<()> {
    ctx.accounts.state.oracle_guard_rails = oracle_guard_rails;
    Ok(())
}

pub fn handle_update_state_settlement_duration(
    ctx: Context<AdminUpdateState>,
    settlement_duration: u16,
) -> Result<()> {
    ctx.accounts.state.settlement_duration = settlement_duration;
    Ok(())
}

pub fn handle_update_state_max_number_of_sub_accounts(
    ctx: Context<AdminUpdateState>,
    max_number_of_sub_accounts: u16,
) -> Result<()> {
    ctx.accounts.state.max_number_of_sub_accounts = max_number_of_sub_accounts;
    Ok(())
}

pub fn handle_update_state_max_initialize_user_fee(
    ctx: Context<AdminUpdateState>,
    max_initialize_user_fee: u16,
) -> Result<()> {
    ctx.accounts.state.max_initialize_user_fee = max_initialize_user_fee;
    Ok(())
}

#[access_control(
    perp_market_valid(&ctx.accounts.perp_market)
)]
pub fn handle_update_perp_market_oracle(
    ctx: Context<RepegCurve>,
    oracle: Pubkey,
    oracle_source: OracleSource,
) -> Result<()> {
    let perp_market = &mut load_mut!(ctx.accounts.perp_market)?;
    let clock = Clock::get()?;

    // Verify oracle is readable
    let OraclePriceData {
        price: _oracle_price,
        delay: _oracle_delay,
        ..
    } = get_oracle_price(&oracle_source, &ctx.accounts.oracle, clock.slot)?;

    perp_market.amm.oracle = oracle;
    perp_market.amm.oracle_source = oracle_source;

    Ok(())
}

#[access_control(
    perp_market_valid(&ctx.accounts.perp_market)
)]
pub fn handle_update_perp_market_base_spread(
    ctx: Context<AdminUpdatePerpMarket>,
    base_spread: u32,
) -> Result<()> {
    let perp_market = &mut load_mut!(ctx.accounts.perp_market)?;
    perp_market.amm.base_spread = base_spread;
    perp_market.amm.long_spread = base_spread / 2;
    perp_market.amm.short_spread = base_spread / 2;
    Ok(())
}

#[access_control(
    perp_market_valid(&ctx.accounts.perp_market)
)]
pub fn handle_update_amm_jit_intensity(
    ctx: Context<AdminUpdatePerpMarket>,
    amm_jit_intensity: u8,
) -> Result<()> {
    validate!(
        (0..=200).contains(&amm_jit_intensity),
        ErrorCode::DefaultError,
        "invalid amm_jit_intensity",
    )?;

    let perp_market = &mut load_mut!(ctx.accounts.perp_market)?;
    perp_market.amm.amm_jit_intensity = amm_jit_intensity;

    Ok(())
}

#[access_control(
    perp_market_valid(&ctx.accounts.perp_market)
)]
pub fn handle_update_perp_market_max_spread(
    ctx: Context<AdminUpdatePerpMarket>,
    max_spread: u32,
) -> Result<()> {
    let perp_market = &mut load_mut!(ctx.accounts.perp_market)?;
    validate!(
        max_spread >= perp_market.amm.base_spread,
        ErrorCode::DefaultError,
        "invalid max_spread < base_spread",
    )?;

    validate!(
        max_spread <= perp_market.margin_ratio_initial * 100,
        ErrorCode::DefaultError,
        "invalid max_spread > market.margin_ratio_initial * 100",
    )?;

    perp_market.amm.max_spread = max_spread;

    Ok(())
}

#[access_control(
    perp_market_valid(&ctx.accounts.perp_market)
)]
pub fn handle_update_perp_market_step_size_and_tick_size(
    ctx: Context<AdminUpdatePerpMarket>,
    step_size: u64,
    tick_size: u64,
) -> Result<()> {
    let perp_market = &mut load_mut!(ctx.accounts.perp_market)?;
    validate!(step_size > 0 && tick_size > 0, ErrorCode::DefaultError)?;
    validate!(step_size <= 2000000000, ErrorCode::DefaultError)?; // below i32 max for lp's remainder_base_asset

    perp_market.amm.order_step_size = step_size;
    perp_market.amm.order_tick_size = tick_size;
    Ok(())
}

#[access_control(
    perp_market_valid(&ctx.accounts.perp_market)
)]
pub fn handle_update_perp_market_min_order_size(
    ctx: Context<AdminUpdatePerpMarket>,
    order_size: u64,
) -> Result<()> {
    let perp_market = &mut load_mut!(ctx.accounts.perp_market)?;
    validate!(order_size > 0, ErrorCode::DefaultError)?;
    perp_market.amm.min_order_size = order_size;
    Ok(())
}

#[access_control(
    spot_market_valid(&ctx.accounts.spot_market)
)]
pub fn handle_update_spot_market_step_size_and_tick_size(
    ctx: Context<AdminUpdateSpotMarket>,
    step_size: u64,
    tick_size: u64,
) -> Result<()> {
    let spot_market = &mut load_mut!(ctx.accounts.spot_market)?;
    validate!(
        spot_market.market_index == 0 || step_size > 0 && tick_size > 0,
        ErrorCode::DefaultError
    )?;
    spot_market.order_step_size = step_size;
    spot_market.order_tick_size = tick_size;
    Ok(())
}

#[access_control(
    spot_market_valid(&ctx.accounts.spot_market)
)]
pub fn handle_update_spot_market_min_order_size(
    ctx: Context<AdminUpdateSpotMarket>,
    order_size: u64,
) -> Result<()> {
    let spot_market = &mut load_mut!(ctx.accounts.spot_market)?;
    validate!(
        spot_market.market_index == 0 || order_size > 0,
        ErrorCode::DefaultError
    )?;
    spot_market.min_order_size = order_size;
    Ok(())
}

#[access_control(
    perp_market_valid(&ctx.accounts.perp_market)
)]
pub fn handle_update_perp_market_max_slippage_ratio(
    ctx: Context<AdminUpdatePerpMarket>,
    max_slippage_ratio: u16,
) -> Result<()> {
    validate!(max_slippage_ratio > 0, ErrorCode::DefaultError)?;
    let perp_market = &mut load_mut!(ctx.accounts.perp_market)?;
    perp_market.amm.max_slippage_ratio = max_slippage_ratio;
    Ok(())
}

#[access_control(
    perp_market_valid(&ctx.accounts.perp_market)
)]
pub fn handle_update_perp_market_max_fill_reserve_fraction(
    ctx: Context<AdminUpdatePerpMarket>,
    max_fill_reserve_fraction: u16,
) -> Result<()> {
    validate!(max_fill_reserve_fraction > 0, ErrorCode::DefaultError)?;
    let perp_market = &mut load_mut!(ctx.accounts.perp_market)?;
    perp_market.amm.max_fill_reserve_fraction = max_fill_reserve_fraction;
    Ok(())
}

#[access_control(
    perp_market_valid(&ctx.accounts.perp_market)
)]
pub fn handle_update_perp_market_max_open_interest(
    ctx: Context<AdminUpdatePerpMarket>,
    max_open_interest: u128,
) -> Result<()> {
    let perp_market = &mut load_mut!(ctx.accounts.perp_market)?;

    validate!(
        is_multiple_of_step_size(
            max_open_interest.cast::<u64>()?,
            perp_market.amm.order_step_size
        )?,
        ErrorCode::DefaultError,
        "max oi not a multiple of the step size"
    )?;

    perp_market.amm.max_open_interest = max_open_interest;
    Ok(())
}

#[access_control(
    perp_market_valid(&ctx.accounts.perp_market)
)]
pub fn handle_update_perp_market_fee_adjustment(
    ctx: Context<AdminUpdatePerpMarket>,
    fee_adjustment: i16,
) -> Result<()> {
    let perp_market = &mut load_mut!(ctx.accounts.perp_market)?;

    validate!(
        fee_adjustment.unsigned_abs().cast::<u64>()? <= FEE_ADJUSTMENT_MAX,
        ErrorCode::DefaultError,
        "fee adjustment {} greater than max {}",
        fee_adjustment,
        FEE_ADJUSTMENT_MAX
    )?;

    perp_market.fee_adjustment = fee_adjustment;
    Ok(())
}

pub fn handle_update_admin(ctx: Context<AdminUpdateState>, admin: Pubkey) -> Result<()> {
    ctx.accounts.state.admin = admin;
    Ok(())
}

pub fn handle_update_whitelist_mint(
    ctx: Context<AdminUpdateState>,
    whitelist_mint: Pubkey,
) -> Result<()> {
    ctx.accounts.state.whitelist_mint = whitelist_mint;
    Ok(())
}

pub fn handle_update_discount_mint(
    ctx: Context<AdminUpdateState>,
    discount_mint: Pubkey,
) -> Result<()> {
    ctx.accounts.state.discount_mint = discount_mint;
    Ok(())
}

pub fn handle_update_exchange_status(
    ctx: Context<AdminUpdateState>,
    exchange_status: u8,
) -> Result<()> {
    ctx.accounts.state.exchange_status = exchange_status;
    Ok(())
}

pub fn handle_update_perp_auction_duration(
    ctx: Context<AdminUpdateState>,
    min_perp_auction_duration: u8,
) -> Result<()> {
    ctx.accounts.state.min_perp_auction_duration = min_perp_auction_duration;
    Ok(())
}

pub fn handle_update_spot_auction_duration(
    ctx: Context<AdminUpdateState>,
    default_spot_auction_duration: u8,
) -> Result<()> {
    ctx.accounts.state.default_spot_auction_duration = default_spot_auction_duration;
    Ok(())
}

pub fn handle_admin_remove_insurance_fund_stake(
    ctx: Context<AdminRemoveInsuranceFundStake>,
    market_index: u16,
    amount: u64,
) -> Result<()> {
    let clock = Clock::get()?;
    let now = clock.unix_timestamp;
    let spot_market = &mut load_mut!(ctx.accounts.spot_market)?;
    let state = &ctx.accounts.state;

    validate!(
        market_index == spot_market.market_index,
        ErrorCode::DefaultError,
        "market_index doesnt match spot_market"
    )?;

    let n_shares = math::insurance::vault_amount_to_if_shares(
        amount,
        spot_market.insurance_fund.total_shares,
        ctx.accounts.insurance_fund_vault.amount,
    )?;

    let withdrawn_amount = controller::insurance::admin_remove_insurance_fund_stake(
        ctx.accounts.insurance_fund_vault.amount,
        n_shares,
        spot_market,
        now,
        *ctx.accounts.admin.key,
    )?;

    controller::token::send_from_program_vault(
        &ctx.accounts.token_program,
        &ctx.accounts.insurance_fund_vault,
        &ctx.accounts.admin_token_account,
        &ctx.accounts.drift_signer,
        state.signer_nonce,
        withdrawn_amount,
    )?;

    validate!(
        ctx.accounts.insurance_fund_vault.amount > 0,
        ErrorCode::DefaultError,
        "insurance_fund_vault.amount must remain > 0"
    )?;

    Ok(())
}

pub fn handle_admin_disable_update_perp_bid_ask_twap(
    ctx: Context<AdminDisableBidAskTwapUpdate>,
    disable: bool,
) -> Result<()> {
    let mut user_stats = load_mut!(ctx.accounts.user_stats)?;
    user_stats.disable_update_perp_bid_ask_twap = disable;
    Ok(())
}

pub fn handle_initialize_protocol_if_shares_transfer_config(
    ctx: Context<InitializeProtocolIfSharesTransferConfig>,
) -> Result<()> {
    let mut config = ctx
        .accounts
        .protocol_if_shares_transfer_config
        .load_init()?;

    let now = Clock::get()?.unix_timestamp;
    config.next_epoch_ts = now.safe_add(EPOCH_DURATION)?;

    Ok(())
}

pub fn handle_update_protocol_if_shares_transfer_config(
    ctx: Context<UpdateProtocolIfSharesTransferConfig>,
    whitelisted_signers: Option<[Pubkey; 4]>,
    max_transfer_per_epoch: Option<u128>,
) -> Result<()> {
    let mut config = ctx.accounts.protocol_if_shares_transfer_config.load_mut()?;

    if let Some(whitelisted_signers) = whitelisted_signers {
        config.whitelisted_signers = whitelisted_signers;
    }

    if let Some(max_transfer_per_epoch) = max_transfer_per_epoch {
        config.max_transfer_per_epoch = max_transfer_per_epoch;
    }
    Ok(())
}

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    #[account(
        init,
        seeds = [b"drift_state".as_ref()],
        space = State::SIZE,
        bump,
        payer = admin
    )]
    pub state: Box<Account<'info, State>>,
    pub quote_asset_mint: Box<Account<'info, Mint>>,
    /// CHECK: checked in `initialize`
    pub drift_signer: AccountInfo<'info>,
    pub rent: Sysvar<'info, Rent>,
    pub system_program: Program<'info, System>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct InitializeSpotMarket<'info> {
    #[account(
        init,
        seeds = [b"spot_market", state.number_of_spot_markets.to_le_bytes().as_ref()],
        space = SpotMarket::SIZE,
        bump,
        payer = admin
    )]
    pub spot_market: AccountLoader<'info, SpotMarket>,
    pub spot_market_mint: Box<Account<'info, Mint>>,
    #[account(
        init,
        seeds = [b"spot_market_vault".as_ref(), state.number_of_spot_markets.to_le_bytes().as_ref()],
        bump,
        payer = admin,
        token::mint = spot_market_mint,
        token::authority = drift_signer
    )]
    pub spot_market_vault: Box<Account<'info, TokenAccount>>,
    #[account(
        init,
        seeds = [b"insurance_fund_vault".as_ref(), state.number_of_spot_markets.to_le_bytes().as_ref()],
        bump,
        payer = admin,
        token::mint = spot_market_mint,
        token::authority = drift_signer
    )]
    pub insurance_fund_vault: Box<Account<'info, TokenAccount>>,
    #[account(
        constraint = state.signer.eq(&drift_signer.key())
    )]
    /// CHECK: program signer
    pub drift_signer: AccountInfo<'info>,
    #[account(
        mut,
        has_one = admin
    )]
    pub state: Box<Account<'info, State>>,
    /// CHECK: checked in `initialize_spot_market`
    pub oracle: AccountInfo<'info>,
    #[account(mut)]
    pub admin: Signer<'info>,
    pub rent: Sysvar<'info, Rent>,
    pub system_program: Program<'info, System>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
#[instruction(market_index: u16)]
pub struct InitializeSerumFulfillmentConfig<'info> {
    #[account(
        seeds = [b"spot_market", market_index.to_le_bytes().as_ref()],
        bump,
    )]
    pub base_spot_market: AccountLoader<'info, SpotMarket>,
    #[account(
        seeds = [b"spot_market", 0_u16.to_le_bytes().as_ref()],
        bump,
    )]
    pub quote_spot_market: AccountLoader<'info, SpotMarket>,
    #[account(
        mut,
        has_one = admin
    )]
    pub state: Box<Account<'info, State>>,
    /// CHECK: checked in ix
    pub serum_program: AccountInfo<'info>,
    /// CHECK: checked in ix
    pub serum_market: AccountInfo<'info>,
    #[account(
        mut,
        seeds = [b"serum_open_orders".as_ref(), serum_market.key.as_ref()],
        bump,
    )]
    /// CHECK: checked in ix
    pub serum_open_orders: AccountInfo<'info>,
    #[account(
        constraint = state.signer.eq(&drift_signer.key())
    )]
    /// CHECK: program signer
    pub drift_signer: AccountInfo<'info>,
    #[account(
        init,
        seeds = [b"serum_fulfillment_config".as_ref(), serum_market.key.as_ref()],
        space = SerumV3FulfillmentConfig::SIZE,
        bump,
        payer = admin,
    )]
    pub serum_fulfillment_config: AccountLoader<'info, SerumV3FulfillmentConfig>,
    #[account(mut)]
    pub admin: Signer<'info>,
    pub rent: Sysvar<'info, Rent>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct UpdateSerumFulfillmentConfig<'info> {
    #[account(
        has_one = admin
    )]
    pub state: Box<Account<'info, State>>,
    #[account(mut)]
    pub serum_fulfillment_config: AccountLoader<'info, SerumV3FulfillmentConfig>,
    #[account(mut)]
    pub admin: Signer<'info>,
}

#[derive(Accounts)]
#[instruction(market_index: u16)]
pub struct InitializePhoenixFulfillmentConfig<'info> {
    #[account(
        seeds = [b"spot_market", market_index.to_le_bytes().as_ref()],
        bump,
    )]
    pub base_spot_market: AccountLoader<'info, SpotMarket>,
    #[account(
        seeds = [b"spot_market", 0_u16.to_le_bytes().as_ref()],
        bump,
    )]
    pub quote_spot_market: AccountLoader<'info, SpotMarket>,
    #[account(
        mut,
        has_one = admin
    )]
    pub state: Box<Account<'info, State>>,
    /// CHECK: checked in ix
    pub phoenix_program: AccountInfo<'info>,
    /// CHECK: checked in ix
    pub phoenix_market: AccountInfo<'info>,
    #[account(
        constraint = state.signer.eq(&drift_signer.key())
    )]
    /// CHECK: program signer
    pub drift_signer: AccountInfo<'info>,
    #[account(
        init,
        seeds = [b"phoenix_fulfillment_config".as_ref(), phoenix_market.key.as_ref()],
        space = PhoenixV1FulfillmentConfig::SIZE,
        bump,
        payer = admin,
    )]
    pub phoenix_fulfillment_config: AccountLoader<'info, PhoenixV1FulfillmentConfig>,
    #[account(mut)]
    pub admin: Signer<'info>,
    pub rent: Sysvar<'info, Rent>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct UpdatePhoenixFulfillmentConfig<'info> {
    #[account(
        has_one = admin
    )]
    pub state: Box<Account<'info, State>>,
    #[account(mut)]
    pub phoenix_fulfillment_config: AccountLoader<'info, PhoenixV1FulfillmentConfig>,
    #[account(mut)]
    pub admin: Signer<'info>,
}

#[derive(Accounts)]
pub struct UpdateSerumVault<'info> {
    #[account(
        mut,
        has_one = admin
    )]
    pub state: Box<Account<'info, State>>,
    #[account(mut)]
    pub admin: Signer<'info>,
    pub srm_vault: Box<Account<'info, TokenAccount>>,
}

#[derive(Accounts)]
pub struct InitializePerpMarket<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    #[account(
        mut,
        has_one = admin
    )]
    pub state: Box<Account<'info, State>>,
    #[account(
        init,
        seeds = [b"perp_market", state.number_of_markets.to_le_bytes().as_ref()],
        space = PerpMarket::SIZE,
        bump,
        payer = admin
    )]
    pub perp_market: AccountLoader<'info, PerpMarket>,
    /// CHECK: checked in `initialize_perp_market`
    pub oracle: AccountInfo<'info>,
    pub rent: Sysvar<'info, Rent>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct DeleteInitializedPerpMarket<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    #[account(
        mut,
        has_one = admin
    )]
    pub state: Box<Account<'info, State>>,
    #[account(mut, close = admin)]
    pub perp_market: AccountLoader<'info, PerpMarket>,
}

#[derive(Accounts)]
pub struct AdminUpdatePerpMarket<'info> {
    pub admin: Signer<'info>,
    #[account(
    has_one = admin
    )]
    pub state: Box<Account<'info, State>>,
    #[account(mut)]
    pub perp_market: AccountLoader<'info, PerpMarket>,
}

#[derive(Accounts)]
pub struct SettleExpiredMarketPoolsToRevenuePool<'info> {
    #[account(
        has_one = admin
    )]
    pub state: Box<Account<'info, State>>,
    pub admin: Signer<'info>,
    #[account(
        seeds = [b"spot_market", 0_u16.to_le_bytes().as_ref()],
        bump,
        mut
    )]
    pub spot_market: AccountLoader<'info, SpotMarket>,
    #[account(mut)]
    pub perp_market: AccountLoader<'info, PerpMarket>,
}

#[derive(Accounts)]
pub struct DepositIntoMarketFeePool<'info> {
    #[account(
        mut,
        has_one = admin
    )]
    pub state: Box<Account<'info, State>>,
    #[account(mut)]
    pub perp_market: AccountLoader<'info, PerpMarket>,
    pub admin: Signer<'info>,
    #[account(
        mut,
        token::authority = admin
    )]
    pub source_vault: Box<Account<'info, TokenAccount>>,
    #[account(
        constraint = state.signer.eq(&drift_signer.key())
    )]
    /// CHECK: withdraw fails if this isn't vault owner
    pub drift_signer: AccountInfo<'info>,
    #[account(
        mut,
        seeds = [b"spot_market", 0_u16.to_le_bytes().as_ref()],
        bump,
    )]
    pub quote_spot_market: AccountLoader<'info, SpotMarket>,
    #[account(
        mut,
        seeds = [b"spot_market_vault".as_ref(), 0_u16.to_le_bytes().as_ref()],
        bump,
    )]
    pub spot_market_vault: Box<Account<'info, TokenAccount>>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct RepegCurve<'info> {
    #[account(
        has_one = admin
    )]
    pub state: Box<Account<'info, State>>,
    #[account(mut)]
    pub perp_market: AccountLoader<'info, PerpMarket>,
    /// CHECK: checked in `repeg_curve` ix constraint
    pub oracle: AccountInfo<'info>,
    pub admin: Signer<'info>,
}

#[derive(Accounts)]
pub struct AdminUpdateState<'info> {
    pub admin: Signer<'info>,
    #[account(
        mut,
        has_one = admin
    )]
    pub state: Box<Account<'info, State>>,
}

#[derive(Accounts)]
pub struct AdminUpdateK<'info> {
    pub admin: Signer<'info>,
    #[account(
        has_one = admin
    )]
    pub state: Box<Account<'info, State>>,
    #[account(mut)]
    pub perp_market: AccountLoader<'info, PerpMarket>,
    /// CHECK: checked in `admin_update_k` ix constraint
    pub oracle: AccountInfo<'info>,
}

#[derive(Accounts)]
pub struct AdminUpdateSpotMarket<'info> {
    pub admin: Signer<'info>,
    #[account(
        has_one = admin
    )]
    pub state: Box<Account<'info, State>>,
    #[account(mut)]
    pub spot_market: AccountLoader<'info, SpotMarket>,
}

#[derive(Accounts)]
pub struct AdminUpdateSpotMarketOracle<'info> {
    pub admin: Signer<'info>,
    #[account(
        has_one = admin
    )]
    pub state: Box<Account<'info, State>>,
    #[account(mut)]
    pub spot_market: AccountLoader<'info, SpotMarket>,
    /// CHECK: checked in `initialize_spot_market`
    pub oracle: AccountInfo<'info>,
}

#[derive(Accounts)]
#[instruction(market_index: u16,)]
pub struct AdminRemoveInsuranceFundStake<'info> {
    pub admin: Signer<'info>,
    #[account(
        has_one = admin
    )]
    pub state: Box<Account<'info, State>>,
    #[account(
        seeds = [b"spot_market", market_index.to_le_bytes().as_ref()],
        bump
    )]
    pub spot_market: AccountLoader<'info, SpotMarket>,
    #[account(
        mut,
        seeds = [b"insurance_fund_vault".as_ref(), market_index.to_le_bytes().as_ref()],
        bump,
    )]
    pub insurance_fund_vault: Box<Account<'info, TokenAccount>>,
    #[account(
        constraint = state.signer.eq(&drift_signer.key())
    )]
    /// CHECK: forced drift_signer
    pub drift_signer: AccountInfo<'info>,
    #[account(
        mut,
        token::mint = insurance_fund_vault.mint,
        token::authority = admin
    )]
    pub admin_token_account: Box<Account<'info, TokenAccount>>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct AdminDisableBidAskTwapUpdate<'info> {
    pub admin: Signer<'info>,
    #[account(
        has_one = admin
    )]
    pub state: Box<Account<'info, State>>,
    #[account(mut)]
    pub user_stats: AccountLoader<'info, UserStats>,
}

#[derive(Accounts)]
pub struct InitializeProtocolIfSharesTransferConfig<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    #[account(
        init,
        seeds = [b"if_shares_transfer_config".as_ref()],
        space = ProtocolIfSharesTransferConfig::SIZE,
        bump,
        payer = admin
    )]
    pub protocol_if_shares_transfer_config: AccountLoader<'info, ProtocolIfSharesTransferConfig>,
    #[account(
        has_one = admin
    )]
    pub state: Box<Account<'info, State>>,
    pub rent: Sysvar<'info, Rent>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct UpdateProtocolIfSharesTransferConfig<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    #[account(
        mut,
        seeds = [b"if_shares_transfer_config".as_ref()],
        bump,
    )]
    pub protocol_if_shares_transfer_config: AccountLoader<'info, ProtocolIfSharesTransferConfig>,
    #[account(
        has_one = admin
    )]
    pub state: Box<Account<'info, State>>,
}
