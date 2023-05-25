use crate::controller::lp::*;
use crate::math::constants::{AMM_RESERVE_PRECISION, BASE_PRECISION_I128, BASE_PRECISION_U64};
use crate::state::perp_market::AMM;
use crate::state::user::PerpPosition;

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
