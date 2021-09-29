use crate::{
    calculate_base_asset_value_and_pnl, calculate_updated_collateral, Market, MarketPosition,
    SwapDirection, User,
};
use anchor_lang::prelude::*;
use borsh::{BorshDeserialize, BorshSerialize};

#[derive(Clone, Copy, BorshSerialize, BorshDeserialize, PartialEq)]
pub enum PositionDirection {
    Long,
    Short,
}

impl Default for PositionDirection {
    // UpOnly
    fn default() -> Self {
        PositionDirection::Long
    }
}

pub fn increase_position(
    direction: PositionDirection,
    new_quote_asset_notional_amount: u128,
    market: &mut Market,
    market_position: &mut MarketPosition,
    now: i64,
) -> (i128, bool) {
    if new_quote_asset_notional_amount == 0 {
        return (0, false);
    }

    // Update funding rate if this is a new position
    if market_position.base_asset_amount == 0 {
        market_position.last_cumulative_funding_rate = market.amm.cumulative_funding_rate;
        market_position.last_cumulative_repeg_rebate = match direction {
            PositionDirection::Long => market.amm.cumulative_repeg_rebate_long,
            PositionDirection::Short => market.amm.cumulative_repeg_rebate_short,
        };
        market.open_interest = market.open_interest.checked_add(1).unwrap();
    }

    market_position.quote_asset_amount = market_position
        .quote_asset_amount
        .checked_add(new_quote_asset_notional_amount)
        .unwrap();

    let swap_direction = match direction {
        PositionDirection::Long => SwapDirection::Add,
        PositionDirection::Short => SwapDirection::Remove,
    };

    let (base_asset_acquired, quote_asset_peg_fee_unpaid, trade_size_to_small) = market
        .amm
        .swap_quote_asset_with_fee(new_quote_asset_notional_amount, swap_direction, now);

    // update the position size on market and user
    market_position.base_asset_amount = market_position
        .base_asset_amount
        .checked_add(base_asset_acquired)
        .unwrap();
    market.base_asset_amount = market
        .base_asset_amount
        .checked_add(base_asset_acquired)
        .unwrap();

    if market_position.base_asset_amount > 0 {
        market.base_asset_amount_long = market
            .base_asset_amount_long
            .checked_add(base_asset_acquired)
            .unwrap();
    } else {
        market.base_asset_amount_short = market
            .base_asset_amount_short
            .checked_add(base_asset_acquired)
            .unwrap();
    }

    return (quote_asset_peg_fee_unpaid, trade_size_to_small);
}

pub fn reduce_position<'info>(
    direction: PositionDirection,
    new_quote_asset_notional_amount: u128,
    user: &mut Account<'info, User>,
    market: &mut Market,
    market_position: &mut MarketPosition,
    now: i64,
) -> bool {
    let swap_direction = match direction {
        PositionDirection::Long => SwapDirection::Add,
        PositionDirection::Short => SwapDirection::Remove,
    };
    let (base_asset_value_before, pnl_before) =
        calculate_base_asset_value_and_pnl(market_position, &market.amm);
    let (base_asset_swapped, trade_size_too_small) =
        market
            .amm
            .swap_quote_asset(new_quote_asset_notional_amount, swap_direction, now);

    market_position.base_asset_amount = market_position
        .base_asset_amount
        .checked_add(base_asset_swapped)
        .unwrap();

    market.open_interest = market
        .open_interest
        .checked_sub((market_position.base_asset_amount == 0) as u128)
        .unwrap();
    market.base_asset_amount = market
        .base_asset_amount
        .checked_add(base_asset_swapped)
        .unwrap();

    if market_position.base_asset_amount > 0 {
        market.base_asset_amount_long = market
            .base_asset_amount_long
            .checked_add(base_asset_swapped)
            .unwrap();
    } else {
        market.base_asset_amount_short = market
            .base_asset_amount_short
            .checked_add(base_asset_swapped)
            .unwrap();
    }
    market_position.quote_asset_amount = market_position
        .quote_asset_amount
        .checked_sub(new_quote_asset_notional_amount)
        .unwrap();

    let (base_asset_value_after, _pnl_after) =
        calculate_base_asset_value_and_pnl(market_position, &market.amm);

    assert_eq!(base_asset_value_before > base_asset_value_after, true);

    let base_asset_value_change = (base_asset_value_before as i128)
        .checked_sub(base_asset_value_after as i128)
        .unwrap()
        .abs();

    let pnl = pnl_before
        .checked_mul(base_asset_value_change)
        .unwrap()
        .checked_div(base_asset_value_before as i128)
        .unwrap();

    user.collateral = calculate_updated_collateral(user.collateral, pnl);

    return trade_size_too_small;
}

pub fn close_position(
    user: &mut Account<User>,
    market: &mut Market,
    market_position: &mut MarketPosition,
    now: i64,
) {
    // If user has no base asset, return early
    if market_position.base_asset_amount == 0 {
        return;
    }

    let swap_direction = if market_position.base_asset_amount > 0 {
        SwapDirection::Add
    } else {
        SwapDirection::Remove
    };

    let (_base_asset_value, pnl) =
        calculate_base_asset_value_and_pnl(&market_position, &market.amm);

    market.amm.swap_base_asset(
        market_position.base_asset_amount.unsigned_abs(),
        swap_direction,
        now,
    );

    user.collateral = calculate_updated_collateral(user.collateral, pnl);
    market_position.last_cumulative_funding_rate = 0;
    market_position.last_cumulative_repeg_rebate = 0;

    market.open_interest = market.open_interest.checked_sub(1).unwrap();

    market_position.quote_asset_amount = 0;

    market.base_asset_amount = market
        .base_asset_amount
        .checked_sub(market_position.base_asset_amount)
        .unwrap();

    if market_position.base_asset_amount > 0 {
        market.base_asset_amount_long = market
            .base_asset_amount_long
            .checked_sub(market_position.base_asset_amount)
            .unwrap();
    } else {
        market.base_asset_amount_short = market
            .base_asset_amount_short
            .checked_sub(market_position.base_asset_amount)
            .unwrap();
    }

    market_position.base_asset_amount = 0;
}
