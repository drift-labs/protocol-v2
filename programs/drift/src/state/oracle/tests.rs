use solana_program::pubkey::Pubkey;
use std::str::FromStr;

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

#[test]
fn pyth_pull_1m() {
    let oracle_price_key =
        Pubkey::from_str("DBE3N8uNjhKPRHfANdwGvCZghWXyLPdqdSbEW2XFwBiX").unwrap();
    let oracle_market_str = String::from("IvEjY51+9M206svkAq6RZcKrffzb5QRNJ/KEEG+IqQv93vpfv/YMoAFysCEhfKP+aJIqGar5kBCcudhOmtAEtNICWtb1KTFEGbZFBQAAAAAABQIAAAAAAAD2////xXhYZgAAAADFeFhmAAAAAJMfBQAAAAAAnwEAAAAAAAAFMwYQAAAAAAA=");
    let mut decoded_bytes = base64::decode(oracle_market_str).unwrap();
    let oracle_market_bytes = decoded_bytes.as_mut_slice();
    let mut lamports = 0;
    let pyth_program = crate::ids::pyth_pull_program::id();
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
    assert_eq!(oracle_price_data.price, 839400);

    let amm = AMM {
        oracle_source: OracleSource::Pyth1MPull,
        ..AMM::default()
    };

    let twap = amm.get_oracle_twap(&bonk_market_account_info, 0).unwrap();
    assert_eq!(twap, Some(839400));
}
