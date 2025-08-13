use anchor_lang::prelude::*;

use crate::controller::spot_balance;
use crate::math::safe_math::SafeMath;
use crate::math::spot_balance::get_token_amount;
use crate::state::builder::{BuilderEscrowZeroCopyMut, BuilderOrder, BuilderOrderBitFlag};
use crate::state::builder_map::BuilderMap;
use crate::state::perp_market_map::PerpMarketMap;
use crate::state::spot_market::SpotBalance;
use crate::state::spot_market_map::SpotMarketMap;
use crate::state::user::{derive_user_account, MarketType, User};

pub fn sweep_completed_builder_fees_for_market<'a>(
    market_index: u16,
    revenue_escrow: &mut BuilderEscrowZeroCopyMut,
    perp_market_map: &mut PerpMarketMap<'a>,
    spot_market_map: &mut SpotMarketMap<'a>,
    builder_map: BuilderMap<'a>,
    now_ts: i64,
) -> crate::error::DriftResult<()> {
    let perp_market = &mut perp_market_map.get_ref_mut(&market_index)?;
    let quote_spot_market = &mut spot_market_map.get_quote_spot_market_mut()?;

    spot_balance::update_spot_market_cumulative_interest(quote_spot_market, None, now_ts)?;

    let orders_len = revenue_escrow.orders_len();
    for i in 0..orders_len {
        // snapshot fields to avoid holding borrow
        let (is_completed, is_perp, ord_mkt, fees_accrued, builder_idx) = {
            let ord_ro = match revenue_escrow.get_order(i) {
                Ok(o) => o,
                Err(_) => {
                    continue;
                }
            };
            (
                ord_ro.is_bit_flag_set(BuilderOrderBitFlag::Completed),
                ord_ro.market_type == MarketType::Perp,
                ord_ro.market_index,
                ord_ro.fees_accrued,
                ord_ro.builder_idx,
            )
        };

        if !(is_completed && is_perp && ord_mkt == market_index && fees_accrued > 0) {
            continue;
        }

        let pnl_pool_token_amount = get_token_amount(
            perp_market.pnl_pool.scaled_balance,
            quote_spot_market,
            perp_market.pnl_pool.balance_type(),
        )?;

        // TODO: should we add buffer on pnl pool?
        if pnl_pool_token_amount < fees_accrued as u128 {
            msg!(
                "market {} PNL pool has insufficient balance to sweep fees for builder",
                market_index
            );
            break;
        }

        let builder_authority = match revenue_escrow
            .get_approved_builder_mut(builder_idx)
            .map(|builder| builder.authority)
        {
            Ok(auth) => auth,
            Err(_) => {
                continue;
            }
        };

        // TODO: is PDA too expensive? can store the builder's 0th userAccount pubkey instead
        // let builder_user_account = derive_user_account(&builder_authority, 0);
        let builder_user = builder_map.get_user_ref_mut(&builder_authority);
        let builder_revenue_share = builder_map.get_builder_account_mut(&builder_authority);

        if builder_user.is_ok() && builder_revenue_share.is_ok() {
            let mut builder_user = builder_user.unwrap();
            let mut builder_revenue_share = builder_revenue_share.unwrap();

            spot_balance::transfer_spot_balances(
                fees_accrued as i128,
                quote_spot_market,
                &mut perp_market.pnl_pool,
                builder_user.get_quote_spot_position_mut(),
            )?;

            builder_revenue_share.total_builder_rewards = builder_revenue_share
                .total_builder_rewards
                .safe_add(fees_accrued as i64)?;
            msg!("Builder {} new fees: {}", builder_authority, fees_accrued);

            // remove order from revenue_escrow now
            if let Ok(ord_rw) = revenue_escrow.get_order_mut(i) {
                *ord_rw = BuilderOrder::default();
            }
        }
    }

    Ok(())
}
