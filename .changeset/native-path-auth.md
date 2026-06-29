---
'@velocity-exchange/sdk': minor
---

Harden the native fast-path admin handlers. The
`update_amm_spread_adjustment_native` instruction now requires the program
`State` account: `getUpdateAmmSpreadAdjustmentNativeIx` is now **async** and
returns a `Promise<TransactionInstruction>` (it derives and appends the state
account), and its compute-unit budget was raised to cover the on-chain account
validation. Direct callers must `await` the builder. Two new program error
codes are surfaced in the IDL: `InvalidNativeStateAccount` (6355) and
`InvalidNativePerpMarketAccount` (6356).
