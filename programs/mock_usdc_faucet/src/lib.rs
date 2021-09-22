use anchor_lang::prelude::*;
use anchor_spl::token::{self, Mint, Token, TokenAccount};

declare_id!("FpamDNbBXYujFzRcmqbJCi618Se6S8Q1jKUDAggo5Qze");

#[program]
pub mod mock_usdc_faucet {
    use super::*;
    use anchor_spl::token::MintTo;

    #[state]
    pub struct MockUSDCFaucet {
        pub admin: Pubkey,
        pub mint: Pubkey,
        pub mint_authority: Pubkey,
        pub mint_authority_nonce: u8,
    }

    impl MockUSDCFaucet {
        pub fn new(ctx: Context<InitializeMockUSDCFaucet>) -> Result<Self> {
            let mint_account_key = ctx.accounts.mint_account.to_account_info().key;
            let (mint_authority, mint_authority_nonce) =
                Pubkey::find_program_address(&[mint_account_key.as_ref()], ctx.program_id);

            if ctx.accounts.mint_account.mint_authority.unwrap() != mint_authority {
                return Err(ErrorCode::InvalidMintAccountAuthority.into());
            }

            Ok(Self {
                admin: *ctx.accounts.admin.key,
                mint: *mint_account_key,
                mint_authority,
                mint_authority_nonce,
            })
        }

        pub fn mint_to_user(&self, ctx: Context<MintToUser>, amount: u64) -> ProgramResult {
            let mint_signature_seeds = [
                self.mint.as_ref(),
                bytemuck::bytes_of(&self.mint_authority_nonce),
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
}

#[derive(Accounts)]
pub struct InitializeMockUSDCFaucet<'info> {
    pub admin: Signer<'info>,
    pub mint_account: Account<'info, Mint>,
    pub rent: Sysvar<'info, Rent>,
}

#[derive(Accounts)]
pub struct UpdateMaxUserAmount<'info> {
    pub admin: Signer<'info>,
}

#[derive(Accounts)]
pub struct MintToUser<'info> {
    #[account(mut)]
    pub mint_account: Account<'info, Mint>,
    #[account(mut)]
    pub user_token_account: Account<'info, TokenAccount>,
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

fn admin<'info>(
    state: &mock_usdc_faucet::MockUSDCFaucet,
    signer: &AccountInfo<'info>,
) -> Result<()> {
    if !signer.key.eq(&state.admin) {
        return Err(ErrorCode::Unauthorized.into());
    }
    Ok(())
}
