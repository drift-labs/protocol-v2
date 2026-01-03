use std::str::FromStr;

use anchor_lang::Owner;
use solana_program::pubkey::Pubkey;

use crate::controller::pnl::settle_pnl;
use crate::error::ErrorCode;
use crate::math::casting::Cast;
use crate::math::constants::{
    AMM_RESERVE_PRECISION, BASE_PRECISION_I128, BASE_PRECISION_I64, LIQUIDATION_FEE_PRECISION,
    PEG_PRECISION, QUOTE_PRECISION_I128, QUOTE_PRECISION_I64, QUOTE_SPOT_MARKET_INDEX,
    SPOT_BALANCE_PRECISION, SPOT_BALANCE_PRECISION_U64, SPOT_CUMULATIVE_INTEREST_PRECISION,
    SPOT_WEIGHT_PRECISION,
};
use crate::math::margin::{
    meets_maintenance_margin_requirement, meets_settle_pnl_maintenance_margin_requirement,
};
use crate::state::oracle::{HistoricalOracleData, OracleSource};
use crate::state::oracle_map::OracleMap;
use crate::state::perp_market::{MarketStatus, PerpMarket, PoolBalance, AMM};
use crate::state::perp_market_map::PerpMarketMap;
use crate::state::spot_market::{SpotBalanceType, SpotMarket};
use crate::state::spot_market_map::SpotMarketMap;
use crate::state::state::{OracleGuardRails, State, ValidityGuardRails};
use crate::state::user::{PerpPosition, SpotPosition, User, UserStatus};
use crate::test_utils::*;
use crate::test_utils::{get_positions, get_pyth_price, get_spot_positions};
use crate::{create_account_info, SettlePnlMode};
use crate::{create_anchor_account_info, PRICE_PRECISION_I64};
use anchor_lang::prelude::Clock;

use crate::test_utils::create_account_info;
use anchor_lang::prelude::AccountLoader;

#[test]
pub fn user_no_position() {
    let clock = Clock {
        slot: 0,
        epoch_start_timestamp: 0,
        epoch: 0,
        leader_schedule_epoch: 0,
        unix_timestamp: 0,
    };

    let state = State {
        oracle_guard_rails: OracleGuardRails {
            validity: ValidityGuardRails {
                slots_before_stale_for_amm: 10,     // 5s
                slots_before_stale_for_margin: 120, // 60s
                confidence_interval_max_size: 1000,
                too_volatile_ratio: 5,
            },
            ..OracleGuardRails::default()
        },
        ..State::default()
    };

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
    let mut oracle_map = OracleMap::load_one(&oracle_account_info, clock.slot, None).unwrap();

    let mut market = PerpMarket {
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
            base_asset_amount_with_amm: BASE_PRECISION_I128,
            base_asset_amount_long: BASE_PRECISION_I128,
            oracle: oracle_price_key,
            historical_oracle_data: HistoricalOracleData {
                last_oracle_price: oracle_price.agg.price,
                last_oracle_price_twap_5min: oracle_price.agg.price,
                last_oracle_price_twap: oracle_price.agg.price,
                ..HistoricalOracleData::default()
            },
            ..AMM::default()
        },
        margin_ratio_initial: 1000,
        margin_ratio_maintenance: 500,
        number_of_users_with_base: 1,
        status: MarketStatus::Active,
        liquidator_fee: LIQUIDATION_FEE_PRECISION / 100,
        pnl_pool: PoolBalance {
            scaled_balance: (50 * SPOT_BALANCE_PRECISION),
            market_index: QUOTE_SPOT_MARKET_INDEX,
            ..PoolBalance::default()
        },
        ..PerpMarket::default()
    };
    create_anchor_account_info!(market, PerpMarket, market_account_info);
    let market_map = PerpMarketMap::load_one(&market_account_info, true).unwrap();

    let mut spot_market = SpotMarket {
        market_index: 0,
        oracle_source: OracleSource::QuoteAsset,
        cumulative_deposit_interest: SPOT_CUMULATIVE_INTEREST_PRECISION,
        decimals: 6,
        initial_asset_weight: SPOT_WEIGHT_PRECISION,
        deposit_balance: 100 * SPOT_BALANCE_PRECISION,
        ..SpotMarket::default()
    };
    create_anchor_account_info!(spot_market, SpotMarket, spot_market_account_info);
    let spot_market_map = SpotMarketMap::load_one(&spot_market_account_info, true).unwrap();

    let mut user = User {
        perp_positions: [PerpPosition::default(); 8],
        spot_positions: get_spot_positions(SpotPosition {
            market_index: 0,
            balance_type: SpotBalanceType::Deposit,
            scaled_balance: 50 * SPOT_BALANCE_PRECISION_U64,
            ..SpotPosition::default()
        }),
        ..User::default()
    };

    let user_key = Pubkey::default();
    let authority = Pubkey::default();

    let result = settle_pnl(
        0,
        &mut user,
        &authority,
        &user_key,
        &market_map,
        &spot_market_map,
        &mut oracle_map,
        &clock,
        &state,
        None,
        SettlePnlMode::MustSettle,
    );

    assert_eq!(result, Err(ErrorCode::UserHasNoPositionInMarket));
}

#[test]
pub fn user_does_not_meet_maintenance_requirement() {
    let clock = Clock {
        slot: 0,
        epoch_start_timestamp: 0,
        epoch: 0,
        leader_schedule_epoch: 0,
        unix_timestamp: 0,
    };

    let state = State {
        oracle_guard_rails: OracleGuardRails {
            validity: ValidityGuardRails {
                slots_before_stale_for_amm: 10,     // 5s
                slots_before_stale_for_margin: 120, // 60s
                confidence_interval_max_size: 1000,
                too_volatile_ratio: 5,
            },
            ..OracleGuardRails::default()
        },
        ..State::default()
    };

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
    let mut oracle_map = OracleMap::load_one(&oracle_account_info, clock.slot, None).unwrap();

    let mut market = PerpMarket {
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
            base_asset_amount_with_amm: BASE_PRECISION_I128,
            base_asset_amount_long: BASE_PRECISION_I128,
            oracle: oracle_price_key,
            historical_oracle_data: HistoricalOracleData {
                last_oracle_price: oracle_price.agg.price,
                last_oracle_price_twap_5min: oracle_price.agg.price,
                last_oracle_price_twap: oracle_price.agg.price,
                ..HistoricalOracleData::default()
            },
            ..AMM::default()
        },
        margin_ratio_initial: 1000,
        margin_ratio_maintenance: 500,
        number_of_users_with_base: 1,
        status: MarketStatus::Active,
        liquidator_fee: LIQUIDATION_FEE_PRECISION / 100,
        pnl_pool: PoolBalance {
            scaled_balance: (50 * SPOT_BALANCE_PRECISION),
            market_index: QUOTE_SPOT_MARKET_INDEX,
            ..PoolBalance::default()
        },
        unrealized_pnl_maintenance_asset_weight: SPOT_WEIGHT_PRECISION.cast().unwrap(),
        ..PerpMarket::default()
    };
    create_anchor_account_info!(market, PerpMarket, market_account_info);
    let market_map = PerpMarketMap::load_one(&market_account_info, true).unwrap();

    let mut spot_market = SpotMarket {
        market_index: 0,
        oracle_source: OracleSource::QuoteAsset,
        cumulative_deposit_interest: SPOT_CUMULATIVE_INTEREST_PRECISION,
        decimals: 6,
        initial_asset_weight: SPOT_WEIGHT_PRECISION,
        maintenance_asset_weight: SPOT_WEIGHT_PRECISION,
        deposit_balance: 100 * SPOT_BALANCE_PRECISION,
        historical_oracle_data: HistoricalOracleData::default_price(QUOTE_PRECISION_I64),
        ..SpotMarket::default()
    };
    create_anchor_account_info!(spot_market, SpotMarket, spot_market_account_info);
    let spot_market_map = SpotMarketMap::load_one(&spot_market_account_info, true).unwrap();

    let mut user = User {
        perp_positions: get_positions(PerpPosition {
            market_index: 0,
            quote_asset_amount: -120 * QUOTE_PRECISION_I64,
            ..PerpPosition::default()
        }),
        spot_positions: get_spot_positions(SpotPosition {
            market_index: 0,
            balance_type: SpotBalanceType::Deposit,
            scaled_balance: 100 * SPOT_BALANCE_PRECISION_U64,
            ..SpotPosition::default()
        }),
        ..User::default()
    };

    let user_key = Pubkey::default();
    let authority = Pubkey::default();

    let result = settle_pnl(
        0,
        &mut user,
        &authority,
        &user_key,
        &market_map,
        &spot_market_map,
        &mut oracle_map,
        &clock,
        &state,
        None,
        SettlePnlMode::MustSettle,
    );

    assert_eq!(result, Err(ErrorCode::InsufficientCollateralForSettlingPNL))
}

#[test]
pub fn user_does_not_meet_strict_maintenance_requirement() {
    let clock = Clock {
        slot: 0,
        epoch_start_timestamp: 0,
        epoch: 0,
        leader_schedule_epoch: 0,
        unix_timestamp: 0,
    };

    let state = State {
        oracle_guard_rails: OracleGuardRails {
            validity: ValidityGuardRails {
                slots_before_stale_for_amm: 10,     // 5s
                slots_before_stale_for_margin: 120, // 60s
                confidence_interval_max_size: 1000,
                too_volatile_ratio: 5,
            },
            ..OracleGuardRails::default()
        },
        ..State::default()
    };

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
    let mut oracle_map = OracleMap::load_one(&oracle_account_info, clock.slot, None).unwrap();

    let mut market = PerpMarket {
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
            base_asset_amount_with_amm: BASE_PRECISION_I128,
            base_asset_amount_long: BASE_PRECISION_I128,
            oracle: oracle_price_key,
            historical_oracle_data: HistoricalOracleData {
                last_oracle_price: oracle_price.agg.price,
                last_oracle_price_twap_5min: oracle_price.agg.price,
                last_oracle_price_twap: oracle_price.agg.price,
                ..HistoricalOracleData::default()
            },
            ..AMM::default()
        },
        margin_ratio_initial: 1000,
        margin_ratio_maintenance: 500,
        number_of_users_with_base: 1,
        status: MarketStatus::Active,
        liquidator_fee: LIQUIDATION_FEE_PRECISION / 100,
        pnl_pool: PoolBalance {
            scaled_balance: (50 * SPOT_BALANCE_PRECISION),
            market_index: QUOTE_SPOT_MARKET_INDEX,
            ..PoolBalance::default()
        },
        unrealized_pnl_maintenance_asset_weight: SPOT_WEIGHT_PRECISION.cast().unwrap(),
        ..PerpMarket::default()
    };
    create_anchor_account_info!(market, PerpMarket, market_account_info);
    let market_map = PerpMarketMap::load_one(&market_account_info, true).unwrap();

    let mut spot_market = SpotMarket {
        market_index: 0,
        oracle_source: OracleSource::QuoteAsset,
        cumulative_deposit_interest: SPOT_CUMULATIVE_INTEREST_PRECISION,
        decimals: 6,
        initial_asset_weight: SPOT_WEIGHT_PRECISION,
        maintenance_asset_weight: SPOT_WEIGHT_PRECISION,
        deposit_balance: 100 * SPOT_BALANCE_PRECISION,
        historical_oracle_data: HistoricalOracleData {
            last_oracle_price_twap_5min: PRICE_PRECISION_I64 / 2,
            ..HistoricalOracleData::default_price(QUOTE_PRECISION_I64)
        },
        ..SpotMarket::default()
    };
    create_anchor_account_info!(spot_market, SpotMarket, spot_market_account_info);
    let spot_market_map = SpotMarketMap::load_one(&spot_market_account_info, true).unwrap();

    let mut user = User {
        perp_positions: get_positions(PerpPosition {
            market_index: 0,
            quote_asset_amount: -51 * QUOTE_PRECISION_I64,
            ..PerpPosition::default()
        }),
        spot_positions: get_spot_positions(SpotPosition {
            market_index: 0,
            balance_type: SpotBalanceType::Deposit,
            scaled_balance: 100 * SPOT_BALANCE_PRECISION_U64,
            ..SpotPosition::default()
        }),
        ..User::default()
    };

    let user_key = Pubkey::default();
    let authority = Pubkey::default();

    let result = settle_pnl(
        0,
        &mut user,
        &authority,
        &user_key,
        &market_map,
        &spot_market_map,
        &mut oracle_map,
        &clock,
        &state,
        None,
        SettlePnlMode::MustSettle,
    );

    assert_eq!(result, Err(ErrorCode::InsufficientCollateralForSettlingPNL));

    let meets_maintenance =
        meets_maintenance_margin_requirement(&user, &market_map, &spot_market_map, &mut oracle_map)
            .unwrap();

    assert_eq!(meets_maintenance, true);

    let meets_settle_pnl_maintenance = meets_settle_pnl_maintenance_margin_requirement(
        &user,
        &market_map,
        &spot_market_map,
        &mut oracle_map,
    )
    .unwrap();

    assert_eq!(meets_settle_pnl_maintenance, false);
}

#[test]
pub fn user_unsettled_negative_pnl() {
    let clock = Clock {
        slot: 0,
        epoch_start_timestamp: 0,
        epoch: 0,
        leader_schedule_epoch: 0,
        unix_timestamp: 0,
    };
    let state = State {
        oracle_guard_rails: OracleGuardRails {
            validity: ValidityGuardRails {
                slots_before_stale_for_amm: 10,     // 5s
                slots_before_stale_for_margin: 120, // 60s
                confidence_interval_max_size: 1000,
                too_volatile_ratio: 5,
            },
            ..OracleGuardRails::default()
        },
        ..State::default()
    };
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
    let mut oracle_map = OracleMap::load_one(&oracle_account_info, clock.slot, None).unwrap();

    let mut market = PerpMarket {
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
            base_asset_amount_with_amm: BASE_PRECISION_I128,
            base_asset_amount_long: BASE_PRECISION_I128,
            oracle: oracle_price_key,
            historical_oracle_data: HistoricalOracleData {
                last_oracle_price: oracle_price.agg.price,
                last_oracle_price_twap_5min: oracle_price.agg.price,
                last_oracle_price_twap: oracle_price.agg.price,
                ..HistoricalOracleData::default()
            },
            ..AMM::default()
        },
        margin_ratio_initial: 1000,
        margin_ratio_maintenance: 500,
        number_of_users_with_base: 1,
        number_of_users: 1,
        status: MarketStatus::Active,
        liquidator_fee: LIQUIDATION_FEE_PRECISION / 100,
        pnl_pool: PoolBalance {
            scaled_balance: (50 * SPOT_BALANCE_PRECISION),
            market_index: QUOTE_SPOT_MARKET_INDEX,
            ..PoolBalance::default()
        },
        unrealized_pnl_maintenance_asset_weight: SPOT_WEIGHT_PRECISION.cast().unwrap(),
        ..PerpMarket::default()
    };
    create_anchor_account_info!(market, PerpMarket, market_account_info);
    let market_map = PerpMarketMap::load_one(&market_account_info, true).unwrap();

    let mut spot_market = SpotMarket {
        market_index: 0,
        oracle_source: OracleSource::QuoteAsset,
        cumulative_deposit_interest: SPOT_CUMULATIVE_INTEREST_PRECISION,
        decimals: 6,
        initial_asset_weight: SPOT_WEIGHT_PRECISION,
        maintenance_asset_weight: SPOT_WEIGHT_PRECISION,
        deposit_balance: 100 * SPOT_BALANCE_PRECISION,
        historical_oracle_data: HistoricalOracleData::default_price(QUOTE_PRECISION_I64),
        ..SpotMarket::default()
    };
    create_anchor_account_info!(spot_market, SpotMarket, spot_market_account_info);
    let spot_market_map = SpotMarketMap::load_one(&spot_market_account_info, true).unwrap();

    let mut user = User {
        perp_positions: get_positions(PerpPosition {
            market_index: 0,
            quote_asset_amount: -50 * QUOTE_PRECISION_I64,
            ..PerpPosition::default()
        }),
        spot_positions: get_spot_positions(SpotPosition {
            market_index: 0,
            balance_type: SpotBalanceType::Deposit,
            scaled_balance: 100 * SPOT_BALANCE_PRECISION_U64,
            ..SpotPosition::default()
        }),
        ..User::default()
    };

    let user_key = Pubkey::default();
    let authority = Pubkey::default();

    let mut expected_user = user;
    expected_user.perp_positions[0].quote_asset_amount = 0;
    expected_user.settled_perp_pnl = -50 * QUOTE_PRECISION_I64;
    expected_user.perp_positions[0].settled_pnl = -50 * QUOTE_PRECISION_I64;
    expected_user.spot_positions[0].scaled_balance = 50 * SPOT_BALANCE_PRECISION_U64;

    let mut expected_market = market;
    expected_market.pnl_pool.scaled_balance = 100 * SPOT_BALANCE_PRECISION;
    expected_market.amm.quote_asset_amount = -100 * QUOTE_PRECISION_I128;
    expected_market.number_of_users = 0;

    settle_pnl(
        0,
        &mut user,
        &authority,
        &user_key,
        &market_map,
        &spot_market_map,
        &mut oracle_map,
        &clock,
        &state,
        None,
        SettlePnlMode::MustSettle,
    )
    .unwrap();

    assert_eq!(expected_user, user);
    assert_eq!(expected_market, *market_map.get_ref(&0).unwrap());
}

#[test]
pub fn user_unsettled_positive_pnl_more_than_pool() {
    let clock = Clock {
        slot: 0,
        epoch_start_timestamp: 0,
        epoch: 0,
        leader_schedule_epoch: 0,
        unix_timestamp: 0,
    };
    let state = State {
        oracle_guard_rails: OracleGuardRails {
            validity: ValidityGuardRails {
                slots_before_stale_for_amm: 10,     // 5s
                slots_before_stale_for_margin: 120, // 60s
                confidence_interval_max_size: 1000,
                too_volatile_ratio: 5,
            },
            ..OracleGuardRails::default()
        },
        ..State::default()
    };
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
    let mut oracle_map = OracleMap::load_one(&oracle_account_info, clock.slot, None).unwrap();

    let mut market = PerpMarket {
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
            base_asset_amount_with_amm: BASE_PRECISION_I128,
            base_asset_amount_long: BASE_PRECISION_I128,
            oracle: oracle_price_key,
            historical_oracle_data: HistoricalOracleData {
                last_oracle_price: oracle_price.agg.price,
                last_oracle_price_twap_5min: oracle_price.agg.price,
                last_oracle_price_twap: oracle_price.agg.price,
                ..HistoricalOracleData::default()
            },
            ..AMM::default()
        },
        margin_ratio_initial: 1000,
        margin_ratio_maintenance: 500,
        number_of_users_with_base: 1,
        status: MarketStatus::Active,
        liquidator_fee: LIQUIDATION_FEE_PRECISION / 100,
        pnl_pool: PoolBalance {
            scaled_balance: (50 * SPOT_BALANCE_PRECISION),
            market_index: QUOTE_SPOT_MARKET_INDEX,
            ..PoolBalance::default()
        },
        unrealized_pnl_maintenance_asset_weight: SPOT_WEIGHT_PRECISION.cast().unwrap(),
        ..PerpMarket::default()
    };
    create_anchor_account_info!(market, PerpMarket, market_account_info);
    let market_map = PerpMarketMap::load_one(&market_account_info, true).unwrap();

    let mut spot_market = SpotMarket {
        market_index: 0,
        oracle_source: OracleSource::QuoteAsset,
        cumulative_deposit_interest: SPOT_CUMULATIVE_INTEREST_PRECISION,
        decimals: 6,
        initial_asset_weight: SPOT_WEIGHT_PRECISION,
        maintenance_asset_weight: SPOT_WEIGHT_PRECISION,
        deposit_balance: 100 * SPOT_BALANCE_PRECISION,
        historical_oracle_data: HistoricalOracleData::default_price(QUOTE_PRECISION_I64),
        ..SpotMarket::default()
    };
    create_anchor_account_info!(spot_market, SpotMarket, spot_market_account_info);
    let spot_market_map = SpotMarketMap::load_one(&spot_market_account_info, true).unwrap();

    let mut user = User {
        perp_positions: get_positions(PerpPosition {
            market_index: 0,
            quote_asset_amount: 100 * QUOTE_PRECISION_I64,
            ..PerpPosition::default()
        }),
        spot_positions: get_spot_positions(SpotPosition {
            market_index: 0,
            balance_type: SpotBalanceType::Deposit,
            scaled_balance: 100 * SPOT_BALANCE_PRECISION_U64,
            ..SpotPosition::default()
        }),
        ..User::default()
    };

    let user_key = Pubkey::default();
    let authority = Pubkey::default();

    let mut expected_user = user;
    expected_user.perp_positions[0].quote_asset_amount = 50 * QUOTE_PRECISION_I64;
    expected_user.settled_perp_pnl = 50 * QUOTE_PRECISION_I64;
    expected_user.perp_positions[0].settled_pnl = 50 * QUOTE_PRECISION_I64;
    expected_user.spot_positions[0].scaled_balance = 150 * SPOT_BALANCE_PRECISION_U64;

    let mut expected_market = market;
    expected_market.pnl_pool.scaled_balance = 0;
    expected_market.amm.quote_asset_amount = -200 * QUOTE_PRECISION_I128;

    settle_pnl(
        0,
        &mut user,
        &authority,
        &user_key,
        &market_map,
        &spot_market_map,
        &mut oracle_map,
        &clock,
        &state,
        None,
        SettlePnlMode::MustSettle,
    )
    .unwrap();

    assert_eq!(expected_user, user);
    assert_eq!(expected_market, *market_map.get_ref(&0).unwrap());
}

#[test]
pub fn user_unsettled_positive_pnl_less_than_pool() {
    let clock = Clock {
        slot: 0,
        epoch_start_timestamp: 0,
        epoch: 0,
        leader_schedule_epoch: 0,
        unix_timestamp: 0,
    };
    let state = State {
        oracle_guard_rails: OracleGuardRails {
            validity: ValidityGuardRails {
                slots_before_stale_for_amm: 10,     // 5s
                slots_before_stale_for_margin: 120, // 60s
                confidence_interval_max_size: 1000,
                too_volatile_ratio: 5,
            },
            ..OracleGuardRails::default()
        },
        ..State::default()
    };
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
    let mut oracle_map = OracleMap::load_one(&oracle_account_info, clock.slot, None).unwrap();

    let mut market = PerpMarket {
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
            base_asset_amount_with_amm: BASE_PRECISION_I128,
            base_asset_amount_long: BASE_PRECISION_I128,
            oracle: oracle_price_key,
            historical_oracle_data: HistoricalOracleData {
                last_oracle_price: oracle_price.agg.price,
                last_oracle_price_twap_5min: oracle_price.agg.price,
                last_oracle_price_twap: oracle_price.agg.price,
                ..HistoricalOracleData::default()
            },
            ..AMM::default()
        },
        margin_ratio_initial: 1000,
        margin_ratio_maintenance: 500,
        number_of_users_with_base: 1,
        number_of_users: 1,
        status: MarketStatus::Active,
        liquidator_fee: LIQUIDATION_FEE_PRECISION / 100,
        pnl_pool: PoolBalance {
            scaled_balance: (50 * SPOT_BALANCE_PRECISION),
            market_index: QUOTE_SPOT_MARKET_INDEX,
            ..PoolBalance::default()
        },
        unrealized_pnl_maintenance_asset_weight: SPOT_WEIGHT_PRECISION.cast().unwrap(),
        ..PerpMarket::default()
    };
    create_anchor_account_info!(market, PerpMarket, market_account_info);
    let market_map = PerpMarketMap::load_one(&market_account_info, true).unwrap();

    let mut spot_market = SpotMarket {
        market_index: 0,
        oracle_source: OracleSource::QuoteAsset,
        cumulative_deposit_interest: SPOT_CUMULATIVE_INTEREST_PRECISION,
        decimals: 6,
        initial_asset_weight: SPOT_WEIGHT_PRECISION,
        maintenance_asset_weight: SPOT_WEIGHT_PRECISION,
        deposit_balance: 100 * SPOT_BALANCE_PRECISION,
        historical_oracle_data: HistoricalOracleData::default_price(QUOTE_PRECISION_I64),
        ..SpotMarket::default()
    };
    create_anchor_account_info!(spot_market, SpotMarket, spot_market_account_info);
    let spot_market_map = SpotMarketMap::load_one(&spot_market_account_info, true).unwrap();

    let mut user = User {
        perp_positions: get_positions(PerpPosition {
            market_index: 0,
            quote_asset_amount: 25 * QUOTE_PRECISION_I64,
            ..PerpPosition::default()
        }),
        spot_positions: get_spot_positions(SpotPosition {
            market_index: 0,
            balance_type: SpotBalanceType::Deposit,
            scaled_balance: 100 * SPOT_BALANCE_PRECISION_U64,
            ..SpotPosition::default()
        }),
        ..User::default()
    };

    let user_key = Pubkey::default();
    let authority = Pubkey::default();

    let mut expected_user = user;
    expected_user.perp_positions[0].quote_asset_amount = 0;
    expected_user.settled_perp_pnl = 25 * QUOTE_PRECISION_I64;
    expected_user.perp_positions[0].settled_pnl = 25 * QUOTE_PRECISION_I64;
    expected_user.spot_positions[0].scaled_balance = 125 * SPOT_BALANCE_PRECISION_U64;

    let mut expected_market = market;
    expected_market.pnl_pool.scaled_balance = 25 * SPOT_BALANCE_PRECISION;
    expected_market.amm.quote_asset_amount = -175 * QUOTE_PRECISION_I128;
    expected_market.number_of_users = 0;

    settle_pnl(
        0,
        &mut user,
        &authority,
        &user_key,
        &market_map,
        &spot_market_map,
        &mut oracle_map,
        &clock,
        &state,
        None,
        SettlePnlMode::MustSettle,
    )
    .unwrap();

    assert_eq!(expected_user, user);
    assert_eq!(expected_market, *market_map.get_ref(&0).unwrap());
}

#[test]
pub fn market_fee_pool_receives_portion() {
    let clock = Clock {
        slot: 0,
        epoch_start_timestamp: 0,
        epoch: 0,
        leader_schedule_epoch: 0,
        unix_timestamp: 0,
    };
    let slot = clock.slot;
    let state = State {
        oracle_guard_rails: OracleGuardRails {
            validity: ValidityGuardRails {
                slots_before_stale_for_amm: 10,     // 5s
                slots_before_stale_for_margin: 120, // 60s
                confidence_interval_max_size: 1000,
                too_volatile_ratio: 5,
            },
            ..OracleGuardRails::default()
        },
        ..State::default()
    };
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

    let mut market = PerpMarket {
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
            base_asset_amount_with_amm: BASE_PRECISION_I128,
            base_asset_amount_long: BASE_PRECISION_I128,
            oracle: oracle_price_key,
            total_fee_minus_distributions: QUOTE_PRECISION_I128,
            historical_oracle_data: HistoricalOracleData {
                last_oracle_price: oracle_price.agg.price,
                last_oracle_price_twap_5min: oracle_price.agg.price,
                last_oracle_price_twap: oracle_price.agg.price,
                ..HistoricalOracleData::default()
            },
            ..AMM::default()
        },
        margin_ratio_initial: 1000,
        margin_ratio_maintenance: 500,
        number_of_users_with_base: 1,
        number_of_users: 1,
        status: MarketStatus::Active,
        liquidator_fee: LIQUIDATION_FEE_PRECISION / 100,
        pnl_pool: PoolBalance {
            scaled_balance: (50 * SPOT_BALANCE_PRECISION),
            market_index: QUOTE_SPOT_MARKET_INDEX,
            ..PoolBalance::default()
        },
        unrealized_pnl_maintenance_asset_weight: SPOT_WEIGHT_PRECISION.cast().unwrap(),
        ..PerpMarket::default()
    };
    create_anchor_account_info!(market, PerpMarket, market_account_info);
    let market_map = PerpMarketMap::load_one(&market_account_info, true).unwrap();

    let mut spot_market = SpotMarket {
        market_index: 0,
        oracle_source: OracleSource::QuoteAsset,
        cumulative_deposit_interest: SPOT_CUMULATIVE_INTEREST_PRECISION,
        decimals: 6,
        initial_asset_weight: SPOT_WEIGHT_PRECISION,
        maintenance_asset_weight: SPOT_WEIGHT_PRECISION,
        deposit_balance: 100 * SPOT_BALANCE_PRECISION,
        historical_oracle_data: HistoricalOracleData::default_price(QUOTE_PRECISION_I64),
        ..SpotMarket::default()
    };
    create_anchor_account_info!(spot_market, SpotMarket, spot_market_account_info);
    let spot_market_map = SpotMarketMap::load_one(&spot_market_account_info, true).unwrap();

    let mut user = User {
        perp_positions: get_positions(PerpPosition {
            market_index: 0,
            quote_asset_amount: -100 * QUOTE_PRECISION_I64,
            ..PerpPosition::default()
        }),
        spot_positions: get_spot_positions(SpotPosition {
            market_index: 0,
            balance_type: SpotBalanceType::Deposit,
            scaled_balance: 200 * SPOT_BALANCE_PRECISION_U64,
            ..SpotPosition::default()
        }),
        ..User::default()
    };

    let user_key = Pubkey::default();
    let authority = Pubkey::default();

    let mut expected_user = user;
    expected_user.perp_positions[0].quote_asset_amount = 0;
    expected_user.settled_perp_pnl = -100 * QUOTE_PRECISION_I64;
    expected_user.perp_positions[0].settled_pnl = -100 * QUOTE_PRECISION_I64;
    expected_user.spot_positions[0].scaled_balance = 100 * SPOT_BALANCE_PRECISION_U64;

    let mut expected_market = market;
    expected_market.pnl_pool.scaled_balance = 149 * SPOT_BALANCE_PRECISION;
    expected_market.amm.fee_pool.scaled_balance = SPOT_BALANCE_PRECISION;
    expected_market.amm.quote_asset_amount = -50 * QUOTE_PRECISION_I128;
    expected_market.number_of_users = 0;

    settle_pnl(
        0,
        &mut user,
        &authority,
        &user_key,
        &market_map,
        &spot_market_map,
        &mut oracle_map,
        &clock,
        &state,
        None,
        SettlePnlMode::MustSettle,
    )
    .unwrap();

    assert_eq!(expected_user, user);
    assert_eq!(expected_market, *market_map.get_ref(&0).unwrap());
}

#[test]
pub fn market_fee_pool_pays_back_to_pnl_pool() {
    let clock = Clock {
        slot: 0,
        epoch_start_timestamp: 0,
        epoch: 0,
        leader_schedule_epoch: 0,
        unix_timestamp: 0,
    };
    let state = State {
        oracle_guard_rails: OracleGuardRails {
            validity: ValidityGuardRails {
                slots_before_stale_for_amm: 10,     // 5s
                slots_before_stale_for_margin: 120, // 60s
                confidence_interval_max_size: 1000,
                too_volatile_ratio: 5,
            },
            ..OracleGuardRails::default()
        },
        ..State::default()
    };
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
    let mut oracle_map = OracleMap::load_one(&oracle_account_info, clock.slot, None).unwrap();

    let mut market = PerpMarket {
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
            base_asset_amount_with_amm: BASE_PRECISION_I128,
            base_asset_amount_long: BASE_PRECISION_I128,
            oracle: oracle_price_key,
            total_fee_minus_distributions: QUOTE_PRECISION_I128,
            fee_pool: PoolBalance {
                scaled_balance: (2 * SPOT_BALANCE_PRECISION),
                market_index: QUOTE_SPOT_MARKET_INDEX,
                ..PoolBalance::default()
            },
            historical_oracle_data: HistoricalOracleData {
                last_oracle_price: oracle_price.agg.price,
                last_oracle_price_twap_5min: oracle_price.agg.price,
                last_oracle_price_twap: oracle_price.agg.price,
                ..HistoricalOracleData::default()
            },
            ..AMM::default()
        },
        margin_ratio_initial: 1000,
        margin_ratio_maintenance: 500,
        number_of_users_with_base: 1,
        number_of_users: 1,
        status: MarketStatus::Active,
        liquidator_fee: LIQUIDATION_FEE_PRECISION / 100,
        pnl_pool: PoolBalance {
            scaled_balance: (50 * SPOT_BALANCE_PRECISION),
            market_index: QUOTE_SPOT_MARKET_INDEX,
            ..PoolBalance::default()
        },
        unrealized_pnl_maintenance_asset_weight: SPOT_WEIGHT_PRECISION.cast().unwrap(),
        ..PerpMarket::default()
    };
    create_anchor_account_info!(market, PerpMarket, market_account_info);
    let market_map = PerpMarketMap::load_one(&market_account_info, true).unwrap();

    let mut spot_market = SpotMarket {
        market_index: 0,
        oracle_source: OracleSource::QuoteAsset,
        cumulative_deposit_interest: SPOT_CUMULATIVE_INTEREST_PRECISION,
        decimals: 6,
        initial_asset_weight: SPOT_WEIGHT_PRECISION,
        maintenance_asset_weight: SPOT_WEIGHT_PRECISION,
        deposit_balance: 100 * SPOT_BALANCE_PRECISION,
        historical_oracle_data: HistoricalOracleData::default_price(QUOTE_PRECISION_I64),
        ..SpotMarket::default()
    };
    create_anchor_account_info!(spot_market, SpotMarket, spot_market_account_info);
    let spot_market_map = SpotMarketMap::load_one(&spot_market_account_info, true).unwrap();

    let mut user = User {
        perp_positions: get_positions(PerpPosition {
            market_index: 0,
            quote_asset_amount: -100 * QUOTE_PRECISION_I64,
            ..PerpPosition::default()
        }),
        spot_positions: get_spot_positions(SpotPosition {
            market_index: 0,
            balance_type: SpotBalanceType::Deposit,
            scaled_balance: 200 * SPOT_BALANCE_PRECISION_U64,
            ..SpotPosition::default()
        }),
        ..User::default()
    };

    let user_key = Pubkey::default();
    let authority = Pubkey::default();

    let mut expected_user = user;
    expected_user.perp_positions[0].quote_asset_amount = 0;
    expected_user.settled_perp_pnl = -100 * QUOTE_PRECISION_I64;
    expected_user.perp_positions[0].settled_pnl = -100 * QUOTE_PRECISION_I64;
    expected_user.spot_positions[0].scaled_balance = 100 * SPOT_BALANCE_PRECISION_U64;

    let mut expected_market = market;
    expected_market.pnl_pool.scaled_balance = 151 * SPOT_BALANCE_PRECISION;
    expected_market.amm.fee_pool.scaled_balance = SPOT_BALANCE_PRECISION;
    expected_market.amm.quote_asset_amount = -50 * QUOTE_PRECISION_I128;
    expected_market.number_of_users = 0;

    settle_pnl(
        0,
        &mut user,
        &authority,
        &user_key,
        &market_map,
        &spot_market_map,
        &mut oracle_map,
        &clock,
        &state,
        None,
        SettlePnlMode::MustSettle,
    )
    .unwrap();

    assert_eq!(expected_user, user);
    assert_eq!(expected_market, *market_map.get_ref(&0).unwrap());
}

#[test]
pub fn user_long_positive_unrealized_pnl_up_to_max_positive_pnl() {
    let clock = Clock {
        slot: 0,
        epoch_start_timestamp: 0,
        epoch: 0,
        leader_schedule_epoch: 0,
        unix_timestamp: 0,
    };
    let state = State {
        oracle_guard_rails: OracleGuardRails {
            validity: ValidityGuardRails {
                slots_before_stale_for_amm: 10,     // 5s
                slots_before_stale_for_margin: 120, // 60s
                confidence_interval_max_size: 1000,
                too_volatile_ratio: 5,
            },
            ..OracleGuardRails::default()
        },
        ..State::default()
    };
    let mut oracle_price = get_pyth_price(150, 6);
    let oracle_price_key =
        Pubkey::from_str("J83w4HKfqxwcq3BEMMkPFSppX3gqekLyLJBexebFVkix").unwrap();
    let pyth_program = crate::ids::pyth_program::id();
    create_account_info!(
        oracle_price,
        &oracle_price_key,
        &pyth_program,
        oracle_account_info
    );
    let mut oracle_map = OracleMap::load_one(&oracle_account_info, clock.slot, None).unwrap();

    let mut market = PerpMarket {
        amm: AMM {
            base_asset_reserve: 100 * AMM_RESERVE_PRECISION,
            quote_asset_reserve: 100 * AMM_RESERVE_PRECISION,
            bid_base_asset_reserve: 101 * AMM_RESERVE_PRECISION,
            bid_quote_asset_reserve: 99 * AMM_RESERVE_PRECISION,
            ask_base_asset_reserve: 99 * AMM_RESERVE_PRECISION,
            ask_quote_asset_reserve: 101 * AMM_RESERVE_PRECISION,
            sqrt_k: 100 * AMM_RESERVE_PRECISION,
            peg_multiplier: 151 * PEG_PRECISION,
            max_slippage_ratio: 50,
            max_fill_reserve_fraction: 100,
            order_step_size: 10000000,
            quote_asset_amount: -150 * QUOTE_PRECISION_I128,
            base_asset_amount_with_amm: BASE_PRECISION_I128,
            base_asset_amount_long: BASE_PRECISION_I128,
            oracle: oracle_price_key,
            historical_oracle_data: HistoricalOracleData {
                last_oracle_price: oracle_price.agg.price,
                last_oracle_price_twap_5min: oracle_price.agg.price,
                last_oracle_price_twap: oracle_price.agg.price,
                ..HistoricalOracleData::default()
            },
            ..AMM::default()
        },
        margin_ratio_initial: 1000,
        margin_ratio_maintenance: 500,
        number_of_users_with_base: 1,
        status: MarketStatus::Active,
        liquidator_fee: LIQUIDATION_FEE_PRECISION / 100,
        pnl_pool: PoolBalance {
            scaled_balance: (50 * SPOT_BALANCE_PRECISION),
            market_index: QUOTE_SPOT_MARKET_INDEX,
            ..PoolBalance::default()
        },
        unrealized_pnl_maintenance_asset_weight: SPOT_WEIGHT_PRECISION.cast().unwrap(),
        ..PerpMarket::default()
    };
    create_anchor_account_info!(market, PerpMarket, market_account_info);
    let market_map = PerpMarketMap::load_one(&market_account_info, true).unwrap();

    let mut spot_market = SpotMarket {
        market_index: 0,
        oracle_source: OracleSource::QuoteAsset,
        cumulative_deposit_interest: SPOT_CUMULATIVE_INTEREST_PRECISION,
        decimals: 6,
        initial_asset_weight: SPOT_WEIGHT_PRECISION,
        maintenance_asset_weight: SPOT_WEIGHT_PRECISION,
        deposit_balance: 100 * SPOT_BALANCE_PRECISION,
        historical_oracle_data: HistoricalOracleData::default_price(QUOTE_PRECISION_I64),
        ..SpotMarket::default()
    };
    create_anchor_account_info!(spot_market, SpotMarket, spot_market_account_info);
    let spot_market_map = SpotMarketMap::load_one(&spot_market_account_info, true).unwrap();

    let mut user = User {
        perp_positions: get_positions(PerpPosition {
            market_index: 0,
            base_asset_amount: BASE_PRECISION_I64,
            quote_asset_amount: -50 * QUOTE_PRECISION_I64,
            quote_entry_amount: -100 * QUOTE_PRECISION_I64,
            quote_break_even_amount: -100 * QUOTE_PRECISION_I64,
            ..PerpPosition::default()
        }),
        spot_positions: get_spot_positions(SpotPosition {
            market_index: 0,
            balance_type: SpotBalanceType::Deposit,
            scaled_balance: 100 * SPOT_BALANCE_PRECISION_U64,
            ..SpotPosition::default()
        }),
        ..User::default()
    };

    let user_key = Pubkey::default();
    let authority = Pubkey::default();

    let mut expected_user = user;
    expected_user.perp_positions[0].quote_asset_amount = -100 * QUOTE_PRECISION_I64;
    expected_user.settled_perp_pnl = 50 * QUOTE_PRECISION_I64;
    expected_user.perp_positions[0].settled_pnl = 50 * QUOTE_PRECISION_I64;
    expected_user.spot_positions[0].scaled_balance = 150 * SPOT_BALANCE_PRECISION_U64;

    let mut expected_market = market;
    expected_market.pnl_pool.scaled_balance = 0;
    expected_market.amm.quote_asset_amount = -200 * QUOTE_PRECISION_I128;

    settle_pnl(
        0,
        &mut user,
        &authority,
        &user_key,
        &market_map,
        &spot_market_map,
        &mut oracle_map,
        &clock,
        &state,
        None,
        SettlePnlMode::MustSettle,
    )
    .unwrap();

    assert_eq!(expected_user, user);
    assert_eq!(expected_market, *market_map.get_ref(&0).unwrap());
}

#[test]
pub fn user_long_positive_unrealized_pnl_up_to_max_positive_pnl_price_breached() {
    let clock = Clock {
        slot: 0,
        epoch_start_timestamp: 0,
        epoch: 0,
        leader_schedule_epoch: 0,
        unix_timestamp: 0,
    };
    let state = State {
        oracle_guard_rails: OracleGuardRails {
            validity: ValidityGuardRails {
                slots_before_stale_for_amm: 10,     // 5s
                slots_before_stale_for_margin: 120, // 60s
                confidence_interval_max_size: 1000,
                too_volatile_ratio: 5,
            },
            ..OracleGuardRails::default()
        },
        ..State::default()
    };
    let mut oracle_price = get_pyth_price(150, 10);
    let oracle_price_key =
        Pubkey::from_str("J83w4HKfqxwcq3BEMMkPFSppX3gqekLyLJBexebFVkix").unwrap();
    let pyth_program = crate::ids::pyth_program::id();
    create_account_info!(
        oracle_price,
        &oracle_price_key,
        &pyth_program,
        oracle_account_info
    );
    let mut oracle_map = OracleMap::load_one(&oracle_account_info, clock.slot, None).unwrap();

    let mut market = PerpMarket {
        amm: AMM {
            base_asset_reserve: 100 * AMM_RESERVE_PRECISION,
            quote_asset_reserve: 100 * AMM_RESERVE_PRECISION,
            bid_base_asset_reserve: 101 * AMM_RESERVE_PRECISION,
            bid_quote_asset_reserve: 99 * AMM_RESERVE_PRECISION,
            ask_base_asset_reserve: 99 * AMM_RESERVE_PRECISION,
            ask_quote_asset_reserve: 101 * AMM_RESERVE_PRECISION,
            sqrt_k: 100 * AMM_RESERVE_PRECISION,
            peg_multiplier: 121 * PEG_PRECISION,
            max_slippage_ratio: 50,
            max_fill_reserve_fraction: 100,
            order_step_size: 10000000,
            quote_asset_amount: -150 * QUOTE_PRECISION_I128,
            base_asset_amount_with_amm: BASE_PRECISION_I128,
            base_asset_amount_long: BASE_PRECISION_I128,
            oracle: oracle_price_key,
            historical_oracle_data: HistoricalOracleData {
                last_oracle_price: oracle_price.agg.price,
                last_oracle_price_twap_5min: oracle_price.agg.price,
                last_oracle_price_twap: oracle_price.agg.price,
                ..HistoricalOracleData::default()
            },
            ..AMM::default()
        },
        margin_ratio_initial: 1000,
        margin_ratio_maintenance: 500,
        number_of_users_with_base: 1,
        status: MarketStatus::Active,
        liquidator_fee: LIQUIDATION_FEE_PRECISION / 100,
        pnl_pool: PoolBalance {
            scaled_balance: (50 * SPOT_BALANCE_PRECISION),
            market_index: QUOTE_SPOT_MARKET_INDEX,
            ..PoolBalance::default()
        },
        unrealized_pnl_maintenance_asset_weight: SPOT_WEIGHT_PRECISION.cast().unwrap(),
        ..PerpMarket::default()
    };
    create_anchor_account_info!(market, PerpMarket, market_account_info);
    let market_map = PerpMarketMap::load_one(&market_account_info, true).unwrap();

    let mut spot_market = SpotMarket {
        market_index: 0,
        oracle_source: OracleSource::QuoteAsset,
        cumulative_deposit_interest: SPOT_CUMULATIVE_INTEREST_PRECISION,
        decimals: 6,
        initial_asset_weight: SPOT_WEIGHT_PRECISION,
        maintenance_asset_weight: SPOT_WEIGHT_PRECISION,
        deposit_balance: 100 * SPOT_BALANCE_PRECISION,
        historical_oracle_data: HistoricalOracleData::default_price(QUOTE_PRECISION_I64),
        ..SpotMarket::default()
    };
    create_anchor_account_info!(spot_market, SpotMarket, spot_market_account_info);
    let spot_market_map = SpotMarketMap::load_one(&spot_market_account_info, true).unwrap();

    let mut user = User {
        perp_positions: get_positions(PerpPosition {
            market_index: 0,
            base_asset_amount: BASE_PRECISION_I64,
            quote_asset_amount: -50 * QUOTE_PRECISION_I64,
            quote_entry_amount: -100 * QUOTE_PRECISION_I64,
            quote_break_even_amount: -100 * QUOTE_PRECISION_I64,
            ..PerpPosition::default()
        }),
        spot_positions: get_spot_positions(SpotPosition {
            market_index: 0,
            balance_type: SpotBalanceType::Deposit,
            scaled_balance: 100 * SPOT_BALANCE_PRECISION_U64,
            ..SpotPosition::default()
        }),
        ..User::default()
    };

    let user_key = Pubkey::default();
    let authority = Pubkey::default();

    let mut expected_user = user;
    expected_user.perp_positions[0].quote_asset_amount = -100 * QUOTE_PRECISION_I64;
    expected_user.perp_positions[0].settled_pnl = 50 * QUOTE_PRECISION_I64;
    expected_user.spot_positions[0].scaled_balance = 150 * SPOT_BALANCE_PRECISION_U64;
    expected_user.spot_positions[0].cumulative_deposits = 50 * QUOTE_PRECISION_I64;

    let mut expected_market = market;
    expected_market.pnl_pool.scaled_balance = 0;
    expected_market.amm.quote_asset_amount = -200 * QUOTE_PRECISION_I128;

    assert!(settle_pnl(
        0,
        &mut user,
        &authority,
        &user_key,
        &market_map,
        &spot_market_map,
        &mut oracle_map,
        &clock,
        &state,
        None,
        SettlePnlMode::MustSettle
    )
    .is_err());
}

#[test]
pub fn user_long_negative_unrealized_pnl() {
    let clock = Clock {
        slot: 0,
        epoch_start_timestamp: 0,
        epoch: 0,
        leader_schedule_epoch: 0,
        unix_timestamp: 0,
    };
    let state = State {
        oracle_guard_rails: OracleGuardRails {
            validity: ValidityGuardRails {
                slots_before_stale_for_amm: 10,     // 5s
                slots_before_stale_for_margin: 120, // 60s
                confidence_interval_max_size: 1000,
                too_volatile_ratio: 5,
            },
            ..OracleGuardRails::default()
        },
        ..State::default()
    };
    let mut oracle_price = get_pyth_price(50, 6);
    let oracle_price_key =
        Pubkey::from_str("J83w4HKfqxwcq3BEMMkPFSppX3gqekLyLJBexebFVkix").unwrap();
    let pyth_program = crate::ids::pyth_program::id();
    create_account_info!(
        oracle_price,
        &oracle_price_key,
        &pyth_program,
        oracle_account_info
    );
    let mut oracle_map = OracleMap::load_one(&oracle_account_info, clock.slot, None).unwrap();

    let mut market = PerpMarket {
        amm: AMM {
            base_asset_reserve: 100 * AMM_RESERVE_PRECISION,
            quote_asset_reserve: 100 * AMM_RESERVE_PRECISION,
            bid_base_asset_reserve: 101 * AMM_RESERVE_PRECISION,
            bid_quote_asset_reserve: 99 * AMM_RESERVE_PRECISION,
            ask_base_asset_reserve: 99 * AMM_RESERVE_PRECISION,
            ask_quote_asset_reserve: 101 * AMM_RESERVE_PRECISION,
            sqrt_k: 100 * AMM_RESERVE_PRECISION,
            peg_multiplier: 51 * PEG_PRECISION,
            max_slippage_ratio: 50,
            max_fill_reserve_fraction: 100,
            order_step_size: 10000000,
            quote_asset_amount: -150 * QUOTE_PRECISION_I128,
            base_asset_amount_with_amm: BASE_PRECISION_I128,
            base_asset_amount_long: BASE_PRECISION_I128,
            oracle: oracle_price_key,
            historical_oracle_data: HistoricalOracleData {
                last_oracle_price: oracle_price.agg.price,
                last_oracle_price_twap_5min: oracle_price.agg.price,
                last_oracle_price_twap: oracle_price.agg.price,
                ..HistoricalOracleData::default()
            },
            ..AMM::default()
        },
        margin_ratio_initial: 1000,
        margin_ratio_maintenance: 500,
        number_of_users_with_base: 1,
        status: MarketStatus::Active,
        liquidator_fee: LIQUIDATION_FEE_PRECISION / 100,
        pnl_pool: PoolBalance {
            scaled_balance: (50 * SPOT_BALANCE_PRECISION),
            market_index: QUOTE_SPOT_MARKET_INDEX,
            ..PoolBalance::default()
        },
        unrealized_pnl_maintenance_asset_weight: SPOT_WEIGHT_PRECISION.cast().unwrap(),
        ..PerpMarket::default()
    };
    create_anchor_account_info!(market, PerpMarket, market_account_info);
    let market_map = PerpMarketMap::load_one(&market_account_info, true).unwrap();

    let mut spot_market = SpotMarket {
        market_index: 0,
        oracle_source: OracleSource::QuoteAsset,
        cumulative_deposit_interest: SPOT_CUMULATIVE_INTEREST_PRECISION,
        decimals: 6,
        initial_asset_weight: SPOT_WEIGHT_PRECISION,
        maintenance_asset_weight: SPOT_WEIGHT_PRECISION,
        deposit_balance: 100 * SPOT_BALANCE_PRECISION,
        historical_oracle_data: HistoricalOracleData::default_price(QUOTE_PRECISION_I64),
        ..SpotMarket::default()
    };
    create_anchor_account_info!(spot_market, SpotMarket, spot_market_account_info);
    let spot_market_map = SpotMarketMap::load_one(&spot_market_account_info, true).unwrap();

    let mut user = User {
        perp_positions: get_positions(PerpPosition {
            market_index: 0,
            base_asset_amount: BASE_PRECISION_I64,
            quote_asset_amount: -100 * QUOTE_PRECISION_I64,
            quote_entry_amount: -100 * QUOTE_PRECISION_I64,
            quote_break_even_amount: -100 * QUOTE_PRECISION_I64,
            ..PerpPosition::default()
        }),
        spot_positions: get_spot_positions(SpotPosition {
            market_index: 0,
            balance_type: SpotBalanceType::Deposit,
            scaled_balance: 100 * SPOT_BALANCE_PRECISION_U64,
            ..SpotPosition::default()
        }),
        ..User::default()
    };

    let user_key = Pubkey::default();
    let authority = Pubkey::default();

    let mut expected_user = user;
    expected_user.perp_positions[0].quote_asset_amount = -50 * QUOTE_PRECISION_I64;
    expected_user.settled_perp_pnl = -50 * QUOTE_PRECISION_I64;
    expected_user.perp_positions[0].settled_pnl = -50 * QUOTE_PRECISION_I64;
    expected_user.spot_positions[0].scaled_balance = 50 * SPOT_BALANCE_PRECISION_U64;

    let mut expected_market = market;
    expected_market.pnl_pool.scaled_balance = 100 * SPOT_BALANCE_PRECISION;
    expected_market.amm.quote_asset_amount = -100 * QUOTE_PRECISION_I128;

    settle_pnl(
        0,
        &mut user,
        &authority,
        &user_key,
        &market_map,
        &spot_market_map,
        &mut oracle_map,
        &clock,
        &state,
        None,
        SettlePnlMode::MustSettle,
    )
    .unwrap();

    assert_eq!(expected_user, user);
    assert_eq!(expected_market, *market_map.get_ref(&0).unwrap());
}

#[test]
pub fn user_short_positive_unrealized_pnl_up_to_max_positive_pnl() {
    let clock = Clock {
        slot: 0,
        epoch_start_timestamp: 0,
        epoch: 0,
        leader_schedule_epoch: 0,
        unix_timestamp: 0,
    };
    let state = State {
        oracle_guard_rails: OracleGuardRails {
            validity: ValidityGuardRails {
                slots_before_stale_for_amm: 10,     // 5s
                slots_before_stale_for_margin: 120, // 60s
                confidence_interval_max_size: 1000,
                too_volatile_ratio: 5,
            },
            ..OracleGuardRails::default()
        },
        ..State::default()
    };
    let mut oracle_price = get_pyth_price(50, 6);
    let oracle_price_key =
        Pubkey::from_str("J83w4HKfqxwcq3BEMMkPFSppX3gqekLyLJBexebFVkix").unwrap();
    let pyth_program = crate::ids::pyth_program::id();
    create_account_info!(
        oracle_price,
        &oracle_price_key,
        &pyth_program,
        oracle_account_info
    );
    let mut oracle_map = OracleMap::load_one(&oracle_account_info, clock.slot, None).unwrap();

    let mut market = PerpMarket {
        amm: AMM {
            base_asset_reserve: 100 * AMM_RESERVE_PRECISION,
            quote_asset_reserve: 100 * AMM_RESERVE_PRECISION,
            bid_base_asset_reserve: 101 * AMM_RESERVE_PRECISION,
            bid_quote_asset_reserve: 99 * AMM_RESERVE_PRECISION,
            ask_base_asset_reserve: 99 * AMM_RESERVE_PRECISION,
            ask_quote_asset_reserve: 101 * AMM_RESERVE_PRECISION,
            sqrt_k: 100 * AMM_RESERVE_PRECISION,
            peg_multiplier: 51 * PEG_PRECISION,
            max_slippage_ratio: 50,
            max_fill_reserve_fraction: 100,
            order_step_size: 10000000,
            quote_asset_amount: 150 * QUOTE_PRECISION_I128,
            base_asset_amount_with_amm: BASE_PRECISION_I128,
            base_asset_amount_long: BASE_PRECISION_I128,
            oracle: oracle_price_key,
            historical_oracle_data: HistoricalOracleData {
                last_oracle_price: oracle_price.agg.price,
                last_oracle_price_twap_5min: oracle_price.agg.price,
                last_oracle_price_twap: oracle_price.agg.price,
                ..HistoricalOracleData::default()
            },
            ..AMM::default()
        },
        margin_ratio_initial: 1000,
        margin_ratio_maintenance: 500,
        number_of_users_with_base: 1,
        status: MarketStatus::Active,
        liquidator_fee: LIQUIDATION_FEE_PRECISION / 100,
        pnl_pool: PoolBalance {
            scaled_balance: (50 * SPOT_BALANCE_PRECISION),
            market_index: QUOTE_SPOT_MARKET_INDEX,
            ..PoolBalance::default()
        },
        unrealized_pnl_maintenance_asset_weight: SPOT_WEIGHT_PRECISION.cast().unwrap(),
        ..PerpMarket::default()
    };
    create_anchor_account_info!(market, PerpMarket, market_account_info);
    let market_map = PerpMarketMap::load_one(&market_account_info, true).unwrap();

    let mut spot_market = SpotMarket {
        market_index: 0,
        oracle_source: OracleSource::QuoteAsset,
        cumulative_deposit_interest: SPOT_CUMULATIVE_INTEREST_PRECISION,
        decimals: 6,
        initial_asset_weight: SPOT_WEIGHT_PRECISION,
        maintenance_asset_weight: SPOT_WEIGHT_PRECISION,
        deposit_balance: 100 * SPOT_BALANCE_PRECISION,
        historical_oracle_data: HistoricalOracleData::default_price(QUOTE_PRECISION_I64),
        ..SpotMarket::default()
    };
    create_anchor_account_info!(spot_market, SpotMarket, spot_market_account_info);
    let spot_market_map = SpotMarketMap::load_one(&spot_market_account_info, true).unwrap();

    let mut user = User {
        perp_positions: get_positions(PerpPosition {
            market_index: 0,
            base_asset_amount: -BASE_PRECISION_I64,
            quote_asset_amount: 100 * QUOTE_PRECISION_I64,
            quote_entry_amount: 50 * QUOTE_PRECISION_I64,
            quote_break_even_amount: 50 * QUOTE_PRECISION_I64,
            ..PerpPosition::default()
        }),
        spot_positions: get_spot_positions(SpotPosition {
            market_index: 0,
            balance_type: SpotBalanceType::Deposit,
            scaled_balance: 100 * SPOT_BALANCE_PRECISION_U64,
            ..SpotPosition::default()
        }),
        ..User::default()
    };

    let user_key = Pubkey::default();
    let authority = Pubkey::default();

    let mut expected_user = user;
    expected_user.perp_positions[0].quote_asset_amount = 50 * QUOTE_PRECISION_I64;
    expected_user.settled_perp_pnl = 50 * QUOTE_PRECISION_I64;
    expected_user.perp_positions[0].settled_pnl = 50 * QUOTE_PRECISION_I64;
    expected_user.spot_positions[0].scaled_balance = 150 * SPOT_BALANCE_PRECISION_U64;

    let mut expected_market = market;
    expected_market.pnl_pool.scaled_balance = 0;
    expected_market.amm.quote_asset_amount = 100 * QUOTE_PRECISION_I128;

    settle_pnl(
        0,
        &mut user,
        &authority,
        &user_key,
        &market_map,
        &spot_market_map,
        &mut oracle_map,
        &clock,
        &state,
        None,
        SettlePnlMode::MustSettle,
    )
    .unwrap();

    assert_eq!(expected_user, user);
    assert_eq!(expected_market, *market_map.get_ref(&0).unwrap());
}

#[test]
pub fn user_short_negative_unrealized_pnl() {
    let clock = Clock {
        slot: 0,
        epoch_start_timestamp: 0,
        epoch: 0,
        leader_schedule_epoch: 0,
        unix_timestamp: 0,
    };
    let state = State {
        oracle_guard_rails: OracleGuardRails {
            validity: ValidityGuardRails {
                slots_before_stale_for_amm: 10,     // 5s
                slots_before_stale_for_margin: 120, // 60s
                confidence_interval_max_size: 1000,
                too_volatile_ratio: 5,
            },
            ..OracleGuardRails::default()
        },
        ..State::default()
    };
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
    let mut oracle_map = OracleMap::load_one(&oracle_account_info, clock.slot, None).unwrap();

    let mut market = PerpMarket {
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
            quote_asset_amount: 150 * QUOTE_PRECISION_I128,
            base_asset_amount_with_amm: BASE_PRECISION_I128,
            base_asset_amount_long: BASE_PRECISION_I128,
            oracle: oracle_price_key,
            historical_oracle_data: HistoricalOracleData {
                last_oracle_price: oracle_price.agg.price,
                last_oracle_price_twap_5min: oracle_price.agg.price,
                last_oracle_price_twap: oracle_price.agg.price,
                ..HistoricalOracleData::default()
            },
            ..AMM::default()
        },
        margin_ratio_initial: 1000,
        margin_ratio_maintenance: 500,
        number_of_users_with_base: 1,
        status: MarketStatus::Active,
        liquidator_fee: LIQUIDATION_FEE_PRECISION / 100,
        pnl_pool: PoolBalance {
            scaled_balance: (50 * SPOT_BALANCE_PRECISION),
            market_index: QUOTE_SPOT_MARKET_INDEX,
            ..PoolBalance::default()
        },
        unrealized_pnl_maintenance_asset_weight: SPOT_WEIGHT_PRECISION.cast().unwrap(),
        ..PerpMarket::default()
    };
    create_anchor_account_info!(market, PerpMarket, market_account_info);
    let market_map = PerpMarketMap::load_one(&market_account_info, true).unwrap();

    let mut spot_market = SpotMarket {
        market_index: 0,
        oracle_source: OracleSource::QuoteAsset,
        cumulative_deposit_interest: SPOT_CUMULATIVE_INTEREST_PRECISION,
        decimals: 6,
        initial_asset_weight: SPOT_WEIGHT_PRECISION,
        maintenance_asset_weight: SPOT_WEIGHT_PRECISION,
        deposit_balance: 100 * SPOT_BALANCE_PRECISION,
        historical_oracle_data: HistoricalOracleData::default_price(QUOTE_PRECISION_I64),
        ..SpotMarket::default()
    };
    create_anchor_account_info!(spot_market, SpotMarket, spot_market_account_info);
    let spot_market_map = SpotMarketMap::load_one(&spot_market_account_info, true).unwrap();

    let mut user = User {
        perp_positions: get_positions(PerpPosition {
            market_index: 0,
            base_asset_amount: -BASE_PRECISION_I64,
            quote_asset_amount: 50 * QUOTE_PRECISION_I64,
            quote_entry_amount: 50 * QUOTE_PRECISION_I64,
            quote_break_even_amount: 50 * QUOTE_PRECISION_I64,
            ..PerpPosition::default()
        }),
        spot_positions: get_spot_positions(SpotPosition {
            market_index: 0,
            balance_type: SpotBalanceType::Deposit,
            scaled_balance: 100 * SPOT_BALANCE_PRECISION_U64,
            ..SpotPosition::default()
        }),
        ..User::default()
    };

    let user_key = Pubkey::default();
    let authority = Pubkey::default();

    let mut expected_user = user;
    expected_user.perp_positions[0].quote_asset_amount = 100 * QUOTE_PRECISION_I64;
    expected_user.settled_perp_pnl = -50 * QUOTE_PRECISION_I64;
    expected_user.perp_positions[0].settled_pnl = -50 * QUOTE_PRECISION_I64;
    expected_user.spot_positions[0].scaled_balance = 50 * SPOT_BALANCE_PRECISION_U64;

    let mut expected_market = market;
    expected_market.pnl_pool.scaled_balance = 100 * SPOT_BALANCE_PRECISION;
    expected_market.amm.quote_asset_amount = 200 * QUOTE_PRECISION_I128;

    settle_pnl(
        0,
        &mut user,
        &authority,
        &user_key,
        &market_map,
        &spot_market_map,
        &mut oracle_map,
        &clock,
        &state,
        None,
        SettlePnlMode::MustSettle,
    )
    .unwrap();

    assert_eq!(expected_user, user);
    assert_eq!(expected_market, *market_map.get_ref(&0).unwrap());
}

#[test]
pub fn user_invalid_oracle_position() {
    let clock = Clock {
        slot: 100000,
        epoch_start_timestamp: 0,
        epoch: 0,
        leader_schedule_epoch: 0,
        unix_timestamp: 19929299,
    };
    let state = State {
        oracle_guard_rails: OracleGuardRails {
            validity: ValidityGuardRails {
                slots_before_stale_for_amm: 10,     // 5s
                slots_before_stale_for_margin: 120, // 60s
                confidence_interval_max_size: 1000,
                too_volatile_ratio: 5,
            },
            ..OracleGuardRails::default()
        },
        ..State::default()
    };
    let mut oracle_price = get_pyth_price(100, 6);
    oracle_price.curr_slot = clock.slot - 10;
    let oracle_price_key =
        Pubkey::from_str("J83w4HKfqxwcq3BEMMkPFSppX3gqekLyLJBexebFVkix").unwrap();
    let pyth_program = crate::ids::pyth_program::id();
    create_account_info!(
        oracle_price,
        &oracle_price_key,
        &pyth_program,
        oracle_account_info
    );
    let mut oracle_map = OracleMap::load_one(&oracle_account_info, clock.slot, None).unwrap();

    let mut market = PerpMarket {
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
            quote_asset_amount: 150 * QUOTE_PRECISION_I128,
            base_asset_amount_with_amm: BASE_PRECISION_I128,
            base_asset_amount_long: BASE_PRECISION_I128,
            oracle: oracle_price_key,
            curve_update_intensity: 100,
            historical_oracle_data: HistoricalOracleData {
                last_oracle_price: oracle_price.agg.price,
                last_oracle_price_twap_5min: oracle_price.agg.price,
                last_oracle_price_twap: oracle_price.agg.price,
                ..HistoricalOracleData::default()
            },
            ..AMM::default()
        },
        margin_ratio_initial: 1000,
        margin_ratio_maintenance: 500,
        number_of_users_with_base: 1,
        status: MarketStatus::Active,
        liquidator_fee: LIQUIDATION_FEE_PRECISION / 100,
        pnl_pool: PoolBalance {
            scaled_balance: (50 * SPOT_BALANCE_PRECISION),
            market_index: QUOTE_SPOT_MARKET_INDEX,
            ..PoolBalance::default()
        },
        unrealized_pnl_maintenance_asset_weight: SPOT_WEIGHT_PRECISION.cast().unwrap(),
        ..PerpMarket::default()
    };
    let mut spot_market = SpotMarket {
        market_index: 0,
        oracle_source: OracleSource::QuoteAsset,
        cumulative_deposit_interest: SPOT_CUMULATIVE_INTEREST_PRECISION,
        decimals: 6,
        initial_asset_weight: SPOT_WEIGHT_PRECISION,
        maintenance_asset_weight: SPOT_WEIGHT_PRECISION,
        deposit_balance: 100 * SPOT_BALANCE_PRECISION,
        historical_oracle_data: HistoricalOracleData::default_price(QUOTE_PRECISION_I64),
        ..SpotMarket::default()
    };
    create_anchor_account_info!(spot_market, SpotMarket, spot_market_account_info);
    let spot_market_map = SpotMarketMap::load_one(&spot_market_account_info, true).unwrap();

    let mut user = User {
        perp_positions: get_positions(PerpPosition {
            market_index: 0,
            base_asset_amount: -BASE_PRECISION_I64,
            quote_asset_amount: 50 * QUOTE_PRECISION_I64,
            quote_entry_amount: 50 * QUOTE_PRECISION_I64,
            quote_break_even_amount: 50 * QUOTE_PRECISION_I64,
            ..PerpPosition::default()
        }),
        spot_positions: get_spot_positions(SpotPosition {
            market_index: 0,
            balance_type: SpotBalanceType::Deposit,
            scaled_balance: 100 * SPOT_BALANCE_PRECISION_U64,
            ..SpotPosition::default()
        }),
        ..User::default()
    };

    let user_key = Pubkey::default();
    let authority = Pubkey::default();

    market
        .amm
        .historical_oracle_data
        .last_oracle_price_twap_5min -= market
        .amm
        .historical_oracle_data
        .last_oracle_price_twap_5min
        / 33;
    create_anchor_account_info!(market, PerpMarket, market_account_info);
    let market_map = PerpMarketMap::load_one(&market_account_info, true).unwrap();
    assert!(!market
        .is_price_divergence_ok_for_settle_pnl(oracle_price.agg.price)
        .unwrap());

    let result = settle_pnl(
        0,
        &mut user,
        &authority,
        &user_key,
        &market_map,
        &spot_market_map,
        &mut oracle_map,
        &clock,
        &state,
        None,
        SettlePnlMode::MustSettle,
    );
    assert_eq!(result, Err(ErrorCode::OracleStaleForMargin));

    market
        .amm
        .historical_oracle_data
        .last_oracle_price_twap_5min /= 2;
    market.amm.last_update_slot = clock.slot;
    create_anchor_account_info!(market, PerpMarket, market_account_info);
    let market_map = PerpMarketMap::load_one(&market_account_info, true).unwrap();
    assert!(!market
        .is_price_divergence_ok_for_settle_pnl(oracle_price.agg.price)
        .unwrap());

    let result = settle_pnl(
        0,
        &mut user,
        &authority,
        &user_key,
        &market_map,
        &spot_market_map,
        &mut oracle_map,
        &clock,
        &state,
        None,
        SettlePnlMode::MustSettle,
    );
    assert_eq!(result, Err(ErrorCode::PriceBandsBreached));

    market
        .amm
        .historical_oracle_data
        .last_oracle_price_twap_5min *= 4;
    market.amm.last_update_slot = clock.slot;
    create_anchor_account_info!(market, PerpMarket, market_account_info);
    let market_map = PerpMarketMap::load_one(&market_account_info, true).unwrap();
    assert!(!market
        .is_price_divergence_ok_for_settle_pnl(oracle_price.agg.price)
        .unwrap());

    let result = settle_pnl(
        0,
        &mut user,
        &authority,
        &user_key,
        &market_map,
        &spot_market_map,
        &mut oracle_map,
        &clock,
        &state,
        None,
        SettlePnlMode::MustSettle,
    );
    assert_eq!(result, Err(ErrorCode::PriceBandsBreached));

    market
        .amm
        .historical_oracle_data
        .last_oracle_price_twap_5min = oracle_price.agg.price * 95 / 100;
    create_anchor_account_info!(market, PerpMarket, market_account_info);
    let market_map = PerpMarketMap::load_one(&market_account_info, true).unwrap();
    assert!(!market
        .is_price_divergence_ok_for_settle_pnl(oracle_price.agg.price)
        .unwrap());

    let result = settle_pnl(
        0,
        &mut user,
        &authority,
        &user_key,
        &market_map,
        &spot_market_map,
        &mut oracle_map,
        &clock,
        &state,
        None,
        SettlePnlMode::MustSettle,
    );
    assert_eq!(result, Err(ErrorCode::OracleStaleForMargin));

    market
        .amm
        .historical_oracle_data
        .last_oracle_price_twap_5min = oracle_price.agg.price - 789789;
    create_anchor_account_info!(market, PerpMarket, market_account_info);
    let market_map = PerpMarketMap::load_one(&market_account_info, true).unwrap();

    assert!(market
        .is_price_divergence_ok_for_settle_pnl(oracle_price.agg.price)
        .unwrap());
    let result = settle_pnl(
        0,
        &mut user,
        &authority,
        &user_key,
        &market_map,
        &spot_market_map,
        &mut oracle_map,
        &clock,
        &state,
        None,
        SettlePnlMode::MustSettle,
    );
    assert_eq!(result, Ok(()));
}

#[test]
pub fn is_price_divergence_ok_on_invalid_oracle() {
    let clock = Clock {
        slot: 100000,
        epoch_start_timestamp: 0,
        epoch: 0,
        leader_schedule_epoch: 0,
        unix_timestamp: 19929299,
    };

    let mut oracle_price = get_pyth_price(100, 6);
    oracle_price.curr_slot = clock.slot - 10;
    let oracle_price_key =
        Pubkey::from_str("J83w4HKfqxwcq3BEMMkPFSppX3gqekLyLJBexebFVkix").unwrap();

    let mut market = PerpMarket {
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
            quote_asset_amount: 150 * QUOTE_PRECISION_I128,
            base_asset_amount_with_amm: BASE_PRECISION_I128,
            base_asset_amount_long: BASE_PRECISION_I128,
            oracle: oracle_price_key,
            historical_oracle_data: HistoricalOracleData {
                last_oracle_price: oracle_price.agg.price,
                last_oracle_price_twap_5min: oracle_price.agg.price,
                last_oracle_price_twap: oracle_price.agg.price,
                ..HistoricalOracleData::default()
            },
            ..AMM::default()
        },
        margin_ratio_initial: 1000,
        margin_ratio_maintenance: 500,
        number_of_users_with_base: 1,
        status: MarketStatus::Active,
        liquidator_fee: LIQUIDATION_FEE_PRECISION / 100,
        pnl_pool: PoolBalance {
            scaled_balance: (50 * SPOT_BALANCE_PRECISION),
            market_index: QUOTE_SPOT_MARKET_INDEX,
            ..PoolBalance::default()
        },
        unrealized_pnl_maintenance_asset_weight: SPOT_WEIGHT_PRECISION.cast().unwrap(),
        ..PerpMarket::default()
    };

    assert!(market
        .is_price_divergence_ok_for_settle_pnl(oracle_price.agg.price)
        .unwrap());

    market.amm.mark_std = (oracle_price.agg.price / 100) as u64;
    market.amm.oracle_std = (oracle_price.agg.price / 190) as u64;

    assert!(market
        .is_price_divergence_ok_for_settle_pnl(oracle_price.agg.price)
        .unwrap());

    market.amm.mark_std = (oracle_price.agg.price / 10) as u64;

    assert!(!market
        .is_price_divergence_ok_for_settle_pnl(oracle_price.agg.price)
        .unwrap());

    market.amm.oracle_std = (oracle_price.agg.price * 10) as u64;

    assert!(!market
        .is_price_divergence_ok_for_settle_pnl(oracle_price.agg.price)
        .unwrap());
}

#[test]
pub fn big_lp() {
    let slot = 283392111;

    let user_str = String::from("n3Vf4++XOuzQuo8/h3xT08SYWbd7ob/oaZiSl+Dl0JJ1sUbSN2T1Mwzd9xRZ1DCfrYBfTdgj38msCBn1maih1JKu7vCovzzaVHVyYm9jaGFyZ2VyIFZhdWx0ICAgICAgICAgICAgICBDFYZSlH8SAAAAAAAAAAAAAAAAAAAAAAAtHmGnjgUAAAAAAAAAAAAAp4MoG9UfAgAAAAAAAAAAAAAAAAAAAAAALRjRTIsAAAAWAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAte+///////BAAAAAAAAAA590qvQAoAAAAAAAAAAAAAAAAAAAAAAABYTGj/9fT//wEAAQAAAAAAHP6jMasWAAAAAAAAAAAAAAAAAAAAAAAAVa+EU6wWAAAGAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAKlTff//////CwAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAJi6LkAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAgAAAH+aMPMIAAAAANEaCmfz///dnW+K3wEAAOUJzOjWAQAAEb6w2NYBAAAASuUfmQMAAAC2GuBm/P//hu7Fyd7///8AEmIRptcLADtRynR8////OCJKKf3///99sQ78AAAKAwAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAyVnrWAEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAGAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAEI45BAAAAAASH7MCAAAAAAAuGTZRQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAvnbtmAAAAAAAAAACzhGUCAAABAQEAAQAAAQAAAAAAAEI45BAAAAAAnF3LCAAAAAAAFBfGaAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAvnbtmAAAAAAAAAAC0hGUCAAABAQEAAQAAAQAAAAAAAEI45BAAAAAAuD3KCAAAAAAAniIpnQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAvnbtmAAAAAAAAAAC1hGUCAAABAQEAAQAAAQAAAAAAAEI45BAAAAAAcB3JCAAAAAAA7bO96wAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAvnbtmAAAAAAAAAAC2hGUCAAABAQEAAQAAAQAAAAAAAEI45BAAAAAAjP3HCAAAAAAA85KZYQEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAvnbtmAAAAAAAAAAC3hGUCAAABAQEAAQAAAQAAAAAAAEI45BAAAAAA2FvSCAAAAAAAuGTZRQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAvnbtmAAAAAAAAAAC4hGUCAAABAQEAAQEAAQAAAAAAAEI45BAAAAAA6HzTCAAAAAAAFBfGaAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAvnbtmAAAAAAAAAAC5hGUCAAABAQEAAQEAAQAAAAAAAEI45BAAAAAAXJ7UCAAAAAAAniIpnQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAvnbtmAAAAAAAAAAC6hGUCAAABAQEAAQEAAQAAAAAAAEI45BAAAAAA0L/VCAAAAAAA7bO96wAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAvnbtmAAAAAAAAAAC7hGUCAAABAQEAAQEAAQAAAAAAAEI45BAAAAAAROHWCAAAAAAA85KZYQEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAvnbtmAAAAAAAAAAC8hGUCAAABAQEAAQEAAQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAQEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAQEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAQEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAQEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAQEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAQEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAQEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAQEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAQEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAQEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAQEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAQEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAQEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAQEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAQEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAQEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAQEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAQEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAQEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAQEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAQEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAQEAAAAAAAAAAAAAAJybu2YAAAAARX7exfIMAACYYPZOkQYAAAAAAAAAAAAAfDFAUuH///9LeJ6zyf///+jJuTbaAQAAAAAAAAAAAABCOOQQAAAAAL2EZQIAAAAAAQAAAAABAAoBAAAAAAAAAC6cu2YAAAAAAAAAAAAAAAA=");
    let mut decoded_bytes = base64::decode(user_str).unwrap();
    let user_bytes = decoded_bytes.as_mut_slice();
    let user_key = Pubkey::new_unique();
    let owner = Pubkey::from_str("dRiftyHA39MWEi3m9aunc5MzRF1JYuBsbn6VPcn33UH").unwrap();
    let mut lamports = 0;
    let user_account_info = create_account_info(&user_key, true, &mut lamports, user_bytes, &owner);
    let user_loader: AccountLoader<User> = AccountLoader::try_from(&user_account_info).unwrap();
    let mut user = user_loader.load_mut().unwrap();
    let authority = user.authority;
    user.status = user.status | (UserStatus::AdvancedLp as u8);

    let perp_market_str = String::from("Ct8MLGv1N/dvAH3EF67yBqaUQerctpm4yqpK+QNSrXCQz76p+B+ka5cdDKvImMwegHYSrqlRr4mPm/gqRPWD+8llAWp4/D4KsqDTCAAAAAAAAAAAAAAAAHUAAAAAAAAANU7TCAAAAAAAhNgIAAAAACGdu2YAAAAADUBgc3z//////////////3jZfyn9//////////////+FmTWk6uMPAAAAAAAAAAAAAAAAAAAAAACNLFGe6SoeAAAAAAAAAAAA6w5o447qbgAAAAAAAAAAAJxiDwAAAAAAAAAAAAAAAAA2xfsmdusdAAAAAAAAAAAAMTFMneNqHgAAAAAAAAAAALPhRzlm2DkAAAAAAAAAAAAZlmYCAAAAAAAAAAAAAAAAE8Tv8Y7qbgAAAAAAAAAAAABwDDNdLgEAAAAAAAAAAAAAY5LetdH+////////////+koM/P///////////////waIkhUTAAAAAAAAAAAAAAAAIA8MEgUDAAAAAAAAAAAA1xXhnAUDAAAAAAAAAAAAAN7i4k1r0v////////////+3HBvnLiwAAAAAAAAAAAAAhmX/WwrS/////////////9Ptj0RRLQAAAAAAAAAAAACrH1DIn/0XAAAAAAAAAAAAKZAUAAAAAAApkBQAAAAAACmQFAAAAAAA+TQOAAAAAAB7XqDLTggAAAAAAAAAAAAAocKqKnMCAAAAAAAAAAAAAFMvdhLvBQAAAAAAAAAAAAC1LukZbAUAAAAAAAAAAAAA0n0GCZoCAAAAAAAAAAAAAEws6euXAQAAAAAAAAAAAAD69Xr/CAAAAAAAAAAAAAAAf5ow8wgAAAAAAAAAAAAAAMG4+QwBAAAAAAAAAAAAAACKmkDXPiceAAAAAAAAAAAAjZUlGQz4bgAAAAAAAAAAADZEea3NMB4AAAAAAAAAAABGWJl86tRuAAAAAAAAAAAAsqDTCAAAAAAAAAAAAAAAAIB60QgAAAAA+kzUCAAAAAC949IIAAAAAFiy1wgAAAAAATjkEAAAAAB1AwAAAAAAAONshu7/////EpG7ZgAAAAAQDgAAAAAAAADh9QUAAAAAZAAAAAAAAAAA4fUFAAAAAAAAAAAAAAAAm8iPvthKAABUUtbjcgIAAElDlMxXAwAAIZ27ZgAAAAAN1wEAAAAAAH1SAAAAAAAAIZ27ZgAAAADuAgAA7CwAALYDAAD1BQAAAAAAAJx2AACoYTIAZMgHAMDIUt4DAAAAQpZREgAAAACVxnTJ+v///1jzhLr2////AAAAAAAAAAAAAAAAAAAAAPvextSKMA8AAAAAAAAAAAAAAAAAAAAAAFNPTC1QRVJQICAgICAgICAgICAgICAgICAgICAgICAgAJsy4v////8AZc0dAAAAAP8PpdToAAAAlBFY3hYAAADDkrtmAAAAAADh9QUAAAAAAAAAAAAAAAAAAAAAAAAAAKIzbgAAAAAAczwAAAAAAABKCQAAAAAAAMgAAAAAAAAATB0AANQwAADoAwAA9AEAAAAAAAAQJwAAwBUAAKsnAAAAAAEAAQAAALX/AAEBAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==");
    let mut decoded_bytes = base64::decode(perp_market_str).unwrap();
    let perp_market_bytes = decoded_bytes.as_mut_slice();
    let key = Pubkey::new_unique();
    let owner = Pubkey::from_str("dRiftyHA39MWEi3m9aunc5MzRF1JYuBsbn6VPcn33UH").unwrap();
    let mut lamports = 0;
    let perp_market_account_info =
        create_account_info(&key, true, &mut lamports, perp_market_bytes, &owner);
    let perp_market_map = PerpMarketMap::load_one(&perp_market_account_info, true).unwrap();

    let usdc_market_str = String::from("ZLEIa6hBQSdUX6MOo7w/PClm2otsPf7406t9pXygIypU5KAmT//Dwsy3xpWPA/Pp1GfkQjwaxq3rB7BfPBWigujgMxXAX1Z3xvp6877brTo9ZfNqq8l0MbG75MLS9uDkfKYCA0UvXWHmsHZFgFFAI49uEcLfeyYJqqXqJL+++g9w+I4yK2cfD1VTREMgICAgICAgICAgICAgICAgICAgICAgICAgICAgQEIPAAAAAAD2AgAAAAAAACIAAAAAAAAAREIPAAAAAABBQg8AAAAAANqcu2YAAAAAQEIPAAAAAABAQg8AAAAAAEBCDwAAAAAAQEIPAAAAAAAAAAAAAAAAAKkHxWwABgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABHkMifZGT+FrLhfKfHFav7xo95PrVMA7wMfE+znV7oDaCzHcYYEAAAAAAAAAAAAAOKjFAEEBAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAgCMRAAAAAABdkbtmAAAAABAOAAAAAAAAECcAAIgTAAAAAAAAAAAAAAAAAAAAAAAAnbP/lrmjDgEAAAAAAAAAALf0oomdvI0AAAAAAAAAAADtTcGGAgAAAAAAAAAAAAAApf5zwwIAAAAAAAAAAAAAABvBVnsAAAAAAAAAAAAAAABz/1h7AAAAAAAAAAAAAAAAABCl1OgAAAAAYLeYbIgAAMyZL2BYTAAAhNmRM+8pAAD3hwgAAAAAAP2cu2YAAAAA/Zy7ZgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAQAAAAAAAAAn3Z0AAAAAABAnAAAQJwAAECcAABAnAAAAAAAAAAAAAIgTAABgrgoA8EkCAICEHgAGAAAAAAAACgEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAKMFwEAAAAAAGC3mGyIAAAAAAABAQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=");
    let mut decoded_bytes = base64::decode(usdc_market_str).unwrap();
    let usdc_market_bytes = decoded_bytes.as_mut_slice();
    let key = Pubkey::new_unique();
    let owner = Pubkey::from_str("dRiftyHA39MWEi3m9aunc5MzRF1JYuBsbn6VPcn33UH").unwrap();
    let mut lamports = 0;
    let usdc_market_account_info =
        create_account_info(&key, true, &mut lamports, usdc_market_bytes, &owner);
    let spot_market_map = SpotMarketMap::load_one(&usdc_market_account_info, true).unwrap();

    let ts = spot_market_map
        .get_quote_spot_market()
        .unwrap()
        .last_interest_ts;

    let perp_oracle_price_key =
        Pubkey::from_str("BAtFj4kQttZRVep3UZS2aZRDixkGYgWsbqTBVDbnSsPF").unwrap();
    let perp_oracle_market_str = String::from("IvEjY51+9M2XHQyryJjMHoB2Eq6pUa+Jj5v4KkT1g/vJZQFqePw+CgAC7w2Lb9os66QdoV1AldHaOSoNL47Qxse8D0z6yMKAtW2LxapyAwAAAAsOyAAAAAAA+P///6+cu2YAAAAAr5y7ZgAAAAAIoMNyAwAAABY0tgAAAAAA9zfkEAAAAAA=");
    let mut decoded_bytes = base64::decode(perp_oracle_market_str).unwrap();
    let oracle_market_bytes = decoded_bytes.as_mut_slice();
    let mut lamports = 0;
    let pyth_program = crate::ids::drift_oracle_receiver_program::id();
    let perp_oracle_account_info = create_account_info(
        &perp_oracle_price_key,
        false,
        &mut lamports,
        oracle_market_bytes,
        &pyth_program,
    );

    let usdc_oracle_price_key =
        Pubkey::from_str("En8hkHLkRe9d9DraYmBTrus518BvmVH448YcvmrFM6Ce").unwrap();
    let usdc_oracle_market_str = String::from("IvEjY51+9M3Mt8aVjwPz6dRn5EI8Gsat6wewXzwVooLo4DMVwF9WdwAD6qAgxhzEeXEoE0Yc4VOJSpamwAsh7Qz8J5jR+anpyUqMuvUFAAAAAEgoAQAAAAAA+P////Scu2YAAAAA85y7ZgAAAAAExfUFAAAAAL84AQAAAAAAAzjkEAAAAAA=");
    let mut decoded_bytes = base64::decode(usdc_oracle_market_str).unwrap();
    let oracle_market_bytes = decoded_bytes.as_mut_slice();
    let mut lamports = 0;
    let pyth_program = crate::ids::drift_oracle_receiver_program::id();
    let usdc_oracle_account_info = create_account_info(
        &usdc_oracle_price_key,
        false,
        &mut lamports,
        oracle_market_bytes,
        &pyth_program,
    );

    let mut oracle_map = OracleMap::load(
        &mut vec![perp_oracle_account_info, usdc_oracle_account_info]
            .iter()
            .peekable(),
        slot,
        None,
    )
    .unwrap();

    let clock = Clock {
        slot,
        unix_timestamp: ts as i64,
        ..Clock::default()
    };

    let state = State::default();

    settle_pnl(
        0,
        &mut user,
        &authority,
        &user_key,
        &perp_market_map,
        &spot_market_map,
        &mut oracle_map,
        &clock,
        &state,
        Some(true),
        SettlePnlMode::MustSettle,
    )
    .unwrap();
}
