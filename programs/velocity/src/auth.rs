//! Tiered admin authority predicates.
//!
//! Three tiers, additive: `cold ⊇ warm ⊇ hot(role)`. All three live on `State`:
//! `state.cold_admin` is the root authority (set at `initialize`), `state.warm_admin`
//! is the operational multisig+timelock pubkey, and `state.hot_*` fields hold one
//! purpose-specific bot key per `HotRole`.
//!
//! Orthogonal to the tier hierarchy is `state.pause_admin`: a dedicated
//! emergency-pause key with no on-chain timelock. It is authorised in addition
//! to cold/warm for handlers that flip pause flags (exchange status, per-market
//! paused operations, per-user paused operations).
//!
//! `Pubkey::default()` in any role field means the role is unassigned and falls
//! through to warm-or-cold only.

use anchor_lang::prelude::*;

use crate::error::ErrorCode;
use crate::state::state::{HotRole, State};

/// Anchor `constraint = ...` helper. Loads State via the AccountLoader so the
/// constraint can be expressed as `check_warm(&signer.key(), &state)?` inside
/// `#[derive(Accounts)]`. Returns `Ok(true)` iff the signer is cold or warm.
pub fn check_warm(signer: &Pubkey, state: &AccountLoader<'_, State>) -> Result<bool> {
    let state = state.load()?;
    Ok(state.is_warm(signer))
}

/// Anchor `constraint = ...` helper for hot-role-gated handlers. Returns
/// `Ok(true)` iff `signer` is cold, warm, or the configured key for `role`.
pub fn check_hot(signer: &Pubkey, state: &AccountLoader<'_, State>, role: HotRole) -> Result<bool> {
    let state = state.load()?;
    Ok(state.is_hot(signer, role))
}

/// Anchor `constraint = ...` helper for emergency-pause handlers. Returns
/// `Ok(true)` iff `signer` is cold, warm, or the configured `pause_admin`.
pub fn check_pause(signer: &Pubkey, state: &AccountLoader<'_, State>) -> Result<bool> {
    let state = state.load()?;
    Ok(state.is_pause(signer))
}

pub fn require_cold(signer: &Pubkey, state: &State) -> Result<()> {
    require!(state.is_cold(signer), ErrorCode::Unauthorized);
    Ok(())
}

pub fn require_warm(signer: &Pubkey, state: &State) -> Result<()> {
    require!(state.is_warm(signer), ErrorCode::Unauthorized);
    Ok(())
}

pub fn require_pause(signer: &Pubkey, state: &State) -> Result<()> {
    require!(state.is_pause(signer), ErrorCode::Unauthorized);
    Ok(())
}

/// Enforce that a caller acting via `pause_admin` (i.e. authorised by
/// `check_pause` but not by `check_warm`) may only *add* pause bits to a
/// bitmask, never clear them. Cold/warm callers can still set any value.
///
/// `old_mask` is the on-account value before the write; `new_mask` is the
/// value the caller is trying to install.
pub fn require_pause_only_added(
    signer: &Pubkey,
    state: &State,
    old_mask: u8,
    new_mask: u8,
) -> Result<()> {
    if !state.is_warm(signer) {
        require!((old_mask & new_mask) == old_mask, ErrorCode::Unauthorized);
    }
    Ok(())
}

pub fn require_hot(signer: &Pubkey, state: &State, role: HotRole) -> Result<()> {
    require!(state.is_hot(signer, role), ErrorCode::Unauthorized);
    Ok(())
}
