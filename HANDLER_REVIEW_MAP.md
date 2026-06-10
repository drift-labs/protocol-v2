# Velocity entry-point review map — changed paths only

Filtered to entries whose handler body directly references at least one changed-vs-master file in `programs/velocity/src/`. Each touched file gets a one-line **why** explaining the kind of change (semantic vs field-rename, new module, etc.) so you know what to look for when reading.

Caveat: deps come from a body grep, so transitive call edges aren't shown. If a listed file is itself an orchestrator (`controller/orders.rs`, `controller/funding.rs`, etc.), reading it pulls in further changed deps covered by the **Subsystem cheat sheet** below.

## Subsystem cheat sheet (read these whole-file once before walking entries)

- **Quoter trait foundation** — `state/quoter.rs`, `amm/quoter.rs`. Setup → quote → commit lifecycle, slot-idempotent projection, `MarketEvent::FundingUpdated`.
- **AMM module tree** — `amm/{state,controller,refresh,admin}.rs`, `amm/math/{amm,cp_curve,jit,repeg,spread}.rs`. Was `controller/amm.rs` + `controller/repeg.rs` + `math/amm*.rs` on master.
- **PerpMarket field relocation** — `state/perp_market.rs`. Many scalars moved from `AMM` to top-level PerpMarket / `market_stats`. Most "field-rename" diffs across the codebase trace back here.
- **Orchestrators** — `controller/orders.rs` (massive rewrite), `controller/match.rs` (new), `controller/funding.rs`, `controller/liquidation.rs`, `controller/pnl.rs`.
- **Market-stats / perp-pool extractions** — `controller/market_stats.rs` (new), `controller/perp_pools.rs` (new).

## `programs/velocity/src/instructions/user.rs` (20 entries)

### `deposit` → `handle_deposit` (programs/velocity/src/instructions/user.rs:528)

- `programs/velocity/src/controller/spot_balance.rs` — removed stale `update_amm` cargo-cult calls from spot deposit/withdraw path
- `programs/velocity/src/controller/token.rs` — minor — velocity_signer plumbing aligned with PerpMarket relocation

### `withdraw` → `handle_withdraw` (programs/velocity/src/instructions/user.rs:729)

- `programs/velocity/src/controller/spot_balance.rs` — removed stale `update_amm` cargo-cult calls from spot deposit/withdraw path
- `programs/velocity/src/controller/token.rs` — minor — velocity_signer plumbing aligned with PerpMarket relocation

### `transfer_deposit` → `handle_transfer_deposit` (programs/velocity/src/instructions/user.rs:905)

- `programs/velocity/src/controller/spot_balance.rs` — removed stale `update_amm` cargo-cult calls from spot deposit/withdraw path

### `transfer_pools` → `handle_transfer_pools` (programs/velocity/src/instructions/user.rs:1128)

- `programs/velocity/src/controller/spot_balance.rs` — removed stale `update_amm` cargo-cult calls from spot deposit/withdraw path
- `programs/velocity/src/controller/token.rs` — minor — velocity_signer plumbing aligned with PerpMarket relocation

### `deposit_into_isolated_perp_position` → `handle_deposit_into_isolated_perp_position` (programs/velocity/src/instructions/user.rs:1949)

- `programs/velocity/src/controller/isolated_position.rs` — isolated position deposit/withdraw uses AmmQuoter::setup for refresh
- `programs/velocity/src/controller/token.rs` — minor — velocity_signer plumbing aligned with PerpMarket relocation

### `transfer_isolated_perp_position_deposit` → `handle_transfer_isolated_perp_position_deposit` (programs/velocity/src/instructions/user.rs:2024)

- `programs/velocity/src/controller/isolated_position.rs` — isolated position deposit/withdraw uses AmmQuoter::setup for refresh

### `withdraw_from_isolated_perp_position` → `handle_withdraw_from_isolated_perp_position` (programs/velocity/src/instructions/user.rs:2083)

- `programs/velocity/src/controller/isolated_position.rs` — isolated position deposit/withdraw uses AmmQuoter::setup for refresh
- `programs/velocity/src/controller/token.rs` — minor — velocity_signer plumbing aligned with PerpMarket relocation

### `place_perp_order` → `handle_place_perp_order` (programs/velocity/src/instructions/user.rs:2158)

- `programs/velocity/src/controller/orders.rs` — order fill orchestrator: rebuilt around AmmQuoter setup → match → on_market_event lifecycle (2,060-line diff)

### `cancel_order` → `handle_cancel_order` (programs/velocity/src/instructions/user.rs:2205)

- `programs/velocity/src/controller/orders.rs` — order fill orchestrator: rebuilt around AmmQuoter setup → match → on_market_event lifecycle (2,060-line diff)

### `cancel_order_by_user_id` → `handle_cancel_order_by_user_id` (programs/velocity/src/instructions/user.rs:2244)

- `programs/velocity/src/controller/orders.rs` — order fill orchestrator: rebuilt around AmmQuoter setup → match → on_market_event lifecycle (2,060-line diff)

### `cancel_orders_by_ids` → `handle_cancel_orders_by_ids` (programs/velocity/src/instructions/user.rs:2278)

- `programs/velocity/src/controller/orders.rs` — order fill orchestrator: rebuilt around AmmQuoter setup → match → on_market_event lifecycle (2,060-line diff)

### `modify_order` → `handle_modify_order` (programs/velocity/src/instructions/user.rs:2360)

- `programs/velocity/src/controller/orders.rs` — order fill orchestrator: rebuilt around AmmQuoter setup → match → on_market_event lifecycle (2,060-line diff)

### `modify_order_by_user_id` → `handle_modify_order_by_user_order_id` (programs/velocity/src/instructions/user.rs:2402)

- `programs/velocity/src/controller/orders.rs` — order fill orchestrator: rebuilt around AmmQuoter setup → match → on_market_event lifecycle (2,060-line diff)

### `place_and_take_perp_order` → `handle_place_and_take_perp_order` (programs/velocity/src/instructions/user.rs:2559)

- `programs/velocity/src/controller/orders.rs` — order fill orchestrator: rebuilt around AmmQuoter setup → match → on_market_event lifecycle (2,060-line diff)

### `place_and_make_perp_order` → `handle_place_and_make_perp_order` (programs/velocity/src/instructions/user.rs:2684)

- `programs/velocity/src/controller/orders.rs` — order fill orchestrator: rebuilt around AmmQuoter setup → match → on_market_event lifecycle (2,060-line diff)

### `place_and_make_signed_msg_perp_order` → `handle_place_and_make_signed_msg_perp_order` (programs/velocity/src/instructions/user.rs:2794)

- `programs/velocity/src/controller/orders.rs` — order fill orchestrator: rebuilt around AmmQuoter setup → match → on_market_event lifecycle (2,060-line diff)

### `begin_swap` → `handle_begin_swap` (programs/velocity/src/instructions/user.rs:3183)

- `programs/velocity/src/controller/spot_balance.rs` — removed stale `update_amm` cargo-cult calls from spot deposit/withdraw path
- `programs/velocity/src/controller/token.rs` — minor — velocity_signer plumbing aligned with PerpMarket relocation
- `programs/velocity/src/math/liquidation.rs` — liquidation math reads PerpMarket-level fields (field relocation)

### `end_swap` → `handle_end_swap` (programs/velocity/src/instructions/user.rs:3473)

- `programs/velocity/src/controller/token.rs` — minor — velocity_signer plumbing aligned with PerpMarket relocation

### `deposit_into_spot_market_revenue_pool` → `handle_deposit_into_spot_market_revenue_pool` (programs/velocity/src/instructions/user.rs:3101)

- `programs/velocity/src/controller/spot_balance.rs` — removed stale `update_amm` cargo-cult calls from spot deposit/withdraw path
- `programs/velocity/src/controller/token.rs` — minor — velocity_signer plumbing aligned with PerpMarket relocation

### `special_transfer_perp_position_to_vamm` → `handle_special_transfer_perp_position_to_vamm` (programs/velocity/src/instructions/user.rs:3858)

- `programs/velocity/src/amm/quoter.rs` — NEW: `AmmQuoter` implements `Quoter`/`QuoterCommit`. `setup` is slot-idempotent (skips projection if AMM already refreshed at ctx.slot); on_market_event(FundingUpdated) settles AMM PnL + runs eager k-update + emits `AmmCurveChanged`

## `programs/velocity/src/instructions/keeper.rs` (23 entries)

### `force_delete_user` → `handle_force_delete_user` (programs/velocity/src/instructions/keeper.rs:2845)

- `programs/velocity/src/controller/spot_balance.rs` — removed stale `update_amm` cargo-cult calls from spot deposit/withdraw path

### `trigger_order` → `handle_trigger_order` (programs/velocity/src/instructions/keeper.rs:221)

- `programs/velocity/src/controller/orders.rs` — order fill orchestrator: rebuilt around AmmQuoter setup → match → on_market_event lifecycle (2,060-line diff)

### `force_cancel_orders` → `handle_force_cancel_orders` (programs/velocity/src/instructions/keeper.rs:266)

- `programs/velocity/src/controller/orders.rs` — order fill orchestrator: rebuilt around AmmQuoter setup → match → on_market_event lifecycle (2,060-line diff)

### `settle_pnl` → `handle_settle_pnl` (programs/velocity/src/instructions/keeper.rs:872)

- `programs/velocity/src/controller/pnl.rs` — PnL settle reads top-level PerpMarket scalars (oracle, cum_funding_rate_long/short, fee fields moved off AMM)
- `programs/velocity/src/controller/revenue_share.rs` — revenue share fee accounting reads moved PerpMarket scalars

### `settle_multiple_pnls` → `handle_settle_multiple_pnls` (programs/velocity/src/instructions/keeper.rs:997)

- `programs/velocity/src/controller/pnl.rs` — PnL settle reads top-level PerpMarket scalars (oracle, cum_funding_rate_long/short, fee fields moved off AMM)
- `programs/velocity/src/controller/revenue_share.rs` — revenue share fee accounting reads moved PerpMarket scalars

### `settle_funding_payment` → `handle_settle_funding_payment` (programs/velocity/src/instructions/keeper.rs:1122)

- `programs/velocity/src/controller/funding.rs` — funding orchestrator: pre-refresh AMM (matches master `_update_amm`), then consolidated AmmQuoter spans setup → math → on_market_event(FundingUpdated)

### `liquidate_perp` → `handle_liquidate_perp` (programs/velocity/src/instructions/keeper.rs:1149)

- `programs/velocity/src/controller/liquidation.rs` — liquidation: AMM participation goes through AmmQuoter; reads top-level PerpMarket fields

### `liquidate_perp_with_fill` → `handle_liquidate_perp_with_fill` (programs/velocity/src/instructions/keeper.rs:1209)

- `programs/velocity/src/controller/liquidation.rs` — liquidation: AMM participation goes through AmmQuoter; reads top-level PerpMarket fields

### `liquidate_spot` → `handle_liquidate_spot` (programs/velocity/src/instructions/keeper.rs:1263)

- `programs/velocity/src/controller/liquidation.rs` — liquidation: AMM participation goes through AmmQuoter; reads top-level PerpMarket fields

### `liquidate_spot_with_swap_begin` → `handle_liquidate_spot_with_swap_begin` (programs/velocity/src/instructions/keeper.rs:1324)

- `programs/velocity/src/controller/spot_balance.rs` — removed stale `update_amm` cargo-cult calls from spot deposit/withdraw path
- `programs/velocity/src/controller/token.rs` — minor — velocity_signer plumbing aligned with PerpMarket relocation

### `liquidate_spot_with_swap_end` → `handle_liquidate_spot_with_swap_end` (programs/velocity/src/instructions/keeper.rs:1609)

- `programs/velocity/src/controller/token.rs` — minor — velocity_signer plumbing aligned with PerpMarket relocation

### `liquidate_borrow_for_perp_pnl` → `handle_liquidate_borrow_for_perp_pnl` (programs/velocity/src/instructions/keeper.rs:1789)

- `programs/velocity/src/controller/liquidation.rs` — liquidation: AMM participation goes through AmmQuoter; reads top-level PerpMarket fields

### `liquidate_perp_pnl_for_deposit` → `handle_liquidate_perp_pnl_for_deposit` (programs/velocity/src/instructions/keeper.rs:1848)

- `programs/velocity/src/controller/liquidation.rs` — liquidation: AMM participation goes through AmmQuoter; reads top-level PerpMarket fields

### `set_user_status_to_being_liquidated` → `handle_set_user_status_to_being_liquidated` (programs/velocity/src/instructions/keeper.rs:1907)

- `programs/velocity/src/controller/liquidation.rs` — liquidation: AMM participation goes through AmmQuoter; reads top-level PerpMarket fields

### `resolve_perp_pnl_deficit` → `handle_resolve_perp_pnl_deficit` (programs/velocity/src/instructions/keeper.rs:1941)

- `programs/velocity/src/controller/insurance.rs` — insurance fund accounting reads moved fields (e.g. total_liquidation_fee, total_exchange_fee on PerpMarket)
- `programs/velocity/src/controller/orders.rs` — order fill orchestrator: rebuilt around AmmQuoter setup → match → on_market_event lifecycle (2,060-line diff)
- `programs/velocity/src/controller/token.rs` — minor — velocity_signer plumbing aligned with PerpMarket relocation

### `resolve_perp_bankruptcy` → `handle_resolve_perp_bankruptcy` (programs/velocity/src/instructions/keeper.rs:2086)

- `programs/velocity/src/controller/insurance.rs` — insurance fund accounting reads moved fields (e.g. total_liquidation_fee, total_exchange_fee on PerpMarket)
- `programs/velocity/src/controller/liquidation.rs` — liquidation: AMM participation goes through AmmQuoter; reads top-level PerpMarket fields
- `programs/velocity/src/controller/token.rs` — minor — velocity_signer plumbing aligned with PerpMarket relocation

### `resolve_spot_bankruptcy` → `handle_resolve_spot_bankruptcy` (programs/velocity/src/instructions/keeper.rs:2219)

- `programs/velocity/src/controller/insurance.rs` — insurance fund accounting reads moved fields (e.g. total_liquidation_fee, total_exchange_fee on PerpMarket)
- `programs/velocity/src/controller/liquidation.rs` — liquidation: AMM participation goes through AmmQuoter; reads top-level PerpMarket fields
- `programs/velocity/src/controller/token.rs` — minor — velocity_signer plumbing aligned with PerpMarket relocation

### `settle_revenue_to_insurance_fund` → `handle_settle_revenue_to_insurance_fund` (programs/velocity/src/instructions/keeper.rs:2578)

- `programs/velocity/src/controller/insurance.rs` — insurance fund accounting reads moved fields (e.g. total_liquidation_fee, total_exchange_fee on PerpMarket)
- `programs/velocity/src/controller/token.rs` — minor — velocity_signer plumbing aligned with PerpMarket relocation

### `update_funding_rate` → `handle_update_funding_rate` (programs/velocity/src/instructions/keeper.rs:2339)

- `programs/velocity/src/amm/refresh.rs` — NEW: AMM refresh path (was `controller/repeg.rs`) — `snap_to_oracle`, `project_post_refresh*`, `compute_amm_refresh_validity*`
- `programs/velocity/src/controller/funding.rs` — funding orchestrator: pre-refresh AMM (matches master `_update_amm`), then consolidated AmmQuoter spans setup → math → on_market_event(FundingUpdated)

### `update_perp_bid_ask_twap` → `handle_update_perp_bid_ask_twap` (programs/velocity/src/instructions/keeper.rs:2434)

- `programs/velocity/src/amm/math/spread.rs` — spread math (relocated from math/amm_spread.rs); `compute_amm_quote_state`
- `programs/velocity/src/amm/refresh.rs` — NEW: AMM refresh path (was `controller/repeg.rs`) — `snap_to_oracle`, `project_post_refresh*`, `compute_amm_refresh_validity*`
- `programs/velocity/src/controller/funding.rs` — funding orchestrator: pre-refresh AMM (matches master `_update_amm`), then consolidated AmmQuoter spans setup → math → on_market_event(FundingUpdated)
- `programs/velocity/src/state/perp_market.rs` — PerpMarket struct: many fields moved up from AMM (oracle, oracle_source, cum_funding_rate_long/short, total_exchange_fee, total_liquidation_fee, base_asset_amount_long/short, market_stats, etc.); `next_curve_record_id` removed; padding bumped

### `update_spot_market_cumulative_interest` → `handle_update_spot_market_cumulative_interest` (programs/velocity/src/instructions/keeper.rs:2660)

- `programs/velocity/src/controller/spot_balance.rs` — removed stale `update_amm` cargo-cult calls from spot deposit/withdraw path

### `update_amms` → `handle_update_amms` (programs/velocity/src/instructions/keeper.rs:2703)

- `programs/velocity/src/amm/refresh.rs` — NEW: AMM refresh path (was `controller/repeg.rs`) — `snap_to_oracle`, `project_post_refresh*`, `compute_amm_refresh_validity*`

### `settle_perp_to_lp_pool` → `handle_settle_perp_to_lp_pool` (programs/velocity/src/instructions/keeper.rs:3074)

- `programs/velocity/src/controller/spot_balance.rs` — removed stale `update_amm` cargo-cult calls from spot deposit/withdraw path

## `programs/velocity/src/instructions/admin.rs` (8 entries)

### `settle_expired_market` → `handle_settle_expired_market` (programs/velocity/src/instructions/admin.rs:2956)

- `programs/velocity/src/amm/refresh.rs` — NEW: AMM refresh path (was `controller/repeg.rs`) — `snap_to_oracle`, `project_post_refresh*`, `compute_amm_refresh_validity*`

### `update_delegate_user_gov_token_insurance_stake` → `handle_update_delegate_user_gov_token_insurance_stake` (programs/velocity/src/instructions/admin.rs:3305)

- `programs/velocity/src/controller/insurance.rs` — insurance fund accounting reads moved fields (e.g. total_liquidation_fee, total_exchange_fee on PerpMarket)

### `initialize_perp_market` → `handle_initialize_perp_market` (programs/velocity/src/instructions/admin.rs:418)

- `programs/velocity/src/amm/math/spread.rs` — spread math (relocated from math/amm_spread.rs); `compute_amm_quote_state`
- `programs/velocity/src/validation/perp_market.rs` — PerpMarket validation: 247-line diff — many invariants moved with relocated fields

### `settle_expired_market_pools_to_revenue_pool` → `handle_settle_expired_market_pools_to_revenue_pool` (programs/velocity/src/instructions/admin.rs:1067)

- `programs/velocity/src/amm/math/amm.rs` — AMM math (relocated from math/amm.rs)
- `programs/velocity/src/amm/quoter.rs` — NEW: `AmmQuoter` implements `Quoter`/`QuoterCommit`. `setup` is slot-idempotent (skips projection if AMM already refreshed at ctx.slot); on_market_event(FundingUpdated) settles AMM PnL + runs eager k-update + emits `AmmCurveChanged`
- `programs/velocity/src/controller/spot_balance.rs` — removed stale `update_amm` cargo-cult calls from spot deposit/withdraw path

### `update_perp_market_pnl_pool` → `handle_update_perp_market_pnl_pool` (programs/velocity/src/instructions/admin.rs:1187)

- `programs/velocity/src/controller/spot_balance.rs` — removed stale `update_amm` cargo-cult calls from spot deposit/withdraw path

### `deposit_into_spot_market_vault` → `handle_deposit_into_spot_market_vault` (programs/velocity/src/instructions/admin.rs:1218)

- `programs/velocity/src/controller/token.rs` — minor — velocity_signer plumbing aligned with PerpMarket relocation

### `update_perp_market_max_imbalances` → `handle_update_perp_market_max_imbalances` (programs/velocity/src/instructions/admin.rs:1371)

- `programs/velocity/src/validation/perp_market.rs` — PerpMarket validation: 247-line diff — many invariants moved with relocated fields

### `admin_deposit` → `handle_admin_deposit` (programs/velocity/src/instructions/admin.rs:3016)

- `programs/velocity/src/controller/spot_balance.rs` — removed stale `update_amm` cargo-cult calls from spot deposit/withdraw path
- `programs/velocity/src/controller/token.rs` — minor — velocity_signer plumbing aligned with PerpMarket relocation

## `programs/velocity/src/amm/admin.rs` (8 entries)

### `update_perp_market_amm_summary_stats` → `handle_update_perp_market_amm_summary_stats` (programs/velocity/src/amm/admin.rs:321)

- `programs/velocity/src/amm/controller.rs` — NEW: AMM controller (was `controller/amm.rs` on master) — `formulaic_update_k` test helper, fee_pool helpers

### `deposit_into_perp_market_fee_pool` → `handle_deposit_into_perp_market_fee_pool` (programs/velocity/src/amm/admin.rs:402)

- `programs/velocity/src/amm/quoter.rs` — NEW: `AmmQuoter` implements `Quoter`/`QuoterCommit`. `setup` is slot-idempotent (skips projection if AMM already refreshed at ctx.slot); on_market_event(FundingUpdated) settles AMM PnL + runs eager k-update + emits `AmmCurveChanged`
- `programs/velocity/src/controller/spot_balance.rs` — removed stale `update_amm` cargo-cult calls from spot deposit/withdraw path
- `programs/velocity/src/controller/token.rs` — minor — velocity_signer plumbing aligned with PerpMarket relocation

### `repeg_amm_curve` → `handle_repeg_amm_curve` (programs/velocity/src/amm/admin.rs:469)

- `programs/velocity/src/amm/refresh.rs` — NEW: AMM refresh path (was `controller/repeg.rs`) — `snap_to_oracle`, `project_post_refresh*`, `compute_amm_refresh_validity*`
- `programs/velocity/src/state/events.rs` — events: `CurveRecord` removed, `AmmCurveChanged` added; `FundingRateRecord` dropped `period_revenue`

### `update_k` → `handle_update_k` (programs/velocity/src/amm/admin.rs:661)

- `programs/velocity/src/amm/math/amm.rs` — AMM math (relocated from math/amm.rs)
- `programs/velocity/src/amm/math/cp_curve.rs` — constant-product curve math (relocated from math/cp_curve.rs)
- `programs/velocity/src/state/events.rs` — events: `CurveRecord` removed, `AmmCurveChanged` added; `FundingRateRecord` dropped `period_revenue`

### `update_perp_market_reference_price_offset_deadband_pct` → `handle_update_perp_market_reference_price_offset_deadband_pct` (programs/velocity/src/amm/admin.rs:905)

- `programs/velocity/src/amm/math/spread.rs` — spread math (relocated from math/amm_spread.rs); `compute_amm_quote_state`

### `update_perp_market_base_spread` → `handle_update_perp_market_base_spread` (programs/velocity/src/amm/admin.rs:948)

- `programs/velocity/src/amm/math/spread.rs` — spread math (relocated from math/amm_spread.rs); `compute_amm_quote_state`

### `update_perp_market_amm_spread_adjustment` → `handle_update_perp_market_amm_spread_adjustment` (programs/velocity/src/amm/admin.rs:1072)

- `programs/velocity/src/amm/math/spread.rs` — spread math (relocated from math/amm_spread.rs); `compute_amm_quote_state`

### `transfer_fee_and_pnl_pool` → `handle_transfer_fee_and_pnl_pool` (programs/velocity/src/amm/admin.rs:1137)

- `programs/velocity/src/controller/spot_balance.rs` — removed stale `update_amm` cargo-cult calls from spot deposit/withdraw path

## `programs/velocity/src/instructions/lp_pool.rs` (2 entries)

### `deposit_to_program_vault` → `handle_deposit_to_program_vault` (programs/velocity/src/instructions/lp_pool.rs:1404)

- `programs/velocity/src/controller/spot_balance.rs` — removed stale `update_amm` cargo-cult calls from spot deposit/withdraw path
- `programs/velocity/src/controller/token.rs` — minor — velocity_signer plumbing aligned with PerpMarket relocation

### `withdraw_from_program_vault` → `handle_withdraw_from_program_vault` (programs/velocity/src/instructions/lp_pool.rs:1534)

- `programs/velocity/src/controller/spot_balance.rs` — removed stale `update_amm` cargo-cult calls from spot deposit/withdraw path

## `programs/velocity/src/instructions/lp_admin.rs` (1 entries)

### `end_lp_swap` → `handle_end_lp_swap` (programs/velocity/src/instructions/lp_admin.rs:813)

- `programs/velocity/src/controller/token.rs` — minor — velocity_signer plumbing aligned with PerpMarket relocation

## `programs/velocity/src/instructions/if_staker.rs` (9 entries)

### `add_insurance_fund_stake` → `handle_add_insurance_fund_stake` (programs/velocity/src/instructions/if_staker.rs:60)

- `programs/velocity/src/controller/insurance.rs` — insurance fund accounting reads moved fields (e.g. total_liquidation_fee, total_exchange_fee on PerpMarket)
- `programs/velocity/src/controller/token.rs` — minor — velocity_signer plumbing aligned with PerpMarket relocation

### `request_remove_insurance_fund_stake` → `handle_request_remove_insurance_fund_stake` (programs/velocity/src/instructions/if_staker.rs:168)

- `programs/velocity/src/controller/insurance.rs` — insurance fund accounting reads moved fields (e.g. total_liquidation_fee, total_exchange_fee on PerpMarket)

### `cancel_request_remove_insurance_fund_stake` → `handle_cancel_request_remove_insurance_fund_stake` (programs/velocity/src/instructions/if_staker.rs:223)

- `programs/velocity/src/controller/insurance.rs` — insurance fund accounting reads moved fields (e.g. total_liquidation_fee, total_exchange_fee on PerpMarket)

### `remove_insurance_fund_stake` → `handle_remove_insurance_fund_stake` (programs/velocity/src/instructions/if_staker.rs:259)

- `programs/velocity/src/controller/insurance.rs` — insurance fund accounting reads moved fields (e.g. total_liquidation_fee, total_exchange_fee on PerpMarket)
- `programs/velocity/src/controller/token.rs` — minor — velocity_signer plumbing aligned with PerpMarket relocation

### `begin_insurance_fund_swap` → `handle_begin_insurance_fund_swap` (programs/velocity/src/instructions/if_staker.rs:369)

- `programs/velocity/src/controller/insurance.rs` — insurance fund accounting reads moved fields (e.g. total_liquidation_fee, total_exchange_fee on PerpMarket)
- `programs/velocity/src/controller/token.rs` — minor — velocity_signer plumbing aligned with PerpMarket relocation

### `end_insurance_fund_swap` → `handle_end_insurance_fund_swap` (programs/velocity/src/instructions/if_staker.rs:599)

- `programs/velocity/src/controller/insurance.rs` — insurance fund accounting reads moved fields (e.g. total_liquidation_fee, total_exchange_fee on PerpMarket)
- `programs/velocity/src/controller/token.rs` — minor — velocity_signer plumbing aligned with PerpMarket relocation

### `transfer_protocol_if_shares_to_revenue_pool` → `handle_transfer_protocol_if_shares_to_revenue_pool` (programs/velocity/src/instructions/if_staker.rs:767)

- `programs/velocity/src/controller/insurance.rs` — insurance fund accounting reads moved fields (e.g. total_liquidation_fee, total_exchange_fee on PerpMarket)
- `programs/velocity/src/controller/token.rs` — minor — velocity_signer plumbing aligned with PerpMarket relocation

### `admin_withdraw_from_insurance_fund_vault` → `handle_admin_withdraw_from_insurance_fund_vault` (programs/velocity/src/instructions/if_staker.rs:1243)

- `programs/velocity/src/controller/insurance.rs` — insurance fund accounting reads moved fields (e.g. total_liquidation_fee, total_exchange_fee on PerpMarket)
- `programs/velocity/src/controller/token.rs` — minor — velocity_signer plumbing aligned with PerpMarket relocation
- `programs/velocity/src/state/events.rs` — events: `CurveRecord` removed, `AmmCurveChanged` added; `FundingRateRecord` dropped `period_revenue`

### `deposit_into_insurance_fund_stake` → `handle_deposit_into_insurance_fund_stake` (programs/velocity/src/instructions/if_staker.rs:827)

- `programs/velocity/src/controller/insurance.rs` — insurance fund accounting reads moved fields (e.g. total_liquidation_fee, total_exchange_fee on PerpMarket)
- `programs/velocity/src/controller/token.rs` — minor — velocity_signer plumbing aligned with PerpMarket relocation

---

**Coverage**: 71 of 227 lib.rs entries touch at least one changed file. The remainder are pure-passthrough handlers (trivial-init / read-only) where the handler body has no direct reference to a changed file. They're not included here, but the handler file itself may still contain rename-only diffs — skim with `git diff master -- programs/velocity/src/instructions/<file>.rs`.
