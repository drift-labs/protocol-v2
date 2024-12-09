#[cfg(test)]
mod test {
    use crate::math::spot_balance::{get_spot_balance, get_token_amount};
    use crate::state::spot_market::{SpotBalanceType, SpotMarket};
    use crate::SPOT_CUMULATIVE_INTEREST_PRECISION;

    #[test]
    fn bonk() {
        let spot_market = SpotMarket {
            cumulative_deposit_interest: SPOT_CUMULATIVE_INTEREST_PRECISION,
            decimals: 5,
            ..SpotMarket::default_quote_market()
        };

        let one_bonk = 10_u128.pow(spot_market.decimals);

        let balance =
            get_spot_balance(one_bonk, &spot_market, &SpotBalanceType::Deposit, false).unwrap();

        let token_amount =
            get_token_amount(balance, &spot_market, &SpotBalanceType::Deposit).unwrap();
        assert_eq!(token_amount, one_bonk);
    }
}
