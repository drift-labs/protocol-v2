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

/// Structural authentication for the pre-Anchor native dispatch handlers
/// (`lib.rs::program_entry`, discriminator `[0xFF; 4]`).
///
/// These handlers run *before* Anchor, so they receive a raw `&[AccountInfo]`
/// with none of the ownership / discriminator guarantees that
/// `#[derive(Accounts)]` would normally establish. A handler that authenticates
/// against byte offsets of a caller-supplied "state" account, or that
/// `bytemuck`-casts a caller-supplied "market" account, trusts attacker-chosen
/// bytes: a forged state account whose hot-key offset holds the caller's own
/// pubkey defeats the signer check, and any writable account can be reinterpreted
/// as a `PerpMarket`. Every native handler MUST call this on each typed account
/// before reading or writing its bytes.
///
/// Asserts the account is owned by this program and carries `discriminator` as
/// its first 8 bytes — exactly the checks `AccountLoader` performs, but without
/// cloning the `AccountInfo` or re-borrowing/re-validating on `load`, so the
/// native fast path keeps its minimal CU budget. Owner + discriminator are
/// sufficient: the program only ever writes a given account discriminator to its
/// own PDAs, so no caller-controlled account can satisfy both (the `State`
/// discriminator in particular only ever lands on the singleton
/// `[b"velocity_state"]` PDA).
pub fn require_native_account(
    acc: &AccountInfo,
    discriminator: &[u8],
    err: ErrorCode,
) -> Result<()> {
    if acc.owner != &crate::ID {
        return Err(err.into());
    }
    let data = acc.try_borrow_data()?;
    if data.len() < discriminator.len() || &data[..discriminator.len()] != discriminator {
        return Err(err.into());
    }
    Ok(())
}

/// Anchor `constraint = ...` helper. Returns `Ok(true)` iff the signer is the
/// cold admin. Reserved for actions that can undermine other safety rails
/// (e.g. swapping a market's oracle, which prices the withdraw guard
/// threshold notional cap).
pub fn check_cold(signer: &Pubkey, state: &AccountLoader<'_, State>) -> Result<bool> {
    let state = state.load()?;
    Ok(state.is_cold(signer))
}

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
