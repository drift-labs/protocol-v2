//! Protocol types.

pub mod api;
pub mod binary_update;
pub mod message;
pub mod payload;
pub mod publisher;
pub mod router;
mod serde_price_as_i64;
mod serde_str;
pub mod subscription;
pub mod symbol_state;

#[test]
fn magics_in_big_endian() {
    use crate::{
        binary_update::BINARY_UPDATE_FORMAT_MAGIC,
        message::format_magics_le::{
            EVM_FORMAT_MAGIC, JSON_FORMAT_MAGIC, LE_ECDSA_FORMAT_MAGIC, LE_UNSIGNED_FORMAT_MAGIC,
            SOLANA_FORMAT_MAGIC,
        },
        payload::PAYLOAD_FORMAT_MAGIC,
    };

    // The values listed in this test can be used when reading the magic headers in BE format
    // (e.g. on EVM).

    assert_eq!(u32::swap_bytes(BINARY_UPDATE_FORMAT_MAGIC), 1937213467);
    assert_eq!(u32::swap_bytes(PAYLOAD_FORMAT_MAGIC), 1976813459);

    assert_eq!(u32::swap_bytes(SOLANA_FORMAT_MAGIC), 3103857282);
    assert_eq!(u32::swap_bytes(JSON_FORMAT_MAGIC), 2584795844);
    assert_eq!(u32::swap_bytes(EVM_FORMAT_MAGIC), 706910618);
    assert_eq!(u32::swap_bytes(LE_ECDSA_FORMAT_MAGIC), 3837609805);
    assert_eq!(u32::swap_bytes(LE_UNSIGNED_FORMAT_MAGIC), 206398297);

    for magic in [
        BINARY_UPDATE_FORMAT_MAGIC,
        PAYLOAD_FORMAT_MAGIC,
        SOLANA_FORMAT_MAGIC,
        JSON_FORMAT_MAGIC,
        EVM_FORMAT_MAGIC,
        LE_ECDSA_FORMAT_MAGIC,
        LE_UNSIGNED_FORMAT_MAGIC,
    ] {
        // Required to distinguish between byte orders.
        assert!(u32::swap_bytes(magic) != magic);
    }
}
