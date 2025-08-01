use crate::error::ErrorCode;
use crate::signer::get_signer_seeds;
use crate::validate;
use anchor_lang::prelude::*;
use anchor_spl::token_2022::spl_token_2022;
use anchor_spl::token_2022::spl_token_2022::extension::transfer_fee::TransferFeeConfig;
use anchor_spl::token_2022::spl_token_2022::extension::{
    BaseStateWithExtensions, StateWithExtensions,
};
use anchor_spl::token_2022::spl_token_2022::state::Mint as MintInner;
use anchor_spl::token_interface::{
    self, CloseAccount, Mint, TokenAccount, TokenInterface, Transfer, TransferChecked,
};
use std::iter::Peekable;
use std::slice::Iter;

pub fn send_from_program_vault<'info>(
    token_program: &Interface<'info, TokenInterface>,
    from: &InterfaceAccount<'info, TokenAccount>,
    to: &InterfaceAccount<'info, TokenAccount>,
    authority: &AccountInfo<'info>,
    nonce: u8,
    amount: u64,
    mint: &Option<InterfaceAccount<'info, Mint>>,
    remaining_accounts: Option<&mut Peekable<Iter<'info, AccountInfo<'info>>>>,
) -> Result<()> {
    let signature_seeds = get_signer_seeds(&nonce);
    let signers = &[&signature_seeds[..]];

    if let Some(mint) = mint {
        if let Some(remaining_accounts) = remaining_accounts {
            transfer_checked_with_transfer_hook(
                token_program,
                from,
                to,
                authority,
                amount,
                mint,
                remaining_accounts,
                signers,
            )
        } else {
            let mint_account_info = mint.to_account_info();

            validate_mint_fee(&mint_account_info)?;

            let cpi_accounts = TransferChecked {
                from: from.to_account_info(),
                mint: mint_account_info,
                to: to.to_account_info(),
                authority: authority.to_account_info(),
            };

            let cpi_program = token_program.to_account_info();
            let cpi_context = CpiContext::new_with_signer(cpi_program, cpi_accounts, signers);
            token_interface::transfer_checked(cpi_context, amount, mint.decimals)
        }
    } else {
        let cpi_accounts = Transfer {
            from: from.to_account_info(),
            to: to.to_account_info(),
            authority: authority.to_account_info(),
        };

        let cpi_program = token_program.to_account_info();
        let cpi_context = CpiContext::new_with_signer(cpi_program, cpi_accounts, signers);
        #[allow(deprecated)]
        token_interface::transfer(cpi_context, amount)
    }
}

pub fn receive<'info>(
    token_program: &Interface<'info, TokenInterface>,
    from: &InterfaceAccount<'info, TokenAccount>,
    to: &InterfaceAccount<'info, TokenAccount>,
    authority: &AccountInfo<'info>,
    amount: u64,
    mint: &Option<InterfaceAccount<'info, Mint>>,
    remaining_accounts: Option<&mut Peekable<Iter<'info, AccountInfo<'info>>>>,
) -> Result<()> {
    if let Some(mint) = mint {
        if let Some(remaining_account_metas) = remaining_accounts {
            transfer_checked_with_transfer_hook(
                token_program,
                from,
                to,
                authority,
                amount,
                mint,
                remaining_account_metas,
                &[],
            )
        } else {
            let mint_account_info = mint.to_account_info();

            validate_mint_fee(&mint_account_info)?;

            let cpi_accounts = TransferChecked {
                from: from.to_account_info(),
                to: to.to_account_info(),
                mint: mint_account_info,
                authority: authority.to_account_info(),
            };
            let cpi_program = token_program.to_account_info();
            let cpi_context = CpiContext::new(cpi_program, cpi_accounts);
            token_interface::transfer_checked(cpi_context, amount, mint.decimals)
        }
    } else {
        let cpi_accounts = Transfer {
            from: from.to_account_info(),
            to: to.to_account_info(),
            authority: authority.to_account_info(),
        };
        let cpi_program = token_program.to_account_info();
        let cpi_context = CpiContext::new(cpi_program, cpi_accounts);
        #[allow(deprecated)]
        token_interface::transfer(cpi_context, amount)
    }
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
        account: account.to_account_info(),
        destination: destination.clone(),
        authority: authority.to_account_info(),
    };
    let cpi_program = token_program.to_account_info();
    let cpi_context = CpiContext::new_with_signer(cpi_program, cpi_accounts, signers);
    token_interface::close_account(cpi_context)
}

pub fn validate_mint_fee(account_info: &AccountInfo) -> Result<()> {
    let mint_data = account_info.try_borrow_data()?;
    let mint_with_extension = StateWithExtensions::<MintInner>::unpack(&mint_data)?;
    if let Ok(fee_config) = mint_with_extension.get_extension::<TransferFeeConfig>() {
        let fee = u16::from(
            fee_config
                .get_epoch_fee(Clock::get()?.epoch)
                .transfer_fee_basis_points,
        );
        validate!(fee == 0, ErrorCode::NonZeroTransferFee)?
    }

    Ok(())
}

pub fn transfer_checked_with_transfer_hook<'info>(
    token_program: &Interface<'info, TokenInterface>,
    from: &InterfaceAccount<'info, TokenAccount>,
    to: &InterfaceAccount<'info, TokenAccount>,
    authority: &AccountInfo<'info>,
    amount: u64,
    mint: &InterfaceAccount<'info, Mint>,
    remaining_accounts: &mut Peekable<Iter<'info, AccountInfo<'info>>>,
    signer_seeds: &[&[&[u8]]],
) -> Result<()> {
    let mint_account_info = mint.to_account_info();

    validate_mint_fee(&mint_account_info)?;

    let from_account_info = from.to_account_info();
    let to_account_info = to.to_account_info();
    let authority_account_info = authority.to_account_info();

    let mut ix = spl_token_2022::instruction::transfer_checked(
        token_program.key,
        &from_account_info.key,
        &mint_account_info.key,
        &to_account_info.key,
        &authority_account_info.key,
        &[],
        amount,
        mint.decimals,
    )?;

    let mut account_infos = vec![
        from_account_info,
        mint_account_info,
        to_account_info,
        authority_account_info,
    ];

    for account_info in remaining_accounts {
        ix.accounts.push(if account_info.is_writable {
            AccountMeta::new(*account_info.key, account_info.is_signer)
        } else {
            AccountMeta::new_readonly(*account_info.key, account_info.is_writable)
        });
        account_infos.push(account_info.to_account_info());
    }

    solana_program::program::invoke_signed(&ix, &account_infos, signer_seeds).map_err(Into::into)
}
