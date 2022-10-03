use crate::controller::pnl::settle_pnl;
use crate::create_account_info;
use crate::create_anchor_account_info;
use crate::error::ErrorCode;
use crate::math::casting::cast;
use crate::math::constants::{
    AMM_RESERVE_PRECISION, BASE_PRECISION_I128, BASE_PRECISION_I64, LIQUIDATION_FEE_PRECISION,
    PEG_PRECISION, QUOTE_PRECISION_I128, QUOTE_PRECISION_I64, QUOTE_SPOT_MARKET_INDEX,
    SPOT_BALANCE_PRECISION, SPOT_BALANCE_PRECISION_U64, SPOT_CUMULATIVE_INTEREST_PRECISION,
    SPOT_WEIGHT_PRECISION,
};
use crate::state::market::{MarketStatus, PerpMarket, PoolBalance, AMM};
use crate::state::oracle::{HistoricalOracleData, OracleSource};
use crate::state::oracle_map::OracleMap;
use crate::state::perp_market_map::PerpMarketMap;
use crate::state::spot_market::{SpotBalanceType, SpotMarket};
use crate::state::spot_market_map::SpotMarketMap;
use crate::state::state::{OracleGuardRails, PriceDivergenceGuardRails, State, ValidityGuardRails};
use crate::state::user::{PerpPosition, SpotPosition, User};
use crate::tests::utils::get_pyth_price;
use crate::tests::utils::*;
use anchor_lang::Owner;
use solana_program::pubkey::Pubkey;
use std::str::FromStr;

#[test]
pub fn user_no_position() {
    let now = 0_i64;
    let slot = 0_u64;

    let state = State {
        oracle_guard_rails: OracleGuardRails {
            price_divergence: PriceDivergenceGuardRails {
                mark_oracle_divergence_numerator: 1,
                mark_oracle_divergence_denominator: 10,
            },
            validity: ValidityGuardRails {
                slots_before_stale_for_amm: 10,     // 5s
                slots_before_stale_for_margin: 120, // 60s
                confidence_interval_max_size: 1000,
                too_volatile_ratio: 5,
            },
            use_for_liquidations: true,
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
            max_base_asset_amount_ratio: 100,
            base_asset_amount_step_size: 10000000,
            quote_asset_amount_long: -150 * QUOTE_PRECISION_I128,
            net_base_asset_amount: BASE_PRECISION_I128,
            oracle: oracle_price_key,
            historical_oracle_data: HistoricalOracleData {
                last_oracle_price: oracle_price.agg.price as i128,
                last_oracle_price_twap_5min: oracle_price.agg.price as i128,
                last_oracle_price_twap: oracle_price.agg.price as i128,
                ..HistoricalOracleData::default()
            },
            ..AMM::default()
        },
        margin_ratio_initial: 1000,
        margin_ratio_maintenance: 500,
        open_interest: 1,
        status: MarketStatus::Active,
        liquidator_fee: LIQUIDATION_FEE_PRECISION / 100,
        pnl_pool: PoolBalance {
            balance: (50 * SPOT_BALANCE_PRECISION) as u128,
            market_index: QUOTE_SPOT_MARKET_INDEX,
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
            balance: 50 * SPOT_BALANCE_PRECISION_U64,
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
        now,
        &state,
    );

    assert_eq!(result, Err(ErrorCode::UserHasNoPositionInMarket));
}

#[test]
pub fn user_does_not_meet_maintenance_requirement() {
    let now = 0_i64;
    let slot = 0_u64;

    let state = State {
        oracle_guard_rails: OracleGuardRails {
            price_divergence: PriceDivergenceGuardRails {
                mark_oracle_divergence_numerator: 1,
                mark_oracle_divergence_denominator: 10,
            },
            validity: ValidityGuardRails {
                slots_before_stale_for_amm: 10,     // 5s
                slots_before_stale_for_margin: 120, // 60s
                confidence_interval_max_size: 1000,
                too_volatile_ratio: 5,
            },
            use_for_liquidations: true,
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
            max_base_asset_amount_ratio: 100,
            base_asset_amount_step_size: 10000000,
            quote_asset_amount_long: -150 * QUOTE_PRECISION_I128,
            net_base_asset_amount: BASE_PRECISION_I128,
            oracle: oracle_price_key,
            historical_oracle_data: HistoricalOracleData {
                last_oracle_price: oracle_price.agg.price as i128,
                last_oracle_price_twap_5min: oracle_price.agg.price as i128,
                last_oracle_price_twap: oracle_price.agg.price as i128,
                ..HistoricalOracleData::default()
            },
            ..AMM::default()
        },
        margin_ratio_initial: 1000,
        margin_ratio_maintenance: 500,
        open_interest: 1,
        status: MarketStatus::Active,
        liquidator_fee: LIQUIDATION_FEE_PRECISION / 100,
        pnl_pool: PoolBalance {
            balance: (50 * SPOT_BALANCE_PRECISION) as u128,
            market_index: QUOTE_SPOT_MARKET_INDEX,
        },
        unrealized_maintenance_asset_weight: cast(SPOT_WEIGHT_PRECISION).unwrap(),
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
            balance: 100 * SPOT_BALANCE_PRECISION_U64,
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
        now,
        &state,
    );

    assert_eq!(result, Err(ErrorCode::InsufficientCollateralForSettlingPNL))
}

#[test]
pub fn user_unsettled_negative_pnl() {
    let now = 0_i64;
    let slot = 0_u64;
    let state = State {
        oracle_guard_rails: OracleGuardRails {
            price_divergence: PriceDivergenceGuardRails {
                mark_oracle_divergence_numerator: 1,
                mark_oracle_divergence_denominator: 10,
            },
            validity: ValidityGuardRails {
                slots_before_stale_for_amm: 10,     // 5s
                slots_before_stale_for_margin: 120, // 60s
                confidence_interval_max_size: 1000,
                too_volatile_ratio: 5,
            },
            use_for_liquidations: true,
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
            max_base_asset_amount_ratio: 100,
            base_asset_amount_step_size: 10000000,
            quote_asset_amount_long: -150 * QUOTE_PRECISION_I128,
            net_base_asset_amount: BASE_PRECISION_I128,
            oracle: oracle_price_key,
            historical_oracle_data: HistoricalOracleData {
                last_oracle_price: oracle_price.agg.price as i128,
                last_oracle_price_twap_5min: oracle_price.agg.price as i128,
                last_oracle_price_twap: oracle_price.agg.price as i128,
                ..HistoricalOracleData::default()
            },
            ..AMM::default()
        },
        margin_ratio_initial: 1000,
        margin_ratio_maintenance: 500,
        open_interest: 1,
        status: MarketStatus::Active,
        liquidator_fee: LIQUIDATION_FEE_PRECISION / 100,
        pnl_pool: PoolBalance {
            balance: (50 * SPOT_BALANCE_PRECISION) as u128,
            market_index: QUOTE_SPOT_MARKET_INDEX,
        },
        unrealized_maintenance_asset_weight: cast(SPOT_WEIGHT_PRECISION).unwrap(),
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
            balance: 100 * SPOT_BALANCE_PRECISION_U64,
            ..SpotPosition::default()
        }),
        ..User::default()
    };

    let user_key = Pubkey::default();
    let authority = Pubkey::default();

    let mut expected_user = user;
    expected_user.perp_positions[0].quote_asset_amount = 0;
    expected_user.perp_positions[0].settled_pnl = -50 * QUOTE_PRECISION_I64;
    expected_user.spot_positions[0].balance = 50 * SPOT_BALANCE_PRECISION_U64;
    expected_user.spot_positions[0].cumulative_deposits = -50 * QUOTE_PRECISION_I64;

    let mut expected_market = market;
    expected_market.pnl_pool.balance = 100 * SPOT_BALANCE_PRECISION;
    expected_market.amm.quote_asset_amount_long = -100 * QUOTE_PRECISION_I128;

    settle_pnl(
        0,
        &mut user,
        &authority,
        &user_key,
        &market_map,
        &spot_market_map,
        &mut oracle_map,
        now,
        &state,
    )
    .unwrap();

    assert_eq!(expected_user, user);
    assert_eq!(expected_market, *market_map.get_ref(&0).unwrap());
}

#[test]
pub fn user_unsettled_positive_pnl_more_than_pool() {
    let now = 0_i64;
    let slot = 0_u64;
    let state = State {
        oracle_guard_rails: OracleGuardRails {
            price_divergence: PriceDivergenceGuardRails {
                mark_oracle_divergence_numerator: 1,
                mark_oracle_divergence_denominator: 10,
            },
            validity: ValidityGuardRails {
                slots_before_stale_for_amm: 10,     // 5s
                slots_before_stale_for_margin: 120, // 60s
                confidence_interval_max_size: 1000,
                too_volatile_ratio: 5,
            },
            use_for_liquidations: true,
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
            max_base_asset_amount_ratio: 100,
            base_asset_amount_step_size: 10000000,
            quote_asset_amount_long: -150 * QUOTE_PRECISION_I128,
            net_base_asset_amount: BASE_PRECISION_I128,
            oracle: oracle_price_key,
            historical_oracle_data: HistoricalOracleData {
                last_oracle_price: oracle_price.agg.price as i128,
                last_oracle_price_twap_5min: oracle_price.agg.price as i128,
                last_oracle_price_twap: oracle_price.agg.price as i128,
                ..HistoricalOracleData::default()
            },
            ..AMM::default()
        },
        margin_ratio_initial: 1000,
        margin_ratio_maintenance: 500,
        open_interest: 1,
        status: MarketStatus::Active,
        liquidator_fee: LIQUIDATION_FEE_PRECISION / 100,
        pnl_pool: PoolBalance {
            balance: (50 * SPOT_BALANCE_PRECISION) as u128,
            market_index: QUOTE_SPOT_MARKET_INDEX,
        },
        unrealized_maintenance_asset_weight: cast(SPOT_WEIGHT_PRECISION).unwrap(),
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
            balance: 100 * SPOT_BALANCE_PRECISION_U64,
            ..SpotPosition::default()
        }),
        ..User::default()
    };

    let user_key = Pubkey::default();
    let authority = Pubkey::default();

    let mut expected_user = user;
    expected_user.perp_positions[0].quote_asset_amount = 50 * QUOTE_PRECISION_I64;
    expected_user.perp_positions[0].settled_pnl = 50 * QUOTE_PRECISION_I64;
    expected_user.spot_positions[0].balance = 150 * SPOT_BALANCE_PRECISION_U64;
    expected_user.spot_positions[0].cumulative_deposits = 50 * QUOTE_PRECISION_I64;

    let mut expected_market = market;
    expected_market.pnl_pool.balance = 0;
    expected_market.amm.quote_asset_amount_long = -200 * QUOTE_PRECISION_I128;

    settle_pnl(
        0,
        &mut user,
        &authority,
        &user_key,
        &market_map,
        &spot_market_map,
        &mut oracle_map,
        now,
        &state,
    )
    .unwrap();

    assert_eq!(expected_user, user);
    assert_eq!(expected_market, *market_map.get_ref(&0).unwrap());
}

#[test]
pub fn user_unsettled_positive_pnl_less_than_pool() {
    let now = 0_i64;
    let slot = 0_u64;
    let state = State {
        oracle_guard_rails: OracleGuardRails {
            price_divergence: PriceDivergenceGuardRails {
                mark_oracle_divergence_numerator: 1,
                mark_oracle_divergence_denominator: 10,
            },
            validity: ValidityGuardRails {
                slots_before_stale_for_amm: 10,     // 5s
                slots_before_stale_for_margin: 120, // 60s
                confidence_interval_max_size: 1000,
                too_volatile_ratio: 5,
            },
            use_for_liquidations: true,
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
            max_base_asset_amount_ratio: 100,
            base_asset_amount_step_size: 10000000,
            quote_asset_amount_long: -150 * QUOTE_PRECISION_I128,
            net_base_asset_amount: BASE_PRECISION_I128,
            oracle: oracle_price_key,
            historical_oracle_data: HistoricalOracleData {
                last_oracle_price: oracle_price.agg.price as i128,
                last_oracle_price_twap_5min: oracle_price.agg.price as i128,
                last_oracle_price_twap: oracle_price.agg.price as i128,
                ..HistoricalOracleData::default()
            },
            ..AMM::default()
        },
        margin_ratio_initial: 1000,
        margin_ratio_maintenance: 500,
        open_interest: 1,
        status: MarketStatus::Active,
        liquidator_fee: LIQUIDATION_FEE_PRECISION / 100,
        pnl_pool: PoolBalance {
            balance: (50 * SPOT_BALANCE_PRECISION) as u128,
            market_index: QUOTE_SPOT_MARKET_INDEX,
        },
        unrealized_maintenance_asset_weight: cast(SPOT_WEIGHT_PRECISION).unwrap(),
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
            balance: 100 * SPOT_BALANCE_PRECISION_U64,
            ..SpotPosition::default()
        }),
        ..User::default()
    };

    let user_key = Pubkey::default();
    let authority = Pubkey::default();

    let mut expected_user = user;
    expected_user.perp_positions[0].quote_asset_amount = 0;
    expected_user.perp_positions[0].settled_pnl = 25 * QUOTE_PRECISION_I64;
    expected_user.spot_positions[0].balance = 125 * SPOT_BALANCE_PRECISION_U64;
    expected_user.spot_positions[0].cumulative_deposits = 25 * QUOTE_PRECISION_I64;

    let mut expected_market = market;
    expected_market.pnl_pool.balance = 25 * SPOT_BALANCE_PRECISION;
    expected_market.amm.quote_asset_amount_long = -175 * QUOTE_PRECISION_I128;

    settle_pnl(
        0,
        &mut user,
        &authority,
        &user_key,
        &market_map,
        &spot_market_map,
        &mut oracle_map,
        now,
        &state,
    )
    .unwrap();

    assert_eq!(expected_user, user);
    assert_eq!(expected_market, *market_map.get_ref(&0).unwrap());
}

#[test]
pub fn market_fee_pool_receives_portion() {
    let now = 0_i64;
    let slot = 0;
    let state = State {
        oracle_guard_rails: OracleGuardRails {
            price_divergence: PriceDivergenceGuardRails {
                mark_oracle_divergence_numerator: 1,
                mark_oracle_divergence_denominator: 10,
            },
            validity: ValidityGuardRails {
                slots_before_stale_for_amm: 10,     // 5s
                slots_before_stale_for_margin: 120, // 60s
                confidence_interval_max_size: 1000,
                too_volatile_ratio: 5,
            },
            use_for_liquidations: true,
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
            max_base_asset_amount_ratio: 100,
            base_asset_amount_step_size: 10000000,
            quote_asset_amount_long: -150 * QUOTE_PRECISION_I128,
            net_base_asset_amount: BASE_PRECISION_I128,
            oracle: oracle_price_key,
            total_fee_minus_distributions: QUOTE_PRECISION_I128,
            historical_oracle_data: HistoricalOracleData {
                last_oracle_price: oracle_price.agg.price as i128,
                last_oracle_price_twap_5min: oracle_price.agg.price as i128,
                last_oracle_price_twap: oracle_price.agg.price as i128,
                ..HistoricalOracleData::default()
            },
            ..AMM::default()
        },
        margin_ratio_initial: 1000,
        margin_ratio_maintenance: 500,
        open_interest: 1,
        status: MarketStatus::Active,
        liquidator_fee: LIQUIDATION_FEE_PRECISION / 100,
        pnl_pool: PoolBalance {
            balance: (50 * SPOT_BALANCE_PRECISION) as u128,
            market_index: QUOTE_SPOT_MARKET_INDEX,
        },
        unrealized_maintenance_asset_weight: cast(SPOT_WEIGHT_PRECISION).unwrap(),
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
            balance: 200 * SPOT_BALANCE_PRECISION_U64,
            ..SpotPosition::default()
        }),
        ..User::default()
    };

    let user_key = Pubkey::default();
    let authority = Pubkey::default();

    let mut expected_user = user;
    expected_user.perp_positions[0].quote_asset_amount = 0;
    expected_user.perp_positions[0].settled_pnl = -100 * QUOTE_PRECISION_I64;
    expected_user.spot_positions[0].balance = 100 * SPOT_BALANCE_PRECISION_U64;
    expected_user.spot_positions[0].cumulative_deposits = -100 * QUOTE_PRECISION_I64;

    let mut expected_market = market;
    expected_market.pnl_pool.balance = 149 * SPOT_BALANCE_PRECISION;
    expected_market.amm.fee_pool.balance = SPOT_BALANCE_PRECISION;
    expected_market.amm.quote_asset_amount_long = -50 * QUOTE_PRECISION_I128;

    settle_pnl(
        0,
        &mut user,
        &authority,
        &user_key,
        &market_map,
        &spot_market_map,
        &mut oracle_map,
        now,
        &state,
    )
    .unwrap();

    assert_eq!(expected_user, user);
    assert_eq!(expected_market, *market_map.get_ref(&0).unwrap());
}

#[test]
pub fn market_fee_pool_pays_back_to_pnl_pool() {
    let now = 0_i64;
    let slot = 0_u64;
    let state = State {
        oracle_guard_rails: OracleGuardRails {
            price_divergence: PriceDivergenceGuardRails {
                mark_oracle_divergence_numerator: 1,
                mark_oracle_divergence_denominator: 10,
            },
            validity: ValidityGuardRails {
                slots_before_stale_for_amm: 10,     // 5s
                slots_before_stale_for_margin: 120, // 60s
                confidence_interval_max_size: 1000,
                too_volatile_ratio: 5,
            },
            use_for_liquidations: true,
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
            max_base_asset_amount_ratio: 100,
            base_asset_amount_step_size: 10000000,
            quote_asset_amount_long: -150 * QUOTE_PRECISION_I128,
            net_base_asset_amount: BASE_PRECISION_I128,
            oracle: oracle_price_key,
            total_fee_minus_distributions: QUOTE_PRECISION_I128,
            fee_pool: PoolBalance {
                balance: (2 * SPOT_BALANCE_PRECISION) as u128,
                market_index: QUOTE_SPOT_MARKET_INDEX,
            },
            historical_oracle_data: HistoricalOracleData {
                last_oracle_price: oracle_price.agg.price as i128,
                last_oracle_price_twap_5min: oracle_price.agg.price as i128,
                last_oracle_price_twap: oracle_price.agg.price as i128,
                ..HistoricalOracleData::default()
            },
            ..AMM::default()
        },
        margin_ratio_initial: 1000,
        margin_ratio_maintenance: 500,
        open_interest: 1,
        status: MarketStatus::Active,
        liquidator_fee: LIQUIDATION_FEE_PRECISION / 100,
        pnl_pool: PoolBalance {
            balance: (50 * SPOT_BALANCE_PRECISION) as u128,
            market_index: QUOTE_SPOT_MARKET_INDEX,
        },
        unrealized_maintenance_asset_weight: cast(SPOT_WEIGHT_PRECISION).unwrap(),
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
            balance: 200 * SPOT_BALANCE_PRECISION_U64,
            ..SpotPosition::default()
        }),
        ..User::default()
    };

    let user_key = Pubkey::default();
    let authority = Pubkey::default();

    let mut expected_user = user;
    expected_user.perp_positions[0].quote_asset_amount = 0;
    expected_user.perp_positions[0].settled_pnl = -100 * QUOTE_PRECISION_I64;
    expected_user.spot_positions[0].balance = 100 * SPOT_BALANCE_PRECISION_U64;
    expected_user.spot_positions[0].cumulative_deposits = -100 * QUOTE_PRECISION_I64;

    let mut expected_market = market;
    expected_market.pnl_pool.balance = 151 * SPOT_BALANCE_PRECISION;
    expected_market.amm.fee_pool.balance = SPOT_BALANCE_PRECISION;
    expected_market.amm.quote_asset_amount_long = -50 * QUOTE_PRECISION_I128;

    settle_pnl(
        0,
        &mut user,
        &authority,
        &user_key,
        &market_map,
        &spot_market_map,
        &mut oracle_map,
        now,
        &state,
    )
    .unwrap();

    assert_eq!(expected_user, user);
    assert_eq!(expected_market, *market_map.get_ref(&0).unwrap());
}

#[test]
pub fn user_long_positive_unrealized_pnl_up_to_max_positive_pnl() {
    let now = 0_i64;
    let slot = 0_u64;
    let state = State {
        oracle_guard_rails: OracleGuardRails {
            price_divergence: PriceDivergenceGuardRails {
                mark_oracle_divergence_numerator: 1,
                mark_oracle_divergence_denominator: 10,
            },
            validity: ValidityGuardRails {
                slots_before_stale_for_amm: 10,     // 5s
                slots_before_stale_for_margin: 120, // 60s
                confidence_interval_max_size: 1000,
                too_volatile_ratio: 5,
            },
            use_for_liquidations: true,
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
            peg_multiplier: 151 * PEG_PRECISION,
            max_slippage_ratio: 50,
            max_base_asset_amount_ratio: 100,
            base_asset_amount_step_size: 10000000,
            quote_asset_amount_long: -150 * QUOTE_PRECISION_I128,
            net_base_asset_amount: BASE_PRECISION_I128,
            oracle: oracle_price_key,
            historical_oracle_data: HistoricalOracleData {
                last_oracle_price: oracle_price.agg.price as i128,
                last_oracle_price_twap_5min: oracle_price.agg.price as i128,
                last_oracle_price_twap: oracle_price.agg.price as i128,
                ..HistoricalOracleData::default()
            },
            ..AMM::default()
        },
        margin_ratio_initial: 1000,
        margin_ratio_maintenance: 500,
        open_interest: 1,
        status: MarketStatus::Active,
        liquidator_fee: LIQUIDATION_FEE_PRECISION / 100,
        pnl_pool: PoolBalance {
            balance: (50 * SPOT_BALANCE_PRECISION) as u128,
            market_index: QUOTE_SPOT_MARKET_INDEX,
        },
        unrealized_maintenance_asset_weight: cast(SPOT_WEIGHT_PRECISION).unwrap(),
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
            ..PerpPosition::default()
        }),
        spot_positions: get_spot_positions(SpotPosition {
            market_index: 0,
            balance_type: SpotBalanceType::Deposit,
            balance: 100 * SPOT_BALANCE_PRECISION_U64,
            ..SpotPosition::default()
        }),
        ..User::default()
    };

    let user_key = Pubkey::default();
    let authority = Pubkey::default();

    let mut expected_user = user;
    expected_user.perp_positions[0].quote_asset_amount = -100 * QUOTE_PRECISION_I64;
    expected_user.perp_positions[0].settled_pnl = 50 * QUOTE_PRECISION_I64;
    expected_user.spot_positions[0].balance = 150 * SPOT_BALANCE_PRECISION_U64;
    expected_user.spot_positions[0].cumulative_deposits = 50 * QUOTE_PRECISION_I64;

    let mut expected_market = market;
    expected_market.pnl_pool.balance = 0;
    expected_market.amm.quote_asset_amount_long = -200 * QUOTE_PRECISION_I128;

    settle_pnl(
        0,
        &mut user,
        &authority,
        &user_key,
        &market_map,
        &spot_market_map,
        &mut oracle_map,
        now,
        &state,
    )
    .unwrap();

    assert_eq!(expected_user, user);
    assert_eq!(expected_market, *market_map.get_ref(&0).unwrap());
}

#[test]
pub fn user_long_positive_unrealized_pnl_up_to_max_positive_pnl_price_breached() {
    let now = 0_i64;
    let slot = 0_u64;
    let state = State {
        oracle_guard_rails: OracleGuardRails {
            price_divergence: PriceDivergenceGuardRails {
                mark_oracle_divergence_numerator: 1,
                mark_oracle_divergence_denominator: 10,
            },
            validity: ValidityGuardRails {
                slots_before_stale_for_amm: 10,     // 5s
                slots_before_stale_for_margin: 120, // 60s
                confidence_interval_max_size: 1000,
                too_volatile_ratio: 5,
            },
            use_for_liquidations: true,
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
            peg_multiplier: 121 * PEG_PRECISION,
            max_slippage_ratio: 50,
            max_base_asset_amount_ratio: 100,
            base_asset_amount_step_size: 10000000,
            quote_asset_amount_long: -150 * QUOTE_PRECISION_I128,
            net_base_asset_amount: BASE_PRECISION_I128,
            oracle: oracle_price_key,
            historical_oracle_data: HistoricalOracleData {
                last_oracle_price: oracle_price.agg.price as i128,
                last_oracle_price_twap_5min: oracle_price.agg.price as i128,
                last_oracle_price_twap: oracle_price.agg.price as i128,
                ..HistoricalOracleData::default()
            },
            ..AMM::default()
        },
        margin_ratio_initial: 1000,
        margin_ratio_maintenance: 500,
        open_interest: 1,
        status: MarketStatus::Active,
        liquidator_fee: LIQUIDATION_FEE_PRECISION / 100,
        pnl_pool: PoolBalance {
            balance: (50 * SPOT_BALANCE_PRECISION) as u128,
            market_index: QUOTE_SPOT_MARKET_INDEX,
        },
        unrealized_maintenance_asset_weight: cast(SPOT_WEIGHT_PRECISION).unwrap(),
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
            ..PerpPosition::default()
        }),
        spot_positions: get_spot_positions(SpotPosition {
            market_index: 0,
            balance_type: SpotBalanceType::Deposit,
            balance: 100 * SPOT_BALANCE_PRECISION_U64,
            ..SpotPosition::default()
        }),
        ..User::default()
    };

    let user_key = Pubkey::default();
    let authority = Pubkey::default();

    let mut expected_user = user;
    expected_user.perp_positions[0].quote_asset_amount = -100 * QUOTE_PRECISION_I64;
    expected_user.perp_positions[0].settled_pnl = 50 * QUOTE_PRECISION_I64;
    expected_user.spot_positions[0].balance = 150 * SPOT_BALANCE_PRECISION_U64;
    expected_user.spot_positions[0].cumulative_deposits = 50 * QUOTE_PRECISION_I64;

    let mut expected_market = market;
    expected_market.pnl_pool.balance = 0;
    expected_market.amm.quote_asset_amount_long = -200 * QUOTE_PRECISION_I128;

    assert!(settle_pnl(
        0,
        &mut user,
        &authority,
        &user_key,
        &market_map,
        &spot_market_map,
        &mut oracle_map,
        now,
        &state,
    )
    .is_err());
}

#[test]
pub fn user_long_negative_unrealized_pnl() {
    let now = 0_i64;
    let slot = 0_u64;
    let state = State {
        oracle_guard_rails: OracleGuardRails {
            price_divergence: PriceDivergenceGuardRails {
                mark_oracle_divergence_numerator: 1,
                mark_oracle_divergence_denominator: 10,
            },
            validity: ValidityGuardRails {
                slots_before_stale_for_amm: 10,     // 5s
                slots_before_stale_for_margin: 120, // 60s
                confidence_interval_max_size: 1000,
                too_volatile_ratio: 5,
            },
            use_for_liquidations: true,
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
            peg_multiplier: 51 * PEG_PRECISION,
            max_slippage_ratio: 50,
            max_base_asset_amount_ratio: 100,
            base_asset_amount_step_size: 10000000,
            quote_asset_amount_long: -150 * QUOTE_PRECISION_I128,
            net_base_asset_amount: BASE_PRECISION_I128,
            oracle: oracle_price_key,
            historical_oracle_data: HistoricalOracleData {
                last_oracle_price: oracle_price.agg.price as i128,
                last_oracle_price_twap_5min: oracle_price.agg.price as i128,
                last_oracle_price_twap: oracle_price.agg.price as i128,
                ..HistoricalOracleData::default()
            },
            ..AMM::default()
        },
        margin_ratio_initial: 1000,
        margin_ratio_maintenance: 500,
        open_interest: 1,
        status: MarketStatus::Active,
        liquidator_fee: LIQUIDATION_FEE_PRECISION / 100,
        pnl_pool: PoolBalance {
            balance: (50 * SPOT_BALANCE_PRECISION) as u128,
            market_index: QUOTE_SPOT_MARKET_INDEX,
        },
        unrealized_maintenance_asset_weight: cast(SPOT_WEIGHT_PRECISION).unwrap(),
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
            ..PerpPosition::default()
        }),
        spot_positions: get_spot_positions(SpotPosition {
            market_index: 0,
            balance_type: SpotBalanceType::Deposit,
            balance: 100 * SPOT_BALANCE_PRECISION_U64,
            ..SpotPosition::default()
        }),
        ..User::default()
    };

    let user_key = Pubkey::default();
    let authority = Pubkey::default();

    let mut expected_user = user;
    expected_user.perp_positions[0].quote_asset_amount = -50 * QUOTE_PRECISION_I64;
    expected_user.perp_positions[0].settled_pnl = -50 * QUOTE_PRECISION_I64;
    expected_user.spot_positions[0].balance = 50 * SPOT_BALANCE_PRECISION_U64;
    expected_user.spot_positions[0].cumulative_deposits = -50 * QUOTE_PRECISION_I64;

    let mut expected_market = market;
    expected_market.pnl_pool.balance = 100 * SPOT_BALANCE_PRECISION;
    expected_market.amm.quote_asset_amount_long = -100 * QUOTE_PRECISION_I128;

    settle_pnl(
        0,
        &mut user,
        &authority,
        &user_key,
        &market_map,
        &spot_market_map,
        &mut oracle_map,
        now,
        &state,
    )
    .unwrap();

    assert_eq!(expected_user, user);
    assert_eq!(expected_market, *market_map.get_ref(&0).unwrap());
}

#[test]
pub fn user_short_positive_unrealized_pnl_up_to_max_positive_pnl() {
    let now = 0_i64;
    let slot = 0_u64;
    let state = State {
        oracle_guard_rails: OracleGuardRails {
            price_divergence: PriceDivergenceGuardRails {
                mark_oracle_divergence_numerator: 1,
                mark_oracle_divergence_denominator: 10,
            },
            validity: ValidityGuardRails {
                slots_before_stale_for_amm: 10,     // 5s
                slots_before_stale_for_margin: 120, // 60s
                confidence_interval_max_size: 1000,
                too_volatile_ratio: 5,
            },
            use_for_liquidations: true,
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
            peg_multiplier: 51 * PEG_PRECISION,
            max_slippage_ratio: 50,
            max_base_asset_amount_ratio: 100,
            base_asset_amount_step_size: 10000000,
            quote_asset_amount_short: 150 * QUOTE_PRECISION_I128,
            net_base_asset_amount: BASE_PRECISION_I128,
            oracle: oracle_price_key,
            historical_oracle_data: HistoricalOracleData {
                last_oracle_price: oracle_price.agg.price as i128,
                last_oracle_price_twap_5min: oracle_price.agg.price as i128,
                last_oracle_price_twap: oracle_price.agg.price as i128,
                ..HistoricalOracleData::default()
            },
            ..AMM::default()
        },
        margin_ratio_initial: 1000,
        margin_ratio_maintenance: 500,
        open_interest: 1,
        status: MarketStatus::Active,
        liquidator_fee: LIQUIDATION_FEE_PRECISION / 100,
        pnl_pool: PoolBalance {
            balance: (50 * SPOT_BALANCE_PRECISION) as u128,
            market_index: QUOTE_SPOT_MARKET_INDEX,
        },
        unrealized_maintenance_asset_weight: cast(SPOT_WEIGHT_PRECISION).unwrap(),
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
            ..PerpPosition::default()
        }),
        spot_positions: get_spot_positions(SpotPosition {
            market_index: 0,
            balance_type: SpotBalanceType::Deposit,
            balance: 100 * SPOT_BALANCE_PRECISION_U64,
            ..SpotPosition::default()
        }),
        ..User::default()
    };

    let user_key = Pubkey::default();
    let authority = Pubkey::default();

    let mut expected_user = user;
    expected_user.perp_positions[0].quote_asset_amount = 50 * QUOTE_PRECISION_I64;
    expected_user.perp_positions[0].settled_pnl = 50 * QUOTE_PRECISION_I64;
    expected_user.spot_positions[0].balance = 150 * SPOT_BALANCE_PRECISION_U64;
    expected_user.spot_positions[0].cumulative_deposits = 50 * QUOTE_PRECISION_I64;

    let mut expected_market = market;
    expected_market.pnl_pool.balance = 0;
    expected_market.amm.quote_asset_amount_short = 100 * QUOTE_PRECISION_I128;

    settle_pnl(
        0,
        &mut user,
        &authority,
        &user_key,
        &market_map,
        &spot_market_map,
        &mut oracle_map,
        now,
        &state,
    )
    .unwrap();

    assert_eq!(expected_user, user);
    assert_eq!(expected_market, *market_map.get_ref(&0).unwrap());
}

#[test]
pub fn user_short_negative_unrealized_pnl() {
    let now = 0_i64;
    let slot = 0_u64;
    let state = State {
        oracle_guard_rails: OracleGuardRails {
            price_divergence: PriceDivergenceGuardRails {
                mark_oracle_divergence_numerator: 1,
                mark_oracle_divergence_denominator: 10,
            },
            validity: ValidityGuardRails {
                slots_before_stale_for_amm: 10,     // 5s
                slots_before_stale_for_margin: 120, // 60s
                confidence_interval_max_size: 1000,
                too_volatile_ratio: 5,
            },
            use_for_liquidations: true,
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
            max_base_asset_amount_ratio: 100,
            base_asset_amount_step_size: 10000000,
            quote_asset_amount_short: 150 * QUOTE_PRECISION_I128,
            net_base_asset_amount: BASE_PRECISION_I128,
            oracle: oracle_price_key,
            historical_oracle_data: HistoricalOracleData {
                last_oracle_price: oracle_price.agg.price as i128,
                last_oracle_price_twap_5min: oracle_price.agg.price as i128,
                last_oracle_price_twap: oracle_price.agg.price as i128,
                ..HistoricalOracleData::default()
            },
            ..AMM::default()
        },
        margin_ratio_initial: 1000,
        margin_ratio_maintenance: 500,
        open_interest: 1,
        status: MarketStatus::Active,
        liquidator_fee: LIQUIDATION_FEE_PRECISION / 100,
        pnl_pool: PoolBalance {
            balance: (50 * SPOT_BALANCE_PRECISION) as u128,
            market_index: QUOTE_SPOT_MARKET_INDEX,
        },
        unrealized_maintenance_asset_weight: cast(SPOT_WEIGHT_PRECISION).unwrap(),
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
            ..PerpPosition::default()
        }),
        spot_positions: get_spot_positions(SpotPosition {
            market_index: 0,
            balance_type: SpotBalanceType::Deposit,
            balance: 100 * SPOT_BALANCE_PRECISION_U64,
            ..SpotPosition::default()
        }),
        ..User::default()
    };

    let user_key = Pubkey::default();
    let authority = Pubkey::default();

    let mut expected_user = user;
    expected_user.perp_positions[0].quote_asset_amount = 100 * QUOTE_PRECISION_I64;
    expected_user.perp_positions[0].settled_pnl = -50 * QUOTE_PRECISION_I64;
    expected_user.spot_positions[0].balance = 50 * SPOT_BALANCE_PRECISION_U64;
    expected_user.spot_positions[0].cumulative_deposits = -50 * QUOTE_PRECISION_I64;

    let mut expected_market = market;
    expected_market.pnl_pool.balance = 100 * SPOT_BALANCE_PRECISION;
    expected_market.amm.quote_asset_amount_short = 200 * QUOTE_PRECISION_I128;

    settle_pnl(
        0,
        &mut user,
        &authority,
        &user_key,
        &market_map,
        &spot_market_map,
        &mut oracle_map,
        now,
        &state,
    )
    .unwrap();

    assert_eq!(expected_user, user);
    assert_eq!(expected_market, *market_map.get_ref(&0).unwrap());
}
