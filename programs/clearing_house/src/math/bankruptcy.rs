use crate::state::bank::BankBalanceType;
use crate::state::user::User;

pub fn is_user_bankrupt(user: &User) -> bool {
    let mut has_liability = false;

    for bank_balance in user.bank_balances.iter() {
        if bank_balance.balance > 0 {
            match bank_balance.balance_type {
                BankBalanceType::Deposit => return false,
                BankBalanceType::Borrow => has_liability = true,
            }
        }
    }

    for position in user.positions.iter() {
        if position.base_asset_amount != 0 || position.quote_asset_amount > 0 {
            return false;
        }

        if position.quote_asset_amount < 0 {
            has_liability = true;
        }
    }

    has_liability
}

#[cfg(test)]
mod test {
    use crate::math::bankruptcy::is_user_bankrupt;
    use crate::state::bank::BankBalanceType;
    use crate::state::user::{MarketPosition, User, UserBankBalance};
    use crate::tests::utils::{get_bank_balances, get_positions};

    #[test]
    fn user_has_position_with_base() {
        let user = User {
            positions: get_positions(MarketPosition {
                base_asset_amount: 1,
                ..MarketPosition::default()
            }),
            ..User::default()
        };

        let is_bankrupt = is_user_bankrupt(&user);
        assert!(!is_bankrupt);
    }

    #[test]
    fn user_has_position_with_positive_quote() {
        let user = User {
            positions: get_positions(MarketPosition {
                quote_asset_amount: 1,
                ..MarketPosition::default()
            }),
            ..User::default()
        };

        let is_bankrupt = is_user_bankrupt(&user);
        assert!(!is_bankrupt);
    }

    #[test]
    fn user_with_deposit() {
        let user = User {
            bank_balances: get_bank_balances(UserBankBalance {
                balance_type: BankBalanceType::Deposit,
                balance: 1,
                ..UserBankBalance::default()
            }),
            ..User::default()
        };

        let is_bankrupt = is_user_bankrupt(&user);
        assert!(!is_bankrupt);
    }

    #[test]
    fn user_has_position_with_negative_quote() {
        let user = User {
            positions: get_positions(MarketPosition {
                quote_asset_amount: -1,
                ..MarketPosition::default()
            }),
            ..User::default()
        };

        let is_bankrupt = is_user_bankrupt(&user);
        assert!(is_bankrupt);
    }

    #[test]
    fn user_with_borrow() {
        let user = User {
            bank_balances: get_bank_balances(UserBankBalance {
                balance_type: BankBalanceType::Borrow,
                balance: 1,
                ..UserBankBalance::default()
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
