use crate::context::{InitializeUserOptionalAccounts, ManagePositionOptionalAccounts};
use crate::error::{ClearingHouseResult, ErrorCode};
use crate::state::user::User;
use anchor_lang::prelude::{AccountInfo, Pubkey};
use anchor_lang::Account;
use solana_program::account_info::next_account_info;
use spl_token::solana_program::program_pack::{IsInitialized, Pack};
use spl_token::state::Account as TokenAccount;

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

    spl_token::check_program_account(&token_account_info.owner)
        .map_err(|_| ErrorCode::InvalidWhitelistToken)?;

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

pub fn get_discount_token_and_referrer<'a, 'b, 'c, 'd, 'e>(
    optional_accounts: ManagePositionOptionalAccounts,
    accounts: &'a [AccountInfo<'b>],
    discount_mint: &'c Pubkey,
    user_public_key: &'d Pubkey,
    authority_public_key: &'e Pubkey,
) -> ClearingHouseResult<(Option<TokenAccount>, Option<Account<'b, User>>)> {
    let mut optional_discount_token = None;
    let mut optional_referrer = None;

    let account_info_iter = &mut accounts.iter();
    if optional_accounts.discount_token {
        let token_account_info = next_account_info(account_info_iter)
            .or(Err(ErrorCode::DiscountTokenNotFound.into()))?;

        spl_token::check_program_account(&token_account_info.owner)
            .map_err(|_| ErrorCode::InvalidDiscountToken)?;

        let token_account = TokenAccount::unpack_unchecked(&token_account_info.data.borrow())
            .or(Err(ErrorCode::InvalidDiscountToken.into()))?;

        if !token_account.is_initialized() {
            return Err(ErrorCode::InvalidDiscountToken.into());
        }

        if !token_account.mint.eq(discount_mint) {
            return Err(ErrorCode::InvalidDiscountToken.into());
        }

        if !token_account.owner.eq(authority_public_key) {
            return Err(ErrorCode::InvalidDiscountToken.into());
        }

        optional_discount_token = Some(token_account);
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

    return Ok((optional_discount_token, optional_referrer));
}
