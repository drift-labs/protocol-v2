use crate::signer::get_signer_seeds;
use anchor_lang::prelude::*;
use anchor_spl::token_interface::{self, CloseAccount, TokenAccount, TokenInterface, Transfer};

pub fn send_from_program_vault<'info>(
    token_program: &Interface<'info, TokenInterface>,
    from: &InterfaceAccount<'info, TokenAccount>,
    to: &InterfaceAccount<'info, TokenAccount>,
    authority: &AccountInfo<'info>,
    nonce: u8,
    amount: u64,
) -> Result<()> {
    let signature_seeds = get_signer_seeds(&nonce);
    let signers = &[&signature_seeds[..]];
    let cpi_accounts = Transfer {
        from: from.to_account_info().clone(),
        to: to.to_account_info().clone(),
        authority: authority.to_account_info().clone(),
    };
    let cpi_program = token_program.to_account_info();
    let cpi_context = CpiContext::new_with_signer(cpi_program, cpi_accounts, signers);
    token_interface::transfer(cpi_context, amount)
}

pub fn receive<'info>(
    token_program: &Interface<'info, TokenInterface>,
    from: &InterfaceAccount<'info, TokenAccount>,
    to: &InterfaceAccount<'info, TokenAccount>,
    authority: &AccountInfo<'info>,
    amount: u64,
) -> Result<()> {
    let cpi_accounts = Transfer {
        from: from.to_account_info().clone(),
        to: to.to_account_info().clone(),
        authority: authority.to_account_info().clone(),
    };
    let cpi_program = token_program.to_account_info();
    let cpi_context = CpiContext::new(cpi_program, cpi_accounts);
    token_interface::transfer(cpi_context, amount)
}

pub fn close_vault<'info>(
    token_program: &Interface<'info, TokenInterface>,
    account: &InterfaceAccount<'info, TokenAccount>,
    destination: &AccountInfo<'info>,
    authority: &AccountInfo<'info>,
    nonce: u8,
) -> Result<()> {
    let signature_seeds = get_signer_seeds(&nonce);
    let signers = &[&signature_seeds[..]];
    let cpi_accounts = CloseAccount {
        account: account.to_account_info().clone(),
        destination: destination.clone(),
        authority: authority.to_account_info().clone(),
    };
    let cpi_program = token_program.to_account_info();
    let cpi_context = CpiContext::new_with_signer(cpi_program, cpi_accounts, signers);
    token_interface::close_account(cpi_context)
}
