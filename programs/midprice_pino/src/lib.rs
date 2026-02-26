//! Provides midprice based orderbook externally fillable by authorized matcher program
#![cfg_attr(target_os = "solana", no_std)]

use midprice_book_view::{
    MidpriceBookViewMut, ACCOUNT_MIN_LEN, AUTHORITY_OFFSET, AUTHORIZED_EXCHANGE_PROGRAM_ID_OFFSET,
    LAYOUT_VERSION_INITIAL, LAYOUT_VERSION_OFFSET, MARKET_INDEX_OFFSET, MAX_ORDERS, MID_PRICE_OFFSET,
    ORDERS_DATA_OFFSET, ORDER_ENTRY_SIZE,
};
use pinocchio::{
    account::AccountView, error::ProgramError, no_allocator, nostd_panic_handler,
    program_entrypoint, Address, ProgramResult,
};
use pinocchio_log::log;
use solana_pubkey::Pubkey;

const IX_UPDATE_MID_PRICE: u8 = 0;
const IX_INITIALIZE_MID_PRICE_ACCOUNT: u8 = 1;
const IX_SET_ORDERS: u8 = 2;
const IX_APPLY_FILL: u8 = 3;
const IX_APPLY_FILLS_BATCH: u8 = 4;
const APPLY_FILL_ENTRY_SIZE: usize = 11; // [abs_index:u16 | is_ask:u8 | fill_size:u64]

const AUTH_ERR_IMMUTABLE: u8 = 1 << 0;
const AUTH_ERR_MISSING_SIGNATURE: u8 = 1 << 1;
const AUTH_ERR_ILLEGAL_OWNER: u8 = 1 << 2;
const AUTH_ERR_INVALID_ACCOUNT_DATA: u8 = 1 << 3;
const AUTH_ERR_INVALID_AUTHORITY: u8 = 1 << 4;
const AUTH_ERR_ALREADY_INITIALIZED: u8 = 1 << 5;
const AUTH_ERR_UNSUPPORTED_LAYOUT_VERSION: u8 = 1 << 6;

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
    log!(
        128,
        "midprice: ix_len={} opcode={} payload_len={}",
        instruction_data.len(),
        *opcode,
        payload.len()
    );
    match *opcode {
        IX_INITIALIZE_MID_PRICE_ACCOUNT => {
            process_initialize_mid_price_account(program_id, accounts, payload)
        }
        IX_UPDATE_MID_PRICE => process_update_mid_price(program_id, accounts, payload),
        IX_SET_ORDERS => process_set_orders(program_id, accounts, payload),
        IX_APPLY_FILL => process_apply_fill(program_id, accounts, payload),
        IX_APPLY_FILLS_BATCH => process_apply_fills_batch(program_id, accounts, payload),
        _ => {
            log!(64, "midprice: unknown opcode={}", *opcode);
            Err(ProgramError::InvalidInstructionData)
        }
    }
}

fn process_initialize_mid_price_account(
    program_id: &Address,
    accounts: &[AccountView],
    payload: &[u8],
) -> ProgramResult {
    // init payload: [market_index:u16 | authorized_exchange_program_id:[u8;32]] or
    //               [market_index:u16 | authorized_exchange_program_id:[u8;32] | authority_to_store:[u8;32]]
    // If authority_to_store is present (payload.len() == 66), it is the pubkey stored as authority (e.g. exchange User PDA)
    // so that apply_fills_batch can be called with that account as authority. Otherwise store the signer's address.
    if payload.len() != 34 && payload.len() != 66 {
        log!(
            64,
            "midprice init: bad payload_len={} want 34 or 66",
            payload.len()
        );
        return Err(ProgramError::InvalidInstructionData);
    }
    let market_index = u16::from_le_bytes([payload[0], payload[1]]);
    let authorized_exchange_program_id = &payload[2..34];
    let authority_to_store: Option<&[u8]> = if payload.len() >= 66 {
        Some(&payload[34..66])
    } else {
        None
    };
    // enforce invariant: exactly 2 accounts
    if accounts.len() != 2 {
        log!(64, "midprice init: bad accounts_len={} want 2", accounts.len());
        return Err(ProgramError::NotEnoughAccountKeys);
    }

    let mid_price_account = &accounts[0];
    let authority = &accounts[1];

    let writable = mid_price_account.is_writable();
    let signer = authority.is_signer();
    let data_len = mid_price_account.data_len();

    // Safety: account view is provided by Solana runtime; owner address pointer is valid.
    let owner_ptr = unsafe { mid_price_account.owner().as_ref().as_ptr() };
    let program_id_ptr = program_id.as_ref().as_ptr();

    let mut err: u8 = 0;
    if !writable {
        err |= AUTH_ERR_IMMUTABLE;
    }
    if !signer {
        err |= AUTH_ERR_MISSING_SIGNATURE;
    }
    if data_len < ACCOUNT_MIN_LEN {
        err |= AUTH_ERR_INVALID_ACCOUNT_DATA;
    }
    if !unsafe { authority_matches_32(owner_ptr, program_id_ptr) } {
        err |= AUTH_ERR_ILLEGAL_OWNER;
    }
    if err != 0 {
        return Err(ProgramError::Custom(err as u32));
    }

    // Safety: we don't borrow the account anywhere else.
    let data = unsafe { mid_price_account.borrow_unchecked_mut() };

    // Reject re-initialization if authority slot is already set.
    let stored_ptr = unsafe { data.as_ptr().add(AUTHORITY_OFFSET) };
    if !unsafe { ptr_is_zero_32(stored_ptr) } {
        return Err(ProgramError::Custom(AUTH_ERR_ALREADY_INITIALIZED as u32));
    }

    let authority_src: &[u8] = authority_to_store.unwrap_or_else(|| authority.address().as_ref());

    let market_index_bytes = market_index.to_le_bytes();

    // Safety: prechecks above guarantee account data has at least ACCOUNT_MIN_LEN bytes.
    unsafe {
        core::ptr::write(
            data.as_mut_ptr().add(LAYOUT_VERSION_OFFSET) as *mut u64,
            LAYOUT_VERSION_INITIAL,
        );
        core::ptr::copy_nonoverlapping(
            authority_src.as_ptr(),
            data.as_mut_ptr().add(AUTHORITY_OFFSET),
            32,
        );
        core::ptr::copy_nonoverlapping(
            authorized_exchange_program_id.as_ptr(),
            data.as_mut_ptr().add(AUTHORIZED_EXCHANGE_PROGRAM_ID_OFFSET),
            32,
        );
        core::ptr::write_bytes(data.as_mut_ptr().add(MID_PRICE_OFFSET), 0, 16);
        core::ptr::copy_nonoverlapping(
            market_index_bytes.as_ptr(),
            data.as_mut_ptr().add(MARKET_INDEX_OFFSET),
            2,
        );
    }
    let mut book = MidpriceBookViewMut::new(data).map_err(|_| ProgramError::InvalidAccountData)?;
    book.set_lengths_and_reset_heads(0, 0)
        .map_err(|_| ProgramError::InvalidAccountData)?;
    Ok(())
}

fn process_set_orders(
    program_id: &Address,
    accounts: &[AccountView],
    payload: &[u8],
) -> ProgramResult {
    // payload format:
    // [ask_len: u16 | bid_len: u16 | packed entries...]
    // entries are repeated (offset: i64, size: u64), asks first then bids.
    if payload.len() < 4 {
        return Err(ProgramError::InvalidInstructionData);
    }
    if (payload.len() - 4) % ORDER_ENTRY_SIZE != 0 {
        return Err(ProgramError::InvalidInstructionData);
    }
    // enforce invariant: exactly 2 accounts
    if accounts.len() != 2 {
        return Err(ProgramError::NotEnoughAccountKeys);
    }

    let midprice_account = &accounts[0];
    let authority = &accounts[1];

    let writable = midprice_account.is_writable();
    let signer = authority.is_signer();
    let data_len = midprice_account.data_len();

    // Safety: account view is provided by Solana runtime; owner address pointer is valid.
    let owner_ptr = unsafe { midprice_account.owner().as_ref().as_ptr() };
    let program_id_ptr = program_id.as_ref().as_ptr();

    let mut err: u8 = 0;
    if !writable {
        err |= AUTH_ERR_IMMUTABLE;
    }
    if !signer {
        err |= AUTH_ERR_MISSING_SIGNATURE;
    }
    if data_len < ACCOUNT_MIN_LEN {
        err |= AUTH_ERR_INVALID_ACCOUNT_DATA;
    }
    if !unsafe { authority_matches_32(owner_ptr, program_id_ptr) } {
        err |= AUTH_ERR_ILLEGAL_OWNER;
    }
    if err != 0 {
        return Err(ProgramError::Custom(err as u32));
    }

    let ask_len = u16::from_le_bytes([payload[0], payload[1]]) as usize;
    let bid_len = u16::from_le_bytes([payload[2], payload[3]]) as usize;
    let orders_len = ask_len + bid_len;
    let payload_orders_bytes = payload.len() - 4;
    let payload_orders_len = payload_orders_bytes / ORDER_ENTRY_SIZE;
    if orders_len != payload_orders_len {
        return Err(ProgramError::InvalidInstructionData);
    }

    let capacity_bytes = data_len - ORDERS_DATA_OFFSET;
    if payload_orders_bytes > capacity_bytes {
        return Err(ProgramError::InvalidInstructionData);
    }
    if orders_len > MAX_ORDERS {
        return Err(ProgramError::InvalidInstructionData);
    }

    // Safety: we don't borrow the account anywhere else
    let data = unsafe { midprice_account.borrow_unchecked_mut() };
    check_layout_version(data)?;

    let authority_ptr = authority.address().as_ref().as_ptr();
    let stored_ptr = unsafe { data.as_ptr().add(AUTHORITY_OFFSET) };
    if !unsafe { authority_matches_32(stored_ptr, authority_ptr) } {
        return Err(ProgramError::Custom(AUTH_ERR_INVALID_AUTHORITY as u32));
    }

    {
        let mut book =
            MidpriceBookViewMut::new(data).map_err(|_| ProgramError::InvalidAccountData)?;
        book.set_lengths_and_reset_heads(ask_len as u16, bid_len as u16)
            .map_err(|_| ProgramError::InvalidInstructionData)?;
    }
    // Safety: all ranges are validated above.
    unsafe {
        core::ptr::copy_nonoverlapping(
            payload[4..].as_ptr(),
            data.as_mut_ptr().add(ORDERS_DATA_OFFSET),
            payload_orders_bytes,
        );
    }

    Ok(())
}

fn process_update_mid_price(
    program_id: &Address,
    accounts: &[AccountView],
    payload: &[u8],
) -> ProgramResult {
    // payload is exactly 16 bytes
    if payload.len() != 16 {
        return Err(ProgramError::InvalidInstructionData);
    }
    // enforce invariant: exactly 2 accounts
    if accounts.len() != 2 {
        return Err(ProgramError::NotEnoughAccountKeys);
    }

    let prop_amm = &accounts[0];
    let authority = &accounts[1];

    let writable = prop_amm.is_writable();
    let signer = authority.is_signer();
    let data_len = prop_amm.data_len();

    // Safety: account view is provided by Solana runtime; owner address pointer is valid.
    let owner_ptr = unsafe { prop_amm.owner().as_ref().as_ptr() };
    let program_id_ptr = program_id.as_ref().as_ptr();

    let mut err: u8 = 0;
    if !writable {
        err |= AUTH_ERR_IMMUTABLE;
    }
    if !signer {
        err |= AUTH_ERR_MISSING_SIGNATURE;
    }
    if data_len < ACCOUNT_MIN_LEN {
        err |= AUTH_ERR_INVALID_ACCOUNT_DATA;
    }
    if !unsafe { authority_matches_32(owner_ptr, program_id_ptr) } {
        err |= AUTH_ERR_ILLEGAL_OWNER;
    }
    if err != 0 {
        return Err(ProgramError::Custom(err as u32));
    }

    // Safety: we don't borrow the account anywhere else
    {
        let data = unsafe { prop_amm.borrow_unchecked_mut() };
        check_layout_version(data)?;

        // Safety: prechecks above guarantee at least ACCOUNT_MIN_LEN bytes.
        let authority_ptr = authority.address().as_ref().as_ptr();
        let stored_ptr = unsafe { data.as_ptr().add(AUTHORITY_OFFSET) };

        if !unsafe { authority_matches_32(stored_ptr, authority_ptr) } {
            return Err(ProgramError::Custom(AUTH_ERR_INVALID_AUTHORITY as u32));
        }

        // Safety: payload length is checked to be exactly 16 bytes above.
        // Prechecks ensure account data length is at least ACCOUNT_MIN_LEN (48),
        // and MID_PRICE_OFFSET..MID_PRICE_OFFSET+16 is a 16-byte in-bounds region.
        unsafe {
            core::ptr::copy_nonoverlapping(
                payload.as_ptr(),
                data.as_mut_ptr().add(MID_PRICE_OFFSET),
                16,
            );
        }
    }

    Ok(())
}

fn process_apply_fill(
    program_id: &Address,
    accounts: &[AccountView],
    payload: &[u8],
) -> ProgramResult {
    // payload: [abs_index:u16 | is_ask:u8 | fill_size:u64]
    if payload.len() != APPLY_FILL_ENTRY_SIZE {
        return Err(ProgramError::InvalidInstructionData);
    }
    if accounts.len() != 3 {
        return Err(ProgramError::NotEnoughAccountKeys);
    }

    let midprice_account = &accounts[0];
    let authority = &accounts[1];
    let matcher_authority = &accounts[2];

    if !midprice_account.is_writable() {
        return Err(ProgramError::Custom(AUTH_ERR_IMMUTABLE as u32));
    }
    let data_len = midprice_account.data_len();
    if data_len < ACCOUNT_MIN_LEN {
        return Err(ProgramError::Custom(AUTH_ERR_INVALID_ACCOUNT_DATA as u32));
    }
    // Safety: account view is provided by Solana runtime; owner address pointer is valid.
    let owner_ptr = unsafe { midprice_account.owner().as_ref().as_ptr() };
    let program_id_ptr = program_id.as_ref().as_ptr();
    if !unsafe { authority_matches_32(owner_ptr, program_id_ptr) } {
        return Err(ProgramError::Custom(AUTH_ERR_ILLEGAL_OWNER as u32));
    }

    if !matcher_authority.is_signer() {
        return Err(ProgramError::Custom(AUTH_ERR_MISSING_SIGNATURE as u32));
    }
    // Safety: we don't borrow the account anywhere else.
    let data = unsafe { midprice_account.borrow_unchecked_mut() };
    check_layout_version(data)?;
    if !matcher_authority_matches(data, matcher_authority)? {
        return Err(ProgramError::Custom(AUTH_ERR_INVALID_AUTHORITY as u32));
    }
    let authority_ptr = authority.address().as_ref().as_ptr();
    let stored_ptr = unsafe { data.as_ptr().add(AUTHORITY_OFFSET) };
    if !unsafe { authority_matches_32(stored_ptr, authority_ptr) } {
        return Err(ProgramError::Custom(AUTH_ERR_INVALID_AUTHORITY as u32));
    }

    let mut book = MidpriceBookViewMut::new(data).map_err(|_| ProgramError::InvalidAccountData)?;
    apply_fill_entry(&mut book, payload)?;
    Ok(())
}

fn process_apply_fills_batch(
    program_id: &Address,
    accounts: &[AccountView],
    payload: &[u8],
) -> ProgramResult {
    // payload: repeated [abs_index:u16 | is_ask:u8 | fill_size:u64]
    if payload.is_empty() || payload.len() % APPLY_FILL_ENTRY_SIZE != 0 {
        log!(
            64,
            "midprice apply_fills_batch: bad payload len={} mod {}",
            payload.len(),
            APPLY_FILL_ENTRY_SIZE
        );
        return Err(ProgramError::InvalidInstructionData);
    }
    if accounts.len() != 3 {
        log!(64, "midprice apply_fills_batch: accounts_len={} want 3", accounts.len());
        return Err(ProgramError::NotEnoughAccountKeys);
    }

    let midprice_account = &accounts[0];
    let authority = &accounts[1];
    let matcher_authority = &accounts[2];

    if !midprice_account.is_writable() {
        return Err(ProgramError::Custom(AUTH_ERR_IMMUTABLE as u32));
    }
    let data_len = midprice_account.data_len();
    if data_len < ACCOUNT_MIN_LEN {
        return Err(ProgramError::Custom(AUTH_ERR_INVALID_ACCOUNT_DATA as u32));
    }
    let owner_ptr = unsafe { midprice_account.owner().as_ref().as_ptr() };
    let program_id_ptr = program_id.as_ref().as_ptr();
    if !unsafe { authority_matches_32(owner_ptr, program_id_ptr) } {
        return Err(ProgramError::Custom(AUTH_ERR_ILLEGAL_OWNER as u32));
    }

    if !matcher_authority.is_signer() {
        return Err(ProgramError::Custom(AUTH_ERR_MISSING_SIGNATURE as u32));
    }
    // Safety: we don't borrow the account anywhere else.
    let data = unsafe { midprice_account.borrow_unchecked_mut() };
    check_layout_version(data)?;
    if !matcher_authority_matches(data, matcher_authority)? {
        return Err(ProgramError::Custom(AUTH_ERR_INVALID_AUTHORITY as u32));
    }
    let authority_ptr = authority.address().as_ref().as_ptr();
    let stored_ptr = unsafe { data.as_ptr().add(AUTHORITY_OFFSET) };
    if !unsafe { authority_matches_32(stored_ptr, authority_ptr) } {
        return Err(ProgramError::Custom(AUTH_ERR_INVALID_AUTHORITY as u32));
    }

    let mut book = MidpriceBookViewMut::new(data).map_err(|_| ProgramError::InvalidAccountData)?;
    let mut start = 0usize;
    while start < payload.len() {
        let end = start + APPLY_FILL_ENTRY_SIZE;
        apply_fill_entry(&mut book, &payload[start..end])?;
        start = end;
    }
    Ok(())
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

/// Global matcher PDA seed: one matcher can apply fills to all PropAMM books for this exchange.
const PROP_AMM_MATCHER_SEED: &[u8] = b"prop_amm_matcher";

fn matcher_authority_matches(
    data: &[u8],
    matcher_authority: &AccountView,
) -> Result<bool, ProgramError> {
    let authorized_exchange_program_id_bytes: [u8; 32] = data
        [AUTHORIZED_EXCHANGE_PROGRAM_ID_OFFSET..AUTHORIZED_EXCHANGE_PROGRAM_ID_OFFSET + 32]
        .try_into()
        .map_err(|_| ProgramError::InvalidAccountData)?;
    let authorized_exchange_program_id =
        Pubkey::new_from_array(authorized_exchange_program_id_bytes);
    let matcher_ptr = matcher_authority.address().as_ref().as_ptr();

    // Per-maker matcher: PDA(exchange, ["matcher", authority])
    let authority_seed = &data[AUTHORITY_OFFSET..AUTHORITY_OFFSET + 32];
    let per_maker_matcher = Pubkey::find_program_address(
        &[b"matcher", authority_seed],
        &authorized_exchange_program_id,
    )
    .0;
    if unsafe { authority_matches_32(matcher_ptr, per_maker_matcher.as_ref().as_ptr()) } {
        return Ok(true);
    }

    // Global PropAMM matcher: PDA(exchange, ["prop_amm_matcher"]) — one matcher for all books
    let global_matcher = Pubkey::find_program_address(
        &[PROP_AMM_MATCHER_SEED],
        &authorized_exchange_program_id,
    )
    .0;
    Ok(unsafe { authority_matches_32(matcher_ptr, global_matcher.as_ref().as_ptr()) })
}

fn check_layout_version(data: &[u8]) -> ProgramResult {
    if data.len() < LAYOUT_VERSION_OFFSET + 8 {
        return Err(ProgramError::Custom(AUTH_ERR_UNSUPPORTED_LAYOUT_VERSION as u32));
    }
    let version_bytes: [u8; 8] = data[LAYOUT_VERSION_OFFSET..LAYOUT_VERSION_OFFSET + 8]
        .try_into()
        .map_err(|_| ProgramError::Custom(AUTH_ERR_UNSUPPORTED_LAYOUT_VERSION as u32))?;
    let version = u64::from_le_bytes(version_bytes);
    if version != LAYOUT_VERSION_INITIAL {
        return Err(ProgramError::Custom(AUTH_ERR_UNSUPPORTED_LAYOUT_VERSION as u32));
    }
    Ok(())
}

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
