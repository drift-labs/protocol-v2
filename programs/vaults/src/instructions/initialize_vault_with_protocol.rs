use anchor_lang::prelude::*;
use anchor_spl::token::{Mint, Token, TokenAccount};
use velocity::cpi::accounts::{InitializeUser, InitializeUserStats};
use velocity::math::casting::Cast;
use velocity::math::constants::PERCENTAGE_PRECISION_U64;
use velocity::program::Velocity;
use velocity::state::spot_market::SpotMarket;

use crate::constants::ONE_DAY;
use crate::state::{Vault, VaultProtocol};
use crate::velocity_cpi::InitializeUserCPI;
use crate::{error::ErrorCode, validate, Size};

pub fn initialize_vault_with_protocol<'info>(
    ctx: Context<'info, InitializeVaultWithProtocol<'info>>,
    params: VaultWithProtocolParams,
) -> Result<()> {
    let bump = ctx.bumps.vault;

    let mut vault = ctx.accounts.vault.load_init()?;
    vault.name = params.name;
    vault.pubkey = *ctx.accounts.vault.to_account_info().key;
    vault.manager = *ctx.accounts.manager.key;
    vault.user_stats = *ctx.accounts.velocity_user_stats.key;
    vault.user = *ctx.accounts.velocity_user.key;
    vault.token_account = *ctx.accounts.token_account.to_account_info().key;
    vault.spot_market_index = params.spot_market_index;
    vault.init_ts = Clock::get()?.unix_timestamp;

    let mut vp = ctx.accounts.vault_protocol.load_init()?;

    validate!(
        params.redeem_period < ONE_DAY * 90,
        ErrorCode::InvalidVaultInitialization,
        "redeem period must be < 90 days"
    )?;
    vault.redeem_period = params.redeem_period;

    vault.max_tokens = params.max_tokens;
    vault.min_deposit_amount = params.min_deposit_amount;

    validate!(
        params
            .management_fee
            .saturating_add(params.vault_protocol.protocol_fee.cast::<i64>()?)
            < PERCENTAGE_PRECISION_U64.cast()?,
        ErrorCode::InvalidVaultInitialization,
        "management fee plus protocol fee must be < 100%"
    )?;
    vault.management_fee = params.management_fee;
    vp.protocol_fee = params.vault_protocol.protocol_fee;

    validate!(
        params
            .profit_share
            .saturating_add(params.vault_protocol.protocol_profit_share)
            < PERCENTAGE_PRECISION_U64.cast()?,
        ErrorCode::InvalidVaultInitialization,
        "manager profit share protocol profit share must be < 100%"
    )?;
    vault.profit_share = params.profit_share;
    vp.protocol_profit_share = params.vault_protocol.protocol_profit_share;
    vp.protocol = params.vault_protocol.protocol;

    let vp_bump = ctx.bumps.vault_protocol;
    // let (_, vp_bump) = Pubkey::find_program_address(
    //     &[b"vault_protocol", ctx.accounts.vault.key().as_ref()],
    //     ctx.program_id,
    // );
    vp.bump = vp_bump;

    vault.vault_protocol = true;

    validate!(
        params.hurdle_rate == 0,
        ErrorCode::InvalidVaultInitialization,
        "hurdle rate not implemented"
    )?;
    vault.hurdle_rate = params.hurdle_rate;
    vault.bump = bump;
    vault.permissioned = params.permissioned;

    drop(vault);
    drop(vp);

    ctx.velocity_initialize_user_stats(params.name, bump)?;
    ctx.velocity_initialize_user(params.name, bump)?;

    Ok(())
}

#[derive(Debug, Clone, Copy, AnchorSerialize, AnchorDeserialize, PartialEq, Eq)]
pub struct VaultWithProtocolParams {
    pub name: [u8; 32],
    pub redeem_period: i64,
    pub max_tokens: u64,
    pub management_fee: i64,
    pub min_deposit_amount: u64,
    pub profit_share: u32,
    pub hurdle_rate: u32,
    pub spot_market_index: u16,
    pub permissioned: bool,
    pub vault_protocol: VaultProtocolParams,
}

#[derive(Debug, Clone, Copy, AnchorSerialize, AnchorDeserialize, PartialEq, Eq)]
pub struct VaultProtocolParams {
    pub protocol: Pubkey,
    pub protocol_fee: u64,
    pub protocol_profit_share: u32,
}

#[derive(Accounts)]
#[instruction(params: VaultWithProtocolParams)]
pub struct InitializeVaultWithProtocol<'info> {
    #[account(
        init,
        seeds = [b"vault", params.name.as_ref()],
        space = Vault::SIZE,
        bump,
        payer = payer
    )]
    pub vault: AccountLoader<'info, Vault>,

    #[account(
        init,
        seeds = [b"vault_protocol", vault.key().as_ref()],
        space = VaultProtocol::SIZE,
        bump,
        payer = payer
    )]
    pub vault_protocol: AccountLoader<'info, VaultProtocol>,

    #[account(
        init,
        seeds = [b"vault_token_account".as_ref(), vault.key().as_ref()],
        bump,
        payer = payer,
        token::mint = velocity_spot_market_mint,
        token::authority = vault
    )]
    pub token_account: Box<Account<'info, TokenAccount>>,
    /// CHECK: checked in velocity cpi
    #[account(mut)]
    pub velocity_user_stats: AccountInfo<'info>,
    /// CHECK: checked in velocity cpi
    #[account(mut)]
    pub velocity_user: AccountInfo<'info>,
    /// CHECK: checked in velocity cpi
    #[account(mut)]
    pub velocity_state: AccountInfo<'info>,
    #[account(
        constraint = velocity_spot_market.load()?.market_index == params.spot_market_index
    )]
    pub velocity_spot_market: AccountLoader<'info, SpotMarket>,
    #[account(
        constraint = velocity_spot_market.load()?.mint.eq(&velocity_spot_market_mint.key())
    )]
    pub velocity_spot_market_mint: Box<Account<'info, Mint>>,
    pub manager: Signer<'info>,
    #[account(mut)]
    pub payer: Signer<'info>,
    pub rent: Sysvar<'info, Rent>,
    pub system_program: Program<'info, System>,
    pub velocity_program: Program<'info, Velocity>,
    pub token_program: Program<'info, Token>,
}

impl<'info> InitializeUserCPI for Context<'info, InitializeVaultWithProtocol<'info>> {
    fn velocity_initialize_user(&self, name: [u8; 32], bump: u8) -> Result<()> {
        let signature_seeds = Vault::get_vault_signer_seeds(&name, &bump);
        let signers = &[&signature_seeds[..]];

        let cpi_program = self.accounts.velocity_program.key();
        let cpi_accounts = InitializeUser {
            user_stats: self.accounts.velocity_user_stats.clone(),
            user: self.accounts.velocity_user.clone(),
            state: self.accounts.velocity_state.clone(),
            authority: self.accounts.vault.to_account_info().clone(),
            payer: self.accounts.payer.to_account_info().clone(),
            rent: self.accounts.rent.to_account_info().clone(),
            system_program: self.accounts.system_program.to_account_info().clone(),
        };
        let cpi_ctx = CpiContext::new_with_signer(cpi_program, cpi_accounts, signers);
        let sub_account_id = 0_u16;
        velocity::cpi::initialize_user(cpi_ctx, sub_account_id, name)?;

        Ok(())
    }

    fn velocity_initialize_user_stats(&self, name: [u8; 32], bump: u8) -> Result<()> {
        let signature_seeds = Vault::get_vault_signer_seeds(&name, &bump);
        let signers = &[&signature_seeds[..]];

        let cpi_program = self.accounts.velocity_program.key();
        let cpi_accounts = InitializeUserStats {
            user_stats: self.accounts.velocity_user_stats.clone(),
            state: self.accounts.velocity_state.clone(),
            authority: self.accounts.vault.to_account_info().clone(),
            payer: self.accounts.payer.to_account_info().clone(),
            rent: self.accounts.rent.to_account_info().clone(),
            system_program: self.accounts.system_program.to_account_info().clone(),
        };
        let cpi_ctx = CpiContext::new_with_signer(cpi_program, cpi_accounts, signers);
        velocity::cpi::initialize_user_stats(cpi_ctx)?;

        Ok(())
    }
}
