use crate::math::bankruptcy::is_user_bankrupt;
use crate::state::spot_market::SpotBalanceType;
use crate::state::user::{PerpPosition, PositionFlag, SpotPosition, User};
use crate::test_utils::{get_positions, get_spot_positions};

#[test]
fn user_has_position_with_base() {
    let user = User {
        perp_positions: get_positions(PerpPosition {
            base_asset_amount: 1,
            ..PerpPosition::default()
        }),
        ..User::default()
    };

    let is_bankrupt = is_user_bankrupt(&user);
    assert!(!is_bankrupt);
}

#[test]
fn user_has_position_with_positive_quote() {
    let user = User {
        perp_positions: get_positions(PerpPosition {
            quote_asset_amount: 1,
            ..PerpPosition::default()
        }),
        ..User::default()
    };

    let is_bankrupt = is_user_bankrupt(&user);
    assert!(!is_bankrupt);
}

#[test]
fn user_with_deposit() {
    let user = User {
        spot_positions: get_spot_positions(SpotPosition {
            balance_type: SpotBalanceType::Deposit,
            scaled_balance: 1,
            ..SpotPosition::default()
        }),
        ..User::default()
    };

    let is_bankrupt = is_user_bankrupt(&user);
    assert!(!is_bankrupt);
}

#[test]
fn user_has_position_with_negative_quote() {
    let user = User {
        perp_positions: get_positions(PerpPosition {
            quote_asset_amount: -1,
            ..PerpPosition::default()
        }),
        ..User::default()
    };

    let is_bankrupt = is_user_bankrupt(&user);
    assert!(is_bankrupt);
}

#[test]
fn user_with_borrow() {
    let user = User {
        spot_positions: get_spot_positions(SpotPosition {
            balance_type: SpotBalanceType::Borrow,
            scaled_balance: 1,
            ..SpotPosition::default()
        }),
        ..User::default()
    };

    let is_bankrupt = is_user_bankrupt(&user);
    assert!(is_bankrupt);
}

#[test]
fn user_with_empty_position_and_balances() {
    let user = User::default();
    let is_bankrupt = is_user_bankrupt(&user);
    assert!(!is_bankrupt);
}

#[test]
fn user_with_isolated_position() {
    let user = User {
        perp_positions: get_positions(PerpPosition {
            position_flag: PositionFlag::IsolatedPosition as u8,
            ..PerpPosition::default()
        }),
        ..User::default()
    };

    let mut user_with_scaled_balance = user.clone();
    user_with_scaled_balance.perp_positions[0].isolated_position_scaled_balance = 1000000000000000000;

    let is_bankrupt = is_user_bankrupt(&user_with_scaled_balance);
    assert!(!is_bankrupt);

    let mut user_with_base_asset_amount = user.clone();
    user_with_base_asset_amount.perp_positions[0].base_asset_amount = 1000000000000000000;

    let is_bankrupt = is_user_bankrupt(&user_with_base_asset_amount);
    assert!(!is_bankrupt);

    let mut user_with_open_order = user.clone();
    user_with_open_order.perp_positions[0].open_orders = 1;

    let is_bankrupt = is_user_bankrupt(&user_with_open_order);
    assert!(!is_bankrupt);

    let mut user_with_positive_pnl = user.clone();
    user_with_positive_pnl.perp_positions[0].quote_asset_amount = 1000000000000000000;

    let is_bankrupt = is_user_bankrupt(&user_with_positive_pnl);
    assert!(!is_bankrupt);

    let mut user_with_negative_pnl = user.clone();
    user_with_negative_pnl.perp_positions[0].quote_asset_amount = -1000000000000000000;

    let is_bankrupt = is_user_bankrupt(&user_with_negative_pnl);
    assert!(is_bankrupt);
}
