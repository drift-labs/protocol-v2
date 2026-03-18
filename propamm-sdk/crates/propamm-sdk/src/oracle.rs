// NOTE: Pyth v2 price account parsing is done manually here instead of using
// `pyth-sdk-solana` because that crate pins `borsh = "^0.10"` which conflicts
// with the `borsh 1.x` required by the Solana 3.x crate ecosystem. If/when
// `pyth-sdk-solana` upgrades to borsh 1.x, we can switch back to it.

use thiserror::Error;

/// Parsed oracle price data.
#[derive(Clone, Copy, Debug)]
pub struct OraclePrice {
    /// Price in the oracle's native precision (Pyth: price × 10^(-expo)).
    pub price: i64,
    /// Confidence interval (same precision as price).
    pub confidence: u64,
    /// Slot at which this price was last updated.
    pub slot: u64,
}

/// Errors returned when parsing a Pyth oracle account.
#[derive(Debug, Error)]
pub enum OracleError {
    /// Account data is malformed (wrong magic, version, or too small).
    #[error("failed to parse Pyth price account: {0}")]
    PythParseError(String),
    /// The aggregate price status is not `Trading` — price may be stale or halted.
    #[error("Pyth price status is not Trading")]
    NotTrading,
}

// Pyth v2 on-chain price account layout offsets (magic 0xa1b2c3d4).
// See: https://github.com/pyth-network/pyth-client/blob/main/program/rust/src/accounts/price.rs
const PYTH_MAGIC: u32 = 0xa1b2c3d4;
const PYTH_VERSION_2: u32 = 2;
const PYTH_PRICE_STATUS_TRADING: u32 = 1;

// Fixed offsets into the Pyth v2 PriceAccount:
// 0..4    magic (u32)
// 4..8    ver (u32)
// 8..12   type (u32)
// 12..16  size (u32)
// 16..48  price_type(u32) + exponent(i32) + num_component(u32) + num_quoters(u32) + last_slot(u64) + valid_slot(u64)
//   specifically: offset 32..40 = last_slot (u64)
// 48..80  drv1(i64) + drv2(i64) + drv3(i64) + twap/twac...
//   The aggregate price info starts at a fixed offset.
// Aggregate: offset 208
//   208..216  price (i64)
//   216..224  conf (u64)
//   224..228  status (u32)
//   ...

const OFF_MAGIC: usize = 0;
const OFF_VER: usize = 4;
const OFF_LAST_SLOT: usize = 32;
const OFF_AGG_PRICE: usize = 208;
const OFF_AGG_CONF: usize = 216;
const OFF_AGG_STATUS: usize = 224;
const MIN_ACCOUNT_SIZE: usize = 228;

/// Parse a Pyth v2 price account from raw account data bytes.
///
/// Returns the current aggregate price, confidence, and last-update slot.
/// Errors if the account is malformed or the price status is not `Trading`.
///
/// * `data` - Raw Pyth v2 price account data (minimum 228 bytes).
pub fn parse_pyth_price(data: &[u8]) -> Result<OraclePrice, OracleError> {
    if data.len() < MIN_ACCOUNT_SIZE {
        return Err(OracleError::PythParseError(format!(
            "account too small: {} < {MIN_ACCOUNT_SIZE}",
            data.len()
        )));
    }

    let magic = u32::from_le_bytes(data[OFF_MAGIC..OFF_MAGIC + 4].try_into().unwrap());
    if magic != PYTH_MAGIC {
        return Err(OracleError::PythParseError(format!(
            "bad magic: {magic:#x}, expected {PYTH_MAGIC:#x}"
        )));
    }

    let ver = u32::from_le_bytes(data[OFF_VER..OFF_VER + 4].try_into().unwrap());
    if ver != PYTH_VERSION_2 {
        return Err(OracleError::PythParseError(format!(
            "unsupported version: {ver}, expected {PYTH_VERSION_2}"
        )));
    }

    let status = u32::from_le_bytes(data[OFF_AGG_STATUS..OFF_AGG_STATUS + 4].try_into().unwrap());
    if status != PYTH_PRICE_STATUS_TRADING {
        return Err(OracleError::NotTrading);
    }

    let price = i64::from_le_bytes(data[OFF_AGG_PRICE..OFF_AGG_PRICE + 8].try_into().unwrap());
    let conf = u64::from_le_bytes(data[OFF_AGG_CONF..OFF_AGG_CONF + 8].try_into().unwrap());
    let last_slot = u64::from_le_bytes(data[OFF_LAST_SLOT..OFF_LAST_SLOT + 8].try_into().unwrap());

    Ok(OraclePrice {
        price,
        confidence: conf,
        slot: last_slot,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn make_pyth_account(price: i64, conf: u64, slot: u64, status: u32) -> Vec<u8> {
        let mut data = vec![0u8; 512];
        data[OFF_MAGIC..OFF_MAGIC + 4].copy_from_slice(&PYTH_MAGIC.to_le_bytes());
        data[OFF_VER..OFF_VER + 4].copy_from_slice(&PYTH_VERSION_2.to_le_bytes());
        data[OFF_LAST_SLOT..OFF_LAST_SLOT + 8].copy_from_slice(&slot.to_le_bytes());
        data[OFF_AGG_PRICE..OFF_AGG_PRICE + 8].copy_from_slice(&price.to_le_bytes());
        data[OFF_AGG_CONF..OFF_AGG_CONF + 8].copy_from_slice(&conf.to_le_bytes());
        data[OFF_AGG_STATUS..OFF_AGG_STATUS + 4].copy_from_slice(&status.to_le_bytes());
        data
    }

    #[test]
    fn parse_valid_trading() {
        let data = make_pyth_account(50_000_000_000, 100_000, 42, PYTH_PRICE_STATUS_TRADING);
        let oracle = parse_pyth_price(&data).unwrap();
        assert_eq!(oracle.price, 50_000_000_000);
        assert_eq!(oracle.confidence, 100_000);
        assert_eq!(oracle.slot, 42);
    }

    #[test]
    fn parse_not_trading() {
        let data = make_pyth_account(50_000_000_000, 100_000, 42, 0); // status=Unknown
        assert!(matches!(
            parse_pyth_price(&data),
            Err(OracleError::NotTrading)
        ));
    }

    #[test]
    fn parse_bad_magic() {
        let mut data = make_pyth_account(1, 1, 1, PYTH_PRICE_STATUS_TRADING);
        data[0..4].copy_from_slice(&0xdeadbeef_u32.to_le_bytes());
        assert!(matches!(
            parse_pyth_price(&data),
            Err(OracleError::PythParseError(_))
        ));
    }

    #[test]
    fn parse_too_small() {
        let data = vec![0u8; 100];
        assert!(matches!(
            parse_pyth_price(&data),
            Err(OracleError::PythParseError(_))
        ));
    }
}
