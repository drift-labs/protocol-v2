use crate::error::ClearingHouseResult;
use crate::math::constants::{
    AMM_TO_QUOTE_PRECISION_RATIO_I128, BANK_IMF_PRECISION, BANK_WEIGHT_PRECISION,
    BID_ASK_SPREAD_PRECISION_I128, MARGIN_PRECISION,
};
use crate::math::position::{
    calculate_base_asset_value_and_pnl_with_oracle_price,
    calculate_base_asset_value_with_oracle_price,
};
use crate::math_error;

use crate::state::user::User;

use crate::math::bank_balance::get_balance_value_and_token_amount;
use crate::math::casting::cast_to_i128;
use crate::math::funding::calculate_funding_payment;
use crate::math::lp::{calculate_lp_open_bids_asks, calculate_settle_lp_metrics};
use crate::state::bank::{Bank, BankBalanceType};
use crate::state::bank_map::BankMap;
use crate::state::market::Market;
use crate::state::market_map::MarketMap;
use crate::state::oracle::OraclePriceData;
use crate::state::oracle_map::OracleMap;
use crate::state::user::{MarketPosition, UserBankBalance};
use num_integer::Roots;
use solana_program::msg;
use std::cmp::{max, min};

#[derive(Clone, Copy, PartialEq, Debug, Eq)]
pub enum MarginRequirementType {
    Initial,
    Maintenance,
}

pub fn calculate_size_premium_liability_weight(
    size: u128, // AMM_RESERVE_PRECISION
    imf_factor: u128,
    liability_weight: u128,
    precision: u128,
) -> ClearingHouseResult<u128> {
    if imf_factor == 0 {
        return Ok(liability_weight);
    }

    let size_sqrt = ((size / 1000) + 1).nth_root(2); //1e13 -> 1e10 -> 1e5

    let liability_weight_numerator = liability_weight
        .checked_sub(
            liability_weight
                .checked_div(max(1, BANK_IMF_PRECISION / imf_factor))
                .ok_or_else(math_error!())?,
        )
        .ok_or_else(math_error!())?;

    // increases
    let size_premium_liability_weight = liability_weight_numerator
        .checked_add(
            size_sqrt // 1e5
                .checked_mul(imf_factor)
                .ok_or_else(math_error!())?
                .checked_div(100_000 * BANK_IMF_PRECISION / precision) // 1e5 * 1e2
                .ok_or_else(math_error!())?,
        )
        .ok_or_else(math_error!())?;

    let max_liability_weight = max(liability_weight, size_premium_liability_weight);
    Ok(max_liability_weight)
}

pub fn calculate_size_discount_asset_weight(
    size: u128, // AMM_RESERVE_PRECISION
    imf_factor: u128,
    asset_weight: u128,
) -> ClearingHouseResult<u128> {
    if imf_factor == 0 {
        return Ok(asset_weight);
    }

    let size_sqrt = ((size / 1000) + 1).nth_root(2); //1e13 -> 1e10 -> 1e5
    let imf_numerator = BANK_IMF_PRECISION + BANK_IMF_PRECISION / 10;

    let size_discount_asset_weight = imf_numerator
        .checked_mul(BANK_WEIGHT_PRECISION)
        .ok_or_else(math_error!())?
        .checked_div(
            BANK_IMF_PRECISION
                .checked_add(
                    size_sqrt // 1e5
                        .checked_mul(imf_factor)
                        .ok_or_else(math_error!())?
                        .checked_div(100_000) // 1e5
                        .ok_or_else(math_error!())?,
                )
                .ok_or_else(math_error!())?,
        )
        .ok_or_else(math_error!())?;

    let min_asset_weight = min(asset_weight, size_discount_asset_weight);

    Ok(min_asset_weight)
}

pub fn calculate_bank_balance_value(
    user_bank_balance: &UserBankBalance,
    bank: &Bank,
    oracle_price_data: &OraclePriceData,
    margin_requirement_type: MarginRequirementType,
) -> ClearingHouseResult<u128> {
    let (balance_value, token_amount) =
        get_balance_value_and_token_amount(user_bank_balance, bank, oracle_price_data)?;

    let balance_equity_value = match user_bank_balance.balance_type {
        BankBalanceType::Deposit => balance_value
            .checked_mul(bank.get_asset_weight(token_amount, &margin_requirement_type)?)
            .ok_or_else(math_error!())?
            .checked_div(BANK_WEIGHT_PRECISION)
            .ok_or_else(math_error!())?,
        BankBalanceType::Borrow => balance_value
            .checked_mul(bank.get_liability_weight(token_amount, &margin_requirement_type)?)
            .ok_or_else(math_error!())?
            .checked_div(BANK_WEIGHT_PRECISION)
            .ok_or_else(math_error!())?,
    };

    Ok(balance_equity_value)
}

pub fn calculate_oracle_price_for_perp_margin(
    market_position: &MarketPosition,
    market: &Market,
    oracle_price_data: &OraclePriceData,
) -> ClearingHouseResult<i128> {
    let oracle_price_offset = min(
        (market.amm.max_spread as i128)
            .checked_mul(oracle_price_data.price)
            .ok_or_else(math_error!())?
            .checked_div(BID_ASK_SPREAD_PRECISION_I128)
            .ok_or_else(math_error!())?,
        cast_to_i128(oracle_price_data.confidence)?
            .checked_add(
                (market.amm.base_spread as i128)
                    .checked_mul(oracle_price_data.price)
                    .ok_or_else(math_error!())?
                    .checked_div(BID_ASK_SPREAD_PRECISION_I128)
                    .ok_or_else(math_error!())?,
            )
            .ok_or_else(math_error!())?,
    );
    let oracle_price = if market_position.base_asset_amount > 0 {
        oracle_price_data
            .price
            .checked_sub(oracle_price_offset)
            .ok_or_else(math_error!())?
    } else {
        oracle_price_data
            .price
            .checked_add(oracle_price_offset)
            .ok_or_else(math_error!())?
    };

    Ok(oracle_price)
}

pub fn calculate_perp_position_value_and_pnl(
    market_position: &MarketPosition,
    market: &Market,
    oracle_price_data: &OraclePriceData,
    margin_requirement_type: MarginRequirementType,
) -> ClearingHouseResult<(u128, i128)> {
    let unrealized_funding = calculate_funding_payment(
        if market_position.base_asset_amount > 0 {
            market.amm.cumulative_funding_rate_long
        } else {
            market.amm.cumulative_funding_rate_short
        },
        market_position,
    )?
    .checked_div(AMM_TO_QUOTE_PRECISION_RATIO_I128)
    .ok_or_else(math_error!())?;

    let market_position = if market_position.is_lp() {
        // compute lp metrics
        let lp_metrics = calculate_settle_lp_metrics(&market.amm, market_position)?;

        // compute settled position
        let base_asset_amount = market_position
            .base_asset_amount
            .checked_add(lp_metrics.base_asset_amount)
            .ok_or_else(math_error!())?;

        let mut quote_asset_amount = market_position
            .quote_asset_amount
            .checked_add(lp_metrics.quote_asset_amount)
            .ok_or_else(math_error!())?;

        // dust position in baa/qaa
        if lp_metrics.remainder_base_asset_amount != 0 {
            let dust_base_asset_value = calculate_base_asset_value_with_oracle_price(
                lp_metrics.remainder_base_asset_amount,
                oracle_price_data.price,
            )?
            .checked_add(1)
            .ok_or_else(math_error!())?;

            quote_asset_amount = quote_asset_amount
                .checked_sub(cast_to_i128(dust_base_asset_value)?)
                .ok_or_else(math_error!())?;
        }

        let (lp_bids, lp_asks) = calculate_lp_open_bids_asks(market_position, market)?;

        let open_bids = market_position
            .open_bids
            .checked_add(lp_bids)
            .ok_or_else(math_error!())?;

        let open_asks = market_position
            .open_asks
            .checked_add(lp_asks)
            .ok_or_else(math_error!())?;

        MarketPosition {
            base_asset_amount,
            quote_asset_amount,
            open_asks,
            open_bids,
            // this is ok because no other values are used in the future computations
            ..MarketPosition::default()
        }
    } else {
        *market_position
    };

    let oracle_price_for_upnl =
        calculate_oracle_price_for_perp_margin(&market_position, market, oracle_price_data)?;

    let (_, unrealized_pnl) = calculate_base_asset_value_and_pnl_with_oracle_price(
        &market_position,
        oracle_price_for_upnl,
    )?;

    let total_unsettled_pnl = unrealized_funding
        .checked_add(unrealized_pnl)
        .ok_or_else(math_error!())?;

    let worst_case_base_asset_amount = market_position.worst_case_base_asset_amount()?;

    let worse_case_base_asset_value = calculate_base_asset_value_with_oracle_price(
        worst_case_base_asset_amount,
        oracle_price_data.price,
    )?;

    let margin_ratio = market.get_margin_ratio(
        worst_case_base_asset_amount.unsigned_abs(),
        margin_requirement_type,
    )?;

    let margin_requirement = worse_case_base_asset_value
        .checked_mul(margin_ratio.into())
        .ok_or_else(math_error!())?
        .checked_div(MARGIN_PRECISION)
        .ok_or_else(math_error!())?;

    let unsettled_asset_weight =
        market.get_unsettled_asset_weight(total_unsettled_pnl, margin_requirement_type)?;

    let weighted_unsettled_pnl = total_unsettled_pnl
        .checked_mul(unsettled_asset_weight as i128)
        .ok_or_else(math_error!())?
        .checked_div(BANK_WEIGHT_PRECISION as i128)
        .ok_or_else(math_error!())?;

    Ok((margin_requirement, weighted_unsettled_pnl))
}

pub fn calculate_margin_requirement_and_total_collateral(
    user: &User,
    market_map: &MarketMap,
    margin_requirement_type: MarginRequirementType,
    bank_map: &BankMap,
    oracle_map: &mut OracleMap,
) -> ClearingHouseResult<(u128, i128)> {
    let mut total_collateral: i128 = 0;
    let mut margin_requirement: u128 = 0;

    for user_bank_balance in user.bank_balances.iter() {
        if user_bank_balance.balance == 0 {
            continue;
        }
        let bank = &bank_map.get_ref(&user_bank_balance.bank_index)?;
        let oracle_price_data = oracle_map.get_price_data(&bank.oracle)?;
        let bank_balance_value = calculate_bank_balance_value(
            user_bank_balance,
            bank,
            oracle_price_data,
            margin_requirement_type,
        )?;
        match user_bank_balance.balance_type {
            BankBalanceType::Deposit => {
                total_collateral = total_collateral
                    .checked_add(cast_to_i128(bank_balance_value)?)
                    .ok_or_else(math_error!())?;
            }
            BankBalanceType::Borrow => {
                margin_requirement = margin_requirement
                    .checked_add(bank_balance_value)
                    .ok_or_else(math_error!())?;
            }
        }
    }

    for market_position in user.positions.iter() {
        if market_position.base_asset_amount == 0
            && market_position.quote_asset_amount == 0
            && !market_position.has_open_order()
            && !market_position.is_lp()
        {
            continue;
        }

        let market = &market_map.get_ref(&market_position.market_index)?;

        let oracle_price_data = oracle_map.get_price_data(&market.amm.oracle)?;

        let (perp_margin_requirement, weighted_pnl) = calculate_perp_position_value_and_pnl(
            market_position,
            market,
            oracle_price_data,
            margin_requirement_type,
        )?;

        margin_requirement = margin_requirement
            .checked_add(perp_margin_requirement)
            .ok_or_else(math_error!())?;

        total_collateral = total_collateral
            .checked_add(weighted_pnl)
            .ok_or_else(math_error!())?;
    }

    Ok((margin_requirement, total_collateral))
}

pub fn calculate_net_quote_balance(
    user: &User,
    margin_requirement_type: MarginRequirementType,
    bank_map: &BankMap,
    oracle_map: &mut OracleMap,
) -> ClearingHouseResult<i128> {
    let mut net_quote_balance: i128 = 0;

    for user_bank_balance in user.bank_balances.iter() {
        if user_bank_balance.balance == 0 {
            continue;
        }

        let bank = &bank_map.get_ref(&user_bank_balance.bank_index)?;

        let oracle_price_data = oracle_map.get_price_data(&bank.oracle)?;
        let (balance_value, token_amount) =
            get_balance_value_and_token_amount(user_bank_balance, bank, oracle_price_data)?;

        match user_bank_balance.balance_type {
            BankBalanceType::Deposit => {
                net_quote_balance = net_quote_balance
                    .checked_add(cast_to_i128(
                        balance_value
                            .checked_mul(
                                bank.get_asset_weight(token_amount, &margin_requirement_type)?,
                            )
                            .ok_or_else(math_error!())?
                            .checked_div(BANK_WEIGHT_PRECISION)
                            .ok_or_else(math_error!())?,
                    )?)
                    .ok_or_else(math_error!())?;
            }
            BankBalanceType::Borrow => {
                net_quote_balance = net_quote_balance
                    .checked_sub(cast_to_i128(
                        balance_value
                            .checked_mul(
                                bank.get_liability_weight(token_amount, &margin_requirement_type)?,
                            )
                            .ok_or_else(math_error!())?
                            .checked_div(BANK_WEIGHT_PRECISION)
                            .ok_or_else(math_error!())?,
                    )?)
                    .ok_or_else(math_error!())?;
            }
        }
    }

    Ok(net_quote_balance)
}

pub fn meets_initial_margin_requirement(
    user: &User,
    market_map: &MarketMap,
    bank_map: &BankMap,
    oracle_map: &mut OracleMap,
) -> ClearingHouseResult<bool> {
    let (margin_requirement, total_collateral) = calculate_margin_requirement_and_total_collateral(
        user,
        market_map,
        MarginRequirementType::Initial,
        bank_map,
        oracle_map,
    )?;
    Ok(total_collateral >= cast_to_i128(margin_requirement)?)
}

pub fn meets_maintenance_margin_requirement(
    user: &User,
    market_map: &MarketMap,
    bank_map: &BankMap,
    oracle_map: &mut OracleMap,
) -> ClearingHouseResult<bool> {
    let (margin_requirement, total_collateral) = calculate_margin_requirement_and_total_collateral(
        user,
        market_map,
        MarginRequirementType::Maintenance,
        bank_map,
        oracle_map,
    )?;

    Ok(total_collateral >= cast_to_i128(margin_requirement)?)
}

#[cfg(test)]
mod test {
    use super::*;
    use crate::amm::calculate_swap_output;
    use crate::controller::amm::SwapDirection;
    use crate::math::collateral::calculate_updated_collateral;
    use crate::math::constants::{
        AMM_RESERVE_PRECISION, BANK_CUMULATIVE_INTEREST_PRECISION, BANK_IMF_PRECISION,
        MARK_PRICE_PRECISION, QUOTE_PRECISION,
    };
    use crate::math::position::calculate_position_pnl;
    use crate::state::bank::Bank;
    use crate::state::market::{Market, AMM};

    #[test]
    fn bank_asset_weight() {
        let mut bank = Bank {
            initial_asset_weight: 90,
            initial_liability_weight: 110,
            decimals: 6,
            imf_factor: 0,
            ..Bank::default()
        };

        let size = 1000 * QUOTE_PRECISION;
        let asset_weight = bank
            .get_asset_weight(size, &MarginRequirementType::Initial)
            .unwrap();
        assert_eq!(asset_weight, 90);

        let lib_weight = bank
            .get_liability_weight(size, &MarginRequirementType::Initial)
            .unwrap();
        assert_eq!(lib_weight, 110);

        bank.imf_factor = 10;
        let asset_weight = bank
            .get_asset_weight(size, &MarginRequirementType::Initial)
            .unwrap();
        assert_eq!(asset_weight, 90);

        let lib_weight = bank
            .get_liability_weight(size, &MarginRequirementType::Initial)
            .unwrap();
        assert_eq!(lib_weight, 110);

        let same_asset_weight_diff_imf_factor = 83;
        let asset_weight = bank
            .get_asset_weight(size * 1_000_000, &MarginRequirementType::Initial)
            .unwrap();
        assert_eq!(asset_weight, same_asset_weight_diff_imf_factor);

        bank.imf_factor = 10000;
        let asset_weight = bank
            .get_asset_weight(size, &MarginRequirementType::Initial)
            .unwrap();
        assert_eq!(asset_weight, same_asset_weight_diff_imf_factor);

        let lib_weight = bank
            .get_liability_weight(size, &MarginRequirementType::Initial)
            .unwrap();
        assert_eq!(lib_weight, 140);

        bank.imf_factor = BANK_IMF_PRECISION / 10;
        let asset_weight = bank
            .get_asset_weight(size, &MarginRequirementType::Initial)
            .unwrap();
        assert_eq!(asset_weight, 26);

        let lib_weight = bank
            .get_liability_weight(size, &MarginRequirementType::Initial)
            .unwrap();
        assert_eq!(lib_weight, 415);
    }

    #[test]
    fn negative_margin_user_test() {
        let bank = Bank {
            cumulative_deposit_interest: BANK_CUMULATIVE_INTEREST_PRECISION,
            cumulative_borrow_interest: BANK_CUMULATIVE_INTEREST_PRECISION,
            decimals: 6,
            ..Bank::default()
        };

        let user_bank_balance = UserBankBalance {
            balance_type: BankBalanceType::Deposit,
            balance: MARK_PRICE_PRECISION,
            ..UserBankBalance::default()
        };

        let mut user = User { ..User::default() };

        let market_position = MarketPosition {
            market_index: 0,
            quote_asset_amount: -(2 * QUOTE_PRECISION as i128),
            ..MarketPosition::default()
        };

        user.bank_balances[0] = user_bank_balance;
        user.positions[0] = market_position;

        let market = Market {
            market_index: 0,
            amm: AMM {
                base_asset_reserve: 5122950819670000,
                quote_asset_reserve: 488 * AMM_RESERVE_PRECISION,
                sqrt_k: 500 * AMM_RESERVE_PRECISION,
                peg_multiplier: 22_100_000,
                net_base_asset_amount: -(122950819670000_i128),
                ..AMM::default()
            },
            margin_ratio_initial: 1000,
            margin_ratio_maintenance: 500,
            imf_factor: 1000, // 1_000/1_000_000 = .001
            unsettled_initial_asset_weight: 100,
            unsettled_maintenance_asset_weight: 100,
            ..Market::default()
        };

        // btc
        let oracle_price_data = OraclePriceData {
            price: (22050 * MARK_PRICE_PRECISION) as i128,
            confidence: 0,
            delay: 2,
            has_sufficient_number_of_data_points: true,
        };

        let (_, unrealized_pnl) = calculate_perp_position_value_and_pnl(
            &market_position,
            &market,
            &oracle_price_data,
            MarginRequirementType::Initial,
        )
        .unwrap();

        let quote_asset_oracle_price_data = OraclePriceData {
            price: MARK_PRICE_PRECISION as i128,
            confidence: 1,
            delay: 0,
            has_sufficient_number_of_data_points: true,
        };

        let total_collateral = calculate_bank_balance_value(
            &user_bank_balance,
            &bank,
            &quote_asset_oracle_price_data,
            MarginRequirementType::Initial,
        )
        .unwrap();

        let total_collateral_updated =
            calculate_updated_collateral(total_collateral, unrealized_pnl).unwrap();

        assert_eq!(total_collateral_updated, 0);

        let total_collateral_i128 = (total_collateral as i128)
            .checked_add(unrealized_pnl)
            .ok_or_else(math_error!())
            .unwrap();

        assert_eq!(total_collateral_i128, -(2 * QUOTE_PRECISION as i128));
    }

    #[test]
    fn calculate_user_equity_value_tests() {
        let _user = User { ..User::default() };

        let user_bank_balance = UserBankBalance {
            balance_type: BankBalanceType::Deposit,
            balance: MARK_PRICE_PRECISION,
            ..UserBankBalance::default()
        };

        let bank = Bank {
            cumulative_deposit_interest: BANK_CUMULATIVE_INTEREST_PRECISION,
            cumulative_borrow_interest: BANK_CUMULATIVE_INTEREST_PRECISION,
            decimals: 6,
            ..Bank::default()
        };

        let mut market = Market {
            market_index: 0,
            amm: AMM {
                base_asset_reserve: 5122950819670000,
                quote_asset_reserve: 488 * AMM_RESERVE_PRECISION,
                sqrt_k: 500 * AMM_RESERVE_PRECISION,
                peg_multiplier: 22_100_000,
                net_base_asset_amount: -(122950819670000_i128),
                max_spread: 1000,
                ..AMM::default()
            },
            margin_ratio_initial: 1000,
            margin_ratio_maintenance: 500,
            imf_factor: 1000, // 1_000/1_000_000 = .001
            unsettled_initial_asset_weight: 100,
            unsettled_maintenance_asset_weight: 100,
            ..Market::default()
        };

        let current_price = market.amm.mark_price().unwrap();
        assert_eq!(current_price, 210519296000087);

        market.imf_factor = 1000; // 1_000/1_000_000 = .001

        // btc
        let mut oracle_price_data = OraclePriceData {
            price: (22050 * MARK_PRICE_PRECISION) as i128,
            confidence: 0,
            delay: 2,
            has_sufficient_number_of_data_points: true,
        };

        let market_position = MarketPosition {
            market_index: 0,
            base_asset_amount: -(122950819670000 / 2_i128),
            quote_asset_amount: 153688524588, // $25,000 entry price
            ..MarketPosition::default()
        };

        let margin_requirement_type = MarginRequirementType::Initial;
        let quote_asset_oracle_price_data = OraclePriceData {
            price: MARK_PRICE_PRECISION as i128,
            confidence: 1,
            delay: 0,
            has_sufficient_number_of_data_points: true,
        };
        let _bqv = calculate_bank_balance_value(
            &user_bank_balance,
            &bank,
            &quote_asset_oracle_price_data,
            margin_requirement_type,
        )
        .unwrap();

        let position_unrealized_pnl =
            calculate_position_pnl(&market_position, &market.amm, false).unwrap();

        assert_eq!(position_unrealized_pnl, 22699050901);

        let position_unsettled_pnl = position_unrealized_pnl;
        assert_eq!(position_unsettled_pnl, 22_699_050_901);

        // sqrt of oracle price = 149
        market.unsettled_imf_factor = market.imf_factor;

        let oracle_price_for_margin =
            calculate_oracle_price_for_perp_margin(&market_position, &market, &oracle_price_data)
                .unwrap();
        assert_eq!(oracle_price_for_margin, 220500000000000);

        let uaw = market
            .get_unsettled_asset_weight(position_unsettled_pnl, MarginRequirementType::Initial)
            .unwrap();
        assert_eq!(uaw, 95);

        let (pmr, upnl) = calculate_perp_position_value_and_pnl(
            &market_position,
            &market,
            &oracle_price_data,
            MarginRequirementType::Initial,
        )
        .unwrap();

        // assert_eq!(upnl, 17409836065);
        // assert!(upnl < position_unrealized_pnl); // margin system discounts

        assert!(pmr > 0);
        assert_eq!(pmr, 13880655737);

        oracle_price_data.price = (21050 * MARK_PRICE_PRECISION) as i128; // lower by $1000 (in favor of user)
        oracle_price_data.confidence = MARK_PRICE_PRECISION;

        let oracle_price_for_margin_2 =
            calculate_oracle_price_for_perp_margin(&market_position, &market, &oracle_price_data)
                .unwrap();
        assert_eq!(oracle_price_for_margin_2, 210510000000000);

        let (_, position_unrealized_pnl) = calculate_base_asset_value_and_pnl_with_oracle_price(
            &market_position,
            oracle_price_for_margin_2,
        )
        .unwrap();

        let position_unsettled_pnl = position_unrealized_pnl;
        assert_eq!(position_unrealized_pnl, 24276639345); // $24.276k

        assert_eq!(
            market
                .get_unsettled_asset_weight(position_unsettled_pnl, margin_requirement_type)
                .unwrap(),
            95
        );
        assert_eq!(
            market
                .get_unsettled_asset_weight(position_unsettled_pnl * 10, margin_requirement_type)
                .unwrap(),
            73
        );
        assert_eq!(
            market
                .get_unsettled_asset_weight(position_unsettled_pnl * 100, margin_requirement_type)
                .unwrap(),
            43
        );
        assert_eq!(
            market
                .get_unsettled_asset_weight(position_unsettled_pnl * 1000, margin_requirement_type)
                .unwrap(),
            18
        );
        assert_eq!(
            market
                .get_unsettled_asset_weight(position_unsettled_pnl * 10000, margin_requirement_type)
                .unwrap(),
            6
        );
        //nice that 18000 < 60000

        assert_eq!(
            market
                .get_unsettled_asset_weight(
                    position_unsettled_pnl * 800000,
                    margin_requirement_type
                )
                .unwrap(),
            0 // todo want to reduce to zero once sufficiently sized?
        );
        assert_eq!(position_unsettled_pnl * 800000, 19421311476000000); // 1.9 billion

        let (pmr_2, upnl_2) = calculate_perp_position_value_and_pnl(
            &market_position,
            &market,
            &oracle_price_data,
            MarginRequirementType::Initial,
        )
        .unwrap();

        let uaw_2 = market
            .get_unsettled_asset_weight(upnl_2, MarginRequirementType::Initial)
            .unwrap();
        assert_eq!(uaw_2, 95);

        assert_eq!(upnl_2, 23062807377);
        assert!(upnl_2 > upnl);
        assert!(pmr_2 > 0);
        assert_eq!(pmr_2, 13251147540); //$12940.5737702000
        assert!(pmr > pmr_2);
        assert_eq!(pmr - pmr_2, 629508197);
        //-6.1475409835 * 1000 / 10 = 614.75
    }

    #[test]
    fn test_nroot() {
        let ans = (0).nth_root(2);
        assert_eq!(ans, 0);
    }

    #[test]
    fn test_lp_user_short() {
        let mut market = Market {
            market_index: 0,
            amm: AMM {
                base_asset_reserve: 5 * AMM_RESERVE_PRECISION,
                quote_asset_reserve: 5 * AMM_RESERVE_PRECISION,
                sqrt_k: 5 * AMM_RESERVE_PRECISION,
                user_lp_shares: 10 * AMM_RESERVE_PRECISION,
                max_base_asset_reserve: 10 * AMM_RESERVE_PRECISION,
                ..AMM::default_test()
            },
            margin_ratio_initial: 1000,
            margin_ratio_maintenance: 500,
            imf_factor: 1000, // 1_000/1_000_000 = .001
            unsettled_initial_asset_weight: 100,
            unsettled_maintenance_asset_weight: 100,
            ..Market::default()
        };

        let position = MarketPosition {
            lp_shares: market.amm.user_lp_shares,
            ..MarketPosition::default()
        };

        let oracle_price_data = OraclePriceData {
            price: (2 * MARK_PRICE_PRECISION) as i128,
            confidence: 0,
            delay: 2,
            has_sufficient_number_of_data_points: true,
        };

        let (pmr, _) = calculate_perp_position_value_and_pnl(
            &position,
            &market,
            &oracle_price_data,
            MarginRequirementType::Initial,
        )
        .unwrap();

        // make the market unbalanced

        let trade_size = 3 * AMM_RESERVE_PRECISION;
        let (new_qar, new_bar) = calculate_swap_output(
            trade_size,
            market.amm.base_asset_reserve,
            SwapDirection::Add, // user shorts
            market.amm.sqrt_k,
        )
        .unwrap();
        market.amm.quote_asset_reserve = new_qar;
        market.amm.base_asset_reserve = new_bar;

        let (pmr2, _) = calculate_perp_position_value_and_pnl(
            &position,
            &market,
            &oracle_price_data,
            MarginRequirementType::Initial,
        )
        .unwrap();

        // larger margin req in more unbalanced market
        assert!(pmr2 > pmr)
    }

    #[test]
    fn test_lp_user_long() {
        let mut market = Market {
            market_index: 0,
            amm: AMM {
                base_asset_reserve: 5 * AMM_RESERVE_PRECISION,
                quote_asset_reserve: 5 * AMM_RESERVE_PRECISION,
                sqrt_k: 5 * AMM_RESERVE_PRECISION,
                user_lp_shares: 10 * AMM_RESERVE_PRECISION,
                max_base_asset_reserve: 10 * AMM_RESERVE_PRECISION,
                ..AMM::default_test()
            },
            margin_ratio_initial: 1000,
            margin_ratio_maintenance: 500,
            imf_factor: 1000, // 1_000/1_000_000 = .001
            unsettled_initial_asset_weight: 100,
            unsettled_maintenance_asset_weight: 100,
            ..Market::default()
        };

        let position = MarketPosition {
            lp_shares: market.amm.user_lp_shares,
            ..MarketPosition::default()
        };

        let oracle_price_data = OraclePriceData {
            price: (2 * MARK_PRICE_PRECISION) as i128,
            confidence: 0,
            delay: 2,
            has_sufficient_number_of_data_points: true,
        };

        let (pmr, _) = calculate_perp_position_value_and_pnl(
            &position,
            &market,
            &oracle_price_data,
            MarginRequirementType::Initial,
        )
        .unwrap();

        // make the market unbalanced
        let trade_size = 3 * AMM_RESERVE_PRECISION;
        let (new_qar, new_bar) = calculate_swap_output(
            trade_size,
            market.amm.base_asset_reserve,
            SwapDirection::Remove, // user longs
            market.amm.sqrt_k,
        )
        .unwrap();
        market.amm.quote_asset_reserve = new_qar;
        market.amm.base_asset_reserve = new_bar;

        let (pmr2, _) = calculate_perp_position_value_and_pnl(
            &position,
            &market,
            &oracle_price_data,
            MarginRequirementType::Initial,
        )
        .unwrap();

        // larger margin req in more unbalanced market
        assert!(pmr2 > pmr)
    }
}
