use crate::controller::lp::*;
use crate::math::constants::{AMM_RESERVE_PRECISION, BASE_PRECISION_U64};
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
fn test_remainder_long_settle_big_order_step_size() {
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
    assert_eq!(position.remainder_base_asset_amount, 0);
}
