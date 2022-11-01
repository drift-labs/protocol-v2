use crate::state::spot_market::SpotBalanceType;
use crate::state::user::User;

#[cfg(test)]
mod tests;

pub fn is_user_bankrupt(user: &User) -> bool {
    // user is bankrupt iff they have spot liabilities, no spot assets, and no perp exposure

    let mut has_liability = false;

    for spot_position in user.spot_positions.iter() {
        if spot_position.scaled_balance > 0 {
            match spot_position.balance_type {
                SpotBalanceType::Deposit => return false,
                SpotBalanceType::Borrow => has_liability = true,
            }
        }
    }

    for perp_position in user.perp_positions.iter() {
        if perp_position.base_asset_amount != 0
            || perp_position.quote_asset_amount > 0
            || perp_position.has_open_order()
            || perp_position.is_lp()
        {
            return false;
        }

        if perp_position.quote_asset_amount < 0 {
            has_liability = true;
        }
    }

    has_liability
}
