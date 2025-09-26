use anchor_lang::prelude::*;

use crate::controller::spot_balance;
use crate::math::safe_math::SafeMath;
use crate::math::spot_balance::get_token_amount;
use crate::state::events::{emit_stack, RevenueShareSettleRecord};
use crate::state::perp_market_map::PerpMarketMap;
use crate::state::revenue_share::{RevenueShareEscrowZeroCopyMut, RevenueShareOrder};
use crate::state::revenue_share_map::RevenueShareMap;
use crate::state::spot_market::SpotBalance;
use crate::state::spot_market_map::SpotMarketMap;
use crate::state::traits::Size;
use crate::state::user::MarketType;

/// Runs through the user's RevenueShareEscrow account and sweeps any accrued fees to the corresponding
/// builders and referrer.
pub fn sweep_completed_revenue_share_for_market<'a>(
    market_index: u16,
    revenue_share_escrow: &mut RevenueShareEscrowZeroCopyMut,
    perp_market_map: &PerpMarketMap<'a>,
    spot_market_map: &SpotMarketMap<'a>,
    revenue_share_map: &RevenueShareMap<'a>,
    now_ts: i64,
    builder_codes_feature_enabled: bool,
    builder_referral_feature_enabled: bool,
) -> crate::error::DriftResult<()> {
    let perp_market = &mut perp_market_map.get_ref_mut(&market_index)?;
    let quote_spot_market = &mut spot_market_map.get_quote_spot_market_mut()?;

    spot_balance::update_spot_market_cumulative_interest(quote_spot_market, None, now_ts)?;

    let orders_len = revenue_share_escrow.orders_len();
    for i in 0..orders_len {
        let (
            is_completed,
            is_referral_order,
            order_market_type,
            order_market_index,
            fees_accrued,
            builder_idx,
        ) = {
            let ord_ro = match revenue_share_escrow.get_order(i) {
                Ok(o) => o,
                Err(_) => {
                    continue;
                }
            };
            (
                ord_ro.is_completed(),
                ord_ro.is_referral_order(),
                ord_ro.market_type,
                ord_ro.market_index,
                ord_ro.fees_accrued,
                ord_ro.builder_idx,
            )
        };

        if is_referral_order {
            if fees_accrued == 0
                || !(order_market_type == MarketType::Perp && order_market_index == market_index)
            {
                continue;
            }
        } else if !(is_completed
            && order_market_type == MarketType::Perp
            && order_market_index == market_index
            && fees_accrued > 0)
        {
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
                "market {} PNL pool has insufficient balance to sweep fees for builder. pnl_pool_token_amount: {}, fees_accrued: {}",
                market_index,
                pnl_pool_token_amount,
                fees_accrued
            );
            break;
        }

        if is_referral_order {
            if builder_referral_feature_enabled {
                let referrer_authority =
                    if let Some(referrer_authority) = revenue_share_escrow.get_referrer() {
                        referrer_authority
                    } else {
                        continue;
                    };

                let referrer_user = revenue_share_map.get_user_ref_mut(&referrer_authority);
                let referrer_rev_share =
                    revenue_share_map.get_revenue_share_account_mut(&referrer_authority);

                if referrer_user.is_ok() && referrer_rev_share.is_ok() {
                    let mut referrer_user = referrer_user.unwrap();
                    let mut referrer_rev_share = referrer_rev_share.unwrap();

                    spot_balance::transfer_spot_balances(
                        fees_accrued as i128,
                        quote_spot_market,
                        &mut perp_market.pnl_pool,
                        referrer_user.get_quote_spot_position_mut(),
                    )?;

                    referrer_rev_share.total_referrer_rewards = referrer_rev_share
                        .total_referrer_rewards
                        .safe_add(fees_accrued as u64)?;

                    emit_stack::<_, { RevenueShareSettleRecord::SIZE }>(
                        RevenueShareSettleRecord {
                            ts: now_ts,
                            builder: None,
                            referrer: Some(referrer_authority),
                            fee_settled: fees_accrued as u64,
                            market_index: order_market_index,
                            market_type: order_market_type,
                            builder_total_referrer_rewards: referrer_rev_share
                                .total_referrer_rewards,
                            builder_total_builder_rewards: referrer_rev_share.total_builder_rewards,
                            builder_sub_account_id: referrer_user.sub_account_id,
                        },
                    )?;

                    // zero out the order
                    if let Ok(builder_order) = revenue_share_escrow.get_order_mut(i) {
                        builder_order.fees_accrued = 0;
                    }
                }
            }
        } else if builder_codes_feature_enabled {
            let builder_authority = match revenue_share_escrow
                .get_approved_builder_mut(builder_idx)
                .map(|builder| builder.authority)
            {
                Ok(auth) => auth,
                Err(_) => {
                    msg!("failed to get approved_builder from escrow account");
                    continue;
                }
            };

            let builder_user = revenue_share_map.get_user_ref_mut(&builder_authority);
            let builder_rev_share =
                revenue_share_map.get_revenue_share_account_mut(&builder_authority);

            if builder_user.is_ok() && builder_rev_share.is_ok() {
                let mut builder_user = builder_user.unwrap();
                let mut builder_revenue_share = builder_rev_share.unwrap();

                spot_balance::transfer_spot_balances(
                    fees_accrued as i128,
                    quote_spot_market,
                    &mut perp_market.pnl_pool,
                    builder_user.get_quote_spot_position_mut(),
                )?;

                builder_revenue_share.total_builder_rewards = builder_revenue_share
                    .total_builder_rewards
                    .safe_add(fees_accrued as u64)?;

                emit_stack::<_, { RevenueShareSettleRecord::SIZE }>(RevenueShareSettleRecord {
                    ts: now_ts,
                    builder: Some(builder_authority),
                    referrer: None,
                    fee_settled: fees_accrued as u64,
                    market_index: order_market_index,
                    market_type: order_market_type,
                    builder_total_referrer_rewards: builder_revenue_share.total_referrer_rewards,
                    builder_total_builder_rewards: builder_revenue_share.total_builder_rewards,
                    builder_sub_account_id: builder_user.sub_account_id,
                })?;

                // remove order
                if let Ok(builder_order) = revenue_share_escrow.get_order_mut(i) {
                    *builder_order = RevenueShareOrder::default();
                }
            } else {
                msg!(
                    "Builder user or builder not found for builder authority: {}",
                    builder_authority
                );
            }
        } else {
            msg!("Builder codes nor builder referral feature is not enabled");
        }
    }

    Ok(())
}
