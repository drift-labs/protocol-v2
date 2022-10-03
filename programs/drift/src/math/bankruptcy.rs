use crate::state::spot_market::SpotBalanceType;
use crate::state::user::User;

pub fn is_user_bankrupt(user: &User) -> bool {
    let mut has_liability = false;

    for spot_position in user.spot_positions.iter() {
        if spot_position.balance > 0 {
            match spot_position.balance_type {
                SpotBalanceType::Deposit => return false,
                SpotBalanceType::Borrow => has_liability = true,
            }
        }
    }

    for perp_position in user.perp_positions.iter() {
        if perp_position.base_asset_amount != 0 || perp_position.quote_asset_amount > 0 {
            return false;
        }

        if perp_position.quote_asset_amount < 0 {
            has_liability = true;
        }
    }

    has_liability
}

#[cfg(test)]
mod test {
    use crate::math::bankruptcy::is_user_bankrupt;
    use crate::state::spot_market::SpotBalanceType;
    use crate::state::user::{PerpPosition, SpotPosition, User};
    use crate::tests::utils::{get_positions, get_spot_positions};

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
                balance: 1,
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
                balance: 1,
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
}
