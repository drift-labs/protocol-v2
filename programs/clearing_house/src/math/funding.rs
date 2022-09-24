use crate::error::{ClearingHouseResult, ErrorCode};
use crate::math::bn;
use crate::math::casting::{cast, cast_to_i128};
use crate::math::constants::{
    AMM_TO_QUOTE_PRECISION_RATIO, FUNDING_RATE_BUFFER, ONE_HOUR, PRICE_PRECISION,
    QUOTE_TO_BASE_AMT_FUNDING_PRECISION,
};
use crate::math::repeg::{calculate_fee_pool, get_total_fee_lower_bound};
use crate::math_error;
use crate::state::market::PerpMarket;
use crate::state::user::PerpPosition;
use solana_program::msg;
use std::cmp::{max, min};

pub fn calculate_funding_rate(
    mid_price_twap: u128,
    oracle_price_twap: i128,
    funding_period: i64,
) -> ClearingHouseResult<i128> {
    // funding period = 1 hour, window = 1 day
    // low periodicity => quickly updating/settled funding rates
    //                 => lower funding rate payment per interval
    let period_adjustment = (24_i128)
        .checked_mul(ONE_HOUR)
        .ok_or_else(math_error!())?
        .checked_div(max(ONE_HOUR, funding_period as i128))
        .ok_or_else(math_error!())?;

    let price_spread = cast_to_i128(mid_price_twap)?
        .checked_sub(oracle_price_twap)
        .ok_or_else(math_error!())?;

    // clamp price divergence to 3% for funding rate calculation
    let max_price_spread = oracle_price_twap
        .checked_div(33)
        .ok_or_else(math_error!())?; // 3%
    let clamped_price_spread = max(-max_price_spread, min(price_spread, max_price_spread));

    let funding_rate = clamped_price_spread
        .checked_mul(cast(FUNDING_RATE_BUFFER)?)
        .ok_or_else(math_error!())?
        .checked_div(cast(period_adjustment)?)
        .ok_or_else(math_error!())?;

    Ok(funding_rate)
}

/// With a virtual AMM, there can be an imbalance between longs and shorts and thus funding can be asymmetric.
/// To account for this, amm keeps track of the cumulative funding rate for both longs and shorts.
/// When there is a period with asymmetric funding, the clearing house will pay/receive funding from/to it's collected fees.
pub fn calculate_funding_rate_long_short(
    market: &mut PerpMarket,
    funding_rate: i128,
) -> ClearingHouseResult<(i128, i128, i128)> {
    // Calculate the funding payment owed by the net_market_position if funding is not capped
    // If the net market position owes funding payment, the clearing house receives payment
    let settled_net_market_position = market
        .amm
        .net_base_asset_amount
        .checked_add(market.amm.net_unsettled_lp_base_asset_amount)
        .ok_or_else(math_error!())?;

    let net_market_position_funding_payment =
        calculate_funding_payment_in_quote_precision(funding_rate, settled_net_market_position)?;
    let uncapped_funding_pnl = -net_market_position_funding_payment;

    // If the uncapped_funding_pnl is positive, the clearing house receives money.
    if uncapped_funding_pnl >= 0 {
        market.amm.total_fee_minus_distributions = market
            .amm
            .total_fee_minus_distributions
            .checked_add(uncapped_funding_pnl)
            .ok_or_else(math_error!())?;

        market.amm.net_revenue_since_last_funding = market
            .amm
            .net_revenue_since_last_funding
            .checked_add(uncapped_funding_pnl as i64)
            .ok_or_else(math_error!())?;

        return Ok((funding_rate, funding_rate, uncapped_funding_pnl));
    }

    let (capped_funding_rate, capped_funding_pnl) =
        calculate_capped_funding_rate(market, uncapped_funding_pnl, funding_rate)?;

    let new_total_fee_minus_distributions = market
        .amm
        .total_fee_minus_distributions
        .checked_add(capped_funding_pnl)
        .ok_or_else(math_error!())?;

    // clearing house is paying part of funding imbalance
    if capped_funding_pnl != 0 {
        let total_fee_minus_distributions_lower_bound =
            cast_to_i128(get_total_fee_lower_bound(market)?)?;

        // makes sure the clearing house doesn't pay more than the share of fees allocated to `distributions`
        if new_total_fee_minus_distributions < total_fee_minus_distributions_lower_bound {
            return Err(ErrorCode::InvalidFundingProfitability);
        }
    }
    market.amm.total_fee_minus_distributions = new_total_fee_minus_distributions;
    market.amm.net_revenue_since_last_funding = market
        .amm
        .net_revenue_since_last_funding
        .checked_sub(capped_funding_pnl.unsigned_abs() as i64)
        .ok_or_else(math_error!())?;

    let funding_rate_long = if funding_rate < 0 {
        capped_funding_rate
    } else {
        funding_rate
    };

    let funding_rate_short = if funding_rate > 0 {
        capped_funding_rate
    } else {
        funding_rate
    };

    Ok((funding_rate_long, funding_rate_short, uncapped_funding_pnl))
}

fn calculate_capped_funding_rate(
    market: &PerpMarket,
    uncapped_funding_pnl: i128, // if negative, users would net recieve from clearinghouse
    funding_rate: i128,
) -> ClearingHouseResult<(i128, i128)> {
    // The funding_rate_pnl_limit is the amount of fees the clearing house can use before it hits it's lower bound
    let fee_pool = calculate_fee_pool(market)?;

    // limit to 1/3 of current fee pool per funding period
    let funding_rate_pnl_limit = -cast_to_i128(fee_pool)?
        .checked_div(3)
        .ok_or_else(math_error!())?;

    // if theres enough in fees, give user's uncapped funding
    // if theres a little/nothing in fees, give the user's capped outflow funding
    let capped_funding_pnl = max(uncapped_funding_pnl, funding_rate_pnl_limit);
    let capped_funding_rate = if uncapped_funding_pnl < funding_rate_pnl_limit {
        // Calculate how much funding payment is already available from users
        let funding_payment_from_users = calculate_funding_payment_in_quote_precision(
            funding_rate,
            if funding_rate > 0 {
                market.base_asset_amount_long
            } else {
                market.base_asset_amount_short
            },
        )?;

        // increase the funding_rate_pnl_limit by accounting for the funding payment already being made by users
        // this makes it so that the capped rate includes funding payments from users and clearing house collected fees
        let funding_rate_pnl_limit = funding_rate_pnl_limit
            .checked_sub(funding_payment_from_users.abs())
            .ok_or_else(math_error!())?;

        if funding_rate < 0 {
            // longs receive
            calculate_funding_rate_from_pnl_limit(
                funding_rate_pnl_limit,
                market.base_asset_amount_long,
            )?
        } else {
            // shorts receive
            calculate_funding_rate_from_pnl_limit(
                funding_rate_pnl_limit,
                market.base_asset_amount_short,
            )?
        }
    } else {
        funding_rate
    };

    Ok((capped_funding_rate, capped_funding_pnl))
}

pub fn calculate_funding_payment(
    amm_cumulative_funding_rate: i128,
    market_position: &PerpPosition,
) -> ClearingHouseResult<i128> {
    let funding_rate_delta = amm_cumulative_funding_rate
        .checked_sub(market_position.last_cumulative_funding_rate)
        .ok_or_else(math_error!())?;

    if funding_rate_delta == 0 {
        return Ok(0);
    }

    let funding_rate_payment =
        _calculate_funding_payment(funding_rate_delta, market_position.base_asset_amount)?;

    Ok(funding_rate_payment)
}

fn _calculate_funding_payment(
    funding_rate_delta: i128,
    base_asset_amount: i128,
) -> ClearingHouseResult<i128> {
    let funding_rate_delta_sign: i128 = if funding_rate_delta > 0 { 1 } else { -1 };

    let funding_rate_payment_magnitude = cast_to_i128(
        bn::U192::from(funding_rate_delta.unsigned_abs())
            .checked_mul(bn::U192::from(base_asset_amount.unsigned_abs()))
            .ok_or_else(math_error!())?
            .checked_div(bn::U192::from(PRICE_PRECISION))
            .ok_or_else(math_error!())?
            .checked_div(bn::U192::from(FUNDING_RATE_BUFFER))
            .ok_or_else(math_error!())?
            .try_to_u128()?,
    )?;

    // funding_rate: longs pay shorts
    let funding_rate_payment_sign: i128 = if base_asset_amount > 0 { -1 } else { 1 };

    let funding_rate_payment = (funding_rate_payment_magnitude)
        .checked_mul(funding_rate_payment_sign)
        .ok_or_else(math_error!())?
        .checked_mul(funding_rate_delta_sign)
        .ok_or_else(math_error!())?;

    Ok(funding_rate_payment)
}

fn calculate_funding_rate_from_pnl_limit(
    pnl_limit: i128,
    base_asset_amount: i128,
) -> ClearingHouseResult<i128> {
    if base_asset_amount == 0 {
        return Ok(0);
    }

    let pnl_limit_biased = if pnl_limit < 0 {
        pnl_limit.checked_add(1).ok_or_else(math_error!())?
    } else {
        pnl_limit
    };

    pnl_limit_biased
        .checked_mul(QUOTE_TO_BASE_AMT_FUNDING_PRECISION)
        .ok_or_else(math_error!())?
        .checked_div(base_asset_amount)
        .ok_or_else(math_error!())
}

pub fn calculate_funding_payment_in_quote_precision(
    funding_rate_delta: i128,
    base_asset_amount: i128,
) -> ClearingHouseResult<i128> {
    let funding_payment = _calculate_funding_payment(funding_rate_delta, base_asset_amount)?;
    let funding_payment_collateral = funding_payment
        .checked_div(cast_to_i128(AMM_TO_QUOTE_PRECISION_RATIO)?)
        .ok_or_else(math_error!())?;

    Ok(funding_payment_collateral)
}

#[cfg(test)]
mod test {
    use super::*;
    use crate::math::constants::{AMM_RESERVE_PRECISION, PRICE_PRECISION, QUOTE_PRECISION};
    use crate::state::market::{PerpMarket, AMM};
    use crate::state::oracle::HistoricalOracleData;
    #[test]
    fn capped_sym_funding_test() {
        // more shorts than longs, positive funding, 1/3 of fee pool too small
        let mut market = PerpMarket {
            base_asset_amount_long: 12295081967,
            base_asset_amount_short: -12295081967 * 2,
            amm: AMM {
                base_asset_reserve: 512295081967,
                quote_asset_reserve: 488 * AMM_RESERVE_PRECISION,
                sqrt_k: 500 * AMM_RESERVE_PRECISION,
                peg_multiplier: 50000000,
                net_base_asset_amount: -12295081967,
                total_exchange_fee: QUOTE_PRECISION / 2,
                total_fee_minus_distributions: (QUOTE_PRECISION as i128) / 2,

                last_mark_price_twap: 50 * PRICE_PRECISION,
                historical_oracle_data: HistoricalOracleData {
                    last_oracle_price_twap: (49 * PRICE_PRECISION) as i128,

                    ..HistoricalOracleData::default()
                },
                funding_period: 3600,

                ..AMM::default()
            },
            ..PerpMarket::default()
        };

        let balanced_funding = calculate_funding_rate(
            market.amm.last_mark_price_twap,
            market.amm.historical_oracle_data.last_oracle_price_twap,
            market.amm.funding_period,
        )
        .unwrap();

        assert_eq!(balanced_funding, 41666666);

        let (long_funding, short_funding, _) =
            calculate_funding_rate_long_short(&mut market, balanced_funding).unwrap();

        assert_eq!(long_funding, balanced_funding);
        assert!(long_funding > short_funding);
        assert_eq!(short_funding, 24222164);

        // only spend 1/3 of fee pool, ((.5-.416667)) * 3 < .25
        assert_eq!(market.amm.total_fee_minus_distributions, 416667);

        // more longs than shorts, positive funding, amm earns funding
        market = PerpMarket {
            base_asset_amount_long: 12295081967 * 2,
            base_asset_amount_short: -12295081967,
            amm: AMM {
                base_asset_reserve: 512295081967,
                quote_asset_reserve: 488 * AMM_RESERVE_PRECISION,
                sqrt_k: 500 * AMM_RESERVE_PRECISION,
                peg_multiplier: 50000000,
                net_base_asset_amount: 12295081967,
                total_exchange_fee: QUOTE_PRECISION / 2,
                total_fee_minus_distributions: (QUOTE_PRECISION as i128) / 2,
                last_mark_price_twap: 50 * PRICE_PRECISION,
                historical_oracle_data: HistoricalOracleData {
                    last_oracle_price_twap: (49 * PRICE_PRECISION) as i128,

                    ..HistoricalOracleData::default()
                },
                funding_period: 3600,

                ..AMM::default()
            },
            ..PerpMarket::default()
        };

        assert_eq!(balanced_funding, 41666666);

        let (long_funding, short_funding, _) =
            calculate_funding_rate_long_short(&mut market, balanced_funding).unwrap();

        assert_eq!(long_funding, balanced_funding);
        assert_eq!(long_funding, short_funding);
        let new_fees = market.amm.total_fee_minus_distributions;
        assert!(new_fees > QUOTE_PRECISION as i128 / 2);
        assert_eq!(new_fees, 1012295); // made over $.50
    }

    #[test]
    fn funding_unsettled_lps_amm_win_test() {
        // more shorts than longs, positive funding

        // positive net_unsettled_lp_base_asset_amount =
        // 1) lots of long users who have lp as counterparty
        // 2) the lps should be short but its unsettled...
        // 3) amm takes on the funding revenu/cost of those short LPs

        let mut market = PerpMarket {
            base_asset_amount_long: 12295081967,
            base_asset_amount_short: -12295081967 * 2,
            amm: AMM {
                base_asset_reserve: 512295081967,
                quote_asset_reserve: 488 * AMM_RESERVE_PRECISION,
                sqrt_k: 500 * AMM_RESERVE_PRECISION,
                peg_multiplier: 50000000,
                net_base_asset_amount: -12295081967, //~12
                net_unsettled_lp_base_asset_amount: (AMM_RESERVE_PRECISION * 500) as i128, //wowsers
                total_exchange_fee: QUOTE_PRECISION / 2,
                total_fee_minus_distributions: (QUOTE_PRECISION as i128) / 2,

                last_mark_price_twap: 50 * PRICE_PRECISION,
                historical_oracle_data: HistoricalOracleData {
                    last_oracle_price_twap: (49 * PRICE_PRECISION) as i128,

                    ..HistoricalOracleData::default()
                },
                funding_period: 3600,

                ..AMM::default()
            },
            ..PerpMarket::default()
        };

        let balanced_funding = calculate_funding_rate(
            market.amm.last_mark_price_twap,
            market.amm.historical_oracle_data.last_oracle_price_twap,
            market.amm.funding_period,
        )
        .unwrap();

        assert_eq!(balanced_funding, 41666666);
        assert_eq!(market.amm.total_fee_minus_distributions, 500000);

        let (long_funding, short_funding, _) =
            calculate_funding_rate_long_short(&mut market, balanced_funding).unwrap();

        let settled_net_market_position = market
            .amm
            .net_base_asset_amount
            .checked_add(market.amm.net_unsettled_lp_base_asset_amount)
            .unwrap();

        let net_market_position_funding_payment = calculate_funding_payment_in_quote_precision(
            balanced_funding,
            settled_net_market_position,
        )
        .unwrap();
        let uncapped_funding_pnl = -net_market_position_funding_payment;

        assert_eq!(market.amm.net_base_asset_amount, -12295081967);
        assert_eq!(market.amm.net_unsettled_lp_base_asset_amount, 500000000000);
        assert_eq!(settled_net_market_position, 487704918033);
        assert_eq!(net_market_position_funding_payment, -20321037);
        assert_eq!(uncapped_funding_pnl, 20321037); //clearing house revenue

        assert_eq!(long_funding, balanced_funding);
        assert_eq!(short_funding, balanced_funding);

        assert!(long_funding == short_funding);

        // making money off unsettled lps
        assert_eq!(market.amm.total_fee_minus_distributions, 20821037);

        // more longs than shorts, positive funding, amm earns funding
        market = PerpMarket {
            base_asset_amount_long: 12295081967 * 2,
            base_asset_amount_short: -12295081967,
            amm: AMM {
                base_asset_reserve: 512295081967,
                quote_asset_reserve: 488 * AMM_RESERVE_PRECISION,
                sqrt_k: 500 * AMM_RESERVE_PRECISION,
                peg_multiplier: 50000000,
                net_base_asset_amount: 12295081967,
                net_unsettled_lp_base_asset_amount: (AMM_RESERVE_PRECISION * 500) as i128, //wowsers
                total_exchange_fee: QUOTE_PRECISION / 2,
                total_fee_minus_distributions: (QUOTE_PRECISION as i128) / 2,
                last_mark_price_twap: 50 * PRICE_PRECISION,
                historical_oracle_data: HistoricalOracleData {
                    last_oracle_price_twap: (49 * PRICE_PRECISION) as i128,

                    ..HistoricalOracleData::default()
                },
                funding_period: 3600,

                ..AMM::default()
            },
            ..PerpMarket::default()
        };

        let balanced_funding = calculate_funding_rate(
            market.amm.last_mark_price_twap,
            market.amm.historical_oracle_data.last_oracle_price_twap,
            market.amm.funding_period,
        )
        .unwrap();
        assert_eq!(balanced_funding, 41666666);

        let (long_funding, short_funding, clearing_house_pnl) =
            calculate_funding_rate_long_short(&mut market, balanced_funding).unwrap();

        assert_eq!(clearing_house_pnl, 21345628);
        assert_eq!(long_funding, balanced_funding);
        assert_eq!(long_funding, short_funding);
        let new_fees = market.amm.total_fee_minus_distributions;
        assert!(new_fees > QUOTE_PRECISION as i128 / 2);
        assert_eq!(new_fees, 21845628); // made more
    }

    #[test]
    fn funding_unsettled_lps_amm_lose_test() {
        // more shorts than longs, positive funding

        // positive net_unsettled_lp_base_asset_amount =
        // 1) lots of long users who have lp as counterparty
        // 2) the lps should be short but its unsettled...
        // 3) amm takes on the funding revenu/cost of those short LPs

        let mut market = PerpMarket {
            base_asset_amount_long: 12295081967,
            base_asset_amount_short: -12295081967 * 2,
            amm: AMM {
                base_asset_reserve: 512295081967,
                quote_asset_reserve: 488 * AMM_RESERVE_PRECISION,
                sqrt_k: 500 * AMM_RESERVE_PRECISION,
                peg_multiplier: 50000000,
                net_base_asset_amount: -12295081967, //~12
                net_unsettled_lp_base_asset_amount: -((AMM_RESERVE_PRECISION * 500) as i128), //wowsers
                total_exchange_fee: QUOTE_PRECISION / 2,
                total_fee_minus_distributions: ((QUOTE_PRECISION * 99999) as i128),

                last_mark_price_twap: 50 * PRICE_PRECISION,
                historical_oracle_data: HistoricalOracleData {
                    last_oracle_price_twap: (49 * PRICE_PRECISION) as i128,

                    ..HistoricalOracleData::default()
                },
                funding_period: 3600,

                ..AMM::default()
            },
            ..PerpMarket::default()
        };

        let balanced_funding = calculate_funding_rate(
            market.amm.last_mark_price_twap,
            market.amm.historical_oracle_data.last_oracle_price_twap,
            market.amm.funding_period,
        )
        .unwrap();

        assert_eq!(balanced_funding, 41666666);
        assert_eq!(market.amm.total_fee_minus_distributions, 99999000000);

        let (long_funding, short_funding, _) =
            calculate_funding_rate_long_short(&mut market, balanced_funding).unwrap();

        let settled_net_market_position = market
            .amm
            .net_base_asset_amount
            .checked_add(market.amm.net_unsettled_lp_base_asset_amount)
            .unwrap();

        let net_market_position_funding_payment = calculate_funding_payment_in_quote_precision(
            balanced_funding,
            settled_net_market_position,
        )
        .unwrap();
        let uncapped_funding_pnl = -net_market_position_funding_payment;

        assert_eq!(market.amm.net_base_asset_amount, -12295081967);
        assert_eq!(market.amm.net_unsettled_lp_base_asset_amount, -500000000000);
        assert_eq!(settled_net_market_position, -512295081967);
        assert_eq!(net_market_position_funding_payment, 21345628);
        assert_eq!(uncapped_funding_pnl, -21345628); //clearing house loses $21

        assert_eq!(long_funding, balanced_funding);
        assert_eq!(short_funding, balanced_funding);

        assert!(long_funding == short_funding);

        // making money off unsettled lps
        assert_eq!(market.amm.total_fee_minus_distributions, 99977654372);

        // more longs than shorts, positive funding, amm earns funding
        market = PerpMarket {
            base_asset_amount_long: 12295081967 * 2,
            base_asset_amount_short: -12295081967,
            amm: AMM {
                base_asset_reserve: 512295081967,
                quote_asset_reserve: 488 * AMM_RESERVE_PRECISION,
                sqrt_k: 500 * AMM_RESERVE_PRECISION,
                peg_multiplier: 50000000,
                net_base_asset_amount: 12295081967,
                net_unsettled_lp_base_asset_amount: -((AMM_RESERVE_PRECISION * 500) as i128), //wowsers
                total_exchange_fee: QUOTE_PRECISION / 2,
                total_fee_minus_distributions: (QUOTE_PRECISION as i128) / 2,
                last_mark_price_twap: 50 * PRICE_PRECISION,
                historical_oracle_data: HistoricalOracleData {
                    last_oracle_price_twap: (49 * PRICE_PRECISION) as i128,

                    ..HistoricalOracleData::default()
                },
                funding_period: 3600,

                ..AMM::default()
            },
            ..PerpMarket::default()
        };

        let balanced_funding = calculate_funding_rate(
            market.amm.last_mark_price_twap,
            market.amm.historical_oracle_data.last_oracle_price_twap,
            market.amm.funding_period,
        )
        .unwrap();
        assert_eq!(balanced_funding, 41666666);

        let (long_funding, short_funding, clearing_house_pnl) =
            calculate_funding_rate_long_short(&mut market, balanced_funding).unwrap();

        assert_eq!(clearing_house_pnl, -20321037);
        assert_eq!(long_funding, balanced_funding);
        assert_eq!(short_funding, 90110989);
        assert_eq!(long_funding < short_funding, true);

        let new_fees = market.amm.total_fee_minus_distributions;
        assert_eq!(new_fees, 416667); // lost
    }
}
