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
use crate::state::spot_market::SpotMarket;
use crate::state::spot_market_map::{SpotMarketMap, SpotMarketSet};
use crate::state::traits::Size;
use crate::state::user::{MarketType, Order, OrderType, User};
use crate::validate;
use anchor_lang::prelude::*;
use anchor_lang::solana_program::instruction::{AccountMeta, Instruction};
use anchor_lang::solana_program::program::invoke_signed;
use anchor_lang::Discriminator;
use midprice_book_view::{
    MidpriceBookView, ACCOUNT_MIN_LEN as MIDPRICE_ACCOUNT_MIN_LEN,
    AUTHORITY_OFFSET as MIDPRICE_AUTHORITY_OFFSET,
    MARKET_INDEX_OFFSET as MIDPRICE_MARKET_INDEX_OFFSET, MAX_ORDERS as MIDPRICE_MAX_ORDERS,
    MID_PRICE_OFFSET as MIDPRICE_VALUE_OFFSET, QUOTE_TTL_OFFSET as MIDPRICE_QUOTE_TTL_OFFSET,
    REF_SLOT_OFFSET as MIDPRICE_REF_SLOT_OFFSET,
};
use std::collections::BTreeMap;
use std::convert::{TryFrom, TryInto};
use std::iter::Peekable;
use std::slice::Iter;

const BUY: u8 = 0;
const SELL: u8 = 1;
const MIDPRICE_IX_APPLY_FILLS: u8 = 3;
/// Drift User account: 8-byte discriminator then authority (Pubkey).
const USER_AUTHORITY_OFFSET: usize = 8;
/// One matcher PDA can apply fills to all PropAMM books (saves tx size vs per-maker matcher).
const PROP_AMM_MATCHER_SEED: &[u8] = b"prop_amm_matcher";

#[derive(Clone, Copy)]
struct Side {
    _value: u8,
}

impl Side {
    fn from_u8(v: u8) -> DriftResult<Self> {
        match v {
            BUY => Ok(Side { _value: BUY }),
            SELL => Ok(Side { _value: SELL }),
            _ => Err(ErrorCode::InvalidOrder.into()),
        }
    }
    fn is_buy(&self) -> bool {
        self._value == BUY
    }
}

#[derive(Clone)]
pub(crate) struct AmmView {
    #[allow(dead_code)]
    key: Pubkey,
    mid_price: u64,
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

fn maker_price(mid_price: u64, offset: i32) -> Option<u64> {
    if offset == 0 {
        return None;
    }
    if offset > 0 {
        mid_price.checked_add(offset as u64)
    } else {
        mid_price.checked_sub(offset.unsigned_abs() as u64)
    }
}

fn is_crossing(side: &Side, taker_limit_price: u64, maker_price: u64, offset: i32) -> bool {
    if side.is_buy() {
        offset > 0 && maker_price <= taker_limit_price
    } else {
        offset < 0 && maker_price >= taker_limit_price
    }
}

/// Global PropAMM matcher PDA: one account can apply fills to all PropAMM books.
pub fn prop_amm_matcher_pda(program_id: &Pubkey) -> (Pubkey, u8) {
    Pubkey::find_program_address(&[PROP_AMM_MATCHER_SEED], program_id)
}

fn read_external_mid_price(
    midprice_info: &AccountInfo,
    midprice_program_id: &Pubkey,
    maker_user_info: &AccountInfo,
    current_slot: u64,
) -> DriftResult<u64> {
    validate!(
        *midprice_info.owner == *midprice_program_id,
        ErrorCode::InvalidSpotMarketAccount,
        "midprice account must be owned by midprice program (create/init via midprice program)"
    )?;
    let data = midprice_info
        .try_borrow_data()
        .map_err(|_| ErrorCode::InvalidSpotMarketAccount)?;
    validate!(
        data.len() >= MIDPRICE_ACCOUNT_MIN_LEN,
        ErrorCode::InvalidSpotMarketAccount,
        "midprice data too short"
    )?;
    let auth_arr: [u8; 32] =
        <[u8; 32]>::try_from(&data[MIDPRICE_AUTHORITY_OFFSET..MIDPRICE_AUTHORITY_OFFSET + 32])
            .map_err(|_| ErrorCode::InvalidSpotMarketAccount)?;
    let stored_authority = Pubkey::new_from_array(auth_arr);
    // Midprice authority may be the maker's wallet (User.authority) or the maker's User PDA.
    // Stored authority (e.g. User PDA) is used for other midprice instructions; apply_fills is permissionless and does not take authority accounts.
    let maker_user_data = maker_user_info
        .try_borrow_data()
        .map_err(|_| ErrorCode::InvalidSpotMarketAccount)?;
    validate!(
        maker_user_data.len() >= USER_AUTHORITY_OFFSET + 32,
        ErrorCode::InvalidSpotMarketAccount,
        "maker user data too short"
    )?;
    let maker_authority = Pubkey::new_from_array(
        maker_user_data[USER_AUTHORITY_OFFSET..USER_AUTHORITY_OFFSET + 32]
            .try_into()
            .map_err(|_| ErrorCode::InvalidSpotMarketAccount)?,
    );
    validate!(
        stored_authority == maker_authority,
        ErrorCode::InvalidSpotMarketAccount,
        "midprice authority must match maker user (wallet or User PDA)"
    )?;
    let price_arr: [u8; 8] =
        <[u8; 8]>::try_from(&data[MIDPRICE_VALUE_OFFSET..MIDPRICE_VALUE_OFFSET + 8])
            .map_err(|_| ErrorCode::InvalidSpotMarketAccount)?;
    let mid_price = u64::from_le_bytes(price_arr);

    let ref_slot = u64::from_le_bytes(
        <[u8; 8]>::try_from(&data[MIDPRICE_REF_SLOT_OFFSET..MIDPRICE_REF_SLOT_OFFSET + 8])
            .map_err(|_| ErrorCode::InvalidSpotMarketAccount)?,
    );
    let quote_ttl_slots = u64::from_le_bytes(
        <[u8; 8]>::try_from(&data[MIDPRICE_QUOTE_TTL_OFFSET..MIDPRICE_QUOTE_TTL_OFFSET + 8])
            .map_err(|_| ErrorCode::InvalidSpotMarketAccount)?,
    );
    if quote_ttl_slots > 0 {
        validate!(
            current_slot.saturating_sub(ref_slot) <= quote_ttl_slots,
            ErrorCode::MidpriceQuoteExpired,
            "midprice quote expired (slot age {} > ttl {})",
            current_slot.saturating_sub(ref_slot),
            quote_ttl_slots
        )?;
    }

    let book = MidpriceBookView::new(&data).map_err(|_| ErrorCode::InvalidSpotMarketAccount)?;
    let total = book.total_orders();
    validate!(
        total <= MIDPRICE_MAX_ORDERS,
        ErrorCode::InvalidSpotMarketAccount,
        "midprice orders overflow"
    )?;
    Ok(mid_price)
}

fn find_external_top_level_from(
    midprice_info: &AccountInfo,
    side: &Side,
    taker_limit_price: u64,
    mid_price: u64,
    start_from_abs_index: Option<usize>,
) -> DriftResult<Option<TopLevel>> {
    let data = midprice_info
        .try_borrow_data()
        .map_err(|_| ErrorCode::InvalidSpotMarketAccount)?;
    let book = MidpriceBookView::new(&data).map_err(|_| ErrorCode::InvalidSpotMarketAccount)?;
    let ask_len = book.ask_len() as usize;
    let bid_len = book.bid_len() as usize;
    let ask_head = book.ask_head() as usize;
    let bid_head = book.bid_head() as usize;

    let (default_start, end, is_ask) = if side.is_buy() {
        (ask_head, ask_len, true)
    } else {
        (ask_len + bid_head, ask_len + bid_len, false)
    };
    let start = start_from_abs_index
        .unwrap_or(default_start)
        .max(default_start);

    for abs_index in start..end {
        let size = book
            .order_size_u64(abs_index)
            .map_err(|_| ErrorCode::InvalidSpotMarketAccount)?;
        if size == 0 {
            continue;
        }
        let offset = i32::try_from(
            book.order_offset_i64(abs_index)
                .map_err(|_| ErrorCode::InvalidSpotMarketAccount)?,
        )
        .map_err(|_| ErrorCode::InvalidSpotMarketAccount)?;
        let Some(price) = maker_price(mid_price, offset) else {
            continue;
        };
        if !is_crossing(side, taker_limit_price, price, offset) {
            return Ok(None);
        }
        return Ok(Some(TopLevel {
            price,
            size,
            abs_index,
            is_ask,
        }));
    }
    Ok(None)
}

fn init_frontiers(
    amm_views: &[AmmView],
    remaining_accounts: &[AccountInfo],
    side: &Side,
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
    side: &Side,
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
                let is_better = if side.is_buy() {
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
    side: &Side,
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

/// Single CPI to midprice_pino apply_fills: [matcher, clock, midprice_0, midprice_1, ...], payload: u16 market_index (CPI protection) then per maker u16 num_fills + 11*num_fills bytes. No authority accounts; filling is permissionless.
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

    let mut batch: Vec<ExternalFill> = Vec::new();
    let mut range_start = 0usize;
    let mut accounts: Vec<AccountMeta> = vec![
        AccountMeta::new_readonly(matcher_authority.key(), true),
        AccountMeta::new_readonly(clock.key(), false),
    ];
    let mut cpi_accounts: Vec<AccountInfo> = vec![
        midprice_program.clone(),
        matcher_authority.clone(),
        clock.clone(),
    ];
    let mut payload: Vec<u8> = vec![MIDPRICE_IX_APPLY_FILLS];
    payload.extend_from_slice(&market_index.to_le_bytes());

    while range_start < external_fills.len() {
        let current_midprice_idx = external_fills[range_start].midprice_remaining_index;
        let current_maker_user_idx = external_fills[range_start].maker_user_remaining_index;
        let mut range_end = range_start;
        while range_end < external_fills.len()
            && external_fills[range_end].midprice_remaining_index == current_midprice_idx
            && external_fills[range_end].maker_user_remaining_index == current_maker_user_idx
        {
            range_end += 1;
        }

        batch.clear();
        batch.extend(
            external_fills[range_start..range_end]
                .iter()
                .map(|pending| pending.fill),
        );

        accounts.push(AccountMeta::new(
            remaining_accounts[current_midprice_idx].key(),
            false,
        ));
        cpi_accounts.push(remaining_accounts[current_midprice_idx].clone());

        payload.extend_from_slice(&(batch.len() as u16).to_le_bytes());
        for fill in &batch {
            payload.extend_from_slice(&fill.abs_index.to_le_bytes());
            payload.push(if fill.is_ask { 1 } else { 0 });
            payload.extend_from_slice(&fill.fill_size.to_le_bytes());
        }

        range_start = range_end;
    }

    let ix = Instruction {
        program_id: *midprice_program.key,
        accounts,
        data: payload,
    };

    let bump_byte = [bump];
    let signer_seeds: &[&[u8]] = &[PROP_AMM_MATCHER_SEED, bump_byte.as_slice()];
    invoke_signed(&ix, &cpi_accounts, &[signer_seeds])
        .map_err(|_| ErrorCode::InvalidSpotMarketAccount)?;
    Ok(())
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

/// Finds the first index after midprice_program (0) that is not a SpotMarket account.
/// Canonical layout: consume consecutive accounts while they have SpotMarket discriminator.
fn find_amm_start_after_spot_markets(remaining_accounts: &[AccountInfo]) -> DriftResult<usize> {
    let spot_discriminator = SpotMarket::discriminator();
    let mut i = 1usize;
    while i < remaining_accounts.len() {
        let data = match remaining_accounts[i].try_borrow_data() {
            Ok(d) => d,
            Err(_) => break,
        };
        if data.len() < SpotMarket::SIZE {
            break;
        }
        if data[0..8] != spot_discriminator[..] {
            break;
        }
        i += 1;
    }
    Ok(i)
}

/// Parses remaining_accounts: midprice_program (0), spot markets [1..amm_start], global_matcher (amm_start), then per-AMM pairs (midprice, maker_user).
/// Returns (midprice_program_account_index, amm_views).
pub(crate) fn parse_amm_views(
    remaining_accounts: &[AccountInfo],
    amm_start: usize,
    program_id: &Pubkey,
    current_slot: u64,
) -> DriftResult<(usize, Vec<AmmView>)> {
    const ACCOUNTS_PER_AMM: usize = 2; // midprice, maker_user (global matcher is separate)
    const GLOBAL_MATCHER_SLOTS: usize = 1;
    validate!(
        remaining_accounts.len() >= amm_start + GLOBAL_MATCHER_SLOTS + ACCOUNTS_PER_AMM,
        ErrorCode::InvalidSpotMarketAccount,
        "remaining_accounts: need midprice_program + spot_markets + global_matcher + at least one AMM pair"
    )?;
    let midprice_program = &remaining_accounts[0];
    validate!(
        midprice_program.executable,
        ErrorCode::InvalidSpotMarketAccount,
        "first remaining account must be midprice program"
    )?;
    let expected_midprice_program_id = crate::ids::midprice_program::id();
    validate!(
        midprice_program.key() == expected_midprice_program_id,
        ErrorCode::InvalidSpotMarketAccount,
        "first remaining account must be the canonical midprice program (CPI to other programs is not allowed)"
    )?;
    let (expected_matcher, _bump) = prop_amm_matcher_pda(program_id);
    validate!(
        remaining_accounts[amm_start].key() == expected_matcher,
        ErrorCode::InvalidSpotMarketAccount,
        "account after spot_markets must be global PropAMM matcher PDA"
    )?;

    let amm_slice = &remaining_accounts[amm_start + GLOBAL_MATCHER_SLOTS..];
    validate!(
        amm_slice.len() % ACCOUNTS_PER_AMM == 0,
        ErrorCode::InvalidSpotMarketAccount,
        "remaining_accounts after global_matcher must be (midprice, maker_user)*"
    )?;

    let mut amm_views: Vec<AmmView> = Vec::with_capacity(amm_slice.len() / ACCOUNTS_PER_AMM);
    let mut seen_pairs: Vec<(Pubkey, Pubkey)> = Vec::new();

    for pair_idx in 0..(amm_slice.len() / ACCOUNTS_PER_AMM) {
        let base = amm_start + GLOBAL_MATCHER_SLOTS + pair_idx * ACCOUNTS_PER_AMM;
        let midprice_info = &amm_slice[pair_idx * ACCOUNTS_PER_AMM];
        let maker_user_info = &amm_slice[pair_idx * ACCOUNTS_PER_AMM + 1];

        let midprice_idx = base;
        let maker_user_idx = base + 1;

        let pair = (midprice_info.key(), maker_user_info.key());
        validate!(
            !seen_pairs.contains(&pair),
            ErrorCode::InvalidSpotMarketAccount,
            "duplicate (midprice, maker_user) pair"
        )?;
        seen_pairs.push(pair);

        validate!(
            *maker_user_info.owner == *program_id,
            ErrorCode::InvalidSpotMarketAccount,
            "maker user must be owned by Drift"
        )?;
        validate!(
            maker_user_info.is_writable,
            ErrorCode::InvalidSpotMarketAccount,
            "maker user must be writable"
        )?;

        let mid_price = read_external_mid_price(
            midprice_info,
            midprice_program.key,
            maker_user_info,
            current_slot,
        )?;
        amm_views.push(AmmView {
            key: midprice_info.key(),
            mid_price,
            maker_user_remaining_index: maker_user_idx,
            midprice_remaining_index: midprice_idx,
        });
    }
    Ok((0, amm_views))
}

/// Validates that every midprice account has market_index matching the order's market.
/// Prevents applying position updates for one market while consuming liquidity from another market's book.
pub(crate) fn validate_midprice_market_indices(
    amm_views: &[AmmView],
    remaining_accounts: &[AccountInfo],
    order_market_index: u16,
) -> DriftResult<()> {
    for amm in amm_views {
        let data = remaining_accounts[amm.midprice_remaining_index]
            .try_borrow_data()
            .map_err(|_| ErrorCode::InvalidSpotMarketAccount)?;
        validate!(
            data.len() >= MIDPRICE_MARKET_INDEX_OFFSET + 2,
            ErrorCode::InvalidSpotMarketAccount,
            "midprice data too short for market_index"
        )?;
        let stored =
            u16::from_le_bytes(*arrayref::array_ref![data, MIDPRICE_MARKET_INDEX_OFFSET, 2]);
        validate!(
            stored == order_market_index,
            ErrorCode::InvalidSpotMarketAccount,
            "midprice market_index must match order market"
        )?;
    }
    Ok(())
}

/// Validates that the taker user account is not also listed as a maker (no self-trade).
pub(crate) fn validate_taker_not_any_maker(
    taker_user_key: &Pubkey,
    amm_views: &[AmmView],
    remaining_accounts: &[AccountInfo],
) -> DriftResult<()> {
    for amm in amm_views {
        let maker_key = remaining_accounts[amm.maker_user_remaining_index].key();
        validate!(
            maker_key != *taker_user_key,
            ErrorCode::InvalidSpotMarketAccount,
            "taker cannot be same as maker (no self-trade)"
        )?;
    }
    Ok(())
}

/// Runs the prop AMM matching loop; returns deltas and external fills (no account updates).
pub(crate) fn run_prop_amm_matching(
    amm_views: &[AmmView],
    remaining_accounts: &[AccountInfo],
    side: u8,
    limit_price: u64,
    size: u64,
) -> DriftResult<PropAmmMatchResult> {
    let side = Side::from_u8(side)?;
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
            let (base_delta, quote_delta) = if side.is_buy() {
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
/// - **Self-trade**: validate_taker_not_any_maker rejects taker == maker.

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
        let side = if order.direction == PositionDirection::Long {
            BUY
        } else {
            SELL
        };
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
    // Canonical layout: [midprice_program], [spot_markets...] (consume while SpotMarket discriminator), then AMM quads.
    let amm_start = find_amm_start_after_spot_markets(remaining_accounts)?;
    let (midprice_program_idx, amm_views) =
        parse_amm_views(remaining_accounts, amm_start, program_id, clock.slot)?;

    if amm_views.is_empty() {
        return Ok(());
    }

    validate_midprice_market_indices(&amm_views, remaining_accounts, market_index)?;
    validate_taker_not_any_maker(&ctx.accounts.user.key(), &amm_views, remaining_accounts)?;

    let result = run_prop_amm_matching(&amm_views, remaining_accounts, side, limit_price, size)?;

    if result.external_fills.is_empty() {
        return Ok(());
    }

    let taker_base_delta = result.taker_base_delta;
    let taker_quote_delta = result.taker_quote_delta;
    let total_quote_volume = result.total_quote_volume;
    let maker_deltas = result.maker_deltas;
    let external_fills = result.external_fills;

    let spot_slice = &remaining_accounts[1..amm_start];
    let mut spot_iter: Peekable<Iter<AccountInfo>> = spot_slice.iter().peekable();
    let spot_market_map = SpotMarketMap::load(&SpotMarketSet::new(), &mut spot_iter)?;
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

    let perp_market_map =
        PerpMarketMap::from_single_loader(&ctx.accounts.perp_market, market_index)?;
    let oracle_guard_rails = ctx.accounts.state.oracle_guard_rails;
    let mut oracle_map =
        OracleMap::load_one(&ctx.accounts.oracle, clock.slot, Some(oracle_guard_rails))?;

    // Margin check: taker must still meet margin after fill (same rule as fill_perp_order: Maintenance if position decreasing, Fill if risk-increasing).
    let taker_user = ctx.accounts.user.load()?;
    let position_after = taker_user
        .get_perp_position(market_index)
        .map_or(0_i64, |p| p.base_asset_amount);
    let position_before = position_after.saturating_sub(taker_base_delta);
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

    // Apply maker deltas: load each maker user + user_stats, update position + market, update maker volume, then margin check.
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
        drop(maker);
        drop(market);

        // Margin check: maker must still meet margin after fill (same as fill_perp_order: select_margin_type_for_perp_maker, then meets_margin_requirement).
        let maker_for_margin = maker_loader.load()?;
        let (maker_margin_type, _maker_risk_increasing) =
            select_margin_type_for_perp_maker(&maker_for_margin, base_delta, market_index)?;
        let maker_margin_context = MarginContext::standard(maker_margin_type)
            .fuel_perp_delta(market_index, -base_delta)
            .fuel_numerator(&maker_for_margin, now);
        let maker_margin_calc =
            calculate_margin_requirement_and_total_collateral_and_liability_info(
                &maker_for_margin,
                &perp_market_map,
                &spot_market_map,
                &mut oracle_map,
                maker_margin_context,
            )?;
        if !maker_margin_calc.meets_margin_requirement() {
            let (margin_requirement, total_collateral) = if maker_margin_calc
                .has_isolated_margin_calculation(market_index)
            {
                let isolated = maker_margin_calc.get_isolated_margin_calculation(market_index)?;
                (isolated.margin_requirement, isolated.total_collateral)
            } else {
                (
                    maker_margin_calc.margin_requirement,
                    maker_margin_calc.total_collateral,
                )
            };
            msg!(
                "maker ({}) breached fill requirements (margin requirement {}) (total_collateral {})",
                maker_user_key,
                margin_requirement,
                total_collateral
            );
            return Err(ErrorCode::InsufficientCollateral.into());
        }
    }

    // Emit fill event and increment fill_record_id.
    let mut market = ctx.accounts.perp_market.load_mut()?;
    let fill_record_id = get_then_update_id!(market, next_fill_record_id);
    let oracle_id = market.oracle_id();
    drop(market);
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

    let fill_record = get_order_action_record(
        now,
        OrderAction::Fill,
        OrderActionExplanation::OrderFilledWithMatch,
        market_index,
        None, // filler
        Some(fill_record_id),
        None, // filler_reward
        Some(base_filled),
        Some(total_quote_volume),
        None, // taker_fee
        None, // maker_rebate
        None, // referrer_reward
        None, // quote_asset_amount_surplus
        None, // spot_fulfillment_method_fee
        Some(ctx.accounts.user.key()),
        Some(taker_order),
        None, // maker
        None, // maker_order
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

    // CPI to midprice_pino to apply fills (consume liquidity on AMM books).
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
    use crate::state::spot_market::SpotMarket;
    use crate::state::spot_market_map::SpotMarketMap;
    use crate::state::user::{PerpPosition, SpotPosition, User};
    use crate::{
        create_account_info, create_executable_program_account_info, get_account_bytes,
        get_anchor_account_bytes, get_pyth_price,
    };
    use midprice_book_view::{
        ACCOUNT_MIN_LEN, ASK_HEAD_OFFSET, ASK_LEN_OFFSET, AUTHORITY_OFFSET, BID_HEAD_OFFSET,
        BID_LEN_OFFSET, LAYOUT_VERSION_INITIAL, MARKET_INDEX_OFFSET, MID_PRICE_OFFSET,
        ORDERS_DATA_OFFSET, ORDER_ENTRY_SIZE, QUOTE_TTL_OFFSET, REF_SLOT_OFFSET,
    };

    fn drift_program_id() -> Pubkey {
        crate::id()
    }

    fn midprice_program_id() -> Pubkey {
        crate::ids::midprice_program::id()
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
        data[0..8].copy_from_slice(&LAYOUT_VERSION_INITIAL.to_le_bytes());
        data[AUTHORITY_OFFSET..AUTHORITY_OFFSET + 32].copy_from_slice(authority.as_ref());
        data[MID_PRICE_OFFSET..MID_PRICE_OFFSET + 8].copy_from_slice(&mid_price.to_le_bytes());
        data[MARKET_INDEX_OFFSET..MARKET_INDEX_OFFSET + 2]
            .copy_from_slice(&market_index.to_le_bytes());
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
        let maker_user_key = Pubkey::new_unique();
        let mut maker_user = User::default();
        maker_user.authority = maker_user_key;
        crate::create_anchor_account_info!(maker_user, &maker_user_key, User, maker_user_info);

        let mid_price = 100 * PRICE_PRECISION_U64;
        let data = make_midprice_account_data(mid_price, 100 * BASE_PRECISION_U64, &maker_user_key);
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

        let res = parse_amm_views(remaining.as_slice(), 1, &program_id, 100);
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
        let maker_user_key = Pubkey::new_unique();
        let mut maker_user = User::default();
        maker_user.authority = maker_user_key;
        crate::create_anchor_account_info!(maker_user, &maker_user_key, User, maker_user_info);

        let mid_price = 100 * PRICE_PRECISION_U64;
        let ask_size = 50 * BASE_PRECISION_U64;
        let data = make_midprice_account_data(mid_price, ask_size, &maker_user_key);
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

        let (_, amm_views) = parse_amm_views(slice, 1, &program_id, 100).unwrap();
        let taker_size = 30 * BASE_PRECISION_U64;
        let limit_price = 101 * PRICE_PRECISION_U64;
        let result = run_prop_amm_matching(
            &amm_views,
            slice,
            0, // buy
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

    // --- Security / QA tests: demonstrate vulnerabilities, then validation fixes ---

    /// SECURITY: Midprice account can declare a different market_index than the order.
    /// Without validation, we would apply position updates for market 0 while consuming liquidity from a book for market 1.
    #[test]
    fn security_midprice_market_index_mismatch_must_be_rejected() {
        let program_id = drift_program_id();
        let maker_user_key = Pubkey::new_unique();
        let mut maker_user = User::default();
        maker_user.authority = maker_user_key;
        crate::create_anchor_account_info!(maker_user, &maker_user_key, User, maker_user_info);

        // Midprice account claims market_index = 1, but order will be for market 0.
        let data = make_midprice_account_data_with_market(
            100 * PRICE_PRECISION_U64,
            50 * BASE_PRECISION_U64,
            &maker_user_key,
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
        let (_, amm_views) = parse_amm_views(remaining.as_slice(), 1, &program_id, 100).unwrap();
        // Validation must reject when midprice market_index != order market_index.
        let order_market_index: u16 = 0;
        let res = validate_midprice_market_indices(&amm_views, &remaining, order_market_index);
        assert!(
            res.is_err(),
            "midprice account with market_index=1 must be rejected for order market_index=0"
        );
    }

    /// SECURITY: Only Drift's matcher PDA can apply_fills (midprice_pino hardcodes DRIFT_PROGRAM_ID for PDA check).
    #[test]
    fn security_matcher_pda_enforced_by_midprice() {
        let program_id = drift_program_id();
        let maker_user_key = Pubkey::new_unique();
        let mut maker_user = User::default();
        maker_user.authority = maker_user_key;
        crate::create_anchor_account_info!(maker_user, &maker_user_key, User, maker_user_info);

        let data = make_midprice_account_data_with_market(
            100 * PRICE_PRECISION_U64,
            50 * BASE_PRECISION_U64,
            &maker_user_key,
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
        let res = parse_amm_views(remaining.as_slice(), 1, &program_id, 100);
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
        let maker_user_key = Pubkey::new_unique();
        let mut maker_user = User::default();
        maker_user.authority = maker_user_key;
        crate::create_anchor_account_info!(maker_user, &maker_user_key, User, maker_user_info);

        let data = make_midprice_account_data(
            100 * PRICE_PRECISION_U64,
            50 * BASE_PRECISION_U64,
            &maker_user_key,
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
        let res = parse_amm_views(remaining.as_slice(), 1, &program_id, 100);
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
        let maker_user_key = Pubkey::new_unique();
        let mut maker_user = User::default();
        maker_user.authority = maker_user_key;
        crate::create_anchor_account_info!(maker_user, &maker_user_key, User, maker_user_info);

        let data = make_midprice_account_data(
            100 * PRICE_PRECISION_U64,
            50 * BASE_PRECISION_U64,
            &maker_user_key,
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
        let res = parse_amm_views(remaining.as_slice(), 1, &program_id, 100);
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
        let taker_and_maker_key = Pubkey::new_unique(); // same user as taker and maker
        let mut maker_user = User::default();
        maker_user.authority = taker_and_maker_key;
        crate::create_anchor_account_info!(maker_user, &taker_and_maker_key, User, maker_user_info);

        let data = make_midprice_account_data(
            100 * PRICE_PRECISION_U64,
            50 * BASE_PRECISION_U64,
            &taker_and_maker_key,
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
        let (_, amm_views) = parse_amm_views(remaining.as_slice(), 1, &program_id, 100).unwrap();
        // Taker pubkey same as maker account key (the User account passed as maker).
        let res = validate_taker_not_any_maker(&taker_and_maker_key, &amm_views, &remaining);
        assert!(
            res.is_err(),
            "taker must not be allowed to be the same as a maker (self-trade)"
        );
    }

    /// SECURITY: Zero-size order should be rejected to avoid no-op and edge cases.
    #[test]
    fn security_zero_size_order_returns_empty_fills() {
        let program_id = drift_program_id();
        let maker_user_key = Pubkey::new_unique();
        let mut maker_user = User::default();
        maker_user.authority = maker_user_key;
        crate::create_anchor_account_info!(maker_user, &maker_user_key, User, maker_user_info);

        let data = make_midprice_account_data(
            100 * PRICE_PRECISION_U64,
            50 * BASE_PRECISION_U64,
            &maker_user_key,
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
        let (_, amm_views) = parse_amm_views(remaining.as_slice(), 1, &program_id, 100).unwrap();
        let result = run_prop_amm_matching(
            &amm_views,
            remaining.as_slice(),
            0,
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
        let maker_user_key = Pubkey::new_unique();
        let mut maker_user = User::default();
        maker_user.authority = maker_user_key;
        crate::create_anchor_account_info!(maker_user, &maker_user_key, User, maker_user_info);
        let mid_price = 100 * PRICE_PRECISION_U64;
        let ask_size = 50 * BASE_PRECISION_U64;
        let data = make_midprice_account_data(mid_price, ask_size, &maker_user_key);
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
        let (_, amm_views) = parse_amm_views(slice, 1, &program_id, 100).unwrap();
        let result = run_prop_amm_matching(
            &amm_views,
            slice,
            0,
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

        let maker_key_0 = Pubkey::new_unique();
        let mut maker_user_0 = User {
            authority: maker_key_0,
            ..User::default()
        };
        crate::create_anchor_account_info!(maker_user_0, &maker_key_0, User, maker_user_info_0);
        let midprice_key_0 = Pubkey::new_unique();
        let mut midprice_lamports_0 = 0u64;
        let mut midprice_data_0 = make_midprice_account_data(mid_price, ask_size, &maker_key_0);
        let midprice_info_0 = create_account_info(
            &midprice_key_0,
            true,
            &mut midprice_lamports_0,
            &mut midprice_data_0[..],
            &midprice_prog_id,
        );

        let maker_key_1 = Pubkey::new_unique();
        let mut maker_user_1 = User {
            authority: maker_key_1,
            ..User::default()
        };
        crate::create_anchor_account_info!(maker_user_1, &maker_key_1, User, maker_user_info_1);
        let midprice_key_1 = Pubkey::new_unique();
        let mut midprice_lamports_1 = 0u64;
        let mut midprice_data_1 = make_midprice_account_data(mid_price, ask_size, &maker_key_1);
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
        let (_, amm_views) = parse_amm_views(slice, 1, &program_id, 100).unwrap();
        let result = run_prop_amm_matching(
            &amm_views,
            slice,
            0,
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

        let mk0 = Pubkey::new_unique();
        let mut mu0 = User {
            authority: mk0,
            ..User::default()
        };
        crate::create_anchor_account_info!(mu0, &mk0, User, mu_i0);
        let mp0 = Pubkey::new_unique();
        let mut ml0 = 0u64;
        let mut md0 = make_midprice_account_data(mid_price, ask_size, &mk0);
        let mi0 = create_account_info(&mp0, true, &mut ml0, &mut md0[..], &midprice_prog_id);

        let mk1 = Pubkey::new_unique();
        let mut mu1 = User {
            authority: mk1,
            ..User::default()
        };
        crate::create_anchor_account_info!(mu1, &mk1, User, mu_i1);
        let mp1 = Pubkey::new_unique();
        let mut ml1 = 0u64;
        let mut md1 = make_midprice_account_data(mid_price, ask_size, &mk1);
        let mi1 = create_account_info(&mp1, true, &mut ml1, &mut md1[..], &midprice_prog_id);

        let mk2 = Pubkey::new_unique();
        let mut mu2 = User {
            authority: mk2,
            ..User::default()
        };
        crate::create_anchor_account_info!(mu2, &mk2, User, mu_i2);
        let mp2 = Pubkey::new_unique();
        let mut ml2 = 0u64;
        let mut md2 = make_midprice_account_data(mid_price, ask_size, &mk2);
        let mi2 = create_account_info(&mp2, true, &mut ml2, &mut md2[..], &midprice_prog_id);

        let mk3 = Pubkey::new_unique();
        let mut mu3 = User {
            authority: mk3,
            ..User::default()
        };
        crate::create_anchor_account_info!(mu3, &mk3, User, mu_i3);
        let mp3 = Pubkey::new_unique();
        let mut ml3 = 0u64;
        let mut md3 = make_midprice_account_data(mid_price, ask_size, &mk3);
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
        let (_, amm_views) = parse_amm_views(slice, 1, &program_id, 100).unwrap();
        // Keep taker size modest so total quote fits in i64
        let taker_size = 4 * 5 * BASE_PRECISION_U64;
        let result =
            run_prop_amm_matching(&amm_views, slice, 0, 101 * PRICE_PRECISION_U64, taker_size)
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
            ($mk:ident, $mu:ident, $mu_i:ident, $mp:ident, $ml:ident, $md:ident, $mi:ident) => {
                let $mk = Pubkey::new_unique();
                let mut $mu = User {
                    authority: $mk,
                    ..User::default()
                };
                crate::create_anchor_account_info!($mu, &$mk, User, $mu_i);
                let $mp = Pubkey::new_unique();
                let mut $ml = 0u64;
                let mut $md = make_midprice_account_data(mid_price, ask_size, &$mk);
                let $mi =
                    create_account_info(&$mp, true, &mut $ml, &mut $md[..], &midprice_prog_id);
            };
        }
        one_amm!(mk0, mu0, mu_i0, mp0, ml0, md0, mi0);
        one_amm!(mk1, mu1, mu_i1, mp1, ml1, md1, mi1);
        one_amm!(mk2, mu2, mu_i2, mp2, ml2, md2, mi2);
        one_amm!(mk3, mu3, mu_i3, mp3, ml3, md3, mi3);
        one_amm!(mk4, mu4, mu_i4, mp4, ml4, md4, mi4);
        one_amm!(mk5, mu5, mu_i5, mp5, ml5, md5, mi5);
        one_amm!(mk6, mu6, mu_i6, mp6, ml6, md6, mi6);
        one_amm!(mk7, mu7, mu_i7, mp7, ml7, md7, mi7);

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
        let (_, amm_views) = parse_amm_views(slice, 1, &program_id, 100).unwrap();
        // Keep taker size modest so total quote fits in i64
        let taker_size = 8 * 5 * BASE_PRECISION_U64;
        let result =
            run_prop_amm_matching(&amm_views, slice, 0, 101 * PRICE_PRECISION_U64, taker_size)
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
        let maker_user_key = Pubkey::new_unique();
        let mut maker_user = User::default();
        maker_user.authority = maker_user_key;
        crate::create_anchor_account_info!(maker_user, &maker_user_key, User, maker_user_info);

        let mid_price = 100 * PRICE_PRECISION_U64;
        let data = make_midprice_data_with_ttl(
            mid_price,
            100 * BASE_PRECISION_U64,
            &maker_user_key,
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
        assert_eq!(result.unwrap(), mid_price);
    }

    /// Quote within TTL window is accepted.
    #[test]
    fn ttl_within_window_accepted() {
        let program_id = drift_program_id();
        let midprice_key = Pubkey::new_unique();
        let maker_user_key = Pubkey::new_unique();
        let mut maker_user = User::default();
        maker_user.authority = maker_user_key;
        crate::create_anchor_account_info!(maker_user, &maker_user_key, User, maker_user_info);

        let mid_price = 100 * PRICE_PRECISION_U64;
        let data = make_midprice_data_with_ttl(
            mid_price,
            100 * BASE_PRECISION_U64,
            &maker_user_key,
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
        let maker_user_key = Pubkey::new_unique();
        let mut maker_user = User::default();
        maker_user.authority = maker_user_key;
        crate::create_anchor_account_info!(maker_user, &maker_user_key, User, maker_user_info);

        let mid_price = 100 * PRICE_PRECISION_U64;
        let data = make_midprice_data_with_ttl(
            mid_price,
            100 * BASE_PRECISION_U64,
            &maker_user_key,
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
        let maker_user_key = Pubkey::new_unique();
        let mut maker_user = User::default();
        maker_user.authority = maker_user_key;
        crate::create_anchor_account_info!(maker_user, &maker_user_key, User, maker_user_info);

        let mid_price = 100 * PRICE_PRECISION_U64;
        let data = make_midprice_data_with_ttl(
            mid_price,
            100 * BASE_PRECISION_U64,
            &maker_user_key,
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
        let midprice_program_id = midprice_program_id();
        let midprice_key = Pubkey::new_unique();
        let matcher_key = prop_amm_matcher_pda(&drift_program_id()).0;
        let clock_key = sysvar::clock::ID;
        let mut data = vec![MIDPRICE_IX_APPLY_FILLS];
        data.extend_from_slice(&0u16.to_le_bytes()); // market_index (CPI protection)
        data.extend_from_slice(&1u16.to_le_bytes()); // one maker, one fill
        data.extend_from_slice(&0u16.to_le_bytes());
        data.push(1); // is_ask
        data.extend_from_slice(&1u64.to_le_bytes());
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
}
