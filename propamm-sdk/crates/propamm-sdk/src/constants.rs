use solana_pubkey::Pubkey;

/// Drift exchange program ID.
pub const DRIFT_PROGRAM_ID: Pubkey =
    solana_pubkey::pubkey!("dRiftyHA39MWEi3m9aunc5MzRF1JYuBsbn6VPcn33UH");

/// Midprice-pino program ID (devnet/localnet default — pass as constructor param if different).
pub const MIDPRICE_PINO_PROGRAM_ID: Pubkey =
    solana_pubkey::pubkey!("3DrLvHpasWASfdQCUPphLYA2qVUFWLJwiZsxeLe8mWPk");

/// Price precision: 10^6. Prices are integers in this scale (e.g. $50,000 = `50_000_000_000`).
pub const PRICE_PRECISION: u64 = 1_000_000;
/// Base asset precision: 10^9. Order sizes are integers in this scale (e.g. 1 unit = `1_000_000_000`).
pub const BASE_PRECISION: u64 = 1_000_000_000;
/// Quote asset precision: 10^6.
pub const QUOTE_PRECISION: u64 = 1_000_000;

/// Opcode for [`instructions::update_mid_price`](crate::instructions::update_mid_price).
pub const IX_UPDATE_MID_PRICE: u8 = 0;
/// Opcode for [`instructions::set_orders`](crate::instructions::set_orders).
pub const IX_SET_ORDERS: u8 = 2;
/// Opcode for [`instructions::set_quote_ttl`](crate::instructions::set_quote_ttl).
pub const IX_SET_QUOTE_TTL: u8 = 5;
/// Opcode for [`instructions::close_account`](crate::instructions::close_account).
pub const IX_CLOSE_ACCOUNT: u8 = 6;
/// Opcode for [`instructions::transfer_authority`](crate::instructions::transfer_authority).
pub const IX_TRANSFER_AUTHORITY: u8 = 7;
/// Opcode for [`instructions::initialize_midprice_pino`](crate::instructions::initialize_midprice_pino).
pub const IX_INITIALIZE: u8 = 1;

pub use midprice_book_view::{
    ACCOUNT_MIN_LEN, LEVEL_ENTRY_SIZE, SEQUENCE_NUMBER_OFFSET, STANDARDIZED_HEADER_SIZE,
};
