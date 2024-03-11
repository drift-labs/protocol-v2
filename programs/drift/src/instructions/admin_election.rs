use crate::{
    state::{admin_election_config::AdminElectionConfig, traits::Size},
    State,
};
use anchor_lang::prelude::*;

pub fn handle_initialize_admin_election_config(
    ctx: Context<InitializeElectionConfig>,
    election_signer: Pubkey,
) -> Result<()> {
    let mut election_config = ctx.accounts.admin_election_config.load_init()?;
    election_config.election_signer = election_signer;
    Ok(())
}

pub fn handle_update_election_signer(
    ctx: Context<UpdateElectionSigner>,
    election_signer: Pubkey,
) -> Result<()> {
    let mut election_config = ctx.accounts.admin_election_config.load_mut()?;
    election_config.election_signer = election_signer;
    Ok(())
}

pub fn handle_election_update_admin(ctx: Context<UpdateAdmin>, admin: Pubkey) -> Result<()> {
    let state = &mut ctx.accounts.state;
    state.admin = admin;
    Ok(())
}

#[derive(Accounts)]
pub struct InitializeElectionConfig<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    #[account(
        init,
        seeds = [b"admin_election_config".as_ref()],
        space = AdminElectionConfig::SIZE,
        bump,
        payer = admin
    )]
    pub admin_election_config: AccountLoader<'info, AdminElectionConfig>,
    #[account(
        has_one = admin
    )]
    pub state: Box<Account<'info, State>>,
    pub rent: Sysvar<'info, Rent>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct UpdateElectionSigner<'info> {
    #[account(mut)]
    pub election_signer: Signer<'info>,
    #[account(
        mut,
        seeds = [b"admin_election_config".as_ref()],
        bump,
        has_one = election_signer
    )]
    pub admin_election_config: AccountLoader<'info, AdminElectionConfig>,
}

#[derive(Accounts)]
pub struct UpdateAdmin<'info> {
    #[account(mut)]
    pub election_signer: Signer<'info>,
    #[account(
        mut,
        seeds = [b"admin_election_config".as_ref()],
        bump,
        has_one = election_signer
    )]
    pub admin_election_config: AccountLoader<'info, AdminElectionConfig>,
    #[account(mut)]
    pub state: Box<Account<'info, State>>,
}
