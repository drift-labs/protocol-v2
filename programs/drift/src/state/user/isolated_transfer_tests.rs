//! Tests for `User::meets_transfer_isolated_position_deposit_margin_requirement`.
//! Covers transfer-to-isolated and transfer-from-isolated flows with pass/fail scenarios.

use std::collections::BTreeSet;
use std::str::FromStr;

use anchor_lang::Owner;
use solana_program::pubkey::Pubkey;

use crate::create_account_info;
use crate::error::ErrorCode;
use crate::math::constants::{
    AMM_RESERVE_PRECISION, BASE_PRECISION_I64, LIQUIDATION_FEE_PRECISION, PEG_PRECISION,
    QUOTE_PRECISION_I128, QUOTE_PRECISION_I64, SPOT_BALANCE_PRECISION_U64,
    SPOT_CUMULATIVE_INTEREST_PRECISION, SPOT_WEIGHT_PRECISION,
};
use crate::math::margin::MarginRequirementType;
use crate::state::margin_calculation::MarginTypeConfig;
use crate::state::oracle::{HistoricalOracleData, OracleSource};
use crate::state::oracle_map::OracleMap;
use crate::state::perp_market::{MarketStatus, PerpMarket, AMM};
use crate::state::perp_market_map::PerpMarketMap;
use crate::state::spot_market::{SpotBalanceType, SpotMarket};
use crate::state::spot_market_map::SpotMarketMap;
use crate::state::user::{PerpPosition, PositionFlag, SpotPosition, User, UserStats};
use crate::test_utils::{
    create_account_info, get_account_bytes, get_anchor_account_bytes, get_positions,
    get_pyth_price, get_spot_positions,
};
use crate::{create_anchor_account_info, PRICE_PRECISION_I64};

#[test]
fn can_transfer_to_isolated_when_cross_still_meets_after_withdraw() {
    let now = 0_i64;
    let slot = 0_u64;

    let mut oracle_price = get_pyth_price(100, 6);
    let oracle_price_key =
        Pubkey::from_str("J83w4HKfqxwcq3BEMMkPFSppX3gqekLyLJBexebFVkix").unwrap();
    let pyth_program = crate::ids::pyth_program::id();
    create_account_info!(
        oracle_price,
        &oracle_price_key,
        &pyth_program,
        oracle_account_info
    );
    let mut oracle_map = OracleMap::load_one(&oracle_account_info, slot, None).unwrap();

    let oracle_price_val = oracle_price.agg.price;
    let mut market = PerpMarket {
        market_index: 0,
        amm: AMM {
            base_asset_reserve: 100 * AMM_RESERVE_PRECISION,
            quote_asset_reserve: 100 * AMM_RESERVE_PRECISION,
            bid_base_asset_reserve: 101 * AMM_RESERVE_PRECISION,
            bid_quote_asset_reserve: 99 * AMM_RESERVE_PRECISION,
            ask_base_asset_reserve: 99 * AMM_RESERVE_PRECISION,
            ask_quote_asset_reserve: 101 * AMM_RESERVE_PRECISION,
            sqrt_k: 100 * AMM_RESERVE_PRECISION,
            peg_multiplier: 100 * PEG_PRECISION,
            max_slippage_ratio: 50,
            max_fill_reserve_fraction: 100,
            order_step_size: 10000000,
            quote_asset_amount: -150 * QUOTE_PRECISION_I128,
            base_asset_amount_with_amm: AMM_RESERVE_PRECISION as i128,
            oracle: oracle_price_key,
            historical_oracle_data: HistoricalOracleData::default_price(oracle_price_val),
            ..AMM::default()
        },
        margin_ratio_initial: 1000,
        margin_ratio_maintenance: 500,
        number_of_users_with_base: 1,
        status: MarketStatus::Initialized,
        liquidator_fee: LIQUIDATION_FEE_PRECISION / 100,
        if_liquidation_fee: LIQUIDATION_FEE_PRECISION / 100,
        ..PerpMarket::default()
    };
    create_anchor_account_info!(market, PerpMarket, market_account_info);
    let perp_market_map = PerpMarketMap::load_one(&market_account_info, true).unwrap();

    let mut spot_market = SpotMarket {
        market_index: 0,
        oracle_source: OracleSource::QuoteAsset,
        cumulative_deposit_interest: SPOT_CUMULATIVE_INTEREST_PRECISION,
        cumulative_borrow_interest: SPOT_CUMULATIVE_INTEREST_PRECISION,
        decimals: 6,
        initial_asset_weight: SPOT_WEIGHT_PRECISION,
        maintenance_asset_weight: SPOT_WEIGHT_PRECISION,
        initial_liability_weight: SPOT_WEIGHT_PRECISION,
        maintenance_liability_weight: SPOT_WEIGHT_PRECISION,
        historical_oracle_data: HistoricalOracleData {
            last_oracle_price_twap: PRICE_PRECISION_I64,
            last_oracle_price_twap_5min: PRICE_PRECISION_I64,
            ..HistoricalOracleData::default()
        },
        ..SpotMarket::default()
    };
    create_anchor_account_info!(spot_market, SpotMarket, spot_market_account_info);
    let spot_market_map = SpotMarketMap::load_one(&spot_market_account_info, true).unwrap();

    // User state AFTER transfer: cross has 400 USDC, isolated perp has received 100.
    // No cross perp positions, so cross margin requirement = 0. Cross still meets.
    let transfer_amount = 100 * 1_000_000_u128; // 100 USDC (6 decimals)
    let cross_after = 400 * SPOT_BALANCE_PRECISION_U64;

    let mut user = User {
        spot_positions: get_spot_positions(SpotPosition {
            market_index: 0,
            balance_type: SpotBalanceType::Deposit,
            scaled_balance: cross_after,
            ..SpotPosition::default()
        }),
        perp_positions: get_positions(PerpPosition {
            market_index: 0,
            base_asset_amount: 0,
            quote_asset_amount: 0,
            quote_entry_amount: 0,
            quote_break_even_amount: 0,
            position_flag: PositionFlag::IsolatedPosition as u8,
            isolated_position_scaled_balance: transfer_amount as u64,
            ..PerpPosition::default()
        }),
        ..User::default()
    };

    let mut user_stats = UserStats::default();

    let result = user.meets_transfer_isolated_position_deposit_margin_requirement(
        &perp_market_map,
        &spot_market_map,
        &mut oracle_map,
        MarginTypeConfig::CrossMarginOverride {
            margin_requirement_type: MarginRequirementType::Initial,
            default_margin_requirement_type: MarginRequirementType::Maintenance,
        },
        0,
        transfer_amount,
        &mut user_stats,
        now,
        true,
        0,
    );

    assert!(result.is_ok(), "expected Ok, got {:?}", result);
    assert_eq!(result.unwrap(), true);
}

#[test]
fn cannot_transfer_to_isolated_when_cross_would_fail_after_withdraw() {
    let now = 0_i64;
    let slot = 0_u64;

    let mut oracle_price = get_pyth_price(100, 6);
    let oracle_price_key =
        Pubkey::from_str("J83w4HKfqxwcq3BEMMkPFSppX3gqekLyLJBexebFVkix").unwrap();
    let pyth_program = crate::ids::pyth_program::id();
    create_account_info!(
        oracle_price,
        &oracle_price_key,
        &pyth_program,
        oracle_account_info
    );
    let mut oracle_map = OracleMap::load_one(&oracle_account_info, slot, None).unwrap();

    let oracle_price_val = oracle_price.agg.price;
    let mut market0 = PerpMarket {
        market_index: 0,
        amm: AMM {
            base_asset_reserve: 100 * AMM_RESERVE_PRECISION,
            quote_asset_reserve: 100 * AMM_RESERVE_PRECISION,
            bid_base_asset_reserve: 101 * AMM_RESERVE_PRECISION,
            bid_quote_asset_reserve: 99 * AMM_RESERVE_PRECISION,
            ask_base_asset_reserve: 99 * AMM_RESERVE_PRECISION,
            ask_quote_asset_reserve: 101 * AMM_RESERVE_PRECISION,
            sqrt_k: 100 * AMM_RESERVE_PRECISION,
            peg_multiplier: 100 * PEG_PRECISION,
            max_slippage_ratio: 50,
            max_fill_reserve_fraction: 100,
            order_step_size: 10000000,
            quote_asset_amount: -150 * QUOTE_PRECISION_I128,
            base_asset_amount_with_amm: AMM_RESERVE_PRECISION as i128,
            oracle: oracle_price_key,
            historical_oracle_data: HistoricalOracleData::default_price(oracle_price_val),
            ..AMM::default()
        },
        margin_ratio_initial: 1000,
        margin_ratio_maintenance: 500,
        number_of_users_with_base: 1,
        status: MarketStatus::Initialized,
        liquidator_fee: LIQUIDATION_FEE_PRECISION / 100,
        if_liquidation_fee: LIQUIDATION_FEE_PRECISION / 100,
        ..PerpMarket::default()
    };
    create_anchor_account_info!(market0, PerpMarket, market0_account_info);
    let mut market1 = market0.clone();
    market1.market_index = 1;
    create_anchor_account_info!(market1, PerpMarket, market1_account_info);
    let market_account_infos = vec![market0_account_info, market1_account_info];
    let market_set = BTreeSet::default();
    let perp_market_map: PerpMarketMap<'_> =
        PerpMarketMap::load(&market_set, &mut market_account_infos.iter().peekable()).unwrap();

    let mut spot_market = SpotMarket {
        market_index: 0,
        oracle_source: OracleSource::QuoteAsset,
        cumulative_deposit_interest: SPOT_CUMULATIVE_INTEREST_PRECISION,
        cumulative_borrow_interest: SPOT_CUMULATIVE_INTEREST_PRECISION,
        decimals: 6,
        initial_asset_weight: SPOT_WEIGHT_PRECISION,
        maintenance_asset_weight: SPOT_WEIGHT_PRECISION,
        initial_liability_weight: SPOT_WEIGHT_PRECISION,
        maintenance_liability_weight: SPOT_WEIGHT_PRECISION,
        historical_oracle_data: HistoricalOracleData {
            last_oracle_price_twap: PRICE_PRECISION_I64,
            last_oracle_price_twap_5min: PRICE_PRECISION_I64,
            ..HistoricalOracleData::default()
        },
        ..SpotMarket::default()
    };
    create_anchor_account_info!(spot_market, SpotMarket, spot_market_account_info);
    let spot_market_map = SpotMarketMap::load_one(&spot_market_account_info, true).unwrap();

    // User state AFTER transfer: cross has only 30 USDC (we transferred 50), and has a cross
    // perp position on market 1: 10 long @ $100 = $1000 notional, initial margin 10% = $100.
    // So cross needs $100 but only has $60 -> fails.
    let cross_after = 60 * SPOT_BALANCE_PRECISION_U64;
    let transfer_amount = 50 * 1_000_000_u128;

    let mut user = User {
        spot_positions: get_spot_positions(SpotPosition {
            market_index: 0,
            balance_type: SpotBalanceType::Deposit,
            scaled_balance: cross_after,
            ..SpotPosition::default()
        }),
        perp_positions: get_positions(PerpPosition {
            market_index: 0,
            base_asset_amount: 0,
            quote_asset_amount: 0,
            quote_entry_amount: 0,
            quote_break_even_amount: 0,
            position_flag: PositionFlag::IsolatedPosition as u8,
            isolated_position_scaled_balance: transfer_amount as u64,
            ..PerpPosition::default()
        }),
        ..User::default()
    };
    user.perp_positions[1] = PerpPosition {
        market_index: 1,
        base_asset_amount: 10 * BASE_PRECISION_I64,
        quote_asset_amount: -1000 * QUOTE_PRECISION_I64,
        quote_entry_amount: -1000 * QUOTE_PRECISION_I64,
        quote_break_even_amount: -1000 * QUOTE_PRECISION_I64,
        position_flag: 0, // cross position
        ..PerpPosition::default()
    };

    let mut user_stats = UserStats::default();

    let result = user.meets_transfer_isolated_position_deposit_margin_requirement(
        &perp_market_map,
        &spot_market_map,
        &mut oracle_map,
        MarginTypeConfig::CrossMarginOverride {
            margin_requirement_type: MarginRequirementType::Initial,
            default_margin_requirement_type: MarginRequirementType::Maintenance,
        },
        0,
        transfer_amount,
        &mut user_stats,
        now,
        true,
        0,
    );

    assert_eq!(result, Err(ErrorCode::InsufficientCollateral));
}

#[test]
fn can_transfer_from_isolated_when_isolated_still_meets_after_withdraw() {
    let now = 0_i64;
    let slot = 0_u64;

    let mut oracle_price = get_pyth_price(100, 6);
    let oracle_price_key =
        Pubkey::from_str("J83w4HKfqxwcq3BEMMkPFSppX3gqekLyLJBexebFVkix").unwrap();
    let pyth_program = crate::ids::pyth_program::id();
    create_account_info!(
        oracle_price,
        &oracle_price_key,
        &pyth_program,
        oracle_account_info
    );
    let mut oracle_map = OracleMap::load_one(&oracle_account_info, slot, None).unwrap();

    let oracle_price_val = oracle_price.agg.price;
    let mut market = PerpMarket {
        market_index: 0,
        amm: AMM {
            base_asset_reserve: 100 * AMM_RESERVE_PRECISION,
            quote_asset_reserve: 100 * AMM_RESERVE_PRECISION,
            bid_base_asset_reserve: 101 * AMM_RESERVE_PRECISION,
            bid_quote_asset_reserve: 99 * AMM_RESERVE_PRECISION,
            ask_base_asset_reserve: 99 * AMM_RESERVE_PRECISION,
            ask_quote_asset_reserve: 101 * AMM_RESERVE_PRECISION,
            sqrt_k: 100 * AMM_RESERVE_PRECISION,
            peg_multiplier: 100 * PEG_PRECISION,
            max_slippage_ratio: 50,
            max_fill_reserve_fraction: 100,
            order_step_size: 10000000,
            quote_asset_amount: -150 * QUOTE_PRECISION_I128,
            base_asset_amount_with_amm: AMM_RESERVE_PRECISION as i128,
            oracle: oracle_price_key,
            historical_oracle_data: HistoricalOracleData::default_price(oracle_price_val),
            ..AMM::default()
        },
        margin_ratio_initial: 1000,
        margin_ratio_maintenance: 500,
        number_of_users_with_base: 1,
        status: MarketStatus::Initialized,
        liquidator_fee: LIQUIDATION_FEE_PRECISION / 100,
        if_liquidation_fee: LIQUIDATION_FEE_PRECISION / 100,
        ..PerpMarket::default()
    };
    create_anchor_account_info!(market, PerpMarket, market_account_info);
    let perp_market_map = PerpMarketMap::load_one(&market_account_info, true).unwrap();

    let mut spot_market = SpotMarket {
        market_index: 0,
        oracle_source: OracleSource::QuoteAsset,
        cumulative_deposit_interest: SPOT_CUMULATIVE_INTEREST_PRECISION,
        cumulative_borrow_interest: SPOT_CUMULATIVE_INTEREST_PRECISION,
        decimals: 6,
        initial_asset_weight: SPOT_WEIGHT_PRECISION,
        maintenance_asset_weight: SPOT_WEIGHT_PRECISION,
        initial_liability_weight: SPOT_WEIGHT_PRECISION,
        maintenance_liability_weight: SPOT_WEIGHT_PRECISION,
        historical_oracle_data: HistoricalOracleData {
            last_oracle_price_twap: PRICE_PRECISION_I64,
            last_oracle_price_twap_5min: PRICE_PRECISION_I64,
            ..HistoricalOracleData::default()
        },
        ..SpotMarket::default()
    };
    create_anchor_account_info!(spot_market, SpotMarket, spot_market_account_info);
    let spot_market_map = SpotMarketMap::load_one(&spot_market_account_info, true).unwrap();

    // Isolated position: 1 SOL long @ $100 = $100 notional, initial margin 10% = $10.
    // Isolated collateral $200 -> easily meets. Controller passes (0, 0) for withdraw when
    // transferring from isolated to cross, so we're checking current state.
    let isolated_collateral = 200 * SPOT_BALANCE_PRECISION_U64;

    let mut user = User {
        spot_positions: [SpotPosition::default(); 8],
        perp_positions: get_positions(PerpPosition {
            market_index: 0,
            base_asset_amount: 1 * BASE_PRECISION_I64,
            quote_asset_amount: -100 * QUOTE_PRECISION_I64,
            quote_entry_amount: -100 * QUOTE_PRECISION_I64,
            quote_break_even_amount: -100 * QUOTE_PRECISION_I64,
            position_flag: PositionFlag::IsolatedPosition as u8,
            isolated_position_scaled_balance: isolated_collateral,
            ..PerpPosition::default()
        }),
        ..User::default()
    };

    let mut user_stats = UserStats::default();

    let result = user.meets_transfer_isolated_position_deposit_margin_requirement(
        &perp_market_map,
        &spot_market_map,
        &mut oracle_map,
        MarginTypeConfig::IsolatedPositionOverride {
            margin_requirement_type: MarginRequirementType::Initial,
            default_isolated_margin_requirement_type: MarginRequirementType::Maintenance,
            cross_margin_requirement_type: MarginRequirementType::Maintenance,
            market_index: 0,
        },
        0,
        0,
        &mut user_stats,
        now,
        false,
        0,
    );

    assert!(result.is_ok(), "expected Ok, got {:?}", result);
    assert_eq!(result.unwrap(), true);
}

#[test]
fn cannot_transfer_from_isolated_when_isolated_would_fail() {
    let now = 0_i64;
    let slot = 0_u64;

    let mut oracle_price = get_pyth_price(100, 6);
    let oracle_price_key =
        Pubkey::from_str("J83w4HKfqxwcq3BEMMkPFSppX3gqekLyLJBexebFVkix").unwrap();
    let pyth_program = crate::ids::pyth_program::id();
    create_account_info!(
        oracle_price,
        &oracle_price_key,
        &pyth_program,
        oracle_account_info
    );
    let mut oracle_map = OracleMap::load_one(&oracle_account_info, slot, None).unwrap();

    let oracle_price_val = oracle_price.agg.price;
    let mut market = PerpMarket {
        market_index: 0,
        amm: AMM {
            base_asset_reserve: 100 * AMM_RESERVE_PRECISION,
            quote_asset_reserve: 100 * AMM_RESERVE_PRECISION,
            bid_base_asset_reserve: 101 * AMM_RESERVE_PRECISION,
            bid_quote_asset_reserve: 99 * AMM_RESERVE_PRECISION,
            ask_base_asset_reserve: 99 * AMM_RESERVE_PRECISION,
            ask_quote_asset_reserve: 101 * AMM_RESERVE_PRECISION,
            sqrt_k: 100 * AMM_RESERVE_PRECISION,
            peg_multiplier: 100 * PEG_PRECISION,
            max_slippage_ratio: 50,
            max_fill_reserve_fraction: 100,
            order_step_size: 10000000,
            quote_asset_amount: -150 * QUOTE_PRECISION_I128,
            base_asset_amount_with_amm: AMM_RESERVE_PRECISION as i128,
            oracle: oracle_price_key,
            historical_oracle_data: HistoricalOracleData::default_price(oracle_price_val),
            ..AMM::default()
        },
        margin_ratio_initial: 1000,
        margin_ratio_maintenance: 500,
        number_of_users_with_base: 1,
        status: MarketStatus::Initialized,
        liquidator_fee: LIQUIDATION_FEE_PRECISION / 100,
        if_liquidation_fee: LIQUIDATION_FEE_PRECISION / 100,
        ..PerpMarket::default()
    };
    create_anchor_account_info!(market, PerpMarket, market_account_info);
    let perp_market_map = PerpMarketMap::load_one(&market_account_info, true).unwrap();

    let mut spot_market = SpotMarket {
        market_index: 0,
        oracle_source: OracleSource::QuoteAsset,
        cumulative_deposit_interest: SPOT_CUMULATIVE_INTEREST_PRECISION,
        cumulative_borrow_interest: SPOT_CUMULATIVE_INTEREST_PRECISION,
        decimals: 6,
        initial_asset_weight: SPOT_WEIGHT_PRECISION,
        maintenance_asset_weight: SPOT_WEIGHT_PRECISION,
        initial_liability_weight: SPOT_WEIGHT_PRECISION,
        maintenance_liability_weight: SPOT_WEIGHT_PRECISION,
        historical_oracle_data: HistoricalOracleData {
            last_oracle_price_twap: PRICE_PRECISION_I64,
            last_oracle_price_twap_5min: PRICE_PRECISION_I64,
            ..HistoricalOracleData::default()
        },
        ..SpotMarket::default()
    };
    create_anchor_account_info!(spot_market, SpotMarket, spot_market_account_info);
    let spot_market_map = SpotMarketMap::load_one(&spot_market_account_info, true).unwrap();

    // Isolated position: 10 SOL long @ $100 = $1000 notional, initial margin 10% = $100.
    // Isolated collateral only $30 (e.g. after moving most to cross) -> fails Initial.
    let isolated_collateral = 30 * SPOT_BALANCE_PRECISION_U64;

    let mut user = User {
        spot_positions: [SpotPosition::default(); 8],
        perp_positions: get_positions(PerpPosition {
            market_index: 0,
            base_asset_amount: 10 * BASE_PRECISION_I64,
            quote_asset_amount: -1000 * QUOTE_PRECISION_I64,
            quote_entry_amount: -1000 * QUOTE_PRECISION_I64,
            quote_break_even_amount: -1000 * QUOTE_PRECISION_I64,
            position_flag: PositionFlag::IsolatedPosition as u8,
            isolated_position_scaled_balance: isolated_collateral,
            ..PerpPosition::default()
        }),
        ..User::default()
    };

    let mut user_stats = UserStats::default();

    let result = user.meets_transfer_isolated_position_deposit_margin_requirement(
        &perp_market_map,
        &spot_market_map,
        &mut oracle_map,
        MarginTypeConfig::IsolatedPositionOverride {
            market_index: 0,
            margin_requirement_type: MarginRequirementType::Initial,
            default_isolated_margin_requirement_type: MarginRequirementType::Maintenance,
            cross_margin_requirement_type: MarginRequirementType::Maintenance,
        },
        0,
        0,
        &mut user_stats,
        now,
        false,
        0,
    );

    assert_eq!(result, Err(ErrorCode::InsufficientCollateral));
}
