use std::convert::TryInto;

use anchor_lang::prelude::*;
use anchor_lang::Discriminator;
use anchor_spl::{
    token_2022::{
        spl_token_2022::{
            extension::{
                transfer_hook::TransferHook, BaseStateWithExtensions, StateWithExtensions,
            },
            state::Mint as MintInner,
        },
        Token2022,
    },
    token_interface::{Mint, TokenAccount, TokenInterface},
};

use crate::{
    auth::{check_cold, check_hot, check_pause, check_warm, require_pause_only_added},
    controller,
    controller::token::{close_vault, initialize_immutable_owner, initialize_token_account},
    error::ErrorCode,
    get_then_update_id,
    instructions::{
        constraints::*,
        optional_accounts::{load_maps, AccountMaps},
    },
    load_mut, math,
    math::{
        bn,
        casting::Cast,
        constants::{
            BPS_PRECISION, DEFAULT_LIQUIDATION_MARGIN_BUFFER_RATIO, FEE_ADJUSTMENT_MAX,
            FEE_POOL_TO_REVENUE_POOL_THRESHOLD, IF_FACTOR_PRECISION, INSURANCE_A_MAX,
            INSURANCE_B_MAX, INSURANCE_C_MAX, INSURANCE_SPECULATIVE_MAX, LIQUIDATION_FEE_PRECISION,
            MAX_CONCENTRATION_COEFFICIENT, MM_ORACLE_MAX_STEP_PCT_PRECISION,
            MM_ORACLE_MIN_SLOT_GAP, PERCENTAGE_PRECISION, PERCENTAGE_PRECISION_I128,
            PERCENTAGE_PRECISION_I64, PERCENTAGE_PRECISION_U32, QUOTE_PRECISION_I64,
            QUOTE_SPOT_MARKET_INDEX, SPOT_BALANCE_PRECISION, SPOT_CUMULATIVE_INTEREST_PRECISION,
            SPOT_IMF_PRECISION, SPOT_WEIGHT_PRECISION, THIRTEEN_DAY, TWENTY_FOUR_HOUR,
        },
        orders::is_multiple_of_step_size,
        safe_math::SafeMath,
        spot_balance::get_token_amount,
        spot_withdraw::validate_spot_market_vault_amount,
    },
    math_error, msg,
    optional_accounts::get_token_mint,
    safe_decrement, safe_increment,
    state::{
        events::{
            DepositDirection, DepositExplanation, DepositRecord, SpotMarketVaultDepositRecord,
        },
        market_status::MarketStatus,
        oracle::{
            get_oracle_price, get_prelaunch_price, get_pyth_price, HistoricalIndexData,
            HistoricalOracleData, OraclePriceData, OracleSource, PrelaunchOracle,
            PrelaunchOracleParams, StrictOraclePrice,
        },
        oracle_map::OracleMap,
        paused_operations::{InsuranceFundOperation, PerpOperation, SpotOperation},
        perp_market::{
            ContractTier, ContractType, FeeLedger, HedgeConfig, InsuranceClaim, MarketConfigFlag,
            MarketStats, PerpMarket, PoolBalance, AMM,
        },
        perp_market_map::{get_writable_perp_market_set, MarketSet},
        pyth_lazer_oracle::{PythLazerOracle, PYTH_LAZER_ORACLE_SEED},
        spot_market::{AssetTier, InsuranceFund, SpotBalanceType, SpotMarket, TokenProgramFlag},
        spot_market_map::get_writable_spot_market_set,
        state::{
            ExchangeStatus, FeeStructure, HotRole, LpPoolFeatureBitFlags, OracleGuardRails,
            SolvencyStatus, State,
        },
        traits::Size,
        user::{MarketType, SpecialUserStatus, User, UserStats},
    },
    validate,
    validation::{
        fee_structure::validate_fee_structure,
        margin::{validate_margin, validate_margin_weights},
        spot_market::{validate_borrow_rate, validate_withdraw_guard_threshold},
    },
    vlp::amm::math::amm,
    vlp::amm_cache::{AmmCache, AMM_POSITIONS_CACHE},
    FeatureBitFlags,
};

fn validate_supported_market_oracle_source(oracle_source: OracleSource) -> Result<()> {
    if matches!(
        oracle_source,
        OracleSource::PythPull
            | OracleSource::Pyth1KPull
            | OracleSource::Pyth1MPull
            | OracleSource::PythStableCoinPull
    ) {
        return Err(ErrorCode::InvalidOracle.into());
    }

    Ok(())
}

pub fn handle_initialize(ctx: Context<Initialize>) -> Result<()> {
    let (velocity_signer, velocity_signer_nonce) =
        Pubkey::find_program_address(&[b"velocity_signer".as_ref()], ctx.program_id);

    // Default warm_admin to the cold admin so warm-tier handlers work
    // immediately. All hot roles start as `Pubkey::default()` (unassigned)
    // until rotated via `update_hot_admin`.
    let mut state = ctx.accounts.state.load_init()?;
    *state = State {
        cold_admin: *ctx.accounts.admin.key,
        warm_admin: *ctx.accounts.admin.key,
        pause_admin: Pubkey::default(),
        hot_amm_crank: Pubkey::default(),
        hot_lp_cache: Pubkey::default(),
        hot_lp_swap: Pubkey::default(),
        hot_lp_settle: Pubkey::default(),
        hot_feature_flag: Pubkey::default(),
        hot_fuel: Pubkey::default(),
        hot_user_flag: Pubkey::default(),
        hot_vault_deposit: Pubkey::default(),
        hot_mm_oracle_crank: Pubkey::default(),
        hot_amm_spread_adjust: Pubkey::default(),
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
        signer: velocity_signer,
        signer_nonce: velocity_signer_nonce,
        srm_vault: Pubkey::default(),
        protocol_fee_recipient_perp: Pubkey::default(),
        hot_fee_withdraw: Pubkey::default(),
        protocol_fee_recipient_spot: Pubkey::default(),
        perp_fee_structure: FeeStructure::perps_default(),
        spot_fee_structure: FeeStructure::spot_default(),
        liquidation_duration: 0,
        initial_pct_to_liquidate: 0,
        max_number_of_sub_accounts: 0,
        max_initialize_user_fee: 0,
        feature_bit_flags: 0,
        lp_pool_feature_bit_flags: 0,
        solvency_status: SolvencyStatus::active(),
        padding: [0; 271],
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
    if_liquidation_fee: u32,
    active_status: bool,
    asset_tier: AssetTier,
    scale_initial_asset_weight_start: u64,
    withdraw_guard_threshold: u64,
    order_tick_size: u64,
    order_step_size: u64,
    if_total_factor: u32,
    name: [u8; 32],
) -> Result<()> {
    let mut state = ctx.accounts.state.load_mut()?;
    let spot_market_pubkey = ctx.accounts.spot_market.key();

    validate_supported_market_oracle_source(oracle_source)?;

    let is_token_2022 = *ctx.accounts.spot_market_mint.to_account_info().owner == Token2022::id();
    if is_token_2022 {
        initialize_immutable_owner(&ctx.accounts.token_program, &ctx.accounts.spot_market_vault)?;

        initialize_immutable_owner(
            &ctx.accounts.token_program,
            &ctx.accounts.insurance_fund_vault,
        )?;
    }

    initialize_token_account(
        &ctx.accounts.token_program,
        &ctx.accounts.spot_market_vault,
        &ctx.accounts.velocity_signer,
        &ctx.accounts.spot_market_mint,
    )?;

    initialize_token_account(
        &ctx.accounts.token_program,
        &ctx.accounts.insurance_fund_vault,
        &ctx.accounts.velocity_signer,
        &ctx.accounts.spot_market_mint,
    )?;

    validate_borrow_rate(optimal_utilization, optimal_borrow_rate, max_borrow_rate, 0)?;

    let spot_market_index = get_then_update_id!(state, number_of_spot_markets);

    msg!("initializing spot market {}", spot_market_index);

    if oracle_source == OracleSource::QuoteAsset {
        // catches inconsistent parameters
        validate!(
            ctx.accounts.oracle.key == &Pubkey::default(),
            ErrorCode::InvalidSpotMarketInitialization,
            "For OracleSource::QuoteAsset, oracle must be default public key"
        )?;
    } else {
        OracleMap::validate_oracle_account_info(&ctx.accounts.oracle)?;
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
                ctx.accounts.spot_market_mint.decimals >= 5,
                ErrorCode::InvalidSpotMarketInitialization,
                "Mint decimals must be greater than or equal to 5"
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

    validate_withdraw_guard_threshold(
        withdraw_guard_threshold,
        decimals,
        oracle_price_data?.price,
    )?;

    let mut token_program = 0_u8;
    if ctx.accounts.token_program.key() == Token2022::id() {
        token_program |= TokenProgramFlag::Token2022 as u8;
    }

    let mint_account_info = ctx.accounts.spot_market_mint.to_account_info();
    let mint_data = mint_account_info.try_borrow_data()?;
    let mint_with_extension = StateWithExtensions::<MintInner>::unpack(&mint_data)?;
    if let Ok(transfer_hook) = mint_with_extension.get_extension::<TransferHook>() {
        let transfer_hook_program_id: Option<Pubkey> = transfer_hook.program_id.into();
        if transfer_hook_program_id.is_some() {
            token_program |= TokenProgramFlag::TransferHook as u8;
        }
    }

    if active_status {
        validate!(
            ctx.accounts.admin.key() == state.cold_admin,
            ErrorCode::DefaultError,
            "admin must be state admin"
        )?;
    }

    **spot_market = SpotMarket {
        market_index: spot_market_index,
        pubkey: spot_market_pubkey,
        status: if active_status {
            MarketStatus::Active
        } else {
            MarketStatus::Initialized
        },
        name,
        asset_tier,
        expiry_ts: 0,
        oracle: ctx.accounts.oracle.key(),
        oracle_source,
        historical_oracle_data: historical_oracle_data_default,
        historical_index_data: historical_index_data_default,
        mint: ctx.accounts.spot_market_mint.key(),
        vault: ctx.accounts.spot_market_vault.key(),
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
        utilization_twap: 0,
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
        if_liquidation_fee, // 1%
        withdraw_guard_threshold,
        order_step_size,
        order_tick_size,
        min_order_size: order_step_size,
        max_position_size: 0,
        next_fill_record_id: 1,
        next_deposit_record_id: 1,
        spot_fee_pool: PoolBalance::default(), // in quote asset
        total_spot_fee: 0,
        orders_enabled: spot_market_index != 0,
        paused_operations: 0,
        if_paused_operations: 0,
        fee_adjustment: 0,
        max_token_borrows_fraction: 0,
        flash_loan_amount: 0,
        flash_loan_initial_token_amount: 0,
        total_swap_fee: 0,
        scale_initial_asset_weight_start,
        min_borrow_rate: 0,
        token_program_flag: token_program,
        pool_id: 0,
        _padding_align_pfp: [0; 8],
        protocol_fee_pool: PoolBalance {
            scaled_balance: 0,
            market_index: spot_market_index,
            ..PoolBalance::default()
        },
        protocol_liquidation_fee: 0,
        protocol_fee_factor: 0,
        padding: [0; 8],
        insurance_fund: InsuranceFund {
            vault: ctx.accounts.insurance_fund_vault.key(),
            unstaking_period: THIRTEEN_DAY,
            if_fee_factor: if_total_factor,
            revenue_settle_period: 3600,
            ..InsuranceFund::default()
        },
    };

    Ok(())
}

#[access_control(
    spot_market_valid(&ctx.accounts.spot_market)
)]
pub fn handle_update_spot_market_pool_id(
    ctx: Context<AdminUpdateSpotMarket>,
    pool_id: u8,
) -> Result<()> {
    let mut spot_market = load_mut!(ctx.accounts.spot_market)?;
    msg!(
        "updating spot market {} pool id to {}",
        spot_market.market_index,
        pool_id
    );

    validate!(
        spot_market.status == MarketStatus::Initialized,
        ErrorCode::DefaultError,
        "Market must be just initialized to update pool"
    )?;

    spot_market.pool_id = pool_id;

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
    contract_tier: ContractTier,
    margin_ratio_initial: u32,
    margin_ratio_maintenance: u32,
    liquidator_fee: u32,
    if_liquidation_fee: u32,
    imf_factor: u32,
    active_status: bool,
    base_spread: u32,
    max_spread: u32,
    max_open_interest: u128,
    max_revenue_withdraw_per_period: u64,
    quote_max_insurance: u64,
    order_step_size: u64,
    order_tick_size: u64,
    min_order_size: u64,
    concentration_coef_scale: u128,
    curve_update_intensity: u8,
    amm_jit_intensity: u8,
    name: [u8; 32],
    lp_pool_id: u8,
    funding_clamp_threshold: u32,
    funding_ramp_slope: u32,
) -> Result<()> {
    msg!("perp market {}", market_index);
    let perp_market_pubkey = ctx.accounts.perp_market.to_account_info().key;
    let perp_market = &mut ctx.accounts.perp_market.load_init()?;

    // 0 means "unset" -> fall back to the launch defaults (5bps / 1.0x)
    let funding_clamp_threshold = if funding_clamp_threshold == 0 {
        5
    } else {
        funding_clamp_threshold
    };
    let funding_ramp_slope = if funding_ramp_slope == 0 {
        PERCENTAGE_PRECISION_U32
    } else {
        funding_ramp_slope
    };
    let clock = Clock::get()?;
    let now = clock.unix_timestamp;
    let clock_slot = clock.slot;

    validate_supported_market_oracle_source(oracle_source)?;

    if amm_base_asset_reserve != amm_quote_asset_reserve {
        return Err(ErrorCode::InvalidInitialPeg.into());
    }

    validate!(
        (0..=100).contains(&curve_update_intensity),
        ErrorCode::DefaultError,
        "invalid curve_update_intensity",
    )?;

    validate!(
        (0..=100).contains(&amm_jit_intensity),
        ErrorCode::DefaultError,
        "invalid amm_jit_intensity",
    )?;

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

    OracleMap::validate_oracle_account_info(&ctx.accounts.oracle)?;

    // Verify oracle is readable
    let (oracle_price, oracle_delay, last_oracle_price_twap) = match oracle_source {
        OracleSource::Pyth => {
            let OraclePriceData {
                price: oracle_price,
                delay: oracle_delay,
                ..
            } = get_pyth_price(&ctx.accounts.oracle, clock_slot, &OracleSource::Pyth)?;
            let last_oracle_price_twap = perp_market
                .amm
                .get_pyth_twap(&ctx.accounts.oracle, &OracleSource::Pyth)?;
            (oracle_price, oracle_delay, last_oracle_price_twap)
        }
        OracleSource::Pyth1K => {
            let OraclePriceData {
                price: oracle_price,
                delay: oracle_delay,
                ..
            } = get_pyth_price(&ctx.accounts.oracle, clock_slot, &OracleSource::Pyth1K)?;
            let last_oracle_price_twap = perp_market
                .amm
                .get_pyth_twap(&ctx.accounts.oracle, &OracleSource::Pyth1K)?;
            (oracle_price, oracle_delay, last_oracle_price_twap)
        }
        OracleSource::Pyth1M => {
            let OraclePriceData {
                price: oracle_price,
                delay: oracle_delay,
                ..
            } = get_pyth_price(&ctx.accounts.oracle, clock_slot, &OracleSource::Pyth1M)?;
            let last_oracle_price_twap = perp_market
                .amm
                .get_pyth_twap(&ctx.accounts.oracle, &OracleSource::Pyth1M)?;
            (oracle_price, oracle_delay, last_oracle_price_twap)
        }
        OracleSource::PythStableCoin => {
            let OraclePriceData {
                price: oracle_price,
                delay: oracle_delay,
                ..
            } = get_pyth_price(
                &ctx.accounts.oracle,
                clock_slot,
                &OracleSource::PythStableCoin,
            )?;
            (oracle_price, oracle_delay, QUOTE_PRECISION_I64)
        }
        OracleSource::DeprecatedSwitchboard | OracleSource::DeprecatedSwitchboardOnDemand => {
            return Err(ErrorCode::InvalidOracle.into());
        }
        OracleSource::QuoteAsset => {
            msg!("Quote asset oracle cant be used for perp market");
            return Err(ErrorCode::InvalidOracle.into());
        }
        OracleSource::Prelaunch => {
            let OraclePriceData {
                price: oracle_price,
                delay: oracle_delay,
                ..
            } = get_prelaunch_price(&ctx.accounts.oracle, clock_slot)?;
            (oracle_price, oracle_delay, oracle_price)
        }
        OracleSource::PythPull
        | OracleSource::Pyth1KPull
        | OracleSource::Pyth1MPull
        | OracleSource::PythStableCoinPull => {
            return Err(ErrorCode::InvalidOracle.into());
        }
        OracleSource::PythLazer => {
            let OraclePriceData {
                price: oracle_price,
                delay: oracle_delay,
                ..
            } = get_pyth_price(&ctx.accounts.oracle, clock_slot, &OracleSource::PythLazer)?;
            let last_oracle_price_twap = perp_market
                .amm
                .get_pyth_twap(&ctx.accounts.oracle, &OracleSource::PythLazer)?;
            (oracle_price, oracle_delay, last_oracle_price_twap)
        }
        OracleSource::PythLazer1K => {
            let OraclePriceData {
                price: oracle_price,
                delay: oracle_delay,
                ..
            } = get_pyth_price(&ctx.accounts.oracle, clock_slot, &OracleSource::PythLazer1K)?;
            let last_oracle_price_twap = perp_market
                .amm
                .get_pyth_twap(&ctx.accounts.oracle, &OracleSource::PythLazer1K)?;
            (oracle_price, oracle_delay, last_oracle_price_twap)
        }
        OracleSource::PythLazer1M => {
            let OraclePriceData {
                price: oracle_price,
                delay: oracle_delay,
                ..
            } = get_pyth_price(&ctx.accounts.oracle, clock_slot, &OracleSource::PythLazer1M)?;
            let last_oracle_price_twap = perp_market
                .amm
                .get_pyth_twap(&ctx.accounts.oracle, &OracleSource::PythLazer1M)?;
            (oracle_price, oracle_delay, last_oracle_price_twap)
        }
        OracleSource::PythLazerStableCoin => {
            let OraclePriceData {
                price: oracle_price,
                delay: oracle_delay,
                ..
            } = get_pyth_price(
                &ctx.accounts.oracle,
                clock_slot,
                &OracleSource::PythLazerStableCoin,
            )?;
            (oracle_price, oracle_delay, QUOTE_PRECISION_I64)
        }
    };

    validate_margin(
        margin_ratio_initial,
        margin_ratio_maintenance,
        liquidator_fee,
        max_spread,
    )?;

    let mut state = ctx.accounts.state.load_mut()?;
    validate!(
        market_index == state.number_of_markets,
        ErrorCode::MarketIndexAlreadyInitialized,
        "market_index={} != state.number_of_markets={}",
        market_index,
        state.number_of_markets
    )?;

    if active_status {
        validate!(
            ctx.accounts.admin.key() == state.cold_admin,
            ErrorCode::DefaultError,
            "admin must be state admin"
        )?;
    }

    **perp_market = PerpMarket {
        contract_type: ContractType::Perpetual,
        contract_tier,
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
        imf_factor,
        next_fill_record_id: 1,
        next_funding_rate_record_id: 1,
        fee_ledger: FeeLedger::default(),
        pnl_pool: PoolBalance::default(),
        insurance_claim: InsuranceClaim {
            max_revenue_withdraw_per_period,
            quote_max_insurance,
            ..InsuranceClaim::default()
        },
        unrealized_pnl_initial_asset_weight: 0, // 100%
        unrealized_pnl_maintenance_asset_weight: SPOT_WEIGHT_PRECISION.cast()?, // 100%
        unrealized_pnl_imf_factor: 0,
        unrealized_pnl_max_imbalance: 0,
        liquidator_fee,
        if_liquidation_fee,
        paused_operations: 0,
        quote_spot_market_index: QUOTE_SPOT_MARKET_INDEX,
        fee_adjustment: 0,
        _padding_align_lfp: [0; 6],
        pool_id: 0,
        _padding_pmm: [0; 2],
        _padding_hedge: [0; 5],
        last_fill_price: 0,
        market_config: 0,
        hedge_config: HedgeConfig {
            pool_id: lp_pool_id,
            status: 0,
            paused_operations: 0,
            exchange_fee_exclusion_scalar: 0,
            fee_transfer_scalar: 1,
            padding: [0; 11],
        },
        oracle: *ctx.accounts.oracle.key,
        oracle_source,
        oracle_slot_delay_override: -1,
        oracle_low_risk_slot_delay_override: 0,
        cumulative_funding_rate_long: 0,
        cumulative_funding_rate_short: 0,
        total_social_loss: 0,
        last_funding_rate: 0,
        last_funding_rate_long: 0,
        last_funding_rate_short: 0,
        last_funding_rate_ts: now,
        net_unsettled_funding_pnl: 0,
        funding_clamp_threshold,
        funding_ramp_slope,
        order_step_size,
        order_tick_size,
        base_asset_amount_long: 0,
        base_asset_amount_short: 0,
        quote_asset_amount: 0,
        quote_entry_amount_long: 0,
        quote_entry_amount_short: 0,
        quote_break_even_amount_long: 0,
        quote_break_even_amount_short: 0,
        max_open_interest,
        padding: [0; 4],
        market_stats: MarketStats {
            last_oracle_normalised_price: oracle_price,
            last_mark_price_twap: init_reserve_price,
            last_mark_price_twap_5min: init_reserve_price,
            last_mark_price_twap_ts: now,
            last_bid_price_twap: init_reserve_price,
            last_ask_price_twap: init_reserve_price,
            last_trade_ts: now,
            last_24h_avg_funding_rate: 0,
            funding_period: amm_periodicity,
            min_order_size,
            historical_oracle_data: HistoricalOracleData {
                last_oracle_price: oracle_price,
                last_oracle_delay: oracle_delay,
                last_oracle_price_twap,
                last_oracle_price_twap_5min: oracle_price,
                last_oracle_price_twap_ts: now,
                ..HistoricalOracleData::default()
            },
            ..MarketStats::default()
        },
        _padding_align_amm: [0; 8],
        amm: AMM {
            base_asset_reserve: amm_base_asset_reserve,
            quote_asset_reserve: amm_quote_asset_reserve,
            terminal_quote_asset_reserve: amm_quote_asset_reserve,
            sqrt_k: amm_base_asset_reserve,
            concentration_coef,
            min_base_asset_reserve,
            max_base_asset_reserve,
            peg_multiplier: amm_peg_multiplier,
            total_fee: 0,
            total_fee_withdrawn: 0,
            total_fee_minus_distributions: 0,
            total_mm_fee: 0,
            net_revenue_since_last_funding: 0,
            max_slippage_ratio: 50,         // ~2%
            max_fill_reserve_fraction: 100, // moves price ~2%
            base_spread,
            max_spread,
            base_asset_amount_with_amm: 0,
            curve_update_intensity,
            fee_pool: PoolBalance::default(),
            last_update_slot: clock_slot,

            amm_jit_intensity,

            amm_spread_adjustment: 0,
            amm_inventory_spread_adjustment: 0,
            reference_price_offset_deadband_pct: 0,
            last_cumulative_funding_rate_long: 0,
            last_cumulative_funding_rate_short: 0,
            // Cached spread state: seed to a balanced no-spread snapshot
            // (ask/bid reserves == base/quote reserves, zero spreads). The
            // first `update_amms` keeper crank — or the first fill `setup` —
            // refreshes it with the real oracle-driven values.
            ask_base_asset_reserve: amm_base_asset_reserve,
            ask_quote_asset_reserve: amm_quote_asset_reserve,
            bid_base_asset_reserve: amm_base_asset_reserve,
            bid_quote_asset_reserve: amm_quote_asset_reserve,
            last_oracle_reserve_price_spread_pct: 0,
            last_spread_update_slot: clock_slot,
            long_spread: 0,
            short_spread: 0,
            reference_price_offset: 0,
            funding_bias_sensitivity: 0,
            padding_post_amm: [0; 2],
        },
        // protocol fees are quote/USDC-denominated; quote market is index 0
        protocol_fee_pool: PoolBalance {
            market_index: QUOTE_SPOT_MARKET_INDEX,
            ..PoolBalance::default()
        },
        protocol_liquidation_fee: 0,
        _padding_buffer: [0; 4],
        fee_pool_buffer_target: FEE_POOL_TO_REVENUE_POOL_THRESHOLD as u64,
    };

    safe_increment!(state.number_of_markets, 1);

    perp_market
        .amm
        .update_concentration_coef(concentration_coef_scale)?;
    crate::dlog!(oracle_price);

    let (amm_bid_size, amm_ask_size) = amm::calculate_market_open_bids_asks(&perp_market.amm)?;
    crate::dlog!(amm_bid_size, amm_ask_size);

    // dlog the seeded (no-spread) bid/ask off the AMM's cached spread fields.
    let mrk = perp_market.amm.reserve_price()?;
    let (amm_bid_price, amm_ask_price) = perp_market.amm.bid_ask_price(
        mrk,
        perp_market.amm.long_spread,
        perp_market.amm.short_spread,
        perp_market.amm.reference_price_offset,
    )?;
    crate::dlog!(amm_bid_price, amm_ask_price);

    crate::validation::perp_market::validate_perp_market(perp_market)?;

    Ok(())
}

pub fn handle_delete_initialized_perp_market(
    ctx: Context<DeleteInitializedPerpMarket>,
    market_index: u16,
) -> Result<()> {
    let perp_market = &mut ctx.accounts.perp_market.load()?;
    msg!("perp market {}", perp_market.market_index);
    let mut state = ctx.accounts.state.load_mut()?;

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

pub fn handle_delete_initialized_spot_market(
    ctx: Context<DeleteInitializedSpotMarket>,
    market_index: u16,
) -> Result<()> {
    let spot_market = ctx.accounts.spot_market.load()?;
    msg!("spot market {}", spot_market.market_index);
    let mut state = ctx.accounts.state.load_mut()?;

    // to preserve all protocol invariants, can only remove the last market if it hasn't been "activated"

    validate!(
        state.number_of_spot_markets - 1 == market_index,
        ErrorCode::InvalidMarketAccountforDeletion,
        "state.number_of_spot_markets={} != market_index={}",
        state.number_of_markets,
        market_index
    )?;
    validate!(
        spot_market.status == MarketStatus::Initialized,
        ErrorCode::InvalidMarketAccountforDeletion,
        "spot_market.status != Initialized",
    )?;
    validate!(
        spot_market.deposit_balance == 0,
        ErrorCode::InvalidMarketAccountforDeletion,
        "spot_market.number_of_users={} != 0",
        spot_market.deposit_balance,
    )?;
    validate!(
        spot_market.borrow_balance == 0,
        ErrorCode::InvalidMarketAccountforDeletion,
        "spot_market.borrow_balance={} != 0",
        spot_market.borrow_balance,
    )?;
    validate!(
        spot_market.market_index == market_index,
        ErrorCode::InvalidMarketAccountforDeletion,
        "market_index={} != spot_market.market_index={}",
        market_index,
        spot_market.market_index
    )?;

    safe_decrement!(state.number_of_spot_markets, 1);

    drop(spot_market);

    validate!(
        ctx.accounts.spot_market_vault.amount == 0,
        ErrorCode::InvalidMarketAccountforDeletion,
        "ctx.accounts.spot_market_vault.amount={}",
        ctx.accounts.spot_market_vault.amount
    )?;

    close_vault(
        &ctx.accounts.token_program,
        &ctx.accounts.spot_market_vault,
        &ctx.accounts.admin.to_account_info(),
        &ctx.accounts.velocity_signer,
        state.signer_nonce,
    )?;

    validate!(
        ctx.accounts.insurance_fund_vault.amount == 0,
        ErrorCode::InvalidMarketAccountforDeletion,
        "ctx.accounts.insurance_fund_vault.amount={}",
        ctx.accounts.insurance_fund_vault.amount
    )?;

    close_vault(
        &ctx.accounts.token_program,
        &ctx.accounts.insurance_fund_vault,
        &ctx.accounts.admin.to_account_info(),
        &ctx.accounts.velocity_signer,
        state.signer_nonce,
    )?;

    Ok(())
}

#[access_control(
    spot_market_valid(&ctx.accounts.spot_market)
)]
pub fn handle_update_spot_market_oracle(
    ctx: Context<AdminUpdateSpotMarketOracle>,
    oracle: Pubkey,
    oracle_source: OracleSource,
    skip_invariant_check: bool,
) -> Result<()> {
    let spot_market = &mut load_mut!(ctx.accounts.spot_market)?;
    msg!("updating spot market {} oracle", spot_market.market_index);
    let clock = Clock::get()?;

    validate_supported_market_oracle_source(oracle_source)?;

    OracleMap::validate_oracle_account_info(&ctx.accounts.oracle)?;

    validate!(
        ctx.accounts.oracle.key == &oracle,
        ErrorCode::DefaultError,
        "oracle account info ({:?}) and ix data ({:?}) must match",
        ctx.accounts.oracle.key,
        oracle
    )?;

    validate!(
        ctx.accounts.old_oracle.key == &spot_market.oracle,
        ErrorCode::DefaultError,
        "old oracle account info ({:?}) and spot market oracle ({:?}) must match",
        ctx.accounts.old_oracle.key,
        spot_market.oracle
    )?;

    // Verify oracle is readable
    let OraclePriceData {
        price: new_oracle_price,
        ..
    } = get_oracle_price(&oracle_source, &ctx.accounts.oracle, clock.slot)?;

    msg!(
        "spot_market.oracle {:?} -> {:?}",
        spot_market.oracle,
        oracle
    );

    msg!(
        "spot_market.oracle_source {:?} -> {:?}",
        spot_market.oracle_source,
        oracle_source
    );

    let OraclePriceData {
        price: old_oracle_price,
        ..
    } = get_oracle_price(
        &spot_market.oracle_source,
        &ctx.accounts.old_oracle,
        clock.slot,
    )?;

    msg!(
        "Oracle Price: {:?} -> {:?}",
        old_oracle_price,
        new_oracle_price
    );

    if !skip_invariant_check {
        validate!(
            new_oracle_price > 0,
            ErrorCode::DefaultError,
            "invalid oracle price, must be greater than 0"
        )?;

        let oracle_change_divergence = new_oracle_price
            .safe_sub(old_oracle_price)?
            .safe_mul(PERCENTAGE_PRECISION_I64)?
            .safe_div(old_oracle_price)?;

        validate!(
            oracle_change_divergence.abs() < (PERCENTAGE_PRECISION_I64 / 10),
            ErrorCode::DefaultError,
            "invalid new oracle price, more than 10% divergence"
        )?;
    }

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
    msg!("updating spot market {} expiry", spot_market.market_index);
    let now = Clock::get()?.unix_timestamp;

    validate!(
        now < expiry_ts,
        ErrorCode::DefaultError,
        "Market expiry ts must later than current clock timestamp"
    )?;

    msg!(
        "spot_market.status {:?} -> {:?}",
        spot_market.status,
        MarketStatus::ReduceOnly
    );
    msg!(
        "spot_market.expiry_ts {} -> {}",
        spot_market.expiry_ts,
        expiry_ts
    );

    // automatically enter reduce only
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
    let clock: Clock = Clock::get()?;
    let perp_market = &mut load_mut!(ctx.accounts.perp_market)?;
    msg!("updating perp market {} expiry", perp_market.market_index);

    validate!(
        clock.unix_timestamp < expiry_ts,
        ErrorCode::DefaultError,
        "Market expiry ts must later than current clock timestamp"
    )?;

    msg!(
        "perp_market.status {:?} -> {:?}",
        perp_market.status,
        MarketStatus::ReduceOnly
    );
    msg!(
        "perp_market.expiry_ts {} -> {}",
        perp_market.expiry_ts,
        expiry_ts
    );

    // automatically enter reduce only
    perp_market.status = MarketStatus::ReduceOnly;
    perp_market.expiry_ts = expiry_ts;

    Ok(())
}

#[access_control(
    perp_market_valid(&ctx.accounts.perp_market)
)]
pub fn handle_settle_expired_market_pools_to_revenue_pool(
    ctx: Context<SettleExpiredMarketPoolsToRevenuePool>,
) -> Result<()> {
    let perp_market = &mut load_mut!(ctx.accounts.perp_market)?;
    let spot_market: &mut std::cell::RefMut<'_, SpotMarket> =
        &mut load_mut!(ctx.accounts.spot_market)?;
    let state = ctx.accounts.state.load()?;

    msg!(
        "settling expired market pools to revenue pool for perp market {}",
        perp_market.market_index
    );

    msg!(
        "settling expired market pools to revenue pool for spot market {}",
        spot_market.market_index
    );

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
        perp_market.base_asset_amount_long == 0
            && perp_market.base_asset_amount_short == 0
            && perp_market.number_of_users_with_base == 0,
        ErrorCode::DefaultError,
        "outstanding base_asset_amounts must be balanced {} {} {}",
        perp_market.base_asset_amount_long,
        perp_market.base_asset_amount_short,
        perp_market.number_of_users_with_base
    )?;

    validate!(
        crate::vlp::amm::math::amm::calculate_net_user_cost_basis(
            perp_market.quote_asset_amount,
            perp_market.net_unsettled_funding_pnl,
        )? == 0,
        ErrorCode::DefaultError,
        "outstanding quote_asset_amounts must be balanced"
    )?;

    // With user base, AMM base, and net user cost basis all wound down,
    // net_user_pnl is identically 0 — no live user claim remains on the pnl
    // pool. This is what lets the final sweep below (and the full pnl-pool
    // drain to the revenue pool) reserve nothing for users without consulting
    // an oracle.
    validate!(
        perp_market.amm.base_asset_amount_with_amm == 0,
        ErrorCode::DefaultError,
        "amm base_asset_amount_with_amm must be balanced ({})",
        perp_market.amm.base_asset_amount_with_amm
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

    // Materialize accrued fees before draining the pnl pool to the revenue
    // pool. The pnl pool holds the un-swept fee value; without this sweep the
    // `pending_protocol_fee` carveout (which the waterfall routes to the
    // withdrawable `protocol_fee_pool`) would instead be dumped wholesale into
    // the revenue pool / insurance fund and lost to the protocol, since no
    // sweep can run once the market is Delisted. net_user_pnl is 0 here (see
    // the wind-down validations above), so the full pnl-pool surplus is
    // available to the waterfall. `force = true` overrides any standing
    // SettleRevPool pause — this is the last sweep the market will ever get.
    controller::perp_pools::sweep_market_fees(perp_market, spot_market, 0, now, true)?;

    let fee_pool_token_amount = perp_market.amm.fee_pool_token_amount(spot_market)?;
    let pnl_pool_token_amount = get_token_amount(
        perp_market.pnl_pool.scaled_balance,
        spot_market,
        &SpotBalanceType::Deposit,
    )?;

    <crate::vlp::amm::AMM as crate::vlp::amm::quoter::AmmContract>::withdraw_from_fee_pool(
        &mut perp_market.amm,
        fee_pool_token_amount,
        spot_market,
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
pub fn handle_update_perp_market_pnl_pool<'c: 'info, 'info>(
    ctx: Context<'info, UpdatePerpMarketPnlPool<'info>>,
    amount: u64,
) -> Result<()> {
    let perp_market = &mut load_mut!(ctx.accounts.perp_market)?;

    let spot_market = &mut load_mut!(ctx.accounts.spot_market)?;

    controller::spot_balance::update_spot_balances(
        amount.cast::<u128>()?,
        &SpotBalanceType::Deposit,
        spot_market,
        &mut perp_market.pnl_pool,
        false,
    )?;

    validate_spot_market_vault_amount(spot_market, ctx.accounts.spot_market_vault.amount)?;

    msg!(
        "updating perp market {} pnl pool with amount {}",
        perp_market.market_index,
        amount
    );

    Ok(())
}

#[access_control(
    deposit_not_paused(&ctx.accounts.state)
    spot_market_valid(&ctx.accounts.spot_market)
)]
pub fn handle_deposit_into_spot_market_vault<'c: 'info, 'info>(
    ctx: Context<'info, DepositIntoSpotMarketVault<'info>>,
    amount: u64,
) -> Result<()> {
    let spot_market = &mut load_mut!(ctx.accounts.spot_market)?;

    validate!(
        !spot_market.is_operation_paused(SpotOperation::Deposit),
        ErrorCode::DefaultError,
        "spot market deposits paused"
    )?;

    let remaining_accounts_iter = &mut ctx.remaining_accounts.iter().peekable();

    let mint = get_token_mint(remaining_accounts_iter)?;

    msg!(
        "depositing {} into spot market {} vault",
        amount,
        spot_market.market_index
    );

    let deposit_token_amount_before = spot_market.get_deposits()?;

    let deposit_token_amount_after = deposit_token_amount_before.safe_add(amount.cast()?)?;

    validate!(
        deposit_token_amount_after > deposit_token_amount_before,
        ErrorCode::DefaultError,
        "new_deposit_token_amount ({}) <= deposit_token_amount ({})",
        deposit_token_amount_after,
        deposit_token_amount_before
    )?;

    let token_precision = spot_market.get_precision();

    let cumulative_deposit_interest_before = spot_market.cumulative_deposit_interest;

    let cumulative_deposit_interest_after = deposit_token_amount_after
        .safe_mul(SPOT_CUMULATIVE_INTEREST_PRECISION)?
        .safe_div(spot_market.deposit_balance)?
        .safe_mul(SPOT_BALANCE_PRECISION)?
        .safe_div(token_precision.cast()?)?;

    validate!(
        cumulative_deposit_interest_after > cumulative_deposit_interest_before,
        ErrorCode::DefaultError,
        "cumulative_deposit_interest_after ({}) <= cumulative_deposit_interest_before ({})",
        cumulative_deposit_interest_after,
        cumulative_deposit_interest_before
    )?;

    spot_market.cumulative_deposit_interest = cumulative_deposit_interest_after;

    controller::token::receive(
        &ctx.accounts.token_program,
        &ctx.accounts.source_vault,
        &ctx.accounts.spot_market_vault,
        &ctx.accounts.admin.to_account_info(),
        amount,
        &mint,
        if spot_market.has_transfer_hook() {
            Some(remaining_accounts_iter)
        } else {
            None
        },
    )?;

    ctx.accounts.spot_market_vault.reload()?;
    validate_spot_market_vault_amount(spot_market, ctx.accounts.spot_market_vault.amount)?;

    spot_market.validate_max_token_deposits_and_borrows(false)?;

    emit!(SpotMarketVaultDepositRecord {
        ts: Clock::get()?.unix_timestamp,
        market_index: spot_market.market_index,
        deposit_balance: spot_market.deposit_balance,
        cumulative_deposit_interest_before,
        cumulative_deposit_interest_after,
        deposit_token_amount_before: deposit_token_amount_before.cast()?,
        amount
    });

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

    msg!(
        "updating perp market {} margin ratio",
        perp_market.market_index
    );

    perp_market.amm.validate_compatible_with_margin_ratio(
        margin_ratio_initial,
        margin_ratio_maintenance,
        perp_market.liquidator_fee,
    )?;

    msg!(
        "perp_market.margin_ratio_initial: {:?} -> {:?}",
        perp_market.margin_ratio_initial,
        margin_ratio_initial
    );

    msg!(
        "perp_market.margin_ratio_maintenance: {:?} -> {:?}",
        perp_market.margin_ratio_maintenance,
        margin_ratio_maintenance
    );

    perp_market.margin_ratio_initial = margin_ratio_initial;
    perp_market.margin_ratio_maintenance = margin_ratio_maintenance;
    Ok(())
}

#[access_control(
    perp_market_valid(&ctx.accounts.perp_market)
)]
pub fn handle_update_perp_market_funding_period(
    ctx: Context<AdminUpdatePerpMarket>,
    funding_period: i64,
) -> Result<()> {
    let perp_market = &mut load_mut!(ctx.accounts.perp_market)?;

    msg!(
        "updating funding period for perp market {}",
        perp_market.market_index
    );

    validate!(funding_period >= 0, ErrorCode::DefaultError)?;

    msg!(
        "perp_market.funding_period: {:?} -> {:?}",
        perp_market.market_stats.funding_period,
        funding_period
    );

    perp_market.market_stats.funding_period = funding_period;
    Ok(())
}

#[access_control(
    perp_market_valid(&ctx.accounts.perp_market)
)]
pub fn handle_update_perp_market_funding_dead_zone(
    ctx: Context<AdminUpdatePerpMarket>,
    funding_clamp_threshold: u32,
    funding_ramp_slope: u32,
) -> Result<()> {
    let perp_market = &mut load_mut!(ctx.accounts.perp_market)?;

    msg!(
        "updating funding dead zone for perp market {}",
        perp_market.market_index
    );

    // threshold is a fraction of the oracle price; keep it well below 100%
    validate!(
        funding_clamp_threshold < BPS_PRECISION,
        ErrorCode::DefaultError
    )?;
    // a zero slope would flatten every premium past the band to the offset
    validate!(funding_ramp_slope > 0, ErrorCode::DefaultError)?;

    msg!(
        "perp_market.funding_clamp_threshold: {:?} -> {:?}",
        perp_market.funding_clamp_threshold,
        funding_clamp_threshold
    );

    msg!(
        "perp_market.funding_ramp_slope: {:?} -> {:?}",
        perp_market.funding_ramp_slope,
        funding_ramp_slope
    );

    perp_market.funding_clamp_threshold = funding_clamp_threshold;
    perp_market.funding_ramp_slope = funding_ramp_slope;
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

    msg!(
        "updating perp market {} max imbalances",
        perp_market.market_index
    );

    let max_insurance_for_tier = match perp_market.contract_tier {
        ContractTier::A => INSURANCE_A_MAX,
        ContractTier::B => INSURANCE_B_MAX,
        ContractTier::C => INSURANCE_C_MAX,
        ContractTier::Speculative => INSURANCE_SPECULATIVE_MAX,
        ContractTier::HighlySpeculative => INSURANCE_SPECULATIVE_MAX,
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
    msg!("perp_market.name: {:?} -> {:?}", perp_market.name, name);
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
    msg!("spot_market.name: {:?} -> {:?}", spot_market.name, name);
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
    protocol_liquidation_fee: u32,
) -> Result<()> {
    let perp_market = &mut load_mut!(ctx.accounts.perp_market)?;

    msg!(
        "updating perp market {} liquidation fee",
        perp_market.market_index
    );

    validate!(
        liquidator_fee
            .safe_add(if_liquidation_fee)?
            .safe_add(protocol_liquidation_fee)?
            < LIQUIDATION_FEE_PRECISION,
        ErrorCode::DefaultError,
        "Total liquidation fee must be less than 100%"
    )?;

    validate!(
        if_liquidation_fee < LIQUIDATION_FEE_PRECISION,
        ErrorCode::DefaultError,
        "If liquidation fee must be less than 100%"
    )?;

    validate!(
        protocol_liquidation_fee <= LIQUIDATION_FEE_PRECISION / 10,
        ErrorCode::DefaultError,
        "protocol_liquidation_fee must be <= 10%"
    )?;

    perp_market.amm.validate_compatible_with_liquidation_fee(
        perp_market.margin_ratio_initial,
        perp_market.margin_ratio_maintenance,
        liquidator_fee,
    )?;

    msg!(
        "perp_market.liquidator_fee: {:?} -> {:?}",
        perp_market.liquidator_fee,
        liquidator_fee
    );

    msg!(
        "perp_market.if_liquidation_fee: {:?} -> {:?}",
        perp_market.if_liquidation_fee,
        if_liquidation_fee
    );

    msg!(
        "perp_market.protocol_liquidation_fee: {:?} -> {:?}",
        perp_market.protocol_liquidation_fee,
        protocol_liquidation_fee
    );

    perp_market.liquidator_fee = liquidator_fee;
    perp_market.if_liquidation_fee = if_liquidation_fee;
    perp_market.protocol_liquidation_fee = protocol_liquidation_fee;
    Ok(())
}

#[access_control(
    perp_market_valid(&ctx.accounts.perp_market)
)]
pub fn handle_update_perp_lp_pool_id(
    ctx: Context<AdminUpdatePerpMarket>,
    lp_pool_id: u8,
) -> Result<()> {
    let perp_market = &mut load_mut!(ctx.accounts.perp_market)?;

    msg!(
        "updating perp market {} lp pool id: {} -> {}",
        perp_market.market_index,
        perp_market.hedge_config.pool_id,
        lp_pool_id
    );
    perp_market.hedge_config.pool_id = lp_pool_id;
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

    msg!("updating spot market {} IF unstaking period");
    msg!(
        "spot_market.insurance_fund.unstaking_period: {:?} -> {:?}",
        spot_market.insurance_fund.unstaking_period,
        insurance_fund_unstaking_period
    );

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
    protocol_liquidation_fee: u32,
) -> Result<()> {
    let spot_market = &mut load_mut!(ctx.accounts.spot_market)?;
    msg!(
        "updating spot market {} liquidation fee",
        spot_market.market_index
    );

    validate!(
        liquidator_fee
            .safe_add(if_liquidation_fee)?
            .safe_add(protocol_liquidation_fee)?
            < LIQUIDATION_FEE_PRECISION,
        ErrorCode::DefaultError,
        "Total liquidation fee must be less than 100%"
    )?;

    validate!(
        if_liquidation_fee <= LIQUIDATION_FEE_PRECISION / 10,
        ErrorCode::DefaultError,
        "if_liquidation_fee must be <= 10%"
    )?;

    validate!(
        protocol_liquidation_fee <= LIQUIDATION_FEE_PRECISION / 10,
        ErrorCode::DefaultError,
        "protocol_liquidation_fee must be <= 10%"
    )?;

    msg!(
        "spot_market.liquidator_fee: {:?} -> {:?}",
        spot_market.liquidator_fee,
        liquidator_fee
    );

    msg!(
        "spot_market.if_liquidation_fee: {:?} -> {:?}",
        spot_market.if_liquidation_fee,
        if_liquidation_fee
    );

    msg!(
        "spot_market.protocol_liquidation_fee: {:?} -> {:?}",
        spot_market.protocol_liquidation_fee,
        protocol_liquidation_fee
    );

    spot_market.liquidator_fee = liquidator_fee;
    spot_market.if_liquidation_fee = if_liquidation_fee;
    spot_market.protocol_liquidation_fee = protocol_liquidation_fee;
    Ok(())
}

#[access_control(
    spot_market_valid(&ctx.accounts.spot_market)
)]
pub fn handle_update_withdraw_guard_threshold(
    ctx: Context<AdminUpdateSpotMarketWithdrawGuardThreshold>,
    withdraw_guard_threshold: u64,
) -> Result<()> {
    let spot_market = &mut load_mut!(ctx.accounts.spot_market)?;
    msg!(
        "updating spot market withdraw guard threshold {}",
        spot_market.market_index
    );

    let oracle_price = get_oracle_price(
        &spot_market.oracle_source,
        &ctx.accounts.oracle,
        Clock::get()?.slot,
    )?
    .price;

    // price the notional cap with the max of the live price and the 5min
    // twap so a momentarily manipulated-down oracle can't let an oversized
    // threshold through
    let strict_oracle_price = StrictOraclePrice::new(
        oracle_price,
        spot_market
            .historical_oracle_data
            .last_oracle_price_twap_5min,
        true,
    );
    strict_oracle_price.validate()?;

    validate_withdraw_guard_threshold(
        withdraw_guard_threshold,
        spot_market.decimals,
        strict_oracle_price.max(),
    )?;

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
/// Set the lending-gain carveouts: `if_fee_factor` (to the insurance fund) and
/// `protocol_fee_factor` (to the withdrawable protocol fee pool). Lenders receive
/// deposit interest net of both.
pub fn handle_update_spot_market_if_factor(
    ctx: Context<AdminUpdateSpotMarket>,
    spot_market_index: u16,
    if_fee_factor: u32,
    protocol_fee_factor: u32,
) -> Result<()> {
    let spot_market = &mut load_mut!(ctx.accounts.spot_market)?;

    msg!("spot market {}", spot_market.market_index);

    validate!(
        spot_market.market_index == spot_market_index,
        ErrorCode::DefaultError,
        "spot_market_index dne spot_market.index"
    )?;

    // Strictly less than 100%: lenders must keep a nonzero configured share.
    // At a full 100% carveout `deposit_interest_for_lenders` is 0, which skips
    // the entire accrual block in `update_spot_market_cumulative_interest` —
    // freezing borrower interest, the interest timestamp, and even the IF /
    // protocol pool credits themselves. A strict `<` keeps the lender cut >= 1
    // whenever deposit interest accrues, so the block always runs.
    validate!(
        if_fee_factor.safe_add(protocol_fee_factor)? < IF_FACTOR_PRECISION.cast()?,
        ErrorCode::DefaultError,
        "if_fee_factor + protocol_fee_factor must be < 100%"
    )?;

    msg!(
        "spot_market.if_fee_factor: {:?} -> {:?}",
        spot_market.insurance_fund.if_fee_factor,
        if_fee_factor
    );

    msg!(
        "spot_market.protocol_fee_factor: {:?} -> {:?}",
        spot_market.protocol_fee_factor,
        protocol_fee_factor
    );

    spot_market.insurance_fund.if_fee_factor = if_fee_factor;
    spot_market.protocol_fee_factor = protocol_fee_factor;

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
    msg!("spot market {}", spot_market.market_index);

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
    let spot_market = &mut load_mut!(ctx.accounts.spot_market)?;
    msg!("spot market {}", spot_market.market_index);

    msg!(
        "spot_market.status: {:?} -> {:?}",
        spot_market.status,
        status
    );

    spot_market.status = status;
    Ok(())
}

#[access_control(
spot_market_valid(&ctx.accounts.spot_market)
)]
pub fn handle_update_spot_market_paused_operations(
    ctx: Context<PauseAdminUpdateSpotMarket>,
    paused_operations: u8,
) -> Result<()> {
    let spot_market = &mut load_mut!(ctx.accounts.spot_market)?;
    msg!("spot market {}", spot_market.market_index);

    let signer = ctx.accounts.admin.key();
    let state = ctx.accounts.state.load()?;
    require_pause_only_added(
        &signer,
        &state,
        spot_market.paused_operations,
        paused_operations,
    )?;
    drop(state);

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
    msg!("spot market {}", spot_market.market_index);

    if spot_market.initial_asset_weight > 0 {
        validate!(
            matches!(asset_tier, AssetTier::Collateral | AssetTier::Protected),
            ErrorCode::DefaultError,
            "initial_asset_weight > 0 so AssetTier must be collateral or protected"
        )?;
    }

    msg!(
        "spot_market.asset_tier: {:?} -> {:?}",
        spot_market.asset_tier,
        asset_tier
    );

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
    msg!("spot market {}", spot_market.market_index);

    validate_margin_weights(
        spot_market.market_index,
        initial_asset_weight,
        maintenance_asset_weight,
        initial_liability_weight,
        maintenance_liability_weight,
        imf_factor,
    )?;

    msg!(
        "spot_market.initial_asset_weight: {:?} -> {:?}",
        spot_market.initial_asset_weight,
        initial_asset_weight
    );

    msg!(
        "spot_market.maintenance_asset_weight: {:?} -> {:?}",
        spot_market.maintenance_asset_weight,
        maintenance_asset_weight
    );

    msg!(
        "spot_market.initial_liability_weight: {:?} -> {:?}",
        spot_market.initial_liability_weight,
        initial_liability_weight
    );

    msg!(
        "spot_market.maintenance_liability_weight: {:?} -> {:?}",
        spot_market.maintenance_liability_weight,
        maintenance_liability_weight
    );

    msg!(
        "spot_market.imf_factor: {:?} -> {:?}",
        spot_market.imf_factor,
        imf_factor
    );

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
    min_borrow_rate: Option<u8>,
) -> Result<()> {
    let spot_market = &mut load_mut!(ctx.accounts.spot_market)?;
    msg!("spot market {}", spot_market.market_index);

    validate_borrow_rate(
        optimal_utilization,
        optimal_borrow_rate,
        max_borrow_rate,
        min_borrow_rate
            .unwrap_or(spot_market.min_borrow_rate)
            .cast::<u32>()?
            * ((PERCENTAGE_PRECISION / 200) as u32),
    )?;

    msg!(
        "spot_market.optimal_utilization: {:?} -> {:?}",
        spot_market.optimal_utilization,
        optimal_utilization
    );

    msg!(
        "spot_market.optimal_borrow_rate: {:?} -> {:?}",
        spot_market.optimal_borrow_rate,
        optimal_borrow_rate
    );

    msg!(
        "spot_market.max_borrow_rate: {:?} -> {:?}",
        spot_market.max_borrow_rate,
        max_borrow_rate
    );

    spot_market.optimal_utilization = optimal_utilization;
    spot_market.optimal_borrow_rate = optimal_borrow_rate;
    spot_market.max_borrow_rate = max_borrow_rate;

    if let Some(min_borrow_rate) = min_borrow_rate {
        msg!(
            "spot_market.min_borrow_rate: {:?} -> {:?}",
            spot_market.min_borrow_rate,
            min_borrow_rate
        );
        spot_market.min_borrow_rate = min_borrow_rate
    }

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
    msg!("spot market {}", spot_market.market_index);

    msg!(
        "spot_market.max_token_deposits: {:?} -> {:?}",
        spot_market.max_token_deposits,
        max_token_deposits
    );

    spot_market.max_token_deposits = max_token_deposits;
    Ok(())
}

#[access_control(
    spot_market_valid(&ctx.accounts.spot_market)
)]
pub fn handle_update_spot_market_max_token_borrows(
    ctx: Context<AdminUpdateSpotMarket>,
    max_token_borrows_fraction: u16,
) -> Result<()> {
    let spot_market = &mut load_mut!(ctx.accounts.spot_market)?;
    msg!("spot market {}", spot_market.market_index);

    msg!(
        "spot_market.max_token_borrows_fraction: {:?} -> {:?}",
        spot_market.max_token_borrows_fraction,
        max_token_borrows_fraction
    );

    let current_spot_tokens_borrows: u64 = spot_market.get_borrows()?.cast()?;
    let new_max_token_borrows = spot_market
        .max_token_deposits
        .safe_mul(max_token_borrows_fraction.cast()?)?
        .safe_div(10000)?;

    validate!(
        current_spot_tokens_borrows <= new_max_token_borrows,
        ErrorCode::InvalidSpotMarketInitialization,
        "spot borrows {} > max_token_borrows {}",
        current_spot_tokens_borrows,
        max_token_borrows_fraction
    )?;

    spot_market.max_token_borrows_fraction = max_token_borrows_fraction;
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
    msg!("spot market {}", spot_market.market_index);

    msg!(
        "spot_market.scale_initial_asset_weight_start: {:?} -> {:?}",
        spot_market.scale_initial_asset_weight_start,
        scale_initial_asset_weight_start
    );

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
    msg!("spot market {}", spot_market.market_index);

    msg!(
        "spot_market.orders_enabled: {:?} -> {:?}",
        spot_market.orders_enabled,
        orders_enabled
    );

    spot_market.orders_enabled = orders_enabled;
    Ok(())
}

#[access_control(
    spot_market_valid(&ctx.accounts.spot_market)
)]
pub fn handle_update_spot_market_if_paused_operations(
    ctx: Context<PauseAdminUpdateSpotMarket>,
    paused_operations: u8,
) -> Result<()> {
    let spot_market = &mut load_mut!(ctx.accounts.spot_market)?;
    let signer = ctx.accounts.admin.key();
    let state = ctx.accounts.state.load()?;
    require_pause_only_added(
        &signer,
        &state,
        spot_market.if_paused_operations,
        paused_operations,
    )?;
    drop(state);
    spot_market.if_paused_operations = paused_operations;
    msg!("spot market {}", spot_market.market_index);
    InsuranceFundOperation::log_all_operations_paused(paused_operations);
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

    let perp_market = &mut load_mut!(ctx.accounts.perp_market)?;

    msg!("perp market {}", perp_market.market_index);

    msg!(
        "perp_market.status: {:?} -> {:?}",
        perp_market.status,
        status
    );

    perp_market.status = status;
    Ok(())
}

#[access_control(
    perp_market_valid(&ctx.accounts.perp_market)
)]
pub fn handle_update_perp_market_paused_operations(
    ctx: Context<PauseAdminUpdatePerpMarket>,
    paused_operations: u8,
) -> Result<()> {
    let perp_market = &mut load_mut!(ctx.accounts.perp_market)?;
    msg!("perp market {}", perp_market.market_index);

    // Authority matrix for perp paused_operations:
    //   * cold       — may set any value (full unpause + pause)
    //   * warm       — may only flip the UpdateFunding / SettleRevPool bits;
    //                  all other pause bits must be preserved
    //   * pause_admin — may set any bit but only *add* bits (no unpause)
    let signer = ctx.accounts.admin.key();
    let state = ctx.accounts.state.load()?;
    let is_cold = state.is_cold(&signer);
    let is_pause_admin = state.pause_admin != Pubkey::default() && state.pause_admin == signer;
    if !is_cold && !is_pause_admin {
        validate!(
            PerpOperation::is_warm_update_allowed(perp_market.paused_operations, paused_operations),
            ErrorCode::DefaultError,
            "warm admin may only change the UpdateFunding / SettleRevPool pause bits",
        )?;
    }
    require_pause_only_added(
        &signer,
        &state,
        perp_market.paused_operations,
        paused_operations,
    )?;
    drop(state);

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
    msg!("perp market {}", perp_market.market_index);

    msg!(
        "perp_market.contract_tier: {:?} -> {:?}",
        perp_market.contract_tier,
        contract_tier
    );

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
    msg!("perp market {}", perp_market.market_index);

    msg!(
        "perp_market.imf_factor: {:?} -> {:?}",
        perp_market.imf_factor,
        imf_factor
    );

    msg!(
        "perp_market.unrealized_pnl_imf_factor: {:?} -> {:?}",
        perp_market.unrealized_pnl_imf_factor,
        unrealized_pnl_imf_factor
    );

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
    msg!("perp market {}", perp_market.market_index);

    msg!(
        "perp_market.unrealized_initial_asset_weight: {:?} -> {:?}",
        perp_market.unrealized_pnl_initial_asset_weight,
        unrealized_initial_asset_weight
    );

    msg!(
        "perp_market.unrealized_maintenance_asset_weight: {:?} -> {:?}",
        perp_market.unrealized_pnl_maintenance_asset_weight,
        unrealized_maintenance_asset_weight
    );

    perp_market.unrealized_pnl_initial_asset_weight = unrealized_initial_asset_weight;
    perp_market.unrealized_pnl_maintenance_asset_weight = unrealized_maintenance_asset_weight;
    Ok(())
}

pub fn handle_update_perp_fee_structure(
    ctx: Context<AdminUpdateState>,
    fee_structure: FeeStructure,
) -> Result<()> {
    validate_fee_structure(&fee_structure)?;

    msg!(
        "perp_fee_structure: {:?} -> {:?}",
        ctx.accounts.state.load()?.perp_fee_structure,
        fee_structure
    );

    ctx.accounts.state.load_mut()?.perp_fee_structure = fee_structure;
    Ok(())
}

pub fn handle_update_spot_fee_structure(
    ctx: Context<AdminUpdateState>,
    fee_structure: FeeStructure,
) -> Result<()> {
    validate_fee_structure(&fee_structure)?;

    msg!(
        "spot_fee_structure: {:?} -> {:?}",
        ctx.accounts.state.load()?.spot_fee_structure,
        fee_structure
    );

    ctx.accounts.state.load_mut()?.spot_fee_structure = fee_structure;
    Ok(())
}

pub fn handle_update_initial_pct_to_liquidate(
    ctx: Context<AdminUpdateState>,
    initial_pct_to_liquidate: u16,
) -> Result<()> {
    msg!(
        "initial_pct_to_liquidate: {} -> {}",
        ctx.accounts.state.load()?.initial_pct_to_liquidate,
        initial_pct_to_liquidate
    );

    ctx.accounts.state.load_mut()?.initial_pct_to_liquidate = initial_pct_to_liquidate;
    Ok(())
}

pub fn handle_update_liquidation_duration(
    ctx: Context<AdminUpdateState>,
    liquidation_duration: u8,
) -> Result<()> {
    msg!(
        "liquidation_duration: {} -> {}",
        ctx.accounts.state.load()?.liquidation_duration,
        liquidation_duration
    );

    ctx.accounts.state.load_mut()?.liquidation_duration = liquidation_duration;
    Ok(())
}

pub fn handle_update_liquidation_margin_buffer_ratio(
    ctx: Context<AdminUpdateState>,
    liquidation_margin_buffer_ratio: u32,
) -> Result<()> {
    msg!(
        "liquidation_margin_buffer_ratio: {} -> {}",
        ctx.accounts.state.load()?.liquidation_margin_buffer_ratio,
        liquidation_margin_buffer_ratio
    );

    ctx.accounts
        .state
        .load_mut()?
        .liquidation_margin_buffer_ratio = liquidation_margin_buffer_ratio;
    Ok(())
}

pub fn handle_update_oracle_guard_rails(
    ctx: Context<AdminUpdateState>,
    oracle_guard_rails: OracleGuardRails,
) -> Result<()> {
    msg!(
        "oracle_guard_rails: {:?} -> {:?}",
        ctx.accounts.state.load()?.oracle_guard_rails,
        oracle_guard_rails
    );

    ctx.accounts.state.load_mut()?.oracle_guard_rails = oracle_guard_rails;
    Ok(())
}

pub fn handle_update_state_settlement_duration(
    ctx: Context<AdminUpdateState>,
    settlement_duration: u16,
) -> Result<()> {
    msg!(
        "settlement_duration: {} -> {}",
        ctx.accounts.state.load()?.settlement_duration,
        settlement_duration
    );

    ctx.accounts.state.load_mut()?.settlement_duration = settlement_duration;
    Ok(())
}

pub fn handle_update_state_max_number_of_sub_accounts(
    ctx: Context<AdminUpdateState>,
    max_number_of_sub_accounts: u16,
) -> Result<()> {
    msg!(
        "max_number_of_sub_accounts: {} -> {}",
        ctx.accounts.state.load()?.max_number_of_sub_accounts,
        max_number_of_sub_accounts
    );

    ctx.accounts.state.load_mut()?.max_number_of_sub_accounts = max_number_of_sub_accounts;
    Ok(())
}

pub fn handle_update_state_max_initialize_user_fee(
    ctx: Context<AdminUpdateState>,
    max_initialize_user_fee: u16,
) -> Result<()> {
    msg!(
        "max_initialize_user_fee: {} -> {}",
        ctx.accounts.state.load()?.max_initialize_user_fee,
        max_initialize_user_fee
    );

    ctx.accounts.state.load_mut()?.max_initialize_user_fee = max_initialize_user_fee;
    Ok(())
}

#[access_control(
    perp_market_valid(&ctx.accounts.perp_market)
)]
pub fn handle_update_perp_market_oracle(
    ctx: Context<AdminUpdatePerpMarketOracle>,
    oracle: Pubkey,
    oracle_source: OracleSource,
    skip_invariant_check: bool,
) -> Result<()> {
    let perp_market = &mut load_mut!(ctx.accounts.perp_market)?;
    let amm_cache = &mut ctx.accounts.amm_cache;
    msg!("perp market {}", perp_market.market_index);

    let clock = Clock::get()?;

    validate_supported_market_oracle_source(oracle_source)?;

    OracleMap::validate_oracle_account_info(&ctx.accounts.oracle)?;

    validate!(
        ctx.accounts.oracle.key == &oracle,
        ErrorCode::DefaultError,
        "oracle account info ({:?}) and ix data ({:?}) must match",
        ctx.accounts.oracle.key,
        oracle
    )?;

    validate!(
        ctx.accounts.old_oracle.key == &perp_market.oracle,
        ErrorCode::DefaultError,
        "old oracle account info ({:?}) and perp market oracle ({:?}) must match",
        ctx.accounts.old_oracle.key,
        perp_market.oracle
    )?;

    // Verify new oracle is readable
    let OraclePriceData {
        price: new_oracle_price,
        delay: _oracle_delay,
        ..
    } = get_oracle_price(&oracle_source, &ctx.accounts.oracle, clock.slot)?;

    msg!(
        "perp_market.oracle: {:?} -> {:?}",
        perp_market.oracle,
        oracle
    );

    msg!(
        "perp_market.oracle_source: {:?} -> {:?}",
        perp_market.oracle_source,
        oracle_source
    );

    let OraclePriceData {
        price: old_oracle_price,
        ..
    } = get_oracle_price(
        &perp_market.oracle_source,
        &ctx.accounts.old_oracle,
        clock.slot,
    )?;

    msg!(
        "Oracle Price: {:?} -> {:?}",
        old_oracle_price,
        new_oracle_price
    );

    if !skip_invariant_check {
        validate!(
            new_oracle_price > 0,
            ErrorCode::DefaultError,
            "invalid oracle price, must be greater than 0"
        )?;

        let oracle_change_divergence = new_oracle_price
            .safe_sub(old_oracle_price)?
            .safe_mul(PERCENTAGE_PRECISION_I64)?
            .safe_div(old_oracle_price)?;

        validate!(
            oracle_change_divergence.abs() < (PERCENTAGE_PRECISION_I64 / 10),
            ErrorCode::DefaultError,
            "invalid new oracle price, more than 10% divergence"
        )?;
    }

    perp_market.oracle = oracle;
    perp_market.oracle_source = oracle_source;

    if amm_cache
        .cache
        .iter()
        .any(|cache_info| cache_info.market_index == perp_market.market_index)
    {
        amm_cache.update_perp_market_fields(perp_market)?;
    }

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
    msg!("perp market {}", perp_market.market_index);

    validate!(step_size > 0 && tick_size > 0, ErrorCode::DefaultError)?;
    validate!(step_size <= 2000000000, ErrorCode::DefaultError)?; // below i32 max for lp's remainder_base_asset

    msg!(
        "perp_market.order_step_size: {:?} -> {:?}",
        perp_market.order_step_size,
        step_size
    );

    msg!(
        "perp_market.order_tick_size: {:?} -> {:?}",
        perp_market.order_tick_size,
        tick_size
    );

    perp_market.order_step_size = step_size;
    perp_market.order_tick_size = tick_size;
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
    msg!("perp market {}", perp_market.market_index);

    validate!(order_size > 0, ErrorCode::DefaultError)?;

    msg!(
        "perp_market.min_order_size: {:?} -> {:?}",
        perp_market.market_stats.min_order_size,
        order_size
    );

    perp_market.market_stats.min_order_size = order_size;
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
    msg!("spot market {}", spot_market.market_index);

    validate!(
        spot_market.market_index == 0 || step_size > 0 && tick_size > 0,
        ErrorCode::DefaultError
    )?;

    msg!(
        "spot_market.order_step_size: {:?} -> {:?}",
        spot_market.order_step_size,
        step_size
    );

    msg!(
        "spot_market.order_tick_size: {:?} -> {:?}",
        spot_market.order_tick_size,
        tick_size
    );

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
    msg!("spot market {}", spot_market.market_index);

    validate!(
        spot_market.market_index == 0 || order_size > 0,
        ErrorCode::DefaultError
    )?;

    msg!(
        "spot_market.min_order_size: {:?} -> {:?}",
        spot_market.min_order_size,
        order_size
    );

    spot_market.min_order_size = order_size;
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
    msg!("perp market {}", perp_market.market_index);

    validate!(
        is_multiple_of_step_size(
            max_open_interest.cast::<u64>()?,
            perp_market.order_step_size
        )?,
        ErrorCode::DefaultError,
        "max oi not a multiple of the step size"
    )?;

    msg!(
        "perp_market.max_open_interest: {:?} -> {:?}",
        perp_market.max_open_interest,
        max_open_interest
    );

    perp_market.max_open_interest = max_open_interest;
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
    msg!("perp market {}", perp_market.market_index);

    validate!(
        fee_adjustment.unsigned_abs().cast::<u64>()? <= FEE_ADJUSTMENT_MAX,
        ErrorCode::DefaultError,
        "fee adjustment {} greater than max {}",
        fee_adjustment,
        FEE_ADJUSTMENT_MAX
    )?;

    msg!(
        "perp_market.fee_adjustment: {:?} -> {:?}",
        perp_market.fee_adjustment,
        fee_adjustment
    );

    perp_market.fee_adjustment = fee_adjustment;
    Ok(())
}

pub fn handle_update_perp_market_fee_pool_buffer_target(
    ctx: Context<AdminUpdatePerpMarket>,
    fee_pool_buffer_target: u64,
) -> Result<()> {
    let perp_market = &mut load_mut!(ctx.accounts.perp_market)?;
    msg!("perp market {}", perp_market.market_index);

    msg!(
        "perp_market.fee_pool_buffer_target: {:?} -> {:?}",
        perp_market.fee_pool_buffer_target,
        fee_pool_buffer_target
    );

    perp_market.fee_pool_buffer_target = fee_pool_buffer_target;
    Ok(())
}

pub fn handle_update_perp_market_number_of_users(
    ctx: Context<AdminUpdatePerpMarket>,
    number_of_users: Option<u32>,
    number_of_users_with_base: Option<u32>,
) -> Result<()> {
    let perp_market = &mut load_mut!(ctx.accounts.perp_market)?;
    msg!("perp market {}", perp_market.market_index);

    if let Some(number_of_users) = number_of_users {
        msg!(
            "perp_market.number_of_users: {:?} -> {:?}",
            perp_market.number_of_users,
            number_of_users
        );
        perp_market.number_of_users = number_of_users;
    } else {
        msg!("perp_market.number_of_users: unchanged");
    }

    if let Some(number_of_users_with_base) = number_of_users_with_base {
        msg!(
            "perp_market.number_of_users_with_base: {:?} -> {:?}",
            perp_market.number_of_users_with_base,
            number_of_users_with_base
        );
        perp_market.number_of_users_with_base = number_of_users_with_base;
    } else {
        msg!("perp_market.number_of_users_with_base: unchanged");
    }

    validate!(
        perp_market.number_of_users >= perp_market.number_of_users_with_base,
        ErrorCode::DefaultError,
        "number_of_users must be >= number_of_users_with_base "
    )?;

    Ok(())
}

pub fn handle_update_perp_market_lp_pool_paused_operations(
    ctx: Context<PauseAdminUpdatePerpMarket>,
    lp_paused_operations: u8,
) -> Result<()> {
    let perp_market = &mut load_mut!(ctx.accounts.perp_market)?;
    msg!("perp market {}", perp_market.market_index);
    let signer = ctx.accounts.admin.key();
    let state = ctx.accounts.state.load()?;
    require_pause_only_added(
        &signer,
        &state,
        perp_market.hedge_config.paused_operations,
        lp_paused_operations,
    )?;
    drop(state);
    perp_market.hedge_config.paused_operations = lp_paused_operations;
    Ok(())
}

#[access_control(
    perp_market_valid(&ctx.accounts.perp_market)
)]
pub fn handle_update_perp_market_oracle_low_risk_slot_delay_override(
    ctx: Context<HotAdminUpdatePerpMarket>,
    oracle_low_risk_slot_delay_override: i8,
) -> Result<()> {
    let perp_market = &mut load_mut!(ctx.accounts.perp_market)?;
    msg!("perp market {}", perp_market.market_index);

    msg!(
        "perp_market.oracle_low_risk_slot_delay_override: {:?} -> {:?}",
        perp_market.oracle_low_risk_slot_delay_override,
        oracle_low_risk_slot_delay_override
    );

    perp_market.oracle_low_risk_slot_delay_override = oracle_low_risk_slot_delay_override;
    Ok(())
}

#[access_control(
    perp_market_valid(&ctx.accounts.perp_market)
)]
pub fn handle_update_perp_market_oracle_slot_delay_override(
    ctx: Context<HotAdminUpdatePerpMarket>,
    oracle_slot_delay_override: i8,
) -> Result<()> {
    let perp_market = &mut load_mut!(ctx.accounts.perp_market)?;
    msg!("perp market {}", perp_market.market_index);

    msg!(
        "perp_market.oracle_slot_delay_override: {:?} -> {:?}",
        perp_market.oracle_slot_delay_override,
        oracle_slot_delay_override
    );

    perp_market.oracle_slot_delay_override = oracle_slot_delay_override;
    Ok(())
}

#[access_control(
    spot_market_valid(&ctx.accounts.spot_market)
)]
pub fn handle_update_spot_market_fee_adjustment(
    ctx: Context<AdminUpdateSpotMarket>,
    fee_adjustment: i16,
) -> Result<()> {
    let spot = &mut load_mut!(ctx.accounts.spot_market)?;
    msg!("spot market {}", spot.market_index);

    validate!(
        fee_adjustment.unsigned_abs().cast::<u64>()? <= FEE_ADJUSTMENT_MAX,
        ErrorCode::DefaultError,
        "fee adjustment {} greater than max {}",
        fee_adjustment,
        FEE_ADJUSTMENT_MAX
    )?;

    msg!(
        "spot_market.fee_adjustment: {:?} -> {:?}",
        spot.fee_adjustment,
        fee_adjustment
    );

    spot.fee_adjustment = fee_adjustment;
    Ok(())
}

pub fn handle_update_admin(ctx: Context<ColdAdminUpdateState>, admin: Pubkey) -> Result<()> {
    msg!(
        "admin: {:?} -> {:?}",
        ctx.accounts.state.load()?.cold_admin,
        admin
    );
    ctx.accounts.state.load_mut()?.cold_admin = admin;
    Ok(())
}

pub fn handle_update_whitelist_mint(
    ctx: Context<AdminUpdateState>,
    whitelist_mint: Pubkey,
) -> Result<()> {
    msg!(
        "whitelist_mint: {:?} -> {:?}",
        ctx.accounts.state.load()?.whitelist_mint,
        whitelist_mint
    );

    ctx.accounts.state.load_mut()?.whitelist_mint = whitelist_mint;
    Ok(())
}

pub fn handle_update_discount_mint(
    ctx: Context<AdminUpdateState>,
    discount_mint: Pubkey,
) -> Result<()> {
    msg!(
        "discount_mint: {:?} -> {:?}",
        ctx.accounts.state.load()?.discount_mint,
        discount_mint
    );

    ctx.accounts.state.load_mut()?.discount_mint = discount_mint;
    Ok(())
}

pub fn handle_update_exchange_status(
    ctx: Context<PauseAdminUpdateState>,
    exchange_status: u8,
) -> Result<()> {
    let signer = ctx.accounts.admin.key();
    let mut state = ctx.accounts.state.load_mut()?;
    require_pause_only_added(&signer, &state, state.exchange_status, exchange_status)?;
    msg!(
        "exchange_status: {:?} -> {:?}",
        state.exchange_status,
        exchange_status
    );
    state.exchange_status = exchange_status;
    Ok(())
}

pub fn handle_update_solvency_status(
    ctx: Context<ColdAdminUpdateState>,
    solvency_status: u8,
) -> Result<()> {
    let mut state = ctx.accounts.state.load_mut()?;
    msg!(
        "solvency_status: {:?} -> {:?}",
        state.solvency_status,
        solvency_status
    );
    state.solvency_status = solvency_status;
    Ok(())
}

pub fn handle_update_perp_auction_duration(
    ctx: Context<AdminUpdateState>,
    min_perp_auction_duration: u8,
) -> Result<()> {
    msg!(
        "min_perp_auction_duration: {:?} -> {:?}",
        ctx.accounts.state.load()?.min_perp_auction_duration,
        min_perp_auction_duration
    );

    ctx.accounts.state.load_mut()?.min_perp_auction_duration = min_perp_auction_duration;
    Ok(())
}

pub fn handle_update_spot_auction_duration(
    ctx: Context<AdminUpdateState>,
    default_spot_auction_duration: u8,
) -> Result<()> {
    msg!(
        "default_spot_auction_duration: {:?} -> {:?}",
        ctx.accounts.state.load()?.default_spot_auction_duration,
        default_spot_auction_duration
    );

    ctx.accounts.state.load_mut()?.default_spot_auction_duration = default_spot_auction_duration;
    Ok(())
}

pub fn handle_admin_update_user_stats_paused_operations(
    ctx: Context<PauseAdminUpdateUserStats>,
    paused_operations: u8,
) -> Result<()> {
    let mut user_stats = load_mut!(ctx.accounts.user_stats)?;

    // Authority matrix for user_stats.paused_operations:
    //   * cold / warm / hot_user_flag — full control (pause + unpause)
    //   * pause_admin                 — pause-only (may not clear bits)
    //
    // `is_hot(.., UserFlag)` already returns true for cold/warm; the negation
    // therefore isolates pause_admin specifically.
    let signer = ctx.accounts.admin.key();
    let state = ctx.accounts.state.load()?;
    if !state.is_hot(&signer, HotRole::UserFlag) {
        validate!(
            (user_stats.paused_operations & paused_operations) == user_stats.paused_operations,
            ErrorCode::Unauthorized,
            "pause_admin may not clear pause bits",
        )?;
    }
    drop(state);

    msg!(
        "user_stats.paused_operations: {:?} -> {:?}",
        user_stats.paused_operations,
        paused_operations
    );

    user_stats.paused_operations = paused_operations;
    Ok(())
}

pub fn handle_initialize_prelaunch_oracle(
    ctx: Context<InitializePrelaunchOracle>,
    params: PrelaunchOracleParams,
) -> Result<()> {
    let mut oracle = ctx.accounts.prelaunch_oracle.load_init()?;
    msg!("perp market {}", params.perp_market_index);

    oracle.perp_market_index = params.perp_market_index;
    if let Some(price) = params.price {
        oracle.price = price;
    }
    if let Some(max_price) = params.max_price {
        oracle.max_price = max_price;
    }

    oracle.validate()?;

    Ok(())
}

pub fn handle_update_prelaunch_oracle_params(
    ctx: Context<UpdatePrelaunchOracleParams>,
    params: PrelaunchOracleParams,
) -> Result<()> {
    let mut oracle = ctx.accounts.prelaunch_oracle.load_mut()?;
    let mut perp_market = ctx.accounts.perp_market.load_mut()?;
    msg!("perp market {}", perp_market.market_index);

    let now = Clock::get()?.unix_timestamp;

    if let Some(price) = params.price {
        oracle.price = price;

        msg!("before mark twap ts = {:?} mark twap = {:?} mark twap 5min = {:?} bid twap = {:?} ask twap {:?}", perp_market.market_stats.last_mark_price_twap_ts, perp_market.market_stats.last_mark_price_twap, perp_market.market_stats.last_mark_price_twap_5min, perp_market.market_stats.last_bid_price_twap, perp_market.market_stats.last_ask_price_twap);

        perp_market.market_stats.last_mark_price_twap_ts = now;
        perp_market.market_stats.last_mark_price_twap = price.cast()?;
        perp_market.market_stats.last_mark_price_twap_5min = price.cast()?;
        perp_market.market_stats.last_bid_price_twap = perp_market
            .market_stats
            .last_bid_price_twap
            .min(price.cast()?);
        perp_market.market_stats.last_ask_price_twap = perp_market
            .market_stats
            .last_ask_price_twap
            .max(price.cast()?);

        msg!("after mark twap ts = {:?} mark twap = {:?} mark twap 5min = {:?} bid twap = {:?} ask twap {:?}", perp_market.market_stats.last_mark_price_twap_ts, perp_market.market_stats.last_mark_price_twap, perp_market.market_stats.last_mark_price_twap_5min, perp_market.market_stats.last_bid_price_twap, perp_market.market_stats.last_ask_price_twap);
    } else {
        msg!("mark twap ts, mark twap, mark twap 5min, bid twap, ask twap: unchanged");
    }

    if let Some(max_price) = params.max_price {
        msg!("max price: {:?} -> {:?}", oracle.max_price, max_price);
        oracle.max_price = max_price;
    } else {
        msg!("max price: unchanged")
    }

    oracle.validate()?;

    Ok(())
}

pub fn handle_delete_prelaunch_oracle(
    ctx: Context<DeletePrelaunchOracle>,
    _perp_market_index: u16,
) -> Result<()> {
    let perp_market = ctx.accounts.perp_market.load()?;
    msg!("perp market {}", perp_market.market_index);

    validate!(
        perp_market.oracle != ctx.accounts.prelaunch_oracle.key(),
        ErrorCode::DefaultError,
        "prelaunch oracle currently in use"
    )?;

    Ok(())
}

pub fn handle_initialize_pyth_lazer_oracle(
    ctx: Context<InitPythLazerOracle>,
    feed_id: u32,
) -> Result<()> {
    let pubkey = ctx.accounts.lazer_oracle.to_account_info().key;
    msg!(
        "Lazer price feed initted {} with feed_id {}",
        pubkey,
        feed_id
    );
    Ok(())
}

pub fn handle_settle_expired_market<'c: 'info, 'info>(
    ctx: Context<'info, AdminUpdatePerpMarket<'info>>,
    market_index: u16,
) -> Result<()> {
    let clock = Clock::get()?;
    let _now = clock.unix_timestamp;
    let state = ctx.accounts.state.load()?;

    let AccountMaps {
        perp_market_map,
        spot_market_map,
        mut oracle_map,
    } = load_maps(
        &mut ctx.remaining_accounts.iter().peekable(),
        &get_writable_perp_market_set(market_index),
        &get_writable_spot_market_set(QUOTE_SPOT_MARKET_INDEX),
        clock.slot,
        Some(state.oracle_guard_rails),
    )?;

    // Refresh PerpMarket-level oracle stats only — settle_expired_market
    // reads `market.market_stats.historical_oracle_data` for the expiry
    // price, not AMM peg or reserves. The AMM refresh that used to fire
    // here was cargo-cult.
    {
        let mut perp_market = perp_market_map.get_ref_mut(&market_index)?;
        let oracle_price_data = oracle_map.get_price_data(&perp_market.oracle_id())?;
        let mm_oracle_price_data = perp_market.get_mm_oracle_price_data(
            *oracle_price_data,
            clock.slot,
            &state.oracle_guard_rails.validity,
        )?;
        let validity = crate::vlp::amm::refresh::compute_amm_refresh_validity(
            &perp_market,
            &mm_oracle_price_data,
            &state,
        )?;
        perp_market.update_oracle_derived_stats(
            &mm_oracle_price_data,
            validity,
            clock.unix_timestamp,
            clock.slot,
        )?;
    }

    crate::vlp::amm::refresh::settle_expired_market(
        market_index,
        &perp_market_map,
        &mut oracle_map,
        &spot_market_map,
        &state,
        &clock,
    )?;

    Ok(())
}

#[access_control(
    deposit_not_paused(&ctx.accounts.state)
)]
pub fn handle_admin_deposit<'c: 'info, 'info>(
    ctx: Context<'info, AdminDeposit<'info>>,
    market_index: u16,
    amount: u64,
) -> Result<()> {
    let user_key = ctx.accounts.user.key();
    let user = &mut load_mut!(ctx.accounts.user)?;

    let state = ctx.accounts.state.load()?;
    let clock = Clock::get()?;
    let now = clock.unix_timestamp;
    let slot = clock.slot;

    let remaining_accounts_iter = &mut ctx.remaining_accounts.iter().peekable();
    let AccountMaps {
        perp_market_map: _,
        spot_market_map,
        mut oracle_map,
    } = load_maps(
        remaining_accounts_iter,
        &MarketSet::new(),
        &get_writable_spot_market_set(market_index),
        clock.slot,
        Some(state.oracle_guard_rails),
    )?;

    let mint = get_token_mint(remaining_accounts_iter)?;

    if amount == 0 {
        return Err(ErrorCode::InsufficientDeposit.into());
    }

    validate!(!user.is_bankrupt(), ErrorCode::UserBankrupt)?;

    let mut spot_market = spot_market_map.get_ref_mut(&market_index)?;
    let oracle_price_data = *oracle_map.get_price_data(&spot_market.oracle_id())?;

    validate!(
        user.pool_id == spot_market.pool_id,
        ErrorCode::InvalidPoolId,
        "user pool id ({}) != market pool id ({})",
        user.pool_id,
        spot_market.pool_id
    )?;

    validate!(
        !matches!(spot_market.status, MarketStatus::Initialized),
        ErrorCode::MarketBeingInitialized,
        "Market is being initialized"
    )?;

    controller::spot_balance::update_spot_market_cumulative_interest(
        &mut spot_market,
        Some(&oracle_price_data),
        now,
    )?;

    let position_index = user.force_get_spot_position_index(spot_market.market_index)?;

    // if reduce only, have to compare ix amount to current borrow amount
    let amount = if (spot_market.is_reduce_only())
        && user.spot_positions[position_index].balance_type == SpotBalanceType::Borrow
    {
        user.spot_positions[position_index]
            .get_token_amount(&spot_market)?
            .cast::<u64>()?
            .min(amount)
    } else {
        amount
    };

    let total_deposits_after = user.total_deposits;
    let total_withdraws_after = user.total_withdraws;

    let spot_position = &mut user.spot_positions[position_index];
    controller::spot_position::update_spot_balances_and_cumulative_deposits(
        amount as u128,
        &SpotBalanceType::Deposit,
        &mut spot_market,
        spot_position,
        false,
        None,
    )?;

    let token_amount = spot_position.get_token_amount(&spot_market)?;
    if token_amount == 0 {
        validate!(
            spot_position.scaled_balance == 0,
            ErrorCode::InvalidSpotPosition,
            "deposit left user with invalid position. scaled balance = {} token amount = {}",
            spot_position.scaled_balance,
            token_amount
        )?;
    }

    if spot_position.balance_type == SpotBalanceType::Deposit && spot_position.scaled_balance > 0 {
        validate!(
            matches!(spot_market.status, MarketStatus::Active),
            ErrorCode::MarketActionPaused,
            "spot_market not active",
        )?;
    }

    drop(spot_market);

    user.update_last_active_slot(slot);

    let spot_market = &mut spot_market_map.get_ref_mut(&market_index)?;
    let user_token_amount_after = user.get_total_token_amount(spot_market)?;

    controller::token::receive(
        &ctx.accounts.token_program,
        &ctx.accounts.admin_token_account,
        &ctx.accounts.spot_market_vault,
        &ctx.accounts.admin,
        amount,
        &mint,
        if spot_market.has_transfer_hook() {
            Some(remaining_accounts_iter)
        } else {
            None
        },
    )?;
    ctx.accounts.spot_market_vault.reload()?;
    validate_spot_market_vault_amount(spot_market, ctx.accounts.spot_market_vault.amount)?;

    let deposit_record_id = get_then_update_id!(spot_market, next_deposit_record_id);
    let oracle_price = oracle_price_data.price;
    let deposit_record = DepositRecord {
        ts: now,
        deposit_record_id,
        user_authority: user.authority,
        user: user_key,
        direction: DepositDirection::Deposit,
        amount,
        oracle_price,
        market_deposit_balance: spot_market.deposit_balance,
        market_withdraw_balance: spot_market.borrow_balance,
        market_cumulative_deposit_interest: spot_market.cumulative_deposit_interest,
        market_cumulative_borrow_interest: spot_market.cumulative_borrow_interest,
        total_deposits_after,
        total_withdraws_after,
        market_index,
        explanation: DepositExplanation::Reward,
        transfer_user: None,
        signer: Some(ctx.accounts.admin.key()),
        user_token_amount_after,
    };
    emit!(deposit_record);

    spot_market.validate_max_token_deposits_and_borrows(false)?;

    Ok(())
}

pub fn handle_zero_mm_oracle_fields(ctx: Context<HotAdminUpdatePerpMarket>) -> Result<()> {
    let mut perp_market = load_mut!(ctx.accounts.perp_market)?;
    perp_market.market_stats.mm_oracle_price = 0;
    perp_market.market_stats.mm_oracle_sequence_id = 0;
    perp_market.market_stats.mm_oracle_slot = 0;
    Ok(())
}

pub fn handle_update_mm_oracle_native(accounts: &[AccountInfo], data: &[u8]) -> Result<()> {
    // Pre-Anchor native dispatch: re-establish the ownership + discriminator
    // guarantees Anchor would provide (see `crate::auth::require_native_account`)
    // before trusting any byte. Accounts:
    //   [0] perp_market (mut), [1] signer, [2] clock sysvar, [3] state.
    // State byte offsets (from account start, incl. 8-byte discriminator):
    //   hot_mm_oracle_crank: 360..392, feature_bit_flags: 1374
    // (guarded by `state/traits/tests.rs::native_instruction_offsets`).
    crate::auth::require_native_account(
        &accounts[3],
        State::DISCRIMINATOR,
        ErrorCode::InvalidNativeStateAccount,
    )?;
    crate::auth::require_native_account(
        &accounts[0],
        PerpMarket::DISCRIMINATOR,
        ErrorCode::InvalidNativePerpMarketAccount,
    )?;

    {
        let state = accounts[3].data.borrow();
        // Kill switch: admin can disable this ix via feature_bit_flags. Panic
        // (aborts the tx) to match the prior behavior.
        assert!(
            state[1374] & 1 > 0,
            "mm oracle update disabled by admin state"
        );

        #[cfg(not(feature = "anchor-test"))]
        {
            let signer_account = &accounts[1];
            let hot_key =
                anchor_lang::prelude::Pubkey::new_from_array(state[360..392].try_into().unwrap());
            require!(
                signer_account.is_signer && *signer_account.key == hot_key,
                ErrorCode::Unauthorized
            );
        }
    }

    if data[0..8] == [0u8; 8] {
        msg!("MM oracle price is zero, not updating");
        return Err(ErrorCode::DefaultError.into());
    }

    let mut perp_market_data = accounts[0].data.borrow_mut();
    let perp_market: &mut PerpMarket =
        bytemuck::from_bytes_mut(&mut perp_market_data[8..8 + std::mem::size_of::<PerpMarket>()]);
    // Sequence-id check uses only seq fields. Defer the rest.
    let incoming_sequence_id = u64::from_le_bytes(data[8..16].try_into().unwrap());
    if incoming_sequence_id <= perp_market.market_stats.mm_oracle_sequence_id {
        return Ok(());
    }

    // Slot comes from the passed Clock sysvar account, which we require to be the
    // real sysvar — an attacker-supplied account could carry an arbitrary slot
    // and defeat the staleness / slot-gap rate limits below.
    require_keys_eq!(
        *accounts[2].key,
        solana_program::sysvar::clock::ID,
        ErrorCode::DefaultError
    );
    let clock_data = accounts[2].data.borrow();
    let current_slot = u64::from_le_bytes(clock_data[0..8].try_into().unwrap());
    let perp_market_slot = perp_market.market_stats.mm_oracle_slot;

    if current_slot <= perp_market_slot {
        msg!(
            "mm oracle reject: stale slot {} <= {}",
            current_slot,
            perp_market_slot
        );
        return Ok(());
    }
    let slot_gap = current_slot - perp_market_slot;
    if slot_gap < MM_ORACLE_MIN_SLOT_GAP {
        msg!(
            "mm oracle reject: re-crank gap {} < {}",
            slot_gap,
            MM_ORACLE_MIN_SLOT_GAP
        );
        return Ok(());
    }

    // Step cap vs last accepted price. Bootstrap when prev == 0.
    let perp_market_price = perp_market.market_stats.mm_oracle_price;
    let incoming_price = i64::from_le_bytes(data[0..8].try_into().unwrap());
    if perp_market_price != 0 {
        let prev_abs = (perp_market_price as i128).abs();
        let diff_abs = ((incoming_price as i128) - (perp_market_price as i128)).abs();
        // Cross-multiply form of (diff_abs / prev_abs) > MAX_STEP / PCT
        if diff_abs * PERCENTAGE_PRECISION_I128 > MM_ORACLE_MAX_STEP_PCT_PRECISION * prev_abs {
            msg!(
                "mm oracle reject: step too large, incoming={} prev={}",
                incoming_price,
                perp_market_price
            );
            return Ok(());
        }
    }

    perp_market.market_stats.mm_oracle_slot = current_slot;
    perp_market.market_stats.mm_oracle_price = incoming_price;
    perp_market.market_stats.mm_oracle_sequence_id = incoming_sequence_id;

    Ok(())
}

pub fn handle_update_feature_bit_flags_mm_oracle(
    ctx: Context<HotAdminUpdateState>,
    enable: bool,
) -> Result<()> {
    let mut state = ctx.accounts.state.load_mut()?;
    if enable {
        validate!(
            ctx.accounts.admin.key().eq(&state.cold_admin),
            ErrorCode::DefaultError,
            "Only state admin can re-enable after kill switch"
        )?;

        msg!("Setting first bit to 1, enabling mm oracle update");
        state.feature_bit_flags |= FeatureBitFlags::MmOracleUpdate as u8;
    } else {
        msg!("Setting first bit to 0, disabling mm oracle update");
        state.feature_bit_flags &= !(FeatureBitFlags::MmOracleUpdate as u8);
    }
    Ok(())
}

pub fn handle_update_feature_bit_flags_median_trigger_price(
    ctx: Context<HotAdminUpdateState>,
    enable: bool,
) -> Result<()> {
    let mut state = ctx.accounts.state.load_mut()?;
    if enable {
        validate!(
            ctx.accounts.admin.key().eq(&state.cold_admin),
            ErrorCode::DefaultError,
            "Only state admin can re-enable after kill switch"
        )?;

        msg!("Setting second bit to 1, enabling median trigger price");
        state.feature_bit_flags |= FeatureBitFlags::MedianTriggerPrice as u8;
    } else {
        msg!("Setting second bit to 0, disabling median trigger price");
        state.feature_bit_flags &= !(FeatureBitFlags::MedianTriggerPrice as u8);
    }
    Ok(())
}

pub fn handle_update_feature_bit_flags_builder_codes(
    ctx: Context<HotAdminUpdateState>,
    enable: bool,
) -> Result<()> {
    let mut state = ctx.accounts.state.load_mut()?;
    if enable {
        validate!(
            ctx.accounts.admin.key().eq(&state.cold_admin),
            ErrorCode::DefaultError,
            "Only state admin can enable feature bit flags"
        )?;

        msg!("Setting 3rd bit to 1, enabling builder codes");
        state.feature_bit_flags |= FeatureBitFlags::BuilderCodes as u8;
    } else {
        msg!("Setting 3rd bit to 0, disabling builder codes");
        state.feature_bit_flags &= !(FeatureBitFlags::BuilderCodes as u8);
    }
    Ok(())
}

pub fn handle_update_feature_bit_flags_settle_lp_pool(
    ctx: Context<HotAdminUpdateState>,
    enable: bool,
) -> Result<()> {
    let mut state = ctx.accounts.state.load_mut()?;
    if enable {
        validate!(
            ctx.accounts.admin.key().eq(&state.cold_admin),
            ErrorCode::DefaultError,
            "Only state admin can re-enable after kill switch"
        )?;

        msg!("Setting first bit to 1, enabling settle LP pool");
        state.lp_pool_feature_bit_flags |= LpPoolFeatureBitFlags::SettleLpPool as u8;
    } else {
        msg!("Setting first bit to 0, disabling settle LP pool");
        state.lp_pool_feature_bit_flags &= !(LpPoolFeatureBitFlags::SettleLpPool as u8);
    }
    Ok(())
}

pub fn handle_update_feature_bit_flags_swap_lp_pool(
    ctx: Context<HotAdminUpdateState>,
    enable: bool,
) -> Result<()> {
    let mut state = ctx.accounts.state.load_mut()?;
    if enable {
        validate!(
            ctx.accounts.admin.key().eq(&state.cold_admin),
            ErrorCode::DefaultError,
            "Only state admin can re-enable after kill switch"
        )?;

        msg!("Setting second bit to 1, enabling swapping with LP pool");
        state.lp_pool_feature_bit_flags |= LpPoolFeatureBitFlags::SwapLpPool as u8;
    } else {
        msg!("Setting second bit to 0, disabling swapping with LP pool");
        state.lp_pool_feature_bit_flags &= !(LpPoolFeatureBitFlags::SwapLpPool as u8);
    }
    Ok(())
}

pub fn handle_update_feature_bit_flags_mint_redeem_lp_pool(
    ctx: Context<HotAdminUpdateState>,
    enable: bool,
) -> Result<()> {
    let mut state = ctx.accounts.state.load_mut()?;
    if enable {
        validate!(
            ctx.accounts.admin.key().eq(&state.cold_admin),
            ErrorCode::DefaultError,
            "Only state admin can re-enable after kill switch"
        )?;

        msg!("Setting third bit to 1, enabling minting and redeeming with LP pool");
        state.lp_pool_feature_bit_flags |= LpPoolFeatureBitFlags::MintRedeemLpPool as u8;
    } else {
        msg!("Setting third bit to 0, disabling minting and redeeming with LP pool");
        state.lp_pool_feature_bit_flags &= !(LpPoolFeatureBitFlags::MintRedeemLpPool as u8);
    }
    Ok(())
}

#[access_control(
    perp_market_valid(&ctx.accounts.perp_market)
)]
pub fn handle_update_perp_market_config(
    ctx: Context<HotAdminUpdatePerpMarket>,
    market_config: u8,
) -> Result<()> {
    let allowed_bits = MarketConfigFlag::DisableFormulaicKUpdate as u8;

    validate!(
        market_config & !allowed_bits == 0,
        ErrorCode::InvalidPerpMarketConfig,
        "unknown bits set in market_config: {:?}",
        market_config
    )?;

    let perp_market = &mut load_mut!(ctx.accounts.perp_market)?;
    msg!("perp market {}", perp_market.market_index);

    if *ctx.accounts.admin.key != ctx.accounts.state.load()?.cold_admin {
        validate!(
            market_config == 0,
            ErrorCode::DefaultError,
            "signer must be state admin to enable market config flags",
        )?;
    }

    msg!(
        "perp_market.market_config: {:?} -> {:?}",
        perp_market.market_config,
        market_config
    );

    perp_market.market_config = market_config;

    Ok(())
}

pub fn handle_update_special_user_status(
    ctx: Context<UpdateSpecialUserStatus>,
    status: u8,
) -> Result<()> {
    let allowed_bits = SpecialUserStatus::VammHedger as u8;

    validate!(
        status & !allowed_bits == 0,
        ErrorCode::DefaultError,
        "unknown bits set in user's special_user_status: {:?}",
        status
    )?;

    let user = &mut load_mut!(ctx.accounts.user)?;

    if *ctx.accounts.admin.key != ctx.accounts.state.load()?.cold_admin {
        validate!(
            status == 0,
            ErrorCode::DefaultError,
            "signer must be state admin to enable special user status flags",
        )?;
    }

    msg!(
        "special_user_status for {:?}: {:?} -> {:?}",
        user.authority,
        user.special_user_status,
        status
    );

    user.special_user_status = status;

    Ok(())
}

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    #[account(
        init,
        seeds = [b"velocity_state".as_ref()],
        space = State::SIZE,
        bump,
        payer = admin
    )]
    pub state: AccountLoader<'info, State>,
    pub quote_asset_mint: Box<InterfaceAccount<'info, Mint>>,
    /// CHECK: checked in `initialize`
    pub velocity_signer: UncheckedAccount<'info>,
    pub rent: Sysvar<'info, Rent>,
    pub system_program: Program<'info, System>,
    pub token_program: Interface<'info, TokenInterface>,
}

#[derive(Accounts)]
pub struct InitializeSpotMarket<'info> {
    #[account(
        init,
        seeds = [b"spot_market", state.load()?.number_of_spot_markets.to_le_bytes().as_ref()],
        space = SpotMarket::SIZE,
        bump,
        payer = admin
    )]
    pub spot_market: AccountLoader<'info, SpotMarket>,
    #[account(
        mint::token_program = token_program,
    )]
    pub spot_market_mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(
        init,
        seeds = [b"spot_market_vault".as_ref(), state.load()?.number_of_spot_markets.to_le_bytes().as_ref()],
        bump,
        payer = admin,
        space = get_vault_len(&spot_market_mint)?,
        owner = token_program.key()
    )]
    /// CHECK: checked in `initialize_spot_market`
    pub spot_market_vault: AccountInfo<'info>,
    #[account(
        init,
        seeds = [b"insurance_fund_vault".as_ref(), state.load()?.number_of_spot_markets.to_le_bytes().as_ref()],
        bump,
        payer = admin,
        space = get_vault_len(&spot_market_mint)?,
        owner = token_program.key()
    )]
    /// CHECK: checked in `initialize_spot_market`
    pub insurance_fund_vault: AccountInfo<'info>,
    #[account(
        constraint = state.load()?.signer.eq(&velocity_signer.key())
    )]
    /// CHECK: program signer
    pub velocity_signer: UncheckedAccount<'info>,
    #[account(mut)]
    pub state: AccountLoader<'info, State>,
    /// CHECK: checked in `initialize_spot_market`
    pub oracle: UncheckedAccount<'info>,
    #[account(
        mut,
        constraint = check_warm(&admin.key(), &state)?
    )]
    pub admin: Signer<'info>,
    pub rent: Sysvar<'info, Rent>,
    pub system_program: Program<'info, System>,
    pub token_program: Interface<'info, TokenInterface>,
}

#[derive(Accounts)]
#[instruction(market_index: u16)]
pub struct DeleteInitializedSpotMarket<'info> {
    #[account(mut, constraint = check_warm(&admin.key(), &state)?)]
    pub admin: Signer<'info>,
    #[account(mut)]
    pub state: AccountLoader<'info, State>,
    #[account(mut, close = admin)]
    pub spot_market: AccountLoader<'info, SpotMarket>,
    #[account(
        mut,
        seeds = [b"spot_market_vault".as_ref(), market_index.to_le_bytes().as_ref()],
        bump,
    )]
    pub spot_market_vault: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(
        mut,
        seeds = [b"insurance_fund_vault".as_ref(), market_index.to_le_bytes().as_ref()],
        bump,
    )]
    pub insurance_fund_vault: Box<InterfaceAccount<'info, TokenAccount>>,
    /// CHECK: program signer
    pub velocity_signer: UncheckedAccount<'info>,
    pub token_program: Interface<'info, TokenInterface>,
}

#[derive(Accounts)]
pub struct InitializePerpMarket<'info> {
    #[account(
        mut,
        constraint = check_warm(&admin.key(), &state)?
    )]
    pub admin: Signer<'info>,
    #[account(mut)]
    pub state: AccountLoader<'info, State>,
    #[account(
        init,
        seeds = [b"perp_market", state.load()?.number_of_markets.to_le_bytes().as_ref()],
        space = PerpMarket::SIZE,
        bump,
        payer = admin
    )]
    pub perp_market: AccountLoader<'info, PerpMarket>,
    /// CHECK: checked in `initialize_perp_market`
    pub oracle: UncheckedAccount<'info>,
    pub rent: Sysvar<'info, Rent>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct DeleteInitializedPerpMarket<'info> {
    #[account(mut, constraint = check_warm(&admin.key(), &state)?)]
    pub admin: Signer<'info>,
    #[account(mut)]
    pub state: AccountLoader<'info, State>,
    #[account(mut, close = admin)]
    pub perp_market: AccountLoader<'info, PerpMarket>,
}

#[derive(Accounts)]
pub struct AdminUpdatePerpMarket<'info> {
    #[account(constraint = check_warm(&admin.key(), &state)?)]
    pub admin: Signer<'info>,
    pub state: AccountLoader<'info, State>,
    #[account(mut)]
    pub perp_market: AccountLoader<'info, PerpMarket>,
}

#[derive(Accounts)]
pub struct HotAdminUpdatePerpMarket<'info> {
    #[account(constraint = check_warm(&admin.key(), &state)?)]
    pub admin: Signer<'info>,
    pub state: AccountLoader<'info, State>,
    #[account(mut)]
    pub perp_market: AccountLoader<'info, PerpMarket>,
}

#[derive(Accounts)]
pub struct SettleExpiredMarketPoolsToRevenuePool<'info> {
    pub state: AccountLoader<'info, State>,
    #[account(constraint = check_warm(&admin.key(), &state)?)]
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
pub struct UpdatePerpMarketPnlPool<'info> {
    pub state: AccountLoader<'info, State>,
    #[account(constraint = check_warm(&admin.key(), &state)?)]
    pub admin: Signer<'info>,
    #[account(
        seeds = [b"spot_market", 0_u16.to_le_bytes().as_ref()],
        bump,
        mut
    )]
    pub spot_market: AccountLoader<'info, SpotMarket>,
    #[account(
        mut,
        seeds = [b"spot_market_vault".as_ref(), 0_u16.to_le_bytes().as_ref()],
        bump,
    )]
    pub spot_market_vault: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut)]
    pub perp_market: AccountLoader<'info, PerpMarket>,
}

#[derive(Accounts)]
pub struct DepositIntoSpotMarketVault<'info> {
    pub state: AccountLoader<'info, State>,
    #[account(mut)]
    pub spot_market: AccountLoader<'info, SpotMarket>,
    #[account(constraint = check_hot(&admin.key(), &state, HotRole::VaultDeposit)?)]
    pub admin: Signer<'info>,
    #[account(
        mut,
        token::authority = admin
    )]
    pub source_vault: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(
        mut,
        constraint = spot_market.load()?.vault == spot_market_vault.key()
    )]
    pub spot_market_vault: Box<InterfaceAccount<'info, TokenAccount>>,
    pub token_program: Interface<'info, TokenInterface>,
}

#[derive(Accounts)]
pub struct AdminUpdateState<'info> {
    #[account(constraint = check_warm(&admin.key(), &state)?)]
    pub admin: Signer<'info>,
    #[account(mut)]
    pub state: AccountLoader<'info, State>,
}

#[derive(Accounts)]
pub struct HotAdminUpdateState<'info> {
    #[account(constraint = check_hot(&admin.key(), &state, HotRole::FeatureFlag)?)]
    pub admin: Signer<'info>,
    #[account(mut)]
    pub state: AccountLoader<'info, State>,
}

#[derive(Accounts)]
pub struct AdminUpdateSpotMarket<'info> {
    #[account(constraint = check_warm(&admin.key(), &state)?)]
    pub admin: Signer<'info>,
    pub state: AccountLoader<'info, State>,
    #[account(mut)]
    pub spot_market: AccountLoader<'info, SpotMarket>,
}

#[derive(Accounts)]
pub struct AdminUpdateSpotMarketWithdrawGuardThreshold<'info> {
    #[account(constraint = check_warm(&admin.key(), &state)?)]
    pub admin: Signer<'info>,
    pub state: AccountLoader<'info, State>,
    #[account(
        mut,
        has_one = oracle @ ErrorCode::InvalidOracle,
    )]
    pub spot_market: AccountLoader<'info, SpotMarket>,
    /// CHECK: validated against `spot_market.oracle` by the `has_one` constraint
    pub oracle: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct AdminUpdateSpotMarketOracle<'info> {
    // cold-only: a lesser admin swapping the oracle could re-price the
    // withdraw guard threshold notional cap (and all margin math) at will
    #[account(constraint = check_cold(&admin.key(), &state)?)]
    pub admin: Signer<'info>,
    pub state: AccountLoader<'info, State>,
    #[account(mut)]
    pub spot_market: AccountLoader<'info, SpotMarket>,
    /// CHECK: checked in `initialize_spot_market`
    pub oracle: UncheckedAccount<'info>,
    /// CHECK: checked in `admin_update_spot_market_oracle` ix constraint
    pub old_oracle: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct AdminUpdatePerpMarketOracle<'info> {
    // cold-only: see AdminUpdateSpotMarketOracle
    #[account(constraint = check_cold(&admin.key(), &state)?)]
    pub admin: Signer<'info>,
    pub state: AccountLoader<'info, State>,
    #[account(mut)]
    pub perp_market: AccountLoader<'info, PerpMarket>,
    /// CHECK: checked in `admin_update_perp_market_oracle` ix constraint
    pub oracle: UncheckedAccount<'info>,
    /// CHECK: checked in `admin_update_perp_market_oracle` ix constraint
    pub old_oracle: UncheckedAccount<'info>,
    #[account(
        mut,
        seeds = [AMM_POSITIONS_CACHE.as_bytes()],
        bump = amm_cache.bump,
    )]
    pub amm_cache: Box<Account<'info, AmmCache>>,
}

#[derive(Accounts)]
pub struct AdminDisableBidAskTwapUpdate<'info> {
    #[account(constraint = check_hot(&admin.key(), &state, HotRole::UserFlag)?)]
    pub admin: Signer<'info>,
    pub state: AccountLoader<'info, State>,
    #[account(mut)]
    pub user_stats: AccountLoader<'info, UserStats>,
}

#[derive(Accounts)]
#[instruction(params: PrelaunchOracleParams,)]
pub struct InitializePrelaunchOracle<'info> {
    #[account(mut, constraint = check_warm(&admin.key(), &state)?)]
    pub admin: Signer<'info>,
    #[account(
        init,
        seeds = [b"prelaunch_oracle".as_ref(), params.perp_market_index.to_le_bytes().as_ref()],
        space = PrelaunchOracle::SIZE,
        bump,
        payer = admin
    )]
    pub prelaunch_oracle: AccountLoader<'info, PrelaunchOracle>,
    pub state: AccountLoader<'info, State>,
    pub rent: Sysvar<'info, Rent>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(params: PrelaunchOracleParams,)]
pub struct UpdatePrelaunchOracleParams<'info> {
    #[account(mut, constraint = check_warm(&admin.key(), &state)?)]
    pub admin: Signer<'info>,
    #[account(
        mut,
        seeds = [b"prelaunch_oracle".as_ref(), params.perp_market_index.to_le_bytes().as_ref()],
        bump,
    )]
    pub prelaunch_oracle: AccountLoader<'info, PrelaunchOracle>,
    #[account(
        mut,
        constraint = perp_market.load()?.market_index == params.perp_market_index
    )]
    pub perp_market: AccountLoader<'info, PerpMarket>,
    pub state: AccountLoader<'info, State>,
}

#[derive(Accounts)]
#[instruction(perp_market_index: u16,)]
pub struct DeletePrelaunchOracle<'info> {
    #[account(mut, constraint = check_warm(&admin.key(), &state)?)]
    pub admin: Signer<'info>,
    #[account(
        mut,
        seeds = [b"prelaunch_oracle".as_ref(), perp_market_index.to_le_bytes().as_ref()],
        bump,
        close = admin
    )]
    pub prelaunch_oracle: AccountLoader<'info, PrelaunchOracle>,
    #[account(
        constraint = perp_market.load()?.market_index == perp_market_index
    )]
    pub perp_market: AccountLoader<'info, PerpMarket>,
    pub state: AccountLoader<'info, State>,
}

#[derive(Accounts)]
#[instruction(feed_id: u32)]
pub struct InitPythLazerOracle<'info> {
    #[account(mut, constraint = check_warm(&admin.key(), &state)?)]
    pub admin: Signer<'info>,
    #[account(init, seeds = [PYTH_LAZER_ORACLE_SEED, &feed_id.to_le_bytes()],
        space=PythLazerOracle::SIZE,
        bump,
        payer=admin
    )]
    pub lazer_oracle: AccountLoader<'info, PythLazerOracle>,
    pub state: AccountLoader<'info, State>,
    pub rent: Sysvar<'info, Rent>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(market_index: u16,)]
pub struct AdminDeposit<'info> {
    pub state: AccountLoader<'info, State>,
    #[account(mut)]
    pub user: AccountLoader<'info, User>,
    #[account(mut, constraint = check_hot(&admin.key(), &state, HotRole::VaultDeposit)?)]
    pub admin: Signer<'info>,
    #[account(
        mut,
        seeds = [b"spot_market_vault".as_ref(), market_index.to_le_bytes().as_ref()],
        bump,
    )]
    pub spot_market_vault: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(
        mut,
        constraint = &spot_market_vault.mint.eq(&admin_token_account.mint),
        token::authority = admin.key()
    )]
    pub admin_token_account: Box<InterfaceAccount<'info, TokenAccount>>,
    pub token_program: Interface<'info, TokenInterface>,
}

#[derive(Accounts)]
pub struct UpdateSpecialUserStatus<'info> {
    #[account(constraint = check_hot(&admin.key(), &state, HotRole::UserFlag)?)]
    pub admin: Signer<'info>,
    pub state: AccountLoader<'info, State>,
    #[account(mut)]
    pub user: AccountLoader<'info, User>,
}

// ----- Tiered admin authority handlers -----
//
// cold/warm/hot pubkeys now live directly on `State`. `handle_initialize`
// seeds `cold_admin = warm_admin = signer` at deploy time; the handlers below
// rotate `warm_admin` (cold-only), `pause_admin` (cold-only), and individual
// hot-role keys (warm-only).

pub fn handle_update_warm_admin(
    ctx: Context<UpdateWarmAdmin>,
    new_warm_admin: Pubkey,
) -> Result<()> {
    let mut state = ctx.accounts.state.load_mut()?;
    msg!("warm_admin: {:?} -> {:?}", state.warm_admin, new_warm_admin);
    state.warm_admin = new_warm_admin;
    Ok(())
}

pub fn handle_update_pause_admin(
    ctx: Context<UpdatePauseAdmin>,
    new_pause_admin: Pubkey,
) -> Result<()> {
    let mut state = ctx.accounts.state.load_mut()?;
    msg!(
        "pause_admin: {:?} -> {:?}",
        state.pause_admin,
        new_pause_admin
    );
    state.pause_admin = new_pause_admin;
    Ok(())
}

pub fn handle_update_hot_admin(
    ctx: Context<UpdateHotAdmin>,
    role: HotRole,
    new_pubkey: Pubkey,
) -> Result<()> {
    let mut state = ctx.accounts.state.load_mut()?;
    let prev = state.hot_key(role);
    state.set_hot_key(role, new_pubkey);
    msg!("hot_admin[{:?}]: {:?} -> {:?}", role, prev, new_pubkey);
    Ok(())
}

/// Cold-only. Sets the treasury that protocol fees can be withdrawn to —
/// perp (quote-denominated) and spot (per-market tokens) recipients are
/// configured independently via `market_type`.
pub fn handle_update_protocol_fee_recipient(
    ctx: Context<ColdAdminUpdateState>,
    protocol_fee_recipient: Pubkey,
    market_type: MarketType,
) -> Result<()> {
    let mut state = ctx.accounts.state.load_mut()?;
    match market_type {
        MarketType::Perp => {
            msg!(
                "protocol_fee_recipient_perp: {:?} -> {:?}",
                state.protocol_fee_recipient_perp,
                protocol_fee_recipient
            );
            state.protocol_fee_recipient_perp = protocol_fee_recipient;
        }
        MarketType::Spot => {
            msg!(
                "protocol_fee_recipient_spot: {:?} -> {:?}",
                state.protocol_fee_recipient_spot,
                protocol_fee_recipient
            );
            state.protocol_fee_recipient_spot = protocol_fee_recipient;
        }
    }
    Ok(())
}

/// Cold-only state mutation. Constraint enforces `state.cold_admin == admin.key()`.
#[derive(Accounts)]
pub struct ColdAdminUpdateState<'info> {
    #[account(mut, constraint = state.load()?.cold_admin == admin.key() @ ErrorCode::Unauthorized)]
    pub state: AccountLoader<'info, State>,
    pub admin: Signer<'info>,
}

/// Cold-only mutation of `warm_admin`.
#[derive(Accounts)]
pub struct UpdateWarmAdmin<'info> {
    #[account(mut, constraint = state.load()?.cold_admin == admin.key() @ ErrorCode::Unauthorized)]
    pub state: AccountLoader<'info, State>,
    pub admin: Signer<'info>,
}

/// Cold-only mutation of `pause_admin`. The pause admin is the no-timelock
/// emergency-pause key; only the root (cold) authority can rotate it.
#[derive(Accounts)]
pub struct UpdatePauseAdmin<'info> {
    #[account(mut, constraint = state.load()?.cold_admin == admin.key() @ ErrorCode::Unauthorized)]
    pub state: AccountLoader<'info, State>,
    pub admin: Signer<'info>,
}

/// Warm-or-cold gated mutation of an individual hot-role key.
#[derive(Accounts)]
pub struct UpdateHotAdmin<'info> {
    #[account(
        mut,
        constraint = state.load()?.is_warm(&admin.key()) @ ErrorCode::Unauthorized
    )]
    pub state: AccountLoader<'info, State>,
    pub admin: Signer<'info>,
}

// ----- Pause-admin gated contexts -----
//
// Pause flags can be flipped by cold, warm, or the dedicated `pause_admin`
// (which has no on-chain timelock). pause_admin is restricted *inside* the
// handlers to bit-additions only — it can never clear a pause bit.

#[derive(Accounts)]
pub struct PauseAdminUpdateState<'info> {
    #[account(constraint = check_pause(&admin.key(), &state)?)]
    pub admin: Signer<'info>,
    #[account(mut)]
    pub state: AccountLoader<'info, State>,
}

#[derive(Accounts)]
pub struct PauseAdminUpdateSpotMarket<'info> {
    #[account(constraint = check_pause(&admin.key(), &state)?)]
    pub admin: Signer<'info>,
    pub state: AccountLoader<'info, State>,
    #[account(mut)]
    pub spot_market: AccountLoader<'info, SpotMarket>,
}

#[derive(Accounts)]
pub struct PauseAdminUpdatePerpMarket<'info> {
    #[account(constraint = check_pause(&admin.key(), &state)?)]
    pub admin: Signer<'info>,
    pub state: AccountLoader<'info, State>,
    #[account(mut)]
    pub perp_market: AccountLoader<'info, PerpMarket>,
}

/// Per-user pause flips are reachable by cold/warm, the existing
/// `HotRole::UserFlag` bot, or the pause_admin (pause-only — see handler).
#[derive(Accounts)]
pub struct PauseAdminUpdateUserStats<'info> {
    #[account(
        constraint =
            check_pause(&admin.key(), &state)?
                || check_hot(&admin.key(), &state, HotRole::UserFlag)?
    )]
    pub admin: Signer<'info>,
    pub state: AccountLoader<'info, State>,
    #[account(mut)]
    pub user_stats: AccountLoader<'info, UserStats>,
}

// ----- Force wipe (non-mainnet only) -----
//
// One-shot escape hatch for devnet: closes velocity-owned PDAs whose on-chain
// layout no longer matches the program (e.g. after a layout-breaking upgrade).
// Bypasses `AccountLoader::try_from` size checks by reading State's admin
// pubkey directly from raw bytes — the first pubkey field lives at offset
// 8..40 in both the legacy `#[account]` State (admin) and the new zero-copy
// State (cold_admin), so this admin gate works across layouts.
//
// Compiled out of mainnet builds via `cfg(not(feature = "mainnet-beta"))`.

#[cfg(not(feature = "mainnet-beta"))]
pub fn handle_force_wipe_accounts_devnet<'info>(
    ctx: Context<'info, ForceWipeAccountsDevnet<'info>>,
    velocity_signer_nonce: u8,
) -> Result<()> {
    use anchor_lang::solana_program::system_program;
    use anchor_spl::token_interface;

    let state_ai = ctx.accounts.state.to_account_info();
    require_keys_eq!(*state_ai.owner, crate::ID, ErrorCode::DefaultError);
    {
        let data = state_ai.try_borrow_data()?;
        require!(data.len() >= 40, ErrorCode::DefaultError);
        let mut admin_bytes = [0u8; 32];
        admin_bytes.copy_from_slice(&data[8..40]);
        let stored_admin = Pubkey::from(admin_bytes);
        require_keys_eq!(
            stored_admin,
            ctx.accounts.admin.key(),
            ErrorCode::Unauthorized
        );
    }

    let admin_ai = ctx.accounts.admin.to_account_info();
    let token_program_id = ctx.accounts.token_program.key();
    let signer_seeds = crate::signer::get_signer_seeds(&velocity_signer_nonce);
    let cpi_signers = &[&signer_seeds[..]];

    // PASS 1: close token vaults. Remaining accounts must come in pairs:
    //   (vault, mint), (vault, mint), ...
    // For each vault: if it holds a non-zero balance, CPI burn first (mint is
    // the next account in the pair), then CPI close_account.
    // Velocity-owned PDAs come AFTER all the (vault, mint) pairs.
    let mut i = 0;
    while i < ctx.remaining_accounts.len() {
        let target = &ctx.remaining_accounts[i];
        if *target.owner != token_program_id {
            break; // start of velocity-owned section
        }
        if target.lamports() == 0 {
            i += 1;
            continue;
        }
        // pair: next account is the mint
        let mint_ai = ctx
            .remaining_accounts
            .get(i + 1)
            .ok_or_else(|| ErrorCode::DefaultError)?;
        require_keys_eq!(*mint_ai.owner, token_program_id, ErrorCode::DefaultError);

        // read current token amount (offset 64..72 in SPL token account layout)
        let amount = {
            let data = target.try_borrow_data()?;
            require!(data.len() >= 72, ErrorCode::DefaultError);
            u64::from_le_bytes(data[64..72].try_into().unwrap())
        };

        if amount > 0 {
            let burn_accounts = token_interface::Burn {
                mint: mint_ai.clone(),
                from: target.clone(),
                authority: ctx.accounts.velocity_signer.clone(),
            };
            let burn_ctx =
                CpiContext::new_with_signer(token_program_id, burn_accounts, cpi_signers);
            token_interface::burn(burn_ctx, amount)?;
            msg!("burned {} from {}", amount, target.key());
        }

        let close_accounts = token_interface::CloseAccount {
            account: target.clone(),
            destination: admin_ai.clone(),
            authority: ctx.accounts.velocity_signer.clone(),
        };
        let close_ctx = CpiContext::new_with_signer(token_program_id, close_accounts, cpi_signers);
        token_interface::close_account(close_ctx)?;
        msg!("closed token vault {}", target.key());

        i += 2; // skip past the mint
    }
    let velocity_section_start = i;

    // PASS 2: drain velocity-owned PDAs by zeroing lamports; runtime GCs at EOT.
    for target in ctx.remaining_accounts.iter().skip(velocity_section_start) {
        if *target.owner == system_program::ID || target.lamports() == 0 {
            msg!("skip {} (already empty)", target.key());
            continue;
        }
        if *target.owner != crate::ID {
            msg!(
                "skip {} (owner {} not velocity)",
                target.key(),
                target.owner,
            );
            continue;
        }
        let take = target.lamports();
        **admin_ai.try_borrow_mut_lamports()? = admin_ai
            .lamports()
            .checked_add(take)
            .ok_or_else(math_error!())?;
        **target.try_borrow_mut_lamports()? = 0;
        msg!("wiped {} (reclaimed {} lamports)", target.key(), take);
    }
    Ok(())
}

#[cfg(not(feature = "mainnet-beta"))]
#[derive(Accounts)]
pub struct ForceWipeAccountsDevnet<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    /// CHECK: read raw bytes manually; both old and new State layouts have the
    /// (cold-)admin pubkey at offset 8..40.
    pub state: UncheckedAccount<'info>,
    /// CHECK: PDA seeded by [b"velocity_signer", nonce]. Verified by Token Program
    /// at CPI time when closing token vaults; ignored otherwise.
    pub velocity_signer: AccountInfo<'info>,
    pub token_program: Interface<'info, TokenInterface>,
    // Targets are passed via `remaining_accounts` so a single call can wipe
    // many accounts in one tx. Velocity-owned PDAs are drained; token-owned vaults
    // are closed via CPI (rent → admin).
}

#[cfg(test)]
mod native_auth_tests {
    //! Negative tests for the pre-Anchor native dispatch authentication on
    //! `handle_update_mm_oracle_native`. These run under `cargo test` (default
    //! features, no `anchor-test`), so the signer check is compiled in. The
    //! structural account checks are always compiled in regardless of feature.
    use super::*;
    use crate::create_anchor_account_info;
    use crate::state::perp_market::PerpMarket;
    use crate::state::state::{FeatureBitFlags, State};
    use crate::test_utils::get_anchor_account_bytes;
    use anchor_lang::prelude::{AccountInfo, Pubkey};

    // mm-oracle payload: 8-byte price + 8-byte sequence id (both non-zero so the
    // happy path would proceed past the early-out checks).
    fn mm_payload() -> [u8; 16] {
        let mut d = [0u8; 16];
        d[0..8].copy_from_slice(&100_i64.to_le_bytes());
        d[8..16].copy_from_slice(&1_u64.to_le_bytes());
        d
    }

    fn signer_info<'a>(
        key: &'a Pubkey,
        is_signer: bool,
        lamports: &'a mut u64,
        data: &'a mut [u8],
        owner: &'a Pubkey,
    ) -> AccountInfo<'a> {
        AccountInfo::new(key, is_signer, false, lamports, data, owner, false)
    }

    #[test]
    fn mm_oracle_native_rejects_forged_state() {
        // State account with the attacker's key at the hot-key field but owned by
        // a foreign program — the pre-fix bug authenticated against exactly this.
        let attacker = Pubkey::new_unique();
        let mut state = State::default();
        state.hot_mm_oracle_crank = attacker;
        state.feature_bit_flags = FeatureBitFlags::MmOracleUpdate as u8;
        let mut state_bytes = get_anchor_account_bytes(&mut state);
        let foreign_owner = Pubkey::new_unique();
        let state_key = Pubkey::new_unique();
        let mut state_lamports = 0u64;
        let forged_state = AccountInfo::new(
            &state_key,
            false,
            false,
            &mut state_lamports,
            &mut state_bytes[..],
            &foreign_owner, // NOT crate::ID
            false,
        );

        let mut perp_market = PerpMarket::default();
        create_anchor_account_info!(perp_market, PerpMarket, perp_market_info);

        let mut clock_lamports = 0u64;
        let mut clock_data = [0u8; 8];
        let clock_owner = Pubkey::new_unique();
        let clock_key = Pubkey::new_unique();
        let clock_info = AccountInfo::new(
            &clock_key,
            false,
            false,
            &mut clock_lamports,
            &mut clock_data,
            &clock_owner,
            false,
        );

        let mut sig_lamports = 0u64;
        let mut sig_data: [u8; 0] = [];
        let sig_owner = Pubkey::new_unique();
        let signer = signer_info(
            &attacker,
            true,
            &mut sig_lamports,
            &mut sig_data,
            &sig_owner,
        );

        let accounts = [perp_market_info, signer, clock_info, forged_state];
        let err = handle_update_mm_oracle_native(&accounts, &mm_payload()).unwrap_err();
        assert_eq!(err, ErrorCode::InvalidNativeStateAccount.into());
    }

    #[test]
    fn mm_oracle_native_rejects_non_perp_market_in_market_slot() {
        // Genuine state, but the "market" slot holds a non-PerpMarket account
        // (here a second State) — the pre-fix bug bytemuck-cast it blindly.
        let hot_key = Pubkey::new_unique();
        let mut state = State::default();
        state.hot_mm_oracle_crank = hot_key;
        state.feature_bit_flags = FeatureBitFlags::MmOracleUpdate as u8;
        create_anchor_account_info!(state, State, state_info);

        let mut not_a_market = State::default();
        create_anchor_account_info!(not_a_market, State, not_a_market_info);

        let mut clock_lamports = 0u64;
        let mut clock_data = [0u8; 8];
        let clock_owner = Pubkey::new_unique();
        let clock_key = Pubkey::new_unique();
        let clock_info = AccountInfo::new(
            &clock_key,
            false,
            false,
            &mut clock_lamports,
            &mut clock_data,
            &clock_owner,
            false,
        );

        let mut sig_lamports = 0u64;
        let mut sig_data: [u8; 0] = [];
        let sig_owner = Pubkey::new_unique();
        let signer = signer_info(&hot_key, true, &mut sig_lamports, &mut sig_data, &sig_owner);

        let accounts = [not_a_market_info, signer, clock_info, state_info];
        let err = handle_update_mm_oracle_native(&accounts, &mm_payload()).unwrap_err();
        assert_eq!(err, ErrorCode::InvalidNativePerpMarketAccount.into());
    }

    #[test]
    fn mm_oracle_native_rejects_unauthorized_signer() {
        // Genuine state + market, but the signer is not the configured hot key.
        let hot_key = Pubkey::new_unique();
        let mut state = State::default();
        state.hot_mm_oracle_crank = hot_key;
        state.feature_bit_flags = FeatureBitFlags::MmOracleUpdate as u8;
        create_anchor_account_info!(state, State, state_info);

        let mut perp_market = PerpMarket::default();
        create_anchor_account_info!(perp_market, PerpMarket, perp_market_info);

        let mut clock_lamports = 0u64;
        let mut clock_data = [0u8; 8];
        let clock_owner = Pubkey::new_unique();
        let clock_key = Pubkey::new_unique();
        let clock_info = AccountInfo::new(
            &clock_key,
            false,
            false,
            &mut clock_lamports,
            &mut clock_data,
            &clock_owner,
            false,
        );

        let attacker = Pubkey::new_unique();
        let mut sig_lamports = 0u64;
        let mut sig_data: [u8; 0] = [];
        let sig_owner = Pubkey::new_unique();
        let signer = signer_info(
            &attacker,
            true,
            &mut sig_lamports,
            &mut sig_data,
            &sig_owner,
        );

        let accounts = [perp_market_info, signer, clock_info, state_info];
        let err = handle_update_mm_oracle_native(&accounts, &mm_payload()).unwrap_err();
        assert_eq!(err, ErrorCode::Unauthorized.into());
    }
}
