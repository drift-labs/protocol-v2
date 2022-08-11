use solana_program::msg;

use crate::controller::position::PositionDirection;
use crate::error::ClearingHouseResult;
use crate::get_then_update_id;
use crate::math::amm::{
    calculate_quote_asset_amount_swapped, calculate_spread_reserves, get_spread_reserves,
    get_update_k_result,
};
use crate::math::bank_balance::get_token_amount;
use crate::math::casting::{cast_to_i128, cast_to_i64, cast_to_u128};
use crate::math::constants::PRICE_TO_PEG_PRECISION_RATIO;
use crate::math::{amm, bn, quote_asset::*};
use crate::math_error;
use crate::state::events::CurveRecord;
use crate::state::market::{Market, AMM};
use crate::state::oracle::OraclePriceData;
use anchor_lang::prelude::*;
use std::cmp::{max, min};

use crate::controller::bank_balance::update_bank_balances;
use crate::controller::repeg::apply_cost_to_market;
use crate::state::bank::{Bank, BankBalance, BankBalanceType};

#[derive(Clone, Copy, PartialEq)]
pub enum SwapDirection {
    Add,
    Remove,
}

fn calculate_quote_asset_amount_surplus(
    quote_asset_reserve_before: u128,
    quote_asset_reserve_after: u128,
    swap_direction: SwapDirection,
    peg_multiplier: u128,
    initial_quote_asset_amount: u128,
    round_down: bool,
) -> ClearingHouseResult<u128> {
    let quote_asset_reserve_change = match swap_direction {
        SwapDirection::Add => quote_asset_reserve_before
            .checked_sub(quote_asset_reserve_after)
            .ok_or_else(math_error!())?,

        SwapDirection::Remove => quote_asset_reserve_after
            .checked_sub(quote_asset_reserve_before)
            .ok_or_else(math_error!())?,
    };

    let mut actual_quote_asset_amount =
        reserve_to_asset_amount(quote_asset_reserve_change, peg_multiplier)?;

    // Compensate for +1 quote asset amount added when removing base asset
    if round_down {
        actual_quote_asset_amount = actual_quote_asset_amount
            .checked_add(1)
            .ok_or_else(math_error!())?;
    }

    let quote_asset_amount_surplus = if actual_quote_asset_amount > initial_quote_asset_amount {
        actual_quote_asset_amount
            .checked_sub(initial_quote_asset_amount)
            .ok_or_else(math_error!())?
    } else {
        initial_quote_asset_amount
            .checked_sub(actual_quote_asset_amount)
            .ok_or_else(math_error!())?
    };

    Ok(quote_asset_amount_surplus)
}

pub fn swap_base_asset(
    amm: &mut AMM,
    base_asset_swap_amount: u128,
    direction: SwapDirection,
    now: i64,
    precomputed_mark_price: Option<u128>,
) -> ClearingHouseResult<(u128, u128)> {
    let position_direction = match direction {
        SwapDirection::Add => PositionDirection::Short,
        SwapDirection::Remove => PositionDirection::Long,
    };

    let mark_price = match precomputed_mark_price {
        Some(mark_price) => mark_price,
        None => amm.mark_price()?,
    };

    amm::update_mark_twap(
        amm,
        now,
        Some(match position_direction {
            PositionDirection::Long => amm.ask_price(mark_price)?,
            PositionDirection::Short => amm.bid_price(mark_price)?,
        }),
        Some(position_direction),
    )?;

    let (
        new_base_asset_reserve,
        new_quote_asset_reserve,
        quote_asset_amount,
        quote_asset_amount_surplus,
    ) = calculate_base_swap_output_with_spread(amm, base_asset_swap_amount, direction)?;

    amm.base_asset_reserve = new_base_asset_reserve;
    amm.quote_asset_reserve = new_quote_asset_reserve;

    Ok((quote_asset_amount, quote_asset_amount_surplus))
}

pub fn calculate_base_swap_output_with_spread(
    amm: &AMM,
    base_asset_swap_amount: u128,
    direction: SwapDirection,
) -> ClearingHouseResult<(u128, u128, u128, u128)> {
    // first do the swap with spread reserves to figure out how much base asset is acquired
    let (base_asset_reserve_with_spread, quote_asset_reserve_with_spread) = get_spread_reserves(
        amm,
        match direction {
            SwapDirection::Add => PositionDirection::Short,
            SwapDirection::Remove => PositionDirection::Long,
        },
    )?;

    let (new_quote_asset_reserve_with_spread, _) = amm::calculate_swap_output(
        base_asset_swap_amount,
        base_asset_reserve_with_spread,
        direction,
        amm.sqrt_k,
    )?;

    let quote_asset_amount = calculate_quote_asset_amount_swapped(
        quote_asset_reserve_with_spread,
        new_quote_asset_reserve_with_spread,
        direction,
        amm.peg_multiplier,
    )?;

    let (new_quote_asset_reserve, new_base_asset_reserve) = amm::calculate_swap_output(
        base_asset_swap_amount,
        amm.base_asset_reserve,
        direction,
        amm.sqrt_k,
    )?;

    // calculate the quote asset surplus by taking the difference between what quote_asset_amount is
    // with and without spread
    let quote_asset_amount_surplus = calculate_quote_asset_amount_surplus(
        new_quote_asset_reserve,
        amm.quote_asset_reserve,
        match direction {
            SwapDirection::Remove => SwapDirection::Add,
            SwapDirection::Add => SwapDirection::Remove,
        },
        amm.peg_multiplier,
        quote_asset_amount,
        direction == SwapDirection::Remove,
    )?;

    Ok((
        new_base_asset_reserve,
        new_quote_asset_reserve,
        quote_asset_amount,
        quote_asset_amount_surplus,
    ))
}

#[allow(dead_code)]
fn calculate_base_swap_output_without_spread(
    amm: &mut AMM,
    base_asset_swap_amount: u128,
    direction: SwapDirection,
) -> ClearingHouseResult<(u128, u128, u128, u128)> {
    let initial_quote_asset_reserve = amm.quote_asset_reserve;
    let (new_quote_asset_reserve, new_base_asset_reserve) = amm::calculate_swap_output(
        base_asset_swap_amount,
        amm.base_asset_reserve,
        direction,
        amm.sqrt_k,
    )?;

    let quote_asset_amount = calculate_quote_asset_amount_swapped(
        initial_quote_asset_reserve,
        new_quote_asset_reserve,
        direction,
        amm.peg_multiplier,
    )?;

    Ok((
        new_base_asset_reserve,
        new_quote_asset_reserve,
        quote_asset_amount,
        0,
    ))
}

pub fn update_spreads(amm: &mut AMM, mark_price: u128) -> ClearingHouseResult<(u128, u128)> {
    let (long_spread, short_spread) = if amm.curve_update_intensity > 0 {
        amm::calculate_spread(
            amm.base_spread,
            amm.last_oracle_mark_spread_pct,
            amm.last_oracle_conf_pct,
            amm.max_spread,
            amm.quote_asset_reserve,
            amm.terminal_quote_asset_reserve,
            amm.peg_multiplier,
            amm.net_base_asset_amount,
            mark_price,
            amm.total_fee_minus_distributions,
        )?
    } else {
        let half_base_spread = (amm.base_spread / 2) as u128;
        (half_base_spread, half_base_spread)
    };

    amm.long_spread = long_spread;
    amm.short_spread = short_spread;

    let (new_ask_base_asset_reserve, new_ask_quote_asset_reserve) =
        calculate_spread_reserves(amm, PositionDirection::Long)?;
    let (new_bid_base_asset_reserve, new_bid_quote_asset_reserve) =
        calculate_spread_reserves(amm, PositionDirection::Short)?;

    amm.ask_base_asset_reserve = new_ask_base_asset_reserve;
    amm.bid_base_asset_reserve = new_bid_base_asset_reserve;
    amm.ask_quote_asset_reserve = new_ask_quote_asset_reserve;
    amm.bid_quote_asset_reserve = new_bid_quote_asset_reserve;

    Ok((long_spread, short_spread))
}

pub fn formulaic_update_k(
    market: &mut Market,
    _oracle_price_data: &OraclePriceData,
    funding_imbalance_cost: i128,
    now: i64,
    mark_price: u128,
) -> ClearingHouseResult {
    let peg_multiplier_before = market.amm.peg_multiplier;
    let base_asset_reserve_before = market.amm.base_asset_reserve;
    let quote_asset_reserve_before = market.amm.quote_asset_reserve;
    let sqrt_k_before = market.amm.sqrt_k;

    let funding_imbalance_cost_i64 = cast_to_i64(funding_imbalance_cost)?;

    // calculate budget
    let budget = if funding_imbalance_cost_i64 < 0 {
        // negative cost is period revenue, if spread is low give back half in k increase
        if max(market.amm.long_spread, market.amm.short_spread)
            <= cast_to_u128(market.amm.base_spread)?
        {
            funding_imbalance_cost_i64
                .checked_div(2)
                .ok_or_else(math_error!())?
                .abs()
        } else {
            0
        }
    } else if market.amm.net_revenue_since_last_funding < funding_imbalance_cost_i64 {
        // cost exceeded period revenue, take back half in k decrease
        max(0, market.amm.net_revenue_since_last_funding)
            .checked_sub(funding_imbalance_cost_i64)
            .ok_or_else(math_error!())?
            .checked_div(2)
            .ok_or_else(math_error!())?
    } else {
        0
    };

    if budget > 0 || (budget < 0 && market.amm.can_lower_k()?) {
        // single k scale is capped by .1% increase and 2.2% decrease (regardless of budget)
        let (k_scale_numerator, k_scale_denominator) =
            amm::calculate_budgeted_k_scale(market, cast_to_i128(budget)?, mark_price)?;

        let new_sqrt_k = bn::U192::from(market.amm.sqrt_k)
            .checked_mul(bn::U192::from(k_scale_numerator))
            .ok_or_else(math_error!())?
            .checked_div(bn::U192::from(k_scale_denominator))
            .ok_or_else(math_error!())?;

        let update_k_result = get_update_k_result(market, new_sqrt_k)?;

        let adjustment_cost = amm::adjust_k_cost(market, &update_k_result)?;

        let cost_applied = apply_cost_to_market(market, adjustment_cost, true)?;

        if cost_applied {
            amm::update_k(market, &update_k_result)?;

            let peg_multiplier_after = market.amm.peg_multiplier;
            let base_asset_reserve_after = market.amm.base_asset_reserve;
            let quote_asset_reserve_after = market.amm.quote_asset_reserve;
            let sqrt_k_after = market.amm.sqrt_k;

            emit!(CurveRecord {
                ts: now,
                record_id: get_then_update_id!(market, next_curve_record_id),
                market_index: market.market_index,
                peg_multiplier_before,
                base_asset_reserve_before,
                quote_asset_reserve_before,
                sqrt_k_before,
                peg_multiplier_after,
                base_asset_reserve_after,
                quote_asset_reserve_after,
                sqrt_k_after,
                base_asset_amount_long: market.base_asset_amount_long.unsigned_abs(),
                base_asset_amount_short: market.base_asset_amount_short.unsigned_abs(),
                net_base_asset_amount: market.amm.net_base_asset_amount,
                open_interest: market.open_interest,
                adjustment_cost,
                total_fee: market.amm.total_fee,
                total_fee_minus_distributions: market.amm.total_fee_minus_distributions,
                oracle_price: market.amm.last_oracle_price,
                fill_record: market.next_fill_record_id as u128,
            });
        }
    }
    Ok(())
}

pub fn update_pool_balances(
    market: &mut Market,
    bank: &mut Bank,
    user_unsettled_pnl: i128,
) -> ClearingHouseResult<i128> {
    // current bank balance of amm fee pool
    let amm_fee_pool_token_amount = cast_to_i128(get_token_amount(
        market.amm.fee_pool.balance(),
        bank,
        market.amm.fee_pool.balance_type(),
    )?)?;

    let mut fraction_for_amm = 100;

    if market.amm.total_fee_minus_distributions <= amm_fee_pool_token_amount {
        // owe the market pnl pool before settling user
        let pnl_pool_addition = max(0, market.amm.total_fee_minus_distributions)
            .checked_sub(amm_fee_pool_token_amount)
            .ok_or_else(math_error!())?;

        if pnl_pool_addition < 0 {
            update_bank_balances(
                pnl_pool_addition.unsigned_abs(),
                &BankBalanceType::Borrow,
                bank,
                &mut market.amm.fee_pool,
            )?;

            update_bank_balances(
                pnl_pool_addition.unsigned_abs(),
                &BankBalanceType::Deposit,
                bank,
                &mut market.pnl_pool,
            )?;
        }

        fraction_for_amm = 0;
    }

    // market pnl pool pays (what it can to) user_unsettled_pnl and pnl_to_settle_to_amm
    let pnl_pool_token_amount = get_token_amount(
        market.pnl_pool.balance(),
        bank,
        market.pnl_pool.balance_type(),
    )?;

    let pnl_to_settle_with_user = if user_unsettled_pnl > 0 {
        min(user_unsettled_pnl, cast_to_i128(pnl_pool_token_amount)?)
    } else {
        user_unsettled_pnl
    };

    let pnl_fraction_for_amm = if fraction_for_amm > 0 {
        let pnl_fraction_for_amm = pnl_to_settle_with_user
            .checked_div(fraction_for_amm)
            .ok_or_else(math_error!())?;
        update_bank_balances(
            pnl_fraction_for_amm.unsigned_abs(),
            &BankBalanceType::Deposit,
            bank,
            &mut market.amm.fee_pool,
        )?;
        pnl_fraction_for_amm
    } else {
        0
    };

    let pnl_to_settle_with_market = -(pnl_to_settle_with_user
        .checked_sub(pnl_fraction_for_amm)
        .ok_or_else(math_error!())?);

    update_bank_balances(
        pnl_to_settle_with_market.unsigned_abs(),
        if pnl_to_settle_with_market >= 0 {
            &BankBalanceType::Deposit
        } else {
            &BankBalanceType::Borrow
        },
        bank,
        &mut market.pnl_pool,
    )?;

    Ok(pnl_to_settle_with_user)
}

pub fn move_price(
    amm: &mut AMM,
    base_asset_reserve: u128,
    quote_asset_reserve: u128,
) -> ClearingHouseResult {
    amm.base_asset_reserve = base_asset_reserve;
    amm.quote_asset_reserve = quote_asset_reserve;

    let k = bn::U256::from(base_asset_reserve)
        .checked_mul(bn::U256::from(quote_asset_reserve))
        .ok_or_else(math_error!())?;

    amm.sqrt_k = k.integer_sqrt().try_to_u128()?;

    Ok(())
}

#[allow(dead_code)]
pub fn move_to_price(amm: &mut AMM, target_price: u128) -> ClearingHouseResult {
    let sqrt_k = bn::U256::from(amm.sqrt_k);
    let k = sqrt_k.checked_mul(sqrt_k).ok_or_else(math_error!())?;

    let new_base_asset_amount_squared = k
        .checked_mul(bn::U256::from(amm.peg_multiplier))
        .ok_or_else(math_error!())?
        .checked_mul(bn::U256::from(PRICE_TO_PEG_PRECISION_RATIO))
        .ok_or_else(math_error!())?
        .checked_div(bn::U256::from(target_price))
        .ok_or_else(math_error!())?;

    let new_base_asset_amount = new_base_asset_amount_squared.integer_sqrt();
    let new_quote_asset_amount = k
        .checked_div(new_base_asset_amount)
        .ok_or_else(math_error!())?;

    amm.base_asset_reserve = new_base_asset_amount.try_to_u128()?;
    amm.quote_asset_reserve = new_quote_asset_amount.try_to_u128()?;

    Ok(())
}

#[cfg(test)]
mod test {
    use super::*;
    use crate::math::constants::{
        AMM_RESERVE_PRECISION, BANK_CUMULATIVE_INTEREST_PRECISION, MARK_PRICE_PRECISION,
        QUOTE_PRECISION,
    };
    #[test]
    fn formualic_k_tests() {
        let mut market = Market {
            amm: AMM {
                base_asset_reserve: 5122950819670000,
                quote_asset_reserve: 488 * AMM_RESERVE_PRECISION,
                sqrt_k: 500 * AMM_RESERVE_PRECISION,
                peg_multiplier: 50000,
                net_base_asset_amount: -122950819670000,
                total_fee_minus_distributions: 1000 * QUOTE_PRECISION as i128,
                curve_update_intensity: 100,
                ..AMM::default()
            },
            ..Market::default()
        };

        let prev_sqrt_k = market.amm.sqrt_k;

        let mark_price = market.amm.mark_price().unwrap();
        let now = 10000;
        let oracle_price_data = OraclePriceData {
            price: (50 * MARK_PRICE_PRECISION) as i128,
            confidence: 0,
            delay: 2,
            has_sufficient_number_of_data_points: true,
        };

        // zero funding cost
        let funding_cost: i128 = 0;
        formulaic_update_k(
            &mut market,
            &oracle_price_data,
            funding_cost,
            now,
            mark_price,
        )
        .unwrap();
        assert_eq!(prev_sqrt_k, market.amm.sqrt_k);

        // positive means amm supossedly paid $500 in funding payments for interval
        let funding_cost_2: i128 = (500 * QUOTE_PRECISION) as i128;
        formulaic_update_k(
            &mut market,
            &oracle_price_data,
            funding_cost_2,
            now,
            mark_price,
        )
        .unwrap();

        assert!(prev_sqrt_k > market.amm.sqrt_k);
        assert_eq!(market.amm.sqrt_k, 4890000000000000); // max k decrease (2.2%)
        assert_eq!(market.amm.total_fee_minus_distributions, 1000332075); //$.33 acquired from slippage increase

        // negative means amm recieved $500 in funding payments for interval
        let funding_cost_2: i128 = -((500 * QUOTE_PRECISION) as i128);
        formulaic_update_k(
            &mut market,
            &oracle_price_data,
            funding_cost_2,
            now,
            mark_price,
        )
        .unwrap();

        assert_eq!(market.amm.sqrt_k, 4894890000000000); // max k increase (.1%)
        assert_eq!(market.amm.total_fee_minus_distributions, 1000316988); //$.33 acquired from slippage increase

        // negative means amm recieved $.001 in funding payments for interval
        let funding_cost_2: i128 = -((QUOTE_PRECISION / 1000) as i128);
        formulaic_update_k(
            &mut market,
            &oracle_price_data,
            funding_cost_2,
            now,
            mark_price,
        )
        .unwrap();

        assert_eq!(market.amm.sqrt_k, 4895052229261371); // increase k by 1.00003314258x
        assert_eq!(market.amm.total_fee_minus_distributions, 1000316491); // ~$.005 spent from slippage decrease
                                                                          // todo: (316988-316491)/1e6 * 2 = 0.000994 < .001
    }

    #[test]
    fn update_pool_balances_test() {
        let mut market = Market {
            amm: AMM {
                base_asset_reserve: 5122950819670000,
                quote_asset_reserve: 488 * AMM_RESERVE_PRECISION,
                sqrt_k: 500 * AMM_RESERVE_PRECISION,
                peg_multiplier: 50000,
                net_base_asset_amount: -122950819670000,
                total_fee_minus_distributions: 1000 * QUOTE_PRECISION as i128,
                curve_update_intensity: 100,
                ..AMM::default()
            },
            ..Market::default()
        };

        let mut bank = Bank {
            cumulative_deposit_interest: BANK_CUMULATIVE_INTEREST_PRECISION,
            cumulative_borrow_interest: BANK_CUMULATIVE_INTEREST_PRECISION,
            ..Bank::default()
        };
        let to_settle_with_user = update_pool_balances(&mut market, &mut bank, 100).unwrap();
        assert_eq!(to_settle_with_user, 0);

        let to_settle_with_user = update_pool_balances(&mut market, &mut bank, -100).unwrap();
        assert_eq!(to_settle_with_user, -100);
        assert!(market.amm.fee_pool.balance() > 0);

        let amm_fee_pool_token_amount = get_token_amount(
            market.amm.fee_pool.balance(),
            &bank,
            market.amm.fee_pool.balance_type(),
        )
        .unwrap();
        let pnl_pool_token_amount = get_token_amount(
            market.pnl_pool.balance(),
            &bank,
            market.pnl_pool.balance_type(),
        )
        .unwrap();
        assert_eq!(pnl_pool_token_amount, 99);
        assert_eq!(amm_fee_pool_token_amount, 1);

        let to_settle_with_user = update_pool_balances(&mut market, &mut bank, 100).unwrap();
        assert_eq!(to_settle_with_user, 99);
        let amm_fee_pool_token_amount = get_token_amount(
            market.amm.fee_pool.balance(),
            &bank,
            market.amm.fee_pool.balance_type(),
        )
        .unwrap();
        let pnl_pool_token_amount = get_token_amount(
            market.pnl_pool.balance(),
            &bank,
            market.pnl_pool.balance_type(),
        )
        .unwrap();
        assert_eq!(pnl_pool_token_amount, 0);
        assert_eq!(amm_fee_pool_token_amount, 1);

        market.amm.total_fee_minus_distributions = 0;
        update_pool_balances(&mut market, &mut bank, -1).unwrap();
        let amm_fee_pool_token_amount = get_token_amount(
            market.amm.fee_pool.balance(),
            &bank,
            market.amm.fee_pool.balance_type(),
        )
        .unwrap();
        let pnl_pool_token_amount = get_token_amount(
            market.pnl_pool.balance(),
            &bank,
            market.pnl_pool.balance_type(),
        )
        .unwrap();
        assert_eq!(pnl_pool_token_amount, 2);
        assert_eq!(amm_fee_pool_token_amount, 0);

        market.amm.total_fee_minus_distributions = 90_000 * QUOTE_PRECISION as i128;
        update_pool_balances(&mut market, &mut bank, -(100_000 * QUOTE_PRECISION as i128)).unwrap();
        let amm_fee_pool_token_amount = get_token_amount(
            market.amm.fee_pool.balance(),
            &bank,
            market.amm.fee_pool.balance_type(),
        )
        .unwrap();
        let pnl_pool_token_amount = get_token_amount(
            market.pnl_pool.balance(),
            &bank,
            market.pnl_pool.balance_type(),
        )
        .unwrap();
        assert_eq!(pnl_pool_token_amount, 99_000_000_000 + 2);
        assert_eq!(amm_fee_pool_token_amount, (1_000 * QUOTE_PRECISION));

        // negative fee pool
        market.amm.total_fee_minus_distributions = -8_008_123_456;

        update_pool_balances(&mut market, &mut bank, 1_000_987_789).unwrap();
        let amm_fee_pool_token_amount = get_token_amount(
            market.amm.fee_pool.balance(),
            &bank,
            market.amm.fee_pool.balance_type(),
        )
        .unwrap();
        let pnl_pool_token_amount = get_token_amount(
            market.pnl_pool.balance(),
            &bank,
            market.pnl_pool.balance_type(),
        )
        .unwrap();
        assert_eq!(pnl_pool_token_amount, 99_000_000_000 + 2 - 987_789);
        assert_eq!(amm_fee_pool_token_amount, 0);
    }
}
