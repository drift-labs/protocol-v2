//! Test-only helpers to migrate base64-encoded `PerpMarket` snapshots from the
//! pre-AMM-decoupling layout to the current layout.
//!
//! Background: a refactor moved ~28 fields out of `AMM` into the top-level
//! `PerpMarket`, and introduced a new `MarketStats` struct at the tail of
//! `PerpMarket` (oracle TWAPs, mark/oracle std, volume, mm-oracle, etc.).
//! Existing tests embed base64 blobs captured under the old layout; this
//! module reads those blobs as `LegacyPerpMarket`, copies every field to the
//! correct new location, and re-encodes the resulting current-`PerpMarket`
//! as base64 — yielding a drop-in replacement for the snapshot string.
//!
//! The `LegacyAmm` and `LegacyPerpMarket` field definitions mirror
//! `git show HEAD:programs/velocity/src/state/perp_market.rs` exactly (the
//! committed pre-refactor layout the snapshots were generated against).
#![allow(dead_code)]
#![cfg(test)]
use crate::state::market_status::MarketStatus;
use crate::state::oracle::{HistoricalIndexData, HistoricalOracleData, OracleSource};
use crate::state::perp_market::{InsuranceClaim, MarketStats, PerpMarket, PoolBalance, AMM};
use crate::state::spot_market::{AssetTier, InsuranceFund, SpotMarket};
use crate::state::traits::Size;
use anchor_lang::prelude::Pubkey;

// ---- Legacy AMM (pre-decoupling) layout ----------------------------------
//
// The struct below mirrors the AMM struct as committed at HEAD (the layout
// the snapshots were serialized under). Every field, in order, with the
// exact same `repr(C)` semantics. Do not reorder.
//
// `packed(8)` caps each field's alignment at 8 bytes — matching the SBF
// target where the snapshots were generated (on SBF `align_of::<u128>() ==
// 8`, but on x86_64 with Rust ≥ 1.77 it's 16). Without this cap, x86_64
// `sizeof::<LegacyAmm>()` is 880 vs the on-chain 704.
#[repr(C, packed(8))]
#[derive(Clone, Copy)]
pub struct LegacyAmm {
    pub oracle: Pubkey,
    pub historical_oracle_data: HistoricalOracleData,
    pub fee_pool: PoolBalance,
    pub base_asset_reserve: u128,
    pub quote_asset_reserve: u128,
    pub concentration_coef: u128,
    pub min_base_asset_reserve: u128,
    pub max_base_asset_reserve: u128,
    pub sqrt_k: u128,
    pub peg_multiplier: u128,
    pub terminal_quote_asset_reserve: u128,
    pub base_asset_amount_long: i128,
    pub base_asset_amount_short: i128,
    pub base_asset_amount_with_amm: i128,
    pub max_open_interest: u128,
    pub quote_asset_amount: i128,
    pub quote_entry_amount_long: i128,
    pub quote_entry_amount_short: i128,
    pub quote_break_even_amount_long: i128,
    pub quote_break_even_amount_short: i128,
    pub last_funding_rate: i64,
    pub last_funding_rate_long: i64,
    pub last_funding_rate_short: i64,
    pub last_24h_avg_funding_rate: i64,
    pub total_fee: i128,
    pub total_mm_fee: i128,
    pub total_exchange_fee: u128,
    pub total_fee_minus_distributions: i128,
    pub total_fee_withdrawn: u128,
    pub total_liquidation_fee: u128,
    pub cumulative_funding_rate_long: i128,
    pub cumulative_funding_rate_short: i128,
    pub total_social_loss: u128,
    pub ask_base_asset_reserve: u128,
    pub ask_quote_asset_reserve: u128,
    pub bid_base_asset_reserve: u128,
    pub bid_quote_asset_reserve: u128,
    pub last_oracle_normalised_price: i64,
    pub last_oracle_reserve_price_spread_pct: i64,
    pub last_bid_price_twap: u64,
    pub last_ask_price_twap: u64,
    pub last_mark_price_twap: u64,
    pub last_mark_price_twap_5min: u64,
    pub last_update_slot: u64,
    pub last_oracle_conf_pct: u64,
    pub net_revenue_since_last_funding: i64,
    pub last_funding_rate_ts: i64,
    pub funding_period: i64,
    pub order_step_size: u64,
    pub order_tick_size: u64,
    pub min_order_size: u64,
    pub mm_oracle_slot: u64,
    pub volume_24h: u64,
    pub long_intensity_volume: u64,
    pub short_intensity_volume: u64,
    pub last_trade_ts: i64,
    pub mark_std: u64,
    pub oracle_std: u64,
    pub last_mark_price_twap_ts: i64,
    pub base_spread: u32,
    pub max_spread: u32,
    pub long_spread: u32,
    pub short_spread: u32,
    pub mm_oracle_price: i64,
    pub max_fill_reserve_fraction: u16,
    pub max_slippage_ratio: u16,
    pub curve_update_intensity: u8,
    pub amm_jit_intensity: u8,
    pub oracle_source: u8, // OracleSource is repr(u8)
    pub last_oracle_valid: bool,
    pub oracle_low_risk_slot_delay_override: i8,
    pub amm_spread_adjustment: i8,
    pub oracle_slot_delay_override: i8,
    pub padding_pre_mm_oracle_sequence: [u8; 5],
    pub mm_oracle_sequence_id: u64,
    pub net_unsettled_funding_pnl: i64,
    pub reference_price_offset: i32,
    pub amm_inventory_spread_adjustment: i8,
    pub reference_price_offset_deadband_pct: u8,
    pub padding_pre_last_funding: [u8; 2],
    pub last_funding_oracle_twap: i64,
    pub padding_trailing: [u8; 8],
}

/// Legacy PerpMarket layout (pre-decoupling). Mirrors `git show
/// HEAD:programs/velocity/src/state/perp_market.rs` field order.
///
/// See `LegacyAmm` for why `packed(8)` is needed.
#[repr(C, packed(8))]
#[derive(Clone, Copy)]
pub struct LegacyPerpMarket {
    pub pubkey: Pubkey,
    pub amm: LegacyAmm,
    pub pnl_pool: PoolBalance,
    pub name: [u8; 32],
    pub insurance_claim: InsuranceClaim,
    pub unrealized_pnl_max_imbalance: u64,
    pub expiry_ts: i64,
    pub expiry_price: i64,
    pub next_fill_record_id: u64,
    pub next_funding_rate_record_id: u64,
    pub next_curve_record_id: u64,
    pub imf_factor: u32,
    pub unrealized_pnl_imf_factor: u32,
    pub liquidator_fee: u32,
    pub if_liquidation_fee: u32,
    pub margin_ratio_initial: u32,
    pub margin_ratio_maintenance: u32,
    pub unrealized_pnl_initial_asset_weight: u32,
    pub unrealized_pnl_maintenance_asset_weight: u32,
    pub number_of_users_with_base: u32,
    pub number_of_users: u32,
    pub market_index: u16,
    pub status: u8, // MarketStatus is repr(u8)
    pub contract_type: u8,
    pub contract_tier: u8,
    pub paused_operations: u8,
    pub quote_spot_market_index: u16,
    pub fee_adjustment: i16,
    pub last_fill_price: u64,
    pub pool_id: u8,
    pub _padding_pmm: [u8; 2],
    pub lp_fee_transfer_scalar: u8,
    pub lp_status: u8,
    pub lp_paused_operations: u8,
    pub lp_exchange_fee_excluscion_scalar: u8,
    pub lp_pool_id: u8,
    pub market_config: u8,
    pub padding: [u8; 30],
}

/// Decode a base64 snapshot of a pre-decoupling PerpMarket, translate it
/// into the current PerpMarket layout, and re-encode as base64 (with the
/// original 8-byte Anchor discriminator preserved).
pub fn regenerate_perp_market_snapshot(old_b64: &str) -> String {
    let decoded = base64::decode(old_b64.trim()).expect("snapshot is valid base64");

    let disc_len = 8;
    let legacy_size = std::mem::size_of::<LegacyPerpMarket>();
    assert!(
        decoded.len() >= disc_len + legacy_size,
        "snapshot too short: got {} bytes, expected at least {} + {} ({}) — \
         double-check LegacyAmm field order against git show HEAD:.../perp_market.rs",
        decoded.len(),
        disc_len,
        legacy_size,
        disc_len + legacy_size,
    );

    // Read the legacy struct out of the byte buffer at byte offset 8 (after
    // the Anchor discriminator). The buffer may not be 16-aligned, so use an
    // unaligned read into a local owned by this function.
    let legacy: LegacyPerpMarket = unsafe {
        std::ptr::read_unaligned(decoded[disc_len..].as_ptr() as *const LegacyPerpMarket)
    };

    // ---- Translate to the current PerpMarket layout --------------------
    let mut pm = PerpMarket::default();

    // Top-level scalars that didn't move.
    pm.pubkey = legacy.pubkey;
    pm.pnl_pool = legacy.pnl_pool;
    pm.name = legacy.name;
    pm.insurance_claim = legacy.insurance_claim;
    pm.unrealized_pnl_max_imbalance = legacy.unrealized_pnl_max_imbalance;
    pm.expiry_ts = legacy.expiry_ts;
    pm.expiry_price = legacy.expiry_price;
    pm.next_fill_record_id = legacy.next_fill_record_id;
    pm.next_funding_rate_record_id = legacy.next_funding_rate_record_id;
    // legacy.next_curve_record_id is intentionally dropped — the auto-increment
    // ID was removed alongside the `CurveRecord` event.
    pm.imf_factor = legacy.imf_factor;
    pm.unrealized_pnl_imf_factor = legacy.unrealized_pnl_imf_factor;
    pm.liquidator_fee = legacy.liquidator_fee;
    pm.if_liquidation_fee = legacy.if_liquidation_fee;
    pm.margin_ratio_initial = legacy.margin_ratio_initial;
    pm.margin_ratio_maintenance = legacy.margin_ratio_maintenance;
    pm.unrealized_pnl_initial_asset_weight = legacy.unrealized_pnl_initial_asset_weight;
    pm.unrealized_pnl_maintenance_asset_weight = legacy.unrealized_pnl_maintenance_asset_weight;
    pm.number_of_users_with_base = legacy.number_of_users_with_base;
    pm.number_of_users = legacy.number_of_users;
    pm.market_index = legacy.market_index;
    // SAFETY: legacy.status was read from a serialized MarketStatus byte that
    // a real protocol writer produced; the same is true for contract_type /
    // contract_tier / oracle_source. Transmute is sound for these
    // repr(u8) enums (and OracleSource is the same in both layouts).
    pm.status = unsafe { std::mem::transmute::<u8, MarketStatus>(legacy.status) };
    pm.contract_type = unsafe {
        std::mem::transmute::<u8, crate::state::perp_market::ContractType>(legacy.contract_type)
    };
    pm.contract_tier = unsafe {
        std::mem::transmute::<u8, crate::state::perp_market::ContractTier>(legacy.contract_tier)
    };
    pm.paused_operations = legacy.paused_operations;
    pm.quote_spot_market_index = legacy.quote_spot_market_index;
    pm.fee_adjustment = legacy.fee_adjustment;
    pm.last_fill_price = legacy.last_fill_price;
    pm.pool_id = legacy.pool_id;
    pm._padding_pmm = legacy._padding_pmm;
    pm.hedge_config.fee_transfer_scalar = legacy.lp_fee_transfer_scalar;
    pm.hedge_config.status = legacy.lp_status;
    pm.hedge_config.paused_operations = legacy.lp_paused_operations;
    pm.hedge_config.exchange_fee_exclusion_scalar = legacy.lp_exchange_fee_excluscion_scalar;
    pm.hedge_config.pool_id = legacy.lp_pool_id;
    pm.market_config = legacy.market_config;

    // ---- AMM fields that didn't move stay on AMM. ------------------
    let la = &legacy.amm;
    let mut amm = AMM::default();
    amm.fee_pool = la.fee_pool;
    amm.base_asset_reserve = la.base_asset_reserve;
    amm.quote_asset_reserve = la.quote_asset_reserve;
    amm.concentration_coef = la.concentration_coef;
    amm.min_base_asset_reserve = la.min_base_asset_reserve;
    amm.max_base_asset_reserve = la.max_base_asset_reserve;
    amm.sqrt_k = la.sqrt_k;
    amm.peg_multiplier = la.peg_multiplier;
    amm.terminal_quote_asset_reserve = la.terminal_quote_asset_reserve;
    amm.base_asset_amount_with_amm = la.base_asset_amount_with_amm;
    amm.total_fee = la.total_fee;
    amm.total_mm_fee = la.total_mm_fee;
    amm.total_fee_minus_distributions = la.total_fee_minus_distributions;
    amm.total_fee_withdrawn = la.total_fee_withdrawn;
    // The cached spread state stays on AMM (same fields as the legacy
    // layout). `last_spread_update_slot` has no legacy counterpart; seed it
    // from `last_update_slot` so a freshly-migrated account reports the
    // cache as refreshed at the same slot the curve was.
    amm.ask_base_asset_reserve = la.ask_base_asset_reserve;
    amm.ask_quote_asset_reserve = la.ask_quote_asset_reserve;
    amm.bid_base_asset_reserve = la.bid_base_asset_reserve;
    amm.bid_quote_asset_reserve = la.bid_quote_asset_reserve;
    amm.last_oracle_reserve_price_spread_pct = la.last_oracle_reserve_price_spread_pct;
    amm.long_spread = la.long_spread;
    amm.short_spread = la.short_spread;
    amm.reference_price_offset = la.reference_price_offset;
    amm.last_spread_update_slot = la.last_update_slot;
    amm.last_update_slot = la.last_update_slot;
    amm.net_revenue_since_last_funding = la.net_revenue_since_last_funding;
    amm.base_spread = la.base_spread;
    amm.max_spread = la.max_spread;
    amm.max_fill_reserve_fraction = la.max_fill_reserve_fraction;
    amm.max_slippage_ratio = la.max_slippage_ratio;
    amm.curve_update_intensity = la.curve_update_intensity;
    amm.amm_jit_intensity = la.amm_jit_intensity;
    amm.amm_spread_adjustment = la.amm_spread_adjustment;
    amm.amm_inventory_spread_adjustment = la.amm_inventory_spread_adjustment;
    amm.reference_price_offset_deadband_pct = la.reference_price_offset_deadband_pct;
    pm.amm = amm;

    // ---- AMM → PerpMarket field moves ---------------------------------
    pm.base_asset_amount_long = la.base_asset_amount_long;
    pm.base_asset_amount_short = la.base_asset_amount_short;
    pm.quote_asset_amount = la.quote_asset_amount;
    pm.quote_entry_amount_long = la.quote_entry_amount_long;
    pm.quote_entry_amount_short = la.quote_entry_amount_short;
    pm.quote_break_even_amount_long = la.quote_break_even_amount_long;
    pm.quote_break_even_amount_short = la.quote_break_even_amount_short;
    pm.max_open_interest = la.max_open_interest;
    pm.total_social_loss = la.total_social_loss;
    pm.cumulative_funding_rate_long = la.cumulative_funding_rate_long;
    pm.cumulative_funding_rate_short = la.cumulative_funding_rate_short;
    pm.fee_ledger.total_exchange_fee = la.total_exchange_fee;
    pm.fee_ledger.total_liquidation_fee = la.total_liquidation_fee;
    pm.oracle = la.oracle;
    pm.last_funding_rate = la.last_funding_rate;
    pm.last_funding_rate_long = la.last_funding_rate_long;
    pm.last_funding_rate_short = la.last_funding_rate_short;
    pm.last_funding_rate_ts = la.last_funding_rate_ts;
    pm.net_unsettled_funding_pnl = la.net_unsettled_funding_pnl;
    pm.order_step_size = la.order_step_size;
    pm.order_tick_size = la.order_tick_size;
    pm.oracle_source = unsafe { std::mem::transmute::<u8, OracleSource>(la.oracle_source) };
    pm.oracle_slot_delay_override = la.oracle_slot_delay_override;
    pm.oracle_low_risk_slot_delay_override = la.oracle_low_risk_slot_delay_override;

    // ---- AMM → MarketStats field moves --------------------------------
    pm.market_stats = MarketStats {
        funding_period: la.funding_period,
        last_24h_avg_funding_rate: la.last_24h_avg_funding_rate,
        min_order_size: la.min_order_size,
        last_mark_price_twap: la.last_mark_price_twap,
        last_mark_price_twap_5min: la.last_mark_price_twap_5min,
        last_mark_price_twap_ts: la.last_mark_price_twap_ts,
        last_bid_price_twap: la.last_bid_price_twap,
        last_ask_price_twap: la.last_ask_price_twap,
        mark_std: la.mark_std,
        oracle_std: la.oracle_std,
        last_oracle_conf_pct: la.last_oracle_conf_pct,
        volume_24h: la.volume_24h,
        long_intensity_volume: la.long_intensity_volume,
        short_intensity_volume: la.short_intensity_volume,
        last_trade_ts: la.last_trade_ts,
        mm_oracle_price: la.mm_oracle_price,
        mm_oracle_slot: la.mm_oracle_slot,
        mm_oracle_sequence_id: la.mm_oracle_sequence_id,
        last_oracle_normalised_price: la.last_oracle_normalised_price,
        last_reference_price_offset: la.reference_price_offset,
        last_oracle_valid: la.last_oracle_valid,
        padding: [0; 3],
        last_funding_oracle_twap: la.last_funding_oracle_twap,
        historical_oracle_data: la.historical_oracle_data,
    };

    // ---- Re-encode (discriminator + struct bytes) ---------------------
    let mut out_bytes = Vec::with_capacity(disc_len + std::mem::size_of::<PerpMarket>());
    out_bytes.extend_from_slice(&decoded[..disc_len]);
    let pm_bytes: &[u8] = unsafe {
        std::slice::from_raw_parts(
            &pm as *const PerpMarket as *const u8,
            std::mem::size_of::<PerpMarket>(),
        )
    };
    out_bytes.extend_from_slice(pm_bytes);

    base64::encode(&out_bytes)
}

// ============================================================================
// Even-older "1216" layout (SIZE 1216, content 1208).
//
// Some inline snapshots (the repeg `adjust_amm_with_market_config_flag_*`
// tests) were captured one refactor earlier than the `.b64` files above: the
// AMM still carried the LP fields (`*_per_lp`, `user_lp_shares`,
// `target_base_asset_amount_per_lp`, `per_lp_base`,
// `quote_asset_amount_with_unsettled_lp`, `base_asset_amount_with_unsettled_lp`)
// and the `PerpMarket` carried `next_curve_record_id`, the `fuel_boost_*`
// bytes, `padding_former_hlm`, and the `protected_maker_*` divisors that the
// velocity fork later removed. The field definitions below mirror
// `git show 5dec5bdd57:programs/drift/src/state/perp_market.rs` exactly.
//
// In the 1216 era `PoolBalance` carried only `padding: [u8; 6]` (24 bytes);
// the current `PoolBalance` grew that pad to `[u8; 14]` (32 bytes). The 1216
// legacy structs must therefore use this smaller mirror, or both the AMM's
// `fee_pool` and the `PerpMarket`'s `pnl_pool` over-count by 8 bytes each.
#[repr(C, packed(8))]
#[derive(Clone, Copy, Default)]
pub struct LegacyPoolBalance24 {
    pub scaled_balance: u128,
    pub market_index: u16,
    pub padding: [u8; 6],
}

impl LegacyPoolBalance24 {
    fn to_current(self) -> PoolBalance {
        PoolBalance {
            scaled_balance: self.scaled_balance,
            market_index: self.market_index,
            padding: [0; 14],
        }
    }
}

// See `LegacyAmm` for why `packed(8)` is needed.
#[repr(C, packed(8))]
#[derive(Clone, Copy)]
pub struct LegacyAmm1216 {
    pub oracle: Pubkey,
    pub historical_oracle_data: HistoricalOracleData,
    pub base_asset_amount_per_lp: i128,
    pub quote_asset_amount_per_lp: i128,
    pub fee_pool: LegacyPoolBalance24,
    pub base_asset_reserve: u128,
    pub quote_asset_reserve: u128,
    pub concentration_coef: u128,
    pub min_base_asset_reserve: u128,
    pub max_base_asset_reserve: u128,
    pub sqrt_k: u128,
    pub peg_multiplier: u128,
    pub terminal_quote_asset_reserve: u128,
    pub base_asset_amount_long: i128,
    pub base_asset_amount_short: i128,
    pub base_asset_amount_with_amm: i128,
    pub base_asset_amount_with_unsettled_lp: i128,
    pub max_open_interest: u128,
    pub quote_asset_amount: i128,
    pub quote_entry_amount_long: i128,
    pub quote_entry_amount_short: i128,
    pub quote_break_even_amount_long: i128,
    pub quote_break_even_amount_short: i128,
    pub user_lp_shares: u128,
    pub last_funding_rate: i64,
    pub last_funding_rate_long: i64,
    pub last_funding_rate_short: i64,
    pub last_24h_avg_funding_rate: i64,
    pub total_fee: i128,
    pub total_mm_fee: i128,
    pub total_exchange_fee: u128,
    pub total_fee_minus_distributions: i128,
    pub total_fee_withdrawn: u128,
    pub total_liquidation_fee: u128,
    pub cumulative_funding_rate_long: i128,
    pub cumulative_funding_rate_short: i128,
    pub total_social_loss: u128,
    pub ask_base_asset_reserve: u128,
    pub ask_quote_asset_reserve: u128,
    pub bid_base_asset_reserve: u128,
    pub bid_quote_asset_reserve: u128,
    pub last_oracle_normalised_price: i64,
    pub last_oracle_reserve_price_spread_pct: i64,
    pub last_bid_price_twap: u64,
    pub last_ask_price_twap: u64,
    pub last_mark_price_twap: u64,
    pub last_mark_price_twap_5min: u64,
    pub last_update_slot: u64,
    pub last_oracle_conf_pct: u64,
    pub net_revenue_since_last_funding: i64,
    pub last_funding_rate_ts: i64,
    pub funding_period: i64,
    pub order_step_size: u64,
    pub order_tick_size: u64,
    pub min_order_size: u64,
    pub mm_oracle_slot: u64,
    pub volume_24h: u64,
    pub long_intensity_volume: u64,
    pub short_intensity_volume: u64,
    pub last_trade_ts: i64,
    pub mark_std: u64,
    pub oracle_std: u64,
    pub last_mark_price_twap_ts: i64,
    pub base_spread: u32,
    pub max_spread: u32,
    pub long_spread: u32,
    pub short_spread: u32,
    pub mm_oracle_price: i64,
    pub max_fill_reserve_fraction: u16,
    pub max_slippage_ratio: u16,
    pub curve_update_intensity: u8,
    pub amm_jit_intensity: u8,
    pub oracle_source: u8,
    pub last_oracle_valid: bool,
    pub target_base_asset_amount_per_lp: i32,
    pub per_lp_base: i8,
    pub oracle_low_risk_slot_delay_override: i8,
    pub amm_spread_adjustment: i8,
    pub oracle_slot_delay_override: i8,
    pub mm_oracle_sequence_id: u64,
    pub net_unsettled_funding_pnl: i64,
    pub quote_asset_amount_with_unsettled_lp: i64,
    pub reference_price_offset: i32,
    pub amm_inventory_spread_adjustment: i8,
    pub reference_price_offset_deadband_pct: u8,
    pub padding: [u8; 2],
    pub last_funding_oracle_twap: i64,
}

#[repr(C, packed(8))]
#[derive(Clone, Copy)]
pub struct LegacyPerpMarket1216 {
    pub pubkey: Pubkey,
    pub amm: LegacyAmm1216,
    pub pnl_pool: LegacyPoolBalance24,
    pub name: [u8; 32],
    pub insurance_claim: InsuranceClaim,
    pub unrealized_pnl_max_imbalance: u64,
    pub expiry_ts: i64,
    pub expiry_price: i64,
    pub next_fill_record_id: u64,
    pub next_funding_rate_record_id: u64,
    pub next_curve_record_id: u64,
    pub imf_factor: u32,
    pub unrealized_pnl_imf_factor: u32,
    pub liquidator_fee: u32,
    pub if_liquidation_fee: u32,
    pub margin_ratio_initial: u32,
    pub margin_ratio_maintenance: u32,
    pub unrealized_pnl_initial_asset_weight: u32,
    pub unrealized_pnl_maintenance_asset_weight: u32,
    pub number_of_users_with_base: u32,
    pub number_of_users: u32,
    pub market_index: u16,
    pub status: u8,
    pub contract_type: u8,
    pub contract_tier: u8,
    pub paused_operations: u8,
    pub quote_spot_market_index: u16,
    pub fee_adjustment: i16,
    pub fuel_boost_position: u8,
    pub fuel_boost_taker: u8,
    pub fuel_boost_maker: u8,
    pub pool_id: u8,
    pub padding_former_hlm: [u8; 4],
    pub protected_maker_limit_price_divisor: u8,
    pub protected_maker_dynamic_divisor: u8,
    pub lp_fee_transfer_scalar: u8,
    pub lp_status: u8,
    pub lp_paused_operations: u8,
    pub lp_exchange_fee_excluscion_scalar: u8,
    pub last_fill_price: u64,
    pub lp_pool_id: u8,
    pub market_config: u8,
    pub padding: [u8; 22],
}

/// Decode a base64 snapshot in the "1216" pre-decoupling layout and re-encode
/// it as a current `PerpMarket`. Mirrors `regenerate_perp_market_snapshot`
/// but reads `LegacyPerpMarket1216`. LP-only fields are dropped (the velocity
/// fork removed LP-on-AMM); everything else maps to the same destinations.
pub fn regenerate_perp_market_snapshot_1216(old_b64: &str) -> String {
    let decoded = base64::decode(old_b64.trim()).expect("snapshot is valid base64");
    let disc_len = 8;
    let legacy_size = std::mem::size_of::<LegacyPerpMarket1216>();
    assert!(
        decoded.len() >= disc_len + legacy_size,
        "snapshot too short: got {} bytes, expected at least {} + {} ({})",
        decoded.len(),
        disc_len,
        legacy_size,
        disc_len + legacy_size,
    );

    let legacy: LegacyPerpMarket1216 = unsafe {
        std::ptr::read_unaligned(decoded[disc_len..].as_ptr() as *const LegacyPerpMarket1216)
    };

    let mut pm = PerpMarket::default();
    pm.pubkey = legacy.pubkey;
    pm.pnl_pool = legacy.pnl_pool.to_current();
    pm.name = legacy.name;
    pm.insurance_claim = legacy.insurance_claim;
    pm.unrealized_pnl_max_imbalance = legacy.unrealized_pnl_max_imbalance;
    pm.expiry_ts = legacy.expiry_ts;
    pm.expiry_price = legacy.expiry_price;
    pm.next_fill_record_id = legacy.next_fill_record_id;
    pm.next_funding_rate_record_id = legacy.next_funding_rate_record_id;
    // next_curve_record_id dropped (CurveRecord event removed).
    pm.imf_factor = legacy.imf_factor;
    pm.unrealized_pnl_imf_factor = legacy.unrealized_pnl_imf_factor;
    pm.liquidator_fee = legacy.liquidator_fee;
    pm.if_liquidation_fee = legacy.if_liquidation_fee;
    pm.margin_ratio_initial = legacy.margin_ratio_initial;
    pm.margin_ratio_maintenance = legacy.margin_ratio_maintenance;
    pm.unrealized_pnl_initial_asset_weight = legacy.unrealized_pnl_initial_asset_weight;
    pm.unrealized_pnl_maintenance_asset_weight = legacy.unrealized_pnl_maintenance_asset_weight;
    pm.number_of_users_with_base = legacy.number_of_users_with_base;
    pm.number_of_users = legacy.number_of_users;
    pm.market_index = legacy.market_index;
    pm.status = unsafe { std::mem::transmute::<u8, MarketStatus>(legacy.status) };
    pm.contract_type = unsafe {
        std::mem::transmute::<u8, crate::state::perp_market::ContractType>(legacy.contract_type)
    };
    pm.contract_tier = unsafe {
        std::mem::transmute::<u8, crate::state::perp_market::ContractTier>(legacy.contract_tier)
    };
    pm.paused_operations = legacy.paused_operations;
    pm.quote_spot_market_index = legacy.quote_spot_market_index;
    pm.fee_adjustment = legacy.fee_adjustment;
    // fuel_boost_* / padding_former_hlm / protected_maker_* dropped.
    pm.last_fill_price = legacy.last_fill_price;
    pm.pool_id = legacy.pool_id;
    pm.hedge_config.fee_transfer_scalar = legacy.lp_fee_transfer_scalar;
    pm.hedge_config.status = legacy.lp_status;
    pm.hedge_config.paused_operations = legacy.lp_paused_operations;
    pm.hedge_config.exchange_fee_exclusion_scalar = legacy.lp_exchange_fee_excluscion_scalar;
    pm.hedge_config.pool_id = legacy.lp_pool_id;
    pm.market_config = legacy.market_config;

    let la = &legacy.amm;
    let mut amm = AMM::default();
    amm.fee_pool = la.fee_pool.to_current();
    amm.base_asset_reserve = la.base_asset_reserve;
    amm.quote_asset_reserve = la.quote_asset_reserve;
    amm.concentration_coef = la.concentration_coef;
    amm.min_base_asset_reserve = la.min_base_asset_reserve;
    amm.max_base_asset_reserve = la.max_base_asset_reserve;
    amm.sqrt_k = la.sqrt_k;
    amm.peg_multiplier = la.peg_multiplier;
    amm.terminal_quote_asset_reserve = la.terminal_quote_asset_reserve;
    amm.base_asset_amount_with_amm = la.base_asset_amount_with_amm;
    amm.total_fee = la.total_fee;
    amm.total_mm_fee = la.total_mm_fee;
    amm.total_fee_minus_distributions = la.total_fee_minus_distributions;
    amm.total_fee_withdrawn = la.total_fee_withdrawn;
    amm.ask_base_asset_reserve = la.ask_base_asset_reserve;
    amm.ask_quote_asset_reserve = la.ask_quote_asset_reserve;
    amm.bid_base_asset_reserve = la.bid_base_asset_reserve;
    amm.bid_quote_asset_reserve = la.bid_quote_asset_reserve;
    amm.last_oracle_reserve_price_spread_pct = la.last_oracle_reserve_price_spread_pct;
    amm.long_spread = la.long_spread;
    amm.short_spread = la.short_spread;
    amm.reference_price_offset = la.reference_price_offset;
    amm.last_spread_update_slot = la.last_update_slot;
    amm.last_update_slot = la.last_update_slot;
    amm.net_revenue_since_last_funding = la.net_revenue_since_last_funding;
    amm.base_spread = la.base_spread;
    amm.max_spread = la.max_spread;
    amm.max_fill_reserve_fraction = la.max_fill_reserve_fraction;
    amm.max_slippage_ratio = la.max_slippage_ratio;
    amm.curve_update_intensity = la.curve_update_intensity;
    amm.amm_jit_intensity = la.amm_jit_intensity;
    amm.amm_spread_adjustment = la.amm_spread_adjustment;
    amm.amm_inventory_spread_adjustment = la.amm_inventory_spread_adjustment;
    amm.reference_price_offset_deadband_pct = la.reference_price_offset_deadband_pct;
    pm.amm = amm;

    pm.base_asset_amount_long = la.base_asset_amount_long;
    pm.base_asset_amount_short = la.base_asset_amount_short;
    pm.quote_asset_amount = la.quote_asset_amount;
    pm.quote_entry_amount_long = la.quote_entry_amount_long;
    pm.quote_entry_amount_short = la.quote_entry_amount_short;
    pm.quote_break_even_amount_long = la.quote_break_even_amount_long;
    pm.quote_break_even_amount_short = la.quote_break_even_amount_short;
    pm.max_open_interest = la.max_open_interest;
    pm.total_social_loss = la.total_social_loss;
    pm.cumulative_funding_rate_long = la.cumulative_funding_rate_long;
    pm.cumulative_funding_rate_short = la.cumulative_funding_rate_short;
    pm.fee_ledger.total_exchange_fee = la.total_exchange_fee;
    pm.fee_ledger.total_liquidation_fee = la.total_liquidation_fee;
    pm.oracle = la.oracle;
    pm.last_funding_rate = la.last_funding_rate;
    pm.last_funding_rate_long = la.last_funding_rate_long;
    pm.last_funding_rate_short = la.last_funding_rate_short;
    pm.last_funding_rate_ts = la.last_funding_rate_ts;
    pm.net_unsettled_funding_pnl = la.net_unsettled_funding_pnl;
    pm.order_step_size = la.order_step_size;
    pm.order_tick_size = la.order_tick_size;
    pm.oracle_source = unsafe { std::mem::transmute::<u8, OracleSource>(la.oracle_source) };
    pm.oracle_slot_delay_override = la.oracle_slot_delay_override;
    pm.oracle_low_risk_slot_delay_override = la.oracle_low_risk_slot_delay_override;

    pm.market_stats = MarketStats {
        funding_period: la.funding_period,
        last_24h_avg_funding_rate: la.last_24h_avg_funding_rate,
        min_order_size: la.min_order_size,
        last_mark_price_twap: la.last_mark_price_twap,
        last_mark_price_twap_5min: la.last_mark_price_twap_5min,
        last_mark_price_twap_ts: la.last_mark_price_twap_ts,
        last_bid_price_twap: la.last_bid_price_twap,
        last_ask_price_twap: la.last_ask_price_twap,
        mark_std: la.mark_std,
        oracle_std: la.oracle_std,
        last_oracle_conf_pct: la.last_oracle_conf_pct,
        volume_24h: la.volume_24h,
        long_intensity_volume: la.long_intensity_volume,
        short_intensity_volume: la.short_intensity_volume,
        last_trade_ts: la.last_trade_ts,
        mm_oracle_price: la.mm_oracle_price,
        mm_oracle_slot: la.mm_oracle_slot,
        mm_oracle_sequence_id: la.mm_oracle_sequence_id,
        last_oracle_normalised_price: la.last_oracle_normalised_price,
        last_reference_price_offset: la.reference_price_offset,
        last_oracle_valid: la.last_oracle_valid,
        padding: [0; 3],
        last_funding_oracle_twap: la.last_funding_oracle_twap,
        historical_oracle_data: la.historical_oracle_data,
    };

    let mut out_bytes = Vec::with_capacity(disc_len + std::mem::size_of::<PerpMarket>());
    out_bytes.extend_from_slice(&decoded[..disc_len]);
    let pm_bytes: &[u8] = unsafe {
        std::slice::from_raw_parts(
            &pm as *const PerpMarket as *const u8,
            std::mem::size_of::<PerpMarket>(),
        )
    };
    out_bytes.extend_from_slice(pm_bytes);
    base64::encode(&out_bytes)
}

// ============================================================================
// Legacy `SpotMarket` (SIZE 776, content 768).
//
// The SpotMarket snapshots embedded in the repeg and liquidation tests predate
// the field reordering that grouped all u128-containing members together (the
// `MarketIndexOffset` alignment rework): `historical_oracle_data`,
// `historical_index_data`, `revenue_pool`, and `spot_fee_pool` used to sit
// right after `name`, and the struct still carried the `fuel_boost_*` bytes and
// a 24-byte `PoolBalance`. Mirrors
// `git show 9b321e384c:programs/drift/src/state/spot_market.rs` exactly.
//
// `InsuranceFund` is byte-identical in size between the two layouts (the tail
// `total_factor`/`user_factor` u32 pair simply became `if_fee_factor` +
// `_padding_if`), so the current type is read in place. `PoolBalance` shrank
// (see `LegacyPoolBalance24`).
#[repr(C, packed(8))]
#[derive(Clone, Copy)]
pub struct LegacySpotMarket776 {
    pub pubkey: Pubkey,
    pub oracle: Pubkey,
    pub mint: Pubkey,
    pub vault: Pubkey,
    pub name: [u8; 32],
    pub historical_oracle_data: HistoricalOracleData,
    pub historical_index_data: HistoricalIndexData,
    pub revenue_pool: LegacyPoolBalance24,
    pub spot_fee_pool: LegacyPoolBalance24,
    pub insurance_fund: InsuranceFund,
    pub total_spot_fee: u128,
    pub deposit_balance: u128,
    pub borrow_balance: u128,
    pub cumulative_deposit_interest: u128,
    pub cumulative_borrow_interest: u128,
    pub total_social_loss: u128,
    pub total_quote_social_loss: u128,
    pub withdraw_guard_threshold: u64,
    pub max_token_deposits: u64,
    pub deposit_token_twap: u64,
    pub borrow_token_twap: u64,
    pub utilization_twap: u64,
    pub last_interest_ts: u64,
    pub last_twap_ts: u64,
    pub expiry_ts: i64,
    pub order_step_size: u64,
    pub order_tick_size: u64,
    pub min_order_size: u64,
    pub max_position_size: u64,
    pub next_fill_record_id: u64,
    pub next_deposit_record_id: u64,
    pub initial_asset_weight: u32,
    pub maintenance_asset_weight: u32,
    pub initial_liability_weight: u32,
    pub maintenance_liability_weight: u32,
    pub imf_factor: u32,
    pub liquidator_fee: u32,
    pub if_liquidation_fee: u32,
    pub optimal_utilization: u32,
    pub optimal_borrow_rate: u32,
    pub max_borrow_rate: u32,
    pub decimals: u32,
    pub market_index: u16,
    pub orders_enabled: bool,
    pub oracle_source: u8,
    pub status: u8,
    pub asset_tier: u8,
    pub paused_operations: u8,
    pub if_paused_operations: u8,
    pub fee_adjustment: i16,
    pub max_token_borrows_fraction: u16,
    pub flash_loan_amount: u64,
    pub flash_loan_initial_token_amount: u64,
    pub total_swap_fee: u64,
    pub scale_initial_asset_weight_start: u64,
    pub min_borrow_rate: u8,
    pub fuel_boost_deposits: u8,
    pub fuel_boost_borrows: u8,
    pub fuel_boost_taker: u8,
    pub fuel_boost_maker: u8,
    pub fuel_boost_insurance: u8,
    pub token_program_flag: u8,
    pub pool_id: u8,
    pub padding: [u8; 40],
}

/// Decode a base64 snapshot of a pre-reorder `SpotMarket` (SIZE 776) and
/// re-encode it as a current `SpotMarket`. Drops the removed `fuel_boost_*`
/// bytes; everything else maps to the same destination.
pub fn regenerate_spot_market_snapshot(old_b64: &str) -> String {
    let decoded = base64::decode(old_b64.trim()).expect("snapshot is valid base64");
    let disc_len = 8;
    let legacy_size = std::mem::size_of::<LegacySpotMarket776>();
    assert!(
        decoded.len() >= disc_len + legacy_size,
        "snapshot too short: got {} bytes, expected at least {} + {} ({})",
        decoded.len(),
        disc_len,
        legacy_size,
        disc_len + legacy_size,
    );

    let l: LegacySpotMarket776 = unsafe {
        std::ptr::read_unaligned(decoded[disc_len..].as_ptr() as *const LegacySpotMarket776)
    };

    let mut sm = SpotMarket::default();
    sm.pubkey = l.pubkey;
    sm.oracle = l.oracle;
    sm.mint = l.mint;
    sm.vault = l.vault;
    sm.name = l.name;
    sm.historical_oracle_data = l.historical_oracle_data;
    sm.historical_index_data = l.historical_index_data;
    sm.revenue_pool = l.revenue_pool.to_current();
    sm.spot_fee_pool = l.spot_fee_pool.to_current();
    sm.insurance_fund = l.insurance_fund;
    sm.total_spot_fee = l.total_spot_fee;
    sm.deposit_balance = l.deposit_balance;
    sm.borrow_balance = l.borrow_balance;
    sm.cumulative_deposit_interest = l.cumulative_deposit_interest;
    sm.cumulative_borrow_interest = l.cumulative_borrow_interest;
    sm.total_social_loss = l.total_social_loss;
    sm.total_quote_social_loss = l.total_quote_social_loss;
    sm.withdraw_guard_threshold = l.withdraw_guard_threshold;
    sm.max_token_deposits = l.max_token_deposits;
    sm.deposit_token_twap = l.deposit_token_twap;
    sm.borrow_token_twap = l.borrow_token_twap;
    sm.utilization_twap = l.utilization_twap;
    sm.last_interest_ts = l.last_interest_ts;
    sm.last_twap_ts = l.last_twap_ts;
    sm.expiry_ts = l.expiry_ts;
    sm.order_step_size = l.order_step_size;
    sm.order_tick_size = l.order_tick_size;
    sm.min_order_size = l.min_order_size;
    sm.max_position_size = l.max_position_size;
    sm.next_fill_record_id = l.next_fill_record_id;
    sm.next_deposit_record_id = l.next_deposit_record_id;
    sm.initial_asset_weight = l.initial_asset_weight;
    sm.maintenance_asset_weight = l.maintenance_asset_weight;
    sm.initial_liability_weight = l.initial_liability_weight;
    sm.maintenance_liability_weight = l.maintenance_liability_weight;
    sm.imf_factor = l.imf_factor;
    sm.liquidator_fee = l.liquidator_fee;
    sm.if_liquidation_fee = l.if_liquidation_fee;
    sm.optimal_utilization = l.optimal_utilization;
    sm.optimal_borrow_rate = l.optimal_borrow_rate;
    sm.max_borrow_rate = l.max_borrow_rate;
    sm.decimals = l.decimals;
    sm.market_index = l.market_index;
    sm.orders_enabled = l.orders_enabled;
    sm.oracle_source = unsafe { std::mem::transmute::<u8, OracleSource>(l.oracle_source) };
    sm.status = unsafe { std::mem::transmute::<u8, MarketStatus>(l.status) };
    sm.asset_tier = unsafe { std::mem::transmute::<u8, AssetTier>(l.asset_tier) };
    sm.paused_operations = l.paused_operations;
    sm.if_paused_operations = l.if_paused_operations;
    sm.fee_adjustment = l.fee_adjustment;
    sm.max_token_borrows_fraction = l.max_token_borrows_fraction;
    sm.flash_loan_amount = l.flash_loan_amount;
    sm.flash_loan_initial_token_amount = l.flash_loan_initial_token_amount;
    sm.total_swap_fee = l.total_swap_fee;
    sm.scale_initial_asset_weight_start = l.scale_initial_asset_weight_start;
    sm.min_borrow_rate = l.min_borrow_rate;
    // fuel_boost_* dropped.
    sm.token_program_flag = l.token_program_flag;
    sm.pool_id = l.pool_id;

    let mut out_bytes = Vec::with_capacity(disc_len + std::mem::size_of::<SpotMarket>());
    out_bytes.extend_from_slice(&decoded[..disc_len]);
    let sm_bytes: &[u8] = unsafe {
        std::slice::from_raw_parts(
            &sm as *const SpotMarket as *const u8,
            std::mem::size_of::<SpotMarket>(),
        )
    };
    out_bytes.extend_from_slice(sm_bytes);
    base64::encode(&out_bytes)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Print sizes so we can iterate on the layout.
    #[test]
    fn print_legacy_layout_sizes() {
        println!(
            "size_of LegacyAmm = {}, LegacyPerpMarket = {}",
            std::mem::size_of::<LegacyAmm>(),
            std::mem::size_of::<LegacyPerpMarket>(),
        );
    }

    /// New PerpMarket is the size the tests will write into.
    #[test]
    fn current_perp_market_size_unchanged() {
        // Cached spread state lives back on AMM: 4×u128 spread reserves,
        // i64 last_oracle_reserve_price_spread_pct, u64 last_spread_update_slot,
        // 2×u32 long/short_spread, i32 reference_price_offset. The 5 former
        // lp_* config bytes moved into the 16-byte `hedge_config` at the tail,
        // growing the struct from 1200 to 1216 bytes; +8 for the Anchor
        // discriminator = 1224. The protocol-fee redesign then appended
        // `protocol_fee_pool` (32) + `pending_protocol_fee`/`pending_if_fee`
        // (2×16) + `protocol_liquidation_fee` (4) + pad (12) = 80 bytes at the
        // tail → 1296 content, 1304 with discriminator.
        assert_eq!(std::mem::size_of::<PerpMarket>(), 1296);
        assert_eq!(PerpMarket::SIZE, 1304);
    }

    /// One-shot regeneration helper. Run with:
    /// `cargo test -p velocity --lib test_utils::legacy_snapshot::tests::print_regenerated -- --ignored --nocapture`
    /// then copy the printed lines back into each test.
    #[test]
    #[ignore = "regeneration tool; run on demand"]
    fn print_regenerated() {
        let snapshots: &[(&str, &str)] = &[
            (
                "amm_pool_balance_liq_fees_example",
                AMM_POOL_BALANCE_LIQ_FEES_EXAMPLE,
            ),
            (
                "amm_pred_expiry_price_yes_market_example",
                AMM_PRED_EXPIRY_PRICE_YES_MARKET_EXAMPLE,
            ),
            (
                "amm_pred_expiry_price_market_example",
                AMM_PRED_EXPIRY_PRICE_MARKET_EXAMPLE,
            ),
            (
                "amm_pred_settle_market_example",
                AMM_PRED_SETTLE_MARKET_EXAMPLE,
            ),
            ("amm_pred_market_example", AMM_PRED_MARKET_EXAMPLE),
            (
                "amm_ref_price_decay_tail_test",
                AMM_REF_PRICE_DECAY_TAIL_TEST,
            ),
            (
                "amm_ref_price_offset_decay_logic",
                AMM_REF_PRICE_OFFSET_DECAY_LOGIC,
            ),
            (
                "amm_negative_ref_price_offset_decay_logic",
                AMM_NEGATIVE_REF_PRICE_OFFSET_DECAY_LOGIC,
            ),
            ("amm_perp_ref_offset", AMM_PERP_REF_OFFSET),
            ("update_amm_near_boundary", UPDATE_AMM_NEAR_BOUNDARY),
            ("update_amm_near_boundary2", UPDATE_AMM_NEAR_BOUNDARY2),
            ("recenter_amm_1", RECENTER_AMM_1),
            ("recenter_amm_2", RECENTER_AMM_2),
            ("test_move_amm", TEST_MOVE_AMM),
            ("order_params::btc", ORDER_PARAMS_BTC),
            ("order_params::doge", ORDER_PARAMS_DOGE),
            (
                "order_params::test_default_starts_on_perp_markets",
                ORDER_PARAMS_DEFAULT_STARTS,
            ),
            (
                "crate::vlp::amm::controller::perp_market_transfer_fee_and_pnl_pool::sol",
                PMTFPP_SOL,
            ),
            (
                "crate::vlp::amm::controller::perp_market_transfer_fee_and_pnl_pool::eth",
                PMTFPP_ETH,
            ),
        ];
        for (name, b64) in snapshots {
            let new = regenerate_perp_market_snapshot(b64);
            println!("---BEGIN {}---", name);
            println!("{}", new);
            println!("---END {}---", name);
        }
    }

    // Snapshot strings read from .b64 sibling files (populated by extracting
    // the `let perp_market_str` blob out of each `#[ignore]` test body).

    const AMM_POOL_BALANCE_LIQ_FEES_EXAMPLE: &str =
        include_str!("snapshots/amm_pool_balance_liq_fees_example.b64");
    const AMM_PRED_EXPIRY_PRICE_YES_MARKET_EXAMPLE: &str =
        include_str!("snapshots/amm_pred_expiry_price_yes_market_example.b64");
    const AMM_PRED_EXPIRY_PRICE_MARKET_EXAMPLE: &str =
        include_str!("snapshots/amm_pred_expiry_price_market_example.b64");
    const AMM_PRED_SETTLE_MARKET_EXAMPLE: &str =
        include_str!("snapshots/amm_pred_settle_market_example.b64");
    const AMM_PRED_MARKET_EXAMPLE: &str = include_str!("snapshots/amm_pred_market_example.b64");
    const AMM_REF_PRICE_DECAY_TAIL_TEST: &str =
        include_str!("snapshots/amm_ref_price_decay_tail_test.b64");
    const AMM_REF_PRICE_OFFSET_DECAY_LOGIC: &str =
        include_str!("snapshots/amm_ref_price_offset_decay_logic.b64");
    const AMM_NEGATIVE_REF_PRICE_OFFSET_DECAY_LOGIC: &str =
        include_str!("snapshots/amm_negative_ref_price_offset_decay_logic.b64");
    const AMM_PERP_REF_OFFSET: &str = include_str!("snapshots/amm_perp_ref_offset.b64");
    const UPDATE_AMM_NEAR_BOUNDARY: &str = include_str!("snapshots/update_amm_near_boundary.b64");
    const UPDATE_AMM_NEAR_BOUNDARY2: &str = include_str!("snapshots/update_amm_near_boundary2.b64");
    const RECENTER_AMM_1: &str = include_str!("snapshots/recenter_amm_1.b64");
    const RECENTER_AMM_2: &str = include_str!("snapshots/recenter_amm_2.b64");
    const TEST_MOVE_AMM: &str = include_str!("snapshots/test_move_amm.b64");
    const ORDER_PARAMS_BTC: &str = include_str!("snapshots/order_params_btc.b64");
    const ORDER_PARAMS_DOGE: &str = include_str!("snapshots/order_params_doge.b64");
    const ORDER_PARAMS_DEFAULT_STARTS: &str =
        include_str!("snapshots/order_params_default_starts.b64");
    const PMTFPP_SOL: &str = include_str!("snapshots/pmtfpp_sol.b64");
    const PMTFPP_ETH: &str = include_str!("snapshots/pmtfpp_eth.b64");
}
