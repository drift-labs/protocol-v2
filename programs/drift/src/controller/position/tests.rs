use crate::controller::amm::{
    calculate_base_swap_output_with_spread, move_price, recenter_perp_market_amm, swap_base_asset,
};
use crate::controller::lp::{apply_lp_rebase_to_perp_market, settle_lp_position};
use crate::controller::position::{
    update_lp_market_position, update_position_and_market, PositionDelta,
};
use crate::controller::repeg::_update_amm;

use crate::create_account_info;
use crate::math::amm::calculate_market_open_bids_asks;
use crate::math::constants::{
    AMM_RESERVE_PRECISION, AMM_RESERVE_PRECISION_I128, BASE_PRECISION, BASE_PRECISION_I64,
    PRICE_PRECISION_I64, PRICE_PRECISION_U64, QUOTE_PRECISION_I128,
    SPOT_CUMULATIVE_INTEREST_PRECISION, SPOT_WEIGHT_PRECISION,
};
use crate::math::lp::calculate_settle_lp_metrics;
use crate::math::position::swap_direction_to_close_position;
use crate::math::repeg;
use crate::state::oracle::OraclePriceData;
use crate::state::oracle_map::OracleMap;
use crate::state::perp_market::{AMMLiquiditySplit, PerpMarket, AMM};
use crate::state::perp_market_map::PerpMarketMap;
use crate::state::state::State;
use crate::state::user::PerpPosition;
use crate::test_utils::{create_account_info, get_account_bytes};

use crate::bn::U192;
use crate::create_anchor_account_info;
use crate::math::cp_curve::{adjust_k_cost, get_update_k_result, update_k};
use crate::state::oracle::{HistoricalOracleData, OracleSource};
use crate::state::spot_market::SpotMarket;
use crate::state::spot_market_map::SpotMarketMap;
use crate::test_utils::get_anchor_account_bytes;
use crate::test_utils::get_hardcoded_pyth_price;
use crate::QUOTE_PRECISION_I64;
use anchor_lang::prelude::{AccountLoader, Clock};
use anchor_lang::Owner;
use solana_program::pubkey::Pubkey;
use std::str::FromStr;

#[test]
fn full_amm_split() {
    let delta = PositionDelta {
        base_asset_amount: 10 * BASE_PRECISION_I64,
        quote_asset_amount: -10 * BASE_PRECISION_I64,
        remainder_base_asset_amount: None,
    };

    let amm = AMM {
        user_lp_shares: 0,
        sqrt_k: 100 * AMM_RESERVE_PRECISION,
        base_asset_amount_with_amm: 10 * AMM_RESERVE_PRECISION_I128,
        ..AMM::default_test()
    };
    let mut market = PerpMarket {
        amm,
        ..PerpMarket::default_test()
    };

    update_lp_market_position(&mut market, &delta, 0, AMMLiquiditySplit::Shared).unwrap();

    assert_eq!(market.amm.base_asset_amount_with_unsettled_lp, 0);
    assert_eq!(
        market.amm.base_asset_amount_with_amm,
        10 * AMM_RESERVE_PRECISION_I128
    );
}

#[test]
fn amm_pred_expiry_price_yes_market_example() {
    let perp_market_str = String::from("Ct8MLGv1N/dl0p1eEmE81tQYB9Glge6rs+AUr9vviyafBoQk5i+tvySBJ6vhKXcltfwowKDc4P12md85m3szMmZT2G5mXgDnAgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAwAAAAAAAAADAAAAAAAAALkD4WYAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAADi/yshAAAAAAAAAAAAAAAAAAAAAAAAAADoSLcAIQAAAAAAAAAAAAAAeBY5bSkAAAAAAAAAAAAAANiFEAAAAAAAAAAAAAAAAACThIAfHwAAAAAAAAAAAAAAAQY8fiQAAAAAAAAAAAAAAGZEwfkkAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAAAAY2FrkSgAAAAAAAAAAAAAAADWYVTgAQAAAAAAAAAAAAAAiG5eIP7/////////////AF7QsgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAgMakfo0DAAAAAAAAAAAAspRHGwAAAAAAAAAAAAAAALrNFNr////////////////BkYwcAAAAAAAAAAAAAAAAjdsL2v///////////////z+rjRwAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABU1xQHAAAAAAAAAAAAAAAAjXwEBwAAAAAAAAAAAAAAABfpEAAAAAAAAAAAAAAAAADkRV7k////////////////AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAhDEoqAAAAAAAAAAAAAAAAtxAaYlQgAAAAAAAAAAAAALCKdZonAAAAAAAAAAAAAAC6kq+FIgAAAAAAAAAAAAAAAgAAAAAAAADAvfD//////wMAAAAAAAAAsAcLAAAAAADZgwUAAAAAACjIAwAAAAAAyMNKEwAAAABAfZRUuAAAAORFXuT/////6eemZgAAAAAQDgAAAAAAAADKmjsAAAAAZAAAAAAAAAAA8gUqAQAAAAAAAAAAAAAAeDJGCAAAAAC1w4oCAAAAAMz6lQAAAAAADPbXZgAAAADPhQUAAAAAAAIAAAAAAAAAfwfhZgAAAACghgEAQA0DADitCgAIlQQAAAAAAAAAAABkADIAY2QGAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAFRSVU1QLVdJTi0yMDI0LVBSRURJQ1QgICAgICAgICAgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAoPHZZgAAAADEI+j2/////1kAAAAAAAAAAQAAAAAAAAABAAAAAAAAAAEAAAAAAAAAECcAABAnAAAQJwAACycAAAAAAAAQJwAAEAAAABYAAAAaAAcCBAEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==");

    let mut decoded_bytes = base64::decode(perp_market_str).unwrap();
    let perp_market_bytes = decoded_bytes.as_mut_slice();

    let key = Pubkey::default();
    let owner = Pubkey::from_str("dRiftyHA39MWEi3m9aunc5MzRF1JYuBsbn6VPcn33UH").unwrap();
    let mut lamports = 0;
    let perp_market_account_info =
        create_account_info(&key, true, &mut lamports, perp_market_bytes, &owner);

    let perp_market_loader: AccountLoader<PerpMarket> =
        AccountLoader::try_from(&perp_market_account_info).unwrap();

    let perp_market_map = PerpMarketMap::load_one(&perp_market_account_info, true).unwrap();

    let now = 1725948560;
    let clock_slot = 324975051;
    let clock = Clock {
        unix_timestamp: now,
        slot: clock_slot,
        ..Clock::default()
    };

    let mut state = State::default();
    state
        .oracle_guard_rails
        .validity
        .confidence_interval_max_size = 20000;
    // let oracle_market_str = String::from("XA6L6kj0RBoBAAAAAAAAAAIAAAAAAAAAlLsNAAAAAADIw0oTAAAAAMjDShMAAAAAGgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA");
    // let mut decoded_bytes = base64::decode(oracle_market_str).unwrap();
    // let oracle_market_bytes = decoded_bytes.as_mut_slice();

    // let key = Pubkey::from_str("3TVuLmEGBRfVgrmFRtYTheczXaaoRBwcHw1yibZHSeNA").unwrap();
    // let owner = Pubkey::from_str("7rUSt1PXXn2Pp4ZNDcZqZGEgKSGpxqbRyb2W6rG1Dtt6").unwrap();
    // let mut lamports = 0;
    // let jto_market_account_info =
    //     create_account_info(&key, true, &mut lamports, oracle_market_bytes, &owner);
    // let mut oracle_map: OracleMap<'_> =
    //     OracleMap::load_one(&jto_market_account_info, clock_slot, None).unwrap();

    let mut sol_oracle_price: pyth::pc::Price = get_hardcoded_pyth_price(1000000, 6);
    sol_oracle_price.agg.conf = 1655389;

    let sol_oracle_price_key: Pubkey =
        Pubkey::from_str("3TVuLmEGBRfVgrmFRtYTheczXaaoRBwcHw1yibZHSeNA").unwrap();
    let pyth_program = crate::ids::pyth_program::id();
    create_account_info!(
        sol_oracle_price,
        &sol_oracle_price_key,
        &pyth_program,
        oracle_account_info
    );
    let mut oracle_map = OracleMap::load_one(&oracle_account_info, clock_slot, None).unwrap();

    let mut spot_market = SpotMarket {
        market_index: 0,
        oracle_source: OracleSource::QuoteAsset,
        cumulative_deposit_interest: SPOT_CUMULATIVE_INTEREST_PRECISION,
        decimals: 6,
        initial_asset_weight: SPOT_WEIGHT_PRECISION,
        maintenance_asset_weight: SPOT_WEIGHT_PRECISION,
        historical_oracle_data: HistoricalOracleData {
            last_oracle_price_twap: PRICE_PRECISION_I64,
            last_oracle_price_twap_5min: PRICE_PRECISION_I64,
            ..HistoricalOracleData::default()
        },
        ..SpotMarket::default()
    };
    create_anchor_account_info!(spot_market, SpotMarket, spot_market_account_info);
    let spot_market_map: SpotMarketMap<'_> =
        SpotMarketMap::load_one(&spot_market_account_info, true).unwrap();
    let mut market_index;

    {
        let mut perp_market = perp_market_loader.load_mut().unwrap();
        perp_market.amm.historical_oracle_data.last_oracle_price = 1_000_000;
        perp_market.amm.base_asset_amount_with_amm = 0;

        market_index = perp_market.market_index;
        assert_eq!(perp_market.expiry_ts, 1725559200);
        assert_eq!(perp_market.expiry_price, -152558652); // needs to be updated/corrected
    }

    crate::controller::repeg::update_amm(
        market_index,
        &perp_market_map,
        &mut oracle_map,
        &state,
        &clock,
    )
    .unwrap();

    crate::controller::repeg::settle_expired_market(
        market_index,
        &perp_market_map,
        &mut oracle_map,
        &spot_market_map,
        &state,
        &clock,
    )
    .unwrap();

    {
        let mut perp_market = perp_market_loader.load_mut().unwrap();
        market_index = perp_market.market_index;
        assert_eq!(perp_market.expiry_price, 1_000_000);
    }
}

#[test]
fn amm_pred_expiry_price_market_example() {
    let perp_market_str = String::from("Ct8MLGv1N/dl0p1eEmE81tQYB9Glge6rs+AUr9vviyafBoQk5i+tvySBJ6vhKXcltfwowKDc4P12md85m3szMmZT2G5mXgDnAgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAwAAAAAAAAADAAAAAAAAALkD4WYAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAADi/yshAAAAAAAAAAAAAAAAAAAAAAAAAADoSLcAIQAAAAAAAAAAAAAAeBY5bSkAAAAAAAAAAAAAANiFEAAAAAAAAAAAAAAAAACThIAfHwAAAAAAAAAAAAAAAQY8fiQAAAAAAAAAAAAAAGZEwfkkAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAAAAY2FrkSgAAAAAAAAAAAAAAADWYVTgAQAAAAAAAAAAAAAAiG5eIP7/////////////AF7QsgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAgMakfo0DAAAAAAAAAAAAspRHGwAAAAAAAAAAAAAAALrNFNr////////////////BkYwcAAAAAAAAAAAAAAAAjdsL2v///////////////z+rjRwAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABU1xQHAAAAAAAAAAAAAAAAjXwEBwAAAAAAAAAAAAAAABfpEAAAAAAAAAAAAAAAAADkRV7k////////////////AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAhDEoqAAAAAAAAAAAAAAAAtxAaYlQgAAAAAAAAAAAAALCKdZonAAAAAAAAAAAAAAC6kq+FIgAAAAAAAAAAAAAAAgAAAAAAAADAvfD//////wMAAAAAAAAAsAcLAAAAAADZgwUAAAAAACjIAwAAAAAAyMNKEwAAAABAfZRUuAAAAORFXuT/////6eemZgAAAAAQDgAAAAAAAADKmjsAAAAAZAAAAAAAAAAA8gUqAQAAAAAAAAAAAAAAeDJGCAAAAAC1w4oCAAAAAMz6lQAAAAAADPbXZgAAAADPhQUAAAAAAAIAAAAAAAAAfwfhZgAAAACghgEAQA0DADitCgAIlQQAAAAAAAAAAABkADIAY2QGAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAFRSVU1QLVdJTi0yMDI0LVBSRURJQ1QgICAgICAgICAgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAoPHZZgAAAADEI+j2/////1kAAAAAAAAAAQAAAAAAAAABAAAAAAAAAAEAAAAAAAAAECcAABAnAAAQJwAACycAAAAAAAAQJwAAEAAAABYAAAAaAAcCBAEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==");

    let mut decoded_bytes = base64::decode(perp_market_str).unwrap();
    let perp_market_bytes = decoded_bytes.as_mut_slice();

    let key = Pubkey::default();
    let owner = Pubkey::from_str("dRiftyHA39MWEi3m9aunc5MzRF1JYuBsbn6VPcn33UH").unwrap();
    let mut lamports = 0;
    let perp_market_account_info =
        create_account_info(&key, true, &mut lamports, perp_market_bytes, &owner);

    let perp_market_loader: AccountLoader<PerpMarket> =
        AccountLoader::try_from(&perp_market_account_info).unwrap();

    let perp_market_map = PerpMarketMap::load_one(&perp_market_account_info, true).unwrap();

    let now = 1725948560;
    let clock_slot = 324975051;
    let clock = Clock {
        unix_timestamp: now,
        slot: clock_slot,
        ..Clock::default()
    };

    let mut state = State::default();
    state
        .oracle_guard_rails
        .validity
        .confidence_interval_max_size = 20000;
    // let oracle_market_str = String::from("XA6L6kj0RBoBAAAAAAAAAAIAAAAAAAAAlLsNAAAAAADIw0oTAAAAAMjDShMAAAAAGgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA");
    // let mut decoded_bytes = base64::decode(oracle_market_str).unwrap();
    // let oracle_market_bytes = decoded_bytes.as_mut_slice();

    // let key = Pubkey::from_str("3TVuLmEGBRfVgrmFRtYTheczXaaoRBwcHw1yibZHSeNA").unwrap();
    // let owner = Pubkey::from_str("7rUSt1PXXn2Pp4ZNDcZqZGEgKSGpxqbRyb2W6rG1Dtt6").unwrap();
    // let mut lamports = 0;
    // let jto_market_account_info =
    //     create_account_info(&key, true, &mut lamports, oracle_market_bytes, &owner);
    // let mut oracle_map: OracleMap<'_> =
    //     OracleMap::load_one(&jto_market_account_info, clock_slot, None).unwrap();

    let mut sol_oracle_price: pyth::pc::Price = get_hardcoded_pyth_price(1, 6);
    sol_oracle_price.agg.conf = 1655389;

    let sol_oracle_price_key: Pubkey =
        Pubkey::from_str("3TVuLmEGBRfVgrmFRtYTheczXaaoRBwcHw1yibZHSeNA").unwrap();
    let pyth_program = crate::ids::pyth_program::id();
    create_account_info!(
        sol_oracle_price,
        &sol_oracle_price_key,
        &pyth_program,
        oracle_account_info
    );
    let mut oracle_map = OracleMap::load_one(&oracle_account_info, clock_slot, None).unwrap();

    let mut spot_market = SpotMarket {
        market_index: 0,
        oracle_source: OracleSource::QuoteAsset,
        cumulative_deposit_interest: SPOT_CUMULATIVE_INTEREST_PRECISION,
        decimals: 6,
        initial_asset_weight: SPOT_WEIGHT_PRECISION,
        maintenance_asset_weight: SPOT_WEIGHT_PRECISION,
        historical_oracle_data: HistoricalOracleData {
            last_oracle_price_twap: PRICE_PRECISION_I64,
            last_oracle_price_twap_5min: PRICE_PRECISION_I64,
            ..HistoricalOracleData::default()
        },
        ..SpotMarket::default()
    };
    create_anchor_account_info!(spot_market, SpotMarket, spot_market_account_info);
    let spot_market_map: SpotMarketMap<'_> =
        SpotMarketMap::load_one(&spot_market_account_info, true).unwrap();
    let mut market_index;

    {
        let mut perp_market = perp_market_loader.load_mut().unwrap();
        market_index = perp_market.market_index;
        perp_market.amm.base_asset_amount_with_amm = 0;
        perp_market.amm.historical_oracle_data.last_oracle_price = 1;

        assert_eq!(perp_market.expiry_ts, 1725559200);
        assert_eq!(perp_market.expiry_price, -152558652); // needs to be updated/corrected
    }

    crate::controller::repeg::update_amm(
        market_index,
        &perp_market_map,
        &mut oracle_map,
        &state,
        &clock,
    )
    .unwrap();

    crate::controller::repeg::settle_expired_market(
        market_index,
        &perp_market_map,
        &mut oracle_map,
        &spot_market_map,
        &state,
        &clock,
    )
    .unwrap();

    {
        let mut perp_market = perp_market_loader.load_mut().unwrap();
        market_index = perp_market.market_index;
        assert_eq!(perp_market.expiry_price, 1);
    }
}

#[test]
fn amm_pred_settle_market_example() {
    let perp_market_str = String::from("Ct8MLGv1N/dl0p1eEmE81tQYB9Glge6rs+AUr9vviyafBoQk5i+tvySBJ6vhKXcltfwowKDc4P12md85m3szMmZT2G5mXgDnQEIPAAAAAAAAAAAAAAAAAAAAAAAAAAAAAQAAAAAAAAB/vA0AAAAAAOeV2GYAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAADi/yshAAAAAAAAAAAAAAAAAAAAAAAAAADoSLcAIQAAAAAAAAAAAAAAeBY5bSkAAAAAAAAAAAAAANiFEAAAAAAAAAAAAAAAAACThIAfHwAAAAAAAAAAAAAAAQY8fiQAAAAAAAAAAAAAAGZEwfkkAAAAAAAAAAAAAAC98AoAAAAAAAAAAAAAAAAAY2FrkSgAAAAAAAAAAAAAAADWYVTgAQAAAAAAAAAAAAAAiG5eIP7/////////////AF7QsgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAgMakfo0DAAAAAAAAAAAAspRHGwAAAAAAAAAAAAAAALrNFNr////////////////BkYwcAAAAAAAAAAAAAAAAjdsL2v///////////////z+rjRwAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABU1xQHAAAAAAAAAAAAAAAAjXwEBwAAAAAAAAAAAAAAABfpEAAAAAAAAAAAAAAAAACm7TXk////////////////AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA0ViNPHwAAAAAAAAAAAAAA8UfpqisAAAAAAAAAAAAAAHHyxwAkAAAAAAAAAAAAAACZVHT5JQAAAAAAAAAAAAAAfrwNAAAAAAD3Tf7//////wEAAAAAAAAAXkIZAAAAAAABAAAAAAAAAAEAAAAAAAAAyMNKEwAAAAA0Qg8AAAAAAKbtNeT/////6eemZgAAAAAQDgAAAAAAAADKmjsAAAAAZAAAAAAAAAAA8gUqAQAAAAAAAAAAAAAAeDJGCAAAAAC1w4oCAAAAAMz6lQAAAAAADPbXZgAAAAAGAAAAAAAAAAEAAAAAAAAA55XYZgAAAACghgEAQA0DAJ7ODACicwIAAAAAAAAAAABkADIAY2QGAQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAFRSVU1QLVdJTi0yMDI0LVBSRURJQ1QgICAgICAgICAgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAoPHZZgAAAAAAAAAAAAAAAFkAAAAAAAAAAQAAAAAAAAABAAAAAAAAAAEAAAAAAAAAECcAABAnAAAQJwAACycAAAAAAAAQJwAAEAAAABYAAAAaAAYCBAEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==");
    let mut decoded_bytes = base64::decode(perp_market_str).unwrap();
    let perp_market_bytes = decoded_bytes.as_mut_slice();

    let key = Pubkey::default();
    let owner = Pubkey::from_str("dRiftyHA39MWEi3m9aunc5MzRF1JYuBsbn6VPcn33UH").unwrap();
    let mut lamports = 0;
    let perp_market_account_info =
        create_account_info(&key, true, &mut lamports, perp_market_bytes, &owner);

    let perp_market_loader: AccountLoader<PerpMarket> =
        AccountLoader::try_from(&perp_market_account_info).unwrap();

    let perp_market_map = PerpMarketMap::load_one(&perp_market_account_info, true).unwrap();

    let now = 1725948560;
    let clock_slot = 324975051;
    let clock = Clock {
        unix_timestamp: now,
        slot: clock_slot,
        ..Clock::default()
    };

    let mut state = State::default();
    state
        .oracle_guard_rails
        .validity
        .confidence_interval_max_size = 20000;
    // let oracle_market_str = String::from("XA6L6kj0RBoBAAAAAAAAAAIAAAAAAAAAlLsNAAAAAADIw0oTAAAAAMjDShMAAAAAGgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA");
    // let mut decoded_bytes = base64::decode(oracle_market_str).unwrap();
    // let oracle_market_bytes = decoded_bytes.as_mut_slice();

    // let key = Pubkey::from_str("3TVuLmEGBRfVgrmFRtYTheczXaaoRBwcHw1yibZHSeNA").unwrap();
    // let owner = Pubkey::from_str("7rUSt1PXXn2Pp4ZNDcZqZGEgKSGpxqbRyb2W6rG1Dtt6").unwrap();
    // let mut lamports = 0;
    // let jto_market_account_info =
    //     create_account_info(&key, true, &mut lamports, oracle_market_bytes, &owner);
    // let mut oracle_map: OracleMap<'_> =
    //     OracleMap::load_one(&jto_market_account_info, clock_slot, None).unwrap();

    let mut sol_oracle_price: pyth::pc::Price = get_hardcoded_pyth_price(1, 6);
    sol_oracle_price.agg.conf = 1655389;

    let sol_oracle_price_key: Pubkey =
        Pubkey::from_str("3TVuLmEGBRfVgrmFRtYTheczXaaoRBwcHw1yibZHSeNA").unwrap();
    let pyth_program = crate::ids::pyth_program::id();
    create_account_info!(
        sol_oracle_price,
        &sol_oracle_price_key,
        &pyth_program,
        oracle_account_info
    );
    let mut oracle_map = OracleMap::load_one(&oracle_account_info, clock_slot, None).unwrap();

    let mut spot_market = SpotMarket {
        market_index: 0,
        oracle_source: OracleSource::QuoteAsset,
        cumulative_deposit_interest: SPOT_CUMULATIVE_INTEREST_PRECISION,
        decimals: 6,
        initial_asset_weight: SPOT_WEIGHT_PRECISION,
        maintenance_asset_weight: SPOT_WEIGHT_PRECISION,
        historical_oracle_data: HistoricalOracleData {
            last_oracle_price_twap: PRICE_PRECISION_I64,
            last_oracle_price_twap_5min: PRICE_PRECISION_I64,
            ..HistoricalOracleData::default()
        },
        ..SpotMarket::default()
    };
    create_anchor_account_info!(spot_market, SpotMarket, spot_market_account_info);
    let spot_market_map: SpotMarketMap<'_> =
        SpotMarketMap::load_one(&spot_market_account_info, true).unwrap();
    let mut market_index;

    {
        let mut perp_market = perp_market_loader.load_mut().unwrap();
        market_index = perp_market.market_index;
        assert_eq!(perp_market.expiry_ts, 1725559200);
    }

    crate::controller::repeg::update_amm(
        market_index,
        &perp_market_map,
        &mut oracle_map,
        &state,
        &clock,
    )
    .unwrap();

    crate::controller::repeg::settle_expired_market(
        market_index,
        &perp_market_map,
        &mut oracle_map,
        &spot_market_map,
        &state,
        &clock,
    )
    .unwrap();
}

#[test]
fn amm_pred_market_example() {
    let perp_market_str = String::from("Ct8MLGv1N/d4Z6qgHBUxeWCMxmRIBUFu0Cbgr0+cynpC7DpYkS/CTOXP21T33POxW4i7bmk7mDMybOGpdoswWmd3q/AGvjM8HTQLAAAAAAAAAAAAAAAAAAAAAAAAAAAAqtMKAAAAAACR0QoAAAAAAJAArWYAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAKhRYWAAAAAAAAAAAAAAAAAAAAAAAAAAAWyBUBRDMAAAAAAAAAAAAATEkY4cczAAAAAAAAAAAAANiFEAAAAAAAAAAAAAAAAACc5bSDyS8AAAAAAAAAAAAA1uyyUAg4AAAAAAAAAAAAAJjC5caFMwAAAAAAAAAAAACNswoAAAAAAAAAAAAAAAAAlCya3EwzAAAAAAAAAAAAAACIetViAQAAAAAAAAAAAAAAGMYZGP//////////////AKBA73oAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAgMakfo0DAAAAAAAAAAAAWxTg6P///////////////zSW/7z///////////////+4zDQtAAAAAAAAAAAAAAAAu5QAvf///////////////yKkLy0AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA9WW4DAAAAAAAAAAAAAAAA91heAwAAAAAAAAAAAAAAAD/sEAAAAAAAAAAAAAAAAAB3HGkAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABr91NW/i4AAAAAAAAAAAAAmNuO9Xw4AAAAAAAAAAAAAM10iFwuNAAAAAAAAAAAAACu8upR3zIAAAAAAAAAAAAAxc8KAAAAAABfcf///////+WlCgAAAAAAAcILAAAAAADzMwsAAAAAAK+HCwAAAAAAAqTVEgAAAADpkAEAAAAAAHccaQAAAAAA7pynZgAAAAAQDgAAAAAAAADKmjsAAAAA6AMAAAAAAAAA8gUqAQAAAAAAAAAAAAAANj3uUAAAAAAAAAAAAAAAAECLrAoAAAAAkv+sZgAAAADtVQAAAAAAAOUDAAAAAAAAkACtZgAAAACghgEAQA0DANiYAgD6iAAAhQAAAEUAAABkADIAZGQGAQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAHCK274AAAAAAAAAAAAAAAAAAAAAAAAAAEtBTUFMQS1QT1BVTEFSLVZPVEUtUFJFRElDVCAgICAgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAACYAAAAAAAAAAQAAAAAAAAABAAAAAAAAAAEAAAAAAAAAECcAABAnAAAQJwAACycAAAAAAAAQJwAABwAAAAwAAAAbAAECBAEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==");
    let mut decoded_bytes = base64::decode(perp_market_str).unwrap();
    let perp_market_bytes = decoded_bytes.as_mut_slice();

    let key = Pubkey::default();
    let owner = Pubkey::from_str("dRiftyHA39MWEi3m9aunc5MzRF1JYuBsbn6VPcn33UH").unwrap();
    let mut lamports = 0;
    let perp_market_account_info =
        create_account_info(&key, true, &mut lamports, perp_market_bytes, &owner);

    let perp_market_loader: AccountLoader<PerpMarket> =
        AccountLoader::try_from(&perp_market_account_info).unwrap();
    let mut perp_market = perp_market_loader.load_mut().unwrap();

    let now = 1722614328;
    let clock_slot = 281152241;
    let state = State::default();
    let oracle_price_data = OraclePriceData {
        price: 743335,
        confidence: 47843,
        delay: 1,
        has_sufficient_number_of_data_points: true,
    };

    let (max_bids, max_asks) = calculate_market_open_bids_asks(&perp_market.amm).unwrap();
    perp_market.amm.curve_update_intensity = 99;

    assert_eq!(max_bids, 3_824_624_394_874); // 3824 shares
    assert_eq!(max_asks, -5_241_195_799_744); // -5000 shares

    assert_eq!(perp_market.amm.sqrt_k, 56_649_660_613_272);

    let (optimal_peg, fee_budget, _check_lower_bound) =
        repeg::calculate_optimal_peg_and_budget(&perp_market, &oracle_price_data).unwrap();

    assert_eq!(perp_market.amm.terminal_quote_asset_reserve, 56405211622548);
    assert_eq!(perp_market.amm.quote_asset_reserve, 56933567973708);
    assert_eq!(
        perp_market.amm.quote_asset_reserve - perp_market.amm.terminal_quote_asset_reserve,
        528356351160
    );

    let (_repegged_market, repegged_cost) = repeg::adjust_amm(
        &perp_market,
        optimal_peg,
        fee_budget,
        perp_market.amm.curve_update_intensity >= 100,
    )
    .unwrap();

    // if adjust k is true:
    // assert_eq!(_repegged_market.amm.terminal_quote_asset_reserve, 56348282906824);
    // assert_eq!(_repegged_market.amm.quote_asset_reserve, 56876634348803);
    // assert_eq!(_repegged_market.amm.quote_asset_reserve - _repegged_market.amm.terminal_quote_asset_reserve, 528351441979);

    // let cost_applied = apply_cost_to_market(&perp_market, repegged_cost, check_lower_bound).unwrap();

    assert_eq!(optimal_peg, 735939);
    assert_eq!(fee_budget, 6334040);
    assert_eq!(repegged_cost, 6333935);
    assert!(repegged_cost <= fee_budget as i128);

    let cost = _update_amm(
        &mut perp_market,
        &oracle_price_data,
        &state,
        now,
        clock_slot,
    )
    .unwrap();

    assert_eq!(cost, 6333935);
}

#[test]
fn amm_split_large_k() {
    let perp_market_str = String::from("Ct8MLGv1N/dvAH3EF67yBqaUQerctpm4yqpK+QNSrXCQz76p+B+ka+8Ni2/aLOukHaFdQJXR2jkqDS+O0MbHvA9M+sjCgLVtQwhkAQAAAAAAAAAAAAAAAAIAAAAAAAAAkI1kAQAAAAB6XWQBAAAAAO8yzWQAAAAAnJ7I3f///////////////2dHvwAAAAAAAAAAAAAAAABGiVjX6roAAAAAAAAAAAAAAAAAAAAAAAB1tO47J+xiAAAAAAAAAAAAGD03Fis3mgAAAAAAAAAAAJxiDwAAAAAAAAAAAAAAAABxqRCIGRxiAAAAAAAAAAAAEy8wZfK9YwAAAAAAAAAAAGZeZCE+g3sAAAAAAAAAAAAKYeQAAAAAAAAAAAAAAAAAlIvoyyc3mgAAAAAAAAAAAADQdQKjbgAAAAAAAAAAAAAAwu8g05H/////////////E6tNHAIAAAAAAAAAAAAAAO3mFwd0AAAAAAAAAAAAAAAAgPQg5rUAAAAAAAAAAAAAGkDtXR4AAAAAAAAAAAAAAEv0WeZW/f////////////9kUidaqAIAAAAAAAAAAAAA0ZMEr1H9/////////////w5/U3uqAgAAAAAAAAAAAAAANfbqfCd3AAAAAAAAAAAAIhABAAAAAAAiEAEAAAAAACIQAQAAAAAAY1QBAAAAAAA5f3WMVAAAAAAAAAAAAAAAFhkiihsAAAAAAAAAAAAAAO2EfWc5AAAAAAAAAAAAAACM/5CAQgAAAAAAAAAAAAAAvenX0SsAAAAAAAAAAAAAALgPUogZAAAAAAAAAAAAAAC01x97AAAAAAAAAAAAAAAAOXzVbgAAAAAAAAAAAAAAAMG4+QwBAAAAAAAAAAAAAABwHI3fLeJiAAAAAAAAAAAABvigOblGmgAAAAAAAAAAALeRnZsi9mIAAAAAAAAAAAAqgs3ynCeaAAAAAAAAAAAAQwhkAQAAAAAAAAAAAAAAAJOMZAEAAAAAFKJkAQAAAABTl2QBAAAAALFuZAEAAAAAgrx7DAAAAAAUAwAAAAAAAAN1TAYAAAAAuC7NZAAAAAAQDgAAAAAAAADh9QUAAAAAZAAAAAAAAAAA4fUFAAAAAAAAAAAAAAAAn2HvyMABAADGV6rZFwAAAE5Qg2oPAAAA8zHNZAAAAAAdYAAAAAAAAE2FAAAAAAAA6zLNZAAAAAD6AAAAaEIAABQDAAAUAwAAAAAAANcBAABkADIAZGQAAcDIUt4AAAAA0QQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAI9qQbynsAAAAAAAAAAAAAAAAAAAAAAAAFNPTC1QRVJQICAgICAgICAgICAgICAgICAgICAgICAghuS1//////8A4fUFAAAAAAB0O6QLAAAAR7PdeQMAAAD+Mc1kAAAAAADKmjsAAAAAAAAAAAAAAAAAAAAAAAAAAOULDwAAAAAAUBkAAAAAAADtAQAAAAAAAMgAAAAAAAAAECcAAKhhAADoAwAA9AEAAAAAAAAQJwAAZAIAAGQCAAAAAAEAAQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==");
    let mut decoded_bytes = base64::decode(perp_market_str).unwrap();
    let perp_market_bytes = decoded_bytes.as_mut_slice();

    let key = Pubkey::default();
    let owner = Pubkey::from_str("dRiftyHA39MWEi3m9aunc5MzRF1JYuBsbn6VPcn33UH").unwrap();
    let mut lamports = 0;
    let perp_market_account_info =
        create_account_info(&key, true, &mut lamports, perp_market_bytes, &owner);

    let perp_market_loader: AccountLoader<PerpMarket> =
        AccountLoader::try_from(&perp_market_account_info).unwrap();
    let mut perp_market = perp_market_loader.load_mut().unwrap();

    assert_eq!(perp_market.amm.base_asset_amount_per_lp, -574054756);
    assert_eq!(perp_market.amm.quote_asset_amount_per_lp, 12535655);

    let og_baapl = perp_market.amm.base_asset_amount_per_lp;
    let og_qaapl = perp_market.amm.quote_asset_amount_per_lp;

    // msg!("perp_market: {:?}", perp_market);

    // min long order for $2.3
    let delta = PositionDelta {
        base_asset_amount: BASE_PRECISION_I64 / 10,
        quote_asset_amount: -2300000,
        remainder_base_asset_amount: None,
    };

    update_lp_market_position(&mut perp_market, &delta, 0, AMMLiquiditySplit::Shared).unwrap();

    assert_eq!(perp_market.amm.base_asset_amount_per_lp, -574054758);
    assert_eq!(perp_market.amm.quote_asset_amount_per_lp, 12535655);

    // min short order for $2.3
    let delta = PositionDelta {
        base_asset_amount: -BASE_PRECISION_I64 / 10,
        quote_asset_amount: 2300000,
        remainder_base_asset_amount: None,
    };

    update_lp_market_position(&mut perp_market, &delta, 0, AMMLiquiditySplit::Shared).unwrap();

    assert_eq!(perp_market.amm.base_asset_amount_per_lp, -574054756);
    assert_eq!(perp_market.amm.quote_asset_amount_per_lp, 12535654);

    let mut existing_position = PerpPosition {
        market_index: 0,
        base_asset_amount: 0,
        quote_asset_amount: 0,
        lp_shares: perp_market.amm.user_lp_shares as u64,
        last_base_asset_amount_per_lp: og_baapl as i64,
        last_quote_asset_amount_per_lp: og_qaapl as i64,
        per_lp_base: 0,
        ..PerpPosition::default()
    };

    settle_lp_position(&mut existing_position, &mut perp_market).unwrap();

    assert_eq!(existing_position.base_asset_amount, 0);
    assert_eq!(existing_position.remainder_base_asset_amount, 0);
    assert_eq!(existing_position.quote_asset_amount, -33538939); // out of favor rounding

    assert_eq!(existing_position.per_lp_base, perp_market.amm.per_lp_base);

    // long order for $230
    let delta = PositionDelta {
        base_asset_amount: BASE_PRECISION_I64 * 10,
        quote_asset_amount: -230000000,
        remainder_base_asset_amount: None,
    };

    update_lp_market_position(&mut perp_market, &delta, 0, AMMLiquiditySplit::Shared).unwrap();

    assert_eq!(perp_market.amm.base_asset_amount_per_lp, -574055043);
    assert_eq!(perp_market.amm.quote_asset_amount_per_lp, 12535660);

    assert_eq!(
        (perp_market.amm.sqrt_k as i128) * (og_baapl - perp_market.amm.base_asset_amount_per_lp)
            / AMM_RESERVE_PRECISION_I128,
        9977763076
    );
    // assert_eq!((perp_market.amm.sqrt_k as i128) * (og_baapl-perp_market.amm.base_asset_amount_per_lp) / AMM_RESERVE_PRECISION_I128, 104297175);
    assert_eq!(
        (perp_market.amm.sqrt_k as i128) * (og_qaapl - perp_market.amm.quote_asset_amount_per_lp)
            / QUOTE_PRECISION_I128,
        -173828625034
    );
    assert_eq!(
        (perp_market.amm.sqrt_k as i128)
            * (og_qaapl - perp_market.amm.quote_asset_amount_per_lp - 1)
            / QUOTE_PRECISION_I128,
        -208594350041
    );
    // assert_eq!(243360075047/9977763076 < 23, true); // ensure rounding in favor

    // long order for $230
    let delta = PositionDelta {
        base_asset_amount: -BASE_PRECISION_I64 * 10,
        quote_asset_amount: 230000000,
        remainder_base_asset_amount: None,
    };

    let og_baapl = perp_market.amm.base_asset_amount_per_lp;
    let og_qaapl = perp_market.amm.quote_asset_amount_per_lp;

    update_lp_market_position(&mut perp_market, &delta, 0, AMMLiquiditySplit::Shared).unwrap();

    assert_eq!(perp_market.amm.base_asset_amount_per_lp, -574054756);
    assert_eq!(perp_market.amm.quote_asset_amount_per_lp, 12535653);

    assert_eq!(
        (perp_market.amm.sqrt_k as i128) * (og_baapl - perp_market.amm.base_asset_amount_per_lp)
            / AMM_RESERVE_PRECISION_I128,
        -9977763076
    );
    // assert_eq!((perp_market.amm.sqrt_k as i128) * (og_baapl-perp_market.amm.base_asset_amount_per_lp) / AMM_RESERVE_PRECISION_I128, 104297175);
    assert_eq!(
        (perp_market.amm.sqrt_k as i128) * (og_qaapl - perp_market.amm.quote_asset_amount_per_lp)
            / QUOTE_PRECISION_I128,
        243360075047
    );
    // assert_eq!(243360075047/9977763076 < 23, true); // ensure rounding in favor
}

#[test]
fn test_quote_unsettled_lp() {
    let perp_market_str = String::from("Ct8MLGv1N/dvAH3EF67yBqaUQerctpm4yqpK+QNSrXCQz76p+B+ka+8Ni2/aLOukHaFdQJXR2jkqDS+O0MbHvA9M+sjCgLVtzjkqCQAAAAAAAAAAAAAAAAIAAAAAAAAAl44wCQAAAAD54C0JAAAAAGJ4JmYAAAAAyqMxdXz//////////////wV1ZyH9//////////////8Uy592jFYPAAAAAAAAAAAAAAAAAAAAAAD6zIP0/dAIAAAAAAAAAAAA+srqThjtHwAAAAAAAAAAAJxiDwAAAAAAAAAAAAAAAAByWgjyVb4IAAAAAAAAAAAAOpuf9pLjCAAAAAAAAAAAAMRfA6LzxhAAAAAAAAAAAABs6IcCAAAAAAAAAAAAAAAAeXyo6oHtHwAAAAAAAAAAAABngilYXAEAAAAAAAAAAAAAZMIneaP+////////////GeN71uL//////////////+fnyHru//////////////8AIA8MEgUDAAAAAAAAAAAAv1P8g/EBAAAAAAAAAAAAACNQgLCty/////////////+KMQ7JGjMAAAAAAAAAAAAA4DK7xH3K/////////////2grSsB0NQAAAAAAAAAAAACsBC7WWDkCAAAAAAAAAAAAsis3AAAAAACyKzcAAAAAALIrNwAAAAAATGc8AAAAAADH51Hn/wYAAAAAAAAAAAAANXNbBAgCAAAAAAAAAAAAAPNHO0UKBQAAAAAAAAAAAABiEweaqQUAAAAAAAAAAAAAg16F138BAAAAAAAAAAAAAFBZFMk0AQAAAAAAAAAAAACoA6JpBwAAAAAAAAAAAAAALahXXQcAAAAAAAAAAAAAAMG4+QwBAAAAAAAAAAAAAADr9qfqkdAIAAAAAAAAAAAAlBk2nZ/uHwAAAAAAAAAAAHPdcUR+0QgAAAAAAAAAAAAF+03DR+sfAAAAAAAAAAAAzjkqCQAAAAAAAAAAAAAAAJXnMAkAAAAAT9IxCQAAAADyXDEJAAAAAKlJLgkAAAAAyg2YDwAAAABfBwAAAAAAANVPrUEAAAAAZW0mZgAAAAAQDgAAAAAAAADh9QUAAAAAZAAAAAAAAAAA4fUFAAAAAAAAAAAAAAAAj0W2KSYpAABzqJhf6gAAAOD5o985AQAAS3gmZgAAAADxKQYAAAAAAMlUBgAAAAAAS3gmZgAAAADuAgAA7CwAAHcBAAC9AQAAAAAAAH0AAADECTIAZMgAAcDIUt4DAAAAFJMfEQAAAADBogAAAAAAAIneROQcpf//AAAAAAAAAAAAAAAAAAAAAFe4ynNxUwoAAAAAAAAAAAAAAAAAAAAAAFNPTC1QRVJQICAgICAgICAgICAgICAgICAgICAgICAgAJsy4v////8AZc0dAAAAAP8PpdToAAAANOVq3RYAAAB7cyZmAAAAAADh9QUAAAAAAAAAAAAAAAAAAAAAAAAAAEyBWwAAAAAA2DEAAAAAAABzBQAAAAAAAMgAAAAAAAAATB0AANQwAADoAwAA9AEAAAAAAAAQJwAAASoAACtgAAAAAAEAAQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==");
    let mut decoded_bytes = base64::decode(perp_market_str).unwrap();
    let perp_market_bytes = decoded_bytes.as_mut_slice();

    let key = Pubkey::default();
    let owner = Pubkey::from_str("dRiftyHA39MWEi3m9aunc5MzRF1JYuBsbn6VPcn33UH").unwrap();
    let mut lamports = 0;
    let perp_market_account_info =
        create_account_info(&key, true, &mut lamports, perp_market_bytes, &owner);

    let perp_market_loader: AccountLoader<PerpMarket> =
        AccountLoader::try_from(&perp_market_account_info).unwrap();
    let mut perp_market = perp_market_loader.load_mut().unwrap();
    perp_market.amm.quote_asset_amount_with_unsettled_lp = 0;

    let mut existing_position: PerpPosition = PerpPosition::default();
    assert_eq!(perp_market.amm.quote_asset_amount_per_lp, -12324473595);
    assert_eq!(perp_market.amm.base_asset_amount_per_lp, -564969495606);

    existing_position.last_quote_asset_amount_per_lp =
        perp_market.amm.quote_asset_amount_per_lp as i64;
    existing_position.last_base_asset_amount_per_lp =
        perp_market.amm.base_asset_amount_per_lp as i64;

    let pos_delta = PositionDelta {
        quote_asset_amount: QUOTE_PRECISION_I64 * 150,
        base_asset_amount: -BASE_PRECISION_I64,
        remainder_base_asset_amount: Some(-881),
    };
    assert_eq!(perp_market.amm.quote_asset_amount_with_unsettled_lp, 0);
    let fee_to_market = 1000000; // uno doll
    let liq_split = AMMLiquiditySplit::Shared;
    let base_unit: i128 = perp_market.amm.get_per_lp_base_unit().unwrap();
    assert_eq!(base_unit, 1_000_000_000_000); // 10^4 * base_precision

    let (per_lp_delta_base, per_lp_delta_quote, per_lp_fee) = perp_market
        .amm
        .calculate_per_lp_delta(&pos_delta, fee_to_market, liq_split, base_unit)
        .unwrap();

    assert_eq!(per_lp_delta_base, -211759);
    assert_eq!(per_lp_delta_quote, 31764);
    assert_eq!(per_lp_fee, 169);

    let pos_delta2 = PositionDelta {
        quote_asset_amount: -QUOTE_PRECISION_I64 * 150,
        base_asset_amount: BASE_PRECISION_I64,
        remainder_base_asset_amount: Some(0),
    };
    let (per_lp_delta_base, per_lp_delta_quote, per_lp_fee) = perp_market
        .amm
        .calculate_per_lp_delta(&pos_delta2, fee_to_market, liq_split, base_unit)
        .unwrap();

    assert_eq!(per_lp_delta_base, 211759);
    assert_eq!(per_lp_delta_quote, -31763);
    assert_eq!(per_lp_fee, 169);

    let expected_base_asset_amount_with_unsettled_lp = -75249424409;
    assert_eq!(
        perp_market.amm.base_asset_amount_with_unsettled_lp,
        // 0
        expected_base_asset_amount_with_unsettled_lp // ~-75
    );
    // let lp_delta_quote = perp_market
    //     .amm
    //     .calculate_lp_base_delta(per_lp_delta_quote, QUOTE_PRECISION_I128)
    //     .unwrap();
    // assert_eq!(lp_delta_quote, -19883754464333);

    let delta_base =
        update_lp_market_position(&mut perp_market, &pos_delta, fee_to_market, liq_split).unwrap();
    assert_eq!(
        perp_market.amm.user_lp_shares * 1000000 / perp_market.amm.sqrt_k,
        132561
    ); // 13.2 % of amm
    assert_eq!(
        perp_market.amm.quote_asset_amount_with_unsettled_lp,
        19884380
    ); // 19.884380/.132 ~= 150 (+ fee)
    assert_eq!(delta_base, -132_561_910); // ~13%
    assert_eq!(
        perp_market.amm.base_asset_amount_with_unsettled_lp,
        // 0
        -75381986319 // ~-75
    );

    // settle lp and quote with unsettled should go back to zero
    existing_position.lp_shares = perp_market.amm.user_lp_shares as u64;
    existing_position.per_lp_base = 3;

    let lp_metrics: crate::math::lp::LPMetrics =
        calculate_settle_lp_metrics(&perp_market.amm, &existing_position).unwrap();

    let position_delta = PositionDelta {
        base_asset_amount: lp_metrics.base_asset_amount as i64,
        quote_asset_amount: lp_metrics.quote_asset_amount as i64,
        remainder_base_asset_amount: Some(lp_metrics.remainder_base_asset_amount as i64),
    };

    assert_eq!(position_delta.base_asset_amount, 100000000);

    assert_eq!(
        position_delta.remainder_base_asset_amount.unwrap_or(0),
        32561910
    );

    assert_eq!(position_delta.quote_asset_amount, -19778585);

    let pnl = update_position_and_market(&mut existing_position, &mut perp_market, &position_delta)
        .unwrap();

    //.132561*1e6*.8 = 106048.8
    assert_eq!(perp_market.amm.quote_asset_amount_with_unsettled_lp, 105795); //?
    assert_eq!(
        perp_market.amm.base_asset_amount_with_unsettled_lp,
        expected_base_asset_amount_with_unsettled_lp - 32561910
    );

    assert_eq!(pnl, 0);
}

#[test]
fn amm_split_large_k_with_rebase() {
    let perp_market_str = String::from("Ct8MLGv1N/dvAH3EF67yBqaUQerctpm4yqpK+QNSrXCQz76p+B+ka+8Ni2/aLOukHaFdQJXR2jkqDS+O0MbHvA9M+sjCgLVtQwhkAQAAAAAAAAAAAAAAAAIAAAAAAAAAkI1kAQAAAAB6XWQBAAAAAO8yzWQAAAAAnJ7I3f///////////////2dHvwAAAAAAAAAAAAAAAABGiVjX6roAAAAAAAAAAAAAAAAAAAAAAAB1tO47J+xiAAAAAAAAAAAAGD03Fis3mgAAAAAAAAAAAJxiDwAAAAAAAAAAAAAAAABxqRCIGRxiAAAAAAAAAAAAEy8wZfK9YwAAAAAAAAAAAGZeZCE+g3sAAAAAAAAAAAAKYeQAAAAAAAAAAAAAAAAAlIvoyyc3mgAAAAAAAAAAAADQdQKjbgAAAAAAAAAAAAAAwu8g05H/////////////E6tNHAIAAAAAAAAAAAAAAO3mFwd0AAAAAAAAAAAAAAAAgPQg5rUAAAAAAAAAAAAAGkDtXR4AAAAAAAAAAAAAAEv0WeZW/f////////////9kUidaqAIAAAAAAAAAAAAA0ZMEr1H9/////////////w5/U3uqAgAAAAAAAAAAAAAANfbqfCd3AAAAAAAAAAAAIhABAAAAAAAiEAEAAAAAACIQAQAAAAAAY1QBAAAAAAA5f3WMVAAAAAAAAAAAAAAAFhkiihsAAAAAAAAAAAAAAO2EfWc5AAAAAAAAAAAAAACM/5CAQgAAAAAAAAAAAAAAvenX0SsAAAAAAAAAAAAAALgPUogZAAAAAAAAAAAAAAC01x97AAAAAAAAAAAAAAAAOXzVbgAAAAAAAAAAAAAAAMG4+QwBAAAAAAAAAAAAAABwHI3fLeJiAAAAAAAAAAAABvigOblGmgAAAAAAAAAAALeRnZsi9mIAAAAAAAAAAAAqgs3ynCeaAAAAAAAAAAAAQwhkAQAAAAAAAAAAAAAAAJOMZAEAAAAAFKJkAQAAAABTl2QBAAAAALFuZAEAAAAAgrx7DAAAAAAUAwAAAAAAAAN1TAYAAAAAuC7NZAAAAAAQDgAAAAAAAADh9QUAAAAAZAAAAAAAAAAA4fUFAAAAAAAAAAAAAAAAn2HvyMABAADGV6rZFwAAAE5Qg2oPAAAA8zHNZAAAAAAdYAAAAAAAAE2FAAAAAAAA6zLNZAAAAAD6AAAAaEIAABQDAAAUAwAAAAAAANcBAABkADIAZGQAAcDIUt4AAAAA0QQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAI9qQbynsAAAAAAAAAAAAAAAAAAAAAAAAFNPTC1QRVJQICAgICAgICAgICAgICAgICAgICAgICAghuS1//////8A4fUFAAAAAAB0O6QLAAAAR7PdeQMAAAD+Mc1kAAAAAADKmjsAAAAAAAAAAAAAAAAAAAAAAAAAAOULDwAAAAAAUBkAAAAAAADtAQAAAAAAAMgAAAAAAAAAECcAAKhhAADoAwAA9AEAAAAAAAAQJwAAZAIAAGQCAAAAAAEAAQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==");
    let mut decoded_bytes = base64::decode(perp_market_str).unwrap();
    let perp_market_bytes = decoded_bytes.as_mut_slice();

    let key = Pubkey::default();
    let owner = Pubkey::from_str("dRiftyHA39MWEi3m9aunc5MzRF1JYuBsbn6VPcn33UH").unwrap();
    let mut lamports = 0;
    let perp_market_account_info =
        create_account_info(&key, true, &mut lamports, perp_market_bytes, &owner);

    let perp_market_loader: AccountLoader<PerpMarket> =
        AccountLoader::try_from(&perp_market_account_info).unwrap();
    let mut perp_market = perp_market_loader.load_mut().unwrap();

    assert_eq!(perp_market.amm.base_asset_amount_per_lp, -574054756);
    assert_eq!(perp_market.amm.quote_asset_amount_per_lp, 12535655);
    assert_eq!(
        perp_market.amm.base_asset_amount_with_unsettled_lp,
        498335213293
    );

    let og_baawul = perp_market.amm.base_asset_amount_with_unsettled_lp;
    let og_baapl = perp_market.amm.base_asset_amount_per_lp;
    let og_qaapl = perp_market.amm.quote_asset_amount_per_lp;

    // update base
    let base_change = 5;
    apply_lp_rebase_to_perp_market(&mut perp_market, base_change).unwrap();

    // noop delta
    let delta = PositionDelta {
        base_asset_amount: 0,
        quote_asset_amount: 0,
        remainder_base_asset_amount: None,
    };

    update_lp_market_position(&mut perp_market, &delta, 0, AMMLiquiditySplit::Shared).unwrap();

    assert_eq!(perp_market.amm.quote_asset_amount_per_lp, og_qaapl * 100000);
    assert_eq!(perp_market.amm.base_asset_amount_per_lp, og_baapl * 100000);
    assert_eq!(
        perp_market.amm.base_asset_amount_with_unsettled_lp,
        og_baawul
    );

    // min long order for $2.3
    let delta = PositionDelta {
        base_asset_amount: BASE_PRECISION_I64 / 10,
        quote_asset_amount: -2300000,
        remainder_base_asset_amount: None,
    };

    let u1 =
        update_lp_market_position(&mut perp_market, &delta, 0, AMMLiquiditySplit::Shared).unwrap();
    assert_eq!(u1, 96471070);

    assert_eq!(
        perp_market.amm.base_asset_amount_with_unsettled_lp,
        498431684363
    );

    assert_eq!(
        perp_market.amm.base_asset_amount_per_lp - og_baapl * 100000,
        -287639
    );
    assert_eq!(
        perp_market.amm.quote_asset_amount_per_lp - og_qaapl * 100000,
        6615
    );
    assert_eq!(
        perp_market.amm.base_asset_amount_with_unsettled_lp - og_baawul,
        96471070
    );
    assert_eq!(perp_market.amm.base_asset_amount_per_lp, -57405475887639);
    assert_eq!(perp_market.amm.quote_asset_amount_per_lp, 1253565506615);

    let num = perp_market.amm.quote_asset_amount_per_lp - (og_qaapl * 100000);
    let denom = perp_market.amm.base_asset_amount_per_lp - (og_baapl * 100000);
    assert_eq!(-num * 1000000 / denom, 22997); // $22.997 cost basis for short (vs $23 actual)

    // min short order for $2.3
    let delta = PositionDelta {
        base_asset_amount: -BASE_PRECISION_I64 / 10,
        quote_asset_amount: 2300000,
        remainder_base_asset_amount: None,
    };

    update_lp_market_position(&mut perp_market, &delta, 0, AMMLiquiditySplit::Shared).unwrap();

    assert_eq!(perp_market.amm.base_asset_amount_per_lp, -57405475600000);
    assert_eq!(perp_market.amm.quote_asset_amount_per_lp, 1253565499999);
    assert_eq!(
        (og_qaapl * 100000) - perp_market.amm.quote_asset_amount_per_lp,
        1
    );

    let mut existing_position = PerpPosition {
        market_index: 0,
        base_asset_amount: 0,
        quote_asset_amount: 0,
        lp_shares: perp_market.amm.user_lp_shares as u64,
        last_base_asset_amount_per_lp: og_baapl as i64,
        last_quote_asset_amount_per_lp: og_qaapl as i64,
        per_lp_base: 0,
        ..PerpPosition::default()
    };

    settle_lp_position(&mut existing_position, &mut perp_market).unwrap();

    assert_eq!(existing_position.base_asset_amount, 0);
    assert_eq!(existing_position.remainder_base_asset_amount, 0);
    assert_eq!(existing_position.quote_asset_amount, -335); // out of favor rounding... :/

    assert_eq!(existing_position.per_lp_base, perp_market.amm.per_lp_base);

    assert_eq!(
        perp_market
            .amm
            .imbalanced_base_asset_amount_with_lp()
            .unwrap(),
        -303686915482213
    );

    assert_eq!(perp_market.amm.target_base_asset_amount_per_lp, -565000000);

    // update base back
    let base_change = -2;
    apply_lp_rebase_to_perp_market(&mut perp_market, base_change).unwrap();
    // noop delta
    let delta = PositionDelta {
        base_asset_amount: 0,
        quote_asset_amount: 0,
        remainder_base_asset_amount: None,
    };

    // unchanged with rebase (even when target!=0)
    assert_eq!(
        perp_market
            .amm
            .imbalanced_base_asset_amount_with_lp()
            .unwrap(),
        -303686915482213
    );

    update_lp_market_position(&mut perp_market, &delta, 0, AMMLiquiditySplit::Shared).unwrap();

    assert_eq!(
        perp_market.amm.quote_asset_amount_per_lp,
        og_qaapl * 1000 - 1
    ); // down only rounding
    assert_eq!(perp_market.amm.base_asset_amount_per_lp, og_baapl * 1000);

    // 1 long order for $23 before lp position does rebasing
    let delta = PositionDelta {
        base_asset_amount: BASE_PRECISION_I64,
        quote_asset_amount: -23000000,
        remainder_base_asset_amount: None,
    };
    assert_eq!(perp_market.amm.base_asset_amount_per_lp, -574054756000);

    update_lp_market_position(&mut perp_market, &delta, 0, AMMLiquiditySplit::Shared).unwrap();

    let now = 110;
    let clock_slot = 111;
    let state = State::default();
    let oracle_price_data = OraclePriceData {
        price: 23 * PRICE_PRECISION_I64,
        confidence: PRICE_PRECISION_U64 / 100,
        delay: 14,
        has_sufficient_number_of_data_points: true,
    };

    let cost = _update_amm(
        &mut perp_market,
        &oracle_price_data,
        &state,
        now,
        clock_slot,
    )
    .unwrap();
    assert_eq!(cost, -3017938);

    assert_eq!(perp_market.amm.quote_asset_amount_per_lp, 12535655660);
    assert_eq!(perp_market.amm.base_asset_amount_per_lp, -574054784763);
    assert_eq!(
        existing_position.last_base_asset_amount_per_lp,
        -57405475600000
    );
    assert_eq!(existing_position.per_lp_base, 5);
    assert_ne!(existing_position.per_lp_base, perp_market.amm.per_lp_base);

    assert_eq!(perp_market.amm.base_asset_amount_long, 121646400000000);
    assert_eq!(perp_market.amm.base_asset_amount_short, -121139000000000);
    assert_eq!(perp_market.amm.base_asset_amount_with_amm, 8100106185);
    assert_eq!(
        perp_market.amm.base_asset_amount_with_unsettled_lp,
        499299893815
    );
    let prev_with_unsettled_lp = perp_market.amm.base_asset_amount_with_unsettled_lp;
    settle_lp_position(&mut existing_position, &mut perp_market).unwrap();

    assert_eq!(perp_market.amm.base_asset_amount_long, 121646400000000);
    assert_eq!(perp_market.amm.base_asset_amount_short, -121139900000000);
    assert_eq!(perp_market.amm.base_asset_amount_with_amm, 8100106185);
    assert_eq!(
        perp_market.amm.base_asset_amount_with_unsettled_lp,
        498399893815
    );
    assert_eq!(
        perp_market.amm.base_asset_amount_with_unsettled_lp,
        498399893815
    );
    assert!(perp_market.amm.base_asset_amount_with_unsettled_lp < prev_with_unsettled_lp);

    // 96.47% owned
    assert_eq!(perp_market.amm.user_lp_shares, 33538939700000000);
    assert_eq!(perp_market.amm.sqrt_k, 34765725006847590);

    assert_eq!(existing_position.per_lp_base, perp_market.amm.per_lp_base);

    assert_eq!(existing_position.base_asset_amount, -900000000);
    assert_eq!(existing_position.remainder_base_asset_amount, -64680522);
    assert_eq!(existing_position.quote_asset_amount, 22168904); // out of favor rounding... :/
    assert_eq!(
        existing_position.last_base_asset_amount_per_lp,
        perp_market.amm.base_asset_amount_per_lp as i64
    ); // out of favor rounding... :/
    assert_eq!(
        existing_position.last_quote_asset_amount_per_lp,
        perp_market.amm.quote_asset_amount_per_lp as i64
    ); // out of favor rounding... :/
}

#[test]
fn full_lp_split() {
    let delta = PositionDelta {
        base_asset_amount: 10 * BASE_PRECISION_I64,
        quote_asset_amount: -10 * BASE_PRECISION_I64,
        remainder_base_asset_amount: None,
    };

    let amm = AMM {
        user_lp_shares: 100 * AMM_RESERVE_PRECISION,
        sqrt_k: 100 * AMM_RESERVE_PRECISION,
        base_asset_amount_with_amm: 10 * AMM_RESERVE_PRECISION_I128,
        ..AMM::default_test()
    };
    let mut market = PerpMarket {
        amm,
        ..PerpMarket::default_test()
    };

    update_lp_market_position(&mut market, &delta, 0, AMMLiquiditySplit::Shared).unwrap();

    assert_eq!(
        market.amm.base_asset_amount_per_lp as i64,
        -10 * BASE_PRECISION_I64 / 100
    );
    assert_eq!(
        market.amm.quote_asset_amount_per_lp as i64,
        10 * BASE_PRECISION_I64 / 100
    );
    assert_eq!(market.amm.base_asset_amount_with_amm, 0);
    assert_eq!(
        market.amm.base_asset_amount_with_unsettled_lp,
        10 * AMM_RESERVE_PRECISION_I128
    );
}

#[test]
fn half_half_amm_lp_split() {
    let delta = PositionDelta {
        base_asset_amount: 10 * BASE_PRECISION_I64,
        quote_asset_amount: -10 * BASE_PRECISION_I64,
        remainder_base_asset_amount: None,
    };

    let amm = AMM {
        user_lp_shares: 100 * AMM_RESERVE_PRECISION,
        sqrt_k: 200 * AMM_RESERVE_PRECISION,
        base_asset_amount_with_amm: 10 * AMM_RESERVE_PRECISION_I128,
        ..AMM::default_test()
    };
    let mut market = PerpMarket {
        amm,
        ..PerpMarket::default_test()
    };

    update_lp_market_position(&mut market, &delta, 0, AMMLiquiditySplit::Shared).unwrap();

    assert_eq!(
        market.amm.base_asset_amount_with_amm,
        5 * AMM_RESERVE_PRECISION_I128
    );
    assert_eq!(
        market.amm.base_asset_amount_with_unsettled_lp,
        5 * AMM_RESERVE_PRECISION_I128
    );
}

#[test]
fn test_position_entry_sim() {
    let mut existing_position: PerpPosition = PerpPosition::default();
    let position_delta = PositionDelta {
        base_asset_amount: BASE_PRECISION_I64 / 2,
        quote_asset_amount: -99_345_000 / 2,
        remainder_base_asset_amount: None,
    };
    let mut market = PerpMarket {
        amm: AMM {
            cumulative_funding_rate_long: 1,
            sqrt_k: 1,
            order_step_size: (BASE_PRECISION_I64 / 10) as u64,
            ..AMM::default()
        },
        number_of_users_with_base: 0,
        ..PerpMarket::default_test()
    };

    let pnl =
        update_position_and_market(&mut existing_position, &mut market, &position_delta).unwrap();

    assert_eq!(pnl, 0);
    assert_eq!(existing_position.get_entry_price().unwrap(), 99345000);

    let position_delta_to_reduce = PositionDelta {
        base_asset_amount: -BASE_PRECISION_I64 / 5,
        quote_asset_amount: 99_245_000 / 5,
        remainder_base_asset_amount: None,
    };

    let pnl = update_position_and_market(
        &mut existing_position,
        &mut market,
        &position_delta_to_reduce,
    )
    .unwrap();

    assert_eq!(pnl, -20000);
    assert_eq!(existing_position.base_asset_amount, 300000000);
    assert_eq!(existing_position.get_entry_price().unwrap(), 99345000);
    assert_eq!(existing_position.get_breakeven_price().unwrap(), 99345000);

    let position_delta_to_flip = PositionDelta {
        base_asset_amount: -BASE_PRECISION_I64,
        quote_asset_amount: 99_345_000,
        remainder_base_asset_amount: None,
    };

    let pnl =
        update_position_and_market(&mut existing_position, &mut market, &position_delta_to_flip)
            .unwrap();

    assert_eq!(pnl, 0);
    assert_eq!(existing_position.base_asset_amount, -700000000);
    assert_eq!(existing_position.get_entry_price().unwrap(), 99345000);
    assert_eq!(existing_position.get_breakeven_price().unwrap(), 99345000);
}

#[test]
fn increase_long_from_no_position() {
    let mut existing_position = PerpPosition::default();
    let position_delta = PositionDelta {
        base_asset_amount: 1,
        quote_asset_amount: -1,
        remainder_base_asset_amount: None,
    };
    let mut market = PerpMarket {
        amm: AMM {
            cumulative_funding_rate_long: 1,
            sqrt_k: 1,
            order_step_size: 1,
            ..AMM::default()
        },
        number_of_users_with_base: 0,
        ..PerpMarket::default_test()
    };

    let pnl =
        update_position_and_market(&mut existing_position, &mut market, &position_delta).unwrap();

    assert_eq!(existing_position.base_asset_amount, 1);
    assert_eq!(existing_position.quote_asset_amount, -1);
    assert_eq!(existing_position.quote_break_even_amount, -1);
    assert_eq!(existing_position.quote_entry_amount, -1);
    assert_eq!(pnl, 0);
    assert_eq!(existing_position.last_cumulative_funding_rate, 1);

    assert_eq!(market.number_of_users_with_base, 1);
    assert_eq!(market.amm.base_asset_amount_long, 1);
    assert_eq!(market.amm.base_asset_amount_short, 0);
    assert_eq!(market.amm.base_asset_amount_with_amm, 0);
    assert_eq!(market.amm.quote_asset_amount, -1);
    assert_eq!(market.amm.quote_entry_amount_long, -1);
    assert_eq!(market.amm.quote_entry_amount_short, 0);
    assert_eq!(market.amm.quote_break_even_amount_long, -1);
    assert_eq!(market.amm.quote_break_even_amount_short, 0);
}

#[test]
fn increase_short_from_no_position() {
    let mut existing_position = PerpPosition::default();
    let position_delta = PositionDelta {
        base_asset_amount: -1,
        quote_asset_amount: 1,
        remainder_base_asset_amount: None,
    };
    let mut market = PerpMarket {
        amm: AMM {
            cumulative_funding_rate_short: 1,
            ..AMM::default_test()
        },
        number_of_users_with_base: 0,
        ..PerpMarket::default_test()
    };

    let pnl =
        update_position_and_market(&mut existing_position, &mut market, &position_delta).unwrap();

    assert_eq!(existing_position.base_asset_amount, -1);
    assert_eq!(existing_position.quote_asset_amount, 1);
    assert_eq!(existing_position.quote_break_even_amount, 1);
    assert_eq!(existing_position.quote_entry_amount, 1);
    assert_eq!(pnl, 0);
    assert_eq!(existing_position.last_cumulative_funding_rate, 1);

    assert_eq!(market.number_of_users_with_base, 1);
    assert_eq!(market.amm.base_asset_amount_long, 0);
    assert_eq!(market.amm.base_asset_amount_short, -1);
    assert_eq!(market.amm.quote_asset_amount, 1);
    assert_eq!(market.amm.quote_entry_amount_long, 0);
    assert_eq!(market.amm.quote_entry_amount_short, 1);
    assert_eq!(market.amm.quote_break_even_amount_long, 0);
    assert_eq!(market.amm.quote_break_even_amount_short, 1);
}

#[test]
fn increase_long() {
    let mut existing_position = PerpPosition {
        base_asset_amount: 1,
        quote_asset_amount: -1,
        quote_break_even_amount: -2,
        quote_entry_amount: -1,
        last_cumulative_funding_rate: 1,
        ..PerpPosition::default()
    };
    let position_delta = PositionDelta {
        base_asset_amount: 1,
        quote_asset_amount: -1,
        remainder_base_asset_amount: None,
    };
    let mut market = PerpMarket {
        amm: AMM {
            base_asset_amount_with_amm: 1,
            base_asset_amount_long: 1,
            base_asset_amount_short: 0,
            quote_asset_amount: -1,
            quote_break_even_amount_long: -2,
            quote_entry_amount_long: -1,
            cumulative_funding_rate_long: 1,
            ..AMM::default_test()
        },
        number_of_users_with_base: 1,
        ..PerpMarket::default_test()
    };

    let pnl =
        update_position_and_market(&mut existing_position, &mut market, &position_delta).unwrap();

    assert_eq!(existing_position.base_asset_amount, 2);
    assert_eq!(existing_position.quote_asset_amount, -2);
    assert_eq!(existing_position.quote_break_even_amount, -3);
    assert_eq!(existing_position.quote_entry_amount, -2);
    assert_eq!(pnl, 0);
    assert_eq!(existing_position.last_cumulative_funding_rate, 1);

    assert_eq!(market.number_of_users_with_base, 1);
    assert_eq!(market.amm.base_asset_amount_long, 2);
    assert_eq!(market.amm.base_asset_amount_short, 0);
    assert_eq!(market.amm.quote_asset_amount, -2);
    assert_eq!(market.amm.quote_entry_amount_long, -2);
    assert_eq!(market.amm.quote_entry_amount_short, 0);
    assert_eq!(market.amm.quote_break_even_amount_long, -3);
    assert_eq!(market.amm.quote_break_even_amount_short, 0);

    assert_eq!(market.amm.base_asset_amount_with_amm, 1); // todo: update_position_and_market doesnt modify this properly?
}

#[test]
fn increase_short() {
    let mut existing_position = PerpPosition {
        base_asset_amount: -1,
        quote_asset_amount: 1,
        quote_break_even_amount: 2,
        quote_entry_amount: 1,
        last_cumulative_funding_rate: 1,
        ..PerpPosition::default()
    };
    let position_delta = PositionDelta {
        base_asset_amount: -1,
        quote_asset_amount: 1,
        remainder_base_asset_amount: None,
    };
    let mut market = PerpMarket {
        amm: AMM {
            base_asset_amount_short: -1,
            base_asset_amount_long: 0,
            quote_asset_amount: 1,
            quote_entry_amount_short: 1,
            quote_break_even_amount_short: 2,
            cumulative_funding_rate_short: 1,
            ..AMM::default_test()
        },
        number_of_users_with_base: 1,
        ..PerpMarket::default_test()
    };

    let pnl =
        update_position_and_market(&mut existing_position, &mut market, &position_delta).unwrap();

    assert_eq!(existing_position.base_asset_amount, -2);
    assert_eq!(existing_position.quote_asset_amount, 2);
    assert_eq!(existing_position.quote_entry_amount, 2);
    assert_eq!(existing_position.quote_break_even_amount, 3);
    assert_eq!(pnl, 0);
    assert_eq!(existing_position.last_cumulative_funding_rate, 1);

    assert_eq!(market.number_of_users_with_base, 1);
    assert_eq!(market.amm.base_asset_amount_long, 0);
    assert_eq!(market.amm.base_asset_amount_short, -2);
    assert_eq!(market.amm.quote_asset_amount, 2);
    assert_eq!(market.amm.quote_entry_amount_long, 0);
    assert_eq!(market.amm.quote_entry_amount_short, 2);
    assert_eq!(market.amm.quote_break_even_amount_long, 0);
    assert_eq!(market.amm.quote_break_even_amount_short, 3);
}

#[test]
fn reduce_long_profitable() {
    let mut existing_position = PerpPosition {
        base_asset_amount: 10,
        quote_asset_amount: -10,
        quote_entry_amount: -10,
        quote_break_even_amount: -12,
        last_cumulative_funding_rate: 1,
        ..PerpPosition::default()
    };
    let position_delta = PositionDelta {
        base_asset_amount: -1,
        quote_asset_amount: 5,
        remainder_base_asset_amount: None,
    };
    let mut market = PerpMarket {
        amm: AMM {
            base_asset_amount_with_amm: 10,
            base_asset_amount_long: 10,
            base_asset_amount_short: 0,
            quote_asset_amount: -10,
            quote_entry_amount_long: -10,
            quote_break_even_amount_long: -12,
            cumulative_funding_rate_long: 1,
            ..AMM::default_test()
        },
        number_of_users_with_base: 1,
        ..PerpMarket::default_test()
    };

    let pnl =
        update_position_and_market(&mut existing_position, &mut market, &position_delta).unwrap();

    assert_eq!(existing_position.base_asset_amount, 9);
    assert_eq!(existing_position.quote_asset_amount, -5);
    assert_eq!(existing_position.quote_entry_amount, -9);
    assert_eq!(existing_position.quote_break_even_amount, -11);
    assert_eq!(pnl, 4);
    assert_eq!(existing_position.last_cumulative_funding_rate, 1);

    assert_eq!(market.number_of_users_with_base, 1);
    assert_eq!(market.amm.base_asset_amount_long, 9);
    assert_eq!(market.amm.base_asset_amount_short, 0);
    // assert_eq!(market.amm.base_asset_amount_with_amm, 9);
    assert_eq!(market.amm.quote_asset_amount, -5);
    assert_eq!(market.amm.quote_entry_amount_long, -9);
    assert_eq!(market.amm.quote_entry_amount_short, 0);
    assert_eq!(market.amm.quote_break_even_amount_long, -11);
    assert_eq!(market.amm.quote_break_even_amount_short, 0);
}

#[test]
fn reduce_long_unprofitable() {
    let mut existing_position = PerpPosition {
        base_asset_amount: 10,
        quote_asset_amount: -100,
        quote_entry_amount: -100,
        quote_break_even_amount: -200,
        last_cumulative_funding_rate: 1,
        ..PerpPosition::default()
    };
    let position_delta = PositionDelta {
        base_asset_amount: -1,
        quote_asset_amount: 5,
        remainder_base_asset_amount: None,
    };
    let mut market = PerpMarket {
        amm: AMM {
            base_asset_amount_with_amm: 10,
            base_asset_amount_long: 10,
            base_asset_amount_short: 0,
            quote_asset_amount: -100,
            quote_entry_amount_long: -100,
            quote_break_even_amount_long: -200,
            cumulative_funding_rate_long: 1,
            ..AMM::default_test()
        },
        number_of_users_with_base: 1,
        ..PerpMarket::default_test()
    };

    let pnl =
        update_position_and_market(&mut existing_position, &mut market, &position_delta).unwrap();

    assert_eq!(existing_position.base_asset_amount, 9);
    assert_eq!(existing_position.quote_asset_amount, -95);
    assert_eq!(existing_position.quote_entry_amount, -90);
    assert_eq!(existing_position.quote_break_even_amount, -180);
    assert_eq!(pnl, -5);
    assert_eq!(existing_position.last_cumulative_funding_rate, 1);

    assert_eq!(market.number_of_users_with_base, 1);
    assert_eq!(market.amm.base_asset_amount_long, 9);
    assert_eq!(market.amm.base_asset_amount_short, 0);
    // assert_eq!(market.amm.base_asset_amount_with_amm, 9);
    assert_eq!(market.amm.quote_asset_amount, -95);
    assert_eq!(market.amm.quote_entry_amount_long, -90);
    assert_eq!(market.amm.quote_entry_amount_short, 0);
    assert_eq!(market.amm.quote_break_even_amount_long, -180);
    assert_eq!(market.amm.quote_break_even_amount_short, 0);
}

#[test]
fn flip_long_to_short_profitable() {
    let mut existing_position = PerpPosition {
        base_asset_amount: 10,
        quote_asset_amount: -10,
        quote_entry_amount: -10,
        quote_break_even_amount: -12,
        last_cumulative_funding_rate: 1,
        ..PerpPosition::default()
    };
    let position_delta = PositionDelta {
        base_asset_amount: -11,
        quote_asset_amount: 22,
        remainder_base_asset_amount: None,
    };
    let mut market = PerpMarket {
        amm: AMM {
            base_asset_amount_with_amm: 10,
            base_asset_amount_long: 10,
            base_asset_amount_short: 0,
            quote_asset_amount: -10,
            quote_break_even_amount_long: -12,
            quote_entry_amount_long: -10,
            cumulative_funding_rate_short: 2,
            cumulative_funding_rate_long: 1,
            ..AMM::default_test()
        },
        number_of_users_with_base: 1,
        ..PerpMarket::default_test()
    };

    let pnl =
        update_position_and_market(&mut existing_position, &mut market, &position_delta).unwrap();

    assert_eq!(existing_position.base_asset_amount, -1);
    assert_eq!(existing_position.quote_asset_amount, 12);
    assert_eq!(existing_position.quote_entry_amount, 2);
    assert_eq!(existing_position.quote_break_even_amount, 2);
    assert_eq!(pnl, 10);
    assert_eq!(existing_position.last_cumulative_funding_rate, 2);

    assert_eq!(market.number_of_users_with_base, 1);
    assert_eq!(market.amm.base_asset_amount_long, 0);
    assert_eq!(market.amm.base_asset_amount_short, -1);
    // assert_eq!(market.amm.base_asset_amount_with_amm, -1);
    assert_eq!(market.amm.quote_asset_amount, 12);
    assert_eq!(market.amm.quote_break_even_amount_long, 0);
    assert_eq!(market.amm.quote_break_even_amount_short, 2);
    assert_eq!(market.amm.quote_entry_amount_long, 0);
    assert_eq!(market.amm.quote_entry_amount_short, 2);
}

#[test]
fn flip_long_to_short_unprofitable() {
    let mut existing_position = PerpPosition {
        base_asset_amount: 10,
        quote_asset_amount: -10,
        quote_entry_amount: -10,
        quote_break_even_amount: -12,
        last_cumulative_funding_rate: 1,
        ..PerpPosition::default()
    };
    let position_delta = PositionDelta {
        base_asset_amount: -11,
        quote_asset_amount: 10,
        remainder_base_asset_amount: None,
    };
    let mut market = PerpMarket {
        amm: AMM {
            base_asset_amount_with_amm: 10,
            base_asset_amount_long: 10,
            base_asset_amount_short: 0,
            quote_asset_amount: -10,
            quote_break_even_amount_long: -12,
            quote_entry_amount_long: -10,
            cumulative_funding_rate_short: 2,
            cumulative_funding_rate_long: 1,
            order_step_size: 1,
            ..AMM::default()
        },
        number_of_users_with_base: 1,
        ..PerpMarket::default_test()
    };

    let pnl =
        update_position_and_market(&mut existing_position, &mut market, &position_delta).unwrap();

    assert_eq!(existing_position.base_asset_amount, -1);
    assert_eq!(existing_position.quote_asset_amount, 0);
    assert_eq!(existing_position.quote_break_even_amount, 1);
    assert_eq!(existing_position.quote_entry_amount, 1);
    assert_eq!(pnl, -1);
    assert_eq!(existing_position.last_cumulative_funding_rate, 2);

    assert_eq!(market.number_of_users_with_base, 1);
    assert_eq!(market.amm.base_asset_amount_long, 0);
    assert_eq!(market.amm.base_asset_amount_short, -1);
    // assert_eq!(market.amm.base_asset_amount_with_amm, -1);
    assert_eq!(market.amm.quote_asset_amount, 0);
    assert_eq!(market.amm.quote_break_even_amount_long, 0);
    assert_eq!(market.amm.quote_break_even_amount_short, 1);
    assert_eq!(market.amm.quote_entry_amount_long, 0);
    assert_eq!(market.amm.quote_entry_amount_short, 1);
}

#[test]
fn reduce_short_profitable() {
    let mut existing_position = PerpPosition {
        base_asset_amount: -10,
        quote_asset_amount: 100,
        quote_entry_amount: 100,
        quote_break_even_amount: 200,
        last_cumulative_funding_rate: 1,
        ..PerpPosition::default()
    };
    let position_delta = PositionDelta {
        base_asset_amount: 1,
        quote_asset_amount: -5,
        remainder_base_asset_amount: None,
    };
    let mut market = PerpMarket {
        amm: AMM {
            base_asset_amount_long: 0,
            base_asset_amount_short: -10,
            quote_asset_amount: 100,
            quote_entry_amount_short: 100,
            quote_break_even_amount_short: 200,
            cumulative_funding_rate_short: 1,
            ..AMM::default_test()
        },
        number_of_users_with_base: 1,
        ..PerpMarket::default_test()
    };

    let pnl =
        update_position_and_market(&mut existing_position, &mut market, &position_delta).unwrap();

    assert_eq!(existing_position.base_asset_amount, -9);
    assert_eq!(existing_position.quote_asset_amount, 95);
    assert_eq!(existing_position.quote_entry_amount, 90);
    assert_eq!(existing_position.quote_break_even_amount, 180);
    assert_eq!(pnl, 5);
    assert_eq!(existing_position.last_cumulative_funding_rate, 1);

    assert_eq!(market.number_of_users_with_base, 1);
    assert_eq!(market.amm.base_asset_amount_long, 0);
    assert_eq!(market.amm.base_asset_amount_short, -9);
    assert_eq!(market.amm.quote_asset_amount, 95);
    assert_eq!(market.amm.quote_entry_amount_long, 0);
    assert_eq!(market.amm.quote_entry_amount_short, 90);
    assert_eq!(market.amm.quote_break_even_amount_long, 0);
    assert_eq!(market.amm.quote_break_even_amount_short, 180);
}

#[test]
fn decrease_short_unprofitable() {
    let mut existing_position = PerpPosition {
        base_asset_amount: -10,
        quote_asset_amount: 100,
        quote_entry_amount: 100,
        quote_break_even_amount: 200,
        last_cumulative_funding_rate: 1,
        ..PerpPosition::default()
    };
    let position_delta = PositionDelta {
        base_asset_amount: 1,
        quote_asset_amount: -15,
        remainder_base_asset_amount: None,
    };
    let mut market = PerpMarket {
        amm: AMM {
            base_asset_amount_long: 0,
            base_asset_amount_short: -10,
            quote_asset_amount: 100,
            quote_entry_amount_short: 100,
            quote_break_even_amount_short: 200,
            cumulative_funding_rate_short: 1,
            ..AMM::default_test()
        },
        number_of_users_with_base: 1,
        ..PerpMarket::default_test()
    };

    let pnl =
        update_position_and_market(&mut existing_position, &mut market, &position_delta).unwrap();

    assert_eq!(existing_position.base_asset_amount, -9);
    assert_eq!(existing_position.quote_asset_amount, 85);
    assert_eq!(existing_position.quote_entry_amount, 90);
    assert_eq!(existing_position.quote_break_even_amount, 180);
    assert_eq!(pnl, -5);
    assert_eq!(existing_position.last_cumulative_funding_rate, 1);

    assert_eq!(market.number_of_users_with_base, 1);
    assert_eq!(market.amm.base_asset_amount_long, 0);
    assert_eq!(market.amm.base_asset_amount_short, -9);
    assert_eq!(market.amm.quote_asset_amount, 85);
    assert_eq!(market.amm.quote_entry_amount_long, 0);
    assert_eq!(market.amm.quote_entry_amount_short, 90);
    assert_eq!(market.amm.quote_break_even_amount_long, 0);
    assert_eq!(market.amm.quote_break_even_amount_short, 180);
}

#[test]
fn flip_short_to_long_profitable() {
    let mut existing_position = PerpPosition {
        base_asset_amount: -10,
        quote_asset_amount: 100,
        quote_entry_amount: 100,
        quote_break_even_amount: 200,
        last_cumulative_funding_rate: 1,
        ..PerpPosition::default()
    };
    let position_delta = PositionDelta {
        base_asset_amount: 11,
        quote_asset_amount: -60,
        remainder_base_asset_amount: None,
    };
    let mut market = PerpMarket {
        amm: AMM {
            base_asset_amount_with_amm: -10,
            base_asset_amount_long: 0,
            base_asset_amount_short: -10,
            quote_asset_amount: 100,
            quote_entry_amount_short: 100,
            quote_break_even_amount_short: 200,
            cumulative_funding_rate_long: 2,
            cumulative_funding_rate_short: 1,
            ..AMM::default_test()
        },
        number_of_users_with_base: 1,
        ..PerpMarket::default_test()
    };

    let pnl =
        update_position_and_market(&mut existing_position, &mut market, &position_delta).unwrap();

    assert_eq!(existing_position.base_asset_amount, 1);
    assert_eq!(existing_position.quote_asset_amount, 40);
    assert_eq!(existing_position.quote_break_even_amount, -6);
    assert_eq!(existing_position.quote_entry_amount, -6);
    assert_eq!(pnl, 46);
    assert_eq!(existing_position.last_cumulative_funding_rate, 2);

    assert_eq!(market.number_of_users_with_base, 1);
    assert_eq!(market.amm.base_asset_amount_long, 1);
    assert_eq!(market.amm.base_asset_amount_short, 0);
    // assert_eq!(market.amm.base_asset_amount_with_amm, 1);
    assert_eq!(market.amm.quote_asset_amount, 40);
    assert_eq!(market.amm.quote_entry_amount_long, -6);
    assert_eq!(market.amm.quote_entry_amount_short, 0);
    assert_eq!(market.amm.quote_break_even_amount_long, -6);
    assert_eq!(market.amm.quote_break_even_amount_short, 0);
}

#[test]
fn flip_short_to_long_unprofitable() {
    let mut existing_position = PerpPosition {
        base_asset_amount: -10,
        quote_asset_amount: 100,
        quote_break_even_amount: 200,
        quote_entry_amount: 100,
        last_cumulative_funding_rate: 1,
        ..PerpPosition::default()
    };
    let position_delta = PositionDelta {
        base_asset_amount: 11,
        quote_asset_amount: -120,
        remainder_base_asset_amount: None,
    };
    let mut market = PerpMarket {
        amm: AMM {
            base_asset_amount_with_amm: -10,
            base_asset_amount_long: 0,
            base_asset_amount_short: -10,
            quote_asset_amount: 100,
            quote_entry_amount_short: 100,
            quote_break_even_amount_short: 200,
            cumulative_funding_rate_long: 2,
            cumulative_funding_rate_short: 1,
            ..AMM::default_test()
        },
        number_of_users_with_base: 1,
        ..PerpMarket::default_test()
    };

    let pnl =
        update_position_and_market(&mut existing_position, &mut market, &position_delta).unwrap();

    assert_eq!(existing_position.base_asset_amount, 1);
    assert_eq!(existing_position.quote_asset_amount, -20);
    assert_eq!(existing_position.quote_entry_amount, -11);
    assert_eq!(existing_position.quote_break_even_amount, -11);
    assert_eq!(pnl, -9);
    assert_eq!(existing_position.last_cumulative_funding_rate, 2);

    assert_eq!(market.number_of_users_with_base, 1);
    assert_eq!(market.amm.base_asset_amount_long, 1);
    assert_eq!(market.amm.base_asset_amount_short, 0);
    // assert_eq!(market.amm.base_asset_amount_with_amm, 1);
    assert_eq!(market.amm.quote_asset_amount, -20);
    assert_eq!(market.amm.quote_entry_amount_long, -11);
    assert_eq!(market.amm.quote_entry_amount_short, 0);
    assert_eq!(market.amm.quote_break_even_amount_long, -11);
    assert_eq!(market.amm.quote_break_even_amount_short, 0);
}

#[test]
fn close_long_profitable() {
    let mut existing_position = PerpPosition {
        base_asset_amount: 10,
        quote_asset_amount: -10,
        quote_entry_amount: -10,
        quote_break_even_amount: -12,
        last_cumulative_funding_rate: 1,
        ..PerpPosition::default()
    };
    let position_delta = PositionDelta {
        base_asset_amount: -10,
        quote_asset_amount: 15,
        remainder_base_asset_amount: None,
    };
    let mut market = PerpMarket {
        amm: AMM {
            base_asset_amount_with_amm: 11,
            base_asset_amount_long: 11,
            quote_asset_amount: -11,
            quote_entry_amount_long: -11,
            quote_break_even_amount_long: -13,
            cumulative_funding_rate_long: 1,
            ..AMM::default_test()
        },
        number_of_users_with_base: 2,
        ..PerpMarket::default_test()
    };

    let pnl =
        update_position_and_market(&mut existing_position, &mut market, &position_delta).unwrap();

    assert_eq!(existing_position.base_asset_amount, 0);
    assert_eq!(existing_position.quote_asset_amount, 5);
    assert_eq!(existing_position.quote_entry_amount, 0);
    assert_eq!(existing_position.quote_break_even_amount, 0);
    assert_eq!(pnl, 5);
    assert_eq!(existing_position.last_cumulative_funding_rate, 0);

    assert_eq!(market.number_of_users_with_base, 1);
    assert_eq!(market.amm.base_asset_amount_long, 1);
    assert_eq!(market.amm.base_asset_amount_short, 0);
    // assert_eq!(market.amm.base_asset_amount_with_amm, 1);
    // not 5 because quote asset amount long was -11 not -10 before
    assert_eq!(market.amm.quote_asset_amount, 4);
    assert_eq!(market.amm.quote_entry_amount_long, -1);
    assert_eq!(market.amm.quote_entry_amount_short, 0);
    assert_eq!(market.amm.quote_break_even_amount_long, -1);
    assert_eq!(market.amm.quote_break_even_amount_short, 0);
}

#[test]
fn close_long_unprofitable() {
    let mut existing_position = PerpPosition {
        base_asset_amount: 10,
        quote_asset_amount: -10,
        quote_entry_amount: -10,
        quote_break_even_amount: -12,
        last_cumulative_funding_rate: 1,
        ..PerpPosition::default()
    };
    let position_delta = PositionDelta {
        base_asset_amount: -10,
        quote_asset_amount: 5,
        remainder_base_asset_amount: None,
    };
    let mut market = PerpMarket {
        amm: AMM {
            base_asset_amount_with_amm: 11,
            base_asset_amount_long: 11,
            quote_asset_amount: -11,
            quote_entry_amount_long: -11,
            quote_break_even_amount_long: -13,
            cumulative_funding_rate_long: 1,
            ..AMM::default_test()
        },
        number_of_users_with_base: 2,
        ..PerpMarket::default_test()
    };

    let pnl =
        update_position_and_market(&mut existing_position, &mut market, &position_delta).unwrap();

    assert_eq!(existing_position.base_asset_amount, 0);
    assert_eq!(existing_position.quote_asset_amount, -5);
    assert_eq!(existing_position.quote_entry_amount, 0);
    assert_eq!(existing_position.quote_break_even_amount, 0);
    assert_eq!(pnl, -5);
    assert_eq!(existing_position.last_cumulative_funding_rate, 0);

    assert_eq!(market.number_of_users_with_base, 1);
    assert_eq!(market.amm.base_asset_amount_long, 1);
    assert_eq!(market.amm.base_asset_amount_short, 0);
    // assert_eq!(market.amm.base_asset_amount_with_amm, 1);
    assert_eq!(market.amm.quote_asset_amount, -6);
    assert_eq!(market.amm.quote_entry_amount_long, -1);
    assert_eq!(market.amm.quote_entry_amount_short, 0);
    assert_eq!(market.amm.quote_break_even_amount_long, -1);
    assert_eq!(market.amm.quote_break_even_amount_short, 0);
}

#[test]
fn close_short_profitable() {
    let mut existing_position = PerpPosition {
        base_asset_amount: -10,
        quote_asset_amount: 10,
        quote_entry_amount: 10,
        quote_break_even_amount: 12,
        last_cumulative_funding_rate: 1,
        ..PerpPosition::default()
    };
    let position_delta = PositionDelta {
        base_asset_amount: 10,
        quote_asset_amount: -5,
        remainder_base_asset_amount: None,
    };
    let mut market = PerpMarket {
        amm: AMM {
            base_asset_amount_short: -11,
            quote_asset_amount: 11,
            quote_entry_amount_short: 11,
            quote_break_even_amount_short: 13,
            cumulative_funding_rate_short: 1,
            ..AMM::default_test()
        },
        number_of_users_with_base: 2,
        ..PerpMarket::default_test()
    };

    let pnl =
        update_position_and_market(&mut existing_position, &mut market, &position_delta).unwrap();

    assert_eq!(existing_position.base_asset_amount, 0);
    assert_eq!(existing_position.quote_asset_amount, 5);
    assert_eq!(existing_position.quote_break_even_amount, 0);
    assert_eq!(existing_position.quote_entry_amount, 0);
    assert_eq!(pnl, 5);
    assert_eq!(existing_position.last_cumulative_funding_rate, 0);

    assert_eq!(market.number_of_users_with_base, 1);
    assert_eq!(market.amm.base_asset_amount_long, 0);
    assert_eq!(market.amm.base_asset_amount_short, -1);
    assert_eq!(market.amm.quote_asset_amount, 6);
    assert_eq!(market.amm.quote_entry_amount_long, 0);
    assert_eq!(market.amm.quote_entry_amount_short, 1);
    assert_eq!(market.amm.quote_break_even_amount_long, 0);
    assert_eq!(market.amm.quote_break_even_amount_short, 1);
}

#[test]
fn close_short_unprofitable() {
    let mut existing_position = PerpPosition {
        base_asset_amount: -10,
        quote_asset_amount: 10,
        quote_entry_amount: 10,
        quote_break_even_amount: 12,
        last_cumulative_funding_rate: 1,
        ..PerpPosition::default()
    };
    let position_delta = PositionDelta {
        base_asset_amount: 10,
        quote_asset_amount: -15,
        remainder_base_asset_amount: None,
    };
    let mut market = PerpMarket {
        amm: AMM {
            base_asset_amount_short: -11,
            quote_asset_amount: 11,
            quote_entry_amount_short: 11,
            quote_break_even_amount_short: 13,
            cumulative_funding_rate_short: 1,
            ..AMM::default_test()
        },
        number_of_users_with_base: 2,
        ..PerpMarket::default_test()
    };

    let pnl =
        update_position_and_market(&mut existing_position, &mut market, &position_delta).unwrap();

    assert_eq!(existing_position.base_asset_amount, 0);
    assert_eq!(existing_position.quote_asset_amount, -5);
    assert_eq!(existing_position.quote_break_even_amount, 0);
    assert_eq!(existing_position.quote_entry_amount, 0);
    assert_eq!(pnl, -5);
    assert_eq!(existing_position.last_cumulative_funding_rate, 0);

    assert_eq!(market.number_of_users_with_base, 1);
    assert_eq!(market.amm.base_asset_amount_long, 0);
    assert_eq!(market.amm.base_asset_amount_short, -1);
    assert_eq!(market.amm.quote_asset_amount, -4);
    assert_eq!(market.amm.quote_entry_amount_long, 0);
    assert_eq!(market.amm.quote_entry_amount_short, 1);
    assert_eq!(market.amm.quote_break_even_amount_long, 0);
    assert_eq!(market.amm.quote_break_even_amount_short, 1);
}

#[test]
fn close_long_with_quote_break_even_amount_less_than_quote_asset_amount() {
    let mut existing_position = PerpPosition {
        base_asset_amount: 10,
        quote_asset_amount: -10,
        quote_entry_amount: -8,
        quote_break_even_amount: -9,
        last_cumulative_funding_rate: 1,
        ..PerpPosition::default()
    };
    let position_delta = PositionDelta {
        base_asset_amount: -10,
        quote_asset_amount: 5,
        remainder_base_asset_amount: None,
    };
    let mut market = PerpMarket {
        amm: AMM {
            base_asset_amount_with_amm: 11,
            base_asset_amount_long: 11,
            quote_asset_amount: -11,
            quote_entry_amount_long: -8,
            quote_break_even_amount_long: -9,
            cumulative_funding_rate_long: 1,
            order_step_size: 1,
            ..AMM::default()
        },
        number_of_users_with_base: 2,
        ..PerpMarket::default_test()
    };

    let pnl =
        update_position_and_market(&mut existing_position, &mut market, &position_delta).unwrap();

    assert_eq!(existing_position.base_asset_amount, 0);
    assert_eq!(existing_position.quote_asset_amount, -5);
    assert_eq!(existing_position.quote_entry_amount, 0);
    assert_eq!(existing_position.quote_break_even_amount, 0);
    assert_eq!(pnl, -3);
    assert_eq!(existing_position.last_cumulative_funding_rate, 0);

    assert_eq!(market.number_of_users_with_base, 1);
    assert_eq!(market.amm.base_asset_amount_long, 1);
    assert_eq!(market.amm.base_asset_amount_short, 0);
    // assert_eq!(market.amm.base_asset_amount_with_amm, 1);
    assert_eq!(market.amm.quote_asset_amount, -6);
    assert_eq!(market.amm.quote_entry_amount_long, 0);
    assert_eq!(market.amm.quote_entry_amount_short, 0);
    assert_eq!(market.amm.quote_break_even_amount_long, 0);
    assert_eq!(market.amm.quote_break_even_amount_short, 0);
}

#[test]
fn close_short_with_quote_break_even_amount_more_than_quote_asset_amount() {
    let mut existing_position = PerpPosition {
        base_asset_amount: -10,
        quote_asset_amount: 10,
        quote_entry_amount: 15,
        quote_break_even_amount: 17,
        last_cumulative_funding_rate: 1,
        ..PerpPosition::default()
    };
    let position_delta = PositionDelta {
        base_asset_amount: 10,
        quote_asset_amount: -15,
        remainder_base_asset_amount: None,
    };
    let mut market = PerpMarket {
        amm: AMM {
            base_asset_amount_short: -11,
            quote_asset_amount: 11,
            quote_entry_amount_short: 15,
            quote_break_even_amount_short: 17,
            cumulative_funding_rate_short: 1,
            order_step_size: 1,
            ..AMM::default()
        },
        number_of_users_with_base: 2,
        ..PerpMarket::default_test()
    };

    let pnl =
        update_position_and_market(&mut existing_position, &mut market, &position_delta).unwrap();

    assert_eq!(existing_position.base_asset_amount, 0);
    assert_eq!(existing_position.quote_asset_amount, -5);
    assert_eq!(existing_position.quote_entry_amount, 0);
    assert_eq!(existing_position.quote_break_even_amount, 0);
    assert_eq!(pnl, 0);
    assert_eq!(existing_position.last_cumulative_funding_rate, 0);

    assert_eq!(market.number_of_users_with_base, 1);
    assert_eq!(market.amm.base_asset_amount_long, 0);
    assert_eq!(market.amm.base_asset_amount_short, -1);
    assert_eq!(market.amm.quote_asset_amount, -4);
    assert_eq!(market.amm.quote_entry_amount_long, 0);
    assert_eq!(market.amm.quote_entry_amount_short, 0);
    assert_eq!(market.amm.quote_break_even_amount_long, 0);
    assert_eq!(market.amm.quote_break_even_amount_short, 0);
}

#[test]
fn update_amm_near_boundary() {
    let perp_market_str = String::from("Ct8MLGv1N/cU6tVVkVpIHdjrXil5+Blo7M7no01SEzFkvCN2nSnel3KwISF8o/5okioZqvmQEJy52E6a0AS00gJa1vUpMUQZeP7dAAAAAAAAAAAAAAAAAAMAAAAAAAAAvY3aAAAAAADqVt4AAAAAAGBMdGUAAAAA2sB2TbH//////////////8IsZGgAAAAAAAAAAAAAAACar9SsB0sAAAAAAAAAAAAAAAAAAAAAAACKMVL+upQLAAAAAAAAAAAAi2QWWATXCwAAAAAAAAAAACaTDwAAAAAAAAAAAAAAAAD1EOO7z20LAAAAAAAAAAAAosUC40DoCwAAAAAAAAAAABGeCsSwtQsAAAAAAAAAAABcHcMAAAAAAAAAAAAAAAAAY+zhwwTBCwAAAAAAAAAAAADgOhciiAAAAAAAAAAAAAAAhHmUDY7/////////////xTLPsKwVAAAAAAAAAAAAADsx5fqCAAAAAAAAAAAAAAAAQGNSv8YBAAAAAAAAAAAAG//kYQEAAAAAAAAAAAAAAFYkqoqx/v////////////92d53T2QAAAAAAAAAAAAAABdKhg6b+/////////////znMXLbsAAAAAAAAAAAAAAAAbnopLPMAAAAAAAAAAAAAcbUT//////9xtRP//////3G1E///////Csx3AAAAAABW1yLuOQAAAAAAAAAAAAAAixE0bjYAAAAAAAAAAAAAAPTMl48DAAAAAAAAAAAAAAADejoEDQAAAAAAAAAAAAAAwY+XFgAAAAAAAAAAAAAAAAPnvtIIAAAAAAAAAAAAAAAHWeRpAAAAAAAAAAAAAAAAB1nkaQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAADJLjHwBfAKAAAAAAAAAAAAdWrM5E+JDAAAAAAAAAAAAEIG1b42lQsAAAAAAAAAAAC3PYjYhdYLAAAAAAAAAAAA3LPdAAAAAAARR/7//////wx0yQAAAAAA2XDcAAAAAABy8tIAAAAAADXo1AAAAAAA96b/DQAAAAC1BQAAAAAAABIDNBQBAAAAMTx0ZQAAAAAQDgAAAAAAAADKmjsAAAAAZAAAAAAAAAAA8gUqAQAAAAAAAAAAAAAALSoG3VsBAABfrBuoCgAAAM4eyjoEAAAA9Ut0ZQAAAAB9RwAAAAAAAB8mAwAAAAAAYEx0ZQAAAACUEQAAoIYBAKi3AQBHAQAAAAAAAAAAAABkADIAZMgEAQAAAAAEAAAADWpTAQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAZUL9UG/wAAAAAAAAAAAAAAAAAAAAAAADFNQk9OSy1QRVJQICAgICAgICAgICAgICAgICAgICAgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAoNAgAAAAAA5xkAAAAAAACMAgAAAAAAACYCAADuAgAA+CQBAPgkAQDECQAA3AUAAAAAAAAQJwAA+QEAAPwCAAAEAAIAAwAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==");
    let mut decoded_bytes = base64::decode(perp_market_str).unwrap();
    let perp_market_bytes = decoded_bytes.as_mut_slice();

    let key = Pubkey::from_str("2QeqpeJUVo2LBWNELRfcBwJgrNoxJQSd7gokcaM5nvaa").unwrap();
    let owner = Pubkey::from_str("dRiftyHA39MWEi3m9aunc5MzRF1JYuBsbn6VPcn33UH").unwrap();
    let mut lamports = 0;
    let perp_market_account_info =
        create_account_info(&key, true, &mut lamports, perp_market_bytes, &owner);

    let perp_market_loader: AccountLoader<PerpMarket> =
        AccountLoader::try_from(&perp_market_account_info).unwrap();

    let oracle_market_str = String::from("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AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA");
    let mut decoded_bytes = base64::decode(oracle_market_str).unwrap();
    let oracle_market_bytes = decoded_bytes.as_mut_slice();

    let key = Pubkey::from_str("8ihFLu5FimgTQ1Unh4dVyEHUGodJ5gJQCrQf4KUVB9bN").unwrap();
    let owner = Pubkey::from_str("FsJ3A3u2vn5cTVofAjvy6y5kwABJAqYWpe4975bi2epH").unwrap();
    let mut lamports = 0;
    let jto_market_account_info =
        create_account_info(&key, true, &mut lamports, oracle_market_bytes, &owner);

    let slot = 234897842;
    let now = 1702120657;
    let mut oracle_map: OracleMap<'_> =
        OracleMap::load_one(&jto_market_account_info, slot, None).unwrap();

    let mut perp_market = perp_market_loader.load_mut().unwrap();

    println!("perp_market: {:?}", perp_market.amm.last_update_slot);

    let oracle_price_data = oracle_map.get_price_data(&key).unwrap();

    let state = State::default();

    let cost = _update_amm(&mut perp_market, oracle_price_data, &state, now, slot).unwrap();

    assert_eq!(cost, 18803837952);
}

#[test]
fn update_amm_near_boundary2() {
    let perp_market_str = String::from("Ct8MLGv1N/cU6tVVkVpIHdjrXil5+Blo7M7no01SEzFkvCN2nSnel3KwISF8o/5okioZqvmQEJy52E6a0AS00gJa1vUpMUQZIAjcAAAAAAAAAAAAAAAAAAEAAAAAAAAAuUnaAAAAAADDXNsAAAAAAP5xdGUAAAAAa4BQirD//////////////6fVQmsAAAAAAAAAAAAAAACar9SsB0sAAAAAAAAAAAAAAAAAAAAAAABBXO7/SWwLAAAAAAAAAAAAa0vYrBqvCwAAAAAAAAAAACaTDwAAAAAAAAAAAAAAAACHRTA1zkYLAAAAAAAAAAAAEkQuep2/CwAAAAAAAAAAAFAYOQmCjQsAAAAAAAAAAAC9r80AAAAAAAAAAAAAAAAANYB5EXeYCwAAAAAAAAAAAADqjJbciAAAAAAAAAAAAAAANiZLB47/////////////rEGjW00WAAAAAAAAAAAAAFTeD4aWAAAAAAAAAAAAAAAAQGNSv8YBAAAAAAAAAAAAUt/uyv7//////////////802zJqt/v/////////////PSTYa2wAAAAAAAAAAAAAAtPcalqL+/////////////xvHbwvuAAAAAAAAAAAAAAAAdsrWtPEAAAAAAAAAAAAAcbUT//////9xtRP//////3G1E///////Csx3AAAAAACVwjw2OgAAAAAAAAAAAAAAd/FNszYAAAAAAAAAAAAAALHQnZIDAAAAAAAAAAAAAAAA8z1QCQAAAAAAAAAAAAAAwY+XFgAAAAAAAAAAAAAAAEFTL9MIAAAAAAAAAAAAAAAHWeRpAAAAAAAAAAAAAAAAB1nkaQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAADQlAeGCeEKAAAAAAAAAAAAME8Wz6hEDAAAAAAAAAAAABctSD9BbwsAAAAAAAAAAAA8T/PdEqwLAAAAAAAAAAAAMMvbAAAAAADpTP///////6NCywAAAAAA0yfeAAAAAAA7tdQAAAAAAJ3u2wAAAAAAwI8ADgAAAABrBAAAAAAAAA98N2D9////MTx0ZQAAAAAQDgAAAAAAAADKmjsAAAAAZAAAAAAAAAAA8gUqAQAAAAAAAAAAAAAA/9iJIUQBAAB7ga9oBQAAAADrzocBAAAAxXF0ZQAAAACI1QcAAAAAAHeBAQAAAAAA/nF0ZQAAAACUEQAAoIYBALV+AQDrBwAAAAAAAAAAAABkADIAZMgEAQAAAAAEAAAACvtTAQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAZUL9UG/wAAAAAAAAAAAAAAAAAAAAAAADFNQk9OSy1QRVJQICAgICAgICAgICAgICAgICAgICAgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAHQNAgAAAAAA5xkAAAAAAACMAgAAAAAAACYCAADuAgAA+CQBAPgkAQDECQAA3AUAAAAAAAAQJwAAAgIAABwDAAAEAAIAAwAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==");
    let mut decoded_bytes = base64::decode(perp_market_str).unwrap();
    let perp_market_bytes = decoded_bytes.as_mut_slice();

    let key = Pubkey::from_str("2QeqpeJUVo2LBWNELRfcBwJgrNoxJQSd7gokcaM5nvaa").unwrap();
    let owner = Pubkey::from_str("dRiftyHA39MWEi3m9aunc5MzRF1JYuBsbn6VPcn33UH").unwrap();
    let mut lamports = 0;
    let perp_market_account_info =
        create_account_info(&key, true, &mut lamports, perp_market_bytes, &owner);
    let market_map = PerpMarketMap::load_one(&perp_market_account_info, true).unwrap();

    let oracle_market_str = String::from("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AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA");
    let mut decoded_bytes = base64::decode(oracle_market_str).unwrap();
    let oracle_market_bytes = decoded_bytes.as_mut_slice();

    let key = Pubkey::from_str("8ihFLu5FimgTQ1Unh4dVyEHUGodJ5gJQCrQf4KUVB9bN").unwrap();
    let owner = Pubkey::from_str("FsJ3A3u2vn5cTVofAjvy6y5kwABJAqYWpe4975bi2epH").unwrap();
    let mut lamports = 0;
    let jto_market_account_info =
        create_account_info(&key, true, &mut lamports, oracle_market_bytes, &owner);

    let slot = 234919073;
    let now = 1702120657;
    let mut oracle_map = OracleMap::load_one(&jto_market_account_info, slot, None).unwrap();

    // let perp_market_old = market_map.get_ref(&4).unwrap();

    let mut perp_market = market_map.get_ref_mut(&4).unwrap();

    println!("perp_market: {:?}", perp_market.amm.last_update_slot);

    let oracle_price_data = oracle_map.get_price_data(&key).unwrap();

    let state = State::default();

    let cost: i128 = _update_amm(&mut perp_market, oracle_price_data, &state, now, slot).unwrap();
    assert!(perp_market.amm.last_oracle_valid);
    assert_eq!(cost, 2987010);
}

#[test]
fn recenter_amm_1() {
    let perp_market_str: String = String::from("Ct8MLGv1N/cU6tVVkVpIHdjrXil5+Blo7M7no01SEzFkvCN2nSnel3KwISF8o/5okioZqvmQEJy52E6a0AS00gJa1vUpMUQZIAjcAAAAAAAAAAAAAAAAAAEAAAAAAAAAuUnaAAAAAADDXNsAAAAAAP5xdGUAAAAAa4BQirD//////////////6fVQmsAAAAAAAAAAAAAAACar9SsB0sAAAAAAAAAAAAAAAAAAAAAAABBXO7/SWwLAAAAAAAAAAAAa0vYrBqvCwAAAAAAAAAAACaTDwAAAAAAAAAAAAAAAACHRTA1zkYLAAAAAAAAAAAAEkQuep2/CwAAAAAAAAAAAFAYOQmCjQsAAAAAAAAAAAC9r80AAAAAAAAAAAAAAAAANYB5EXeYCwAAAAAAAAAAAADqjJbciAAAAAAAAAAAAAAANiZLB47/////////////rEGjW00WAAAAAAAAAAAAAFTeD4aWAAAAAAAAAAAAAAAAQGNSv8YBAAAAAAAAAAAAUt/uyv7//////////////802zJqt/v/////////////PSTYa2wAAAAAAAAAAAAAAtPcalqL+/////////////xvHbwvuAAAAAAAAAAAAAAAAdsrWtPEAAAAAAAAAAAAAcbUT//////9xtRP//////3G1E///////Csx3AAAAAACVwjw2OgAAAAAAAAAAAAAAd/FNszYAAAAAAAAAAAAAALHQnZIDAAAAAAAAAAAAAAAA8z1QCQAAAAAAAAAAAAAAwY+XFgAAAAAAAAAAAAAAAEFTL9MIAAAAAAAAAAAAAAAHWeRpAAAAAAAAAAAAAAAAB1nkaQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAADQlAeGCeEKAAAAAAAAAAAAME8Wz6hEDAAAAAAAAAAAABctSD9BbwsAAAAAAAAAAAA8T/PdEqwLAAAAAAAAAAAAMMvbAAAAAADpTP///////6NCywAAAAAA0yfeAAAAAAA7tdQAAAAAAJ3u2wAAAAAAwI8ADgAAAABrBAAAAAAAAA98N2D9////MTx0ZQAAAAAQDgAAAAAAAADKmjsAAAAAZAAAAAAAAAAA8gUqAQAAAAAAAAAAAAAA/9iJIUQBAAB7ga9oBQAAAADrzocBAAAAxXF0ZQAAAACI1QcAAAAAAHeBAQAAAAAA/nF0ZQAAAACUEQAAoIYBALV+AQDrBwAAAAAAAAAAAABkADIAZMgEAQAAAAAEAAAACvtTAQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAZUL9UG/wAAAAAAAAAAAAAAAAAAAAAAADFNQk9OSy1QRVJQICAgICAgICAgICAgICAgICAgICAgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAHQNAgAAAAAA5xkAAAAAAACMAgAAAAAAACYCAADuAgAA+CQBAPgkAQDECQAA3AUAAAAAAAAQJwAAAgIAABwDAAAEAAIAAwAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==");
    let mut decoded_bytes = base64::decode(perp_market_str).unwrap();
    let perp_market_bytes = decoded_bytes.as_mut_slice();

    let key = Pubkey::from_str("2QeqpeJUVo2LBWNELRfcBwJgrNoxJQSd7gokcaM5nvaa").unwrap();
    let owner = Pubkey::from_str("dRiftyHA39MWEi3m9aunc5MzRF1JYuBsbn6VPcn33UH").unwrap();
    let mut lamports = 0;
    let perp_market_account_info =
        create_account_info(&key, true, &mut lamports, perp_market_bytes, &owner);
    let market_map = PerpMarketMap::load_one(&perp_market_account_info, true).unwrap();

    let oracle_market_str = String::from("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AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA");
    let mut decoded_bytes = base64::decode(oracle_market_str).unwrap();
    let oracle_market_bytes = decoded_bytes.as_mut_slice();

    let key = Pubkey::from_str("8ihFLu5FimgTQ1Unh4dVyEHUGodJ5gJQCrQf4KUVB9bN").unwrap();
    let owner = Pubkey::from_str("FsJ3A3u2vn5cTVofAjvy6y5kwABJAqYWpe4975bi2epH").unwrap();
    let mut lamports = 0;
    let jto_market_account_info =
        create_account_info(&key, true, &mut lamports, oracle_market_bytes, &owner);

    let slot = 234919073;
    let now = 1702120657;
    let mut oracle_map = OracleMap::load_one(&jto_market_account_info, slot, None).unwrap();

    // let perp_market_old = market_map.get_ref(&4).unwrap();

    let mut perp_market = market_map.get_ref_mut(&4).unwrap();

    println!("perp_market: {:?}", perp_market.amm.last_update_slot);

    let oracle_price_data = oracle_map.get_price_data(&key).unwrap();

    let state = State::default();

    let cost = _update_amm(&mut perp_market, oracle_price_data, &state, now, slot).unwrap();

    assert_eq!(cost, 2987010);

    let inv = perp_market.amm.base_asset_amount_with_amm;
    assert_eq!(inv, 24521505718700);

    let (_, _, r1_orig, r2_orig) = calculate_base_swap_output_with_spread(
        &perp_market.amm,
        inv.unsigned_abs() as u64,
        swap_direction_to_close_position(inv),
    )
    .unwrap();

    assert_eq!(r1_orig, 334837204625);
    assert_eq!(r2_orig, 703359043);

    let current_k = perp_market.amm.sqrt_k;
    let _current_peg = perp_market.amm.peg_multiplier;

    let new_k = (current_k * 900000) / 100;
    recenter_perp_market_amm(&mut perp_market, oracle_price_data.price as u128, new_k).unwrap();

    assert_eq!(perp_market.amm.sqrt_k, new_k);
    assert_eq!(
        perp_market.amm.peg_multiplier,
        oracle_price_data.price as u128
    );

    let (_r1, _r2) = swap_base_asset(
        &mut perp_market,
        inv.unsigned_abs() as u64,
        swap_direction_to_close_position(inv),
    )
    .unwrap();

    // assert_eq!(r1, r1_orig); // 354919762322 w/o k adj
    // assert_eq!(r2, r2_orig as i64);

    // assert_eq!(perp_market.amm.peg_multiplier, current_peg);
}

#[test]
fn recenter_amm_2() {
    // sui example
    let perp_market_str: String = String::from("Ct8MLGv1N/d29jnnLxPJWcgnELd2ICWqe/HjfUfvrt/0yq7vt4ipySPXMVET9bHTunqDYExEuU159P1pr3f4BPx/kgptxldEbY8QAAAAAAAAAAAAAAAAAAMAAAAAAAAABb8QAAAAAADCjBAAAAAAANnvrmUAAAAAA/UzhKT1/////////////+zWKQkDAAAAAAAAAAAAAADXxsbXggQAAAAAAAAAAAAAAAAAAAAAAAAm1aGXXBcBAAAAAAAAAAAA0bqOq60ZeX0DAAAAAAAAADxrEgAAAAAAAAAAAAAAAABWUcGPbucAAAAAAAAAAAAAixe+mDdRAQAAAAAAAAAAAAHgQW8bmvMBAAAAAAAAAAAFAAAAAAAAAAAAAAAAAAAAObJUKUBReX0DAAAAAAAAAAB82Wd71QAAAAAAAAAAAAAAvJautCf/////////////zNCf7v///////////////zRn0Ccw/f////////////8AAI1J/RoHAAAAAAAAAAAA2TrFMQwAAAAAAAAAAAAAAIasEJrH//////////////8CQy3yOAAAAAAAAAAAAAAA/Bzf4Mb//////////////9dAQLc5AAAAAAAAAAAAAAAA4EFvG5rzAQAAAAAAAAAA0Qb////////RBv///////9EG////////JaIAAAAAAADuHq3oAQAAAAAAAAAAAAAAZZBlmf///////////////2Y79WMCAAAAAAAAAAAAAACW6DzZ+f//////////////Ut/+OAEAAAAAAAAAAAAAAB0oBjUBAAAAAAAAAAAAAACR6S4LAAAAAAAAAAAAAAAAAOAtCwAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAACn0WwwyBIBAAAAAAAAAAAAmOidoYFAXYwDAAAAAAAAAFSG6vGvFwEAAAAAAAAAAACRR6oTndNufAMAAAAAAAAAbosQAAAAAAAGdf///////1+cEAAAAAAARMEQAAAAAADRrhAAAAAAAH5MEAAAAAAA6EqDDgAAAADQAwAAAAAAAI007gAAAAAAQeauZQAAAAAQDgAAAAAAAADKmjsAAAAAZAAAAAAAAAAAypo7AAAAAAAAAAAAAAAAjPDu4DcAAAAXm1qdAAAAALcGYAwDAAAAiu6uZQAAAACqcwAAAAAAAJczAAAAAAAA2e+uZQAAAACIEwAAPHMAAOKBAAAYCQAAAAAAAKEHAABkADIAZMgAAQAAAAAEAAAATu+XBAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAC3/spZrMwAAAAAAAAAAAAAAAAAAAAAAAFNVSS1QRVJQICAgICAgICAgICAgICAgICAgICAgICAgAOH1BQAAAAAA4fUFAAAAAADKmjsAAAAAiF7MCQAAAACH6a5lAAAAAADC6wsAAAAAAAAAAAAAAAAAAAAAAAAAAI0SAQAAAAAAbRgAAAAAAADDBgAAAAAAAMIBAADCAQAAECcAACBOAADoAwAA9AEAAAAAAAAQJwAAIAEAANEBAAAJAAEAAgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==");
    let mut decoded_bytes = base64::decode(perp_market_str).unwrap();
    let perp_market_bytes = decoded_bytes.as_mut_slice();

    let key = Pubkey::from_str("91NsaUmTNNdLGbYtwmoiYSn9SgWHCsZiChfMYMYZ2nQx").unwrap();
    let owner = Pubkey::from_str("dRiftyHA39MWEi3m9aunc5MzRF1JYuBsbn6VPcn33UH").unwrap();
    let mut lamports = 0;
    let perp_market_account_info =
        create_account_info(&key, true, &mut lamports, perp_market_bytes, &owner);
    let market_map = PerpMarketMap::load_one(&perp_market_account_info, true).unwrap();

    // let oracle_market_str = String::from("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AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA");
    // let mut decoded_bytes = base64::decode(oracle_market_str).unwrap();
    // let oracle_market_bytes = decoded_bytes.as_mut_slice();

    let mut oracle_price = get_hardcoded_pyth_price(1_120_000, 6);
    let oracle_price_key =
        Pubkey::from_str("3Qub3HaAJaa2xNY7SUqPKd3vVwTqDfDDkEUMPjXD2c1q").unwrap();
    let pyth_program = crate::ids::pyth_program::id();
    let mut data = get_account_bytes(&mut oracle_price);
    let mut lamports2 = 0;

    let oracle_account_info = create_account_info(
        &oracle_price_key,
        true,
        &mut lamports2,
        &mut data[..],
        &pyth_program,
    );

    //https://explorer.solana.com/block/243485436
    let slot = 243485436;
    let now = 1705963488;
    let mut oracle_map = OracleMap::load_one(&oracle_account_info, slot, None).unwrap();

    // let perp_market_old = market_map.get_ref(&4).unwrap();

    let mut perp_market = market_map.get_ref_mut(&9).unwrap();

    println!(
        "perp_market latest slot: {:?}",
        perp_market.amm.last_update_slot
    );

    // previous values
    assert_eq!(perp_market.amm.peg_multiplier, 5);
    assert_eq!(perp_market.amm.quote_asset_reserve, 64381518181749930705);
    assert_eq!(perp_market.amm.base_asset_reserve, 307161425106214);

    let oracle_price_data = oracle_map.get_price_data(&oracle_price_key).unwrap();

    let state = State::default();

    let cost = _update_amm(&mut perp_market, oracle_price_data, &state, now, slot).unwrap();

    assert_eq!(cost, 0);

    let inv = perp_market.amm.base_asset_amount_with_amm;
    assert_eq!(inv, -291516212);

    let (_, _, r1_orig, r2_orig) = calculate_base_swap_output_with_spread(
        &perp_market.amm,
        inv.unsigned_abs() as u64,
        swap_direction_to_close_position(inv),
    )
    .unwrap();

    assert_eq!(r1_orig, 326219);
    assert_eq!(r2_orig, 20707);

    let current_k = perp_market.amm.sqrt_k;
    let _current_peg = perp_market.amm.peg_multiplier;
    let new_k = current_k * 2;

    // refusal to decrease further
    assert_eq!(current_k, current_k);
    assert_eq!(perp_market.amm.user_lp_shares, current_k - 1);
    assert_eq!(perp_market.amm.get_lower_bound_sqrt_k().unwrap(), current_k);

    recenter_perp_market_amm(&mut perp_market, oracle_price_data.price as u128, new_k).unwrap();

    assert_eq!(perp_market.amm.sqrt_k, new_k);
    assert_eq!(
        perp_market.amm.peg_multiplier,
        oracle_price_data.price as u128
    );
    assert_eq!(perp_market.amm.peg_multiplier, 1_120_000);
    // assert_eq!(perp_market.amm.quote_asset_reserve, 140625455708483789 * 2);
    // assert_eq!(perp_market.amm.base_asset_reserve, 140625456291516213 * 2);
    assert_eq!(perp_market.amm.base_asset_reserve, 281250912291516214);
    assert_eq!(perp_market.amm.quote_asset_reserve, 281250911708483790);

    crate::validation::perp_market::validate_perp_market(&perp_market).unwrap();

    let (r1, r2) = swap_base_asset(
        &mut perp_market,
        inv.unsigned_abs() as u64,
        swap_direction_to_close_position(inv),
    )
    .unwrap();

    // adjusted slightly
    assert_eq!(r1, 348628); // 354919762322 w/o k adj
    assert_eq!(r2, 22129);

    let new_scale = 2;
    let new_sqrt_k = perp_market.amm.sqrt_k * new_scale;
    let update_k_result = get_update_k_result(&perp_market, U192::from(new_sqrt_k), false).unwrap();
    let adjustment_cost = adjust_k_cost(&mut perp_market, &update_k_result).unwrap();
    assert_eq!(adjustment_cost, 0);

    update_k(&mut perp_market, &update_k_result).unwrap();

    // higher lower bound now
    assert_eq!(perp_market.amm.sqrt_k, new_sqrt_k);
    assert_eq!(perp_market.amm.user_lp_shares, current_k - 1);
    assert!(perp_market.amm.get_lower_bound_sqrt_k().unwrap() > current_k);
    assert_eq!(
        perp_market.amm.get_lower_bound_sqrt_k().unwrap(),
        140766081456000000
    );
    // assert_eq!(perp_market.amm.peg_multiplier, current_peg);
}

#[test]
fn test_move_amm() {
    // sui example
    let perp_market_str: String = String::from("Ct8MLGv1N/d29jnnLxPJWcgnELd2ICWqe/HjfUfvrt/0yq7vt4ipySPXMVET9bHTunqDYExEuU159P1pr3f4BPx/kgptxldEbY8QAAAAAAAAAAAAAAAAAAMAAAAAAAAABb8QAAAAAADCjBAAAAAAANnvrmUAAAAAA/UzhKT1/////////////+zWKQkDAAAAAAAAAAAAAADXxsbXggQAAAAAAAAAAAAAAAAAAAAAAAAm1aGXXBcBAAAAAAAAAAAA0bqOq60ZeX0DAAAAAAAAADxrEgAAAAAAAAAAAAAAAABWUcGPbucAAAAAAAAAAAAAixe+mDdRAQAAAAAAAAAAAAHgQW8bmvMBAAAAAAAAAAAFAAAAAAAAAAAAAAAAAAAAObJUKUBReX0DAAAAAAAAAAB82Wd71QAAAAAAAAAAAAAAvJautCf/////////////zNCf7v///////////////zRn0Ccw/f////////////8AAI1J/RoHAAAAAAAAAAAA2TrFMQwAAAAAAAAAAAAAAIasEJrH//////////////8CQy3yOAAAAAAAAAAAAAAA/Bzf4Mb//////////////9dAQLc5AAAAAAAAAAAAAAAA4EFvG5rzAQAAAAAAAAAA0Qb////////RBv///////9EG////////JaIAAAAAAADuHq3oAQAAAAAAAAAAAAAAZZBlmf///////////////2Y79WMCAAAAAAAAAAAAAACW6DzZ+f//////////////Ut/+OAEAAAAAAAAAAAAAAB0oBjUBAAAAAAAAAAAAAACR6S4LAAAAAAAAAAAAAAAAAOAtCwAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAACn0WwwyBIBAAAAAAAAAAAAmOidoYFAXYwDAAAAAAAAAFSG6vGvFwEAAAAAAAAAAACRR6oTndNufAMAAAAAAAAAbosQAAAAAAAGdf///////1+cEAAAAAAARMEQAAAAAADRrhAAAAAAAH5MEAAAAAAA6EqDDgAAAADQAwAAAAAAAI007gAAAAAAQeauZQAAAAAQDgAAAAAAAADKmjsAAAAAZAAAAAAAAAAAypo7AAAAAAAAAAAAAAAAjPDu4DcAAAAXm1qdAAAAALcGYAwDAAAAiu6uZQAAAACqcwAAAAAAAJczAAAAAAAA2e+uZQAAAACIEwAAPHMAAOKBAAAYCQAAAAAAAKEHAABkADIAZMgAAQAAAAAEAAAATu+XBAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAC3/spZrMwAAAAAAAAAAAAAAAAAAAAAAAFNVSS1QRVJQICAgICAgICAgICAgICAgICAgICAgICAgAOH1BQAAAAAA4fUFAAAAAADKmjsAAAAAiF7MCQAAAACH6a5lAAAAAADC6wsAAAAAAAAAAAAAAAAAAAAAAAAAAI0SAQAAAAAAbRgAAAAAAADDBgAAAAAAAMIBAADCAQAAECcAACBOAADoAwAA9AEAAAAAAAAQJwAAIAEAANEBAAAJAAEAAgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==");
    let mut decoded_bytes = base64::decode(perp_market_str).unwrap();
    let perp_market_bytes = decoded_bytes.as_mut_slice();

    let key = Pubkey::from_str("91NsaUmTNNdLGbYtwmoiYSn9SgWHCsZiChfMYMYZ2nQx").unwrap();
    let owner = Pubkey::from_str("dRiftyHA39MWEi3m9aunc5MzRF1JYuBsbn6VPcn33UH").unwrap();
    let mut lamports = 0;
    let perp_market_account_info =
        create_account_info(&key, true, &mut lamports, perp_market_bytes, &owner);
    let market_map = PerpMarketMap::load_one(&perp_market_account_info, true).unwrap();

    // let oracle_market_str = String::from("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AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA");
    // let mut decoded_bytes = base64::decode(oracle_market_str).unwrap();
    // let oracle_market_bytes = decoded_bytes.as_mut_slice();

    let mut oracle_price = get_hardcoded_pyth_price(1_120_000, 6);
    let oracle_price_key =
        Pubkey::from_str("3Qub3HaAJaa2xNY7SUqPKd3vVwTqDfDDkEUMPjXD2c1q").unwrap();
    let pyth_program = crate::ids::pyth_program::id();
    let mut data = get_account_bytes(&mut oracle_price);
    let mut lamports2 = 0;

    let oracle_account_info = create_account_info(
        &oracle_price_key,
        true,
        &mut lamports2,
        &mut data[..],
        &pyth_program,
    );

    //https://explorer.solana.com/block/243485436
    let slot = 243485436;
    let now = 1705963488;
    let mut oracle_map = OracleMap::load_one(&oracle_account_info, slot, None).unwrap();

    // let perp_market_old = market_map.get_ref(&4).unwrap();

    let mut perp_market = market_map.get_ref_mut(&9).unwrap();

    println!(
        "perp_market latest slot: {:?}",
        perp_market.amm.last_update_slot
    );

    // previous values
    assert_eq!(perp_market.amm.peg_multiplier, 5);
    assert_eq!(perp_market.amm.quote_asset_reserve, 64381518181749930705);
    assert_eq!(perp_market.amm.base_asset_reserve, 307161425106214);

    let oracle_price_data = oracle_map.get_price_data(&oracle_price_key).unwrap();

    let state = State::default();

    let cost = _update_amm(&mut perp_market, oracle_price_data, &state, now, slot).unwrap();

    assert_eq!(cost, 0);

    let inv = perp_market.amm.base_asset_amount_with_amm;
    assert_eq!(inv, -291516212);

    let (_, _, r1_orig, r2_orig) = calculate_base_swap_output_with_spread(
        &perp_market.amm,
        inv.unsigned_abs() as u64,
        swap_direction_to_close_position(inv),
    )
    .unwrap();

    assert_eq!(r1_orig, 326219);
    assert_eq!(r2_orig, 20707);
    let current_bar = perp_market.amm.base_asset_reserve;
    let _current_qar = perp_market.amm.quote_asset_reserve;
    let current_k = perp_market.amm.sqrt_k;
    let inc_numerator = BASE_PRECISION + BASE_PRECISION / 100;
    let new_k = current_k * inc_numerator / BASE_PRECISION;

    // test correction
    move_price(
        &mut perp_market,
        current_bar * inc_numerator / BASE_PRECISION,
        // current_qar * inc_numerator / BASE_PRECISION,
        65025333363567459347, // pass in exact amount that reconciles
        new_k,
    )
    .unwrap();
    crate::validation::perp_market::validate_perp_market(&perp_market).unwrap();
    assert_eq!(perp_market.amm.sqrt_k, new_k);
    assert_eq!(perp_market.amm.peg_multiplier, 5); // still same
}
