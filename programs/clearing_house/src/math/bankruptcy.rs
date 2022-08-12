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

        has_liability = has_liability || position.quote_asset_amount < 0
    }

    has_liability
}
