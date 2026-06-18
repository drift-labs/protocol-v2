//! Off-chain SDK API for velocity-rs.
//!
//! The velocity program's core math (margin calculation, oracle pricing) is
//! written against on-chain `AccountInfo` buffers and the map wrappers
//! `PerpMarketMap` / `SpotMarketMap` / `OracleMap`. The velocity-rs SDK runs
//! off-chain and holds *owned* account data.
//!
//! This module provides a small, isolated surface so velocity-rs callers can
//! invoke that same code path without building `AccountInfo`s manually.
//! It is gated behind `feature = "velocity-rs"` and compiled out for BPF
//! builds.

use std::{cell::RefCell, rc::Rc};

use anchor_lang::prelude::{AccountInfo, Pubkey};

use crate::{
    error::VelocityResult,
    math::margin::calculate_margin_requirement_and_total_collateral_and_liability_info as _calc_margin,
    state::{
        margin_calculation::{MarginCalculation, MarginContext},
        oracle::{get_oracle_price as _get_oracle_price, OraclePriceData, OracleSource},
        oracle_map::OracleMap,
        perp_market_map::PerpMarketMap,
        spot_market_map::SpotMarketMap,
        state::OracleGuardRails,
        user::User,
    },
};

/// Client-side owned account payload. Layout-compatible with
/// `solana_account::Account` but owned and `Default`-able.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct OwnedAccount {
    pub lamports: u64,
    pub data: Vec<u8>,
    pub owner: Pubkey,
    pub executable: bool,
}

/// Bundle of owned account data required by velocity's margin/oracle math.
///
/// Callers push `(Pubkey, OwnedAccount)` entries into the appropriate vec,
/// then call one of the top-level helpers below. Borrowed `AccountInfo`s
/// are fabricated inside each helper call — the bundle itself holds no
/// references, which keeps lifetimes local.
#[derive(Default)]
pub struct VelocityAccounts {
    pub perp_markets: Vec<(Pubkey, OwnedAccount)>,
    pub spot_markets: Vec<(Pubkey, OwnedAccount)>,
    pub oracles: Vec<(Pubkey, OwnedAccount)>,
    pub latest_slot: u64,
    pub oracle_guard_rails: Option<OracleGuardRails>,
}

#[allow(deprecated)]
fn account_info_from<'a>(slot: &'a mut (Pubkey, OwnedAccount)) -> AccountInfo<'a> {
    let (ref key, ref mut acc) = *slot;
    AccountInfo {
        key,
        lamports: Rc::new(RefCell::new(&mut acc.lamports)),
        data: Rc::new(RefCell::new(acc.data.as_mut_slice())),
        owner: &acc.owner,
        _unused: 0,
        is_signer: false,
        is_writable: true,
        executable: acc.executable,
    }
}

fn build_infos<'a>(entries: &'a mut [(Pubkey, OwnedAccount)]) -> Vec<AccountInfo<'a>> {
    entries.iter_mut().map(account_info_from).collect()
}

/// Compute margin info for `user` against the owned market/oracle data in `accounts`.
pub fn calculate_margin(
    user: &User,
    accounts: &mut VelocityAccounts,
    context: MarginContext,
) -> VelocityResult<MarginCalculation> {
    let spot_infos = build_infos(&mut accounts.spot_markets);
    let spot_map = SpotMarketMap::load(&Default::default(), &mut spot_infos.iter().peekable())?;

    let perp_infos = build_infos(&mut accounts.perp_markets);
    let perp_map = PerpMarketMap::load(&Default::default(), &mut perp_infos.iter().peekable())?;

    let oracle_infos = build_infos(&mut accounts.oracles);
    let mut oracle_map = OracleMap::load(
        &mut oracle_infos.iter().peekable(),
        accounts.latest_slot,
        accounts.oracle_guard_rails,
    )?;

    _calc_margin(user, &perp_map, &spot_map, &mut oracle_map, context)
}

/// Compute the oracle price for a single oracle account.
///
/// Borrows the account fields directly so callers don't need to construct an
/// `OwnedAccount`. `lamports` are not read by the oracle path; an internal
/// stack slot is used.
#[allow(deprecated)]
pub fn oracle_price(
    source: &OracleSource,
    pubkey: &Pubkey,
    owner: &Pubkey,
    data: &mut [u8],
    slot: u64,
) -> VelocityResult<OraclePriceData> {
    let mut lamports = 0u64;
    let info = AccountInfo {
        key: pubkey,
        lamports: Rc::new(RefCell::new(&mut lamports)),
        data: Rc::new(RefCell::new(data)),
        owner,
        _unused: 0,
        is_signer: false,
        is_writable: false,
        executable: false,
    };
    _get_oracle_price(source, &info, slot)
}
