use anchor_lang::prelude::*;
use anchor_spl::token::{self, Mint, Token, TokenAccount};

#[cfg(feature = "mainnet-beta")]
declare_id!("AmNeSW4UMPFBodCjEJD22G3kA8EraUGkhxr3GmdyEF4f");
#[cfg(not(feature = "mainnet-beta"))]
declare_id!("GvMhkYZmtnCL7jfVsTKz5zi1Jmd5dqRTHaXJL2ps1Gb");

#[program]
pub mod mock_usdc_faucet {
    use super::*;
    use anchor_spl::token::MintTo;

    pub fn initialize(
        ctx: Context<InitializeMockUSDCFaucet>,
        _mock_usdc_faucet_nonce: u8,
    ) -> ProgramResult {
        let mint_account_key = ctx.accounts.mint_account.to_account_info().key;
        let (mint_authority, mint_authority_nonce) =
            Pubkey::find_program_address(&[mint_account_key.as_ref()], ctx.program_id);

        if ctx.accounts.mint_account.mint_authority.unwrap() != mint_authority {
            return Err(ErrorCode::InvalidMintAccountAuthority.into());
        }

        **ctx.accounts.mock_usdc_faucet_state = MockUSDCFaucetState {
            admin: *ctx.accounts.admin.key,
            mint: *mint_account_key,
            mint_authority,
            mint_authority_nonce,
        };

        Ok(())
    }

    pub fn mint_to_user(ctx: Context<MintToUser>, amount: u64) -> ProgramResult {
        let mint_signature_seeds = [
            ctx.accounts.mock_usdc_faucet_state.mint.as_ref(),
            bytemuck::bytes_of(&ctx.accounts.mock_usdc_faucet_state.mint_authority_nonce),
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
}

#[derive(Accounts)]
#[instruction(mock_usdc_faucet_nonce: u8)]
pub struct InitializeMockUSDCFaucet<'info> {
    #[account(
        init,
        seeds = [b"mock_usdc_faucet".as_ref()],
        bump = mock_usdc_faucet_nonce,
        payer = admin
    )]
    pub mock_usdc_faucet_state: Box<Account<'info, MockUSDCFaucetState>>,
    pub admin: Signer<'info>,
    pub mint_account: Box<Account<'info, Mint>>,
    pub rent: Sysvar<'info, Rent>,
    pub system_program: Program<'info, System>,
}

#[account]
#[derive(Default)]
pub struct MockUSDCFaucetState {
    pub admin: Pubkey,
    pub mint: Pubkey,
    pub mint_authority: Pubkey,
    pub mint_authority_nonce: u8,
}

#[derive(Accounts)]
pub struct MintToUser<'info> {
    pub mock_usdc_faucet_state: Box<Account<'info, MockUSDCFaucetState>>,
    #[account(mut)]
    pub mint_account: Box<Account<'info, Mint>>,
    #[account(mut)]
    pub user_token_account: Box<Account<'info, TokenAccount>>,
    pub mint_authority: AccountInfo<'info>,
    pub token_program: Program<'info, Token>,
}

#[error]
pub enum ErrorCode {
    #[msg("Program not mint authority")]
    InvalidMintAccountAuthority,
    #[msg("Signer must be MockUSDCFaucet admin")]
    Unauthorized,
}
