/// Switchboard account definitions and parsers
pub mod accounts;
pub use accounts::*;
/// Oracle quote verification and data extraction
pub mod oracle_quote;
pub use oracle_quote::*;

use crate::solana_compat::pubkey;
use crate::Pubkey;

/// Address Lookup Table program ID
pub const ADDRESS_LOOKUP_TABLE_PROGRAM_ID: Pubkey =
    pubkey!("AddressLookupTab1e1111111111111111111111111");

pub const SPL_TOKEN_PROGRAM_ID: Pubkey =
    pubkey!("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");

/// Derives associated token address and bump seed for given wallet and mint
pub fn get_associated_token_address_and_bump_seed(
    wallet_address: &Pubkey,
    token_mint_address: &Pubkey,
    program_id: &Pubkey,
    token_program_id: &Pubkey,
) -> (Pubkey, u8) {
    get_associated_token_address_and_bump_seed_internal(
        wallet_address,
        token_mint_address,
        program_id,
        token_program_id,
    )
}

/// Derives the associated token account address for the given wallet address
/// and token mint
pub fn get_associated_token_address(
    wallet_address: &Pubkey,
    token_mint_address: &Pubkey,
) -> Pubkey {
    get_associated_token_address_with_program_id(
        wallet_address,
        token_mint_address,
        &SPL_TOKEN_PROGRAM_ID
    )
}

/// Derives the associated token account address for the given wallet address,
/// token mint and token program id
pub fn get_associated_token_address_with_program_id(
    wallet_address: &Pubkey,
    token_mint_address: &Pubkey,
    token_program_id: &Pubkey,
) -> Pubkey {
    get_associated_token_address_and_bump_seed(
        wallet_address,
        token_mint_address,
        &pubkey!("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL")
            .to_bytes()
            .into(),
        token_program_id,
    )
    .0
}

fn get_associated_token_address_and_bump_seed_internal(
    wallet_address: &Pubkey,
    token_mint_address: &Pubkey,
    program_id: &Pubkey,
    token_program_id: &Pubkey,
) -> (Pubkey, u8) {
    Pubkey::find_program_address(
        &[
            &wallet_address.to_bytes(),
            &token_program_id.to_bytes(),
            &token_mint_address.to_bytes(),
        ],
        program_id,
    )
}
