use crate::error::ClearingHouseResult;
use crate::math::collateral::calculate_updated_collateral;
use crate::math::constants::{BANK_WEIGHT_PRECISION, MARGIN_PRECISION};
use crate::math::position::{
    calculate_base_asset_value_and_pnl, calculate_base_asset_value_and_pnl_with_oracle_price,
};
use crate::math_error;
use crate::state::user::User;

use crate::error::ErrorCode;
use crate::math::amm::use_oracle_price_for_margin_calculation;
use crate::math::bank_balance::get_balance_value;
use crate::math::casting::cast_to_i128;
use crate::math::oracle::{get_oracle_status, OracleStatus};
// use crate::math::repeg;
use crate::math::slippage::calculate_slippage;
use crate::state::bank::BankBalanceType;
use crate::state::bank_map::BankMap;
use crate::state::market_map::MarketMap;
use crate::state::oracle_map::OracleMap;
use crate::state::state::OracleGuardRails;
use crate::validate;
use solana_program::clock::Slot;
use solana_program::msg;
use std::ops::Div;

#[derive(Copy, Clone)]
pub enum MarginRequirementType {
    Initial,
    Partial,
    Maintenance,
}

pub fn calculate_margin_requirement_and_total_collateral(
    user: &User,
    market_map: &MarketMap,
    margin_requirement_type: MarginRequirementType,
    bank_map: &BankMap,
    oracle_map: &mut OracleMap,
) -> ClearingHouseResult<(u128, u128)> {
    let mut total_collateral: u128 = 0;
    let mut margin_requirement: u128 = 0;
    let mut unrealized_pnl: i128 = 0;
    let mut unsettled_pnl: i128 = 0;

    for user_bank_balance in user.bank_balances.iter() {
        if user_bank_balance.balance == 0 {
            continue;
        }

        let bank = &bank_map.get_ref(&user_bank_balance.bank_index)?;

        let oracle_price_data = oracle_map.get_price_data(&bank.oracle)?;
        let balance_value = get_balance_value(user_bank_balance, bank, oracle_price_data)?;

        match user_bank_balance.balance_type {
            BankBalanceType::Deposit => {
                total_collateral = total_collateral
                    .checked_add(
                        balance_value
                            .checked_mul(bank.get_asset_weight(&margin_requirement_type))
                            .ok_or_else(math_error!())?
                            .checked_div(BANK_WEIGHT_PRECISION)
                            .ok_or_else(math_error!())?,
                    )
                    .ok_or_else(math_error!())?;
            }
            BankBalanceType::Borrow => {
                margin_requirement = margin_requirement
                    .checked_add(
                        balance_value
                            .checked_mul(bank.get_liability_weight(&margin_requirement_type))
                            .ok_or_else(math_error!())?
                            .checked_div(BANK_WEIGHT_PRECISION)
                            .ok_or_else(math_error!())?,
                    )
                    .ok_or_else(math_error!())?;
            }
        }
    }

    let mut perp_margin_requirements: u128 = 0;
    for market_position in user.positions.iter() {
        unsettled_pnl = unsettled_pnl
            .checked_add(market_position.unsettled_pnl)
            .ok_or_else(math_error!())?;

        if market_position.base_asset_amount == 0 {
            continue;
        }

        let market = &market_map.get_ref(&market_position.market_index)?;

        validate!(
            (oracle_map.slot == market.amm.last_update_slot
                || market.amm.curve_update_intensity == 0),
            ErrorCode::AMMNotUpdatedInSameSlot,
            "AMM must be updated in a prior instruction within same slot"
        )?;

        let (position_base_asset_value, position_unrealized_pnl) =
            calculate_base_asset_value_and_pnl(market_position, &market.amm, true)?;

        let margin_ratio = market.get_margin_ratio(margin_requirement_type);

        perp_margin_requirements = perp_margin_requirements
            .checked_add(
                position_base_asset_value
                    .checked_mul(margin_ratio.into())
                    .ok_or_else(math_error!())?,
            )
            .ok_or_else(math_error!())?;

        unrealized_pnl = unrealized_pnl
            .checked_add(position_unrealized_pnl)
            .ok_or_else(math_error!())?;
    }

    margin_requirement = margin_requirement
        .checked_add(
            perp_margin_requirements
                .checked_div(MARGIN_PRECISION)
                .ok_or_else(math_error!())?,
        )
        .ok_or_else(math_error!())?;

    let total_collateral = calculate_updated_collateral(
        calculate_updated_collateral(total_collateral, unrealized_pnl)?,
        unsettled_pnl,
    )?;

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
        let balance_value = get_balance_value(user_bank_balance, bank, oracle_price_data)?;

        match user_bank_balance.balance_type {
            BankBalanceType::Deposit => {
                net_quote_balance = net_quote_balance
                    .checked_add(cast_to_i128(
                        balance_value
                            .checked_mul(bank.get_asset_weight(&margin_requirement_type))
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
                            .checked_mul(bank.get_liability_weight(&margin_requirement_type))
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
    let (margin_requirement, margin) = calculate_margin_requirement_and_total_collateral(
        user,
        market_map,
        MarginRequirementType::Initial,
        bank_map,
        oracle_map,
    )?;

    Ok(margin >= margin_requirement)
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

    Ok(total_collateral >= partial_margin_requirement)
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
    clock_slot: Slot,
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
        let balance_value = get_balance_value(user_bank_balance, bank, oracle_price_data)?;

        match user_bank_balance.balance_type {
            BankBalanceType::Deposit => {
                deposit_value = deposit_value
                    .checked_add(
                        balance_value
                            .checked_mul(bank.get_asset_weight(&MarginRequirementType::Maintenance))
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
        let oracle_account_info = oracle_map.get_account_info(&market.amm.oracle)?;

        let mark_price_before = market.amm.mark_price()?;

        let oracle_status = get_oracle_status(
            &market.amm,
            &oracle_account_info,
            clock_slot,
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
        let balance_value = get_balance_value(user_bank_balance, bank, oracle_price_data)?;

        match user_bank_balance.balance_type {
            BankBalanceType::Deposit => {
                deposit_value = deposit_value
                    .checked_add(
                        balance_value
                            .checked_mul(bank.get_asset_weight(&MarginRequirementType::Initial))
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
