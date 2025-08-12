use anchor_lang::prelude::*;

use crate::controller::spot_balance;
use crate::math::safe_math::SafeMath;
use crate::math::spot_balance::get_token_amount;
use crate::state::builder::{
    RevenueShareEscrowZeroCopyMut, RevenueShareOrder, RevenueShareOrderBitFlag,
};
use crate::state::perp_market_map::PerpMarketMap;
use crate::state::spot_market::SpotBalance;
use crate::state::spot_market_map::SpotMarketMap;
use crate::state::user::{derive_user_account, MarketType, User};
use crate::state::user_map::UserMap;

pub fn sweep_completed_builder_fees_for_market<'a>(
    market_index: u16,
    revenue_escrow: &mut RevenueShareEscrowZeroCopyMut,
    perp_market_map: &mut PerpMarketMap<'a>,
    spot_market_map: &mut SpotMarketMap<'a>,
    builder_users: &UserMap<'a>,
    now_ts: i64,
) -> crate::error::DriftResult<()> {
    // update quote market interest before spot transfers
    {
        let spot_market = &mut spot_market_map.get_quote_spot_market_mut()?;
        spot_balance::update_spot_market_cumulative_interest(spot_market, None, now_ts)?;
    }

    let perp_market = &mut perp_market_map.get_ref_mut(&market_index)?;
    let quote_market = &mut spot_market_map.get_quote_spot_market_mut()?;

    // // collect any User loaders from remaining accounts
    // let mut candidate_users: Vec<AccountLoader<User>> = Vec::new();
    // for ai in all_remaining_accounts.iter() {
    //     if let Ok(loader) = AccountLoader::<User>::try_from(ai) {
    //         candidate_users.push(loader);
    //     }
    // }

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
                ord_ro.is_bit_flag_set(RevenueShareOrderBitFlag::Completed),
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
            quote_market,
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

        // find builder user
        let mut maybe_builder_user: Option<AccountLoader<User>> = None;
        // TODO: is PDA too expensive? can store the builder's 0th userAccount pubkey instead
        let builder_user_account = derive_user_account(&builder_authority, 0);
        let builder_user = builder_users.get_ref_mut(&builder_user_account);

        if let Ok(mut builder_user) = builder_user {
            spot_balance::transfer_spot_balances(
                fees_accrued as i128,
                quote_market,
                &mut perp_market.pnl_pool,
                builder_user.get_quote_spot_position_mut(),
            )?;

            // TODO: update builder's total fees received

            if let Ok(ord_rw) = revenue_escrow.get_order_mut(i) {
                *ord_rw = RevenueShareOrder::default();
            }
        } else {
            // no builder user provided, skip
            continue;
        }
    }

    Ok(())
}
