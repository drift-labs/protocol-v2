# Velocity Protocol — Security Review Guidance

This file is consumed by the `anthropics/claude-code-security-review` GitHub
Action as false-positive filtering instructions. It documents intentional
patterns in the Velocity codebase that a generic security model is likely to flag
incorrectly. Treat these as expected and **do not report them as findings**
unless the change clearly violates the documented invariant.

For deeper context, the canonical references are `CLAUDE.md`, `ARCHITECTURE.md`,
and `docs/alignment-and-native-offsets.md`.

## Intentional patterns — do not flag

### 1. Zero-copy struct layout with explicit padding

Anchor zero-copy account structs in `programs/velocity/src/state/` use `repr(C)` and
manual padding bytes so that `(SIZE - 8) % 16 == 0` and all `u128`/`i128` fields
are ordered before any `PoolBalance` fields. This ensures `sizeof` matches the
on-chain SBF layout regardless of whether the host is Rust 1.76 (older
`align_of::<u128>()` of 8) or Rust ≥ 1.77 (corrected `align_of::<u128>()` of 16
on x86_64). `const_assert_eq!` guards enforce the invariant at compile time.

- Padding bytes are **not** uninitialized memory bugs.
- Field reordering is **not** a refactor — it is load-bearing for on-chain ABI
  compatibility.
- Adding a field requires preserving the invariant; if a PR adds a u128/i128
  field after a `PoolBalance` field, that *is* worth flagging.

### 2. Custom native entrypoint with `[0xFF, 0xFF, 0xFF, 0xFF, opcode]` discriminator

Velocity dispatches certain high-frequency keeper instructions through a custom
native entrypoint that bypasses Anchor's instruction discriminator and account
deserialization. The leading bytes `[0xFF, 0xFF, 0xFF, 0xFF, <opcode>]` are the
documented signal for this dispatch path. Manual deserialization of accounts
inside this entrypoint is expected.

- This is **not** unsafe deserialization of untrusted input — the dispatch is
  intentional and the per-opcode handlers perform their own validation.
- Do not flag the absence of Anchor's `#[derive(Accounts)]` macros along this
  path.

### 3. `remaining_accounts` for variable-length account lists

Many instructions accept variable numbers of oracle accounts, spot markets, or
maker accounts via Anchor's `remaining_accounts`. These are *not* validated by
the `Accounts` struct macro; instead, validation lives in
`programs/velocity/src/validation/` and in per-instruction logic.

- "Unvalidated `remaining_accounts`" is **only** a finding if the instruction in
  question does not call into the validation layer. Check
  `programs/velocity/src/validation/` and the instruction's controller before
  reporting.

### 4. `AccountLoader` zero-copy on large accounts

`User` and `PerpMarket` accounts are loaded with Anchor's `AccountLoader`, which
returns `RefMut`/`Ref` views into the underlying buffer without copying. This
involves `unsafe`-adjacent patterns that are correct given the alignment
invariant in (1).

- Do not flag `load_mut()` / `load()` patterns themselves.
- Do flag if a PR introduces a *new* zero-copy struct that does not satisfy the
  alignment invariant, or accesses fields outside the `RefMut` lifetime.

## Generated and non-source artifacts — skip review

Diffs in the following paths add no security signal beyond reviewing their
upstream sources, and you can skip them entirely:

- `sdk/src/idl/velocity.json` — regenerated from the Anchor program. Any
  meaningful change is already visible in the corresponding Rust diff.
- Pure markdown changes (`**/*.md`) — documentation, no executable behavior.
- Lockfile diffs (`yarn.lock`, `bun.lockb`, `package-lock.json`, `Cargo.lock`)
  — dependency hygiene is covered by Snyk SCA, not this review.

## What *is* in scope

Focus reports on:

- New unsafe blocks or pointer arithmetic outside the documented zero-copy
  pattern.
- Instructions that read user-controlled accounts without calling the
  validation layer.
- Oracle staleness, price manipulation, or rounding-direction bugs that affect
  margin or settlement math.
- Authority/signer checks missing on admin or keeper instructions.
- Integer overflow/underflow in pricing, funding, or PnL math
  (`programs/velocity/src/math/`).
- SDK code that constructs transactions with attacker-controllable fields
  without bounds-checking.
- Secret material, API keys, or RPC endpoints accidentally committed.

When in doubt, prefer reporting with a clear "why this might still be okay
given the patterns above" so reviewers can triage quickly.
