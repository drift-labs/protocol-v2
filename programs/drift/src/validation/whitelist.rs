use crate::error::{DriftResult, ErrorCode};
use crate::validate;
use anchor_lang::prelude::{Account, Pubkey};
use anchor_spl::token::TokenAccount;
use solana_program::msg;

pub fn validate_whitelist_token(
    whitelist_token: Account<TokenAccount>,
    whitelist_mint: &Pubkey,
    authority: &Pubkey,
) -> DriftResult {
    validate!(
        &whitelist_token.owner == authority,
        ErrorCode::InvalidWhitelistToken,
        "Whitelist token owner ({:?}) does not match authority ({:?})",
        whitelist_token.owner,
        authority
    )?;

    validate!(
        &whitelist_token.mint == whitelist_mint,
        ErrorCode::InvalidWhitelistToken,
        "Token mint ({:?}) does not whitelist mint ({:?})",
        whitelist_token.mint,
        whitelist_mint
    )?;

    validate!(
        whitelist_token.amount > 0,
        ErrorCode::InvalidWhitelistToken,
        "Whitelist token amount must be > 0",
    )?;

    Ok(())
}
