---
name: Devnet program ID (repeatable)
overview: Parameterize and document all repo changes needed when pointing Velocity at a new devnet program id. Re-run the same steps whenever the id changes; no vanity install/grind in scope—only code and config in source control.
todos:
  - id: set-id-variable
    content: Choose the canonical value for the new id once per iteration and record it as `VELOCITY_DEVNET_PROGRAM_ID` (env, note, or single config file—see below).
    status: in_progress
  - id: anchor-toml
    content: Set `[programs.devnet] velocity = "<VELOCITY_DEVNET_PROGRAM_ID>"` in [Anchor.toml](Anchor.toml).
    status: pending
  - id: rust-declare-id
    content: Align [programs/velocity/src/lib.rs](programs/velocity/src/lib.rs) `declare_id!` for the build profile that devnet uses (e.g. non-`mainnet-beta` if that matches [deploy-scripts/build-devnet.sh](deploy-scripts/build-devnet.sh)).
    status: pending
  - id: repo-wide-grep
    content: Grep for the old id and for `vELoC1audYbSYVRXn1vPaV8Axoa9oU6BYmNGZZBDZ1P`; update any devnet/test/sdk references that must track the new program id.
    status: pending
  - id: deploy-script
    content: Update [deploy-scripts/deploy-devnet.sh](deploy-scripts/deploy-devnet.sh) to use `VELOCITY_DEVNET_PROGRAM_ID` and the correct upgrade wallet (e.g. `VELOCITY_DEVNET_UPGRADE_KEYPAIR` or `anchor` provider wallet env).
    status: pending
  - id: verify-build
    content: Run `build-devnet.sh` and a quick `anchor`/`cargo` check to ensure the embedded id and artifacts match the intended id.
    status: pending
isProject: true
---

## Re-runnability (different program IDs over time)

**Yes—treat this as a fixed checklist.** Each time you move to a new devnet program id, set a new `VELOCITY_DEVNET_PROGRAM_ID` and repeat the same steps. No need to change the process—only the value and any file that still contains the _previous_ id from the last iteration.

**Recommended pattern for fast iteration**

1. **Single source of truth (optional but ideal):** One small file or env contract (e.g. `export VELOCITY_DEVNET_PROGRAM_ID=...` in a local, gitignored `deploy-scripts/.env.local`, or a single `constants` module only for devnet) so you replace the id in **one place** and scripts read it. If you keep ids only in `Anchor.toml` + `declare_id!` + grep, re-runs are still the same: search for the _old_ id and replace with the _new_ id everywhere the checklist marks.

2. **Always grep both:** After updating the canonical id, grep for:

   - The **new** id (should appear everywhere expected).
   - The **old** id(s) from the prior iteration (should be zero unless intentionally retained for mainnet/localnet docs).

3. **Operational steps out of scope here:** Installing `vanity`, grinding seeds, first deploy via `vanity deploy`, and `solana program write-buffer` are **not** part of this repo plan—you already handle those outside git.

## Inputs (set once per iteration)

| Input                     | Purpose                                                                                                    |
| ------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `VELOCITY_DEVNET_PROGRAM_ID` | New program pubkey (base58)                                                                                |
| Upgrade authority keypair | Used by `anchor upgrade` (match [deploy-scripts/deploy-devnet.sh](deploy-scripts/deploy-devnet.sh) wallet) |

## Code / config changes (in-repo)

1. **[Anchor.toml](Anchor.toml)** — Add or update `[programs.devnet]` with `velocity = "<VELOCITY_DEVNET_PROGRAM_ID>"`.

2. **Rust program id** — [programs/velocity/src/lib.rs](programs/velocity/src/lib.rs) `declare_id!` must match the id embedded in the `.so` you deploy to devnet, consistent with [deploy-scripts/build-devnet.sh](deploy-scripts/build-devnet.sh) (feature flags / `no-entrypoint` / `mainnet-beta`).

3. **Deploy script** — [deploy-scripts/deploy-devnet.sh](deploy-scripts/deploy-devnet.sh): `--program-id` and `--provider.wallet` for the upgrade authority (parameterized, not a one-off hardcode).

4. **SDK / tests / configs** — Repo-wide search for hardcoded Velocity program id; update devnet-oriented paths only as needed (preserve mainnet constants if the repo keeps both).

5. **Validate** — Rebuild with `build-devnet.sh` and confirm the program id in metadata / expected places matches `VELOCITY_DEVNET_PROGRAM_ID`.

## Cargo / dependencies

- **No new `cargo` dependencies expected** for id rotation. If a future change centralizes the id in a small shared crate, add deps only then.

## Subsequence: first deploy vs upgrade

- **First time** a given id exists on-chain: done outside this plan (buffer + `vanity deploy` or equivalent).
- **Subsequent** updates to the same id: [deploy-scripts/deploy-devnet.sh](deploy-scripts/deploy-devnet.sh) (`anchor upgrade`).

This document is the checklist to re-run whenever `VELOCITY_DEVNET_PROGRAM_ID` changes.
