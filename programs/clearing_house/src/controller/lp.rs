use anchor_lang::prelude::*;

use crate::controller::amm::SwapDirection;
use crate::math::casting::cast_to_i128;
use crate::math_error;
use crate::MarketPosition;
use solana_program::msg;

use crate::math::amm::calculate_swap_output;
use crate::math::lp::get_proportion;
use crate::math::quote_asset::reserve_to_asset_amount;
use crate::state::market::AMM;
use std::convert::TryInto;

pub fn settle_lp_position<'info>(
    lp_position: &mut MarketPosition,
    lp_tokens_to_settle: u128,
    amm: &mut AMM,
) -> Result<()> {
    if lp_position.lp_tokens != lp_tokens_to_settle {
        panic!("not implemented yet...");
    }

    if lp_tokens_to_settle == 0 {
        return Ok(());
    }

    let total_lp_tokens = amm.sqrt_k;

    // give them slice of the damm market position
    let net_base_asset_amount_delta = lp_position
        .last_net_base_asset_amount
        .checked_sub(amm.net_base_asset_amount)
        .ok_or_else(math_error!())?;

    if net_base_asset_amount_delta != 0 {
        let base_asset_amount = get_proportion(
            net_base_asset_amount_delta,
            lp_tokens_to_settle,
            total_lp_tokens,
        )?;

        let swap_direction = match net_base_asset_amount_delta > 0 {
            true => SwapDirection::Remove,
            false => SwapDirection::Add,
        };

        let (new_quote_asset_reserve, _) = calculate_swap_output(
            net_base_asset_amount_delta.unsigned_abs(),
            amm.base_asset_reserve,
            swap_direction,
            amm.sqrt_k,
        )?;

        // avoid overflow - note: sign doesnt matter
        let net_quote_asset_amount_delta = if new_quote_asset_reserve > amm.quote_asset_reserve {
            new_quote_asset_reserve
                .checked_sub(amm.quote_asset_reserve)
                .ok_or_else(math_error!())?
        } else {
            amm.quote_asset_reserve
                .checked_sub(new_quote_asset_reserve)
                .ok_or_else(math_error!())?
        };
        let quote_asset_amount = reserve_to_asset_amount(
            get_proportion(
                net_quote_asset_amount_delta.try_into().unwrap(),
                lp_tokens_to_settle,
                total_lp_tokens,
            )?
            .try_into()
            .unwrap(),
            amm.peg_multiplier,
        )?;

        lp_position.quote_asset_amount = quote_asset_amount;
        lp_position.base_asset_amount = base_asset_amount;
    } else {
        // zero these out so last_cum_fund doesnt matter for settling
        lp_position.quote_asset_amount = 0;
        lp_position.base_asset_amount = 0;
    }

    // give them fees
    // is it ok if they lose money on this?
    let fee_delta = cast_to_i128(amm.total_fee_minus_distributions)?
        .checked_sub(cast_to_i128(
            lp_position.last_total_fee_minus_distributions,
        )?)
        .ok_or_else(math_error!())?;
    let lp_fee_amount = get_proportion(fee_delta, lp_tokens_to_settle, total_lp_tokens)?;

    lp_position.unsettled_pnl = lp_position
        .unsettled_pnl
        .checked_add(lp_fee_amount)
        .ok_or_else(math_error!())?;

    // give them the funding
    let funding_delta = amm
        .cumulative_funding_rate_lp
        .checked_sub(lp_position.last_cumulative_funding_rate)
        .ok_or_else(math_error!())?;
    let funding_payment = get_proportion(funding_delta, lp_tokens_to_settle, total_lp_tokens)?;

    lp_position.unsettled_pnl = lp_position
        .unsettled_pnl
        .checked_add(funding_payment)
        .ok_or_else(math_error!())?;

    // update the lp position
    lp_position.last_net_base_asset_amount = amm.net_base_asset_amount;
    lp_position.last_total_fee_minus_distributions = amm.total_fee_minus_distributions;
    lp_position.last_cumulative_funding_rate = amm.cumulative_funding_rate_lp;

    Ok(())
}
