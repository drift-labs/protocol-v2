use anchor_lang::accounts::account::Account;
use anchor_lang::accounts::account_loader::AccountLoader;
use anchor_lang::accounts::signer::Signer;
use anchor_lang::prelude::{AccountInfo, Pubkey};

use crate::error::ErrorCode;
use crate::state::market::{MarketStatus, PerpMarket};
use crate::state::state::{ExchangeStatus, State};
use crate::state::user::{User, UserStats};

pub fn can_sign_for_user(user: &AccountLoader<User>, signer: &Signer) -> anchor_lang::Result<bool> {
    user.load().map(|user| {
        user.authority.eq(signer.key)
            || (user.delegate.eq(signer.key) && !user.delegate.eq(&Pubkey::default()))
    })
}

pub fn is_stats_for_user(
    user: &AccountLoader<User>,
    user_stats: &AccountLoader<UserStats>,
) -> anchor_lang::Result<bool> {
    let user = user.load()?;
    let user_stats = user_stats.load()?;
    Ok(user_stats.authority.eq(&user.authority))
}

pub fn market_valid(market: &AccountLoader<PerpMarket>) -> anchor_lang::Result<()> {
    if market.load()?.status == MarketStatus::Delisted {
        return Err(ErrorCode::MarketIndexNotInitialized.into());
    }
    Ok(())
}

pub fn valid_oracle_for_market(
    oracle: &AccountInfo,
    market: &AccountLoader<PerpMarket>,
) -> anchor_lang::Result<()> {
    if !market.load()?.amm.oracle.eq(oracle.key) {
        return Err(ErrorCode::InvalidOracle.into());
    }
    Ok(())
}

pub fn liq_not_paused(state: &Account<State>) -> anchor_lang::Result<()> {
    if matches!(
        state.exchange_status,
        ExchangeStatus::LiqPaused | ExchangeStatus::Paused
    ) {
        return Err(ErrorCode::ExchangePaused.into());
    }
    Ok(())
}

pub fn funding_not_paused(state: &Account<State>) -> anchor_lang::Result<()> {
    if matches!(
        state.exchange_status,
        ExchangeStatus::FundingPaused | ExchangeStatus::Paused
    ) {
        return Err(ErrorCode::ExchangePaused.into());
    }
    Ok(())
}

pub fn amm_not_paused(state: &Account<State>) -> anchor_lang::Result<()> {
    if matches!(
        state.exchange_status,
        ExchangeStatus::AmmPaused | ExchangeStatus::Paused
    ) {
        return Err(ErrorCode::ExchangePaused.into());
    }
    Ok(())
}

pub fn fill_not_paused(state: &Account<State>) -> anchor_lang::Result<()> {
    if matches!(
        state.exchange_status,
        ExchangeStatus::FillPaused | ExchangeStatus::Paused
    ) {
        return Err(ErrorCode::ExchangePaused.into());
    }
    Ok(())
}

pub fn withdraw_not_paused(state: &Account<State>) -> anchor_lang::Result<()> {
    if matches!(
        state.exchange_status,
        ExchangeStatus::WithdrawPaused | ExchangeStatus::Paused
    ) {
        return Err(ErrorCode::ExchangePaused.into());
    }
    Ok(())
}

pub fn exchange_not_paused(state: &Account<State>) -> anchor_lang::Result<()> {
    if state.exchange_status == ExchangeStatus::Paused {
        return Err(ErrorCode::ExchangePaused.into());
    }
    Ok(())
}
