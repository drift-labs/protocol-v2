use crate::controller::lp::*;
use crate::controller::pnl::settle_pnl;
use crate::state::perp_market::AMM;
use crate::state::user::PerpPosition;
use std::str::FromStr;

use anchor_lang::Owner;
use solana_program::pubkey::Pubkey;

use crate::create_account_info;
use crate::create_anchor_account_info;
use crate::math::casting::Cast;
use crate::math::constants::{
    AMM_RESERVE_PRECISION, BASE_PRECISION_I128, BASE_PRECISION_U64, LIQUIDATION_FEE_PRECISION,
    PEG_PRECISION, QUOTE_PRECISION_I128, QUOTE_SPOT_MARKET_INDEX, SPOT_BALANCE_PRECISION,
    SPOT_BALANCE_PRECISION_U64, SPOT_CUMULATIVE_INTEREST_PRECISION, SPOT_WEIGHT_PRECISION,
};
use crate::math::margin::{
    calculate_margin_requirement_and_total_collateral_and_liability_info,
    calculate_perp_position_value_and_pnl, meets_maintenance_margin_requirement,
    MarginRequirementType,
};
use crate::state::margin_calculation::{MarginCalculation, MarginContext};
use crate::state::oracle::{HistoricalOracleData, OracleSource};
use crate::state::oracle::{OraclePriceData, StrictOraclePrice};
use crate::state::oracle_map::OracleMap;
use crate::state::perp_market::{MarketStatus, PerpMarket, PoolBalance};
use crate::state::perp_market_map::PerpMarketMap;
use crate::state::spot_market::{SpotBalanceType, SpotMarket};
use crate::state::spot_market_map::SpotMarketMap;
use crate::state::state::{OracleGuardRails, State, ValidityGuardRails};
use crate::state::user::{SpotPosition, User};
use crate::test_utils::*;
use crate::test_utils::{get_positions, get_pyth_price, get_spot_positions};
#[test]
fn test_lp_wont_collect_improper_funding() {
    let mut position = PerpPosition {
        base_asset_amount: 1,
        ..PerpPosition::default()
    };

    let amm = AMM {
        order_step_size: 1,
        ..AMM::default_test()
    };
    let mut market = PerpMarket {
        amm,
        ..PerpMarket::default_test()
    };
    mint_lp_shares(&mut position, &mut market, BASE_PRECISION_U64).unwrap();

    market.amm.base_asset_amount_per_lp = 10;
    market.amm.quote_asset_amount_per_lp = -10;
    market.amm.base_asset_amount_with_unsettled_lp = -10;
    market.amm.base_asset_amount_short = -10;
    market.amm.cumulative_funding_rate_long = -10;
    market.amm.cumulative_funding_rate_long = -10;

    let result = settle_lp_position(&mut position, &mut market);
    assert_eq!(result, Err(ErrorCode::InvalidPerpPositionDetected));
}

#[test]
fn test_full_long_settle() {
    let mut position = PerpPosition {
        ..PerpPosition::default()
    };

    let amm = AMM {
        order_step_size: 1,
        ..AMM::default_test()
    };
    let mut market = PerpMarket {
        amm,
        ..PerpMarket::default_test()
    };
    let og_market = market;

    mint_lp_shares(&mut position, &mut market, BASE_PRECISION_U64).unwrap();

    market.amm.base_asset_amount_per_lp = 10;
    market.amm.quote_asset_amount_per_lp = -10;
    market.amm.base_asset_amount_with_unsettled_lp = -10;
    market.amm.base_asset_amount_short = -10;

    settle_lp_position(&mut position, &mut market).unwrap();

    assert_eq!(position.last_base_asset_amount_per_lp, 10);
    assert_eq!(position.last_quote_asset_amount_per_lp, -10);
    assert_eq!(position.base_asset_amount, 10);
    assert_eq!(position.quote_asset_amount, -10);
    assert_eq!(market.amm.base_asset_amount_with_unsettled_lp, 0);
    // net baa doesnt change
    assert_eq!(
        og_market.amm.base_asset_amount_with_amm,
        market.amm.base_asset_amount_with_amm
    );

    // burn
    let lp_shares = position.lp_shares;
    burn_lp_shares(&mut position, &mut market, lp_shares, 0).unwrap();
    assert_eq!(position.lp_shares, 0);
    assert_eq!(og_market.amm.sqrt_k, market.amm.sqrt_k);
}

#[test]
fn test_full_short_settle() {
    let mut position = PerpPosition {
        ..PerpPosition::default()
    };

    let amm = AMM {
        peg_multiplier: 1,
        user_lp_shares: 100 * AMM_RESERVE_PRECISION,
        order_step_size: 1,
        ..AMM::default_test()
    };

    let mut market = PerpMarket {
        amm,
        ..PerpMarket::default_test()
    };

    mint_lp_shares(&mut position, &mut market, 100 * BASE_PRECISION_U64).unwrap();

    market.amm.base_asset_amount_per_lp = -10;
    market.amm.quote_asset_amount_per_lp = 10;

    settle_lp_position(&mut position, &mut market).unwrap();

    assert_eq!(position.last_base_asset_amount_per_lp, -10);
    assert_eq!(position.last_quote_asset_amount_per_lp, 10);
    assert_eq!(position.base_asset_amount, -10 * 100);
    assert_eq!(position.quote_asset_amount, 10 * 100);
}

#[test]
fn test_partial_short_settle() {
    let mut position = PerpPosition {
        ..PerpPosition::default()
    };

    let amm = AMM {
        order_step_size: 3,
        ..AMM::default_test()
    };

    let mut market = PerpMarket {
        amm,
        ..PerpMarket::default_test()
    };

    mint_lp_shares(&mut position, &mut market, BASE_PRECISION_U64).unwrap();

    market.amm.base_asset_amount_per_lp = -10;
    market.amm.quote_asset_amount_per_lp = 10;

    market.amm.base_asset_amount_with_unsettled_lp = 10;
    market.amm.base_asset_amount_long = 10;

    settle_lp_position(&mut position, &mut market).unwrap();

    assert_eq!(position.base_asset_amount, -9);
    assert_eq!(position.quote_asset_amount, 10);
    assert_eq!(position.remainder_base_asset_amount, -1);
    assert_eq!(position.last_base_asset_amount_per_lp, -10);
    assert_eq!(position.last_quote_asset_amount_per_lp, 10);

    // burn
    let _position = position;
    let lp_shares = position.lp_shares;
    burn_lp_shares(&mut position, &mut market, lp_shares, 0).unwrap();
    assert_eq!(position.lp_shares, 0);
}

#[test]
fn test_partial_long_settle() {
    let mut position = PerpPosition {
        lp_shares: BASE_PRECISION_U64,
        ..PerpPosition::default()
    };

    let amm = AMM {
        base_asset_amount_per_lp: -10,
        quote_asset_amount_per_lp: 10,
        order_step_size: 3,
        ..AMM::default_test()
    };

    let mut market = PerpMarket {
        amm,
        ..PerpMarket::default_test()
    };

    settle_lp_position(&mut position, &mut market).unwrap();

    assert_eq!(position.base_asset_amount, -9);
    assert_eq!(position.quote_asset_amount, 10);
    assert_eq!(position.remainder_base_asset_amount, -1);
    assert_eq!(position.last_base_asset_amount_per_lp, -10);
    assert_eq!(position.last_quote_asset_amount_per_lp, 10);
}

#[test]
fn test_remainder_long_settle_too_large_order_step_size() {
    let mut position = PerpPosition {
        ..PerpPosition::default()
    };

    let amm = AMM {
        order_step_size: 5 * BASE_PRECISION_U64,
        ..AMM::default_test()
    };
    let mut market = PerpMarket {
        amm,
        ..PerpMarket::default_test()
    };
    let og_market = market;

    mint_lp_shares(&mut position, &mut market, BASE_PRECISION_U64).unwrap();

    market.amm.base_asset_amount_per_lp = 10;
    market.amm.quote_asset_amount_per_lp = -10;
    market.amm.base_asset_amount_with_unsettled_lp = -10;
    market.amm.base_asset_amount_short = -10;

    settle_lp_position(&mut position, &mut market).unwrap();

    assert_eq!(position.last_base_asset_amount_per_lp, 10);
    assert_eq!(position.last_quote_asset_amount_per_lp, -10);
    assert_eq!(position.base_asset_amount, 0);
    assert_eq!(position.quote_asset_amount, -10);
    assert_eq!(position.remainder_base_asset_amount, 10);
    assert_eq!(market.amm.base_asset_amount_with_unsettled_lp, -10);
    // net baa doesnt change
    assert_eq!(
        og_market.amm.base_asset_amount_with_amm,
        market.amm.base_asset_amount_with_amm
    );

    // burn
    let lp_shares = position.lp_shares;
    assert_eq!(lp_shares, BASE_PRECISION_U64);
    burn_lp_shares(&mut position, &mut market, lp_shares, 22).unwrap();
    assert_eq!(position.lp_shares, 0);
    assert_eq!(og_market.amm.sqrt_k, market.amm.sqrt_k);
    assert_eq!(position.quote_asset_amount, -11);
    assert_eq!(position.base_asset_amount, 0);
    assert_eq!(position.remainder_base_asset_amount, 0);
}

#[test]
fn test_remainder_overflows_too_large_order_step_size() {
    let mut position = PerpPosition {
        ..PerpPosition::default()
    };

    let amm = AMM {
        order_step_size: 5 * BASE_PRECISION_U64,
        ..AMM::default_test()
    };
    let mut market = PerpMarket {
        amm,
        ..PerpMarket::default_test()
    };
    let og_market = market;

    mint_lp_shares(&mut position, &mut market, BASE_PRECISION_U64).unwrap();

    market.amm.base_asset_amount_per_lp = 10;
    market.amm.quote_asset_amount_per_lp = -10;
    market.amm.base_asset_amount_with_unsettled_lp = -10;
    market.amm.base_asset_amount_short = -10;

    settle_lp_position(&mut position, &mut market).unwrap();

    assert_eq!(position.last_base_asset_amount_per_lp, 10);
    assert_eq!(position.last_quote_asset_amount_per_lp, -10);
    assert_eq!(position.base_asset_amount, 0);
    assert_eq!(position.quote_asset_amount, -10);
    assert_eq!(position.remainder_base_asset_amount, 10);
    assert_eq!(market.amm.base_asset_amount_with_unsettled_lp, -10);
    // net baa doesnt change
    assert_eq!(
        og_market.amm.base_asset_amount_with_amm,
        market.amm.base_asset_amount_with_amm
    );

    market.amm.base_asset_amount_per_lp = BASE_PRECISION_I128 + 1;
    market.amm.quote_asset_amount_per_lp = -16900000000;
    market.amm.base_asset_amount_with_unsettled_lp = -(BASE_PRECISION_I128 + 1);
    market.amm.base_asset_amount_short = -(BASE_PRECISION_I128 + 1);

    settle_lp_position(&mut position, &mut market).unwrap();

    assert_eq!(position.last_base_asset_amount_per_lp, 1000000001);
    assert_eq!(position.last_quote_asset_amount_per_lp, -16900000000);
    assert_eq!(position.quote_asset_amount, -16900000000);
    assert_eq!(position.base_asset_amount, 0);
    assert_eq!(position.remainder_base_asset_amount, 1000000001);
    assert_eq!(
        (position.remainder_base_asset_amount as u64) < market.amm.order_step_size,
        true
    );

    // might break i32 limit
    market.amm.base_asset_amount_per_lp = 3 * BASE_PRECISION_I128 + 1;
    market.amm.quote_asset_amount_per_lp = -(3 * 16900000000);
    market.amm.base_asset_amount_with_unsettled_lp = -(3 * BASE_PRECISION_I128 + 1);
    market.amm.base_asset_amount_short = -(3 * BASE_PRECISION_I128 + 1);

    // not allowed to settle when remainder is above i32 but below order size
    assert!(settle_lp_position(&mut position, &mut market).is_err());

    assert_eq!(position.last_base_asset_amount_per_lp, 1000000001);
    assert_eq!(position.last_quote_asset_amount_per_lp, -16900000000);
    assert_eq!(position.quote_asset_amount, -16900000000);
    assert_eq!(position.base_asset_amount, 0);
    assert_eq!(position.remainder_base_asset_amount, 1000000001);
    assert_eq!(
        (position.remainder_base_asset_amount as u64) < market.amm.order_step_size,
        true
    );

    // past order_step_size on market
    market.amm.base_asset_amount_per_lp = 5 * BASE_PRECISION_I128 + 1;
    market.amm.quote_asset_amount_per_lp = -116900000000;
    market.amm.base_asset_amount_with_unsettled_lp = -(5 * BASE_PRECISION_I128 + 1);
    market.amm.base_asset_amount_short = -(5 * BASE_PRECISION_I128 + 1);

    settle_lp_position(&mut position, &mut market).unwrap();

    assert_eq!(position.last_base_asset_amount_per_lp, 5000000001);
    assert_eq!(position.last_quote_asset_amount_per_lp, -116900000000);
    assert_eq!(position.quote_asset_amount, -116900000000);
    assert_eq!(position.base_asset_amount, 5000000000);
    assert_eq!(position.remainder_base_asset_amount, 1);
    assert_eq!(
        (position.remainder_base_asset_amount as u64) < market.amm.order_step_size,
        true
    );

    // burn
    let lp_shares = position.lp_shares;
    assert_eq!(lp_shares, BASE_PRECISION_U64);
    burn_lp_shares(&mut position, &mut market, lp_shares, 22).unwrap();
    assert_eq!(position.lp_shares, 0);
    assert_eq!(og_market.amm.sqrt_k, market.amm.sqrt_k);
    assert_eq!(position.quote_asset_amount, -116900000001);
    assert_eq!(position.base_asset_amount, 5000000000);
    assert_eq!(position.remainder_base_asset_amount, 0);
}

#[test]
fn test_remainder_burn_large_order_step_size() {
    let mut position = PerpPosition {
        ..PerpPosition::default()
    };

    let amm = AMM {
        order_step_size: 2 * BASE_PRECISION_U64,
        ..AMM::default_test()
    };
    let mut market = PerpMarket {
        amm,
        ..PerpMarket::default_test()
    };
    let og_market = market;

    mint_lp_shares(&mut position, &mut market, BASE_PRECISION_U64).unwrap();

    market.amm.base_asset_amount_per_lp = 10;
    market.amm.quote_asset_amount_per_lp = -10;
    market.amm.base_asset_amount_with_unsettled_lp = -10;
    market.amm.base_asset_amount_short = -10;

    settle_lp_position(&mut position, &mut market).unwrap();

    assert_eq!(position.last_base_asset_amount_per_lp, 10);
    assert_eq!(position.last_quote_asset_amount_per_lp, -10);
    assert_eq!(position.base_asset_amount, 0);
    assert_eq!(position.quote_asset_amount, -10);
    assert_eq!(position.remainder_base_asset_amount, 10);
    assert_eq!(market.amm.base_asset_amount_with_unsettled_lp, -10);
    // net baa doesnt change
    assert_eq!(
        og_market.amm.base_asset_amount_with_amm,
        market.amm.base_asset_amount_with_amm
    );

    market.amm.base_asset_amount_per_lp = BASE_PRECISION_I128 + 1;
    market.amm.quote_asset_amount_per_lp = -16900000000;
    market.amm.base_asset_amount_with_unsettled_lp = -(BASE_PRECISION_I128 + 1);
    market.amm.base_asset_amount_short = -(BASE_PRECISION_I128 + 1);

    settle_lp_position(&mut position, &mut market).unwrap();

    assert_eq!(position.last_base_asset_amount_per_lp, 1000000001);
    assert_eq!(position.last_quote_asset_amount_per_lp, -16900000000);
    assert_eq!(position.quote_asset_amount, -16900000000);
    assert_eq!(position.base_asset_amount, 0);
    assert_eq!(position.remainder_base_asset_amount, 1000000001);
    assert_eq!(
        (position.remainder_base_asset_amount as u64) < market.amm.order_step_size,
        true
    );

    // burn with overflowed remainder
    let lp_shares = position.lp_shares;
    assert_eq!(lp_shares, BASE_PRECISION_U64);
    burn_lp_shares(&mut position, &mut market, lp_shares, 22).unwrap();
    assert_eq!(position.lp_shares, 0);
    assert_eq!(og_market.amm.sqrt_k, market.amm.sqrt_k);
    assert_eq!(position.quote_asset_amount, -16900000023);
    assert_eq!(position.base_asset_amount, 0);
    assert_eq!(position.remainder_base_asset_amount, 0);
}

#[test]
pub fn test_lp_settle_pnl() {
    let mut position = PerpPosition {
        ..PerpPosition::default()
    };
    position.last_cumulative_funding_rate = 1337;

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
    let slot = 0;
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
            order_step_size: 2 * BASE_PRECISION_U64 / 100,
            quote_asset_amount: -150 * QUOTE_PRECISION_I128,
            base_asset_amount_with_amm: BASE_PRECISION_I128,
            base_asset_amount_long: BASE_PRECISION_I128,
            oracle: oracle_price_key,
            concentration_coef: 1000001,
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
            scaled_balance: (50 * SPOT_BALANCE_PRECISION) as u128,
            market_index: QUOTE_SPOT_MARKET_INDEX,
            ..PoolBalance::default()
        },
        unrealized_pnl_maintenance_asset_weight: SPOT_WEIGHT_PRECISION.cast().unwrap(),
        ..PerpMarket::default()
    };

    mint_lp_shares(&mut position, &mut market, BASE_PRECISION_U64).unwrap();

    market.amm.base_asset_amount_per_lp = 10;
    market.amm.quote_asset_amount_per_lp = -10;
    market.amm.base_asset_amount_with_unsettled_lp = -10;
    market.amm.base_asset_amount_short = -10;
    market.amm.cumulative_funding_rate_long = 169;
    market.amm.cumulative_funding_rate_short = 169;

    settle_lp_position(&mut position, &mut market).unwrap();
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
    let user_key = Pubkey::default();
    let authority = Pubkey::default();

    let mut user = User {
        perp_positions: get_positions(position),
        spot_positions: get_spot_positions(SpotPosition {
            market_index: 0,
            balance_type: SpotBalanceType::Deposit,
            scaled_balance: 50 * SPOT_BALANCE_PRECISION_U64,
            ..SpotPosition::default()
        }),
        ..User::default()
    };

    let now = 1000000;

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

    let MarginCalculation {
        total_collateral: total_collateral1,
        margin_requirement: margin_requirement1,
        ..
    } = calculate_margin_requirement_and_total_collateral_and_liability_info(
        &user,
        &market_map,
        &spot_market_map,
        &mut oracle_map,
        MarginContext::standard(MarginRequirementType::Initial),
    )
    .unwrap();

    assert_eq!(total_collateral1, 49999988);
    assert_eq!(margin_requirement1, 2099020); // $2+ for margin req

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

    assert_eq!(result, Ok(()));
    // assert_eq!(result, Err(ErrorCode::InsufficientCollateralForSettlingPNL))
}

#[test]
fn test_lp_margin_calc() {
    let mut position = PerpPosition {
        ..PerpPosition::default()
    };
    position.last_cumulative_funding_rate = 1337;

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
    let slot = 0;
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
            order_step_size: 2 * BASE_PRECISION_U64 / 100,
            quote_asset_amount: -150 * QUOTE_PRECISION_I128,
            base_asset_amount_with_amm: BASE_PRECISION_I128,
            base_asset_amount_long: BASE_PRECISION_I128,
            oracle: oracle_price_key,
            concentration_coef: 1000001,
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
            scaled_balance: (50 * SPOT_BALANCE_PRECISION) as u128,
            market_index: QUOTE_SPOT_MARKET_INDEX,
            ..PoolBalance::default()
        },
        unrealized_pnl_maintenance_asset_weight: SPOT_WEIGHT_PRECISION.cast().unwrap(),
        ..PerpMarket::default()
    };

    mint_lp_shares(&mut position, &mut market, BASE_PRECISION_U64).unwrap();

    market.amm.base_asset_amount_per_lp = 100 * BASE_PRECISION_I128;
    market.amm.quote_asset_amount_per_lp = -BASE_PRECISION_I128;
    market.amm.base_asset_amount_with_unsettled_lp = -100 * BASE_PRECISION_I128;
    market.amm.base_asset_amount_short = -100 * BASE_PRECISION_I128;
    market.amm.cumulative_funding_rate_long = 169 * 100000000;
    market.amm.cumulative_funding_rate_short = 169 * 100000000;

    settle_lp_position(&mut position, &mut market).unwrap();
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
        perp_positions: get_positions(position),
        spot_positions: get_spot_positions(SpotPosition {
            market_index: 0,
            balance_type: SpotBalanceType::Deposit,
            scaled_balance: 5000 * SPOT_BALANCE_PRECISION_U64,
            ..SpotPosition::default()
        }),
        ..User::default()
    };
    user.perp_positions[0].base_asset_amount = BASE_PRECISION_I128 as i64;

    // user has lp shares + long and last cumulative funding doesnt match
    assert_eq!(user.perp_positions[0].lp_shares, 1000000000);
    assert_eq!(
        user.perp_positions[0].base_asset_amount,
        BASE_PRECISION_I128 as i64
    );
    assert!(
        user.perp_positions[0].last_cumulative_funding_rate != market.amm.last_funding_rate_long
    );

    let result =
        meets_maintenance_margin_requirement(&user, &market_map, &spot_market_map, &mut oracle_map);

    assert_eq!(result.unwrap(), true);

    // add move lower
    let oracle_price_data = OraclePriceData {
        price: oracle_price.agg.price as i64,
        confidence: 100000,
        delay: 1,
        has_sufficient_number_of_data_points: true,
    };

    assert_eq!(market.amm.base_asset_amount_per_lp, 100000000000);
    assert_eq!(market.amm.quote_asset_amount_per_lp, -1000000000);
    assert_eq!(market.amm.cumulative_funding_rate_long, 16900000000);
    assert_eq!(market.amm.cumulative_funding_rate_short, 16900000000);

    assert_eq!(user.perp_positions[0].lp_shares, 1000000000);
    assert_eq!(user.perp_positions[0].base_asset_amount, 1000000000);
    assert_eq!(
        user.perp_positions[0].last_base_asset_amount_per_lp,
        100000000000
    );
    assert_eq!(
        user.perp_positions[0].last_quote_asset_amount_per_lp,
        -1000000000
    );
    assert_eq!(
        user.perp_positions[0].last_cumulative_funding_rate,
        16900000000
    );

    // increase markets so user has to settle lp
    market.amm.base_asset_amount_per_lp *= 2;
    market.amm.quote_asset_amount_per_lp *= 20;

    // update funding so user has unsettled funding
    market.amm.cumulative_funding_rate_long *= 2;
    market.amm.cumulative_funding_rate_short *= 2;

    apply_lp_rebase_to_perp_market(&mut market, 1).unwrap();

    let sim_user_pos = user.perp_positions[0]
        .simulate_settled_lp_position(&market, oracle_price_data.price)
        .unwrap();
    assert_ne!(
        sim_user_pos.base_asset_amount,
        user.perp_positions[0].base_asset_amount
    );
    assert_eq!(sim_user_pos.base_asset_amount, 101000000000);
    assert_eq!(sim_user_pos.quote_asset_amount, -20000000000);
    assert_eq!(sim_user_pos.last_cumulative_funding_rate, 16900000000);

    let strict_quote_price = StrictOraclePrice::test(1000000);
    // ensure margin calc doesnt incorrectly count funding rate (funding pnl MUST come before settling lp)
    let (margin_requirement, weighted_unrealized_pnl, worse_case_base_asset_value) =
        calculate_perp_position_value_and_pnl(
            &user.perp_positions[0],
            &market,
            &oracle_price_data,
            &strict_quote_price,
            crate::math::margin::MarginRequirementType::Initial,
            0,
        )
        .unwrap();

    assert_eq!(margin_requirement, 1012000000); // $1010 + $2 mr for lp_shares
    assert_eq!(weighted_unrealized_pnl, -9916900000); // $-9900000000 upnl (+ -16900000 from old funding)
    assert_eq!(worse_case_base_asset_value, 10100000000); //$10100
}
