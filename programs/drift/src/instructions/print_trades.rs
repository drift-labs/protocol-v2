use crate::optional_accounts::{load_maps, AccountMaps};
use crate::state::perp_market_map::MarketSet;
use crate::state::print_trade::PrintTrade;
use crate::state::traits::Size;
use crate::state::user::User;
use crate::{can_sign_for_user, MarketType, PositionDirection, State};
use anchor_lang::prelude::*;
use crate::controller::print_trades::place_perp_orders_for_print_trade;

#[derive(Accounts)]
pub struct InitializePrintTrade<'info> {
    pub state: Box<Account<'info, State>>,

    #[account(
        init,
        seeds = [
            b"print_trade",
            creator.key().as_ref(),
            counterparty.key().as_ref(),
        ],
        space = PrintTrade::SIZE,
        bump,
        payer = creator_owner
    )]
    pub print_trade: Box<Account<'info, PrintTrade>>,

    #[account(
        mut,
        constraint = can_sign_for_user(&creator, &creator_owner)?
    )]
    pub creator_owner: Signer<'info>,
    pub creator: AccountLoader<'info, User>,

    #[account(
        mut,
        constraint = can_sign_for_user(&counterparty, &counterparty_owner)?
    )]
    pub counterparty_owner: Signer<'info>,
    pub counterparty: AccountLoader<'info, User>,

    pub system_program: Program<'info, System>,
    pub clock: Sysvar<'info, Clock>,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Default)]
pub struct PrintTradeParams {
    pub market_type: MarketType,
    pub creator_direction: PositionDirection,
    pub counterparty_direction: PositionDirection,
    pub base_asset_amount: u64,
    pub price: u64,
    pub market_index: u16,
    pub reduce_only: bool,
    pub post_only: bool,
}

pub fn handle_initialize_print_trade(
    ctx: Context<InitializePrintTrade>,
    params: PrintTradeParams,
) -> Result<()> {
    let clock = &Clock::get()?;
    let state = &ctx.accounts.state;

    let AccountMaps {
        perp_market_map,
        spot_market_map,
        mut oracle_map,
    } = load_maps(
        &mut ctx.remaining_accounts.iter().peekable(),
        &MarketSet::new(),
        &MarketSet::new(),
        clock.slot,
        Some(state.oracle_guard_rails),
    )?;

    place_perp_orders_for_print_trade(
        &state,
        &mut ctx.accounts.print_trade,
        &ctx.accounts.creator,
        &ctx.accounts.counterparty,
        &perp_market_map,
        &spot_market_map,
        &mut oracle_map,
        &ctx.accounts.clock,
        params,
    ).unwrap();

    Ok(())
}
