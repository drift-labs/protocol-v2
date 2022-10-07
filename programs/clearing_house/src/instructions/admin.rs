use std::convert::identity;
use std::mem::size_of;

use anchor_lang::prelude::*;
use anchor_spl::token::{Mint, Token, TokenAccount};
use bytemuck::cast_slice;
use serum_dex::state::ToAlignedBytes;
use solana_program::msg;

use crate::controller;
use crate::controller::validate::validate_market_account;
use crate::error::ErrorCode;
use crate::get_then_update_id;
use crate::instructions::constraints::*;
use crate::instructions::keeper::SpotFulfillmentType;
use crate::load;
use crate::load_mut;
use crate::math::amm::get_update_k_result;
use crate::math::casting::{cast, cast_to_i128, cast_to_u128, cast_to_u32};
use crate::math::constants::{
    DEFAULT_BASE_ASSET_AMOUNT_STEP_SIZE, DEFAULT_LIQUIDATION_MARGIN_BUFFER_RATIO,
    DEFAULT_QUOTE_ASSET_AMOUNT_TICK_SIZE, IF_FACTOR_PRECISION, INSURANCE_A_MAX, INSURANCE_B_MAX,
    INSURANCE_C_MAX, INSURANCE_SPECULATIVE_MAX, LIQUIDATION_FEE_PRECISION,
    MAX_CONCENTRATION_COEFFICIENT, MAX_UPDATE_K_PRICE_CHANGE, QUOTE_SPOT_MARKET_INDEX,
    SPOT_CUMULATIVE_INTEREST_PRECISION, SPOT_IMF_PRECISION, SPOT_UTILIZATION_PRECISION,
    SPOT_UTILIZATION_PRECISION_U32, SPOT_WEIGHT_PRECISION, TWENTY_FOUR_HOUR,
};
use crate::math::oracle::{is_oracle_valid_for_action, DriftAction};
use crate::math::repeg::get_total_fee_lower_bound;
use crate::math::spot_balance::get_token_amount;
use crate::math::{amm, bn, oracle};
use crate::math_error;
use crate::state::events::CurveRecord;
use crate::state::market::{
    ContractTier, ContractType, MarketStatus, PerpMarket, PoolBalance, AMM,
};
use crate::state::oracle::{
    get_oracle_price, get_pyth_price, get_switchboard_price, HistoricalIndexData,
    HistoricalOracleData, OraclePriceData, OracleSource,
};
use crate::state::serum::{load_open_orders, load_serum_market};
use crate::state::spot_market::{
    AssetTier, SerumV3FulfillmentConfig, SpotBalanceType, SpotFulfillmentStatus, SpotMarket,
};
use crate::state::state::{ExchangeStatus, FeeStructure, OracleGuardRails, State};
use crate::state::user::PerpPosition;
use crate::validate;
use crate::validation::fee_structure::validate_fee_structure;
use crate::validation::margin::{validate_margin, validate_margin_weights};
use crate::{checked_increment, math};

pub fn handle_initialize(ctx: Context<Initialize>) -> Result<()> {
    let (clearing_house_signer, clearing_house_signer_nonce) =
        Pubkey::find_program_address(&[b"clearing_house_signer".as_ref()], ctx.program_id);

    **ctx.accounts.state = State {
        admin: *ctx.accounts.admin.key,
        exchange_status: ExchangeStatus::Active,
        whitelist_mint: Pubkey::default(),
        discount_mint: Pubkey::default(),
        oracle_guard_rails: OracleGuardRails::default(),
        number_of_authorities: 0,
        number_of_markets: 0,
        number_of_spot_markets: 0,
        min_perp_auction_duration: 10,
        default_market_order_time_in_force: 60,
        default_spot_auction_duration: 10,
        liquidation_margin_buffer_ratio: DEFAULT_LIQUIDATION_MARGIN_BUFFER_RATIO,
        settlement_duration: 0, // extra duration after market expiry to allow settlement
        signer: clearing_house_signer,
        signer_nonce: clearing_house_signer_nonce,
        srm_vault: Pubkey::default(),
        perp_fee_structure: FeeStructure::perps_default(),
        spot_fee_structure: FeeStructure::spot_default(),
        padding: [0; 1],
    };

    Ok(())
}

pub fn handle_initialize_spot_market(
    ctx: Context<InitializeSpotMarket>,
    optimal_utilization: u32,
    optimal_borrow_rate: u32,
    max_borrow_rate: u32,
    oracle_source: OracleSource,
    initial_asset_weight: u128,
    maintenance_asset_weight: u128,
    initial_liability_weight: u128,
    maintenance_liability_weight: u128,
    imf_factor: u128,
    liquidation_fee: u128,
    active_status: bool,
) -> Result<()> {
    let state = &mut ctx.accounts.state;
    let spot_market_pubkey = ctx.accounts.spot_market.key();

    // clearing house must be authority of collateral vault
    if ctx.accounts.spot_market_vault.owner != state.signer {
        return Err(ErrorCode::InvalidSpotMarketAuthority.into());
    }

    // clearing house must be authority of collateral vault
    if ctx.accounts.insurance_fund_vault.owner != state.signer {
        return Err(ErrorCode::InvalidInsuranceFundAuthority.into());
    }

    validate!(
        optimal_utilization <= SPOT_UTILIZATION_PRECISION_U32,
        ErrorCode::InvalidSpotMarketInitialization,
        "For spot market, optimal_utilization must be < {}",
        SPOT_UTILIZATION_PRECISION
    )?;

    let spot_market_index = get_then_update_id!(state, number_of_spot_markets);

    let oracle_price_data = get_oracle_price(
        &oracle_source,
        &ctx.accounts.oracle,
        cast(Clock::get()?.unix_timestamp)?,
    );

    let (historical_oracle_data_default, historical_index_data_default) = if spot_market_index == 0
    {
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
            HistoricalIndexData::default_with_current_oracle(oracle_price_data?),
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
    let now = cast(clock.unix_timestamp).or(Err(ErrorCode::UnableToCastUnixTime))?;

    let decimals = ctx.accounts.spot_market_mint.decimals;
    let order_step_size = 10_u64.pow(2 + (decimals - 6) as u32); // 10 for usdc/btc, 10000 for sol

    **spot_market = SpotMarket {
        market_index: spot_market_index,
        pubkey: spot_market_pubkey,
        status: if active_status {
            MarketStatus::Active
        } else {
            MarketStatus::Initialized
        },
        asset_tier: AssetTier::Collateral,
        expiry_ts: 0,
        oracle: ctx.accounts.oracle.key(),
        oracle_source,
        historical_oracle_data: historical_oracle_data_default,
        historical_index_data: historical_index_data_default,
        mint: ctx.accounts.spot_market_mint.key(),
        vault: *ctx.accounts.spot_market_vault.to_account_info().key,
        insurance_fund_vault: *ctx.accounts.insurance_fund_vault.to_account_info().key,
        revenue_pool: PoolBalance {
            balance: 0,
            market_index: spot_market_index,
            ..PoolBalance::default()
        }, // in base asset
        total_if_factor: 0,
        user_if_factor: 0,
        total_if_shares: 0,
        user_if_shares: 0,
        if_shares_base: 0,
        insurance_withdraw_escrow_period: 0,
        last_revenue_settle_ts: 0,
        revenue_settle_period: 0, // how often can be settled
        decimals: ctx.accounts.spot_market_mint.decimals,
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
        last_interest_ts: now,
        last_twap_ts: now,
        initial_asset_weight,
        maintenance_asset_weight,
        initial_liability_weight,
        maintenance_liability_weight,
        imf_factor,
        liquidator_fee: liquidation_fee,
        if_liquidation_fee: LIQUIDATION_FEE_PRECISION / 100, // 1%
        withdraw_guard_threshold: 0,
        order_step_size,
        order_tick_size: DEFAULT_QUOTE_ASSET_AMOUNT_TICK_SIZE,
        min_order_size: order_step_size,
        max_position_size: 0,
        next_fill_record_id: 1,
        spot_fee_pool: PoolBalance::default(), // in quote asset
        total_spot_fee: 0,
        padding: [0; 6],
    };

    Ok(())
}

pub fn handle_initialize_serum_fulfillment_config(
    ctx: Context<InitializeSerumFulfillmentConfig>,
    market_index: u16,
) -> Result<()> {
    validate!(
        market_index != 0,
        ErrorCode::DefaultError,
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
    let market_state = load_serum_market(&ctx.accounts.serum_market, &serum_program_id)?;

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

    let serum_program_id = serum_program_id;
    let serum_market = serum_market_key;

    let market_state_event_queue = market_state.event_q;
    let serum_event_queue = Pubkey::new(cast_slice(&market_state_event_queue));

    let market_state_request_queue = market_state.req_q;
    let serum_request_queue = Pubkey::new(cast_slice(&market_state_request_queue));

    let market_state_bids = market_state.bids;
    let serum_bids = Pubkey::new(cast_slice(&market_state_bids));

    let market_state_asks = market_state.asks;
    let serum_asks = Pubkey::new(cast_slice(&market_state_asks));

    let market_state_coin_vault = market_state.coin_vault;
    let serum_base_vault = Pubkey::new(cast_slice(&market_state_coin_vault));

    let market_state_pc_vault = market_state.pc_vault;
    let serum_quote_vault = Pubkey::new(cast_slice(&market_state_pc_vault));
    let serum_signer_nonce = market_state.vault_signer_nonce;

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

    let open_orders = load_open_orders(&ctx.accounts.serum_open_orders)?;
    validate!(
        open_orders.account_flags == 0,
        ErrorCode::InvalidSerumOpenOrders,
        "Serum open orders already initialized"
    )?;
    drop(open_orders);

    controller::serum::invoke_init_open_orders(
        &ctx.accounts.serum_program,
        &ctx.accounts.serum_open_orders,
        &ctx.accounts.clearing_house_signer,
        &ctx.accounts.serum_market,
        &ctx.accounts.rent,
        ctx.accounts.state.signer_nonce,
    )?;

    let serum_fulfillment_config_key = ctx.accounts.serum_fulfillment_config.key();
    let mut serum_fulfillment_config = ctx.accounts.serum_fulfillment_config.load_init()?;
    *serum_fulfillment_config = SerumV3FulfillmentConfig {
        fulfillment_type: SpotFulfillmentType::SerumV3,
        status: SpotFulfillmentStatus::Enabled,
        pubkey: serum_fulfillment_config_key,
        market_index,
        serum_program_id,
        serum_market,
        serum_request_queue,
        serum_event_queue,
        serum_bids,
        serum_asks,
        serum_base_vault,
        serum_quote_vault,
        serum_open_orders: ctx.accounts.serum_open_orders.key(),
        serum_signer_nonce,
        padding: [0; 4],
    };

    Ok(())
}

pub fn handle_update_serum_vault(ctx: Context<UpdateSerumVault>) -> Result<()> {
    let vault = &ctx.accounts.srm_vault;
    validate!(
        vault.mint == crate::ids::srm_mint::id() || vault.mint == crate::ids::msrm_mint::id(),
        ErrorCode::DefaultError,
        "vault did not hav srm or msrm mint"
    )?;

    validate!(
        vault.owner == ctx.accounts.state.signer,
        ErrorCode::DefaultError,
        "vault owner was not program signer"
    )?;

    let state = &mut ctx.accounts.state;
    state.srm_vault = vault.key();

    Ok(())
}

pub fn handle_initialize_market(
    ctx: Context<InitializeMarket>,
    amm_base_asset_reserve: u128,
    amm_quote_asset_reserve: u128,
    amm_periodicity: i64,
    amm_peg_multiplier: u128,
    oracle_source: OracleSource,
    margin_ratio_initial: u32,
    margin_ratio_maintenance: u32,
    liquidation_fee: u128,
    active_status: bool,
) -> Result<()> {
    let market_pubkey = ctx.accounts.market.to_account_info().key;
    let market = &mut ctx.accounts.market.load_init()?;
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

    assert_eq!(amm_peg_multiplier, init_reserve_price);

    let concentration_coef = MAX_CONCENTRATION_COEFFICIENT;

    // Verify there's no overflow
    let _k = bn::U192::from(amm_base_asset_reserve)
        .checked_mul(bn::U192::from(amm_quote_asset_reserve))
        .ok_or_else(math_error!())?;

    let (min_base_asset_reserve, max_base_asset_reserve) =
        amm::calculate_bid_ask_bounds(concentration_coef, amm_base_asset_reserve)?;

    // Verify oracle is readable
    let OraclePriceData {
        price: oracle_price,
        delay: oracle_delay,
        ..
    } = match oracle_source {
        OracleSource::Pyth => get_pyth_price(&ctx.accounts.oracle, clock_slot).unwrap(),
        OracleSource::Switchboard => {
            get_switchboard_price(&ctx.accounts.oracle, clock_slot).unwrap()
        }
        OracleSource::QuoteAsset => panic!(),
    };

    let last_oracle_price_twap = match oracle_source {
        OracleSource::Pyth => market.amm.get_pyth_twap(&ctx.accounts.oracle)?,
        OracleSource::Switchboard => oracle_price,
        OracleSource::QuoteAsset => panic!(),
    };

    let max_spread = (margin_ratio_initial - margin_ratio_maintenance) * (100 - 5);

    // todo? should ensure peg within 1 cent of current oracle?
    // validate!(
    //     cast_to_i128(amm_peg_multiplier)?
    //         .checked_sub(oracle_price)
    //         .ok_or_else(math_error!())?
    //         .unsigned_abs()
    //         < PRICE_PRECISION / 100,
    //     ErrorCode::InvalidInitialPeg
    // )?;

    validate_margin(
        margin_ratio_initial,
        margin_ratio_maintenance,
        liquidation_fee,
        max_spread,
    )?;

    let state = &mut ctx.accounts.state;
    let market_index = state.number_of_markets;
    **market = PerpMarket {
        contract_type: ContractType::Perpetual,
        contract_tier: ContractTier::Speculative, // default
        status: if active_status {
            MarketStatus::Active
        } else {
            MarketStatus::Initialized
        },
        settlement_price: 0,
        expiry_ts: 0,
        pubkey: *market_pubkey,
        market_index,
        open_interest: 0,
        base_asset_amount_long: 0,
        base_asset_amount_short: 0,
        margin_ratio_initial, // unit is 20% (+2 decimal places)
        margin_ratio_maintenance,
        imf_factor: 0,
        next_fill_record_id: 1,
        next_funding_rate_record_id: 1,
        next_curve_record_id: 1,
        pnl_pool: PoolBalance::default(),
        revenue_withdraw_since_last_settle: 0,
        max_revenue_withdraw_per_period: 0,
        last_revenue_withdraw_ts: now,
        unrealized_initial_asset_weight: cast(SPOT_WEIGHT_PRECISION)?, // 100%
        unrealized_maintenance_asset_weight: cast(SPOT_WEIGHT_PRECISION)?, // 100%
        unrealized_imf_factor: 0,
        unrealized_max_imbalance: 0,
        liquidator_fee: liquidation_fee,
        if_liquidation_fee: LIQUIDATION_FEE_PRECISION / 100, // 1%
        quote_max_insurance: 0,
        quote_settled_insurance: 0,
        padding: [0; 3],
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
            cumulative_social_loss: 0,
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
            max_slippage_ratio: 50,           // ~2%
            max_base_asset_amount_ratio: 100, // moves price ~2%
            base_spread: 0,
            long_spread: 0,
            short_spread: 0,
            max_spread,
            last_bid_price_twap: init_reserve_price,
            last_ask_price_twap: init_reserve_price,
            net_base_asset_amount: 0,
            quote_asset_amount_long: 0,
            quote_asset_amount_short: 0,
            quote_entry_amount_long: 0,
            quote_entry_amount_short: 0,
            mark_std: 0,
            volume_24h: 0,
            long_intensity_count: 0,
            long_intensity_volume: 0,
            short_intensity_count: 0,
            short_intensity_volume: 0,
            last_trade_ts: now,
            curve_update_intensity: 0,
            fee_pool: PoolBalance::default(),
            market_position_per_lp: PerpPosition {
                market_index,
                ..PerpPosition::default()
            },
            market_position: PerpPosition {
                market_index,
                ..PerpPosition::default()
            },
            last_update_slot: clock_slot,

            // lp stuff
            net_unsettled_lp_base_asset_amount: 0,
            user_lp_shares: 0,
            lp_cooldown_time: 1,  // TODO: what should this be?
            amm_jit_intensity: 0, // turn it off at the start

            last_oracle_valid: false,

            padding: [0; 6],
        },
    };

    checked_increment!(state.number_of_markets, 1);

    Ok(())
}

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
    market_valid(&ctx.accounts.market)
)]
pub fn handle_update_market_expiry(ctx: Context<AdminUpdateMarket>, expiry_ts: i64) -> Result<()> {
    let clock = Clock::get()?;
    let market = &mut load_mut!(ctx.accounts.market)?;
    validate!(
        clock.unix_timestamp < expiry_ts,
        ErrorCode::DefaultError,
        "Market expiry ts must later than current clock timestamp"
    )?;

    // automatically enter reduce only
    market.status = MarketStatus::ReduceOnly;
    market.expiry_ts = expiry_ts;

    Ok(())
}

#[allow(unused_must_use)]
#[access_control(
    market_valid(&ctx.accounts.market)
)]
pub fn handle_move_amm_price(
    ctx: Context<AdminUpdateMarket>,
    base_asset_reserve: u128,
    quote_asset_reserve: u128,
    sqrt_k: u128,
) -> Result<()> {
    let market = &mut load_mut!(ctx.accounts.market)?;
    controller::amm::move_price(
        &mut market.amm,
        base_asset_reserve,
        quote_asset_reserve,
        sqrt_k,
    )?;
    validate_market_account(market)?;

    Ok(())
}

#[access_control(
    market_valid(&ctx.accounts.perp_market)
)]
pub fn handle_settle_expired_market_pools_to_revenue_pool(
    ctx: Context<SettleExpiredMarketPoolsToRevenuePool>,
) -> Result<()> {
    let market = &mut load_mut!(ctx.accounts.perp_market)?;
    let spot_market = &mut load_mut!(ctx.accounts.spot_market)?;

    let clock = Clock::get()?;
    let now = clock.unix_timestamp;

    controller::spot_balance::update_spot_market_cumulative_interest(spot_market, None, now)?;

    validate!(
        spot_market.market_index == QUOTE_SPOT_MARKET_INDEX,
        ErrorCode::DefaultError,
        "spot_market must be perp market's quote asset"
    )?;

    validate!(
        market.status == MarketStatus::Settlement,
        ErrorCode::DefaultError,
        "Market must in Settlement"
    )?;

    validate!(
        market.base_asset_amount_long == 0
            && market.base_asset_amount_short == 0
            && market.open_interest == 0,
        ErrorCode::DefaultError,
        "outstanding base_asset_amounts must be balanced"
    )?;

    validate!(
        math::amm::calculate_net_user_cost_basis(&market.amm)? == 0,
        ErrorCode::DefaultError,
        "outstanding quote_asset_amounts must be balanced"
    )?;

    validate!(
        now > market.expiry_ts + TWENTY_FOUR_HOUR,
        ErrorCode::DefaultError,
        "must be TWENTY_FOUR_HOUR after market.expiry_ts"
    )?;

    let depositors_amount_before: u64 = cast(get_token_amount(
        spot_market.deposit_balance,
        spot_market,
        &SpotBalanceType::Deposit,
    )?)?;

    let borrowers_amount_before: u64 = cast(get_token_amount(
        spot_market.borrow_balance,
        spot_market,
        &SpotBalanceType::Borrow,
    )?)?;

    let fee_pool_token_amount = get_token_amount(
        market.amm.fee_pool.balance,
        spot_market,
        &SpotBalanceType::Deposit,
    )?;
    let pnl_pool_token_amount = get_token_amount(
        market.pnl_pool.balance,
        spot_market,
        &SpotBalanceType::Deposit,
    )?;

    controller::spot_balance::update_spot_balances(
        fee_pool_token_amount,
        &SpotBalanceType::Borrow,
        spot_market,
        &mut market.amm.fee_pool,
        false,
    )?;

    controller::spot_balance::update_spot_balances(
        pnl_pool_token_amount,
        &SpotBalanceType::Borrow,
        spot_market,
        &mut market.pnl_pool,
        false,
    )?;

    controller::spot_balance::update_revenue_pool_balances(
        pnl_pool_token_amount
            .checked_add(fee_pool_token_amount)
            .ok_or_else(math_error!())?,
        &SpotBalanceType::Deposit,
        spot_market,
    )?;

    let depositors_amount_after: u64 = cast(get_token_amount(
        spot_market.deposit_balance,
        spot_market,
        &SpotBalanceType::Deposit,
    )?)?;

    let borrowers_amount_after: u64 = cast(get_token_amount(
        spot_market.borrow_balance,
        spot_market,
        &SpotBalanceType::Borrow,
    )?)?;

    validate!(
        borrowers_amount_before == borrowers_amount_after
            && depositors_amount_before == depositors_amount_after,
        ErrorCode::DefaultError,
        "Bank token balances must be equal before and after"
    )?;

    math::spot_balance::validate_spot_balances(spot_market)?;

    market.status = MarketStatus::Delisted;

    Ok(())
}

#[access_control(
    market_valid(&ctx.accounts.market)
)]
pub fn handle_deposit_into_market_fee_pool(
    ctx: Context<DepositIntoMarketFeePool>,
    amount: u64,
) -> Result<()> {
    let market = &mut load_mut!(ctx.accounts.market)?;

    market.amm.total_fee_minus_distributions = market
        .amm
        .total_fee_minus_distributions
        .checked_add(cast(amount)?)
        .ok_or_else(math_error!())?;

    let quote_spot_market = &mut load_mut!(ctx.accounts.quote_spot_market)?;

    controller::spot_balance::update_spot_balances(
        cast_to_u128(amount)?,
        &SpotBalanceType::Deposit,
        quote_spot_market,
        &mut market.amm.fee_pool,
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

#[allow(unused_must_use)]
#[access_control(
market_valid(&ctx.accounts.market) &&
valid_oracle_for_market(&ctx.accounts.oracle, &ctx.accounts.market)
)]
pub fn handle_repeg_amm_curve(ctx: Context<RepegCurve>, new_peg_candidate: u128) -> Result<()> {
    let clock = Clock::get()?;
    let now = clock.unix_timestamp;
    let clock_slot = clock.slot;

    let market = &mut load_mut!(ctx.accounts.market)?;
    let price_oracle = &ctx.accounts.oracle;
    let OraclePriceData {
        price: oracle_price,
        ..
    } = get_oracle_price(&market.amm.oracle_source, price_oracle, clock.slot)?;

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
    market_valid(&ctx.accounts.market) &&
    valid_oracle_for_market(&ctx.accounts.oracle, &ctx.accounts.market)
)]
pub fn handle_update_amm_oracle_twap(ctx: Context<RepegCurve>) -> Result<()> {
    // allow update to amm's oracle twap iff price gap is reduced and thus more tame funding
    // otherwise if oracle error or funding flip: set oracle twap to mark twap (0 gap)

    let clock = Clock::get()?;
    let now = clock.unix_timestamp;

    let market = &mut load_mut!(ctx.accounts.market)?;
    let price_oracle = &ctx.accounts.oracle;
    let oracle_twap = market.amm.get_oracle_twap(price_oracle)?;

    if let Some(oracle_twap) = oracle_twap {
        let oracle_mark_gap_before = cast_to_i128(market.amm.last_mark_price_twap)?
            .checked_sub(market.amm.historical_oracle_data.last_oracle_price_twap)
            .ok_or_else(math_error!())?;

        let oracle_mark_gap_after = cast_to_i128(market.amm.last_mark_price_twap)?
            .checked_sub(oracle_twap)
            .ok_or_else(math_error!())?;

        if (oracle_mark_gap_after > 0 && oracle_mark_gap_before < 0)
            || (oracle_mark_gap_after < 0 && oracle_mark_gap_before > 0)
        {
            market.amm.historical_oracle_data.last_oracle_price_twap =
                cast_to_i128(market.amm.last_mark_price_twap)?;
            market.amm.historical_oracle_data.last_oracle_price_twap_ts = now;
        } else if oracle_mark_gap_after.unsigned_abs() <= oracle_mark_gap_before.unsigned_abs() {
            market.amm.historical_oracle_data.last_oracle_price_twap = oracle_twap;
            market.amm.historical_oracle_data.last_oracle_price_twap_ts = now;
        } else {
            return Err(ErrorCode::PriceBandsBreached.into());
        }
    } else {
        return Err(ErrorCode::InvalidOracle.into());
    }

    Ok(())
}

#[allow(unused_must_use)]
#[access_control(
    market_valid(&ctx.accounts.market) &&
    valid_oracle_for_market(&ctx.accounts.oracle, &ctx.accounts.market)
)]
pub fn handle_update_k(ctx: Context<AdminUpdateK>, sqrt_k: u128) -> Result<()> {
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

    let k_increasing = sqrt_k > market.amm.sqrt_k;

    let new_sqrt_k_u192 = bn::U192::from(sqrt_k);

    let update_k_result = get_update_k_result(market, new_sqrt_k_u192, true)?;

    let adjustment_cost = math::amm::adjust_k_cost(market, &update_k_result)?;

    math::amm::update_k(market, &update_k_result);

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
        let max_cost = market
            .amm
            .total_fee_minus_distributions
            .checked_sub(cast_to_i128(get_total_fee_lower_bound(market)?)?)
            .ok_or_else(math_error!())?
            .checked_sub(cast_to_i128(market.amm.total_fee_withdrawn)?)
            .ok_or_else(math_error!())?;
        if adjustment_cost > max_cost {
            return Err(ErrorCode::InvalidUpdateK.into());
        }
    }

    market.amm.total_fee_minus_distributions = market
        .amm
        .total_fee_minus_distributions
        .checked_sub(adjustment_cost)
        .ok_or_else(math_error!())?;

    market.amm.net_revenue_since_last_funding = market
        .amm
        .net_revenue_since_last_funding
        .checked_sub(adjustment_cost as i64)
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
    } = get_oracle_price(&market.amm.oracle_source, &ctx.accounts.oracle, clock.slot)?;

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

#[allow(unused_must_use)]
#[access_control(
    market_valid(&ctx.accounts.market) &&
    valid_oracle_for_market(&ctx.accounts.oracle, &ctx.accounts.market)
)]
pub fn handle_reset_amm_oracle_twap(ctx: Context<RepegCurve>) -> Result<()> {
    // if oracle is invalid, failsafe to reset amm oracle_twap to the mark_twap

    let state = &ctx.accounts.state;

    let clock = Clock::get()?;
    let now = clock.unix_timestamp;
    let clock_slot = clock.slot;

    let market = &mut load_mut!(ctx.accounts.market)?;
    let price_oracle = &ctx.accounts.oracle;
    let oracle_price_data = &get_oracle_price(&market.amm.oracle_source, price_oracle, clock_slot)?;

    let oracle_validity = oracle::oracle_validity(
        market.amm.historical_oracle_data.last_oracle_price_twap,
        oracle_price_data,
        &state.oracle_guard_rails.validity,
    )?;

    let is_oracle_valid =
        is_oracle_valid_for_action(oracle_validity, Some(DriftAction::UpdateFunding))?;

    if !is_oracle_valid {
        market.amm.historical_oracle_data.last_oracle_price_twap =
            cast_to_i128(market.amm.last_mark_price_twap)?;
        market.amm.historical_oracle_data.last_oracle_price_twap_ts = now;
    }

    Ok(())
}

#[access_control(
    market_valid(&ctx.accounts.market)
)]
pub fn handle_update_margin_ratio(
    ctx: Context<AdminUpdateMarket>,
    margin_ratio_initial: u32,
    margin_ratio_maintenance: u32,
) -> Result<()> {
    let market = &mut load_mut!(ctx.accounts.market)?;
    validate_margin(
        margin_ratio_initial,
        margin_ratio_maintenance,
        market.liquidator_fee,
        market.amm.max_spread,
    )?;

    market.margin_ratio_initial = margin_ratio_initial;
    market.margin_ratio_maintenance = margin_ratio_maintenance;
    Ok(())
}

#[access_control(
    market_valid(&ctx.accounts.market)
)]
pub fn handle_update_market_max_imbalances(
    ctx: Context<AdminUpdateMarket>,
    unrealized_max_imbalance: u128,
    max_revenue_withdraw_per_period: u128,
    quote_max_insurance: u128,
) -> Result<()> {
    let market = &mut load_mut!(ctx.accounts.market)?;

    let max_insurance_for_tier = match market.contract_tier {
        ContractTier::A => INSURANCE_A_MAX,
        ContractTier::B => INSURANCE_B_MAX,
        ContractTier::C => INSURANCE_C_MAX,
        ContractTier::Speculative => INSURANCE_SPECULATIVE_MAX,
    };

    validate!(
        max_revenue_withdraw_per_period <= max_insurance_for_tier
            && unrealized_max_imbalance <= max_insurance_for_tier + 1
            && quote_max_insurance <= max_insurance_for_tier,
        ErrorCode::DefaultError,
        "all maxs must be less than max_insurance for ContractTier ={}",
        max_insurance_for_tier
    )?;

    validate!(
        market.quote_settled_insurance <= quote_max_insurance,
        ErrorCode::DefaultError,
        "quote_max_insurance must be above market.quote_settled_insurance={}",
        market.quote_settled_insurance
    )?;

    msg!(
        "market.max_revenue_withdraw_per_period: {:?} -> {:?}",
        market.max_revenue_withdraw_per_period,
        max_revenue_withdraw_per_period
    );

    msg!(
        "market.unrealized_max_imbalance: {:?} -> {:?}",
        market.unrealized_max_imbalance,
        unrealized_max_imbalance
    );

    msg!(
        "market.quote_max_insurance: {:?} -> {:?}",
        market.quote_max_insurance,
        quote_max_insurance
    );

    market.max_revenue_withdraw_per_period = max_revenue_withdraw_per_period;
    market.unrealized_max_imbalance = unrealized_max_imbalance;
    market.quote_max_insurance = quote_max_insurance;

    Ok(())
}

#[access_control(
    market_valid(&ctx.accounts.market)
)]
pub fn handle_update_perp_liquidation_fee(
    ctx: Context<AdminUpdateMarket>,
    liquidator_fee: u128,
    if_liquidation_fee: u128,
) -> Result<()> {
    let market = &mut load_mut!(ctx.accounts.market)?;
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
        market.margin_ratio_initial,
        market.margin_ratio_maintenance,
        liquidator_fee,
        market.amm.max_spread,
    )?;

    market.liquidator_fee = liquidator_fee;
    market.if_liquidation_fee = if_liquidation_fee;
    Ok(())
}

pub fn handle_update_insurance_withdraw_escrow_period(
    ctx: Context<AdminUpdateSpotMarket>,
    insurance_withdraw_escrow_period: i64,
) -> Result<()> {
    let spot_market = &mut load_mut!(ctx.accounts.spot_market)?;
    spot_market.insurance_withdraw_escrow_period = insurance_withdraw_escrow_period;
    Ok(())
}

pub fn handle_update_spot_market_liquidation_fee(
    ctx: Context<AdminUpdateSpotMarket>,
    liquidator_fee: u128,
    if_liquidation_fee: u128,
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

pub fn handle_update_withdraw_guard_threshold(
    ctx: Context<AdminUpdateSpotMarket>,
    withdraw_guard_threshold: u128,
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
        total_if_factor <= cast_to_u32(IF_FACTOR_PRECISION)?,
        ErrorCode::DefaultError,
        "total_if_factor must be <= 100%"
    )?;

    msg!(
        "spot_market.user_if_factor: {:?} -> {:?}",
        spot_market.user_if_factor,
        user_if_factor
    );
    msg!(
        "spot_market.total_if_factor: {:?} -> {:?}",
        spot_market.total_if_factor,
        total_if_factor
    );

    spot_market.user_if_factor = user_if_factor;
    spot_market.total_if_factor = total_if_factor;

    Ok(())
}

pub fn handle_update_spot_market_revenue_settle_period(
    ctx: Context<AdminUpdateSpotMarket>,
    revenue_settle_period: i64,
) -> Result<()> {
    let spot_market = &mut load_mut!(ctx.accounts.spot_market)?;
    validate!(revenue_settle_period > 0, ErrorCode::DefaultError)?;
    msg!(
        "spot_market.revenue_settle_period: {:?} -> {:?}",
        spot_market.revenue_settle_period,
        revenue_settle_period
    );
    spot_market.revenue_settle_period = revenue_settle_period;
    Ok(())
}

pub fn handle_update_spot_market_status(
    ctx: Context<AdminUpdateSpotMarket>,
    status: MarketStatus,
) -> Result<()> {
    let market = &mut load_mut!(ctx.accounts.spot_market)?;
    market.status = status;
    Ok(())
}

pub fn handle_update_spot_market_asset_tier(
    ctx: Context<AdminUpdateSpotMarket>,
    asset_tier: AssetTier,
) -> Result<()> {
    let market = &mut load_mut!(ctx.accounts.spot_market)?;

    if market.initial_asset_weight > 0 {
        validate!(
            matches!(asset_tier, AssetTier::Collateral | AssetTier::Protected),
            ErrorCode::DefaultError,
            "initial_asset_weight > 0 so AssetTier must be collateral or protected"
        )?;
    }

    market.asset_tier = asset_tier;
    Ok(())
}

pub fn handle_update_spot_market_margin_weights(
    ctx: Context<AdminUpdateSpotMarket>,
    initial_asset_weight: u128,
    maintenance_asset_weight: u128,
    initial_liability_weight: u128,
    maintenance_liability_weight: u128,
    imf_factor: u128,
) -> Result<()> {
    let market = &mut load_mut!(ctx.accounts.spot_market)?;

    validate_margin_weights(
        market.market_index,
        initial_asset_weight,
        maintenance_asset_weight,
        initial_liability_weight,
        maintenance_liability_weight,
        imf_factor,
    )?;

    market.initial_asset_weight = initial_asset_weight;
    market.maintenance_asset_weight = maintenance_asset_weight;
    market.initial_liability_weight = initial_liability_weight;
    market.maintenance_liability_weight = maintenance_liability_weight;
    market.imf_factor = imf_factor;

    Ok(())
}

pub fn handle_update_spot_market_max_token_deposits(
    ctx: Context<AdminUpdateSpotMarket>,
    max_token_deposits: u128,
) -> Result<()> {
    let spot_market = &mut load_mut!(ctx.accounts.spot_market)?;
    spot_market.max_token_deposits = max_token_deposits;
    Ok(())
}

#[access_control(
    market_valid(&ctx.accounts.market)
)]
pub fn handle_update_perp_market_status(
    ctx: Context<AdminUpdateMarket>,
    status: MarketStatus,
) -> Result<()> {
    validate!(
        !matches!(status, MarketStatus::Delisted | MarketStatus::Settlement),
        ErrorCode::DefaultError,
        "must set settlement/delist through another instruction",
    )?;

    let market = &mut load_mut!(ctx.accounts.market)?;
    market.status = status;
    Ok(())
}

#[access_control(
    market_valid(&ctx.accounts.market)
)]
pub fn handle_update_perp_market_contract_tier(
    ctx: Context<AdminUpdateMarket>,
    contract_tier: ContractTier,
) -> Result<()> {
    let market = &mut load_mut!(ctx.accounts.market)?;
    market.contract_tier = contract_tier;
    Ok(())
}

#[access_control(
    market_valid(&ctx.accounts.market)
)]
pub fn handle_update_market_imf_factor(
    ctx: Context<AdminUpdateMarket>,
    imf_factor: u128,
) -> Result<()> {
    validate!(
        imf_factor <= SPOT_IMF_PRECISION,
        ErrorCode::DefaultError,
        "invalid imf factor",
    )?;
    let market = &mut load_mut!(ctx.accounts.market)?;
    market.imf_factor = imf_factor;
    Ok(())
}

#[access_control(
    market_valid(&ctx.accounts.market)
)]
pub fn handle_update_market_unrealized_asset_weight(
    ctx: Context<AdminUpdateMarket>,
    unrealized_initial_asset_weight: u32,
    unrealized_maintenance_asset_weight: u32,
) -> Result<()> {
    validate!(
        unrealized_initial_asset_weight <= cast(SPOT_WEIGHT_PRECISION)?,
        ErrorCode::DefaultError,
        "invalid unrealized_initial_asset_weight",
    )?;
    validate!(
        unrealized_maintenance_asset_weight <= cast(SPOT_WEIGHT_PRECISION)?,
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
    market_valid(&ctx.accounts.market)
)]
pub fn handle_update_concentration_coef(
    ctx: Context<AdminUpdateMarket>,
    concentration_scale: u128,
) -> Result<()> {
    validate!(
        concentration_scale > 0,
        ErrorCode::DefaultError,
        "invalid concentration_scale",
    )?;

    let market = &mut load_mut!(ctx.accounts.market)?;
    let prev_concentration_coef = market.amm.concentration_coef;
    controller::amm::update_concentration_coef(&mut market.amm, concentration_scale)?;
    let new_concentration_coef = market.amm.concentration_coef;

    msg!(
        "market.amm.concentration_coef: {} -> {}",
        prev_concentration_coef,
        new_concentration_coef
    );

    validate!(
        prev_concentration_coef != new_concentration_coef,
        ErrorCode::DefaultError,
        "concentration_coef unchanged",
    )?;

    Ok(())
}

#[access_control(
    market_valid(&ctx.accounts.market)
)]
pub fn handle_update_curve_update_intensity(
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
    market_valid(&ctx.accounts.market)
)]
pub fn handle_update_lp_cooldown_time(
    ctx: Context<AdminUpdateMarket>,
    lp_cooldown_time: i64,
) -> Result<()> {
    let market = &mut ctx.accounts.market.load_mut()?;
    market.amm.lp_cooldown_time = lp_cooldown_time;
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

pub fn handle_update_oracle_guard_rails(
    ctx: Context<AdminUpdateState>,
    oracle_guard_rails: OracleGuardRails,
) -> Result<()> {
    ctx.accounts.state.oracle_guard_rails = oracle_guard_rails;
    Ok(())
}

#[access_control(
    market_valid(&ctx.accounts.market)
)]
pub fn handle_update_market_oracle(
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
    market_valid(&ctx.accounts.market)
)]
pub fn handle_update_market_base_spread(
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
    market_valid(&ctx.accounts.market)
)]
pub fn handle_update_amm_jit_intensity(
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
    market_valid(&ctx.accounts.market)
)]
pub fn handle_update_market_max_spread(
    ctx: Context<AdminUpdateMarket>,
    max_spread: u32,
) -> Result<()> {
    let market = &mut load_mut!(ctx.accounts.market)?;
    validate!(
        (max_spread >= market.amm.base_spread as u32),
        ErrorCode::DefaultError,
        "invalid max_spread < base_spread",
    )?;

    validate!(
        max_spread <= market.margin_ratio_initial * 100,
        ErrorCode::DefaultError,
        "invalid max_spread > market.margin_ratio_initial * 100",
    )?;

    market.amm.max_spread = max_spread;

    Ok(())
}

#[access_control(
    market_valid(&ctx.accounts.market)
)]
pub fn handle_update_perp_step_size_and_tick_size(
    ctx: Context<AdminUpdateMarket>,
    step_size: u64,
    tick_size: u64,
) -> Result<()> {
    let market = &mut load_mut!(ctx.accounts.market)?;
    validate!(step_size > 0 && tick_size > 0, ErrorCode::DefaultError)?;
    market.amm.order_step_size = step_size;
    market.amm.order_tick_size = tick_size;
    Ok(())
}

#[access_control(
    market_valid(&ctx.accounts.market)
)]
pub fn handle_update_perp_min_order_size(
    ctx: Context<AdminUpdateMarket>,
    order_size: u64,
) -> Result<()> {
    let market = &mut load_mut!(ctx.accounts.market)?;
    validate!(order_size > 0, ErrorCode::DefaultError)?;
    market.amm.min_order_size = order_size;
    Ok(())
}

#[access_control(
    market_valid(&ctx.accounts.market)
)]
pub fn handle_update_market_max_slippage_ratio(
    ctx: Context<AdminUpdateMarket>,
    max_slippage_ratio: u16,
) -> Result<()> {
    validate!(max_slippage_ratio > 0, ErrorCode::DefaultError)?;
    let market = &mut load_mut!(ctx.accounts.market)?;
    market.amm.max_slippage_ratio = max_slippage_ratio;
    Ok(())
}

#[access_control(
    market_valid(&ctx.accounts.market)
)]
pub fn handle_update_max_base_asset_amount_ratio(
    ctx: Context<AdminUpdateMarket>,
    max_base_asset_amount_ratio: u16,
) -> Result<()> {
    validate!(max_base_asset_amount_ratio > 0, ErrorCode::DefaultError)?;
    let market = &mut load_mut!(ctx.accounts.market)?;
    market.amm.max_base_asset_amount_ratio = max_base_asset_amount_ratio;
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
    exchange_status: ExchangeStatus,
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
        spot_market.total_if_shares,
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
        &ctx.accounts.clearing_house_signer,
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

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    #[account(
        init,
        seeds = [b"clearing_house".as_ref()],
        space = std::mem::size_of::<State>() + 8,
        bump,
        payer = admin
    )]
    pub state: Box<Account<'info, State>>,
    pub quote_asset_mint: Box<Account<'info, Mint>>,
    /// CHECK: checked in `initialize`
    pub clearing_house_signer: AccountInfo<'info>,
    pub rent: Sysvar<'info, Rent>,
    pub system_program: Program<'info, System>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct InitializeSpotMarket<'info> {
    #[account(
        init,
        seeds = [b"spot_market", state.number_of_spot_markets.to_le_bytes().as_ref()],
        space = std::mem::size_of::<SpotMarket>() + 8,
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
        token::authority = clearing_house_signer
    )]
    pub spot_market_vault: Box<Account<'info, TokenAccount>>,
    #[account(
        init,
        seeds = [b"insurance_fund_vault".as_ref(), state.number_of_spot_markets.to_le_bytes().as_ref()],
        bump,
        payer = admin,
        token::mint = spot_market_mint,
        token::authority = clearing_house_signer
    )]
    pub insurance_fund_vault: Box<Account<'info, TokenAccount>>,
    #[account(
        constraint = state.signer.eq(&clearing_house_signer.key())
    )]
    /// CHECK: program signer
    pub clearing_house_signer: AccountInfo<'info>,
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
        constraint = state.signer.eq(&clearing_house_signer.key())
    )]
    /// CHECK: program signer
    pub clearing_house_signer: AccountInfo<'info>,
    #[account(
        init,
        seeds = [b"serum_fulfillment_config".as_ref(), serum_market.key.as_ref()],
        space = std::mem::size_of::<SerumV3FulfillmentConfig>() + 8,
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
pub struct InitializeMarket<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    #[account(
        mut,
        has_one = admin
    )]
    pub state: Box<Account<'info, State>>,
    #[account(
        init,
        seeds = [b"market", state.number_of_markets.to_le_bytes().as_ref()],
        space = std::mem::size_of::<PerpMarket>() + 8,
        bump,
        payer = admin
    )]
    pub market: AccountLoader<'info, PerpMarket>,
    /// CHECK: checked in `initialize_market`
    pub oracle: AccountInfo<'info>,
    pub rent: Sysvar<'info, Rent>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct AdminUpdateMarket<'info> {
    pub admin: Signer<'info>,
    #[account(
    has_one = admin
    )]
    pub state: Box<Account<'info, State>>,
    #[account(mut)]
    pub market: AccountLoader<'info, PerpMarket>,
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
    pub market: AccountLoader<'info, PerpMarket>,
    pub admin: Signer<'info>,
    #[account(
        mut,
        token::authority = admin
    )]
    pub source_vault: Box<Account<'info, TokenAccount>>,
    #[account(
        constraint = state.signer.eq(&clearing_house_signer.key())
    )]
    /// CHECK: withdraw fails if this isn't vault owner
    pub clearing_house_signer: AccountInfo<'info>,
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
    pub market: AccountLoader<'info, PerpMarket>,
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
    pub market: AccountLoader<'info, PerpMarket>,
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
        constraint = state.signer.eq(&clearing_house_signer.key())
    )]
    /// CHECK: forced clearing_house_signer
    pub clearing_house_signer: AccountInfo<'info>,
    #[account(
        mut,
        token::mint = insurance_fund_vault.mint,
        token::authority = admin
    )]
    pub admin_token_account: Box<Account<'info, TokenAccount>>,
    pub token_program: Program<'info, Token>,
}
