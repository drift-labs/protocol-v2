use crate::state::print_trade::PrintTrade;
use crate::state::traits::Size;
use anchor_lang::prelude::*;

#[derive(Accounts)]
pub struct InitializePrintTrade<'info> {
    #[account(
        init,
        seeds = [b"print_trade", payer.key.as_ref()],
        space = PrintTrade::SIZE,
        bump,
        payer = payer
    )]
    pub print_trade: AccountLoader<'info, PrintTrade>,
    #[account(mut)]
    pub payer: Signer<'info>,
    pub system_program: Program<'info, System>,
}

pub fn handle_initialize_print_trade(_ctx: Context<InitializePrintTrade>) -> Result<()> {
    Ok(())
}
