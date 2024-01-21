use crate::error::{DriftResult, ErrorCode};

use crate::math::safe_unwrap::SafeUnwrap;
use crate::state::oracle_map::OracleMap;
use crate::state::perp_market_map::{MarketSet, PerpMarketMap};
use crate::state::spot_market_map::SpotMarketMap;
use crate::state::state::OracleGuardRails;
use crate::state::traits::Size;
use crate::state::user::{User, UserStats};
use crate::validate;
use anchor_lang::accounts::account::Account;
use anchor_lang::prelude::AccountInfo;
use anchor_lang::prelude::AccountLoader;
use anchor_lang::Discriminator;
use anchor_spl::token::TokenAccount;
use arrayref::array_ref;
use solana_program::account_info::next_account_info;
use solana_program::msg;
use std::iter::Peekable;
use std::slice::Iter;

pub struct AccountMaps<'a> {
    pub perp_market_map: PerpMarketMap<'a>,
    pub spot_market_map: SpotMarketMap<'a>,
    pub oracle_map: OracleMap<'a>,
}

pub fn load_maps<'a, 'b, 'c: 'a>(
    account_info_iter: &mut Peekable<Iter<'c, AccountInfo<'a>>>,
    writable_perp_markets: &'b MarketSet,
    writable_spot_markets: &'b MarketSet,
    slot: u64,
    oracle_guard_rails: Option<OracleGuardRails>,
) -> DriftResult<AccountMaps<'a>> {
    let oracle_map = OracleMap::load(account_info_iter, slot, oracle_guard_rails)?;
    let spot_market_map = SpotMarketMap::load(writable_spot_markets, account_info_iter)?;
    let perp_market_map = PerpMarketMap::load(writable_perp_markets, account_info_iter)?;

    Ok(AccountMaps {
        perp_market_map,
        spot_market_map,
        oracle_map,
    })
}

pub fn get_maker_and_maker_stats<'a, 'b>(
    account_info_iter: &mut Peekable<Iter<'a, AccountInfo<'a>>>,
) -> DriftResult<(AccountLoader<'a, User>, AccountLoader<'a, UserStats>)> {
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

    let maker_stats: AccountLoader<UserStats> =
        AccountLoader::try_from(maker_stats_account_info)
            .or(Err(ErrorCode::CouldNotDeserializeMakerStats))?;

    Ok((maker, maker_stats))
}

#[allow(clippy::type_complexity)]
pub fn get_referrer_and_referrer_stats<'a: 'b, 'b>(
    account_info_iter: &mut Peekable<Iter<'a, AccountInfo<'b>>>,
) -> DriftResult<(
    Option<AccountLoader<'b, User>>,
    Option<AccountLoader<'b, UserStats>>,
)> {
    let referrer_account_info = account_info_iter.peek();

    if referrer_account_info.is_none() {
        return Ok((None, None));
    }

    let referrer_account_info = referrer_account_info.safe_unwrap()?;
    let data = referrer_account_info.try_borrow_data().map_err(|e| {
        msg!("{:?}", e);
        ErrorCode::CouldNotDeserializeReferrer
    })?;

    if data.len() < User::SIZE {
        return Ok((None, None));
    }

    let user_discriminator: [u8; 8] = User::discriminator();
    let account_discriminator = array_ref![data, 0, 8];
    if account_discriminator != &user_discriminator {
        return Ok((None, None));
    }

    let referrer_account_info = next_account_info(account_info_iter).safe_unwrap()?;

    validate!(
        referrer_account_info.is_writable,
        ErrorCode::ReferrerMustBeWritable
    )?;

    let referrer: AccountLoader<User> = AccountLoader::try_from(referrer_account_info)
        .or(Err(ErrorCode::CouldNotDeserializeReferrer))?;

    let referrer_stats_account_info = account_info_iter.peek();
    if referrer_stats_account_info.is_none() {
        return Ok((None, None));
    }

    let referrer_stats_account_info = referrer_stats_account_info.safe_unwrap()?;
    let data = referrer_stats_account_info.try_borrow_data().map_err(|e| {
        msg!("{:?}", e);
        ErrorCode::CouldNotDeserializeReferrerStats
    })?;

    if data.len() < UserStats::SIZE {
        return Ok((None, None));
    }

    let user_stats_discriminator: [u8; 8] = UserStats::discriminator();
    let account_discriminator = array_ref![data, 0, 8];
    if account_discriminator != &user_stats_discriminator {
        return Ok((None, None));
    }

    let referrer_stats_account_info = next_account_info(account_info_iter).safe_unwrap()?;

    validate!(
        referrer_stats_account_info.is_writable,
        ErrorCode::ReferrerMustBeWritable
    )?;

    let referrer_stats: AccountLoader<UserStats> =
        AccountLoader::try_from(referrer_stats_account_info)
            .or(Err(ErrorCode::CouldNotDeserializeReferrerStats))?;

    Ok((Some(referrer), Some(referrer_stats)))
}

pub fn get_whitelist_token<'a: 'b, 'b>(
    account_info_iter: &mut Peekable<Iter<'a, AccountInfo<'b>>>,
) -> DriftResult<Account<'b, TokenAccount>> {
    let token_account_info = account_info_iter.peek();
    if token_account_info.is_none() {
        msg!("Could not find whitelist token");
        return Err(ErrorCode::InvalidWhitelistToken);
    }

    let token_account_info = token_account_info.safe_unwrap()?;
    let whitelist_token: Account<TokenAccount> =
        Account::try_from(token_account_info).map_err(|e| {
            msg!("Unable to deserialize whitelist token");
            msg!("{:?}", e);
            ErrorCode::InvalidWhitelistToken
        })?;

    Ok(whitelist_token)
}
