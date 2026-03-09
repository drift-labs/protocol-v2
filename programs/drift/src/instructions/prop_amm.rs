//! Match perp orders against prop AMM (midprice_pino) liquidity. Uses Drift as the exchange:
//! taker and makers are Drift users; matcher authority is a PDA of this program.
//!
//! Each PropAMM account must be associated with a Drift User account (the maker).
//! Remaining accounts: [midprice_program], [spot_market_0, spot_market_1, ...] (num_spot_markets collateral spot markets),
//! then for each AMM: (midprice_account, maker_user).
//! Midprice accounts have authority = maker's wallet (User.authority); only Drift's matcher PDA can apply_fills (hardcoded in midprice_pino).
//! Matcher_authority = PDA(drift_program_id, ["matcher", maker_user.key()]).

use crate::controller::orders::update_order_after_fill;
use crate::controller::pda;
use crate::controller::position::{
    add_new_position, get_position_index, update_position_and_market, PositionDirection,
};
use crate::error::{DriftResult, ErrorCode};
use crate::get_then_update_id;
use crate::instructions::constraints::valid_oracle_for_perp_market;
use crate::math::constants::AMM_RESERVE_PRECISION;
use crate::math::margin::{
    calculate_margin_requirement_and_total_collateral_and_liability_info, MarginRequirementType,
};
use crate::math::orders::{get_position_delta_for_fill, select_margin_type_for_perp_maker};
use crate::math::safe_math::SafeMath;
use crate::state::events::{
    emit_stack, get_order_action_record, OrderAction, OrderActionExplanation, OrderActionRecord,
};
use crate::state::margin_calculation::MarginContext;
use crate::state::oracle_map::OracleMap;
use crate::state::paused_operations::PerpOperation;
use crate::state::perp_market::{MarketStatus, PerpMarket};
use crate::state::perp_market_map::PerpMarketMap;
use crate::state::spot_market_map::{SpotMarketMap, SpotMarketSet};
use crate::state::traits::Size;
use crate::state::user::{MarketType, Order, OrderType, User};
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

#[derive(Clone, Copy)]
struct TopLevel {
    price: u64,
    size: u64,
    abs_index: usize,
    is_ask: bool,
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

/// Result of the prop AMM matching loop (used by handler and tests).
#[derive(Default)]
pub(crate) struct PropAmmMatchResult {
    pub taker_base_delta: i64,
    pub taker_quote_delta: i64,
    pub total_quote_volume: u64,
    pub maker_deltas: BTreeMap<Pubkey, (i64, i64)>,
    pub external_fills: Vec<PendingExternalFill>,
}

/// Global PropAMM matcher PDA: one account can apply fills to all PropAMM books.
pub fn prop_amm_matcher_pda(program_id: &Pubkey) -> (Pubkey, u8) {
    Pubkey::find_program_address(&[PROP_AMM_MATCHER_SEED], program_id)
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
    }))
}

fn init_frontiers(
    amm_views: &[AmmView],
    remaining_accounts: &[AccountInfo],
    side: &PositionDirection,
    taker_limit_price: u64,
) -> DriftResult<Vec<Option<TopLevel>>> {
    let mut frontiers = Vec::with_capacity(amm_views.len());
    for amm in amm_views {
        frontiers.push(find_external_top_level_from(
            &remaining_accounts[amm.midprice_remaining_index],
            side,
            taker_limit_price,
            amm.mid_price,
            None,
        )?);
    }
    Ok(frontiers)
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

fn allocate_fill_pro_rata(
    tied_levels: &[TiedFrontier],
    remaining: u64,
) -> DriftResult<(u64, Vec<FillAllocation>)> {
    let total_liquidity = tied_levels
        .iter()
        .try_fold(0u64, |acc, tied| acc.safe_add(tied.level.size))?;
    let fill = remaining.min(total_liquidity);

    let mut allocations = Vec::with_capacity(tied_levels.len());
    let mut distributed = 0u64;
    for tied in tied_levels {
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

    let mut remainder = fill.safe_sub(distributed)?;
    for allocation in &mut allocations {
        if remainder == 0 {
            break;
        }
        // Cap at level size so we never request more than available (Solana overflow / CPI safety).
        if allocation.share < allocation.level.size {
            allocation.share = allocation.share.safe_add(1)?;
            remainder = remainder.saturating_sub(1);
        }
    }
    Ok((fill, allocations))
}

fn refresh_exhausted_frontiers(
    frontiers: &mut [Option<TopLevel>],
    tied_levels: &[TiedFrontier],
    amm_views: &[AmmView],
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
        let next_start = current.abs_index.saturating_add(1);
        frontiers[tied.idx] = find_external_top_level_from(
            &remaining_accounts[amm_views[tied.idx].midprice_remaining_index],
            side,
            taker_limit_price,
            amm_views[tied.idx].mid_price,
            Some(next_start),
        )?;
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
        ErrorCode::InvalidSpotMarketAccount,
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
/// Layout: remaining_accounts[0] = midprice program, [1..amm_start] = spot markets, [amm_start] = matcher PDA.
fn find_amm_start_after_spot_markets(
    remaining_accounts: &[AccountInfo],
    program_id: &Pubkey,
) -> DriftResult<usize> {
    let (expected_matcher, _bump) = prop_amm_matcher_pda(program_id);
    remaining_accounts[1..]
        .iter()
        .position(|a| a.key() == expected_matcher)
        .map(|pos| 1 + pos)
        .ok_or_else(|| ErrorCode::InvalidSpotMarketAccount.into())
}

/// Parses remaining_accounts: midprice_program (0), spot markets [1..amm_start], global_matcher (amm_start), then per-AMM pairs (midprice, maker_user).
/// Returns (midprice_program_account_index, amm_views).
/// When provided, `order_market_index` and `taker_user_key` are validated in the same pass (each midprice's market_index must match; taker must not be any maker).
pub(crate) fn parse_amm_views(
    remaining_accounts: &[AccountInfo],
    amm_start: usize,
    program_id: &Pubkey,
    current_slot: u64,
    order_market_index: Option<u16>,
    taker_user_key: Option<&Pubkey>,
) -> DriftResult<(usize, Vec<AmmView>)> {
    const ACCOUNTS_PER_AMM: usize = 2; // midprice, maker_user (global matcher is separate)
    const GLOBAL_MATCHER_SLOTS: usize = 1;
    validate!(
        remaining_accounts.len() >= amm_start + GLOBAL_MATCHER_SLOTS + ACCOUNTS_PER_AMM,
        ErrorCode::InvalidSpotMarketAccount,
        "remaining_accounts: need midprice_program + spot_markets + global_matcher + at least one (midprice, maker_user) pair"
    )?;

    // 0: midprice program
    let midprice_program = &remaining_accounts[0];
    validate!(
        midprice_program.executable,
        ErrorCode::InvalidSpotMarketAccount,
        "remaining_accounts[0] must be an executable program (midprice program)"
    )?;
    let expected_midprice_program_id = crate::ids::midprice_program::id();
    validate!(
        midprice_program.key() == expected_midprice_program_id,
        ErrorCode::InvalidSpotMarketAccount,
        "remaining_accounts[0] must be the canonical midprice program (prevent CPI to arbitrary program)"
    )?;

    // amm_start: global matcher PDA
    let (expected_matcher, _bump) = prop_amm_matcher_pda(program_id);
    validate!(
        remaining_accounts[amm_start].key() == expected_matcher,
        ErrorCode::InvalidSpotMarketAccount,
        "account after spot_markets must be the global PropAMM matcher PDA"
    )?;

    // Build reserved key set: all "global" accounts that must not overlap with any AMM pair.
    // This includes:
    // [0] midprice_program
    // [1..amm_start) spot markets (or whatever you consumed)
    // [amm_start] global matcher PDA
    let mut reserved: BTreeSet<Pubkey> = BTreeSet::new();
    for i in 0..(amm_start + GLOBAL_MATCHER_SLOTS) {
        reserved.insert(remaining_accounts[i].key());
    }

    // Ensure the remainder after the matcher is exactly (midprice, maker_user)*.
    let tail_start = amm_start + GLOBAL_MATCHER_SLOTS;
    let tail_len = remaining_accounts.len().saturating_sub(tail_start);
    validate!(
        tail_len % ACCOUNTS_PER_AMM == 0,
        ErrorCode::InvalidSpotMarketAccount,
        "remaining_accounts after global_matcher must be (midprice, maker_user)*; got tail_len={} not divisible by {}",
        tail_len,
        ACCOUNTS_PER_AMM
    )?;

    let num_pairs = tail_len / ACCOUNTS_PER_AMM;
    validate!(
        num_pairs > 0,
        ErrorCode::InvalidSpotMarketAccount,
        "must provide at least one (midprice, maker_user) pair"
    )?;

    let mut amm_views: Vec<AmmView> = Vec::with_capacity(num_pairs);
    let mut seen_midprices: BTreeSet<Pubkey> = BTreeSet::new();
    let mut seen_makers: BTreeSet<Pubkey> = BTreeSet::new();

    for pair_idx in 0..num_pairs {
        let base = tail_start + pair_idx * ACCOUNTS_PER_AMM;
        let midprice_info = &remaining_accounts[base];
        let maker_user_info = &remaining_accounts[base + 1];

        let midprice_key = midprice_info.key();
        let maker_user_key = maker_user_info.key();

        // Disallow overlap between any AMM account and the global accounts.
        validate!(
            !reserved.contains(&midprice_key),
            ErrorCode::InvalidSpotMarketAccount,
            "midprice account must not overlap with global accounts (pair_idx={}, midprice={})",
            pair_idx,
            midprice_key
        )?;
        validate!(
            !reserved.contains(&maker_user_key),
            ErrorCode::InvalidSpotMarketAccount,
            "maker user must not overlap with global accounts (pair_idx={}, maker_user={})",
            pair_idx,
            maker_user_key
        )?;

        // Disallow pathological "same pubkey twice in the pair".
        validate!(
            midprice_key != maker_user_key,
            ErrorCode::InvalidSpotMarketAccount,
            "midprice and maker_user must be different accounts (pair_idx={}, key={})",
            pair_idx,
            midprice_key
        )?;

        // Disallow duplicate midprice or duplicate maker user within the same instruction.
        validate!(
            seen_midprices.insert(midprice_key),
            ErrorCode::InvalidSpotMarketAccount,
            "duplicate midprice account in remaining_accounts (pair_idx={}, midprice={})",
            pair_idx,
            midprice_key
        )?;
        validate!(
            seen_makers.insert(maker_user_key),
            ErrorCode::InvalidSpotMarketAccount,
            "duplicate maker user account in remaining_accounts (pair_idx={}, maker_user={})",
            pair_idx,
            maker_user_key
        )?;

        // Maker user must be owned by Drift and must be writable (we will mutate position / orders / stats).
        validate!(
            *maker_user_info.owner == *program_id,
            ErrorCode::InvalidSpotMarketAccount,
            "maker user must be owned by Drift program (pair_idx={}, maker_user={}, owner={})",
            pair_idx,
            maker_user_key,
            maker_user_info.owner
        )?;
        validate!(
            maker_user_info.is_writable,
            ErrorCode::InvalidSpotMarketAccount,
            "maker user must be writable (pair_idx={}, maker_user={})",
            pair_idx,
            maker_user_key
        )?;

        // Read mid price (and any other snapshot like sequence number) and validate midprice authority ↔ maker relationship + TTL.
        let (mid_price, sequence_number_snapshot, midprice_market_index) = read_external_mid_price(
            midprice_info,
            midprice_program.key,
            maker_user_info,
            current_slot,
        )?;

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
                ErrorCode::InvalidSpotMarketAccount,
                "taker cannot be same as maker (no self-trade)"
            )?;
        }

        amm_views.push(AmmView {
            key: midprice_key,
            mid_price,
            sequence_number_snapshot,
            maker_user_remaining_index: base + 1,
            midprice_remaining_index: base,
        });
    }

    // Return index of midprice program in remaining_accounts, plus parsed views.
    Ok((0, amm_views))
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
    let mut solvent_keys = std::collections::BTreeSet::new();
    for (maker_user_key, &(base_delta, quote_delta)) in maker_deltas {
        if base_delta == 0 && quote_delta == 0 {
            solvent_keys.insert(*maker_user_key);
            continue;
        }
        let amm_view = amm_views
            .iter()
            .find(|a| remaining_accounts[a.maker_user_remaining_index].key() == *maker_user_key)
            .ok_or(ErrorCode::InvalidSpotMarketAccount)?;
        let maker_info = &remaining_accounts[amm_view.maker_user_remaining_index];
        let maker_loader: AccountLoader<User> =
            AccountLoader::try_from(maker_info).map_err(|_| ErrorCode::CouldNotLoadUserData)?;
        let maker_for_margin = maker_loader
            .load()
            .map_err(|_| ErrorCode::CouldNotLoadUserData)?;
        let (maker_margin_type, _) =
            select_margin_type_for_perp_maker(&maker_for_margin, base_delta, market_index)?;
        let maker_margin_context = MarginContext::standard(maker_margin_type)
            .fuel_perp_delta(market_index, base_delta)
            .fuel_numerator(&maker_for_margin, now);
        let maker_margin_calc =
            calculate_margin_requirement_and_total_collateral_and_liability_info(
                &maker_for_margin,
                perp_market_map,
                spot_market_map,
                oracle_map,
                maker_margin_context,
            )?;
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
        taker_base_delta = taker_base_delta.saturating_sub(*base);
        taker_quote_delta = taker_quote_delta.saturating_sub(*quote);
        total_quote_volume = total_quote_volume.saturating_add(quote.unsigned_abs());
    }

    Ok((
        filtered_maker_deltas,
        filtered_external_fills,
        taker_base_delta,
        taker_quote_delta,
        total_quote_volume,
    ))
}

/// Runs the prop AMM matching loop; returns deltas and external fills (no account updates).
pub(crate) fn run_prop_amm_matching(
    amm_views: &[AmmView],
    remaining_accounts: &[AccountInfo],
    side: PositionDirection,
    limit_price: u64,
    size: u64,
) -> DriftResult<PropAmmMatchResult> {
    let mut remaining = size;
    let mut frontiers = init_frontiers(amm_views, remaining_accounts, &side, limit_price)?;
    let mut result = PropAmmMatchResult::default();

    while remaining > 0 {
        let Some((best_price, tied_levels)) = tied_frontiers_at_best_price(&frontiers, &side)
        else {
            break;
        };
        let (fill, allocations) = allocate_fill_pro_rata(&tied_levels, remaining)?;
        if fill == 0 {
            break;
        }
        for allocation in allocations {
            if allocation.share == 0 {
                continue;
            }
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
            // quote = base * price; base in AMM_RESERVE_PRECISION (1e9), price in PRICE_PRECISION (1e6) => divide by AMM_RESERVE_PRECISION for QUOTE_PRECISION (1e6)
            let fill_quote_u128 = (allocation.share as u128)
                .checked_mul(best_price as u128)
                .ok_or(ErrorCode::MathError)?
                .checked_div(AMM_RESERVE_PRECISION)
                .ok_or(ErrorCode::MathError)?;
            let fill_quote_u64 =
                u64::try_from(fill_quote_u128).map_err(|_| ErrorCode::MathError)?;
            result.total_quote_volume = result.total_quote_volume.safe_add(fill_quote_u64)?;
            let share_i64 = i64::try_from(allocation.share).map_err(|_| ErrorCode::MathError)?;
            let fill_quote_i64 =
                i64::try_from(fill_quote_u128).map_err(|_| ErrorCode::MathError)?;
            let (base_delta, quote_delta) = if matches!(side, PositionDirection::Long) {
                (share_i64, -fill_quote_i64)
            } else {
                (-share_i64, fill_quote_i64)
            };
            result.taker_base_delta = result.taker_base_delta.safe_add(base_delta)?;
            result.taker_quote_delta = result.taker_quote_delta.safe_add(quote_delta)?;
            let maker_pubkey = remaining_accounts[amm_view.maker_user_remaining_index].key();
            let entry = result.maker_deltas.entry(maker_pubkey).or_insert((0, 0));
            entry.0 = entry.0.safe_add(-base_delta)?;
            entry.1 = entry.1.safe_add(-quote_delta)?;
            if let Some(ref mut frontier) = frontiers[allocation.idx] {
                frontier.size = frontier.size.safe_sub(allocation.share)?;
            }
        }
        refresh_exhausted_frontiers(
            &mut frontiers,
            &tied_levels,
            amm_views,
            remaining_accounts,
            &side,
            limit_price,
        )?;
        remaining = remaining.safe_sub(fill)?;
    }
    Ok(result)
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
        ErrorCode::InvalidSpotMarketAccount,
        "midprice_program must be the canonical midprice program"
    )?;
    validate!(
        ctx.accounts.midprice_program.executable,
        ErrorCode::InvalidSpotMarketAccount,
        "midprice_program must be executable"
    )?;
    let perp_market = ctx.accounts.perp_market.load()?;
    let market_index = perp_market.market_index;
    let order_tick_size = perp_market.amm.order_tick_size;
    let min_order_size = perp_market.amm.min_order_size;

    let (expected_matcher, bump) = prop_amm_matcher_pda(ctx.program_id);
    validate!(
        ctx.accounts.prop_amm_matcher.key() == expected_matcher,
        ErrorCode::InvalidSpotMarketAccount,
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
        ErrorCode::InvalidSpotMarketAccount,
        "midprice_program must be the canonical midprice program"
    )?;
    validate!(
        ctx.accounts.midprice_program.executable,
        ErrorCode::InvalidSpotMarketAccount,
        "midprice_program must be executable"
    )?;
    let perp_market = ctx.accounts.perp_market.load()?;
    let order_tick_size = perp_market.amm.order_tick_size;
    let min_order_size = perp_market.amm.min_order_size;

    let (expected_matcher, bump) = prop_amm_matcher_pda(ctx.program_id);
    validate!(
        ctx.accounts.prop_amm_matcher.key() == expected_matcher,
        ErrorCode::InvalidSpotMarketAccount,
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

pub fn handle_match_perp_order_via_prop_amm<'c: 'info, 'info>(
    ctx: Context<'_, '_, 'c, 'info, MatchPerpOrderViaPropAmm<'info>>,
    taker_order_id: u32,
) -> Result<()> {
    let (
        market_index,
        side,
        limit_price,
        size,
        taker_direction,
        order_index,
        order_base_asset_amount,
    ) = {
        let user = ctx.accounts.user.load()?;
        let order_index = user.get_order_index(taker_order_id)?;
        let order = &user.orders[order_index];

        validate!(
            order.market_type == MarketType::Perp,
            ErrorCode::InvalidOrderMarketType,
            "must be perp order"
        )?;
        validate!(
            order.order_type == OrderType::Limit,
            ErrorCode::InvalidOrder,
            "prop AMM match requires limit order"
        )?;
        validate!(
            !order.post_only,
            ErrorCode::InvalidOrder,
            "post_only orders cannot be filled as taker via prop AMM"
        )?;
        let size = order.get_base_asset_amount_unfilled(None)?;
        validate!(
            size > 0,
            ErrorCode::InvalidOrder,
            "prop AMM match requires unfilled size > 0"
        )?;
        let side = order.direction;
        (
            order.market_index,
            side,
            order.price,
            size,
            order.direction,
            order_index,
            order.base_asset_amount,
        )
    };

    let clock = Clock::get()?;
    let now = clock.unix_timestamp;

    let perp_market = ctx.accounts.perp_market.load()?;
    validate!(
        perp_market.market_index == market_index,
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
    valid_oracle_for_perp_market(&ctx.accounts.oracle, &ctx.accounts.perp_market)?;
    drop(perp_market);

    let program_id = ctx.program_id;
    let remaining_accounts = ctx.remaining_accounts;
    // Canonical layout: [midprice_program], [spot_markets...], [matcher PDA], then (midprice, maker_user)*.
    // The client may also pass additional perp market accounts when maker/taker have positions in those markets (e.g. for margin).
    let amm_start = find_amm_start_after_spot_markets(remaining_accounts, program_id)?;
    let (midprice_program_idx, amm_views) = parse_amm_views(
        remaining_accounts,
        amm_start,
        program_id,
        clock.slot,
        Some(market_index),
        Some(&ctx.accounts.user.key()),
    )?;

    if amm_views.is_empty() {
        return Ok(());
    }

    let result = run_prop_amm_matching(&amm_views, remaining_accounts, side, limit_price, size)?;

    let spot_slice = &remaining_accounts[1..amm_start];
    let mut spot_iter: Peekable<Iter<AccountInfo>> = spot_slice.iter().peekable();
    let spot_market_map = SpotMarketMap::load(&SpotMarketSet::new(), &mut spot_iter)?;

    // Filter out insolvent makers before applying any state changes. This recomputes taker deltas
    // and total_quote_volume so they only reflect solvent makers (skip semantics).
    let perp_market_map =
        PerpMarketMap::from_single_loader(&ctx.accounts.perp_market, market_index)?;
    let oracle_guard_rails = ctx.accounts.state.oracle_guard_rails;
    let mut oracle_map =
        OracleMap::load_one(&ctx.accounts.oracle, clock.slot, Some(oracle_guard_rails))?;

    let (maker_deltas, external_fills, taker_base_delta, taker_quote_delta, total_quote_volume) =
        filter_prop_amm_makers_by_margin(
            &result.maker_deltas,
            &result.external_fills,
            &amm_views,
            remaining_accounts,
            &perp_market_map,
            &spot_market_map,
            &mut oracle_map,
            market_index,
            now,
        )?;

    if external_fills.is_empty() {
        return Ok(());
    }

    let base_filled = taker_base_delta.unsigned_abs() as u64;
    let mut user = ctx.accounts.user.load_mut()?;
    let mut perp_market = ctx.accounts.perp_market.load_mut()?;

    let taker_position_index = get_position_index(&user.perp_positions, market_index)
        .or_else(|_| add_new_position(&mut user.perp_positions, market_index))?;
    let taker_delta = get_position_delta_for_fill(
        base_filled,
        taker_quote_delta.unsigned_abs() as u64,
        taker_direction,
    )?;
    update_position_and_market(
        &mut user.perp_positions[taker_position_index],
        &mut perp_market,
        &taker_delta,
    )?;
    update_order_after_fill(
        &mut user.orders[order_index],
        base_filled,
        total_quote_volume,
    )?;

    drop(user);
    drop(perp_market);

    // Margin check: taker must still meet margin after fill (same rule as fill_perp_order: Maintenance if position decreasing, Fill if risk-increasing).
    let taker_user = ctx.accounts.user.load()?;
    let position_after = taker_user
        .get_perp_position(market_index)
        .map_or(0_i64, |p| p.base_asset_amount);
    // Use checked_sub: taker_base_delta is signed, and saturating_sub on i64 silently clamps
    // on overflow rather than propagating an error, which would produce a wrong position_before
    // and therefore wrong margin type selection (Maintenance vs Fill).
    let position_before = position_after
        .checked_sub(taker_base_delta)
        .ok_or(ErrorCode::MathError)?;
    let taker_position_decreasing = position_after == 0
        || (position_after.signum() == position_before.signum()
            && position_after.abs() < position_before.abs());
    let taker_margin_type = if taker_position_decreasing {
        MarginRequirementType::Maintenance
    } else {
        MarginRequirementType::Fill
    };
    {
        let taker_margin_context = MarginContext::standard(taker_margin_type)
            .fuel_perp_delta(market_index, -taker_base_delta)
            .fuel_numerator(&taker_user, now);
        let taker_margin_calc =
            calculate_margin_requirement_and_total_collateral_and_liability_info(
                &taker_user,
                &perp_market_map,
                &spot_market_map,
                &mut oracle_map,
                taker_margin_context,
            )?;
        if !taker_margin_calc.meets_margin_requirement() {
            let (margin_requirement, total_collateral) = if taker_margin_calc
                .has_isolated_margin_calculation(market_index)
            {
                let isolated = taker_margin_calc.get_isolated_margin_calculation(market_index)?;
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
    drop(taker_user);

    // Update taker UserStats (taker volume).
    let mut taker_stats = ctx.accounts.user_stats.load_mut()?;
    let fuel_boost_taker = ctx.accounts.perp_market.load()?.fuel_boost_taker;
    taker_stats.update_taker_volume_30d(fuel_boost_taker, total_quote_volume, now)?;
    drop(taker_stats);

    // Precompute oracle price and taker order for fill events.
    let oracle_id = ctx.accounts.perp_market.load()?.oracle_id();
    let mut oracle_map = OracleMap::load_one(
        &ctx.accounts.oracle,
        clock.slot,
        Some(ctx.accounts.state.as_ref().oracle_guard_rails),
    )?;
    let oracle_price = oracle_map.get_price_data(&oracle_id)?.price;
    drop(oracle_map);

    let mut taker_order = Order::default();
    taker_order.market_type = MarketType::Perp;
    taker_order.direction = taker_direction;
    taker_order.base_asset_amount = order_base_asset_amount;
    taker_order.base_asset_amount_filled = base_filled;
    taker_order.quote_asset_amount_filled = total_quote_volume;
    taker_order.market_index = market_index;

    // Apply maker deltas: load each maker user + user_stats, update position + market, update maker volume.
    // Maker margin has already been enforced by filter_prop_amm_makers_by_margin; we do not
    // revert the tx here on additional maker margin failures (skip semantics).
    // Emit a match fill event for each maker with that maker's cumulative amount.
    for (maker_user_key, (base_delta, quote_delta)) in maker_deltas {
        if base_delta == 0 && quote_delta == 0 {
            continue;
        }
        let amm_view = amm_views
            .iter()
            .find(|a| remaining_accounts[a.maker_user_remaining_index].key() == maker_user_key)
            .ok_or(ErrorCode::InvalidSpotMarketAccount)?;
        let maker_info = &remaining_accounts[amm_view.maker_user_remaining_index];
        let maker_loader: AccountLoader<User> =
            AccountLoader::try_from(maker_info).or(Err(ErrorCode::CouldNotLoadUserData))?;
        let mut maker = maker_loader.load_mut()?;
        let mut market = ctx.accounts.perp_market.load_mut()?;
        let maker_direction = if base_delta > 0 {
            PositionDirection::Long
        } else {
            PositionDirection::Short
        };
        let maker_position_index = get_position_index(&maker.perp_positions, market_index)
            .or_else(|_| add_new_position(&mut maker.perp_positions, market_index))?;
        let maker_delta = get_position_delta_for_fill(
            base_delta.unsigned_abs() as u64,
            quote_delta.unsigned_abs() as u64,
            maker_direction,
        )?;
        update_position_and_market(
            &mut maker.perp_positions[maker_position_index],
            &mut *market,
            &maker_delta,
        )?;

        let maker_base_filled = base_delta.unsigned_abs() as u64;
        let maker_quote_filled = quote_delta.unsigned_abs() as u64;
        let fill_record_id = get_then_update_id!(market, next_fill_record_id);
        drop(maker);
        drop(market);

        let fill_record = get_order_action_record(
            now,
            OrderAction::Fill,
            OrderActionExplanation::OrderFilledWithMatch,
            market_index,
            None, // filler
            Some(fill_record_id),
            None, // filler_reward
            Some(maker_base_filled),
            Some(maker_quote_filled),
            None, // taker_fee
            None, // maker_rebate
            None, // referrer_reward
            None, // quote_asset_amount_surplus
            None, // spot_fulfillment_method_fee
            Some(ctx.accounts.user.key()),
            Some(taker_order),
            Some(maker_user_key),
            None, // maker_order (PropAMM orders live on midprice, not Drift User)
            oracle_price,
            0,    // bit_flags
            None, // taker_existing_quote_entry_amount
            None, // taker_existing_base_asset_amount
            None, // maker_existing_quote_entry_amount
            None, // maker_existing_base_asset_amount
            None, // trigger_price
            None, // builder_idx
            None, // builder_fee
        )?;
        emit_stack::<_, { OrderActionRecord::SIZE }>(fill_record)?;
    }

    // CPI to midprice_pino to apply fills (consume orders on AMM books).
    flush_external_fill_batches(
        &remaining_accounts[midprice_program_idx],
        remaining_accounts,
        &ctx.accounts.clock.to_account_info(),
        &external_fills,
        amm_start,
        market_index,
        program_id,
    )?;

    Ok(())
}

#[derive(Accounts)]
pub struct MatchPerpOrderViaPropAmm<'info> {
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

    pub clock: Sysvar<'info, Clock>,
}

#[cfg(test)]
mod tests {
    use super::*;
    use anchor_lang::prelude::Pubkey;
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
    use crate::state::spot_market::{SpotBalanceType, SpotMarket};
    use crate::state::spot_market_map::SpotMarketMap;
    use crate::state::user::{PerpPosition, SpotPosition, User};
    use crate::{
        create_account_info, create_executable_program_account_info, get_account_bytes,
        get_anchor_account_bytes, get_pyth_price,
    };
    use midprice_book_view::{
        ACCOUNT_DISCRIMINATOR_OFFSET, ACCOUNT_DISCRIMINATOR_SIZE, ACCOUNT_MIN_LEN, ASK_HEAD_OFFSET,
        ASK_LEN_OFFSET, AUTHORITY_OFFSET, BID_HEAD_OFFSET, BID_LEN_OFFSET, LAYOUT_VERSION_INITIAL,
        LAYOUT_VERSION_OFFSET, MARKET_INDEX_OFFSET, MIDPRICE_ACCOUNT_DISCRIMINATOR,
        MID_PRICE_OFFSET, ORDERS_DATA_OFFSET, ORDER_ENTRY_SIZE, QUOTE_TTL_OFFSET, REF_SLOT_OFFSET,
        SUBACCOUNT_INDEX_OFFSET,
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
        let base = ORDERS_DATA_OFFSET;
        data[base..base + 8].copy_from_slice(&1i64.to_le_bytes());
        data[base + 8..base + 16].copy_from_slice(&ask_size.to_le_bytes());
        data
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
            Err(e) => assert_eq!(e, ErrorCode::InvalidSpotMarketAccount),
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

        let (_, amm_views) = parse_amm_views(slice, 1, &program_id, 100, None, None).unwrap();
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

    /// After applying prop AMM fill deltas to the taker, margin requirement must be satisfied.
    /// Margin must remain valid after applying a simulated fill.
    /// Ignored: account buffer alignment can trigger bytemuck error in test env; logic is covered by margin_calculation.
    #[test]
    fn margin_checks_upheld_post_fill() {
        let slot = 0_u64;
        let oracle_key = Pubkey::from_str("J83w4HKfqxwcq3BEMMkPFSppX3gqekLyLJBexebFVkix").unwrap();
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
        let oracle_key = Pubkey::from_str("J83w4HKfqxwcq3BEMMkPFSppX3gqekLyLJBexebFVkix").unwrap();
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
        let oracle_key = Pubkey::from_str("J83w4HKfqxwcq3BEMMkPFSppX3gqekLyLJBexebFVkix").unwrap();
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
        let oracle_key = Pubkey::from_str("J83w4HKfqxwcq3BEMMkPFSppX3gqekLyLJBexebFVkix").unwrap();
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

    /// SECURITY: Only Drift's matcher PDA can apply_fills (midprice_pino hardcodes DRIFT_PROGRAM_ID for PDA check).
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
        // parse_amm_views accepts valid midprice layout; apply_fills matcher PDA is enforced in midprice_pino.
        let res = parse_amm_views(remaining.as_slice(), 1, &program_id, 100, None, None);
        assert!(
            res.is_ok(),
            "valid midprice with correct authority should parse"
        );
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
        let res = parse_amm_views(remaining.as_slice(), 1, &program_id, 100, None, None);
        assert!(
            res.is_err(),
            "midprice account must be owned by the canonical midprice program"
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
        let (_, amm_views) =
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

    /// CU scaling: order matched against 1 PropAMM. Run with 1/2/4/8 tests to gauge CU; actual CUs from integration test.
    #[test]
    fn cu_bench_1_prop_amm() {
        let program_id = drift_program_id();
        let midprice_prog_id = midprice_program_id();
        let midprice_key = Pubkey::new_unique();
        let (maker_authority, maker_user_key) = derive_maker_user_pda();
        let mut maker_user = User::default();
        maker_user.authority = maker_authority;
        maker_user.sub_account_id = 0;
        crate::create_anchor_account_info!(maker_user, &maker_user_key, User, maker_user_info);
        let mid_price = 100 * PRICE_PRECISION_U64;
        let ask_size = 50 * BASE_PRECISION_U64;
        let data = make_midprice_account_data(mid_price, ask_size, &maker_authority);
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
        let slice = remaining.as_slice();
        let (_, amm_views) = parse_amm_views(slice, 1, &program_id, 100, None, None).unwrap();
        let result = run_prop_amm_matching(
            &amm_views,
            slice,
            PositionDirection::Long,
            101 * PRICE_PRECISION_U64,
            30 * BASE_PRECISION_U64,
        )
        .unwrap();
        let total_filled: u64 = result.external_fills.iter().map(|p| p.fill.fill_size).sum();
        assert!(total_filled > 0);
        assert!(result.external_fills.len() >= 1);
    }

    /// CU scaling: order matched against 2 PropAMM accounts.
    #[test]
    fn cu_bench_2_prop_amms() {
        let program_id = drift_program_id();
        let midprice_prog_id = midprice_program_id();
        let mid_price = 100 * PRICE_PRECISION_U64;
        let ask_size = 50 * BASE_PRECISION_U64;

        let (maker_authority_0, maker_user_pda_0) = derive_maker_user_pda();
        let mut maker_user_0 = User {
            authority: maker_authority_0,
            ..User::default()
        };
        crate::create_anchor_account_info!(
            maker_user_0,
            &maker_user_pda_0,
            User,
            maker_user_info_0
        );
        let midprice_key_0 = Pubkey::new_unique();
        let mut midprice_lamports_0 = 0u64;
        let mut midprice_data_0 =
            make_midprice_account_data(mid_price, ask_size, &maker_authority_0);
        let midprice_info_0 = create_account_info(
            &midprice_key_0,
            true,
            &mut midprice_lamports_0,
            &mut midprice_data_0[..],
            &midprice_prog_id,
        );

        let (maker_authority_1, maker_user_pda_1) = derive_maker_user_pda();
        let mut maker_user_1 = User {
            authority: maker_authority_1,
            ..User::default()
        };
        crate::create_anchor_account_info!(
            maker_user_1,
            &maker_user_pda_1,
            User,
            maker_user_info_1
        );
        let midprice_key_1 = Pubkey::new_unique();
        let mut midprice_lamports_1 = 0u64;
        let mut midprice_data_1 =
            make_midprice_account_data(mid_price, ask_size, &maker_authority_1);
        let midprice_info_1 = create_account_info(
            &midprice_key_1,
            true,
            &mut midprice_lamports_1,
            &mut midprice_data_1[..],
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
            midprice_info_0,
            maker_user_info_0,
            midprice_info_1,
            maker_user_info_1,
        ];
        let slice = remaining.as_slice();
        let (_, amm_views) = parse_amm_views(slice, 1, &program_id, 100, None, None).unwrap();
        let result = run_prop_amm_matching(
            &amm_views,
            slice,
            PositionDirection::Long,
            101 * PRICE_PRECISION_U64,
            60 * BASE_PRECISION_U64,
        )
        .unwrap();
        let total_filled: u64 = result.external_fills.iter().map(|p| p.fill.fill_size).sum();
        assert!(total_filled > 0);
        assert!(result.external_fills.len() >= 1);
    }

    /// CU scaling: order matched against 4 PropAMM accounts (unrolled so all storage lives in scope).
    #[test]
    fn cu_bench_4_prop_amms() {
        let program_id = drift_program_id();
        let midprice_prog_id = midprice_program_id();
        let mid_price = 100 * PRICE_PRECISION_U64;
        let ask_size = 50 * BASE_PRECISION_U64;

        let (auth0, pda0) = derive_maker_user_pda();
        let mut mu0 = User {
            authority: auth0,
            ..User::default()
        };
        crate::create_anchor_account_info!(mu0, &pda0, User, mu_i0);
        let mp0 = Pubkey::new_unique();
        let mut ml0 = 0u64;
        let mut md0 = make_midprice_account_data(mid_price, ask_size, &auth0);
        let mi0 = create_account_info(&mp0, true, &mut ml0, &mut md0[..], &midprice_prog_id);

        let (auth1, pda1) = derive_maker_user_pda();
        let mut mu1 = User {
            authority: auth1,
            ..User::default()
        };
        crate::create_anchor_account_info!(mu1, &pda1, User, mu_i1);
        let mp1 = Pubkey::new_unique();
        let mut ml1 = 0u64;
        let mut md1 = make_midprice_account_data(mid_price, ask_size, &auth1);
        let mi1 = create_account_info(&mp1, true, &mut ml1, &mut md1[..], &midprice_prog_id);

        let (auth2, pda2) = derive_maker_user_pda();
        let mut mu2 = User {
            authority: auth2,
            ..User::default()
        };
        crate::create_anchor_account_info!(mu2, &pda2, User, mu_i2);
        let mp2 = Pubkey::new_unique();
        let mut ml2 = 0u64;
        let mut md2 = make_midprice_account_data(mid_price, ask_size, &auth2);
        let mi2 = create_account_info(&mp2, true, &mut ml2, &mut md2[..], &midprice_prog_id);

        let (auth3, pda3) = derive_maker_user_pda();
        let mut mu3 = User {
            authority: auth3,
            ..User::default()
        };
        crate::create_anchor_account_info!(mu3, &pda3, User, mu_i3);
        let mp3 = Pubkey::new_unique();
        let mut ml3 = 0u64;
        let mut md3 = make_midprice_account_data(mid_price, ask_size, &auth3);
        let mi3 = create_account_info(&mp3, true, &mut ml3, &mut md3[..], &midprice_prog_id);

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
            mi0,
            mu_i0,
            mi1,
            mu_i1,
            mi2,
            mu_i2,
            mi3,
            mu_i3,
        ];
        let slice = remaining.as_slice();
        let (_, amm_views) = parse_amm_views(slice, 1, &program_id, 100, None, None).unwrap();
        // Keep taker size modest so total quote fits in i64
        let taker_size = 4 * 5 * BASE_PRECISION_U64;
        let result = run_prop_amm_matching(
            &amm_views,
            slice,
            PositionDirection::Long,
            101 * PRICE_PRECISION_U64,
            taker_size,
        )
        .unwrap();
        let total_filled: u64 = result.external_fills.iter().map(|p| p.fill.fill_size).sum();
        assert!(total_filled > 0);
        assert!(result.external_fills.len() >= 1);
    }

    /// CU scaling: order matched against 8 PropAMM accounts (unrolled so all storage lives in scope).
    #[test]
    fn cu_bench_8_prop_amms() {
        let program_id = drift_program_id();
        let midprice_prog_id = midprice_program_id();
        let mid_price = 100 * PRICE_PRECISION_U64;
        let ask_size = 50 * BASE_PRECISION_U64;

        macro_rules! one_amm {
            ($auth:ident, $pda:ident, $mu:ident, $mu_i:ident, $mp:ident, $ml:ident, $md:ident, $mi:ident) => {
                let ($auth, $pda) = derive_maker_user_pda();
                let mut $mu = User {
                    authority: $auth,
                    ..User::default()
                };
                crate::create_anchor_account_info!($mu, &$pda, User, $mu_i);
                let $mp = Pubkey::new_unique();
                let mut $ml = 0u64;
                let mut $md = make_midprice_account_data(mid_price, ask_size, &$auth);
                let $mi =
                    create_account_info(&$mp, true, &mut $ml, &mut $md[..], &midprice_prog_id);
            };
        }
        one_amm!(auth0, pda0, mu0, mu_i0, mp0, ml0, md0, mi0);
        one_amm!(auth1, pda1, mu1, mu_i1, mp1, ml1, md1, mi1);
        one_amm!(auth2, pda2, mu2, mu_i2, mp2, ml2, md2, mi2);
        one_amm!(auth3, pda3, mu3, mu_i3, mp3, ml3, md3, mi3);
        one_amm!(auth4, pda4, mu4, mu_i4, mp4, ml4, md4, mi4);
        one_amm!(auth5, pda5, mu5, mu_i5, mp5, ml5, md5, mi5);
        one_amm!(auth6, pda6, mu6, mu_i6, mp6, ml6, md6, mi6);
        one_amm!(auth7, pda7, mu7, mu_i7, mp7, ml7, md7, mi7);

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
            mi0,
            mu_i0,
            mi1,
            mu_i1,
            mi2,
            mu_i2,
            mi3,
            mu_i3,
            mi4,
            mu_i4,
            mi5,
            mu_i5,
            mi6,
            mu_i6,
            mi7,
            mu_i7,
        ];
        let slice = remaining.as_slice();
        let (_, amm_views) = parse_amm_views(slice, 1, &program_id, 100, None, None).unwrap();
        // Keep taker size modest so total quote fits in i64
        let taker_size = 8 * 5 * BASE_PRECISION_U64;
        let result = run_prop_amm_matching(
            &amm_views,
            slice,
            PositionDirection::Long,
            101 * PRICE_PRECISION_U64,
            taker_size,
        )
        .unwrap();
        let total_filled: u64 = result.external_fills.iter().map(|p| p.fill.fill_size).sum();
        assert!(total_filled > 0);
        assert!(result.external_fills.len() >= 1);
    }

    // -----------------------------------------------------------------------
    // TTL enforcement tests
    // -----------------------------------------------------------------------

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

    /// TTL=0 means no expiry; quote is accepted regardless of slot age.
    #[test]
    fn ttl_disabled_quote_accepted() {
        let program_id = drift_program_id();
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

        let result =
            read_external_mid_price(&midprice_info, &midprice_prog_id, &maker_user_info, 999_999);
        assert!(result.is_ok());
        let (returned_mid_price, _sequence_number, _market_index) = result.unwrap();
        assert_eq!(returned_mid_price, mid_price);
    }

    /// Quote within TTL window is accepted.
    #[test]
    fn ttl_within_window_accepted() {
        let program_id = drift_program_id();
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
        let program_id = drift_program_id();
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
        let program_id = drift_program_id();
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

    /// Insolvent makers are skipped; only solvent makers are included in filtered result (skip semantics).
    #[test]
    fn filter_prop_amm_makers_by_margin_skips_insolvent_maker() {
        use crate::state::oracle_map::OracleMap;
        let slot = 0_u64;
        let program_id = drift_program_id();
        let oracle_key = Pubkey::from_str("J83w4HKfqxwcq3BEMMkPFSppX3gqekLyLJBexebFVkix").unwrap();
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
        let oracle_key = Pubkey::from_str("J83w4HKfqxwcq3BEMMkPFSppX3gqekLyLJBexebFVkix").unwrap();
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
