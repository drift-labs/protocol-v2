---
'@velocity-exchange/sdk': minor
'@velocity-exchange/admin-cli': minor
---

Program↔SDK parity fixes from the 2026-07-02 audit: renamed deprecated Switchboard
OracleSource keys to match the IDL (fixes a decode crash on affected markets), applied
the $100 initial-margin unrealized-PnL cap, standardized auction/limit prices to order
tick size across the DLOB, isolated-position handling in bankruptcy/liquidation math,
corrected MM-oracle validity gating, referrer_status memcmp offset, PerpOperation and
OrderBitFlag bit values, wired five missing event records into EventSubscriber, fixed
withdraw-limit divisors, multi-pool margin segregation, referee/builder fee estimation,
and added AdminClient.updatePauseAdmin plus admin CLI commands for pause-admin rotation
and fee-pool transfers. Also fixed withdrawFromIsolatedPerpPosition's withdraw-all path:
it substituted the MIN_I64 sentinel into the instruction's unsigned u64 amount (serializing
as 2^63, so full withdrawals always failed on-chain with InsufficientCollateral); it now
clamps the request to the position's deposit plus claimable PnL.

Follow-up completeness fixes: DLOBSubscriber.getL2/getL3 (and the dlob-server publisher) now
thread orderTickSize so the public book view is tick-standardized like on-chain; added
hasIsolatedMarginBankrupt and wired isolated-only bankruptcy detection into keeper resolution
(isIsolatedPositionBankrupt now guards against non-isolated indices); getMarketFees applies the
referee discount and calculateFeeForQuoteAmount accepts builder params so both public fee-prediction
entry points match on-chain; and isFallbackAvailableLiquiditySource now fully mirrors
amm_fill_gates_ok, adding the market-drawdown and MM-vs-exchange oracle volatility gates.

Low-risk parity follow-ups: MarginCategory now includes 'Fill' as a single shared type, handled
across perp margin ratio / unrealized-asset-weight and spot asset/liability weights (the
integer-averaged midpoint of initial and maintenance, mirroring get_margin_ratio /
get_asset_weight / get_liability_weight) instead of throwing or returning undefined; the
worst-tier taker-fee estimate in calculateEntriesEffectOnFreeCollateral now ceil-divides to match
calculate_taker_fee; MM-oracle validity is computed with the raw exchange confidence (matching
get_mm_oracle_price_data) while the returned MM price keeps its diff-adjusted confidence; and
corrected the OracleSourceNum doc (it is an SDK-internal oracle-id encoding, not the on-chain
Borsh discriminant).

Visible/breaking API changes in this release: `OracleSource.SWITCHBOARD` /
`OracleSource.SWITCHBOARD_ON_DEMAND` (and the corresponding `OracleSourceNum` entries) are renamed
to `DEPRECATED_SWITCHBOARD` / `DEPRECATED_SWITCHBOARD_ON_DEMAND` with no aliases kept for the old
names; `ContractType.FUTURE` is renamed to `DEPRECATED_FUTURE`; and `FeatureBitFlags.BUILDER_REFERRAL`
is removed outright, since no such on-chain flag exists. Separately, `getLimitPrice` gained a new
optional trailing `tickSize` parameter — the existing `fallbackPrice` parameter stays in its original
4th position, so old 4-argument call sites keep working unchanged.
