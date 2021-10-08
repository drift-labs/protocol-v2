use crate::error::{ClearingHouseResult, ErrorCode};
use crate::instructions::InitializeUserOptionalAccounts;
use anchor_lang::prelude::{AccountInfo, Pubkey};
use solana_program::msg;
use spl_token::solana_program::program_pack::{IsInitialized, Pack};
use spl_token::state::{Account, Mint};

pub fn get_whitelist_token(
    optional_accounts: InitializeUserOptionalAccounts,
    accounts: &[AccountInfo],
) -> ClearingHouseResult<Option<Account>> {
    if !optional_accounts.whitelist_token {
        return Ok(None);
    }

    if accounts.len() != 1 {
        return Err(ErrorCode::WhitelistTokenNotFound.into());
    }
    let token_account_info = &accounts[0];

    let token_account = Account::unpack_unchecked(&token_account_info.data.borrow())
        .or(Err(ErrorCode::InvalidWhitelistToken.into()))?;

    if !token_account.is_initialized() {
        return Err(ErrorCode::InvalidWhitelistToken.into());
    }

    return Ok(Some(token_account));
}
