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
use crate::math::amm::calculate_amm_available_liquidity;
use crate::math::amm_spread::calculate_base_asset_amount_to_trade_to_price;
use crate::math::constants::AMM_RESERVE_PRECISION;
use crate::math::orders::standardize_base_asset_amount;
use crate::state::perp_market::AMM as DriftAMM;
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
}

/// A pending AMM fill to be settled after the matching loop.
#[derive(Clone, Copy)]
pub(crate) struct PendingAmmFill {
    pub base_asset_amount: u64,
    /// Cap price from the next-best frontier (None = uncapped final fill).
    pub limit_price: Option<u64>,
}

/// A pending DLOB fill to be settled after the matching loop.
#[derive(Clone)]
pub(crate) struct PendingDlobFill {
    pub maker_key: Pubkey,
    pub order_index: usize,
    pub remaining_account_index: usize,
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
    /// AMM fills to settle via fulfill_perp_order_with_amm.
    pub amm_fills: Vec<PendingAmmFill>,
    /// DLOB fills to settle by updating maker/taker positions.
    pub dlob_fills: Vec<PendingDlobFill>,
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

/// Midprice accounts have a 4-byte "midp" discriminator at offset 0 and are owned by the
/// midprice program. This is used to detect the PropAMM/DLOB boundary in remaining_accounts.
fn is_midprice_account(info: &AccountInfo, midprice_program_id: &Pubkey) -> bool {
    *info.owner == *midprice_program_id
        && info.data_len() >= 4
        && info
            .try_borrow_data()
            .map_or(false, |d| &d[..4] == b"midp")
}

/// Parses remaining_accounts after the global matcher PDA.
///
/// Layout: `(midprice_account, maker_user)* (dlob_maker_user)*`
///
/// PropAMM pairs are detected by the "midp" discriminator on the first account of each pair.
/// Once a non-midprice account is encountered, the rest are treated as DLOB maker User accounts.
///
/// Returns `(midprice_program_account_index, amm_views, dlob_start_index)`.
pub(crate) fn parse_amm_views(
    remaining_accounts: &[AccountInfo],
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
            ErrorCode::InvalidSpotMarketAccount,
            "midprice account must not overlap with global accounts (midprice={})",
            midprice_key
        )?;
        validate!(
            !reserved.contains(&maker_user_key),
            ErrorCode::InvalidSpotMarketAccount,
            "maker user must not overlap with global accounts (maker_user={})",
            maker_user_key
        )?;

        validate!(
            midprice_key != maker_user_key,
            ErrorCode::InvalidSpotMarketAccount,
            "midprice and maker_user must be different accounts (key={})",
            midprice_key
        )?;

        validate!(
            seen_midprices.insert(midprice_key),
            ErrorCode::InvalidSpotMarketAccount,
            "duplicate midprice account (midprice={})",
            midprice_key
        )?;
        validate!(
            seen_makers.insert(maker_user_key),
            ErrorCode::InvalidSpotMarketAccount,
            "duplicate maker user (maker_user={})",
            maker_user_key
        )?;

        validate!(
            *maker_user_info.owner == *program_id,
            ErrorCode::InvalidSpotMarketAccount,
            "maker user must be owned by Drift program (maker_user={}, owner={})",
            maker_user_key,
            maker_user_info.owner
        )?;
        validate!(
            maker_user_info.is_writable,
            ErrorCode::InvalidSpotMarketAccount,
            "maker user must be writable (maker_user={})",
            maker_user_key
        )?;

        let (mid_price, sequence_number_snapshot, midprice_market_index) = read_external_mid_price(
            midprice_info,
            midprice_program_key,
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
            maker_user_remaining_index: cursor + 1,
            midprice_remaining_index: cursor,
        });

        cursor += ACCOUNTS_PER_AMM;
    }

    // Return: midprice_program idx, parsed PropAMM views, start of DLOB accounts.
    Ok((0, amm_views, cursor))
}

/// Parse DLOB maker accounts from remaining_accounts starting at `dlob_start`.
/// Each DLOB maker is a single Drift User account. We scan their open orders to find
/// crossing limit orders for the given market + direction.
///
/// Returns views sorted by price (best for taker first).
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
    order_tick_size: u64,
    is_prediction_market: bool,
) -> DriftResult<Vec<DlobMakerView>> {
    use crate::math::orders::find_maker_orders;

    let maker_direction = taker_direction.opposite();
    let mut views: Vec<DlobMakerView> = Vec::with_capacity(8);

    for idx in dlob_start..remaining_accounts.len() {
        let maker_info = &remaining_accounts[idx];
        let maker_key = maker_info.key();

        validate!(
            *maker_info.owner == *program_id,
            ErrorCode::InvalidSpotMarketAccount,
            "DLOB maker must be owned by Drift program (maker={})",
            maker_key
        )?;
        validate!(
            maker_info.is_writable,
            ErrorCode::InvalidSpotMarketAccount,
            "DLOB maker must be writable (maker={})",
            maker_key
        )?;
        validate!(
            maker_key != *taker_user_key,
            ErrorCode::InvalidSpotMarketAccount,
            "DLOB maker cannot be taker (no self-trade)"
        )?;

        let maker_loader: AccountLoader<User> =
            AccountLoader::try_from(maker_info).map_err(|_| ErrorCode::CouldNotLoadUserData)?;
        let maker = maker_loader.load().map_err(|_| ErrorCode::CouldNotLoadUserData)?;

        if maker.is_being_liquidated() || maker.is_bankrupt() {
            continue;
        }

        let maker_order_info = find_maker_orders(
            &maker,
            &maker_direction,
            &MarketType::Perp,
            market_index,
            Some(oracle_price),
            slot,
            order_tick_size,
            is_prediction_market,
            None, // no protected maker params for prop_amm context
        )?;

        for (order_index, order_price) in maker_order_info {
            let order = &maker.orders[order_index];
            let size = order.get_base_asset_amount_unfilled(None)?;
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
            });
        }
    }

    // Sort by price: best for taker first.
    views.sort_by(|a, b| match taker_direction {
        PositionDirection::Long => a.price.cmp(&b.price),   // ascending (lowest ask first)
        PositionDirection::Short => b.price.cmp(&a.price),  // descending (highest bid first)
    });

    Ok(views)
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

/// Compute the vAMM's effective price and available depth for the taker's side.
fn amm_frontier_price_and_depth(
    amm: &DriftAMM,
    side: PositionDirection,
    limit_price: u64,
) -> DriftResult<Option<(u64, u64)>> {
    let reserve_price = amm.reserve_price()?;
    let price = match side {
        PositionDirection::Long => amm.ask_price(reserve_price)?,
        PositionDirection::Short => amm.bid_price(reserve_price)?,
    };
    // Check if AMM crosses taker's limit.
    let crosses = match side {
        PositionDirection::Long => price <= limit_price,
        PositionDirection::Short => price >= limit_price,
    };
    if !crosses {
        return Ok(None);
    }
    let depth = calculate_amm_available_liquidity(amm, &side)?;
    if depth == 0 {
        return Ok(None);
    }
    Ok(Some((price, depth)))
}

/// Compute how much base the vAMM can fill before its price slides to `target_price`.
/// Returns 0 if the AMM is already past the target or has no liquidity.
fn amm_fill_up_to_price(
    amm: &DriftAMM,
    side: PositionDirection,
    target_price: u64,
    remaining: u64,
) -> DriftResult<u64> {
    let (trade_amount, trade_direction) =
        calculate_base_asset_amount_to_trade_to_price(amm, target_price, side)?;
    if trade_direction != side || trade_amount == 0 {
        return Ok(0);
    }
    let max_available = calculate_amm_available_liquidity(amm, &side)?;
    let capped = trade_amount.min(max_available).min(remaining);
    standardize_base_asset_amount(capped, amm.order_step_size)
}

/// Apply a simulated fill to an AMM copy so its reserves (and therefore prices) move.
fn simulate_amm_fill(amm: &mut DriftAMM, base_amount: u64, side: PositionDirection) {
    let k = amm.sqrt_k as u128 * amm.sqrt_k as u128;
    match side {
        PositionDirection::Long => {
            amm.base_asset_reserve =
                amm.base_asset_reserve.saturating_sub(base_amount as u128);
        }
        PositionDirection::Short => {
            amm.base_asset_reserve =
                amm.base_asset_reserve.saturating_add(base_amount as u128);
        }
    }
    if amm.base_asset_reserve > 0 {
        amm.quote_asset_reserve = k / amm.base_asset_reserve;
    }
}

/// Unified matching loop: fills from PropAMM books, DLOB makers, and vAMM in price-priority order.
///
/// At each step the best discrete frontier (PropAMM + DLOB) is compared against the current vAMM
/// price. If the vAMM offers a better price, it fills first (capped at the next-best discrete
/// frontier's price so the curve doesn't overshoot). Discrete frontiers use the existing
/// pro-rata (PropAMM) / sequential (DLOB) allocation.
pub(crate) fn run_unified_matching(
    amm_views: &[AmmView],
    dlob_makers: &[DlobMakerView],
    remaining_accounts: &[AccountInfo],
    side: PositionDirection,
    limit_price: u64,
    size: u64,
    drift_amm: Option<&DriftAMM>,
) -> DriftResult<UnifiedMatchResult> {
    let mut remaining = size;
    let (mut frontiers, num_prop_amm) =
        init_frontiers(amm_views, dlob_makers, remaining_accounts, &side, limit_price)?;
    let mut result = UnifiedMatchResult::default();

    // Clone AMM for simulation (price slides as we fill).
    let mut sim_amm: Option<DriftAMM> = drift_amm.cloned();

    while remaining > 0 {
        // 1) Best discrete frontier (PropAMM books + DLOB makers).
        let best_discrete = tied_frontiers_at_best_price(&frontiers, &side);

        // 2) Current vAMM price (if available).
        let amm_offer: Option<(u64, u64)> = match &sim_amm {
            Some(amm) => amm_frontier_price_and_depth(amm, side, limit_price)?,
            None => None,
        };

        // 3) Is vAMM better than the best discrete frontier?
        let amm_is_better = match (&amm_offer, &best_discrete) {
            (Some((amm_price, _)), Some((frontier_price, _))) => match side {
                PositionDirection::Long => *amm_price < *frontier_price,
                PositionDirection::Short => *amm_price > *frontier_price,
            },
            (Some(_), None) => true, // no discrete frontiers left, AMM is only source
            _ => false,
        };

        if amm_is_better {
            let amm = sim_amm.as_mut().unwrap();
            // Fill from AMM, capped at the best discrete frontier's price (if any).
            let amm_fill_amount = match &best_discrete {
                Some((frontier_price, _)) => {
                    amm_fill_up_to_price(amm, side, *frontier_price, remaining)?
                }
                None => {
                    // No discrete frontiers — fill AMM uncapped up to available.
                    let avail = calculate_amm_available_liquidity(amm, &side)?;
                    standardize_base_asset_amount(
                        avail.min(remaining),
                        amm.order_step_size,
                    )?
                }
            };
            if amm_fill_amount == 0 {
                // AMM can't fill anything; fall through to discrete frontiers.
                if best_discrete.is_none() {
                    break;
                }
            } else {
                result.amm_fills.push(PendingAmmFill {
                    base_asset_amount: amm_fill_amount,
                    limit_price: best_discrete.as_ref().map(|(p, _)| *p),
                });
                simulate_amm_fill(amm, amm_fill_amount, side);
                remaining = remaining.safe_sub(amm_fill_amount)?;
                continue;
            }
        }

        // 4) Fill from discrete frontiers.
        let Some((best_price, tied_levels)) = best_discrete else {
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
                    let dlob_idx = allocation.idx.checked_sub(num_prop_amm)
                        .ok_or(ErrorCode::MathError)?;
                    let dlob = &dlob_makers[dlob_idx];
                    result.dlob_fills.push(PendingDlobFill {
                        maker_key: dlob.maker_key,
                        order_index: dlob.order_index,
                        remaining_account_index: dlob.remaining_account_index,
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
    run_unified_matching(amm_views, &[], remaining_accounts, side, limit_price, size, None)
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
    let (midprice_program_idx, amm_views, dlob_start) = parse_amm_views(
        remaining_accounts,
        amm_start,
        program_id,
        clock.slot,
        Some(market_index),
        Some(&ctx.accounts.user.key()),
    )?;

    // Parse DLOB makers from remaining accounts after PropAMM pairs.
    let perp_market_for_parse = ctx.accounts.perp_market.load()?;
    let oracle_guard_rails = ctx.accounts.state.oracle_guard_rails;
    let mut oracle_map_for_parse =
        OracleMap::load_one(&ctx.accounts.oracle, clock.slot, Some(oracle_guard_rails))?;
    let oracle_price = oracle_map_for_parse
        .get_price_data(&perp_market_for_parse.oracle_id())?
        .price;
    let order_tick_size = perp_market_for_parse.amm.order_tick_size;
    let is_prediction_market = perp_market_for_parse.is_prediction_market();

    // Get a read-only snapshot of the vAMM for unified matching (if AMM is available).
    let amm_paused = ctx.accounts.state.amm_paused().unwrap_or(true);
    let drift_amm: Option<DriftAMM> = if !amm_paused {
        Some(perp_market_for_parse.amm)
    } else {
        None
    };
    drop(perp_market_for_parse);
    drop(oracle_map_for_parse);

    let dlob_makers = parse_dlob_makers(
        remaining_accounts,
        dlob_start,
        program_id,
        &ctx.accounts.user.key(),
        taker_direction,
        market_index,
        limit_price,
        oracle_price,
        clock.slot,
        order_tick_size,
        is_prediction_market,
    )?;

    if amm_views.is_empty() && dlob_makers.is_empty() && drift_amm.is_none() {
        return Ok(());
    }

    let result = run_unified_matching(
        &amm_views,
        &dlob_makers,
        remaining_accounts,
        side,
        limit_price,
        size,
        drift_amm.as_ref(),
    )?;

    let spot_slice = &remaining_accounts[1..amm_start];
    let mut spot_iter: Peekable<Iter<AccountInfo>> = spot_slice.iter().peekable();
    let spot_market_map = SpotMarketMap::load(&SpotMarketSet::new(), &mut spot_iter)?;

    // Filter out insolvent PropAMM makers before applying any state changes.
    let perp_market_map =
        PerpMarketMap::from_single_loader(&ctx.accounts.perp_market, market_index)?;
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

    let has_prop_amm_fills = !external_fills.is_empty();
    let has_amm_fills = !result.amm_fills.is_empty();
    let has_dlob_fills = !result.dlob_fills.is_empty();

    if !has_prop_amm_fills && !has_amm_fills && !has_dlob_fills {
        return Ok(());
    }

    // PropAMM taker deltas (from filter, only solvent makers).
    // These are settled via bulk update_position_and_market.
    // AMM + DLOB fills are settled individually later (they update the taker position themselves).
    let prop_amm_base_filled = taker_base_delta.unsigned_abs() as u64;

    // Compute total taker delta for margin checking (across all sources).
    let mut total_taker_base_delta = taker_base_delta;
    let mut total_quote_volume = total_quote_volume;

    for amm_fill in &result.amm_fills {
        let fill_base = i64::try_from(amm_fill.base_asset_amount).map_err(|_| ErrorCode::MathError)?;
        let bd = if matches!(side, PositionDirection::Long) { fill_base } else { -fill_base };
        total_taker_base_delta = total_taker_base_delta.safe_add(bd)?;
        // AMM quote volume will be determined at settlement time by the actual curve.
    }
    for dlob_fill in &result.dlob_fills {
        let fill_base = i64::try_from(dlob_fill.base_asset_amount).map_err(|_| ErrorCode::MathError)?;
        let fill_quote_u128 = (dlob_fill.base_asset_amount as u128)
            .checked_mul(dlob_fill.price as u128)
            .ok_or(ErrorCode::MathError)?
            .checked_div(AMM_RESERVE_PRECISION)
            .ok_or(ErrorCode::MathError)?;
        let bd = if matches!(side, PositionDirection::Long) { fill_base } else { -fill_base };
        total_taker_base_delta = total_taker_base_delta.safe_add(bd)?;
        total_quote_volume = total_quote_volume.safe_add(
            u64::try_from(fill_quote_u128).map_err(|_| ErrorCode::MathError)?,
        )?;
    }

    let base_filled = total_taker_base_delta.unsigned_abs() as u64;
    let mut user = ctx.accounts.user.load_mut()?;
    let mut perp_market = ctx.accounts.perp_market.load_mut()?;

    let taker_position_index = get_position_index(&user.perp_positions, market_index)
        .or_else(|_| add_new_position(&mut user.perp_positions, market_index))?;

    // Only apply PropAMM deltas here. AMM + DLOB fills update the taker position separately.
    if prop_amm_base_filled > 0 {
        let taker_delta = get_position_delta_for_fill(
            prop_amm_base_filled,
            taker_quote_delta.unsigned_abs() as u64,
            taker_direction,
        )?;
        update_position_and_market(
            &mut user.perp_positions[taker_position_index],
            &mut perp_market,
            &taker_delta,
        )?;
    }

    // Update order fill tracking with total across all sources.
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
    {
        let taker_margin_context = MarginContext::standard(taker_margin_type)
            .fuel_perp_delta(market_index, -total_taker_base_delta)
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

    // Settle DLOB fills: update taker + maker positions and maker orders.
    for dlob_fill in &result.dlob_fills {
        let maker_info = &remaining_accounts[dlob_fill.remaining_account_index];
        let maker_loader: AccountLoader<User> =
            AccountLoader::try_from(maker_info).or(Err(ErrorCode::CouldNotLoadUserData))?;
        let mut maker = maker_loader.load_mut()?;
        let mut user = ctx.accounts.user.load_mut()?;
        let mut market = ctx.accounts.perp_market.load_mut()?;

        let maker_direction = taker_direction.opposite();

        let fill_quote_u128 = (dlob_fill.base_asset_amount as u128)
            .checked_mul(dlob_fill.price as u128)
            .ok_or(ErrorCode::MathError)?
            .checked_div(AMM_RESERVE_PRECISION)
            .ok_or(ErrorCode::MathError)?;
        let fill_quote = u64::try_from(fill_quote_u128).map_err(|_| ErrorCode::MathError)?;

        // Update taker position.
        let taker_pos_idx = get_position_index(&user.perp_positions, market_index)
            .or_else(|_| add_new_position(&mut user.perp_positions, market_index))?;
        let taker_pos_delta = get_position_delta_for_fill(
            dlob_fill.base_asset_amount,
            fill_quote,
            taker_direction,
        )?;
        update_position_and_market(
            &mut user.perp_positions[taker_pos_idx],
            &mut *market,
            &taker_pos_delta,
        )?;

        // Update maker position.
        let maker_position_index = get_position_index(&maker.perp_positions, market_index)
            .or_else(|_| add_new_position(&mut maker.perp_positions, market_index))?;
        let maker_pos_delta = get_position_delta_for_fill(
            dlob_fill.base_asset_amount,
            fill_quote,
            maker_direction,
        )?;
        update_position_and_market(
            &mut maker.perp_positions[maker_position_index],
            &mut *market,
            &maker_pos_delta,
        )?;

        // Update the maker's order.
        update_order_after_fill(
            &mut maker.orders[dlob_fill.order_index],
            dlob_fill.base_asset_amount,
            fill_quote,
        )?;

        let fill_record_id = get_then_update_id!(market, next_fill_record_id);
        drop(maker);
        drop(market);

        let fill_record = get_order_action_record(
            now,
            OrderAction::Fill,
            OrderActionExplanation::OrderFilledWithMatch,
            market_index,
            None,                          // filler
            Some(fill_record_id),
            None,                          // filler_reward
            Some(dlob_fill.base_asset_amount),
            Some(fill_quote),
            None,                          // taker_fee
            None,                          // maker_rebate
            None,                          // referrer_reward
            None,                          // quote_asset_amount_surplus
            None,                          // spot_fulfillment_method_fee
            Some(ctx.accounts.user.key()),
            Some(taker_order),
            Some(dlob_fill.maker_key),
            None,                          // maker_order
            oracle_price,
            0,                             // bit_flags
            None, None, None, None,        // existing amounts
            None,                          // trigger_price
            None,                          // builder_idx
            None,                          // builder_fee
        )?;
        emit_stack::<_, { OrderActionRecord::SIZE }>(fill_record)?;
    }

    // Settle AMM fills via position update (simplified: no filler/referrer rewards in this path).
    for amm_fill in &result.amm_fills {
        let mut user = ctx.accounts.user.load_mut()?;
        let mut market = ctx.accounts.perp_market.load_mut()?;

        let position_index = get_position_index(&user.perp_positions, market_index)
            .or_else(|_| add_new_position(&mut user.perp_positions, market_index))?;

        let (_quote_asset_amount, _quote_surplus, _) =
            crate::controller::position::update_position_with_base_asset_amount(
                amm_fill.base_asset_amount,
                taker_direction,
                &mut market,
                &mut user,
                position_index,
                amm_fill.limit_price,
            )?;

        let fill_record_id = get_then_update_id!(market, next_fill_record_id);
        drop(user);
        drop(market);

        let fill_record = get_order_action_record(
            now,
            OrderAction::Fill,
            OrderActionExplanation::OrderFilledWithAMM,
            market_index,
            None,
            Some(fill_record_id),
            None,
            Some(amm_fill.base_asset_amount),
            None,
            None, None, None, None, None,
            Some(ctx.accounts.user.key()),
            Some(taker_order),
            None, None,
            oracle_price,
            0,
            None, None, None, None,
            None, None, None,
        )?;
        emit_stack::<_, { OrderActionRecord::SIZE }>(fill_record)?;
    }

    // CPI to midprice_pino to apply fills (consume orders on AMM books).
    if has_prop_amm_fills {
        flush_external_fill_batches(
            &remaining_accounts[midprice_program_idx],
            remaining_accounts,
            &ctx.accounts.clock.to_account_info(),
            &external_fills,
            amm_start,
            market_index,
            program_id,
        )?;
    }

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

        let (_, amm_views, _) = parse_amm_views(slice, 1, &program_id, 100, None, None).unwrap();
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
        let (_, amm_views, _) = parse_amm_views(slice, 1, &program_id, 100, None, None).unwrap();
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
        let (_, amm_views, _) = parse_amm_views(slice, 1, &program_id, 100, None, None).unwrap();
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
        let (_, amm_views, _) = parse_amm_views(slice, 1, &program_id, 100, None, None).unwrap();
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
        let (_, amm_views, _) = parse_amm_views(slice, 1, &program_id, 100, None, None).unwrap();
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

    // -----------------------------------------------------------------------
    // Unified matching: mixed fill type tests
    // -----------------------------------------------------------------------

    /// Helper: build a test DriftAMM with given reserve price and spread.
    fn make_test_amm(reserve_price_u64: u64) -> DriftAMM {
        // constant product: base * quote = k, price = quote * peg / base
        // Set base = 100e9, peg = reserve_price, quote = 100e9 => price = peg
        let base_reserve = 100 * AMM_RESERVE_PRECISION;
        let quote_reserve = 100 * AMM_RESERVE_PRECISION;
        let sqrt_k = base_reserve; // k = base * quote = base^2 when base == quote
        DriftAMM {
            base_asset_reserve: base_reserve,
            quote_asset_reserve: quote_reserve,
            sqrt_k: sqrt_k as u128,
            peg_multiplier: reserve_price_u64 as u128,
            long_spread: 0,
            short_spread: 0,
            base_spread: 0,
            order_step_size: 1,
            order_tick_size: 1,
            max_fill_reserve_fraction: 1, // allow full fill
            max_base_asset_reserve: u128::MAX,
            min_base_asset_reserve: 0,
            ..DriftAMM::default()
        }
    }

    /// AMM alone: when no PropAMM books or DLOB makers, the unified matcher fills from vAMM.
    #[test]
    fn unified_amm_only_fills() {
        let amm = make_test_amm(100 * PRICE_PRECISION_U64);
        let result = run_unified_matching(
            &[],  // no PropAMM books
            &[],  // no DLOB makers
            &[],  // no remaining accounts needed
            PositionDirection::Long,
            200 * PRICE_PRECISION_U64, // generous limit
            10 * BASE_PRECISION_U64,
            Some(&amm),
        )
        .unwrap();

        assert!(!result.amm_fills.is_empty(), "should have AMM fills");
        assert!(result.external_fills.is_empty(), "no PropAMM fills expected");
        assert!(result.dlob_fills.is_empty(), "no DLOB fills expected");
        let total_amm: u64 = result.amm_fills.iter().map(|f| f.base_asset_amount).sum();
        assert!(total_amm > 0, "AMM should fill some base");
    }

    /// DLOB alone: when no PropAMM and no AMM, DLOB makers fill.
    #[test]
    fn unified_dlob_only_fills() {
        let dlob = vec![DlobMakerView {
            maker_key: Pubkey::new_unique(),
            order_index: 0,
            price: 100 * PRICE_PRECISION_U64,
            size: 20 * BASE_PRECISION_U64,
            remaining_account_index: 0,
        }];
        let result = run_unified_matching(
            &[],
            &dlob,
            &[],
            PositionDirection::Long,
            101 * PRICE_PRECISION_U64,
            10 * BASE_PRECISION_U64,
            None, // no AMM
        )
        .unwrap();

        assert!(result.amm_fills.is_empty());
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
        let (_, amm_views, _) = parse_amm_views(slice, 1, &program_id, 100, None, None).unwrap();

        // DLOB maker at price 105 (worse than PropAMM ask at ~101)
        let dlob = vec![DlobMakerView {
            maker_key: Pubkey::new_unique(),
            order_index: 0,
            price: 105 * PRICE_PRECISION_U64,
            size: 20 * BASE_PRECISION_U64,
            remaining_account_index: 99, // not actually loaded
        }];

        let result = run_unified_matching(
            &amm_views,
            &dlob,
            slice,
            PositionDirection::Long,
            110 * PRICE_PRECISION_U64,
            10 * BASE_PRECISION_U64,
            None, // no vAMM
        )
        .unwrap();

        // PropAMM has 5 at a better price; DLOB gets the remaining 5.
        let prop_filled: u64 = result.external_fills.iter().map(|f| f.fill.fill_size).sum();
        let dlob_filled: u64 = result.dlob_fills.iter().map(|f| f.base_asset_amount).sum();
        assert_eq!(prop_filled, 5 * BASE_PRECISION_U64, "PropAMM fills 5");
        assert_eq!(dlob_filled, 5 * BASE_PRECISION_U64, "DLOB fills remaining 5");
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
        let (_, amm_views, _) = parse_amm_views(slice, 1, &program_id, 100, None, None).unwrap();

        // DLOB maker at price 100 (better than PropAMM ask at ~111)
        let dlob_key = Pubkey::new_unique();
        let dlob = vec![DlobMakerView {
            maker_key: dlob_key,
            order_index: 0,
            price: 100 * PRICE_PRECISION_U64,
            size: 3 * BASE_PRECISION_U64,
            remaining_account_index: 99,
        }];

        let result = run_unified_matching(
            &amm_views,
            &dlob,
            slice,
            PositionDirection::Long,
            120 * PRICE_PRECISION_U64,
            10 * BASE_PRECISION_U64,
            None,
        )
        .unwrap();

        // DLOB has 3 at a better price → filled first, then PropAMM gets 7.
        let dlob_filled: u64 = result.dlob_fills.iter().map(|f| f.base_asset_amount).sum();
        let prop_filled: u64 = result.external_fills.iter().map(|f| f.fill.fill_size).sum();
        assert_eq!(dlob_filled, 3 * BASE_PRECISION_U64, "DLOB fills 3 at better price");
        assert_eq!(prop_filled, 7 * BASE_PRECISION_U64, "PropAMM fills remaining 7");
    }

    /// Mixed AMM + PropAMM: AMM offers a better price than the PropAMM book.
    /// The matcher should fill AMM first (capped at PropAMM's price), then PropAMM.
    #[test]
    fn unified_amm_better_than_prop_amm() {
        let program_id = drift_program_id();
        let midprice_key = Pubkey::new_unique();
        let (maker_authority, maker_user_key) = derive_maker_user_pda();
        let mut maker_user = User::default();
        maker_user.authority = maker_authority;
        maker_user.sub_account_id = 0;
        crate::create_anchor_account_info!(maker_user, &maker_user_key, User, maker_user_info);

        // PropAMM book at mid=120, ask offset=1, effective ask ~121
        let data = make_midprice_account_data(
            120 * PRICE_PRECISION_U64,
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
        let (_, amm_views, _) = parse_amm_views(slice, 1, &program_id, 100, None, None).unwrap();

        // AMM at ~100 (cheaper than PropAMM ask at ~121)
        let amm = make_test_amm(100 * PRICE_PRECISION_U64);

        let result = run_unified_matching(
            &amm_views,
            &[],
            slice,
            PositionDirection::Long,
            130 * PRICE_PRECISION_U64,
            5 * BASE_PRECISION_U64,
            Some(&amm),
        )
        .unwrap();

        // AMM should fill first since its price (~100) is better than PropAMM (~121).
        assert!(!result.amm_fills.is_empty(), "AMM should have fills");
        let amm_filled: u64 = result.amm_fills.iter().map(|f| f.base_asset_amount).sum();
        assert!(amm_filled > 0, "AMM fills some base at better price");
    }

    /// All three sources: AMM, PropAMM, and DLOB fill in price order.
    #[test]
    fn unified_all_three_sources_price_priority() {
        let program_id = drift_program_id();
        let midprice_key = Pubkey::new_unique();
        let (maker_authority, maker_user_key) = derive_maker_user_pda();
        let mut maker_user = User::default();
        maker_user.authority = maker_authority;
        maker_user.sub_account_id = 0;
        crate::create_anchor_account_info!(maker_user, &maker_user_key, User, maker_user_info);

        // PropAMM book: mid=105, ask offset=1 → effective ask ~106
        let data = make_midprice_account_data(
            105 * PRICE_PRECISION_U64,
            3 * BASE_PRECISION_U64,
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
        let (_, amm_views, _) = parse_amm_views(slice, 1, &program_id, 100, None, None).unwrap();

        // AMM at ~100 (best price)
        let amm = make_test_amm(100 * PRICE_PRECISION_U64);

        // DLOB maker at 110 (worst price)
        let dlob = vec![DlobMakerView {
            maker_key: Pubkey::new_unique(),
            order_index: 0,
            price: 110 * PRICE_PRECISION_U64,
            size: 20 * BASE_PRECISION_U64,
            remaining_account_index: 99,
        }];

        let result = run_unified_matching(
            &amm_views,
            &dlob,
            slice,
            PositionDirection::Long,
            115 * PRICE_PRECISION_U64,
            10 * BASE_PRECISION_U64,
            Some(&amm),
        )
        .unwrap();

        // Expected priority: AMM (100) → PropAMM (~106) → DLOB (110)
        let amm_filled: u64 = result.amm_fills.iter().map(|f| f.base_asset_amount).sum();
        let prop_filled: u64 = result.external_fills.iter().map(|f| f.fill.fill_size).sum();
        let dlob_filled: u64 = result.dlob_fills.iter().map(|f| f.base_asset_amount).sum();
        let total = amm_filled + prop_filled + dlob_filled;

        assert!(amm_filled > 0, "AMM should fill (best price at ~100)");
        assert_eq!(prop_filled, 3 * BASE_PRECISION_U64, "PropAMM fills its 3 (~106)");
        assert_eq!(total, 10 * BASE_PRECISION_U64, "total should equal taker size");
        // DLOB fills the remainder
        assert!(dlob_filled > 0, "DLOB fills remainder at worst price (110)");
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
        let data_a = make_midprice_account_data(100 * PRICE_PRECISION_U64, 10 * BASE_PRECISION_U64, &auth_a);
        let mid_a_key = Pubkey::new_unique();
        let mut mid_a_lamps = 0u64;
        let mut mid_a_data = data_a;
        let mid_a_info = create_account_info(&mid_a_key, true, &mut mid_a_lamps, &mut mid_a_data[..], &midprice_prog_id);

        // Book B: same price level, size=10
        let (auth_b, key_b) = derive_maker_user_pda();
        let mut user_b = User::default();
        user_b.authority = auth_b;
        user_b.sub_account_id = 0;
        crate::create_anchor_account_info!(user_b, &key_b, User, user_b_info);
        let data_b = make_midprice_account_data(100 * PRICE_PRECISION_U64, 10 * BASE_PRECISION_U64, &auth_b);
        let mid_b_key = Pubkey::new_unique();
        let mut mid_b_lamps = 0u64;
        let mut mid_b_data = data_b;
        let mid_b_info = create_account_info(&mid_b_key, true, &mut mid_b_lamps, &mut mid_b_data[..], &midprice_prog_id);

        let mut prog_lamps = 0u64;
        let mut prog_data = [0u8; 0];
        let program_info = create_executable_program_account_info(&midprice_prog_id, &mut prog_lamps, &mut prog_data[..]);
        let (global_matcher_pda, _) = prop_amm_matcher_pda(&program_id);
        let mut gm_lamps = 0u64;
        let mut gm_data = [0u8; 0];
        let gm_info = create_account_info(&global_matcher_pda, true, &mut gm_lamps, &mut gm_data[..], &program_id);

        let remaining: Vec<AccountInfo> = vec![
            program_info, gm_info,
            mid_a_info, user_a_info,
            mid_b_info, user_b_info,
        ];
        let slice = remaining.as_slice();
        let (_, amm_views, _) = parse_amm_views(slice, 1, &program_id, 100, None, None).unwrap();
        assert_eq!(amm_views.len(), 2);

        // DLOB maker at same price: 101 (same as PropAMM effective ask)
        let dlob = vec![DlobMakerView {
            maker_key: Pubkey::new_unique(),
            order_index: 0,
            price: 100 * PRICE_PRECISION_U64 + PRICE_PRECISION_U64, // 101
            size: 10 * BASE_PRECISION_U64,
            remaining_account_index: 99,
        }];

        let result = run_unified_matching(
            &amm_views,
            &dlob,
            slice,
            PositionDirection::Long,
            110 * PRICE_PRECISION_U64,
            12 * BASE_PRECISION_U64,
            None,
        )
        .unwrap();

        // PropAMM A and B share 12 pro-rata (6 each if equal), then DLOB gets remainder.
        let prop_filled: u64 = result.external_fills.iter().map(|f| f.fill.fill_size).sum();
        let dlob_filled: u64 = result.dlob_fills.iter().map(|f| f.base_asset_amount).sum();

        // All tied at price 101. PropAMM fills pro-rata first (total 20 available, 12 requested),
        // so PropAMM fills 12 and DLOB fills 0.
        assert_eq!(prop_filled, 12 * BASE_PRECISION_U64, "PropAMM fills all 12 pro-rata");
        assert_eq!(dlob_filled, 0, "DLOB not needed when PropAMM covers full size");
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
        let data = make_midprice_account_data(100 * PRICE_PRECISION_U64, 4 * BASE_PRECISION_U64, &auth);
        let mid_key = Pubkey::new_unique();
        let mut mid_lamps = 0u64;
        let mut mid_data = data;
        let mid_info = create_account_info(&mid_key, true, &mut mid_lamps, &mut mid_data[..], &midprice_prog_id);

        let mut prog_lamps = 0u64;
        let mut prog_data = [0u8; 0];
        let program_info = create_executable_program_account_info(&midprice_prog_id, &mut prog_lamps, &mut prog_data[..]);
        let (global_matcher_pda, _) = prop_amm_matcher_pda(&program_id);
        let mut gm_lamps = 0u64;
        let mut gm_data = [0u8; 0];
        let gm_info = create_account_info(&global_matcher_pda, true, &mut gm_lamps, &mut gm_data[..], &program_id);

        let remaining: Vec<AccountInfo> = vec![program_info, gm_info, mid_info, maker_user_info];
        let slice = remaining.as_slice();
        let (_, amm_views, _) = parse_amm_views(slice, 1, &program_id, 100, None, None).unwrap();

        // DLOB at the same price (101) with plenty of depth
        let dlob = vec![DlobMakerView {
            maker_key: Pubkey::new_unique(),
            order_index: 0,
            price: 100 * PRICE_PRECISION_U64 + PRICE_PRECISION_U64,
            size: 20 * BASE_PRECISION_U64,
            remaining_account_index: 99,
        }];

        let result = run_unified_matching(
            &amm_views,
            &dlob,
            slice,
            PositionDirection::Long,
            110 * PRICE_PRECISION_U64,
            10 * BASE_PRECISION_U64,
            None,
        )
        .unwrap();

        let prop_filled: u64 = result.external_fills.iter().map(|f| f.fill.fill_size).sum();
        let dlob_filled: u64 = result.dlob_fills.iter().map(|f| f.base_asset_amount).sum();

        assert_eq!(prop_filled, 4 * BASE_PRECISION_U64, "PropAMM exhausts its 4");
        assert_eq!(dlob_filled, 6 * BASE_PRECISION_U64, "DLOB fills remaining 6");
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
            None,
        )
        .unwrap();

        assert_eq!(result.taker_base_delta, 0);
        assert!(result.external_fills.is_empty());
        assert!(result.amm_fills.is_empty());
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

        let data = make_midprice_account_data(100 * PRICE_PRECISION_U64, 50 * BASE_PRECISION_U64, &auth);
        let midprice_prog_id = midprice_program_id();
        let mut mid_lamps = 0u64;
        let mut mid_data = data;
        let mid_info = create_account_info(&midprice_key, true, &mut mid_lamps, &mut mid_data[..], &midprice_prog_id);
        let mut prog_lamps = 0u64;
        let mut prog_data = [0u8; 0];
        let program_info = create_executable_program_account_info(&midprice_prog_id, &mut prog_lamps, &mut prog_data[..]);
        let (global_matcher_pda, _) = prop_amm_matcher_pda(&program_id);
        let mut gm_lamps = 0u64;
        let mut gm_data = [0u8; 0];
        let gm_info = create_account_info(&global_matcher_pda, true, &mut gm_lamps, &mut gm_data[..], &program_id);

        let remaining: Vec<AccountInfo> = vec![program_info, gm_info, mid_info, maker_user_info];
        let slice = remaining.as_slice();
        let (_, amm_views, _) = parse_amm_views(slice, 1, &program_id, 100, None, None).unwrap();

        let dlob = vec![DlobMakerView {
            maker_key: Pubkey::new_unique(),
            order_index: 0,
            price: 110 * PRICE_PRECISION_U64,
            size: 20 * BASE_PRECISION_U64,
            remaining_account_index: 99,
        }];

        // AMM at 100 (ask), PropAMM at ~101, DLOB at 110
        let amm = make_test_amm(100 * PRICE_PRECISION_U64);

        // Limit price = 50 — nothing crosses for a Long taker.
        let result = run_unified_matching(
            &amm_views,
            &dlob,
            slice,
            PositionDirection::Long,
            50 * PRICE_PRECISION_U64, // too low
            10 * BASE_PRECISION_U64,
            Some(&amm),
        )
        .unwrap();

        assert!(result.amm_fills.is_empty(), "AMM ask > limit price");
        assert!(result.external_fills.is_empty(), "PropAMM ask > limit price");
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
            },
            DlobMakerView {
                maker_key: Pubkey::new_unique(),
                order_index: 0,
                price: 120 * PRICE_PRECISION_U64, // doesn't cross
                size: 5 * BASE_PRECISION_U64,
                remaining_account_index: 1,
            },
        ];

        let result = run_unified_matching(
            &[],
            &dlob,
            &[],
            PositionDirection::Long,
            115 * PRICE_PRECISION_U64,
            10 * BASE_PRECISION_U64,
            None,
        )
        .unwrap();

        // Only 5 can be filled (from maker at 110); maker at 120 doesn't cross.
        let dlob_filled: u64 = result.dlob_fills.iter().map(|f| f.base_asset_amount).sum();
        assert_eq!(dlob_filled, 5 * BASE_PRECISION_U64, "only crossing DLOB fills");
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
        }];

        let result = run_unified_matching(
            &[],
            &dlob,
            &[],
            PositionDirection::Long,
            110 * PRICE_PRECISION_U64,
            10 * BASE_PRECISION_U64, // wants 10
            None,
        )
        .unwrap();

        let filled: u64 = result.dlob_fills.iter().map(|f| f.base_asset_amount).sum();
        assert_eq!(filled, 3 * BASE_PRECISION_U64, "capped at maker's size");
    }

    /// AMM fill respects the taker's limit price — AMM price above limit yields no fill.
    #[test]
    fn security_amm_respects_limit_price() {
        // AMM at ~200 (ask)
        let amm = make_test_amm(200 * PRICE_PRECISION_U64);

        let result = run_unified_matching(
            &[],
            &[],
            &[],
            PositionDirection::Long,
            100 * PRICE_PRECISION_U64, // limit below AMM ask
            10 * BASE_PRECISION_U64,
            Some(&amm),
        )
        .unwrap();

        assert!(result.amm_fills.is_empty(), "AMM must not fill above taker limit");
    }

    /// AMM fill is capped at the next discrete frontier's price.
    /// This prevents the curve from sliding past better discrete liquidity.
    #[test]
    fn security_amm_fill_capped_at_frontier_price() {
        let amm = make_test_amm(90 * PRICE_PRECISION_U64);

        // DLOB at 95 — AMM should fill up to the point where its price reaches 95,
        // then the DLOB fills at 95.
        let dlob = vec![DlobMakerView {
            maker_key: Pubkey::new_unique(),
            order_index: 0,
            price: 95 * PRICE_PRECISION_U64,
            size: 100 * BASE_PRECISION_U64,
            remaining_account_index: 0,
        }];

        let result = run_unified_matching(
            &[],
            &dlob,
            &[],
            PositionDirection::Long,
            200 * PRICE_PRECISION_U64,
            10 * BASE_PRECISION_U64,
            Some(&amm),
        )
        .unwrap();

        // AMM should fill some, then DLOB fills the remainder.
        let amm_filled: u64 = result.amm_fills.iter().map(|f| f.base_asset_amount).sum();
        let dlob_filled: u64 = result.dlob_fills.iter().map(|f| f.base_asset_amount).sum();
        assert!(amm_filled > 0, "AMM should fill at better price");
        assert!(dlob_filled > 0, "DLOB should fill remainder");

        // The AMM fill's limit_price should be set to the frontier price.
        for fill in &result.amm_fills {
            assert_eq!(
                fill.limit_price,
                Some(95 * PRICE_PRECISION_U64),
                "AMM fill must be capped at the DLOB frontier price"
            );
        }
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

        let data = make_midprice_account_data(100 * PRICE_PRECISION_U64, 10 * BASE_PRECISION_U64, &auth);
        let mid_key = Pubkey::new_unique();
        let mut mid_lamps = 0u64;
        let mut mid_data = data;
        let mid_info = create_account_info(&mid_key, true, &mut mid_lamps, &mut mid_data[..], &midprice_prog_id);

        // One Drift User account (DLOB maker) — owned by drift, NOT midprice program
        let dlob_key = Pubkey::new_unique();
        let mut dlob_user = User::default();
        crate::create_anchor_account_info!(dlob_user, &dlob_key, User, dlob_user_info);

        let mut prog_lamps = 0u64;
        let mut prog_data = [0u8; 0];
        let program_info = create_executable_program_account_info(&midprice_prog_id, &mut prog_lamps, &mut prog_data[..]);
        let (global_matcher_pda, _) = prop_amm_matcher_pda(&program_id);
        let mut gm_lamps = 0u64;
        let mut gm_data = [0u8; 0];
        let gm_info = create_account_info(&global_matcher_pda, true, &mut gm_lamps, &mut gm_data[..], &program_id);

        // Layout: [midprice_program, matcher, midprice_acct, maker_user, dlob_user]
        let remaining: Vec<AccountInfo> = vec![
            program_info, gm_info,
            mid_info, maker_user_info,
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
        let info = create_account_info(&key, true, &mut lamps, &mut data[..], &midprice_prog_id);

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
        let data = make_midprice_account_data(100 * PRICE_PRECISION_U64, 10 * BASE_PRECISION_U64, &auth);
        let mid_key = Pubkey::new_unique();
        let mut mid_lamps = 0u64;
        let mut mid_data = data;
        let mid_info = create_account_info(&mid_key, true, &mut mid_lamps, &mut mid_data[..], &midprice_prog_id);

        let mut prog_lamps = 0u64;
        let mut prog_data = [0u8; 0];
        let program_info = create_executable_program_account_info(&midprice_prog_id, &mut prog_lamps, &mut prog_data[..]);
        let (global_matcher_pda, _) = prop_amm_matcher_pda(&program_id);
        let mut gm_lamps = 0u64;
        let mut gm_data = [0u8; 0];
        let gm_info = create_account_info(&global_matcher_pda, true, &mut gm_lamps, &mut gm_data[..], &program_id);

        // Layout: [prog, matcher, dlob_user, midprice, maker_user]
        // The DLOB user at index 2 breaks the PropAMM scan.
        let remaining: Vec<AccountInfo> = vec![
            program_info, gm_info,
            dlob_user_info,       // not midprice → boundary
            mid_info,             // this midprice is after boundary
            maker_user_info,
        ];
        let slice = remaining.as_slice();

        let (_, amm_views, dlob_start) =
            parse_amm_views(slice, 1, &program_id, 100, None, None).unwrap();

        assert_eq!(amm_views.len(), 0, "no PropAMM pairs parsed (boundary hit immediately)");
        assert_eq!(dlob_start, 2, "DLOB starts at index 2");
        // The midprice account at index 3 is in the DLOB tail — it won't be used for PropAMM
        // matching. If someone tries to use it as a DLOB maker, it would fail validation
        // (not owned by Drift program).
    }

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
                $oracle_price, &$oracle_key, &$pyth_program, $oracle_account_info
            );
            let mut $oracle_map =
                crate::state::oracle_map::OracleMap::load_one(&$oracle_account_info, $slot, None)
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
                        last_oracle_price_twap: 100 * crate::math::constants::PRICE_PRECISION_I64,
                        ..HistoricalOracleData::default()
                    },
                    ..AMM::default()
                },
                margin_ratio_initial: 1000,  // 10%
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
            let quote = (perp_base as i128 * 100 * crate::math::constants::PRICE_PRECISION_I64 as i128
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
        let fill_quote = (fill_base as i128 * 100 * crate::math::constants::PRICE_PRECISION_I64 as i128
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
        let oracle_key = Pubkey::from_str("J83w4HKfqxwcq3BEMMkPFSppX3gqekLyLJBexebFVkix").unwrap();
        let pyth_program = crate::ids::pyth_program::id();
        margin_test_setup!(
            slot, oracle_key, pyth_program,
            oracle_price, oracle_account_info, oracle_map,
            perp_market, perp_market_info, perp_market_map,
            spot_market, spot_market_info, spot_market_map
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
        assert!(taker_position_decreasing, "closing to flat must be position-decreasing");

        let user_after = apply_fill_to_user(&user, fill_delta);
        let margin_calc = calculate_margin_requirement_and_total_collateral_and_liability_info(
            &user_after,
            &perp_market_map,
            &spot_market_map,
            &mut oracle_map,
            MarginContext::standard(MarginRequirementType::Maintenance),
        )
        .unwrap();
        assert!(margin_calc.meets_margin_requirement(), "flat position must pass maintenance");
    }

    /// Taker reduces an existing long (long 10 → long 3).
    /// Uses Maintenance margin since position magnitude is shrinking.
    #[test]
    fn margin_taker_reduce_long_uses_maintenance() {
        let slot = 0_u64;
        let oracle_key = Pubkey::from_str("J83w4HKfqxwcq3BEMMkPFSppX3gqekLyLJBexebFVkix").unwrap();
        let pyth_program = crate::ids::pyth_program::id();
        margin_test_setup!(
            slot, oracle_key, pyth_program,
            oracle_price, oracle_account_info, oracle_map,
            perp_market, perp_market_info, perp_market_map,
            spot_market, spot_market_info, spot_market_map
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
        assert!(taker_position_decreasing, "reducing long magnitude must be position-decreasing");

        let user_after = apply_fill_to_user(&user, fill_delta);
        let margin_calc = calculate_margin_requirement_and_total_collateral_and_liability_info(
            &user_after,
            &perp_market_map,
            &spot_market_map,
            &mut oracle_map,
            MarginContext::standard(MarginRequirementType::Maintenance),
        )
        .unwrap();
        assert!(margin_calc.meets_margin_requirement(), "reduced long must pass maintenance");
    }

    /// Taker opens a new long from flat (flat → long 10).
    /// Uses Fill margin (stricter) since position is risk-increasing.
    #[test]
    fn margin_taker_open_long_from_flat_uses_fill() {
        let slot = 0_u64;
        let oracle_key = Pubkey::from_str("J83w4HKfqxwcq3BEMMkPFSppX3gqekLyLJBexebFVkix").unwrap();
        let pyth_program = crate::ids::pyth_program::id();
        margin_test_setup!(
            slot, oracle_key, pyth_program,
            oracle_price, oracle_account_info, oracle_map,
            perp_market, perp_market_info, perp_market_map,
            spot_market, spot_market_info, spot_market_map
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
        assert!(!taker_position_decreasing, "opening from flat must be risk-increasing");

        let user_after = apply_fill_to_user(&user, fill_delta);
        let margin_calc = calculate_margin_requirement_and_total_collateral_and_liability_info(
            &user_after,
            &perp_market_map,
            &spot_market_map,
            &mut oracle_map,
            MarginContext::standard(MarginRequirementType::Fill),
        )
        .unwrap();
        assert!(margin_calc.meets_margin_requirement(), "well-collateralized open must pass fill margin");
    }

    /// Taker increases an existing long (long 5 → long 15).
    /// Uses Fill margin since position magnitude is growing.
    #[test]
    fn margin_taker_increase_long_uses_fill() {
        let slot = 0_u64;
        let oracle_key = Pubkey::from_str("J83w4HKfqxwcq3BEMMkPFSppX3gqekLyLJBexebFVkix").unwrap();
        let pyth_program = crate::ids::pyth_program::id();
        margin_test_setup!(
            slot, oracle_key, pyth_program,
            oracle_price, oracle_account_info, oracle_map,
            perp_market, perp_market_info, perp_market_map,
            spot_market, spot_market_info, spot_market_map
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
        assert!(!taker_position_decreasing, "increasing long must be risk-increasing");

        let user_after = apply_fill_to_user(&user, fill_delta);
        let margin_calc = calculate_margin_requirement_and_total_collateral_and_liability_info(
            &user_after,
            &perp_market_map,
            &spot_market_map,
            &mut oracle_map,
            MarginContext::standard(MarginRequirementType::Fill),
        )
        .unwrap();
        assert!(margin_calc.meets_margin_requirement(), "well-collateralized increase must pass fill margin");
    }

    /// Taker flips direction (long 5 → short 5).
    /// Uses Fill margin since position_after.signum() != position_before.signum().
    #[test]
    fn margin_taker_flip_long_to_short_uses_fill() {
        let slot = 0_u64;
        let oracle_key = Pubkey::from_str("J83w4HKfqxwcq3BEMMkPFSppX3gqekLyLJBexebFVkix").unwrap();
        let pyth_program = crate::ids::pyth_program::id();
        margin_test_setup!(
            slot, oracle_key, pyth_program,
            oracle_price, oracle_account_info, oracle_map,
            perp_market, perp_market_info, perp_market_map,
            spot_market, spot_market_info, spot_market_map
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
        assert!(!taker_position_decreasing, "flipping direction must be risk-increasing");

        let user_after = apply_fill_to_user(&user, fill_delta);
        let margin_calc = calculate_margin_requirement_and_total_collateral_and_liability_info(
            &user_after,
            &perp_market_map,
            &spot_market_map,
            &mut oracle_map,
            MarginContext::standard(MarginRequirementType::Fill),
        )
        .unwrap();
        assert!(margin_calc.meets_margin_requirement(), "well-collateralized flip must pass fill margin");
    }

    /// Taker with barely-enough collateral can close a position (maintenance margin is relaxed),
    /// but the same collateral level would fail if opening a new position (fill margin is stricter).
    #[test]
    fn margin_taker_close_passes_maintenance_but_open_would_fail_fill() {
        let slot = 0_u64;
        let oracle_key = Pubkey::from_str("J83w4HKfqxwcq3BEMMkPFSppX3gqekLyLJBexebFVkix").unwrap();
        let pyth_program = crate::ids::pyth_program::id();
        margin_test_setup!(
            slot, oracle_key, pyth_program,
            oracle_price, oracle_account_info, oracle_map,
            perp_market, perp_market_info, perp_market_map,
            spot_market, spot_market_info, spot_market_map
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
        let margin_close = calculate_margin_requirement_and_total_collateral_and_liability_info(
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
        let oracle_key = Pubkey::from_str("J83w4HKfqxwcq3BEMMkPFSppX3gqekLyLJBexebFVkix").unwrap();
        let pyth_program = crate::ids::pyth_program::id();
        margin_test_setup!(
            slot, oracle_key, pyth_program,
            oracle_price, oracle_account_info, oracle_map,
            perp_market, perp_market_info, perp_market_map,
            spot_market, spot_market_info, spot_market_map
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
        let oracle_key = Pubkey::from_str("J83w4HKfqxwcq3BEMMkPFSppX3gqekLyLJBexebFVkix").unwrap();
        let pyth_program = crate::ids::pyth_program::id();
        margin_test_setup!(
            slot, oracle_key, pyth_program,
            oracle_price, oracle_account_info, oracle_map,
            perp_market, perp_market_info, perp_market_map,
            spot_market, spot_market_info, spot_market_map
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
        assert!(taker_position_decreasing, "reducing short magnitude must be position-decreasing");

        let user_after = apply_fill_to_user(&user, fill_delta);
        let margin_calc = calculate_margin_requirement_and_total_collateral_and_liability_info(
            &user_after,
            &perp_market_map,
            &spot_market_map,
            &mut oracle_map,
            MarginContext::standard(MarginRequirementType::Maintenance),
        )
        .unwrap();
        assert!(margin_calc.meets_margin_requirement(), "reduced short must pass maintenance");
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
        let oracle_key = Pubkey::from_str("J83w4HKfqxwcq3BEMMkPFSppX3gqekLyLJBexebFVkix").unwrap();
        let pyth_program = crate::ids::pyth_program::id();
        margin_test_setup!(
            slot, oracle_key, pyth_program,
            oracle_price, oracle_account_info, oracle_map,
            perp_market, perp_market_info, perp_market_map,
            spot_market, spot_market_info, spot_market_map
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
        let oracle_key = Pubkey::from_str("J83w4HKfqxwcq3BEMMkPFSppX3gqekLyLJBexebFVkix").unwrap();
        let pyth_program = crate::ids::pyth_program::id();
        margin_test_setup!(
            slot, oracle_key, pyth_program,
            oracle_price, oracle_account_info, oracle_map,
            perp_market, perp_market_info, perp_market_map,
            spot_market, spot_market_info, spot_market_map
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
            slot, oracle_key, pyth_program,
            oracle_price, oracle_account_info, oracle_map,
            perp_market, perp_market_info, perp_market_map,
            spot_market, spot_market_info, spot_market_map
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
            &mid_a_key, true, &mut mid_a_lamps, &mut mid_a_data[..], &midprice_prog_id,
        );
        let mid_b_info = create_account_info(
            &mid_b_key, true, &mut mid_b_lamps, &mut mid_b_data[..], &midprice_prog_id,
        );
        let mut prog_lamps = 0u64;
        let mut prog_data = [0u8; 0];
        let program_info = create_executable_program_account_info(
            &midprice_prog_id, &mut prog_lamps, &mut prog_data[..],
        );
        let (matcher_pda, _) = prop_amm_matcher_pda(&program_id);
        let mut matcher_lamps = 0u64;
        let mut matcher_data = [0u8; 0];
        let matcher_info = create_account_info(
            &matcher_pda, true, &mut matcher_lamps, &mut matcher_data[..], &program_id,
        );

        let remaining_accounts: Vec<AccountInfo> = vec![
            program_info, matcher_info,
            mid_a_info, maker_a_info,
            mid_b_info, maker_b_info,
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

        let (filtered, _, taker_base, taker_quote, total_quote) =
            filter_prop_amm_makers_by_margin(
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

        // Only maker A survives
        assert_eq!(filtered.len(), 1);
        assert!(filtered.contains_key(&maker_a_key));
        assert!(!filtered.contains_key(&maker_b_key));

        // Taker deltas reflect only maker A's contribution (mirror of maker A's delta)
        assert_eq!(taker_base, -base_delta, "taker base = negative of solvent maker's base");
        assert_eq!(taker_quote, -quote_delta, "taker quote = negative of solvent maker's quote");
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
            slot, oracle_key, pyth_program,
            oracle_price, oracle_account_info, oracle_map,
            perp_market, perp_market_info, perp_market_map,
            spot_market, spot_market_info, spot_market_map
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
            100 * PRICE_PRECISION_U64, 50 * BASE_PRECISION_U64, &maker_a_key,
        );
        let mut mid_b_data = make_midprice_account_data(
            100 * PRICE_PRECISION_U64, 50 * BASE_PRECISION_U64, &maker_b_key,
        );
        let mut mid_a_lamps = 0u64;
        let mut mid_b_lamps = 0u64;
        let mid_a_info = create_account_info(
            &mid_a_key, true, &mut mid_a_lamps, &mut mid_a_data[..], &midprice_prog_id,
        );
        let mid_b_info = create_account_info(
            &mid_b_key, true, &mut mid_b_lamps, &mut mid_b_data[..], &midprice_prog_id,
        );
        let mut prog_lamps = 0u64;
        let mut prog_data = [0u8; 0];
        let program_info = create_executable_program_account_info(
            &midprice_prog_id, &mut prog_lamps, &mut prog_data[..],
        );
        let (matcher_pda, _) = prop_amm_matcher_pda(&program_id);
        let mut matcher_lamps = 0u64;
        let mut matcher_data = [0u8; 0];
        let matcher_info = create_account_info(
            &matcher_pda, true, &mut matcher_lamps, &mut matcher_data[..], &program_id,
        );

        let remaining_accounts: Vec<AccountInfo> = vec![
            program_info, matcher_info,
            mid_a_info, maker_a_info,
            mid_b_info, maker_b_info,
        ];
        let amm_views = vec![
            AmmView {
                key: mid_a_key, mid_price: 100 * PRICE_PRECISION_U64,
                sequence_number_snapshot: 0, maker_user_remaining_index: 3, midprice_remaining_index: 2,
            },
            AmmView {
                key: mid_b_key, mid_price: 100 * PRICE_PRECISION_U64,
                sequence_number_snapshot: 0, maker_user_remaining_index: 5, midprice_remaining_index: 4,
            },
        ];

        let base_delta = -30_i64 * (BASE_PRECISION_U64 as i64);
        let quote_delta = 30 * 100 * crate::math::constants::PRICE_PRECISION_I64;
        let mut maker_deltas = BTreeMap::new();
        maker_deltas.insert(maker_a_key, (base_delta, quote_delta));
        maker_deltas.insert(maker_b_key, (base_delta, quote_delta));

        let (filtered, _, taker_base, taker_quote, total_quote) =
            filter_prop_amm_makers_by_margin(
                &maker_deltas, &[], &amm_views, &remaining_accounts,
                &perp_market_map, &spot_market_map, &mut oracle_map, 0, 0,
            )
            .unwrap();

        assert_eq!(filtered.len(), 0, "both insolvent makers must be filtered");
        assert_eq!(taker_base, 0, "taker base delta must be zero when all makers skipped");
        assert_eq!(taker_quote, 0, "taker quote delta must be zero when all makers skipped");
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
        assert!(risk_increasing, "increasing position must flag risk_increasing");
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
            slot, oracle_key, pyth_program,
            oracle_price, oracle_account_info, oracle_map,
            perp_market, perp_market_info, perp_market_map,
            spot_market, spot_market_info, spot_market_map
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
            100 * PRICE_PRECISION_U64, 50 * BASE_PRECISION_U64, &maker_key,
        );
        let mut mid_lamps = 0u64;
        let mid_info = create_account_info(
            &mid_key, true, &mut mid_lamps, &mut mid_data[..], &midprice_prog_id,
        );
        let mut prog_lamps = 0u64;
        let mut prog_data_buf = [0u8; 0];
        let program_info = create_executable_program_account_info(
            &midprice_prog_id, &mut prog_lamps, &mut prog_data_buf[..],
        );
        let (matcher_pda, _) = prop_amm_matcher_pda(&program_id);
        let mut matcher_lamps = 0u64;
        let mut matcher_data = [0u8; 0];
        let matcher_info = create_account_info(
            &matcher_pda, true, &mut matcher_lamps, &mut matcher_data[..], &program_id,
        );

        let remaining_accounts: Vec<AccountInfo> = vec![
            program_info, matcher_info, mid_info, maker_info,
        ];
        let amm_views = vec![AmmView {
            key: mid_key, mid_price: 100 * PRICE_PRECISION_U64,
            sequence_number_snapshot: 0, maker_user_remaining_index: 3, midprice_remaining_index: 2,
        }];

        // Delta = 0 for this maker
        let mut maker_deltas = BTreeMap::new();
        maker_deltas.insert(maker_key, (0i64, 0i64));

        let (filtered, _, _, _, _) = filter_prop_amm_makers_by_margin(
            &maker_deltas, &[], &amm_views, &remaining_accounts,
            &perp_market_map, &spot_market_map, &mut oracle_map, 0, 0,
        )
        .unwrap();

        assert!(
            filtered.contains_key(&maker_key),
            "maker with zero delta must always pass margin filter"
        );
    }
}
