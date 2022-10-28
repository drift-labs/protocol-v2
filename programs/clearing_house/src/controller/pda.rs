use crate::error::{ClearingHouseResult, ErrorCode};
use crate::validate;
use anchor_lang::prelude::{AccountInfo, Pubkey};
use solana_program::msg;
use solana_program::rent::Rent;

pub fn seed_and_create_pda<'a>(
    program_id: &Pubkey,
    funder: &AccountInfo<'a>,
    rent: &Rent,
    space: usize,
    owner: &Pubkey,
    system_program: &AccountInfo<'a>,
    pda_account: &AccountInfo<'a>,
    seeds: &[&[u8]],
) -> ClearingHouseResult {
    let (pda_address, bump) = Pubkey::find_program_address(seeds, program_id);
    validate!(&pda_address == pda_account.key, ErrorCode::InvalidPDA)?;

    let bump_seed = [bump];
    let pda_signer_seeds: &[&[&[u8]]] = &[&[seeds, &[&bump_seed]].concat()];

    solana_program::program::invoke_signed_unchecked(
        &solana_program::system_instruction::create_account(
            funder.key,
            pda_account.key,
            rent.minimum_balance(space).max(1),
            space as u64,
            owner,
        ),
        &[funder.clone(), pda_account.clone(), system_program.clone()],
        pda_signer_seeds,
    )
    .map_err(|e| {
        msg!("{:?}", e);
        ErrorCode::InvalidPDASigner
    })?;

    Ok(())
}
