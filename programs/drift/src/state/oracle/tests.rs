use solana_program::pubkey::Pubkey;
use std::str::FromStr;

use crate::create_account_info;
use crate::math::constants::{AMM_RESERVE_PRECISION, PRICE_PRECISION_I64, PRICE_PRECISION_U64};
use crate::state::oracle::{get_oracle_price, HistoricalOracleData, OraclePriceData, OracleSource};
use crate::state::oracle_map::OracleMap;
use crate::state::perp_market::{PerpMarket, AMM};
use crate::state::state::State;
use crate::test_utils::*;

#[test]
fn pyth_1k() {
    let mut oracle_price = get_hardcoded_pyth_price(8394, 10);
    let oracle_price_key =
        Pubkey::from_str("8ihFLu5FimgTQ1Unh4dVyEHUGodJ5gJQCrQf4KUVB9bN").unwrap();
    let pyth_program = crate::ids::pyth_program::id();
    create_account_info!(
        oracle_price,
        &oracle_price_key,
        &pyth_program,
        oracle_account_info
    );

    let oracle_price_data =
        get_oracle_price(&OracleSource::Pyth1K, &oracle_account_info, 0).unwrap();
    assert_eq!(oracle_price_data.price, 839);

    let amm = AMM {
        oracle_source: OracleSource::Pyth1K,
        ..AMM::default()
    };

    let twap = amm.get_oracle_twap(&oracle_account_info, 0).unwrap();
    assert_eq!(twap, Some(839));
}

#[test]
fn pyth_1m() {
    let mut oracle_price = get_hardcoded_pyth_price(8394, 10);
    let oracle_price_key =
        Pubkey::from_str("8ihFLu5FimgTQ1Unh4dVyEHUGodJ5gJQCrQf4KUVB9bN").unwrap();
    let pyth_program = crate::ids::pyth_program::id();
    create_account_info!(
        oracle_price,
        &oracle_price_key,
        &pyth_program,
        oracle_account_info
    );

    let oracle_price_data =
        get_oracle_price(&OracleSource::Pyth1M, &oracle_account_info, 0).unwrap();
    assert_eq!(oracle_price_data.price, 839400);

    let amm = AMM {
        oracle_source: OracleSource::Pyth1M,
        ..AMM::default()
    };

    let twap = amm.get_oracle_twap(&oracle_account_info, 0).unwrap();
    assert_eq!(twap, Some(839400));
}

#[test]
fn pyth_pull_1m() {
    let oracle_price_key =
        Pubkey::from_str("DBE3N8uNjhKPRHfANdwGvCZghWXyLPdqdSbEW2XFwBiX").unwrap();
    let oracle_market_str = String::from("IvEjY51+9M206svkAq6RZcKrffzb5QRNJ/KEEG+IqQv93vpfv/YMoAFysCEhfKP+aJIqGar5kBCcudhOmtAEtNICWtb1KTFEGbZFBQAAAAAABQIAAAAAAAD2////xXhYZgAAAADFeFhmAAAAAJMfBQAAAAAAnwEAAAAAAAAFMwYQAAAAAAA=");
    let mut decoded_bytes = base64::decode(oracle_market_str).unwrap();
    let oracle_market_bytes = decoded_bytes.as_mut_slice();
    let mut lamports = 0;
    let pyth_program = crate::ids::drift_oracle_receiver_program::id();
    let bonk_market_account_info = create_account_info(
        &oracle_price_key,
        true,
        &mut lamports,
        oracle_market_bytes,
        &pyth_program,
    );

    let oracle_price_data = get_oracle_price(
        &OracleSource::Pyth1MPull,
        &bonk_market_account_info,
        234919073,
    )
    .unwrap();
    assert_eq!(oracle_price_data.price, 34552600);

    let amm = AMM {
        oracle_source: OracleSource::Pyth1MPull,
        ..AMM::default()
    };

    let twap = amm.get_oracle_twap(&bonk_market_account_info, 0).unwrap();
    assert_eq!(twap, Some(33576300));
}

#[test]
fn switchboard_on_demand() {
    let oracle_price_key =
        Pubkey::from_str("8an9aE6j4STjv1cNXaE7SJfqmfjgLUHpBKURjqcAQJbQ").unwrap();
    let oracle_market_str = String::from("xBtsxArX2ygF5+9rNGznB5bCcRKtQrkPSKnB7SpgtyeGQM7FuE2KVlisPRQAAAAAAAAAAAAAAAA+UHpSRCo0IwwAAAAAAAAAJitDZKZoh6XepseJBXWe/lcspgoK5FkXhG/BewUorG5CqUEUAAAAAFqpQRQAAAAA8PzgMB6TfkcMAAAAAAAAAGjiSUNueeTftplz+u/z8VQ2hRIbsVfG2ikc8Oxa1OVTolooFAAAAAAAAAAAAAAAAEizjuOw8yicCgAAAAAAAAABXj3Y9l4yGBRFXaCetMwT6HpzMpca+kYR/MYh+j8EUB1uPhQAAAAAOG4+FAAAAAACiEe0ZUszUgwAAAAAAAAAkDfiD4Gn+CTbOnE8xYjATeEDBfMWFNY57v1LuujRnGZYrD0UAAAAAAAAAAAAAAAABl3I+mq45SMMAAAAAAAAACVOW/5bK8Btqmx4Vk6zcPIfXO8zAoD0jYfZl8sUISFEaSpxEwAAAAAAAAAAAAAAAMzgbc5nVjCoBwAAAAAAAABQtwZpTNT6DaYcbKn3fERJYIW+SUeHf96zTfeNM0KsnRRGqhMAAAAAAAAAAAAAAABIfPmsmN/hXwgAAAAAAAAAYJg3LYKk7K7VBmaP3CqKdDehOJ9w2BAdGN2ihbblBMLwyyEUAAAAAAAAAAAAAAAAxs9IiXhjQCcJAAAAAAAAACH5pdGZv3Zl4YGR/RkbyiM972/Y6TkFDRSOugqBX8R3pdatEwAAAAAAAAAAAAAAAATJSrig8pADCAAAAAAAAAB7gyHaEgJTUWoB03O2WP2y5wG0BQyy4DIW4QIX0Zm/LBCDrRMAAAAAAAAAAAAAAAD0QtXQ8ppmUwgAAAAAAAAAXKbf3SvboSeQoR1Uax14h2bo3XRZT6YDzVR04CCKI9OiWigUAAAAAAAAAAAAAAAAvDV3NgOBNZwKAAAAAAAAAOZ7GqcB2Y++LyL1s5nlJ5BPWiBqGufX9otlggY7+arpHW4+FAAAAAA4bj4UAAAAACId0nIlrSxSDAAAAAAAAACDlY3q65NTi3f76VZvIIwy9dPg2O22YgY8biVvXVbmRkKpQRQAAAAAWqlBFAAAAADw/OAwHpN+RwwAAAAAAAAA3MJlNs10pau942MW3ICzf2juvzF0+hdValrRUBcb0DpCqUEUAAAAAFqpQRQAAAAAgKcI0J26VkkMAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWnepBOelBHznzx//7xQtA1OAt1Bx+exaGnlnqRII0HyUd7+1/xAShZ8zbPmHJWgOdwW6Kr7OFxiM+yjKZspbC8qNXh/AbUSNWMVBd3cJsl737xFECAru4/NmPaW4F85v6y5GYAAAAAAAAAAAAAAAAAlDV3AAAAAAEAAABkU09MAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAFwNLEDVnAAAAAGeRaxMAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAADw/OAwHpN+RwwAAAAAAAAAEB9A716T3gAAAAAAAAAAAHTgmBCe9RtIDAAAAAAAAACQqieffyfYAQAAAAAAAAAA8PzgMB6TfkcMAAAAAAAAAICnCNCdulZJDAAAAAAAAAADDAAAAAAAAEKpQRQAAAAAQqlBFAAAAABCqUEUAAAAAJYAAAAAAAAAAAAAAAAAAABeHL43OGkgQ0jZpxMAAAAAuwZVOgV4IEP526cTAAAAAEBf4jv4GhxDij6qEwAAAABEt508DB4cQ5E+qhMAAAAARLedPAweHEOVPqoTAAAAAES3nTwMHhxDlj6qEwAAAABEt508DB4cQ5c+qhMAAAAA59KoPCNPG0MhQaoTAAAAADV9tzxZTRtDKUGqEwAAAAA2gsE8Ok4bQytBqhMAAAAAnJVNPGOFGkMHRqoTAAAAAJO/ozyxhBpDD0aqEwAAAACTv6M8sYQaQxBGqhMAAAAAk7+jPLGEGkMRRqoTAAAAAJO/ozyxhBpDEkaqEwAAAADKBrY8jnsaQxdGqhMAAAAA/9jKOLjfGENOV6sTAAAAAG5u7Tyn1hhDqVerEwAAAADm3FA7QJQZQxCDrRMAAAAAAAAAALfUE0Ol1q0TAAAAAAAAAABc2ShD8MshFAAAAACJzNU8PulfQ1isPRQAAAAAATRmOmlIY0Mdbj4UAAAAAF9OgD2UjmJDQqlBFAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==");

    let mut decoded_bytes = base64::decode(oracle_market_str).unwrap();
    let oracle_market_bytes = decoded_bytes.as_mut_slice();
    let mut lamports = 0;
    let sb_program = crate::ids::switchboard_on_demand::id();
    let dsol_oracle_info = create_account_info(
        &oracle_price_key,
        true,
        &mut lamports,
        oracle_market_bytes,
        &sb_program,
    );

    let oracle_price_data = get_oracle_price(
        &OracleSource::SwitchboardOnDemand,
        &dsol_oracle_info,
        339848045,
    )
    .unwrap();
    assert_eq!(oracle_price_data.price, 226556945);

    let amm = AMM {
        oracle_source: OracleSource::SwitchboardOnDemand,
        ..AMM::default()
    };

    let twap = amm.get_oracle_twap(&dsol_oracle_info, 0).unwrap();
    assert_eq!(twap, Some(226556945));
}

#[test]
fn oracle_map_diff_oracle_source() {
    let oracle_price_key =
        Pubkey::from_str("DBE3N8uNjhKPRHfANdwGvCZghWXyLPdqdSbEW2XFwBiX").unwrap();
    let oracle_market_str = String::from("IvEjY51+9M206svkAq6RZcKrffzb5QRNJ/KEEG+IqQv93vpfv/YMoAFysCEhfKP+aJIqGar5kBCcudhOmtAEtNICWtb1KTFEGbZFBQAAAAAABQIAAAAAAAD2////xXhYZgAAAADFeFhmAAAAAJMfBQAAAAAAnwEAAAAAAAAFMwYQAAAAAAA=");
    let mut decoded_bytes = base64::decode(oracle_market_str).unwrap();
    let oracle_market_bytes = decoded_bytes.as_mut_slice();
    let mut lamports = 0;
    let pyth_program = crate::ids::drift_oracle_receiver_program::id();
    let bonk_market_account_info = create_account_info(
        &oracle_price_key,
        true,
        &mut lamports,
        oracle_market_bytes,
        &pyth_program,
    );

    let mut oracle_map = OracleMap::load_one(&bonk_market_account_info, 0, None).unwrap();

    let oracle_price_data = oracle_map
        .get_price_data(&(oracle_price_key, OracleSource::Pyth1MPull))
        .unwrap();
    assert_eq!(oracle_price_data.price, 34552600);

    let oracle_price_data = oracle_map
        .get_price_data(&(oracle_price_key, OracleSource::PythPull))
        .unwrap();
    assert_eq!(oracle_price_data.price, 34);
}

#[test]
fn use_mm_oracle() {
    let slot = 303030303;
    let mut oracle_price_data = OraclePriceData {
        price: 130 * PRICE_PRECISION_I64 + 873,
        confidence: PRICE_PRECISION_U64 / 10,
        delay: 1,
        has_sufficient_number_of_data_points: true,
        sequence_id: Some(1756262481),
    };
    let mut market = PerpMarket {
        market_index: 0,
        amm: AMM {
            base_asset_reserve: 512295081967,
            quote_asset_reserve: 488 * AMM_RESERVE_PRECISION,
            sqrt_k: 500 * AMM_RESERVE_PRECISION,
            peg_multiplier: 22_100_000_000,
            base_asset_amount_with_amm: (12295081967_i128),
            max_spread: 1000,
            mm_oracle_price: 130 * PRICE_PRECISION_I64 + 973,
            mm_oracle_slot: slot,
            mm_oracle_sequence_id: 1756262481,
            historical_oracle_data: HistoricalOracleData::default_with_current_oracle(
                oracle_price_data,
            ),
            // assume someone else has other half same entry,
            ..AMM::default()
        },
        margin_ratio_initial: 1000,
        margin_ratio_maintenance: 500,
        imf_factor: 1000, // 1_000/1_000_000 = .001
        unrealized_pnl_initial_asset_weight: 100,
        unrealized_pnl_maintenance_asset_weight: 100,
        ..PerpMarket::default()
    };
    let state = State::default();

    let mm_oracle_price_data = market
        .get_mm_oracle_price_data(oracle_price_data, slot, &state.oracle_guard_rails.validity)
        .unwrap();

    // Use the MM oracle when it's recent and it's valid to use
    assert_eq!(
        mm_oracle_price_data.get_price(),
        mm_oracle_price_data.mm_oracle_price
    );
    assert_eq!(
        mm_oracle_price_data.get_delay(),
        mm_oracle_price_data.mm_oracle_delay
    );

    // Update the MM oracle slot to be equal but the sequence number to be behind, should use exchange oracle
    market.amm.mm_oracle_sequence_id = 1756262481 - 10;
    let mm_oracle_price_data = market
        .get_mm_oracle_price_data(oracle_price_data, slot, &state.oracle_guard_rails.validity)
        .unwrap();
    assert_eq!(mm_oracle_price_data.get_price(), oracle_price_data.price);
    assert_eq!(mm_oracle_price_data.get_delay(), oracle_price_data.delay,);

    // Update oracle price data to have no sequence id, fall back to using slot comparison
    oracle_price_data.sequence_id = None;

    // With no sequence id and delayed mm oracle slot, should fall back to using oracle price data
    market.amm.mm_oracle_slot = slot - 5;
    let mm_oracle_price_data = market
        .get_mm_oracle_price_data(oracle_price_data, slot, &state.oracle_guard_rails.validity)
        .unwrap();
    assert_eq!(mm_oracle_price_data.get_price(), oracle_price_data.price);
    assert_eq!(mm_oracle_price_data.get_delay(), oracle_price_data.delay,);

    // With no sequence id and up to date mm oracle slot, should use mm oracle
    market.amm.mm_oracle_slot = slot;
    let mm_oracle_price_data = market
        .get_mm_oracle_price_data(oracle_price_data, slot, &state.oracle_guard_rails.validity)
        .unwrap();
    assert_eq!(
        mm_oracle_price_data.get_price(),
        mm_oracle_price_data.mm_oracle_price
    );
    assert_eq!(
        mm_oracle_price_data.get_delay(),
        mm_oracle_price_data.mm_oracle_delay
    );

    // With really off sequence id and up to date mm oracle slot, should fall back to slot comparison
    market.amm.mm_oracle_sequence_id = 1756262481000; // wrong resolution
    market.amm.mm_oracle_slot = slot - 5;
    let mm_oracle_price_data = market
        .get_mm_oracle_price_data(oracle_price_data, slot, &state.oracle_guard_rails.validity)
        .unwrap();
    assert_eq!(mm_oracle_price_data.get_price(), oracle_price_data.price);
    assert_eq!(mm_oracle_price_data.get_delay(), oracle_price_data.delay);
}

#[test]
fn mm_oracle_confidence() {
    let slot = 303030303;
    let oracle_price_data = OraclePriceData {
        price: 130 * PRICE_PRECISION_I64 + 873,
        confidence: PRICE_PRECISION_U64 / 10,
        delay: 1,
        has_sufficient_number_of_data_points: true,
        sequence_id: Some(0),
    };
    let market = PerpMarket {
        market_index: 0,
        amm: AMM {
            base_asset_reserve: 512295081967,
            quote_asset_reserve: 488 * AMM_RESERVE_PRECISION,
            sqrt_k: 500 * AMM_RESERVE_PRECISION,
            peg_multiplier: 22_100_000_000,
            base_asset_amount_with_amm: (12295081967_i128),
            max_spread: 1000,
            mm_oracle_price: 130 * PRICE_PRECISION_I64 + 999,
            mm_oracle_slot: slot,
            mm_oracle_sequence_id: 1,
            historical_oracle_data: HistoricalOracleData::default_with_current_oracle(
                oracle_price_data,
            ),
            // assume someone else has other half same entry,
            ..AMM::default()
        },
        margin_ratio_initial: 1000,
        margin_ratio_maintenance: 500,
        imf_factor: 1000, // 1_000/1_000_000 = .001
        unrealized_pnl_initial_asset_weight: 100,
        unrealized_pnl_maintenance_asset_weight: 100,
        ..PerpMarket::default()
    };
    let state = State::default();

    let mm_oracle_price_data = market
        .get_mm_oracle_price_data(oracle_price_data, slot, &state.oracle_guard_rails.validity)
        .unwrap();

    let expected_confidence = oracle_price_data.confidence
        + (mm_oracle_price_data._get_mm_oracle_price()
            - mm_oracle_price_data.get_exchange_oracle_price_data().price)
            .abs() as u64;

    let confidence = mm_oracle_price_data.get_confidence();
    assert_eq!(confidence, expected_confidence);
}
