pub mod perp_lp_pool_settlement {
    use core::slice::Iter;
    use std::iter::Peekable;

    use crate::error::ErrorCode;
    use crate::math::casting::Cast;
    use crate::state::spot_market::SpotBalanceType;
    use crate::{
        math::safe_math::SafeMath,
        state::{amm_cache::CacheInfo, perp_market::PerpMarket, spot_market::SpotMarket},
        *,
    };
    use anchor_spl::token_interface::{TokenAccount, TokenInterface};

    #[derive(Debug, Clone, Copy)]
    pub struct SettlementResult {
        pub amount_transferred: u64,
        pub direction: SettlementDirection,
        pub fee_pool_used: u128,
        pub pnl_pool_used: u128,
    }

    #[derive(Debug, Clone, Copy, PartialEq)]
    pub enum SettlementDirection {
        ToLpPool,
        FromLpPool,
        None,
    }

    pub struct SettlementContext<'a> {
        pub quote_owed_from_lp: i64,
        pub quote_constituent_token_balance: u64,
        pub fee_pool_balance: u128,
        pub pnl_pool_balance: u128,
        pub quote_market: &'a SpotMarket,
        pub max_settle_quote_amount: u64,
    }

    pub fn calculate_settlement_amount(ctx: &SettlementContext) -> Result<SettlementResult> {
        if ctx.quote_owed_from_lp > 0 {
            calculate_lp_to_perp_settlement(ctx)
        } else if ctx.quote_owed_from_lp < 0 {
            calculate_perp_to_lp_settlement(ctx)
        } else {
            Ok(SettlementResult {
                amount_transferred: 0,
                direction: SettlementDirection::None,
                fee_pool_used: 0,
                pnl_pool_used: 0,
            })
        }
    }

    pub fn validate_settlement_amount(
        ctx: &SettlementContext,
        result: &SettlementResult,
    ) -> Result<()> {
        if result.amount_transferred > ctx.max_settle_quote_amount {
            msg!(
                "Amount to settle exceeds maximum allowed, {} > {}",
                result.amount_transferred,
                ctx.max_settle_quote_amount
            );
            return Err(ErrorCode::LpPoolSettleInvariantBreached.into());
        }
        Ok(())
    }

    fn calculate_lp_to_perp_settlement(ctx: &SettlementContext) -> Result<SettlementResult> {
        if ctx.quote_constituent_token_balance == 0 {
            return Ok(SettlementResult {
                amount_transferred: 0,
                direction: SettlementDirection::None,
                fee_pool_used: 0,
                pnl_pool_used: 0,
            });
        }

        let amount_to_send = ctx
            .quote_owed_from_lp
            .cast::<u64>()?
            .min(
                ctx.quote_constituent_token_balance
                    .saturating_sub(QUOTE_PRECISION_U64),
            )
            .min(ctx.max_settle_quote_amount);

        Ok(SettlementResult {
            amount_transferred: amount_to_send,
            direction: SettlementDirection::FromLpPool,
            fee_pool_used: 0,
            pnl_pool_used: 0,
        })
    }

    fn calculate_perp_to_lp_settlement(ctx: &SettlementContext) -> Result<SettlementResult> {
        let amount_to_send =
            (ctx.quote_owed_from_lp.abs().cast::<u64>()?).min(ctx.max_settle_quote_amount);

        if ctx.fee_pool_balance >= amount_to_send as u128 {
            // Fee pool can cover entire amount
            Ok(SettlementResult {
                amount_transferred: amount_to_send,
                direction: SettlementDirection::ToLpPool,
                fee_pool_used: amount_to_send as u128,
                pnl_pool_used: 0,
            })
        } else {
            // Need to use both fee pool and pnl pool
            let remaining_amount = (amount_to_send as u128).safe_sub(ctx.fee_pool_balance)?;
            let pnl_pool_used = remaining_amount.min(ctx.pnl_pool_balance);
            let actual_transfer = ctx.fee_pool_balance.safe_add(pnl_pool_used)?;

            Ok(SettlementResult {
                amount_transferred: actual_transfer as u64,
                direction: SettlementDirection::ToLpPool,
                fee_pool_used: ctx.fee_pool_balance,
                pnl_pool_used,
            })
        }
    }

    pub fn execute_token_transfer<'info>(
        token_program: &Interface<'info, TokenInterface>,
        from_vault: &InterfaceAccount<'info, TokenAccount>,
        to_vault: &InterfaceAccount<'info, TokenAccount>,
        signer: &AccountInfo<'info>,
        signer_seed: &[&[u8]],
        amount: u64,
        remaining_accounts: Option<&mut Peekable<Iter<'info, AccountInfo<'info>>>>,
    ) -> Result<()> {
        controller::token::send_from_program_vault_with_signature_seeds(
            token_program,
            from_vault,
            to_vault,
            signer,
            signer_seed,
            amount,
            &None,
            remaining_accounts,
        )
    }

    // Market state updates
    pub fn update_perp_market_pools_and_quote_market_balance(
        perp_market: &mut PerpMarket,
        result: &SettlementResult,
        quote_spot_market: &mut SpotMarket,
    ) -> Result<()> {
        match result.direction {
            SettlementDirection::FromLpPool => {
                controller::spot_balance::update_spot_balances(
                    result.amount_transferred as u128,
                    &SpotBalanceType::Deposit,
                    quote_spot_market,
                    &mut perp_market.amm.fee_pool,
                    false,
                )?;
            }
            SettlementDirection::ToLpPool => {
                if result.fee_pool_used > 0 {
                    controller::spot_balance::update_spot_balances(
                        result.fee_pool_used,
                        &SpotBalanceType::Borrow,
                        quote_spot_market,
                        &mut perp_market.amm.fee_pool,
                        true,
                    )?;
                }
                if result.pnl_pool_used > 0 {
                    controller::spot_balance::update_spot_balances(
                        result.pnl_pool_used,
                        &SpotBalanceType::Borrow,
                        quote_spot_market,
                        &mut perp_market.pnl_pool,
                        true,
                    )?;
                }
            }
            SettlementDirection::None => {}
        }
        Ok(())
    }

    pub fn update_cache_info(
        cache_info: &mut CacheInfo,
        result: &SettlementResult,
        new_quote_owed: i64,
        slot: u64,
        now: i64,
    ) -> Result<()> {
        cache_info.quote_owed_from_lp_pool = new_quote_owed;
        cache_info.last_settle_amount = result.amount_transferred;
        cache_info.last_settle_slot = slot;
        cache_info.last_settle_ts = now;
        cache_info.last_settle_amm_ex_fees = cache_info.last_exchange_fees;
        cache_info.last_settle_amm_pnl = cache_info.last_net_pnl_pool_token_amount;

        match result.direction {
            SettlementDirection::FromLpPool => {
                cache_info.last_fee_pool_token_amount = cache_info
                    .last_fee_pool_token_amount
                    .safe_add(result.amount_transferred as u128)?;
            }
            SettlementDirection::ToLpPool => {
                if result.fee_pool_used > 0 {
                    cache_info.last_fee_pool_token_amount = cache_info
                        .last_fee_pool_token_amount
                        .safe_sub(result.fee_pool_used)?;
                }
                if result.pnl_pool_used > 0 {
                    cache_info.last_net_pnl_pool_token_amount = cache_info
                        .last_net_pnl_pool_token_amount
                        .safe_sub(result.pnl_pool_used as i128)?;
                }
            }
            SettlementDirection::None => {}
        }
        Ok(())
    }
}
