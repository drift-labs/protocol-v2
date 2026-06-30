//! Regression coverage for the production swift panic:
//!
//! ```text
//! from_bytes>TargetAlignmentGreaterAndInputNotAligned
//! ```
//!
//! ## Where it fired
//!
//! The off-chain pre-trade simulation: `simulate_taker_order_local` ->
//! `simulate_place_perp_order` (`swift/src/util/local_sim.rs`) builds the
//! program's `PerpMarketMap`/`SpotMarketMap` from owned account bytes and runs
//! the real `place_perp_order`. Those maps wrap anchor's `AccountLoader`, which
//! casts the zero-copy struct **by reference**: `bytemuck::from_bytes(&data[8..])`.
//!
//! ## Root cause
//!
//! On-chain SBF has `align_of::<u128>() == 8`, so an 8-aligned account-data
//! region suffices for any zero-copy struct. Off-chain on x86_64 with Rust ≥ 1.77,
//! `align_of::<u128>() == 16`, so `PerpMarket`/`SpotMarket` (native `u128`/`i128`)
//! are 16-aligned. The simulation's account bytes lived in a `Vec<u8>`
//! (`OwnedAccount.data`), which the allocator hands back 16-aligned at the *base*;
//! slicing `[8..]` to skip the discriminator yields a pointer at `8 mod 16` — not
//! 16-aligned — so `from_bytes` panics.
//!
//! ## The fix
//!
//! `OwnedAccount.data` now holds a `program::sdk::AlignedAccountData`: a heap
//! buffer whose payload starts at `base + 8`, so the post-discriminator struct
//! lands on a 16-byte boundary. The byte copy happens **once**, when the
//! `OwnedAccount` is built (`AccountsListBuilder`); the `AccountInfo`/`AccountLoader`
//! the simulation feeds then casts the struct in place — genuine zero-copy, no
//! per-read copy, no panic.
//!
//! These tests pin: (1) `AlignedAccountData` actually 16-aligns the body, (2) an
//! `OwnedAccount` built that way round-trips through the program's by-reference
//! `AccountLoader` for both market structs, and (3) the hazard is real — anchor's
//! by-reference cast still panics on a deliberately 8-mod-16 buffer.
//!
//! Run: `cargo test -p swift-server --test devnet_zero_copy_alignment`

use std::mem::{align_of, size_of};
use std::panic::{self, AssertUnwindSafe};

use anchor_lang::{AccountDeserialize, Discriminator};
use velocity_rs::program::sdk::{build_infos, AlignedAccountData, OwnedAccount};
use velocity_rs::program::state::{
    perp_market::PerpMarket,
    perp_market_map::PerpMarketMap,
    spot_market::SpotMarket,
    spot_market_map::SpotMarketMap,
    traits::{MarketIndexOffset, Size},
};
use velocity_rs::Pubkey;

/// Run `f`, swallowing the default backtrace print, returning the panic payload
/// as a `String` if it panicked.
fn capture_panic<F: FnOnce() -> R, R>(f: F) -> Result<R, String> {
    let prev = panic::take_hook();
    panic::set_hook(Box::new(|_| {}));
    let result = panic::catch_unwind(AssertUnwindSafe(f));
    panic::set_hook(prev);
    result.map_err(|payload| {
        payload
            .downcast_ref::<String>()
            .cloned()
            .or_else(|| payload.downcast_ref::<&str>().map(|s| s.to_string()))
            .unwrap_or_else(|| "<non-string panic payload>".to_string())
    })
}

/// Build an `OwnedAccount` exactly as `AccountsListBuilder` does — owner =
/// velocity program, bytes in an `AlignedAccountData` — for a zeroed account of
/// `size` bytes (full account incl. the 8-byte discriminator) with `disc` and
/// `market_index` patched in. A zeroed body is a valid `Pod`; field values are
/// irrelevant here — the cast is what we exercise.
fn owned_market(disc: &[u8], size: usize, index_offset: usize, market_index: u16) -> OwnedAccount {
    let mut raw = vec![0u8; size];
    raw[..8].copy_from_slice(disc);
    raw[index_offset..index_offset + 2].copy_from_slice(&market_index.to_le_bytes());
    OwnedAccount {
        lamports: 0,
        data: AlignedAccountData::from_bytes(&raw),
        owner: velocity_rs::program::ID,
        executable: false,
    }
}

#[test]
fn aligned_account_data_body_is_16_aligned() {
    // Precondition: the structs that triggered the bug really are 16-aligned
    // off-chain, so an 8-aligned body would fault.
    assert_eq!(align_of::<PerpMarket>(), 16);
    assert_eq!(align_of::<SpotMarket>(), 16);

    let raw = vec![0u8; 8 + size_of::<PerpMarket>()];
    let data = AlignedAccountData::from_bytes(&raw);
    let body_addr = data.as_slice()[8..].as_ptr() as usize;
    assert_eq!(
        body_addr % 16,
        0,
        "post-discriminator body must be 16-aligned for a by-reference cast"
    );
}

#[test]
fn perp_market_loads_through_program_account_loader() {
    // The exact shape the simulation builds, loaded via the program's
    // by-reference `AccountLoader` map. `get_ref` performs the `from_bytes` cast
    // that panicked pre-fix.
    let mut entries = vec![(
        Pubkey::new_unique(),
        owned_market(
            PerpMarket::DISCRIMINATOR,
            PerpMarket::SIZE,
            PerpMarket::MARKET_INDEX_OFFSET,
            7,
        ),
    )];

    let infos = build_infos(&mut entries);
    let map = PerpMarketMap::load(&Default::default(), &mut infos.iter().peekable()).unwrap();
    let market = map.get_ref(&7).unwrap();
    assert_eq!(market.market_index, 7);
}

#[test]
fn spot_market_loads_through_program_account_loader() {
    let mut entries = vec![(
        Pubkey::new_unique(),
        owned_market(
            SpotMarket::DISCRIMINATOR,
            SpotMarket::SIZE,
            SpotMarket::MARKET_INDEX_OFFSET,
            3,
        ),
    )];

    let infos = build_infos(&mut entries);
    let map = SpotMarketMap::load(&Default::default(), &mut infos.iter().peekable()).unwrap();
    let market = map.get_ref(&3).unwrap();
    assert_eq!(market.market_index, 3);
}

#[test]
fn anchor_by_reference_cast_still_panics_on_misaligned_buffer() {
    // Documents why `AlignedAccountData` is mandatory: a buffer whose body is at
    // `8 mod 16` (a 16-aligned `Vec<u128>` base, sliced `[8..]`) still faults
    // anchor's by-reference cast — the production failure mode, deterministic.
    let total = 8 + size_of::<PerpMarket>();
    let words = vec![0u128; total.div_ceil(16)]; // 16-aligned heap allocation
                                                 // SAFETY: reinterpreting initialized `[u128]` as bytes; all bit patterns valid.
    let bytes: &[u8] =
        unsafe { std::slice::from_raw_parts(words.as_ptr() as *const u8, words.len() * 16) };
    let mut buf = bytes[..total].to_vec();
    assert_eq!(
        buf.as_ptr() as usize % 16,
        0,
        "buffer base must be 16-aligned"
    );
    buf[..8].copy_from_slice(PerpMarket::DISCRIMINATOR);

    let result = capture_panic(|| {
        let _ = PerpMarket::try_deserialize(&mut buf.as_slice());
    });
    let msg = result.expect_err("anchor try_deserialize must panic on the misaligned buffer");
    assert!(
        msg.contains("TargetAlignmentGreaterAndInputNotAligned"),
        "expected the production alignment panic, got: {msg:?}"
    );
}
