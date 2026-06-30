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
use anchor_lang::Discriminator;
use bytemuck::Pod;

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

/// Owns an Anchor account's raw bytes (8-byte discriminator + zero-copy body)
/// in a heap buffer positioned so the body — `bytes[8..]`, where anchor's
/// `AccountLoader` / `try_deserialize` cast the struct **by reference** — is
/// 16-byte aligned.
///
/// # Why this exists
///
/// On-chain, the SBF target has `align_of::<u128>() == 8`, so an 8-aligned
/// account-data region is enough for any zero-copy struct. Off-chain on x86_64
/// with Rust ≥ 1.77, `align_of::<u128>() == 16`, so `PerpMarket` / `SpotMarket`
/// (native `u128`/`i128` fields) are 16-aligned. Account bytes arrive off the
/// wire in `Vec<u8>` / `Arc<[u8]>` allocations the global allocator hands back
/// 16-aligned at the *base*; slicing `[8..]` to skip the discriminator yields a
/// pointer at `8 mod 16`, which is **not** 16-aligned, and
/// `bytemuck::from_bytes` panics with `TargetAlignmentGreaterAndInputNotAligned`.
///
/// `AlignedAccountData` allocates with 16-byte alignment and places the payload
/// at `base + 8`, so the post-discriminator struct lands at `base + 16` — a
/// 16-byte boundary. The byte copy happens **once**, at construction; every
/// later access ([`as_slice`](Self::as_slice), the `AccountInfo` the SDK builds,
/// and the `AccountLoader` cast it feeds) is genuine zero-copy (by reference, no
/// per-read copy).
pub struct AlignedAccountData {
    /// Allocation base (16-aligned). Owns the allocation; freed in `Drop`.
    base: *mut u8,
    /// Payload start, `base + DISC_LEN`, so `ptr + DISC_LEN` is 16-aligned.
    ptr: *mut u8,
    /// Payload length (discriminator + struct body).
    len: usize,
    layout: std::alloc::Layout,
}

impl AlignedAccountData {
    /// 16 is the maximum alignment any zero-copy account needs (u128/i128);
    /// over-aligning smaller payloads (oracles) is harmless.
    const ALIGN: usize = 16;
    /// Anchor's account discriminator length.
    const DISC_LEN: usize = 8;

    fn alloc(len: usize) -> Self {
        // `ALIGN` bytes of headroom let the payload sit at `base + DISC_LEN`
        // while staying inside the allocation regardless of `len`.
        let layout = std::alloc::Layout::from_size_align(len + Self::ALIGN, Self::ALIGN).unwrap();
        let base = unsafe { std::alloc::alloc_zeroed(layout) };
        assert!(!base.is_null(), "OOM allocating aligned account buffer");
        let ptr = unsafe { base.add(Self::DISC_LEN) };
        Self {
            base,
            ptr,
            len,
            layout,
        }
    }

    /// Copy `raw` (a full discriminator + body buffer) into a fresh aligned
    /// allocation. One copy; reads thereafter are zero-copy.
    pub fn from_bytes(raw: &[u8]) -> Self {
        let mut this = Self::alloc(raw.len());
        this.as_mut_slice().copy_from_slice(raw);
        this
    }

    /// Serialize a zero-copy account `T` (discriminator + `bytemuck` body)
    /// directly into a fresh aligned allocation — the single copy from the
    /// in-memory struct to the wire-shaped, alignment-correct bytes the program's
    /// `AccountLoader` casts. `T` is typically the velocity-rs IDL-mirror type;
    /// its byte layout and discriminator match the program struct.
    pub fn from_account<T: Pod + Discriminator>(account: &T) -> Self {
        let body = bytemuck::bytes_of(account);
        let mut this = Self::alloc(Self::DISC_LEN + body.len());
        let dst = this.as_mut_slice();
        dst[..Self::DISC_LEN].copy_from_slice(T::DISCRIMINATOR);
        dst[Self::DISC_LEN..].copy_from_slice(body);
        this
    }

    pub fn as_slice(&self) -> &[u8] {
        unsafe { std::slice::from_raw_parts(self.ptr, self.len) }
    }

    pub fn as_mut_slice(&mut self) -> &mut [u8] {
        unsafe { std::slice::from_raw_parts_mut(self.ptr, self.len) }
    }

    pub fn len(&self) -> usize {
        self.len
    }

    pub fn is_empty(&self) -> bool {
        self.len == 0
    }
}

impl Drop for AlignedAccountData {
    fn drop(&mut self) {
        unsafe { std::alloc::dealloc(self.base, self.layout) }
    }
}

impl Clone for AlignedAccountData {
    fn clone(&self) -> Self {
        Self::from_bytes(self.as_slice())
    }
}

impl Default for AlignedAccountData {
    fn default() -> Self {
        Self::alloc(0)
    }
}

impl std::ops::Deref for AlignedAccountData {
    type Target = [u8];
    fn deref(&self) -> &[u8] {
        self.as_slice()
    }
}

impl std::ops::DerefMut for AlignedAccountData {
    fn deref_mut(&mut self) -> &mut [u8] {
        self.as_mut_slice()
    }
}

impl AsRef<[u8]> for AlignedAccountData {
    fn as_ref(&self) -> &[u8] {
        self.as_slice()
    }
}

impl std::fmt::Debug for AlignedAccountData {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("AlignedAccountData")
            .field("len", &self.len)
            .finish()
    }
}

impl PartialEq for AlignedAccountData {
    fn eq(&self, other: &Self) -> bool {
        self.as_slice() == other.as_slice()
    }
}

impl Eq for AlignedAccountData {}

// SAFETY: `AlignedAccountData` uniquely owns its heap allocation (freed in
// `Drop`) with no aliasing or interior mutability — the same ownership model as
// the `Vec<u8>` it replaced, which is `Send + Sync`. Preserving these auto
// traits keeps `OwnedAccount`/`VelocityAccounts` usable across threads/awaits.
unsafe impl Send for AlignedAccountData {}
unsafe impl Sync for AlignedAccountData {}

impl From<Vec<u8>> for AlignedAccountData {
    fn from(v: Vec<u8>) -> Self {
        Self::from_bytes(&v)
    }
}

impl From<&[u8]> for AlignedAccountData {
    fn from(v: &[u8]) -> Self {
        Self::from_bytes(v)
    }
}

/// Client-side owned account payload, mirroring `solana_account::Account` but
/// owned, `Default`-able, and — crucially — holding its bytes in an
/// [`AlignedAccountData`] buffer so the program's off-chain zero-copy
/// `AccountLoader` can cast 16-aligned structs (`PerpMarket`/`SpotMarket`)
/// without an alignment panic. See [`AlignedAccountData`] for the why.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct OwnedAccount {
    pub lamports: u64,
    pub data: AlignedAccountData,
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

/// Fabricate an `AccountInfo` borrowing directly into `slot`'s
/// [`AlignedAccountData`]. Zero-copy: no bytes are copied here — the single copy
/// already happened when the `OwnedAccount` was built — and the program's
/// `AccountLoader` casts the 16-aligned body in place.
#[allow(deprecated)]
pub fn account_info_from<'a>(slot: &'a mut (Pubkey, OwnedAccount)) -> AccountInfo<'a> {
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

/// Borrow an `AccountInfo` for every entry. Hold the returned vec for as long as
/// any borrow is in use.
pub fn build_infos(entries: &mut [(Pubkey, OwnedAccount)]) -> Vec<AccountInfo<'_>> {
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
