use anyhow::{bail, Result};

use crate::on_demand::oracle_quote::feed_info::{PackedFeedInfo, PackedQuoteHeader};

/// Type alias for complex return type to improve readability
pub type ParsedInstructionResult<'a> = Result<(
    [ParsedEd25519SignatureDataRef<'a>; 8],
    u8,
    &'a [u8],
    u64,
    u8,
)>;

/// Size of a serialized ED25519 public key in bytes
pub const ED25519_PUBKEY_SERIALIZED_SIZE: usize = 32;
/// Size of a serialized ED25519 signature in bytes
pub const ED25519_SIGNATURE_SERIALIZED_SIZE: usize = 64;
/// Size of ED25519 signature offset structure in bytes
pub const ED25519_SIGNATURE_OFFSETS_SERIALIZED_SIZE: usize = 14; // 2+2+2+2+2+2+2 = 14 bytes

// const SBOD_DISCRIMINATOR: u32 = u32::from_le_bytes(*b"SBOD");

/// Header structure for ED25519 signature instruction data
#[repr(C)]
#[derive(Debug, Copy, Clone)]
pub struct Ed25519SignatureHeader {
    /// Number of signatures in the instruction
    pub num_signatures: u8,
    /// Padding byte for alignment
    pub padding: u8,
}

/// ED25519 signature data offsets within instruction data
#[repr(C)]
#[derive(Debug, Copy, Clone, PartialEq, Eq, borsh::BorshSerialize, borsh::BorshDeserialize)]
pub struct Ed25519SignatureOffsets {
    /// Offset to the signature data
    pub signature_offset: u16,
    /// Instruction index containing the signature
    pub signature_instruction_index: u16,
    /// Offset to the public key data
    pub public_key_offset: u16,
    /// Instruction index containing the public key
    pub public_key_instruction_index: u16,
    /// Offset to the message data
    pub message_data_offset: u16,
    /// Size of the message data in bytes
    pub message_data_size: u16,
    /// Instruction index containing the message
    pub message_instruction_index: u16,
}

#[cfg(feature = "anchor")]
impl anchor_lang::AnchorDeserialize for Ed25519SignatureOffsets {
    fn deserialize_reader<R: std::io::Read>(reader: &mut R) -> std::io::Result<Self> {
        <Self as borsh::BorshDeserialize>::deserialize_reader(reader)
    }
}

#[cfg(feature = "anchor")]
impl anchor_lang::AnchorSerialize for Ed25519SignatureOffsets {
    fn serialize<W: std::io::Write>(&self, writer: &mut W) -> std::io::Result<()> {
        <Self as borsh::BorshSerialize>::serialize(self, writer)
    }
}

#[cfg(feature = "idl-build")]
impl anchor_lang::IdlBuild for Ed25519SignatureOffsets {}

/// Parsed ED25519 signature data with lifetime-bound references
#[derive(Debug, Copy, Clone)]
pub struct ParsedEd25519SignatureDataRef<'a> {
    /// Signature data offsets
    pub offsets: Ed25519SignatureOffsets,
    /// Pointer to the public key data
    pub pubkey: *const [u8; ED25519_PUBKEY_SERIALIZED_SIZE],
    /// Pointer to the signature data
    pub signature: *const [u8; ED25519_SIGNATURE_SERIALIZED_SIZE],
    /// Pointer to the message data
    pub message: *const u8,
    /// Length of the message data
    pub message_len: usize,
    /// Pointer to the packed quote header
    pub bundle_header: *const PackedQuoteHeader,
    /// Pointer to the feed information array
    pub feed_infos: *const PackedFeedInfo,
    /// Number of feeds in the feed information array
    pub feed_count: usize,
    _phantom: core::marker::PhantomData<&'a ()>,
}

impl<'a> ParsedEd25519SignatureDataRef<'a> {
    /// Creates an empty ParsedEd25519SignatureDataRef with all null pointers
    #[inline(always)]
    pub fn default_empty() -> Self {
        unsafe { core::mem::zeroed() }
    }

    #[inline(always)]
    /// Returns true if the signature data has valid pointers
    pub fn is_valid(&self) -> bool {
        !self.pubkey.is_null()
    }

    #[inline(always)]
    /// Returns the ED25519 public key from the signature
    /// # Safety
    /// This function assumes the signature data is properly formatted and aligned
    pub unsafe fn pubkey(&self) -> &'a [u8; ED25519_PUBKEY_SERIALIZED_SIZE] {
        &*self.pubkey
    }

    #[inline(always)]
    /// Returns the ED25519 signature bytes
    /// # Safety
    /// This function assumes the signature data is properly formatted and aligned
    pub unsafe fn signature(&self) -> &'a [u8; ED25519_SIGNATURE_SERIALIZED_SIZE] {
        &*self.signature
    }

    #[inline(always)]
    /// Returns the message that was signed
    /// # Safety
    /// This function assumes the message data is properly formatted
    pub unsafe fn message(&self) -> &'a [u8] {
        core::slice::from_raw_parts(self.message, self.message_len)
    }

    #[inline(always)]
    /// Returns the oracle quote header from the message
    /// # Safety
    /// This function assumes the message contains a valid PackedQuoteHeader
    pub unsafe fn quote_header(&self) -> &'a PackedQuoteHeader {
        &*self.bundle_header
    }

    #[inline(always)]
    /// Returns the array of feed information from the oracle quote
    /// # Safety
    /// This function assumes the message contains valid PackedFeedInfo data
    pub unsafe fn feed_infos(&self) -> &'a [PackedFeedInfo] {
        core::slice::from_raw_parts(self.feed_infos, self.feed_count)
    }
}

/// Utility for parsing ED25519 signature verification sysvar data
pub struct Ed25519Sysvar;
impl Ed25519Sysvar {
    /// Ultra-efficient zero-copy ED25519 instruction parsing
    /// Supports variable length messages unlike secp256k1
    /// Returns (signatures, sig_count, oracle_idxs, recent_slot, version)
    #[inline(always)]
    pub fn parse_instruction(data: &[u8]) -> ParsedInstructionResult<'_> {
        let data_len = data.len(); // Update data_len to reflect actual ED25519 data length
                                   // Validate minimum size for header before unsafe cast
        if data_len < core::mem::size_of::<Ed25519SignatureHeader>() {
            bail!("Data too short for Ed25519SignatureHeader");
        }

        // Parse the header (num_signatures + padding byte)
        let header: &Ed25519SignatureHeader = unsafe { std::mem::transmute(&data[0]) };
        let num_signatures = header.num_signatures as usize;
        if num_signatures > 8 {
            bail!("Too many signatures - maximum 8 supported");
        }
        if num_signatures == 0 {
            bail!("No signatures found in instruction data");
        }

        // Extract recent_slot and version from the end of instruction data first
        // Check for underflow before subtraction
        if data_len < 13 + num_signatures {
            bail!(
                "Data too short for oracle indices and metadata: need {} bytes, got {}",
                13 + num_signatures,
                data_len
            );
        }
        // Discriminator length is 4, slot is 8, version is 1
        let end_of_message = data_len - num_signatures - 13;
        let suffix = &data[end_of_message..];
        let oracle_idxs: &[u8] = unsafe { suffix.get_unchecked(..num_signatures) };
        let suffix = unsafe { suffix.get_unchecked(num_signatures..) };
        let slot: u64 = unsafe {
            // Direct u64 read for 64-bit machines - data already little-endian
            core::ptr::read_unaligned(&suffix[0] as *const u8 as *const u64)
        };
        let version: u8 = unsafe { *suffix.get_unchecked(8) };

        let message_data = &data[..end_of_message];

        let message_data_ptr = message_data.as_ptr();

        // Use MaybeUninit to avoid unnecessary initialization
        let mut parsed_sigs_array =
            unsafe { core::mem::zeroed::<[ParsedEd25519SignatureDataRef; 8]>() };
        let parsed_sigs_ptr = parsed_sigs_array.as_mut_ptr();

        unsafe {
            let mut offset = 2usize; // Skip padding byte after count byte

            // Parse the first signature to get shared message structure
            let offset_ptr = message_data_ptr.add(offset);
            let first_offsets = *(offset_ptr as *const Ed25519SignatureOffsets);
            let first_message_offset = first_offsets.message_data_offset as usize;
            let first_message_size = first_offsets.message_data_size as usize;

            // Parse message structure once for all signatures
            let message = core::slice::from_raw_parts(
                message_data_ptr.add(first_message_offset),
                first_message_size,
            );

            if first_message_size < core::mem::size_of::<PackedQuoteHeader>() {
                bail!("Message too short for bundle header");
            }
            let shared_header: &PackedQuoteHeader = std::mem::transmute(&message[0]);

            const HEADER_SIZE: usize = core::mem::size_of::<PackedQuoteHeader>();
            const FEED_INFO_SIZE: usize = core::mem::size_of::<PackedFeedInfo>();
            let remaining_bytes = first_message_size - HEADER_SIZE;

            if remaining_bytes % FEED_INFO_SIZE != 0 {
                bail!("Invalid message size: remaining bytes not divisible by feed info size, got {}, with feed info size {}", remaining_bytes, FEED_INFO_SIZE);
            }

            let shared_feed_count = remaining_bytes / FEED_INFO_SIZE;
            if shared_feed_count > 8 {
                bail!(
                    "Too many feeds in message: {} feeds but maximum is 8",
                    shared_feed_count
                );
            }

            let shared_feed_infos = core::slice::from_raw_parts(
                message.as_ptr().add(HEADER_SIZE) as *const PackedFeedInfo,
                shared_feed_count,
            );

            // Process first signature (i=0) outside the loop
            let first_signature_offset = first_offsets.signature_offset as usize;
            let first_pubkey_offset = first_offsets.public_key_offset as usize;
            let first_message_instruction_index = first_offsets.message_instruction_index;

            let first_pubkey = &*(message_data_ptr.add(first_pubkey_offset)
                as *const [u8; ED25519_PUBKEY_SERIALIZED_SIZE]);
            let first_signature = &*(message_data_ptr.add(first_signature_offset)
                as *const [u8; ED25519_SIGNATURE_SERIALIZED_SIZE]);

            // Write first signature to array
            parsed_sigs_ptr.write(ParsedEd25519SignatureDataRef {
                offsets: first_offsets,
                pubkey: first_pubkey as *const _,
                signature: first_signature as *const _,
                message: message_data_ptr.add(first_message_offset),
                message_len: first_message_size,
                bundle_header: shared_header as *const _,
                feed_infos: shared_feed_infos.as_ptr(),
                feed_count: shared_feed_count,
                _phantom: core::marker::PhantomData,
            });

            offset += ED25519_SIGNATURE_OFFSETS_SERIALIZED_SIZE;

            // Process remaining signatures (i=1 to num_signatures-1)
            for i in 1..num_signatures {
                // Ultra-fast direct access - no endianness conversion needed
                let offset_ptr = message_data_ptr.add(offset);
                let offsets = *(offset_ptr as *const Ed25519SignatureOffsets);

                // Direct access without endianness conversion (assumes little-endian or native format)
                let signature_offset = offsets.signature_offset as usize;
                let pubkey_offset = offsets.public_key_offset as usize;
                let message_offset = offsets.message_data_offset as usize;
                let message_size = offsets.message_data_size as usize;

                // Verify all messages are identical
                if message_offset != first_message_offset || message_size != first_message_size {
                    bail!("Inconsistent message offsets or sizes");
                }

                // Validate that all instruction indexes match the first signature's message_instruction_index
                if offsets.signature_instruction_index != first_message_instruction_index {
                    bail!(
                        "Signature instruction index mismatch: expected {}, got {}",
                        first_message_instruction_index,
                        offsets.signature_instruction_index
                    );
                }
                if offsets.public_key_instruction_index != first_message_instruction_index {
                    bail!(
                        "Public key instruction index mismatch: expected {}, got {}",
                        first_message_instruction_index,
                        offsets.public_key_instruction_index
                    );
                }
                if offsets.message_instruction_index != first_message_instruction_index {
                    bail!(
                        "Message instruction index mismatch: expected {}, got {}",
                        first_message_instruction_index,
                        offsets.message_instruction_index
                    );
                }

                // Zero-copy references - no copying or allocation
                let pubkey = &*(message_data_ptr.add(pubkey_offset)
                    as *const [u8; ED25519_PUBKEY_SERIALIZED_SIZE]);
                let signature = &*(message_data_ptr.add(signature_offset)
                    as *const [u8; ED25519_SIGNATURE_SERIALIZED_SIZE]);

                // Write directly to final array position - no intermediate copy
                parsed_sigs_ptr.add(i).write(ParsedEd25519SignatureDataRef {
                    offsets,
                    pubkey: pubkey as *const _,
                    signature: signature as *const _,
                    message: message_data_ptr.add(message_offset),
                    message_len: message_size,
                    bundle_header: shared_header as *const _,
                    feed_infos: shared_feed_infos.as_ptr(),
                    feed_count: shared_feed_count,
                    _phantom: core::marker::PhantomData,
                });

                offset += ED25519_SIGNATURE_OFFSETS_SERIALIZED_SIZE;
            }

            // Array is now fully initialized, safe to assume_init
            Ok((
                parsed_sigs_array,
                num_signatures as u8,
                oracle_idxs,
                slot,
                version,
            ))
        }
    }
}
