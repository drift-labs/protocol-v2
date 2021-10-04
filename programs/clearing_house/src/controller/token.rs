use anchor_lang::prelude::AccountInfo;
use anchor_lang::prelude::*;
use anchor_lang::{Account, CpiContext};
use anchor_spl::token::{self, Token, TokenAccount, Transfer};

pub fn send<'info>(
    token_program: &Program<'info, Token>,
    from: &Account<'info, TokenAccount>,
    to: &Account<'info, TokenAccount>,
    authority: &AccountInfo<'info>,
    nonce: u8,
    amount: u64,
) -> ProgramResult {
    let from_key = from.key();
    let signature_seeds = [from_key.as_ref(), bytemuck::bytes_of(&nonce)];
    let signers = &[&signature_seeds[..]];
    let cpi_accounts = Transfer {
        from: from.to_account_info().clone(),
        to: to.to_account_info().clone(),
        authority: authority.to_account_info().clone(),
    };
    let cpi_program = token_program.to_account_info();
    let cpi_context = CpiContext::new_with_signer(cpi_program, cpi_accounts, signers);
    return token::transfer(cpi_context, amount);
}

pub fn receive<'info>(
    token_program: &Program<'info, Token>,
    from: &Account<'info, TokenAccount>,
    to: &Account<'info, TokenAccount>,
    authority: &AccountInfo<'info>,
    amount: u64,
) -> ProgramResult {
    let cpi_accounts = Transfer {
        from: from.to_account_info().clone(),
        to: to.to_account_info().clone(),
        authority: authority.to_account_info().clone(),
    };
    let cpi_program = token_program.to_account_info();
    let cpi_context = CpiContext::new(cpi_program, cpi_accounts);
    return token::transfer(cpi_context, amount);
}
