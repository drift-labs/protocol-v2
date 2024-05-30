use std::str::FromStr;

use solana_program::pubkey::Pubkey;

use crate::create_account_info;
use crate::state::oracle::{get_oracle_price, OracleSource};
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
