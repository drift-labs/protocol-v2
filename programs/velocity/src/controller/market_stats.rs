//! Market-level statistics writer module — documentation placeholder.
//!
//! Historic market data (mark TWAPs, oracle TWAPs, std, volume, intensity,
//! mm-oracle snapshots) lives in `PerpMarket.market_stats: MarketStats`.
//! **All** writers are methods on `MarketStats` itself, defined in
//! `state/perp_market.rs`:
//!
//! - `update_mark_std`, `update_oracle_std`, `update_oracle_conf_pct`
//! - `update_volume_24h`
//! - `update_mark_twap`, `update_mark_twap_with_amm_bid_ask`,
//!   `update_mark_twap_crank`
//! - `update_oracle_twap`
//!
//! The TWAP writers take `&AMM` read-only when they need to derive an
//! input (reserve_price, AMM bid/ask, base_spread) and otherwise only
//! mutate `self`. No external caller — not funding, not matching, not
//! the AMM refresh path — should reach into the AMM math crate to write
//! market stats.
//!
//! Update-cadence rule: anything that refreshes on every market event
//! lives in `MarketStats`. Anything AMM-private (stale-tolerant —
//! reserves, peg, spread reserves) lives on `AMM`. See
//! `docs/amm-decoupling-and-maker-interface.md`.
//!
//! This file is intentionally empty — kept as the documented landing
//! place for matcher-fed market-stat plumbing (e.g. piping `QuoterFill`
//! aggregates into per-fill stat updates once the matcher owns fill
//! orchestration).
