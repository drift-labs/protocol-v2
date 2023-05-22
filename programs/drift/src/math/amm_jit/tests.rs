use crate::math::amm_jit::*;
use crate::state::perp_market::AMM;

#[test]
fn balanced_market_zero_jit() {
    let market = PerpMarket {
        amm: AMM {
            base_asset_amount_with_amm: 0,
            amm_jit_intensity: 100,
            ..AMM::default_test()
        },
        ..PerpMarket::default()
    };
    let jit_base_asset_amount = 100;

    let jit_amount = calculate_clamped_jit_base_asset_amount(
        &market,
        AMMLiquiditySplit::ProtocolOwned,
        jit_base_asset_amount,
    )
    .unwrap();
    assert_eq!(jit_amount, 0);
}

#[test]
fn balanced_market_zero_intensity() {
    let market = PerpMarket {
        amm: AMM {
            base_asset_amount_with_amm: 100,
            amm_jit_intensity: 0,
            ..AMM::default_test()
        },
        ..PerpMarket::default()
    };
    let jit_base_asset_amount = 100;

    let jit_amount = calculate_clamped_jit_base_asset_amount(
        &market,
        AMMLiquiditySplit::ProtocolOwned,
        jit_base_asset_amount,
    )
    .unwrap();
    assert_eq!(jit_amount, 0);
}

#[test]
fn balanced_market_full_intensity() {
    let market = PerpMarket {
        amm: AMM {
            base_asset_amount_with_amm: 100,
            amm_jit_intensity: 100,
            ..AMM::default_test()
        },
        ..PerpMarket::default()
    };
    let jit_base_asset_amount = 100;

    let jit_amount = calculate_clamped_jit_base_asset_amount(
        &market,
        AMMLiquiditySplit::ProtocolOwned,
        jit_base_asset_amount,
    )
    .unwrap();
    assert_eq!(jit_amount, 100);
}

#[test]
fn balanced_market_half_intensity() {
    let market = PerpMarket {
        amm: AMM {
            base_asset_amount_with_amm: 100,
            amm_jit_intensity: 50,
            ..AMM::default_test()
        },
        ..PerpMarket::default()
    };
    let jit_base_asset_amount = 100;

    let jit_amount = calculate_clamped_jit_base_asset_amount(
        &market,
        AMMLiquiditySplit::ProtocolOwned,
        jit_base_asset_amount,
    )
    .unwrap();
    assert_eq!(jit_amount, 50);
}
