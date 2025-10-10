//! Packed feed information data structures for oracle quotes
//!
//! This module defines zero-copy data structures for efficiently storing and accessing
//! oracle feed data within quotes. The structures use `#[repr(packed)]` to ensure
//! consistent memory layout across platforms and minimize space usage.

use faster_hex::hex_string;
use rust_decimal::prelude::*;

use crate::prelude::*;

/// Packed quote header containing the signed slot hash
///
/// This header is signed by all oracles in the quote and contains the slot hash
/// that is used to validate the quote's freshness against the slot hash sysvar.
///
/// Size: 32 bytes
#[derive(Copy, Clone, Debug)]
#[repr(packed)]
pub struct PackedQuoteHeader {
    /// The 32-byte slot hash that was signed by all oracles in the quote
    pub signed_slothash: [u8; 32],
}

/// Packed feed information containing ID, value, and validation requirements
///
/// This structure stores individual feed data within a quote. The layout is optimized
/// for compatibility with JavaScript serialization, with the feed ID first, followed
/// by the value and minimum sample requirement.
///
/// Size: 49 bytes (32 + 16 + 1)
#[derive(Copy, Clone, Debug)]
#[repr(packed)]
pub struct PackedFeedInfo {
    /// 32-byte unique identifier for this feed
    feed_id: [u8; 32],
    /// Feed value as a fixed-point integer (scaled by PRECISION)
    feed_value: i128,
    /// Minimum number of oracle samples required for this feed to be considered valid
    min_oracle_samples: u8,
}

impl PackedFeedInfo {
    /// The size in bytes of this packed structure
    pub const PACKED_SIZE: usize = 49;

    /// Returns a reference to the 32-byte feed ID
    #[inline(always)]
    pub fn feed_id(&self) -> &[u8; 32] {
        &self.feed_id
    }

    /// Returns the feed ID as a hexadecimal string with "0x" prefix
    ///
    /// This is useful for displaying feed IDs in a human-readable format
    /// or for use in APIs that expect hex-encoded identifiers.
    #[inline(always)]
    pub fn hex_id(&self) -> String {
        String::from("0x") + &hex_string(self.feed_id())
    }

    /// Returns the raw feed value as a fixed-point integer
    ///
    /// This value is scaled by the program-wide `PRECISION` constant.
    /// Use [`value()`](Self::value) to get the human-readable decimal form.
    #[inline(always)]
    pub fn feed_value(&self) -> i128 {
        self.feed_value
    }

    /// Returns the feed value as a `Decimal`, scaled using the program-wide `PRECISION`.
    ///
    /// This converts the raw fixed-point integer into a human-readable decimal form.
    /// For example, if the raw value is 115525650000000000000000 and PRECISION is 18,
    /// this will return approximately 115525.65.
    #[inline(always)]
    pub fn value(&self) -> Decimal {
        Decimal::from_i128_with_scale(self.feed_value(), PRECISION).normalize()
    }

    /// Returns the minimum number of oracle samples required for this feed
    #[inline(always)]
    pub fn min_oracle_samples(&self) -> u8 {
        self.min_oracle_samples
    }
}

#[cfg(test)]
mod tests {

    use super::*;

    #[test]
    fn test_packed_feed_info_layout() {
        // Simulate JavaScript serialized data: feed_id (32) + feed_value (16) + min_oracle_samples (1)
        let mut data = [0u8; 49];

        // Feed ID (32 bytes) - some test hash
        data[0..32].fill(0x42);

        // Feed value at offset 32: 115525650000000000000000 (i128, scaled by 18 decimals)
        // This should decode to approximately 115525.65
        let feed_value_scaled: i128 = 115525650000000000000000i128;
        let value_bytes = feed_value_scaled.to_le_bytes();
        data[32..48].copy_from_slice(&value_bytes);

        // Min oracle samples (1 byte) at offset 48
        data[48] = 5;

        // Cast to PackedFeedInfo
        let feed_info = unsafe { &*(data.as_ptr() as *const PackedFeedInfo) };

        // Test reading the feed value
        let raw_value = feed_info.feed_value();
        println!("Raw feed value: {}", raw_value);
        println!("Expected: {}", feed_value_scaled);
        assert_eq!(raw_value, feed_value_scaled);

        // Test the decimal conversion
        let decimal_value = feed_info.value();
        println!("Decimal value: {}", decimal_value);

        // Test other fields
        assert_eq!(feed_info.min_oracle_samples(), 5);
        assert_eq!(feed_info.feed_id()[0], 0x42);

        println!(
            "✅ Test passed! Feed value reads correctly: {}",
            decimal_value
        );
    }
}
