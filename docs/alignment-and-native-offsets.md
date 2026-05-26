# Struct Alignment, PoolBalance Padding, and Native Instruction Offsets

## The Problem: u128 Alignment Diverges Between x86_64 and SBF

Rust ≥ 1.77 corrected `align_of::<u128>()` to **16 bytes** on x86_64.  The Solana on-chain
target (SBF / BPF) has always kept it at **8 bytes**.

For any `#[repr(C)]` struct that contains a `u128` or `i128` field, this means:

- On **x86_64** the compiler may insert alignment padding before the field (if it sits at an
  offset that is not a multiple of 16) and/or tail-padding after the last field (to round the
  total size up to the next multiple of 16).
- On **SBF** neither gap is added, because the alignment requirement is only 8 bytes.

Result: `std::mem::size_of::<T>()` and field offsets **differ between the two platforms** for
any struct that contains u128 and whose total non-padding content is not already a multiple of 16.

### Why PoolBalance was the culprit

`PoolBalance` appeared in `AMM` (once), `PerpMarket` (twice via pnl\_pool) and `SpotMarket`
(twice) — all as `#[zero_copy(unsafe)]` structs whose on-chain bytes are the raw memory layout.

| Platform | `sizeof(PoolBalance)` before fix |
|----------|----------------------------------|
| x86_64   | 32 bytes (8 bytes of tail-padding added by compiler) |
| SBF      | 24 bytes (no tail-padding) |

Each occurrence contributed an **8-byte divergence**.  Combined with implicit alignment gaps in
`SpotMarket`, the total divergence reached 32 bytes for `SpotMarket` and 24 bytes for `PerpMarket`.

---

## The Fix

### 1. Widen `PoolBalance::padding`

`PoolBalance` previously had `padding: [u8; 6]`.  It was extended to `padding: [u8; 14]` so that
`sizeof(PoolBalance) == 32` on **both** platforms — the compiler adds no extra padding because the
declared content is already a multiple of 16.

### 2. Reorder fields in structs that embed PoolBalance

Any struct that placed a `u128`-containing field *after* a `PoolBalance` field could still develop
an architecture-specific alignment gap between them.  Fields were reordered so all `u128`/`i128`
types appear **before** any `PoolBalance` fields, eliminating the gap.

### 3. Regression guards

**Compile-time — `static_assertions::const_assert_eq!`**

`drift_macros::assert_no_slop` cannot be used more than once per module: the macro emits
module-level constants named `STRUCT_SIZE` and `FIELD_SIZES`, so a second use in the same file
causes a duplicate-definition compile error.  `perp_market.rs` defines `PerpMarket`, `PoolBalance`,
and `AMM` in the same module, which rules out the attribute macro for all three simultaneously.

Use `static_assertions::const_assert_eq!` directly instead — it generates anonymous `const` items
and can appear any number of times in one module:

```rust
use static_assertions::const_assert_eq;
use std::mem::size_of;

// PerpMarket::SIZE == 1240, so sizeof == 1232
const_assert_eq!(size_of::<PerpMarket>(), 1232);
// PoolBalance: u128 (16) + u16 (2) + [u8;14] padding == 32
const_assert_eq!(size_of::<PoolBalance>(), 32);
// AMM has no standalone SIZE constant.  Derive the correct value by running:
//   cargo test -p drift -- amm_zero_copy_offsets --nocapture
// or by checking `size_of::<PerpMarket>() - offset_of!(PerpMarket, amm)
//   - size_of::<PoolBalance>() - <remaining PerpMarket fields>`.
// Update the literal whenever AMM fields change.
const_assert_eq!(size_of::<AMM>(), /* run cargo test to derive */ 0);
```

Place these assertions immediately after the struct definitions they guard.  If you change field
types, add fields, or reorder fields and the compiler inserts implicit padding, the build fails
immediately — no need to run tests.

> **Note:** `traits/tests.rs` already contains `size` tests that assert
> `size_of::<PerpMarket>() + 8 == PerpMarket::SIZE` (and the same for `SpotMarket`).  Those cover
> the most important structs at test time.  The `const_assert_eq!` guards above add a
> compile-time layer for the embedded types (`PoolBalance`, `AMM`) that have no standalone `SIZE`
> constant and are therefore not covered by the existing tests.

**Test-time — `traits/tests.rs`**

| Module | What it checks |
|--------|----------------|
| `size` | `sizeof(T) + 8 == T::SIZE` for every major account type.  If padding diverges between platforms the SIZE constant (hardcoded) would no longer match, and Anchor account allocation would be wrong. |
| `market_index_offset` | Round-trips `PerpMarket` and `SpotMarket` through Anchor's account-info machinery and reads `market_index` at `MARKET_INDEX_OFFSET`.  Fails if the byte layout has shifted. |

---

## Padding Up vs Padding Down

### Current reserve audit

All zero-copy structs must satisfy: `(SIZE - 8) % 16 == 0`.  The gap between actual field
content and that minimum is intentional **reserve space** for future fields.

| Struct | Non-padding content | Declared total (SIZE−8) | Minimum valid total | Reserve left |
|--------|--------------------|-----------------------|--------------------|-|
| `PoolBalance` | 18 B | 32 B | 32 B | **0 B** — exact minimum, no room |
| `PerpMarket`  | 1202 B | 1232 B | 1216 B | **16 B** — 1 u128 or 2 u64 |
| `SpotMarket`  | 744 B  | 800 B  | 752 B  | **48 B** — 3 u128 or 6 u64 |
| `LPPool`      | 314 B  | 496 B  | 320 B  | **176 B** |

### "Pad up" vs "pad down" explained

> **Pad up**: increase the total `SIZE` to the next higher multiple of 16.
> **Pad down**: reduce the total `SIZE` to the next lower multiple of 16.

For **live mainnet accounts** neither option is freely available: `SIZE` is fixed by what was
already allocated on-chain when the accounts were first created.  Changing `SIZE` requires an
explicit account-reallocation instruction and a migration.

For **new structs** or during a planned realloc migration, the choice is:

- **Pad up** (larger struct): simpler, no data loss risk, wastes a little rent.
- **Pad down** (smaller struct): saves rent, but only valid if the smaller size still satisfies
  alignment and there is no existing on-chain data at the larger size.

In both cases the rule is the same: **`(SIZE - 8)` must be a multiple of 16.**

> **Why 16 and not 8?**  The target that matters most is the *deployed* SBF VM (align=8), but
> the tests and SDK run on x86_64 (align=16 for u128).  Choosing a multiple of 16 satisfies both
> simultaneously and keeps `sizeof` identical on all platforms, which is a hard requirement for
> zero-copy accounts.

---

## Managing Field Changes in Zero-Copy Structs

Zero-copy (`#[account(zero_copy)]`) structs have a **fixed on-chain layout**.  Any change that
shifts a field's byte position is a **breaking change** — existing accounts hold data at the
old offsets.

### The invariants you must preserve

1. **`(SIZE - 8) % 16 == 0`** — total struct content is a multiple of 16.
2. **No u128/i128 field appears after a `PoolBalance` field** — re-introducing that ordering
   re-introduces an implicit 8-byte alignment gap on x86_64 (see above).
3. **All u128/i128 fields start at an offset that is a multiple of 16** — otherwise x86_64
   inserts an internal alignment gap that SBF does not, causing `sizeof` to diverge again.

### Adding a new field

1. **Consume reserve padding**: shrink the trailing `padding` array by the size of the new field.
2. **Check the new total**: `(non-padding content + new padding)` must still be a multiple of 16.
   - If it's already a multiple of 16: done.
   - If it's short of a multiple of 16 by *N* bytes: remove *N* more bytes from padding (**pad
     down** to the previous multiple of 16).  This is only valid if the resulting `SIZE` is
     ≥ the currently-deployed account size on mainnet.
   - If removing *N* more bytes would go below the deployed size: remove *16 − N* fewer bytes
     from padding instead (**pad up** to the next multiple of 16 above).  The total size grows
     by `16 − N` bytes, requiring a realloc migration.
3. **Place the field correctly**: u128/i128 fields must precede `PoolBalance` fields; other
   types can go anywhere that keeps all u128 offsets at multiples of 16.
4. **Run the size regression tests**: `cargo test -p drift size`.

### Removing a field (replacing with padding)

1. Replace the field with an equivalently-sized `padding_*: [u8; N]` array to preserve existing
   offsets for all subsequent fields.
2. The total `(SIZE - 8)` doesn't change, so the multiple-of-16 invariant is automatically
   preserved.
3. **Do not shrink the struct** unless you are performing an explicit realloc migration — on-chain
   accounts are already allocated at the current `SIZE`.

### Growing a field (e.g. u32 → u64)

Equivalent to removing the old field and adding a larger one.  You must consume 4 extra bytes
from padding *and* check the multiple-of-16 invariant (step 2 above).

### Example: adding a u64 to PerpMarket

`PerpMarket` has **16 bytes of reserve** (padding is `[u8; 30]`, minimum is 14).

```
Before: content=1202, padding=30, total=1232  ✓ (multiple of 16)
Add u64 (8 bytes): consume from padding
  tentative: content=1210, padding=22, total=1232  ✓ (still multiple of 16)
```

16 − 8 = 8 bytes of reserve remaining after this change.

### Example: adding a u128 to PerpMarket

```
Before: content=1202, padding=30, total=1232  ✓
Add u128 (16 bytes): consume from padding
  tentative: content=1218, padding=14, total=1232  ✓ (still multiple of 16)
```

0 bytes of reserve remaining.  The next field addition would require a realloc migration.

### Example: adding a u64 to SpotMarket (what "pad down" looks like)

```
Before: content=744, padding=56, total=800  ✓
Add u64 (8 bytes), naive: content=752, padding=48, total=800  ✓
```

800 is still a multiple of 16 so no adjustment needed — take 8 bytes from padding, done.

But if the field were 12 bytes (hypothetically):

```
Naive: content=756, padding=44, total=800  ✓  (800 still multiple of 16, fine)
```

If it were 20 bytes:
```
Naive: content=764, padding=36, total=800  ✓  (still fine)
```

SpotMarket has so much reserve (48 B) that simple subtraction keeps the total a multiple of 16
for any field size ≤ 48 bytes.  Once reserve drops below 16, you must check more carefully.

---

## Native Instruction Byte Offsets

Two instruction handlers bypass Anchor's deserializer entirely and **write directly into raw
account bytes** at hardcoded offsets:

- `handle_update_mm_oracle_native` — writes `mm_oracle_slot`, `mm_oracle_price`,
  `mm_oracle_sequence_id` into a `PerpMarket` account; reads `feature_bit_flags` from a `State`
  account.
- `handle_update_amm_spread_adjustment_native` — writes `amm_spread_adjustment` into a
  `PerpMarket` account.

### Two different encoding models — two different offset calculation methods

| Account | Encoding | How to compute offset |
|---------|----------|-----------------------|
| `PerpMarket` / `AMM` | **Zero-copy** (`#[account(zero_copy)]`) — on-chain bytes *are* the `repr(C)` memory layout | `std::mem::offset_of!(Struct, field) + 8` (8 = discriminator) |
| `State` | **Regular `#[account]`** — on-chain bytes are **borsh-serialised** (sequential, no alignment padding) | Borsh round-trip: serialize a sentinel value and find its byte position |

Using `offset_of!` for a borsh-serialised account gives the **wrong answer** because borsh writes
fields sequentially with no gaps, while `offset_of!` reflects the memory layout which includes
alignment padding.

### Current hardcoded offsets (as of this fix)

| Field | Account | Offset | How derived |
|-------|---------|--------|-------------|
| `AMM::mm_oracle_slot` | `PerpMarket` (zero-copy) | 840 | `offset_of!(PerpMarket, amm) + offset_of!(AMM, mm_oracle_slot) + 8` |
| `AMM::mm_oracle_price` | `PerpMarket` (zero-copy) | 920 | same |
| `AMM::mm_oracle_sequence_id` | `PerpMarket` (zero-copy) | 944 | same |
| `AMM::amm_spread_adjustment` | `PerpMarket` (zero-copy) | 942 | same |
| `State::feature_bit_flags` | `State` (borsh) | 982 | borsh round-trip |

### Regression tests

`programs/drift/src/state/traits/tests.rs :: native_instruction_offsets` contains two tests that
lock these values down:

- **`amm_zero_copy_offsets`** — asserts each `offset_of!` value equals the literal in `admin.rs`.
- **`state_borsh_feature_bit_flags_offset`** — serialises a `State` with `feature_bit_flags = 0xFF`
  and asserts the byte is found at position 982 (including discriminator).

**If you change any field in `AMM`, `PerpMarket`, or `State`, run `cargo test -p drift
native_instruction_offsets` and update both the test expectations and the literals in
`handle_update_mm_oracle_native` / `handle_update_amm_spread_adjustment_native` together.**

---

## SDK Custom User Decoder (`sdk/src/decode/user.ts`)

The SDK ships a hand-written binary decoder for `UserAccount` that reads the raw on-chain bytes
directly rather than going through Anchor's borsh coder.  It is tested in
`sdk/tests/decode/test.ts`, which decodes 100 real mainnet buffers and asserts field-by-field
equality against Anchor's own decoder.

**Why it exists:** Anchor's borsh coder allocates many intermediate objects; the custom decoder
is ~15× smaller in output size and measurably faster for high-frequency subscription paths.

### How the decoder works

The decoder maintains a running `offset` counter starting at 8 (past the discriminator) and
reads each field in declaration order — identical to how zero-copy structs lay out in memory
and how borsh serialises them.  For `PerpPosition` and `SpotPosition` it also pre-reads a few
fields at fixed relative offsets before the loop body to decide whether to skip the slot
entirely.

### What must be updated when `UserAccount` or its sub-structs change

`UserAccount` and its embedded types (`SpotPosition`, `PerpPosition`, `Order`) are **not**
zero-copy on-chain — they are regular `#[account]` structs serialised with borsh.  However,
because they contain only fixed-size primitive fields (no `Vec`, `String`, or `Option`), the
borsh wire format is identical to a packed `repr(C)` layout: fields are written sequentially
with no gaps.

| Change | What to update in `decode/user.ts` |
|--------|------------------------------------|
| Field added to `PerpPosition` / `SpotPosition` / `Order` | Add a read at the correct offset; update the `offset +=` arithmetic for all subsequent fields; add the field to the returned object literal |
| Field removed (replaced with padding) | Replace the read with `offset += N`; remove it from the returned object literal; remove it from the `PerpPosition` / `SpotPosition` TypeScript type in `src/types.ts` and any default-value sites |
| Field type widened (e.g. `u32` → `u64`) | Change the reader and update `offset +=` delta |
| Field reordered | Reorder the reads to match; all subsequent absolute pre-reads (`offset + N`) must be recalculated |

**Tracking signed vs unsigned:** use `readSignedBigInt64LE` for `i64` fields and
`readUnsignedBigInt64LE` for `u64` fields.  The two diverge only when bit 63 is set; a mismatch
causes silent `.eq()` failures in the decode test rather than a crash, so it is easy to miss
without running the test.

**Tracking padding:** when a field is removed from the Rust struct and replaced with
`padding_x: [u8; N]`, the decoder must skip those bytes (`offset += N`) rather than removing
the read entirely — otherwise every field that follows shifts by N bytes and all subsequent
assertions fail.

### Running the test

```bash
cd sdk
bun run test --grep "Custom user decode"
```

The test decodes 100 real mainnet `UserAccount` buffers and compares every field between the
custom decoder and Anchor's borsh decoder.  It should be run any time `UserAccount`,
`PerpPosition`, `SpotPosition`, or `Order` changes layout.

---

## Quick Reference: What Breaks If You Get This Wrong

| Mistake | Symptom |
|---------|---------|
| PoolBalance padding too small | `sizeof(PerpMarket)` differs between dev (x86\_64) and on-chain (SBF); `size` tests fail on one platform |
| u128 field placed after PoolBalance | Alignment gap re-introduced; size diverges silently at runtime |
| New field pushes total off a multiple of 16 | x86\_64 adds implicit tail padding; sizeof diverges; `size` tests fail |
| `(SIZE - 8)` changed without a realloc migration | Anchor rejects existing on-chain accounts as too small |
| Using `offset_of!` for a borsh account | Native handler reads/writes the wrong field; assertion fires or silently corrupts data |
| Updating AMM/PerpMarket layout without updating `admin.rs` | Native instructions write to stale offsets; values appear unchanged after the tx |
| Changing `PerpPosition` / `SpotPosition` / `Order` layout without updating `sdk/src/decode/user.ts` | Custom decoder reads wrong bytes; `Custom user decode` SDK test fails with field-value mismatches |
| Using `readSignedBigInt64LE` for a `u64` field in `decode/user.ts` | Silent mismatch vs Anchor when bit 63 is set; `.eq()` in the decode test fails |
