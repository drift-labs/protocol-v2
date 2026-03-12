//! Provides midprice based orderbook externally fillable by authorized matcher program.
//!
//! Account layout is defined in [`midprice_book_view`].
//!
//! ## Instructions
//!
//! | Opcode | Name | Accounts | Payload |
//! |--------|------|----------|---------|
//! | 0 | update_mid_price | [midprice (w), authority (s)] | 24 bytes: mid_price (u64) + 8 reserved + ref_slot (u64) |
//! | 1 | initialize | [midprice (w), authority (s), drift_matcher (s)] | 20 bytes: market_index (u16), subaccount_index (u16), order_tick_size (u64), min_order_size (u64). CPI-only from Drift. |
//! | 2 | set_orders | [midprice (w), authority (s)] | ref_slot (u64), ask_len (u16), bid_len (u16), then 16×N order entries (offset i64 LE, size u64 LE). Tick/size validated against values stored on account. |
//! | 3 | apply_fills | [matcher (s), clock, midprice_0 (w), …] | market_index (u16); then per maker: num_fills (u16), expected_sequence (u64), then num_fills × (abs_index u16, is_ask u8, fill_size u64) |
//! | 5 | set_quote_ttl | [midprice (w), authority (s)] | 8 bytes: ttl_slots (u64) |
//! | 6 | close_account | [midprice (w), authority (s), dest (w)] | 0 bytes |
//! | 7 | transfer_authority | [midprice (w), authority (s)] | 32 bytes: new authority pubkey |
//! | 8 | update_tick_sizes | [midprice (w), authority (s), drift_matcher (s)] | 16 bytes: order_tick_size (u64), min_order_size (u64). CPI-only from Drift. |
//!
//! ## Error codes
//!
//! Returned as `ProgramError::Custom(u32)` where the low byte is a bitmask:
//!
//! | Bit | Value | Meaning |
//! |-----|-------|---------|
//! | 0 | 0x01 | Account not writable |
//! | 1 | 0x02 | Missing required signature |
//! | 2 | 0x04 | Account not owned by this program |
//! | 3 | 0x08 | Account data too small |
//! | 4 | 0x10 | Authority mismatch |
//! | 5 | 0x20 | Already initialized |
//! | 6 | 0x40 | Unsupported layout version |
//! | 7 | 0x80 | Quote expired (TTL exceeded during apply_fills) |
//! | 8 | 0x100 | CPI market_index does not match midprice account |
//! | 9 | 0x200 | accounts[1] is not the Clock sysvar (apply_fills) |
//! | 12 | 0x1000 | Order not on tick or below min_order_size |
//! | 13 | 0x2000 | Init/update_tick_sizes invoked directly; must be CPI from Drift (drift_matcher must be signer) |
#![cfg_attr(target_os = "solana", no_std)]

use midprice_book_view::{
    MidpriceBookViewMut, ACCOUNT_DISCRIMINATOR_OFFSET, ACCOUNT_DISCRIMINATOR_SIZE, ACCOUNT_MIN_LEN,
    APPLY_FILLS_MARKET_INDEX_SIZE, APPLY_FILLS_NUM_FILLS_SIZE, APPLY_FILLS_OPCODE,
    APPLY_FILLS_SEQ_NUM_SIZE, APPLY_FILL_ENTRY_SIZE, ASK_HEAD_OFFSET, ASK_LEN_OFFSET,
    AUTHORITY_OFFSET, BID_HEAD_OFFSET, BID_LEN_OFFSET, LAYOUT_VERSION_INITIAL,
    LAYOUT_VERSION_OFFSET, MARKET_INDEX_OFFSET, MAX_ORDERS, MIDPRICE_ACCOUNT_DISCRIMINATOR,
    MID_PRICE_OFFSET, MIN_ORDER_SIZE_OFFSET, ORDERS_DATA_OFFSET, ORDER_ENTRY_SIZE,
    ORDER_ENTRY_SIZE_OFFSET, ORDER_TICK_SIZE_OFFSET, QUOTE_TTL_OFFSET, REF_SLOT_OFFSET,
    RESERVED_OFFSET, SEQUENCE_NUMBER_OFFSET, SUBACCOUNT_INDEX_OFFSET,
};
use pinocchio::{
    account::AccountView, error::ProgramError, no_allocator, nostd_panic_handler,
    program_entrypoint, Address, ProgramResult,
};
use pinocchio_log::log;
use solana_pubkey::pubkey;

const IX_UPDATE_MID_PRICE: u8 = 0;
const IX_INITIALIZE_MID_PRICE_ACCOUNT: u8 = 1;
const IX_SET_ORDERS: u8 = 2;
const IX_SET_QUOTE_TTL: u8 = 5;
const IX_CLOSE_ACCOUNT: u8 = 6;
const IX_TRANSFER_AUTHORITY: u8 = 7;
const IX_UPDATE_TICK_SIZES: u8 = 8;
/// Authorized exchange program ID (for matcher PDA derivation).
const DRIFT_PROGRAM_ID: Address = pubkey!("dRiftyHA39MWEi3m9aunc5MzRF1JYuBsbn6VPcn33UH");
/// Seed for the matcher PDA (must match the exchange's PROP_AMM_MATCHER_SEED).
const PROP_AMM_MATCHER_SEED: &[u8] = b"prop_amm_matcher";
/// Clock sysvar; must be accounts[1] for apply_fills.
const CLOCK_SYSVAR_ID: Address = pubkey!("SysvarC1ock11111111111111111111111111111111");

const AUTH_ERR_IMMUTABLE: u8 = 1 << 0; // 0x01
const AUTH_ERR_MISSING_SIGNATURE: u8 = 1 << 1; // 0x02
const AUTH_ERR_ILLEGAL_OWNER: u8 = 1 << 2; // 0x04
const AUTH_ERR_INVALID_ACCOUNT_DATA: u8 = 1 << 3; // 0x08
const AUTH_ERR_INVALID_AUTHORITY: u8 = 1 << 4; // 0x10
const AUTH_ERR_ALREADY_INITIALIZED: u8 = 1 << 5; // 0x20
const AUTH_ERR_UNSUPPORTED_LAYOUT_VERSION: u8 = 1 << 6; // 0x40
const AUTH_ERR_INVALID_CLOCK: u32 = 1 << 7; // apply_fills: accounts[1] not Clock
const AUTH_ERR_ORDER_TICK_OR_SIZE: u32 = 1 << 12; // 0x1000
const AUTH_ERR_INIT_REQUIRES_DRIFT_CPI: u32 = 1 << 13; // 0x2000

/// Order filled event: emitted for each order filled in apply_fills.
/// Layout: "ordrfill" (8) | market_index (2) | authority (32) | abs_index (2) | is_ask (1) | fill_size (8) = 53 bytes.
const ORDER_FILLED_EVENT_DISCRIMINATOR: [u8; 8] = [b'o', b'r', b'd', b'r', b'f', b'i', b'l', b'l'];
const ORDER_FILLED_EVENT_SIZE: usize = 53;

fn emit_order_filled_event(
    market_index: u16,
    authority: &[u8; 32],
    entry: &[u8],
) {
    if entry.len() != APPLY_FILL_ENTRY_SIZE {
        return;
    }
    let mut buf = [0u8; ORDER_FILLED_EVENT_SIZE];
    buf[0..8].copy_from_slice(&ORDER_FILLED_EVENT_DISCRIMINATOR);
    buf[8..10].copy_from_slice(&market_index.to_le_bytes());
    buf[10..42].copy_from_slice(authority);
    buf[42..44].copy_from_slice(&entry[0..2]); // abs_index
    buf[44] = entry[2]; // is_ask
    buf[45..53].copy_from_slice(&entry[3..11]); // fill_size
    #[cfg(target_os = "solana")]
    {
        extern "C" {
            fn sol_log_data(data: *const u8, data_len: u64);
        }
        // SolBytes layout: { *const u8, u64 } — one pair for our single slice.
        let fields = [buf.as_ptr() as u64, buf.len() as u64];
        unsafe { sol_log_data(fields.as_ptr() as *const u8, 1) };
    }
}

program_entrypoint!(process_instruction);
no_allocator!();
nostd_panic_handler!();

pub fn process_instruction(
    program_id: &Address,
    accounts: &[AccountView],
    instruction_data: &[u8],
) -> ProgramResult {
    let (opcode, payload) = match instruction_data.split_first() {
        Some(p) => p,
        None => {
            log!(64, "midprice: empty instruction data");
            return Err(ProgramError::InvalidInstructionData);
        }
    };
    match *opcode {
        IX_INITIALIZE_MID_PRICE_ACCOUNT => {
            process_initialize_mid_price_account(program_id, accounts, payload)
        }
        IX_UPDATE_MID_PRICE => process_update_mid_price(program_id, accounts, payload),
        IX_SET_ORDERS => process_set_orders(program_id, accounts, payload),
        APPLY_FILLS_OPCODE => process_apply_fills(program_id, accounts, payload),
        IX_SET_QUOTE_TTL => process_set_quote_ttl(program_id, accounts, payload),
        IX_CLOSE_ACCOUNT => process_close_account(program_id, accounts, payload),
        IX_TRANSFER_AUTHORITY => process_transfer_authority(program_id, accounts, payload),
        IX_UPDATE_TICK_SIZES => process_update_tick_sizes(program_id, accounts, payload),
        _ => {
            log!(64, "midprice: unknown opcode={}", *opcode);
            Err(ProgramError::InvalidInstructionData)
        }
    }
}

// ---------------------------------------------------------------------------
// Auth helpers
// ---------------------------------------------------------------------------

/// Validates the 2-account pattern: accounts[0] = midprice (writable, program-owned),
/// accounts[1] = authority (signer). Returns mutable account data after checking layout and authority.
fn validate_authority_and_borrow_mut<'a>(
    program_id: &Address,
    accounts: &'a [AccountView],
) -> Result<&'a mut [u8], ProgramError> {
    if accounts.len() < 2 {
        log!(64, "midprice: accounts_len={} want >= 2", accounts.len());
        return Err(ProgramError::NotEnoughAccountKeys);
    }
    let midprice_account = &accounts[0];
    let authority = &accounts[1];

    let mut err: u8 = 0;
    if !midprice_account.is_writable() {
        err |= AUTH_ERR_IMMUTABLE;
    }
    if !authority.is_signer() {
        err |= AUTH_ERR_MISSING_SIGNATURE;
    }
    if midprice_account.data_len() < ACCOUNT_MIN_LEN {
        err |= AUTH_ERR_INVALID_ACCOUNT_DATA;
    }
    // Safety: owner pointer comes from Solana runtime and is always valid.
    if !unsafe {
        authority_matches_32(
            midprice_account.owner().as_ref().as_ptr(),
            program_id.as_ref().as_ptr(),
        )
    } {
        err |= AUTH_ERR_ILLEGAL_OWNER;
    }
    if err != 0 {
        log!(64, "midprice: auth check failed err={}", err);
        return Err(ProgramError::Custom(err as u32));
    }

    // Safety: no other borrows exist on this account.
    let data = unsafe { midprice_account.borrow_unchecked_mut() };
    check_layout_version(data)?;

    if !unsafe {
        authority_matches_32(
            data.as_ptr().add(AUTHORITY_OFFSET),
            authority.address().as_ref().as_ptr(),
        )
    } {
        log!(64, "midprice: stored authority mismatch");
        return Err(ProgramError::Custom(AUTH_ERR_INVALID_AUTHORITY as u32));
    }

    Ok(data)
}

/// Validates init preconditions (writable, program-owned, signer, min length). Does not check
/// layout version or stored authority since the account is uninitialized.
fn validate_init_preconditions(
    program_id: &Address,
    accounts: &[AccountView],
) -> Result<(), ProgramError> {
    if accounts.len() < 2 {
        log!(
            64,
            "midprice init: accounts_len={} want >= 2",
            accounts.len()
        );
        return Err(ProgramError::NotEnoughAccountKeys);
    }
    let midprice_account = &accounts[0];
    let authority = &accounts[1];

    let mut err: u8 = 0;
    if !midprice_account.is_writable() {
        err |= AUTH_ERR_IMMUTABLE;
    }
    if !authority.is_signer() {
        err |= AUTH_ERR_MISSING_SIGNATURE;
    }
    if midprice_account.data_len() < ACCOUNT_MIN_LEN {
        err |= AUTH_ERR_INVALID_ACCOUNT_DATA;
    }
    // Safety: owner pointer from Solana runtime.
    if !unsafe {
        authority_matches_32(
            midprice_account.owner().as_ref().as_ptr(),
            program_id.as_ref().as_ptr(),
        )
    } {
        err |= AUTH_ERR_ILLEGAL_OWNER;
    }
    if err != 0 {
        log!(64, "midprice init: auth check failed err={}", err);
        return Err(ProgramError::Custom(err as u32));
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Instruction handlers
// ---------------------------------------------------------------------------

fn process_initialize_mid_price_account(
    program_id: &Address,
    accounts: &[AccountView],
    payload: &[u8],
) -> ProgramResult {
    const INIT_PAYLOAD_LEN: usize = 4 + 8 + 8; // market_index, subaccount_index, order_tick_size, min_order_size
    if payload.len() != INIT_PAYLOAD_LEN {
        log!(
            64,
            "midprice init: bad payload_len={} want {}",
            payload.len(),
            INIT_PAYLOAD_LEN
        );
        return Err(ProgramError::InvalidInstructionData);
    }
    let market_index = u16::from_le_bytes([payload[0], payload[1]]);
    let subaccount_index = u16::from_le_bytes([payload[2], payload[3]]);
    let order_tick_size = u64::from_le_bytes(payload[4..12].try_into().unwrap());
    let min_order_size = u64::from_le_bytes(payload[12..20].try_into().unwrap());

    validate_init_preconditions(program_id, accounts)?;
    if accounts.len() < 3 {
        log!(
            64,
            "midprice init: accounts_len={} want >= 3 (need drift_matcher signer); init is CPI-only from Drift",
            accounts.len()
        );
        return Err(ProgramError::Custom(AUTH_ERR_INIT_REQUIRES_DRIFT_CPI));
    }
    let drift_matcher = &accounts[2];
    if !drift_matcher.is_signer() {
        log!(64, "midprice init: drift_matcher must be signer (init is CPI-only from Drift)");
        return Err(ProgramError::Custom(AUTH_ERR_INIT_REQUIRES_DRIFT_CPI));
    }
    let (expected_matcher_pda, _bump) =
        Address::try_find_program_address(&[PROP_AMM_MATCHER_SEED], &DRIFT_PROGRAM_ID)
            .ok_or(ProgramError::InvalidInstructionData)?;
    if drift_matcher.address().as_ref() != expected_matcher_pda.as_ref() {
        log!(
            64,
            "midprice init: drift_matcher must be Drift prop_amm_matcher PDA (init is CPI-only)"
        );
        return Err(ProgramError::Custom(AUTH_ERR_INIT_REQUIRES_DRIFT_CPI));
    }

    let mid_price_account = &accounts[0];
    let authority = &accounts[1];
    let authority_src: &[u8] = authority.address().as_ref();

    let data = unsafe { mid_price_account.borrow_unchecked_mut() };
    if !unsafe { ptr_is_zero_32(data.as_ptr().add(AUTHORITY_OFFSET)) } {
        log!(64, "midprice init: already initialized");
        return Err(ProgramError::Custom(AUTH_ERR_ALREADY_INITIALIZED as u32));
    }

    let market_index_bytes = market_index.to_le_bytes();
    let subaccount_index_bytes = subaccount_index.to_le_bytes();
    let (expected_pda, _bump) = Address::try_find_program_address(
        &[
            b"midprice",
            &market_index_bytes,
            authority_src,
            &subaccount_index_bytes,
        ],
        program_id,
    )
    .ok_or(ProgramError::InvalidInstructionData)?;
    if mid_price_account.address().as_ref() != expected_pda.as_ref() {
        log!(
            64,
            "midprice init: midprice account is not PDA for (market_index, authority, subaccount_index)"
        );
        return Err(ProgramError::Custom(AUTH_ERR_INVALID_AUTHORITY as u32));
    }

    data[ACCOUNT_DISCRIMINATOR_OFFSET..ACCOUNT_DISCRIMINATOR_OFFSET + ACCOUNT_DISCRIMINATOR_SIZE]
        .copy_from_slice(&MIDPRICE_ACCOUNT_DISCRIMINATOR);
    data[LAYOUT_VERSION_OFFSET..LAYOUT_VERSION_OFFSET + 8]
        .copy_from_slice(&LAYOUT_VERSION_INITIAL.to_le_bytes());
    data[AUTHORITY_OFFSET..AUTHORITY_OFFSET + 32].copy_from_slice(authority_src);
    data[MID_PRICE_OFFSET..MID_PRICE_OFFSET + 16].fill(0);
    data[REF_SLOT_OFFSET..REF_SLOT_OFFSET + 8].fill(0);
    data[MARKET_INDEX_OFFSET..MARKET_INDEX_OFFSET + 2].copy_from_slice(&market_index.to_le_bytes());
    data[SUBACCOUNT_INDEX_OFFSET..SUBACCOUNT_INDEX_OFFSET + 2]
        .copy_from_slice(&subaccount_index.to_le_bytes());
    data[ORDER_TICK_SIZE_OFFSET..ORDER_TICK_SIZE_OFFSET + 8]
        .copy_from_slice(&order_tick_size.to_le_bytes());
    data[MIN_ORDER_SIZE_OFFSET..MIN_ORDER_SIZE_OFFSET + 8]
        .copy_from_slice(&min_order_size.to_le_bytes());
    data[QUOTE_TTL_OFFSET..QUOTE_TTL_OFFSET + 8].fill(0);
    data[SEQUENCE_NUMBER_OFFSET..SEQUENCE_NUMBER_OFFSET + 8].fill(0);
    data[ORDER_ENTRY_SIZE_OFFSET..ORDER_ENTRY_SIZE_OFFSET + 2]
        .copy_from_slice(&(ORDER_ENTRY_SIZE as u16).to_le_bytes());
    data[RESERVED_OFFSET..RESERVED_OFFSET + 6].fill(0);

    let mut book = MidpriceBookViewMut::new(data).map_err(|_| ProgramError::InvalidAccountData)?;
    book.set_lengths_and_reset_heads(0, 0)
        .map_err(|_| ProgramError::InvalidAccountData)?;
    book.increment_sequence_number();
    Ok(())
}

fn process_set_orders(
    program_id: &Address,
    accounts: &[AccountView],
    payload: &[u8],
) -> ProgramResult {
    if payload.len() < 12 {
        log!(
            64,
            "midprice set_orders: payload_len={} want >= 12",
            payload.len()
        );
        return Err(ProgramError::InvalidInstructionData);
    }
    if (payload.len() - 12) % ORDER_ENTRY_SIZE != 0 {
        log!(64, "midprice set_orders: payload not aligned to entry size");
        return Err(ProgramError::InvalidInstructionData);
    }

    let ref_slot = u64::from_le_bytes(payload[0..8].try_into().unwrap());
    let ask_len = u16::from_le_bytes([payload[8], payload[9]]) as usize;
    let bid_len = u16::from_le_bytes([payload[10], payload[11]]) as usize;
    let orders_len = ask_len + bid_len;
    let payload_orders_bytes = payload.len() - 12;
    if orders_len != payload_orders_bytes / ORDER_ENTRY_SIZE {
        log!(64, "midprice set_orders: ask+bid len mismatch");
        return Err(ProgramError::InvalidInstructionData);
    }
    if orders_len > MAX_ORDERS {
        log!(
            64,
            "midprice set_orders: orders_len={} > max={}",
            orders_len,
            MAX_ORDERS
        );
        return Err(ProgramError::InvalidInstructionData);
    }

    let data = validate_authority_and_borrow_mut(program_id, accounts)?;

    let order_tick_size = u64::from_le_bytes(data[ORDER_TICK_SIZE_OFFSET..][..8].try_into().unwrap());
    let min_order_size = u64::from_le_bytes(data[MIN_ORDER_SIZE_OFFSET..][..8].try_into().unwrap());
    let mid_price_u64 = u64::from_le_bytes(data[MID_PRICE_OFFSET..][..8].try_into().unwrap());

    // Validate each order: price on tick and size >= min_order_size.
    let orders_start = 12;
    for i in 0..orders_len {
        let base = orders_start + i * ORDER_ENTRY_SIZE;
        let offset = i64::from_le_bytes(payload[base..][..8].try_into().unwrap());
        let size = u64::from_le_bytes(payload[base + 8..][..8].try_into().unwrap());
        let effective_price = if offset > 0 {
            match mid_price_u64.checked_add(offset as u64) {
                Some(p) => p,
                None => {
                    log!(64, "midprice set_orders: ask price overflow");
                    return Err(ProgramError::Custom(AUTH_ERR_ORDER_TICK_OR_SIZE));
                }
            }
        } else if offset < 0 {
            let abs_offset = offset.unsigned_abs();
            match mid_price_u64.checked_sub(abs_offset) {
                Some(p) => p,
                None => {
                    log!(64, "midprice set_orders: bid price underflow");
                    return Err(ProgramError::Custom(AUTH_ERR_ORDER_TICK_OR_SIZE));
                }
            }
        } else {
            log!(64, "midprice set_orders: order {} offset 0 invalid", i);
            return Err(ProgramError::Custom(AUTH_ERR_ORDER_TICK_OR_SIZE));
        };
        if order_tick_size > 0 && effective_price % order_tick_size != 0 {
            log!(
                64,
                "midprice set_orders: order {} price {} not on tick {}",
                i,
                effective_price,
                order_tick_size
            );
            return Err(ProgramError::Custom(AUTH_ERR_ORDER_TICK_OR_SIZE));
        }
        if size < min_order_size {
            log!(
                64,
                "midprice set_orders: order {} size {} < min_order_size {}",
                i,
                size,
                min_order_size
            );
            return Err(ProgramError::Custom(AUTH_ERR_ORDER_TICK_OR_SIZE));
        }
    }

    if payload_orders_bytes > data.len() - ORDERS_DATA_OFFSET {
        log!(64, "midprice set_orders: orders exceed account capacity");
        return Err(ProgramError::InvalidInstructionData);
    }

    data[REF_SLOT_OFFSET..REF_SLOT_OFFSET + 8].copy_from_slice(&ref_slot.to_le_bytes());
    data[ASK_LEN_OFFSET..ASK_LEN_OFFSET + 2].copy_from_slice(&(ask_len as u16).to_le_bytes());
    data[BID_LEN_OFFSET..BID_LEN_OFFSET + 2].copy_from_slice(&(bid_len as u16).to_le_bytes());
    data[ASK_HEAD_OFFSET..ASK_HEAD_OFFSET + 2].copy_from_slice(&0u16.to_le_bytes());
    data[BID_HEAD_OFFSET..BID_HEAD_OFFSET + 2].copy_from_slice(&0u16.to_le_bytes());
    increment_sequence_number(data);
    data[ORDERS_DATA_OFFSET..ORDERS_DATA_OFFSET + payload_orders_bytes]
        .copy_from_slice(&payload[12..]);

    Ok(())
}

fn process_update_mid_price(
    program_id: &Address,
    accounts: &[AccountView],
    payload: &[u8],
) -> ProgramResult {
    if payload.len() != 24 {
        log!(
            64,
            "midprice update: bad payload_len={} want 24",
            payload.len()
        );
        return Err(ProgramError::InvalidInstructionData);
    }

    let ref_slot = u64::from_le_bytes(payload[16..24].try_into().unwrap());
    let data = validate_authority_and_borrow_mut(program_id, accounts)?;

    data[MID_PRICE_OFFSET..MID_PRICE_OFFSET + 16].copy_from_slice(&payload[..16]);
    data[REF_SLOT_OFFSET..REF_SLOT_OFFSET + 8].copy_from_slice(&ref_slot.to_le_bytes());
    increment_sequence_number(data);

    Ok(())
}

fn process_apply_fills(
    program_id: &Address,
    accounts: &[AccountView],
    payload: &[u8],
) -> ProgramResult {
    // Accounts: [matcher (s), clock, midprice_0 (w), midprice_1 (w), ...]
    if accounts.len() < 3 {
        log!(
            64,
            "midprice apply_fills: accounts_len={} want >= 3",
            accounts.len()
        );
        return Err(ProgramError::NotEnoughAccountKeys);
    }
    let num_makers = accounts.len() - 2;
    if num_makers == 0 {
        log!(64, "midprice apply_fills: need at least one maker");
        return Err(ProgramError::NotEnoughAccountKeys);
    }

    let matcher = &accounts[0];
    if !matcher.is_signer() {
        log!(64, "midprice apply_fills: matcher not signer");
        return Err(ProgramError::Custom(AUTH_ERR_MISSING_SIGNATURE as u32));
    }

    // Matcher account must be owned by the authorized exchange program.
    if !unsafe {
        authority_matches_32(
            matcher.owner().as_ref().as_ptr(),
            DRIFT_PROGRAM_ID.as_ref().as_ptr(),
        )
    } {
        log!(
            64,
            "midprice apply_fills: matcher owner is not authorized exchange program"
        );
        return Err(ProgramError::Custom(AUTH_ERR_INVALID_AUTHORITY as u32));
    }

    if accounts[1].address().as_ref() != CLOCK_SYSVAR_ID.as_ref() {
        log!(
            64,
            "midprice apply_fills: accounts[1] is not the Clock sysvar"
        );
        return Err(ProgramError::Custom(AUTH_ERR_INVALID_CLOCK));
    }
    let current_slot =
        read_slot_from_clock_at(accounts, 1).ok_or(ProgramError::NotEnoughAccountKeys)?;

    // Matcher must be the authorized exchange's matcher PDA.
    let (expected_matcher_pda, _bump) =
        Address::try_find_program_address(&[PROP_AMM_MATCHER_SEED], &DRIFT_PROGRAM_ID)
            .ok_or(ProgramError::InvalidInstructionData)?;
    if matcher.address().as_ref() != expected_matcher_pda.as_ref() {
        log!(
            64,
            "midprice apply_fills: matcher is not authorized exchange PDA"
        );
        return Err(ProgramError::Custom(AUTH_ERR_INVALID_AUTHORITY as u32));
    }

    if payload.len() < APPLY_FILLS_MARKET_INDEX_SIZE {
        log!(
            64,
            "midprice apply_fills: payload too short for market_index"
        );
        return Err(ProgramError::InvalidInstructionData);
    }
    let expected_market_index = u16::from_le_bytes(
        payload[0..APPLY_FILLS_MARKET_INDEX_SIZE]
            .try_into()
            .unwrap(),
    );

    let mut payload_offset = APPLY_FILLS_MARKET_INDEX_SIZE;
    for maker_i in 0..num_makers {
        if payload_offset + APPLY_FILLS_NUM_FILLS_SIZE + APPLY_FILLS_SEQ_NUM_SIZE > payload.len() {
            log!(
                64,
                "midprice apply_fills: payload short for maker {} header",
                maker_i
            );
            return Err(ProgramError::InvalidInstructionData);
        }
        let num_fills = u16::from_le_bytes(
            payload[payload_offset..payload_offset + 2]
                .try_into()
                .unwrap(),
        ) as usize;
        payload_offset += APPLY_FILLS_NUM_FILLS_SIZE;

        let expected_sequence = u64::from_le_bytes(
            payload[payload_offset..payload_offset + APPLY_FILLS_SEQ_NUM_SIZE]
                .try_into()
                .unwrap(),
        );
        payload_offset += APPLY_FILLS_SEQ_NUM_SIZE;

        if num_fills > MAX_ORDERS {
            log!(
                64,
                "midprice apply_fills: maker {} num_fills {} > MAX_ORDERS {}",
                maker_i,
                num_fills,
                MAX_ORDERS
            );
            return Err(ProgramError::InvalidInstructionData);
        }
        let entries_len = num_fills * APPLY_FILL_ENTRY_SIZE;
        if payload_offset + entries_len > payload.len() {
            log!(
                64,
                "midprice apply_fills: payload short for maker {} fills",
                maker_i
            );
            return Err(ProgramError::InvalidInstructionData);
        }
        let entries = &payload[payload_offset..payload_offset + entries_len];
        payload_offset += entries_len;

        // Skip this maker on validation failure; other makers can still be filled.
        let data = match validate_fill_accounts_for_maker(program_id, accounts, maker_i) {
            Ok(d) => d,
            Err(_) => {
                log!(
                    64,
                    "midprice apply_fills: maker {} account validation failed, skipping",
                    maker_i
                );
                continue;
            }
        };

        let stored_market_index = u16::from_le_bytes(
            data[MARKET_INDEX_OFFSET..MARKET_INDEX_OFFSET + 2]
                .try_into()
                .unwrap(),
        );
        if stored_market_index != expected_market_index {
            log!(
                64,
                "midprice apply_fills: maker {} market_index mismatch, skipping",
                maker_i
            );
            continue;
        }

        let ref_slot = match data[REF_SLOT_OFFSET..REF_SLOT_OFFSET + 8].try_into() {
            Ok(b) => u64::from_le_bytes(b),
            Err(_) => {
                log!(
                    64,
                    "midprice apply_fills: maker {} bad ref_slot, skipping",
                    maker_i
                );
                continue;
            }
        };

        let stored_sequence =
            match data[SEQUENCE_NUMBER_OFFSET..SEQUENCE_NUMBER_OFFSET + 8].try_into() {
                Ok(b) => u64::from_le_bytes(b),
                Err(_) => {
                    log!(
                        64,
                        "midprice apply_fills: maker {} bad sequence_number, skipping",
                        maker_i
                    );
                    continue;
                }
            };
        if stored_sequence != expected_sequence {
            log!(
                64,
                "midprice apply_fills: maker {} sequence_number mismatch, skipping",
                maker_i
            );
            continue;
        }
        let quote_ttl_slots = match data[QUOTE_TTL_OFFSET..QUOTE_TTL_OFFSET + 8].try_into() {
            Ok(b) => u64::from_le_bytes(b),
            Err(_) => {
                log!(
                    64,
                    "midprice apply_fills: maker {} bad quote_ttl, skipping",
                    maker_i
                );
                continue;
            }
        };
        if quote_ttl_slots > 0 {
            if current_slot.saturating_sub(ref_slot) > quote_ttl_slots {
                log!(
                    64,
                    "midprice apply_fills: maker {} quote expired, skipping",
                    maker_i
                );
                continue;
            }
        }

        // Copy authority for event emission before creating book (which borrows data mutably).
        let authority_for_event: [u8; 32] = data[AUTHORITY_OFFSET..AUTHORITY_OFFSET + 32]
            .try_into()
            .unwrap_or([0u8; 32]);

        let mut book = match MidpriceBookViewMut::new(data) {
            Ok(b) => b,
            Err(_) => {
                log!(
                    64,
                    "midprice apply_fills: maker {} book view failed, skipping",
                    maker_i
                );
                continue;
            }
        };
        let mut start = 0usize;
        while start < entries.len() {
            let end = start + APPLY_FILL_ENTRY_SIZE;
            let entry = &entries[start..end];
            emit_order_filled_event(expected_market_index, &authority_for_event, entry);
            apply_fill_entry(&mut book, entry)?;
            start = end;
        }
        book.increment_sequence_number();
    }
    if payload_offset != payload.len() {
        log!(64, "midprice apply_fills: payload trailing bytes");
        return Err(ProgramError::InvalidInstructionData);
    }
    Ok(())
}

fn process_set_quote_ttl(
    program_id: &Address,
    accounts: &[AccountView],
    payload: &[u8],
) -> ProgramResult {
    if payload.len() != 8 {
        log!(
            64,
            "midprice set_quote_ttl: bad payload_len={} want 8",
            payload.len()
        );
        return Err(ProgramError::InvalidInstructionData);
    }

    let data = validate_authority_and_borrow_mut(program_id, accounts)?;

    data[QUOTE_TTL_OFFSET..QUOTE_TTL_OFFSET + 8].copy_from_slice(payload);

    let mut book = MidpriceBookViewMut::new(data).map_err(|_| ProgramError::InvalidAccountData)?;
    book.increment_sequence_number();
    Ok(())
}

/// Update order_tick_size and min_order_size stored on the midprice account. CPI-only from Drift.
/// Accounts: [midprice (w), authority (s), drift_matcher (s)]. Payload: order_tick_size (u64), min_order_size (u64).
fn process_update_tick_sizes(
    program_id: &Address,
    accounts: &[AccountView],
    payload: &[u8],
) -> ProgramResult {
    if payload.len() != 16 {
        log!(
            64,
            "midprice update_tick_sizes: bad payload_len={} want 16",
            payload.len()
        );
        return Err(ProgramError::InvalidInstructionData);
    }
    if accounts.len() < 3 {
        log!(
            64,
            "midprice update_tick_sizes: accounts_len={} want >= 3 (need drift_matcher signer); CPI-only from Drift",
            accounts.len()
        );
        return Err(ProgramError::Custom(AUTH_ERR_INIT_REQUIRES_DRIFT_CPI));
    }
    let drift_matcher = &accounts[2];
    if !drift_matcher.is_signer() {
        log!(64, "midprice update_tick_sizes: drift_matcher must be signer (CPI-only from Drift)");
        return Err(ProgramError::Custom(AUTH_ERR_INIT_REQUIRES_DRIFT_CPI));
    }
    let (expected_matcher_pda, _bump) =
        Address::try_find_program_address(&[PROP_AMM_MATCHER_SEED], &DRIFT_PROGRAM_ID)
            .ok_or(ProgramError::InvalidInstructionData)?;
    if drift_matcher.address().as_ref() != expected_matcher_pda.as_ref() {
        log!(
            64,
            "midprice update_tick_sizes: drift_matcher must be Drift prop_amm_matcher PDA"
        );
        return Err(ProgramError::Custom(AUTH_ERR_INIT_REQUIRES_DRIFT_CPI));
    }

    let data = validate_authority_and_borrow_mut(program_id, accounts)?;
    let order_tick_size = u64::from_le_bytes(payload[0..8].try_into().unwrap());
    let min_order_size = u64::from_le_bytes(payload[8..16].try_into().unwrap());

    data[ORDER_TICK_SIZE_OFFSET..ORDER_TICK_SIZE_OFFSET + 8]
        .copy_from_slice(&order_tick_size.to_le_bytes());
    data[MIN_ORDER_SIZE_OFFSET..MIN_ORDER_SIZE_OFFSET + 8]
        .copy_from_slice(&min_order_size.to_le_bytes());

    let mut book = MidpriceBookViewMut::new(data).map_err(|_| ProgramError::InvalidAccountData)?;
    book.increment_sequence_number();
    Ok(())
}

/// Close the midprice account, transferring lamports to a destination.
/// Accounts: [midprice (writable), authority (signer), destination (writable)].
fn process_close_account(
    program_id: &Address,
    accounts: &[AccountView],
    _payload: &[u8],
) -> ProgramResult {
    if accounts.len() != 3 {
        log!(64, "midprice close: accounts_len={} want 3", accounts.len());
        return Err(ProgramError::NotEnoughAccountKeys);
    }

    let midprice_account = &accounts[0];
    let authority = &accounts[1];
    let destination = &accounts[2];

    let mut err: u8 = 0;
    if !midprice_account.is_writable() {
        err |= AUTH_ERR_IMMUTABLE;
    }
    if !authority.is_signer() {
        err |= AUTH_ERR_MISSING_SIGNATURE;
    }
    if midprice_account.data_len() < ACCOUNT_MIN_LEN {
        err |= AUTH_ERR_INVALID_ACCOUNT_DATA;
    }
    if !unsafe {
        authority_matches_32(
            midprice_account.owner().as_ref().as_ptr(),
            program_id.as_ref().as_ptr(),
        )
    } {
        err |= AUTH_ERR_ILLEGAL_OWNER;
    }
    if err != 0 {
        log!(64, "midprice close: auth check failed err={}", err);
        return Err(ProgramError::Custom(err as u32));
    }
    if !destination.is_writable() {
        log!(64, "midprice close: destination not writable");
        return Err(ProgramError::Custom(AUTH_ERR_IMMUTABLE as u32));
    }

    {
        // Safety: no other borrows on this account.
        let data = unsafe { midprice_account.borrow_unchecked_mut() };
        check_layout_version(data)?;
        if data[AUTHORITY_OFFSET..AUTHORITY_OFFSET + 32] != *authority.address().as_ref() {
            log!(64, "midprice close: authority mismatch");
            return Err(ProgramError::Custom(AUTH_ERR_INVALID_AUTHORITY as u32));
        }
    }

    let source_lamports = midprice_account.lamports();
    destination.set_lamports(destination.lamports() + source_lamports);
    midprice_account.set_lamports(0);

    // Safety: lamports have been moved out; no active borrows on owner.
    unsafe { midprice_account.close_unchecked() };
    Ok(())
}

/// Transfer authority to a new pubkey.
/// Accounts: [midprice (writable), current_authority (signer)].
/// Payload: [new_authority: [u8; 32]].
fn process_transfer_authority(
    program_id: &Address,
    accounts: &[AccountView],
    payload: &[u8],
) -> ProgramResult {
    if payload.len() != 32 {
        log!(
            64,
            "midprice transfer_authority: bad payload_len={} want 32",
            payload.len()
        );
        return Err(ProgramError::InvalidInstructionData);
    }

    let data = validate_authority_and_borrow_mut(program_id, accounts)?;

    data[AUTHORITY_OFFSET..AUTHORITY_OFFSET + 32].copy_from_slice(payload);

    let mut book = MidpriceBookViewMut::new(data).map_err(|_| ProgramError::InvalidAccountData)?;
    book.increment_sequence_number();
    Ok(())
}

// ---------------------------------------------------------------------------
// Fill helpers
// ---------------------------------------------------------------------------

/// Validates one maker's midprice account (writable, owned by program, layout).
fn validate_fill_accounts_for_maker<'a>(
    program_id: &Address,
    accounts: &'a [AccountView],
    maker_index: usize,
) -> Result<&'a mut [u8], ProgramError> {
    let midprice_idx = 2 + maker_index;
    if midprice_idx >= accounts.len() {
        return Err(ProgramError::NotEnoughAccountKeys);
    }
    let midprice_account = &accounts[midprice_idx];

    if !midprice_account.is_writable() {
        log!(64, "midprice fill: account not writable");
        return Err(ProgramError::Custom(AUTH_ERR_IMMUTABLE as u32));
    }
    if midprice_account.data_len() < ACCOUNT_MIN_LEN {
        log!(64, "midprice fill: account data too small");
        return Err(ProgramError::Custom(AUTH_ERR_INVALID_ACCOUNT_DATA as u32));
    }
    if !unsafe {
        authority_matches_32(
            midprice_account.owner().as_ref().as_ptr(),
            program_id.as_ref().as_ptr(),
        )
    } {
        log!(64, "midprice fill: illegal owner");
        return Err(ProgramError::Custom(AUTH_ERR_ILLEGAL_OWNER as u32));
    }

    let data = unsafe { midprice_account.borrow_unchecked_mut() };
    check_layout_version(data)?;

    Ok(data)
}

fn apply_fill_entry(book: &mut MidpriceBookViewMut, entry: &[u8]) -> ProgramResult {
    if entry.len() != APPLY_FILL_ENTRY_SIZE {
        return Err(ProgramError::InvalidInstructionData);
    }
    let abs_index = u16::from_le_bytes([entry[0], entry[1]]) as usize;
    let is_ask = match entry[2] {
        0 => false,
        1 => true,
        _ => return Err(ProgramError::InvalidInstructionData),
    };
    let fill_size = u64::from_le_bytes(
        entry[3..11]
            .try_into()
            .map_err(|_| ProgramError::InvalidInstructionData)?,
    );
    if fill_size == 0 {
        return Err(ProgramError::InvalidInstructionData);
    }
    // Validate abs_index falls within the correct side's range. Without this check, a fill
    // entry with is_ask=true pointing into the bid range (or vice versa) would advance the
    // wrong head pointer and corrupt book traversal state.
    let ask_len = book.ask_len() as usize;
    let bid_len = book.bid_len() as usize;
    if is_ask {
        if abs_index >= ask_len {
            return Err(ProgramError::InvalidInstructionData);
        }
    } else if abs_index < ask_len || abs_index >= ask_len + bid_len {
        return Err(ProgramError::InvalidInstructionData);
    }
    let current_size = book
        .order_size_u64(abs_index)
        .map_err(|_| ProgramError::InvalidInstructionData)?;
    if fill_size > current_size {
        return Err(ProgramError::InvalidInstructionData);
    }
    book.set_order_size_u64(abs_index, current_size - fill_size)
        .map_err(|_| ProgramError::InvalidInstructionData)?;
    if is_ask {
        book.advance_ask_head_while_empty()
            .map_err(|_| ProgramError::InvalidInstructionData)?;
    } else {
        book.advance_bid_head_while_empty()
            .map_err(|_| ProgramError::InvalidInstructionData)?;
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Shared utilities
// ---------------------------------------------------------------------------

/// Read current slot from the Clock sysvar account at the given index (avoids Clock::get() syscall).
fn read_slot_from_clock_at(accounts: &[AccountView], index: usize) -> Option<u64> {
    if accounts.len() <= index {
        return None;
    }
    let clock_account = &accounts[index];
    if clock_account.data_len() < 8 {
        return None;
    }
    let data = unsafe { clock_account.borrow_unchecked() };
    let slot_bytes: [u8; 8] = data[0..8].try_into().ok()?;
    Some(u64::from_le_bytes(slot_bytes))
}


/// Increment sequence number in-place without constructing a MidpriceBookViewMut.
#[inline(always)]
fn increment_sequence_number(data: &mut [u8]) {
    let seq = u64::from_le_bytes(
        data[SEQUENCE_NUMBER_OFFSET..SEQUENCE_NUMBER_OFFSET + 8]
            .try_into()
            .unwrap(),
    );
    data[SEQUENCE_NUMBER_OFFSET..SEQUENCE_NUMBER_OFFSET + 8]
        .copy_from_slice(&seq.wrapping_add(1).to_le_bytes());
}

fn check_layout_version(data: &[u8]) -> ProgramResult {
    if data.len() < LAYOUT_VERSION_OFFSET + 8 {
        return Err(ProgramError::Custom(
            AUTH_ERR_UNSUPPORTED_LAYOUT_VERSION as u32,
        ));
    }
    if data[ACCOUNT_DISCRIMINATOR_OFFSET..ACCOUNT_DISCRIMINATOR_OFFSET + ACCOUNT_DISCRIMINATOR_SIZE]
        != MIDPRICE_ACCOUNT_DISCRIMINATOR
    {
        return Err(ProgramError::Custom(
            AUTH_ERR_UNSUPPORTED_LAYOUT_VERSION as u32,
        ));
    }
    let version_bytes: [u8; 8] = data[LAYOUT_VERSION_OFFSET..LAYOUT_VERSION_OFFSET + 8]
        .try_into()
        .map_err(|_| ProgramError::Custom(AUTH_ERR_UNSUPPORTED_LAYOUT_VERSION as u32))?;
    let version = u64::from_le_bytes(version_bytes);
    if version != LAYOUT_VERSION_INITIAL {
        return Err(ProgramError::Custom(
            AUTH_ERR_UNSUPPORTED_LAYOUT_VERSION as u32,
        ));
    }
    Ok(())
}

/// Compares two 32-byte regions as 4 u64 words (used where CU cost matters).
#[inline(always)]
unsafe fn authority_matches_32(stored_ptr: *const u8, authority_ptr: *const u8) -> bool {
    let d0 = core::ptr::read_unaligned(stored_ptr as *const u64)
        ^ core::ptr::read_unaligned(authority_ptr as *const u64);
    let d1 = core::ptr::read_unaligned(stored_ptr.add(8) as *const u64)
        ^ core::ptr::read_unaligned(authority_ptr.add(8) as *const u64);
    let d2 = core::ptr::read_unaligned(stored_ptr.add(16) as *const u64)
        ^ core::ptr::read_unaligned(authority_ptr.add(16) as *const u64);
    let d3 = core::ptr::read_unaligned(stored_ptr.add(24) as *const u64)
        ^ core::ptr::read_unaligned(authority_ptr.add(24) as *const u64);
    (d0 | d1 | d2 | d3) == 0
}

#[inline(always)]
unsafe fn ptr_is_zero_32(ptr: *const u8) -> bool {
    let d0 = core::ptr::read_unaligned(ptr as *const u64);
    let d1 = core::ptr::read_unaligned(ptr.add(8) as *const u64);
    let d2 = core::ptr::read_unaligned(ptr.add(16) as *const u64);
    let d3 = core::ptr::read_unaligned(ptr.add(24) as *const u64);
    (d0 | d1 | d2 | d3) == 0
}

// ---------------------------------------------------------------------------
// Unit tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use core::ptr;
    use midprice_book_view::{
        ACCOUNT_DISCRIMINATOR_OFFSET, ACCOUNT_DISCRIMINATOR_SIZE, ASK_HEAD_OFFSET, ASK_LEN_OFFSET,
        BID_HEAD_OFFSET, BID_LEN_OFFSET, LAYOUT_VERSION_INITIAL, MIDPRICE_ACCOUNT_DISCRIMINATOR,
        ORDER_ENTRY_SIZE_OFFSET, SUBACCOUNT_INDEX_OFFSET,
    };
    use solana_account_view::{RuntimeAccount, NOT_BORROWED};

    /// Test addresses (use byte arrays to avoid pubkey! const-eval limits in tests).
    fn test_program_id() -> Address {
        Address::new_from_array([1u8; 32])
    }
    fn test_authority() -> Address {
        Address::new_from_array([2u8; 32])
    }
    fn test_midprice_account() -> Address {
        Address::new_from_array([3u8; 32])
    }
    fn test_system_program() -> Address {
        Address::new_from_array([0u8; 32])
    }
    fn midprice_pda(
        program_id: &Address,
        authority: &Address,
        market_index: u16,
        subaccount_index: u16,
    ) -> Address {
        let (pda, _) = Address::try_find_program_address(
            &[
                b"midprice",
                &market_index.to_le_bytes(),
                authority.as_ref(),
                &subaccount_index.to_le_bytes(),
            ],
            program_id,
        )
        .unwrap();
        pda
    }
    fn test_new_authority() -> Address {
        Address::new_from_array([4u8; 32])
    }
    fn test_wrong_clock() -> Address {
        Address::new_from_array([5u8; 32])
    }
    /// Build 20-byte init payload: market_index (2), subaccount_index (2), order_tick_size (8), min_order_size (8).
    fn init_payload(
        market_index: u16,
        subaccount_index: u16,
        order_tick_size: u64,
        min_order_size: u64,
    ) -> Vec<u8> {
        let mut p = Vec::with_capacity(20);
        p.extend_from_slice(&market_index.to_le_bytes());
        p.extend_from_slice(&subaccount_index.to_le_bytes());
        p.extend_from_slice(&order_tick_size.to_le_bytes());
        p.extend_from_slice(&min_order_size.to_le_bytes());
        p
    }

    /// Build a single mock account backing (RuntimeAccount header + data). Caller must keep
    /// the returned Vec alive while using the AccountView.
    fn mock_account_backing(
        address: Address,
        owner: Address,
        data_len: usize,
        is_signer: bool,
        is_writable: bool,
        lamports: u64,
        data_init: Option<&[u8]>,
    ) -> Vec<u8> {
        let hdr_size = core::mem::size_of::<RuntimeAccount>();
        let total = hdr_size + data_len;
        let mut backing = vec![0u8; total];
        let hdr = backing.as_mut_ptr() as *mut RuntimeAccount;
        unsafe {
            ptr::write(
                hdr,
                RuntimeAccount {
                    borrow_state: NOT_BORROWED,
                    is_signer: if is_signer { 1 } else { 0 },
                    is_writable: if is_writable { 1 } else { 0 },
                    executable: 0,
                    resize_delta: 0,
                    address,
                    owner,
                    lamports,
                    data_len: data_len as u64,
                },
            );
            if let Some(d) = data_init {
                let data_ptr = (hdr as *mut u8).add(hdr_size);
                let copy_len = core::cmp::min(d.len(), data_len);
                ptr::copy_nonoverlapping(d.as_ptr(), data_ptr, copy_len);
            }
        }
        backing
    }

    /// Create an AccountView from a backing buffer. The backing must outlive the view.
    fn account_view_from_backing(backing: &mut [u8]) -> AccountView {
        unsafe { AccountView::new_unchecked(backing.as_mut_ptr() as *mut RuntimeAccount) }
    }

    /// Build midprice account data with given header and order sizes (asks then bids). Each order
    /// is stored as offset=0 i64 + size u64. Used for apply_fills tests.
    fn make_midprice_data_with_orders(
        authority: &Address,
        market_index: u16,
        subaccount_index: u16,
        order_tick_size: u64,
        min_order_size: u64,
        ref_slot: u64,
        quote_ttl_slots: u64,
        ask_sizes: &[u64],
        bid_sizes: &[u64],
    ) -> Vec<u8> {
        let ask_len = ask_sizes.len() as u16;
        let bid_len = bid_sizes.len() as u16;
        let total_orders = ask_len as usize + bid_len as usize;
        let data_len = ORDERS_DATA_OFFSET + total_orders * ORDER_ENTRY_SIZE;
        let mut data = vec![0u8; data_len];
        data[ACCOUNT_DISCRIMINATOR_OFFSET
            ..ACCOUNT_DISCRIMINATOR_OFFSET + ACCOUNT_DISCRIMINATOR_SIZE]
            .copy_from_slice(&MIDPRICE_ACCOUNT_DISCRIMINATOR);
        data[LAYOUT_VERSION_OFFSET..LAYOUT_VERSION_OFFSET + 8]
            .copy_from_slice(&LAYOUT_VERSION_INITIAL.to_le_bytes());
        data[AUTHORITY_OFFSET..AUTHORITY_OFFSET + 32].copy_from_slice(authority.as_ref());
        data[REF_SLOT_OFFSET..REF_SLOT_OFFSET + 8].copy_from_slice(&ref_slot.to_le_bytes());
        data[MARKET_INDEX_OFFSET..MARKET_INDEX_OFFSET + 2]
            .copy_from_slice(&market_index.to_le_bytes());
        data[SUBACCOUNT_INDEX_OFFSET..SUBACCOUNT_INDEX_OFFSET + 2]
            .copy_from_slice(&subaccount_index.to_le_bytes());
        data[ORDER_TICK_SIZE_OFFSET..ORDER_TICK_SIZE_OFFSET + 8]
            .copy_from_slice(&order_tick_size.to_le_bytes());
        data[MIN_ORDER_SIZE_OFFSET..MIN_ORDER_SIZE_OFFSET + 8]
            .copy_from_slice(&min_order_size.to_le_bytes());
        data[ASK_LEN_OFFSET..ASK_LEN_OFFSET + 2].copy_from_slice(&ask_len.to_le_bytes());
        data[BID_LEN_OFFSET..BID_LEN_OFFSET + 2].copy_from_slice(&bid_len.to_le_bytes());
        data[ASK_HEAD_OFFSET..ASK_HEAD_OFFSET + 2].copy_from_slice(&0u16.to_le_bytes());
        data[BID_HEAD_OFFSET..BID_HEAD_OFFSET + 2].copy_from_slice(&0u16.to_le_bytes());
        data[QUOTE_TTL_OFFSET..QUOTE_TTL_OFFSET + 8]
            .copy_from_slice(&quote_ttl_slots.to_le_bytes());
        data[SEQUENCE_NUMBER_OFFSET..SEQUENCE_NUMBER_OFFSET + 8]
            .copy_from_slice(&0u64.to_le_bytes());
        data[ORDER_ENTRY_SIZE_OFFSET..ORDER_ENTRY_SIZE_OFFSET + 2]
            .copy_from_slice(&(ORDER_ENTRY_SIZE as u16).to_le_bytes());
        let mut off = ORDERS_DATA_OFFSET;
        for &sz in ask_sizes {
            data[off..off + 8].copy_from_slice(&0i64.to_le_bytes());
            data[off + 8..off + 16].copy_from_slice(&sz.to_le_bytes());
            off += ORDER_ENTRY_SIZE;
        }
        for &sz in bid_sizes {
            data[off..off + 8].copy_from_slice(&0i64.to_le_bytes());
            data[off + 8..off + 16].copy_from_slice(&sz.to_le_bytes());
            off += ORDER_ENTRY_SIZE;
        }
        data
    }

    /// Build one fill entry: [abs_index u16 LE][is_ask u8][fill_size u64 LE].
    fn fill_entry(abs_index: u16, is_ask: bool, fill_size: u64) -> [u8; APPLY_FILL_ENTRY_SIZE] {
        let mut buf = [0u8; APPLY_FILL_ENTRY_SIZE];
        buf[0..2].copy_from_slice(&abs_index.to_le_bytes());
        buf[2] = if is_ask { 1 } else { 0 };
        buf[3..11].copy_from_slice(&fill_size.to_le_bytes());
        buf
    }

    /// Drift prop_amm_matcher PDA backing for initialize tests (CPI-only gate). Pass as accounts[3] with is_signer=true.
    fn init_drift_matcher_backing() -> Vec<u8> {
        let (expected_matcher_pda, _) =
            Address::try_find_program_address(&[PROP_AMM_MATCHER_SEED], &DRIFT_PROGRAM_ID).unwrap();
        mock_account_backing(
            expected_matcher_pda,
            DRIFT_PROGRAM_ID,
            0,
            true,
            false,
            0,
            None,
        )
    }

    /// Common setup for apply_fills: matcher (signer), clock (slot), returns (matcher_backing, clock_backing, current_slot).
    fn apply_fills_setup_matcher_clock(current_slot: u64) -> (Vec<u8>, Vec<u8>, u64) {
        let (expected_matcher_pda, _) =
            Address::try_find_program_address(&[b"prop_amm_matcher"], &DRIFT_PROGRAM_ID).unwrap();
        let matcher_backing = mock_account_backing(
            expected_matcher_pda,
            DRIFT_PROGRAM_ID,
            0,
            true,
            false,
            0,
            None,
        );
        let clock_backing = mock_account_backing(
            CLOCK_SYSVAR_ID,
            test_system_program(),
            8,
            false,
            false,
            0,
            Some(&current_slot.to_le_bytes()),
        );
        (matcher_backing, clock_backing, current_slot)
    }

    #[test]
    fn process_instruction_empty_data_returns_invalid_instruction_data() {
        let program_id = test_program_id();
        let accounts: &[AccountView] = &[];
        let result = process_instruction(&program_id, accounts, &[]);
        assert!(matches!(result, Err(ProgramError::InvalidInstructionData)));
    }

    #[test]
    fn process_instruction_unknown_opcode_returns_invalid_instruction_data() {
        let program_id = test_program_id();
        let accounts: &[AccountView] = &[];
        let ix = [99u8]; // unknown opcode
        let result = process_instruction(&program_id, accounts, &ix);
        assert!(matches!(result, Err(ProgramError::InvalidInstructionData)));
    }

    #[test]
    fn process_initialize_success() {
        let program_id = test_program_id();
        let authority = test_authority();
        let market_index = 1u16;
        let subaccount_index = 0u16;
        let pda = midprice_pda(&program_id, &authority, market_index, subaccount_index);
        let mut midprice_backing =
            mock_account_backing(pda, program_id, ACCOUNT_MIN_LEN, false, true, 1000, None);
        let mut auth_backing =
            mock_account_backing(authority, test_system_program(), 0, true, false, 0, None);
        let mut matcher_backing = init_drift_matcher_backing();
        let payload = init_payload(market_index, subaccount_index, 100, 10);
        let mut ix = vec![IX_INITIALIZE_MID_PRICE_ACCOUNT];
        ix.extend_from_slice(&payload);
        let accounts = [
            account_view_from_backing(&mut midprice_backing),
            account_view_from_backing(&mut auth_backing),
            account_view_from_backing(&mut matcher_backing),
        ];
        let result = process_instruction(&program_id, &accounts, &ix);
        assert!(result.is_ok());
        let data = unsafe { accounts[0].borrow_unchecked() };
        assert_eq!(
            data[ACCOUNT_DISCRIMINATOR_OFFSET
                ..ACCOUNT_DISCRIMINATOR_OFFSET + ACCOUNT_DISCRIMINATOR_SIZE],
            MIDPRICE_ACCOUNT_DISCRIMINATOR
        );
        assert_eq!(
            data[LAYOUT_VERSION_OFFSET..LAYOUT_VERSION_OFFSET + 8],
            LAYOUT_VERSION_INITIAL.to_le_bytes()
        );
        assert_eq!(
            data[ORDER_ENTRY_SIZE_OFFSET..ORDER_ENTRY_SIZE_OFFSET + 2],
            (ORDER_ENTRY_SIZE as u16).to_le_bytes()
        );
        assert_eq!(
            data[AUTHORITY_OFFSET..AUTHORITY_OFFSET + 32],
            authority.as_ref()[..]
        );
        assert_eq!(
            data[SUBACCOUNT_INDEX_OFFSET..SUBACCOUNT_INDEX_OFFSET + 2],
            subaccount_index.to_le_bytes()
        );
        assert_eq!(
            data[ORDER_TICK_SIZE_OFFSET..ORDER_TICK_SIZE_OFFSET + 8],
            100u64.to_le_bytes()
        );
        assert_eq!(
            data[MIN_ORDER_SIZE_OFFSET..MIN_ORDER_SIZE_OFFSET + 8],
            10u64.to_le_bytes()
        );
    }

    #[test]
    fn process_initialize_wrong_account_count() {
        let program_id = test_program_id();
        let authority = test_authority();
        let pda = midprice_pda(&program_id, &authority, 0, 0);
        let mut midprice_backing =
            mock_account_backing(pda, program_id, ACCOUNT_MIN_LEN, false, true, 1000, None);
        let mut auth_backing =
            mock_account_backing(authority, test_system_program(), 0, true, false, 0, None);
        let accounts = [
            account_view_from_backing(&mut midprice_backing),
            account_view_from_backing(&mut auth_backing),
        ];
        let payload = init_payload(0, 0, 100, 10);
        let mut ix = vec![IX_INITIALIZE_MID_PRICE_ACCOUNT];
        ix.extend_from_slice(&payload);
        let result = process_instruction(&program_id, &accounts, &ix);
        assert!(matches!(
            result,
            Err(ProgramError::Custom(AUTH_ERR_INIT_REQUIRES_DRIFT_CPI))
        ));
    }

    #[test]
    fn process_initialize_missing_matcher_fails() {
        let program_id = test_program_id();
        let authority = test_authority();
        let market_index = 1u16;
        let pda = midprice_pda(&program_id, &authority, market_index, 0);
        let mut midprice_backing =
            mock_account_backing(pda, program_id, ACCOUNT_MIN_LEN, false, true, 1000, None);
        let mut auth_backing =
            mock_account_backing(authority, test_system_program(), 0, true, false, 0, None);
        let accounts = [
            account_view_from_backing(&mut midprice_backing),
            account_view_from_backing(&mut auth_backing),
        ];
        let payload = init_payload(market_index, 0, 100, 10);
        let mut ix = vec![IX_INITIALIZE_MID_PRICE_ACCOUNT];
        ix.extend_from_slice(&payload);
        let result = process_instruction(&program_id, &accounts, &ix);
        assert!(matches!(
            result,
            Err(ProgramError::Custom(AUTH_ERR_INIT_REQUIRES_DRIFT_CPI))
        ));
    }

    #[test]
    fn process_initialize_invalid_payload_length() {
        let program_id = test_program_id();
        let authority = test_authority();
        let mut midprice_backing = mock_account_backing(
            test_midprice_account(),
            program_id,
            ACCOUNT_MIN_LEN,
            false,
            true,
            1000,
            None,
        );
        let mut auth_backing =
            mock_account_backing(authority, test_system_program(), 0, true, false, 0, None);
        let mut matcher_backing = init_drift_matcher_backing();
        let accounts = [
            account_view_from_backing(&mut midprice_backing),
            account_view_from_backing(&mut auth_backing),
            account_view_from_backing(&mut matcher_backing),
        ];
        let ix = [IX_INITIALIZE_MID_PRICE_ACCOUNT, 0u8]; // only 1 byte payload (need 20)
        let result = process_instruction(&program_id, &accounts, &ix);
        assert!(matches!(result, Err(ProgramError::InvalidInstructionData)));
    }

    #[test]
    fn process_initialize_authority_not_signer() {
        let program_id = test_program_id();
        let authority = test_authority();
        let pda = midprice_pda(&program_id, &authority, 0, 0);
        let mut midprice_backing =
            mock_account_backing(pda, program_id, ACCOUNT_MIN_LEN, false, true, 1000, None);
        let mut auth_backing = mock_account_backing(
            authority,
            test_system_program(),
            0,
            false, // not signer
            false,
            0,
            None,
        );
        let mut matcher_backing = init_drift_matcher_backing();
        let payload = init_payload(0, 0, 100, 10);
        let mut ix = vec![IX_INITIALIZE_MID_PRICE_ACCOUNT];
        ix.extend_from_slice(&payload);
        let accounts = [
            account_view_from_backing(&mut midprice_backing),
            account_view_from_backing(&mut auth_backing),
            account_view_from_backing(&mut matcher_backing),
        ];
        let result = process_instruction(&program_id, &accounts, &ix);
        assert!(matches!(result, Err(ProgramError::Custom(0x02)))); // AUTH_ERR_MISSING_SIGNATURE
    }

    #[test]
    fn process_initialize_midprice_not_writable() {
        let program_id = test_program_id();
        let authority = test_authority();
        let pda = midprice_pda(&program_id, &authority, 0, 0);
        let mut midprice_backing = mock_account_backing(
            pda,
            program_id,
            ACCOUNT_MIN_LEN,
            false,
            false, // not writable
            1000,
            None,
        );
        let mut auth_backing =
            mock_account_backing(authority, test_system_program(), 0, true, false, 0, None);
        let mut matcher_backing = init_drift_matcher_backing();
        let payload = init_payload(0, 0, 100, 10);
        let mut ix = vec![IX_INITIALIZE_MID_PRICE_ACCOUNT];
        ix.extend_from_slice(&payload);
        let accounts = [
            account_view_from_backing(&mut midprice_backing),
            account_view_from_backing(&mut auth_backing),
            account_view_from_backing(&mut matcher_backing),
        ];
        let result = process_instruction(&program_id, &accounts, &ix);
        assert!(matches!(result, Err(ProgramError::Custom(0x01)))); // AUTH_ERR_IMMUTABLE
    }

    #[test]
    fn process_initialize_reinit_fails() {
        let program_id = test_program_id();
        let authority = test_authority();
        let pda = midprice_pda(&program_id, &authority, 0, 0);
        let mut data = vec![0u8; ACCOUNT_MIN_LEN];
        data[ACCOUNT_DISCRIMINATOR_OFFSET
            ..ACCOUNT_DISCRIMINATOR_OFFSET + ACCOUNT_DISCRIMINATOR_SIZE]
            .copy_from_slice(&MIDPRICE_ACCOUNT_DISCRIMINATOR);
        data[LAYOUT_VERSION_OFFSET..LAYOUT_VERSION_OFFSET + 8]
            .copy_from_slice(&LAYOUT_VERSION_INITIAL.to_le_bytes());
        data[ORDER_ENTRY_SIZE_OFFSET..ORDER_ENTRY_SIZE_OFFSET + 2]
            .copy_from_slice(&(ORDER_ENTRY_SIZE as u16).to_le_bytes());
        data[AUTHORITY_OFFSET..AUTHORITY_OFFSET + 32].copy_from_slice(authority.as_ref());
        let mut midprice_backing = mock_account_backing(
            pda,
            program_id,
            ACCOUNT_MIN_LEN,
            false,
            true,
            1000,
            Some(&data),
        );
        let mut auth_backing =
            mock_account_backing(authority, test_system_program(), 0, true, false, 0, None);
        let mut matcher_backing = init_drift_matcher_backing();
        let accounts = [
            account_view_from_backing(&mut midprice_backing),
            account_view_from_backing(&mut auth_backing),
            account_view_from_backing(&mut matcher_backing),
        ];
        let payload = init_payload(0, 0, 100, 10);
        let mut ix = vec![IX_INITIALIZE_MID_PRICE_ACCOUNT];
        ix.extend_from_slice(&payload);
        let result = process_instruction(&program_id, &accounts, &ix);
        assert!(matches!(result, Err(ProgramError::Custom(0x20)))); // AUTH_ERR_ALREADY_INITIALIZED
    }

    #[test]
    fn process_initialize_direct_invocation_rejected() {
        let program_id = test_program_id();
        let authority = test_authority();
        let market_index = 1u16;
        let pda = midprice_pda(&program_id, &authority, market_index, 0);
        let mut midprice_backing =
            mock_account_backing(pda, program_id, ACCOUNT_MIN_LEN, false, true, 1000, None);
        let mut auth_backing =
            mock_account_backing(authority, test_system_program(), 0, true, false, 0, None);
        // No matcher account — simulates a direct invocation without Drift CPI.
        let accounts = [
            account_view_from_backing(&mut midprice_backing),
            account_view_from_backing(&mut auth_backing),
        ];
        let payload = init_payload(market_index, 0, 100, 10);
        let mut ix = vec![IX_INITIALIZE_MID_PRICE_ACCOUNT];
        ix.extend_from_slice(&payload);
        let result = process_instruction(&program_id, &accounts, &ix);
        assert!(matches!(
            result,
            Err(ProgramError::Custom(AUTH_ERR_INIT_REQUIRES_DRIFT_CPI))
        ));
    }

    #[test]
    fn process_initialize_matcher_not_signer_rejected() {
        let program_id = test_program_id();
        let authority = test_authority();
        let market_index = 1u16;
        let pda = midprice_pda(&program_id, &authority, market_index, 0);
        let mut midprice_backing =
            mock_account_backing(pda, program_id, ACCOUNT_MIN_LEN, false, true, 1000, None);
        let mut auth_backing =
            mock_account_backing(authority, test_system_program(), 0, true, false, 0, None);
        let (matcher_pda, _) =
            Address::try_find_program_address(&[PROP_AMM_MATCHER_SEED], &DRIFT_PROGRAM_ID).unwrap();
        let mut matcher_backing = mock_account_backing(
            matcher_pda,
            DRIFT_PROGRAM_ID,
            0,
            false, // not signer — simulates missing Drift CPI context
            false,
            0,
            None,
        );
        let accounts = [
            account_view_from_backing(&mut midprice_backing),
            account_view_from_backing(&mut auth_backing),
            account_view_from_backing(&mut matcher_backing),
        ];
        let payload = init_payload(market_index, 0, 100, 10);
        let mut ix = vec![IX_INITIALIZE_MID_PRICE_ACCOUNT];
        ix.extend_from_slice(&payload);
        let result = process_instruction(&program_id, &accounts, &ix);
        assert!(matches!(
            result,
            Err(ProgramError::Custom(AUTH_ERR_INIT_REQUIRES_DRIFT_CPI))
        ));
    }

    #[test]
    fn process_update_mid_price_invalid_payload_length() {
        let program_id = test_program_id();
        let authority = test_authority();
        let mut data = vec![0u8; ACCOUNT_MIN_LEN];
        data[ACCOUNT_DISCRIMINATOR_OFFSET
            ..ACCOUNT_DISCRIMINATOR_OFFSET + ACCOUNT_DISCRIMINATOR_SIZE]
            .copy_from_slice(&MIDPRICE_ACCOUNT_DISCRIMINATOR);
        data[LAYOUT_VERSION_OFFSET..LAYOUT_VERSION_OFFSET + 8]
            .copy_from_slice(&LAYOUT_VERSION_INITIAL.to_le_bytes());
        data[ORDER_ENTRY_SIZE_OFFSET..ORDER_ENTRY_SIZE_OFFSET + 2]
            .copy_from_slice(&(ORDER_ENTRY_SIZE as u16).to_le_bytes());
        data[AUTHORITY_OFFSET..AUTHORITY_OFFSET + 32].copy_from_slice(authority.as_ref());
        let mut midprice_backing = mock_account_backing(
            test_midprice_account(),
            program_id,
            ACCOUNT_MIN_LEN,
            false,
            true,
            1000,
            Some(&data),
        );
        let mut auth_backing =
            mock_account_backing(authority, test_system_program(), 0, true, false, 0, None);
        let accounts = [
            account_view_from_backing(&mut midprice_backing),
            account_view_from_backing(&mut auth_backing),
        ];
        let ix = [IX_UPDATE_MID_PRICE, 0u8, 0u8]; // only 2 payload bytes, need 24
        let result = process_instruction(&program_id, &accounts, &ix);
        assert!(matches!(result, Err(ProgramError::InvalidInstructionData)));
    }

    #[test]
    fn process_update_mid_price_success() {
        let program_id = test_program_id();
        let authority = test_authority();
        let mut data = vec![0u8; ACCOUNT_MIN_LEN];
        data[ACCOUNT_DISCRIMINATOR_OFFSET
            ..ACCOUNT_DISCRIMINATOR_OFFSET + ACCOUNT_DISCRIMINATOR_SIZE]
            .copy_from_slice(&MIDPRICE_ACCOUNT_DISCRIMINATOR);
        data[LAYOUT_VERSION_OFFSET..LAYOUT_VERSION_OFFSET + 8]
            .copy_from_slice(&LAYOUT_VERSION_INITIAL.to_le_bytes());
        data[ORDER_ENTRY_SIZE_OFFSET..ORDER_ENTRY_SIZE_OFFSET + 2]
            .copy_from_slice(&(ORDER_ENTRY_SIZE as u16).to_le_bytes());
        data[AUTHORITY_OFFSET..AUTHORITY_OFFSET + 32].copy_from_slice(authority.as_ref());
        let mut midprice_backing = mock_account_backing(
            test_midprice_account(),
            program_id,
            ACCOUNT_MIN_LEN,
            false,
            true,
            1000,
            Some(&data),
        );
        let mut auth_backing =
            mock_account_backing(authority, test_system_program(), 0, true, false, 0, None);
        let accounts = [
            account_view_from_backing(&mut midprice_backing),
            account_view_from_backing(&mut auth_backing),
        ];
        let price_payload: [u8; 16] = [1u8; 16]; // arbitrary mid_price + reserved
        let ref_slot: u64 = 42;
        let mut ix = vec![IX_UPDATE_MID_PRICE];
        ix.extend_from_slice(&price_payload);
        ix.extend_from_slice(&ref_slot.to_le_bytes());
        let result = process_instruction(&program_id, &accounts, &ix);
        assert!(result.is_ok());
        let data = unsafe { accounts[0].borrow_unchecked() };
        assert_eq!(data[MID_PRICE_OFFSET..MID_PRICE_OFFSET + 16], price_payload);
        assert_eq!(
            data[REF_SLOT_OFFSET..REF_SLOT_OFFSET + 8],
            ref_slot.to_le_bytes()
        );
    }

    #[test]
    fn update_mid_price_reserved_bytes_are_passthrough() {
        // The 8 bytes at MID_PRICE_OFFSET+8 are currently reserved. The handler
        // copies all 16 payload bytes verbatim. This test documents that behavior
        // so any change to reserved-byte handling (e.g. zeroing them) is caught.
        let program_id = test_program_id();
        let authority = test_authority();
        let mut data = vec![0u8; ACCOUNT_MIN_LEN];
        data[ACCOUNT_DISCRIMINATOR_OFFSET
            ..ACCOUNT_DISCRIMINATOR_OFFSET + ACCOUNT_DISCRIMINATOR_SIZE]
            .copy_from_slice(&MIDPRICE_ACCOUNT_DISCRIMINATOR);
        data[LAYOUT_VERSION_OFFSET..LAYOUT_VERSION_OFFSET + 8]
            .copy_from_slice(&LAYOUT_VERSION_INITIAL.to_le_bytes());
        data[ORDER_ENTRY_SIZE_OFFSET..ORDER_ENTRY_SIZE_OFFSET + 2]
            .copy_from_slice(&(ORDER_ENTRY_SIZE as u16).to_le_bytes());
        data[AUTHORITY_OFFSET..AUTHORITY_OFFSET + 32].copy_from_slice(authority.as_ref());
        let mut midprice_backing = mock_account_backing(
            test_midprice_account(),
            program_id,
            ACCOUNT_MIN_LEN,
            false,
            true,
            1000,
            Some(&data),
        );
        let mut auth_backing =
            mock_account_backing(authority, test_system_program(), 0, true, false, 0, None);
        let accounts = [
            account_view_from_backing(&mut midprice_backing),
            account_view_from_backing(&mut auth_backing),
        ];

        let mid_price: u64 = 100_000;
        let reserved_garbage: [u8; 8] = [0xAB; 8]; // non-zero reserved bytes
        let ref_slot: u64 = 99;
        let mut ix = vec![IX_UPDATE_MID_PRICE];
        ix.extend_from_slice(&mid_price.to_le_bytes());
        ix.extend_from_slice(&reserved_garbage);
        ix.extend_from_slice(&ref_slot.to_le_bytes());

        let result = process_instruction(&program_id, &accounts, &ix);
        assert!(result.is_ok());

        let data = unsafe { accounts[0].borrow_unchecked() };
        // mid_price written correctly
        assert_eq!(
            data[MID_PRICE_OFFSET..MID_PRICE_OFFSET + 8],
            mid_price.to_le_bytes()
        );
        // reserved bytes are passed through, NOT zeroed
        assert_eq!(
            data[MID_PRICE_OFFSET + 8..MID_PRICE_OFFSET + 16],
            reserved_garbage,
            "reserved bytes should be written verbatim from payload"
        );
        assert_eq!(
            data[REF_SLOT_OFFSET..REF_SLOT_OFFSET + 8],
            ref_slot.to_le_bytes()
        );
    }

    #[test]
    fn process_set_orders_invalid_payload_too_short() {
        let program_id = test_program_id();
        let authority = test_authority();
        let mut data = vec![0u8; ACCOUNT_MIN_LEN];
        data[ACCOUNT_DISCRIMINATOR_OFFSET
            ..ACCOUNT_DISCRIMINATOR_OFFSET + ACCOUNT_DISCRIMINATOR_SIZE]
            .copy_from_slice(&MIDPRICE_ACCOUNT_DISCRIMINATOR);
        data[LAYOUT_VERSION_OFFSET..LAYOUT_VERSION_OFFSET + 8]
            .copy_from_slice(&LAYOUT_VERSION_INITIAL.to_le_bytes());
        data[ORDER_ENTRY_SIZE_OFFSET..ORDER_ENTRY_SIZE_OFFSET + 2]
            .copy_from_slice(&(ORDER_ENTRY_SIZE as u16).to_le_bytes());
        data[AUTHORITY_OFFSET..AUTHORITY_OFFSET + 32].copy_from_slice(authority.as_ref());
        let mut midprice_backing = mock_account_backing(
            test_midprice_account(),
            program_id,
            ACCOUNT_MIN_LEN,
            false,
            true,
            1000,
            Some(&data),
        );
        let mut auth_backing =
            mock_account_backing(authority, test_system_program(), 0, true, false, 0, None);
        let accounts = [
            account_view_from_backing(&mut midprice_backing),
            account_view_from_backing(&mut auth_backing),
        ];
        let ix = [IX_SET_ORDERS, 0u8, 0u8]; // payload len 2, need at least 12
        let result = process_instruction(&program_id, &accounts, &ix);
        assert!(matches!(result, Err(ProgramError::InvalidInstructionData)));
    }

    #[test]
    fn process_set_orders_success_empty_book() {
        let program_id = test_program_id();
        let authority = test_authority();
        let market_index = 0u16;
        let mut data = vec![0u8; ACCOUNT_MIN_LEN];
        data[ACCOUNT_DISCRIMINATOR_OFFSET
            ..ACCOUNT_DISCRIMINATOR_OFFSET + ACCOUNT_DISCRIMINATOR_SIZE]
            .copy_from_slice(&MIDPRICE_ACCOUNT_DISCRIMINATOR);
        data[LAYOUT_VERSION_OFFSET..LAYOUT_VERSION_OFFSET + 8]
            .copy_from_slice(&LAYOUT_VERSION_INITIAL.to_le_bytes());
        data[ORDER_ENTRY_SIZE_OFFSET..ORDER_ENTRY_SIZE_OFFSET + 2]
            .copy_from_slice(&(ORDER_ENTRY_SIZE as u16).to_le_bytes());
        data[AUTHORITY_OFFSET..AUTHORITY_OFFSET + 32].copy_from_slice(authority.as_ref());
        data[MARKET_INDEX_OFFSET..MARKET_INDEX_OFFSET + 2]
            .copy_from_slice(&market_index.to_le_bytes());
        let mut midprice_backing = mock_account_backing(
            test_midprice_account(),
            program_id,
            ACCOUNT_MIN_LEN,
            false,
            true,
            1000,
            Some(&data),
        );
        let mut auth_backing =
            mock_account_backing(authority, test_system_program(), 0, true, false, 0, None);
        let accounts = [
            account_view_from_backing(&mut midprice_backing),
            account_view_from_backing(&mut auth_backing),
        ];
        // ref_slot=50, ask_len=0, bid_len=0, no orders
        let ref_slot: u64 = 50;
        let mut payload = vec![];
        payload.extend_from_slice(&ref_slot.to_le_bytes());
        payload.extend_from_slice(&[0u8, 0u8, 0u8, 0u8]); // ask_len=0, bid_len=0
        let mut ix = vec![IX_SET_ORDERS];
        ix.extend_from_slice(&payload);
        let result = process_instruction(&program_id, &accounts, &ix);
        assert!(result.is_ok());
        let data = unsafe { accounts[0].borrow_unchecked() };
        assert_eq!(
            data[REF_SLOT_OFFSET..REF_SLOT_OFFSET + 8],
            ref_slot.to_le_bytes()
        );
    }

    #[test]
    fn process_set_orders_success_with_orders_on_tick() {
        let program_id = test_program_id();
        let authority = test_authority();
        let market_index = 1u16;
        let mid_price = 1000u64;
        let order_tick_size = 100u64;
        let min_order_size = 10u64;
        let data_len = ORDERS_DATA_OFFSET + ORDER_ENTRY_SIZE; // room for 1 order
        let mut data = vec![0u8; data_len];
        data[ACCOUNT_DISCRIMINATOR_OFFSET
            ..ACCOUNT_DISCRIMINATOR_OFFSET + ACCOUNT_DISCRIMINATOR_SIZE]
            .copy_from_slice(&MIDPRICE_ACCOUNT_DISCRIMINATOR);
        data[LAYOUT_VERSION_OFFSET..LAYOUT_VERSION_OFFSET + 8]
            .copy_from_slice(&LAYOUT_VERSION_INITIAL.to_le_bytes());
        data[ORDER_ENTRY_SIZE_OFFSET..ORDER_ENTRY_SIZE_OFFSET + 2]
            .copy_from_slice(&(ORDER_ENTRY_SIZE as u16).to_le_bytes());
        data[AUTHORITY_OFFSET..AUTHORITY_OFFSET + 32].copy_from_slice(authority.as_ref());
        data[MARKET_INDEX_OFFSET..MARKET_INDEX_OFFSET + 2]
            .copy_from_slice(&market_index.to_le_bytes());
        data[MID_PRICE_OFFSET..MID_PRICE_OFFSET + 8].copy_from_slice(&mid_price.to_le_bytes());
        data[ORDER_TICK_SIZE_OFFSET..ORDER_TICK_SIZE_OFFSET + 8]
            .copy_from_slice(&order_tick_size.to_le_bytes());
        data[MIN_ORDER_SIZE_OFFSET..MIN_ORDER_SIZE_OFFSET + 8]
            .copy_from_slice(&min_order_size.to_le_bytes());
        let mut midprice_backing = mock_account_backing(
            test_midprice_account(),
            program_id,
            data_len,
            false,
            true,
            1000,
            Some(&data),
        );
        let mut auth_backing =
            mock_account_backing(authority, test_system_program(), 0, true, false, 0, None);
        let accounts = [
            account_view_from_backing(&mut midprice_backing),
            account_view_from_backing(&mut auth_backing),
        ];
        // 1 ask: offset 100 -> price 1100 (on tick 100), size 10
        let mut payload = vec![];
        payload.extend_from_slice(&50u64.to_le_bytes()); // ref_slot
        payload.extend_from_slice(&[1u8, 0u8, 0u8, 0u8]); // ask_len=1, bid_len=0
        payload.extend_from_slice(&100i64.to_le_bytes());
        payload.extend_from_slice(&10u64.to_le_bytes());
        let mut ix = vec![IX_SET_ORDERS];
        ix.extend_from_slice(&payload);
        let result = process_instruction(&program_id, &accounts, &ix);
        assert!(result.is_ok());
    }

    #[test]
    fn process_set_orders_price_not_on_tick_fails() {
        let program_id = test_program_id();
        let authority = test_authority();
        let market_index = 1u16;
        let mid_price = 1000u64;
        let order_tick_size = 100u64;
        let min_order_size = 10u64;
        let mut data = vec![0u8; ACCOUNT_MIN_LEN];
        data[ACCOUNT_DISCRIMINATOR_OFFSET
            ..ACCOUNT_DISCRIMINATOR_OFFSET + ACCOUNT_DISCRIMINATOR_SIZE]
            .copy_from_slice(&MIDPRICE_ACCOUNT_DISCRIMINATOR);
        data[LAYOUT_VERSION_OFFSET..LAYOUT_VERSION_OFFSET + 8]
            .copy_from_slice(&LAYOUT_VERSION_INITIAL.to_le_bytes());
        data[ORDER_ENTRY_SIZE_OFFSET..ORDER_ENTRY_SIZE_OFFSET + 2]
            .copy_from_slice(&(ORDER_ENTRY_SIZE as u16).to_le_bytes());
        data[AUTHORITY_OFFSET..AUTHORITY_OFFSET + 32].copy_from_slice(authority.as_ref());
        data[MARKET_INDEX_OFFSET..MARKET_INDEX_OFFSET + 2]
            .copy_from_slice(&market_index.to_le_bytes());
        data[MID_PRICE_OFFSET..MID_PRICE_OFFSET + 8].copy_from_slice(&mid_price.to_le_bytes());
        data[ORDER_TICK_SIZE_OFFSET..ORDER_TICK_SIZE_OFFSET + 8]
            .copy_from_slice(&order_tick_size.to_le_bytes());
        data[MIN_ORDER_SIZE_OFFSET..MIN_ORDER_SIZE_OFFSET + 8]
            .copy_from_slice(&min_order_size.to_le_bytes());
        let mut midprice_backing = mock_account_backing(
            test_midprice_account(),
            program_id,
            ACCOUNT_MIN_LEN,
            false,
            true,
            1000,
            Some(&data),
        );
        let mut auth_backing =
            mock_account_backing(authority, test_system_program(), 0, true, false, 0, None);
        let accounts = [
            account_view_from_backing(&mut midprice_backing),
            account_view_from_backing(&mut auth_backing),
        ];
        // 1 ask: offset 45 -> price 1045, not on tick 100
        let mut payload = vec![];
        payload.extend_from_slice(&50u64.to_le_bytes()); // ref_slot
        payload.extend_from_slice(&[1u8, 0u8, 0u8, 0u8]);
        payload.extend_from_slice(&45i64.to_le_bytes());
        payload.extend_from_slice(&10u64.to_le_bytes());
        let mut ix = vec![IX_SET_ORDERS];
        ix.extend_from_slice(&payload);
        let result = process_instruction(&program_id, &accounts, &ix);
        assert!(matches!(
            result,
            Err(ProgramError::Custom(AUTH_ERR_ORDER_TICK_OR_SIZE))
        ));
    }

    #[test]
    fn process_set_orders_size_below_min_fails() {
        let program_id = test_program_id();
        let authority = test_authority();
        let market_index = 1u16;
        let mid_price = 1000u64;
        let order_tick_size = 100u64;
        let min_order_size = 10u64;
        let mut data = vec![0u8; ACCOUNT_MIN_LEN];
        data[ACCOUNT_DISCRIMINATOR_OFFSET
            ..ACCOUNT_DISCRIMINATOR_OFFSET + ACCOUNT_DISCRIMINATOR_SIZE]
            .copy_from_slice(&MIDPRICE_ACCOUNT_DISCRIMINATOR);
        data[LAYOUT_VERSION_OFFSET..LAYOUT_VERSION_OFFSET + 8]
            .copy_from_slice(&LAYOUT_VERSION_INITIAL.to_le_bytes());
        data[ORDER_ENTRY_SIZE_OFFSET..ORDER_ENTRY_SIZE_OFFSET + 2]
            .copy_from_slice(&(ORDER_ENTRY_SIZE as u16).to_le_bytes());
        data[AUTHORITY_OFFSET..AUTHORITY_OFFSET + 32].copy_from_slice(authority.as_ref());
        data[MARKET_INDEX_OFFSET..MARKET_INDEX_OFFSET + 2]
            .copy_from_slice(&market_index.to_le_bytes());
        data[MID_PRICE_OFFSET..MID_PRICE_OFFSET + 8].copy_from_slice(&mid_price.to_le_bytes());
        data[ORDER_TICK_SIZE_OFFSET..ORDER_TICK_SIZE_OFFSET + 8]
            .copy_from_slice(&order_tick_size.to_le_bytes());
        data[MIN_ORDER_SIZE_OFFSET..MIN_ORDER_SIZE_OFFSET + 8]
            .copy_from_slice(&min_order_size.to_le_bytes());
        let mut midprice_backing = mock_account_backing(
            test_midprice_account(),
            program_id,
            ACCOUNT_MIN_LEN,
            false,
            true,
            1000,
            Some(&data),
        );
        let mut auth_backing =
            mock_account_backing(authority, test_system_program(), 0, true, false, 0, None);
        let accounts = [
            account_view_from_backing(&mut midprice_backing),
            account_view_from_backing(&mut auth_backing),
        ];
        // 1 ask: offset 100 -> price 1100 (on tick 100), size 5 < min_order_size 10
        let mut payload = vec![];
        payload.extend_from_slice(&50u64.to_le_bytes()); // ref_slot
        payload.extend_from_slice(&[1u8, 0u8, 0u8, 0u8]);
        payload.extend_from_slice(&100i64.to_le_bytes());
        payload.extend_from_slice(&5u64.to_le_bytes());
        let mut ix = vec![IX_SET_ORDERS];
        ix.extend_from_slice(&payload);
        let result = process_instruction(&program_id, &accounts, &ix);
        assert!(matches!(
            result,
            Err(ProgramError::Custom(AUTH_ERR_ORDER_TICK_OR_SIZE))
        ));
    }


    #[test]
    fn process_set_quote_ttl_invalid_payload_length() {
        let program_id = test_program_id();
        let authority = test_authority();
        let mut data = vec![0u8; ACCOUNT_MIN_LEN];
        data[ACCOUNT_DISCRIMINATOR_OFFSET
            ..ACCOUNT_DISCRIMINATOR_OFFSET + ACCOUNT_DISCRIMINATOR_SIZE]
            .copy_from_slice(&MIDPRICE_ACCOUNT_DISCRIMINATOR);
        data[LAYOUT_VERSION_OFFSET..LAYOUT_VERSION_OFFSET + 8]
            .copy_from_slice(&LAYOUT_VERSION_INITIAL.to_le_bytes());
        data[ORDER_ENTRY_SIZE_OFFSET..ORDER_ENTRY_SIZE_OFFSET + 2]
            .copy_from_slice(&(ORDER_ENTRY_SIZE as u16).to_le_bytes());
        data[AUTHORITY_OFFSET..AUTHORITY_OFFSET + 32].copy_from_slice(authority.as_ref());
        let mut midprice_backing = mock_account_backing(
            test_midprice_account(),
            program_id,
            ACCOUNT_MIN_LEN,
            false,
            true,
            1000,
            Some(&data),
        );
        let mut auth_backing =
            mock_account_backing(authority, test_system_program(), 0, true, false, 0, None);
        let accounts = [
            account_view_from_backing(&mut midprice_backing),
            account_view_from_backing(&mut auth_backing),
        ];
        let ix = [IX_SET_QUOTE_TTL, 0u8]; // 1 byte, need 8
        let result = process_instruction(&program_id, &accounts, &ix);
        assert!(matches!(result, Err(ProgramError::InvalidInstructionData)));
    }

    #[test]
    fn process_set_quote_ttl_success() {
        let program_id = test_program_id();
        let authority = test_authority();
        let mut data = vec![0u8; ACCOUNT_MIN_LEN];
        data[ACCOUNT_DISCRIMINATOR_OFFSET
            ..ACCOUNT_DISCRIMINATOR_OFFSET + ACCOUNT_DISCRIMINATOR_SIZE]
            .copy_from_slice(&MIDPRICE_ACCOUNT_DISCRIMINATOR);
        data[LAYOUT_VERSION_OFFSET..LAYOUT_VERSION_OFFSET + 8]
            .copy_from_slice(&LAYOUT_VERSION_INITIAL.to_le_bytes());
        data[ORDER_ENTRY_SIZE_OFFSET..ORDER_ENTRY_SIZE_OFFSET + 2]
            .copy_from_slice(&(ORDER_ENTRY_SIZE as u16).to_le_bytes());
        data[AUTHORITY_OFFSET..AUTHORITY_OFFSET + 32].copy_from_slice(authority.as_ref());
        let mut midprice_backing = mock_account_backing(
            test_midprice_account(),
            program_id,
            ACCOUNT_MIN_LEN,
            false,
            true,
            1000,
            Some(&data),
        );
        let mut auth_backing =
            mock_account_backing(authority, test_system_program(), 0, true, false, 0, None);
        let accounts = [
            account_view_from_backing(&mut midprice_backing),
            account_view_from_backing(&mut auth_backing),
        ];
        let ttl: u64 = 100;
        let mut ix = vec![IX_SET_QUOTE_TTL];
        ix.extend_from_slice(&ttl.to_le_bytes());
        let result = process_instruction(&program_id, &accounts, &ix);
        assert!(result.is_ok());
        let data = unsafe { accounts[0].borrow_unchecked() };
        assert_eq!(
            data[QUOTE_TTL_OFFSET..QUOTE_TTL_OFFSET + 8],
            ttl.to_le_bytes()
        );
    }

    #[test]
    fn process_transfer_authority_invalid_payload_length() {
        let program_id = test_program_id();
        let authority = test_authority();
        let mut data = vec![0u8; ACCOUNT_MIN_LEN];
        data[ACCOUNT_DISCRIMINATOR_OFFSET
            ..ACCOUNT_DISCRIMINATOR_OFFSET + ACCOUNT_DISCRIMINATOR_SIZE]
            .copy_from_slice(&MIDPRICE_ACCOUNT_DISCRIMINATOR);
        data[LAYOUT_VERSION_OFFSET..LAYOUT_VERSION_OFFSET + 8]
            .copy_from_slice(&LAYOUT_VERSION_INITIAL.to_le_bytes());
        data[ORDER_ENTRY_SIZE_OFFSET..ORDER_ENTRY_SIZE_OFFSET + 2]
            .copy_from_slice(&(ORDER_ENTRY_SIZE as u16).to_le_bytes());
        data[AUTHORITY_OFFSET..AUTHORITY_OFFSET + 32].copy_from_slice(authority.as_ref());
        let mut midprice_backing = mock_account_backing(
            test_midprice_account(),
            program_id,
            ACCOUNT_MIN_LEN,
            false,
            true,
            1000,
            Some(&data),
        );
        let mut auth_backing =
            mock_account_backing(authority, test_system_program(), 0, true, false, 0, None);
        let accounts = [
            account_view_from_backing(&mut midprice_backing),
            account_view_from_backing(&mut auth_backing),
        ];
        let mut ix = vec![IX_TRANSFER_AUTHORITY];
        ix.extend_from_slice(&[0u8; 16]); // only 16 bytes payload, need 32
        let result = process_instruction(&program_id, &accounts, &ix);
        assert!(matches!(result, Err(ProgramError::InvalidInstructionData)));
    }

    #[test]
    fn process_transfer_authority_success() {
        let program_id = test_program_id();
        let authority = test_authority();
        let new_authority = test_new_authority();
        let mut data = vec![0u8; ACCOUNT_MIN_LEN];
        data[ACCOUNT_DISCRIMINATOR_OFFSET
            ..ACCOUNT_DISCRIMINATOR_OFFSET + ACCOUNT_DISCRIMINATOR_SIZE]
            .copy_from_slice(&MIDPRICE_ACCOUNT_DISCRIMINATOR);
        data[LAYOUT_VERSION_OFFSET..LAYOUT_VERSION_OFFSET + 8]
            .copy_from_slice(&LAYOUT_VERSION_INITIAL.to_le_bytes());
        data[ORDER_ENTRY_SIZE_OFFSET..ORDER_ENTRY_SIZE_OFFSET + 2]
            .copy_from_slice(&(ORDER_ENTRY_SIZE as u16).to_le_bytes());
        data[AUTHORITY_OFFSET..AUTHORITY_OFFSET + 32].copy_from_slice(authority.as_ref());
        let mut midprice_backing = mock_account_backing(
            test_midprice_account(),
            program_id,
            ACCOUNT_MIN_LEN,
            false,
            true,
            1000,
            Some(&data),
        );
        let mut auth_backing =
            mock_account_backing(authority, test_system_program(), 0, true, false, 0, None);
        let accounts = [
            account_view_from_backing(&mut midprice_backing),
            account_view_from_backing(&mut auth_backing),
        ];
        let mut ix = vec![IX_TRANSFER_AUTHORITY];
        ix.extend_from_slice(new_authority.as_ref());
        let result = process_instruction(&program_id, &accounts, &ix);
        assert!(result.is_ok());
        let data = unsafe { accounts[0].borrow_unchecked() };
        assert_eq!(
            data[AUTHORITY_OFFSET..AUTHORITY_OFFSET + 32],
            new_authority.as_ref()[..]
        );
    }

    #[test]
    fn process_close_account_wrong_account_count() {
        let program_id = test_program_id();
        let mut midprice_backing = mock_account_backing(
            test_midprice_account(),
            program_id,
            ACCOUNT_MIN_LEN,
            false,
            true,
            1000,
            None,
        );
        let accounts = [account_view_from_backing(&mut midprice_backing)];
        let ix = [IX_CLOSE_ACCOUNT];
        let result = process_instruction(&program_id, &accounts, &ix);
        assert!(matches!(result, Err(ProgramError::NotEnoughAccountKeys)));
    }

    #[test]
    fn process_apply_fills_too_few_accounts() {
        let program_id = test_program_id();
        let accounts: &[AccountView] = &[];
        let ix = [APPLY_FILLS_OPCODE, 0u8, 0u8]; // market_index 0
        let result = process_instruction(&program_id, accounts, &ix);
        assert!(matches!(result, Err(ProgramError::NotEnoughAccountKeys)));
    }

    #[test]
    fn process_apply_fills_matcher_not_signer() {
        let program_id = test_program_id();
        let (expected_matcher_pda, _) =
            Address::try_find_program_address(&[b"prop_amm_matcher"], &DRIFT_PROGRAM_ID).unwrap();
        let mut matcher_backing = mock_account_backing(
            expected_matcher_pda,
            DRIFT_PROGRAM_ID,
            0,
            false, // not signer
            false,
            0,
            None,
        );
        let mut clock_backing = mock_account_backing(
            CLOCK_SYSVAR_ID,
            test_system_program(),
            8,
            false,
            false,
            0,
            Some(&0u64.to_le_bytes()),
        );
        let mut midprice_backing = mock_account_backing(
            test_midprice_account(),
            program_id,
            ACCOUNT_MIN_LEN,
            false,
            true,
            1000,
            None,
        );
        let accounts = [
            account_view_from_backing(&mut matcher_backing),
            account_view_from_backing(&mut clock_backing),
            account_view_from_backing(&mut midprice_backing),
        ];
        let ix = [APPLY_FILLS_OPCODE, 0u8, 0u8, 0u8, 0u8]; // market_index 0, num_fills 0 for one maker
        let result = process_instruction(&program_id, &accounts, &ix);
        assert!(matches!(result, Err(ProgramError::Custom(0x02)))); // missing signature
    }

    #[test]
    fn process_apply_fills_wrong_clock_account() {
        let program_id = test_program_id();
        let (expected_matcher_pda, _) =
            Address::try_find_program_address(&[b"prop_amm_matcher"], &DRIFT_PROGRAM_ID).unwrap();
        let mut matcher_backing = mock_account_backing(
            expected_matcher_pda,
            DRIFT_PROGRAM_ID,
            0,
            true,
            false,
            0,
            None,
        );
        // accounts[1] is not Clock sysvar
        let mut wrong_clock_backing = mock_account_backing(
            test_wrong_clock(),
            test_system_program(),
            8,
            false,
            false,
            0,
            Some(&0u64.to_le_bytes()),
        );
        let mut midprice_backing = mock_account_backing(
            test_midprice_account(),
            program_id,
            ACCOUNT_MIN_LEN,
            false,
            true,
            1000,
            None,
        );
        let accounts = [
            account_view_from_backing(&mut matcher_backing),
            account_view_from_backing(&mut wrong_clock_backing),
            account_view_from_backing(&mut midprice_backing),
        ];
        let ix = [APPLY_FILLS_OPCODE, 1u8, 0u8, 0u8, 0u8]; // market_index 1, num_fills 0
        let result = process_instruction(&program_id, &accounts, &ix);
        assert!(matches!(result, Err(ProgramError::Custom(0x80)))); // AUTH_ERR_INVALID_CLOCK
    }

    // ---------- apply_fills: success and functional coverage ----------

    #[test]
    fn process_apply_fills_success_single_fill_reduces_order_size() {
        let program_id = test_program_id();
        let authority = test_authority();
        let current_slot = 100u64;
        let (mut matcher_backing, mut clock_backing, _) =
            apply_fills_setup_matcher_clock(current_slot);
        let market_index = 1u16;
        let ref_slot = 90u64;
        let data = make_midprice_data_with_orders(
            &authority,
            market_index,
            0, // subaccount_index
            0,
            0, // tick sizes
            ref_slot,
            0,         // no TTL
            &[100u64], // 1 ask, size 100
            &[],
        );
        let data_len = data.len();
        let mut midprice_backing = mock_account_backing(
            test_midprice_account(),
            program_id,
            data_len,
            false,
            true,
            1000,
            Some(&data),
        );
        let accounts = [
            account_view_from_backing(&mut matcher_backing),
            account_view_from_backing(&mut clock_backing),
            account_view_from_backing(&mut midprice_backing),
        ];
        // Fill 50 from ask at abs_index 0.
        let entry = fill_entry(0, true, 50);
        let mut ix = vec![APPLY_FILLS_OPCODE];
        ix.extend_from_slice(&market_index.to_le_bytes());
        ix.extend_from_slice(&1u16.to_le_bytes()); // num_fills
        ix.extend_from_slice(&0u64.to_le_bytes()); // expected sequence_number
        ix.extend_from_slice(&entry);
        let result = process_instruction(&program_id, &accounts, &ix);
        assert!(result.is_ok());
        let out_data = unsafe { accounts[2].borrow_unchecked() };
        let base = ORDERS_DATA_OFFSET + 8;
        let size_after = u64::from_le_bytes(out_data[base..base + 8].try_into().unwrap());
        assert_eq!(size_after, 50);
    }

    #[test]
    fn process_apply_fills_success_full_fill_advances_ask_head() {
        let program_id = test_program_id();
        let authority = test_authority();
        let current_slot = 100u64;
        let (mut matcher_backing, mut clock_backing, _) =
            apply_fills_setup_matcher_clock(current_slot);
        let market_index = 1u16;
        let data = make_midprice_data_with_orders(
            &authority,
            market_index,
            0, // subaccount_index
            0,
            0,
            90,
            0,
            &[100u64], // 1 ask
            &[],
        );
        let data_len = data.len();
        let mut midprice_backing = mock_account_backing(
            test_midprice_account(),
            program_id,
            data_len,
            false,
            true,
            1000,
            Some(&data),
        );
        let accounts = [
            account_view_from_backing(&mut matcher_backing),
            account_view_from_backing(&mut clock_backing),
            account_view_from_backing(&mut midprice_backing),
        ];
        let entry = fill_entry(0, true, 100); // full fill
        let mut ix = vec![APPLY_FILLS_OPCODE];
        ix.extend_from_slice(&market_index.to_le_bytes());
        ix.extend_from_slice(&1u16.to_le_bytes());
        ix.extend_from_slice(&0u64.to_le_bytes());
        ix.extend_from_slice(&entry);
        let result = process_instruction(&program_id, &accounts, &ix);
        assert!(result.is_ok());
        let out_data = unsafe { accounts[2].borrow_unchecked() };
        let ask_head =
            u16::from_le_bytes([out_data[ASK_HEAD_OFFSET], out_data[ASK_HEAD_OFFSET + 1]]);
        assert_eq!(ask_head, 1);
    }

    #[test]
    fn process_apply_fills_success_bid_fill() {
        let program_id = test_program_id();
        let authority = test_authority();
        let (mut matcher_backing, mut clock_backing, _) = apply_fills_setup_matcher_clock(50);
        let market_index = 0u16;
        let data =
            make_midprice_data_with_orders(&authority, market_index, 0, 0, 0, 40, 0, &[], &[200u64]);
        let data_len = data.len();
        let mut midprice_backing = mock_account_backing(
            test_midprice_account(),
            program_id,
            data_len,
            false,
            true,
            1000,
            Some(&data),
        );
        let accounts = [
            account_view_from_backing(&mut matcher_backing),
            account_view_from_backing(&mut clock_backing),
            account_view_from_backing(&mut midprice_backing),
        ];
        let entry = fill_entry(0, false, 80); // bid at abs_index 0 (first bid)
        let mut ix = vec![APPLY_FILLS_OPCODE];
        ix.extend_from_slice(&market_index.to_le_bytes());
        ix.extend_from_slice(&1u16.to_le_bytes());
        ix.extend_from_slice(&0u64.to_le_bytes());
        ix.extend_from_slice(&entry);
        let result = process_instruction(&program_id, &accounts, &ix);
        assert!(result.is_ok());
        let out_data = unsafe { accounts[2].borrow_unchecked() };
        let base = ORDERS_DATA_OFFSET + 8;
        assert_eq!(
            u64::from_le_bytes(out_data[base..base + 8].try_into().unwrap()),
            120
        );
    }

    #[test]
    fn process_apply_fills_success_multiple_fills_same_maker() {
        let program_id = test_program_id();
        let authority = test_authority();
        let (mut matcher_backing, mut clock_backing, _) = apply_fills_setup_matcher_clock(50);
        let market_index = 2u16;
        let data = make_midprice_data_with_orders(
            &authority,
            market_index,
            0,
            0,
            0,
            40,
            0,
            &[100u64, 200u64],
            &[],
        );
        let data_len = data.len();
        let mut midprice_backing = mock_account_backing(
            test_midprice_account(),
            program_id,
            data_len,
            false,
            true,
            1000,
            Some(&data),
        );
        let accounts = [
            account_view_from_backing(&mut matcher_backing),
            account_view_from_backing(&mut clock_backing),
            account_view_from_backing(&mut midprice_backing),
        ];
        let e1 = fill_entry(0, true, 30);
        let e2 = fill_entry(1, true, 50);
        let mut ix = vec![APPLY_FILLS_OPCODE];
        ix.extend_from_slice(&market_index.to_le_bytes());
        ix.extend_from_slice(&2u16.to_le_bytes());
        ix.extend_from_slice(&0u64.to_le_bytes());
        ix.extend_from_slice(&e1);
        ix.extend_from_slice(&e2);
        let result = process_instruction(&program_id, &accounts, &ix);
        assert!(result.is_ok());
        let out_data = unsafe { accounts[2].borrow_unchecked() };
        let base0 = ORDERS_DATA_OFFSET + 8;
        let base1 = ORDERS_DATA_OFFSET + ORDER_ENTRY_SIZE + 8;
        assert_eq!(
            u64::from_le_bytes(out_data[base0..base0 + 8].try_into().unwrap()),
            70
        );
        assert_eq!(
            u64::from_le_bytes(out_data[base1..base1 + 8].try_into().unwrap()),
            150
        );
    }

    #[test]
    fn process_apply_fills_success_two_makers_second_filled() {
        let program_id = test_program_id();
        let authority = test_authority();
        let (mut matcher_backing, mut clock_backing, _) = apply_fills_setup_matcher_clock(50);
        let market_index = 1u16;
        let data0 =
            make_midprice_data_with_orders(&authority, market_index, 0, 0, 0, 40, 0, &[100u64], &[]);
        let data1 =
            make_midprice_data_with_orders(&authority, market_index, 0, 0, 0, 40, 0, &[100u64], &[]);
        let len0 = data0.len();
        let len1 = data1.len();
        let mut mid0 = mock_account_backing(
            test_midprice_account(),
            program_id,
            len0,
            false,
            true,
            1000,
            Some(&data0),
        );
        let mut mid1 = mock_account_backing(
            Address::new_from_array([10u8; 32]),
            program_id,
            len1,
            false,
            true,
            1000,
            Some(&data1),
        );
        let accounts = [
            account_view_from_backing(&mut matcher_backing),
            account_view_from_backing(&mut clock_backing),
            account_view_from_backing(&mut mid0),
            account_view_from_backing(&mut mid1),
        ];
        let entry = fill_entry(0, true, 50);
        let mut ix = vec![APPLY_FILLS_OPCODE];
        ix.extend_from_slice(&market_index.to_le_bytes());
        ix.extend_from_slice(&0u16.to_le_bytes());
        ix.extend_from_slice(&0u64.to_le_bytes());
        ix.extend_from_slice(&1u16.to_le_bytes());
        ix.extend_from_slice(&0u64.to_le_bytes());
        ix.extend_from_slice(&entry);
        let result = process_instruction(&program_id, &accounts, &ix);
        assert!(result.is_ok());
        let out1 = unsafe { accounts[3].borrow_unchecked() };
        let base = ORDERS_DATA_OFFSET + 8;
        assert_eq!(
            u64::from_le_bytes(out1[base..base + 8].try_into().unwrap()),
            50
        );
    }

    #[test]
    fn process_apply_fills_market_index_mismatch_skips_maker() {
        let program_id = test_program_id();
        let authority = test_authority();
        let (mut matcher_backing, mut clock_backing, _) = apply_fills_setup_matcher_clock(50);
        let data = make_midprice_data_with_orders(&authority, 5, 0, 0, 0, 40, 0, &[100u64], &[]);
        let data_len = data.len();
        let mut midprice_backing = mock_account_backing(
            test_midprice_account(),
            program_id,
            data_len,
            false,
            true,
            1000,
            Some(&data),
        );
        let accounts = [
            account_view_from_backing(&mut matcher_backing),
            account_view_from_backing(&mut clock_backing),
            account_view_from_backing(&mut midprice_backing),
        ];
        let market_index_payload = 1u16;
        let entry = fill_entry(0, true, 50);
        let mut ix = vec![APPLY_FILLS_OPCODE];
        ix.extend_from_slice(&market_index_payload.to_le_bytes());
        ix.extend_from_slice(&1u16.to_le_bytes());
        ix.extend_from_slice(&0u64.to_le_bytes());
        ix.extend_from_slice(&entry);
        let result = process_instruction(&program_id, &accounts, &ix);
        assert!(result.is_ok());
        let out_data = unsafe { accounts[2].borrow_unchecked() };
        let base = ORDERS_DATA_OFFSET + 8;
        assert_eq!(
            u64::from_le_bytes(out_data[base..base + 8].try_into().unwrap()),
            100
        );
    }

    #[test]
    fn process_apply_fills_quote_expired_skips_maker() {
        let program_id = test_program_id();
        let authority = test_authority();
        let current_slot = 200u64;
        let ref_slot = 100u64;
        let quote_ttl_slots = 50u64;
        let (mut matcher_backing, mut clock_backing, _) =
            apply_fills_setup_matcher_clock(current_slot);
        let data = make_midprice_data_with_orders(
            &authority,
            1,
            0, // subaccount_index
            0,
            0,
            ref_slot,
            quote_ttl_slots,
            &[100u64],
            &[],
        );
        let data_len = data.len();
        let mut midprice_backing = mock_account_backing(
            test_midprice_account(),
            program_id,
            data_len,
            false,
            true,
            1000,
            Some(&data),
        );
        let accounts = [
            account_view_from_backing(&mut matcher_backing),
            account_view_from_backing(&mut clock_backing),
            account_view_from_backing(&mut midprice_backing),
        ];
        let entry = fill_entry(0, true, 50);
        let mut ix = vec![APPLY_FILLS_OPCODE];
        ix.extend_from_slice(&1u16.to_le_bytes());
        ix.extend_from_slice(&1u16.to_le_bytes());
        ix.extend_from_slice(&0u64.to_le_bytes());
        ix.extend_from_slice(&entry);
        let result = process_instruction(&program_id, &accounts, &ix);
        assert!(result.is_ok());
        let out_data = unsafe { accounts[2].borrow_unchecked() };
        let base = ORDERS_DATA_OFFSET + 8;
        assert_eq!(
            u64::from_le_bytes(out_data[base..base + 8].try_into().unwrap()),
            100
        );
    }

    #[test]
    fn process_apply_fills_quote_not_expired_applies_fill() {
        let program_id = test_program_id();
        let current_slot = 100u64;
        let ref_slot = 90u64;
        let quote_ttl_slots = 20u64;
        let (mut matcher_backing, mut clock_backing, _) =
            apply_fills_setup_matcher_clock(current_slot);
        let authority = test_authority();
        let data = make_midprice_data_with_orders(
            &authority,
            1,
            0, // subaccount_index
            0,
            0,
            ref_slot,
            quote_ttl_slots,
            &[100u64],
            &[],
        );
        let data_len = data.len();
        let mut midprice_backing = mock_account_backing(
            test_midprice_account(),
            program_id,
            data_len,
            false,
            true,
            1000,
            Some(&data),
        );
        let accounts = [
            account_view_from_backing(&mut matcher_backing),
            account_view_from_backing(&mut clock_backing),
            account_view_from_backing(&mut midprice_backing),
        ];
        let entry = fill_entry(0, true, 50);
        let mut ix = vec![APPLY_FILLS_OPCODE];
        ix.extend_from_slice(&1u16.to_le_bytes());
        ix.extend_from_slice(&1u16.to_le_bytes());
        ix.extend_from_slice(&0u64.to_le_bytes());
        ix.extend_from_slice(&entry);
        let result = process_instruction(&program_id, &accounts, &ix);
        assert!(result.is_ok());
        let out_data = unsafe { accounts[2].borrow_unchecked() };
        let base = ORDERS_DATA_OFFSET + 8;
        assert_eq!(
            u64::from_le_bytes(out_data[base..base + 8].try_into().unwrap()),
            50
        );
    }

    #[test]
    fn process_apply_fills_payload_trailing_bytes_fails() {
        let program_id = test_program_id();
        let (mut matcher_backing, mut clock_backing, _) = apply_fills_setup_matcher_clock(50);
        let authority = test_authority();
        let data = make_midprice_data_with_orders(&authority, 1, 0, 0, 0, 40, 0, &[100u64], &[]);
        let data_len = data.len();
        let mut midprice_backing = mock_account_backing(
            test_midprice_account(),
            program_id,
            data_len,
            false,
            true,
            1000,
            Some(&data),
        );
        let accounts = [
            account_view_from_backing(&mut matcher_backing),
            account_view_from_backing(&mut clock_backing),
            account_view_from_backing(&mut midprice_backing),
        ];
        let entry = fill_entry(0, true, 50);
        let mut ix = vec![APPLY_FILLS_OPCODE];
        ix.extend_from_slice(&1u16.to_le_bytes());
        ix.extend_from_slice(&1u16.to_le_bytes());
        ix.extend_from_slice(&0u64.to_le_bytes());
        ix.extend_from_slice(&entry);
        ix.push(0xff);
        let result = process_instruction(&program_id, &accounts, &ix);
        assert!(matches!(result, Err(ProgramError::InvalidInstructionData)));
    }

    #[test]
    fn process_apply_fills_payload_short_for_maker_fails() {
        let program_id = test_program_id();
        let (mut matcher_backing, mut clock_backing, _) = apply_fills_setup_matcher_clock(50);
        let authority = test_authority();
        let data = make_midprice_data_with_orders(&authority, 1, 0, 0, 0, 40, 0, &[100u64], &[]);
        let data_len = data.len();
        let mut midprice_backing = mock_account_backing(
            test_midprice_account(),
            program_id,
            data_len,
            false,
            true,
            1000,
            Some(&data),
        );
        let accounts = [
            account_view_from_backing(&mut matcher_backing),
            account_view_from_backing(&mut clock_backing),
            account_view_from_backing(&mut midprice_backing),
        ];
        let mut ix = vec![APPLY_FILLS_OPCODE];
        ix.extend_from_slice(&1u16.to_le_bytes());
        ix.extend_from_slice(&1u16.to_le_bytes());
        // Missing expected_sequence and entries: header is incomplete.
        let result = process_instruction(&program_id, &accounts, &ix);
        assert!(matches!(result, Err(ProgramError::InvalidInstructionData)));
    }

    #[test]
    fn process_apply_fills_num_fills_exceeds_max_fails() {
        let program_id = test_program_id();
        let (mut matcher_backing, mut clock_backing, _) = apply_fills_setup_matcher_clock(50);
        let authority = test_authority();
        let data = make_midprice_data_with_orders(&authority, 1, 0, 0, 0, 40, 0, &[100u64], &[]);
        let data_len = data.len();
        let mut midprice_backing = mock_account_backing(
            test_midprice_account(),
            program_id,
            data_len,
            false,
            true,
            1000,
            Some(&data),
        );
        let accounts = [
            account_view_from_backing(&mut matcher_backing),
            account_view_from_backing(&mut clock_backing),
            account_view_from_backing(&mut midprice_backing),
        ];
        let mut ix = vec![APPLY_FILLS_OPCODE];
        ix.extend_from_slice(&1u16.to_le_bytes());
        ix.extend_from_slice(&(MAX_ORDERS as u16 + 1).to_le_bytes());
        let result = process_instruction(&program_id, &accounts, &ix);
        assert!(matches!(result, Err(ProgramError::InvalidInstructionData)));
    }

    #[test]
    fn process_apply_fills_fill_size_exceeds_order_fails() {
        let program_id = test_program_id();
        let (mut matcher_backing, mut clock_backing, _) = apply_fills_setup_matcher_clock(50);
        let authority = test_authority();
        let data = make_midprice_data_with_orders(&authority, 1, 0, 0, 0, 40, 0, &[100u64], &[]);
        let data_len = data.len();
        let mut midprice_backing = mock_account_backing(
            test_midprice_account(),
            program_id,
            data_len,
            false,
            true,
            1000,
            Some(&data),
        );
        let accounts = [
            account_view_from_backing(&mut matcher_backing),
            account_view_from_backing(&mut clock_backing),
            account_view_from_backing(&mut midprice_backing),
        ];
        let entry = fill_entry(0, true, 101);
        let mut ix = vec![APPLY_FILLS_OPCODE];
        ix.extend_from_slice(&1u16.to_le_bytes());
        ix.extend_from_slice(&1u16.to_le_bytes());
        ix.extend_from_slice(&entry);
        let result = process_instruction(&program_id, &accounts, &ix);
        assert!(matches!(result, Err(ProgramError::InvalidInstructionData)));
    }

    #[test]
    fn process_apply_fills_fill_size_zero_fails() {
        let program_id = test_program_id();
        let (mut matcher_backing, mut clock_backing, _) = apply_fills_setup_matcher_clock(50);
        let authority = test_authority();
        let data = make_midprice_data_with_orders(&authority, 1, 0, 0, 0, 40, 0, &[100u64], &[]);
        let data_len = data.len();
        let mut midprice_backing = mock_account_backing(
            test_midprice_account(),
            program_id,
            data_len,
            false,
            true,
            1000,
            Some(&data),
        );
        let accounts = [
            account_view_from_backing(&mut matcher_backing),
            account_view_from_backing(&mut clock_backing),
            account_view_from_backing(&mut midprice_backing),
        ];
        let entry = fill_entry(0, true, 0);
        let mut ix = vec![APPLY_FILLS_OPCODE];
        ix.extend_from_slice(&1u16.to_le_bytes());
        ix.extend_from_slice(&1u16.to_le_bytes());
        ix.extend_from_slice(&entry);
        let result = process_instruction(&program_id, &accounts, &ix);
        assert!(matches!(result, Err(ProgramError::InvalidInstructionData)));
    }

    #[test]
    fn process_apply_fills_invalid_is_ask_fails() {
        let program_id = test_program_id();
        let (mut matcher_backing, mut clock_backing, _) = apply_fills_setup_matcher_clock(50);
        let authority = test_authority();
        let data = make_midprice_data_with_orders(&authority, 1, 0, 0, 0, 40, 0, &[100u64], &[]);
        let data_len = data.len();
        let mut midprice_backing = mock_account_backing(
            test_midprice_account(),
            program_id,
            data_len,
            false,
            true,
            1000,
            Some(&data),
        );
        let accounts = [
            account_view_from_backing(&mut matcher_backing),
            account_view_from_backing(&mut clock_backing),
            account_view_from_backing(&mut midprice_backing),
        ];
        let mut entry = fill_entry(0, true, 50);
        entry[2] = 2;
        let mut ix = vec![APPLY_FILLS_OPCODE];
        ix.extend_from_slice(&1u16.to_le_bytes());
        ix.extend_from_slice(&1u16.to_le_bytes());
        ix.extend_from_slice(&entry);
        let result = process_instruction(&program_id, &accounts, &ix);
        assert!(matches!(result, Err(ProgramError::InvalidInstructionData)));
    }

    #[test]
    fn process_apply_fills_abs_index_out_of_range_fails() {
        let program_id = test_program_id();
        let (mut matcher_backing, mut clock_backing, _) = apply_fills_setup_matcher_clock(50);
        let authority = test_authority();
        let data = make_midprice_data_with_orders(&authority, 1, 0, 0, 0, 40, 0, &[100u64], &[]);
        let data_len = data.len();
        let mut midprice_backing = mock_account_backing(
            test_midprice_account(),
            program_id,
            data_len,
            false,
            true,
            1000,
            Some(&data),
        );
        let accounts = [
            account_view_from_backing(&mut matcher_backing),
            account_view_from_backing(&mut clock_backing),
            account_view_from_backing(&mut midprice_backing),
        ];
        let entry = fill_entry(1, true, 50);
        let mut ix = vec![APPLY_FILLS_OPCODE];
        ix.extend_from_slice(&1u16.to_le_bytes());
        ix.extend_from_slice(&1u16.to_le_bytes());
        ix.extend_from_slice(&entry);
        let result = process_instruction(&program_id, &accounts, &ix);
        assert!(matches!(result, Err(ProgramError::InvalidInstructionData)));
    }

    /// is_ask=true fill entry with abs_index pointing into the bid range must be rejected.
    /// Without the bounds check the wrong head (ask) would be advanced, corrupting traversal.
    #[test]
    fn apply_fill_entry_ask_flag_with_bid_index_rejected() {
        let program_id = test_program_id();
        let (mut matcher_backing, mut clock_backing, _) = apply_fills_setup_matcher_clock(50);
        let authority = test_authority();
        // 1 ask (abs_index 0) + 1 bid (abs_index 1).
        let data = make_midprice_data_with_orders(
            &authority, 1, 0, 0, 0, 40, 0, &[100u64], &[200u64],
        );
        let data_len = data.len();
        let mut midprice_backing = mock_account_backing(
            test_midprice_account(), program_id, data_len, false, true, 1000, Some(&data),
        );
        let accounts = [
            account_view_from_backing(&mut matcher_backing),
            account_view_from_backing(&mut clock_backing),
            account_view_from_backing(&mut midprice_backing),
        ];
        // Claim is_ask=true but abs_index=1 is in the bid range.
        let entry = fill_entry(1, true, 50);
        let mut ix = vec![APPLY_FILLS_OPCODE];
        ix.extend_from_slice(&1u16.to_le_bytes()); // market_index
        ix.extend_from_slice(&1u16.to_le_bytes()); // num_fills
        ix.extend_from_slice(&0u64.to_le_bytes()); // expected_sequence = 0 (matches account)
        ix.extend_from_slice(&entry);
        let result = process_instruction(&program_id, &accounts, &ix);
        assert!(matches!(result, Err(ProgramError::InvalidInstructionData)));
    }

    /// is_ask=false fill entry with abs_index pointing into the ask range must be rejected.
    /// Without the bounds check the wrong head (bid) would be advanced, corrupting traversal.
    #[test]
    fn apply_fill_entry_bid_flag_with_ask_index_rejected() {
        let program_id = test_program_id();
        let (mut matcher_backing, mut clock_backing, _) = apply_fills_setup_matcher_clock(50);
        let authority = test_authority();
        // 1 ask (abs_index 0) + 1 bid (abs_index 1).
        let data = make_midprice_data_with_orders(
            &authority, 1, 0, 0, 0, 40, 0, &[100u64], &[200u64],
        );
        let data_len = data.len();
        let mut midprice_backing = mock_account_backing(
            test_midprice_account(), program_id, data_len, false, true, 1000, Some(&data),
        );
        let accounts = [
            account_view_from_backing(&mut matcher_backing),
            account_view_from_backing(&mut clock_backing),
            account_view_from_backing(&mut midprice_backing),
        ];
        // Claim is_ask=false but abs_index=0 is in the ask range.
        let entry = fill_entry(0, false, 50);
        let mut ix = vec![APPLY_FILLS_OPCODE];
        ix.extend_from_slice(&1u16.to_le_bytes()); // market_index
        ix.extend_from_slice(&1u16.to_le_bytes()); // num_fills
        ix.extend_from_slice(&0u64.to_le_bytes()); // expected_sequence = 0 (matches account)
        ix.extend_from_slice(&entry);
        let result = process_instruction(&program_id, &accounts, &ix);
        assert!(matches!(result, Err(ProgramError::InvalidInstructionData)));
    }

    #[test]
    fn process_apply_fills_wrong_matcher_pda_fails() {
        let program_id = test_program_id();
        let mut wrong_matcher_backing =
            mock_account_backing(test_authority(), DRIFT_PROGRAM_ID, 0, true, false, 0, None);
        let mut clock_backing = mock_account_backing(
            CLOCK_SYSVAR_ID,
            test_system_program(),
            8,
            false,
            false,
            0,
            Some(&50u64.to_le_bytes()),
        );
        let authority = test_authority();
        let data = make_midprice_data_with_orders(&authority, 1, 0, 0, 0, 40, 0, &[100u64], &[]);
        let data_len = data.len();
        let mut midprice_backing = mock_account_backing(
            test_midprice_account(),
            program_id,
            data_len,
            false,
            true,
            1000,
            Some(&data),
        );
        let accounts = [
            account_view_from_backing(&mut wrong_matcher_backing),
            account_view_from_backing(&mut clock_backing),
            account_view_from_backing(&mut midprice_backing),
        ];
        let entry = fill_entry(0, true, 50);
        let mut ix = vec![APPLY_FILLS_OPCODE];
        ix.extend_from_slice(&1u16.to_le_bytes());
        ix.extend_from_slice(&1u16.to_le_bytes());
        ix.extend_from_slice(&entry);
        let result = process_instruction(&program_id, &accounts, &ix);
        assert!(matches!(result, Err(ProgramError::Custom(0x10))));
    }

    #[test]
    fn process_apply_fills_maker_not_writable_skipped_others_succeed() {
        let program_id = test_program_id();
        let (mut matcher_backing, mut clock_backing, _) = apply_fills_setup_matcher_clock(50);
        let authority = test_authority();
        let data = make_midprice_data_with_orders(&authority, 1, 0, 0, 0, 40, 0, &[100u64], &[]);
        let data_len = data.len();
        let mut mid0 = mock_account_backing(
            test_midprice_account(),
            program_id,
            data_len,
            false,
            false,
            1000,
            Some(&data),
        );
        let mut mid1 = mock_account_backing(
            Address::new_from_array([11u8; 32]),
            program_id,
            data_len,
            false,
            true,
            1000,
            Some(&data),
        );
        let accounts = [
            account_view_from_backing(&mut matcher_backing),
            account_view_from_backing(&mut clock_backing),
            account_view_from_backing(&mut mid0),
            account_view_from_backing(&mut mid1),
        ];
        let entry = fill_entry(0, true, 50);
        let mut ix = vec![APPLY_FILLS_OPCODE];
        ix.extend_from_slice(&1u16.to_le_bytes());
        ix.extend_from_slice(&1u16.to_le_bytes());
        ix.extend_from_slice(&0u64.to_le_bytes());
        ix.extend_from_slice(&entry);
        ix.extend_from_slice(&1u16.to_le_bytes());
        ix.extend_from_slice(&0u64.to_le_bytes());
        ix.extend_from_slice(&entry);
        let result = process_instruction(&program_id, &accounts, &ix);
        assert!(result.is_ok());
        let out1 = unsafe { accounts[3].borrow_unchecked() };
        let base = ORDERS_DATA_OFFSET + 8;
        assert_eq!(
            u64::from_le_bytes(out1[base..base + 8].try_into().unwrap()),
            50
        );
    }
}
