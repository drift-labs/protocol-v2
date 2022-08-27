use crate::error::ClearingHouseResult;
use crate::math::constants::AMM_RESERVE_PRECISION_I128;
use crate::math_error;
use crate::state::market::Market;
use crate::MarketPosition;

use crate::bn::U192;
use crate::controller::position::PositionDelta;
use crate::controller::position::{update_position_and_market, update_quote_asset_amount};
use crate::math::amm::{get_update_k_result, update_k};
use crate::math::casting::cast_to_i128;
use crate::math::lp::calculate_settle_lp_metrics;
use crate::math::lp::calculate_settled_lp_base_quote;
use crate::math::position::calculate_base_asset_value_with_oracle_price;

use anchor_lang::prelude::msg;

pub fn settle_lp_position(
    position: &mut MarketPosition,
    market: &mut Market,
) -> ClearingHouseResult<()> {
    let n_shares = position.lp_shares;
    let n_shares_i128 = cast_to_i128(n_shares)?;

    let lp_metrics = calculate_settle_lp_metrics(&market.amm, position)?;

    position.last_net_base_asset_amount_per_lp =
        market.amm.market_position_per_lp.base_asset_amount;
    position.last_net_quote_asset_amount_per_lp =
        market.amm.market_position_per_lp.quote_asset_amount;

    let remainder_base_asset_amount_per_lp = lp_metrics
        .remainder_base_asset_amount
        .checked_mul(AMM_RESERVE_PRECISION_I128)
        .ok_or_else(math_error!())?
        .checked_div(n_shares_i128)
        .ok_or_else(math_error!())?;

    // put the remainder back into the last_ for future burns
    position.last_net_base_asset_amount_per_lp = position
        .last_net_base_asset_amount_per_lp
        .checked_sub(remainder_base_asset_amount_per_lp)
        .ok_or_else(math_error!())?;

    let position_delta = PositionDelta {
        base_asset_amount: lp_metrics.base_asset_amount,
        quote_asset_amount: lp_metrics.quote_asset_amount,
    };
    update_position_and_market(position, market, &position_delta)?;

    market.amm.net_unsettled_lp_base_asset_amount = market
        .amm
        .net_unsettled_lp_base_asset_amount
        .checked_add(lp_metrics.base_asset_amount)
        .ok_or_else(math_error!())?;

    Ok(())
}

pub fn burn_lp_shares(
    position: &mut MarketPosition,
    market: &mut Market,
    shares_to_burn: u128,
    oracle_price: i128,
) -> ClearingHouseResult<()> {
    if shares_to_burn == 0 {
        return Ok(());
    }

    // settle
    settle_lp_position(position, market)?;

    // compute any dust
    let (base_asset_amount, _) = calculate_settled_lp_base_quote(&market.amm, position)?;

    // update stats
    // user closes the dust
    market.amm.net_base_asset_amount = market
        .amm
        .net_base_asset_amount
        .checked_sub(base_asset_amount)
        .ok_or_else(math_error!())?;

    market.amm.net_unsettled_lp_base_asset_amount = market
        .amm
        .net_unsettled_lp_base_asset_amount
        .checked_add(base_asset_amount)
        .ok_or_else(math_error!())?;

    // liquidate dust position
    let dust_base_asset_value =
        calculate_base_asset_value_with_oracle_price(base_asset_amount, oracle_price)?
            .checked_add(1)
            .ok_or_else(math_error!())?;

    update_quote_asset_amount(position, -cast_to_i128(dust_base_asset_value)?)?;

    // update last_ metrics
    position.last_net_base_asset_amount_per_lp =
        market.amm.market_position_per_lp.base_asset_amount;
    position.last_net_quote_asset_amount_per_lp =
        market.amm.market_position_per_lp.quote_asset_amount;

    // burn shares
    position.lp_shares = position
        .lp_shares
        .checked_sub(shares_to_burn)
        .ok_or_else(math_error!())?;

    market.amm.user_lp_shares = market
        .amm
        .user_lp_shares
        .checked_sub(shares_to_burn)
        .ok_or_else(math_error!())?;

    // update market state
    let new_sqrt_k = market
        .amm
        .sqrt_k
        .checked_sub(shares_to_burn)
        .ok_or_else(math_error!())?;
    let new_sqrt_k_u192 = U192::from(new_sqrt_k);

    let update_k_result = get_update_k_result(market, new_sqrt_k_u192, false)?;
    update_k(market, &update_k_result)?;

    Ok(())
}

#[cfg(test)]
mod test {
    use super::*;
    use crate::math::constants::AMM_RESERVE_PRECISION;
    use crate::state::market::AMM;
    use crate::state::user::MarketPosition;

    #[test]
    fn test_full_long_settle() {
        let mut position = MarketPosition {
            lp_shares: 100 * AMM_RESERVE_PRECISION,
            ..MarketPosition::default()
        };

        let mut amm = AMM {
            market_position_per_lp: MarketPosition {
                base_asset_amount: 10,
                quote_asset_amount: -10,
                ..MarketPosition::default()
            },
            user_lp_shares: position.lp_shares,
            base_asset_amount_step_size: 1,
            ..AMM::default_test()
        };
        amm.sqrt_k += position.lp_shares;

        let mut market = Market {
            amm,
            ..Market::default_test()
        };
        let og_market = market;

        settle_lp_position(&mut position, &mut market).unwrap();

        assert_eq!(position.last_net_base_asset_amount_per_lp, 10);
        assert_eq!(position.last_net_quote_asset_amount_per_lp, -10);
        assert_eq!(position.base_asset_amount, 10 * 100);
        assert_eq!(position.quote_asset_amount, -10 * 100);
        assert_eq!(
            og_market.amm.net_unsettled_lp_base_asset_amount + 10 * 100,
            market.amm.net_unsettled_lp_base_asset_amount
        );
        // net baa doesnt change
        assert_eq!(
            og_market.amm.net_base_asset_amount,
            market.amm.net_base_asset_amount
        );

        // burn
        let lp_shares = position.lp_shares;
        burn_lp_shares(&mut position, &mut market, lp_shares, 0).unwrap();
        assert_eq!(position.lp_shares, 0);
        assert_eq!(
            og_market.amm.sqrt_k - 100 * AMM_RESERVE_PRECISION,
            market.amm.sqrt_k
        );
    }

    #[test]
    fn test_full_short_settle() {
        let mut position = MarketPosition {
            lp_shares: 100 * AMM_RESERVE_PRECISION,
            ..MarketPosition::default()
        };

        let amm = AMM {
            market_position_per_lp: MarketPosition {
                base_asset_amount: -10,
                quote_asset_amount: 10,
                ..MarketPosition::default()
            },
            user_lp_shares: 100 * AMM_RESERVE_PRECISION,
            base_asset_amount_step_size: 1,
            ..AMM::default_test()
        };

        let mut market = Market {
            amm,
            ..Market::default_test()
        };

        settle_lp_position(&mut position, &mut market).unwrap();

        assert_eq!(position.last_net_base_asset_amount_per_lp, -10);
        assert_eq!(position.last_net_quote_asset_amount_per_lp, 10);
        assert_eq!(position.base_asset_amount, -10 * 100);
        assert_eq!(position.quote_asset_amount, 10 * 100);
    }

    #[test]
    fn test_partial_short_settle() {
        let mut position = MarketPosition {
            lp_shares: AMM_RESERVE_PRECISION,
            ..MarketPosition::default()
        };

        let mut amm = AMM {
            market_position_per_lp: MarketPosition {
                base_asset_amount: -10,
                quote_asset_amount: 10,
                ..MarketPosition::default()
            },
            user_lp_shares: position.lp_shares,
            base_asset_amount_step_size: 3,
            ..AMM::default_test()
        };
        amm.sqrt_k += position.lp_shares;

        let mut market = Market {
            amm,
            ..Market::default_test()
        };

        settle_lp_position(&mut position, &mut market).unwrap();

        assert_eq!(position.base_asset_amount, -9);
        assert_eq!(position.quote_asset_amount, 10);
        assert_eq!(position.last_net_base_asset_amount_per_lp, -9);
        assert_eq!(position.last_net_quote_asset_amount_per_lp, 10);

        // burn
        let _position = position;
        let lp_shares = position.lp_shares;
        burn_lp_shares(&mut position, &mut market, lp_shares, 0).unwrap();
        assert_eq!(position.lp_shares, 0);
        // assert_eq!(
        //     _position.quote_asset_amount - 2,
        //     position.quote_asset_amount
        // );
    }

    #[test]
    fn test_partial_long_settle() {
        let mut position = MarketPosition {
            lp_shares: AMM_RESERVE_PRECISION,
            ..MarketPosition::default()
        };

        let amm = AMM {
            market_position_per_lp: MarketPosition {
                base_asset_amount: -10,
                quote_asset_amount: 10,
                ..MarketPosition::default()
            },
            base_asset_amount_step_size: 3,
            ..AMM::default_test()
        };

        let mut market = Market {
            amm,
            ..Market::default_test()
        };

        settle_lp_position(&mut position, &mut market).unwrap();

        assert_eq!(position.base_asset_amount, -9);
        assert_eq!(position.quote_asset_amount, 10);
        assert_eq!(position.last_net_base_asset_amount_per_lp, -9);
        assert_eq!(position.last_net_quote_asset_amount_per_lp, 10);
    }
}
