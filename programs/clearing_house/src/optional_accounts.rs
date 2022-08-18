use crate::error::{ClearingHouseResult, ErrorCode};
use crate::state::user::{User, UserStats};
use crate::validate;
use anchor_lang::prelude::AccountInfo;
use anchor_lang::prelude::AccountLoader;
use solana_program::account_info::next_account_info;
use solana_program::msg;
use std::iter::Peekable;
use std::slice::Iter;

pub fn get_maker_and_maker_stats<'a>(
    account_info_iter: &mut Peekable<Iter<AccountInfo<'a>>>,
) -> ClearingHouseResult<(AccountLoader<'a, User>, AccountLoader<'a, UserStats>)> {
    let maker_account_info =
        next_account_info(account_info_iter).or(Err(ErrorCode::MakerNotFound))?;

    validate!(
        maker_account_info.is_writable,
        ErrorCode::MakerMustBeWritable
    )?;

    let maker: AccountLoader<User> =
        AccountLoader::try_from(maker_account_info).or(Err(ErrorCode::CouldNotDeserializeMaker))?;

    let maker_stats_account_info =
        next_account_info(account_info_iter).or(Err(ErrorCode::MakerStatsNotFound))?;

    validate!(
        maker_stats_account_info.is_writable,
        ErrorCode::MakerStatsMustBeWritable
    )?;

    let maker_stats: AccountLoader<UserStats> = AccountLoader::try_from(maker_stats_account_info)
        .or(Err(ErrorCode::CouldNotDeserializeMaker))?;

    Ok((maker, maker_stats))
}
