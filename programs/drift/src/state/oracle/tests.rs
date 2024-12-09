use solana_program::pubkey::Pubkey;
use std::str::FromStr;

use crate::create_account_info;
use crate::state::oracle::{get_oracle_price, OracleSource};
use crate::state::oracle_map::OracleMap;
use crate::state::perp_market::AMM;
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
