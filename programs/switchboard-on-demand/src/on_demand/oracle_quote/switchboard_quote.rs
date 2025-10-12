use crate::smallvec::{SmallVec, U8Prefix, U16Prefix};
use crate::on_demand::oracle_quote::feed_info::{PackedFeedInfo, PackedQuoteHeader};
use crate::Pubkey;

// Compatibility shim for anchor-lang borsh macros
#[cfg(feature = "anchor")]
mod borsh {
    pub use anchor_lang::prelude::borsh::*;
    pub mod maybestd {
        pub mod io {
            pub use std::io::*;
        }
    }
}

// Import Ed25519SignatureOffsets conditionally
#[cfg(any(feature = "client", not(target_os = "solana")))]
use crate::sysvar::ed25519_sysvar::Ed25519SignatureOffsets;

// Define Ed25519SignatureOffsets for on-chain use
#[cfg(all(not(feature = "client"), target_os = "solana"))]
#[repr(C)]
#[derive(Debug, Copy, Clone, PartialEq, Eq)]
pub struct Ed25519SignatureOffsets {
    pub signature_offset: u16,
    pub signature_instruction_index: u16,
    pub public_key_offset: u16,
    pub public_key_instruction_index: u16,
    pub message_data_offset: u16,
    pub message_data_size: u16,
    pub message_instruction_index: u16,
}

#[cfg(all(not(feature = "client"), target_os = "solana"))]
impl anchor_lang::prelude::borsh::BorshSerialize for Ed25519SignatureOffsets {
    fn serialize<W: std::io::Write>(&self, writer: &mut W) -> std::io::Result<()> {
        writer.write_all(&self.signature_offset.to_le_bytes())?;
        writer.write_all(&self.signature_instruction_index.to_le_bytes())?;
        writer.write_all(&self.public_key_offset.to_le_bytes())?;
        writer.write_all(&self.public_key_instruction_index.to_le_bytes())?;
        writer.write_all(&self.message_data_offset.to_le_bytes())?;
        writer.write_all(&self.message_data_size.to_le_bytes())?;
        writer.write_all(&self.message_instruction_index.to_le_bytes())?;
        Ok(())
    }
}

#[cfg(all(not(feature = "client"), target_os = "solana"))]
impl anchor_lang::prelude::borsh::BorshDeserialize for Ed25519SignatureOffsets {
    fn deserialize_reader<R: std::io::Read>(reader: &mut R) -> std::io::Result<Self> {
        let mut buf = [0u8; 2];
        reader.read_exact(&mut buf)?;
        let signature_offset = u16::from_le_bytes(buf);
        reader.read_exact(&mut buf)?;
        let signature_instruction_index = u16::from_le_bytes(buf);
        reader.read_exact(&mut buf)?;
        let public_key_offset = u16::from_le_bytes(buf);
        reader.read_exact(&mut buf)?;
        let public_key_instruction_index = u16::from_le_bytes(buf);
        reader.read_exact(&mut buf)?;
        let message_data_offset = u16::from_le_bytes(buf);
        reader.read_exact(&mut buf)?;
        let message_data_size = u16::from_le_bytes(buf);
        reader.read_exact(&mut buf)?;
        let message_instruction_index = u16::from_le_bytes(buf);
        Ok(Self {
            signature_offset,
            signature_instruction_index,
            public_key_offset,
            public_key_instruction_index,
            message_data_offset,
            message_data_size,
            message_instruction_index,
        })
    }
}

pub const QUOTE_DISCRIMINATOR: [u8; 8] = *b"SBOracle";

/// Oracle signature data with offsets
#[cfg_attr(feature = "anchor", derive(anchor_lang::AnchorSerialize, anchor_lang::AnchorDeserialize))]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(C)]
pub struct OracleSignature {
    /// Offsets to locate signature data within instruction
    pub offsets: Ed25519SignatureOffsets,
    /// ED25519 public key
    pub pubkey: Pubkey,
    /// ED25519 signature (64 bytes)
    pub signature: [u8; 64],
}

#[cfg(not(feature = "anchor"))]
impl anchor_lang::prelude::borsh::BorshSerialize for OracleSignature {
    fn serialize<W: std::io::Write>(&self, writer: &mut W) -> std::io::Result<()> {
        self.offsets.serialize(writer)?;
        writer.write_all(self.pubkey.as_ref())?;
        writer.write_all(&self.signature)?;
        Ok(())
    }
}

#[cfg(not(feature = "anchor"))]
impl anchor_lang::prelude::borsh::BorshDeserialize for OracleSignature {
    fn deserialize_reader<R: std::io::Read>(reader: &mut R) -> std::io::Result<Self> {
        let offsets = Ed25519SignatureOffsets::deserialize_reader(reader)?;
        let mut pubkey_bytes = [0u8; 32];
        reader.read_exact(&mut pubkey_bytes)?;
        let pubkey = Pubkey::new_from_array(pubkey_bytes);
        let mut signature = [0u8; 64];
        reader.read_exact(&mut signature)?;
        Ok(Self {
            offsets,
            pubkey,
            signature,
        })
    }
}

#[cfg(feature = "idl-build")]
impl anchor_lang::IdlBuild for OracleSignature {}

/// Switchboard oracle quote account structure
///
/// # On-chain Layout (excluding 8-byte discriminator):
/// ```text
/// [0..32]      queue: Queue pubkey (32 bytes)
/// [34..]       signatures: SmallVec of OracleSignature (2-byte u16 length + 110 bytes each)
///              - Ed25519SignatureOffsets (14 bytes)
///              - pubkey (32 bytes)
///              - signature (64 bytes)
/// [..]         quote_header: PackedQuoteHeader (32 bytes)
/// [..]         feeds: SmallVec of PackedFeedInfo (1-byte u8 length + 49 bytes each)
/// [..]         oracle_idxs: SmallVec of oracle indices (1-byte u8 length + u8 each)
/// [..]         slot: Slot number (u64, 8 bytes)
/// [..]         version: Version (u8, 1 byte)
/// [..]         tail_discriminator: "SBOD" (4 bytes)
/// ```
///
/// # Length Prefix Sizes
/// - `signatures`: 2-byte (u16) length prefix - allows up to 65535 signatures
/// - `feeds`: 1-byte (u8) length prefix - max 255 feeds
/// - `oracle_idxs`: 1-byte (u8) length prefix - max 255 indices
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SwitchboardQuote {
    /// Queue pubkey that this oracle quote belongs to
    pub queue: Pubkey,
    /// Uses 2-byte (u16) length prefix
    pub signatures: SmallVec<OracleSignature, U16Prefix>,
    /// Quote header containing the signed slot hash
    pub quote_header: PackedQuoteHeader,
    /// Array of feed information (max 255)
    /// Uses 1-byte (u8) length prefix
    pub feeds: SmallVec<PackedFeedInfo, U8Prefix>,
    /// Oracle indices that correspond to the queue's oracle array (max 255)
    /// Uses 1-byte (u8) length prefix
    pub oracle_idxs: SmallVec<u8, U8Prefix>,
    /// Recent slot from the ED25519 instruction data used for freshness validation
    pub slot: u64,
    /// Version from the ED25519 instruction data
    pub version: u8,
    /// Tail discriminator "SBOD" for validation
    pub tail_discriminator: [u8; 4],
}

impl anchor_lang::prelude::borsh::BorshSerialize for SwitchboardQuote {
    fn serialize<W: std::io::Write>(&self, writer: &mut W) -> std::io::Result<()> {
        writer.write_all(self.queue.as_ref())?;
        self.signatures.serialize(writer)?;
        self.quote_header.serialize(writer)?;
        self.feeds.serialize(writer)?;
        self.oracle_idxs.serialize(writer)?;
        self.slot.serialize(writer)?;
        self.version.serialize(writer)?;
        self.tail_discriminator.serialize(writer)?;
        Ok(())
    }
}

impl anchor_lang::prelude::borsh::BorshDeserialize for SwitchboardQuote {
    fn deserialize_reader<R: std::io::Read>(reader: &mut R) -> std::io::Result<Self> {
        let mut queue_bytes = [0u8; 32];
        reader.read_exact(&mut queue_bytes)?;
        Ok(Self {
            queue: Pubkey::new_from_array(queue_bytes),
            signatures: anchor_lang::prelude::borsh::BorshDeserialize::deserialize_reader(reader)?,
            quote_header: anchor_lang::prelude::borsh::BorshDeserialize::deserialize_reader(reader)?,
            feeds: anchor_lang::prelude::borsh::BorshDeserialize::deserialize_reader(reader)?,
            oracle_idxs: anchor_lang::prelude::borsh::BorshDeserialize::deserialize_reader(reader)?,
            slot: anchor_lang::prelude::borsh::BorshDeserialize::deserialize_reader(reader)?,
            version: anchor_lang::prelude::borsh::BorshDeserialize::deserialize_reader(reader)?,
            tail_discriminator: anchor_lang::prelude::borsh::BorshDeserialize::deserialize_reader(reader)?,
        })
    }
}

#[cfg(feature = "anchor")]
impl anchor_lang::Discriminator for SwitchboardQuote {
    const DISCRIMINATOR: [u8; 8] = QUOTE_DISCRIMINATOR;
}

#[cfg(feature = "anchor")]
impl anchor_lang::AccountSerialize for SwitchboardQuote {
    fn try_serialize<W: std::io::Write>(&self, writer: &mut W) -> anchor_lang::Result<()> {
        use anchor_lang::Discriminator;

        // Write discriminator (8 bytes)
        writer.write_all(&Self::DISCRIMINATOR)?;

        // Write queue pubkey (32 bytes)
        writer.write_all(self.queue.as_ref())?;

        // Serialize the delimited data to a buffer first to get length
        let mut delimited_buf = Vec::new();
        anchor_lang::prelude::borsh::BorshSerialize::serialize(&self.signatures, &mut delimited_buf)
            .map_err(|_| anchor_lang::error::ErrorCode::AccountDidNotSerialize)?;
        anchor_lang::prelude::borsh::BorshSerialize::serialize(&self.quote_header, &mut delimited_buf)
            .map_err(|_| anchor_lang::error::ErrorCode::AccountDidNotSerialize)?;
        anchor_lang::prelude::borsh::BorshSerialize::serialize(&self.feeds, &mut delimited_buf)
            .map_err(|_| anchor_lang::error::ErrorCode::AccountDidNotSerialize)?;
        anchor_lang::prelude::borsh::BorshSerialize::serialize(&self.oracle_idxs, &mut delimited_buf)
            .map_err(|_| anchor_lang::error::ErrorCode::AccountDidNotSerialize)?;
        anchor_lang::prelude::borsh::BorshSerialize::serialize(&self.slot, &mut delimited_buf)
            .map_err(|_| anchor_lang::error::ErrorCode::AccountDidNotSerialize)?;
        anchor_lang::prelude::borsh::BorshSerialize::serialize(&self.version, &mut delimited_buf)
            .map_err(|_| anchor_lang::error::ErrorCode::AccountDidNotSerialize)?;
        anchor_lang::prelude::borsh::BorshSerialize::serialize(&self.tail_discriminator, &mut delimited_buf)
            .map_err(|_| anchor_lang::error::ErrorCode::AccountDidNotSerialize)?;

        // Write u16 length prefix
        let len = delimited_buf.len() as u16;
        writer.write_all(&len.to_le_bytes())?;

        // Write delimited data
        writer.write_all(&delimited_buf)?;

        Ok(())
    }
}

#[cfg(feature = "anchor")]
impl anchor_lang::AccountDeserialize for SwitchboardQuote {
    fn try_deserialize(buf: &mut &[u8]) -> anchor_lang::Result<Self> {
        use anchor_lang::Discriminator;
        use crate::on_demand::oracle_quote::instruction_parser::ParsedEd25519Instruction;

        // Check minimum size: discriminator (8) + queue (32) = 40 bytes minimum
        if buf.len() < 40 {
            return Err(anchor_lang::error::ErrorCode::AccountDiscriminatorNotFound.into());
        }

        // Check discriminator
        let given_disc = &buf[..Self::DISCRIMINATOR.len()];
        if given_disc != Self::DISCRIMINATOR {
            return Err(anchor_lang::error::ErrorCode::AccountDiscriminatorMismatch.into());
        }

        // Extract queue pubkey (bytes 8-40)
        let queue = Pubkey::new_from_array(buf[8..40].try_into().unwrap());

        // Parse length-delimited ED25519 instruction data starting at byte 40
        let data = &buf[40..];
        if data.len() < 2 {
            return Err(anchor_lang::error::ErrorCode::AccountDidNotDeserialize.into());
        }

        // Read u16 length prefix
        let len = u16::from_le_bytes([data[0], data[1]]) as usize;
        if data.len() < len + 2 {
            return Err(anchor_lang::error::ErrorCode::AccountDidNotDeserialize.into());
        }

        // Parse the ED25519 instruction data
        let ed25519_data = &data[2..len + 2];
        let parsed = ParsedEd25519Instruction::parse(ed25519_data)
            .map_err(|_| anchor_lang::error::ErrorCode::AccountDidNotDeserialize)?;

        // Convert Vec to SmallVec (will fail if exceeds capacity)
        let signatures = parsed.signatures.into_iter()
            .map(|sig| OracleSignature {
                offsets: sig.offsets,
                pubkey: Pubkey::new_from_array(sig.pubkey),
                signature: sig.signature,
            })
            .collect::<Vec<_>>()
            .try_into()
            .map_err(|_| anchor_lang::error::ErrorCode::AccountDidNotDeserialize)?;

        let feeds = parsed.feeds.into_iter()
            .collect::<Vec<_>>()
            .try_into()
            .map_err(|_| anchor_lang::error::ErrorCode::AccountDidNotDeserialize)?;

        let oracle_idxs = parsed.oracle_idxs.into_iter()
            .collect::<Vec<_>>()
            .try_into()
            .map_err(|_| anchor_lang::error::ErrorCode::AccountDidNotDeserialize)?;

        Ok(Self {
            queue,
            signatures,
            quote_header: parsed.quote_header,
            feeds,
            oracle_idxs,
            slot: parsed.slot,
            version: parsed.version,
            tail_discriminator: parsed.discriminator,
        })
    }

    fn try_deserialize_unchecked(buf: &mut &[u8]) -> anchor_lang::Result<Self> {
        use crate::on_demand::oracle_quote::instruction_parser::ParsedEd25519Instruction;

        if buf.len() < 40 {
            return Err(anchor_lang::error::ErrorCode::AccountDidNotDeserialize.into());
        }

        let full_buf = *buf;
        *buf = &[]; // Consume the buffer

        // Extract queue pubkey (bytes 8-40) - skip discriminator check for unchecked
        let queue = Pubkey::new_from_array(full_buf[8..40].try_into().unwrap());

        // Parse length-delimited ED25519 instruction data starting at byte 40
        let data = &full_buf[40..];
        if data.len() < 2 {
            return Err(anchor_lang::error::ErrorCode::AccountDidNotDeserialize.into());
        }

        // Read u16 length prefix
        let len = u16::from_le_bytes([data[0], data[1]]) as usize;
        if data.len() < len + 2 {
            return Err(anchor_lang::error::ErrorCode::AccountDidNotDeserialize.into());
        }

        // Parse the ED25519 instruction data
        let ed25519_data = &data[2..len + 2];
        let parsed = ParsedEd25519Instruction::parse(ed25519_data)
            .map_err(|_| anchor_lang::error::ErrorCode::AccountDidNotDeserialize)?;

        // Convert Vec to SmallVec (will fail if exceeds capacity)
        let signatures = parsed.signatures.into_iter()
            .map(|sig| OracleSignature {
                offsets: sig.offsets,
                pubkey: Pubkey::new_from_array(sig.pubkey),
                signature: sig.signature,
            })
            .collect::<Vec<_>>()
            .try_into()
            .map_err(|_| anchor_lang::error::ErrorCode::AccountDidNotDeserialize)?;

        let feeds = parsed.feeds.into_iter()
            .collect::<Vec<_>>()
            .try_into()
            .map_err(|_| anchor_lang::error::ErrorCode::AccountDidNotDeserialize)?;

        let oracle_idxs = parsed.oracle_idxs.into_iter()
            .collect::<Vec<_>>()
            .try_into()
            .map_err(|_| anchor_lang::error::ErrorCode::AccountDidNotDeserialize)?;

        Ok(Self {
            queue,
            signatures,
            quote_header: parsed.quote_header,
            feeds,
            oracle_idxs,
            slot: parsed.slot,
            version: parsed.version,
            tail_discriminator: parsed.discriminator,
        })
    }
}

#[cfg(feature = "idl-build")]
impl anchor_lang::IdlBuild for SwitchboardQuote {}

impl SwitchboardQuote {
    /// Maximum serialized size estimate for account initialization
    /// This is conservative: queue(32) + max_sigs(2 + 8*110) + quote_header(32) + max_feeds(1 + 8*49) + oracle_idxs(1 + 8) + slot(8) + version(1) + tail(4)
    pub const MAX_LEN: usize = 32 + (2 + 8 * 110) + 32 + (1 + 8 * 49) + (1 + 8) + 8 + 1 + 4;

    /// Minimum size for empty quote
    pub const MIN_LEN: usize = 32 + 2 + 32 + 1 + 1 + 8 + 1 + 4;

    /// Returns a reference to the feed information array
    ///
    /// # Example
    /// ```rust,ignore
    /// let feeds = quote.feeds_slice();
    /// for feed in feeds {
    ///     println!("Feed {}: {}", feed.hex_id(), feed.value());
    /// }
    /// ```
    pub fn feeds_slice(&self) -> &[PackedFeedInfo] {
        self.feeds.as_slice()
    }

    /// Get the canonical oracle account public key for the given feed IDs
    ///
    /// This method derives the canonical oracle account that the quote program
    /// creates and manages for storing verified oracle data.
    ///
    /// ## Parameters
    /// - `queue_key`: The queue public key to use as the first seed
    /// - `feed_ids`: Array of feed ID byte arrays (32 bytes each)
    /// - `program_id`: The quote program ID to use for derivation
    ///
    /// ## Returns
    /// The canonical oracle account public key
    ///
    /// ## Example
    /// ```rust,ignore
    /// let oracle_key = SwitchboardQuote::get_canonical_key(&queue_key, &[feed_id_bytes], &quote_program_id);
    /// ```
    #[cfg(feature = "anchor")]
    pub fn get_canonical_key(
        queue_key: &anchor_lang::solana_program::pubkey::Pubkey,
        feed_ids: &[&[u8; 32]],
        program_id: &anchor_lang::solana_program::pubkey::Pubkey,
    ) -> anchor_lang::solana_program::pubkey::Pubkey {
        let mut seeds: Vec<&[u8]> = Vec::with_capacity(feed_ids.len() + 1);
        seeds.push(queue_key.as_ref());
        for id in feed_ids {
            seeds.push(id.as_slice());
        }
        let (oracle_account, _) =
            anchor_lang::solana_program::pubkey::Pubkey::find_program_address(&seeds, program_id);
        oracle_account
    }

    /// Get the canonical oracle account for this quote's feeds
    ///
    /// Convenience method that extracts feed IDs from the current quote
    /// and derives the canonical oracle account using the provided owner.
    ///
    /// ## Parameters
    /// - `queue_key`: The queue public key to use as the first seed
    /// - `owner`: The program ID that owns this oracle account (usually the quote program)
    ///
    /// ## Returns
    /// The canonical oracle account public key for this quote's feeds
    ///
    /// ## Example
    /// ```rust,ignore
    /// let canonical_key = quote.canonical_key(&queue_key, &oracle_account.owner);
    /// ```
    #[cfg(feature = "anchor")]
    pub fn canonical_key(
        &self,
        queue_key: &anchor_lang::solana_program::pubkey::Pubkey,
        owner: &anchor_lang::solana_program::pubkey::Pubkey,
    ) -> anchor_lang::solana_program::pubkey::Pubkey {
        let feed_ids: Vec<&[u8; 32]> = self.feeds.iter().map(|feed| feed.feed_id()).collect();
        Self::get_canonical_key(queue_key, &feed_ids, owner)
    }
}

#[cfg(feature = "anchor")]
impl anchor_lang::Owner for SwitchboardQuote {
    fn owner() -> anchor_lang::solana_program::pubkey::Pubkey {
        crate::QUOTE_PROGRAM_ID.to_bytes().into()
    }
}
