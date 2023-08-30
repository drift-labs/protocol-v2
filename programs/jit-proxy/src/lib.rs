use anchor_lang::prelude::*;
use borsh::{BorshDeserialize, BorshSerialize};
use drift::controller::position::PositionDirection;
use drift::cpi::accounts::PlaceAndMake;
use drift::error::DriftResult;
use drift::instructions::optional_accounts::{load_maps, AccountMaps};
use drift::instructions::OrderParams;
use drift::instructions::PostOnlyParam as DriftPostOnlyParam;
use drift::math::safe_math::SafeMath;
use drift::program::Drift;
use drift::state::perp_market_map::MarketSet;
use drift::state::state::State;
use drift::state::user::{MarketType as DriftMarketType, OrderTriggerCondition, OrderType};
use drift::state::user::{User, UserStats};

declare_id!("J1TnP8zvVxbtF5KFp5xRmWuvG9McnhzmBd9XGfCyuxFP");

#[program]
pub mod jit_proxy {
    use super::*;
    use drift::math::casting::Cast;

    pub fn jit<'info>(
        ctx: Context<'_, '_, '_, 'info, Jit<'info>>,
        params: JitParams,
    ) -> Result<()> {
        let clock = Clock::get()?;
        let slot = clock.slot;

        let taker = ctx.accounts.taker.load()?;
        let maker = ctx.accounts.user.load()?;

        let taker_order = taker
            .get_order(params.taker_order_id)
            .ok_or(ErrorCode::TakerOrderNotFound)?;
        let market_type = taker_order.market_type;
        let market_index = taker_order.market_index;
        let taker_direction = taker_order.direction;

        let remaining_accounts_iter = &mut ctx.remaining_accounts.iter().peekable();
        let AccountMaps {
            perp_market_map,
            spot_market_map,
            mut oracle_map,
        } = load_maps(
            remaining_accounts_iter,
            &MarketSet::new(),
            &MarketSet::new(),
            slot,
            None,
        )?;

        let (oracle_price, tick_size) = if market_type == DriftMarketType::Perp {
            let perp_market = perp_market_map.get_ref(&market_index)?;
            let oracle_price = oracle_map.get_price_data(&perp_market.amm.oracle)?.price;

            (oracle_price, perp_market.amm.order_tick_size)
        } else {
            let spot_market = spot_market_map.get_ref(&market_index)?;
            let oracle_price = oracle_map.get_price_data(&spot_market.oracle)?.price;

            (oracle_price, spot_market.order_tick_size)
        };

        let taker_price =
            taker_order.force_get_limit_price(Some(oracle_price), None, slot, tick_size)?;

        let maker_direction = taker_direction.opposite();
        let maker_worst_price = params.get_worst_price(oracle_price, taker_direction)?;
        match maker_direction {
            PositionDirection::Long => {
                if taker_price > maker_worst_price {
                    msg!(
                        "taker price {} > worst bid {}",
                        taker_price,
                        maker_worst_price
                    );
                    return Err(ErrorCode::BidNotCrossed.into());
                }
            }
            PositionDirection::Short => {
                if taker_price < maker_worst_price {
                    msg!(
                        "taker price {} < worst ask {}",
                        taker_price,
                        maker_worst_price
                    );
                    return Err(ErrorCode::AskNotCrossed.into());
                }
            }
        }
        let maker_price = taker_price;

        let taker_base_asset_amount_unfilled = taker_order.get_base_asset_amount_unfilled(None)?;
        let maker_existing_position = if market_type == DriftMarketType::Perp {
            let perp_market = perp_market_map.get_ref(&market_index)?;
            let perp_position = maker.get_perp_position(market_index);
            match perp_position {
                Ok(perp_position) => {
                    perp_position
                        .simulate_settled_lp_position(&perp_market, oracle_price)?
                        .base_asset_amount
                }
                Err(_) => 0,
            }
        } else {
            let spot_market = spot_market_map.get_ref(&market_index)?;
            maker
                .get_spot_position(market_index)
                .map_or(0, |p| p.get_signed_token_amount(&spot_market).unwrap())
                .cast::<i64>()?
        };

        let maker_base_asset_amount = if maker_direction == PositionDirection::Long {
            let size = params.max_position.safe_sub(maker_existing_position)?;

            if size <= 0 {
                msg!(
                    "maker existing position {} >= max position {}",
                    maker_existing_position,
                    params.max_position
                );
            }

            size.unsigned_abs().min(taker_base_asset_amount_unfilled)
        } else {
            let size = maker_existing_position.safe_sub(params.min_position)?;

            if size <= 0 {
                msg!(
                    "maker existing position {} <= max position {}",
                    maker_existing_position,
                    params.max_position
                );
            }

            size.unsigned_abs().min(taker_base_asset_amount_unfilled)
        };

        let order_params = OrderParams {
            order_type: OrderType::Limit,
            market_type,
            direction: maker_direction,
            user_order_id: 0,
            base_asset_amount: maker_base_asset_amount,
            price: maker_price,
            market_index,
            reduce_only: false,
            post_only: params
                .post_only
                .unwrap_or(PostOnlyParam::MustPostOnly)
                .to_drift_param(),
            immediate_or_cancel: true,
            max_ts: None,
            trigger_price: None,
            trigger_condition: OrderTriggerCondition::Above,
            oracle_price_offset: None,
            auction_duration: None,
            auction_start_price: None,
            auction_end_price: None,
        };

        drop(taker);
        drop(maker);

        place_and_make(ctx, params.taker_order_id, order_params)?;

        Ok(())
    }

    pub fn check_order_constraints<'info>(
        ctx: Context<'_, '_, '_, 'info, CheckOrderConstraints<'info>>,
        constraints: Vec<OrderConstraint>,
    ) -> Result<()> {
        let clock = Clock::get()?;
        let slot = clock.slot;

        let user = ctx.accounts.user.load()?;

        let remaining_accounts_iter = &mut ctx.remaining_accounts.iter().peekable();
        let AccountMaps {
            perp_market_map,
            spot_market_map,
            mut oracle_map,
        } = load_maps(
            remaining_accounts_iter,
            &MarketSet::new(),
            &MarketSet::new(),
            slot,
            None,
        )?;

        for constraint in constraints.iter() {
            if constraint.market_type == MarketType::Spot {
                let spot_market = spot_market_map.get_ref(&constraint.market_index)?;
                let spot_position = match user.get_spot_position(constraint.market_index) {
                    Ok(spot_position) => spot_position,
                    Err(_) => continue,
                };

                let signed_token_amount = spot_position
                    .get_signed_token_amount(&spot_market)?
                    .cast::<i64>()?;

                constraint.check(
                    signed_token_amount,
                    spot_position.open_bids,
                    spot_position.open_asks,
                )?;
            } else {
                let perp_market = perp_market_map.get_ref(&constraint.market_index)?;
                let perp_position = match user.get_perp_position(constraint.market_index) {
                    Ok(perp_position) => perp_position,
                    Err(_) => continue,
                };

                let oracle_price = oracle_map.get_price_data(&perp_market.amm.oracle)?.price;

                let settled_perp_position =
                    perp_position.simulate_settled_lp_position(&perp_market, oracle_price)?;

                constraint.check(
                    settled_perp_position.base_asset_amount,
                    settled_perp_position.open_bids,
                    settled_perp_position.open_asks,
                )?;
            }
        }

        Ok(())
    }
}

#[derive(Accounts)]
pub struct Jit<'info> {
    pub state: Box<Account<'info, State>>,
    #[account(mut)]
    pub user: AccountLoader<'info, User>,
    #[account(mut)]
    pub user_stats: AccountLoader<'info, UserStats>,
    #[account(mut)]
    pub taker: AccountLoader<'info, User>,
    #[account(mut)]
    pub taker_stats: AccountLoader<'info, UserStats>,
    pub authority: Signer<'info>,
    pub drift_program: Program<'info, Drift>,
}

#[derive(Debug, Clone, Copy, AnchorSerialize, AnchorDeserialize, PartialEq, Eq)]
pub struct JitParams {
    pub taker_order_id: u32,
    pub max_position: i64,
    pub min_position: i64,
    pub bid: i64,
    pub ask: i64,
    pub price_type: PriceType,
    pub post_only: Option<PostOnlyParam>,
}

impl JitParams {
    pub fn get_worst_price(
        self,
        oracle_price: i64,
        taker_direction: PositionDirection,
    ) -> DriftResult<u64> {
        match (taker_direction, self.price_type) {
            (PositionDirection::Long, PriceType::Limit) => Ok(self.ask.unsigned_abs()),
            (PositionDirection::Short, PriceType::Limit) => Ok(self.bid.unsigned_abs()),
            (PositionDirection::Long, PriceType::Oracle) => {
                Ok(oracle_price.safe_add(self.ask)?.unsigned_abs())
            }
            (PositionDirection::Short, PriceType::Oracle) => {
                Ok(oracle_price.safe_add(self.bid)?.unsigned_abs())
            }
        }
    }
}

#[derive(Clone, Copy, BorshSerialize, BorshDeserialize, PartialEq, Debug, Eq)]
pub enum PostOnlyParam {
    None,
    MustPostOnly, // Tx fails if order can't be post only
    TryPostOnly,  // Tx succeeds and order not placed if can't be post only
}

impl PostOnlyParam {
    pub fn to_drift_param(self) -> DriftPostOnlyParam {
        match self {
            PostOnlyParam::None => DriftPostOnlyParam::None,
            PostOnlyParam::MustPostOnly => DriftPostOnlyParam::MustPostOnly,
            PostOnlyParam::TryPostOnly => DriftPostOnlyParam::TryPostOnly,
        }
    }
}

#[derive(Clone, Copy, BorshSerialize, BorshDeserialize, PartialEq, Debug, Eq)]
pub enum PriceType {
    Limit,
    Oracle,
}

#[derive(Accounts)]
pub struct CheckOrderConstraints<'info> {
    pub user: AccountLoader<'info, User>,
}

#[derive(Debug, Clone, Copy, AnchorSerialize, AnchorDeserialize, PartialEq, Eq)]
pub struct OrderConstraint {
    pub max_position: i64,
    pub min_position: i64,
    pub market_index: u16,
    pub market_type: MarketType,
}

impl OrderConstraint {
    pub fn check(&self, current_position: i64, open_bids: i64, open_asks: i64) -> Result<()> {
        let max_long = current_position.safe_add(open_bids)?;

        if max_long > self.max_position {
            msg!(
                "market index {} market type {:?}",
                self.market_index,
                self.market_type
            );
            msg!(
                "max long {} current position {} open bids {}",
                max_long,
                current_position,
                open_bids
            );
            return Err(ErrorCode::OrderSizeBreached.into());
        }

        let max_short = current_position.safe_add(open_asks)?;
        if max_short < self.min_position {
            msg!(
                "market index {} market type {:?}",
                self.market_index,
                self.market_type
            );
            msg!(
                "max short {} current position {} open asks {}",
                max_short,
                current_position,
                open_asks
            );
            return Err(ErrorCode::OrderSizeBreached.into());
        }

        Ok(())
    }
}

#[derive(Clone, Copy, BorshSerialize, BorshDeserialize, PartialEq, Debug, Eq)]
pub enum MarketType {
    Perp,
    Spot,
}

impl MarketType {
    pub fn to_drift_param(self) -> DriftMarketType {
        match self {
            MarketType::Spot => DriftMarketType::Spot,
            MarketType::Perp => DriftMarketType::Perp,
        }
    }
}

#[error_code]
#[derive(PartialEq, Eq)]
pub enum ErrorCode {
    #[msg("BidNotCrossed")]
    BidNotCrossed,
    #[msg("AskNotCrossed")]
    AskNotCrossed,
    #[msg("TakerOrderNotFound")]
    TakerOrderNotFound,
    #[msg("OrderSizeBreached")]
    OrderSizeBreached,
}

fn place_and_make<'info>(
    ctx: Context<'_, '_, '_, 'info, Jit<'info>>,
    taker_order_id: u32,
    order_params: OrderParams,
) -> Result<()> {
    let drift_program = ctx.accounts.drift_program.to_account_info().clone();
    let cpi_accounts = PlaceAndMake {
        state: ctx.accounts.state.to_account_info().clone(),
        user: ctx.accounts.user.to_account_info().clone(),
        user_stats: ctx.accounts.user_stats.to_account_info().clone(),
        authority: ctx.accounts.authority.to_account_info().clone(),
        taker: ctx.accounts.taker.to_account_info().clone(),
        taker_stats: ctx.accounts.taker_stats.to_account_info().clone(),
    };

    let cpi_context = CpiContext::new(drift_program, cpi_accounts)
        .with_remaining_accounts(ctx.remaining_accounts.into());

    if order_params.market_type == DriftMarketType::Perp {
        drift::cpi::place_and_make_perp_order(cpi_context, order_params, taker_order_id)?;
    } else {
        drift::cpi::place_and_make_spot_order(cpi_context, order_params, taker_order_id, None)?;
    }

    Ok(())
}
