use crate::error::{ClearingHouseResult, ErrorCode};
use crate::state::user::User;
use crate::validate;
use anchor_lang::prelude::AccountInfo;
use anchor_lang::prelude::AccountLoader;
use solana_program::account_info::next_account_info;
use solana_program::msg;
use std::iter::Peekable;
use std::slice::Iter;

pub fn get_maker<'a>(
    account_info_iter: &mut Peekable<Iter<AccountInfo<'a>>>,
) -> ClearingHouseResult<AccountLoader<'a, User>> {
    let maker_account_info =
        next_account_info(account_info_iter).or(Err(ErrorCode::MakerNotFound))?;

    validate!(
        maker_account_info.is_writable,
        ErrorCode::MakerMustBeWritable
    )?;

    let maker: AccountLoader<User> =
        AccountLoader::try_from(maker_account_info).or(Err(ErrorCode::CouldNotDeserializeMaker))?;

    Ok(maker)
}
