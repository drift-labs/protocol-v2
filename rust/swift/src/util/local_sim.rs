//! Off-chain replay of `drift::controller::orders::place_perp_order`.
//!
//! Mirrors the simulation that the on-chain `place_signed_msg_taker_order`
//! ix runs for its main perp leg. The signature verification, slot freshness
//! check, signed-msg dedup, and SL/TP/isolated-deposit side-effects are
//! handled by the swift caller before we get here.
//!
//! Replaces the deleted `drift_rs::ffi::simulate_place_perp_order`.

use std::{
    cell::RefCell,
    rc::Rc,
    time::{SystemTime, UNIX_EPOCH},
};

use anchor_lang::AccountDeserialize;
use drift::{
    controller::orders::place_perp_order,
    error::{VelocityResult, ErrorCode},
    sdk::{VelocityAccounts, OwnedAccount},
    state::{
        oracle_map::OracleMap,
        order_params::{OrderParams, PlaceOrderOptions},
        perp_market_map::PerpMarketMap,
        spot_market_map::SpotMarketMap,
        state::State as NativeState,
        user::User,
    },
};
use solana_account_info::AccountInfo;
use solana_clock::Clock;
use solana_pubkey::Pubkey;

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

/// Off-chain replay of `place_perp_order`.
///
/// `user` is cloned before the call so the caller's value is not mutated,
/// matching the pre-FFI-removal behavior. `state_bytes` is the raw cached
/// state-account bytes (including 8-byte discriminator) — drift's native
/// `State` is Borsh-only and not safely castable from the Pod IDL mirror.
pub fn simulate_place_perp_order(
    user: &User,
    accounts: &mut VelocityAccounts,
    state_bytes: &[u8],
    order_params: OrderParams,
    max_margin_ratio: Option<u16>,
) -> VelocityResult<()> {
    let state = NativeState::try_deserialize(&mut &*state_bytes)
        .map_err(|_| ErrorCode::UnableToLoadAccountLoader)?;

    let mut user = user.clone();
    if let Some(max_margin_ratio) = max_margin_ratio {
        user.update_perp_position_max_margin_ratio(order_params.market_index, max_margin_ratio)?;
    }

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

    // No epoch info — `place_perp_order` only reads `slot` and `unix_timestamp`.
    let unix_timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|_| ErrorCode::UnableToCastUnixTime)?
        .as_secs() as i64;
    let local_clock = Clock {
        slot: accounts.latest_slot,
        epoch_start_timestamp: 0,
        epoch: 0,
        leader_schedule_epoch: 0,
        unix_timestamp,
    };

    let user_key = user.authority;
    let mut rev_share_order = None;
    place_perp_order(
        &state,
        &mut user,
        user_key,
        &perp_map,
        &spot_map,
        &mut oracle_map,
        &local_clock,
        order_params,
        PlaceOrderOptions::default(),
        &mut rev_share_order,
    )
}
