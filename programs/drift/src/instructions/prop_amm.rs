//! Match perp orders against prop AMM (midprice_pino) liquidity. Uses Drift as the exchange:
//! taker and makers are Drift users; matcher authority is a PDA of this program.
//!
//! Each PropAMM account must be associated with a Drift User account (the maker).
//! Remaining accounts: [midprice_program], [spot_market_0, spot_market_1, ...] (num_spot_markets collateral spot markets),
//! then for each AMM: (midprice_account, maker_user).
//! Midprice accounts have authority = maker's wallet (User.authority); only Drift's matcher PDA can apply_fills (hardcoded in midprice_pino).
//! Matcher_authority = PDA(drift_program_id, ["matcher", maker_user.key()]).

use crate::controller;
use crate::controller::orders::update_order_after_fill;
use crate::controller::pda;
use crate::controller::position::{
    add_new_position, decrease_open_bids_and_asks, get_position_index, update_position_and_market,
    update_quote_asset_and_break_even_amount, PositionDirection,
};
use crate::error::{DriftResult, ErrorCode};
use crate::get_then_update_id;
use crate::instructions::constraints::valid_oracle_for_perp_market;
use crate::instructions::optional_accounts::get_revenue_share_escrow_account;
use crate::math::casting::Cast;
use crate::math::constants::AMM_RESERVE_PRECISION;
use crate::math::constants::BASE_PRECISION_U64;
use crate::math::fees;
use crate::math::liquidation::validate_user_not_being_liquidated;
use crate::math::margin::{
    calculate_margin_requirement_and_total_collateral_and_liability_info, MarginRequirementType,
};
use crate::math::oracle::{is_oracle_valid_for_action, oracle_validity, DriftAction, LogMode};
use crate::math::orders::{
    calculate_fill_price, get_position_delta_for_fill, is_oracle_too_divergent_with_twap_5min,
    limit_price_breaches_maker_oracle_price_bands, select_margin_type_for_perp_maker,
    should_cancel_reduce_only_order, should_expire_order, validate_fill_price_within_price_bands,
};
use crate::math::safe_math::SafeMath;
use crate::state::events::{
    emit_stack, get_order_action_record, OrderAction, OrderActionExplanation, OrderActionRecord,
};
use crate::state::margin_calculation::MarginContext;
use crate::state::oracle_map::{is_oracle_account, OracleMap};
use crate::state::paused_operations::PerpOperation;
use crate::state::perp_market::{MarketStatus, PerpMarket};
use crate::state::perp_market_map::{MarketSet as PerpMarketSet, PerpMarketMap};
use crate::state::revenue_share::RevenueShareOrderBitFlag;
use crate::state::spot_market_map::{SpotMarketMap, SpotMarketSet};
use crate::state::state::ExchangeStatus;
use crate::state::traits::Size;
use crate::state::user::{MarketType, Order, OrderStatus, OrderType, User, UserStats};
use crate::validate;
use anchor_lang::prelude::*;
use anchor_lang::solana_program::instruction::{AccountMeta, Instruction};
use anchor_lang::solana_program::program::invoke_signed;
use midprice_book_view::{
    write_apply_fills_instruction_data, ApplyFillsSink, MidpriceBookView, TakingSide,
};
use std::collections::{BTreeMap, BTreeSet};
use std::convert::TryFrom;
use std::iter::Peekable;
use std::slice::Iter;

/// One matcher PDA can apply fills to all PropAMM books (saves tx size vs per-maker matcher).
const PROP_AMM_MATCHER_SEED: &[u8] = b"prop_amm_matcher";

/// Midprice_pino instruction opcode for initialize (accounts: midprice w, authority s, drift_matcher s). Payload: market_index, subaccount_index, order_tick_size, min_order_size.
const MIDPRICE_IX_INITIALIZE: u8 = 1;
/// Midprice_pino instruction opcode for update_tick_sizes (accounts: midprice w, authority s, drift_matcher s). Payload: order_tick_size, min_order_size.
const MIDPRICE_IX_UPDATE_TICK_SIZES: u8 = 8;

struct VecSink<'a>(&'a mut Vec<u8>);
impl ApplyFillsSink for VecSink<'_> {
    fn extend_from_slice(&mut self, bytes: &[u8]) {
        self.0.extend_from_slice(bytes);
    }
}

#[derive(Clone)]
pub(crate) struct AmmView {
    #[allow(dead_code)]
    key: Pubkey,
    mid_price: u64,
    /// sequence_number snapshot taken when reading the midprice book for matching.
    sequence_number_snapshot: u64,
    maker_user_remaining_index: usize,
    midprice_remaining_index: usize,
}

/// Tracks the source of a frontier level for unified matching.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum FrontierSource {
    /// PropAMM book level — settled via CPI to midprice_pino.
    PropAmm,
    /// DLOB maker order — settled via position update on both taker and maker.
    DlobMaker,
}

#[derive(Clone, Copy)]
struct TopLevel {
    price: u64,
    size: u64,
    abs_index: usize,
    is_ask: bool,
    source: FrontierSource,
}

#[derive(Clone, Copy)]
pub(crate) struct ExternalFill {
    pub abs_index: u16,
    pub is_ask: bool,
    pub fill_size: u64,
}

#[derive(Clone, Copy)]
pub(crate) struct PendingExternalFill {
    pub midprice_remaining_index: usize,
    pub maker_user_remaining_index: usize,
    /// sequence_number snapshot for this (midprice, maker_user) pair.
    pub sequence_number_snapshot: u64,
    pub fill: ExternalFill,
}

/// DLOB maker order parsed from remaining accounts.
#[derive(Clone)]
pub(crate) struct DlobMakerView {
    pub maker_key: Pubkey,
    pub order_index: usize,
    pub price: u64,
    pub size: u64,
    pub remaining_account_index: usize,
    pub maker_stats_remaining_index: usize,
}

/// A pending DLOB fill to be settled after the matching loop.
#[derive(Clone)]
pub(crate) struct PendingDlobFill {
    pub maker_key: Pubkey,
    pub order_index: usize,
    pub remaining_account_index: usize,
    pub maker_stats_remaining_index: usize,
    #[allow(dead_code)]
    pub base_asset_amount: u64,
    pub price: u64,
}

#[derive(Clone, Copy)]
struct TiedFrontier {
    idx: usize,
    level: TopLevel,
}

#[derive(Clone, Copy)]
struct FillAllocation {
    idx: usize,
    level: TopLevel,
    share: u64,
}

/// Result of the unified matching loop (used by handler and tests).
#[derive(Default)]
pub(crate) struct UnifiedMatchResult {
    pub taker_base_delta: i64,
    pub taker_quote_delta: i64,
    pub total_quote_volume: u64,
    pub maker_deltas: BTreeMap<Pubkey, (i64, i64)>,
    pub external_fills: Vec<PendingExternalFill>,
    /// DLOB fills to settle by updating maker/taker positions.
    pub dlob_fills: Vec<PendingDlobFill>,
}

/// Heap-allocated context holding the heavy long-lived state for fill_perp_order2.
/// Boxing this keeps ~440 bytes off the handler's stack frame (SBF stack limit is 4KB).
struct FillContext<'a> {
    oracle_map: OracleMap<'a>,
    spot_market_map: SpotMarketMap<'a>,
    perp_market_map: PerpMarketMap<'a>,
    mctx: MarketContext,
    taker: TakerOrder,
    reserve_price_before: u64,
    limit_price: u64,
    amm_start: usize,
}

/// Resolved taker order fields extracted during the setup phase of fill_perp_order2.
struct TakerOrder {
    market_index: u16,
    size: u64,
    direction: PositionDirection,
    order_index: usize,
    base_asset_amount: u64,
    slot: u64,
    reduce_only: bool,
    high_leverage: bool,
    is_resting_limit_order: bool,
    auction_end_slot: u64,
}

/// Market-level oracle and config data loaded during market prefill.
struct MarketContext {
    oracle_price: i64,
    oracle_twap_5min: i64,
    is_prediction_market: bool,
    order_tick_size: u64,
    market_margin_ratio_initial: u32,
    order_step_size: u64,
    protected_maker_params: crate::state::protected_maker_mode_config::ProtectedMakerParams,
}

/// Output of the matching phase: filtered fills and metadata for settlement.
struct MatchOutput {
    midprice_program_idx: usize,
    amm_views: Vec<AmmView>,
    amm_view_by_maker: BTreeMap<Pubkey, usize>,
    external_fills: Vec<PendingExternalFill>,
    maker_deltas: BTreeMap<Pubkey, (i64, i64)>,
    dlob_fills: Vec<PendingDlobFill>,
    taker_base_delta: i64,
    taker_quote_delta: i64,
    total_quote_volume: u64,
    referrer_info: Option<(Pubkey, usize, usize)>,
    optional_accounts_start: usize,
}

/// Global PropAMM matcher PDA: one account can apply fills to all PropAMM books.
pub fn prop_amm_matcher_pda(program_id: &Pubkey) -> (Pubkey, u8) {
    Pubkey::find_program_address(&[PROP_AMM_MATCHER_SEED], program_id)
}

fn validate_fill_perp_order2_globals(
    state: &crate::state::state::State,
    user: &User,
    user_stats: &UserStats,
) -> DriftResult<()> {
    validate!(
        user_stats.authority == user.authority,
        ErrorCode::InvalidUserStatsAccount,
        "user_stats authority must match user authority"
    )?;

    validate!(
        !state
            .get_exchange_status()?
            .contains(ExchangeStatus::FillPaused),
        ErrorCode::ExchangePaused,
        "exchange fills paused"
    )?;

    Ok(())
}

fn load_fill_perp_order2_market_maps<'a>(
    remaining_accounts: &'a [AccountInfo<'a>],
    market_start: usize,
    amm_start: usize,
    current_perp_market: &AccountLoader<'a, PerpMarket>,
    current_market_index: u16,
) -> DriftResult<(SpotMarketMap<'a>, PerpMarketMap<'a>)> {
    let market_slice = &remaining_accounts[market_start..amm_start];
    let mut market_iter: Peekable<Iter<AccountInfo>> = market_slice.iter().peekable();

    let spot_market_map = SpotMarketMap::load(&SpotMarketSet::new(), &mut market_iter)?;
    let extra_perp_market_map = PerpMarketMap::load(&PerpMarketSet::new(), &mut market_iter)?;

    validate!(
        market_iter.peek().is_none(),
        ErrorCode::InvalidMarketAccount,
        "only spot/perp market accounts may appear before the matcher PDA"
    )?;

    let mut perp_market_map =
        PerpMarketMap::from_single_loader(current_perp_market, current_market_index)?;
    for (market_index, loader) in extra_perp_market_map.0.iter() {
        validate!(
            !perp_market_map.0.contains_key(market_index),
            ErrorCode::InvalidMarketAccount,
            "duplicate perp market account before matcher for market {}",
            market_index
        )?;
        perp_market_map.0.insert(*market_index, loader.clone());
    }

    Ok((spot_market_map, perp_market_map))
}

/// Returns (mid_price, sequence_number, market_index).
fn read_external_mid_price(
    midprice_info: &AccountInfo,
    midprice_program_id: &Pubkey,
    maker_user_info: &AccountInfo,
    current_slot: u64,
) -> DriftResult<(u64, u64, u16)> {
    validate!(
        *midprice_info.owner == *midprice_program_id,
        ErrorCode::InvalidMidpriceAccount,
        "midprice account must be owned by midprice program (create/init via midprice program)"
    )?;
    let data = midprice_info
        .try_borrow_data()
        .map_err(|_| ErrorCode::InvalidMidpriceAccount)?;
    let view = MidpriceBookView::new(&data).map_err(|_| ErrorCode::InvalidMidpriceAccount)?;

    let stored_authority = Pubkey::new_from_array(
        view.authority()
            .map_err(|_| ErrorCode::InvalidMidpriceAccount)?,
    );
    let subaccount_index = view.subaccount_index();
    let expected_maker_user_pda =
        crate::state::user::derive_user_account(&stored_authority, subaccount_index);
    validate!(
        expected_maker_user_pda == maker_user_info.key(),
        ErrorCode::MidpriceMakerUserMismatch,
        "midprice (authority, subaccount_id) must derive to maker User PDA"
    )?;

    let quote_ttl_slots = view.quote_ttl_slots();
    if quote_ttl_slots > 0 {
        validate!(
            current_slot.saturating_sub(view.ref_slot()) <= quote_ttl_slots,
            ErrorCode::MidpriceQuoteExpired,
            "midprice quote expired (slot age {} > ttl {})",
            current_slot.saturating_sub(view.ref_slot()),
            quote_ttl_slots
        )?;
    }

    Ok((
        view.mid_price_u64(),
        view.sequence_number(),
        view.market_index(),
    ))
}

fn find_external_top_level_from(
    midprice_info: &AccountInfo,
    side: &PositionDirection,
    taker_limit_price: u64,
    mid_price: u64,
    start_from_abs_index: Option<usize>,
) -> DriftResult<Option<TopLevel>> {
    let data = midprice_info
        .try_borrow_data()
        .map_err(|_| ErrorCode::InvalidMidpriceAccount)?;
    let book = MidpriceBookView::new(&data).map_err(|_| ErrorCode::InvalidMidpriceAccount)?;
    let taking_side = match side {
        PositionDirection::Long => TakingSide::TakingAsks,
        PositionDirection::Short => TakingSide::TakingBids,
    };
    let level = book
        .find_first_crossing_level(
            taking_side,
            mid_price,
            taker_limit_price,
            start_from_abs_index,
        )
        .map_err(|_| ErrorCode::InvalidMidpriceAccount)?;
    Ok(level.map(|l| TopLevel {
        price: l.price,
        size: l.size,
        abs_index: l.abs_index,
        is_ask: l.is_ask,
        source: FrontierSource::PropAmm,
    }))
}

/// Initialize frontiers for all discrete sources: PropAMM books first, then DLOB makers.
/// Returns (frontiers, num_prop_amm_frontiers) so callers know the boundary.
fn init_frontiers(
    amm_views: &[AmmView],
    dlob_makers: &[DlobMakerView],
    remaining_accounts: &[AccountInfo],
    side: &PositionDirection,
    taker_limit_price: u64,
) -> DriftResult<(Vec<Option<TopLevel>>, usize)> {
    let mut frontiers = Vec::with_capacity(amm_views.len() + dlob_makers.len());

    // PropAMM book frontiers (multi-level, can advance).
    for amm in amm_views {
        frontiers.push(find_external_top_level_from(
            &remaining_accounts[amm.midprice_remaining_index],
            side,
            taker_limit_price,
            amm.mid_price,
            None,
        )?);
    }
    let num_prop_amm = amm_views.len();

    // DLOB maker frontiers (single-level, no advancement).
    let crosses = |maker_price: u64| -> bool {
        match side {
            PositionDirection::Long => maker_price <= taker_limit_price,
            PositionDirection::Short => maker_price >= taker_limit_price,
        }
    };
    for dlob in dlob_makers {
        if crosses(dlob.price) && dlob.size > 0 {
            frontiers.push(Some(TopLevel {
                price: dlob.price,
                size: dlob.size,
                abs_index: 0,  // not meaningful for DLOB
                is_ask: false, // not meaningful for DLOB
                source: FrontierSource::DlobMaker,
            }));
        } else {
            frontiers.push(None);
        }
    }

    Ok((frontiers, num_prop_amm))
}

fn tied_frontiers_at_best_price(
    frontiers: &[Option<TopLevel>],
    side: &PositionDirection,
) -> Option<(u64, Vec<TiedFrontier>)> {
    let mut best_price: Option<u64> = None;
    let mut tied: Vec<TiedFrontier> = Vec::new();

    for (idx, maybe_level) in frontiers.iter().enumerate() {
        let Some(level) = maybe_level else {
            continue;
        };
        match best_price {
            None => {
                best_price = Some(level.price);
                tied.push(TiedFrontier { idx, level: *level });
            }
            Some(current_best) => {
                let is_better = if matches!(side, PositionDirection::Long) {
                    level.price < current_best
                } else {
                    level.price > current_best
                };
                if is_better {
                    best_price = Some(level.price);
                    tied.clear();
                    tied.push(TiedFrontier { idx, level: *level });
                    continue;
                }
                if level.price == current_best {
                    tied.push(TiedFrontier { idx, level: *level });
                }
            }
        }
    }

    best_price.map(|price| (price, tied))
}

/// Allocate fill among tied frontiers at the same price level.
/// PropAMM books get pro-rata allocation; DLOB makers fill sequentially after.
fn allocate_fill(
    tied_levels: &[TiedFrontier],
    remaining: u64,
) -> DriftResult<(u64, Vec<FillAllocation>)> {
    // Partition into PropAMM (pro-rata) and DLOB (sequential).
    let prop_amm: Vec<&TiedFrontier> = tied_levels
        .iter()
        .filter(|t| t.level.source == FrontierSource::PropAmm)
        .collect();
    let dlob: Vec<&TiedFrontier> = tied_levels
        .iter()
        .filter(|t| t.level.source == FrontierSource::DlobMaker)
        .collect();

    let mut allocations = Vec::with_capacity(tied_levels.len());
    let mut total_fill = 0u64;
    let mut left = remaining;

    // 1) PropAMM books: pro-rata among them.
    if !prop_amm.is_empty() && left > 0 {
        let total_liquidity = prop_amm
            .iter()
            .try_fold(0u64, |acc, tied| acc.safe_add(tied.level.size))?;
        let fill = left.min(total_liquidity);

        let mut distributed = 0u64;
        for tied in &prop_amm {
            let share_u128 = (fill as u128)
                .safe_mul(tied.level.size as u128)?
                .safe_div(total_liquidity as u128)?;
            let share = u64::try_from(share_u128).map_err(|_| ErrorCode::MathError)?;
            distributed = distributed.safe_add(share)?;
            allocations.push(FillAllocation {
                idx: tied.idx,
                level: tied.level,
                share,
            });
        }

        // Distribute remainder 1-unit at a time.
        let mut rem = fill.safe_sub(distributed)?;
        for allocation in allocations.iter_mut() {
            if rem == 0 {
                break;
            }
            if allocation.level.source == FrontierSource::PropAmm
                && allocation.share < allocation.level.size
            {
                allocation.share = allocation.share.safe_add(1)?;
                rem = rem.saturating_sub(1);
            }
        }
        total_fill = total_fill.safe_add(fill)?;
        left = left.safe_sub(fill)?;
    }

    // 2) DLOB makers: fill sequentially.
    for tied in &dlob {
        if left == 0 {
            break;
        }
        let fill = left.min(tied.level.size);
        allocations.push(FillAllocation {
            idx: tied.idx,
            level: tied.level,
            share: fill,
        });
        total_fill = total_fill.safe_add(fill)?;
        left = left.safe_sub(fill)?;
    }

    Ok((total_fill, allocations))
}

fn refresh_exhausted_frontiers(
    frontiers: &mut [Option<TopLevel>],
    tied_levels: &[TiedFrontier],
    amm_views: &[AmmView],
    _num_prop_amm: usize,
    remaining_accounts: &[AccountInfo],
    side: &PositionDirection,
    taker_limit_price: u64,
) -> DriftResult<()> {
    for tied in tied_levels {
        let Some(current) = frontiers[tied.idx] else {
            continue;
        };
        if current.size != 0 {
            continue;
        }
        match current.source {
            FrontierSource::PropAmm => {
                // PropAMM books advance to next level.
                let next_start = current.abs_index.saturating_add(1);
                frontiers[tied.idx] = find_external_top_level_from(
                    &remaining_accounts[amm_views[tied.idx].midprice_remaining_index],
                    side,
                    taker_limit_price,
                    amm_views[tied.idx].mid_price,
                    Some(next_start),
                )?;
            }
            FrontierSource::DlobMaker => {
                // DLOB frontiers are single-level; once exhausted, they're gone.
                frontiers[tied.idx] = None;
            }
        }
    }
    Ok(())
}

/// Builds canonical (account_metas, maker_batches, ordered midprice indices) for apply_fills CPI:
/// sorts external_fills by (midprice, maker, sequence) so each maker appears once, then coalesces
/// by (abs_index, is_ask). Used by apply_external_fills_via_cpi and by tests to assert no regression.
pub(crate) fn build_canonical_apply_fills_accounts_and_batches<'a>(
    remaining_accounts: &[AccountInfo<'a>],
    external_fills: &[PendingExternalFill],
    matcher_authority: &AccountInfo<'a>,
    clock: &AccountInfo<'a>,
) -> DriftResult<(
    Vec<AccountMeta>,
    Vec<(u64, Vec<(u16, bool, u64)>)>,
    Vec<usize>,
)> {
    if external_fills.is_empty() {
        return Ok((
            vec![
                AccountMeta::new_readonly(matcher_authority.key(), true),
                AccountMeta::new_readonly(clock.key(), false),
            ],
            vec![],
            vec![],
        ));
    }

    // Canonicalize: sort by (midprice, maker, sequence) so fills for the same maker are contiguous.
    // Secondary sort by (abs_index, is_ask) for deterministic coalescing.
    let mut canonical: Vec<PendingExternalFill> = external_fills.to_vec();
    canonical.sort_by_key(|pf| {
        (
            pf.midprice_remaining_index,
            pf.maker_user_remaining_index,
            pf.sequence_number_snapshot,
            pf.fill.abs_index,
            pf.fill.is_ask,
        )
    });

    let mut coalesced: Vec<(u16, bool, u64)> = Vec::new();
    let mut maker_batches: Vec<(u64, Vec<(u16, bool, u64)>)> = Vec::new();
    let mut midprice_indices: Vec<usize> = Vec::new();
    let mut accounts: Vec<AccountMeta> = vec![
        AccountMeta::new_readonly(matcher_authority.key(), true),
        AccountMeta::new_readonly(clock.key(), false),
    ];
    let mut range_start = 0usize;

    while range_start < canonical.len() {
        let current_midprice_idx = canonical[range_start].midprice_remaining_index;
        let expected_sequence = canonical[range_start].sequence_number_snapshot;
        let mut range_end = range_start;
        while range_end < canonical.len()
            && canonical[range_end].midprice_remaining_index == current_midprice_idx
            && canonical[range_end].maker_user_remaining_index
                == canonical[range_start].maker_user_remaining_index
        {
            range_end += 1;
        }

        // Coalesce fills for the same (abs_index, is_ask) within this group (deterministic order via BTreeMap).
        let mut by_level: BTreeMap<(u16, bool), u64> = BTreeMap::new();
        for pending in &canonical[range_start..range_end] {
            let k = (pending.fill.abs_index, pending.fill.is_ask);
            *by_level.entry(k).or_insert(0) += pending.fill.fill_size;
        }
        coalesced.clear();
        for ((abs_index, is_ask), fill_size) in &by_level {
            coalesced.push((*abs_index, *is_ask, *fill_size));
        }
        maker_batches.push((expected_sequence, coalesced.clone()));
        midprice_indices.push(current_midprice_idx);

        accounts.push(AccountMeta::new(
            remaining_accounts[current_midprice_idx].key(),
            false,
        ));

        range_start = range_end;
    }

    Ok((accounts, maker_batches, midprice_indices))
}

/// Single CPI to midprice_pino apply_fills: [matcher, clock, midprice_0, midprice_1, ...],
/// payload: u16 market_index (CPI protection) then, per maker, `u16 num_fills`,
/// `u64 expected_sequence_number` (snapshot when matching), and 11*num_fills bytes of entries.
/// No authority accounts; filling is permissionless.
fn apply_external_fills_via_cpi<'a>(
    midprice_program: &AccountInfo<'a>,
    remaining_accounts: &[AccountInfo<'a>],
    clock: &AccountInfo<'a>,
    external_fills: &[PendingExternalFill],
    global_matcher_idx: usize,
    market_index: u16,
    program_id: &Pubkey,
) -> DriftResult<()> {
    if external_fills.is_empty() {
        return Ok(());
    }
    let (expected_matcher, bump) = prop_amm_matcher_pda(program_id);
    let matcher_authority = &remaining_accounts[global_matcher_idx];
    validate!(
        matcher_authority.key() == expected_matcher,
        ErrorCode::InvalidPropAmmMatcherAccount,
        "matcher must be global PropAMM matcher PDA"
    )?;

    let (accounts, maker_batches, midprice_indices) =
        build_canonical_apply_fills_accounts_and_batches(
            remaining_accounts,
            external_fills,
            matcher_authority,
            clock,
        )?;

    let batches_ref: Vec<(u64, &[(u16, bool, u64)])> = maker_batches
        .iter()
        .map(|(seq, fills)| (*seq, fills.as_slice()))
        .collect();
    let mut payload = Vec::new();
    write_apply_fills_instruction_data(&mut VecSink(&mut payload), market_index, &batches_ref);

    let mut cpi_accounts: Vec<AccountInfo> = vec![matcher_authority.clone(), clock.clone()];
    for &idx in &midprice_indices {
        cpi_accounts.push(remaining_accounts[idx].clone());
    }
    let ix = Instruction {
        program_id: midprice_program.key(),
        accounts,
        data: payload,
    };
    let signer_seeds: &[&[u8]] = &[PROP_AMM_MATCHER_SEED, &[bump]];
    invoke_signed(&ix, &cpi_accounts, &[signer_seeds]).map_err(|e| {
        msg!("midprice apply_fills CPI: {:?}", e);
        ErrorCode::InvalidMidpriceAccount
    })
}

fn flush_external_fill_batches<'a>(
    midprice_program: &AccountInfo<'a>,
    remaining_accounts: &[AccountInfo<'a>],
    clock: &AccountInfo<'a>,
    external_fills: &[PendingExternalFill],
    global_matcher_idx: usize,
    market_index: u16,
    program_id: &Pubkey,
) -> DriftResult<()> {
    apply_external_fills_via_cpi(
        midprice_program,
        remaining_accounts,
        clock,
        external_fills,
        global_matcher_idx,
        market_index,
        program_id,
    )
}

/// Finds the index of the global PropAMM matcher PDA in remaining_accounts.
/// Layout: remaining_accounts[0] = midprice program, [1..search_start] = live oracles (optional),
/// [search_start..amm_start] = spot markets, [amm_start] = matcher PDA.
/// `search_start` is the index to begin scanning for the matcher PDA (skipping live oracles).
fn find_amm_start_after_spot_markets(
    remaining_accounts: &[AccountInfo],
    program_id: &Pubkey,
    search_start: usize,
) -> DriftResult<usize> {
    let (expected_matcher, _bump) = prop_amm_matcher_pda(program_id);
    remaining_accounts[search_start..]
        .iter()
        .position(|a| a.key() == expected_matcher)
        .map(|pos| search_start + pos)
        .ok_or_else(|| ErrorCode::InvalidPropAmmMatcherAccount.into())
}

/// Midprice accounts have a 4-byte "midp" discriminator at offset 0 and are owned by the
/// midprice program. This is used to detect the PropAMM/DLOB boundary in remaining_accounts.
fn is_midprice_account(info: &AccountInfo, midprice_program_id: &Pubkey) -> bool {
    *info.owner == *midprice_program_id
        && info.data_len() >= 4
        && info.try_borrow_data().map_or(false, |d| &d[..4] == b"midp")
}

/// Parses remaining_accounts after the global matcher PDA.
///
/// Layout: `(midprice_account, maker_user)* (dlob_maker_user)*`
///
/// PropAMM pairs are detected by the "midp" discriminator on the first account of each pair.
/// Once a non-midprice account is encountered, the rest are treated as DLOB maker User accounts.
///
/// Returns `(midprice_program_account_index, amm_views, dlob_start_index)`.
pub(crate) fn parse_amm_views<'info>(
    remaining_accounts: &'info [AccountInfo<'info>],
    amm_start: usize,
    program_id: &Pubkey,
    current_slot: u64,
    order_market_index: Option<u16>,
    taker_user_key: Option<&Pubkey>,
) -> DriftResult<(usize, Vec<AmmView>, usize)> {
    const ACCOUNTS_PER_AMM: usize = 2; // midprice, maker_user (global matcher is separate)
    const GLOBAL_MATCHER_SLOTS: usize = 1;

    // 0: midprice program
    let midprice_program = &remaining_accounts[0];
    validate!(
        midprice_program.executable,
        ErrorCode::InvalidMidpriceAccount,
        "remaining_accounts[0] must be an executable program (midprice program)"
    )?;
    let expected_midprice_program_id = crate::ids::midprice_program::id();
    validate!(
        midprice_program.key() == expected_midprice_program_id,
        ErrorCode::InvalidMidpriceAccount,
        "remaining_accounts[0] must be the canonical midprice program (prevent CPI to arbitrary program)"
    )?;

    // amm_start: global matcher PDA
    let (expected_matcher, _bump) = prop_amm_matcher_pda(program_id);
    validate!(
        remaining_accounts[amm_start].key() == expected_matcher,
        ErrorCode::InvalidPropAmmMatcherAccount,
        "account after spot_markets must be the global PropAMM matcher PDA"
    )?;

    // Build reserved key set: all "global" accounts that must not overlap with any AMM pair.
    let mut reserved: BTreeSet<Pubkey> = BTreeSet::new();
    for i in 0..(amm_start + GLOBAL_MATCHER_SLOTS) {
        reserved.insert(remaining_accounts[i].key());
    }

    let tail_start = amm_start + GLOBAL_MATCHER_SLOTS;
    let midprice_program_key = midprice_program.key;

    let mut amm_views: Vec<AmmView> = Vec::with_capacity(8);
    let mut seen_midprices: BTreeSet<Pubkey> = BTreeSet::new();
    let mut seen_makers: BTreeSet<Pubkey> = BTreeSet::new();

    // Scan pairs: PropAMM pairs are detected by the "midp" discriminator.
    let mut cursor = tail_start;
    while cursor + 1 < remaining_accounts.len() {
        let candidate = &remaining_accounts[cursor];
        if !is_midprice_account(candidate, midprice_program_key) {
            break; // boundary found — remaining accounts are DLOB makers
        }

        let midprice_info = candidate;
        let maker_user_info = &remaining_accounts[cursor + 1];
        let midprice_key = midprice_info.key();
        let maker_user_key = maker_user_info.key();

        // Disallow overlap between any AMM account and the global accounts.
        validate!(
            !reserved.contains(&midprice_key),
            ErrorCode::InvalidPropAmmAccountLayout,
            "midprice account must not overlap with global accounts (midprice={})",
            midprice_key
        )?;
        validate!(
            !reserved.contains(&maker_user_key),
            ErrorCode::InvalidPropAmmAccountLayout,
            "maker user must not overlap with global accounts (maker_user={})",
            maker_user_key
        )?;

        validate!(
            midprice_key != maker_user_key,
            ErrorCode::InvalidPropAmmAccountLayout,
            "midprice and maker_user must be different accounts (key={})",
            midprice_key
        )?;

        validate!(
            seen_midprices.insert(midprice_key),
            ErrorCode::InvalidPropAmmAccountLayout,
            "duplicate midprice account (midprice={})",
            midprice_key
        )?;
        validate!(
            seen_makers.insert(maker_user_key),
            ErrorCode::InvalidPropAmmAccountLayout,
            "duplicate maker user (maker_user={})",
            maker_user_key
        )?;

        validate!(
            *maker_user_info.owner == *program_id,
            ErrorCode::CouldNotDeserializeMaker,
            "maker user must be owned by Drift program (maker_user={}, owner={})",
            maker_user_key,
            maker_user_info.owner
        )?;
        validate!(
            maker_user_info.is_writable,
            ErrorCode::MakerMustBeWritable,
            "maker user must be writable (maker_user={})",
            maker_user_key
        )?;

        let (mid_price, sequence_number_snapshot, midprice_market_index) =
            match read_external_mid_price(
                midprice_info,
                midprice_program_key,
                maker_user_info,
                current_slot,
            ) {
                Ok(result) => result,
                Err(err) if err == ErrorCode::MidpriceQuoteExpired.into() => {
                    cursor += ACCOUNTS_PER_AMM;
                    continue;
                }
                Err(err) => return Err(err),
            };

        if let Some(order_mi) = order_market_index {
            validate!(
                midprice_market_index == order_mi,
                ErrorCode::InvalidMidpriceAccount,
                "midprice market_index must match order market"
            )?;
        }
        if let Some(taker) = taker_user_key {
            validate!(
                maker_user_key != *taker,
                ErrorCode::MakerCantFulfillOwnOrder,
                "taker cannot be same as maker (no self-trade)"
            )?;
        }

        {
            let maker_loader: AccountLoader<User> = AccountLoader::try_from(maker_user_info)
                .map_err(|_| ErrorCode::CouldNotDeserializeMaker)?;
            let maker = maker_loader
                .load()
                .map_err(|_| ErrorCode::CouldNotLoadUserData)?;
            if maker.is_being_liquidated() || maker.is_bankrupt() {
                cursor += ACCOUNTS_PER_AMM;
                continue;
            }
        }

        amm_views.push(AmmView {
            key: midprice_key,
            mid_price,
            sequence_number_snapshot,
            maker_user_remaining_index: cursor + 1,
            midprice_remaining_index: cursor,
        });

        cursor += ACCOUNTS_PER_AMM;
    }

    // Return: midprice_program idx, parsed PropAMM views, start of DLOB accounts.
    Ok((0, amm_views, cursor))
}

/// Parse DLOB maker accounts from remaining_accounts starting at `dlob_start`.
/// Each DLOB maker is a `(User, UserStats)` pair. We scan their open orders to find
/// crossing limit orders for the given market + direction.
///
/// Returns `(views sorted by price, index after last DLOB pair)` — the second value
/// is where optional referrer accounts begin.
fn maker_order_matches_fill_perp_order2_taker(
    maker_order: &Order,
    taker_is_resting_limit_order: bool,
    taker_auction_end_slot: u64,
    slot: u64,
) -> DriftResult<bool> {
    if !maker_order.is_resting_limit_order(slot)? {
        return Ok(false);
    }

    if !taker_is_resting_limit_order || maker_order.post_only {
        return Ok(true);
    }

    Ok(maker_order
        .slot
        .safe_add(maker_order.auction_duration.cast()?)?
        <= taker_auction_end_slot)
}

pub(crate) fn parse_dlob_makers<'info>(
    remaining_accounts: &'info [AccountInfo<'info>],
    dlob_start: usize,
    program_id: &Pubkey,
    taker_user_key: &Pubkey,
    taker_direction: PositionDirection,
    market_index: u16,
    limit_price: u64,
    oracle_price: i64,
    slot: u64,
    now: i64,
    order_tick_size: u64,
    is_prediction_market: bool,
    taker_is_resting_limit_order: bool,
    taker_auction_end_slot: u64,
    taker_order_age: u64,
    user_can_skip_duration: bool,
    protected_maker_params: crate::state::protected_maker_mode_config::ProtectedMakerParams,
    protected_maker_min_age: u64,
    market_margin_ratio_initial: u32,
    order_step_size: u64,
) -> DriftResult<(Vec<DlobMakerView>, usize)> {
    let maker_direction = taker_direction.opposite();
    let mut views: Vec<DlobMakerView> = Vec::with_capacity(8);

    let mut idx = dlob_start;
    while idx + 1 < remaining_accounts.len() {
        let maker_info = &remaining_accounts[idx];
        let maker_stats_info = &remaining_accounts[idx + 1];
        let maker_key = maker_info.key();

        // Try to load as User — if it fails, we've reached the end of DLOB pairs
        // (possibly referrer accounts or nothing left).
        if *maker_info.owner != *program_id {
            break;
        }

        let maker_loader: AccountLoader<User> = match AccountLoader::try_from(maker_info) {
            Ok(loader) => loader,
            Err(_) => break,
        };

        validate!(
            maker_info.is_writable,
            ErrorCode::MakerMustBeWritable,
            "DLOB maker must be writable (maker={})",
            maker_key
        )?;
        validate!(
            maker_key != *taker_user_key,
            ErrorCode::MakerCantFulfillOwnOrder,
            "DLOB maker cannot be taker (no self-trade)"
        )?;

        // Validate maker_stats account.
        validate!(
            *maker_stats_info.owner == *program_id,
            ErrorCode::InvalidUserStatsAccount,
            "DLOB maker_stats must be owned by Drift program (maker_stats={})",
            maker_stats_info.key()
        )?;
        // Verify maker_stats authority matches maker authority.
        {
            let maker = maker_loader
                .load()
                .map_err(|_| ErrorCode::CouldNotLoadUserData)?;
            let maker_stats_loader: AccountLoader<UserStats> =
                AccountLoader::try_from(maker_stats_info)
                    .map_err(|_| ErrorCode::CouldNotDeserializeMakerStats)?;
            let maker_stats = maker_stats_loader
                .load()
                .map_err(|_| ErrorCode::CouldNotDeserializeMakerStats)?;
            validate!(
                maker_stats.authority == maker.authority,
                ErrorCode::InvalidUserStatsAccount,
                "DLOB maker_stats authority must match maker authority"
            )?;
        }

        let maker = maker_loader
            .load()
            .map_err(|_| ErrorCode::CouldNotLoadUserData)?;

        if maker.is_being_liquidated() || maker.is_bankrupt() {
            idx += 2;
            continue;
        }

        let maker_protected_params = if maker.is_protected_maker()
            && !user_can_skip_duration
            && taker_order_age < protected_maker_min_age
        {
            Some(protected_maker_params)
        } else {
            None
        };

        for (order_index, order) in maker.orders.iter().enumerate() {
            if order.status != OrderStatus::Open {
                continue;
            }

            if order.direction != maker_direction
                || order.market_type != MarketType::Perp
                || order.market_index != market_index
            {
                continue;
            }

            if !order.is_limit_order() || (order.must_be_triggered() && !order.triggered()) {
                continue;
            }

            let order_price = order.force_get_limit_price(
                Some(oracle_price),
                None,
                slot,
                order_tick_size,
                is_prediction_market,
                maker_protected_params,
            )?;

            if !maker_order_matches_fill_perp_order2_taker(
                order,
                taker_is_resting_limit_order,
                taker_auction_end_slot,
                slot,
            )? {
                continue;
            }

            if limit_price_breaches_maker_oracle_price_bands(
                order_price,
                order.direction,
                oracle_price,
                market_margin_ratio_initial,
            )? {
                continue;
            }

            if should_expire_order(&maker, order_index, now)? {
                continue;
            }

            let existing_position = maker
                .get_perp_position(market_index)
                .map_or(0_i64, |p| p.base_asset_amount);
            if should_cancel_reduce_only_order(order, existing_position, order_step_size)? {
                continue;
            }
            let size = order.get_base_asset_amount_unfilled(Some(existing_position))?;
            if size == 0 {
                continue;
            }
            // Check crossing.
            let crosses = match taker_direction {
                PositionDirection::Long => order_price <= limit_price,
                PositionDirection::Short => order_price >= limit_price,
            };
            if !crosses {
                continue;
            }
            views.push(DlobMakerView {
                maker_key,
                order_index,
                price: order_price,
                size,
                remaining_account_index: idx,
                maker_stats_remaining_index: idx + 1,
            });
        }
        idx += 2;
    }

    // Sort by price: best for taker first.
    views.sort_by(|a, b| match taker_direction {
        PositionDirection::Long => a.price.cmp(&b.price), // ascending (lowest ask first)
        PositionDirection::Short => b.price.cmp(&a.price), // descending (highest bid first)
    });

    Ok((views, idx))
}

/// Resolve optional referrer (User, UserStats) from remaining_accounts.
/// Returns `Some((referrer_user_key, referrer_user_remaining_idx, referrer_stats_remaining_idx))`
/// if the taker has a referrer and the accounts are present.
fn resolve_referrer<'info>(
    taker_stats: &crate::state::user::UserStats,
    remaining_accounts: &'info [AccountInfo<'info>],
    start: usize,
    program_id: &Pubkey,
    slot: u64,
) -> DriftResult<Option<(Pubkey, usize, usize)>> {
    if taker_stats.referrer == Pubkey::default() {
        return Ok(None);
    }

    if start + 1 >= remaining_accounts.len() {
        return Err(ErrorCode::ReferrerNotFound.into());
    }

    let referrer_user_info = &remaining_accounts[start];
    let referrer_stats_info = &remaining_accounts[start + 1];

    validate!(
        *referrer_user_info.owner == *program_id,
        ErrorCode::InvalidReferrer,
        "referrer user must be owned by Drift program"
    )?;
    validate!(
        *referrer_stats_info.owner == *program_id,
        ErrorCode::CouldNotDeserializeReferrerStats,
        "referrer stats must be owned by Drift program"
    )?;
    validate!(
        referrer_user_info.is_writable,
        ErrorCode::ReferrerMustBeWritable,
        "referrer user must be writable"
    )?;
    validate!(
        referrer_stats_info.is_writable,
        ErrorCode::ReferrerStatsMustBeWritable,
        "referrer stats must be writable"
    )?;

    let referrer_loader: AccountLoader<User> = AccountLoader::try_from(referrer_user_info)
        .map_err(|_| ErrorCode::CouldNotDeserializeReferrer)?;
    let referrer = referrer_loader
        .load()
        .map_err(|_| ErrorCode::CouldNotDeserializeReferrer)?;

    validate!(
        referrer.authority == taker_stats.referrer,
        ErrorCode::DidNotReceiveExpectedReferrer,
        "referrer user authority must match taker_stats.referrer"
    )?;
    validate!(
        referrer.sub_account_id == 0,
        ErrorCode::InvalidReferrer,
        "referrer must be sub_account_id 0"
    )?;
    validate!(
        referrer.pool_id == 0,
        ErrorCode::InvalidReferrer,
        "referrer must be pool_id 0"
    )?;

    let referrer_stats_loader: AccountLoader<UserStats> =
        AccountLoader::try_from(referrer_stats_info)
            .map_err(|_| ErrorCode::CouldNotDeserializeReferrerStats)?;
    let referrer_stats = referrer_stats_loader
        .load()
        .map_err(|_| ErrorCode::CouldNotDeserializeReferrerStats)?;

    validate!(
        referrer_stats.authority == taker_stats.referrer,
        ErrorCode::ReferrerAndReferrerStatsAuthorityUnequal,
        "referrer stats authority must match taker_stats.referrer"
    )?;

    drop(referrer);
    drop(referrer_stats);

    // Update last active slot on referrer.
    {
        let mut referrer_mut = referrer_loader
            .load_mut()
            .map_err(|_| ErrorCode::CouldNotLoadUserData)?;
        referrer_mut.update_last_active_slot(slot);
    }

    Ok(Some((referrer_user_info.key(), start, start + 1)))
}

/// Filter out makers that would breach margin after their fill. Returns filtered maker_deltas,
/// filtered external_fills, and recomputed taker_base_delta, taker_quote_delta, total_quote_volume
/// so that only solvent makers are applied (skip semantics: one insolvent maker does not revert the tx).
pub(crate) fn filter_prop_amm_makers_by_margin<'a>(
    maker_deltas: &BTreeMap<Pubkey, (i64, i64)>,
    external_fills: &[PendingExternalFill],
    amm_views: &[AmmView],
    remaining_accounts: &'a [AccountInfo<'a>],
    perp_market_map: &PerpMarketMap,
    spot_market_map: &SpotMarketMap,
    oracle_map: &mut OracleMap,
    market_index: u16,
    now: i64,
) -> DriftResult<(
    BTreeMap<Pubkey, (i64, i64)>,
    Vec<PendingExternalFill>,
    i64,
    i64,
    u64,
)> {
    let amm_view_by_maker: BTreeMap<Pubkey, usize> = amm_views
        .iter()
        .enumerate()
        .map(|(i, v)| (remaining_accounts[v.maker_user_remaining_index].key(), i))
        .collect();

    let mut solvent_keys = std::collections::BTreeSet::new();
    for (maker_user_key, &(base_delta, quote_delta)) in maker_deltas {
        if base_delta == 0 && quote_delta == 0 {
            solvent_keys.insert(*maker_user_key);
            continue;
        }
        let amm_view = &amm_views[*amm_view_by_maker
            .get(maker_user_key)
            .ok_or(ErrorCode::MakerNotFound)?];
        let maker_info = &remaining_accounts[amm_view.maker_user_remaining_index];
        let maker_loader: AccountLoader<User> =
            AccountLoader::try_from(maker_info).map_err(|_| ErrorCode::CouldNotLoadUserData)?;
        let mut maker_for_margin = maker_loader
            .load_mut()
            .map_err(|_| ErrorCode::CouldNotLoadUserData)?;

        // Temporarily mutate maker position to simulate post-fill state for margin calc.
        let pos_idx = get_position_index(&maker_for_margin.perp_positions, market_index)
            .or_else(|_| add_new_position(&mut maker_for_margin.perp_positions, market_index))?;

        // Save original position fields.
        let orig_base = maker_for_margin.perp_positions[pos_idx].base_asset_amount;
        let orig_quote = maker_for_margin.perp_positions[pos_idx].quote_asset_amount;
        let orig_entry = maker_for_margin.perp_positions[pos_idx].quote_entry_amount;
        let orig_breakeven = maker_for_margin.perp_positions[pos_idx].quote_break_even_amount;

        // Apply simulated delta.
        maker_for_margin.perp_positions[pos_idx].base_asset_amount =
            orig_base.safe_add(base_delta)?;
        maker_for_margin.perp_positions[pos_idx].quote_asset_amount =
            orig_quote.safe_add(quote_delta)?;
        maker_for_margin.perp_positions[pos_idx].quote_entry_amount =
            orig_entry.safe_add(quote_delta)?;
        maker_for_margin.perp_positions[pos_idx].quote_break_even_amount =
            orig_breakeven.safe_add(quote_delta)?;

        // Determine margin type from simulated positions.
        let pos_before = orig_base;
        let pos_after = maker_for_margin.perp_positions[pos_idx].base_asset_amount;
        let position_decreasing = pos_after == 0
            || (pos_after.signum() == pos_before.signum() && pos_after.abs() < pos_before.abs());
        let maker_margin_type = if position_decreasing {
            MarginRequirementType::Maintenance
        } else {
            MarginRequirementType::Fill
        };
        let maker_margin_context = MarginContext::standard(maker_margin_type)
            .fuel_perp_delta(market_index, -base_delta)
            .fuel_numerator(&maker_for_margin, now);
        let maker_margin_calc =
            match calculate_margin_requirement_and_total_collateral_and_liability_info(
                &maker_for_margin,
                perp_market_map,
                spot_market_map,
                oracle_map,
                maker_margin_context,
            ) {
                Ok(calc) => calc,
                Err(e) if e == ErrorCode::OracleNotFound => {
                    // Missing oracle for a maker position — skip this maker.
                    maker_for_margin.perp_positions[pos_idx].base_asset_amount = orig_base;
                    maker_for_margin.perp_positions[pos_idx].quote_asset_amount = orig_quote;
                    maker_for_margin.perp_positions[pos_idx].quote_entry_amount = orig_entry;
                    maker_for_margin.perp_positions[pos_idx].quote_break_even_amount =
                        orig_breakeven;
                    msg!(
                        "Skipping PropAMM maker {} due to missing oracle",
                        maker_user_key
                    );
                    continue;
                }
                Err(e) => return Err(e),
            };

        // Restore original position fields.
        maker_for_margin.perp_positions[pos_idx].base_asset_amount = orig_base;
        maker_for_margin.perp_positions[pos_idx].quote_asset_amount = orig_quote;
        maker_for_margin.perp_positions[pos_idx].quote_entry_amount = orig_entry;
        maker_for_margin.perp_positions[pos_idx].quote_break_even_amount = orig_breakeven;

        if maker_margin_calc.meets_margin_requirement() {
            solvent_keys.insert(*maker_user_key);
        }
    }

    let filtered_maker_deltas: BTreeMap<Pubkey, (i64, i64)> = maker_deltas
        .iter()
        .filter(|(k, _)| solvent_keys.contains(*k))
        .map(|(k, v)| (*k, *v))
        .collect();

    let filtered_external_fills: Vec<PendingExternalFill> = external_fills
        .iter()
        .filter(|pf| {
            solvent_keys.contains(&remaining_accounts[pf.maker_user_remaining_index].key())
        })
        .copied()
        .collect();

    let mut taker_base_delta = 0i64;
    let mut taker_quote_delta = 0i64;
    let mut total_quote_volume = 0u64;
    for (_, (base, quote)) in &filtered_maker_deltas {
        taker_base_delta = taker_base_delta.safe_sub(*base)?;
        taker_quote_delta = taker_quote_delta.safe_sub(*quote)?;
        total_quote_volume = total_quote_volume.safe_add(quote.unsigned_abs())?;
    }

    Ok((
        filtered_maker_deltas,
        filtered_external_fills,
        taker_base_delta,
        taker_quote_delta,
        total_quote_volume,
    ))
}

/// Unified matching loop: fills from PropAMM books and DLOB makers in price-priority order.
///
/// Discrete frontiers use pro-rata (PropAMM) / sequential (DLOB) allocation.
/// vAMM fills are handled by the cranker interleaving `fill_perp_order` in the same atomic tx.
pub(crate) fn run_unified_matching(
    amm_views: &[AmmView],
    dlob_makers: &[DlobMakerView],
    remaining_accounts: &[AccountInfo],
    side: PositionDirection,
    limit_price: u64,
    size: u64,
) -> DriftResult<UnifiedMatchResult> {
    let mut remaining = size;
    let (mut frontiers, num_prop_amm) = init_frontiers(
        amm_views,
        dlob_makers,
        remaining_accounts,
        &side,
        limit_price,
    )?;
    let mut result = UnifiedMatchResult::default();

    while remaining > 0 {
        // Best discrete frontier (PropAMM books + DLOB makers).
        let Some((best_price, tied_levels)) = tied_frontiers_at_best_price(&frontiers, &side)
        else {
            break;
        };
        let (fill, allocations) = allocate_fill(&tied_levels, remaining)?;
        if fill == 0 {
            break;
        }
        for allocation in allocations {
            if allocation.share == 0 {
                continue;
            }
            match allocation.level.source {
                FrontierSource::PropAmm => {
                    let amm_view = &amm_views[allocation.idx];
                    result.external_fills.push(PendingExternalFill {
                        midprice_remaining_index: amm_view.midprice_remaining_index,
                        maker_user_remaining_index: amm_view.maker_user_remaining_index,
                        sequence_number_snapshot: amm_view.sequence_number_snapshot,
                        fill: ExternalFill {
                            abs_index: allocation.level.abs_index as u16,
                            is_ask: allocation.level.is_ask,
                            fill_size: allocation.share,
                        },
                    });
                    // quote = base * price / AMM_RESERVE_PRECISION
                    let fill_quote_u128 = (allocation.share as u128)
                        .checked_mul(best_price as u128)
                        .ok_or(ErrorCode::MathError)?
                        .checked_div(AMM_RESERVE_PRECISION)
                        .ok_or(ErrorCode::MathError)?;
                    let fill_quote_u64 =
                        u64::try_from(fill_quote_u128).map_err(|_| ErrorCode::MathError)?;
                    result.total_quote_volume =
                        result.total_quote_volume.safe_add(fill_quote_u64)?;
                    let share_i64 =
                        i64::try_from(allocation.share).map_err(|_| ErrorCode::MathError)?;
                    let fill_quote_i64 =
                        i64::try_from(fill_quote_u128).map_err(|_| ErrorCode::MathError)?;
                    let (base_delta, quote_delta) = if matches!(side, PositionDirection::Long) {
                        (share_i64, -fill_quote_i64)
                    } else {
                        (-share_i64, fill_quote_i64)
                    };
                    result.taker_base_delta = result.taker_base_delta.safe_add(base_delta)?;
                    result.taker_quote_delta = result.taker_quote_delta.safe_add(quote_delta)?;
                    let maker_pubkey =
                        remaining_accounts[amm_view.maker_user_remaining_index].key();
                    let entry = result.maker_deltas.entry(maker_pubkey).or_insert((0, 0));
                    entry.0 = entry.0.safe_add(-base_delta)?;
                    entry.1 = entry.1.safe_add(-quote_delta)?;
                }
                FrontierSource::DlobMaker => {
                    // DLOB frontier index maps to dlob_makers[allocation.idx - num_prop_amm].
                    let dlob_idx = allocation
                        .idx
                        .checked_sub(num_prop_amm)
                        .ok_or(ErrorCode::MathError)?;
                    let dlob = &dlob_makers[dlob_idx];
                    result.dlob_fills.push(PendingDlobFill {
                        maker_key: dlob.maker_key,
                        order_index: dlob.order_index,
                        remaining_account_index: dlob.remaining_account_index,
                        maker_stats_remaining_index: dlob.maker_stats_remaining_index,
                        base_asset_amount: allocation.share,
                        price: best_price,
                    });
                }
            }
            if let Some(ref mut frontier) = frontiers[allocation.idx] {
                frontier.size = frontier.size.safe_sub(allocation.share)?;
            }
        }
        refresh_exhausted_frontiers(
            &mut frontiers,
            &tied_levels,
            amm_views,
            num_prop_amm,
            remaining_accounts,
            &side,
            limit_price,
        )?;
        remaining = remaining.safe_sub(fill)?;
    }
    Ok(result)
}

/// Legacy entry point: PropAMM-only matching (no AMM, no DLOB).
#[cfg(test)]
pub(crate) fn run_prop_amm_matching(
    amm_views: &[AmmView],
    remaining_accounts: &[AccountInfo],
    side: PositionDirection,
    limit_price: u64,
    size: u64,
) -> DriftResult<UnifiedMatchResult> {
    run_unified_matching(amm_views, &[], remaining_accounts, side, limit_price, size)
}

/// Match taker perp order against prop AMM (midprice) liquidity. Permissionless: anyone may call.
///
/// Security / audit checklist (Solana smart contract vulnerabilities):
/// - **Signer / auth**: Permissionless; no signer required (order is looked up by id from user account).
/// - **Account ownership**: Maker user/stats validated in parse (owner == Drift); midprice in read_external_mid_price.
/// - **Account-type / wrong account**: perp_market.market_index == order market_index; oracle validated via valid_oracle_for_perp_market.
/// - **Integer overflow**: SafeMath / checked_mul / try_from used; pro-rata remainder capped so allocation.share <= level.size.
/// - **PDA**: Matcher PDA derived and validated in apply_external_fills_batch_via_cpi; invoke_signed with correct seeds.
/// - **Reentrancy**: No state read after CPI; CPI is last step.
/// - **Cross-program**: only Drift's matcher PDA can apply_fills (hardcoded in midprice_pino); midprice market_index validated.
/// - **Self-trade**: parse_amm_views rejects when taker_user_key equals any maker (no self-trade).

/// Creates the global PropAMM matcher PDA so that midprice_pino's fill CPI can verify matcher.owner() == Drift.
/// Idempotent: safe to call if the account already exists (skips creation when already owned by program).
pub fn handle_initialize_prop_amm_matcher(ctx: Context<InitializePropAmmMatcher>) -> Result<()> {
    if ctx.accounts.prop_amm_matcher.owner == ctx.program_id
        && ctx.accounts.prop_amm_matcher.lamports() > 0
    {
        return Ok(());
    }
    let seeds: &[&[u8]] = &[PROP_AMM_MATCHER_SEED];
    pda::seed_and_create_pda(
        ctx.program_id,
        &ctx.accounts.payer.to_account_info(),
        &Rent::get()?,
        1_usize, // minimum space so account is owned by program
        ctx.program_id,
        &ctx.accounts.system_program.to_account_info(),
        &ctx.accounts.prop_amm_matcher,
        seeds,
    )?;
    Ok(())
}

#[derive(Accounts)]
pub struct InitializePropAmmMatcher<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(
        mut,
        seeds = [PROP_AMM_MATCHER_SEED],
        bump,
    )]
    /// CHECK: Created by seed_and_create_pda; owner set to program_id so midprice_pino accepts it as matcher.
    pub prop_amm_matcher: AccountInfo<'info>,
    pub rent: Sysvar<'info, Rent>,
    pub system_program: Program<'info, System>,
}

/// Initializes a midprice (Prop AMM) account via CPI to the midprice program.
/// Caller must have created the midprice account at the PDA derived by the midprice program
/// (seeds: ["midprice", market_index, authority, subaccount_index]) with sufficient space.
/// Drift supplies the perp_market account so the client does not need to load it.
pub fn handle_initialize_prop_amm_midprice(
    ctx: Context<InitializePropAmmMidprice>,
    subaccount_index: u16,
) -> Result<()> {
    validate!(
        ctx.accounts.midprice_program.key() == crate::ids::midprice_program::id(),
        ErrorCode::InvalidMidpriceAccount,
        "midprice_program must be the canonical midprice program"
    )?;
    validate!(
        ctx.accounts.midprice_program.executable,
        ErrorCode::InvalidMidpriceAccount,
        "midprice_program must be executable"
    )?;
    let perp_market = ctx.accounts.perp_market.load()?;
    let market_index = perp_market.market_index;
    let order_tick_size = perp_market.amm.order_tick_size;
    let min_order_size = perp_market.amm.min_order_size;

    let (expected_matcher, bump) = prop_amm_matcher_pda(ctx.program_id);
    validate!(
        ctx.accounts.prop_amm_matcher.key() == expected_matcher,
        ErrorCode::InvalidPropAmmMatcherAccount,
        "prop_amm_matcher must be the global PropAMM matcher PDA"
    )?;

    let mut data = vec![MIDPRICE_IX_INITIALIZE];
    data.extend_from_slice(&market_index.to_le_bytes());
    data.extend_from_slice(&subaccount_index.to_le_bytes());
    data.extend_from_slice(&order_tick_size.to_le_bytes());
    data.extend_from_slice(&min_order_size.to_le_bytes());

    let accounts = vec![
        AccountMeta::new(ctx.accounts.midprice_account.key(), false),
        AccountMeta::new_readonly(ctx.accounts.authority.key(), true),
        AccountMeta::new_readonly(ctx.accounts.prop_amm_matcher.key(), true),
    ];
    let ix = Instruction {
        program_id: ctx.accounts.midprice_program.key(),
        accounts,
        data,
    };
    let cpi_accounts = [
        ctx.accounts.midprice_account.to_account_info(),
        ctx.accounts.authority.to_account_info(),
        ctx.accounts.prop_amm_matcher.to_account_info(),
    ];
    let signer_seeds: &[&[u8]] = &[PROP_AMM_MATCHER_SEED, &[bump]];
    invoke_signed(&ix, &cpi_accounts, &[signer_seeds]).map_err(|e| {
        msg!("midprice initialize CPI: {:?}", e);
        anchor_lang::error::Error::from(ErrorCode::InvalidMidpriceAccount)
    })?;
    Ok(())
}

/// Updates order_tick_size and min_order_size on a midprice account via CPI. Drift reads current values from perp_market and forwards them.
pub fn handle_update_prop_amm_tick_sizes(ctx: Context<UpdatePropAmmTickSizes>) -> Result<()> {
    validate!(
        ctx.accounts.midprice_program.key() == crate::ids::midprice_program::id(),
        ErrorCode::InvalidMidpriceAccount,
        "midprice_program must be the canonical midprice program"
    )?;
    validate!(
        ctx.accounts.midprice_program.executable,
        ErrorCode::InvalidMidpriceAccount,
        "midprice_program must be executable"
    )?;
    let perp_market = ctx.accounts.perp_market.load()?;
    let order_tick_size = perp_market.amm.order_tick_size;
    let min_order_size = perp_market.amm.min_order_size;

    let (expected_matcher, bump) = prop_amm_matcher_pda(ctx.program_id);
    validate!(
        ctx.accounts.prop_amm_matcher.key() == expected_matcher,
        ErrorCode::InvalidPropAmmMatcherAccount,
        "prop_amm_matcher must be the global PropAMM matcher PDA"
    )?;

    let mut data = vec![MIDPRICE_IX_UPDATE_TICK_SIZES];
    data.extend_from_slice(&order_tick_size.to_le_bytes());
    data.extend_from_slice(&min_order_size.to_le_bytes());

    let accounts = vec![
        AccountMeta::new(ctx.accounts.midprice_account.key(), false),
        AccountMeta::new_readonly(ctx.accounts.authority.key(), true),
        AccountMeta::new_readonly(ctx.accounts.prop_amm_matcher.key(), true),
    ];
    let ix = Instruction {
        program_id: ctx.accounts.midprice_program.key(),
        accounts,
        data,
    };
    let cpi_accounts = [
        ctx.accounts.midprice_account.to_account_info(),
        ctx.accounts.authority.to_account_info(),
        ctx.accounts.prop_amm_matcher.to_account_info(),
    ];
    let signer_seeds: &[&[u8]] = &[PROP_AMM_MATCHER_SEED, &[bump]];
    invoke_signed(&ix, &cpi_accounts, &[signer_seeds]).map_err(|e| {
        msg!("midprice update_tick_sizes CPI: {:?}", e);
        anchor_lang::error::Error::from(ErrorCode::InvalidMidpriceAccount)
    })?;
    Ok(())
}

#[derive(Accounts)]
pub struct InitializePropAmmMidprice<'info> {
    pub authority: Signer<'info>,
    /// CHECK: Midprice account at the PDA derived by midprice program (seeds: midprice, market_index, authority, subaccount_index). Must be allocated before calling.
    #[account(mut)]
    pub midprice_account: AccountInfo<'info>,
    pub perp_market: AccountLoader<'info, PerpMarket>,
    /// CHECK: Executable midprice program; validated to be crate::ids::midprice_program::id().
    pub midprice_program: AccountInfo<'info>,
    #[account(
        seeds = [PROP_AMM_MATCHER_SEED],
        bump,
    )]
    /// CHECK: Global PropAMM matcher PDA; required by midprice init (CPI-only). Passed as signer via invoke_signed.
    pub prop_amm_matcher: AccountInfo<'info>,
}

#[derive(Accounts)]
pub struct UpdatePropAmmTickSizes<'info> {
    pub authority: Signer<'info>,
    /// CHECK: Midprice account to update; must be initialized and authority must match.
    #[account(mut)]
    pub midprice_account: AccountInfo<'info>,
    pub perp_market: AccountLoader<'info, PerpMarket>,
    /// CHECK: Executable midprice program; validated to be crate::ids::midprice_program::id().
    pub midprice_program: AccountInfo<'info>,
    #[account(
        seeds = [PROP_AMM_MATCHER_SEED],
        bump,
    )]
    /// CHECK: Global PropAMM matcher PDA; required by midprice update_tick_sizes (CPI-only).
    pub prop_amm_matcher: AccountInfo<'info>,
}

/// Consolidate PropAMM fee application: taker fee deduction, referrer reward credit,
/// market fee totals, taker stats, referrer stats.
fn apply_prop_amm_fill_fees<'a, 'info: 'a>(
    taker_loader: &AccountLoader<'info, User>,
    market: &mut PerpMarket,
    taker_stats_loader: &AccountLoader<'info, crate::state::user::UserStats>,
    remaining_accounts: &'info [AccountInfo<'info>],
    referrer_info: Option<(Pubkey, usize, usize)>,
    rev_share_escrow: &mut Option<
        &mut crate::state::revenue_share::RevenueShareEscrowZeroCopyMut<'info>,
    >,
    referrer_builder_order_idx: Option<u32>,
    fill_fees: &crate::math::fees::FillFees,
    market_index: u16,
    now: i64,
) -> DriftResult<()> {
    use crate::controller::position::update_quote_asset_amount;
    let taker_fee = fill_fees.user_fee;
    let builder_fee = fill_fees.builder_fee.unwrap_or(0);
    let fee_to_market = fill_fees.fee_to_market;
    let referrer_reward = fill_fees.referrer_reward;
    let referee_discount = fill_fees.referee_discount;

    // Deduct taker fee from taker quote position.
    if taker_fee > 0 || builder_fee > 0 {
        let mut taker = taker_loader
            .load_mut()
            .map_err(|_| ErrorCode::CouldNotLoadUserData)?;
        let taker_pos_idx = get_position_index(&taker.perp_positions, market_index)?;
        update_quote_asset_and_break_even_amount(
            &mut taker.perp_positions[taker_pos_idx],
            market,
            -(taker_fee.safe_add(builder_fee)? as i64),
        )?;
    }

    // Credit referrer reward.
    if referrer_reward > 0 {
        if let (Some(idx), Some(escrow)) =
            (referrer_builder_order_idx, rev_share_escrow.as_deref_mut())
        {
            let order = escrow.get_order_mut(idx)?;
            order.fees_accrued = order.fees_accrued.safe_add(referrer_reward)?;
        } else if let Some((_, referrer_user_idx, referrer_stats_idx)) = referrer_info {
            let referrer_user_info = &remaining_accounts[referrer_user_idx];
            let referrer_loader: AccountLoader<User> = AccountLoader::try_from(referrer_user_info)
                .map_err(|_| ErrorCode::CouldNotLoadUserData)?;
            let mut referrer = referrer_loader
                .load_mut()
                .map_err(|_| ErrorCode::CouldNotLoadUserData)?;
            if let Ok(referrer_position) = referrer.force_get_perp_position_mut(market_index) {
                update_quote_asset_amount(referrer_position, market, referrer_reward.cast()?)?;
            }
            drop(referrer);

            let referrer_stats_info = &remaining_accounts[referrer_stats_idx];
            let referrer_stats_loader: AccountLoader<crate::state::user::UserStats> =
                AccountLoader::try_from(referrer_stats_info)
                    .map_err(|_| ErrorCode::CouldNotLoadUserData)?;
            let mut referrer_stats = referrer_stats_loader
                .load_mut()
                .map_err(|_| ErrorCode::CouldNotLoadUserData)?;
            referrer_stats.increment_total_referrer_reward(referrer_reward, now)?;
        }
    }

    // Update market fee totals.
    market.amm.total_fee = market.amm.total_fee.safe_add(fee_to_market.cast()?)?;
    market.amm.total_exchange_fee = market
        .amm
        .total_exchange_fee
        .safe_add(fee_to_market.cast()?)?;
    market.amm.total_fee_minus_distributions = market
        .amm
        .total_fee_minus_distributions
        .safe_add(fee_to_market.cast()?)?;
    market.amm.net_revenue_since_last_funding = market
        .amm
        .net_revenue_since_last_funding
        .safe_add(fee_to_market)?;

    // Update taker stats.
    let mut taker_stats = taker_stats_loader
        .load_mut()
        .map_err(|_| ErrorCode::CouldNotLoadUserData)?;
    taker_stats.increment_total_fees(taker_fee)?;
    taker_stats.increment_total_referee_discount(referee_discount)?;

    Ok(())
}

/// Fill taker perp order against PropAMM (midprice) + DLOB liquidity. Permissionless.
///
/// ```text
/// ┌────────────────────────────────────────────────────────────────┐
/// │                    ORDER RESOLUTION                            │
/// │ Resolve taker order → TakerOrder struct                       │
/// │ Validate type / status / expiry / reduce_only                 │
/// └───────────────────────────┬────────────────────────────────────┘
///                             │
/// ┌───────────────────────────▼────────────────────────────────────┐
/// │                    MARKET PREFILL                              │
/// │ Validate market status, oracle, reduce-only, fills not paused │
/// │ Load spot/perp market maps + oracle map                       │
/// │ Load oracle data → MarketContext struct                       │
/// │ Check oracle validity + TWAP divergence (early exit)          │
/// │ Capture reserve_price_before                                  │
/// └───────────────────────────┬────────────────────────────────────┘
///                             │
/// ┌───────────────────────────▼────────────────────────────────────┐
/// │                    TAKER PREFILL                               │
/// │ Check bankruptcy / liquidation (early exit)                   │
/// │ Compute limit_price from auction / oracle mechanics           │
/// │ Settle taker funding                                          │
/// └───────────────────────────┬────────────────────────────────────┘
///                             │
/// ┌───────────────────────────▼────────────────────────────────────┐
/// │                    MAKER PREFILL                               │
/// │ Parse PropAMM book views  →  amm_views[]                     │
/// │ Build amm_view_by_maker index (O(1) lookup)                  │
/// │ Parse DLOB makers         →  dlob_makers[]                   │
/// │ Resolve optional referrer                                     │
/// │ Early exit if no liquidity                                    │
/// └───────────────────────────┬────────────────────────────────────┘
///                             │
/// ┌───────────────────────────▼────────────────────────────────────┐
/// │                      DO FILLS                                 │
/// │                                                               │
/// │  ┌─ run_unified_matching ──────────────────────────────────┐  │
/// │  │ Price-priority merge across PropAMM + DLOB              │  │
/// │  │ Pro-rata allocation for tied PropAMM levels             │  │
/// │  │ → UnifiedMatchResult { maker_deltas, dlob_fills }       │  │
/// │  └─────────────────────────────────────────────────────────┘  │
/// │                                                               │
/// │  ┌─ filter_prop_amm_makers_by_margin ──────────────────────┐  │
/// │  │ Simulate post-fill position, check margin, restore      │  │
/// │  │ Skip insolvent makers (no revert)                       │  │
/// │  └─────────────────────────────────────────────────────────┘  │
/// │                                                               │
/// │  ┌─ PropAMM fills ─────────────────────────────────────────┐  │
/// │  │ Settle maker funding → taker + maker positions          │  │
/// │  │ Fees (taker fee, referrer reward) → fill events         │  │
/// │  └─────────────────────────────────────────────────────────┘  │
/// │                                                               │
/// │  ┌─ DLOB fills ────────────────────────────────────────────┐  │
/// │  │ Per maker: settle funding → fulfill_perp_order_with_match│  │
/// │  │ (battle-tested existing path)                           │  │
/// │  └─────────────────────────────────────────────────────────┘  │
/// └───────────────────────────┬────────────────────────────────────┘
///                             │
/// ┌───────────────────────────▼────────────────────────────────────┐
/// │                  MAKER POSTFILL                                │
/// │ Validate DLOB maker margin requirements                       │
/// └───────────────────────────┬────────────────────────────────────┘
///                             │
/// ┌───────────────────────────▼────────────────────────────────────┐
/// │                  TAKER POSTFILL                                │
/// │ Validate taker margin requirement                             │
/// │ Update taker stats (volume_30d, last_active_slot)             │
/// └───────────────────────────┬────────────────────────────────────┘
///                             │
/// ┌───────────────────────────▼────────────────────────────────────┐
/// │                  MARKET POSTFILL                               │
/// │ Validate fill price bands + max open interest                 │
/// │ Update last_fill_price, funding rate                          │
/// │ CPI → midprice_pino apply_fills (consume PropAMM book orders)│
/// └───────────────────────────────────────────────────────────────┘
/// ```

#[inline(never)]
fn resolve_taker_order(
    accounts: &FillPerpOrder2,
    taker_order_id: Option<u32>,
    clock: &Clock,
) -> Result<TakerOrder> {
    let now = clock.unix_timestamp;
    let user = accounts.user.load()?;
    let user_stats = accounts.user_stats.load()?;
    validate_fill_perp_order2_globals(&accounts.state, &user, &user_stats)?;
    let resolved_order_id = taker_order_id.unwrap_or_else(|| user.get_last_order_id());
    let order_index = user.get_order_index(resolved_order_id)?;
    let order = &user.orders[order_index];

    validate!(
        order.market_type == MarketType::Perp,
        ErrorCode::InvalidOrderMarketType,
        "must be perp order"
    )?;
    validate!(
        order.status == OrderStatus::Open,
        ErrorCode::OrderNotOpen,
        "Order not open"
    )?;
    validate!(
        matches!(
            order.order_type,
            OrderType::Limit | OrderType::Market | OrderType::Oracle
        ),
        ErrorCode::InvalidOrder,
        "prop AMM match requires limit, market, or oracle order"
    )?;
    validate!(
        !order.post_only,
        ErrorCode::InvalidOrder,
        "post_only orders cannot be filled as taker via prop AMM"
    )?;
    validate!(
        !order.must_be_triggered() || order.triggered(),
        ErrorCode::OrderMustBeTriggeredFirst,
        "Order must be triggered first"
    )?;
    validate!(
        order.max_ts == 0 || order.max_ts >= now,
        ErrorCode::InvalidOrder,
        "order has expired (max_ts {} < now {})",
        order.max_ts,
        now
    )?;

    let existing_position = user
        .get_perp_position(order.market_index)
        .map_or(0_i64, |p| p.base_asset_amount);
    let size = order.get_base_asset_amount_unfilled(Some(existing_position))?;
    validate!(
        size > 0,
        ErrorCode::InvalidOrder,
        "prop AMM match requires unfilled size > 0"
    )?;

    Ok(TakerOrder {
        market_index: order.market_index,
        size,
        direction: order.direction,
        order_index,
        base_asset_amount: order.base_asset_amount,
        slot: order.slot,
        reduce_only: order.reduce_only,
        high_leverage: user.is_high_leverage_mode(MarginRequirementType::Initial),
        is_resting_limit_order: order.is_resting_limit_order(clock.slot)?,
        auction_end_slot: order.slot.safe_add(order.auction_duration.cast()?)?,
    })
}

#[inline(never)]
pub fn handle_fill_perp_order2<'c: 'info, 'info>(
    ctx: Context<'_, '_, 'c, 'info, FillPerpOrder2<'info>>,
    taker_order_id: Option<u32>,
) -> Result<()> {
    let clock = Clock::get()?;
    let taker = resolve_taker_order(&ctx.accounts, taker_order_id, &clock)?;

    let program_id = ctx.program_id;
    let remaining_accounts = ctx.remaining_accounts;

    // Keep the exported instruction wrapper tiny so the large matching/fill pipeline
    // does not share the same top-level Solana stack frame as the Anchor `Context`.
    let Some(fctx) =
        build_fill_context(&ctx.accounts, remaining_accounts, &clock, taker, program_id)?
    else {
        return Ok(());
    };
    let mut fctx = Box::new(fctx);

    execute_fill(
        &ctx.accounts,
        remaining_accounts,
        &clock,
        &mut fctx,
        program_id,
    )
}

/// Build the heap-allocated FillContext: oracle map, market maps, market context, taker preflight.
/// Returns `Ok(None)` for soft-bail conditions (invalid oracle, bankrupt/liquidating taker, etc.).
#[inline(never)]
fn build_fill_context<'c: 'info, 'info>(
    accounts: &FillPerpOrder2<'info>,
    remaining_accounts: &'c [AccountInfo<'info>],
    clock: &Clock,
    taker: TakerOrder,
    program_id: &Pubkey,
) -> Result<Option<FillContext<'info>>> {
    let now = clock.unix_timestamp;

    // Market prefill lives here instead of the exported instruction wrapper to keep
    // the top-level Solana frame small while preserving the audit-friendly phase order.
    {
        let perp_market = accounts.perp_market.load()?;
        validate!(
            perp_market.market_index == taker.market_index,
            ErrorCode::InvalidMarketAccount,
            "perp_market account must match order market_index"
        )?;
        validate!(
            matches!(
                perp_market.status,
                MarketStatus::Active | MarketStatus::ReduceOnly
            ),
            ErrorCode::MarketFillOrderPaused,
            "Market not active"
        )?;
        if perp_market.is_reduce_only()? {
            let user = accounts.user.load()?;
            let existing_position = user
                .get_perp_position(taker.market_index)
                .map_or(0_i64, |p| p.base_asset_amount);
            let is_position_reducing = match taker.direction {
                PositionDirection::Long => existing_position < 0,
                PositionDirection::Short => existing_position > 0,
            };
            validate!(
                is_position_reducing,
                ErrorCode::InvalidOrder,
                "market is reduce-only; fill must reduce existing position"
            )?;
        }
        validate!(
            !perp_market.is_operation_paused(PerpOperation::Fill),
            ErrorCode::MarketFillOrderPaused,
            "Market fills paused"
        )?;
        validate!(
            !perp_market.is_in_settlement(now),
            ErrorCode::MarketFillOrderPaused,
            "Market is in settlement mode"
        )?;
        valid_oracle_for_perp_market(&accounts.oracle, &accounts.perp_market)?;
    }

    let oracle_guard_rails = accounts.state.oracle_guard_rails;
    let mut oracle_map = OracleMap::load_one_with_cache(
        &accounts.oracle,
        &accounts.oracle_price_cache,
        clock.slot,
        Some(oracle_guard_rails),
    )?;

    // Load live fallback oracles from remaining_accounts[1..] before spot markets.
    let mut oracles_end = 1;
    while oracles_end < remaining_accounts.len() {
        if is_oracle_account(&remaining_accounts[oracles_end]) {
            oracle_map.insert_live_oracle(&remaining_accounts[oracles_end])?;
            oracles_end += 1;
        } else {
            break;
        }
    }

    let amm_start = find_amm_start_after_spot_markets(remaining_accounts, program_id, oracles_end)?;

    let (spot_market_map, perp_market_map) = load_fill_perp_order2_market_maps(
        remaining_accounts,
        oracles_end,
        amm_start,
        &accounts.perp_market,
        taker.market_index,
    )?;

    let mctx = {
        let market = perp_market_map.get_ref(&taker.market_index)?;
        let oracle_price_data = oracle_map.get_price_data(&market.oracle_id())?;
        let mm_oracle_price_data = market.get_mm_oracle_price_data(
            *oracle_price_data,
            clock.slot,
            &oracle_guard_rails.validity,
        )?;
        let safe_oracle_price_data = mm_oracle_price_data.get_safe_oracle_price_data();
        let safe_oracle_validity = oracle_validity(
            MarketType::Perp,
            market.market_index,
            market.amm.historical_oracle_data.last_oracle_price_twap,
            &safe_oracle_price_data,
            &oracle_guard_rails.validity,
            market.get_max_confidence_interval_multiplier()?,
            &market.amm.oracle_source,
            LogMode::SafeMMOracle,
            market.amm.oracle_slot_delay_override,
            market.amm.oracle_low_risk_slot_delay_override,
        )?;

        if !is_oracle_valid_for_action(safe_oracle_validity, Some(DriftAction::OracleOrderPrice))? {
            msg!(
                "Perp market = {} oracle deemed invalid for prop AMM fill",
                taker.market_index
            );
            return Ok(None);
        }

        MarketContext {
            oracle_price: mm_oracle_price_data.get_price(),
            oracle_twap_5min: market
                .amm
                .historical_oracle_data
                .last_oracle_price_twap_5min,
            is_prediction_market: market.is_prediction_market(),
            order_tick_size: market.amm.order_tick_size,
            market_margin_ratio_initial: market.margin_ratio_initial,
            order_step_size: market.amm.order_step_size,
            protected_maker_params: market.get_protected_maker_params(),
        }
    };

    let oracle_too_divergent_with_twap_5min = is_oracle_too_divergent_with_twap_5min(
        mctx.oracle_price,
        mctx.oracle_twap_5min,
        accounts
            .state
            .oracle_guard_rails
            .max_oracle_twap_5min_percent_divergence()
            .cast()?,
    )?;
    if oracle_too_divergent_with_twap_5min && !mctx.is_prediction_market {
        return Ok(None);
    }

    let reserve_price_before = accounts.perp_market.load()?.amm.reserve_price()?;

    // Taker preflight: settle funding before bankruptcy / liquidation gates.
    {
        let mut user = accounts.user.load_mut()?;
        let mut market = accounts.perp_market.load_mut()?;
        controller::funding::settle_funding_payment(
            &mut user,
            &accounts.user.key(),
            &mut market,
            now,
        )?;
    }
    {
        let user = accounts.user.load()?;
        if user.is_bankrupt() {
            msg!("user is bankrupt");
            return Ok(None);
        }
    }
    {
        let mut user = accounts.user.load_mut()?;
        match validate_user_not_being_liquidated(
            &mut user,
            &perp_market_map,
            &spot_market_map,
            &mut oracle_map,
            accounts.state.liquidation_margin_buffer_ratio,
        ) {
            Ok(_) => {}
            Err(_) => {
                msg!("user is being liquidated");
                return Ok(None);
            }
        }
    }

    let limit_price = {
        let user = accounts.user.load()?;
        let order = &user.orders[taker.order_index];
        let fallback = match taker.direction {
            PositionDirection::Long => Some(u64::MAX),
            PositionDirection::Short => Some(0u64),
        };
        order
            .get_limit_price(
                Some(mctx.oracle_price),
                fallback,
                clock.slot,
                mctx.order_tick_size,
                mctx.is_prediction_market,
                None,
            )?
            .unwrap_or(order.price)
    };

    Ok(Some(FillContext {
        oracle_map,
        spot_market_map,
        perp_market_map,
        mctx,
        taker,
        reserve_price_before,
        limit_price,
        amm_start,
    }))
}

/// Execute the fill phases using the heap-allocated FillContext.
#[inline(never)]
fn execute_fill<'c: 'info, 'info>(
    accounts: &FillPerpOrder2<'info>,
    remaining_accounts: &'c [AccountInfo<'info>],
    clock: &Clock,
    fctx: &mut Box<FillContext<'info>>,
    program_id: &Pubkey,
) -> Result<()> {
    // --- Parse and match ---
    let m = parse_and_match(
        accounts,
        remaining_accounts,
        program_id,
        clock,
        &fctx.taker,
        &fctx.mctx,
        fctx.amm_start,
        fctx.limit_price,
        &fctx.perp_market_map,
        &fctx.spot_market_map,
        &mut fctx.oracle_map,
    )?;
    let Some(m) = m else { return Ok(()) };

    // --- Settle fills ---
    let dlob_maker_fills = settle_fills(
        accounts,
        remaining_accounts,
        clock,
        &fctx.taker,
        &fctx.mctx,
        &m,
        fctx.limit_price,
        fctx.reserve_price_before,
        &mut fctx.oracle_map,
    )?;

    // --- Postfill ---
    postfill_finalization(
        accounts,
        remaining_accounts,
        clock,
        &fctx.taker,
        &fctx.mctx,
        &m,
        &dlob_maker_fills,
        fctx.reserve_price_before,
        &fctx.perp_market_map,
        &fctx.spot_market_map,
        &mut fctx.oracle_map,
        program_id,
        fctx.amm_start,
    )?;

    Ok(())
}

#[inline(never)]
fn parse_and_match<'c: 'info, 'info>(
    accounts: &FillPerpOrder2<'info>,
    remaining_accounts: &'c [AccountInfo<'info>],
    program_id: &Pubkey,
    clock: &Clock,
    taker: &TakerOrder,
    mctx: &MarketContext,
    amm_start: usize,
    limit_price: u64,
    perp_market_map: &PerpMarketMap,
    spot_market_map: &SpotMarketMap,
    oracle_map: &mut OracleMap,
) -> Result<Option<MatchOutput>> {
    let now = clock.unix_timestamp;

    let (midprice_program_idx, amm_views, dlob_start) = parse_amm_views(
        remaining_accounts,
        amm_start,
        program_id,
        clock.slot,
        Some(taker.market_index),
        Some(&accounts.user.key()),
    )?;

    let amm_view_by_maker: BTreeMap<Pubkey, usize> = amm_views
        .iter()
        .enumerate()
        .map(|(i, v)| (remaining_accounts[v.maker_user_remaining_index].key(), i))
        .collect();

    let user_can_skip_duration = {
        let user = accounts.user.load()?;
        let user_stats = accounts.user_stats.load()?;
        user.can_skip_auction_duration(&user_stats, taker.reduce_only)?
    };
    let taker_order_age = clock.slot.safe_sub(taker.slot)?;
    let protected_maker_min_age = accounts.state.min_perp_auction_duration as u64;

    let (dlob_makers, referrer_start) = parse_dlob_makers(
        remaining_accounts,
        dlob_start,
        program_id,
        &accounts.user.key(),
        taker.direction,
        taker.market_index,
        limit_price,
        mctx.oracle_price,
        clock.slot,
        now,
        mctx.order_tick_size,
        mctx.is_prediction_market,
        taker.is_resting_limit_order,
        taker.auction_end_slot,
        taker_order_age,
        user_can_skip_duration,
        mctx.protected_maker_params,
        protected_maker_min_age,
        mctx.market_margin_ratio_initial,
        mctx.order_step_size,
    )?;

    let taker_stats_for_referrer = accounts.user_stats.load()?;
    let referrer_info = resolve_referrer(
        &taker_stats_for_referrer,
        remaining_accounts,
        referrer_start,
        program_id,
        clock.slot,
    )?;
    drop(taker_stats_for_referrer);
    let optional_accounts_start = if referrer_info.is_some() {
        referrer_start + 2
    } else {
        referrer_start
    };

    if amm_views.is_empty() && dlob_makers.is_empty() {
        return Ok(None);
    }

    let result = run_unified_matching(
        &amm_views,
        &dlob_makers,
        remaining_accounts,
        taker.direction,
        limit_price,
        taker.size,
    )?;

    let (maker_deltas, external_fills, taker_base_delta, taker_quote_delta, total_quote_volume) =
        filter_prop_amm_makers_by_margin(
            &result.maker_deltas,
            &result.external_fills,
            &amm_views,
            remaining_accounts,
            perp_market_map,
            spot_market_map,
            oracle_map,
            taker.market_index,
            now,
        )?;

    if external_fills.is_empty() && result.dlob_fills.is_empty() {
        return Ok(None);
    }

    Ok(Some(MatchOutput {
        midprice_program_idx,
        amm_views,
        amm_view_by_maker,
        external_fills,
        maker_deltas,
        dlob_fills: result.dlob_fills,
        taker_base_delta,
        taker_quote_delta,
        total_quote_volume,
        referrer_info,
        optional_accounts_start,
    }))
}

#[inline(never)]
fn settle_fills<'c: 'info, 'info>(
    accounts: &FillPerpOrder2<'info>,
    remaining_accounts: &'c [AccountInfo<'info>],
    clock: &Clock,
    taker: &TakerOrder,
    mctx: &MarketContext,
    m: &MatchOutput,
    limit_price: u64,
    reserve_price_before: u64,
    oracle_map: &mut OracleMap,
) -> Result<BTreeMap<Pubkey, i64>> {
    let now = clock.unix_timestamp;
    let prop_amm_base_filled = m.taker_base_delta.unsigned_abs() as u64;
    let prop_amm_quote_filled = m.taker_quote_delta.unsigned_abs() as u64;
    let fee_structure = &accounts.state.perp_fee_structure;
    let mut dlob_maker_fills: BTreeMap<Pubkey, i64> = BTreeMap::new();
    let has_referrer = m.referrer_info.is_some();
    let builder_codes_enabled = accounts.state.builder_codes_enabled();
    let builder_referral_enabled = accounts.state.builder_referral_enabled();
    let mut builder_escrow = if builder_codes_enabled || builder_referral_enabled {
        let taker_user = accounts.user.load()?;
        let mut optional_accounts_iter = remaining_accounts[m.optional_accounts_start..]
            .iter()
            .peekable();
        get_revenue_share_escrow_account(&mut optional_accounts_iter, &taker_user.authority)?
    } else {
        None
    };

    // PropAMM fills: settle maker funding, apply taker + maker positions, fees.
    if prop_amm_base_filled > 0 {
        let (builder_order_idx, referrer_builder_order_idx, builder_order_fee_bps, builder_idx) = {
            let taker_user = accounts.user.load()?;
            let mut escrow_ref = builder_escrow.as_mut();
            crate::controller::orders::get_builder_escrow_info(
                &mut escrow_ref,
                taker_user.sub_account_id,
                taker_user.orders[taker.order_index].order_id,
                taker.market_index,
                builder_referral_enabled,
            )
        };

        // Settle funding for each PropAMM maker before position mutation.
        for (maker_user_key, _) in &m.maker_deltas {
            let amm_view = &m.amm_views[*m
                .amm_view_by_maker
                .get(maker_user_key)
                .ok_or(ErrorCode::MakerNotFound)?];
            let maker_info = &remaining_accounts[amm_view.maker_user_remaining_index];
            let maker_loader: AccountLoader<User> =
                AccountLoader::try_from(maker_info).or(Err(ErrorCode::CouldNotLoadUserData))?;
            let mut maker = maker_loader.load_mut()?;
            let mut market = accounts.perp_market.load_mut()?;
            controller::funding::settle_funding_payment(
                &mut maker,
                maker_user_key,
                &mut market,
                now,
            )?;
        }

        let mut user = accounts.user.load_mut()?;
        let mut perp_market = accounts.perp_market.load_mut()?;

        let taker_position_index = get_position_index(&user.perp_positions, taker.market_index)
            .or_else(|_| add_new_position(&mut user.perp_positions, taker.market_index))?;

        let taker_delta = get_position_delta_for_fill(
            prop_amm_base_filled,
            prop_amm_quote_filled,
            taker.direction,
        )?;
        update_position_and_market(
            &mut user.perp_positions[taker_position_index],
            &mut perp_market,
            &taker_delta,
        )?;

        let is_filled = update_order_after_fill(
            &mut user.orders[taker.order_index],
            prop_amm_base_filled,
            m.total_quote_volume,
        )?;

        let should_update_open_bids_asks =
            user.orders[taker.order_index].update_open_bids_and_asks();
        decrease_open_bids_and_asks(
            &mut user.perp_positions[taker_position_index],
            &taker.direction,
            prop_amm_base_filled,
            should_update_open_bids_asks,
        )?;

        if user.orders[taker.order_index].get_base_asset_amount_unfilled(None)? == 0 {
            let has_auction = user.orders[taker.order_index].has_auction();
            user.decrement_open_orders(has_auction);
            user.orders[taker.order_index].status = OrderStatus::Filled;
            user.perp_positions[taker_position_index].open_orders -= 1;
        }
        if is_filled {
            if let (Some(idx), Some(escrow)) = (builder_order_idx, builder_escrow.as_mut()) {
                escrow
                    .get_order_mut(idx)?
                    .add_bit_flag(RevenueShareOrderBitFlag::Completed);
            }
        }

        drop(user);
        drop(perp_market);

        let oracle_id = accounts.perp_market.load()?.oracle_id();
        let fill_oracle_price = oracle_map.get_price_data(&oracle_id)?.price;

        for (maker_user_key, (base_delta, quote_delta)) in &m.maker_deltas {
            if *base_delta == 0 && *quote_delta == 0 {
                continue;
            }
            let amm_view = &m.amm_views[*m
                .amm_view_by_maker
                .get(maker_user_key)
                .ok_or(ErrorCode::MakerNotFound)?];
            let maker_info = &remaining_accounts[amm_view.maker_user_remaining_index];
            let maker_loader: AccountLoader<User> =
                AccountLoader::try_from(maker_info).or(Err(ErrorCode::CouldNotLoadUserData))?;
            let mut maker = maker_loader.load_mut()?;
            let mut market = accounts.perp_market.load_mut()?;
            let maker_direction = if *base_delta > 0 {
                PositionDirection::Long
            } else {
                PositionDirection::Short
            };
            let maker_position_index =
                get_position_index(&maker.perp_positions, taker.market_index)
                    .or_else(|_| add_new_position(&mut maker.perp_positions, taker.market_index))?;
            let maker_pos_delta = get_position_delta_for_fill(
                base_delta.unsigned_abs() as u64,
                quote_delta.unsigned_abs() as u64,
                maker_direction,
            )?;
            update_position_and_market(
                &mut maker.perp_positions[maker_position_index],
                &mut *market,
                &maker_pos_delta,
            )?;

            let maker_base_filled = base_delta.unsigned_abs() as u64;
            let maker_quote_filled = quote_delta.unsigned_abs() as u64;

            let referrer_stats_loader_for_fee = if let Some((_, _, ref_stats_idx)) = m.referrer_info
            {
                let ref_stats_info = &remaining_accounts[ref_stats_idx];
                Some(
                    AccountLoader::<crate::state::user::UserStats>::try_from(ref_stats_info)
                        .map_err(|_| ErrorCode::CouldNotLoadUserData)?,
                )
            } else {
                None
            };
            let mut referrer_stats_guard = match referrer_stats_loader_for_fee.as_ref() {
                Some(loader) => Some(
                    loader
                        .load_mut()
                        .map_err(|_| ErrorCode::CouldNotLoadUserData)?,
                ),
                None => None,
            };
            let referrer_stats_opt: Option<&mut crate::state::user::UserStats> =
                referrer_stats_guard.as_deref_mut();

            let fill_fees = {
                let taker_stats_ref = accounts.user_stats.load()?;
                fees::calculate_fee_for_fulfillment_with_match(
                    &*taker_stats_ref,
                    &None,
                    maker_quote_filled,
                    fee_structure,
                    taker.slot,
                    clock.slot,
                    0,
                    has_referrer,
                    &referrer_stats_opt,
                    &MarketType::Perp,
                    market.fee_adjustment,
                    taker.high_leverage,
                    builder_order_fee_bps,
                )?
            };
            if let Some(builder_fee) = fill_fees.builder_fee {
                if builder_fee != 0 {
                    if let (Some(idx), Some(escrow)) = (builder_order_idx, builder_escrow.as_mut())
                    {
                        let order = escrow.get_order_mut(idx)?;
                        order.fees_accrued = order.fees_accrued.safe_add(builder_fee)?;
                    } else {
                        msg!("Order has builder fee but no escrow account found, in the future this tx will fail.");
                    }
                }
            }
            drop(referrer_stats_guard);
            apply_prop_amm_fill_fees(
                &accounts.user,
                &mut *market,
                &accounts.user_stats,
                remaining_accounts,
                m.referrer_info,
                &mut builder_escrow.as_mut(),
                referrer_builder_order_idx,
                &fill_fees,
                taker.market_index,
                now,
            )?;

            let fill_record_id = get_then_update_id!(market, next_fill_record_id);
            market
                .amm
                .update_volume_24h(maker_quote_filled, taker.direction, now)?;
            drop(maker);
            drop(market);

            let mut taker_order = Order::default();
            taker_order.market_type = MarketType::Perp;
            taker_order.direction = taker.direction;
            taker_order.base_asset_amount = taker.base_asset_amount;
            taker_order.market_index = taker.market_index;

            let fill_record = get_order_action_record(
                now,
                OrderAction::Fill,
                OrderActionExplanation::OrderFilledWithMatch,
                taker.market_index,
                None,
                Some(fill_record_id),
                None,
                Some(maker_base_filled),
                Some(maker_quote_filled),
                Some(
                    fill_fees
                        .user_fee
                        .safe_add(fill_fees.builder_fee.unwrap_or(0))?,
                ),
                None,
                Some(fill_fees.referrer_reward),
                None,
                None,
                Some(accounts.user.key()),
                Some(taker_order),
                Some(*maker_user_key),
                None,
                fill_oracle_price,
                0,
                None,
                None,
                None,
                None,
                None,
                builder_idx,
                fill_fees.builder_fee,
            )?;
            emit_stack::<_, { OrderActionRecord::SIZE }>(fill_record)?;
        }
    }

    // DLOB fills: delegate to fulfill_perp_order_with_match (battle-tested path).
    if !m.dlob_fills.is_empty() {
        use crate::controller::orders::fulfill_perp_order_with_match;

        let ref_user_loader = if let Some((_, ref_user_idx, _)) = m.referrer_info {
            Some(
                AccountLoader::<User>::try_from(&remaining_accounts[ref_user_idx])
                    .map_err(|_| ErrorCode::CouldNotLoadUserData)?,
            )
        } else {
            None
        };
        let ref_stats_loader = if let Some((_, _, ref_stats_idx)) = m.referrer_info {
            Some(
                AccountLoader::<crate::state::user::UserStats>::try_from(
                    &remaining_accounts[ref_stats_idx],
                )
                .map_err(|_| ErrorCode::CouldNotLoadUserData)?,
            )
        } else {
            None
        };

        for dlob_fill in &m.dlob_fills {
            {
                let maker_info = &remaining_accounts[dlob_fill.remaining_account_index];
                let maker_loader: AccountLoader<User> =
                    AccountLoader::try_from(maker_info).or(Err(ErrorCode::CouldNotLoadUserData))?;
                let mut maker = maker_loader.load_mut()?;
                let mut market = accounts.perp_market.load_mut()?;
                controller::funding::settle_funding_payment(
                    &mut maker,
                    &dlob_fill.maker_key,
                    &mut market,
                    now,
                )?;
            }

            let maker_info = &remaining_accounts[dlob_fill.remaining_account_index];
            let maker_loader: AccountLoader<User> =
                AccountLoader::try_from(maker_info).or(Err(ErrorCode::CouldNotLoadUserData))?;

            let maker_stats_info = &remaining_accounts[dlob_fill.maker_stats_remaining_index];
            let maker_stats_loader: AccountLoader<crate::state::user::UserStats> =
                AccountLoader::try_from(maker_stats_info)
                    .map_err(|_| ErrorCode::CouldNotLoadUserData)?;

            let mut maker = maker_loader.load_mut()?;
            let mut taker_user = accounts.user.load_mut()?;
            let mut taker_stats = accounts.user_stats.load_mut()?;
            let mut market = accounts.perp_market.load_mut()?;

            let mut maker_stats_guard = if maker.authority != taker_user.authority {
                Some(
                    maker_stats_loader
                        .load_mut()
                        .map_err(|_| ErrorCode::CouldNotLoadUserData)?,
                )
            } else {
                None
            };
            let mut referrer_user_guard = match ref_user_loader.as_ref() {
                Some(loader) => Some(
                    loader
                        .load_mut()
                        .map_err(|_| ErrorCode::CouldNotLoadUserData)?,
                ),
                None => None,
            };
            let mut referrer_stats_guard = match ref_stats_loader.as_ref() {
                Some(loader) => Some(
                    loader
                        .load_mut()
                        .map_err(|_| ErrorCode::CouldNotLoadUserData)?,
                ),
                None => None,
            };

            let mut maker_stats_opt: Option<&mut crate::state::user::UserStats> =
                maker_stats_guard.as_deref_mut();
            let mut filler_none: Option<&mut User> = None;
            let mut filler_stats_none: Option<&mut crate::state::user::UserStats> = None;
            let mut referrer_ref: Option<&mut User> = referrer_user_guard.as_deref_mut();
            let mut referrer_stats_ref: Option<&mut crate::state::user::UserStats> =
                referrer_stats_guard.as_deref_mut();

            let (_fill_base, fill_quote, maker_fill_base) = fulfill_perp_order_with_match(
                &mut market,
                &mut taker_user,
                &mut taker_stats,
                taker.order_index,
                &accounts.user.key(),
                &mut maker,
                &mut maker_stats_opt,
                dlob_fill.order_index,
                &dlob_fill.maker_key,
                &mut filler_none,
                &mut filler_stats_none,
                &Pubkey::default(),
                &mut referrer_ref,
                &mut referrer_stats_ref,
                reserve_price_before,
                Some(mctx.oracle_price),
                Some(limit_price),
                dlob_fill.price,
                now,
                clock.slot,
                fee_structure,
                oracle_map,
                false,
                &mut builder_escrow.as_mut(),
                builder_referral_enabled,
            )?;

            if maker_fill_base != 0 {
                let maker_direction = taker.direction.opposite();
                let signed_fill = match maker_direction {
                    PositionDirection::Long => maker_fill_base as i64,
                    PositionDirection::Short => -(maker_fill_base as i64),
                };
                *dlob_maker_fills.entry(dlob_fill.maker_key).or_insert(0) += signed_fill;
            }

            market
                .amm
                .update_volume_24h(fill_quote, taker.direction, now)?;
        }
    }

    Ok(dlob_maker_fills)
}

#[inline(never)]
fn postfill_finalization<'c: 'info, 'info>(
    accounts: &FillPerpOrder2<'info>,
    remaining_accounts: &'c [AccountInfo<'info>],
    clock: &Clock,
    taker: &TakerOrder,
    mctx: &MarketContext,
    m: &MatchOutput,
    dlob_maker_fills: &BTreeMap<Pubkey, i64>,
    reserve_price_before: u64,
    perp_market_map: &PerpMarketMap,
    spot_market_map: &SpotMarketMap,
    oracle_map: &mut OracleMap,
    program_id: &Pubkey,
    amm_start: usize,
) -> Result<()> {
    let now = clock.unix_timestamp;
    let has_prop_amm_fills = !m.external_fills.is_empty();
    let has_dlob_fills = !m.dlob_fills.is_empty();
    let prop_amm_base_filled = m.taker_base_delta.unsigned_abs() as u64;

    // --- Maker postfill: validate DLOB maker margin ---
    if has_dlob_fills {
        for (maker_key, maker_base_filled) in dlob_maker_fills {
            let dlob_fill = m
                .dlob_fills
                .iter()
                .find(|f| f.maker_key == *maker_key)
                .ok_or(ErrorCode::MakerNotFound)?;
            let maker_info = &remaining_accounts[dlob_fill.remaining_account_index];
            let maker_loader: AccountLoader<User> =
                AccountLoader::try_from(maker_info).or(Err(ErrorCode::CouldNotLoadUserData))?;
            let maker = maker_loader
                .load()
                .map_err(|_| ErrorCode::CouldNotLoadUserData)?;

            let (margin_type, _maker_risk_increasing) =
                select_margin_type_for_perp_maker(&maker, *maker_base_filled, taker.market_index)?;
            let context = MarginContext::standard(margin_type)
                .fuel_perp_delta(taker.market_index, -*maker_base_filled)
                .fuel_numerator(&maker, now);

            let maker_margin_calc =
                match calculate_margin_requirement_and_total_collateral_and_liability_info(
                    &maker,
                    perp_market_map,
                    spot_market_map,
                    oracle_map,
                    context,
                ) {
                    Ok(calc) => calc,
                    Err(e) => return Err(e.into()),
                };

            if !maker_margin_calc.meets_margin_requirement() {
                let (margin_requirement, total_collateral) =
                    if maker_margin_calc.has_isolated_margin_calculation(taker.market_index) {
                        let isolated = maker_margin_calc
                            .get_isolated_margin_calculation(taker.market_index)?;
                        (isolated.margin_requirement, isolated.total_collateral)
                    } else {
                        (
                            maker_margin_calc.margin_requirement,
                            maker_margin_calc.total_collateral,
                        )
                    };
                msg!(
                    "DLOB maker ({}) breached fill requirements (margin requirement {}) (total_collateral {})",
                    maker_key,
                    margin_requirement,
                    total_collateral
                );
                return Err(ErrorCode::InsufficientCollateral.into());
            }
        }
    }

    // --- Taker postfill: validate taker margin ---
    {
        let taker_user = accounts.user.load()?;
        let position_after = taker_user
            .get_perp_position(taker.market_index)
            .map_or(0_i64, |p| p.base_asset_amount);
        let total_base_filled =
            taker_user.orders[taker.order_index].base_asset_amount_filled as i64;
        let total_taker_base_delta = if matches!(taker.direction, PositionDirection::Long) {
            total_base_filled
        } else {
            -total_base_filled
        };
        let position_before = position_after
            .checked_sub(total_taker_base_delta)
            .ok_or(ErrorCode::MathError)?;
        let taker_position_decreasing = position_after == 0
            || (position_after.signum() == position_before.signum()
                && position_after.abs() < position_before.abs());
        let taker_margin_type = if taker_position_decreasing {
            MarginRequirementType::Maintenance
        } else {
            MarginRequirementType::Fill
        };
        let taker_margin_context = MarginContext::standard(taker_margin_type)
            .fuel_perp_delta(taker.market_index, -total_taker_base_delta)
            .fuel_numerator(&taker_user, now);
        let taker_margin_calc =
            calculate_margin_requirement_and_total_collateral_and_liability_info(
                &taker_user,
                perp_market_map,
                spot_market_map,
                oracle_map,
                taker_margin_context,
            )?;
        if !taker_margin_calc.meets_margin_requirement() {
            let (margin_requirement, total_collateral) =
                if taker_margin_calc.has_isolated_margin_calculation(taker.market_index) {
                    let isolated =
                        taker_margin_calc.get_isolated_margin_calculation(taker.market_index)?;
                    (isolated.margin_requirement, isolated.total_collateral)
                } else {
                    (
                        taker_margin_calc.margin_requirement,
                        taker_margin_calc.total_collateral,
                    )
                };
            msg!(
                "taker breached fill requirements (margin requirement {}) (total_collateral {})",
                margin_requirement,
                total_collateral
            );
            return Err(ErrorCode::InsufficientCollateral.into());
        }
    }

    // Update taker stats (prop_amm portion; DLOB already handled by fulfill_perp_order_with_match).
    if prop_amm_base_filled > 0 {
        let mut taker_stats = accounts.user_stats.load_mut()?;
        let fuel_boost_taker = accounts.perp_market.load()?.fuel_boost_taker;
        taker_stats.update_taker_volume_30d(fuel_boost_taker, m.total_quote_volume, now)?;
    }

    {
        let mut taker_user = accounts.user.load_mut()?;
        taker_user.update_last_active_slot(clock.slot);
    }

    // --- Market postfill ---
    {
        let taker_user = accounts.user.load()?;
        let total_base_filled_u64 = taker_user.orders[taker.order_index].base_asset_amount_filled;
        let total_quote_filled_u64 = taker_user.orders[taker.order_index].quote_asset_amount_filled;
        drop(taker_user);

        if total_base_filled_u64 > 0 {
            let fill_price = calculate_fill_price(
                total_quote_filled_u64,
                total_base_filled_u64,
                BASE_PRECISION_U64,
            )?;

            let mut market = accounts.perp_market.load_mut()?;

            validate_fill_price_within_price_bands(
                fill_price,
                mctx.oracle_price,
                mctx.oracle_twap_5min,
                mctx.market_margin_ratio_initial,
                accounts
                    .state
                    .oracle_guard_rails
                    .max_oracle_twap_5min_percent_divergence(),
                mctx.is_prediction_market,
                None,
            )?;

            market.last_fill_price = fill_price;

            let open_interest = market.get_open_interest();
            let max_open_interest = market.amm.max_open_interest;
            validate!(
                max_open_interest == 0 || max_open_interest > open_interest,
                ErrorCode::MaxOpenInterest,
                "open interest ({}) > max open interest ({})",
                open_interest,
                max_open_interest
            )?;

            let funding_paused = accounts.state.funding_paused()?
                || market.is_operation_paused(PerpOperation::UpdateFunding);
            controller::funding::update_funding_rate(
                taker.market_index,
                &mut market,
                oracle_map,
                now,
                clock.slot,
                &accounts.state.oracle_guard_rails,
                funding_paused,
                Some(reserve_price_before),
            )?;
        }
    }

    // CPI to midprice_pino to apply fills (consume orders on AMM books).
    if has_prop_amm_fills {
        flush_external_fill_batches(
            &remaining_accounts[m.midprice_program_idx],
            remaining_accounts,
            &accounts.clock.to_account_info(),
            &m.external_fills,
            amm_start,
            taker.market_index,
            program_id,
        )?;
    }

    Ok(())
}

#[derive(Accounts)]
pub struct FillPerpOrder2<'info> {
    #[account(mut)]
    pub user: AccountLoader<'info, User>,

    #[account(mut)]
    pub user_stats: AccountLoader<'info, crate::state::user::UserStats>,

    pub state: Box<Account<'info, crate::state::state::State>>,

    #[account(mut)]
    pub perp_market: AccountLoader<'info, PerpMarket>,

    /// Oracle for the perp market (must match perp_market.amm.oracle).
    /// Validated by `valid_oracle_for_perp_market` before use; then passed to `OracleMap::load_one` for price reads.
    ///
    /// CHECK:
    /// Caller must pass the account specified by `perp_market.amm.oracle`; validation enforces correct oracle type and ownership before the account is used.
    pub oracle: AccountInfo<'info>,

    /// Oracle price cache (read-only). Provides cached oracle prices for maker margin checks
    /// without requiring live oracle accounts for every position. Validated as an
    /// `OraclePriceCache` PDA owned by the drift program.
    ///
    /// CHECK:
    /// Validated by `OracleMap::load_one_with_cache` which checks discriminator, owner,
    /// and parses entries from the zero-copy account.
    pub oracle_price_cache: AccountInfo<'info>,

    pub clock: Sysvar<'info, Clock>,
}

#[cfg(test)]
mod tests {
    use super::*;
    use anchor_lang::prelude::AccountLoader;
    use anchor_lang::prelude::Pubkey;
    use anchor_lang::Discriminator;
    use std::str::FromStr;

    use crate::math::constants::{
        AMM_RESERVE_PRECISION, BASE_PRECISION_U64, PRICE_PRECISION_U64, SPOT_BALANCE_PRECISION_U64,
        SPOT_CUMULATIVE_INTEREST_PRECISION, SPOT_WEIGHT_PRECISION,
    };
    use crate::math::margin::{
        calculate_margin_requirement_and_total_collateral_and_liability_info, MarginRequirementType,
    };
    use crate::state::margin_calculation::MarginContext;
    use crate::state::oracle::{HistoricalOracleData, OracleSource};
    use crate::state::perp_market::{MarketStatus, PerpMarket, AMM};
    use crate::state::perp_market_map::PerpMarketMap;
    use crate::state::revenue_share::{
        BuilderInfo, RevenueShareEscrow, RevenueShareEscrowFixed, RevenueShareOrder,
        RevenueShareOrderBitFlag,
    };
    use crate::state::spot_market::{SpotBalanceType, SpotMarket};
    use crate::state::spot_market_map::SpotMarketMap;
    use crate::state::state::{ExchangeStatus, State};
    use crate::state::user::{
        Order, OrderStatus, OrderType, PerpPosition, SpotPosition, User, UserStats, UserStatus,
    };
    use crate::{
        create_account_info, create_executable_program_account_info, get_account_bytes,
        get_anchor_account_bytes, get_pyth_price,
    };
    use midprice_book_view::{
        ACCOUNT_DISCRIMINATOR_OFFSET, ACCOUNT_DISCRIMINATOR_SIZE, ACCOUNT_MIN_LEN, ASK_HEAD_OFFSET,
        ASK_LEN_OFFSET, AUTHORITY_OFFSET, BID_HEAD_OFFSET, BID_LEN_OFFSET, LAYOUT_VERSION_INITIAL,
        LAYOUT_VERSION_OFFSET, MARKET_INDEX_OFFSET, MIDPRICE_ACCOUNT_DISCRIMINATOR,
        MID_PRICE_OFFSET, ORDERS_DATA_OFFSET, ORDER_ENTRY_SIZE, ORDER_ENTRY_SIZE_OFFSET,
        QUOTE_TTL_OFFSET, REF_SLOT_OFFSET, SUBACCOUNT_INDEX_OFFSET,
    };

    fn drift_program_id() -> Pubkey {
        crate::id()
    }

    fn midprice_program_id() -> Pubkey {
        crate::ids::midprice_program::id()
    }

    /// Returns (authority, maker_user_pda) so that midprice (authority, 0) derives to maker_user_pda.
    fn derive_maker_user_pda() -> (Pubkey, Pubkey) {
        let authority = Pubkey::new_unique();
        let pda = crate::state::user::derive_user_account(&authority, 0);
        (authority, pda)
    }

    /// Build a minimal midprice account buffer: 1 ask at (offset=1, size=size), mid_price=mid.
    fn make_midprice_account_data(mid_price: u64, ask_size: u64, authority: &Pubkey) -> Vec<u8> {
        make_midprice_account_data_with_market(mid_price, ask_size, authority, 0)
    }

    /// Same as above but with explicit market_index (for security tests).
    fn make_midprice_account_data_with_market(
        mid_price: u64,
        ask_size: u64,
        authority: &Pubkey,
        market_index: u16,
    ) -> Vec<u8> {
        let mut data = vec![0u8; ACCOUNT_MIN_LEN + ORDER_ENTRY_SIZE];
        data[ACCOUNT_DISCRIMINATOR_OFFSET
            ..ACCOUNT_DISCRIMINATOR_OFFSET + ACCOUNT_DISCRIMINATOR_SIZE]
            .copy_from_slice(&MIDPRICE_ACCOUNT_DISCRIMINATOR);
        data[LAYOUT_VERSION_OFFSET..LAYOUT_VERSION_OFFSET + 8]
            .copy_from_slice(&LAYOUT_VERSION_INITIAL.to_le_bytes());
        data[AUTHORITY_OFFSET..AUTHORITY_OFFSET + 32].copy_from_slice(authority.as_ref());
        data[MID_PRICE_OFFSET..MID_PRICE_OFFSET + 8].copy_from_slice(&mid_price.to_le_bytes());
        data[MARKET_INDEX_OFFSET..MARKET_INDEX_OFFSET + 2]
            .copy_from_slice(&market_index.to_le_bytes());
        data[SUBACCOUNT_INDEX_OFFSET..SUBACCOUNT_INDEX_OFFSET + 2]
            .copy_from_slice(&0u16.to_le_bytes());
        data[ASK_LEN_OFFSET..ASK_LEN_OFFSET + 2].copy_from_slice(&1u16.to_le_bytes());
        data[BID_LEN_OFFSET..BID_LEN_OFFSET + 2].copy_from_slice(&0u16.to_le_bytes());
        data[ASK_HEAD_OFFSET..ASK_HEAD_OFFSET + 2].copy_from_slice(&0u16.to_le_bytes());
        data[BID_HEAD_OFFSET..BID_HEAD_OFFSET + 2].copy_from_slice(&0u16.to_le_bytes());
        data[ORDER_ENTRY_SIZE_OFFSET..ORDER_ENTRY_SIZE_OFFSET + 2]
            .copy_from_slice(&(ORDER_ENTRY_SIZE as u16).to_le_bytes());
        let base = ORDERS_DATA_OFFSET;
        data[base..base + 8].copy_from_slice(&1i64.to_le_bytes());
        data[base + 8..base + 16].copy_from_slice(&ask_size.to_le_bytes());
        data
    }

    fn make_bid_midprice_account_data(
        mid_price: u64,
        bid_size: u64,
        authority: &Pubkey,
        market_index: u16,
    ) -> Vec<u8> {
        let mut data = vec![0u8; ACCOUNT_MIN_LEN + ORDER_ENTRY_SIZE];
        data[ACCOUNT_DISCRIMINATOR_OFFSET
            ..ACCOUNT_DISCRIMINATOR_OFFSET + ACCOUNT_DISCRIMINATOR_SIZE]
            .copy_from_slice(&MIDPRICE_ACCOUNT_DISCRIMINATOR);
        data[LAYOUT_VERSION_OFFSET..LAYOUT_VERSION_OFFSET + 8]
            .copy_from_slice(&LAYOUT_VERSION_INITIAL.to_le_bytes());
        data[AUTHORITY_OFFSET..AUTHORITY_OFFSET + 32].copy_from_slice(authority.as_ref());
        data[MID_PRICE_OFFSET..MID_PRICE_OFFSET + 8].copy_from_slice(&mid_price.to_le_bytes());
        data[MARKET_INDEX_OFFSET..MARKET_INDEX_OFFSET + 2]
            .copy_from_slice(&market_index.to_le_bytes());
        data[SUBACCOUNT_INDEX_OFFSET..SUBACCOUNT_INDEX_OFFSET + 2]
            .copy_from_slice(&0u16.to_le_bytes());
        data[ASK_LEN_OFFSET..ASK_LEN_OFFSET + 2].copy_from_slice(&0u16.to_le_bytes());
        data[BID_LEN_OFFSET..BID_LEN_OFFSET + 2].copy_from_slice(&1u16.to_le_bytes());
        data[ASK_HEAD_OFFSET..ASK_HEAD_OFFSET + 2].copy_from_slice(&0u16.to_le_bytes());
        data[BID_HEAD_OFFSET..BID_HEAD_OFFSET + 2].copy_from_slice(&0u16.to_le_bytes());
        data[ORDER_ENTRY_SIZE_OFFSET..ORDER_ENTRY_SIZE_OFFSET + 2]
            .copy_from_slice(&(ORDER_ENTRY_SIZE as u16).to_le_bytes());
        let base = ORDERS_DATA_OFFSET;
        data[base..base + 8].copy_from_slice(&(-1i64).to_le_bytes());
        data[base + 8..base + 16].copy_from_slice(&bid_size.to_le_bytes());
        data
    }

    fn make_midprice_data_with_ttl(
        mid_price: u64,
        ask_size: u64,
        authority: &Pubkey,
        ref_slot: u64,
        quote_ttl_slots: u64,
    ) -> Vec<u8> {
        let mut data = make_midprice_account_data(mid_price, ask_size, authority);
        data[REF_SLOT_OFFSET..REF_SLOT_OFFSET + 8].copy_from_slice(&ref_slot.to_le_bytes());
        data[QUOTE_TTL_OFFSET..QUOTE_TTL_OFFSET + 8]
            .copy_from_slice(&quote_ttl_slots.to_le_bytes());
        data
    }

    fn make_open_perp_order(
        direction: PositionDirection,
        price: u64,
        base_asset_amount: u64,
        slot: u64,
    ) -> Order {
        Order {
            status: OrderStatus::Open,
            order_type: OrderType::Limit,
            market_type: MarketType::Perp,
            market_index: 0,
            direction,
            price,
            base_asset_amount,
            slot,
            ..Order::default()
        }
    }

    fn make_revenue_share_escrow_data(
        authority: Pubkey,
        orders: &[RevenueShareOrder],
        approved_builders: &[BuilderInfo],
    ) -> Vec<u8> {
        let mut data = vec![0u8; RevenueShareEscrow::space(orders.len(), approved_builders.len())];
        data[..8].copy_from_slice(&RevenueShareEscrow::discriminator());

        let fixed = RevenueShareEscrowFixed {
            authority,
            ..RevenueShareEscrowFixed::default()
        };

        let mut offset = 8;
        let fixed_bytes = bytemuck::bytes_of(&fixed);
        data[offset..offset + fixed_bytes.len()].copy_from_slice(fixed_bytes);
        offset += fixed_bytes.len();

        data[offset..offset + 4].copy_from_slice(&0u32.to_le_bytes());
        offset += 4;
        data[offset..offset + 4].copy_from_slice(&(orders.len() as u32).to_le_bytes());
        offset += 4;

        for order in orders {
            let order_bytes = bytemuck::bytes_of(order);
            data[offset..offset + order_bytes.len()].copy_from_slice(order_bytes);
            offset += order_bytes.len();
        }

        data[offset..offset + 4].copy_from_slice(&0u32.to_le_bytes());
        offset += 4;
        data[offset..offset + 4].copy_from_slice(&(approved_builders.len() as u32).to_le_bytes());
        offset += 4;

        for builder in approved_builders {
            let builder_bytes = bytemuck::bytes_of(builder);
            data[offset..offset + builder_bytes.len()].copy_from_slice(builder_bytes);
            offset += builder_bytes.len();
        }

        data
    }

    fn make_margin_user(usdc_balance: u64, perp_base: i64) -> User {
        let mut spot_positions = [SpotPosition::default(); 8];
        spot_positions[0] = SpotPosition {
            market_index: 0,
            balance_type: SpotBalanceType::Deposit,
            scaled_balance: usdc_balance * SPOT_BALANCE_PRECISION_U64,
            ..SpotPosition::default()
        };
        let mut perp_positions = [PerpPosition::default(); 8];
        if perp_base != 0 {
            let quote =
                (perp_base as i128 * 100 * crate::math::constants::PRICE_PRECISION_I64 as i128
                    / BASE_PRECISION_U64 as i128) as i64;
            perp_positions[0] = PerpPosition {
                market_index: 0,
                base_asset_amount: perp_base,
                quote_asset_amount: -quote,
                quote_entry_amount: -quote,
                quote_break_even_amount: -quote,
                ..PerpPosition::default()
            };
        }
        User {
            spot_positions,
            perp_positions,
            ..User::default()
        }
    }

    mod validation_and_parsing {
        use super::*;

        #[test]
        fn fill_perp_order2_globals_rejects_user_stats_mismatch() {
            let user = User {
                authority: Pubkey::new_unique(),
                ..User::default()
            };
            let user_stats = UserStats {
                authority: Pubkey::new_unique(),
                ..UserStats::default()
            };

            let err = validate_fill_perp_order2_globals(&State::default(), &user, &user_stats)
                .expect_err("mismatched user_stats must be rejected");
            assert_eq!(err, ErrorCode::InvalidUserStatsAccount);
        }

        #[test]
        fn fill_perp_order2_globals_rejects_fill_paused() {
            let user = User {
                authority: Pubkey::new_unique(),
                ..User::default()
            };
            let user_stats = UserStats {
                authority: user.authority,
                ..UserStats::default()
            };
            let state = State {
                exchange_status: ExchangeStatus::FillPaused as u8,
                ..State::default()
            };

            let err = validate_fill_perp_order2_globals(&state, &user, &user_stats)
                .expect_err("fill pause must be enforced");
            assert_eq!(err, ErrorCode::ExchangePaused);
        }

        #[test]
        fn prop_amm_builder_and_referrer_rewards_accrue_to_escrow() {
            let authority = Pubkey::new_unique();

            let mut user = make_margin_user(100_000, BASE_PRECISION_U64 as i64);
            user.authority = authority;
            crate::create_anchor_account_info!(user, User, user_info);
            let user_loader = AccountLoader::<User>::try_from(&user_info).unwrap();

            let mut user_stats = UserStats {
                authority,
                ..UserStats::default()
            };
            crate::create_anchor_account_info!(user_stats, UserStats, user_stats_info);
            let user_stats_loader =
                AccountLoader::<crate::state::user::UserStats>::try_from(&user_stats_info).unwrap();

            let mut market = PerpMarket {
                market_index: 0,
                ..PerpMarket::default_test()
            };

            let builder_order = RevenueShareOrder::new(
                0,
                0,
                42,
                25,
                MarketType::Perp,
                0,
                RevenueShareOrderBitFlag::Open as u8,
                0,
            );
            let referral_order = RevenueShareOrder::new(
                0,
                0,
                0,
                0,
                MarketType::Perp,
                0,
                RevenueShareOrderBitFlag::Referral as u8,
                0,
            );
            let approved_builder = BuilderInfo {
                authority: Pubkey::new_unique(),
                max_fee_tenth_bps: 25,
                ..BuilderInfo::default()
            };

            let program_id = drift_program_id();
            let escrow_key = Pubkey::new_unique();
            let mut escrow_lamports = 0u64;
            let mut escrow_data = make_revenue_share_escrow_data(
                authority,
                &[builder_order, referral_order],
                &[approved_builder],
            );
            let escrow_info = create_account_info(
                &escrow_key,
                true,
                &mut escrow_lamports,
                &mut escrow_data[..],
                &program_id,
            );

            let remaining_accounts = vec![escrow_info.clone()];
            let mut iter = remaining_accounts.iter().peekable();
            let mut escrow = get_revenue_share_escrow_account(&mut iter, &authority)
                .unwrap()
                .expect("escrow must parse");

            let (builder_order_idx, referrer_builder_order_idx, builder_order_fee_bps, builder_idx) = {
                let mut escrow_ref = Some(&mut escrow);
                crate::controller::orders::get_builder_escrow_info(&mut escrow_ref, 0, 42, 0, true)
            };

            assert_eq!(builder_order_idx, Some(0));
            assert_eq!(referrer_builder_order_idx, Some(1));
            assert_eq!(builder_order_fee_bps, Some(25));
            assert_eq!(builder_idx, Some(0));

            let fill_fees = crate::math::fees::FillFees {
                user_fee: 100,
                maker_rebate: 0,
                fee_to_market: 80,
                fee_to_market_for_lp: 0,
                filler_reward: 0,
                referrer_reward: 20,
                referee_discount: 10,
                builder_fee: Some(5),
            };

            let quote_before = {
                let user = user_loader.load().unwrap();
                user.perp_positions[0].quote_asset_amount
            };

            if let Some(builder_fee) = fill_fees.builder_fee {
                let order = escrow
                    .get_order_mut(builder_order_idx.unwrap())
                    .expect("builder order must exist");
                order.fees_accrued = order.fees_accrued.safe_add(builder_fee).unwrap();
            }

            {
                let mut escrow_ref = Some(&mut escrow);
                apply_prop_amm_fill_fees(
                    &user_loader,
                    &mut market,
                    &user_stats_loader,
                    remaining_accounts.as_slice(),
                    None,
                    &mut escrow_ref,
                    referrer_builder_order_idx,
                    &fill_fees,
                    0,
                    0,
                )
                .unwrap();
            }

            escrow
                .get_order_mut(builder_order_idx.unwrap())
                .unwrap()
                .add_bit_flag(RevenueShareOrderBitFlag::Completed);

            let user_after = user_loader.load().unwrap();
            assert_eq!(
                user_after.perp_positions[0].quote_asset_amount,
                quote_before - 105,
                "taker quote must include builder fee deduction"
            );
            drop(user_after);

            let user_stats_after = user_stats_loader.load().unwrap();
            assert_eq!(user_stats_after.fees.total_fee_paid, 100);
            assert_eq!(user_stats_after.fees.total_referee_discount, 10);
            drop(user_stats_after);

            assert_eq!(market.amm.total_fee, 80);
            assert_eq!(market.amm.total_exchange_fee, 80);
            assert_eq!(market.amm.total_fee_minus_distributions, 80);
            assert_eq!(market.amm.net_revenue_since_last_funding, 80);

            let builder_order_after = escrow.get_order(builder_order_idx.unwrap()).unwrap();
            assert_eq!(builder_order_after.fees_accrued, 5);
            assert!(builder_order_after.is_completed());

            let referral_order_after = escrow
                .get_order(referrer_builder_order_idx.unwrap())
                .unwrap();
            assert_eq!(referral_order_after.fees_accrued, 20);
            assert!(referral_order_after.is_referral_order());
        }

        #[test]
        fn resolve_referrer_requires_accounts_when_referrer_set() {
            let taker_stats = UserStats {
                referrer: Pubkey::new_unique(),
                ..UserStats::default()
            };

            let err = resolve_referrer(&taker_stats, &[], 0, &drift_program_id(), 0)
                .expect_err("missing referrer accounts must error");
            assert_eq!(err, ErrorCode::ReferrerNotFound);
        }

        #[test]
        fn parse_amm_views_skips_unhealthy_prop_amm_maker() {
            let program_id = drift_program_id();
            let midprice_prog_id = midprice_program_id();
            let (healthy_authority, healthy_key) = derive_maker_user_pda();
            let mut healthy_user = User {
                authority: healthy_authority,
                sub_account_id: 0,
                ..User::default()
            };
            crate::create_anchor_account_info!(healthy_user, &healthy_key, User, healthy_user_info);

            let (bankrupt_authority, bankrupt_key) = derive_maker_user_pda();
            let mut bankrupt_user = User {
                authority: bankrupt_authority,
                sub_account_id: 0,
                status: UserStatus::Bankrupt as u8,
                ..User::default()
            };
            crate::create_anchor_account_info!(
                bankrupt_user,
                &bankrupt_key,
                User,
                bankrupt_user_info
            );

            let mut healthy_mid_lamports = 0u64;
            let mut healthy_mid_data = make_midprice_account_data(
                100 * PRICE_PRECISION_U64,
                5 * BASE_PRECISION_U64,
                &healthy_authority,
            );
            let healthy_mid_key = Pubkey::new_unique();
            let healthy_mid_info = create_account_info(
                &healthy_mid_key,
                true,
                &mut healthy_mid_lamports,
                &mut healthy_mid_data[..],
                &midprice_prog_id,
            );

            let mut bankrupt_mid_lamports = 0u64;
            let mut bankrupt_mid_data = make_midprice_account_data(
                101 * PRICE_PRECISION_U64,
                5 * BASE_PRECISION_U64,
                &bankrupt_authority,
            );
            let bankrupt_mid_key = Pubkey::new_unique();
            let bankrupt_mid_info = create_account_info(
                &bankrupt_mid_key,
                true,
                &mut bankrupt_mid_lamports,
                &mut bankrupt_mid_data[..],
                &midprice_prog_id,
            );

            let mut prog_lamports = 0u64;
            let mut prog_data = [0u8; 0];
            let program_info = create_executable_program_account_info(
                &midprice_prog_id,
                &mut prog_lamports,
                &mut prog_data[..],
            );
            let (matcher_pda, _) = prop_amm_matcher_pda(&program_id);
            let mut matcher_lamports = 0u64;
            let mut matcher_data = [0u8; 0];
            let matcher_info = create_account_info(
                &matcher_pda,
                true,
                &mut matcher_lamports,
                &mut matcher_data[..],
                &program_id,
            );

            let remaining: Vec<AccountInfo> = vec![
                program_info,
                matcher_info,
                healthy_mid_info,
                healthy_user_info,
                bankrupt_mid_info,
                bankrupt_user_info,
            ];

            let (_, amm_views, _) =
                parse_amm_views(remaining.as_slice(), 1, &program_id, 100, Some(0), None).unwrap();
            assert_eq!(amm_views.len(), 1, "bankrupt PropAMM maker must be skipped");
            assert_eq!(
                remaining[amm_views[0].maker_user_remaining_index].key(),
                healthy_key
            );
        }

        #[test]
        fn parse_dlob_makers_excludes_younger_maker_for_resting_taker() {
            let program_id = drift_program_id();
            let taker_key = Pubkey::new_unique();

            let older_maker_key = Pubkey::new_unique();
            let older_stats_key = Pubkey::new_unique();
            let maker_authority = Pubkey::new_unique();
            let mut older_maker = User {
                authority: maker_authority,
                ..User::default()
            };
            older_maker.orders[0] = make_open_perp_order(
                PositionDirection::Short,
                100 * PRICE_PRECISION_U64,
                5 * BASE_PRECISION_U64,
                5,
            );
            crate::create_anchor_account_info!(
                older_maker,
                &older_maker_key,
                User,
                older_maker_info
            );
            let mut older_stats = UserStats {
                authority: maker_authority,
                ..UserStats::default()
            };
            crate::create_anchor_account_info!(
                older_stats,
                &older_stats_key,
                UserStats,
                older_stats_info
            );

            let younger_maker_key = Pubkey::new_unique();
            let younger_stats_key = Pubkey::new_unique();
            let younger_authority = Pubkey::new_unique();
            let mut younger_maker = User {
                authority: younger_authority,
                ..User::default()
            };
            younger_maker.orders[0] = make_open_perp_order(
                PositionDirection::Short,
                100 * PRICE_PRECISION_U64,
                5 * BASE_PRECISION_U64,
                12,
            );
            crate::create_anchor_account_info!(
                younger_maker,
                &younger_maker_key,
                User,
                younger_maker_info
            );
            let mut younger_stats = UserStats {
                authority: younger_authority,
                ..UserStats::default()
            };
            crate::create_anchor_account_info!(
                younger_stats,
                &younger_stats_key,
                UserStats,
                younger_stats_info
            );

            let remaining: Vec<AccountInfo> = vec![
                older_maker_info,
                older_stats_info,
                younger_maker_info,
                younger_stats_info,
            ];

            let (views, next_idx) = parse_dlob_makers(
                remaining.as_slice(),
                0,
                &program_id,
                &taker_key,
                PositionDirection::Long,
                0,
                101 * PRICE_PRECISION_U64,
                (100 * PRICE_PRECISION_U64) as i64,
                15,
                0,
                PRICE_PRECISION_U64,
                false,
                true,
                10,
                5,
                false,
                crate::state::protected_maker_mode_config::ProtectedMakerParams::default(),
                10,
                500,
                BASE_PRECISION_U64,
            )
            .unwrap();

            assert_eq!(next_idx, 4);
            assert_eq!(views.len(), 1, "only the older maker should remain");
            assert_eq!(views[0].maker_key, older_maker_key);
        }

        #[test]
        fn parse_dlob_makers_excludes_oracle_band_breaching_maker() {
            let program_id = drift_program_id();
            let maker_key = Pubkey::new_unique();
            let maker_stats_key = Pubkey::new_unique();
            let maker_authority = Pubkey::new_unique();
            let mut maker = User {
                authority: maker_authority,
                ..User::default()
            };
            maker.orders[0] = make_open_perp_order(
                PositionDirection::Short,
                80 * PRICE_PRECISION_U64,
                5 * BASE_PRECISION_U64,
                1,
            );
            crate::create_anchor_account_info!(maker, &maker_key, User, maker_info);
            let mut maker_stats = UserStats {
                authority: maker_authority,
                ..UserStats::default()
            };
            crate::create_anchor_account_info!(
                maker_stats,
                &maker_stats_key,
                UserStats,
                maker_stats_info
            );

            let (views, _) = parse_dlob_makers(
                &[maker_info, maker_stats_info],
                0,
                &program_id,
                &Pubkey::new_unique(),
                PositionDirection::Long,
                0,
                130 * PRICE_PRECISION_U64,
                (100 * PRICE_PRECISION_U64) as i64,
                5,
                0,
                PRICE_PRECISION_U64,
                false,
                false,
                0,
                5,
                true,
                crate::state::protected_maker_mode_config::ProtectedMakerParams::default(),
                10,
                500,
                BASE_PRECISION_U64,
            )
            .unwrap();

            assert!(views.is_empty(), "maker above oracle band must be excluded");
        }

        #[test]
        fn load_fill_perp_order2_market_maps_includes_extra_perp_markets() {
            let program_id = drift_program_id();
            let midprice_program_id = midprice_program_id();
            let mut program_lamports = 0u64;
            let mut program_data = [0u8; 0];
            let program_info = create_executable_program_account_info(
                &midprice_program_id,
                &mut program_lamports,
                &mut program_data[..],
            );

            let mut spot_market = SpotMarket::default();
            spot_market.market_index = 0;
            crate::create_anchor_account_info!(spot_market, SpotMarket, spot_market_info);

            let mut extra_perp_market = PerpMarket::default();
            extra_perp_market.market_index = 7;
            crate::create_anchor_account_info!(
                extra_perp_market,
                PerpMarket,
                extra_perp_market_info
            );

            let (matcher_pda, _) = prop_amm_matcher_pda(&program_id);
            let mut matcher_lamports = 0u64;
            let mut matcher_data = [0u8; 0];
            let matcher_info = create_account_info(
                &matcher_pda,
                true,
                &mut matcher_lamports,
                &mut matcher_data[..],
                &program_id,
            );

            let remaining: Vec<AccountInfo> = vec![
                program_info,
                spot_market_info,
                extra_perp_market_info,
                matcher_info,
            ];

            let mut current_perp_market = PerpMarket::default();
            current_perp_market.market_index = 0;
            crate::create_anchor_account_info!(
                current_perp_market,
                PerpMarket,
                current_perp_market_info
            );
            let current_loader =
                AccountLoader::<PerpMarket>::try_from(&current_perp_market_info).unwrap();

            let (spot_market_map, perp_market_map) =
                load_fill_perp_order2_market_maps(remaining.as_slice(), 1, 3, &current_loader, 0)
                    .unwrap();

            assert!(
                spot_market_map.get_ref(&0).is_ok(),
                "quote spot market must load"
            );
            assert!(
                perp_market_map.get_ref(&0).is_ok(),
                "current perp market must remain loaded"
            );
            assert!(
                perp_market_map.get_ref(&7).is_ok(),
                "extra perp market must be available for margin checks"
            );
        }

        #[test]
        fn load_fill_perp_order2_market_maps_skips_live_oracle_prefix() {
            let program_id = drift_program_id();
            let midprice_program_id = midprice_program_id();
            let mut program_lamports = 0u64;
            let mut program_data = [0u8; 0];
            let program_info = create_executable_program_account_info(
                &midprice_program_id,
                &mut program_lamports,
                &mut program_data[..],
            );

            let oracle_key = Pubkey::new_unique();
            let oracle_owner = crate::ids::pyth_program::id();
            let mut oracle_lamports = 0u64;
            let mut oracle_price = get_pyth_price(100, 6);
            let mut oracle_data = get_account_bytes(&mut oracle_price);
            let oracle_info = create_account_info(
                &oracle_key,
                false,
                &mut oracle_lamports,
                &mut oracle_data[..],
                &oracle_owner,
            );

            let mut spot_market = SpotMarket::default();
            spot_market.market_index = 0;
            crate::create_anchor_account_info!(spot_market, SpotMarket, spot_market_info);

            let mut extra_perp_market = PerpMarket::default();
            extra_perp_market.market_index = 7;
            crate::create_anchor_account_info!(
                extra_perp_market,
                PerpMarket,
                extra_perp_market_info
            );

            let (matcher_pda, _) = prop_amm_matcher_pda(&program_id);
            let mut matcher_lamports = 0u64;
            let mut matcher_data = [0u8; 0];
            let matcher_info = create_account_info(
                &matcher_pda,
                true,
                &mut matcher_lamports,
                &mut matcher_data[..],
                &program_id,
            );

            let remaining: Vec<AccountInfo> = vec![
                program_info,
                oracle_info,
                spot_market_info,
                extra_perp_market_info,
                matcher_info,
            ];

            let mut current_perp_market = PerpMarket::default();
            current_perp_market.market_index = 0;
            crate::create_anchor_account_info!(
                current_perp_market,
                PerpMarket,
                current_perp_market_info
            );
            let current_loader =
                AccountLoader::<PerpMarket>::try_from(&current_perp_market_info).unwrap();

            let (spot_market_map, perp_market_map) =
                load_fill_perp_order2_market_maps(remaining.as_slice(), 2, 4, &current_loader, 0)
                    .unwrap();

            assert!(
                spot_market_map.get_ref(&0).is_ok(),
                "quote spot market must load after live oracle prefix"
            );
            assert!(
                perp_market_map.get_ref(&7).is_ok(),
                "extra perp market must still load after live oracle prefix"
            );
        }

        /// Duplicate (midprice, maker_user) in remaining_accounts must be rejected (no double fill).
        #[test]
        fn duplicate_prop_amm_accounts_rejected() {
            let program_id = drift_program_id();
            let midprice_key = Pubkey::new_unique();
            let (maker_authority, maker_user_key) = derive_maker_user_pda();
            let mut maker_user = User::default();
            maker_user.authority = maker_authority;
            maker_user.sub_account_id = 0;
            crate::create_anchor_account_info!(maker_user, &maker_user_key, User, maker_user_info);

            let mid_price = 100 * PRICE_PRECISION_U64;
            let data =
                make_midprice_account_data(mid_price, 100 * BASE_PRECISION_U64, &maker_authority);
            let midprice_prog_id = midprice_program_id();
            let mut midprice_lamports = 0u64;
            let mut midprice_data = data.clone();
            let midprice_info = create_account_info(
                &midprice_key,
                true,
                &mut midprice_lamports,
                &mut midprice_data[..],
                &midprice_prog_id,
            );
            let mut prog_lamps = 0u64;
            let mut prog_data = [0u8; 0];
            let program_info = create_executable_program_account_info(
                &midprice_prog_id,
                &mut prog_lamps,
                &mut prog_data[..],
            );
            let (global_matcher_pda, _) = prop_amm_matcher_pda(&program_id);
            let mut global_matcher_lamports = 0u64;
            let mut global_matcher_data = [0u8; 0];
            let global_matcher_info = create_account_info(
                &global_matcher_pda,
                true,
                &mut global_matcher_lamports,
                &mut global_matcher_data[..],
                &program_id,
            );
            let mut remaining: Vec<AccountInfo> = vec![program_info, global_matcher_info];
            remaining.push(midprice_info.clone());
            remaining.push(maker_user_info.clone());
            remaining.push(midprice_info);
            remaining.push(maker_user_info);

            let res = parse_amm_views(remaining.as_slice(), 1, &program_id, 100, None, None);
            match res {
                Err(e) => assert_eq!(e, ErrorCode::InvalidPropAmmAccountLayout),
                Ok(_) => panic!("duplicate (midprice, maker_user) must be rejected"),
            }
        }

        /// External fills from matching must deduct exactly the filled size per level (PropAMM orders removed after fill).
        #[test]
        fn prop_amm_external_fills_match_allocated_size() {
            let program_id = drift_program_id();
            let midprice_key = Pubkey::new_unique();
            let (maker_authority, maker_user_key) = derive_maker_user_pda();
            let mut maker_user = User::default();
            maker_user.authority = maker_authority;
            maker_user.sub_account_id = 0;
            crate::create_anchor_account_info!(maker_user, &maker_user_key, User, maker_user_info);

            let mid_price = 100 * PRICE_PRECISION_U64;
            let ask_size = 50 * BASE_PRECISION_U64;
            let data = make_midprice_account_data(mid_price, ask_size, &maker_authority);
            let midprice_prog_id = midprice_program_id();
            let mut midprice_lamports = 0u64;
            let mut midprice_data = data;
            let midprice_info = create_account_info(
                &midprice_key,
                true,
                &mut midprice_lamports,
                &mut midprice_data[..],
                &midprice_prog_id,
            );

            let mut prog_lamps = 0u64;
            let mut prog_data = [0u8; 0];
            let program_info = create_executable_program_account_info(
                &midprice_prog_id,
                &mut prog_lamps,
                &mut prog_data[..],
            );
            let (global_matcher_pda, _) = prop_amm_matcher_pda(&program_id);
            let mut global_matcher_lamports = 0u64;
            let mut global_matcher_data = [0u8; 0];
            let global_matcher_info = create_account_info(
                &global_matcher_pda,
                true,
                &mut global_matcher_lamports,
                &mut global_matcher_data[..],
                &program_id,
            );

            let remaining_accounts: Vec<AccountInfo> = vec![
                program_info,
                global_matcher_info,
                midprice_info,
                maker_user_info,
            ];
            let slice = remaining_accounts.as_slice();

            let (_, amm_views, _) =
                parse_amm_views(slice, 1, &program_id, 100, None, None).unwrap();
            let taker_size = 30 * BASE_PRECISION_U64;
            let limit_price = 101 * PRICE_PRECISION_U64;
            let result = run_prop_amm_matching(
                &amm_views,
                slice,
                PositionDirection::Long,
                limit_price,
                taker_size,
            )
            .unwrap();

            assert!(!result.external_fills.is_empty());
            let total_filled: u64 = result.external_fills.iter().map(|p| p.fill.fill_size).sum();
            assert_eq!(
                total_filled, taker_size,
                "filled size must match taker size"
            );
            for pf in &result.external_fills {
                assert!(
                    pf.fill.fill_size <= ask_size,
                    "each fill must not exceed level size (PropAMM order removed by fill_size)"
                );
            }
        }

        /// After applying prop AMM fill deltas to the taker, margin requirement must remain valid.
        #[test]
        fn margin_checks_upheld_post_fill() {
            let slot = 0_u64;
            let oracle_key =
                Pubkey::from_str("J83w4HKfqxwcq3BEMMkPFSppX3gqekLyLJBexebFVkix").unwrap();
            let pyth_program = crate::ids::pyth_program::id();
            let mut oracle_price = get_pyth_price(100, 6);
            crate::create_account_info!(
                oracle_price,
                &oracle_key,
                &pyth_program,
                oracle_account_info
            );
            let mut oracle_map =
                crate::state::oracle_map::OracleMap::load_one(&oracle_account_info, slot, None)
                    .unwrap();

            let mut perp_market = PerpMarket {
                market_index: 0,
                amm: AMM {
                    base_asset_reserve: 100 * AMM_RESERVE_PRECISION,
                    quote_asset_reserve: 100 * AMM_RESERVE_PRECISION,
                    oracle: oracle_key,
                    order_tick_size: 1,
                    historical_oracle_data: HistoricalOracleData {
                        last_oracle_price: 100 * crate::math::constants::PRICE_PRECISION_I64,
                        last_oracle_price_twap: 100 * crate::math::constants::PRICE_PRECISION_I64,
                        ..HistoricalOracleData::default()
                    },
                    ..AMM::default()
                },
                margin_ratio_initial: 1000,
                margin_ratio_maintenance: 500,
                status: MarketStatus::Active,
                ..PerpMarket::default_test()
            };
            perp_market.amm.max_base_asset_reserve = u64::MAX as u128;
            perp_market.amm.min_base_asset_reserve = 0;
            crate::create_anchor_account_info!(perp_market, PerpMarket, perp_market_info);
            let perp_market_map = PerpMarketMap::load_one(&perp_market_info, true).unwrap();

            let mut spot_market = SpotMarket {
                market_index: 0,
                oracle_source: OracleSource::QuoteAsset,
                cumulative_deposit_interest: SPOT_CUMULATIVE_INTEREST_PRECISION,
                decimals: 6,
                initial_asset_weight: SPOT_WEIGHT_PRECISION,
                maintenance_asset_weight: SPOT_WEIGHT_PRECISION,
                historical_oracle_data: HistoricalOracleData::default_quote_oracle(),
                ..SpotMarket::default()
            };
            crate::create_anchor_account_info!(spot_market, SpotMarket, spot_market_info);
            let spot_market_map = SpotMarketMap::load_one(&spot_market_info, true).unwrap();

            let mut spot_positions = [SpotPosition::default(); 8];
            spot_positions[0] = SpotPosition {
                market_index: 0,
                balance_type: crate::state::spot_market::SpotBalanceType::Deposit,
                scaled_balance: 100_000 * SPOT_BALANCE_PRECISION_U64,
                ..SpotPosition::default()
            };
            let mut perp_positions = [PerpPosition::default(); 8];
            perp_positions[0] = PerpPosition {
                market_index: 0,
                base_asset_amount: 10 * BASE_PRECISION_U64 as i64,
                quote_asset_amount: -(10 * 100 * crate::math::constants::PRICE_PRECISION_I64),
                quote_entry_amount: -(10 * 100 * crate::math::constants::PRICE_PRECISION_I64),
                quote_break_even_amount: -(10 * 100 * crate::math::constants::PRICE_PRECISION_I64),
                ..PerpPosition::default()
            };

            let user = User {
                spot_positions,
                perp_positions,
                ..User::default()
            };

            let margin_calc = calculate_margin_requirement_and_total_collateral_and_liability_info(
                &user,
                &perp_market_map,
                &spot_market_map,
                &mut oracle_map,
                MarginContext::standard(MarginRequirementType::Initial),
            )
            .unwrap();

            assert!(
                margin_calc.meets_cross_margin_requirement(),
                "pre-fill: margin must be satisfied"
            );

            let fill_base = 5 * BASE_PRECISION_U64 as i64;
            let fill_quote = 5 * 100 * crate::math::constants::PRICE_PRECISION_I64;
            let user_after_fill = User {
                perp_positions: {
                    let mut p = user.perp_positions;
                    p[0].base_asset_amount += fill_base;
                    p[0].quote_asset_amount -= fill_quote;
                    p[0].quote_entry_amount -= fill_quote;
                    p[0].quote_break_even_amount -= fill_quote;
                    p
                },
                ..user
            };

            let margin_calc_after =
                calculate_margin_requirement_and_total_collateral_and_liability_info(
                    &user_after_fill,
                    &perp_market_map,
                    &spot_market_map,
                    &mut oracle_map,
                    MarginContext::standard(MarginRequirementType::Initial),
                )
                .unwrap();

            assert!(
                margin_calc_after.meets_cross_margin_requirement(),
                "post-fill: margin must still be satisfied after prop AMM fill"
            );
        }

        /// Taker has an existing perp position in the same market (fill market); margin holds after adding fill.
        #[test]
        fn margin_taker_existing_perp_position_same_market() {
            let slot = 0_u64;
            let oracle_key =
                Pubkey::from_str("J83w4HKfqxwcq3BEMMkPFSppX3gqekLyLJBexebFVkix").unwrap();
            let pyth_program = crate::ids::pyth_program::id();
            let mut oracle_price = get_pyth_price(100, 6);
            crate::create_account_info!(
                oracle_price,
                &oracle_key,
                &pyth_program,
                oracle_account_info
            );
            let mut oracle_map =
                crate::state::oracle_map::OracleMap::load_one(&oracle_account_info, slot, None)
                    .unwrap();

            let mut perp_market = PerpMarket {
                market_index: 0,
                amm: AMM {
                    base_asset_reserve: 100 * AMM_RESERVE_PRECISION,
                    quote_asset_reserve: 100 * AMM_RESERVE_PRECISION,
                    oracle: oracle_key,
                    order_tick_size: 1,
                    historical_oracle_data: HistoricalOracleData {
                        last_oracle_price: 100 * crate::math::constants::PRICE_PRECISION_I64,
                        last_oracle_price_twap: 100 * crate::math::constants::PRICE_PRECISION_I64,
                        ..HistoricalOracleData::default()
                    },
                    ..AMM::default()
                },
                margin_ratio_initial: 1000,
                margin_ratio_maintenance: 500,
                status: MarketStatus::Active,
                ..PerpMarket::default_test()
            };
            perp_market.amm.max_base_asset_reserve = u64::MAX as u128;
            perp_market.amm.min_base_asset_reserve = 0;
            crate::create_anchor_account_info!(perp_market, PerpMarket, perp_market_info);
            let perp_market_map = PerpMarketMap::load_one(&perp_market_info, true).unwrap();

            let mut spot_market = SpotMarket {
                market_index: 0,
                oracle_source: OracleSource::QuoteAsset,
                cumulative_deposit_interest: SPOT_CUMULATIVE_INTEREST_PRECISION,
                decimals: 6,
                initial_asset_weight: SPOT_WEIGHT_PRECISION,
                maintenance_asset_weight: SPOT_WEIGHT_PRECISION,
                historical_oracle_data: HistoricalOracleData::default_quote_oracle(),
                ..SpotMarket::default()
            };
            crate::create_anchor_account_info!(spot_market, SpotMarket, spot_market_info);
            let spot_market_map = SpotMarketMap::load_one(&spot_market_info, true).unwrap();

            // Taker: existing long in market 0 (same market as fill).
            let mut spot_positions = [SpotPosition::default(); 8];
            spot_positions[0] = SpotPosition {
                market_index: 0,
                balance_type: crate::state::spot_market::SpotBalanceType::Deposit,
                scaled_balance: 100_000 * SPOT_BALANCE_PRECISION_U64,
                ..SpotPosition::default()
            };
            let mut perp_positions = [PerpPosition::default(); 8];
            perp_positions[0] = PerpPosition {
                market_index: 0,
                base_asset_amount: 8 * BASE_PRECISION_U64 as i64,
                quote_asset_amount: -(8 * 100 * crate::math::constants::PRICE_PRECISION_I64),
                quote_entry_amount: -(8 * 100 * crate::math::constants::PRICE_PRECISION_I64),
                quote_break_even_amount: -(8 * 100 * crate::math::constants::PRICE_PRECISION_I64),
                ..PerpPosition::default()
            };

            let user = User {
                spot_positions,
                perp_positions,
                ..User::default()
            };

            let margin_calc = calculate_margin_requirement_and_total_collateral_and_liability_info(
                &user,
                &perp_market_map,
                &spot_market_map,
                &mut oracle_map,
                MarginContext::standard(MarginRequirementType::Initial),
            )
            .unwrap();
            assert!(
                margin_calc.meets_cross_margin_requirement(),
                "pre-fill: taker with existing long in same market must be solvent"
            );

            // Fill adds more long (same direction).
            let fill_base = 4 * BASE_PRECISION_U64 as i64;
            let fill_quote = 4 * 100 * crate::math::constants::PRICE_PRECISION_I64;
            let user_after_fill = User {
                perp_positions: {
                    let mut p = user.perp_positions;
                    p[0].base_asset_amount += fill_base;
                    p[0].quote_asset_amount -= fill_quote;
                    p[0].quote_entry_amount -= fill_quote;
                    p[0].quote_break_even_amount -= fill_quote;
                    p
                },
                ..user
            };

            let margin_calc_after =
                calculate_margin_requirement_and_total_collateral_and_liability_info(
                    &user_after_fill,
                    &perp_market_map,
                    &spot_market_map,
                    &mut oracle_map,
                    MarginContext::standard(MarginRequirementType::Initial),
                )
                .unwrap();
            assert!(
                margin_calc_after.meets_cross_margin_requirement(),
                "post-fill: taker with existing long + fill in same market must stay solvent"
            );
        }

        /// User has collateral in multiple spot assets and a perp position in a different market
        /// (not the fill market). Margin must be satisfied before and after a simulated fill on market 0.
        #[test]
        fn margin_multiple_spot_and_perp_in_different_market() {
            let slot = 0_u64;
            let oracle_key =
                Pubkey::from_str("J83w4HKfqxwcq3BEMMkPFSppX3gqekLyLJBexebFVkix").unwrap();
            let pyth_program = crate::ids::pyth_program::id();
            let mut oracle_price = get_pyth_price(100, 6);
            crate::create_account_info!(
                oracle_price,
                &oracle_key,
                &pyth_program,
                oracle_account_info
            );
            let mut oracle_map =
                crate::state::oracle_map::OracleMap::load_one(&oracle_account_info, slot, None)
                    .unwrap();

            // Perp market 0 (fill market) and 1 (other market – user has position here).
            let make_perp_market = |market_index: u16| {
                let mut perp_market = PerpMarket {
                    market_index,
                    amm: AMM {
                        base_asset_reserve: 100 * AMM_RESERVE_PRECISION,
                        quote_asset_reserve: 100 * AMM_RESERVE_PRECISION,
                        oracle: oracle_key,
                        order_tick_size: 1,
                        historical_oracle_data: HistoricalOracleData {
                            last_oracle_price: 100 * crate::math::constants::PRICE_PRECISION_I64,
                            last_oracle_price_twap: 100
                                * crate::math::constants::PRICE_PRECISION_I64,
                            ..HistoricalOracleData::default()
                        },
                        ..AMM::default()
                    },
                    margin_ratio_initial: 1000,
                    margin_ratio_maintenance: 500,
                    status: MarketStatus::Active,
                    ..PerpMarket::default_test()
                };
                perp_market.amm.max_base_asset_reserve = u64::MAX as u128;
                perp_market.amm.min_base_asset_reserve = 0;
                perp_market
            };
            let mut perp_market_0 = make_perp_market(0);
            let mut perp_market_1 = make_perp_market(1);
            crate::create_anchor_account_info!(perp_market_0, PerpMarket, perp_market_info_0);
            crate::create_anchor_account_info!(perp_market_1, PerpMarket, perp_market_info_1);
            let perp_market_map =
                PerpMarketMap::load_multiple(vec![&perp_market_info_0, &perp_market_info_1], true)
                    .unwrap();

            // Spot markets 0 and 1 (user has collateral in both).
            let make_spot_market = |market_index: u16| {
                let mut spot_market = SpotMarket {
                    market_index,
                    oracle_source: OracleSource::QuoteAsset,
                    cumulative_deposit_interest: SPOT_CUMULATIVE_INTEREST_PRECISION,
                    decimals: 6,
                    initial_asset_weight: SPOT_WEIGHT_PRECISION,
                    maintenance_asset_weight: SPOT_WEIGHT_PRECISION,
                    historical_oracle_data: HistoricalOracleData::default_quote_oracle(),
                    ..SpotMarket::default()
                };
                spot_market
            };
            let mut spot_market_0 = make_spot_market(0);
            let mut spot_market_1 = make_spot_market(1);
            crate::create_anchor_account_info!(spot_market_0, SpotMarket, spot_market_info_0);
            crate::create_anchor_account_info!(spot_market_1, SpotMarket, spot_market_info_1);
            let spot_market_map =
                SpotMarketMap::load_multiple(vec![&spot_market_info_0, &spot_market_info_1], true)
                    .unwrap();

            // User: collateral in spot 0 and 1; perp position only in market 1 (different from fill market 0).
            let mut spot_positions = [SpotPosition::default(); 8];
            spot_positions[0] = SpotPosition {
                market_index: 0,
                balance_type: crate::state::spot_market::SpotBalanceType::Deposit,
                scaled_balance: 50_000 * SPOT_BALANCE_PRECISION_U64,
                ..SpotPosition::default()
            };
            spot_positions[1] = SpotPosition {
                market_index: 1,
                balance_type: crate::state::spot_market::SpotBalanceType::Deposit,
                scaled_balance: 50_000 * SPOT_BALANCE_PRECISION_U64,
                ..SpotPosition::default()
            };
            let mut perp_positions = [PerpPosition::default(); 8];
            perp_positions[1] = PerpPosition {
                market_index: 1,
                base_asset_amount: 5 * BASE_PRECISION_U64 as i64,
                quote_asset_amount: -(5 * 100 * crate::math::constants::PRICE_PRECISION_I64),
                quote_entry_amount: -(5 * 100 * crate::math::constants::PRICE_PRECISION_I64),
                quote_break_even_amount: -(5 * 100 * crate::math::constants::PRICE_PRECISION_I64),
                ..PerpPosition::default()
            };

            let user = User {
                spot_positions,
                perp_positions,
                ..User::default()
            };

            let margin_calc = calculate_margin_requirement_and_total_collateral_and_liability_info(
                &user,
                &perp_market_map,
                &spot_market_map,
                &mut oracle_map,
                MarginContext::standard(MarginRequirementType::Initial),
            )
            .unwrap();

            assert!(
                margin_calc.meets_cross_margin_requirement(),
                "pre-fill: user with multiple spot + perp in other market must be solvent"
            );

            // Simulate fill on market 0 (user gains long position on market 0).
            let fill_base = 3 * BASE_PRECISION_U64 as i64;
            let fill_quote = 3 * 100 * crate::math::constants::PRICE_PRECISION_I64;
            let user_after_fill = User {
                perp_positions: {
                    let mut p = user.perp_positions;
                    p[0].market_index = 0;
                    p[0].base_asset_amount = fill_base;
                    p[0].quote_asset_amount = -fill_quote;
                    p[0].quote_entry_amount = -fill_quote;
                    p[0].quote_break_even_amount = -fill_quote;
                    p
                },
                ..user
            };

            let margin_calc_after =
                calculate_margin_requirement_and_total_collateral_and_liability_info(
                    &user_after_fill,
                    &perp_market_map,
                    &spot_market_map,
                    &mut oracle_map,
                    MarginContext::standard(MarginRequirementType::Initial),
                )
                .unwrap();

            assert!(
            margin_calc_after.meets_cross_margin_requirement(),
            "post-fill: margin must still be satisfied after fill on market 0 (user had spot in 0,1 and perp in 1)"
        );
        }

        /// Maker and/or taker has collateral in a non-quote spot market (not USDC / market 0).
        /// Margin must be satisfied when collateral is valued via that market's oracle.
        #[test]
        fn margin_collateral_non_quote_spot_market() {
            let slot = 0_u64;
            let oracle_key =
                Pubkey::from_str("J83w4HKfqxwcq3BEMMkPFSppX3gqekLyLJBexebFVkix").unwrap();
            let pyth_program = crate::ids::pyth_program::id();
            let mut oracle_price = get_pyth_price(100, 6);
            crate::create_account_info!(
                oracle_price,
                &oracle_key,
                &pyth_program,
                oracle_account_info
            );
            let mut oracle_map =
                crate::state::oracle_map::OracleMap::load_one(&oracle_account_info, slot, None)
                    .unwrap();

            // Perp market 0 (fill market).
            let mut perp_market = PerpMarket {
                market_index: 0,
                amm: AMM {
                    base_asset_reserve: 100 * AMM_RESERVE_PRECISION,
                    quote_asset_reserve: 100 * AMM_RESERVE_PRECISION,
                    oracle: oracle_key,
                    order_tick_size: 1,
                    historical_oracle_data: HistoricalOracleData {
                        last_oracle_price: 100 * crate::math::constants::PRICE_PRECISION_I64,
                        last_oracle_price_twap: 100 * crate::math::constants::PRICE_PRECISION_I64,
                        ..HistoricalOracleData::default()
                    },
                    ..AMM::default()
                },
                margin_ratio_initial: 1000,
                margin_ratio_maintenance: 500,
                status: MarketStatus::Active,
                ..PerpMarket::default_test()
            };
            perp_market.amm.max_base_asset_reserve = u64::MAX as u128;
            perp_market.amm.min_base_asset_reserve = 0;
            crate::create_anchor_account_info!(perp_market, PerpMarket, perp_market_info);
            let perp_market_map = PerpMarketMap::load_one(&perp_market_info, true).unwrap();

            // Spot market 0 = quote (USDC); spot market 1 = non-quote, priced by Pyth oracle.
            let mut spot_market_0 = SpotMarket {
                market_index: 0,
                oracle: Pubkey::default(),
                oracle_source: OracleSource::QuoteAsset,
                cumulative_deposit_interest: SPOT_CUMULATIVE_INTEREST_PRECISION,
                decimals: 6,
                initial_asset_weight: SPOT_WEIGHT_PRECISION,
                maintenance_asset_weight: SPOT_WEIGHT_PRECISION,
                historical_oracle_data: HistoricalOracleData::default_quote_oracle(),
                ..SpotMarket::default()
            };
            let mut spot_market_1 = SpotMarket {
                market_index: 1,
                oracle: oracle_key,
                oracle_source: OracleSource::Pyth,
                cumulative_deposit_interest: SPOT_CUMULATIVE_INTEREST_PRECISION,
                decimals: 6,
                initial_asset_weight: SPOT_WEIGHT_PRECISION,
                maintenance_asset_weight: SPOT_WEIGHT_PRECISION,
                historical_oracle_data: HistoricalOracleData {
                    last_oracle_price_twap: 100 * crate::math::constants::PRICE_PRECISION_I64,
                    last_oracle_price_twap_5min: 100 * crate::math::constants::PRICE_PRECISION_I64,
                    ..HistoricalOracleData::default()
                },
                ..SpotMarket::default()
            };
            crate::create_anchor_account_info!(spot_market_0, SpotMarket, spot_market_info_0);
            crate::create_anchor_account_info!(spot_market_1, SpotMarket, spot_market_info_1);
            let spot_market_map =
                SpotMarketMap::load_multiple(vec![&spot_market_info_0, &spot_market_info_1], true)
                    .unwrap();

            // User: no USDC (market 0); collateral only in non-quote spot market 1 (oracle price 100).
            let mut spot_positions = [SpotPosition::default(); 8];
            spot_positions[1] = SpotPosition {
                market_index: 1,
                balance_type: crate::state::spot_market::SpotBalanceType::Deposit,
                scaled_balance: 200_000 * SPOT_BALANCE_PRECISION_U64,
                ..SpotPosition::default()
            };
            let perp_positions = [PerpPosition::default(); 8];

            let user = User {
                spot_positions,
                perp_positions,
                ..User::default()
            };

            let margin_calc = calculate_margin_requirement_and_total_collateral_and_liability_info(
                &user,
                &perp_market_map,
                &spot_market_map,
                &mut oracle_map,
                MarginContext::standard(MarginRequirementType::Initial),
            )
            .unwrap();

            assert!(
                margin_calc.meets_cross_margin_requirement(),
                "user with collateral only in non-quote spot market (not USDC) must be solvent"
            );

            // Simulate a small fill on market 0; margin must still hold.
            let fill_base = 2 * BASE_PRECISION_U64 as i64;
            let fill_quote = 2 * 100 * crate::math::constants::PRICE_PRECISION_I64;
            let user_after_fill = User {
                perp_positions: {
                    let mut p = user.perp_positions;
                    p[0].market_index = 0;
                    p[0].base_asset_amount = fill_base;
                    p[0].quote_asset_amount = -fill_quote;
                    p[0].quote_entry_amount = -fill_quote;
                    p[0].quote_break_even_amount = -fill_quote;
                    p
                },
                ..user
            };

            let margin_calc_after =
                calculate_margin_requirement_and_total_collateral_and_liability_info(
                    &user_after_fill,
                    &perp_market_map,
                    &spot_market_map,
                    &mut oracle_map,
                    MarginContext::standard(MarginRequirementType::Initial),
                )
                .unwrap();

            assert!(
            margin_calc_after.meets_cross_margin_requirement(),
            "post-fill: margin must still be satisfied when collateral is in non-quote spot market"
        );
        }

        // --- Security / QA tests: demonstrate vulnerabilities, then validation fixes ---

        /// SECURITY: Midprice account can declare a different market_index than the order.
        /// Without validation, we would apply position updates for market 0 while consuming liquidity from a book for market 1.
        #[test]
        fn security_midprice_market_index_mismatch_must_be_rejected() {
            let program_id = drift_program_id();
            let (maker_authority, maker_user_key) = derive_maker_user_pda();
            let mut maker_user = User::default();
            maker_user.authority = maker_authority;
            maker_user.sub_account_id = 0;
            crate::create_anchor_account_info!(maker_user, &maker_user_key, User, maker_user_info);

            // Midprice account claims market_index = 1, but order will be for market 0.
            let data = make_midprice_account_data_with_market(
                100 * PRICE_PRECISION_U64,
                50 * BASE_PRECISION_U64,
                &maker_authority,
                1, // wrong market_index
            );
            let midprice_key = Pubkey::new_unique();
            let midprice_prog_id = midprice_program_id();
            let mut midprice_lamports = 0u64;
            let mut midprice_data = data;
            let midprice_info = create_account_info(
                &midprice_key,
                true,
                &mut midprice_lamports,
                &mut midprice_data[..],
                &midprice_prog_id,
            );
            let mut prog_lamps = 0u64;
            let mut prog_data = [0u8; 0];
            let program_info = create_executable_program_account_info(
                &midprice_prog_id,
                &mut prog_lamps,
                &mut prog_data[..],
            );
            let (global_matcher_pda, _) = prop_amm_matcher_pda(&program_id);
            let mut global_matcher_lamports = 0u64;
            let mut global_matcher_data = [0u8; 0];
            let global_matcher_info = create_account_info(
                &global_matcher_pda,
                true,
                &mut global_matcher_lamports,
                &mut global_matcher_data[..],
                &program_id,
            );

            let remaining: Vec<AccountInfo> = vec![
                program_info,
                global_matcher_info,
                midprice_info,
                maker_user_info,
            ];
            // Parse with order_market_index=0; midprice has market_index=1 so must be rejected in same pass.
            let res = parse_amm_views(remaining.as_slice(), 1, &program_id, 100, Some(0), None);
            assert!(
                res.is_err(),
                "midprice account with market_index=1 must be rejected for order market_index=0"
            );
        }

        /// SECURITY: the account after spot markets must be the canonical global matcher PDA.
        #[test]
        fn security_matcher_pda_enforced_by_midprice() {
            let program_id = drift_program_id();
            let (maker_authority, maker_user_key) = derive_maker_user_pda();
            let mut maker_user = User::default();
            maker_user.authority = maker_authority;
            maker_user.sub_account_id = 0;
            crate::create_anchor_account_info!(maker_user, &maker_user_key, User, maker_user_info);

            let data = make_midprice_account_data_with_market(
                100 * PRICE_PRECISION_U64,
                50 * BASE_PRECISION_U64,
                &maker_authority,
                0,
            );
            let midprice_key = Pubkey::new_unique();
            let midprice_prog_id = midprice_program_id();
            let mut midprice_lamports = 0u64;
            let mut midprice_data = data;
            let midprice_info = create_account_info(
                &midprice_key,
                true,
                &mut midprice_lamports,
                &mut midprice_data[..],
                &midprice_prog_id,
            );
            let mut prog_lamps = 0u64;
            let mut prog_data = [0u8; 0];
            let program_info = create_executable_program_account_info(
                &midprice_prog_id,
                &mut prog_lamps,
                &mut prog_data[..],
            );
            let wrong_matcher = Pubkey::new_unique();
            let mut wrong_matcher_lamports = 0u64;
            let mut wrong_matcher_data = [0u8; 0];
            let wrong_matcher_info = create_account_info(
                &wrong_matcher,
                true,
                &mut wrong_matcher_lamports,
                &mut wrong_matcher_data[..],
                &program_id,
            );

            let remaining: Vec<AccountInfo> = vec![
                program_info,
                wrong_matcher_info,
                midprice_info,
                maker_user_info,
            ];
            let res = parse_amm_views(remaining.as_slice(), 1, &program_id, 100, None, None);
            match res {
                Err(err) => assert_eq!(err, ErrorCode::InvalidPropAmmMatcherAccount),
                Ok(_) => panic!("wrong matcher PDA must be rejected"),
            }
        }

        /// SECURITY: First remaining account must be the canonical midprice program, not an arbitrary executable.
        /// Otherwise an attacker could pass their own program and we would CPI to it with (midprice, maker_user, matcher).
        #[test]
        fn security_midprice_program_must_be_canonical() {
            let program_id = drift_program_id();
            let wrong_program_id = Pubkey::new_unique(); // not crate::ids::midprice_program::id()
            let (maker_authority, maker_user_key) = derive_maker_user_pda();
            let mut maker_user = User::default();
            maker_user.authority = maker_authority;
            maker_user.sub_account_id = 0;
            crate::create_anchor_account_info!(maker_user, &maker_user_key, User, maker_user_info);

            let data = make_midprice_account_data(
                100 * PRICE_PRECISION_U64,
                50 * BASE_PRECISION_U64,
                &maker_authority,
            );
            let midprice_key = Pubkey::new_unique();
            let mut midprice_lamports = 0u64;
            let mut midprice_data = data;
            let midprice_info = create_account_info(
                &midprice_key,
                true,
                &mut midprice_lamports,
                &mut midprice_data[..],
                &wrong_program_id,
            );
            let mut prog_lamps = 0u64;
            let mut prog_data = [0u8; 0];
            let wrong_program_info = create_executable_program_account_info(
                &wrong_program_id,
                &mut prog_lamps,
                &mut prog_data[..],
            );
            let (global_matcher_pda, _) = prop_amm_matcher_pda(&program_id);
            let mut global_matcher_lamports = 0u64;
            let mut global_matcher_data = [0u8; 0];
            let global_matcher_info = create_account_info(
                &global_matcher_pda,
                true,
                &mut global_matcher_lamports,
                &mut global_matcher_data[..],
                &program_id,
            );

            let remaining: Vec<AccountInfo> = vec![
                wrong_program_info,
                global_matcher_info,
                midprice_info,
                maker_user_info,
            ];
            let res = parse_amm_views(remaining.as_slice(), 1, &program_id, 100, None, None);
            assert!(
            res.is_err(),
            "remaining_accounts[0] must be the canonical midprice program, not an arbitrary executable"
        );
        }

        /// SECURITY: Midprice account must be owned by the canonical midprice program.
        /// Otherwise we could pass a Drift-owned or attacker-owned account that looks like midprice data.
        #[test]
        fn security_midprice_account_must_be_owned_by_midprice_program() {
            let program_id = drift_program_id();
            let canonical_midprice_prog_id = midprice_program_id();
            let wrong_owner = Pubkey::new_unique();
            let (maker_authority, maker_user_key) = derive_maker_user_pda();
            let mut maker_user = User::default();
            maker_user.authority = maker_authority;
            maker_user.sub_account_id = 0;
            crate::create_anchor_account_info!(maker_user, &maker_user_key, User, maker_user_info);

            let data = make_midprice_account_data(
                100 * PRICE_PRECISION_U64,
                50 * BASE_PRECISION_U64,
                &maker_authority,
            );
            let midprice_key = Pubkey::new_unique();
            let mut midprice_lamports = 0u64;
            let mut midprice_data = data;
            let midprice_info = create_account_info(
                &midprice_key,
                true,
                &mut midprice_lamports,
                &mut midprice_data[..],
                &wrong_owner,
            );
            let mut prog_lamps = 0u64;
            let mut prog_data = [0u8; 0];
            let program_info = create_executable_program_account_info(
                &canonical_midprice_prog_id,
                &mut prog_lamps,
                &mut prog_data[..],
            );
            let (global_matcher_pda, _) = prop_amm_matcher_pda(&program_id);
            let mut global_matcher_lamports = 0u64;
            let mut global_matcher_data = [0u8; 0];
            let global_matcher_info = create_account_info(
                &global_matcher_pda,
                true,
                &mut global_matcher_lamports,
                &mut global_matcher_data[..],
                &program_id,
            );

            let remaining: Vec<AccountInfo> = vec![
                program_info,
                global_matcher_info,
                midprice_info,
                maker_user_info,
            ];
            // With discriminator-based detection, a wrong-owner account isn't recognized as a
            // midprice account, so it won't appear in amm_views. It would be treated as a DLOB maker
            // (and fail separately if used). This is safe: CPI to midprice_pino also validates owner.
            let res = parse_amm_views(remaining.as_slice(), 1, &program_id, 100, None, None);
            let (_, amm_views, _) = res.unwrap();
            assert!(
                amm_views.is_empty(),
                "wrong-owner midprice account must not be parsed as PropAMM"
            );
        }

        /// SECURITY: Taker must not be the same as any maker (no self-trade via prop AMM).
        /// Otherwise the same account gets taker deltas then maker deltas (double volume, possible abuse).
        #[test]
        fn security_taker_equals_maker_must_be_rejected() {
            let program_id = drift_program_id();
            let (maker_authority, maker_user_key) = derive_maker_user_pda(); // taker == maker
            let mut maker_user = User::default();
            maker_user.authority = maker_authority;
            maker_user.sub_account_id = 0;
            crate::create_anchor_account_info!(maker_user, &maker_user_key, User, maker_user_info);

            let data = make_midprice_account_data(
                100 * PRICE_PRECISION_U64,
                50 * BASE_PRECISION_U64,
                &maker_authority,
            );
            let midprice_key = Pubkey::new_unique();
            let midprice_prog_id = midprice_program_id();
            let mut midprice_lamports = 0u64;
            let mut midprice_data = data;
            let midprice_info = create_account_info(
                &midprice_key,
                true,
                &mut midprice_lamports,
                &mut midprice_data[..],
                &midprice_prog_id,
            );
            let mut prog_lamps = 0u64;
            let mut prog_data = [0u8; 0];
            let program_info = create_executable_program_account_info(
                &midprice_prog_id,
                &mut prog_lamps,
                &mut prog_data[..],
            );
            let (global_matcher_pda, _) = prop_amm_matcher_pda(&program_id);
            let mut global_matcher_lamports = 0u64;
            let mut global_matcher_data = [0u8; 0];
            let global_matcher_info = create_account_info(
                &global_matcher_pda,
                true,
                &mut global_matcher_lamports,
                &mut global_matcher_data[..],
                &program_id,
            );

            let remaining: Vec<AccountInfo> = vec![
                program_info,
                global_matcher_info,
                midprice_info,
                maker_user_info,
            ];
            // Parse with taker = maker (self-trade); must be rejected in same pass.
            let res = parse_amm_views(
                remaining.as_slice(),
                1,
                &program_id,
                100,
                None,
                Some(&maker_user_key),
            );
            assert!(
                res.is_err(),
                "taker must not be allowed to be the same as a maker (self-trade)"
            );
        }

        /// SECURITY: Zero-size order should be rejected to avoid no-op and edge cases.
        #[test]
        fn security_zero_size_order_returns_empty_fills() {
            let program_id = drift_program_id();
            let (maker_authority, maker_user_key) = derive_maker_user_pda();
            let mut maker_user = User::default();
            maker_user.authority = maker_authority;
            maker_user.sub_account_id = 0;
            crate::create_anchor_account_info!(maker_user, &maker_user_key, User, maker_user_info);

            let data = make_midprice_account_data(
                100 * PRICE_PRECISION_U64,
                50 * BASE_PRECISION_U64,
                &maker_authority,
            );
            let midprice_key = Pubkey::new_unique();
            let midprice_prog_id = midprice_program_id();
            let mut midprice_lamports = 0u64;
            let mut midprice_data = data;
            let midprice_info = create_account_info(
                &midprice_key,
                true,
                &mut midprice_lamports,
                &mut midprice_data[..],
                &midprice_prog_id,
            );
            let mut prog_lamps = 0u64;
            let mut prog_data = [0u8; 0];
            let program_info = create_executable_program_account_info(
                &midprice_prog_id,
                &mut prog_lamps,
                &mut prog_data[..],
            );
            let (global_matcher_pda, _) = prop_amm_matcher_pda(&program_id);
            let mut global_matcher_lamports = 0u64;
            let mut global_matcher_data = [0u8; 0];
            let global_matcher_info = create_account_info(
                &global_matcher_pda,
                true,
                &mut global_matcher_lamports,
                &mut global_matcher_data[..],
                &program_id,
            );

            let remaining: Vec<AccountInfo> = vec![
                program_info,
                global_matcher_info,
                midprice_info,
                maker_user_info,
            ];
            let (_, amm_views, _) =
                parse_amm_views(remaining.as_slice(), 1, &program_id, 100, None, None).unwrap();
            let result = run_prop_amm_matching(
                &amm_views,
                remaining.as_slice(),
                PositionDirection::Long,
                101 * PRICE_PRECISION_U64,
                0,
            )
            .unwrap();
            assert!(
                result.external_fills.is_empty() && result.taker_base_delta == 0,
                "zero size must yield no fills; handler should reject size=0 early"
            );
        }
    }

    mod midprice_integration {
        use super::*;

        // -----------------------------------------------------------------------
        // TTL enforcement tests
        // -----------------------------------------------------------------------

        /// TTL=0 means no expiry; quote is accepted regardless of slot age.
        #[test]
        fn ttl_disabled_quote_accepted() {
            let midprice_key = Pubkey::new_unique();
            let (maker_authority, maker_user_key) = derive_maker_user_pda();
            let mut maker_user = User::default();
            maker_user.authority = maker_authority;
            maker_user.sub_account_id = 0;
            crate::create_anchor_account_info!(maker_user, &maker_user_key, User, maker_user_info);

            let mid_price = 100 * PRICE_PRECISION_U64;
            let data = make_midprice_data_with_ttl(
                mid_price,
                100 * BASE_PRECISION_U64,
                &maker_authority,
                50, // ref_slot=50, old
                0,  // ttl=0 => disabled
            );
            let midprice_prog_id = midprice_program_id();
            let mut midprice_lamports = 0u64;
            let mut midprice_data = data;
            let midprice_info = create_account_info(
                &midprice_key,
                true,
                &mut midprice_lamports,
                &mut midprice_data[..],
                &midprice_prog_id,
            );

            let result = read_external_mid_price(
                &midprice_info,
                &midprice_prog_id,
                &maker_user_info,
                999_999,
            );
            assert!(result.is_ok());
            let (returned_mid_price, _sequence_number, _market_index) = result.unwrap();
            assert_eq!(returned_mid_price, mid_price);
        }

        /// Quote within TTL window is accepted.
        #[test]
        fn ttl_within_window_accepted() {
            let midprice_key = Pubkey::new_unique();
            let (maker_authority, maker_user_key) = derive_maker_user_pda();
            let mut maker_user = User::default();
            maker_user.authority = maker_authority;
            maker_user.sub_account_id = 0;
            crate::create_anchor_account_info!(maker_user, &maker_user_key, User, maker_user_info);

            let mid_price = 100 * PRICE_PRECISION_U64;
            let data = make_midprice_data_with_ttl(
                mid_price,
                100 * BASE_PRECISION_U64,
                &maker_authority,
                100, // ref_slot
                50,  // ttl=50 slots
            );
            let midprice_prog_id = midprice_program_id();
            let mut midprice_lamports = 0u64;
            let mut midprice_data = data;
            let midprice_info = create_account_info(
                &midprice_key,
                true,
                &mut midprice_lamports,
                &mut midprice_data[..],
                &midprice_prog_id,
            );

            // current_slot=140, age=40 <= ttl=50 => accepted
            let result =
                read_external_mid_price(&midprice_info, &midprice_prog_id, &maker_user_info, 140);
            assert!(result.is_ok());
        }

        /// Quote at exactly the TTL boundary is still accepted (<=).
        #[test]
        fn ttl_at_boundary_accepted() {
            let midprice_key = Pubkey::new_unique();
            let (maker_authority, maker_user_key) = derive_maker_user_pda();
            let mut maker_user = User::default();
            maker_user.authority = maker_authority;
            maker_user.sub_account_id = 0;
            crate::create_anchor_account_info!(maker_user, &maker_user_key, User, maker_user_info);

            let mid_price = 100 * PRICE_PRECISION_U64;
            let data = make_midprice_data_with_ttl(
                mid_price,
                100 * BASE_PRECISION_U64,
                &maker_authority,
                100, // ref_slot
                50,  // ttl=50
            );
            let midprice_prog_id = midprice_program_id();
            let mut midprice_lamports = 0u64;
            let mut midprice_data = data;
            let midprice_info = create_account_info(
                &midprice_key,
                true,
                &mut midprice_lamports,
                &mut midprice_data[..],
                &midprice_prog_id,
            );

            // current_slot=150, age=50 == ttl=50 => accepted
            let result =
                read_external_mid_price(&midprice_info, &midprice_prog_id, &maker_user_info, 150);
            assert!(result.is_ok());
        }

        /// Quote past TTL is rejected with MidpriceQuoteExpired.
        #[test]
        fn ttl_expired_rejected() {
            let midprice_key = Pubkey::new_unique();
            let (maker_authority, maker_user_key) = derive_maker_user_pda();
            let mut maker_user = User::default();
            maker_user.authority = maker_authority;
            maker_user.sub_account_id = 0;
            crate::create_anchor_account_info!(maker_user, &maker_user_key, User, maker_user_info);

            let mid_price = 100 * PRICE_PRECISION_U64;
            let data = make_midprice_data_with_ttl(
                mid_price,
                100 * BASE_PRECISION_U64,
                &maker_authority,
                100, // ref_slot
                50,  // ttl=50
            );
            let midprice_prog_id = midprice_program_id();
            let mut midprice_lamports = 0u64;
            let mut midprice_data = data;
            let midprice_info = create_account_info(
                &midprice_key,
                true,
                &mut midprice_lamports,
                &mut midprice_data[..],
                &midprice_prog_id,
            );

            // current_slot=151, age=51 > ttl=50 => expired
            let result =
                read_external_mid_price(&midprice_info, &midprice_prog_id, &maker_user_info, 151);
            assert!(result.is_err());
            assert_eq!(result.unwrap_err(), ErrorCode::MidpriceQuoteExpired);
        }

        /// apply_fills CPI: matcher and clock once, then one midprice per maker (no authority accounts).
        #[test]
        fn apply_fills_cpi_matcher_clock_once_then_makers() {
            use anchor_lang::solana_program::sysvar;
            use midprice_book_view::write_apply_fills_instruction_data;
            let midprice_program_id = midprice_program_id();
            let midprice_key = Pubkey::new_unique();
            let matcher_key = prop_amm_matcher_pda(&drift_program_id()).0;
            let clock_key = sysvar::clock::ID;
            let batches = [(0u64, [(0u16, true, 1u64)].as_slice())];
            let mut data = Vec::new();
            write_apply_fills_instruction_data(&mut VecSink(&mut data), 0, &batches);
            let ix = Instruction {
                program_id: midprice_program_id,
                accounts: vec![
                    AccountMeta::new_readonly(matcher_key, true),
                    AccountMeta::new_readonly(clock_key, false),
                    AccountMeta::new(midprice_key, false),
                ],
                data,
            };
            assert_eq!(ix.accounts.len(), 3, "one maker: matcher, clock, midprice");
            assert_eq!(ix.accounts[0].pubkey, matcher_key);
            assert_eq!(ix.accounts[1].pubkey, clock_key);
        }

        /// Regression: CPI maker account order is canonicalized so interleaved fills for the same maker
        /// produce one account per maker (no duplicates) and one batch per maker with all fills coalesced.
        #[test]
        fn apply_fills_cpi_canonicalized_maker_order_no_duplicates() {
            use super::{
                build_canonical_apply_fills_accounts_and_batches, ExternalFill, PendingExternalFill,
            };
            let program_id = drift_program_id();
            let matcher_pda = prop_amm_matcher_pda(&program_id).0;
            let clock_key = anchor_lang::solana_program::sysvar::clock::ID;
            let mid0_key = Pubkey::new_unique();
            let mid1_key = Pubkey::new_unique();
            let mut lamports = 0u64;
            let mut clock_data = [0u8; 0];
            let clock_info = create_account_info(
                &clock_key,
                false,
                &mut lamports,
                &mut clock_data[..],
                &program_id,
            );
            let mut matcher_lamports = 0u64;
            let mut matcher_data = [0u8; 0];
            let matcher_info = create_account_info(
                &matcher_pda,
                true,
                &mut matcher_lamports,
                &mut matcher_data[..],
                &program_id,
            );
            let midprice_prog_id = midprice_program_id();
            let mut mid0_lamports = 0u64;
            let mut mid0_data = [0u8; 0];
            let mid0_info = create_account_info(
                &mid0_key,
                false,
                &mut mid0_lamports,
                &mut mid0_data[..],
                &midprice_prog_id,
            );
            let maker0_key = Pubkey::new_unique();
            let mut maker0_lamports = 0u64;
            let mut maker0_data = [0u8; 0];
            let maker0_info = create_account_info(
                &maker0_key,
                false,
                &mut maker0_lamports,
                &mut maker0_data[..],
                &program_id,
            );
            let mut mid1_lamports = 0u64;
            let mut mid1_data = [0u8; 0];
            let mid1_info = create_account_info(
                &mid1_key,
                false,
                &mut mid1_lamports,
                &mut mid1_data[..],
                &midprice_prog_id,
            );
            let maker1_key = Pubkey::new_unique();
            let mut maker1_lamports = 0u64;
            let mut maker1_data = [0u8; 0];
            let maker1_info = create_account_info(
                &maker1_key,
                false,
                &mut maker1_lamports,
                &mut maker1_data[..],
                &program_id,
            );

            // remaining_accounts: [matcher, clock, mid0, maker0, mid1, maker1]; matcher at 0, mid0 at 2, mid1 at 4.
            let remaining_accounts: Vec<AccountInfo> = vec![
                matcher_info.clone(),
                clock_info.clone(),
                mid0_info.clone(),
                maker0_info,
                mid1_info.clone(),
                maker1_info,
            ];

            // Interleaved: fill for maker0, then maker1, then maker0 again (would duplicate mid0 without canonicalization).
            let external_fills = vec![
                PendingExternalFill {
                    midprice_remaining_index: 2,
                    maker_user_remaining_index: 3,
                    sequence_number_snapshot: 0,
                    fill: ExternalFill {
                        abs_index: 0,
                        is_ask: true,
                        fill_size: 10,
                    },
                },
                PendingExternalFill {
                    midprice_remaining_index: 4,
                    maker_user_remaining_index: 5,
                    sequence_number_snapshot: 0,
                    fill: ExternalFill {
                        abs_index: 0,
                        is_ask: true,
                        fill_size: 20,
                    },
                },
                PendingExternalFill {
                    midprice_remaining_index: 2,
                    maker_user_remaining_index: 3,
                    sequence_number_snapshot: 0,
                    fill: ExternalFill {
                        abs_index: 0,
                        is_ask: true,
                        fill_size: 15,
                    },
                },
            ];

            let (accounts, maker_batches, midprice_indices) =
                build_canonical_apply_fills_accounts_and_batches(
                    &remaining_accounts,
                    &external_fills,
                    &remaining_accounts[0],
                    &remaining_accounts[1],
                )
                .unwrap();

            // One account per maker: matcher + clock + 2 midprices (no duplicate mid0).
            assert_eq!(accounts.len(), 4, "matcher, clock, mid0, mid1");
            assert_eq!(maker_batches.len(), 2, "one batch per maker");
            assert_eq!(midprice_indices.len(), 2);
            assert_eq!(midprice_indices[0], 2);
            assert_eq!(midprice_indices[1], 4);

            // First maker (mid0): two fills coalesced into one (same abs_index, is_ask) -> fill_size 10+15=25.
            assert_eq!(maker_batches[0].0, 0);
            assert_eq!(maker_batches[0].1.len(), 1);
            assert_eq!(maker_batches[0].1[0], (0, true, 25));

            // Second maker (mid1): one fill.
            assert_eq!(maker_batches[1].0, 0);
            assert_eq!(maker_batches[1].1.len(), 1);
            assert_eq!(maker_batches[1].1[0], (0, true, 20));

            // No duplicate account keys in the midprice list.
            assert_eq!(accounts[2].pubkey, mid0_key);
            assert_eq!(accounts[3].pubkey, mid1_key);
        }
    }

    mod maker_margin {
        use super::*;

        /// Insolvent makers are skipped; only solvent makers are included in filtered result (skip semantics).
        #[test]
        fn filter_prop_amm_makers_by_margin_skips_insolvent_maker() {
            use crate::state::oracle_map::OracleMap;
            let slot = 0_u64;
            let program_id = drift_program_id();
            let oracle_key =
                Pubkey::from_str("J83w4HKfqxwcq3BEMMkPFSppX3gqekLyLJBexebFVkix").unwrap();
            let pyth_program = crate::ids::pyth_program::id();
            let mut oracle_price = get_pyth_price(100, 6);
            crate::create_account_info!(
                oracle_price,
                &oracle_key,
                &pyth_program,
                oracle_account_info
            );
            let mut oracle_map = OracleMap::load_one(&oracle_account_info, slot, None).unwrap();

            let mut perp_market = PerpMarket {
                market_index: 0,
                amm: AMM {
                    base_asset_reserve: 100 * AMM_RESERVE_PRECISION,
                    quote_asset_reserve: 100 * AMM_RESERVE_PRECISION,
                    oracle: oracle_key,
                    order_tick_size: 1,
                    historical_oracle_data: HistoricalOracleData {
                        last_oracle_price: 100 * crate::math::constants::PRICE_PRECISION_I64,
                        last_oracle_price_twap: 100 * crate::math::constants::PRICE_PRECISION_I64,
                        ..HistoricalOracleData::default()
                    },
                    ..AMM::default()
                },
                margin_ratio_initial: 2000,
                margin_ratio_maintenance: 1000,
                status: MarketStatus::Active,
                ..PerpMarket::default_test()
            };
            perp_market.amm.max_base_asset_reserve = u64::MAX as u128;
            perp_market.amm.min_base_asset_reserve = 0;
            crate::create_anchor_account_info!(perp_market, PerpMarket, perp_market_info);
            let perp_market_map = PerpMarketMap::load_one(&perp_market_info, true).unwrap();

            let mut spot_market = SpotMarket {
                market_index: 0,
                oracle_source: OracleSource::QuoteAsset,
                cumulative_deposit_interest: SPOT_CUMULATIVE_INTEREST_PRECISION,
                decimals: 6,
                initial_asset_weight: SPOT_WEIGHT_PRECISION,
                maintenance_asset_weight: SPOT_WEIGHT_PRECISION,
                historical_oracle_data: HistoricalOracleData::default_quote_oracle(),
                ..SpotMarket::default()
            };
            crate::create_anchor_account_info!(spot_market, SpotMarket, spot_market_info);
            let spot_market_map = SpotMarketMap::load_one(&spot_market_info, true).unwrap();

            // Maker 1 (solvent): has spot collateral; after fill (short 50 base) still meets margin.
            let maker_solvent_key = Pubkey::new_unique();
            let mut spot_positions_solvent = [SpotPosition::default(); 8];
            spot_positions_solvent[0] = SpotPosition {
                market_index: 0,
                balance_type: crate::state::spot_market::SpotBalanceType::Deposit,
                scaled_balance: 100_000 * SPOT_BALANCE_PRECISION_U64,
                ..SpotPosition::default()
            };
            let mut maker_solvent = User {
                authority: maker_solvent_key,
                spot_positions: spot_positions_solvent,
                perp_positions: [PerpPosition::default(); 8],
                ..User::default()
            };
            crate::create_anchor_account_info!(
                maker_solvent,
                &maker_solvent_key,
                User,
                maker_solvent_info
            );

            // Maker 2 (insolvent): minimal spot collateral and existing short; after fill would breach margin.
            let maker_insolvent_key = Pubkey::new_unique();
            let mut spot_positions_insolvent = [SpotPosition::default(); 8];
            spot_positions_insolvent[0] = SpotPosition {
                market_index: 0,
                scaled_balance: 1000 * SPOT_BALANCE_PRECISION_U64,
                balance_type: SpotBalanceType::Deposit,
                ..SpotPosition::default()
            };
            let mut perp_positions_insolvent = [PerpPosition::default(); 8];
            perp_positions_insolvent[0] = PerpPosition {
                market_index: 0,
                base_asset_amount: -100 * (BASE_PRECISION_U64 as i64),
                quote_asset_amount: 10000 * (crate::math::constants::PRICE_PRECISION_I64),
                ..PerpPosition::default()
            };
            let mut maker_insolvent = User {
                authority: maker_insolvent_key,
                spot_positions: spot_positions_insolvent,
                perp_positions: perp_positions_insolvent,
                ..User::default()
            };
            crate::create_anchor_account_info!(
                maker_insolvent,
                &maker_insolvent_key,
                User,
                maker_insolvent_info
            );

            let midprice_prog_id = midprice_program_id();
            let mid1_key = Pubkey::new_unique();
            let mid2_key = Pubkey::new_unique();
            let mut mid1_data = make_midprice_account_data(
                100 * PRICE_PRECISION_U64,
                100 * BASE_PRECISION_U64,
                &maker_solvent_key,
            );
            let mut mid2_data = make_midprice_account_data(
                100 * PRICE_PRECISION_U64,
                100 * BASE_PRECISION_U64,
                &maker_insolvent_key,
            );
            let mut mid1_lamports = 0u64;
            let mut mid2_lamports = 0u64;
            let mid1_info = create_account_info(
                &mid1_key,
                true,
                &mut mid1_lamports,
                &mut mid1_data[..],
                &midprice_prog_id,
            );
            let mid2_info = create_account_info(
                &mid2_key,
                true,
                &mut mid2_lamports,
                &mut mid2_data[..],
                &midprice_prog_id,
            );

            let mut prog_lamps = 0u64;
            let mut prog_data = [0u8; 0];
            let program_info = create_executable_program_account_info(
                &midprice_prog_id,
                &mut prog_lamps,
                &mut prog_data[..],
            );
            let (matcher_pda, _) = prop_amm_matcher_pda(&program_id);
            let mut matcher_lamports = 0u64;
            let mut matcher_data = [0u8; 0];
            let matcher_info = create_account_info(
                &matcher_pda,
                true,
                &mut matcher_lamports,
                &mut matcher_data[..],
                &program_id,
            );

            let remaining_accounts: Vec<AccountInfo> = vec![
                program_info,
                matcher_info,
                mid1_info,
                maker_solvent_info,
                mid2_info,
                maker_insolvent_info,
            ];
            // AmmView indices: mid1=2, maker1=3; mid2=4, maker2=5
            let amm_views = vec![
                AmmView {
                    key: mid1_key,
                    mid_price: 100 * PRICE_PRECISION_U64,
                    sequence_number_snapshot: 0,
                    maker_user_remaining_index: 3,
                    midprice_remaining_index: 2,
                },
                AmmView {
                    key: mid2_key,
                    mid_price: 100 * PRICE_PRECISION_U64,
                    sequence_number_snapshot: 0,
                    maker_user_remaining_index: 5,
                    midprice_remaining_index: 4,
                },
            ];
            // Maker selling (short): base_delta negative, quote_delta positive (receives quote).
            let base_delta = -50_i64 * (BASE_PRECISION_U64 as i64);
            let quote_delta = 5000_i64 * (crate::math::constants::PRICE_PRECISION_I64);
            let mut maker_deltas = BTreeMap::new();
            maker_deltas.insert(maker_solvent_key, (base_delta, quote_delta));
            maker_deltas.insert(maker_insolvent_key, (base_delta, quote_delta));

            let external_fills = vec![
                PendingExternalFill {
                    midprice_remaining_index: 2,
                    maker_user_remaining_index: 3,
                    sequence_number_snapshot: 0,
                    fill: ExternalFill {
                        abs_index: 0,
                        is_ask: true,
                        fill_size: 50 * BASE_PRECISION_U64,
                    },
                },
                PendingExternalFill {
                    midprice_remaining_index: 4,
                    maker_user_remaining_index: 5,
                    sequence_number_snapshot: 0,
                    fill: ExternalFill {
                        abs_index: 0,
                        is_ask: true,
                        fill_size: 50 * BASE_PRECISION_U64,
                    },
                },
            ];

            let (filtered_deltas, filtered_fills, taker_base, taker_quote, total_quote) =
                filter_prop_amm_makers_by_margin(
                    &maker_deltas,
                    &external_fills,
                    &amm_views,
                    &remaining_accounts,
                    &perp_market_map,
                    &spot_market_map,
                    &mut oracle_map,
                    0, // market_index
                    0, // now
                )
                .unwrap();

            assert_eq!(filtered_deltas.len(), 1, "only solvent maker should remain");
            assert!(filtered_deltas.contains_key(&maker_solvent_key));
            assert!(!filtered_deltas.contains_key(&maker_insolvent_key));
            assert_eq!(filtered_fills.len(), 1);
            assert_eq!(
                remaining_accounts[filtered_fills[0].maker_user_remaining_index].key(),
                maker_solvent_key
            );
            assert_eq!(taker_base, -base_delta);
            assert_eq!(taker_quote, -quote_delta);
            assert_eq!(total_quote, quote_delta.unsigned_abs());
        }

        /// Maker has an existing perp position in the same market (fill market); still solvent after fill reduces position.
        #[test]
        fn filter_prop_amm_maker_with_existing_perp_position_same_market() {
            use crate::state::oracle_map::OracleMap;
            let slot = 0_u64;
            let program_id = drift_program_id();
            let oracle_key =
                Pubkey::from_str("J83w4HKfqxwcq3BEMMkPFSppX3gqekLyLJBexebFVkix").unwrap();
            let pyth_program = crate::ids::pyth_program::id();
            let mut oracle_price = get_pyth_price(100, 6);
            crate::create_account_info!(
                oracle_price,
                &oracle_key,
                &pyth_program,
                oracle_account_info
            );
            let mut oracle_map = OracleMap::load_one(&oracle_account_info, slot, None).unwrap();

            let mut perp_market = PerpMarket {
                market_index: 0,
                amm: AMM {
                    base_asset_reserve: 100 * AMM_RESERVE_PRECISION,
                    quote_asset_reserve: 100 * AMM_RESERVE_PRECISION,
                    oracle: oracle_key,
                    order_tick_size: 1,
                    historical_oracle_data: HistoricalOracleData {
                        last_oracle_price: 100 * crate::math::constants::PRICE_PRECISION_I64,
                        last_oracle_price_twap: 100 * crate::math::constants::PRICE_PRECISION_I64,
                        ..HistoricalOracleData::default()
                    },
                    ..AMM::default()
                },
                margin_ratio_initial: 1000,
                margin_ratio_maintenance: 500,
                status: MarketStatus::Active,
                ..PerpMarket::default_test()
            };
            perp_market.amm.max_base_asset_reserve = u64::MAX as u128;
            perp_market.amm.min_base_asset_reserve = 0;
            crate::create_anchor_account_info!(perp_market, PerpMarket, perp_market_info);
            let perp_market_map = PerpMarketMap::load_one(&perp_market_info, true).unwrap();

            let mut spot_market = SpotMarket {
                market_index: 0,
                oracle_source: OracleSource::QuoteAsset,
                cumulative_deposit_interest: SPOT_CUMULATIVE_INTEREST_PRECISION,
                decimals: 6,
                initial_asset_weight: SPOT_WEIGHT_PRECISION,
                maintenance_asset_weight: SPOT_WEIGHT_PRECISION,
                historical_oracle_data: HistoricalOracleData::default_quote_oracle(),
                ..SpotMarket::default()
            };
            crate::create_anchor_account_info!(spot_market, SpotMarket, spot_market_info);
            let spot_market_map = SpotMarketMap::load_one(&spot_market_info, true).unwrap();

            // Maker: spot collateral + existing long in market 0 (same market as fill).
            let maker_key = Pubkey::new_unique();
            let mut spot_positions = [SpotPosition::default(); 8];
            spot_positions[0] = SpotPosition {
                market_index: 0,
                balance_type: crate::state::spot_market::SpotBalanceType::Deposit,
                scaled_balance: 80_000 * SPOT_BALANCE_PRECISION_U64,
                ..SpotPosition::default()
            };
            let mut perp_positions = [PerpPosition::default(); 8];
            perp_positions[0] = PerpPosition {
                market_index: 0,
                base_asset_amount: 30 * BASE_PRECISION_U64 as i64,
                quote_asset_amount: -(30 * 100 * crate::math::constants::PRICE_PRECISION_I64),
                quote_entry_amount: -(30 * 100 * crate::math::constants::PRICE_PRECISION_I64),
                quote_break_even_amount: -(30 * 100 * crate::math::constants::PRICE_PRECISION_I64),
                ..PerpPosition::default()
            };
            let mut maker_user = User {
                authority: maker_key,
                spot_positions,
                perp_positions,
                ..User::default()
            };
            crate::create_anchor_account_info!(maker_user, &maker_key, User, maker_info);

            let midprice_prog_id = midprice_program_id();
            let mid_key = Pubkey::new_unique();
            let mut mid_data = make_midprice_account_data(
                100 * PRICE_PRECISION_U64,
                100 * BASE_PRECISION_U64,
                &maker_key,
            );
            let mut mid_lamports = 0u64;
            let mid_info = create_account_info(
                &mid_key,
                true,
                &mut mid_lamports,
                &mut mid_data[..],
                &midprice_prog_id,
            );
            let mut prog_lamps = 0u64;
            let mut prog_data = [0u8; 0];
            let program_info = create_executable_program_account_info(
                &midprice_prog_id,
                &mut prog_lamps,
                &mut prog_data[..],
            );
            let (matcher_pda, _) = prop_amm_matcher_pda(&program_id);
            let mut matcher_lamports = 0u64;
            let mut matcher_data = [0u8; 0];
            let matcher_info = create_account_info(
                &matcher_pda,
                true,
                &mut matcher_lamports,
                &mut matcher_data[..],
                &program_id,
            );

            let remaining_accounts: Vec<AccountInfo> =
                vec![program_info, matcher_info, mid_info, maker_info];
            let amm_views = vec![AmmView {
                key: mid_key,
                mid_price: 100 * PRICE_PRECISION_U64,
                sequence_number_snapshot: 0,
                maker_user_remaining_index: 3,
                midprice_remaining_index: 2,
            }];
            // Maker sells 15 (fill reduces long from 30 to 15).
            let base_delta = -15_i64 * (BASE_PRECISION_U64 as i64);
            let quote_delta = 15 * 100 * crate::math::constants::PRICE_PRECISION_I64;
            let mut maker_deltas = BTreeMap::new();
            maker_deltas.insert(maker_key, (base_delta, quote_delta));

            let (filtered_deltas, _, _, _, _) = filter_prop_amm_makers_by_margin(
                &maker_deltas,
                &[],
                &amm_views,
                &remaining_accounts,
                &perp_market_map,
                &spot_market_map,
                &mut oracle_map,
                0,
                0,
            )
            .unwrap();

            assert!(
                filtered_deltas.contains_key(&maker_key),
                "maker with existing perp position in same market must remain solvent after fill"
            );
        }
    }

    mod matching {
        use super::*;

        // -----------------------------------------------------------------------
        // Unified matching: mixed fill type tests
        // -----------------------------------------------------------------------

        /// DLOB alone: when no PropAMM, DLOB makers fill.
        #[test]
        fn unified_dlob_only_fills() {
            let dlob = vec![DlobMakerView {
                maker_key: Pubkey::new_unique(),
                order_index: 0,
                price: 100 * PRICE_PRECISION_U64,
                size: 20 * BASE_PRECISION_U64,
                remaining_account_index: 0,
                maker_stats_remaining_index: 0,
            }];
            let result = run_unified_matching(
                &[],
                &dlob,
                &[],
                PositionDirection::Long,
                101 * PRICE_PRECISION_U64,
                10 * BASE_PRECISION_U64,
            )
            .unwrap();

            assert!(result.external_fills.is_empty());
            assert_eq!(result.dlob_fills.len(), 1);
            assert_eq!(
                result.dlob_fills[0].base_asset_amount,
                10 * BASE_PRECISION_U64,
                "DLOB should fill entire taker size"
            );
        }

        /// Mixed PropAMM + DLOB: PropAMM book offers a better price than the DLOB maker.
        /// The matcher should fill PropAMM first, then DLOB for the remainder.
        #[test]
        fn unified_prop_amm_better_price_fills_first() {
            let program_id = drift_program_id();
            let midprice_key = Pubkey::new_unique();
            let (maker_authority, maker_user_key) = derive_maker_user_pda();
            let mut maker_user = User::default();
            maker_user.authority = maker_authority;
            maker_user.sub_account_id = 0;
            crate::create_anchor_account_info!(maker_user, &maker_user_key, User, maker_user_info);

            // PropAMM book at mid=100, ask offset=1, size=5 → effective ask = 101
            let data = make_midprice_account_data(
                100 * PRICE_PRECISION_U64,
                5 * BASE_PRECISION_U64,
                &maker_authority,
            );
            let midprice_prog_id = midprice_program_id();
            let mut midprice_lamports = 0u64;
            let mut midprice_data = data;
            let midprice_info = create_account_info(
                &midprice_key,
                true,
                &mut midprice_lamports,
                &mut midprice_data[..],
                &midprice_prog_id,
            );
            let mut prog_lamps = 0u64;
            let mut prog_data = [0u8; 0];
            let program_info = create_executable_program_account_info(
                &midprice_prog_id,
                &mut prog_lamps,
                &mut prog_data[..],
            );
            let (global_matcher_pda, _) = prop_amm_matcher_pda(&program_id);
            let mut gm_lamps = 0u64;
            let mut gm_data = [0u8; 0];
            let gm_info = create_account_info(
                &global_matcher_pda,
                true,
                &mut gm_lamps,
                &mut gm_data[..],
                &program_id,
            );

            let remaining: Vec<AccountInfo> =
                vec![program_info, gm_info, midprice_info, maker_user_info];
            let slice = remaining.as_slice();
            let (_, amm_views, _) =
                parse_amm_views(slice, 1, &program_id, 100, None, None).unwrap();

            // DLOB maker at price 105 (worse than PropAMM ask at ~101)
            let dlob = vec![DlobMakerView {
                maker_key: Pubkey::new_unique(),
                order_index: 0,
                price: 105 * PRICE_PRECISION_U64,
                size: 20 * BASE_PRECISION_U64,
                remaining_account_index: 99, // not actually loaded
                maker_stats_remaining_index: 0,
            }];

            let result = run_unified_matching(
                &amm_views,
                &dlob,
                slice,
                PositionDirection::Long,
                110 * PRICE_PRECISION_U64,
                10 * BASE_PRECISION_U64,
            )
            .unwrap();

            // PropAMM has 5 at a better price; DLOB gets the remaining 5.
            let prop_filled: u64 = result.external_fills.iter().map(|f| f.fill.fill_size).sum();
            let dlob_filled: u64 = result.dlob_fills.iter().map(|f| f.base_asset_amount).sum();
            assert_eq!(prop_filled, 5 * BASE_PRECISION_U64, "PropAMM fills 5");
            assert_eq!(
                dlob_filled,
                5 * BASE_PRECISION_U64,
                "DLOB fills remaining 5"
            );
        }

        /// Mixed PropAMM + DLOB: DLOB maker offers a better price than the PropAMM book.
        /// The matcher should fill DLOB first, then PropAMM.
        #[test]
        fn unified_dlob_better_price_fills_first() {
            let program_id = drift_program_id();
            let midprice_key = Pubkey::new_unique();
            let (maker_authority, maker_user_key) = derive_maker_user_pda();
            let mut maker_user = User::default();
            maker_user.authority = maker_authority;
            maker_user.sub_account_id = 0;
            crate::create_anchor_account_info!(maker_user, &maker_user_key, User, maker_user_info);

            // PropAMM book: mid=110, ask offset=1, effective ask ~111
            let data = make_midprice_account_data(
                110 * PRICE_PRECISION_U64,
                20 * BASE_PRECISION_U64,
                &maker_authority,
            );
            let midprice_prog_id = midprice_program_id();
            let mut midprice_lamports = 0u64;
            let mut midprice_data = data;
            let midprice_info = create_account_info(
                &midprice_key,
                true,
                &mut midprice_lamports,
                &mut midprice_data[..],
                &midprice_prog_id,
            );
            let mut prog_lamps = 0u64;
            let mut prog_data = [0u8; 0];
            let program_info = create_executable_program_account_info(
                &midprice_prog_id,
                &mut prog_lamps,
                &mut prog_data[..],
            );
            let (global_matcher_pda, _) = prop_amm_matcher_pda(&program_id);
            let mut gm_lamps = 0u64;
            let mut gm_data = [0u8; 0];
            let gm_info = create_account_info(
                &global_matcher_pda,
                true,
                &mut gm_lamps,
                &mut gm_data[..],
                &program_id,
            );

            let remaining: Vec<AccountInfo> =
                vec![program_info, gm_info, midprice_info, maker_user_info];
            let slice = remaining.as_slice();
            let (_, amm_views, _) =
                parse_amm_views(slice, 1, &program_id, 100, None, None).unwrap();

            // DLOB maker at price 100 (better than PropAMM ask at ~111)
            let dlob_key = Pubkey::new_unique();
            let dlob = vec![DlobMakerView {
                maker_key: dlob_key,
                order_index: 0,
                price: 100 * PRICE_PRECISION_U64,
                size: 3 * BASE_PRECISION_U64,
                remaining_account_index: 99,
                maker_stats_remaining_index: 0,
            }];

            let result = run_unified_matching(
                &amm_views,
                &dlob,
                slice,
                PositionDirection::Long,
                120 * PRICE_PRECISION_U64,
                10 * BASE_PRECISION_U64,
            )
            .unwrap();

            // DLOB has 3 at a better price → filled first, then PropAMM gets 7.
            let dlob_filled: u64 = result.dlob_fills.iter().map(|f| f.base_asset_amount).sum();
            let prop_filled: u64 = result.external_fills.iter().map(|f| f.fill.fill_size).sum();
            assert_eq!(
                dlob_filled,
                3 * BASE_PRECISION_U64,
                "DLOB fills 3 at better price"
            );
            assert_eq!(
                prop_filled,
                7 * BASE_PRECISION_U64,
                "PropAMM fills remaining 7"
            );
        }

        /// Mixed PropAMM + DLOB on the sell side: the higher PropAMM bid should fill first.
        #[test]
        fn unified_short_prop_amm_better_bid_fills_first() {
            let program_id = drift_program_id();
            let midprice_key = Pubkey::new_unique();
            let (maker_authority, maker_user_key) = derive_maker_user_pda();
            let mut maker_user = User::default();
            maker_user.authority = maker_authority;
            maker_user.sub_account_id = 0;
            crate::create_anchor_account_info!(maker_user, &maker_user_key, User, maker_user_info);

            let mut data = make_bid_midprice_account_data(
                100 * PRICE_PRECISION_U64,
                5 * BASE_PRECISION_U64,
                &maker_authority,
                0,
            );
            let midprice_prog_id = midprice_program_id();
            let mut midprice_lamports = 0u64;
            let midprice_info = create_account_info(
                &midprice_key,
                true,
                &mut midprice_lamports,
                &mut data[..],
                &midprice_prog_id,
            );
            let mut prog_lamps = 0u64;
            let mut prog_data = [0u8; 0];
            let program_info = create_executable_program_account_info(
                &midprice_prog_id,
                &mut prog_lamps,
                &mut prog_data[..],
            );
            let (global_matcher_pda, _) = prop_amm_matcher_pda(&program_id);
            let mut gm_lamps = 0u64;
            let mut gm_data = [0u8; 0];
            let gm_info = create_account_info(
                &global_matcher_pda,
                true,
                &mut gm_lamps,
                &mut gm_data[..],
                &program_id,
            );

            let remaining: Vec<AccountInfo> =
                vec![program_info, gm_info, midprice_info, maker_user_info];
            let slice = remaining.as_slice();
            let (_, amm_views, _) =
                parse_amm_views(slice, 1, &program_id, 100, None, None).unwrap();

            let dlob = vec![DlobMakerView {
                maker_key: Pubkey::new_unique(),
                order_index: 0,
                price: 95 * PRICE_PRECISION_U64,
                size: 20 * BASE_PRECISION_U64,
                remaining_account_index: 99,
                maker_stats_remaining_index: 0,
            }];

            let result = run_unified_matching(
                &amm_views,
                &dlob,
                slice,
                PositionDirection::Short,
                90 * PRICE_PRECISION_U64,
                10 * BASE_PRECISION_U64,
            )
            .unwrap();

            let prop_filled: u64 = result.external_fills.iter().map(|f| f.fill.fill_size).sum();
            let dlob_filled: u64 = result.dlob_fills.iter().map(|f| f.base_asset_amount).sum();
            assert_eq!(
                prop_filled,
                5 * BASE_PRECISION_U64,
                "PropAMM fills 5 at the better bid"
            );
            assert_eq!(
                dlob_filled,
                5 * BASE_PRECISION_U64,
                "DLOB fills the remaining 5"
            );
        }

        /// Mixed PropAMM + DLOB on the sell side: the higher DLOB bid should fill first.
        #[test]
        fn unified_short_dlob_better_bid_fills_first() {
            let program_id = drift_program_id();
            let midprice_key = Pubkey::new_unique();
            let (maker_authority, maker_user_key) = derive_maker_user_pda();
            let mut maker_user = User::default();
            maker_user.authority = maker_authority;
            maker_user.sub_account_id = 0;
            crate::create_anchor_account_info!(maker_user, &maker_user_key, User, maker_user_info);

            let mut data = make_bid_midprice_account_data(
                90 * PRICE_PRECISION_U64,
                20 * BASE_PRECISION_U64,
                &maker_authority,
                0,
            );
            let midprice_prog_id = midprice_program_id();
            let mut midprice_lamports = 0u64;
            let midprice_info = create_account_info(
                &midprice_key,
                true,
                &mut midprice_lamports,
                &mut data[..],
                &midprice_prog_id,
            );
            let mut prog_lamps = 0u64;
            let mut prog_data = [0u8; 0];
            let program_info = create_executable_program_account_info(
                &midprice_prog_id,
                &mut prog_lamps,
                &mut prog_data[..],
            );
            let (global_matcher_pda, _) = prop_amm_matcher_pda(&program_id);
            let mut gm_lamps = 0u64;
            let mut gm_data = [0u8; 0];
            let gm_info = create_account_info(
                &global_matcher_pda,
                true,
                &mut gm_lamps,
                &mut gm_data[..],
                &program_id,
            );

            let remaining: Vec<AccountInfo> =
                vec![program_info, gm_info, midprice_info, maker_user_info];
            let slice = remaining.as_slice();
            let (_, amm_views, _) =
                parse_amm_views(slice, 1, &program_id, 100, None, None).unwrap();

            let dlob = vec![DlobMakerView {
                maker_key: Pubkey::new_unique(),
                order_index: 0,
                price: 95 * PRICE_PRECISION_U64,
                size: 3 * BASE_PRECISION_U64,
                remaining_account_index: 99,
                maker_stats_remaining_index: 0,
            }];

            let result = run_unified_matching(
                &amm_views,
                &dlob,
                slice,
                PositionDirection::Short,
                80 * PRICE_PRECISION_U64,
                10 * BASE_PRECISION_U64,
            )
            .unwrap();

            let dlob_filled: u64 = result.dlob_fills.iter().map(|f| f.base_asset_amount).sum();
            let prop_filled: u64 = result.external_fills.iter().map(|f| f.fill.fill_size).sum();
            assert_eq!(
                dlob_filled,
                3 * BASE_PRECISION_U64,
                "DLOB fills 3 at the better bid"
            );
            assert_eq!(
                prop_filled,
                7 * BASE_PRECISION_U64,
                "PropAMM fills the remaining 7"
            );
        }

        /// PropAMM pro-rata + DLOB sequential at the same price level.
        /// Two PropAMM books and one DLOB maker all at the same effective price.
        /// PropAMM should share pro-rata; DLOB fills sequentially after.
        #[test]
        fn unified_tied_price_prop_amm_pro_rata_dlob_sequential() {
            let program_id = drift_program_id();
            let midprice_prog_id = midprice_program_id();

            // Book A: mid=100, ask offset=1, size=10 → effective ask 101
            let (auth_a, key_a) = derive_maker_user_pda();
            let mut user_a = User::default();
            user_a.authority = auth_a;
            user_a.sub_account_id = 0;
            crate::create_anchor_account_info!(user_a, &key_a, User, user_a_info);
            let data_a = make_midprice_account_data(
                100 * PRICE_PRECISION_U64,
                10 * BASE_PRECISION_U64,
                &auth_a,
            );
            let mid_a_key = Pubkey::new_unique();
            let mut mid_a_lamps = 0u64;
            let mut mid_a_data = data_a;
            let mid_a_info = create_account_info(
                &mid_a_key,
                true,
                &mut mid_a_lamps,
                &mut mid_a_data[..],
                &midprice_prog_id,
            );

            // Book B: same price level, size=10
            let (auth_b, key_b) = derive_maker_user_pda();
            let mut user_b = User::default();
            user_b.authority = auth_b;
            user_b.sub_account_id = 0;
            crate::create_anchor_account_info!(user_b, &key_b, User, user_b_info);
            let data_b = make_midprice_account_data(
                100 * PRICE_PRECISION_U64,
                10 * BASE_PRECISION_U64,
                &auth_b,
            );
            let mid_b_key = Pubkey::new_unique();
            let mut mid_b_lamps = 0u64;
            let mut mid_b_data = data_b;
            let mid_b_info = create_account_info(
                &mid_b_key,
                true,
                &mut mid_b_lamps,
                &mut mid_b_data[..],
                &midprice_prog_id,
            );

            let mut prog_lamps = 0u64;
            let mut prog_data = [0u8; 0];
            let program_info = create_executable_program_account_info(
                &midprice_prog_id,
                &mut prog_lamps,
                &mut prog_data[..],
            );
            let (global_matcher_pda, _) = prop_amm_matcher_pda(&program_id);
            let mut gm_lamps = 0u64;
            let mut gm_data = [0u8; 0];
            let gm_info = create_account_info(
                &global_matcher_pda,
                true,
                &mut gm_lamps,
                &mut gm_data[..],
                &program_id,
            );

            let remaining: Vec<AccountInfo> = vec![
                program_info,
                gm_info,
                mid_a_info,
                user_a_info,
                mid_b_info,
                user_b_info,
            ];
            let slice = remaining.as_slice();
            let (_, amm_views, _) =
                parse_amm_views(slice, 1, &program_id, 100, None, None).unwrap();
            assert_eq!(amm_views.len(), 2);

            // DLOB maker at same price: 101 (same as PropAMM effective ask)
            let dlob = vec![DlobMakerView {
                maker_key: Pubkey::new_unique(),
                order_index: 0,
                price: 100 * PRICE_PRECISION_U64 + PRICE_PRECISION_U64, // 101
                size: 10 * BASE_PRECISION_U64,
                remaining_account_index: 99,
                maker_stats_remaining_index: 0,
            }];

            let result = run_unified_matching(
                &amm_views,
                &dlob,
                slice,
                PositionDirection::Long,
                110 * PRICE_PRECISION_U64,
                12 * BASE_PRECISION_U64,
            )
            .unwrap();

            // PropAMM A and B share 12 pro-rata (6 each if equal), then DLOB gets remainder.
            let prop_filled: u64 = result.external_fills.iter().map(|f| f.fill.fill_size).sum();
            let dlob_filled: u64 = result.dlob_fills.iter().map(|f| f.base_asset_amount).sum();

            // All tied at price 101. PropAMM fills pro-rata first (total 20 available, 12 requested),
            // so PropAMM fills 12 and DLOB fills 0.
            assert_eq!(
                prop_filled,
                12 * BASE_PRECISION_U64,
                "PropAMM fills all 12 pro-rata"
            );
            assert_eq!(
                dlob_filled, 0,
                "DLOB not needed when PropAMM covers full size"
            );
        }

        /// When PropAMM books are exhausted at a price level, DLOB at the same price fills remainder.
        #[test]
        fn unified_tied_price_prop_amm_exhausted_dlob_remainder() {
            let program_id = drift_program_id();
            let midprice_prog_id = midprice_program_id();

            // Single PropAMM book: mid=100, ask offset=1, size=4
            let (auth, maker_key) = derive_maker_user_pda();
            let mut maker_user = User::default();
            maker_user.authority = auth;
            maker_user.sub_account_id = 0;
            crate::create_anchor_account_info!(maker_user, &maker_key, User, maker_user_info);
            let data = make_midprice_account_data(
                100 * PRICE_PRECISION_U64,
                4 * BASE_PRECISION_U64,
                &auth,
            );
            let mid_key = Pubkey::new_unique();
            let mut mid_lamps = 0u64;
            let mut mid_data = data;
            let mid_info = create_account_info(
                &mid_key,
                true,
                &mut mid_lamps,
                &mut mid_data[..],
                &midprice_prog_id,
            );

            let mut prog_lamps = 0u64;
            let mut prog_data = [0u8; 0];
            let program_info = create_executable_program_account_info(
                &midprice_prog_id,
                &mut prog_lamps,
                &mut prog_data[..],
            );
            let (global_matcher_pda, _) = prop_amm_matcher_pda(&program_id);
            let mut gm_lamps = 0u64;
            let mut gm_data = [0u8; 0];
            let gm_info = create_account_info(
                &global_matcher_pda,
                true,
                &mut gm_lamps,
                &mut gm_data[..],
                &program_id,
            );

            let remaining: Vec<AccountInfo> =
                vec![program_info, gm_info, mid_info, maker_user_info];
            let slice = remaining.as_slice();
            let (_, amm_views, _) =
                parse_amm_views(slice, 1, &program_id, 100, None, None).unwrap();

            // DLOB at the same price (101) with plenty of depth
            let dlob = vec![DlobMakerView {
                maker_key: Pubkey::new_unique(),
                order_index: 0,
                price: 100 * PRICE_PRECISION_U64 + PRICE_PRECISION_U64,
                size: 20 * BASE_PRECISION_U64,
                remaining_account_index: 99,
                maker_stats_remaining_index: 0,
            }];

            let result = run_unified_matching(
                &amm_views,
                &dlob,
                slice,
                PositionDirection::Long,
                110 * PRICE_PRECISION_U64,
                10 * BASE_PRECISION_U64,
            )
            .unwrap();

            let prop_filled: u64 = result.external_fills.iter().map(|f| f.fill.fill_size).sum();
            let dlob_filled: u64 = result.dlob_fills.iter().map(|f| f.base_asset_amount).sum();

            assert_eq!(
                prop_filled,
                4 * BASE_PRECISION_U64,
                "PropAMM exhausts its 4"
            );
            assert_eq!(
                dlob_filled,
                6 * BASE_PRECISION_U64,
                "DLOB fills remaining 6"
            );
        }

        /// When two DLOB makers quote the same price, fills should remain deterministic and sequential.
        #[test]
        fn unified_same_price_dlob_fills_in_input_order() {
            let maker_a = Pubkey::new_unique();
            let maker_b = Pubkey::new_unique();
            let dlob = vec![
                DlobMakerView {
                    maker_key: maker_a,
                    order_index: 0,
                    price: 100 * PRICE_PRECISION_U64,
                    size: 4 * BASE_PRECISION_U64,
                    remaining_account_index: 0,
                    maker_stats_remaining_index: 0,
                },
                DlobMakerView {
                    maker_key: maker_b,
                    order_index: 0,
                    price: 100 * PRICE_PRECISION_U64,
                    size: 6 * BASE_PRECISION_U64,
                    remaining_account_index: 1,
                    maker_stats_remaining_index: 0,
                },
            ];

            let result = run_unified_matching(
                &[],
                &dlob,
                &[],
                PositionDirection::Long,
                101 * PRICE_PRECISION_U64,
                7 * BASE_PRECISION_U64,
            )
            .unwrap();

            assert_eq!(result.dlob_fills.len(), 2);
            assert_eq!(result.dlob_fills[0].maker_key, maker_a);
            assert_eq!(
                result.dlob_fills[0].base_asset_amount,
                4 * BASE_PRECISION_U64
            );
            assert_eq!(result.dlob_fills[1].maker_key, maker_b);
            assert_eq!(
                result.dlob_fills[1].base_asset_amount,
                3 * BASE_PRECISION_U64
            );
        }

        /// Expired PropAMM quotes should be skipped so valid DLOB liquidity can still fill.
        #[test]
        fn expired_prop_amm_quote_skips_to_dlob_fill() {
            let program_id = drift_program_id();
            let midprice_prog_id = midprice_program_id();

            let (maker_authority, maker_user_key) = derive_maker_user_pda();
            let mut maker_user = User::default();
            maker_user.authority = maker_authority;
            maker_user.sub_account_id = 0;
            crate::create_anchor_account_info!(maker_user, &maker_user_key, User, maker_user_info);

            let midprice_key = Pubkey::new_unique();
            let mut midprice_lamports = 0u64;
            let mut midprice_data = make_midprice_data_with_ttl(
                100 * PRICE_PRECISION_U64,
                5 * BASE_PRECISION_U64,
                &maker_authority,
                100,
                10,
            );
            let midprice_info = create_account_info(
                &midprice_key,
                true,
                &mut midprice_lamports,
                &mut midprice_data[..],
                &midprice_prog_id,
            );

            let dlob_maker_key = Pubkey::new_unique();
            let dlob_maker_authority = Pubkey::new_unique();
            let mut dlob_maker = User {
                authority: dlob_maker_authority,
                ..User::default()
            };
            dlob_maker.orders[0] = make_open_perp_order(
                PositionDirection::Short,
                100 * PRICE_PRECISION_U64,
                5 * BASE_PRECISION_U64,
                1,
            );
            crate::create_anchor_account_info!(dlob_maker, &dlob_maker_key, User, dlob_maker_info);
            let dlob_stats_key = Pubkey::new_unique();
            let mut dlob_stats = UserStats {
                authority: dlob_maker_authority,
                ..UserStats::default()
            };
            crate::create_anchor_account_info!(
                dlob_stats,
                &dlob_stats_key,
                UserStats,
                dlob_stats_info
            );

            let mut prog_lamps = 0u64;
            let mut prog_data = [0u8; 0];
            let program_info = create_executable_program_account_info(
                &midprice_prog_id,
                &mut prog_lamps,
                &mut prog_data[..],
            );
            let (global_matcher_pda, _) = prop_amm_matcher_pda(&program_id);
            let mut gm_lamps = 0u64;
            let mut gm_data = [0u8; 0];
            let gm_info = create_account_info(
                &global_matcher_pda,
                true,
                &mut gm_lamps,
                &mut gm_data[..],
                &program_id,
            );

            let remaining: Vec<AccountInfo> = vec![
                program_info,
                gm_info,
                midprice_info,
                maker_user_info,
                dlob_maker_info,
                dlob_stats_info,
            ];
            let slice = remaining.as_slice();

            let (_, amm_views, dlob_start) =
                parse_amm_views(slice, 1, &program_id, 200, None, None).unwrap();
            assert!(
                amm_views.is_empty(),
                "expired PropAMM quote should be skipped"
            );

            let (dlob_views, _) = parse_dlob_makers(
                slice,
                dlob_start,
                &program_id,
                &Pubkey::new_unique(),
                PositionDirection::Long,
                0,
                101 * PRICE_PRECISION_U64,
                (100 * PRICE_PRECISION_U64) as i64,
                200,
                0,
                PRICE_PRECISION_U64,
                false,
                false,
                0,
                200,
                false,
                crate::state::protected_maker_mode_config::ProtectedMakerParams::default(),
                10,
                500,
                BASE_PRECISION_U64,
            )
            .unwrap();
            assert_eq!(dlob_views.len(), 1);

            let result = run_unified_matching(
                &amm_views,
                &dlob_views,
                slice,
                PositionDirection::Long,
                101 * PRICE_PRECISION_U64,
                5 * BASE_PRECISION_U64,
            )
            .unwrap();

            assert!(
                result.external_fills.is_empty(),
                "expired PropAMM must not contribute fills"
            );
            assert_eq!(
                result.dlob_fills.len(),
                1,
                "DLOB liquidity should still fill"
            );
            assert_eq!(
                result.dlob_fills[0].base_asset_amount,
                5 * BASE_PRECISION_U64
            );
        }

        /// No sources at all: zero fill, no error.
        #[test]
        fn unified_no_sources_returns_empty() {
            let result = run_unified_matching(
                &[],
                &[],
                &[],
                PositionDirection::Long,
                100 * PRICE_PRECISION_U64,
                10 * BASE_PRECISION_U64,
            )
            .unwrap();

            assert_eq!(result.taker_base_delta, 0);
            assert!(result.external_fills.is_empty());
            assert!(result.dlob_fills.is_empty());
        }

        /// Taker limit price too low: no source crosses, zero fill.
        #[test]
        fn unified_limit_price_prevents_fills() {
            let program_id = drift_program_id();
            let midprice_key = Pubkey::new_unique();
            let (auth, maker_key) = derive_maker_user_pda();
            let mut maker_user = User::default();
            maker_user.authority = auth;
            maker_user.sub_account_id = 0;
            crate::create_anchor_account_info!(maker_user, &maker_key, User, maker_user_info);

            let data = make_midprice_account_data(
                100 * PRICE_PRECISION_U64,
                50 * BASE_PRECISION_U64,
                &auth,
            );
            let midprice_prog_id = midprice_program_id();
            let mut mid_lamps = 0u64;
            let mut mid_data = data;
            let mid_info = create_account_info(
                &midprice_key,
                true,
                &mut mid_lamps,
                &mut mid_data[..],
                &midprice_prog_id,
            );
            let mut prog_lamps = 0u64;
            let mut prog_data = [0u8; 0];
            let program_info = create_executable_program_account_info(
                &midprice_prog_id,
                &mut prog_lamps,
                &mut prog_data[..],
            );
            let (global_matcher_pda, _) = prop_amm_matcher_pda(&program_id);
            let mut gm_lamps = 0u64;
            let mut gm_data = [0u8; 0];
            let gm_info = create_account_info(
                &global_matcher_pda,
                true,
                &mut gm_lamps,
                &mut gm_data[..],
                &program_id,
            );

            let remaining: Vec<AccountInfo> =
                vec![program_info, gm_info, mid_info, maker_user_info];
            let slice = remaining.as_slice();
            let (_, amm_views, _) =
                parse_amm_views(slice, 1, &program_id, 100, None, None).unwrap();

            let dlob = vec![DlobMakerView {
                maker_key: Pubkey::new_unique(),
                order_index: 0,
                price: 110 * PRICE_PRECISION_U64,
                size: 20 * BASE_PRECISION_U64,
                remaining_account_index: 99,
                maker_stats_remaining_index: 0,
            }];

            // PropAMM at ~101, DLOB at 110
            // Limit price = 50 — nothing crosses for a Long taker.
            let result = run_unified_matching(
                &amm_views,
                &dlob,
                slice,
                PositionDirection::Long,
                50 * PRICE_PRECISION_U64, // too low
                10 * BASE_PRECISION_U64,
            )
            .unwrap();

            assert!(
                result.external_fills.is_empty(),
                "PropAMM ask > limit price"
            );
            assert!(result.dlob_fills.is_empty(), "DLOB price > limit price");
        }

        // -----------------------------------------------------------------------
        // Security tests for unified matching
        // -----------------------------------------------------------------------

        /// DLOB frontiers that don't cross the taker's limit price must be excluded.
        #[test]
        fn security_dlob_non_crossing_excluded() {
            let dlob = vec![
                DlobMakerView {
                    maker_key: Pubkey::new_unique(),
                    order_index: 0,
                    price: 110 * PRICE_PRECISION_U64, // crosses (limit=115)
                    size: 5 * BASE_PRECISION_U64,
                    remaining_account_index: 0,
                    maker_stats_remaining_index: 0,
                },
                DlobMakerView {
                    maker_key: Pubkey::new_unique(),
                    order_index: 0,
                    price: 120 * PRICE_PRECISION_U64, // doesn't cross
                    size: 5 * BASE_PRECISION_U64,
                    remaining_account_index: 1,
                    maker_stats_remaining_index: 0,
                },
            ];

            let result = run_unified_matching(
                &[],
                &dlob,
                &[],
                PositionDirection::Long,
                115 * PRICE_PRECISION_U64,
                10 * BASE_PRECISION_U64,
            )
            .unwrap();

            // Only 5 can be filled (from maker at 110); maker at 120 doesn't cross.
            let dlob_filled: u64 = result.dlob_fills.iter().map(|f| f.base_asset_amount).sum();
            assert_eq!(
                dlob_filled,
                5 * BASE_PRECISION_U64,
                "only crossing DLOB fills"
            );
        }

        /// DLOB fill must not exceed the maker's available size.
        #[test]
        fn security_dlob_fill_bounded_by_maker_size() {
            let dlob = vec![DlobMakerView {
                maker_key: Pubkey::new_unique(),
                order_index: 0,
                price: 100 * PRICE_PRECISION_U64,
                size: 3 * BASE_PRECISION_U64, // only 3 available
                remaining_account_index: 0,
                maker_stats_remaining_index: 0,
            }];

            let result = run_unified_matching(
                &[],
                &dlob,
                &[],
                PositionDirection::Long,
                110 * PRICE_PRECISION_U64,
                10 * BASE_PRECISION_U64, // wants 10
            )
            .unwrap();

            let filled: u64 = result.dlob_fills.iter().map(|f| f.base_asset_amount).sum();
            assert_eq!(filled, 3 * BASE_PRECISION_U64, "capped at maker's size");
        }

        /// Discriminator boundary: accounts with "midp" discriminator + midprice program owner
        /// are PropAMM; others are DLOB. Verify clean boundary detection.
        #[test]
        fn security_discriminator_boundary_detection() {
            let program_id = drift_program_id();
            let midprice_prog_id = midprice_program_id();

            // One valid PropAMM pair
            let (auth, maker_key) = derive_maker_user_pda();
            let mut maker_user = User::default();
            maker_user.authority = auth;
            maker_user.sub_account_id = 0;
            crate::create_anchor_account_info!(maker_user, &maker_key, User, maker_user_info);

            let data = make_midprice_account_data(
                100 * PRICE_PRECISION_U64,
                10 * BASE_PRECISION_U64,
                &auth,
            );
            let mid_key = Pubkey::new_unique();
            let mut mid_lamps = 0u64;
            let mut mid_data = data;
            let mid_info = create_account_info(
                &mid_key,
                true,
                &mut mid_lamps,
                &mut mid_data[..],
                &midprice_prog_id,
            );

            // One Drift User account (DLOB maker) — owned by drift, NOT midprice program
            let dlob_key = Pubkey::new_unique();
            let mut dlob_user = User::default();
            crate::create_anchor_account_info!(dlob_user, &dlob_key, User, dlob_user_info);

            let mut prog_lamps = 0u64;
            let mut prog_data = [0u8; 0];
            let program_info = create_executable_program_account_info(
                &midprice_prog_id,
                &mut prog_lamps,
                &mut prog_data[..],
            );
            let (global_matcher_pda, _) = prop_amm_matcher_pda(&program_id);
            let mut gm_lamps = 0u64;
            let mut gm_data = [0u8; 0];
            let gm_info = create_account_info(
                &global_matcher_pda,
                true,
                &mut gm_lamps,
                &mut gm_data[..],
                &program_id,
            );

            // Layout: [midprice_program, matcher, midprice_acct, maker_user, dlob_user]
            let remaining: Vec<AccountInfo> = vec![
                program_info,
                gm_info,
                mid_info,
                maker_user_info,
                dlob_user_info,
            ];
            let slice = remaining.as_slice();

            let (_, amm_views, dlob_start) =
                parse_amm_views(slice, 1, &program_id, 100, None, None).unwrap();

            assert_eq!(amm_views.len(), 1, "exactly one PropAMM pair");
            assert_eq!(dlob_start, 4, "DLOB starts at index 4 (after PropAMM pair)");
            assert_eq!(
                remaining.len() - dlob_start,
                1,
                "one DLOB maker account after boundary"
            );
        }

        /// A Drift User account with bytes that happen to start with "midp" should NOT be
        /// detected as a midprice account because its owner is the Drift program, not midprice.
        #[test]
        fn security_drift_user_with_midp_bytes_not_confused() {
            let midprice_prog_id = midprice_program_id();
            let drift_prog_id = drift_program_id();

            // Create a Drift User account whose data starts with "midp" (adversarial)
            let fake_key = Pubkey::new_unique();
            let mut fake_lamps = 100u64;
            let mut fake_data = vec![0u8; 128];
            fake_data[..4].copy_from_slice(b"midp"); // plant the discriminator
            let fake_info = create_account_info(
                &fake_key,
                true,
                &mut fake_lamps,
                &mut fake_data[..],
                &drift_prog_id, // owned by Drift, NOT midprice
            );

            assert!(
            !is_midprice_account(&fake_info, &midprice_prog_id),
            "Drift-owned account must not pass midprice discriminator check even with 'midp' bytes"
        );
        }

        /// An account owned by the midprice program but with wrong discriminator (not "midp")
        /// should not be detected as a midprice account.
        #[test]
        fn security_wrong_discriminator_not_detected() {
            let midprice_prog_id = midprice_program_id();
            let key = Pubkey::new_unique();
            let mut lamps = 100u64;
            let mut data = vec![0u8; 128];
            data[..4].copy_from_slice(b"fake"); // wrong discriminator
            let info =
                create_account_info(&key, true, &mut lamps, &mut data[..], &midprice_prog_id);

            assert!(
                !is_midprice_account(&info, &midprice_prog_id),
                "wrong discriminator must not be detected as midprice"
            );
        }

        /// Interleaving PropAMM and DLOB accounts is not allowed: once the first non-midprice
        /// account is hit, all subsequent accounts are DLOB. A midprice account after a DLOB
        /// account would be silently ignored (not parsed as PropAMM). This test documents that.
        #[test]
        fn security_no_interleaving_prop_amm_after_dlob() {
            let program_id = drift_program_id();
            let midprice_prog_id = midprice_program_id();

            // DLOB user (non-midprice) — will be encountered first after matcher
            let dlob_key = Pubkey::new_unique();
            let mut dlob_user = User::default();
            crate::create_anchor_account_info!(dlob_user, &dlob_key, User, dlob_user_info);

            // PropAMM pair — placed after the DLOB user (should NOT be parsed as PropAMM)
            let (auth, maker_key) = derive_maker_user_pda();
            let mut maker_user = User::default();
            maker_user.authority = auth;
            maker_user.sub_account_id = 0;
            crate::create_anchor_account_info!(maker_user, &maker_key, User, maker_user_info);
            let data = make_midprice_account_data(
                100 * PRICE_PRECISION_U64,
                10 * BASE_PRECISION_U64,
                &auth,
            );
            let mid_key = Pubkey::new_unique();
            let mut mid_lamps = 0u64;
            let mut mid_data = data;
            let mid_info = create_account_info(
                &mid_key,
                true,
                &mut mid_lamps,
                &mut mid_data[..],
                &midprice_prog_id,
            );

            let mut prog_lamps = 0u64;
            let mut prog_data = [0u8; 0];
            let program_info = create_executable_program_account_info(
                &midprice_prog_id,
                &mut prog_lamps,
                &mut prog_data[..],
            );
            let (global_matcher_pda, _) = prop_amm_matcher_pda(&program_id);
            let mut gm_lamps = 0u64;
            let mut gm_data = [0u8; 0];
            let gm_info = create_account_info(
                &global_matcher_pda,
                true,
                &mut gm_lamps,
                &mut gm_data[..],
                &program_id,
            );

            // Layout: [prog, matcher, dlob_user, midprice, maker_user]
            // The DLOB user at index 2 breaks the PropAMM scan.
            let remaining: Vec<AccountInfo> = vec![
                program_info,
                gm_info,
                dlob_user_info, // not midprice → boundary
                mid_info,       // this midprice is after boundary
                maker_user_info,
            ];
            let slice = remaining.as_slice();

            let (_, amm_views, dlob_start) =
                parse_amm_views(slice, 1, &program_id, 100, None, None).unwrap();

            assert_eq!(
                amm_views.len(),
                0,
                "no PropAMM pairs parsed (boundary hit immediately)"
            );
            assert_eq!(dlob_start, 2, "DLOB starts at index 2");
            // The midprice account at index 3 is in the DLOB tail — it won't be used for PropAMM
            // matching. If someone tries to use it as a DLOB maker, it would fail validation
            // (not owned by Drift program).
        }
    }

    mod margin {
        use super::*;

        // -----------------------------------------------------------------------
        // Margin: taker margin type selection (Maintenance vs Fill)
        // -----------------------------------------------------------------------

        /// Helper: set up standard oracle, perp market (10% initial / 5% maintenance), and quote spot market.
        /// Returns (oracle_map, perp_market_map, spot_market_map) tuple.
        /// `margin_ratio_initial` = 1000 (10%), `margin_ratio_maintenance` = 500 (5%).
        macro_rules! margin_test_setup {
            ($slot:expr, $oracle_key:expr, $pyth_program:expr,
         $oracle_price:ident, $oracle_account_info:ident, $oracle_map:ident,
         $perp_market:ident, $perp_market_info:ident, $perp_market_map:ident,
         $spot_market:ident, $spot_market_info:ident, $spot_market_map:ident) => {
                let mut $oracle_price = get_pyth_price(100, 6);
                crate::create_account_info!(
                    $oracle_price,
                    &$oracle_key,
                    &$pyth_program,
                    $oracle_account_info
                );
                let mut $oracle_map = crate::state::oracle_map::OracleMap::load_one(
                    &$oracle_account_info,
                    $slot,
                    None,
                )
                .unwrap();

                let mut $perp_market = PerpMarket {
                    market_index: 0,
                    amm: AMM {
                        base_asset_reserve: 100 * AMM_RESERVE_PRECISION,
                        quote_asset_reserve: 100 * AMM_RESERVE_PRECISION,
                        oracle: $oracle_key,
                        order_tick_size: 1,
                        historical_oracle_data: HistoricalOracleData {
                            last_oracle_price: 100 * crate::math::constants::PRICE_PRECISION_I64,
                            last_oracle_price_twap: 100
                                * crate::math::constants::PRICE_PRECISION_I64,
                            ..HistoricalOracleData::default()
                        },
                        ..AMM::default()
                    },
                    margin_ratio_initial: 1000,    // 10%
                    margin_ratio_maintenance: 500, // 5%
                    status: MarketStatus::Active,
                    ..PerpMarket::default_test()
                };
                $perp_market.amm.max_base_asset_reserve = u64::MAX as u128;
                $perp_market.amm.min_base_asset_reserve = 0;
                crate::create_anchor_account_info!($perp_market, PerpMarket, $perp_market_info);
                let $perp_market_map = PerpMarketMap::load_one(&$perp_market_info, true).unwrap();

                let mut $spot_market = SpotMarket {
                    market_index: 0,
                    oracle_source: OracleSource::QuoteAsset,
                    cumulative_deposit_interest: SPOT_CUMULATIVE_INTEREST_PRECISION,
                    decimals: 6,
                    initial_asset_weight: SPOT_WEIGHT_PRECISION,
                    maintenance_asset_weight: SPOT_WEIGHT_PRECISION,
                    historical_oracle_data: HistoricalOracleData::default_quote_oracle(),
                    ..SpotMarket::default()
                };
                crate::create_anchor_account_info!($spot_market, SpotMarket, $spot_market_info);
                let $spot_market_map = SpotMarketMap::load_one(&$spot_market_info, true).unwrap();
            };
        }

        /// Helper: build a User with given USDC collateral and perp position.
        fn make_margin_user(usdc_balance: u64, perp_base: i64) -> User {
            let mut spot_positions = [SpotPosition::default(); 8];
            spot_positions[0] = SpotPosition {
                market_index: 0,
                balance_type: SpotBalanceType::Deposit,
                scaled_balance: usdc_balance * SPOT_BALANCE_PRECISION_U64,
                ..SpotPosition::default()
            };
            let mut perp_positions = [PerpPosition::default(); 8];
            if perp_base != 0 {
                let quote =
                    (perp_base as i128 * 100 * crate::math::constants::PRICE_PRECISION_I64 as i128
                        / BASE_PRECISION_U64 as i128) as i64;
                perp_positions[0] = PerpPosition {
                    market_index: 0,
                    base_asset_amount: perp_base,
                    quote_asset_amount: -quote,
                    quote_entry_amount: -quote,
                    quote_break_even_amount: -quote,
                    ..PerpPosition::default()
                };
            }
            User {
                spot_positions,
                perp_positions,
                ..User::default()
            }
        }

        /// Helper: apply a simulated fill delta to a user and return the new User.
        fn apply_fill_to_user(user: &User, fill_base: i64) -> User {
            let fill_quote =
                (fill_base as i128 * 100 * crate::math::constants::PRICE_PRECISION_I64 as i128
                    / BASE_PRECISION_U64 as i128) as i64;
            let mut pp = user.perp_positions;
            pp[0].market_index = 0;
            pp[0].base_asset_amount += fill_base;
            pp[0].quote_asset_amount -= fill_quote;
            pp[0].quote_entry_amount -= fill_quote;
            pp[0].quote_break_even_amount -= fill_quote;
            User {
                perp_positions: pp,
                ..*user
            }
        }

        /// Taker closes an existing long position entirely (long → flat).
        /// Uses Maintenance margin (relaxed) since position is decreasing.
        #[test]
        fn margin_taker_close_long_to_flat_uses_maintenance() {
            let slot = 0_u64;
            let oracle_key =
                Pubkey::from_str("J83w4HKfqxwcq3BEMMkPFSppX3gqekLyLJBexebFVkix").unwrap();
            let pyth_program = crate::ids::pyth_program::id();
            margin_test_setup!(
                slot,
                oracle_key,
                pyth_program,
                oracle_price,
                oracle_account_info,
                oracle_map,
                perp_market,
                perp_market_info,
                perp_market_map,
                spot_market,
                spot_market_info,
                spot_market_map
            );

            // Taker: long 10 base @ $100, $10k collateral
            let base = 10 * BASE_PRECISION_U64 as i64;
            let user = make_margin_user(10_000, base);

            // Sell 10 base → flat (position_after = 0)
            let fill_delta = -base;
            let position_after = base + fill_delta; // 0
            let position_before = base; // 10 BASE

            // position_after == 0 → taker_position_decreasing = true → Maintenance
            assert_eq!(position_after, 0);
            let taker_position_decreasing = position_after == 0
                || (position_after.signum() == position_before.signum()
                    && position_after.abs() < position_before.abs());
            assert!(
                taker_position_decreasing,
                "closing to flat must be position-decreasing"
            );

            let user_after = apply_fill_to_user(&user, fill_delta);
            let margin_calc = calculate_margin_requirement_and_total_collateral_and_liability_info(
                &user_after,
                &perp_market_map,
                &spot_market_map,
                &mut oracle_map,
                MarginContext::standard(MarginRequirementType::Maintenance),
            )
            .unwrap();
            assert!(
                margin_calc.meets_margin_requirement(),
                "flat position must pass maintenance"
            );
        }

        /// Taker reduces an existing long (long 10 → long 3).
        /// Uses Maintenance margin since position magnitude is shrinking.
        #[test]
        fn margin_taker_reduce_long_uses_maintenance() {
            let slot = 0_u64;
            let oracle_key =
                Pubkey::from_str("J83w4HKfqxwcq3BEMMkPFSppX3gqekLyLJBexebFVkix").unwrap();
            let pyth_program = crate::ids::pyth_program::id();
            margin_test_setup!(
                slot,
                oracle_key,
                pyth_program,
                oracle_price,
                oracle_account_info,
                oracle_map,
                perp_market,
                perp_market_info,
                perp_market_map,
                spot_market,
                spot_market_info,
                spot_market_map
            );

            let base = 10 * BASE_PRECISION_U64 as i64;
            let user = make_margin_user(10_000, base);

            // Sell 7 base → long 3
            let fill_delta = -7 * BASE_PRECISION_U64 as i64;
            let position_after = base + fill_delta;
            let position_before = base;

            assert!(position_after > 0 && position_after < position_before);
            let taker_position_decreasing = position_after == 0
                || (position_after.signum() == position_before.signum()
                    && position_after.abs() < position_before.abs());
            assert!(
                taker_position_decreasing,
                "reducing long magnitude must be position-decreasing"
            );

            let user_after = apply_fill_to_user(&user, fill_delta);
            let margin_calc = calculate_margin_requirement_and_total_collateral_and_liability_info(
                &user_after,
                &perp_market_map,
                &spot_market_map,
                &mut oracle_map,
                MarginContext::standard(MarginRequirementType::Maintenance),
            )
            .unwrap();
            assert!(
                margin_calc.meets_margin_requirement(),
                "reduced long must pass maintenance"
            );
        }

        /// Taker opens a new long from flat (flat → long 10).
        /// Uses Fill margin (stricter) since position is risk-increasing.
        #[test]
        fn margin_taker_open_long_from_flat_uses_fill() {
            let slot = 0_u64;
            let oracle_key =
                Pubkey::from_str("J83w4HKfqxwcq3BEMMkPFSppX3gqekLyLJBexebFVkix").unwrap();
            let pyth_program = crate::ids::pyth_program::id();
            margin_test_setup!(
                slot,
                oracle_key,
                pyth_program,
                oracle_price,
                oracle_account_info,
                oracle_map,
                perp_market,
                perp_market_info,
                perp_market_map,
                spot_market,
                spot_market_info,
                spot_market_map
            );

            // Taker starts flat, $20k USDC collateral
            let user = make_margin_user(20_000, 0);

            // Buy 10 base → long 10 @ $100 = $1000 notional, 10% margin = $100 requirement
            let fill_delta = 10 * BASE_PRECISION_U64 as i64;
            let position_after = fill_delta; // 10 BASE
            let position_before = 0_i64;

            // position_after != 0 and position_before == 0 → signum check fails → Fill
            let taker_position_decreasing = position_after == 0
                || (position_after.signum() == position_before.signum()
                    && position_after.abs() < position_before.abs());
            assert!(
                !taker_position_decreasing,
                "opening from flat must be risk-increasing"
            );

            let user_after = apply_fill_to_user(&user, fill_delta);
            let margin_calc = calculate_margin_requirement_and_total_collateral_and_liability_info(
                &user_after,
                &perp_market_map,
                &spot_market_map,
                &mut oracle_map,
                MarginContext::standard(MarginRequirementType::Fill),
            )
            .unwrap();
            assert!(
                margin_calc.meets_margin_requirement(),
                "well-collateralized open must pass fill margin"
            );
        }

        /// Taker increases an existing long (long 5 → long 15).
        /// Uses Fill margin since position magnitude is growing.
        #[test]
        fn margin_taker_increase_long_uses_fill() {
            let slot = 0_u64;
            let oracle_key =
                Pubkey::from_str("J83w4HKfqxwcq3BEMMkPFSppX3gqekLyLJBexebFVkix").unwrap();
            let pyth_program = crate::ids::pyth_program::id();
            margin_test_setup!(
                slot,
                oracle_key,
                pyth_program,
                oracle_price,
                oracle_account_info,
                oracle_map,
                perp_market,
                perp_market_info,
                perp_market_map,
                spot_market,
                spot_market_info,
                spot_market_map
            );

            let base = 5 * BASE_PRECISION_U64 as i64;
            let user = make_margin_user(20_000, base);

            // Buy 10 more → long 15
            let fill_delta = 10 * BASE_PRECISION_U64 as i64;
            let position_after = base + fill_delta;
            let position_before = base;

            // Same sign but magnitude increased → risk-increasing → Fill
            let taker_position_decreasing = position_after == 0
                || (position_after.signum() == position_before.signum()
                    && position_after.abs() < position_before.abs());
            assert!(
                !taker_position_decreasing,
                "increasing long must be risk-increasing"
            );

            let user_after = apply_fill_to_user(&user, fill_delta);
            let margin_calc = calculate_margin_requirement_and_total_collateral_and_liability_info(
                &user_after,
                &perp_market_map,
                &spot_market_map,
                &mut oracle_map,
                MarginContext::standard(MarginRequirementType::Fill),
            )
            .unwrap();
            assert!(
                margin_calc.meets_margin_requirement(),
                "well-collateralized increase must pass fill margin"
            );
        }

        /// Taker flips direction (long 5 → short 5).
        /// Uses Fill margin since position_after.signum() != position_before.signum().
        #[test]
        fn margin_taker_flip_long_to_short_uses_fill() {
            let slot = 0_u64;
            let oracle_key =
                Pubkey::from_str("J83w4HKfqxwcq3BEMMkPFSppX3gqekLyLJBexebFVkix").unwrap();
            let pyth_program = crate::ids::pyth_program::id();
            margin_test_setup!(
                slot,
                oracle_key,
                pyth_program,
                oracle_price,
                oracle_account_info,
                oracle_map,
                perp_market,
                perp_market_info,
                perp_market_map,
                spot_market,
                spot_market_info,
                spot_market_map
            );

            let base = 5 * BASE_PRECISION_U64 as i64;
            let user = make_margin_user(20_000, base);

            // Sell 10 base → short 5
            let fill_delta = -10 * BASE_PRECISION_U64 as i64;
            let position_after = base + fill_delta; // -5 BASE
            let position_before = base; // 5 BASE

            assert!(position_after < 0 && position_before > 0, "must flip sign");
            let taker_position_decreasing = position_after == 0
                || (position_after.signum() == position_before.signum()
                    && position_after.abs() < position_before.abs());
            assert!(
                !taker_position_decreasing,
                "flipping direction must be risk-increasing"
            );

            let user_after = apply_fill_to_user(&user, fill_delta);
            let margin_calc = calculate_margin_requirement_and_total_collateral_and_liability_info(
                &user_after,
                &perp_market_map,
                &spot_market_map,
                &mut oracle_map,
                MarginContext::standard(MarginRequirementType::Fill),
            )
            .unwrap();
            assert!(
                margin_calc.meets_margin_requirement(),
                "well-collateralized flip must pass fill margin"
            );
        }

        /// Taker with barely-enough collateral can close a position (maintenance margin is relaxed),
        /// but the same collateral level would fail if opening a new position (fill margin is stricter).
        #[test]
        fn margin_taker_close_passes_maintenance_but_open_would_fail_fill() {
            let slot = 0_u64;
            let oracle_key =
                Pubkey::from_str("J83w4HKfqxwcq3BEMMkPFSppX3gqekLyLJBexebFVkix").unwrap();
            let pyth_program = crate::ids::pyth_program::id();
            margin_test_setup!(
                slot,
                oracle_key,
                pyth_program,
                oracle_price,
                oracle_account_info,
                oracle_map,
                perp_market,
                perp_market_info,
                perp_market_map,
                spot_market,
                spot_market_info,
                spot_market_map
            );

            // Oracle price = $100. For a 100 BASE long, notional = $10,000.
            // maintenance (5%) = $500, fill/initial (10%) = $1,000.
            // Give user exactly $600 collateral.
            // Also need to account for the quote_asset_amount on the perp position.
            let base_amount = 100 * BASE_PRECISION_U64 as i64;
            let user_with_long = make_margin_user(600, base_amount);

            // Closing the long (sell 100) → flat: Maintenance margin on a flat position = 0.
            // $600 collateral > 0 requirement → passes.
            let user_after_close = apply_fill_to_user(&user_with_long, -base_amount);
            assert_eq!(
                user_after_close.perp_positions[0].base_asset_amount, 0,
                "must be flat after close"
            );
            let margin_close =
                calculate_margin_requirement_and_total_collateral_and_liability_info(
                    &user_after_close,
                    &perp_market_map,
                    &spot_market_map,
                    &mut oracle_map,
                    MarginContext::standard(MarginRequirementType::Maintenance),
                )
                .unwrap();
            assert!(
                margin_close.meets_margin_requirement(),
                "closing to flat with $600 must pass maintenance"
            );

            // Now test: opening a new long (flat → long 100) with the same $600.
            // Fill margin (10%) on $10,000 notional = $1,000 requirement.
            // $600 < $1,000 → should fail.
            let flat_user = make_margin_user(600, 0);
            let user_after_open = apply_fill_to_user(&flat_user, base_amount);
            let margin_open = calculate_margin_requirement_and_total_collateral_and_liability_info(
                &user_after_open,
                &perp_market_map,
                &spot_market_map,
                &mut oracle_map,
                MarginContext::standard(MarginRequirementType::Fill),
            )
            .unwrap();
            assert!(
                !margin_open.meets_margin_requirement(),
                "opening long 100 with $600 collateral must fail fill margin"
            );
        }

        /// Taker with insufficient collateral fails margin when opening a risk-increasing position.
        #[test]
        fn margin_taker_open_insufficient_collateral_fails() {
            let slot = 0_u64;
            let oracle_key =
                Pubkey::from_str("J83w4HKfqxwcq3BEMMkPFSppX3gqekLyLJBexebFVkix").unwrap();
            let pyth_program = crate::ids::pyth_program::id();
            margin_test_setup!(
                slot,
                oracle_key,
                pyth_program,
                oracle_price,
                oracle_account_info,
                oracle_map,
                perp_market,
                perp_market_info,
                perp_market_map,
                spot_market,
                spot_market_info,
                spot_market_map
            );

            // $50 collateral, try to open long 100 BASE @ $100 = $10,000 notional.
            // Fill margin (10%) = $1,000 >> $50.
            let user = make_margin_user(50, 0);
            let fill_delta = 100 * BASE_PRECISION_U64 as i64;
            let user_after = apply_fill_to_user(&user, fill_delta);

            let margin_calc = calculate_margin_requirement_and_total_collateral_and_liability_info(
                &user_after,
                &perp_market_map,
                &spot_market_map,
                &mut oracle_map,
                MarginContext::standard(MarginRequirementType::Fill),
            )
            .unwrap();
            assert!(
                !margin_calc.meets_margin_requirement(),
                "opening huge position with $50 collateral must fail fill margin"
            );
        }

        /// Taker reduces a short (short 10 → short 3): Maintenance margin type.
        #[test]
        fn margin_taker_reduce_short_uses_maintenance() {
            let slot = 0_u64;
            let oracle_key =
                Pubkey::from_str("J83w4HKfqxwcq3BEMMkPFSppX3gqekLyLJBexebFVkix").unwrap();
            let pyth_program = crate::ids::pyth_program::id();
            margin_test_setup!(
                slot,
                oracle_key,
                pyth_program,
                oracle_price,
                oracle_account_info,
                oracle_map,
                perp_market,
                perp_market_info,
                perp_market_map,
                spot_market,
                spot_market_info,
                spot_market_map
            );

            let base = -10 * BASE_PRECISION_U64 as i64; // short 10
            let user = make_margin_user(10_000, base);

            // Buy 7 base → short 3
            let fill_delta = 7 * BASE_PRECISION_U64 as i64;
            let position_after = base + fill_delta;
            let position_before = base;

            assert!(position_after < 0 && position_after.abs() < position_before.abs());
            let taker_position_decreasing = position_after == 0
                || (position_after.signum() == position_before.signum()
                    && position_after.abs() < position_before.abs());
            assert!(
                taker_position_decreasing,
                "reducing short magnitude must be position-decreasing"
            );

            let user_after = apply_fill_to_user(&user, fill_delta);
            let margin_calc = calculate_margin_requirement_and_total_collateral_and_liability_info(
                &user_after,
                &perp_market_map,
                &spot_market_map,
                &mut oracle_map,
                MarginContext::standard(MarginRequirementType::Maintenance),
            )
            .unwrap();
            assert!(
                margin_calc.meets_margin_requirement(),
                "reduced short must pass maintenance"
            );
        }

        // -----------------------------------------------------------------------
        // Margin: maker margin filter (skip semantics)
        // -----------------------------------------------------------------------

        /// Maker margin filter: maker whose fill would close their position to flat
        /// gets Maintenance margin type via select_margin_type_for_perp_maker and passes.
        #[test]
        fn margin_maker_close_to_flat_passes_filter() {
            use crate::math::orders::select_margin_type_for_perp_maker;

            let slot = 0_u64;
            let oracle_key =
                Pubkey::from_str("J83w4HKfqxwcq3BEMMkPFSppX3gqekLyLJBexebFVkix").unwrap();
            let pyth_program = crate::ids::pyth_program::id();
            margin_test_setup!(
                slot,
                oracle_key,
                pyth_program,
                oracle_price,
                oracle_account_info,
                oracle_map,
                perp_market,
                perp_market_info,
                perp_market_map,
                spot_market,
                spot_market_info,
                spot_market_map
            );

            // Maker: long 10, $500 collateral (thin but above 5% maintenance for $1000 notional).
            // After fill (sell 10), position = 0 → Maintenance type.
            let base = 10 * BASE_PRECISION_U64 as i64;
            let mut maker = make_margin_user(500, base);
            // select_margin_type_for_perp_maker reads the user's current position.
            // In the filter, the user hasn't been mutated yet, so the "position_after_fill"
            // the function reads is actually the current position.
            // Simulate: the User data reflects *after* the fill has been applied (the way
            // fill_perp_order calls it). So we give it the post-fill state.
            let fill_delta = -base; // sell all 10
            let maker_after = apply_fill_to_user(&maker, fill_delta);

            let (margin_type, _) =
                select_margin_type_for_perp_maker(&maker_after, fill_delta, 0).unwrap();
            // position_after_fill = 0 → Maintenance
            assert_eq!(
                margin_type,
                MarginRequirementType::Maintenance,
                "closing to flat must use Maintenance"
            );

            let margin_calc = calculate_margin_requirement_and_total_collateral_and_liability_info(
                &maker_after,
                &perp_market_map,
                &spot_market_map,
                &mut oracle_map,
                MarginContext::standard(margin_type),
            )
            .unwrap();
            assert!(
                margin_calc.meets_margin_requirement(),
                "maker closing to flat with adequate collateral must pass"
            );
        }

        /// Maker margin filter: maker whose fill would increase risk (flat → long)
        /// gets Fill margin type via select_margin_type_for_perp_maker.
        /// With insufficient collateral, maker is filtered out (skip semantics).
        #[test]
        fn margin_maker_risk_increasing_fill_gets_fill_margin() {
            use crate::math::orders::select_margin_type_for_perp_maker;

            let slot = 0_u64;
            let oracle_key =
                Pubkey::from_str("J83w4HKfqxwcq3BEMMkPFSppX3gqekLyLJBexebFVkix").unwrap();
            let pyth_program = crate::ids::pyth_program::id();
            margin_test_setup!(
                slot,
                oracle_key,
                pyth_program,
                oracle_price,
                oracle_account_info,
                oracle_map,
                perp_market,
                perp_market_info,
                perp_market_map,
                spot_market,
                spot_market_info,
                spot_market_map
            );

            // Maker starts flat, gets filled into long 100 @ $100 = $10,000 notional.
            // Fill margin (10%) = $1,000.  Give them only $50 → must fail.
            let fill_delta = 100 * BASE_PRECISION_U64 as i64;
            let maker = make_margin_user(50, 0);
            let maker_after = apply_fill_to_user(&maker, fill_delta);

            let (margin_type, _) =
                select_margin_type_for_perp_maker(&maker_after, fill_delta, 0).unwrap();
            assert_eq!(
                margin_type,
                MarginRequirementType::Fill,
                "opening from flat must use Fill margin"
            );

            let margin_calc = calculate_margin_requirement_and_total_collateral_and_liability_info(
                &maker_after,
                &perp_market_map,
                &spot_market_map,
                &mut oracle_map,
                MarginContext::standard(margin_type),
            )
            .unwrap();
            assert!(
                !margin_calc.meets_margin_requirement(),
                "under-collateralized risk-increasing maker must fail margin"
            );
        }

        /// Two prop-AMM makers: one solvent, one insolvent. filter_prop_amm_makers_by_margin
        /// must skip the insolvent maker and produce correct taker deltas from the solvent one only.
        /// Verify the taker's cumulative delta is recalculated excluding the skipped maker.
        #[test]
        fn margin_maker_skip_adjusts_taker_deltas() {
            use crate::state::oracle_map::OracleMap;
            let slot = 0_u64;
            let program_id = drift_program_id();
            let oracle_key =
                Pubkey::from_str("J83w4HKfqxwcq3BEMMkPFSppX3gqekLyLJBexebFVkix").unwrap();
            let pyth_program = crate::ids::pyth_program::id();
            margin_test_setup!(
                slot,
                oracle_key,
                pyth_program,
                oracle_price,
                oracle_account_info,
                oracle_map,
                perp_market,
                perp_market_info,
                perp_market_map,
                spot_market,
                spot_market_info,
                spot_market_map
            );

            // Solvent maker: $100k collateral, no position
            let maker_a_key = Pubkey::new_unique();
            let mut maker_a = User {
                authority: maker_a_key,
                ..make_margin_user(100_000, 0)
            };
            crate::create_anchor_account_info!(maker_a, &maker_a_key, User, maker_a_info);

            // Insolvent maker: $10 collateral with massive short already
            let maker_b_key = Pubkey::new_unique();
            let mut insolvent_perp_positions = [PerpPosition::default(); 8];
            insolvent_perp_positions[0] = PerpPosition {
                market_index: 0,
                base_asset_amount: -500 * (BASE_PRECISION_U64 as i64),
                quote_asset_amount: 50000 * crate::math::constants::PRICE_PRECISION_I64,
                ..PerpPosition::default()
            };
            let mut insolvent_spot = [SpotPosition::default(); 8];
            insolvent_spot[0] = SpotPosition {
                market_index: 0,
                balance_type: SpotBalanceType::Deposit,
                scaled_balance: 10 * SPOT_BALANCE_PRECISION_U64,
                ..SpotPosition::default()
            };
            let mut maker_b = User {
                authority: maker_b_key,
                spot_positions: insolvent_spot,
                perp_positions: insolvent_perp_positions,
                ..User::default()
            };
            crate::create_anchor_account_info!(maker_b, &maker_b_key, User, maker_b_info);

            let midprice_prog_id = midprice_program_id();
            let mid_a_key = Pubkey::new_unique();
            let mid_b_key = Pubkey::new_unique();
            let mut mid_a_data = make_midprice_account_data(
                100 * PRICE_PRECISION_U64,
                50 * BASE_PRECISION_U64,
                &maker_a_key,
            );
            let mut mid_b_data = make_midprice_account_data(
                100 * PRICE_PRECISION_U64,
                50 * BASE_PRECISION_U64,
                &maker_b_key,
            );
            let mut mid_a_lamps = 0u64;
            let mut mid_b_lamps = 0u64;
            let mid_a_info = create_account_info(
                &mid_a_key,
                true,
                &mut mid_a_lamps,
                &mut mid_a_data[..],
                &midprice_prog_id,
            );
            let mid_b_info = create_account_info(
                &mid_b_key,
                true,
                &mut mid_b_lamps,
                &mut mid_b_data[..],
                &midprice_prog_id,
            );
            let mut prog_lamps = 0u64;
            let mut prog_data = [0u8; 0];
            let program_info = create_executable_program_account_info(
                &midprice_prog_id,
                &mut prog_lamps,
                &mut prog_data[..],
            );
            let (matcher_pda, _) = prop_amm_matcher_pda(&program_id);
            let mut matcher_lamps = 0u64;
            let mut matcher_data = [0u8; 0];
            let matcher_info = create_account_info(
                &matcher_pda,
                true,
                &mut matcher_lamps,
                &mut matcher_data[..],
                &program_id,
            );

            let remaining_accounts: Vec<AccountInfo> = vec![
                program_info,
                matcher_info,
                mid_a_info,
                maker_a_info,
                mid_b_info,
                maker_b_info,
            ];
            let amm_views = vec![
                AmmView {
                    key: mid_a_key,
                    mid_price: 100 * PRICE_PRECISION_U64,
                    sequence_number_snapshot: 0,
                    maker_user_remaining_index: 3,
                    midprice_remaining_index: 2,
                },
                AmmView {
                    key: mid_b_key,
                    mid_price: 100 * PRICE_PRECISION_U64,
                    sequence_number_snapshot: 0,
                    maker_user_remaining_index: 5,
                    midprice_remaining_index: 4,
                },
            ];

            // Both makers sell 20 base each
            let base_delta = -20_i64 * (BASE_PRECISION_U64 as i64);
            let quote_delta = 20 * 100 * crate::math::constants::PRICE_PRECISION_I64;
            let mut maker_deltas = BTreeMap::new();
            maker_deltas.insert(maker_a_key, (base_delta, quote_delta));
            maker_deltas.insert(maker_b_key, (base_delta, quote_delta));

            // External fills: one for each maker
            let external_fills = vec![
                PendingExternalFill {
                    midprice_remaining_index: 2,
                    maker_user_remaining_index: 3, // maker_a
                    sequence_number_snapshot: 0,
                    fill: ExternalFill {
                        abs_index: 0,
                        is_ask: true,
                        fill_size: 20 * BASE_PRECISION_U64,
                    },
                },
                PendingExternalFill {
                    midprice_remaining_index: 4,
                    maker_user_remaining_index: 5, // maker_b (insolvent)
                    sequence_number_snapshot: 0,
                    fill: ExternalFill {
                        abs_index: 0,
                        is_ask: true,
                        fill_size: 20 * BASE_PRECISION_U64,
                    },
                },
            ];

            let (filtered, filtered_fills, taker_base, taker_quote, total_quote) =
                filter_prop_amm_makers_by_margin(
                    &maker_deltas,
                    &external_fills,
                    &amm_views,
                    &remaining_accounts,
                    &perp_market_map,
                    &spot_market_map,
                    &mut oracle_map,
                    0,
                    0,
                )
                .unwrap();

            // Only maker A survives
            assert_eq!(filtered.len(), 1);
            assert!(filtered.contains_key(&maker_a_key));
            assert!(!filtered.contains_key(&maker_b_key));

            // External fills for insolvent maker B must also be removed
            assert_eq!(
                filtered_fills.len(),
                1,
                "only solvent maker's fills should survive"
            );
            assert_eq!(
                filtered_fills[0].maker_user_remaining_index, 3,
                "surviving fill must belong to maker_a"
            );

            // Taker deltas reflect only maker A's contribution (mirror of maker A's delta)
            assert_eq!(
                taker_base, -base_delta,
                "taker base = negative of solvent maker's base"
            );
            assert_eq!(
                taker_quote, -quote_delta,
                "taker quote = negative of solvent maker's quote"
            );
            assert_eq!(total_quote, quote_delta.unsigned_abs());
        }

        /// Both makers are insolvent → filter removes both → taker deltas are zero.
        /// Transaction should still succeed (no fills applied, no margin breach).
        #[test]
        fn margin_all_makers_insolvent_zero_taker_delta() {
            use crate::state::oracle_map::OracleMap;
            let slot = 0_u64;
            let program_id = drift_program_id();
            let oracle_key =
                Pubkey::from_str("J83w4HKfqxwcq3BEMMkPFSppX3gqekLyLJBexebFVkix").unwrap();
            let pyth_program = crate::ids::pyth_program::id();
            margin_test_setup!(
                slot,
                oracle_key,
                pyth_program,
                oracle_price,
                oracle_account_info,
                oracle_map,
                perp_market,
                perp_market_info,
                perp_market_map,
                spot_market,
                spot_market_info,
                spot_market_map
            );

            // Both makers: $5 collateral, massive existing short
            let make_insolvent_maker = |key: Pubkey| -> User {
                let mut perp_positions = [PerpPosition::default(); 8];
                perp_positions[0] = PerpPosition {
                    market_index: 0,
                    base_asset_amount: -500 * (BASE_PRECISION_U64 as i64),
                    quote_asset_amount: 50000 * crate::math::constants::PRICE_PRECISION_I64,
                    ..PerpPosition::default()
                };
                let mut spot_positions = [SpotPosition::default(); 8];
                spot_positions[0] = SpotPosition {
                    market_index: 0,
                    balance_type: SpotBalanceType::Deposit,
                    scaled_balance: 5 * SPOT_BALANCE_PRECISION_U64,
                    ..SpotPosition::default()
                };
                User {
                    authority: key,
                    spot_positions,
                    perp_positions,
                    ..User::default()
                }
            };

            let maker_a_key = Pubkey::new_unique();
            let maker_b_key = Pubkey::new_unique();
            let mut maker_a = make_insolvent_maker(maker_a_key);
            let mut maker_b = make_insolvent_maker(maker_b_key);
            crate::create_anchor_account_info!(maker_a, &maker_a_key, User, maker_a_info);
            crate::create_anchor_account_info!(maker_b, &maker_b_key, User, maker_b_info);

            let midprice_prog_id = midprice_program_id();
            let mid_a_key = Pubkey::new_unique();
            let mid_b_key = Pubkey::new_unique();
            let mut mid_a_data = make_midprice_account_data(
                100 * PRICE_PRECISION_U64,
                50 * BASE_PRECISION_U64,
                &maker_a_key,
            );
            let mut mid_b_data = make_midprice_account_data(
                100 * PRICE_PRECISION_U64,
                50 * BASE_PRECISION_U64,
                &maker_b_key,
            );
            let mut mid_a_lamps = 0u64;
            let mut mid_b_lamps = 0u64;
            let mid_a_info = create_account_info(
                &mid_a_key,
                true,
                &mut mid_a_lamps,
                &mut mid_a_data[..],
                &midprice_prog_id,
            );
            let mid_b_info = create_account_info(
                &mid_b_key,
                true,
                &mut mid_b_lamps,
                &mut mid_b_data[..],
                &midprice_prog_id,
            );
            let mut prog_lamps = 0u64;
            let mut prog_data = [0u8; 0];
            let program_info = create_executable_program_account_info(
                &midprice_prog_id,
                &mut prog_lamps,
                &mut prog_data[..],
            );
            let (matcher_pda, _) = prop_amm_matcher_pda(&program_id);
            let mut matcher_lamps = 0u64;
            let mut matcher_data = [0u8; 0];
            let matcher_info = create_account_info(
                &matcher_pda,
                true,
                &mut matcher_lamps,
                &mut matcher_data[..],
                &program_id,
            );

            let remaining_accounts: Vec<AccountInfo> = vec![
                program_info,
                matcher_info,
                mid_a_info,
                maker_a_info,
                mid_b_info,
                maker_b_info,
            ];
            let amm_views = vec![
                AmmView {
                    key: mid_a_key,
                    mid_price: 100 * PRICE_PRECISION_U64,
                    sequence_number_snapshot: 0,
                    maker_user_remaining_index: 3,
                    midprice_remaining_index: 2,
                },
                AmmView {
                    key: mid_b_key,
                    mid_price: 100 * PRICE_PRECISION_U64,
                    sequence_number_snapshot: 0,
                    maker_user_remaining_index: 5,
                    midprice_remaining_index: 4,
                },
            ];

            let base_delta = -30_i64 * (BASE_PRECISION_U64 as i64);
            let quote_delta = 30 * 100 * crate::math::constants::PRICE_PRECISION_I64;
            let mut maker_deltas = BTreeMap::new();
            maker_deltas.insert(maker_a_key, (base_delta, quote_delta));
            maker_deltas.insert(maker_b_key, (base_delta, quote_delta));

            let external_fills = vec![
                PendingExternalFill {
                    midprice_remaining_index: 2,
                    maker_user_remaining_index: 3,
                    sequence_number_snapshot: 0,
                    fill: ExternalFill {
                        abs_index: 0,
                        is_ask: true,
                        fill_size: 30 * BASE_PRECISION_U64,
                    },
                },
                PendingExternalFill {
                    midprice_remaining_index: 4,
                    maker_user_remaining_index: 5,
                    sequence_number_snapshot: 0,
                    fill: ExternalFill {
                        abs_index: 0,
                        is_ask: true,
                        fill_size: 30 * BASE_PRECISION_U64,
                    },
                },
            ];

            let (filtered, filtered_fills, taker_base, taker_quote, total_quote) =
                filter_prop_amm_makers_by_margin(
                    &maker_deltas,
                    &external_fills,
                    &amm_views,
                    &remaining_accounts,
                    &perp_market_map,
                    &spot_market_map,
                    &mut oracle_map,
                    0,
                    0,
                )
                .unwrap();

            assert_eq!(filtered.len(), 0, "both insolvent makers must be filtered");
            assert_eq!(
                filtered_fills.len(),
                0,
                "all external fills must be removed when all makers insolvent"
            );
            assert_eq!(
                taker_base, 0,
                "taker base delta must be zero when all makers skipped"
            );
            assert_eq!(
                taker_quote, 0,
                "taker quote delta must be zero when all makers skipped"
            );
            assert_eq!(total_quote, 0, "total quote volume must be zero");
        }

        /// Maker's fill reduces their existing position (long 30 → long 15 via selling 15).
        /// select_margin_type_for_perp_maker should return Maintenance.
        #[test]
        fn margin_maker_position_reducing_uses_maintenance() {
            use crate::math::orders::select_margin_type_for_perp_maker;

            // Maker starts long 30, fill sells 15 → long 15 (same sign, smaller magnitude).
            let base = 30 * BASE_PRECISION_U64 as i64;
            let fill_delta = -15 * BASE_PRECISION_U64 as i64;
            let maker = make_margin_user(10_000, base);
            let maker_after = apply_fill_to_user(&maker, fill_delta);

            let (margin_type, _) =
                select_margin_type_for_perp_maker(&maker_after, fill_delta, 0).unwrap();
            assert_eq!(
                margin_type,
                MarginRequirementType::Maintenance,
                "position-reducing maker fill must use Maintenance"
            );
        }

        /// Maker's fill increases their existing position (long 10 → long 25 via buying 15).
        /// select_margin_type_for_perp_maker should return Fill.
        #[test]
        fn margin_maker_position_increasing_uses_fill() {
            use crate::math::orders::select_margin_type_for_perp_maker;

            // Maker starts long 10, fill buys 15 → long 25 (same sign, larger magnitude).
            let base = 10 * BASE_PRECISION_U64 as i64;
            let fill_delta = 15 * BASE_PRECISION_U64 as i64;
            let maker = make_margin_user(10_000, base);
            let maker_after = apply_fill_to_user(&maker, fill_delta);

            let (margin_type, risk_increasing) =
                select_margin_type_for_perp_maker(&maker_after, fill_delta, 0).unwrap();
            assert_eq!(
                margin_type,
                MarginRequirementType::Fill,
                "position-increasing maker fill must use Fill"
            );
            assert!(
                risk_increasing,
                "increasing position must flag risk_increasing"
            );
        }

        /// Maker with zero-delta fill (no actual fill) is kept by the margin filter regardless of balance.
        #[test]
        fn margin_maker_zero_delta_always_passes() {
            use crate::state::oracle_map::OracleMap;
            let slot = 0_u64;
            let program_id = drift_program_id();
            let oracle_key =
                Pubkey::from_str("J83w4HKfqxwcq3BEMMkPFSppX3gqekLyLJBexebFVkix").unwrap();
            let pyth_program = crate::ids::pyth_program::id();
            margin_test_setup!(
                slot,
                oracle_key,
                pyth_program,
                oracle_price,
                oracle_account_info,
                oracle_map,
                perp_market,
                perp_market_info,
                perp_market_map,
                spot_market,
                spot_market_info,
                spot_market_map
            );

            // Maker: insolvent (huge short, tiny collateral) but delta = 0 → passes.
            let maker_key = Pubkey::new_unique();
            let mut perp_positions = [PerpPosition::default(); 8];
            perp_positions[0] = PerpPosition {
                market_index: 0,
                base_asset_amount: -500 * (BASE_PRECISION_U64 as i64),
                quote_asset_amount: 50000 * crate::math::constants::PRICE_PRECISION_I64,
                ..PerpPosition::default()
            };
            let mut spot_positions = [SpotPosition::default(); 8];
            spot_positions[0] = SpotPosition {
                market_index: 0,
                balance_type: SpotBalanceType::Deposit,
                scaled_balance: 1 * SPOT_BALANCE_PRECISION_U64,
                ..SpotPosition::default()
            };
            let mut maker = User {
                authority: maker_key,
                spot_positions,
                perp_positions,
                ..User::default()
            };
            crate::create_anchor_account_info!(maker, &maker_key, User, maker_info);

            let midprice_prog_id = midprice_program_id();
            let mid_key = Pubkey::new_unique();
            let mut mid_data = make_midprice_account_data(
                100 * PRICE_PRECISION_U64,
                50 * BASE_PRECISION_U64,
                &maker_key,
            );
            let mut mid_lamps = 0u64;
            let mid_info = create_account_info(
                &mid_key,
                true,
                &mut mid_lamps,
                &mut mid_data[..],
                &midprice_prog_id,
            );
            let mut prog_lamps = 0u64;
            let mut prog_data_buf = [0u8; 0];
            let program_info = create_executable_program_account_info(
                &midprice_prog_id,
                &mut prog_lamps,
                &mut prog_data_buf[..],
            );
            let (matcher_pda, _) = prop_amm_matcher_pda(&program_id);
            let mut matcher_lamps = 0u64;
            let mut matcher_data = [0u8; 0];
            let matcher_info = create_account_info(
                &matcher_pda,
                true,
                &mut matcher_lamps,
                &mut matcher_data[..],
                &program_id,
            );

            let remaining_accounts: Vec<AccountInfo> =
                vec![program_info, matcher_info, mid_info, maker_info];
            let amm_views = vec![AmmView {
                key: mid_key,
                mid_price: 100 * PRICE_PRECISION_U64,
                sequence_number_snapshot: 0,
                maker_user_remaining_index: 3,
                midprice_remaining_index: 2,
            }];

            // Delta = 0 for this maker
            let mut maker_deltas = BTreeMap::new();
            maker_deltas.insert(maker_key, (0i64, 0i64));

            let (filtered, _, _, _, _) = filter_prop_amm_makers_by_margin(
                &maker_deltas,
                &[],
                &amm_views,
                &remaining_accounts,
                &perp_market_map,
                &spot_market_map,
                &mut oracle_map,
                0,
                0,
            )
            .unwrap();

            assert!(
                filtered.contains_key(&maker_key),
                "maker with zero delta must always pass margin filter"
            );
        }

        // -----------------------------------------------------------------------
        // Additional coverage: partial fills, AMM zero-fill fallthrough,
        // taker position_before overflow
        // -----------------------------------------------------------------------

        /// Taker wants more than total available liquidity across all sources.
        /// Matching should fill only what's available and stop gracefully.
        #[test]
        fn partial_fill_taker_size_exceeds_available_liquidity() {
            let program_id = drift_program_id();
            let midprice_key = Pubkey::new_unique();
            let (maker_authority, maker_user_key) = derive_maker_user_pda();
            let mut maker_user = User::default();
            maker_user.authority = maker_authority;
            maker_user.sub_account_id = 0;
            crate::create_anchor_account_info!(maker_user, &maker_user_key, User, maker_user_info);

            // PropAMM book: only 5 base available
            let available = 5 * BASE_PRECISION_U64;
            let data =
                make_midprice_account_data(100 * PRICE_PRECISION_U64, available, &maker_authority);
            let midprice_prog_id = midprice_program_id();
            let mut midprice_lamports = 0u64;
            let mut midprice_data = data;
            let midprice_info = create_account_info(
                &midprice_key,
                true,
                &mut midprice_lamports,
                &mut midprice_data[..],
                &midprice_prog_id,
            );
            let mut prog_lamps = 0u64;
            let mut prog_data = [0u8; 0];
            let program_info = create_executable_program_account_info(
                &midprice_prog_id,
                &mut prog_lamps,
                &mut prog_data[..],
            );
            let (global_matcher_pda, _) = prop_amm_matcher_pda(&program_id);
            let mut gm_lamps = 0u64;
            let mut gm_data = [0u8; 0];
            let gm_info = create_account_info(
                &global_matcher_pda,
                true,
                &mut gm_lamps,
                &mut gm_data[..],
                &program_id,
            );

            let remaining: Vec<AccountInfo> =
                vec![program_info, gm_info, midprice_info, maker_user_info];
            let slice = remaining.as_slice();
            let (_, amm_views, _) =
                parse_amm_views(slice, 1, &program_id, 100, None, None).unwrap();

            // DLOB maker with 3 base
            let dlob = vec![DlobMakerView {
                maker_key: Pubkey::new_unique(),
                order_index: 0,
                price: 105 * PRICE_PRECISION_U64,
                size: 3 * BASE_PRECISION_U64,
                remaining_account_index: 99,
                maker_stats_remaining_index: 0,
            }];

            // Taker wants 100 base — far more than available 5 + 3 = 8
            let taker_size = 100 * BASE_PRECISION_U64;
            let result = run_unified_matching(
                &amm_views,
                &dlob,
                slice,
                PositionDirection::Long,
                110 * PRICE_PRECISION_U64,
                taker_size,
            )
            .unwrap();

            let prop_filled: u64 = result.external_fills.iter().map(|f| f.fill.fill_size).sum();
            let dlob_filled: u64 = result.dlob_fills.iter().map(|f| f.base_asset_amount).sum();
            let total = prop_filled + dlob_filled;

            assert_eq!(prop_filled, available, "PropAMM fills all available");
            assert_eq!(
                dlob_filled,
                3 * BASE_PRECISION_U64,
                "DLOB fills all available"
            );
            assert_eq!(
                total,
                8 * BASE_PRECISION_U64,
                "total filled = all available liquidity"
            );
            assert!(
                total < taker_size,
                "partial fill: less than taker requested"
            );
        }

        /// Taker margin check: position_before overflow returns MathError instead of silently clamping.
        /// If total_taker_base_delta is extreme, checked_sub on position_after must propagate an error.
        #[test]
        fn taker_position_before_overflow_returns_error() {
            // position_after.checked_sub(total_taker_base_delta) must fail for extreme deltas.
            // This tests the logic at line ~1634:
            //   let position_before = position_after.checked_sub(total_taker_base_delta).ok_or(MathError)?;
            let position_after: i64 = i64::MAX;
            let total_taker_base_delta: i64 = i64::MIN; // MAX - MIN would overflow

            let result = position_after.checked_sub(total_taker_base_delta);
            assert!(
                result.is_none(),
                "i64::MAX.checked_sub(i64::MIN) must overflow (returns None)"
            );

            // Conversely: if we used saturating_sub (the old code path), it would silently clamp.
            let wrong_result = position_after.saturating_sub(total_taker_base_delta);
            assert_eq!(
                wrong_result,
                i64::MAX,
                "saturating_sub would clamp to MAX, giving wrong position_before"
            );
        }

        /// Taker wants to buy but all sources are priced above the limit.
        /// Nothing should fill and result should be empty.
        #[test]
        fn all_sources_above_limit_no_fill() {
            let program_id = drift_program_id();
            let midprice_key = Pubkey::new_unique();
            let (maker_authority, maker_user_key) = derive_maker_user_pda();
            let mut maker_user = User::default();
            maker_user.authority = maker_authority;
            maker_user.sub_account_id = 0;
            crate::create_anchor_account_info!(maker_user, &maker_user_key, User, maker_user_info);

            // PropAMM book: mid=200, ask offset=1, effective ask ~201
            let data = make_midprice_account_data(
                200 * PRICE_PRECISION_U64,
                50 * BASE_PRECISION_U64,
                &maker_authority,
            );
            let midprice_prog_id = midprice_program_id();
            let mut midprice_lamports = 0u64;
            let mut midprice_data = data;
            let midprice_info = create_account_info(
                &midprice_key,
                true,
                &mut midprice_lamports,
                &mut midprice_data[..],
                &midprice_prog_id,
            );
            let mut prog_lamps = 0u64;
            let mut prog_data = [0u8; 0];
            let program_info = create_executable_program_account_info(
                &midprice_prog_id,
                &mut prog_lamps,
                &mut prog_data[..],
            );
            let (global_matcher_pda, _) = prop_amm_matcher_pda(&program_id);
            let mut gm_lamps = 0u64;
            let mut gm_data = [0u8; 0];
            let gm_info = create_account_info(
                &global_matcher_pda,
                true,
                &mut gm_lamps,
                &mut gm_data[..],
                &program_id,
            );
            let remaining: Vec<AccountInfo> =
                vec![program_info, gm_info, midprice_info, maker_user_info];
            let slice = remaining.as_slice();
            let (_, amm_views, _) =
                parse_amm_views(slice, 1, &program_id, 100, None, None).unwrap();

            // DLOB at 150 — all above limit of 100
            let dlob = vec![DlobMakerView {
                maker_key: Pubkey::new_unique(),
                order_index: 0,
                price: 150 * PRICE_PRECISION_U64,
                size: 10 * BASE_PRECISION_U64,
                remaining_account_index: 99,
                maker_stats_remaining_index: 0,
            }];

            let result = run_unified_matching(
                &amm_views,
                &dlob,
                slice,
                PositionDirection::Long,
                100 * PRICE_PRECISION_U64, // limit below all sources
                10 * BASE_PRECISION_U64,
            )
            .unwrap();

            assert!(result.external_fills.is_empty(), "no PropAMM fills");
            assert!(result.dlob_fills.is_empty(), "no DLOB fills");
            assert_eq!(result.taker_base_delta, 0);
            assert_eq!(result.taker_quote_delta, 0);
        }

        /// Short-side partial fill: taker sells into bids.
        /// PropAMM book has limited bid liquidity; taker wants to sell more than available.
        #[test]
        fn partial_fill_short_side() {
            let program_id = drift_program_id();
            let midprice_key = Pubkey::new_unique();
            let (maker_authority, maker_user_key) = derive_maker_user_pda();
            let mut maker_user = User::default();
            maker_user.authority = maker_authority;
            maker_user.sub_account_id = 0;
            crate::create_anchor_account_info!(maker_user, &maker_user_key, User, maker_user_info);

            let mid_price = 100 * PRICE_PRECISION_U64;
            let bid_size = 7 * BASE_PRECISION_U64;
            let mut data = make_bid_midprice_account_data(mid_price, bid_size, &maker_authority, 0);

            let midprice_prog_id = midprice_program_id();
            let mut midprice_lamports = 0u64;
            let midprice_info = create_account_info(
                &midprice_key,
                true,
                &mut midprice_lamports,
                &mut data[..],
                &midprice_prog_id,
            );
            let mut prog_lamps = 0u64;
            let mut prog_data = [0u8; 0];
            let program_info = create_executable_program_account_info(
                &midprice_prog_id,
                &mut prog_lamps,
                &mut prog_data[..],
            );
            let (global_matcher_pda, _) = prop_amm_matcher_pda(&program_id);
            let mut gm_lamps = 0u64;
            let mut gm_data = [0u8; 0];
            let gm_info = create_account_info(
                &global_matcher_pda,
                true,
                &mut gm_lamps,
                &mut gm_data[..],
                &program_id,
            );

            let remaining: Vec<AccountInfo> =
                vec![program_info, gm_info, midprice_info, maker_user_info];
            let slice = remaining.as_slice();
            let (_, amm_views, _) =
                parse_amm_views(slice, 1, &program_id, 100, None, None).unwrap();

            // Taker sells 20, only 7 available
            let result = run_unified_matching(
                &amm_views,
                &[],
                slice,
                PositionDirection::Short,
                90 * PRICE_PRECISION_U64, // limit below mid
                20 * BASE_PRECISION_U64,
            )
            .unwrap();

            let filled: u64 = result.external_fills.iter().map(|f| f.fill.fill_size).sum();
            assert_eq!(filled, bid_size, "should fill all available bid liquidity");
            assert!(filled < 20 * BASE_PRECISION_U64, "partial fill");
            // Taker sold base → negative base delta
            assert!(
                result.taker_base_delta < 0,
                "taker base delta should be negative (sold)"
            );
        }

        /// Two PropAMM books with unequal sizes at the same price: pro-rata allocates proportionally.
        /// Verifies that remainder distribution doesn't over-allocate.
        #[test]
        fn pro_rata_unequal_sizes_no_over_allocation() {
            let program_id = drift_program_id();
            let midprice_prog_id = midprice_program_id();

            // Maker A: 3 base available
            let (auth_a, maker_key_a) = derive_maker_user_pda();
            let mut maker_a = User::default();
            maker_a.authority = auth_a;
            maker_a.sub_account_id = 0;
            crate::create_anchor_account_info!(maker_a, &maker_key_a, User, maker_a_info);
            let mut data_a = make_midprice_account_data(
                100 * PRICE_PRECISION_U64,
                3 * BASE_PRECISION_U64,
                &auth_a,
            );
            let mid_key_a = Pubkey::new_unique();
            let mut lamps_a = 0u64;
            let mid_a_info = create_account_info(
                &mid_key_a,
                true,
                &mut lamps_a,
                &mut data_a[..],
                &midprice_prog_id,
            );

            // Maker B: 97 base available (same price level)
            let (auth_b, maker_key_b) = derive_maker_user_pda();
            let mut maker_b = User::default();
            maker_b.authority = auth_b;
            maker_b.sub_account_id = 0;
            crate::create_anchor_account_info!(maker_b, &maker_key_b, User, maker_b_info);
            let mut data_b = make_midprice_account_data(
                100 * PRICE_PRECISION_U64,
                97 * BASE_PRECISION_U64,
                &auth_b,
            );
            let mid_key_b = Pubkey::new_unique();
            let mut lamps_b = 0u64;
            let mid_b_info = create_account_info(
                &mid_key_b,
                true,
                &mut lamps_b,
                &mut data_b[..],
                &midprice_prog_id,
            );

            let mut prog_lamps = 0u64;
            let mut prog_data = [0u8; 0];
            let program_info = create_executable_program_account_info(
                &midprice_prog_id,
                &mut prog_lamps,
                &mut prog_data[..],
            );
            let (global_matcher_pda, _) = prop_amm_matcher_pda(&program_id);
            let mut gm_lamps = 0u64;
            let mut gm_data = [0u8; 0];
            let gm_info = create_account_info(
                &global_matcher_pda,
                true,
                &mut gm_lamps,
                &mut gm_data[..],
                &program_id,
            );

            let remaining: Vec<AccountInfo> = vec![
                program_info,
                gm_info,
                mid_a_info,
                maker_a_info,
                mid_b_info,
                maker_b_info,
            ];
            let slice = remaining.as_slice();
            let (_, amm_views, _) =
                parse_amm_views(slice, 1, &program_id, 100, None, None).unwrap();
            assert_eq!(amm_views.len(), 2);

            // Taker wants 10 base; available = 3 + 97 = 100, fill = 10
            // Pro-rata: A gets 10*3/100 = 0.3 → 0, B gets 10*97/100 = 9.7 → 9, remainder 1 goes to A
            let result = run_unified_matching(
                &amm_views,
                &[],
                slice,
                PositionDirection::Long,
                110 * PRICE_PRECISION_U64,
                10 * BASE_PRECISION_U64,
            )
            .unwrap();

            let total: u64 = result.external_fills.iter().map(|f| f.fill.fill_size).sum();
            assert_eq!(
                total,
                10 * BASE_PRECISION_U64,
                "total must equal taker size"
            );

            // Each maker's fill must not exceed their available size
            for fill in &result.external_fills {
                let maker_idx = fill.midprice_remaining_index;
                if maker_idx == 2 {
                    assert!(
                        fill.fill.fill_size <= 3 * BASE_PRECISION_U64,
                        "maker A fill must not exceed 3"
                    );
                } else {
                    assert!(
                        fill.fill.fill_size <= 97 * BASE_PRECISION_U64,
                        "maker B fill must not exceed 97"
                    );
                }
            }
        }

        // -----------------------------------------------------------------------
        // Correctness fix verification tests
        // -----------------------------------------------------------------------

        /// Maker with 0 position and insufficient collateral is filtered out
        /// when the fill would exceed margin (simulated post-fill position).
        #[test]
        fn margin_simulation_filters_zero_position_maker() {
            use crate::state::oracle_map::OracleMap;
            let slot = 0_u64;
            let program_id = drift_program_id();
            let oracle_key =
                Pubkey::from_str("J83w4HKfqxwcq3BEMMkPFSppX3gqekLyLJBexebFVkix").unwrap();
            let pyth_program = crate::ids::pyth_program::id();
            let mut oracle_price = get_pyth_price(100, 6);
            crate::create_account_info!(
                oracle_price,
                &oracle_key,
                &pyth_program,
                oracle_account_info
            );
            let mut oracle_map = OracleMap::load_one(&oracle_account_info, slot, None).unwrap();

            let mut perp_market = PerpMarket {
                market_index: 0,
                amm: AMM {
                    base_asset_reserve: 100 * AMM_RESERVE_PRECISION,
                    quote_asset_reserve: 100 * AMM_RESERVE_PRECISION,
                    oracle: oracle_key,
                    order_tick_size: 1,
                    historical_oracle_data: HistoricalOracleData {
                        last_oracle_price: 100 * crate::math::constants::PRICE_PRECISION_I64,
                        last_oracle_price_twap: 100 * crate::math::constants::PRICE_PRECISION_I64,
                        ..HistoricalOracleData::default()
                    },
                    ..AMM::default()
                },
                margin_ratio_initial: 2000,
                margin_ratio_maintenance: 1000,
                status: MarketStatus::Active,
                ..PerpMarket::default_test()
            };
            perp_market.amm.max_base_asset_reserve = u64::MAX as u128;
            perp_market.amm.min_base_asset_reserve = 0;
            crate::create_anchor_account_info!(perp_market, PerpMarket, perp_market_info);
            let perp_market_map = PerpMarketMap::load_one(&perp_market_info, true).unwrap();

            let mut spot_market = SpotMarket {
                market_index: 0,
                oracle_source: OracleSource::QuoteAsset,
                cumulative_deposit_interest: SPOT_CUMULATIVE_INTEREST_PRECISION,
                decimals: 6,
                initial_asset_weight: SPOT_WEIGHT_PRECISION,
                maintenance_asset_weight: SPOT_WEIGHT_PRECISION,
                historical_oracle_data: HistoricalOracleData::default_quote_oracle(),
                ..SpotMarket::default()
            };
            crate::create_anchor_account_info!(spot_market, SpotMarket, spot_market_info);
            let spot_market_map = SpotMarketMap::load_one(&spot_market_info, true).unwrap();

            // Maker A: $500 USDC — too small for the fill.
            let maker_key_a = Pubkey::new_unique();
            let mut spot_pos_a = [SpotPosition::default(); 8];
            spot_pos_a[0] = SpotPosition {
                market_index: 0,
                balance_type: SpotBalanceType::Deposit,
                scaled_balance: 500 * SPOT_BALANCE_PRECISION_U64,
                ..SpotPosition::default()
            };
            let mut maker_a = User {
                authority: maker_key_a,
                spot_positions: spot_pos_a,
                ..User::default()
            };
            crate::create_anchor_account_info!(maker_a, &maker_key_a, User, maker_a_info);

            // Maker B: $50,000 USDC — plenty for the fill.
            let maker_key_b = Pubkey::new_unique();
            let mut spot_pos_b = [SpotPosition::default(); 8];
            spot_pos_b[0] = SpotPosition {
                market_index: 0,
                balance_type: SpotBalanceType::Deposit,
                scaled_balance: 50_000 * SPOT_BALANCE_PRECISION_U64,
                ..SpotPosition::default()
            };
            let mut maker_b = User {
                authority: maker_key_b,
                spot_positions: spot_pos_b,
                ..User::default()
            };
            crate::create_anchor_account_info!(maker_b, &maker_key_b, User, maker_b_info);

            let midprice_prog_id = midprice_program_id();
            let mid_key_a = Pubkey::new_unique();
            let mid_key_b = Pubkey::new_unique();
            let mut mid_data_a = make_midprice_account_data(
                100 * PRICE_PRECISION_U64,
                50 * BASE_PRECISION_U64,
                &maker_key_a,
            );
            let mut mid_data_b = make_midprice_account_data(
                100 * PRICE_PRECISION_U64,
                50 * BASE_PRECISION_U64,
                &maker_key_b,
            );
            let mut mid_lamports_a = 0u64;
            let mut mid_lamports_b = 0u64;
            let mid_info_a = create_account_info(
                &mid_key_a,
                true,
                &mut mid_lamports_a,
                &mut mid_data_a[..],
                &midprice_prog_id,
            );
            let mid_info_b = create_account_info(
                &mid_key_b,
                true,
                &mut mid_lamports_b,
                &mut mid_data_b[..],
                &midprice_prog_id,
            );
            let mut prog_lamps = 0u64;
            let mut prog_data = [0u8; 0];
            let program_info = create_executable_program_account_info(
                &midprice_prog_id,
                &mut prog_lamps,
                &mut prog_data[..],
            );
            let (matcher_pda, _) = prop_amm_matcher_pda(&program_id);
            let mut matcher_lamports = 0u64;
            let mut matcher_data = [0u8; 0];
            let matcher_info = create_account_info(
                &matcher_pda,
                true,
                &mut matcher_lamports,
                &mut matcher_data[..],
                &program_id,
            );

            let remaining_accounts: Vec<AccountInfo> = vec![
                program_info,
                matcher_info,
                mid_info_a,
                maker_a_info,
                mid_info_b,
                maker_b_info,
            ];

            let amm_views = vec![
                AmmView {
                    key: mid_key_a,
                    mid_price: 100 * PRICE_PRECISION_U64,
                    sequence_number_snapshot: 0,
                    maker_user_remaining_index: 3,
                    midprice_remaining_index: 2,
                },
                AmmView {
                    key: mid_key_b,
                    mid_price: 100 * PRICE_PRECISION_U64,
                    sequence_number_snapshot: 0,
                    maker_user_remaining_index: 5,
                    midprice_remaining_index: 4,
                },
            ];

            // Fill: 50 BASE each at $100 = $5,000 notional.
            // 20% margin → $1,000 required. Maker A ($500) fails; Maker B ($50,000) passes.
            let base_delta = 50_i64 * (BASE_PRECISION_U64 as i64);
            let quote_delta = -(50 * 100 * crate::math::constants::PRICE_PRECISION_I64);
            let mut maker_deltas = BTreeMap::new();
            maker_deltas.insert(maker_key_a, (base_delta, quote_delta));
            maker_deltas.insert(maker_key_b, (base_delta, quote_delta));

            let (filtered_deltas, _, _, _, _) = filter_prop_amm_makers_by_margin(
                &maker_deltas,
                &[],
                &amm_views,
                &remaining_accounts,
                &perp_market_map,
                &spot_market_map,
                &mut oracle_map,
                0,
                0,
            )
            .unwrap();

            assert!(
                !filtered_deltas.contains_key(&maker_key_a),
                "maker A ($500 collateral) should be filtered out"
            );
            assert!(
                filtered_deltas.contains_key(&maker_key_b),
                "maker B ($50,000 collateral) should pass"
            );
        }

        /// Maker with sufficient collateral passes the simulated margin check.
        #[test]
        fn margin_simulation_passes_solvent_maker() {
            use crate::state::oracle_map::OracleMap;
            let slot = 0_u64;
            let program_id = drift_program_id();
            let oracle_key =
                Pubkey::from_str("J83w4HKfqxwcq3BEMMkPFSppX3gqekLyLJBexebFVkix").unwrap();
            let pyth_program = crate::ids::pyth_program::id();
            let mut oracle_price = get_pyth_price(100, 6);
            crate::create_account_info!(
                oracle_price,
                &oracle_key,
                &pyth_program,
                oracle_account_info
            );
            let mut oracle_map = OracleMap::load_one(&oracle_account_info, slot, None).unwrap();

            let mut perp_market = PerpMarket {
                market_index: 0,
                amm: AMM {
                    base_asset_reserve: 100 * AMM_RESERVE_PRECISION,
                    quote_asset_reserve: 100 * AMM_RESERVE_PRECISION,
                    oracle: oracle_key,
                    order_tick_size: 1,
                    historical_oracle_data: HistoricalOracleData {
                        last_oracle_price: 100 * crate::math::constants::PRICE_PRECISION_I64,
                        last_oracle_price_twap: 100 * crate::math::constants::PRICE_PRECISION_I64,
                        ..HistoricalOracleData::default()
                    },
                    ..AMM::default()
                },
                margin_ratio_initial: 2000,
                margin_ratio_maintenance: 1000,
                status: MarketStatus::Active,
                ..PerpMarket::default_test()
            };
            perp_market.amm.max_base_asset_reserve = u64::MAX as u128;
            perp_market.amm.min_base_asset_reserve = 0;
            crate::create_anchor_account_info!(perp_market, PerpMarket, perp_market_info);
            let perp_market_map = PerpMarketMap::load_one(&perp_market_info, true).unwrap();

            let mut spot_market = SpotMarket {
                market_index: 0,
                oracle_source: OracleSource::QuoteAsset,
                cumulative_deposit_interest: SPOT_CUMULATIVE_INTEREST_PRECISION,
                decimals: 6,
                initial_asset_weight: SPOT_WEIGHT_PRECISION,
                maintenance_asset_weight: SPOT_WEIGHT_PRECISION,
                historical_oracle_data: HistoricalOracleData::default_quote_oracle(),
                ..SpotMarket::default()
            };
            crate::create_anchor_account_info!(spot_market, SpotMarket, spot_market_info);
            let spot_market_map = SpotMarketMap::load_one(&spot_market_info, true).unwrap();

            // Maker: $100,000 USDC, no existing position — fill creates 10 BASE at $100.
            // 20% margin → $200 required. $100,000 >> $200 → passes.
            let maker_key = Pubkey::new_unique();
            let mut spot_positions = [SpotPosition::default(); 8];
            spot_positions[0] = SpotPosition {
                market_index: 0,
                balance_type: SpotBalanceType::Deposit,
                scaled_balance: 100_000 * SPOT_BALANCE_PRECISION_U64,
                ..SpotPosition::default()
            };
            let mut maker_user = User {
                authority: maker_key,
                spot_positions,
                ..User::default()
            };
            crate::create_anchor_account_info!(maker_user, &maker_key, User, maker_info);

            let midprice_prog_id = midprice_program_id();
            let mid_key = Pubkey::new_unique();
            let mut mid_data = make_midprice_account_data(
                100 * PRICE_PRECISION_U64,
                50 * BASE_PRECISION_U64,
                &maker_key,
            );
            let mut mid_lamports = 0u64;
            let mid_info = create_account_info(
                &mid_key,
                true,
                &mut mid_lamports,
                &mut mid_data[..],
                &midprice_prog_id,
            );
            let mut prog_lamps = 0u64;
            let mut prog_data = [0u8; 0];
            let program_info = create_executable_program_account_info(
                &midprice_prog_id,
                &mut prog_lamps,
                &mut prog_data[..],
            );
            let (matcher_pda, _) = prop_amm_matcher_pda(&program_id);
            let mut matcher_lamports = 0u64;
            let mut matcher_data = [0u8; 0];
            let matcher_info = create_account_info(
                &matcher_pda,
                true,
                &mut matcher_lamports,
                &mut matcher_data[..],
                &program_id,
            );

            let remaining_accounts: Vec<AccountInfo> =
                vec![program_info, matcher_info, mid_info, maker_info];
            let amm_views = vec![AmmView {
                key: mid_key,
                mid_price: 100 * PRICE_PRECISION_U64,
                sequence_number_snapshot: 0,
                maker_user_remaining_index: 3,
                midprice_remaining_index: 2,
            }];

            let base_delta = 10_i64 * (BASE_PRECISION_U64 as i64);
            let quote_delta = -(10 * 100 * crate::math::constants::PRICE_PRECISION_I64);
            let mut maker_deltas = BTreeMap::new();
            maker_deltas.insert(maker_key, (base_delta, quote_delta));

            let (filtered_deltas, _, _, _, _) = filter_prop_amm_makers_by_margin(
                &maker_deltas,
                &[],
                &amm_views,
                &remaining_accounts,
                &perp_market_map,
                &spot_market_map,
                &mut oracle_map,
                0,
                0,
            )
            .unwrap();

            assert!(
                filtered_deltas.contains_key(&maker_key),
                "solvent maker ($100k collateral, $200 margin req) should pass"
            );
        }
    }
}
