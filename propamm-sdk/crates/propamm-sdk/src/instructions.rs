use sha2::{Digest, Sha256};
use solana_instruction::{AccountMeta, Instruction};
use solana_pubkey::Pubkey;

use crate::constants::*;

/// A single order level: offset from mid price (signed) and size in base units.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct OrderEntry {
    /// Price offset from mid_price. Positive for asks, negative for bids.
    pub offset: i64,
    /// Order size in base precision (10^9).
    pub size: u64,
}

// ---------------------------------------------------------------------------
// Midprice-pino native instructions (opcode-prefixed)
// ---------------------------------------------------------------------------

/// Build an `update_mid_price` instruction (opcode 0).
///
/// * `program_id` - Midprice-pino program ID.
/// * `midprice_account` - Writable midprice account PDA.
/// * `authority` - Signer authority for the midprice account.
/// * `reference_price` - New reference price in [`PRICE_PRECISION`].
/// * `valid_until_slot` - Slot after which this price is considered stale.
pub fn update_mid_price(
    program_id: &Pubkey,
    midprice_account: &Pubkey,
    authority: &Pubkey,
    reference_price: u64,
    valid_until_slot: u64,
) -> Instruction {
    let mut data = vec![0u8; 1 + 16];
    data[0] = IX_UPDATE_MID_PRICE;
    data[1..9].copy_from_slice(&reference_price.to_le_bytes());
    data[9..17].copy_from_slice(&valid_until_slot.to_le_bytes());

    Instruction::new_with_bytes(
        *program_id,
        &data,
        vec![
            AccountMeta::new(*midprice_account, false),
            AccountMeta::new_readonly(*authority, true),
        ],
    )
}

/// Build a `set_orders` instruction (opcode 2).
///
/// * `program_id` - Midprice-pino program ID.
/// * `midprice_account` - Writable midprice account PDA.
/// * `authority` - Signer authority for the midprice account.
/// * `valid_until_slot` - Slot after which these orders are considered stale.
/// * `asks` - Ask-side levels (positive offsets from reference price).
/// * `bids` - Bid-side levels (negative offsets from reference price).
pub fn set_orders(
    program_id: &Pubkey,
    midprice_account: &Pubkey,
    authority: &Pubkey,
    valid_until_slot: u64,
    asks: &[OrderEntry],
    bids: &[OrderEntry],
) -> Instruction {
    let n = asks.len() + bids.len();
    let payload_len = 12 + n * LEVEL_ENTRY_SIZE;
    let mut data = vec![0u8; 1 + payload_len];
    data[0] = IX_SET_ORDERS;
    data[1..9].copy_from_slice(&valid_until_slot.to_le_bytes());
    data[9..11].copy_from_slice(&(asks.len() as u16).to_le_bytes());
    data[11..13].copy_from_slice(&(bids.len() as u16).to_le_bytes());

    let mut off = 13;
    for entry in asks.iter().chain(bids.iter()) {
        data[off..off + 8].copy_from_slice(&entry.offset.to_le_bytes());
        data[off + 8..off + 16].copy_from_slice(&entry.size.to_le_bytes());
        off += 16;
    }

    Instruction::new_with_bytes(
        *program_id,
        &data,
        vec![
            AccountMeta::new(*midprice_account, false),
            AccountMeta::new_readonly(*authority, true),
        ],
    )
}

/// Build a `set_quote_ttl` instruction (opcode 5).
///
/// * `program_id` - Midprice-pino program ID.
/// * `midprice_account` - Writable midprice account PDA.
/// * `authority` - Signer authority for the midprice account.
/// * `ttl_slots` - Number of slots quotes remain valid after `valid_until_slot`.
pub fn set_quote_ttl(
    program_id: &Pubkey,
    midprice_account: &Pubkey,
    authority: &Pubkey,
    ttl_slots: u64,
) -> Instruction {
    let mut data = vec![0u8; 1 + 8];
    data[0] = IX_SET_QUOTE_TTL;
    data[1..9].copy_from_slice(&ttl_slots.to_le_bytes());

    Instruction::new_with_bytes(
        *program_id,
        &data,
        vec![
            AccountMeta::new(*midprice_account, false),
            AccountMeta::new_readonly(*authority, true),
        ],
    )
}

/// Build a `close_account` instruction (opcode 6).
///
/// * `program_id` - Midprice-pino program ID.
/// * `midprice_account` - Writable midprice account PDA to close.
/// * `authority` - Signer authority for the midprice account.
/// * `destination` - Account to receive the refunded lamports.
pub fn close_account(
    program_id: &Pubkey,
    midprice_account: &Pubkey,
    authority: &Pubkey,
    destination: &Pubkey,
) -> Instruction {
    let data = vec![IX_CLOSE_ACCOUNT];

    Instruction::new_with_bytes(
        *program_id,
        &data,
        vec![
            AccountMeta::new(*midprice_account, false),
            AccountMeta::new_readonly(*authority, true),
            AccountMeta::new(*destination, false),
        ],
    )
}

/// Build a `transfer_authority` instruction (opcode 7).
///
/// * `program_id` - Midprice-pino program ID.
/// * `midprice_account` - Writable midprice account PDA.
/// * `current_authority` - Current signer authority.
/// * `new_authority` - Pubkey of the new authority to transfer ownership to.
pub fn transfer_authority(
    program_id: &Pubkey,
    midprice_account: &Pubkey,
    current_authority: &Pubkey,
    new_authority: &Pubkey,
) -> Instruction {
    let mut data = vec![0u8; 1 + 32];
    data[0] = IX_TRANSFER_AUTHORITY;
    data[1..33].copy_from_slice(new_authority.as_ref());

    Instruction::new_with_bytes(
        *program_id,
        &data,
        vec![
            AccountMeta::new(*midprice_account, false),
            AccountMeta::new_readonly(*current_authority, true),
        ],
    )
}

// ---------------------------------------------------------------------------
// Drift Anchor instructions (sha256 discriminator)
// ---------------------------------------------------------------------------

/// Compute Anchor instruction discriminator: first 8 bytes of sha256("global:<name>").
fn anchor_discriminator(name: &str) -> [u8; 8] {
    let mut hasher = Sha256::new();
    hasher.update(format!("global:{name}").as_bytes());
    let hash = hasher.finalize();
    let mut disc = [0u8; 8];
    disc.copy_from_slice(&hash[..8]);
    disc
}

/// Build an `initialize_prop_amm_midprice` Drift Anchor instruction.
///
/// Initializes a PropAMM midprice account via Drift CPI into `midprice_pino::initialize`.
/// The midprice PDA must be pre-allocated (`create_account`) before calling.
///
/// * `drift_program_id` - Deployed Drift program ID.
/// * `authority` - Signer who owns the midprice account.
/// * `midprice_account` - Writable midprice PDA (must already exist on-chain).
/// * `perp_market` - Drift perp market account for this market index.
/// * `midprice_program` - Midprice-pino program ID (passed for CPI).
/// * `prop_amm_matcher` - PropAMM matcher PDA.
/// * `subaccount_index` - Subaccount index for PDA derivation.
pub fn initialize_prop_amm_midprice(
    drift_program_id: &Pubkey,
    authority: &Pubkey,
    midprice_account: &Pubkey,
    perp_market: &Pubkey,
    midprice_program: &Pubkey,
    prop_amm_matcher: &Pubkey,
    subaccount_index: u16,
) -> Instruction {
    let mut data = Vec::with_capacity(8 + 2);
    data.extend_from_slice(&anchor_discriminator("initialize_prop_amm_midprice"));
    data.extend_from_slice(&subaccount_index.to_le_bytes());

    Instruction::new_with_bytes(
        *drift_program_id,
        &data,
        vec![
            AccountMeta::new_readonly(*authority, true),
            AccountMeta::new(*midprice_account, false),
            AccountMeta::new_readonly(*perp_market, false),
            AccountMeta::new_readonly(*midprice_program, false),
            AccountMeta::new_readonly(*prop_amm_matcher, false),
        ],
    )
}

/// Build an `initialize_prop_amm_matcher` Drift Anchor instruction.
///
/// One-time admin operation to create the global PropAMM matcher PDA.
///
/// * `drift_program_id` - Deployed Drift program ID.
/// * `payer` - Signer who pays for account creation.
/// * `prop_amm_matcher` - Matcher PDA (derived via [`pda::prop_amm_matcher_pda`](crate::pda::prop_amm_matcher_pda)).
pub fn initialize_prop_amm_matcher(
    drift_program_id: &Pubkey,
    payer: &Pubkey,
    prop_amm_matcher: &Pubkey,
) -> Instruction {
    let data = anchor_discriminator("initialize_prop_amm_matcher").to_vec();

    Instruction::new_with_bytes(
        *drift_program_id,
        &data,
        vec![
            AccountMeta::new(*payer, true),
            AccountMeta::new(*prop_amm_matcher, false),
            AccountMeta::new_readonly(solana_sysvar::rent::ID, false),
            AccountMeta::new_readonly(solana_system_interface::program::ID, false),
        ],
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn update_mid_price_serialization() {
        let program_id = Pubkey::new_unique();
        let midprice = Pubkey::new_unique();
        let authority = Pubkey::new_unique();

        let ix = update_mid_price(&program_id, &midprice, &authority, 42_000_000, 100);
        assert_eq!(ix.data.len(), 17);
        assert_eq!(ix.data[0], IX_UPDATE_MID_PRICE);
        assert_eq!(
            u64::from_le_bytes(ix.data[1..9].try_into().unwrap()),
            42_000_000
        );
        assert_eq!(u64::from_le_bytes(ix.data[9..17].try_into().unwrap()), 100);
        assert_eq!(ix.accounts.len(), 2);
    }

    #[test]
    fn set_orders_serialization() {
        let program_id = Pubkey::new_unique();
        let midprice = Pubkey::new_unique();
        let authority = Pubkey::new_unique();

        let asks = vec![OrderEntry {
            offset: 1000,
            size: 5_000_000_000,
        }];
        let bids = vec![OrderEntry {
            offset: -1000,
            size: 5_000_000_000,
        }];
        let ix = set_orders(&program_id, &midprice, &authority, 50, &asks, &bids);

        assert_eq!(ix.data[0], IX_SET_ORDERS);
        assert_eq!(u64::from_le_bytes(ix.data[1..9].try_into().unwrap()), 50); // valid_until_slot
        assert_eq!(u16::from_le_bytes(ix.data[9..11].try_into().unwrap()), 1); // ask_len
        assert_eq!(u16::from_le_bytes(ix.data[11..13].try_into().unwrap()), 1); // bid_len
                                                                                // First entry (ask): offset=1000
        assert_eq!(
            i64::from_le_bytes(ix.data[13..21].try_into().unwrap()),
            1000
        );
        // Second entry (bid): offset=-1000
        assert_eq!(
            i64::from_le_bytes(ix.data[29..37].try_into().unwrap()),
            -1000
        );
        assert_eq!(ix.data.len(), 1 + 12 + 2 * 16);
    }

    #[test]
    fn set_quote_ttl_serialization() {
        let program_id = Pubkey::new_unique();
        let midprice = Pubkey::new_unique();
        let authority = Pubkey::new_unique();

        let ix = set_quote_ttl(&program_id, &midprice, &authority, 150);
        assert_eq!(ix.data.len(), 9);
        assert_eq!(ix.data[0], IX_SET_QUOTE_TTL);
        assert_eq!(u64::from_le_bytes(ix.data[1..9].try_into().unwrap()), 150);
    }

    #[test]
    fn close_account_serialization() {
        let program_id = Pubkey::new_unique();
        let midprice = Pubkey::new_unique();
        let authority = Pubkey::new_unique();
        let dest = Pubkey::new_unique();

        let ix = close_account(&program_id, &midprice, &authority, &dest);
        assert_eq!(ix.data.len(), 1);
        assert_eq!(ix.data[0], IX_CLOSE_ACCOUNT);
        assert_eq!(ix.accounts.len(), 3);
        assert!(ix.accounts[2].is_writable); // destination
    }

    #[test]
    fn transfer_authority_serialization() {
        let program_id = Pubkey::new_unique();
        let midprice = Pubkey::new_unique();
        let authority = Pubkey::new_unique();
        let new_auth = Pubkey::new_unique();

        let ix = transfer_authority(&program_id, &midprice, &authority, &new_auth);
        assert_eq!(ix.data.len(), 33);
        assert_eq!(ix.data[0], IX_TRANSFER_AUTHORITY);
        assert_eq!(&ix.data[1..33], new_auth.as_ref());
    }

    #[test]
    fn anchor_discriminator_is_stable() {
        let disc = anchor_discriminator("initialize_prop_amm_midprice");
        // Should be deterministic across runs.
        let disc2 = anchor_discriminator("initialize_prop_amm_midprice");
        assert_eq!(disc, disc2);
        // And 8 bytes.
        assert_eq!(disc.len(), 8);
    }

    #[test]
    fn initialize_prop_amm_midprice_accounts() {
        let drift = Pubkey::new_unique();
        let auth = Pubkey::new_unique();
        let mid = Pubkey::new_unique();
        let pm = Pubkey::new_unique();
        let mp = Pubkey::new_unique();
        let matcher = Pubkey::new_unique();

        let ix = initialize_prop_amm_midprice(&drift, &auth, &mid, &pm, &mp, &matcher, 0);
        assert_eq!(ix.accounts.len(), 5);
        assert!(ix.accounts[0].is_signer); // authority
        assert!(ix.accounts[1].is_writable); // midprice_account
    }
}
