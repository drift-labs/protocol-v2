use crate::controller::amm::{
    calculate_base_swap_output_with_spread, move_price, recenter_perp_market_amm, swap_base_asset,
};
use crate::controller::position::{update_position_and_market, PositionDelta};
use crate::controller::repeg::_update_amm;

use crate::math::amm::calculate_market_open_bids_asks;
use crate::math::constants::{
    AMM_RESERVE_PRECISION, AMM_RESERVE_PRECISION_I128, BASE_PRECISION, BASE_PRECISION_I64,
    PRICE_PRECISION_I64, PRICE_PRECISION_U64, QUOTE_PRECISION_I128,
    SPOT_CUMULATIVE_INTEREST_PRECISION, SPOT_WEIGHT_PRECISION,
};
use crate::math::oracle::OracleValidity;
use crate::math::position::swap_direction_to_close_position;
use crate::math::repeg;
use crate::state::oracle::{MMOraclePriceData, OraclePriceData, PrelaunchOracle};
use crate::state::oracle_map::OracleMap;
use crate::state::perp_market::{PerpMarket, AMM};
use crate::state::perp_market_map::PerpMarketMap;
use crate::state::state::State;
use crate::state::user::PerpPosition;
use crate::test_utils::{create_account_info, get_account_bytes};

use crate::bn::U192;
use crate::controller::amm::update_pool_balances;
use crate::create_anchor_account_info;
use crate::math::cp_curve::{adjust_k_cost, get_update_k_result, update_k};
use crate::math::safe_math::SafeMath;
use crate::math::spot_balance::get_token_amount;
use crate::state::oracle::{HistoricalOracleData, OracleSource};
use crate::state::spot_market::SpotBalance;
use crate::state::spot_market::SpotMarket;
use crate::state::spot_market_map::SpotMarketMap;
use crate::state::user::SpotPosition;
use crate::test_utils::get_anchor_account_bytes;
use crate::test_utils::get_hardcoded_pyth_price;
use crate::QUOTE_PRECISION_I64;
use anchor_lang::prelude::{AccountLoader, Clock};
use anchor_lang::Owner;
use solana_program::pubkey::Pubkey;
use std::str::FromStr;

#[test]
fn amm_pool_balance_liq_fees_example() {
    let perp_market_str = String::from("Ct8MLGv1N/dquEe6RHLCjPXRFs689/VXwfnq/aHEADtX6J/C8GaZXDKZ6iACt2rxmu8p8Fh+gR3ERNNiw5jAdKhvts0jU4yP8/YGAAAAAAAAAAAAAAAAAAEAAAAAAAAAYOoGAAAAAAD08AYAAAAAAFDQ0WcAAAAAU20cou///////////////zqG0jcAAAAAAAAAAAAAAACyy62lmssEAAAAAAAAAAAAAAAAAAAAAACuEBLjOOAUAAAAAAAAAAAAiQqZJDPTFAAAAAAAAAAAANiFEAAAAAAAAAAAAAAAAABEI0dQmUcTAAAAAAAAAAAAxIkaBDObFgAAAAAAAAAAAD4fkf+02RQAAAAAAAAAAABN+wYAAAAAAAAAAAAAAAAAy1BRbfXSFAAAAAAAAAAAAADOOHkhTQcAAAAAAAAAAAAAFBriILP4////////////SMyW3j0AAAAAAAAAAAAAALgVvHwEAAAAAAAAAAAAAAAAADQm9WscAAAAAAAAAAAAURkvFjoAAAAAAAAAAAAAAHIxjo/f/f/////////////TuoG31QEAAAAAAAAAAAAAP8QC+7L9/////////////3SO4oj1AQAAAAAAAAAAAAAAgFcGo5wAAAAAAAAAAAAAzxUAAAAAAADPFQAAAAAAAM8VAAAAAAAAPQwAAAAAAABk1DIXBgEAAAAAAAAAAAAAKqQCt7MAAAAAAAAAAAAAAP0Q55dSAAAAAAAAAAAAAACS+qA0KQEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAALB5hg2UAAAAAAAAAAAAAAAnMANRAAAAAAAAAAAAAAAAmdj/UAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAB+LAqY3t8UAAAAAAAAAAAAhk/TOI3TFAAAAAAAAAAAAG1uRreN4BQAAAAAAAAAAABkKKeG3tIUAAAAAAAAAAAA8/YGAAAAAAD+/////////2DqBgAAAAAA5OoGAAAAAACi6gYAAAAAAKzxBgAAAAAAMj1zEwAAAABIAgAAAAAAAIy24v//////tMvRZwAAAAAQDgAAAAAAAADKmjsAAAAAZAAAAAAAAAAA8gUqAQAAAAAAAAAAAAAAs3+BskEAAADIfXYRAAAAAIIeqQIAAAAAdb7RZwAAAABxDAAAAAAAAJMMAAAAAAAAUNDRZwAAAAD6AAAA1DAAAIQAAAB9AAAAfgAAAAAAAABkADIAZGQMAQAAAAADAAAAX79DBQAAAABIC9oEAwAAAK3TwZwAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAFdJRi1QRVJQICAgICAgICAgICAgICAgICAgICAgICAgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAADd4BgAAAAAAlCUAAAAAAAAcCgAAAAAAAGQAAABkAAAAqGEAAFDDAADECQAA4gQAAAAAAAAQJwAA2QAAAIgBAAAXAAEAAwAAAAAAAAEBAOgD9AEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==");
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
    let clock_slot = 326319440;
    let clock = Clock {
        unix_timestamp: now,
        slot: clock_slot,
        ..Clock::default()
    };

    let mut state = State::default();

    let mut prelaunch_oracle_price = PrelaunchOracle {
        price: PRICE_PRECISION_I64,
        confidence: 455_389,
        ..PrelaunchOracle::default()
    };

    let prelaunch_oracle_price_key: Pubkey =
        Pubkey::from_str("4QXWStoyEErTZFVsvKrvxuNa6QT8zpeA8jddZunSGvYE").unwrap();
    create_anchor_account_info!(
        prelaunch_oracle_price,
        &prelaunch_oracle_price_key,
        PrelaunchOracle,
        oracle_account_info
    );
    let mut oracle_map = OracleMap::load_one(&oracle_account_info, clock_slot, None).unwrap();

    let mut spot_market = SpotMarket {
        cumulative_deposit_interest: 11425141382,
        cumulative_borrow_interest: 12908327537,
        decimals: 6,
        ..SpotMarket::default()
    };
    spot_market.deposit_balance = 10_u128.pow(19_u32);
    spot_market.deposit_token_twap = 10_u64.pow(16_u32);

    let spot_position = SpotPosition::default();

    {
        let mut perp_market = perp_market_loader.load_mut().unwrap();
        // assert_eq!(perp_market.amm.oracle, Pubkey::default());

        assert_eq!(perp_market.pnl_pool.scaled_balance, 0);
        assert_eq!(perp_market.amm.fee_pool.scaled_balance, 1349764971875250);
        let fee_before = perp_market.amm.fee_pool.scaled_balance;

        assert_eq!(perp_market.amm.total_fee_minus_distributions, 1276488252050);

        let new_total_fee_minus_distributions =
            crate::controller::amm::calculate_perp_market_amm_summary_stats(
                &perp_market,
                &spot_market,
                prelaunch_oracle_price.price,
                true,
            )
            .unwrap();
        let fee_difference = new_total_fee_minus_distributions
            .safe_sub(perp_market.amm.total_fee_minus_distributions)
            .unwrap();
        perp_market.amm.total_fee = perp_market.amm.total_fee.saturating_add(fee_difference);
        perp_market.amm.total_mm_fee = perp_market.amm.total_mm_fee.saturating_add(fee_difference);
        perp_market.amm.total_fee_minus_distributions = new_total_fee_minus_distributions;

        assert_eq!(new_total_fee_minus_distributions, 640881949608);

        let unsettled_pnl = -10_000_000;
        let to_settle_with_user = update_pool_balances(
            &mut perp_market,
            &mut spot_market,
            &spot_position,
            unsettled_pnl,
            now,
        )
        .unwrap();
        assert_eq!(to_settle_with_user, unsettled_pnl);
        // assert_eq!(perp_market.pnl_pool.scaled_balance, 8665100_648_642_458); // post change
        // assert_eq!(perp_market.amm.fee_pool.scaled_balance, 1349764971875250);

        let pnl_pool_token_amount = get_token_amount(
            perp_market.pnl_pool.balance(),
            &spot_market,
            perp_market.pnl_pool.balance_type(),
        )
        .unwrap();
        assert_eq!(pnl_pool_token_amount, 265371537413); // 200k

        let fee_pool_token_amount = get_token_amount(
            perp_market.amm.fee_pool.balance(),
            &spot_market,
            perp_market.amm.fee_pool.balance_type(),
        )
        .unwrap();
        assert_eq!(fee_pool_token_amount, 1276764026200); // 1.27M

        // assert_eq!(perp_market.amm.fee_pool.scaled_balance, fee_before + 1000000000); // pre change
        assert!(perp_market.amm.fee_pool.scaled_balance < fee_before); // post change
    }
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

    let mut prelaunch_oracle_price = PrelaunchOracle {
        price: PRICE_PRECISION_I64,
        confidence: 1655389,
        ..PrelaunchOracle::default()
    };

    let prelaunch_oracle_price_key: Pubkey =
        Pubkey::from_str("3TVuLmEGBRfVgrmFRtYTheczXaaoRBwcHw1yibZHSeNA").unwrap();
    create_anchor_account_info!(
        prelaunch_oracle_price,
        &prelaunch_oracle_price_key,
        PrelaunchOracle,
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
    let market_index;

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
        let perp_market = perp_market_loader.load_mut().unwrap();
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

    let mut prelaunch_oracle_price = PrelaunchOracle {
        price: PRICE_PRECISION_I64,
        confidence: 1655389,
        ..PrelaunchOracle::default()
    };

    let prelaunch_oracle_price_key: Pubkey =
        Pubkey::from_str("3TVuLmEGBRfVgrmFRtYTheczXaaoRBwcHw1yibZHSeNA").unwrap();
    create_anchor_account_info!(
        prelaunch_oracle_price,
        &prelaunch_oracle_price_key,
        PrelaunchOracle,
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
    let market_index;

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
        let perp_market = perp_market_loader.load_mut().unwrap();
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

    let mut prelaunch_oracle_price = PrelaunchOracle {
        price: PRICE_PRECISION_I64,
        confidence: 1655389,
        ..PrelaunchOracle::default()
    };

    let prelaunch_oracle_price_key: Pubkey =
        Pubkey::from_str("3TVuLmEGBRfVgrmFRtYTheczXaaoRBwcHw1yibZHSeNA").unwrap();
    create_anchor_account_info!(
        prelaunch_oracle_price,
        &prelaunch_oracle_price_key,
        PrelaunchOracle,
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
    let market_index;

    {
        let perp_market = perp_market_loader.load_mut().unwrap();
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
        sequence_id: None,
    };
    let mm_oracle_price_data = perp_market
        .get_mm_oracle_price_data(
            oracle_price_data,
            clock_slot,
            &state.oracle_guard_rails.validity,
        )
        .unwrap();

    let (max_bids, max_asks) = calculate_market_open_bids_asks(&perp_market.amm).unwrap();
    perp_market.amm.curve_update_intensity = 99;

    assert_eq!(max_bids, 3_824_624_394_874); // 3824 shares
    assert_eq!(max_asks, -5_241_195_799_744); // -5000 shares

    assert_eq!(perp_market.amm.sqrt_k, 56_649_660_613_272);

    let (optimal_peg, fee_budget, _check_lower_bound) =
        repeg::calculate_optimal_peg_and_budget(&perp_market, &mm_oracle_price_data).unwrap();

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
        &mm_oracle_price_data,
        &state,
        now,
        clock_slot,
    )
    .unwrap();

    assert_eq!(cost, 6333935);
}

#[test]
fn amm_ref_price_decay_tail_test() {
    let perp_market_str = String::from("Ct8MLGv1N/cYzqS2/5Aqu+5dnPum3Mz7oNSk0pG7qV9BgKAzNA1g8nc/ec1eDI5cjucZIdA9e2tj/SgqABSJFUY3KifRpWXvgRY3AAAAAAAAAAAAAAAAAAAAAAAAAAAA+yI3AAAAAADgJzcAAAAAAHplfmgAAAAAi9Ixko3//////////////0fUBWIAAAAAAAAAAAAAAAAi/zfzqpgAAAAAAAAAAAAAAAAAAAAAAAAc9ScOaLQnAAAAAAAAAAAAbHFuuWqMKAAAAAAAAAAAACaTDwAAAAAAAAAAAAAAAACfXfRpjOwmAAAAAAAAAAAAHqAXzo2NKAAAAAAAAAAAANYlJAjYHygAAAAAAAAAAAAJ8TUAAAAAAAAAAAAAAAAASuGKZ8aFKAAAAAAAAAAAAABwLtd8SAEAAAAAAAAAAAAAXAfmA77+////////////26vRAIIGAAAAAAAAAAAAACUgZLz+//////////////8AAMFv8oYjAAAAAAAAAAAAbA0S9BcAAAAAAAAAAAAAAM879U39/v/////////////2Mm7qzwAAAAAAAAAAAAAA5jPQVPz+/////////////7/NuobVAAAAAAAAAAAAAAAA7Ahc1eIAAAAAAAAAAAAA3PEAAAAAAADc8QAAAAAAANzxAAAAAAAAsP0AAAAAAABuSl53NgAAAAAAAAAAAAAA77CPlhMAAAAAAAAAAAAAAGEv3BsjAAAAAAAAAAAAAABRjl7zNwAAAAAAAAAAAAAA5v6m4RIAAAAAAAAAAAAAAKhxy78MAAAAAAAAAAAAAADNROsgAAAAAAAAAAAAAAAAzUTrIAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD+1LD+3HwnAAAAAAAAAAAADp8TwHPFKAAAAAAAAAAAACWcir2K8DQAAAAAAAAAAAAR1RILUGkeAAAAAAAAAAAAgRY3AAAAAAAAAAAAAAAAAM0TNwAAAAAA0Co3AAAAAABOHzcAAAAAAHjoNgAAAAAA7OolFQAAAAD5AAAAAAAAAD11ywAAAAAAR2R+aAAAAAAQDgAAAAAAAADKmjsAAAAAZAAAAAAAAAAA8gUqAQAAAAAAAAAAAAAAqpIRz9oBAACl/xIeCQAAAIh9U7UTAAAAHWV+aAAAAADelgAAAAAAAHkXAAAAAAAAemV+aAAAAADIAAAAECcAAGnFAwDEmgMAAAAAAAkFAAD0ATIAyGQMAQAAAAAEALUAVeKYAgAAAAAxkAyD//////mtMUYAAAAAVWX8/wAAAAAAAAAAAAAAABO5llSEvAAAAAAAAAAAAAAAAAAAAAAAAFhSUC1QRVJQICAgICAgICAgICAgICAgICAgICAgICAgAAAAAAAAAAAAwusLAAAAAADyBSoBAAAAv3vMKQAAAAC3Xn5oAAAAAABlzR0AAAAAAAAAAAAAAAAAAAAAAAAAACjqAQAAAAAAaUQAAAAAAADsBgAAAAAAAPoAAAAAAAAAECcAACBOAADoAwAAigIAAAAAAAAQJwAAUwEAAEABAAANAAEAAgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==");
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

    let reserve_price = perp_market.amm.reserve_price().unwrap();
    let (b1, a1) = perp_market.amm.bid_ask_price(reserve_price).unwrap();
    assert_eq!(reserve_price, 3610239);
    assert_eq!(b1, 1904650);
    assert_eq!(a1, 3649742);
    assert_eq!(
        perp_market.amm.historical_oracle_data.last_oracle_price,
        3610241
    );
    assert_eq!(perp_market.amm.reference_price_offset, -236203);
    assert_eq!(perp_market.amm.last_update_slot, 354806508);

    perp_market.amm.curve_update_intensity = 200;

    let max_ref_offset = perp_market.amm.get_max_reference_price_offset().unwrap();
    assert_eq!(max_ref_offset, 10000);

    let liquidity_ratio = crate::math::amm_spread::calculate_inventory_liquidity_ratio(
        perp_market.amm.base_asset_amount_with_amm,
        perp_market.amm.base_asset_reserve,
        perp_market.amm.max_base_asset_reserve,
        perp_market.amm.min_base_asset_reserve,
    )
    .unwrap();

    let signed_liquidity_ratio = liquidity_ratio
        .checked_mul(
            (perp_market
                .amm
                .get_protocol_owned_position()
                .unwrap()
                .signum() as i128),
        )
        .unwrap();

    let res = crate::math::amm_spread::calculate_reference_price_offset(
        reserve_price,
        perp_market.amm.last_24h_avg_funding_rate,
        signed_liquidity_ratio,
        perp_market.amm.min_order_size,
        perp_market
            .amm
            .historical_oracle_data
            .last_oracle_price_twap_5min,
        perp_market.amm.last_mark_price_twap_5min,
        perp_market
            .amm
            .historical_oracle_data
            .last_oracle_price_twap,
        perp_market.amm.last_mark_price_twap,
        max_ref_offset,
    )
    .unwrap();
    assert_eq!(res, 0);

    let mut now = perp_market.amm.last_mark_price_twap_ts + 1;
    let mut clock_slot = 354806508 + 1; // todo
    let state = State::default();
    let oracle_price_data = OraclePriceData {
        price: 3610241,
        confidence: PRICE_PRECISION_U64 / 100000,
        delay: 1,
        has_sufficient_number_of_data_points: true,
        sequence_id: None,
    };
    let mm_oracle_price_data = perp_market
        .get_mm_oracle_price_data(
            oracle_price_data,
            clock_slot,
            &state.oracle_guard_rails.validity,
        )
        .unwrap();
    let cost = _update_amm(
        &mut perp_market,
        &mm_oracle_price_data,
        &state,
        now,
        clock_slot,
    )
    .unwrap();
    assert_eq!(perp_market.amm.last_update_slot, clock_slot);
    assert_eq!(perp_market.amm.last_oracle_valid, true);
    assert_eq!(perp_market.amm.reference_price_offset, -236093);

    // Run  decay steps
    let mut offsets = Vec::new();
    let mut lspreads = Vec::new();
    let mut sspreads = Vec::new();

    for i in 0..60 {
        // advance time for next iteration

        // some multiple cranks same slot
        if i < 6 || i > 9 {
            now += 250;
            clock_slot += 700;
        }
        let mm_oracle_price_data = perp_market
            .get_mm_oracle_price_data(
                oracle_price_data,
                clock_slot,
                &state.oracle_guard_rails.validity,
            )
            .unwrap();

        let cost = _update_amm(
            &mut perp_market,
            &mm_oracle_price_data,
            &state,
            now,
            clock_slot,
        )
        .unwrap();
        assert_eq!(perp_market.amm.last_update_slot, clock_slot);
        assert_eq!(perp_market.amm.last_oracle_valid, true);

        // capture the new offset
        offsets.push(perp_market.amm.reference_price_offset);
        lspreads.push(perp_market.amm.long_spread);
        sspreads.push(perp_market.amm.short_spread);
    }

    assert_eq!(
        offsets,
        [
            -212475, -191219, -172089, -154872, -139376, -125430, -125410, -125390, -125370,
            -125350, -112806, -101517, -91357, -82213, -73983, -66576, -59910, -53910, -48510,
            -43650, -39276, -35340, -31797, -28609, -25740, -23157, -20833, -18741, -16858, -15164,
            -13639, -12267, -11032, -9920, -8919, -8019, -7209, -6480, -5823, -5232, -4700, -4221,
            -3790, -3402, -3053, -2739, -2457, -2203, -1974, -1768, -1583, -1416, -1266, -1131,
            -1009, -900, -801, -712, -632, -560
        ]
    );
    assert_eq!(
        lspreads,
        [
            212587, 191331, 172201, 154984, 139488, 125542, 125522, 125502, 125482, 125462, 112918,
            101629, 91469, 82325, 74095, 66688, 60022, 54022, 48622, 43762, 39388, 35452, 31909,
            28721, 25852, 23269, 20945, 18853, 16970, 15276, 13751, 12379, 11144, 10032, 9031,
            8131, 7321, 6592, 5935, 5344, 4812, 4333, 3902, 3514, 3165, 2851, 2569, 2315, 2086,
            1880, 1695, 1528, 1378, 1243, 1121, 1012, 913, 824, 744, 672
        ]
    );
    assert_eq!(
        sspreads,
        [
            23633, 21271, 19145, 17232, 15511, 13961, 35, 35, 35, 35, 12559, 11304, 10175, 9159,
            8245, 7422, 6681, 6015, 5415, 4875, 4389, 3951, 3558, 3203, 2884, 2598, 2339, 2107,
            1898, 1709, 1540, 1387, 1250, 1127, 1016, 915, 825, 744, 672, 606, 547, 494, 446, 403,
            364, 329, 297, 269, 244, 221, 200, 182, 165, 150, 137, 124, 114, 104, 95, 87
        ]
    );

    // perp_market.amm.curve_update_intensity = 0;

    // Run  decay steps
    // let mut offsets = Vec::new();
    // let mut lspreads = Vec::new();
    // let mut sspreads = Vec::new();
}

#[test]
fn amm_ref_price_offset_decay_logic() {
    // sample btc market
    let perp_market_str = String::from("Ct8MLGv1N/cV6vWLwJY+18dY2GsrmrNldgnISB7pmbcf7cn9S4FZ4B7U/fA1on6uX4cAPWh+6q5kflQbDzfTC/LJrf1AdS22jhnK8BsAAAAAAAAAAAAAAAEAAAAAAAAA46fs5xsAAADJQ2HmGwAAANhndWgAAAAA0MlT6v///////////////yF75IAAAAAAAAAAAAAAAADHCg8Gw/4GAAAAAAAAAAAAAAAAAAAAAADpl1aFUVEAAAAAAAAAAAAAd5bGp2BRAAAAAAAAAAAAAHxFDwAAAAAAAAAAAAAAAADYi6VkR1EAAAAAAAAAAAAAjzRN3WlRAAAAAAAAAAAAAMF8NBZZUQAAAAAAAAAAAACx1JfrGwAAAAAAAAAAAAAA27hDjVlRAAAAAAAAAAAAAAAvMJpRAAAAAAAAAAAAAACAeFmAtf///////////////VbPGQcAAAAAAAAAAAAAAINQugAAAAAAAAAAAAAAAAAAuEHoLgMAAAAAAAAAAAAA0BBxPAX+/////////////x+EvMLH3v////////////9dJGEqRB4AAAAAAAAAAAAAvT+NfU3e/////////////yp6wB2KHgAAAAAAAAAAAAAAqKvhEAAAAAAAAAAAAAAAPsFFqQAAAAA+wUWpAAAAAD7BRakAAAAAbrDDcQAAAAAaJWKGrwMAAAAAAAAAAAAAS7R+idYBAAAAAAAAAAAAAF2WRnPdAQAAAAAAAAAAAADRdFqB6AIAAAAAAAAAAAAAiHk9siQBAAAAAAAAAAAAANqRAEIxAQAAAAAAAAAAAABxdu2rEhsAAAAAAAAAAAAAluV7kBIbAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAC/RQAMTFEAAAAAAAAAAAAAcSSAImZRAAAAAAAAAAAAADqAU5VRUQAAAAAAAAAAAACLt8aXYFEAAAAAAAAAAAAAjhnK8BsAAAAAAAAAAAAAALcQR+kbAAAAFBqR6xsAAABlFWzqGwAAALmLxOgbAAAAqDIPFQAAAABvAAAAAAAAANPXJTQAAAAAxmF1aAAAAAAQDgAAAAAAAKCGAQAAAAAAoIYBAAAAAACghgEAAAAAAAAAAAAAAAAAPM5NNkwmAQAtW2Wj6QQAAAfQ/dycBgAA12d1aAAAAAAj//YHAAAAAF+/cQoAAAAA12d1aAAAAAAUAAAA3AUAAA4CAAAHAAAAAAAAAHgAAADcBTIAZGQMAYCLLeUABf8FcpekBQAAAADLSnrF+v///32cLdP/////AAAAAM4AAAAAAAAAAAAAAP+OXyMvTQcAAAAAAAAAAAAAAAAAAAAAAEJUQy1QRVJQICAgICAgICAgICAgICAgICAgICAgICAgAB8K+v////8A4fUFAAAAAP8PpdToAAAA7YdGAwQAAABBY3VoAAAAAADh9QUAAAAAAAAAAAAAAAAAAAAAAAAAAIdLVAAAAAAAmlgAAAAAAABvBwAAAAAAAGwHAAAAAAAAiBMAAEwdAAD0AQAALAEAAAAAAAAQJwAAwQQAANMDAAABAAEAAAAAAJz/AAAAAGMAQgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==");
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

    let reserve_price = perp_market.amm.reserve_price().unwrap();
    let (b1, a1) = perp_market.amm.bid_ask_price(reserve_price).unwrap();
    assert_eq!(reserve_price, 120003893645);
    assert_eq!(b1, 120003053617);
    assert_eq!(a1, 120067015693);
    assert_eq!(
        perp_market.amm.historical_oracle_data.last_oracle_price,
        120003893646
    );
    assert_eq!(perp_market.amm.reference_price_offset, 0);
    assert_eq!(perp_market.amm.last_update_slot, 353317544);

    perp_market.amm.curve_update_intensity = 200;

    let max_ref_offset = perp_market.amm.get_max_reference_price_offset().unwrap();

    let liquidity_ratio = crate::math::amm_spread::calculate_inventory_liquidity_ratio(
        perp_market.amm.base_asset_amount_with_amm,
        perp_market.amm.base_asset_reserve,
        perp_market.amm.max_base_asset_reserve,
        perp_market.amm.min_base_asset_reserve,
    )
    .unwrap();

    let signed_liquidity_ratio = liquidity_ratio
        .checked_mul(
            (perp_market
                .amm
                .get_protocol_owned_position()
                .unwrap()
                .signum() as i128),
        )
        .unwrap();

    let res = crate::math::amm_spread::calculate_reference_price_offset(
        reserve_price,
        perp_market.amm.last_24h_avg_funding_rate,
        signed_liquidity_ratio,
        perp_market.amm.min_order_size,
        perp_market
            .amm
            .historical_oracle_data
            .last_oracle_price_twap_5min,
        perp_market.amm.last_mark_price_twap_5min,
        perp_market
            .amm
            .historical_oracle_data
            .last_oracle_price_twap,
        perp_market.amm.last_mark_price_twap,
        max_ref_offset,
    )
    .unwrap();
    assert_eq!(res, 10000);

    let mut now = perp_market.amm.last_mark_price_twap_ts + 10;
    let mut clock_slot = 353317544 + 20; // todo
    let state = State::default();
    let oracle_price_data = OraclePriceData {
        price: 120003893646,
        confidence: PRICE_PRECISION_U64 / 1000,
        delay: 1,
        has_sufficient_number_of_data_points: true,
        sequence_id: None,
    };
    let mm_oracle_price_data = perp_market
        .get_mm_oracle_price_data(
            oracle_price_data,
            clock_slot,
            &state.oracle_guard_rails.validity,
        )
        .unwrap();
    let cost = _update_amm(
        &mut perp_market,
        &mm_oracle_price_data,
        &state,
        now,
        clock_slot,
    )
    .unwrap();
    assert_eq!(perp_market.amm.last_update_slot, clock_slot);
    assert_eq!(perp_market.amm.last_oracle_valid, true);
    assert_eq!(perp_market.amm.reference_price_offset, 4458);

    perp_market.amm.last_mark_price_twap_5min = (perp_market
        .amm
        .historical_oracle_data
        .last_oracle_price_twap_5min
        * 99
        / 100) as u64;

    // Run  decay steps
    let mut offsets = Vec::new();
    let mut lspreads = Vec::new();
    let mut sspreads = Vec::new();

    for i in 0..60 {
        // advance time for next iteration

        // some multiple cranks same slot
        if i < 6 || i > 9 {
            now += 1;
            clock_slot += 2;
        }
        let mm_oracle_price_data = perp_market
            .get_mm_oracle_price_data(
                oracle_price_data,
                clock_slot,
                &state.oracle_guard_rails.validity,
            )
            .unwrap();

        let cost = _update_amm(
            &mut perp_market,
            &mm_oracle_price_data,
            &state,
            now,
            clock_slot,
        )
        .unwrap();
        assert_eq!(perp_market.amm.last_update_slot, clock_slot);
        assert_eq!(perp_market.amm.last_oracle_valid, true);

        // capture the new offset
        offsets.push(perp_market.amm.reference_price_offset);
        lspreads.push(perp_market.amm.long_spread);
        sspreads.push(perp_market.amm.short_spread);
    }

    assert_eq!(
        offsets,
        [
            4248, 4038, 3828, 3618, 3408, 3198, 3178, 3158, 3138, 3118, 2908, 2698, 2488, 2278,
            2068, 1858, 1664, 1489, 1332, 1190, 1062, 947, 844, 751, 667, 592, 524, 463, 408, 359,
            315, 275, 239, 207, 178, 152, 128, 107, 87, 67, 47, 27, 7, 0, 0, 0, 0, 0, 0, 0, 0, 0,
            0, 0, 0, 0, 0, 0, 0, 0
        ]
    );
    assert_eq!(
        lspreads,
        [
            726, 726, 726, 726, 726, 726, 536, 536, 536, 536, 726, 726, 726, 726, 726, 726, 710,
            691, 673, 658, 644, 631, 619, 609, 600, 591, 584, 577, 571, 565, 560, 556, 552, 548,
            545, 542, 540, 537, 536, 536, 536, 536, 536, 526, 526, 526, 526, 526, 526, 526, 526,
            526, 526, 526, 526, 526, 526, 526, 526, 526
        ]
    );
    assert_eq!(
        sspreads,
        [
            4258, 4048, 3838, 3628, 3418, 3208, 3188, 3168, 3148, 3128, 2918, 2708, 2498, 2288,
            2078, 1868, 1674, 1499, 1342, 1200, 1072, 957, 854, 761, 677, 602, 534, 473, 418, 369,
            325, 285, 249, 217, 188, 162, 138, 117, 97, 77, 57, 37, 17, 10, 10, 10, 10, 10, 10, 10,
            10, 10, 10, 10, 10, 10, 10, 10, 10, 10
        ]
    );
}

#[test]
fn amm_negative_ref_price_offset_decay_logic() {
    // sample btc market
    let perp_market_str = String::from("Ct8MLGv1N/cV6vWLwJY+18dY2GsrmrNldgnISB7pmbcf7cn9S4FZ4B7U/fA1on6uX4cAPWh+6q5kflQbDzfTC/LJrf1AdS22jhnK8BsAAAAAAAAAAAAAAAEAAAAAAAAA46fs5xsAAADJQ2HmGwAAANhndWgAAAAA0MlT6v///////////////yF75IAAAAAAAAAAAAAAAADHCg8Gw/4GAAAAAAAAAAAAAAAAAAAAAADpl1aFUVEAAAAAAAAAAAAAd5bGp2BRAAAAAAAAAAAAAHxFDwAAAAAAAAAAAAAAAADYi6VkR1EAAAAAAAAAAAAAjzRN3WlRAAAAAAAAAAAAAMF8NBZZUQAAAAAAAAAAAACx1JfrGwAAAAAAAAAAAAAA27hDjVlRAAAAAAAAAAAAAAAvMJpRAAAAAAAAAAAAAACAeFmAtf///////////////VbPGQcAAAAAAAAAAAAAAINQugAAAAAAAAAAAAAAAAAAuEHoLgMAAAAAAAAAAAAA0BBxPAX+/////////////x+EvMLH3v////////////9dJGEqRB4AAAAAAAAAAAAAvT+NfU3e/////////////yp6wB2KHgAAAAAAAAAAAAAAqKvhEAAAAAAAAAAAAAAAPsFFqQAAAAA+wUWpAAAAAD7BRakAAAAAbrDDcQAAAAAaJWKGrwMAAAAAAAAAAAAAS7R+idYBAAAAAAAAAAAAAF2WRnPdAQAAAAAAAAAAAADRdFqB6AIAAAAAAAAAAAAAiHk9siQBAAAAAAAAAAAAANqRAEIxAQAAAAAAAAAAAABxdu2rEhsAAAAAAAAAAAAAluV7kBIbAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAC/RQAMTFEAAAAAAAAAAAAAcSSAImZRAAAAAAAAAAAAADqAU5VRUQAAAAAAAAAAAACLt8aXYFEAAAAAAAAAAAAAjhnK8BsAAAAAAAAAAAAAALcQR+kbAAAAFBqR6xsAAABlFWzqGwAAALmLxOgbAAAAqDIPFQAAAABvAAAAAAAAANPXJTQAAAAAxmF1aAAAAAAQDgAAAAAAAKCGAQAAAAAAoIYBAAAAAACghgEAAAAAAAAAAAAAAAAAPM5NNkwmAQAtW2Wj6QQAAAfQ/dycBgAA12d1aAAAAAAj//YHAAAAAF+/cQoAAAAA12d1aAAAAAAUAAAA3AUAAA4CAAAHAAAAAAAAAHgAAADcBTIAZGQMAYCLLeUABf8FcpekBQAAAADLSnrF+v///32cLdP/////AAAAAM4AAAAAAAAAAAAAAP+OXyMvTQcAAAAAAAAAAAAAAAAAAAAAAEJUQy1QRVJQICAgICAgICAgICAgICAgICAgICAgICAgAB8K+v////8A4fUFAAAAAP8PpdToAAAA7YdGAwQAAABBY3VoAAAAAADh9QUAAAAAAAAAAAAAAAAAAAAAAAAAAIdLVAAAAAAAmlgAAAAAAABvBwAAAAAAAGwHAAAAAAAAiBMAAEwdAAD0AQAALAEAAAAAAAAQJwAAwQQAANMDAAABAAEAAAAAAJz/AAAAAGMAQgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==");
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

    let reserve_price = perp_market.amm.reserve_price().unwrap();
    let (b1, a1) = perp_market.amm.bid_ask_price(reserve_price).unwrap();
    assert_eq!(reserve_price, 120003893645);
    assert_eq!(b1, 120003053617);
    assert_eq!(a1, 120067015693);
    assert_eq!(
        perp_market.amm.historical_oracle_data.last_oracle_price,
        120003893646
    );
    assert_eq!(perp_market.amm.reference_price_offset, 0);
    assert_eq!(perp_market.amm.last_update_slot, 353317544);

    perp_market.amm.curve_update_intensity = 200;

    let max_ref_offset = perp_market.amm.get_max_reference_price_offset().unwrap();

    let liquidity_ratio = crate::math::amm_spread::calculate_inventory_liquidity_ratio(
        perp_market.amm.base_asset_amount_with_amm,
        perp_market.amm.base_asset_reserve,
        perp_market.amm.max_base_asset_reserve,
        perp_market.amm.min_base_asset_reserve,
    )
    .unwrap();

    let signed_liquidity_ratio = liquidity_ratio
        .checked_mul(
            (perp_market
                .amm
                .get_protocol_owned_position()
                .unwrap()
                .signum() as i128),
        )
        .unwrap();

    let res = crate::math::amm_spread::calculate_reference_price_offset(
        reserve_price,
        perp_market.amm.last_24h_avg_funding_rate,
        signed_liquidity_ratio,
        perp_market.amm.min_order_size,
        perp_market
            .amm
            .historical_oracle_data
            .last_oracle_price_twap_5min,
        perp_market.amm.last_mark_price_twap_5min,
        perp_market
            .amm
            .historical_oracle_data
            .last_oracle_price_twap,
        perp_market.amm.last_mark_price_twap,
        max_ref_offset,
    )
    .unwrap();
    assert_eq!(res, 10000);

    let mut now = perp_market.amm.last_mark_price_twap_ts + 10;
    let mut clock_slot = 353317544 + 20; // todo
    let state = State::default();
    let oracle_price_data = OraclePriceData {
        price: 120003893646,
        confidence: PRICE_PRECISION_U64 / 1000,
        delay: 1,
        has_sufficient_number_of_data_points: true,
        sequence_id: None,
    };
    let mm_oracle_price_data = perp_market
        .get_mm_oracle_price_data(
            oracle_price_data,
            clock_slot,
            &state.oracle_guard_rails.validity,
        )
        .unwrap();
    let cost = _update_amm(
        &mut perp_market,
        &mm_oracle_price_data,
        &state,
        now,
        clock_slot,
    )
    .unwrap();
    assert_eq!(perp_market.amm.last_update_slot, clock_slot);
    assert_eq!(perp_market.amm.last_oracle_valid, true);
    assert_eq!(perp_market.amm.reference_price_offset, 4458);

    perp_market.amm.last_mark_price_twap_5min = (perp_market
        .amm
        .historical_oracle_data
        .last_oracle_price_twap_5min
        * 101
        / 100) as u64;
    perp_market.amm.reference_price_offset = -1 * perp_market.amm.reference_price_offset;

    // Run  decay steps
    let mut offsets = Vec::new();
    let mut lspreads = Vec::new();
    let mut sspreads = Vec::new();

    for i in 0..80 {
        // advance time for next iteration

        // some multiple cranks same slot
        if i < 6 || i > 9 {
            now += 1;
            clock_slot += 2;
        }
        let mm_oracle_price_data = perp_market
            .get_mm_oracle_price_data(
                oracle_price_data,
                clock_slot,
                &state.oracle_guard_rails.validity,
            )
            .unwrap();

        let cost = _update_amm(
            &mut perp_market,
            &mm_oracle_price_data,
            &state,
            now,
            clock_slot,
        )
        .unwrap();
        assert_eq!(perp_market.amm.last_update_slot, clock_slot);
        assert_eq!(perp_market.amm.last_oracle_valid, true);

        // capture the new offset
        offsets.push(perp_market.amm.reference_price_offset);
        lspreads.push(perp_market.amm.long_spread);
        sspreads.push(perp_market.amm.short_spread);
    }

    assert_eq!(
        offsets,
        [
            -4248, -4038, -3828, -3618, -3408, -3198, -3178, -3158, -3138, -3118, -2908, -2698,
            -2488, -2278, -2068, -1858, -1648, -1438, -1228, -1018, -808, -598, -388, -178, 0,
            7654, 7652, 7651, 7649, 7648, 7646, 7645, 7643, 7641, 7640, 7638, 7637, 7635, 7634,
            7632, 7631, 7629, 7628, 7626, 7625, 7623, 7622, 7620, 7619, 7618, 7616, 7615, 7613,
            7612, 7610, 7609, 7607, 7606, 7605, 7603, 7602, 7600, 7599, 7597, 7596, 7595, 7593,
            7592, 7591, 7589, 7588, 7586, 7585, 7584, 7582, 7581, 7580, 7578, 7577, 7576
        ]
    );
    assert_eq!(
        sspreads,
        [
            210, 210, 210, 210, 210, 210, 20, 20, 20, 20, 210, 210, 210, 210, 210, 210, 210, 210,
            210, 210, 210, 210, 210, 210, 178, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10,
            10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10,
            10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10
        ]
    );
    assert_eq!(
        lspreads,
        [
            4774, 4564, 4354, 4144, 3934, 3724, 3704, 3684, 3664, 3644, 3434, 3224, 3014, 2804,
            2594, 2384, 2174, 1964, 1754, 1544, 1334, 1124, 914, 704, 526, 526, 526, 526, 526, 526,
            526, 526, 526, 526, 526, 526, 526, 526, 526, 526, 526, 526, 526, 526, 526, 526, 526,
            526, 526, 526, 526, 526, 526, 526, 526, 526, 526, 526, 526, 526, 526, 526, 526, 526,
            526, 526, 526, 526, 526, 526, 526, 526, 526, 526, 526, 526, 526, 526, 526, 526
        ]
    );
}

#[test]
fn amm_perp_ref_offset() {
    let perp_market_str = String::from("Ct8MLGv1N/frxfcToe675SrQivb0F67YUSLVM3KDMaqsrnwc8fwczsz5oyRPeWWnXBDAXzWarbuAhSPT0bfoyy4yyWBLxtoIoFxsAAAAAAAAAAAAAAAAAAEAAAAAAAAAwt1rAAAAAAAiZmwAAAAAAES4yGcAAAAAtlzFXyUAAAAAAAAAAAAAALSB+4IAAAAAAAAAAAAAAAD2TULXx84AAAAAAAAAAAAAAAAAAAAAAABslCM7QZsQAAAAAAAAAAAAk4WjVa59CAAAAAAAAAAAADxrEgAAAAAAAAAAAAAAAAAFC7zM58ENAAAAAAAAAAAAemIeFLwLFAAAAAAAAAAAAFJYZFbh3wsAAAAAAAAAAAC57tMAAAAAAAAAAAAAAAAAHopkdKl9CAAAAAAAAAAAAACyqjNmBAAAAAAAAAAAAAAA3oQco/v/////////////IX9HiwkAAAAAAAAAAAAAAN8Q6MT///////////////8AgMakfo0DAAAAAAAAAAAANEmHdQAAAAAAAAAAAAAAAE/4Lvzz//////////////8XEpOoCwAAAAAAAAAAAAAABKUfVPP//////////////3ckDIgNAAAAAAAAAAAAAAAAGJUuKwMAAAAAAAAAAAAA/E0BAAAAAAD8TQEAAAAAAPxNAQAAAAAAFlABAAAAAADJ8AhjKAAAAAAAAAAAAAAADJaguhwAAAAAAAAAAAAAAKZ++bELAAAAAAAAAAAAAABae48GKAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAMpu/m4UAAAAAAAAAAAAAACjl79nAQAAAAAAAAAAAAAAyZm9ZwEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABqle+hQHQQAAAAAAAAAAAAs/93w86RCAAAAAAAAAAAAGyUIztBmxAAAAAAAAAAAACThaNVrn0IAAAAAAAAAAAAoFxsAAAAAAAAAAAAAAAAAAHSawAAAAAAv+1rAAAAAADg32sAAAAAAAJnbAAAAAAAYVNcEwAAAAChAwAAAAAAADfd8f//////Q63IZwAAAAAQDgAAAAAAAADKmjsAAAAAZAAAAAAAAAAA8gUqAQAAAAAAAAAAAAAAzxOSPQAAAADE4TUGAAAAAAAAAAAAAAAAzHHIZwAAAACAfQAAAAAAAN5+AAAAAAAARLjIZwAAAADoAwAAkF8BAPgBAAD0AQAAqwEAABYBAADoAzIAyGQOAQAAAAAEAAAAYE+5CAAAAADJKrR8AQAAAFf04Pb/////UEYAAAAAAAAAAAAAAAAAAD7kkISSGgAAAAAAAAAAAAAAAAAAAAAAADFNUEVQRS1QRVJQICAgICAgICAgICAgICAgICAgICAgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAJflAAAAAAAAFj0AAAAAAADYGwAAAAAAAO4CAADuAgAAqGEAAFDDAADECQAA4gQAAAAAAAAQJwAAbQAAAKgAAAAKAAEAAwAAAAAAAAEBAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==");
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

    perp_market.amm.base_asset_amount_with_amm = 40000000000; // override old LP related fields

    let reserve_price = perp_market.amm.reserve_price().unwrap();
    let (b1, a1) = perp_market.amm.bid_ask_price(reserve_price).unwrap();
    assert_eq!(reserve_price, 7101599);
    assert_eq!(b1, 7225876);
    assert_eq!(a1, 7233006);
    assert_eq!(
        perp_market.amm.historical_oracle_data.last_oracle_price,
        7101600
    );
    assert_eq!(perp_market.amm.reference_price_offset, 18000);
    assert_eq!(perp_market.amm.last_update_slot, 324817761);
    assert_eq!(
        perp_market
            .amm
            .historical_oracle_data
            .last_oracle_price_twap_ts,
        1741207620
    );
    assert_eq!(perp_market.amm.bid_base_asset_reserve, 4674304094737516);
    assert_eq!(perp_market.amm.ask_base_asset_reserve, 4631420570932586);

    let max_ref_offset = perp_market.amm.get_max_reference_price_offset().unwrap();

    let liquidity_ratio = crate::math::amm_spread::calculate_inventory_liquidity_ratio(
        perp_market.amm.base_asset_amount_with_amm,
        perp_market.amm.base_asset_reserve,
        perp_market.amm.max_base_asset_reserve,
        perp_market.amm.min_base_asset_reserve,
    )
    .unwrap();

    let signed_liquidity_ratio = liquidity_ratio
        .checked_mul(
            (perp_market
                .amm
                .get_protocol_owned_position()
                .unwrap()
                .signum() as i128),
        )
        .unwrap();

    let res = crate::math::amm_spread::calculate_reference_price_offset(
        reserve_price,
        perp_market.amm.last_24h_avg_funding_rate,
        signed_liquidity_ratio,
        perp_market.amm.min_order_size,
        perp_market
            .amm
            .historical_oracle_data
            .last_oracle_price_twap_5min,
        perp_market.amm.last_mark_price_twap_5min,
        perp_market
            .amm
            .historical_oracle_data
            .last_oracle_price_twap,
        perp_market.amm.last_mark_price_twap,
        max_ref_offset,
    )
    .unwrap();
    assert_eq!(res, (perp_market.amm.max_spread / 2) as i32);
    assert_eq!(perp_market.amm.reference_price_offset, 18000); // not updated vs market account

    let now = 1741207620 + 1;
    let clock_slot = 324817761 + 1; // todo
    let state = State::default();
    let oracle_price_data = OraclePriceData {
        price: 7101600,
        confidence: PRICE_PRECISION_U64 / 1000,
        delay: 1,
        has_sufficient_number_of_data_points: true,
        sequence_id: None,
    };
    let mm_oracle_price_data = perp_market
        .get_mm_oracle_price_data(
            oracle_price_data,
            clock_slot,
            &state.oracle_guard_rails.validity,
        )
        .unwrap();
    let cost = _update_amm(
        &mut perp_market,
        &mm_oracle_price_data,
        &state,
        now,
        clock_slot,
    )
    .unwrap();
    assert_eq!(perp_market.amm.last_update_slot, clock_slot);
    assert_eq!(perp_market.amm.last_oracle_valid, true);

    let r = perp_market.amm.reserve_price().unwrap();
    let (b, a) = perp_market.amm.bid_ask_price(r).unwrap();
    assert_eq!(b, 7098999);
    assert_eq!(a, 7106129);
    assert_eq!(
        perp_market.amm.historical_oracle_data.last_oracle_price,
        7101600
    );
    assert_eq!(perp_market.amm.reference_price_offset, 134);
    assert_eq!(perp_market.amm.max_spread, 90000);

    assert_eq!(r, 7101599);
    assert_eq!(perp_market.amm.bid_base_asset_reserve, 4675159724262455);
    assert_eq!(perp_market.amm.ask_base_asset_reserve, 4672813088646692);

    crate::validation::perp_market::validate_perp_market(&perp_market).unwrap();

    // Update MM oracle and reference price offset stays the same and is applied to the MM oracle
    perp_market.amm.mm_oracle_price = oracle_price_data.price * 1005 / 1000;
    perp_market.amm.mm_oracle_slot = clock_slot;
    let mm_oracle_price_data = perp_market
        .get_mm_oracle_price_data(
            oracle_price_data,
            clock_slot,
            &state.oracle_guard_rails.validity,
        )
        .unwrap();

    let _ = _update_amm(
        &mut perp_market,
        &mm_oracle_price_data,
        &state,
        now,
        clock_slot,
    );
    let reserve_price_mm_offset = perp_market.amm.reserve_price().unwrap();
    let (b2, a2) = perp_market
        .amm
        .bid_ask_price(reserve_price_mm_offset)
        .unwrap();
    assert_eq!(perp_market.amm.reference_price_offset, 133);
    assert_eq!(reserve_price_mm_offset, 7137107);
    assert_eq!(b2, 7101549);
    assert_eq!(a2, 7174591);

    // Uses the original oracle if the slot is old, ignoring MM oracle
    perp_market.amm.mm_oracle_price = mm_oracle_price_data.get_price() * 995 / 1000;
    perp_market.amm.mm_oracle_slot = clock_slot - 100;
    let mut mm_oracle_price = perp_market
        .get_mm_oracle_price_data(
            oracle_price_data,
            clock_slot,
            &state.oracle_guard_rails.validity,
        )
        .unwrap();

    let _ = _update_amm(
        &mut perp_market,
        &mut mm_oracle_price,
        &state,
        now,
        clock_slot,
    );
    let reserve_price_mm_offset_3 = perp_market.amm.reserve_price().unwrap();
    let (b3, a3) = perp_market
        .amm
        .bid_ask_price(reserve_price_mm_offset_3)
        .unwrap();
    assert_eq!(reserve_price_mm_offset_3, r);
    assert_eq!(b3, 7066225);
    assert_eq!(a3, 7138903);
}

#[test]
fn test_position_entry_sim() {
    let mut existing_position: PerpPosition = PerpPosition::default();
    let position_delta = PositionDelta {
        base_asset_amount: BASE_PRECISION_I64 / 2,
        quote_asset_amount: -99_345_000 / 2,
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

    let state: State = State::default();

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
    assert_eq!(perp_market.amm.base_asset_amount_with_amm, 23831444927173);
    assert_eq!(
        perp_market.amm.base_asset_amount_with_unsettled_lp,
        562555072827
    );

    perp_market.amm.base_asset_amount_with_amm +=
        perp_market.amm.base_asset_amount_with_unsettled_lp;
    perp_market.amm.base_asset_amount_with_unsettled_lp = 0;
    println!("perp_market: {:?}", perp_market.amm.last_update_slot);

    let oracle_price_data = oracle_map.get_price_data(&perp_market.oracle_id()).unwrap();
    let mm_oracle_price_data = perp_market
        .get_mm_oracle_price_data(*oracle_price_data, slot, &state.oracle_guard_rails.validity)
        .unwrap();

    let state = State::default();
    // perp_market.amm.sqrt_k -= perp_market.amm.user_lp_shares;
    // perp_market.amm.user_lp_shares = 0;

    let cost = _update_amm(&mut perp_market, &mm_oracle_price_data, &state, now, slot).unwrap();
    // assert_eq!(perp_market.amm.sqrt_k,        3295995551718929);
    // assert_eq!(perp_market.amm.user_lp_shares, 267371000000000);
    assert_eq!(cost, 18803544753);
}

#[test]
fn update_amm_near_boundary2() {
    let perp_market_str = String::from("Ct8MLGv1N/cU6tVVkVpIHdjrXil5+Blo7M7no01SEzFkvCN2nSnel3KwISF8o/5okioZqvmQEJy52E6a0AS00gJa1vUpMUQZIAjcAAAAAAAAAAAAAAAAAAEAAAAAAAAAuUnaAAAAAADDXNsAAAAAAP5xdGUAAAAAa4BQirD//////////////6fVQmsAAAAAAAAAAAAAAACar9SsB0sAAAAAAAAAAAAAAAAAAAAAAABBXO7/SWwLAAAAAAAAAAAAa0vYrBqvCwAAAAAAAAAAACaTDwAAAAAAAAAAAAAAAACHRTA1zkYLAAAAAAAAAAAAEkQuep2/CwAAAAAAAAAAAFAYOQmCjQsAAAAAAAAAAAC9r80AAAAAAAAAAAAAAAAANYB5EXeYCwAAAAAAAAAAAADqjJbciAAAAAAAAAAAAAAANiZLB47/////////////rEGjW00WAAAAAAAAAAAAAFTeD4aWAAAAAAAAAAAAAAAAQGNSv8YBAAAAAAAAAAAAUt/uyv7//////////////802zJqt/v/////////////PSTYa2wAAAAAAAAAAAAAAtPcalqL+/////////////xvHbwvuAAAAAAAAAAAAAAAAdsrWtPEAAAAAAAAAAAAAcbUT//////9xtRP//////3G1E///////Csx3AAAAAACVwjw2OgAAAAAAAAAAAAAAd/FNszYAAAAAAAAAAAAAALHQnZIDAAAAAAAAAAAAAAAA8z1QCQAAAAAAAAAAAAAAwY+XFgAAAAAAAAAAAAAAAEFTL9MIAAAAAAAAAAAAAAAHWeRpAAAAAAAAAAAAAAAAB1nkaQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAADQlAeGCeEKAAAAAAAAAAAAME8Wz6hEDAAAAAAAAAAAABctSD9BbwsAAAAAAAAAAAA8T/PdEqwLAAAAAAAAAAAAMMvbAAAAAADpTP///////6NCywAAAAAA0yfeAAAAAAA7tdQAAAAAAJ3u2wAAAAAAwI8ADgAAAABrBAAAAAAAAA98N2D9////MTx0ZQAAAAAQDgAAAAAAAADKmjsAAAAAZAAAAAAAAAAA8gUqAQAAAAAAAAAAAAAA/9iJIUQBAAB7ga9oBQAAAADrzocBAAAAxXF0ZQAAAACI1QcAAAAAAHeBAQAAAAAA/nF0ZQAAAACUEQAAoIYBALV+AQDrBwAAAAAAAAAAAABkADIAZMgEAQAAAAAEAAAACvtTAQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAZUL9UG/wAAAAAAAAAAAAAAAAAAAAAAADFNQk9OSy1QRVJQICAgICAgICAgICAgICAgICAgICAgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAHQNAgAAAAAA5xkAAAAAAACMAgAAAAAAACYCAADuAgAA+CQBAPgkAQDECQAA3AUAAAAAAAAQJwAAAgIAABwDAAAEAAIAAwAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==");
    let mut decoded_bytes = base64::decode(perp_market_str).unwrap();
    let perp_market_bytes = decoded_bytes.as_mut_slice();

    let state: State = State::default();

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

    let oracle_price_data = oracle_map.get_price_data(&perp_market.oracle_id()).unwrap();
    let mm_oracle_price_data = perp_market
        .get_mm_oracle_price_data(*oracle_price_data, slot, &state.oracle_guard_rails.validity)
        .unwrap();
    let state = State::default();

    let cost: i128 =
        _update_amm(&mut perp_market, &mm_oracle_price_data, &state, now, slot).unwrap();
    assert!(perp_market.amm.last_oracle_valid);
    assert_eq!(cost, 2538958);
}

#[test]
fn recenter_amm_1() {
    let perp_market_str: String = String::from("Ct8MLGv1N/cU6tVVkVpIHdjrXil5+Blo7M7no01SEzFkvCN2nSnel3KwISF8o/5okioZqvmQEJy52E6a0AS00gJa1vUpMUQZIAjcAAAAAAAAAAAAAAAAAAEAAAAAAAAAuUnaAAAAAADDXNsAAAAAAP5xdGUAAAAAa4BQirD//////////////6fVQmsAAAAAAAAAAAAAAACar9SsB0sAAAAAAAAAAAAAAAAAAAAAAABBXO7/SWwLAAAAAAAAAAAAa0vYrBqvCwAAAAAAAAAAACaTDwAAAAAAAAAAAAAAAACHRTA1zkYLAAAAAAAAAAAAEkQuep2/CwAAAAAAAAAAAFAYOQmCjQsAAAAAAAAAAAC9r80AAAAAAAAAAAAAAAAANYB5EXeYCwAAAAAAAAAAAADqjJbciAAAAAAAAAAAAAAANiZLB47/////////////rEGjW00WAAAAAAAAAAAAAFTeD4aWAAAAAAAAAAAAAAAAQGNSv8YBAAAAAAAAAAAAUt/uyv7//////////////802zJqt/v/////////////PSTYa2wAAAAAAAAAAAAAAtPcalqL+/////////////xvHbwvuAAAAAAAAAAAAAAAAdsrWtPEAAAAAAAAAAAAAcbUT//////9xtRP//////3G1E///////Csx3AAAAAACVwjw2OgAAAAAAAAAAAAAAd/FNszYAAAAAAAAAAAAAALHQnZIDAAAAAAAAAAAAAAAA8z1QCQAAAAAAAAAAAAAAwY+XFgAAAAAAAAAAAAAAAEFTL9MIAAAAAAAAAAAAAAAHWeRpAAAAAAAAAAAAAAAAB1nkaQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAADQlAeGCeEKAAAAAAAAAAAAME8Wz6hEDAAAAAAAAAAAABctSD9BbwsAAAAAAAAAAAA8T/PdEqwLAAAAAAAAAAAAMMvbAAAAAADpTP///////6NCywAAAAAA0yfeAAAAAAA7tdQAAAAAAJ3u2wAAAAAAwI8ADgAAAABrBAAAAAAAAA98N2D9////MTx0ZQAAAAAQDgAAAAAAAADKmjsAAAAAZAAAAAAAAAAA8gUqAQAAAAAAAAAAAAAA/9iJIUQBAAB7ga9oBQAAAADrzocBAAAAxXF0ZQAAAACI1QcAAAAAAHeBAQAAAAAA/nF0ZQAAAACUEQAAoIYBALV+AQDrBwAAAAAAAAAAAABkADIAZMgEAQAAAAAEAAAACvtTAQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAZUL9UG/wAAAAAAAAAAAAAAAAAAAAAAADFNQk9OSy1QRVJQICAgICAgICAgICAgICAgICAgICAgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAHQNAgAAAAAA5xkAAAAAAACMAgAAAAAAACYCAADuAgAA+CQBAPgkAQDECQAA3AUAAAAAAAAQJwAAAgIAABwDAAAEAAIAAwAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==");
    let mut decoded_bytes = base64::decode(perp_market_str).unwrap();
    let perp_market_bytes = decoded_bytes.as_mut_slice();

    let state: State = State::default();

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

    let oracle_price_data = oracle_map.get_price_data(&perp_market.oracle_id()).unwrap();
    let mm_oracle_price_data = perp_market
        .get_mm_oracle_price_data(*oracle_price_data, slot, &state.oracle_guard_rails.validity)
        .unwrap();

    let state = State::default();

    let cost = _update_amm(&mut perp_market, &mm_oracle_price_data, &state, now, slot).unwrap();

    assert_eq!(cost, 2538958);

    let inv = perp_market.amm.base_asset_amount_with_amm;
    assert_eq!(inv, 24521505718700);

    let (_, _, r1_orig, r2_orig) = calculate_base_swap_output_with_spread(
        &perp_market.amm,
        inv.unsigned_abs() as u64,
        swap_direction_to_close_position(inv),
    )
    .unwrap();

    assert_eq!(r1_orig, 334835274409);
    assert_eq!(r2_orig, 704841208);

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

    let oracle_price_data = oracle_map
        .get_price_data(&(oracle_price_key, OracleSource::Pyth))
        .unwrap();
    let mm_oracle_price_data = MMOraclePriceData::new(
        oracle_price_data.price,
        oracle_price_data.delay + 1,
        1,
        OracleValidity::default(),
        *oracle_price_data,
    )
    .unwrap();

    let state = State::default();

    let cost = _update_amm(&mut perp_market, &mm_oracle_price_data, &state, now, slot).unwrap();

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
    assert_eq!(
        perp_market.amm.get_lower_bound_sqrt_k().unwrap(),
        perp_market.amm.min_order_size as u128
    );

    perp_market.amm.base_asset_amount_with_amm +=
        perp_market.amm.base_asset_amount_with_unsettled_lp;
    perp_market.amm.base_asset_amount_with_unsettled_lp = 0;

    recenter_perp_market_amm(&mut perp_market, oracle_price_data.price as u128, new_k).unwrap();

    assert_eq!(perp_market.amm.sqrt_k, new_k);
    assert_eq!(
        perp_market.amm.peg_multiplier,
        oracle_price_data.price as u128
    );
    assert_eq!(perp_market.amm.peg_multiplier, 1_120_000);
    // assert_eq!(perp_market.amm.quote_asset_reserve, 140625455708483789 * 2);
    // assert_eq!(perp_market.amm.base_asset_reserve, 140625456291516213 * 2);
    assert_eq!(perp_market.amm.base_asset_reserve, 281254004000000002);
    assert_eq!(perp_market.amm.quote_asset_reserve, 281247820033992278);

    crate::validation::perp_market::validate_perp_market(&perp_market).unwrap();

    let (r1, r2) = swap_base_asset(
        &mut perp_market,
        inv.unsigned_abs() as u64,
        swap_direction_to_close_position(inv),
    )
    .unwrap();

    // adjusted slightly
    assert_eq!(r1, 348620); // 354919762322 w/o k adj
    assert_eq!(r2, 22129);

    let new_scale = 2;
    let new_sqrt_k = perp_market.amm.sqrt_k * new_scale;
    let update_k_result = get_update_k_result(&perp_market, U192::from(new_sqrt_k), false).unwrap();
    let adjustment_cost = adjust_k_cost(&mut perp_market, &update_k_result).unwrap();
    assert_eq!(adjustment_cost, 19035);

    update_k(&mut perp_market, &update_k_result).unwrap();

    assert_eq!(perp_market.amm.sqrt_k, new_sqrt_k);
    assert_eq!(perp_market.amm.user_lp_shares, current_k - 1);
    assert_eq!(
        perp_market.amm.get_lower_bound_sqrt_k().unwrap(),
        3092000000000
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
    perp_market.amm.base_asset_amount_with_amm = -3092 * BASE_PRECISION as i128;
    println!(
        "perp_market latest slot: {:?}",
        perp_market.amm.last_update_slot
    );

    // previous values
    assert_eq!(perp_market.amm.peg_multiplier, 5);
    assert_eq!(perp_market.amm.quote_asset_reserve, 64381518181749930705);
    assert_eq!(perp_market.amm.base_asset_reserve, 307161425106214);

    let oracle_price_data = oracle_map
        .get_price_data(&(oracle_price_key, OracleSource::Pyth))
        .unwrap();
    let mm_oracle_price_data = MMOraclePriceData::new(
        oracle_price_data.price,
        oracle_price_data.delay + 1,
        1,
        OracleValidity::default(),
        *oracle_price_data,
    )
    .unwrap();

    let state = State::default();

    let cost = _update_amm(&mut perp_market, &mm_oracle_price_data, &state, now, slot).unwrap();

    assert_eq!(cost, 0);

    let inv = perp_market.amm.base_asset_amount_with_amm;
    assert_eq!(inv, -3092000000000);

    let (_, _, r1_orig, r2_orig) = calculate_base_swap_output_with_spread(
        &perp_market.amm,
        inv.unsigned_abs() as u64,
        swap_direction_to_close_position(inv),
    )
    .unwrap();

    assert_eq!(r1_orig, 3489128798);
    assert_eq!(r2_orig, 215737299);
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
