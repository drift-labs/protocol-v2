//! Parser for ED25519 instruction data into owned structures
//!
//! This module provides functions to parse the raw ED25519 instruction format
//! into owned (non-reference) data structures that can be serialized with Borsh.

// Re-export for derive macros
use anchor_lang::prelude::borsh;
use borsh::{BorshDeserialize, BorshSerialize};

use crate::on_demand::oracle_quote::feed_info::{PackedFeedInfo, PackedQuoteHeader};

// Import Ed25519SignatureOffsets conditionally
#[cfg(any(feature = "client", not(target_os = "solana")))]
use crate::sysvar::ed25519_sysvar::{
    Ed25519SignatureOffsets, ED25519_PUBKEY_SERIALIZED_SIZE, ED25519_SIGNATURE_OFFSETS_SERIALIZED_SIZE,
    ED25519_SIGNATURE_SERIALIZED_SIZE,
};

// Define constants for on-chain use
#[cfg(all(not(feature = "client"), target_os = "solana"))]
pub const ED25519_PUBKEY_SERIALIZED_SIZE: usize = 32;
#[cfg(all(not(feature = "client"), target_os = "solana"))]
pub const ED25519_SIGNATURE_SERIALIZED_SIZE: usize = 64;
#[cfg(all(not(feature = "client"), target_os = "solana"))]
pub const ED25519_SIGNATURE_OFFSETS_SERIALIZED_SIZE: usize = 14;

// Import from switchboard_quote for on-chain use
#[cfg(all(not(feature = "client"), target_os = "solana"))]
use super::switchboard_quote::Ed25519SignatureOffsets;

/// Parsed ED25519 instruction data with owned values (not references)
///
/// This structure represents the complete ED25519 instruction data parsed
/// from the raw offset-based format into a sequential, owned representation
/// suitable for Borsh serialization.
#[derive(Debug, Clone, PartialEq, BorshSerialize, BorshDeserialize)]
pub struct ParsedEd25519Instruction {
    /// Number of oracle signatures
    pub num_signatures: u8,
    /// Padding byte
    pub padding: u8,
    /// Array of signature data (offsets + pubkey + signature)
    pub signatures: Vec<OracleSignatureData>,
    /// Quote header containing the signed slot hash
    pub quote_header: PackedQuoteHeader,
    /// Array of feed information
    pub feeds: Vec<PackedFeedInfo>,
    /// Oracle indices corresponding to queue's oracle array
    pub oracle_idxs: Vec<u8>,
    /// Slot number for freshness validation
    pub slot: u64,
    /// Version byte
    pub version: u8,
    /// Tail discriminator "SBOD"
    pub discriminator: [u8; 4],
}

/// Oracle signature data with offsets, pubkey, and signature
///
/// This is the owned version that stores actual data instead of pointers
#[derive(Debug, Clone, Copy, PartialEq, Eq, BorshSerialize, BorshDeserialize)]
pub struct OracleSignatureData {
    /// Offsets structure (kept for reference/debugging)
    pub offsets: Ed25519SignatureOffsets,
    /// ED25519 public key (32 bytes)
    pub pubkey: [u8; 32],
    /// ED25519 signature (64 bytes)
    pub signature: [u8; 64],
}

/// Simple error type for parsing failures
#[derive(Debug)]
pub struct ParseError(pub String);

impl core::fmt::Display for ParseError {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        write!(f, "{}", self.0)
    }
}

impl ParsedEd25519Instruction {
    /// Parse ED25519 instruction data from raw bytes
    ///
    /// This function reads the offset-based ED25519 instruction format and
    /// extracts all data into owned structures. The format is:
    ///
    /// ```text
    /// [Header: num_signatures(u8) + padding(u8)]
    /// [Offsets: Ed25519SignatureOffsets[] (14 bytes each)]
    /// [Data Section: signatures, pubkeys at various offsets]
    /// [Message: PackedQuoteHeader + PackedFeedInfo[]]
    /// [Suffix: oracle_idxs + slot(u64) + version(u8) + "SBOD"(4)]
    /// ```
    ///
    /// # Arguments
    /// * `data` - Raw ED25519 instruction data bytes
    ///
    /// # Returns
    /// * `Ok(ParsedEd25519Instruction)` - Successfully parsed instruction with owned data
    /// * `Err` - Failed to parse the instruction data
    pub fn parse(data: &[u8]) -> Result<Self, ParseError> {
        let data_len = data.len();

        // Validate minimum size for header
        if data_len < 2 {
            return Err(ParseError("Data too short for Ed25519SignatureHeader".to_string()));
        }

        // Parse header
        let num_signatures = data[0];
        let padding = data[1];

        if num_signatures == 0 {
            return Err(ParseError("No signatures found in instruction data".to_string()));
        }
        if num_signatures > 8 {
            return Err(ParseError("Too many signatures - maximum 8 supported".to_string()));
        }

        // Extract suffix data from the end
        let suffix_len = num_signatures as usize + 13; // oracle_idxs + slot(8) + version(1) + discriminator(4)
        if data_len < suffix_len {
            return Err(ParseError(format!(
                "Data too short for suffix: need {} bytes, got {}",
                suffix_len, data_len
            )));
        }

        let end_of_message = data_len - suffix_len;
        let suffix = &data[end_of_message..];

        // Parse suffix
        let oracle_idxs = suffix[..num_signatures as usize].to_vec();
        let slot_bytes = &suffix[num_signatures as usize..num_signatures as usize + 8];
        let slot = u64::from_le_bytes(slot_bytes.try_into().unwrap());
        let version = suffix[num_signatures as usize + 8];
        let discriminator: [u8; 4] = suffix[num_signatures as usize + 9..num_signatures as usize + 13]
            .try_into()
            .unwrap();

        // Parse offsets and extract signature data
        let message_data = &data[..end_of_message];
        let mut signatures = Vec::with_capacity(num_signatures as usize);
        let mut offset = 2usize; // Skip header

        // Parse first signature to get message location
        if offset + ED25519_SIGNATURE_OFFSETS_SERIALIZED_SIZE > message_data.len() {
            return Err(ParseError("Data too short for first signature offsets".to_string()));
        }

        let first_offsets = Self::read_offsets(&message_data[offset..offset + ED25519_SIGNATURE_OFFSETS_SERIALIZED_SIZE]);
        let message_offset = first_offsets.message_data_offset as usize;
        let message_size = first_offsets.message_data_size as usize;

        // Extract all signatures
        for i in 0..num_signatures {
            let offsets = Self::read_offsets(&message_data[offset..offset + ED25519_SIGNATURE_OFFSETS_SERIALIZED_SIZE]);

            // Read pubkey
            let pubkey_offset = offsets.public_key_offset as usize;
            if pubkey_offset + ED25519_PUBKEY_SERIALIZED_SIZE > message_data.len() {
                return Err(ParseError("Pubkey offset out of bounds".to_string()));
            }
            let pubkey: [u8; 32] = message_data[pubkey_offset..pubkey_offset + ED25519_PUBKEY_SERIALIZED_SIZE]
                .try_into()
                .unwrap();

            // Read signature
            let sig_offset = offsets.signature_offset as usize;
            if sig_offset + ED25519_SIGNATURE_SERIALIZED_SIZE > message_data.len() {
                return Err(ParseError("Signature offset out of bounds".to_string()));
            }
            let signature: [u8; 64] = message_data[sig_offset..sig_offset + ED25519_SIGNATURE_SERIALIZED_SIZE]
                .try_into()
                .unwrap();

            signatures.push(OracleSignatureData {
                offsets,
                pubkey,
                signature,
            });

            offset += ED25519_SIGNATURE_OFFSETS_SERIALIZED_SIZE;

            // Verify message consistency for subsequent signatures
            if i > 0 {
                if offsets.message_data_offset != first_offsets.message_data_offset {
                    return Err(ParseError("Message offset mismatch".to_string()));
                }
                if offsets.message_data_size != first_offsets.message_data_size {
                    return Err(ParseError("Message size mismatch".to_string()));
                }
            }
        }

        // Parse message: PackedQuoteHeader + PackedFeedInfo[]
        if message_offset + message_size > message_data.len() {
            return Err(ParseError("Message offset/size out of bounds".to_string()));
        }
        let message = &message_data[message_offset..message_offset + message_size];

        // Parse quote header using Borsh deserialization
        if message.len() < 32 {
            return Err(ParseError("Message too short for PackedQuoteHeader".to_string()));
        }
        let quote_header = PackedQuoteHeader::try_from_slice(&message[0..32])
            .map_err(|e| ParseError(format!("Failed to deserialize PackedQuoteHeader: {}", e)))?;

        // Parse feeds using Borsh deserialization
        let mut feeds = Vec::new();
        let mut feed_offset = 32; // After quote header
        while feed_offset + 49 <= message.len() {
            let feed_bytes = &message[feed_offset..feed_offset + 49];
            // Use Borsh deserialization since PackedFeedInfo implements BorshDeserialize
            let feed = PackedFeedInfo::try_from_slice(feed_bytes)
                .map_err(|e| ParseError(format!("Failed to deserialize PackedFeedInfo: {}", e)))?;
            feeds.push(feed);
            feed_offset += 49;
        }

        Ok(Self {
            num_signatures,
            padding,
            signatures,
            quote_header,
            feeds,
            oracle_idxs,
            slot,
            version,
            discriminator,
        })
    }

    /// Read Ed25519SignatureOffsets from bytes
    fn read_offsets(data: &[u8]) -> Ed25519SignatureOffsets {
        assert!(data.len() >= ED25519_SIGNATURE_OFFSETS_SERIALIZED_SIZE);

        Ed25519SignatureOffsets {
            signature_offset: u16::from_le_bytes([data[0], data[1]]),
            signature_instruction_index: u16::from_le_bytes([data[2], data[3]]),
            public_key_offset: u16::from_le_bytes([data[4], data[5]]),
            public_key_instruction_index: u16::from_le_bytes([data[6], data[7]]),
            message_data_offset: u16::from_le_bytes([data[8], data[9]]),
            message_data_size: u16::from_le_bytes([data[10], data[11]]),
            message_instruction_index: u16::from_le_bytes([data[12], data[13]]),
        }
    }

    /// Serialize this parsed instruction back to raw ED25519 instruction format
    ///
    /// This reconstructs the offset-based format from the owned data.
    /// This is useful if you need to write data back in the original format.
    pub fn to_instruction_bytes(&self) -> Vec<u8> {
        // This is complex - we'd need to reconstruct the offset-based layout
        // For now, we'll implement a simple sequential layout
        // TODO: Implement proper offset-based serialization if needed
        unimplemented!("Reconstructing offset-based format not yet implemented")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_parse_owned_structure() {
        // This test verifies the structure compiles and has correct types
        let parsed = ParsedEd25519Instruction {
            num_signatures: 1,
            padding: 0,
            signatures: vec![OracleSignatureData {
                offsets: Ed25519SignatureOffsets {
                    signature_offset: 0,
                    signature_instruction_index: 0,
                    public_key_offset: 0,
                    public_key_instruction_index: 0,
                    message_data_offset: 0,
                    message_data_size: 0,
                    message_instruction_index: 0,
                },
                pubkey: [0u8; 32],
                signature: [0u8; 64],
            }],
            quote_header: PackedQuoteHeader {
                signed_slothash: [0u8; 32],
            },
            feeds: vec![],
            oracle_idxs: vec![0],
            slot: 0,
            version: 0,
            discriminator: *b"SBOD",
        };

        // Test Borsh serialization round-trip
        let serialized = anchor_lang::prelude::borsh::to_vec(&parsed).expect("Failed to serialize");
        let deserialized: ParsedEd25519Instruction =
            anchor_lang::prelude::borsh::from_slice(&serialized).expect("Failed to deserialize");

        assert_eq!(parsed, deserialized);
    }
}
