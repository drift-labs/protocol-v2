//! Compile-time guard against drift between the IDL-generated `velocity_idl`
//! mirror and the on-chain `velocity` program crate.
//!
//! Both ship layouts for the same accounts (`PerpMarket`, `SpotMarket`,
//! `State`, ...). They have to agree, or `bytemuck::pod_read_unaligned` will
//! panic with `SizeMismatch` the first time a real account comes back from a
//! WS subscription.
//!
//! Each `const _: () = assert!(...)` here breaks the build the moment that
//! invariant fails — i.e. as soon as someone bumps `velocity_idl.rs` or the
//! `velocity =` dep without bringing the other along.
//!
//! `program::state::T::SIZE` includes the 8-byte anchor discriminator, so we
//! compare against `size_of::<idl T>() + 8`.

use crate::velocity_idl::accounts as idl;
use program::state::traits::Size;

macro_rules! assert_account_layout {
    ($idl:ty, $program:ty) => {
        const _: () = assert!(
            core::mem::size_of::<$idl>() + 8 == <$program as Size>::SIZE,
            concat!(
                "velocity_idl/",
                stringify!($idl),
                " size disagrees with on-chain ",
                stringify!($program),
                "::SIZE — regenerate the IDL or sync the `program` dep"
            ),
        );
    };
}

assert_account_layout!(idl::PerpMarket, program::state::perp_market::PerpMarket);
assert_account_layout!(idl::SpotMarket, program::state::spot_market::SpotMarket);
// `State` is intentionally not asserted here. It embeds `FeeStructure` /
// `OrderFillerRewardStructure`, neither of which is `#[repr(C)]`; on x86_64
// real `u128` has align 16 while the IDL mirror uses a custom newtype
// (`u128([u8;16])`, align 1), so `size_of::<idl::State>()` and
// `program::state::state::State::SIZE` cannot agree at compile time. All callers
// must load State via `VelocityClient::state_account()` (Borsh) — see
// `account_map.rs` `account_raw` doc.
// assert_account_layout!(idl::State, program::state::state::State);
assert_account_layout!(idl::User, program::state::user::User);
assert_account_layout!(idl::UserStats, program::state::user::UserStats);
