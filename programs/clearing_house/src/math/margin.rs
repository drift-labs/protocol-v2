use crate::error::ClearingHouseResult;
use crate::math::collateral::calculate_updated_collateral;
use crate::math::constants::{
    AMM_TO_QUOTE_PRECISION_RATIO_I128, BANK_IMF_PRECISION, BANK_WEIGHT_PRECISION,
    BID_ASK_SPREAD_PRECISION_I128, MARGIN_PRECISION,
};
use crate::math::position::{
    calculate_base_asset_value_and_pnl, calculate_base_asset_value_and_pnl_with_oracle_price,
    calculate_base_asset_value_with_oracle_price,
};
use crate::math_error;
use crate::state::user::User;

use crate::math::amm::use_oracle_price_for_margin_calculation;
use crate::math::bank_balance::get_balance_value_and_token_amount;
use crate::math::casting::cast_to_i128;
use crate::math::funding::calculate_funding_payment;
use crate::math::oracle::{get_oracle_status, OracleStatus};
// use crate::math::repeg;
use crate::math::slippage::calculate_slippage;
use crate::state::bank::Bank;
use crate::state::bank::BankBalanceType;
use crate::state::bank_map::BankMap;
use crate::state::market::Market;
use crate::state::market_map::MarketMap;
use crate::state::oracle::OraclePriceData;
use crate::state::oracle_map::OracleMap;
use crate::state::state::OracleGuardRails;
use crate::state::user::{MarketPosition, UserBankBalance};
use num_integer::Roots;
use solana_program::msg;
use std::cmp::{max, min};
use std::ops::Div;

#[derive(Clone, Copy, PartialEq, Debug)]
pub enum MarginRequirementType {
    Initial,
    Partial,
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
        cast_to_i128(
            oracle_price_data
                .confidence
                .checked_add(market.amm.base_spread as u128)
                .ok_or_else(math_error!())?,
        )?,
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
    let oracle_price_for_upnl =
        calculate_oracle_price_for_perp_margin(market_position, market, oracle_price_data)?;

    let (_, unrealized_pnl) = calculate_base_asset_value_and_pnl_with_oracle_price(
        market_position,
        oracle_price_for_upnl,
    )?;

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

    let total_unsettled_pnl = unrealized_pnl
        .checked_add(unrealized_funding)
        .ok_or_else(math_error!())?
        .checked_add(market_position.unsettled_pnl)
        .ok_or_else(math_error!())?;

    let unsettled_asset_weight =
        market.get_unsettled_asset_weight(total_unsettled_pnl, margin_requirement_type)?;

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
            && market_position.unsettled_pnl == 0
            && !market_position.has_open_order()
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

        margin_requirement
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

pub fn meets_partial_margin_requirement(
    user: &User,
    market_map: &MarketMap,
    bank_map: &BankMap,
    oracle_map: &mut OracleMap,
) -> ClearingHouseResult<bool> {
    let (mut partial_margin_requirement, total_collateral) =
        calculate_margin_requirement_and_total_collateral(
            user,
            market_map,
            MarginRequirementType::Partial,
            bank_map,
            oracle_map,
        )?;

    partial_margin_requirement = partial_margin_requirement
        .checked_div(MARGIN_PRECISION)
        .ok_or_else(math_error!())?;

    Ok(total_collateral >= cast_to_i128(partial_margin_requirement)?)
}

#[derive(PartialEq)]
pub enum LiquidationType {
    NONE,
    PARTIAL,
    FULL,
}

pub struct LiquidationStatus {
    pub liquidation_type: LiquidationType,
    pub margin_requirement: u128,
    pub total_collateral: u128,
    pub unrealized_pnl: i128,
    pub adjusted_total_collateral: u128,
    pub base_asset_value: u128,
    pub margin_ratio: u128,
    pub market_statuses: [MarketStatus; 5],
}

#[derive(Default, Clone, Copy, Debug)]
pub struct MarketStatus {
    pub market_index: u64,
    pub partial_margin_requirement: u128,
    pub maintenance_margin_requirement: u128,
    pub base_asset_value: u128,
    pub mark_price_before: u128,
    pub close_position_slippage: Option<i128>,
    pub oracle_status: OracleStatus,
}

pub fn calculate_liquidation_status(
    user: &User,
    market_map: &MarketMap,
    bank_map: &BankMap,
    oracle_map: &mut OracleMap,
    oracle_guard_rails: &OracleGuardRails,
) -> ClearingHouseResult<LiquidationStatus> {
    let mut deposit_value: u128 = 0;
    let mut partial_margin_requirement: u128 = 0;
    let mut maintenance_margin_requirement: u128 = 0;
    let mut base_asset_value: u128 = 0;
    let mut unsettled_pnl: i128 = 0;
    let mut unrealized_pnl: i128 = 0;
    let mut adjusted_unrealized_pnl: i128 = 0;
    let mut market_statuses = [MarketStatus::default(); 5];

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
                deposit_value = deposit_value
                    .checked_add(
                        balance_value
                            .checked_mul(bank.get_asset_weight(
                                token_amount,
                                &MarginRequirementType::Maintenance,
                            )?)
                            .ok_or_else(math_error!())?
                            .checked_div(BANK_WEIGHT_PRECISION)
                            .ok_or_else(math_error!())?,
                    )
                    .ok_or_else(math_error!())?;
            }
            BankBalanceType::Borrow => panic!(),
        }
    }

    for (i, market_position) in user.positions.iter().enumerate() {
        unsettled_pnl = unsettled_pnl
            .checked_add(market_position.unsettled_pnl)
            .ok_or_else(math_error!())?;

        if market_position.base_asset_amount == 0 {
            continue;
        }

        let market = market_map.get_ref(&market_position.market_index)?;
        let amm = &market.amm;
        let (amm_position_base_asset_value, amm_position_unrealized_pnl) =
            calculate_base_asset_value_and_pnl(market_position, amm, true)?;

        base_asset_value = base_asset_value
            .checked_add(amm_position_base_asset_value)
            .ok_or_else(math_error!())?;
        unrealized_pnl = unrealized_pnl
            .checked_add(amm_position_unrealized_pnl)
            .ok_or_else(math_error!())?;

        // Block the liquidation if the oracle is invalid or the oracle and mark are too divergent
        let mark_price_before = market.amm.mark_price()?;

        let oracle_price_data = oracle_map.get_price_data(&market.amm.oracle)?;
        let oracle_status = get_oracle_status(
            &market.amm,
            oracle_price_data,
            oracle_guard_rails,
            Some(mark_price_before),
        )?;

        let market_partial_margin_requirement: u128;
        let market_maintenance_margin_requirement: u128;
        let mut close_position_slippage = None;
        if oracle_status.is_valid
            && use_oracle_price_for_margin_calculation(
                oracle_status.oracle_mark_spread_pct,
                &oracle_guard_rails.price_divergence,
            )?
        {
            let market_index = market_position.market_index;
            let exit_slippage = calculate_slippage(
                amm_position_base_asset_value,
                market_position.base_asset_amount.unsigned_abs(),
                cast_to_i128(mark_price_before)?,
            )?;
            close_position_slippage = Some(exit_slippage);

            let oracle_exit_price = oracle_status
                .price_data
                .price
                .checked_add(exit_slippage)
                .ok_or_else(math_error!())?;

            let (oracle_position_base_asset_value, oracle_position_unrealized_pnl) =
                calculate_base_asset_value_and_pnl_with_oracle_price(
                    market_position,
                    oracle_exit_price,
                )?;

            let oracle_provides_better_pnl =
                oracle_position_unrealized_pnl > amm_position_unrealized_pnl;
            if oracle_provides_better_pnl {
                msg!("Using oracle pnl for market {}", market_index);
                adjusted_unrealized_pnl = adjusted_unrealized_pnl
                    .checked_add(oracle_position_unrealized_pnl)
                    .ok_or_else(math_error!())?;

                market_partial_margin_requirement = (oracle_position_base_asset_value)
                    .checked_mul(market.margin_ratio_partial.into())
                    .ok_or_else(math_error!())?;

                partial_margin_requirement = partial_margin_requirement
                    .checked_add(market_partial_margin_requirement)
                    .ok_or_else(math_error!())?;

                market_maintenance_margin_requirement = oracle_position_base_asset_value
                    .checked_mul(market.margin_ratio_maintenance.into())
                    .ok_or_else(math_error!())?;

                maintenance_margin_requirement = maintenance_margin_requirement
                    .checked_add(market_maintenance_margin_requirement)
                    .ok_or_else(math_error!())?;
            } else {
                adjusted_unrealized_pnl = adjusted_unrealized_pnl
                    .checked_add(amm_position_unrealized_pnl)
                    .ok_or_else(math_error!())?;

                market_partial_margin_requirement = (amm_position_base_asset_value)
                    .checked_mul(market.margin_ratio_partial.into())
                    .ok_or_else(math_error!())?;

                partial_margin_requirement = partial_margin_requirement
                    .checked_add(market_partial_margin_requirement)
                    .ok_or_else(math_error!())?;

                market_maintenance_margin_requirement = amm_position_base_asset_value
                    .checked_mul(market.margin_ratio_maintenance.into())
                    .ok_or_else(math_error!())?;

                maintenance_margin_requirement = maintenance_margin_requirement
                    .checked_add(market_maintenance_margin_requirement)
                    .ok_or_else(math_error!())?;
            }
        } else {
            adjusted_unrealized_pnl = adjusted_unrealized_pnl
                .checked_add(amm_position_unrealized_pnl)
                .ok_or_else(math_error!())?;

            market_partial_margin_requirement = (amm_position_base_asset_value)
                .checked_mul(market.margin_ratio_partial.into())
                .ok_or_else(math_error!())?;

            partial_margin_requirement = partial_margin_requirement
                .checked_add(market_partial_margin_requirement)
                .ok_or_else(math_error!())?;

            market_maintenance_margin_requirement = amm_position_base_asset_value
                .checked_mul(market.margin_ratio_maintenance.into())
                .ok_or_else(math_error!())?;

            maintenance_margin_requirement = maintenance_margin_requirement
                .checked_add(market_maintenance_margin_requirement)
                .ok_or_else(math_error!())?;
        }

        market_statuses[i] = MarketStatus {
            market_index: market_position.market_index,
            partial_margin_requirement: market_partial_margin_requirement.div(MARGIN_PRECISION),
            maintenance_margin_requirement: market_maintenance_margin_requirement
                .div(MARGIN_PRECISION),
            base_asset_value: amm_position_base_asset_value,
            mark_price_before,
            oracle_status,
            close_position_slippage,
        };
    }

    partial_margin_requirement = partial_margin_requirement
        .checked_div(MARGIN_PRECISION)
        .ok_or_else(math_error!())?;

    maintenance_margin_requirement = maintenance_margin_requirement
        .checked_div(MARGIN_PRECISION)
        .ok_or_else(math_error!())?;

    let total_collateral = calculate_updated_collateral(
        calculate_updated_collateral(deposit_value, unrealized_pnl)?,
        unsettled_pnl,
    )?;
    let adjusted_total_collateral = calculate_updated_collateral(
        calculate_updated_collateral(deposit_value, adjusted_unrealized_pnl)?,
        unsettled_pnl,
    )?;

    let requires_partial_liquidation = adjusted_total_collateral < partial_margin_requirement;
    let requires_full_liquidation = adjusted_total_collateral < maintenance_margin_requirement;

    let liquidation_type = if requires_full_liquidation {
        LiquidationType::FULL
    } else if requires_partial_liquidation {
        LiquidationType::PARTIAL
    } else {
        LiquidationType::NONE
    };

    let margin_requirement = match liquidation_type {
        LiquidationType::FULL => maintenance_margin_requirement,
        LiquidationType::PARTIAL => partial_margin_requirement,
        LiquidationType::NONE => partial_margin_requirement,
    };

    // Sort the market statuses such that we close the markets with biggest margin requirements first
    if liquidation_type == LiquidationType::FULL {
        market_statuses.sort_by(|a, b| {
            b.maintenance_margin_requirement
                .cmp(&a.maintenance_margin_requirement)
        });
    } else if liquidation_type == LiquidationType::PARTIAL {
        market_statuses.sort_by(|a, b| {
            b.partial_margin_requirement
                .cmp(&a.partial_margin_requirement)
        });
    }

    let margin_ratio = if base_asset_value == 0 {
        u128::MAX
    } else {
        total_collateral
            .checked_mul(MARGIN_PRECISION)
            .ok_or_else(math_error!())?
            .checked_div(base_asset_value)
            .ok_or_else(math_error!())?
    };

    Ok(LiquidationStatus {
        liquidation_type,
        margin_requirement,
        total_collateral,
        unrealized_pnl,
        adjusted_total_collateral,
        base_asset_value,
        market_statuses,
        margin_ratio,
    })
}

pub fn calculate_free_collateral(
    user: &User,
    market_map: &MarketMap,
    bank_map: &BankMap,
    oracle_map: &mut OracleMap,
    market_to_close: Option<u64>,
) -> ClearingHouseResult<(u128, u128)> {
    let mut closed_position_base_asset_value: u128 = 0;
    let mut initial_margin_requirement: u128 = 0;
    let mut unrealized_pnl: i128 = 0;
    let mut unsettled_pnl: i128 = 0;

    let mut deposit_value = 0_u128;
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
                deposit_value =
                    deposit_value
                        .checked_add(
                            balance_value
                                .checked_mul(bank.get_asset_weight(
                                    token_amount,
                                    &MarginRequirementType::Initial,
                                )?)
                                .ok_or_else(math_error!())?
                                .checked_div(BANK_WEIGHT_PRECISION)
                                .ok_or_else(math_error!())?,
                        )
                        .ok_or_else(math_error!())?;
            }
            BankBalanceType::Borrow => panic!(),
        }
    }

    for market_position in user.positions.iter() {
        unsettled_pnl = unsettled_pnl
            .checked_add(market_position.unsettled_pnl)
            .ok_or_else(math_error!())?;

        if market_position.base_asset_amount == 0 {
            continue;
        }

        let market = &market_map.get_ref(&market_position.market_index)?;
        let amm = &market.amm;
        let (position_base_asset_value, position_unrealized_pnl) =
            calculate_base_asset_value_and_pnl(market_position, amm, true)?;

        if market_to_close.is_some() && market_to_close.unwrap() == market_position.market_index {
            closed_position_base_asset_value = position_base_asset_value;
        } else {
            initial_margin_requirement = initial_margin_requirement
                .checked_add(
                    position_base_asset_value
                        .checked_mul(market.margin_ratio_initial.into())
                        .ok_or_else(math_error!())?,
                )
                .ok_or_else(math_error!())?;
        }

        unrealized_pnl = unrealized_pnl
            .checked_add(position_unrealized_pnl)
            .ok_or_else(math_error!())?;
    }

    initial_margin_requirement = initial_margin_requirement
        .checked_div(MARGIN_PRECISION)
        .ok_or_else(math_error!())?;

    let total_collateral = calculate_updated_collateral(
        calculate_updated_collateral(deposit_value, unrealized_pnl)?,
        unsettled_pnl,
    )?;

    let free_collateral = if initial_margin_requirement < total_collateral {
        total_collateral
            .checked_sub(initial_margin_requirement)
            .ok_or_else(math_error!())?
    } else {
        0
    };

    Ok((free_collateral, closed_position_base_asset_value))
}

#[cfg(test)]
mod test {
    use super::*;
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
    fn size_based_partial_margin_requirement() {
        let mut market = Market {
            amm: AMM {
                base_asset_reserve: 5122950819670000,
                quote_asset_reserve: 488 * AMM_RESERVE_PRECISION,
                sqrt_k: 500 * AMM_RESERVE_PRECISION,
                peg_multiplier: 50000,
                net_base_asset_amount: -(122950819670000_i128),
                ..AMM::default()
            },
            margin_ratio_initial: 1000,
            margin_ratio_partial: 625,
            margin_ratio_maintenance: 500,
            imf_factor: 0,
            ..Market::default()
        };

        let res = market
            .get_margin_ratio(AMM_RESERVE_PRECISION, MarginRequirementType::Partial)
            .unwrap();
        assert_eq!(res, 625);
        let res = market
            .get_margin_ratio(
                AMM_RESERVE_PRECISION * 100000,
                MarginRequirementType::Partial,
            )
            .unwrap();
        assert_eq!(res, 625);

        market.imf_factor = 1; // .000001
        let res = market
            .get_margin_ratio(
                AMM_RESERVE_PRECISION * 100000,
                MarginRequirementType::Partial,
            )
            .unwrap();
        // $5,000,000
        assert!(res > 625);
        assert_eq!(res, 628);

        market.imf_factor = 100; // .0001

        let res = market
            .get_margin_ratio(
                AMM_RESERVE_PRECISION * 100000,
                MarginRequirementType::Partial,
            )
            .unwrap();
        // $5,000,000
        assert!(res > 625);
        assert_eq!(res, 941);

        market.imf_factor = 1000; // .001

        let res = market
            .get_margin_ratio(
                AMM_RESERVE_PRECISION * 10000,
                MarginRequirementType::Partial,
            )
            .unwrap();
        // $500,000
        assert!(res > 625);
        assert_eq!(res, 1625);
        let res = market
            .get_margin_ratio(
                AMM_RESERVE_PRECISION * 100000,
                MarginRequirementType::Initial,
            )
            .unwrap();
        assert_eq!(res, 3788);
        let res = market
            .get_margin_ratio(
                AMM_RESERVE_PRECISION * 100000,
                MarginRequirementType::Partial,
            )
            .unwrap();
        assert_eq!(res, 3787);

        let res = market
            .get_margin_ratio(
                AMM_RESERVE_PRECISION / 1000000,
                MarginRequirementType::Partial,
            )
            .unwrap();
        // $500,000
        assert_eq!(res, 625);

        market.imf_factor = 10000; // .01
        let res = market
            .get_margin_ratio(
                AMM_RESERVE_PRECISION * 100000,
                MarginRequirementType::Partial,
            )
            .unwrap();
        // $5,000,000
        assert_eq!(res, 32241);
        let res = market
            .get_margin_ratio(
                AMM_RESERVE_PRECISION * 100000,
                MarginRequirementType::Initial,
            )
            .unwrap();
        // $5,000,000
        assert_eq!(res, 32242);
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
            unsettled_pnl: -(2 * QUOTE_PRECISION as i128),
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
            margin_ratio_partial: 625,
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
            margin_ratio_partial: 625,
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

        let position_unsettled_pnl = position_unrealized_pnl
            .checked_add(market_position.unsettled_pnl)
            .unwrap();
        assert_eq!(market_position.unsettled_pnl, 0);
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
        assert_eq!(pmr, 13555327868);

        let (pmr_partial, upnl_partial) = calculate_perp_position_value_and_pnl(
            &market_position,
            &market,
            &oracle_price_data,
            MarginRequirementType::Partial,
        )
        .unwrap();

        assert_eq!(upnl_partial, 18135245902);
        assert!(upnl_partial < position_unrealized_pnl); // margin system discounts

        assert!(pmr_partial > 0);
        assert_eq!(pmr_partial, 8797407786);
        // required margin $8797.4077867214 for position before partial liq
        // 8587.9701 * 1/.0625 = 13740.7522252

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

        let position_unsettled_pnl = position_unrealized_pnl
            .checked_add(market_position.unsettled_pnl)
            .ok_or_else(math_error!())
            .unwrap();
        assert_eq!(position_unsettled_pnl, 24276639345); // $24.276k

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
        assert_eq!(pmr_2, 12940573770); //$12940.5737702000
        assert!(pmr > pmr_2);
        assert_eq!(pmr - pmr_2, 614754098);
        //-6.1475409835 * 1000 / 10 = 614.75
    }

    #[test]
    fn test_nroot() {
        let ans = (0).nth_root(2);
        assert_eq!(ans, 0);
    }
}
