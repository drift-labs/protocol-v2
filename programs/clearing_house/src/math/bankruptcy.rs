use crate::state::spot_market::SpotBalanceType;
use crate::state::user::User;

#[cfg(test)]
#[path = "../../tests/math/bankruptcy.rs"]
mod test;

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
