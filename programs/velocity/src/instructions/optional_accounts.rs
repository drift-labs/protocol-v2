use crate::error::{ErrorCode, VelocityResult};
use crate::state::revenue_share::{
    RevenueShareEscrow, RevenueShareEscrowLoader, RevenueShareEscrowZeroCopyMut, RevenueShareOrder,
    RevenueShareOrderBitFlag,
};
use crate::state::state::State;
use crate::state::user::MarketType;
use std::cell::RefMut;
use std::convert::TryFrom;

use crate::error::ErrorCode::UnableToLoadOracle;
use crate::math::safe_unwrap::SafeUnwrap;
use crate::msg;
use crate::state::load_ref::load_ref_mut;
use crate::state::oracle::PrelaunchOracle;
use crate::state::oracle_map::OracleMap;
use crate::state::perp_market::PerpMarket;
use crate::state::perp_market_map::{MarketSet, PerpMarketMap};
use crate::state::spot_market_map::SpotMarketMap;
use crate::state::state::OracleGuardRails;
use crate::state::traits::Size;
use crate::state::user::{User, UserStats};
use crate::{validate, OracleSource};
use anchor_lang::accounts::account::Account;
use anchor_lang::prelude::{AccountInfo, Interface, Pubkey};
use anchor_lang::prelude::{AccountLoader, InterfaceAccount};
use anchor_lang::Discriminator;
use anchor_spl::token::TokenAccount;
use anchor_spl::token_interface::{Mint, TokenInterface};
use arrayref::array_ref;
use solana_program::account_info::next_account_info;
use std::iter::Peekable;
use std::ops::Deref;
use std::slice::Iter;

pub struct AccountMaps<'a> {
    pub perp_market_map: PerpMarketMap<'a>,
    pub spot_market_map: SpotMarketMap<'a>,
    pub oracle_map: OracleMap<'a>,
}

pub fn load_maps<'a, 'b>(
    account_info_iter: &mut Peekable<Iter<'a, AccountInfo<'a>>>,
    writable_perp_markets: &'b MarketSet,
    writable_spot_markets: &'b MarketSet,
    slot: u64,
    oracle_guard_rails: Option<OracleGuardRails>,
) -> VelocityResult<AccountMaps<'a>> {
    let oracle_map = OracleMap::load(account_info_iter, slot, oracle_guard_rails)?;
    let spot_market_map = SpotMarketMap::load(writable_spot_markets, account_info_iter)?;
    let perp_market_map = PerpMarketMap::load(writable_perp_markets, account_info_iter)?;

    for perp_market_index in writable_perp_markets.iter() {
        update_prelaunch_oracle(
            perp_market_map.get_ref(perp_market_index)?.deref(),
            &oracle_map,
            slot,
        )?;
    }

    Ok(AccountMaps {
        perp_market_map,
        spot_market_map,
        oracle_map,
    })
}

pub fn update_prelaunch_oracle(
    perp_market: &PerpMarket,
    oracle_map: &OracleMap,
    slot: u64,
) -> VelocityResult {
    if perp_market.oracle_source != OracleSource::Prelaunch {
        return Ok(());
    }

    let oracle_account_info = oracle_map.get_account_info(&perp_market.oracle)?;

    let mut oracle: RefMut<PrelaunchOracle> =
        load_ref_mut(&oracle_account_info).or(Err(UnableToLoadOracle))?;

    oracle.update(perp_market, slot)?;

    Ok(())
}

pub fn get_maker_and_maker_stats<'a>(
    account_info_iter: &mut Peekable<Iter<'a, AccountInfo<'a>>>,
) -> VelocityResult<(AccountLoader<'a, User>, AccountLoader<'a, UserStats>)> {
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
pub fn get_referrer_and_referrer_stats<'a>(
    account_info_iter: &mut Peekable<Iter<'a, AccountInfo<'a>>>,
) -> VelocityResult<(
    Option<AccountLoader<'a, User>>,
    Option<AccountLoader<'a, UserStats>>,
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

    let user_discriminator: &[u8] = User::DISCRIMINATOR;
    let account_discriminator = &data[..8];
    if account_discriminator != user_discriminator {
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

    let user_stats_discriminator: &[u8] = UserStats::DISCRIMINATOR;
    let account_discriminator = &data[..8];
    if account_discriminator != user_stats_discriminator {
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

pub fn get_whitelist_token<'a>(
    account_info_iter: &mut Peekable<Iter<'a, AccountInfo<'a>>>,
) -> VelocityResult<Account<'a, TokenAccount>> {
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

pub fn get_token_interface<'a>(
    account_info_iter: &mut Peekable<Iter<'a, AccountInfo<'a>>>,
) -> VelocityResult<Option<Interface<'a, TokenInterface>>> {
    let token_interface_account_info = account_info_iter.peek();
    if token_interface_account_info.is_none() {
        return Ok(None);
    }

    let token_interface_account_info = account_info_iter.next().safe_unwrap()?;
    let token_interface: Interface<TokenInterface> =
        Interface::try_from(token_interface_account_info).map_err(|e| {
            msg!("Unable to deserialize token interface");
            msg!("{:?}", e);
            ErrorCode::DefaultError
        })?;

    Ok(Some(token_interface))
}

pub fn get_token_mint<'a>(
    account_info_iter: &mut Peekable<Iter<'a, AccountInfo<'a>>>,
) -> VelocityResult<Option<InterfaceAccount<'a, Mint>>> {
    let mint_account_info = account_info_iter.peek();
    if mint_account_info.is_none() {
        return Ok(None);
    }

    let mint_account_info = account_info_iter.next().safe_unwrap()?;

    match InterfaceAccount::try_from(mint_account_info) {
        Ok(mint) => Ok(Some(mint)),
        Err(_) => Ok(None),
    }
}

pub fn get_revenue_share_escrow_account<'a>(
    account_info_iter: &mut Peekable<Iter<'a, AccountInfo<'a>>>,
    expected_authority: &Pubkey,
) -> VelocityResult<Option<RevenueShareEscrowZeroCopyMut<'a>>> {
    let account_info = account_info_iter.peek();
    if account_info.is_none() {
        return Ok(None);
    }

    let account_info = account_info.safe_unwrap()?;

    // Check size and discriminator without borrowing
    if account_info.data_len() < 80 {
        return Ok(None);
    }

    let discriminator: &[u8] = RevenueShareEscrow::DISCRIMINATOR;
    let borrowed_data = account_info.data.borrow();
    let account_discriminator = array_ref![&borrowed_data, 0, 8];
    if account_discriminator != discriminator {
        return Ok(None);
    }

    let account_info = account_info_iter.next().safe_unwrap()?;

    drop(borrowed_data);
    let escrow: RevenueShareEscrowZeroCopyMut<'a> = account_info.load_zc_mut()?;

    validate!(
        escrow.fixed.authority == *expected_authority,
        ErrorCode::RevenueShareEscrowAuthorityMismatch,
        "invalid RevenueShareEscrow authority"
    )?;

    Ok(Some(escrow))
}

/// Validates that a builder referenced by an order may collect the requested fee.
///
/// Returns `Ok(None)` when builder codes are disabled or the order carries no builder fields.
/// When a builder fee is present it validates the escrow ownership, that the builder is not
/// revoked, and that the requested fee does not exceed the builder's max, returning the fee in
/// tenths of a bps. Errors if a builder fee is requested but the escrow has not been loaded.
pub fn validate_builder_fee(
    escrow: Option<&mut RevenueShareEscrowZeroCopyMut>,
    user_authority: &Pubkey,
    builder_idx: Option<u8>,
    builder_fee_tenth_bps: Option<u16>,
    state: &State,
) -> VelocityResult<Option<u16>> {
    if !state.builder_codes_enabled() {
        return Ok(None);
    }
    let (builder_idx, builder_fee) = match (builder_idx, builder_fee_tenth_bps) {
        (Some(idx), Some(fee)) => (idx, fee),
        _ => return Ok(None),
    };

    let escrow = match escrow {
        Some(escrow) => escrow,
        None => {
            validate!(
                false,
                ErrorCode::UnableToLoadRevenueShareAccount,
                "Order has builder fee but no escrow account found"
            )?;
            unreachable!()
        }
    };

    validate!(
        escrow.fixed.authority == *user_authority,
        ErrorCode::InvalidUserAccount,
        "RevenueShareEscrow account must be owned by taker",
    )?;

    let builder = escrow.get_approved_builder_mut(builder_idx)?;

    if builder.is_revoked() {
        return Err(ErrorCode::BuilderRevoked);
    }

    if builder_fee > builder.max_fee_tenth_bps {
        return Err(ErrorCode::InvalidBuilderFee);
    }

    Ok(Some(builder_fee))
}

/// Move-based convenience wrapper around [`validate_builder_fee`] for single-order callers.
///
/// Takes ownership of the loaded escrow and returns it together with the validated builder fee
/// when the order carries a valid builder code, or `(None, None)` otherwise.
pub fn validate_and_load_builder<'a>(
    mut escrow: Option<RevenueShareEscrowZeroCopyMut<'a>>,
    user_authority: &Pubkey,
    builder_idx: Option<u8>,
    builder_fee_tenth_bps: Option<u16>,
    state: &State,
) -> VelocityResult<(Option<RevenueShareEscrowZeroCopyMut<'a>>, Option<u16>)> {
    let builder_fee_bps = validate_builder_fee(
        escrow.as_mut(),
        user_authority,
        builder_idx,
        builder_fee_tenth_bps,
        state,
    )?;
    match builder_fee_bps {
        Some(_) => Ok((escrow, builder_fee_bps)),
        None => Ok((None, None)),
    }
}

/// Adds a [`RevenueShareOrder`] to the escrow for the order about to be placed and returns a
/// mutable reference to it, suitable to pass to `controller::orders::place_perp_order` as the
/// `rev_share_order` argument. Returns `Ok(None)` when the order carries no builder code
/// (`builder_idx`/`builder_fee_bps` is `None`), when there is no escrow, or when the escrow's
/// order list is full.
///
/// Gating on the builder fee here (rather than only on the escrow being present) is important:
/// a referred user has an escrow even for orders without a builder code, and we must not create
/// a spurious builder order for those — the escrow is still loaded so the fill can accrue the
/// referrer's revenue share.
pub fn add_builder_order<'a, 'b>(
    escrow: &'b mut Option<RevenueShareEscrowZeroCopyMut<'a>>,
    user: &User,
    builder_idx: Option<u8>,
    builder_fee_bps: Option<u16>,
    order_id: u32,
    market_index: u16,
) -> VelocityResult<Option<&'b mut RevenueShareOrder>> {
    let (builder_idx, builder_fee_bps) = match (builder_idx, builder_fee_bps) {
        (Some(idx), Some(fee)) => (idx, fee),
        _ => return Ok(None),
    };
    let escrow = match escrow.as_mut() {
        Some(escrow) => escrow,
        None => return Ok(None),
    };

    let new_order_index = user
        .orders
        .iter()
        .position(|order| order.is_available())
        .ok_or(ErrorCode::MaxNumberOfOrders)?;

    match escrow.add_order(RevenueShareOrder::new(
        builder_idx,
        user.sub_account_id,
        order_id,
        builder_fee_bps,
        MarketType::Perp,
        market_index,
        RevenueShareOrderBitFlag::Open as u8,
        new_order_index as u8,
    )) {
        Ok(order_idx) => Ok(escrow.get_order_mut(order_idx).ok()),
        Err(_) => {
            msg!("Failed to add builder order, RevenueShareEscrow is full");
            Ok(None)
        }
    }
}
