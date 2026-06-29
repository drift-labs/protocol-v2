---
'@velocity-exchange/sdk': minor
'@velocity-exchange/admin-cli': minor
---

Decouple solvency-repair from the withdraw pause. The `resolve_perp_pnl_deficit`,
`resolve_perp_bankruptcy`, and `resolve_spot_bankruptcy` instructions are now gated by a
new `State.solvencyStatus` bitfield instead of `WithdrawPaused`, so user withdrawals can
be halted while solvency repair keeps running (or repair can be frozen on its own). Adds
the `SolvencyStatus` enum, `StateAccount.solvencyStatus`, a `solvencyRepairPaused()`
helper, `AdminClient.updateSolvencyStatus`, and the `exchange set-solvency-status` admin
CLI command.
