use crate::controller::position::{
    update_lp_market_position, update_position_and_market, PositionDelta,
};

use crate::controller::lp::{apply_lp_rebase_to_perp_market, settle_lp_position};

use crate::controller::repeg::_update_amm;
// use crate::instructions::handle_update_perp_market_per_lp_base;
use crate::math::constants::{
    AMM_RESERVE_PRECISION, AMM_RESERVE_PRECISION_I128, BASE_PRECISION_I64, PRICE_PRECISION_I64,
    PRICE_PRECISION_U64, QUOTE_PRECISION_I128,
};
use crate::state::oracle::OraclePriceData;
use crate::state::perp_market::{AMMLiquiditySplit, PerpMarket, AMM};
use crate::state::state::State;
use crate::state::user::PerpPosition;
use crate::test_utils::create_account_info;
use anchor_lang::prelude::AccountLoader;
use solana_program::pubkey::Pubkey;
use std::str::FromStr;

#[test]
fn full_amm_split() {
    let delta = PositionDelta {
        base_asset_amount: 10 * BASE_PRECISION_I64,
        quote_asset_amount: -10 * BASE_PRECISION_I64,
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
    };

    update_lp_market_position(&mut perp_market, &delta, 0, AMMLiquiditySplit::Shared).unwrap();

    assert_eq!(perp_market.amm.base_asset_amount_per_lp, -574054758);
    assert_eq!(perp_market.amm.quote_asset_amount_per_lp, 12535655);

    // min short order for $2.3
    let delta = PositionDelta {
        base_asset_amount: -BASE_PRECISION_I64 / 10,
        quote_asset_amount: 2300000,
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

    let og_baapl = perp_market.amm.base_asset_amount_per_lp;
    let og_qaapl = perp_market.amm.quote_asset_amount_per_lp;

    // update base
    let base_change = 5;
    apply_lp_rebase_to_perp_market(&mut perp_market, base_change).unwrap();

    // noop delta
    let delta = PositionDelta {
        base_asset_amount: 0,
        quote_asset_amount: 0,
    };

    update_lp_market_position(&mut perp_market, &delta, 0, AMMLiquiditySplit::Shared).unwrap();

    assert_eq!(perp_market.amm.quote_asset_amount_per_lp, og_qaapl * 100000);
    assert_eq!(perp_market.amm.base_asset_amount_per_lp, og_baapl * 100000);

    // min long order for $2.3
    let delta = PositionDelta {
        base_asset_amount: BASE_PRECISION_I64 / 10,
        quote_asset_amount: -2300000,
    };

    update_lp_market_position(&mut perp_market, &delta, 0, AMMLiquiditySplit::Shared).unwrap();

    assert_eq!(perp_market.amm.base_asset_amount_per_lp, -57405475887639);
    assert_eq!(perp_market.amm.quote_asset_amount_per_lp, 1253565506615);

    let num = perp_market.amm.quote_asset_amount_per_lp - (og_qaapl * 100000);
    let denom = perp_market.amm.base_asset_amount_per_lp - (og_baapl * 100000);
    assert_eq!(-num * 1000000 / denom, 22997); // $22.997 cost basis for short (vs $23 actual)

    // min short order for $2.3
    let delta = PositionDelta {
        base_asset_amount: -BASE_PRECISION_I64 / 10,
        quote_asset_amount: 2300000,
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

    // update base back
    let base_change = -2;
    apply_lp_rebase_to_perp_market(&mut perp_market, base_change).unwrap();
    // noop delta
    let delta = PositionDelta {
        base_asset_amount: 0,
        quote_asset_amount: 0,
    };

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
    assert_eq!(perp_market.amm.base_asset_amount_with_amm, -955615735884);
    assert_eq!(
        perp_market.amm.base_asset_amount_with_unsettled_lp,
        1463015735884
    );
    let prev_with_unsettled_lp = perp_market.amm.base_asset_amount_with_unsettled_lp;
    settle_lp_position(&mut existing_position, &mut perp_market).unwrap();

    assert_eq!(perp_market.amm.base_asset_amount_long, 121646400000000);
    assert_eq!(perp_market.amm.base_asset_amount_short, -121139900000000);
    assert_eq!(perp_market.amm.base_asset_amount_with_amm, -955615735884);
    assert_eq!(
        perp_market.amm.base_asset_amount_with_unsettled_lp,
        1462115735884
    );
    assert_eq!(
        perp_market.amm.base_asset_amount_with_unsettled_lp,
        1462115735884
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
