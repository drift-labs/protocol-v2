use anchor_lang::prelude::*;
use anchor_spl::token::{self, Mint, Token, TokenAccount};

#[cfg(feature = "mainnet-beta")]
declare_id!("AmNeSW4UMPFBodCjEJD22G3kA8EraUGkhxr3GmdyEF4f");
#[cfg(not(feature = "mainnet-beta"))]
declare_id!("V4v1mQiAdLz4qwckEb45WqHYceYizoib39cDBHSWfaB");

#[program]
pub mod token_faucet {
    use super::*;
    use anchor_spl::token::spl_token::instruction::AuthorityType;
    use anchor_spl::token::MintTo;
    use anchor_spl::token::SetAuthority;

    pub fn initialize(ctx: Context<InitializeFaucet>) -> Result<()> {
        let mint_account_key = ctx.accounts.mint_account.to_account_info().key;
        let (mint_authority, mint_authority_nonce) = Pubkey::find_program_address(
            &[b"mint_authority".as_ref(), mint_account_key.as_ref()],
            ctx.program_id,
        );

        let cpi_accounts = SetAuthority {
            current_authority: ctx.accounts.admin.to_account_info(),
            account_or_mint: ctx.accounts.mint_account.to_account_info(),
        };
        let cpi_program = ctx.accounts.token_program.to_account_info();
        let cpi_context = CpiContext::new(cpi_program, cpi_accounts);
        token::set_authority(cpi_context, AuthorityType::MintTokens, Some(mint_authority)).unwrap();

        **ctx.accounts.faucet_config = FaucetConfig {
            admin: *ctx.accounts.admin.key,
            mint: *mint_account_key,
            mint_authority,
            mint_authority_nonce,
        };

        Ok(())
    }

    pub fn mint_to_user(ctx: Context<MintToUser>, amount: u64) -> Result<()> {
        let mint_signature_seeds = [
            b"mint_authority".as_ref(),
            ctx.accounts.faucet_config.mint.as_ref(),
            bytemuck::bytes_of(&ctx.accounts.faucet_config.mint_authority_nonce),
        ];
        let signers = &[&mint_signature_seeds[..]];
        let cpi_accounts = MintTo {
            mint: ctx.accounts.mint_account.to_account_info(),
            to: ctx.accounts.user_token_account.to_account_info(),
            authority: ctx.accounts.mint_authority.clone(),
        };
        let cpi_program = ctx.accounts.token_program.to_account_info();
        let cpi_context = CpiContext::new_with_signer(cpi_program, cpi_accounts, signers);
        token::mint_to(cpi_context, amount).unwrap();
        Ok(())
    }

    pub fn transfer_mint_authority(ctx: Context<TransferMintAuthority>) -> Result<()> {
        let mint_signature_seeds = [
            b"mint_authority".as_ref(),
            ctx.accounts.faucet_config.mint.as_ref(),
            bytemuck::bytes_of(&ctx.accounts.faucet_config.mint_authority_nonce),
        ];
        let signers = &[&mint_signature_seeds[..]];
        let cpi_accounts = SetAuthority {
            current_authority: ctx.accounts.mint_authority.to_account_info(),
            account_or_mint: ctx.accounts.mint_account.to_account_info(),
        };
        let cpi_program = ctx.accounts.token_program.to_account_info();
        let cpi_context = CpiContext::new_with_signer(cpi_program, cpi_accounts, signers);
        token::set_authority(
            cpi_context,
            AuthorityType::MintTokens,
            Some(ctx.accounts.admin.key()),
        )
        .unwrap();
        Ok(())
    }
}

#[derive(Accounts)]
pub struct InitializeFaucet<'info> {
    #[account(
        init,
        seeds = [b"faucet_config".as_ref(), mint_account.key().as_ref()],
        space = std::mem::size_of::<FaucetConfig>() + 8,
        bump,
        payer = admin
    )]
    pub faucet_config: Box<Account<'info, FaucetConfig>>,
    #[account(mut)]
    pub admin: Signer<'info>,
    #[account(mut)]
    pub mint_account: Box<Account<'info, Mint>>,
    pub rent: Sysvar<'info, Rent>,
    pub system_program: Program<'info, System>,
    pub token_program: Program<'info, Token>,
}

#[account]
#[derive(Default)]
pub struct FaucetConfig {
    pub admin: Pubkey,
    pub mint: Pubkey,
    pub mint_authority: Pubkey,
    pub mint_authority_nonce: u8,
}

#[derive(Accounts)]
pub struct MintToUser<'info> {
    pub faucet_config: Box<Account<'info, FaucetConfig>>,
    #[account(mut)]
    pub mint_account: Box<Account<'info, Mint>>,
    #[account(mut)]
    pub user_token_account: Box<Account<'info, TokenAccount>>,
    /// CHECK: Checked by spl_token
    pub mint_authority: AccountInfo<'info>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct TransferMintAuthority<'info> {
    #[account(
        seeds = [b"faucet_config".as_ref(), mint_account.key().as_ref()],
        bump,
        has_one = admin
    )]
    pub faucet_config: Box<Account<'info, FaucetConfig>>,
    #[account(mut)]
    pub admin: Signer<'info>,
    #[account(mut)]
    pub mint_account: Box<Account<'info, Mint>>,
    /// CHECK: Checked by spl_token
    pub mint_authority: AccountInfo<'info>,
    pub token_program: Program<'info, Token>,
}

#[error_code]
pub enum ErrorCode {
    #[msg("Program not mint authority")]
    InvalidMintAccountAuthority,
}
