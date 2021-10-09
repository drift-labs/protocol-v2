use crate::error::{ClearingHouseResult, ErrorCode};
use crate::instructions::{InitializeUserOptionalAccounts, ManagePositionOptionalAccounts};
use crate::state::user::User;
use anchor_lang::prelude::{AccountInfo, Pubkey};
use anchor_lang::Account;
use solana_program::account_info::next_account_info;
use solana_program::msg;
use spl_token::solana_program::program_pack::{IsInitialized, Pack};
use spl_token::state::{Account as TokenAccount, Mint};

pub fn get_whitelist_token(
    optional_accounts: InitializeUserOptionalAccounts,
    accounts: &[AccountInfo],
    whitelist_mint: &Pubkey,
) -> ClearingHouseResult<Option<TokenAccount>> {
    if !optional_accounts.whitelist_token {
        return Ok(None);
    }

    if accounts.len() != 1 {
        return Err(ErrorCode::WhitelistTokenNotFound.into());
    }
    let token_account_info = &accounts[0];

    let token_account = TokenAccount::unpack_unchecked(&token_account_info.data.borrow())
        .or(Err(ErrorCode::InvalidWhitelistToken.into()))?;

    if !token_account.is_initialized() {
        return Err(ErrorCode::InvalidWhitelistToken.into());
    }

    if !token_account.mint.eq(whitelist_mint) {
        return Err(ErrorCode::InvalidWhitelistToken.into());
    }

    return Ok(Some(token_account));
}

pub fn get_drift_token_and_referrer<'a, 'b, 'c, 'd>(
    optional_accounts: ManagePositionOptionalAccounts,
    accounts: &'a [AccountInfo<'b>],
    drift_mint: &'c Pubkey,
    user_public_key: &'d Pubkey,
) -> ClearingHouseResult<(Option<TokenAccount>, Option<Account<'b, User>>)> {
    let mut optional_drift_token = None;
    let mut optional_referrer = None;

    let account_info_iter = &mut accounts.iter();
    if optional_accounts.drift_token {
        let token_account_info =
            next_account_info(account_info_iter).or(Err(ErrorCode::DriftTokenNotFound.into()))?;

        let token_account = TokenAccount::unpack_unchecked(&token_account_info.data.borrow())
            .or(Err(ErrorCode::InvalidDriftToken.into()))?;

        if !token_account.is_initialized() {
            return Err(ErrorCode::InvalidDriftToken.into());
        }

        if !token_account.mint.eq(drift_mint) {
            return Err(ErrorCode::InvalidDriftToken.into());
        }

        optional_drift_token = Some(token_account);
    }

    if optional_accounts.referrer {
        let referrer_account_info =
            next_account_info(account_info_iter).or(Err(ErrorCode::ReferrerNotFound.into()))?;

        if !referrer_account_info.key.eq(user_public_key) {
            let user_account: Account<User> =
                Account::try_from(referrer_account_info).or(Err(ErrorCode::InvalidReferrer))?;

            optional_referrer = Some(user_account);
        }
    }

    return Ok((optional_drift_token, optional_referrer));
}
