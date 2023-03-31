use crate::controller::serum::{FulfillmentParams, SerumFulfillmentParams};
use crate::error::{DriftResult, ErrorCode};
use crate::load;

use crate::math::safe_unwrap::SafeUnwrap;
use crate::state::oracle_map::OracleMap;
use crate::state::perp_market_map::{MarketSet, PerpMarketMap};
use crate::state::spot_market::{
    SerumV3FulfillmentConfig, SpotFulfillmentConfigStatus, SpotMarket,
};
use crate::state::spot_market_map::SpotMarketMap;
use crate::state::state::{OracleGuardRails, State};
use crate::state::traits::Size;
use crate::state::user::{User, UserStats};
use crate::validate;
use anchor_lang::accounts::account::Account;
use anchor_lang::prelude::AccountLoader;
use anchor_lang::prelude::{AccountInfo, Program};
use anchor_lang::Discriminator;
use anchor_spl::token::{Token, TokenAccount};
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

pub fn load_maps<'a, 'b, 'c>(
    account_info_iter: &'c mut Peekable<Iter<AccountInfo<'a>>>,
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

pub fn get_maker_and_maker_stats<'a>(
    account_info_iter: &mut Peekable<Iter<AccountInfo<'a>>>,
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
pub fn get_referrer_and_referrer_stats<'a>(
    account_info_iter: &mut Peekable<Iter<AccountInfo<'a>>>,
) -> DriftResult<(
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

#[allow(clippy::type_complexity)]
pub fn get_serum_fulfillment_accounts<'a, 'b, 'c>(
    account_info_iter: &'a mut std::iter::Peekable<std::slice::Iter<'b, AccountInfo<'c>>>,
    state: &State,
    base_market: &SpotMarket,
    quote_market: &SpotMarket,
) -> DriftResult<Option<FulfillmentParams<'a, 'c>>> {
    let account_info_vec = account_info_iter.collect::<Vec<_>>();
    let account_infos = array_ref![account_info_vec, 0, 16];
    let [serum_fulfillment_config, serum_program_id, serum_market, serum_request_queue, serum_event_queue, serum_bids, serum_asks, serum_base_vault, serum_quote_vault, serum_open_orders, serum_signer, drift_signer, token_program, base_market_vault, quote_market_vault, srm_vault] =
        account_infos;

    let serum_fulfillment_config_loader: AccountLoader<SerumV3FulfillmentConfig> =
        AccountLoader::try_from(serum_fulfillment_config).map_err(|e| {
            msg!("{:?}", e);
            ErrorCode::InvalidSerumFulfillmentConfig
        })?;
    let serum_fulfillment_config = load!(serum_fulfillment_config_loader)?;

    validate!(
        serum_fulfillment_config.status == SpotFulfillmentConfigStatus::Enabled,
        ErrorCode::SpotFulfillmentConfigDisabled
    )?;

    validate!(
        &state.signer == drift_signer.key,
        ErrorCode::InvalidSerumFulfillmentConfig
    )?;

    validate!(
        serum_fulfillment_config.market_index == base_market.market_index,
        ErrorCode::InvalidSerumFulfillmentConfig,
        "config market index {} does not equal base asset index {}",
        serum_fulfillment_config.market_index,
        base_market.market_index
    )?;

    validate!(
        &base_market.vault == base_market_vault.key,
        ErrorCode::InvalidSerumFulfillmentConfig
    )?;

    validate!(
        &quote_market.vault == quote_market_vault.key,
        ErrorCode::InvalidSerumFulfillmentConfig
    )?;

    validate!(
        &serum_fulfillment_config.serum_program_id == serum_program_id.key,
        ErrorCode::InvalidSerumFulfillmentConfig
    )?;

    validate!(
        &serum_fulfillment_config.serum_market == serum_market.key,
        ErrorCode::InvalidSerumFulfillmentConfig
    )?;

    validate!(
        &serum_fulfillment_config.serum_open_orders == serum_open_orders.key,
        ErrorCode::InvalidSerumFulfillmentConfig
    )?;

    let base_market_vault: Box<Account<TokenAccount>> =
        Box::new(Account::try_from(base_market_vault).map_err(|e| {
            msg!("{:?}", e);
            ErrorCode::InvalidSerumFulfillmentConfig
        })?);
    let quote_market_vault: Box<Account<TokenAccount>> =
        Box::new(Account::try_from(quote_market_vault).map_err(|e| {
            msg!("{:?}", e);
            ErrorCode::InvalidSerumFulfillmentConfig
        })?);

    let token_program: Program<Token> = Program::try_from(token_program).map_err(|e| {
        msg!("{:?}", e);
        ErrorCode::InvalidSerumFulfillmentConfig
    })?;

    validate!(
        &state.srm_vault == srm_vault.key,
        ErrorCode::InvalidSerumFulfillmentConfig
    )?;

    let serum_fulfillment_accounts = SerumFulfillmentParams {
        drift_signer,
        serum_program_id,
        serum_market,
        serum_request_queue,
        serum_event_queue,
        serum_bids,
        serum_asks,
        serum_base_vault,
        serum_quote_vault,
        serum_open_orders,
        token_program,
        base_market_vault,
        quote_market_vault,
        serum_signer,
        srm_vault,
        signer_nonce: state.signer_nonce,
    };

    Ok(Some(FulfillmentParams::SerumFulfillmentParams(
        serum_fulfillment_accounts,
    )))
}

#[allow(clippy::type_complexity)]
pub fn get_spot_market_vaults<'a, 'b, 'c>(
    account_info_iter: &'a mut std::iter::Peekable<std::slice::Iter<'b, AccountInfo<'c>>>,
    base_market: &SpotMarket,
    quote_market: &SpotMarket,
) -> DriftResult<(
    Box<Account<'c, TokenAccount>>,
    Box<Account<'c, TokenAccount>>,
)> {
    let account_info_vec = account_info_iter.collect::<Vec<_>>();
    let account_infos = array_ref![account_info_vec, 0, 2];
    let [base_market_vault, quote_market_vault] = account_infos;

    validate!(
        &base_market.vault == base_market_vault.key,
        ErrorCode::InvalidSerumFulfillmentConfig
    )?;

    validate!(
        &quote_market.vault == quote_market_vault.key,
        ErrorCode::InvalidSerumFulfillmentConfig
    )?;

    let base_market_vault: Box<Account<TokenAccount>> =
        Box::new(Account::try_from(base_market_vault).map_err(|e| {
            msg!("{:?}", e);
            ErrorCode::InvalidSerumFulfillmentConfig
        })?);
    let quote_market_vault: Box<Account<TokenAccount>> =
        Box::new(Account::try_from(quote_market_vault).map_err(|e| {
            msg!("{:?}", e);
            ErrorCode::InvalidSerumFulfillmentConfig
        })?);

    Ok((base_market_vault, quote_market_vault))
}

pub fn get_whitelist_token<'a>(
    account_info_iter: &mut Peekable<Iter<AccountInfo<'a>>>,
) -> DriftResult<Account<'a, TokenAccount>> {
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
