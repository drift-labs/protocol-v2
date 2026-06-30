//! Off-chain replay of `velocity_rs::program::controller::orders::place_perp_order`.
//!
//! Mirrors the simulation that the on-chain `place_signed_msg_taker_order`
//! ix runs for its main perp leg. The signature verification, slot freshness
//! check, signed-msg dedup, and SL/TP/isolated-deposit side-effects are
//! handled by the swift caller before we get here.
//!
//! Replaces the deleted `velocity_rs::ffi::simulate_place_perp_order`.

use std::time::{SystemTime, UNIX_EPOCH};

use anchor_lang::AccountDeserialize;
use solana_clock::Clock;
use velocity_rs::program::{
    controller::orders::place_perp_order,
    error::{ErrorCode, VelocityResult},
    sdk::{build_infos, AlignedAccountData, VelocityAccounts},
    state::{
        oracle_map::OracleMap,
        order_params::{OrderParams, PlaceOrderOptions},
        perp_market_map::PerpMarketMap,
        spot_market_map::SpotMarketMap,
        state::State as NativeState,
        user::User,
    },
};

/// Off-chain replay of `place_perp_order`.
///
/// `user` is cloned before the call so the caller's value is not mutated,
/// matching the pre-FFI-removal behavior. `state_bytes` is the raw cached
/// state-account bytes (including 8-byte discriminator).
///
/// `State` is a `#[account(zero_copy)]` struct (embeds `FeeStructure` /
/// `OracleGuardRails`, which hold `u128`/`i128`), so off-chain on x86_64 it is
/// 16-aligned and its `try_deserialize` casts the body **by reference**
/// (`bytemuck::from_bytes(&data[8..])`). The raw `state_bytes` arrive in a plain
/// allocation that's 16-aligned only at the *base*, so `&data[8..]` sits at
/// `8 mod 16` and the cast panics (`TargetAlignmentGreaterAndInputNotAligned`).
/// Copy once into an [`AlignedAccountData`] buffer (body at `base + 16`) so the
/// cast lands on a 16-byte boundary — the same treatment the market/oracle
/// accounts get in `AccountsListBuilder`.
pub fn simulate_place_perp_order(
    user: &User,
    accounts: &mut VelocityAccounts,
    state_bytes: &[u8],
    order_params: OrderParams,
    max_margin_ratio: Option<u16>,
) -> VelocityResult<()> {
    let state_aligned = AlignedAccountData::from_bytes(state_bytes);
    let state = NativeState::try_deserialize(&mut state_aligned.as_slice())
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
    // The simulation only cares whether placement succeeds; the
    // `PlaceOrderResult` (batch risk accounting) is irrelevant here.
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
    )?;
    Ok(())
}
