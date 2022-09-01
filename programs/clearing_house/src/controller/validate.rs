use crate::error::{ClearingHouseResult, ErrorCode};
use crate::math::orders::is_multiple_of_step_size;
use crate::math_error;
use crate::state::market::Market;
use crate::state::user::MarketPosition;
use crate::validate;
use solana_program::msg;

#[allow(clippy::comparison_chain)]
pub fn validate_market_account(market: &Market) -> ClearingHouseResult {
    validate!(
        (market.base_asset_amount_long + market.base_asset_amount_short)
            == market.amm.net_base_asset_amount + market.amm.net_unsettled_lp_base_asset_amount,
        ErrorCode::DefaultError,
        "Market NET_BAA Error: 
        market.base_asset_amount_long={}, 
        + market.base_asset_amount_short={} 
        != 
        market.amm.net_base_asset_amount={}
        +  market.amm.net_unsettled_lp_base_asset_amount={}",
        market.base_asset_amount_long,
        market.base_asset_amount_short,
        market.amm.net_base_asset_amount,
        market.amm.net_unsettled_lp_base_asset_amount,
    )?;

    validate!(
        market.amm.base_asset_reserve >= market.amm.min_base_asset_reserve,
        ErrorCode::DefaultError,
        "Market baa below min_base_asset_reserve: {} < {}",
        market.amm.base_asset_reserve,
        market.amm.min_base_asset_reserve,
    )?;

    validate!(
        market.amm.base_asset_reserve <= market.amm.max_base_asset_reserve,
        ErrorCode::DefaultError,
        "Market baa above max_base_asset_reserve"
    )?;

    validate!(
        market.amm.peg_multiplier > 0,
        ErrorCode::DefaultError,
        "peg_multiplier out of wack"
    )?;

    validate!(
        market.amm.sqrt_k > market.amm.net_base_asset_amount.unsigned_abs(),
        ErrorCode::DefaultError,
        "k out of wack: k={}, net_baa={}",
        market.amm.sqrt_k,
        market.amm.net_base_asset_amount
    )?;

    validate!(
        market.amm.sqrt_k >= market.amm.base_asset_reserve
            || market.amm.sqrt_k >= market.amm.quote_asset_reserve,
        ErrorCode::DefaultError,
        "k out of wack: k={}, bar={}, qar={}",
        market.amm.sqrt_k,
        market.amm.base_asset_reserve,
        market.amm.quote_asset_reserve
    )?;

    validate!(
        market.amm.sqrt_k >= market.amm.user_lp_shares,
        ErrorCode::DefaultError,
        "market.amm.sqrt_k < market.amm.user_lp_shares: {} < {}",
        market.amm.sqrt_k,
        market.amm.user_lp_shares,
    )?;

    let invariant_sqrt_u192 = crate::bn::U192::from(market.amm.sqrt_k);
    let invariant = invariant_sqrt_u192
        .checked_mul(invariant_sqrt_u192)
        .ok_or_else(math_error!())?;
    let quote_asset_reserve = invariant
        .checked_div(crate::bn::U192::from(market.amm.base_asset_reserve))
        .ok_or_else(math_error!())?
        .try_to_u128()?;

    validate!(
        quote_asset_reserve == market.amm.quote_asset_reserve,
        ErrorCode::DefaultError,
        "qar/bar/k out of wack: k={}, bar={}, qar={}, qar'={}",
        invariant,
        market.amm.base_asset_reserve,
        market.amm.quote_asset_reserve,
        quote_asset_reserve
    )?;

    if market.amm.base_spread > 0 {
        // bid quote/base < reserve q/b
        validate!(
            market.amm.bid_base_asset_reserve > market.amm.base_asset_reserve
                && market.amm.bid_quote_asset_reserve < market.amm.quote_asset_reserve,
            ErrorCode::DefaultError,
            "bid reserves out of wack"
        )?;

        // ask quote/base > reserve q/b
        validate!(
            market.amm.ask_base_asset_reserve < market.amm.base_asset_reserve
                && market.amm.ask_quote_asset_reserve > market.amm.quote_asset_reserve,
            ErrorCode::DefaultError,
            "ask reserves out of wack"
        )?;
    }

    validate!(
        market.amm.long_spread + market.amm.short_spread >= market.amm.base_spread as u128,
        ErrorCode::DefaultError,
        "long_spread + short_spread < base_spread: {} + {} < {}",
        market.amm.long_spread,
        market.amm.short_spread,
        market.amm.base_spread
    )?;

    validate!(
        market.amm.long_spread + market.amm.short_spread <= market.amm.max_spread as u128,
        ErrorCode::DefaultError,
        "long_spread + short_spread > max_spread: {} + {} < {}",
        market.amm.long_spread,
        market.amm.short_spread,
        market.amm.max_spread
    )?;

    if market.amm.net_base_asset_amount > 0 {
        // users are long = removed base and added quote = qar increased
        // bid quote/base < reserve q/b
        validate!(
            market.amm.terminal_quote_asset_reserve < market.amm.quote_asset_reserve,
            ErrorCode::DefaultError,
            "terminal_quote_asset_reserve out of wack"
        )?;
    } else if market.amm.net_base_asset_amount < 0 {
        validate!(
            market.amm.terminal_quote_asset_reserve > market.amm.quote_asset_reserve,
            ErrorCode::DefaultError,
            "terminal_quote_asset_reserve out of wack (terminal <) {} > {}",
            market.amm.terminal_quote_asset_reserve,
            market.amm.quote_asset_reserve
        )?;
    } else {
        validate!(
            market.amm.terminal_quote_asset_reserve == market.amm.quote_asset_reserve,
            ErrorCode::DefaultError,
            "terminal_quote_asset_reserve out of wack"
        )?;
    }

    validate!(
        (market.amm.max_spread > market.amm.base_spread as u32)
            && (market.amm.max_spread <= market.margin_ratio_initial * 100),
        ErrorCode::DefaultError,
        "invalid max_spread",
    )?;

    Ok(())
}

pub fn validate_position_account(
    position: &MarketPosition,
    market: &Market,
) -> ClearingHouseResult {
    validate!(
        position.market_index == market.market_index,
        ErrorCode::DefaultError,
        "position/market market_index unequal"
    )?;

    validate!(
        is_multiple_of_step_size(
            position.base_asset_amount.unsigned_abs(),
            market.amm.base_asset_amount_step_size
        )?,
        ErrorCode::DefaultError,
        "position not multiple of stepsize"
    )?;

    Ok(())
}
