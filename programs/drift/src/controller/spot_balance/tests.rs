use std::str::FromStr;

use anchor_lang::Owner;
use solana_program::pubkey::Pubkey;

use crate::controller::insurance::settle_revenue_to_insurance_fund;
use crate::controller::spot_balance::*;
use crate::controller::spot_position::update_spot_balances_and_cumulative_deposits_with_limits;
use crate::create_account_info;
use crate::create_anchor_account_info;
use crate::math::constants::{
    AMM_RESERVE_PRECISION, BASE_PRECISION_I128, BASE_PRECISION_I64, LIQUIDATION_FEE_PRECISION,
    PEG_PRECISION, PRICE_PRECISION_I64, PRICE_PRECISION_U64, QUOTE_PRECISION, QUOTE_PRECISION_I128,
    QUOTE_PRECISION_I64, QUOTE_PRECISION_U64, SPOT_BALANCE_PRECISION, SPOT_BALANCE_PRECISION_U64,
    SPOT_CUMULATIVE_INTEREST_PRECISION, SPOT_RATE_PRECISION_U32, SPOT_UTILIZATION_PRECISION,
    SPOT_UTILIZATION_PRECISION_U32, SPOT_WEIGHT_PRECISION,
};
use crate::math::margin::{
    calculate_margin_requirement_and_total_collateral_and_liability_info, MarginRequirementType,
};
use crate::math::spot_withdraw::{
    calculate_max_borrow_token_amount, calculate_min_deposit_token_amount,
    calculate_token_utilization_limits, check_withdraw_limits,
};
use crate::math::stats::calculate_weighted_average;
use crate::state::margin_calculation::{MarginCalculation, MarginContext};
use crate::state::oracle::{HistoricalOracleData, OracleSource};
use crate::state::oracle_map::OracleMap;
use crate::state::perp_market::{MarketStatus, PerpMarket, AMM};
use crate::state::perp_market_map::PerpMarketMap;
use crate::state::spot_market::{InsuranceFund, SpotBalanceType, SpotMarket};
use crate::state::spot_market_map::SpotMarketMap;
use crate::state::user::{Order, PerpPosition, SpotPosition, User};
use crate::test_utils::*;
use crate::test_utils::{get_pyth_price, get_spot_positions};

pub fn check_perp_market_valid(
    perp_market: &PerpMarket,
    spot_market: &SpotMarket,
    spot_balance: &mut dyn SpotBalance,
    current_slot: u64,
) -> DriftResult {
    // todo

    if perp_market.amm.oracle == spot_market.oracle
        && spot_balance.balance_type() == &SpotBalanceType::Borrow
        && (perp_market.amm.last_update_slot != current_slot || !perp_market.amm.last_oracle_valid)
    {
        return Err(ErrorCode::InvalidOracle);
    }

    Ok(())
}

#[test]
fn test_daily_withdraw_limits() {
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
    let _oracle_map = OracleMap::load_one(&oracle_account_info, slot, None).unwrap();

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
            quote_asset_amount: 50 * QUOTE_PRECISION_I128,
            base_asset_amount_with_amm: BASE_PRECISION_I128,
            oracle: oracle_price_key,
            historical_oracle_data: HistoricalOracleData::default_price(oracle_price.agg.price),
            ..AMM::default()
        },
        margin_ratio_initial: 1000,
        margin_ratio_maintenance: 500,
        number_of_users_with_base: 1,
        status: MarketStatus::Active,
        liquidator_fee: LIQUIDATION_FEE_PRECISION / 100,
        ..PerpMarket::default()
    };
    create_anchor_account_info!(market, PerpMarket, market_account_info);
    let _perp_market_map = PerpMarketMap::load_one(&market_account_info, true).unwrap();

    let mut spot_market = SpotMarket {
        market_index: 0,
        oracle_source: OracleSource::QuoteAsset,
        cumulative_deposit_interest: SPOT_CUMULATIVE_INTEREST_PRECISION,
        cumulative_borrow_interest: SPOT_CUMULATIVE_INTEREST_PRECISION,

        decimals: 6,
        initial_asset_weight: SPOT_WEIGHT_PRECISION,
        maintenance_asset_weight: SPOT_WEIGHT_PRECISION,
        deposit_balance: SPOT_BALANCE_PRECISION,
        borrow_balance: 0,
        deposit_token_twap: QUOTE_PRECISION_U64 / 2,
        status: MarketStatus::Active,

        ..SpotMarket::default()
    };
    create_anchor_account_info!(spot_market, SpotMarket, spot_market_account_info);
    let mut sol_spot_market = SpotMarket {
        market_index: 1,
        oracle_source: OracleSource::Pyth,
        oracle: oracle_price_key,
        cumulative_deposit_interest: SPOT_CUMULATIVE_INTEREST_PRECISION,
        cumulative_borrow_interest: SPOT_CUMULATIVE_INTEREST_PRECISION,
        decimals: 10,
        initial_asset_weight: 8 * SPOT_WEIGHT_PRECISION / 10,
        maintenance_asset_weight: 9 * SPOT_WEIGHT_PRECISION / 10,
        initial_liability_weight: 12 * SPOT_WEIGHT_PRECISION / 10,
        maintenance_liability_weight: 11 * SPOT_WEIGHT_PRECISION / 10,
        deposit_balance: SPOT_BALANCE_PRECISION,
        borrow_balance: SPOT_BALANCE_PRECISION,
        deposit_token_twap: (SPOT_BALANCE_PRECISION * 10) as u64,
        borrow_token_twap: 0,

        liquidator_fee: LIQUIDATION_FEE_PRECISION / 1000,
        status: MarketStatus::Active,

        ..SpotMarket::default()
    };
    create_anchor_account_info!(sol_spot_market, SpotMarket, sol_spot_market_account_info);
    let spot_market_account_infos =
        Vec::from([&spot_market_account_info, &sol_spot_market_account_info]);
    let _spot_market_map = SpotMarketMap::load_multiple(spot_market_account_infos, true).unwrap();

    let mut spot_positions = [SpotPosition::default(); 8];
    spot_positions[0] = SpotPosition {
        market_index: 0,
        balance_type: SpotBalanceType::Deposit,
        scaled_balance: SPOT_BALANCE_PRECISION_U64,
        ..SpotPosition::default()
    };
    let mut user = User {
        orders: [Order::default(); 32],
        perp_positions: [PerpPosition::default(); 8],
        spot_positions,
        ..User::default()
    };

    let amount: u64 = QUOTE_PRECISION as u64;

    assert_eq!(
        spot_market.cumulative_deposit_interest,
        SPOT_CUMULATIVE_INTEREST_PRECISION
    );
    assert_eq!(
        spot_market.cumulative_borrow_interest,
        SPOT_CUMULATIVE_INTEREST_PRECISION
    );

    // TEST USER WITHDRAW

    // fails
    let spot_market_backup = spot_market;
    let user_backup = user;
    assert!(update_spot_balances_and_cumulative_deposits_with_limits(
        amount as u128,
        &SpotBalanceType::Borrow,
        &mut spot_market,
        &mut user,
    )
    .is_err());
    spot_market = spot_market_backup;
    user = user_backup;
    assert_eq!(spot_market.deposit_balance, SPOT_BALANCE_PRECISION);

    // .50 * .2 = .1
    assert_eq!(spot_market.deposit_token_twap, 500000);
    assert_eq!(user.spot_positions[0].scaled_balance, 1000000000);
    assert_eq!(spot_market.deposit_balance, 1000000000);
    assert_eq!(spot_market.borrow_balance, 0);
    assert_eq!((amount / 2), 500000);
    update_spot_balances_and_cumulative_deposits_with_limits(
        (amount / 2) as u128,
        &SpotBalanceType::Borrow,
        &mut spot_market,
        &mut user,
    )
    .unwrap();
    assert_eq!(user.spot_positions[0].scaled_balance, 499999999);
    assert_eq!(spot_market.deposit_token_twap, 500000);
    assert_eq!(spot_market.deposit_balance, 499999999);
    assert_eq!(spot_market.borrow_balance, 0);

    // .50 * .25 = .125
    update_spot_balances_and_cumulative_deposits_with_limits(
        (125000 - 2) as u128,
        &SpotBalanceType::Borrow,
        &mut spot_market,
        &mut user,
    )
    .unwrap();

    //fail
    let spot_market_backup = spot_market;
    let user_backup = user;
    assert!(update_spot_balances_and_cumulative_deposits_with_limits(
        2_u128,
        &SpotBalanceType::Borrow,
        &mut spot_market,
        &mut user,
    )
    .is_err());
    spot_market = spot_market_backup;
    user = user_backup;
    assert_eq!(spot_market.deposit_balance, 375001998);
    assert_eq!(user.spot_positions[0].scaled_balance, 375001998);
    assert_eq!(user.spot_positions[0].market_index, 0);

    let old_twap = spot_market.deposit_token_twap;
    update_spot_market_cumulative_interest(&mut spot_market, None, now + 3600).unwrap();
    assert_eq!(spot_market.deposit_token_twap, 494792);
    update_spot_market_cumulative_interest(&mut spot_market, None, now + 3600 * 24).unwrap();
    assert_eq!(spot_market.deposit_token_twap, 379991); // little bit slower than 1 day
    update_spot_market_cumulative_interest(&mut spot_market, None, now + 3600 * 48 + 100).unwrap();
    let new_twap = spot_market.deposit_token_twap;
    assert!(old_twap >= new_twap);
    assert_eq!(new_twap, 375001);

    // Borrowing blocks

    update_spot_balances_and_cumulative_deposits_with_limits(
        QUOTE_PRECISION * 100000,
        &SpotBalanceType::Deposit,
        &mut spot_market,
        &mut user,
    )
    .unwrap();
    assert_eq!(spot_market.deposit_balance, 100000375001998);
    assert_eq!(user.spot_positions[0].scaled_balance, 100000375001998);
    assert_eq!(user.spot_positions[1].scaled_balance, 0);

    spot_market.last_interest_ts = now as u64;
    spot_market.last_twap_ts = now as u64;
    update_spot_market_cumulative_interest(&mut spot_market, None, now + 3600).unwrap();
    assert_eq!(spot_market.deposit_token_twap, 4167041666); //$4167.04
    update_spot_market_cumulative_interest(&mut spot_market, None, now + 3600 * 44).unwrap();
    assert_eq!(spot_market.deposit_token_twap, 99999755926);

    // tiny whale who will grow
    let mut whale = User {
        total_deposits: 50 * 100 * QUOTE_PRECISION_U64,
        total_withdraws: 0,
        spot_positions: get_spot_positions(SpotPosition {
            market_index: 1,
            balance_type: SpotBalanceType::Deposit,
            scaled_balance: 50 * SPOT_BALANCE_PRECISION_U64,
            ..SpotPosition::default()
        }),
        ..User::default()
    };
    sol_spot_market.deposit_balance = 50 * SPOT_BALANCE_PRECISION;
    sol_spot_market.deposit_token_twap = (500 * SPOT_BALANCE_PRECISION) as u64;

    sol_spot_market.optimal_borrow_rate = SPOT_RATE_PRECISION_U32 / 5; //20% APR
    sol_spot_market.max_borrow_rate = SPOT_RATE_PRECISION_U32; //100% APR
    assert_eq!(whale.spot_positions[1].market_index, 1);
    assert_eq!(whale.spot_positions[1].scaled_balance, 50000000000);

    update_spot_balances_and_cumulative_deposits_with_limits(
        QUOTE_PRECISION * 50,
        &SpotBalanceType::Borrow,
        &mut spot_market,
        &mut whale,
    )
    .unwrap();

    assert_eq!(whale.total_deposits, 5000000000);
    assert_eq!(whale.total_withdraws, 0);
    assert_eq!(whale.spot_positions[0].market_index, 0);
    assert_eq!(whale.spot_positions[0].scaled_balance, 50000000001);
    assert_eq!(whale.spot_positions[1].market_index, 1);
    assert_eq!(whale.spot_positions[1].scaled_balance, 50000000000);
    assert_eq!(
        whale.spot_positions[0].balance_type,
        SpotBalanceType::Borrow
    );
    assert_eq!(user.spot_positions[1].scaled_balance, 0);

    user.spot_positions[1].market_index = 1; // usually done elsewhere in instruction

    update_spot_balances_and_cumulative_deposits_with_limits(
        100000 * 100000,
        &SpotBalanceType::Borrow,
        &mut sol_spot_market,
        &mut user,
    )
    .unwrap();
    assert_eq!(user.spot_positions[0].market_index, 0);

    assert_eq!(user.spot_positions[1].balance_type, SpotBalanceType::Borrow);
    assert_eq!(user.spot_positions[1].scaled_balance, 1000000001);

    assert_eq!(user.spot_positions[1].market_index, 1);

    assert_eq!(
        get_token_amount(
            user.spot_positions[1].scaled_balance as u128,
            &sol_spot_market,
            &SpotBalanceType::Borrow
        )
        .unwrap(),
        10000000010 //10 decimals
    );

    // 80% from 2% bad
    let spot_market_backup = sol_spot_market;
    let user_backup = user;
    assert!(update_spot_balances_and_cumulative_deposits_with_limits(
        100000 * 100000 * 40,
        &SpotBalanceType::Borrow,
        &mut sol_spot_market,
        &mut user,
    )
    .is_err());
    sol_spot_market = spot_market_backup;
    user = user_backup;

    update_spot_balances_and_cumulative_deposits_with_limits(
        100000 * 100000 * 6,
        &SpotBalanceType::Borrow,
        &mut sol_spot_market,
        &mut user,
    )
    .unwrap();

    assert_eq!(sol_spot_market.deposit_balance, 50000000000);
    assert_eq!(sol_spot_market.borrow_balance, 8000000002);
    assert_eq!(sol_spot_market.borrow_token_twap, 0);
    update_spot_market_cumulative_interest(&mut sol_spot_market, None, now + 3655 * 24).unwrap();
    assert_eq!(sol_spot_market.deposit_token_twap, 500072987867);
    assert_eq!(sol_spot_market.borrow_token_twap, 80072075950);

    update_spot_balances_and_cumulative_deposits_with_limits(
        100000 * 100000,
        &SpotBalanceType::Borrow,
        &mut sol_spot_market,
        &mut user,
    )
    .unwrap();

    // cant withdraw when market is invalid => delayed update
    market.amm.last_update_slot = 8008;
    assert!(check_perp_market_valid(
        &market,
        &sol_spot_market,
        &mut user.spot_positions[1],
        8009_u64
    )
    .is_err());

    // ok to withdraw when market is valid
    market.amm.last_update_slot = 8009;
    market.amm.last_oracle_valid = true;
    check_perp_market_valid(
        &market,
        &sol_spot_market,
        &mut user.spot_positions[1],
        8009_u64,
    )
    .unwrap();

    // ok to deposit when market is invalid
    update_spot_balances_and_cumulative_deposits_with_limits(
        100000 * 100000 * 100,
        &SpotBalanceType::Deposit,
        &mut sol_spot_market,
        &mut user,
    )
    .unwrap();

    check_perp_market_valid(
        &market,
        &sol_spot_market,
        &mut user.spot_positions[1],
        100000_u64,
    )
    .unwrap();
}

#[test]
fn test_check_withdraw_limits() {
    // let now = 0_i64;
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
    let _oracle_map = OracleMap::load_one(&oracle_account_info, slot, None).unwrap();

    let mut spot_market = SpotMarket {
        market_index: 0,
        oracle_source: OracleSource::QuoteAsset,
        cumulative_deposit_interest: SPOT_CUMULATIVE_INTEREST_PRECISION,
        cumulative_borrow_interest: SPOT_CUMULATIVE_INTEREST_PRECISION,

        decimals: 6,
        initial_asset_weight: SPOT_WEIGHT_PRECISION,
        maintenance_asset_weight: SPOT_WEIGHT_PRECISION,
        deposit_balance: SPOT_BALANCE_PRECISION,
        borrow_balance: 0,
        deposit_token_twap: QUOTE_PRECISION_U64 / 2,
        status: MarketStatus::Active,

        ..SpotMarket::default()
    };
    create_anchor_account_info!(spot_market, SpotMarket, spot_market_account_info);
    let mut sol_spot_market = SpotMarket {
        market_index: 1,
        oracle_source: OracleSource::Pyth,
        oracle: oracle_price_key,
        cumulative_deposit_interest: SPOT_CUMULATIVE_INTEREST_PRECISION,
        cumulative_borrow_interest: SPOT_CUMULATIVE_INTEREST_PRECISION,
        decimals: 10,
        initial_asset_weight: 8 * SPOT_WEIGHT_PRECISION / 10,
        maintenance_asset_weight: 9 * SPOT_WEIGHT_PRECISION / 10,
        initial_liability_weight: 12 * SPOT_WEIGHT_PRECISION / 10,
        maintenance_liability_weight: 11 * SPOT_WEIGHT_PRECISION / 10,
        deposit_balance: 2 * SPOT_BALANCE_PRECISION,
        borrow_balance: SPOT_BALANCE_PRECISION,
        liquidator_fee: LIQUIDATION_FEE_PRECISION / 1000,
        deposit_token_twap: 28_000_000_000_u64,
        status: MarketStatus::Active,

        ..SpotMarket::default()
    };
    create_anchor_account_info!(sol_spot_market, SpotMarket, sol_spot_market_account_info);
    let spot_market_account_infos =
        Vec::from([&spot_market_account_info, &sol_spot_market_account_info]);
    let _spot_market_map = SpotMarketMap::load_multiple(spot_market_account_infos, true).unwrap();

    let mut spot_positions = [SpotPosition::default(); 8];
    spot_positions[0] = SpotPosition {
        market_index: 0,
        balance_type: SpotBalanceType::Deposit,
        scaled_balance: SPOT_BALANCE_PRECISION_U64,
        ..SpotPosition::default()
    };
    spot_positions[1] = SpotPosition {
        market_index: 1,
        balance_type: SpotBalanceType::Deposit,
        scaled_balance: SPOT_BALANCE_PRECISION_U64,
        ..SpotPosition::default()
    };
    let user = User {
        orders: [Order::default(); 32],
        perp_positions: [PerpPosition::default(); 8],
        spot_positions,
        ..User::default()
    };

    let mdt = calculate_min_deposit_token_amount(QUOTE_PRECISION, 0).unwrap();
    assert_eq!(mdt, QUOTE_PRECISION - QUOTE_PRECISION / 4);

    let mbt =
        calculate_max_borrow_token_amount(QUOTE_PRECISION, QUOTE_PRECISION, QUOTE_PRECISION / 2, 0)
            .unwrap();
    assert_eq!(mbt, 600000);

    let valid_withdraw = check_withdraw_limits(&spot_market, Some(&user), Some(0)).unwrap();
    assert!(valid_withdraw);

    let valid_withdraw =
        check_withdraw_limits(&sol_spot_market, Some(&user), Some(10_000_000_000)).unwrap();
    assert!(!valid_withdraw);

    let valid_withdraw = check_withdraw_limits(&sol_spot_market, None, None).unwrap();
    assert!(!valid_withdraw);
}

#[test]
fn test_check_withdraw_limits_below_optimal_utilization() {
    // let oracle_price = get_pyth_price(20, 9);
    let oracle_price_key =
        Pubkey::from_str("J83w4HKfqxwcq3BEMMkPFSppX3gqekLyLJBexebFVkix").unwrap();

    let mut sol_spot_market = SpotMarket {
        market_index: 1,
        oracle_source: OracleSource::Pyth,
        oracle: oracle_price_key,
        cumulative_deposit_interest: 1020 * SPOT_CUMULATIVE_INTEREST_PRECISION / 1000,
        cumulative_borrow_interest: 1222 * SPOT_CUMULATIVE_INTEREST_PRECISION / 1000,

        optimal_utilization: 700000,
        optimal_borrow_rate: 60000,
        max_borrow_rate: 1000000,

        decimals: 9,
        initial_asset_weight: 8 * SPOT_WEIGHT_PRECISION / 10,
        maintenance_asset_weight: 9 * SPOT_WEIGHT_PRECISION / 10,
        initial_liability_weight: 12 * SPOT_WEIGHT_PRECISION / 10,
        maintenance_liability_weight: 11 * SPOT_WEIGHT_PRECISION / 10,
        deposit_balance: 200_000 * SPOT_BALANCE_PRECISION, // 200k sol
        borrow_balance: 100_000 * SPOT_BALANCE_PRECISION,
        liquidator_fee: LIQUIDATION_FEE_PRECISION / 1000,
        deposit_token_twap: 204000000000000_u64,
        borrow_token_twap: 122200000000000_u64,
        utilization_twap: 100000, // 10% (so quickly moved!)
        status: MarketStatus::Active,

        ..SpotMarket::default()
    };

    assert_eq!(sol_spot_market.get_utilization().unwrap(), 599019);
    assert!(
        sol_spot_market.get_utilization().unwrap() < sol_spot_market.optimal_utilization as u128
    ); // below optimal util

    let deposit_tokens_1 = get_token_amount(
        sol_spot_market.deposit_balance,
        &sol_spot_market,
        &SpotBalanceType::Deposit,
    )
    .unwrap();
    let borrow_tokens_1 = get_token_amount(
        sol_spot_market.borrow_balance,
        &sol_spot_market,
        &SpotBalanceType::Borrow,
    )
    .unwrap();

    let mdt_dep: u128 =
        calculate_min_deposit_token_amount(sol_spot_market.deposit_token_twap as u128, 0).unwrap();

    let mbt_bor = calculate_max_borrow_token_amount(
        deposit_tokens_1,
        deposit_tokens_1,
        sol_spot_market.borrow_token_twap as u128,
        0,
    )
    .unwrap();

    let (min_dep, max_bor) =
        calculate_token_utilization_limits(deposit_tokens_1, borrow_tokens_1, &sol_spot_market)
            .unwrap();

    assert_eq!(deposit_tokens_1, 204000000000000);
    assert_eq!(borrow_tokens_1, 122200000000000);

    // utilization bands differ from others
    assert_eq!(min_dep, 174571428571428); //174571.428571
    assert_eq!(mdt_dep, 153000000000000);

    assert_eq!(max_bor, 142800000000000);
    assert_eq!(mbt_bor, 142600000000000);

    let valid_withdraw = check_withdraw_limits(&sol_spot_market, None, None).unwrap();
    assert_eq!(valid_withdraw, true);

    // ensure it fails due to higher min_dep above
    sol_spot_market.deposit_balance = 174571428571428 / 1020 * 1000;
    sol_spot_market.utilization_twap = 100000;

    let deposit_tokens_1 = get_token_amount(
        sol_spot_market.deposit_balance,
        &sol_spot_market,
        &SpotBalanceType::Deposit,
    )
    .unwrap();
    let (min_dep, max_bor) =
        calculate_token_utilization_limits(deposit_tokens_1, borrow_tokens_1, &sol_spot_market)
            .unwrap();
    assert_eq!(min_dep, 174571428570660);
    assert_eq!(max_bor, 122199999999462);

    let valid_withdraw = check_withdraw_limits(&sol_spot_market, None, None).unwrap();
    assert_eq!(valid_withdraw, false);
}

#[test]
fn test_check_withdraw_limits_above_optimal_utilization() {
    // let oracle_price = get_pyth_price(20, 9);
    let oracle_price_key =
        Pubkey::from_str("J83w4HKfqxwcq3BEMMkPFSppX3gqekLyLJBexebFVkix").unwrap();

    let mut sol_spot_market = SpotMarket {
        market_index: 1,
        oracle_source: OracleSource::Pyth,
        oracle: oracle_price_key,
        cumulative_deposit_interest: 1020 * SPOT_CUMULATIVE_INTEREST_PRECISION / 1000,
        cumulative_borrow_interest: 1222 * SPOT_CUMULATIVE_INTEREST_PRECISION / 1000,

        optimal_utilization: 700000, // 70%
        optimal_borrow_rate: 60000,  // 6%
        max_borrow_rate: 1000000,    // 100%

        decimals: 9,
        initial_asset_weight: 8 * SPOT_WEIGHT_PRECISION / 10,
        maintenance_asset_weight: 9 * SPOT_WEIGHT_PRECISION / 10,
        initial_liability_weight: 12 * SPOT_WEIGHT_PRECISION / 10,
        maintenance_liability_weight: 11 * SPOT_WEIGHT_PRECISION / 10,
        deposit_balance: 200_000 * SPOT_BALANCE_PRECISION, // 200k sol
        borrow_balance: 140_000 * SPOT_BALANCE_PRECISION,
        liquidator_fee: LIQUIDATION_FEE_PRECISION / 1000,
        deposit_token_twap: 204000000000000_u64,
        borrow_token_twap: 192200000000000_u64,
        utilization_twap: 800000, // 80%
        status: MarketStatus::Active,

        ..SpotMarket::default()
    };

    assert_eq!(sol_spot_market.get_utilization().unwrap(), 838627);
    assert!(
        sol_spot_market.get_utilization().unwrap() > sol_spot_market.optimal_utilization as u128
    ); // below optimal util

    let deposit_tokens_1 = get_token_amount(
        sol_spot_market.deposit_balance,
        &sol_spot_market,
        &SpotBalanceType::Deposit,
    )
    .unwrap();
    let borrow_tokens_1 = get_token_amount(
        sol_spot_market.borrow_balance,
        &sol_spot_market,
        &SpotBalanceType::Borrow,
    )
    .unwrap();

    let mdt_dep: u128 =
        calculate_min_deposit_token_amount(sol_spot_market.deposit_token_twap as u128, 0).unwrap();

    let mbt_bor = calculate_max_borrow_token_amount(
        deposit_tokens_1,
        deposit_tokens_1,
        sol_spot_market.borrow_token_twap as u128,
        0,
    )
    .unwrap();

    // 80% utilization means 90% (80% + 10/2%) is the max limit for these tokens
    let (min_dep, max_bor) =
        calculate_token_utilization_limits(deposit_tokens_1, borrow_tokens_1, &sol_spot_market)
            .unwrap();

    assert_eq!(deposit_tokens_1, 204000000000000);
    assert_eq!(borrow_tokens_1, 171080000000000);

    // utilization bands differ from others
    assert_eq!(min_dep, 190088888888888); //174571.428571
    assert_eq!(mdt_dep, 153000000000000);

    assert_eq!(max_bor, 183600000000000);
    assert_eq!(mbt_bor, 163200000000000);

    // without passing a user, since borrows are above the built in limit of 80% will fail
    let valid_withdraw = check_withdraw_limits(&sol_spot_market, None, None).unwrap();
    assert_eq!(valid_withdraw, false);

    // with mock user doing no borrowing, success!
    let mut spot_positions = [SpotPosition::default(); 8];
    spot_positions[0] = SpotPosition {
        market_index: 0,
        balance_type: SpotBalanceType::Deposit,
        scaled_balance: SPOT_BALANCE_PRECISION_U64,
        ..SpotPosition::default()
    };
    spot_positions[1] = SpotPosition {
        market_index: 1,
        balance_type: SpotBalanceType::Deposit,
        scaled_balance: SPOT_BALANCE_PRECISION_U64,
        ..SpotPosition::default()
    };
    let user = User {
        orders: [Order::default(); 32],
        perp_positions: [PerpPosition::default(); 8],
        spot_positions,
        ..User::default()
    };

    let valid_withdraw = check_withdraw_limits(&sol_spot_market, Some(&user), None).unwrap();
    assert_eq!(valid_withdraw, true);

    // now ensure it fails due to higher min_dep above
    sol_spot_market.deposit_balance = min_dep / 1020 * 1000;
    let valid_withdraw = check_withdraw_limits(&sol_spot_market, None, None).unwrap();
    assert_eq!(valid_withdraw, false);
}

#[test]
fn check_fee_collection() {
    let mut now = 0_i64;
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
    let _oracle_map = OracleMap::load_one(&oracle_account_info, slot, None).unwrap();

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
            quote_asset_amount: 50 * QUOTE_PRECISION_I128,
            base_asset_amount_with_amm: BASE_PRECISION_I128,
            oracle: oracle_price_key,
            historical_oracle_data: HistoricalOracleData::default_price(oracle_price.agg.price),
            ..AMM::default()
        },
        margin_ratio_initial: 1000,
        margin_ratio_maintenance: 500,
        number_of_users_with_base: 1,
        status: MarketStatus::Active,
        liquidator_fee: LIQUIDATION_FEE_PRECISION / 100,
        ..PerpMarket::default()
    };
    create_anchor_account_info!(market, PerpMarket, market_account_info);
    let _market_map = PerpMarketMap::load_one(&market_account_info, true).unwrap();

    let mut spot_market = SpotMarket {
        market_index: 0,
        oracle_source: OracleSource::QuoteAsset,
        cumulative_deposit_interest: SPOT_CUMULATIVE_INTEREST_PRECISION,
        cumulative_borrow_interest: SPOT_CUMULATIVE_INTEREST_PRECISION,
        decimals: 6,
        initial_asset_weight: SPOT_WEIGHT_PRECISION,
        maintenance_asset_weight: SPOT_WEIGHT_PRECISION,
        deposit_balance: SPOT_BALANCE_PRECISION,
        borrow_balance: 0,
        deposit_token_twap: QUOTE_PRECISION_U64,

        optimal_utilization: SPOT_UTILIZATION_PRECISION_U32 / 2,
        optimal_borrow_rate: SPOT_RATE_PRECISION_U32 * 20,
        max_borrow_rate: SPOT_RATE_PRECISION_U32 * 50,
        status: MarketStatus::Active,

        ..SpotMarket::default()
    };

    create_anchor_account_info!(spot_market, SpotMarket, spot_market_account_info);
    let mut sol_spot_market = SpotMarket {
        market_index: 1,
        oracle_source: OracleSource::Pyth,
        oracle: oracle_price_key,
        cumulative_deposit_interest: SPOT_CUMULATIVE_INTEREST_PRECISION,
        cumulative_borrow_interest: SPOT_CUMULATIVE_INTEREST_PRECISION,
        decimals: 10,
        initial_asset_weight: 8 * SPOT_WEIGHT_PRECISION / 10,
        maintenance_asset_weight: 9 * SPOT_WEIGHT_PRECISION / 10,
        initial_liability_weight: 12 * SPOT_WEIGHT_PRECISION / 10,
        maintenance_liability_weight: 11 * SPOT_WEIGHT_PRECISION / 10,
        deposit_balance: SPOT_BALANCE_PRECISION,
        borrow_balance: SPOT_BALANCE_PRECISION,
        liquidator_fee: LIQUIDATION_FEE_PRECISION / 1000,
        insurance_fund: InsuranceFund {
            revenue_settle_period: 1,
            ..InsuranceFund::default()
        },
        status: MarketStatus::Active,
        ..SpotMarket::default()
    };
    create_anchor_account_info!(sol_spot_market, SpotMarket, sol_spot_market_account_info);
    let spot_market_account_infos =
        Vec::from([&spot_market_account_info, &sol_spot_market_account_info]);
    let _spot_market_map = SpotMarketMap::load_multiple(spot_market_account_infos, true).unwrap();

    let mut spot_positions = [SpotPosition::default(); 8];
    spot_positions[1] = SpotPosition {
        market_index: 1,
        balance_type: SpotBalanceType::Deposit,
        scaled_balance: SPOT_BALANCE_PRECISION_U64,
        ..SpotPosition::default()
    };
    let mut user = User {
        orders: [Order::default(); 32],
        perp_positions: [PerpPosition::default(); 8],
        spot_positions,
        ..User::default()
    };

    spot_market.insurance_fund.user_factor = 900;
    spot_market.insurance_fund.total_factor = 1000; //1_000_000

    assert_eq!(spot_market.utilization_twap, 0);
    assert_eq!(spot_market.deposit_balance, 1000000000);
    assert_eq!(spot_market.borrow_balance, 0);

    let amount = QUOTE_PRECISION / 4;
    update_spot_balances_and_cumulative_deposits_with_limits(
        amount / 2,
        &SpotBalanceType::Borrow,
        &mut spot_market,
        &mut user,
    )
    .unwrap();

    assert_eq!(user.total_deposits, 0);
    assert_eq!(user.total_withdraws, 0);

    assert_eq!(spot_market.deposit_balance, 1000000000);
    assert_eq!(spot_market.borrow_balance, 125000001);
    assert_eq!(spot_market.utilization_twap, 0);

    update_spot_market_cumulative_interest(&mut spot_market, None, now + 100).unwrap();

    assert_eq!(spot_market.revenue_pool.scaled_balance, 0);
    assert_eq!(spot_market.cumulative_deposit_interest, 10000019799);
    assert_eq!(spot_market.cumulative_borrow_interest, 10000158551);
    assert_eq!(spot_market.last_interest_ts, 100);
    assert_eq!(spot_market.last_twap_ts, 100);
    assert_eq!(spot_market.utilization_twap, 143);

    let deposit_tokens_1 = get_token_amount(
        spot_market.deposit_balance,
        &spot_market,
        &SpotBalanceType::Deposit,
    )
    .unwrap();
    let borrow_tokens_1 = get_token_amount(
        spot_market.borrow_balance,
        &spot_market,
        &SpotBalanceType::Borrow,
    )
    .unwrap();
    let if_tokens_1 = get_token_amount(
        spot_market.revenue_pool.scaled_balance,
        &spot_market,
        &SpotBalanceType::Borrow,
    )
    .unwrap();

    assert_eq!(deposit_tokens_1, 1000001);
    assert_eq!(borrow_tokens_1, 125002);
    assert_eq!(if_tokens_1, 0);

    update_spot_market_cumulative_interest(&mut spot_market, None, now + 7500).unwrap();

    assert_eq!(spot_market.last_interest_ts, 7500);
    assert_eq!(spot_market.last_twap_ts, 7500);
    assert_eq!(spot_market.utilization_twap, 10846);

    assert_eq!(spot_market.cumulative_deposit_interest, 10001484937);
    assert_eq!(spot_market.cumulative_borrow_interest, 10011891454);
    assert_eq!(spot_market.revenue_pool.scaled_balance, 0);

    let deposit_tokens_2 = get_token_amount(
        spot_market.deposit_balance,
        &spot_market,
        &SpotBalanceType::Deposit,
    )
    .unwrap();
    let borrow_tokens_2 = get_token_amount(
        spot_market.borrow_balance,
        &spot_market,
        &SpotBalanceType::Borrow,
    )
    .unwrap();
    let if_tokens_2 = get_token_amount(
        spot_market.revenue_pool.scaled_balance,
        &spot_market,
        &SpotBalanceType::Borrow,
    )
    .unwrap();

    assert_eq!(deposit_tokens_2, 1000148);
    assert_eq!(borrow_tokens_2, 125149);
    assert_eq!(if_tokens_2, 0);

    //assert >=0
    // assert_eq!(
    //     (borrow_tokens_2 - borrow_tokens_1) - (deposit_tokens_2 - deposit_tokens_1),
    //     0
    // );

    update_spot_market_cumulative_interest(
        &mut spot_market,
        None,
        now + 750 + (60 * 60 * 24 * 365),
    )
    .unwrap();

    now = now + 750 + (60 * 60 * 24 * 365);

    assert_eq!(spot_market.cumulative_deposit_interest, 16257818378);
    assert_eq!(spot_market.cumulative_borrow_interest, 60112684636);
    assert_eq!(spot_market.revenue_pool.scaled_balance, 385045);

    let deposit_tokens_3 = get_token_amount(
        spot_market.deposit_balance,
        &spot_market,
        &SpotBalanceType::Deposit,
    )
    .unwrap();
    let borrow_tokens_3 = get_token_amount(
        spot_market.borrow_balance,
        &spot_market,
        &SpotBalanceType::Borrow,
    )
    .unwrap();
    let if_tokens_3 = get_token_amount(
        spot_market.revenue_pool.scaled_balance,
        &spot_market,
        &SpotBalanceType::Borrow,
    )
    .unwrap();

    assert_eq!(deposit_tokens_3, 1626407);
    assert_eq!(borrow_tokens_3, 751409);
    assert_eq!(if_tokens_3, 2315);

    assert_eq!((borrow_tokens_3 - borrow_tokens_2), 626260);
    assert_eq!((deposit_tokens_3 - deposit_tokens_2), 626259);
    assert_eq!(deposit_tokens_3 - borrow_tokens_3, 874998);

    // assert >= 0
    assert_eq!(
        (borrow_tokens_3 - borrow_tokens_2) - (deposit_tokens_3 - deposit_tokens_2),
        1
    );

    // settle IF pool to 100% utilization boundary
    assert_eq!(spot_market.revenue_pool.scaled_balance, 385045);
    assert_eq!(spot_market.utilization_twap, 462004);
    spot_market.insurance_fund.revenue_settle_period = 1;

    let settle_amount = settle_revenue_to_insurance_fund(
        deposit_tokens_3 as u64,
        if_tokens_3 as u64,
        &mut spot_market,
        now + 60,
        true,
    )
    .unwrap();

    assert_eq!(settle_amount, 626);
    assert_eq!(spot_market.insurance_fund.user_shares, 0);
    assert_eq!(spot_market.insurance_fund.total_shares, 0);
    assert_eq!(if_tokens_3 - (settle_amount as u128), 1689);
    assert_eq!(spot_market.revenue_pool.scaled_balance, 0);
    assert_eq!(spot_market.utilization_twap, 462005);

    let deposit_tokens_4 = get_token_amount(
        spot_market.deposit_balance,
        &spot_market,
        &SpotBalanceType::Deposit,
    )
    .unwrap();
    let borrow_tokens_4 = get_token_amount(
        spot_market.borrow_balance,
        &spot_market,
        &SpotBalanceType::Borrow,
    )
    .unwrap();
    let if_tokens_4 = get_token_amount(
        spot_market.revenue_pool.scaled_balance,
        &spot_market,
        &SpotBalanceType::Deposit,
    )
    .unwrap();

    assert_eq!(spot_market.borrow_token_twap, 751409);
    assert_eq!(spot_market.deposit_token_twap, 1626407);
    assert_eq!(
        spot_market.borrow_token_twap * (SPOT_UTILIZATION_PRECISION as u64)
            / spot_market.deposit_token_twap,
        462005
    ); // 46.2%

    assert_eq!(spot_market.utilization_twap, 462005); // 46.2%
    assert_eq!(
        borrow_tokens_4 * SPOT_UTILIZATION_PRECISION / deposit_tokens_4,
        462191
    ); // 46.2%
    assert_eq!(SPOT_UTILIZATION_PRECISION, 1000000); // 100%

    assert_eq!(deposit_tokens_4 - borrow_tokens_4, 874373);
    assert_eq!(if_tokens_4, 0);

    // one more day later, twap update
    update_spot_market_cumulative_interest(&mut spot_market, None, now + 60 + (60 * 60 * 24))
        .unwrap();

    let deposit_tokens_5 = get_token_amount(
        spot_market.deposit_balance,
        &spot_market,
        &SpotBalanceType::Deposit,
    )
    .unwrap();
    let borrow_tokens_5 = get_token_amount(
        spot_market.borrow_balance,
        &spot_market,
        &SpotBalanceType::Borrow,
    )
    .unwrap();
    let _if_tokens_5 = get_token_amount(
        spot_market.revenue_pool.scaled_balance,
        &spot_market,
        &SpotBalanceType::Deposit,
    )
    .unwrap();

    assert_eq!(deposit_tokens_5 - borrow_tokens_5, 874373);

    assert_eq!(spot_market.borrow_token_twap, 789495);
    assert_eq!(spot_market.deposit_token_twap, 1663868);

    assert_eq!(
        spot_market.borrow_token_twap * (SPOT_UTILIZATION_PRECISION as u64)
            / spot_market.deposit_token_twap,
        474493
    ); // 47.4%
    assert_eq!(spot_market.utilization_twap, 474493); // 47.4%
    assert_eq!(
        borrow_tokens_5 * SPOT_UTILIZATION_PRECISION / deposit_tokens_5,
        474494
    ); // 47.4%
    assert_eq!(SPOT_UTILIZATION_PRECISION, 1000000); // 100%

    // 150 years later, twap update
    update_spot_market_cumulative_interest(
        &mut spot_market,
        None,
        now + (60 * 60 * 24 * 365 * 150),
    )
    .unwrap();

    let deposit_tokens_6 = get_token_amount(
        spot_market.deposit_balance,
        &spot_market,
        &SpotBalanceType::Deposit,
    )
    .unwrap();
    let borrow_tokens_6 = get_token_amount(
        spot_market.borrow_balance,
        &spot_market,
        &SpotBalanceType::Borrow,
    )
    .unwrap();

    assert_eq!(deposit_tokens_6 - borrow_tokens_6, 874176);
    assert_eq!(deposit_tokens_6, 2249289191);
    assert_eq!(borrow_tokens_6, 2248415015);
    assert_eq!(spot_market.deposit_token_twap, 2249289190);
    assert_eq!(spot_market.borrow_token_twap, 2248415014);
}

#[test]
fn check_fee_collection_larger_nums() {
    let mut now = 0_i64;
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
    let _oracle_map = OracleMap::load_one(&oracle_account_info, slot, None).unwrap();

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
            quote_asset_amount: 50 * QUOTE_PRECISION_I128,
            base_asset_amount_with_amm: BASE_PRECISION_I128,
            oracle: oracle_price_key,
            historical_oracle_data: HistoricalOracleData::default_price(oracle_price.agg.price),
            ..AMM::default()
        },
        margin_ratio_initial: 1000,
        margin_ratio_maintenance: 500,
        number_of_users_with_base: 1,
        status: MarketStatus::Initialized,
        liquidator_fee: LIQUIDATION_FEE_PRECISION / 100,
        ..PerpMarket::default()
    };
    create_anchor_account_info!(market, PerpMarket, market_account_info);
    let _market_map = PerpMarketMap::load_one(&market_account_info, true).unwrap();

    let mut spot_market = SpotMarket {
        market_index: 0,
        oracle_source: OracleSource::QuoteAsset,
        cumulative_deposit_interest: SPOT_CUMULATIVE_INTEREST_PRECISION,
        cumulative_borrow_interest: SPOT_CUMULATIVE_INTEREST_PRECISION,
        decimals: 6,
        initial_asset_weight: SPOT_WEIGHT_PRECISION,
        maintenance_asset_weight: SPOT_WEIGHT_PRECISION,
        deposit_balance: 1000000 * SPOT_BALANCE_PRECISION,
        borrow_balance: 0,
        deposit_token_twap: QUOTE_PRECISION_U64 / 2,

        optimal_utilization: SPOT_UTILIZATION_PRECISION_U32 / 2,
        optimal_borrow_rate: SPOT_RATE_PRECISION_U32 * 20,
        max_borrow_rate: SPOT_RATE_PRECISION_U32 * 50,
        ..SpotMarket::default()
    };

    create_anchor_account_info!(spot_market, SpotMarket, spot_market_account_info);
    let mut sol_spot_market = SpotMarket {
        market_index: 1,
        oracle_source: OracleSource::Pyth,
        oracle: oracle_price_key,
        cumulative_deposit_interest: SPOT_CUMULATIVE_INTEREST_PRECISION,
        cumulative_borrow_interest: SPOT_CUMULATIVE_INTEREST_PRECISION,
        decimals: 10,
        initial_asset_weight: 8 * SPOT_WEIGHT_PRECISION / 10,
        maintenance_asset_weight: 9 * SPOT_WEIGHT_PRECISION / 10,
        initial_liability_weight: 12 * SPOT_WEIGHT_PRECISION / 10,
        maintenance_liability_weight: 11 * SPOT_WEIGHT_PRECISION / 10,
        deposit_balance: SPOT_BALANCE_PRECISION,
        borrow_balance: SPOT_BALANCE_PRECISION,
        liquidator_fee: LIQUIDATION_FEE_PRECISION / 1000,
        ..SpotMarket::default()
    };
    create_anchor_account_info!(sol_spot_market, SpotMarket, sol_spot_market_account_info);
    let spot_market_account_infos =
        Vec::from([&spot_market_account_info, &sol_spot_market_account_info]);
    let _spot_market_map = SpotMarketMap::load_multiple(spot_market_account_infos, true).unwrap();

    let mut spot_positions = [SpotPosition::default(); 8];
    spot_positions[0] = SpotPosition {
        market_index: 1,
        balance_type: SpotBalanceType::Deposit,
        scaled_balance: SPOT_BALANCE_PRECISION_U64,
        ..SpotPosition::default()
    };
    let mut user = User {
        orders: [Order::default(); 32],
        perp_positions: [PerpPosition::default(); 8],
        spot_positions,
        ..User::default()
    };

    spot_market.insurance_fund.user_factor = 90_000;
    spot_market.insurance_fund.total_factor = 100_000;

    assert_eq!(spot_market.utilization_twap, 0);
    assert_eq!(
        spot_market.deposit_balance,
        1000000 * SPOT_BALANCE_PRECISION
    );
    assert_eq!(spot_market.borrow_balance, 0);

    let amount = 540510 * QUOTE_PRECISION;
    update_spot_balances(
        amount,
        &SpotBalanceType::Borrow,
        &mut spot_market,
        &mut user.spot_positions[1],
        false,
    )
    .unwrap();

    assert_eq!(
        spot_market.deposit_balance,
        1000000 * SPOT_BALANCE_PRECISION
    );
    assert_eq!(spot_market.borrow_balance, 540510000000001);
    assert_eq!(spot_market.utilization_twap, 0);

    update_spot_market_cumulative_interest(&mut spot_market, None, now + 100).unwrap();

    assert_eq!(spot_market.revenue_pool.scaled_balance, 3844266986);
    assert_eq!(spot_market.cumulative_deposit_interest, 10000346004);
    assert_eq!(spot_market.cumulative_borrow_interest, 10000711270);
    assert_eq!(spot_market.last_interest_ts, 100);
    assert_eq!(spot_market.last_twap_ts, 100);
    assert_eq!(spot_market.utilization_twap, 624);

    let deposit_tokens_1 = get_token_amount(
        spot_market.deposit_balance,
        &spot_market,
        &SpotBalanceType::Deposit,
    )
    .unwrap();
    let borrow_tokens_1 = get_token_amount(
        spot_market.borrow_balance,
        &spot_market,
        &SpotBalanceType::Borrow,
    )
    .unwrap();
    let if_tokens_1 = get_token_amount(
        spot_market.revenue_pool.scaled_balance,
        &spot_market,
        &SpotBalanceType::Deposit,
    )
    .unwrap();

    assert_eq!(deposit_tokens_1, 1000038444799);
    assert_eq!(borrow_tokens_1, 540548444855);
    assert_eq!(if_tokens_1, 3844399);

    update_spot_market_cumulative_interest(&mut spot_market, None, now + 7500).unwrap();

    assert_eq!(spot_market.last_interest_ts, 7500);
    assert_eq!(spot_market.last_twap_ts, 7500);
    assert_eq!(spot_market.utilization_twap, 46976);

    assert_eq!(spot_market.cumulative_deposit_interest, 10025953120);
    assert_eq!(spot_market.cumulative_borrow_interest, 10053351363);
    assert_eq!(spot_market.revenue_pool.scaled_balance, 287632341391);

    let deposit_tokens_2 = get_token_amount(
        spot_market.deposit_balance,
        &spot_market,
        &SpotBalanceType::Deposit,
    )
    .unwrap();
    let borrow_tokens_2 = get_token_amount(
        spot_market.borrow_balance,
        &spot_market,
        &SpotBalanceType::Borrow,
    )
    .unwrap();
    let if_tokens_2 = get_token_amount(
        spot_market.revenue_pool.scaled_balance,
        &spot_market,
        &SpotBalanceType::Deposit,
    )
    .unwrap();

    assert_eq!(deposit_tokens_2, 1002883690837);
    assert_eq!(borrow_tokens_2, 543393694522);
    assert_eq!(if_tokens_2, 288378837);

    //assert >=0
    assert_eq!(
        (borrow_tokens_2 - borrow_tokens_1) - (deposit_tokens_2 - deposit_tokens_1),
        3629
    );

    update_spot_market_cumulative_interest(
        &mut spot_market,
        None,
        now + 750 + (60 * 60 * 24 * 365),
    )
    .unwrap();

    now = now + 750 + (60 * 60 * 24 * 365);

    assert_eq!(spot_market.cumulative_deposit_interest, 120056141117);
    assert_eq!(spot_market.cumulative_borrow_interest, 236304445676);
    assert_eq!(spot_market.revenue_pool.scaled_balance, 102149084836788);

    let deposit_tokens_3 = get_token_amount(
        spot_market.deposit_balance,
        &spot_market,
        &SpotBalanceType::Deposit,
    )
    .unwrap();
    let borrow_tokens_3 = get_token_amount(
        spot_market.borrow_balance,
        &spot_market,
        &SpotBalanceType::Borrow,
    )
    .unwrap();
    let if_tokens_3 = get_token_amount(
        spot_market.revenue_pool.scaled_balance,
        &spot_market,
        &SpotBalanceType::Deposit,
    )
    .unwrap();

    assert_eq!(deposit_tokens_3, 13231976606113);
    assert_eq!(borrow_tokens_3, 12772491593234);
    assert_eq!(if_tokens_3, 1226362494413);

    assert_eq!((borrow_tokens_3 - borrow_tokens_2), 12229097898712);
    assert_eq!((deposit_tokens_3 - deposit_tokens_2), 12229092915276);

    // assert >= 0
    assert_eq!(
        (borrow_tokens_3 - borrow_tokens_2) - (deposit_tokens_3 - deposit_tokens_2),
        4_983_436 //$4.98 missing
    );

    let mut if_balance_2 = 0;

    // settle IF pool to 100% utilization boundary
    // only half of depositors available claim was settled (to protect vault)
    assert_eq!(spot_market.revenue_pool.scaled_balance, 102149084836788);
    spot_market.insurance_fund.revenue_settle_period = 1;
    let settle_amount = settle_revenue_to_insurance_fund(
        deposit_tokens_3 as u64,
        if_tokens_3 as u64,
        &mut spot_market,
        now + 60,
        true,
    )
    .unwrap();
    assert_eq!(settle_amount, 229742506020);
    assert_eq!(spot_market.insurance_fund.user_shares, 0);
    assert_eq!(spot_market.insurance_fund.total_shares, 0);
    if_balance_2 += settle_amount;
    assert_eq!(if_balance_2, 229742506020);
    assert_eq!(if_tokens_3 - (settle_amount as u128), 996619988393); // w/ update interest for settle_spot_market_to_if

    assert_eq!(spot_market.revenue_pool.scaled_balance, 83024042298956);
    assert_eq!(spot_market.utilization_twap, 965274);

    let deposit_tokens_4 = get_token_amount(
        spot_market.deposit_balance,
        &spot_market,
        &SpotBalanceType::Deposit,
    )
    .unwrap();
    let borrow_tokens_4 = get_token_amount(
        spot_market.borrow_balance,
        &spot_market,
        &SpotBalanceType::Borrow,
    )
    .unwrap();
    let if_tokens_4 = get_token_amount(
        spot_market.revenue_pool.scaled_balance,
        &spot_market,
        &SpotBalanceType::Deposit,
    )
    .unwrap();

    assert_eq!(deposit_tokens_4 - borrow_tokens_4, 229742506021);
    assert_eq!(if_tokens_4, 996833556273);
}

#[test]
fn attempt_borrow_with_massive_upnl() {
    let _now = 0_i64;
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

    // sol coin
    let mut market = PerpMarket {
        amm: AMM {
            base_asset_reserve: 100 * AMM_RESERVE_PRECISION,
            quote_asset_reserve: 100 * AMM_RESERVE_PRECISION,
            sqrt_k: 100 * AMM_RESERVE_PRECISION,
            peg_multiplier: 100 * PEG_PRECISION,
            max_slippage_ratio: 50,
            max_fill_reserve_fraction: 100,
            order_step_size: 10000000,
            quote_asset_amount: 50 * QUOTE_PRECISION_I128,
            base_asset_amount_with_amm: BASE_PRECISION_I128,
            oracle: oracle_price_key,
            historical_oracle_data: HistoricalOracleData::default_price(oracle_price.agg.price),
            ..AMM::default()
        },
        unrealized_pnl_initial_asset_weight: 0,
        unrealized_pnl_maintenance_asset_weight: SPOT_WEIGHT_PRECISION,
        margin_ratio_initial: 1000,    //10x
        margin_ratio_maintenance: 500, //20x
        number_of_users_with_base: 1,
        status: MarketStatus::Active,
        liquidator_fee: LIQUIDATION_FEE_PRECISION / 100,
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
        deposit_balance: 100_000_000 * SPOT_BALANCE_PRECISION, //$100M usdc
        borrow_balance: 0,
        deposit_token_twap: QUOTE_PRECISION_U64 / 2,
        historical_oracle_data: HistoricalOracleData::default_quote_oracle(),
        status: MarketStatus::Active,

        ..SpotMarket::default()
    };
    create_anchor_account_info!(spot_market, SpotMarket, spot_market_account_info);
    let mut sol_spot_market = SpotMarket {
        market_index: 1,
        oracle_source: OracleSource::Pyth,
        oracle: oracle_price_key,
        cumulative_deposit_interest: SPOT_CUMULATIVE_INTEREST_PRECISION,
        cumulative_borrow_interest: SPOT_CUMULATIVE_INTEREST_PRECISION,
        decimals: 10,
        initial_asset_weight: 8 * SPOT_WEIGHT_PRECISION / 10,
        maintenance_asset_weight: 9 * SPOT_WEIGHT_PRECISION / 10,
        initial_liability_weight: 12 * SPOT_WEIGHT_PRECISION / 10,
        maintenance_liability_weight: 11 * SPOT_WEIGHT_PRECISION / 10,
        deposit_balance: 100 * SPOT_BALANCE_PRECISION,
        borrow_balance: SPOT_BALANCE_PRECISION,
        liquidator_fee: LIQUIDATION_FEE_PRECISION / 1000,
        status: MarketStatus::Active,

        ..SpotMarket::default()
    };
    create_anchor_account_info!(sol_spot_market, SpotMarket, sol_spot_market_account_info);
    let spot_market_account_infos =
        Vec::from([&spot_market_account_info, &sol_spot_market_account_info]);
    let spot_market_map = SpotMarketMap::load_multiple(spot_market_account_infos, true).unwrap();

    // user has 100 sol
    let mut spot_positions = [SpotPosition::default(); 8];
    spot_positions[0] = SpotPosition {
        market_index: 1,
        balance_type: SpotBalanceType::Deposit,
        scaled_balance: 100 * SPOT_BALANCE_PRECISION_U64,
        ..SpotPosition::default()
    };

    let user = User {
        orders: [Order::default(); 32],
        perp_positions: get_positions(PerpPosition {
            market_index: 0,
            base_asset_amount: 1000 * BASE_PRECISION_I64,
            quote_asset_amount: -100 * QUOTE_PRECISION_I64, // got in at 10 cents
            quote_entry_amount: -100 * QUOTE_PRECISION_I64,
            quote_break_even_amount: -100 * QUOTE_PRECISION_I64,

            ..PerpPosition::default()
        }),
        spot_positions,
        ..User::default()
    };

    let MarginCalculation {
        margin_requirement,
        total_collateral,
        ..
    } = calculate_margin_requirement_and_total_collateral_and_liability_info(
        &user,
        &perp_market_map,
        &spot_market_map,
        &mut oracle_map,
        MarginContext::standard(MarginRequirementType::Initial),
    )
    .unwrap();

    assert_eq!(margin_requirement, 10_000_000_000);
    assert_eq!(total_collateral, 8_000_000_000); //100 * 100 *.8

    let MarginCalculation {
        margin_requirement,
        total_collateral,
        ..
    } = calculate_margin_requirement_and_total_collateral_and_liability_info(
        &user,
        &perp_market_map,
        &spot_market_map,
        &mut oracle_map,
        MarginContext::standard(MarginRequirementType::Maintenance),
    )
    .unwrap();

    assert_eq!(margin_requirement, 5_000_000_000);
    assert_eq!(total_collateral, 108_900_000_000); //100* 100 *.9 + upnl = $108_900

    let mut market = perp_market_map.get_ref_mut(&0).unwrap();
    // assert_eq!(market.pnl_pool.scaled_balance, 960549500000);
    market.unrealized_pnl_initial_asset_weight = SPOT_WEIGHT_PRECISION;
    drop(market);

    let MarginCalculation {
        margin_requirement,
        total_collateral,
        ..
    } = calculate_margin_requirement_and_total_collateral_and_liability_info(
        &user,
        &perp_market_map,
        &spot_market_map,
        &mut oracle_map,
        MarginContext::standard(MarginRequirementType::Initial),
    )
    .unwrap();

    assert_eq!(margin_requirement, 10_000_000_000);
    assert_eq!(total_collateral, 8_100_000_000); //100 * 100 *.8 + 100 (cap of upnl for initial margin)
}

#[test]
fn check_usdc_spot_market_twap() {
    let mut now = 30_i64;
    let _slot = 0_u64;

    let _oracle_price = get_pyth_price(1, 6);
    // let oracle_price_key =
    //     Pubkey::from_str("J83w4HKfqxwcq3BEMMkPFSppX3gqekLyLJBexebFVkix").unwrap();

    // usdc market
    let mut spot_market = SpotMarket {
        market_index: 0,
        oracle_source: OracleSource::QuoteAsset,
        cumulative_deposit_interest: SPOT_CUMULATIVE_INTEREST_PRECISION,
        cumulative_borrow_interest: SPOT_CUMULATIVE_INTEREST_PRECISION,
        decimals: 6,
        initial_asset_weight: SPOT_WEIGHT_PRECISION,
        maintenance_asset_weight: SPOT_WEIGHT_PRECISION,
        deposit_balance: 100_000_000 * SPOT_BALANCE_PRECISION, //$100M usdc
        borrow_balance: 0,
        deposit_token_twap: QUOTE_PRECISION_U64 / 2,
        historical_oracle_data: HistoricalOracleData::default_quote_oracle(),
        status: MarketStatus::Active,
        ..SpotMarket::default()
    };
    // create_anchor_account_info!(spot_market, SpotMarket, spot_market_account_info);
    let oracle_price_data = OraclePriceData {
        price: PRICE_PRECISION_I64,
        confidence: 1,
        delay: 0,
        has_sufficient_number_of_data_points: true,
    };

    update_spot_market_twap_stats(&mut spot_market, Some(&oracle_price_data), now).unwrap();
    assert_eq!(spot_market.historical_oracle_data.last_oracle_delay, 0);
    assert_eq!(
        spot_market.historical_oracle_data.last_oracle_price_twap,
        1000001
    );
    assert_eq!(
        spot_market
            .historical_oracle_data
            .last_oracle_price_twap_5min,
        1000001
    );
    let cur_time = 1679940002;
    now += cur_time;
    update_spot_market_twap_stats(&mut spot_market, Some(&oracle_price_data), now).unwrap();
    assert_eq!(
        spot_market
            .historical_oracle_data
            .last_oracle_price_twap_5min,
        1000000
    );

    while now < cur_time + 1000 {
        now += 1;
        update_spot_market_twap_stats(&mut spot_market, Some(&oracle_price_data), now).unwrap();
        update_spot_market_twap_stats(&mut spot_market, Some(&oracle_price_data), now).unwrap();
    }

    // twap gets distorted with multiple stat update calls in same clock.unix_timestamp
    assert_eq!(
        spot_market
            .historical_oracle_data
            .last_oracle_price_twap_5min,
        1000001
    );
    assert_eq!(
        spot_market.historical_oracle_data.last_oracle_price_twap,
        1000001
    );

    let wa_res =
        calculate_weighted_average(PRICE_PRECISION_I64, PRICE_PRECISION_I64, 0, ONE_HOUR).unwrap();

    assert_eq!(wa_res, PRICE_PRECISION_I64);
    let wa_res2 =
        calculate_weighted_average(PRICE_PRECISION_I64, PRICE_PRECISION_I64 + 1, 0, ONE_HOUR)
            .unwrap();
    assert_eq!(wa_res2, PRICE_PRECISION_I64 + 1);

    assert_eq!(
        spot_market.historical_index_data.last_index_price_twap_ts,
        0
    );

    spot_market
        .update_historical_index_price(None, None, 7898)
        .unwrap();
    assert_eq!(
        spot_market.historical_index_data.last_index_price_twap_ts,
        7898
    );
    assert_eq!(spot_market.historical_index_data.last_index_price_twap, 0);
    assert_eq!(
        spot_market.historical_index_data.last_index_price_twap_5min,
        0
    );

    spot_market
        .update_historical_index_price(
            Some(PRICE_PRECISION_U64 - 79083),
            Some(PRICE_PRECISION_U64 + 9174),
            1710344006,
        )
        .unwrap();
    assert_eq!(
        spot_market.historical_index_data.last_index_price_twap_ts,
        1710344006
    );
    assert_eq!(
        spot_market.historical_index_data.last_index_price_twap_5min,
        965044
    );
    assert_eq!(
        spot_market.historical_index_data.last_index_price_twap,
        965044
    );

    spot_market
        .update_historical_index_price(
            Some(PRICE_PRECISION_U64 - 7),
            Some(PRICE_PRECISION_U64 + 9),
            1710344006 + 150,
        )
        .unwrap();

    assert_eq!(
        spot_market.historical_index_data.last_index_price_twap_ts,
        1710344006 + 150
    );
    assert_eq!(
        spot_market.historical_index_data.last_index_price_twap_5min,
        982521
    );
    assert_eq!(
        spot_market.historical_index_data.last_index_price_twap,
        966501
    );
}



#[test]
fn check_spot_market_max_borrow_fraction() {
    let _now = 30_i64;
    let _slot = 0_u64;

    let _oracle_price = get_pyth_price(1, 6);
    let mut spot_market = SpotMarket {
        market_index: 0,
        oracle_source: OracleSource::QuoteAsset,
        cumulative_deposit_interest: SPOT_CUMULATIVE_INTEREST_PRECISION,
        cumulative_borrow_interest: SPOT_CUMULATIVE_INTEREST_PRECISION,
        decimals: 6,
        initial_asset_weight: SPOT_WEIGHT_PRECISION,
        maintenance_asset_weight: SPOT_WEIGHT_PRECISION,
        deposit_balance: 100_000_000 * SPOT_BALANCE_PRECISION, //$100M usdc
        borrow_balance: 0,
        deposit_token_twap: QUOTE_PRECISION_U64 / 2,
        historical_oracle_data: HistoricalOracleData::default_quote_oracle(),
        status: MarketStatus::Active,
        min_borrow_rate: 0,
        max_token_borrows_fraction: 1,
        ..SpotMarket::default()
    };

    assert_eq!(
        spot_market.get_deposits().unwrap(),
        100_000_000 * QUOTE_PRECISION
    );

    assert!(spot_market.validate_max_token_deposits_and_borrows().is_ok());

    spot_market.borrow_balance = spot_market.deposit_balance;
    assert!(spot_market.validate_max_token_deposits_and_borrows().is_ok());

    spot_market.max_token_deposits = (100_000_000 * QUOTE_PRECISION) as u64;

    assert!(spot_market.validate_max_token_deposits_and_borrows().is_err());
    spot_market.borrow_balance = spot_market.deposit_balance/100;
    assert!(spot_market.validate_max_token_deposits_and_borrows().is_err());
    
    spot_market.borrow_balance = spot_market.deposit_balance/(10000-2); // just above 10000th
    assert!(spot_market.validate_max_token_deposits_and_borrows().is_err());

    spot_market.borrow_balance = spot_market.deposit_balance/(10000); // exactly 10000th of deposit
    assert!(spot_market.validate_max_token_deposits_and_borrows().is_ok());

    spot_market.borrow_balance = spot_market.deposit_balance/(10000+1); // < 10000th of deposit
    assert!(spot_market.validate_max_token_deposits_and_borrows().is_ok());

    spot_market.borrow_balance = spot_market.deposit_balance/100000; // 1/10th of 10000
    assert!(spot_market.validate_max_token_deposits_and_borrows().is_ok());

}

#[test]
fn check_spot_market_min_borrow_rate() {
    let now = 30_i64;
    let _slot = 0_u64;

    let _oracle_price = get_pyth_price(1, 6);
    let mut spot_market = SpotMarket {
        market_index: 0,
        oracle_source: OracleSource::QuoteAsset,
        cumulative_deposit_interest: SPOT_CUMULATIVE_INTEREST_PRECISION,
        cumulative_borrow_interest: SPOT_CUMULATIVE_INTEREST_PRECISION,
        decimals: 6,
        initial_asset_weight: SPOT_WEIGHT_PRECISION,
        maintenance_asset_weight: SPOT_WEIGHT_PRECISION,
        deposit_balance: 100_000_000 * SPOT_BALANCE_PRECISION, //$100M usdc
        borrow_balance: 0,
        deposit_token_twap: QUOTE_PRECISION_U64 / 2,
        historical_oracle_data: HistoricalOracleData::default_quote_oracle(),
        status: MarketStatus::Active,
        min_borrow_rate: 0,
        ..SpotMarket::default()
    };

    assert_eq!(
        spot_market.get_deposits().unwrap(),
        100_000_000 * QUOTE_PRECISION
    );

    let accum_interest = calculate_accumulated_interest(&spot_market, now + 10000).unwrap();

    assert_eq!(accum_interest.borrow_interest, 0);
    assert_eq!(accum_interest.deposit_interest, 0);

    spot_market.min_borrow_rate = 1; // .5%

    let accum_interest = calculate_accumulated_interest(&spot_market, now + 10000).unwrap();

    assert_eq!(accum_interest.borrow_interest, 0);
    assert_eq!(accum_interest.deposit_interest, 0);

    spot_market.min_borrow_rate = 1; // .5%
    spot_market.borrow_balance = spot_market.deposit_balance / 100;
    let accum_interest = calculate_accumulated_interest(&spot_market, now + 10000).unwrap();

    assert_eq!(accum_interest.borrow_interest, 15903);
    assert_eq!(accum_interest.deposit_interest, 159);

    spot_market.min_borrow_rate = 10; // 5%
    spot_market.borrow_balance = spot_market.deposit_balance / 100;
    let accum_interest = calculate_accumulated_interest(&spot_market, now + 10000).unwrap();

    assert_eq!(accum_interest.borrow_interest, 159025);
    assert_eq!(accum_interest.deposit_interest, 1590);

    spot_market.min_borrow_rate = 10; // 5%
    spot_market.borrow_balance = spot_market.deposit_balance / 100;
    let accum_interest = calculate_accumulated_interest(&spot_market, now + 1000000).unwrap();

    assert_eq!(accum_interest.borrow_interest, 15855372);
    assert_eq!(accum_interest.deposit_interest, 158553);

    spot_market.min_borrow_rate = 200; // 100%
    spot_market.borrow_balance = spot_market.deposit_balance / 100;
    let accum_interest = calculate_accumulated_interest(&spot_market, now + 1000000).unwrap();

    assert_eq!(accum_interest.borrow_interest, 317107433);
    assert_eq!(accum_interest.deposit_interest, 3171074);
}
