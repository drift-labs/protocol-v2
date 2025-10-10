//! Oracle quote verification and data extraction functionality
//!
//! This module provides the core `OracleQuote` struct for working with verified oracle data quotes.
//! A quote contains aggregated feed data from multiple oracles, cryptographically verified
//! through ED25519 signatures and Solana's instruction sysvar.

use core::ptr::read_unaligned;

use anyhow::{Context, Error as AnyError};

use crate::solana_compat::sol_memcpy_;
// Use our AccountInfo type alias that conditionally uses pinocchio or anchor/solana-program
use crate::AccountInfo;
use crate::{borrow_mut_account_data, check_pubkey_eq, AsAccountInfo, Instructions, Pubkey};

#[allow(unused)]
const SLOTS_PER_EPOCH: u64 = 432_000;

/// Default discriminator for Switchboard Oracle data
pub const QUOTE_DISCRIMINATOR: [u8; 8] = *b"SBOracle";
/// QUOTE_DISCRIMINATOR as little-endian u64 for efficient comparison
pub const QUOTE_DISCRIMINATOR_U64_LE: u64 = u64::from_le_bytes(QUOTE_DISCRIMINATOR);

/// A verified oracle quote containing feed data from multiple oracles.
///
/// This struct provides zero-copy access to aggregated oracle feed data that has been
/// cryptographically verified through ED25519 signatures. The quote contains:
/// - Feed data with values and metadata
/// - Oracle signature information and indices
/// - Slot and version information for freshness validation
/// - Raw instruction data for serialization (when available)
///
/// All data is stored as references to avoid unnecessary copying, making this struct
/// highly efficient for on-chain programs where compute units are precious.
#[derive(Clone, Copy)]
pub struct OracleQuote<'a> {
    /// Reference to the quote header containing signed slot hash
    quote_header_refs: &'a crate::on_demand::oracle_quote::feed_info::PackedQuoteHeader,
    /// Number of oracle signatures that verified this quote
    pub oracle_count: u8,
    /// Zero-copy reference to the packed feed data from the first signature
    pub packed_feed_infos: &'a [crate::on_demand::oracle_quote::feed_info::PackedFeedInfo],
    /// Number of valid feeds in the quote (private, calculated during verification)
    feed_count: u8,
    /// Oracle indices that correspond to the queue's oracle array
    pub oracle_idxs: &'a [u8],
    /// Recent slot from the ED25519 instruction data used for freshness validation
    pub recent_slot: u64,
    /// Version from the ED25519 instruction data
    pub version: u8,
    /// Reference to the raw ED25519 instruction data for serialization
    pub raw_buffer: &'a [u8],
}

impl<'a> OracleQuote<'a> {
    /// Creates a new OracleQuote with header references and zero-copy feed data.
    ///
    /// This constructor is used internally after verification to create an OracleQuote
    /// instance with validated data. All parameters should be pre-verified.
    ///
    /// # Arguments
    /// * `quote_header_ref` - Reference to the verified quote header
    /// * `oracle_count` - Number of oracle signatures
    /// * `packed_feed_infos` - Slice of packed feed information
    /// * `feed_count` - Number of valid feeds
    /// * `oracle_idxs` - Oracle indices array
    /// * `recent_slot` - Recent slot from ED25519 instruction
    /// * `version` - Version from ED25519 instruction
    /// * `raw_buffer` - Reference to the raw ED25519 instruction data
    #[inline(always)]
    #[allow(clippy::too_many_arguments)]
    pub(crate) fn new(
        quote_header_ref: &'a crate::on_demand::oracle_quote::feed_info::PackedQuoteHeader,
        oracle_count: u8,
        packed_feed_infos: &'a [crate::on_demand::oracle_quote::feed_info::PackedFeedInfo],
        feed_count: u8,
        oracle_idxs: &'a [u8],
        recent_slot: u64,
        version: u8,
        raw_buffer: &'a [u8],
    ) -> Self {
        Self {
            quote_header_refs: quote_header_ref,
            oracle_count,
            packed_feed_infos,
            feed_count,
            oracle_idxs,
            recent_slot,
            version,
            raw_buffer,
        }
    }

    /// Returns the recent slot from the ED25519 instruction data.
    ///
    /// This slot value represents when the quote was created and is used
    /// for freshness validation against the slot hash sysvar.
    #[inline(always)]
    pub fn slot(&self) -> u64 {
        self.recent_slot
    }

    /// Returns the version from the ED25519 instruction data.
    ///
    /// The version indicates the quote format version used by the oracles.
    #[inline(always)]
    pub fn version(&self) -> u8 {
        self.version
    }

    /// Returns a reference to the raw ED25519 instruction data used to create this quote.
    ///
    /// This method provides access to the original verified instruction data that can be
    /// used for serialization, storage, or further processing. The data includes all
    /// signatures and quote information in its original binary format.
    ///
    /// # Returns
    /// * `Some(&[u8])` - Reference to the raw instruction data if available
    /// * `None` - Raw data not available (e.g., quote created from account data)
    ///
    /// # Example
    /// ```rust,ignore
    /// let quote = verifier.verify_instruction_at(0)?;
    ///
    /// if let Some(raw_data) = quote.raw_data() {
    ///     // Store or transmit the raw oracle data
    ///     store_oracle_quote(raw_data)?;
    /// }
    /// ```
    #[inline(always)]
    pub fn raw_data(&self) -> &[u8] {
        self.raw_buffer
    }

    /// Returns a slice of the valid packed feeds.
    ///
    /// This provides access to all verified feed data in the quote.
    /// Each feed contains a feed ID, value, and minimum oracle samples requirement.
    #[inline(always)]
    pub fn feeds(&self) -> &[crate::on_demand::oracle_quote::feed_info::PackedFeedInfo] {
        &self.packed_feed_infos[..self.feed_count as usize]
    }

    #[inline(always)]
    pub fn feed_ids(&self) -> Vec<&[u8]> {
        self.feeds()
            .iter()
            .map(|info| info.feed_id().as_slice())
            .collect()
    }

    /// Returns the number of valid feeds in this quote
    #[inline(always)]
    pub fn len(&self) -> usize {
        self.feed_count as usize
    }

    /// Returns true if this quote contains no feeds
    #[inline(always)]
    pub fn is_empty(&self) -> bool {
        self.feed_count == 0
    }

    /// Returns the oracle index for a specific signature position.
    ///
    /// # Arguments
    /// * `signature_index` - The position of the signature (0 to oracle_count-1)
    ///
    /// # Returns
    /// * `Ok(u8)` - The oracle index that corresponds to the queue's oracle array
    /// * `Err(AnyError)` - If signature_index is out of bounds
    ///
    /// # Example
    /// ```rust,ignore
    /// let oracle_idx = quote.oracle_index(0)?; // Get first oracle's index
    /// ```
    #[inline(always)]
    pub fn oracle_index(&self, signature_index: usize) -> Result<u8, AnyError> {
        if signature_index < self.oracle_count as usize {
            Ok(self.oracle_idxs[signature_index])
        } else {
            anyhow::bail!(
                "Invalid signature index {} for quote with {} oracles",
                signature_index,
                self.oracle_count
            )
        }
    }

    /// Returns a reference to the quote header.
    ///
    /// The header contains the signed slot hash that was verified against
    /// the slot hash sysvar during quote verification.
    #[inline(always)]
    pub fn header(&self) -> &'a crate::on_demand::oracle_quote::feed_info::PackedQuoteHeader {
        self.quote_header_refs
    }

    /// Finds a packed feed with a specific feed ID.
    ///
    /// # Arguments
    /// * `feed_id` - A 32-byte array representing the feed ID to look for
    ///
    /// # Returns
    /// * `Ok(&PackedFeedInfo)` - Reference to the feed info if found
    /// * `Err(AnyError)` - Error if the feed ID is not found in the quote
    ///
    /// # Example
    /// ```rust,ignore
    /// let feed_id = [0u8; 32]; // Your feed ID
    /// match quote.feed(&feed_id) {
    ///     Ok(feed_info) => println!("Feed value: {}", feed_info.value()),
    ///     Err(_) => println!("Feed not found in quote"),
    /// }
    /// ```
    #[inline(always)]
    pub fn feed(
        &self,
        feed_id: &[u8; 32],
    ) -> std::result::Result<&crate::on_demand::oracle_quote::feed_info::PackedFeedInfo, AnyError>
    {
        let info = self.packed_feed_infos[..self.feed_count as usize]
            .iter()
            .find(|info| info.feed_id() == feed_id)
            .context("Switchboard On-Demand FeedNotFound")?;
        Ok(info)
    }

    /// High-performance ED25519 instruction data copy with slot validation.
    ///
    /// This function performs an optimized copy of oracle quote data from ED25519 instruction data
    /// to a destination buffer with a length prefix. It implements slot-based ordering validation
    /// to prevent oracle quote replay attacks and ensures data freshness.
    ///
    /// # Data Format
    ///
    /// **Source format** (ED25519 instruction data):
    /// ```
    /// [message_data][oracle_signatures][recent_slot(8)][version(1)][SBOD(4)]
    /// ```
    /// - Slot is located at offset `data_len - 13` (13 = 8 + 1 + 4)
    ///
    /// **Destination format** (after this function):
    /// ```
    /// [length(2)][message_data][oracle_signatures][recent_slot(8)][version(1)][SBOD(4)]
    /// ```
    /// - Adds 2-byte length prefix to the instruction data
    ///
    /// # Arguments
    ///
    /// * `clock_slot` - Current slot for validation
    /// * `source` - ED25519 instruction data slice containing oracle quote
    /// * `dst` - Mutable destination buffer (will be prefixed with 2-byte length)
    ///
    /// # Safety
    ///
    /// This function performs unsafe memory operations for performance:
    /// - **ASSUMES** `source` contains valid ED25519 instruction data with slot at correct offset
    /// - **ASSUMES** `dst` buffer has sufficient capacity (source.len() + 2 bytes)
    /// - **REQUIRES** instruction data format: [...data][slot(8)][version(1)][SBOD(4)]
    ///
    /// # Validation
    ///
    /// Performs critical slot-based validations:
    /// - **Freshness**: new slot < clock.slot (prevents stale data)
    /// - **Progression**: new slot ≥ existing slot in destination (anti-replay protection)
    /// - **Capacity**: destination buffer can hold length prefix + data
    ///
    /// # Performance
    ///
    /// Optimized for maximum performance at approximately 79 compute units with validations.
    ///
    /// # Panics
    ///
    /// Panics if critical validations fail:
    /// - New slot >= clock slot (stale oracle data)
    /// - Slot regression detected (replay attack prevention)
    /// - Destination buffer too small for prefixed data
    #[inline(always)]
    pub fn store_delimited(clock_slot: u64, source: &[u8], dst: &mut [u8]) {
        // Validate slot progression before writing
        Self::validate_slot_progression(clock_slot, source, dst);

        // 79 Compute units with safety checks and sequencing
        unsafe {
            let dst_ptr = dst.as_mut_ptr();
            let data_len = source.len();

            // Write the new data
            assert!(data_len + 2 <= dst.len()); // ensure dst buffer is large enough
            *(dst_ptr as *mut u16) = data_len as u16;
            sol_memcpy_(dst_ptr.add(2), source.as_ptr(), data_len as u64);
        }
    }

    /// Stores oracle quote data with length delimiter but without slot validation.
    ///
    /// This method writes oracle data directly to a buffer without performing any
    /// slot progression or freshness validation. It simply trusts the slot number
    /// embedded in the source data.
    ///
    /// **USE WITH CAUTION**: This method bypasses all safety checks including:
    /// - Slot progression validation
    /// - Slot freshness checks
    /// - Slot hash verification
    ///
    /// # Arguments
    /// * `source` - Raw ED25519 instruction data to store
    /// * `dst` - Target buffer to write to (must have space for length + data)
    ///
    /// # Safety
    /// This method performs minimal validation and writes directly to memory.
    /// Only basic buffer size checks are performed.
    ///
    /// # Panics
    /// Panics if the destination buffer is too small for the data.
    #[inline(always)]
    pub fn store_delimited_unchecked(source: &[u8], dst: &mut [u8]) {
        // Skip slot validation - trust the data
        unsafe {
            let dst_ptr = dst.as_mut_ptr();
            let data_len = source.len();

            // Write the new data (minimal validation)
            assert!(data_len + 2 <= dst.len()); // ensure dst buffer is large enough
            *(dst_ptr as *mut u16) = data_len as u16;
            sol_memcpy_(dst_ptr.add(2), source.as_ptr(), data_len as u64);
        }
    }

    /// Validates slot progression before writing oracle data.
    ///
    /// Ensures that:
    /// - New slot >= existing slot in account (no regression)
    /// - New slot < current clock slot (no stale data)
    ///
    /// # Arguments
    /// * `clock_slot` - Current slot
    /// * `source` - New oracle data to write
    /// * `existing_data` - Current account data (may be empty)
    ///
    /// # Panics
    /// Panics if slot validation fails
    #[inline(always)]
    fn validate_slot_progression(clock_slot: u64, source: &[u8], existing_data: &[u8]) {
        let source_len = source.len();
        if source_len < 13 {
            panic!("Invalid source data length: {}", source_len);
        }

        unsafe {
            // Extract slot from new data (13 bytes from end: 8 slot + 1 version + 4 SBOD)
            let slot_offset = source_len - 13;
            let new_slot = read_unaligned(source.as_ptr().add(slot_offset) as *const u64);

            // Validate new slot is not stale
            assert!(
                new_slot < clock_slot,
                "SB oracle slot is stale new_slot: {}, clock.slot: {}",
                new_slot,
                clock_slot
            );

            // Check existing data for slot regression - always calculate from the back
            if existing_data.len() >= 13 {
                // Minimum data with slot
                let existing_slot_offset = existing_data.len() - 13;
                let existing_slot =
                    read_unaligned(existing_data.as_ptr().add(existing_slot_offset) as *const u64);
                assert!(
                    new_slot >= existing_slot,
                    "SB oracle slot regression new_slot: {}, existing_slot: {}",
                    new_slot,
                    existing_slot
                );
            }
        }
    }

    /// Writes ED25519 instruction data directly to an oracle account with discriminator.
    ///
    /// This convenience method writes oracle quote data to a target account with the
    /// Switchboard Oracle discriminator prefix. The account data format becomes:
    ///
    /// ```
    /// [discriminator(8)][queue(32)][length(2)][message_data][oracle_signatures][recent_slot(8)][version(1)][SBOD(4)]
    /// ```
    ///
    /// # Arguments
    ///
    /// * `clock_slot` - Current slot for validation and freshness checks
    /// * `source` - ED25519 instruction data containing oracle quote
    /// * `oracle_account` - Target oracle account to write the data to
    ///
    /// # Safety
    ///
    /// This function assumes:
    /// - Oracle account has sufficient space (at least discriminator + length + source data)
    /// - Minimum 23 bytes (8 discriminator + 2 length + 13 minimum data with slot)
    /// - Performs unsafe memory operations for maximum efficiency
    ///
    /// # Validation
    ///
    /// Performs comprehensive slot validation before writing:
    /// - **Freshness**: new slot < clock.slot (prevents stale data)
    /// - **Progression**: new slot ≥ existing slot in account (prevents replay attacks)
    ///
    /// # Panics
    ///
    /// Panics if the oracle account buffer is too small or slot validation fails.
    #[inline(always)]
    pub fn write(clock_slot: u64, source: &[u8], queue: &[u8; 32], oracle_account: &AccountInfo) {
        let mut dst_ref = borrow_mut_account_data!(oracle_account);
        let dst: &mut [u8] = &mut dst_ref;
        assert!(dst.len() >= 55); // discriminator(8) + queue(32) + u16 + minimum data (13 bytes)
        unsafe {
            let dst_ptr = dst.as_mut_ptr();
            *(dst_ptr as *mut u64) = QUOTE_DISCRIMINATOR_U64_LE;
            // Copy queue at offset 8 using 4 u64 writes
            let queue_ptr = queue.as_ptr() as *const u64;
            let dst_queue_ptr = dst_ptr.add(8) as *mut u64;
            *dst_queue_ptr = *queue_ptr;
            *dst_queue_ptr.add(1) = *queue_ptr.add(1);
            *dst_queue_ptr.add(2) = *queue_ptr.add(2);
            *dst_queue_ptr.add(3) = *queue_ptr.add(3);
        }
        Self::store_delimited(clock_slot, source, &mut dst[40..]);
    }

    /// Writes ED25519 instruction data directly to an oracle account without slot validation.
    ///
    /// This method writes oracle quote data to a target account with the Switchboard Oracle
    /// discriminator prefix but **bypasses all slot validation checks**. The account data
    /// format becomes:
    ///
    /// ```text
    /// [8 bytes discriminator][32 bytes queue][2 bytes length][N bytes ED25519 data]
    /// ```
    ///
    /// **USE WITH CAUTION**: This method does not validate:
    /// - Slot progression against existing data
    /// - Slot freshness against current clock
    /// - Slot hash existence in recent slot hashes
    ///
    /// # Arguments
    /// * `source` - Raw ED25519 instruction data to write
    /// * `oracle_account` - Target oracle account to write to
    ///
    /// # Safety
    /// This method performs minimal validation and writes directly to account memory.
    /// Ensure the source data is well-formed and from a trusted source.
    ///
    /// # Panics
    /// Panics if the oracle account buffer is too small for the data.
    #[inline(always)]
    pub fn write_unchecked(source: &[u8], queue: &[u8; 32], oracle_account: &AccountInfo) {
        let mut dst_ref = borrow_mut_account_data!(oracle_account);
        let dst: &mut [u8] = &mut dst_ref;
        assert!(dst.len() >= 55); // discriminator(8) + queue(32) + u16 + minimum data (13 bytes)
        unsafe {
            let dst_ptr = dst.as_mut_ptr();
            *(dst_ptr as *mut u64) = QUOTE_DISCRIMINATOR_U64_LE;
            // Copy queue at offset 8 using 4 u64 writes
            let queue_ptr = queue.as_ptr() as *const u64;
            let dst_queue_ptr = dst_ptr.add(8) as *mut u64;
            *dst_queue_ptr = *queue_ptr;
            *dst_queue_ptr.add(1) = *queue_ptr.add(1);
            *dst_queue_ptr.add(2) = *queue_ptr.add(2);
            *dst_queue_ptr.add(3) = *queue_ptr.add(3);
        }
        Self::store_delimited_unchecked(source, &mut dst[40..]);
    }

    /// Writes oracle quote data from an ED25519 instruction to an oracle account.
    ///
    /// This convenience method extracts ED25519 instruction data from the instructions sysvar
    /// and writes it to the target oracle account with proper validation and discriminator.
    ///
    /// # Arguments
    /// * `ix_sysvar` - Any type that implements `AsAccountInfo` (e.g., `Sysvar<Instructions>`, direct `AccountInfo` reference, pinocchio AccountInfo)
    /// * `oracle_account` - Any type that implements `AsAccountInfo` (e.g., `AccountLoader<SwitchboardQuote>`, direct `AccountInfo` reference, pinocchio AccountInfo)
    /// * `clock_slot` - Current slot value
    /// * `instruction_index` - Index of the ED25519 instruction to extract (typically 0)
    ///
    /// # Example with Anchor
    /// ```rust,ignore
    /// use anchor_lang::prelude::*;
    /// use switchboard_on_demand::OracleQuote;
    ///
    /// pub fn update_oracle(ctx: Context<UpdateCtx>) -> Result<()> {
    ///     let UpdateCtx { oracle, sysvars, .. } = ctx.accounts;
    ///     let clock_slot = switchboard_on_demand::clock::get_slot(&sysvars.clock);
    ///
    ///     // Works directly with Anchor wrapper types and clock slot
    ///     OracleQuote::write_from_ix(&sysvars.instructions, &oracle, clock_slot, 0);
    ///     Ok(())
    /// }
    /// ```
    ///
    /// # Validation
    /// Performs comprehensive validation:
    /// - **Program ID**: Ensures instruction is from ED25519 program
    /// - **Sysvar ID**: Validates instructions sysvar account
    /// - **Slot progression**: Prevents stale data and replay attacks
    ///
    /// # Panics
    /// Panics if instruction extraction fails, program ID validation fails, or slot validation fails.
    #[inline(always)]
    pub fn write_from_ix<'b, I, O>(
        ix_sysvar: I,
        oracle_account: O,
        queue: &[u8; 32],
        curr_slot: u64,
        instruction_index: usize,
    ) where
        I: AsAccountInfo<'b>,
        O: AsAccountInfo<'b>,
    {
        let ix_sysvar = ix_sysvar.as_account_info();
        let oracle_account = oracle_account.as_account_info();

        let data = Instructions::extract_ix_data(ix_sysvar, instruction_index);
        Self::write(curr_slot, data, queue, oracle_account);
    }

    /// Writes oracle quote data from an ED25519 instruction to an oracle account without slot validation.
    ///
    /// # ⚠️ WARNING ⚠️
    ///
    /// **This method bypasses critical security validations and should only be used in very specific scenarios.**
    ///
    /// ## Security Risks
    /// This method **DOES NOT VALIDATE**:
    /// - **Slot progression**: Allows slot regression attacks
    /// - **Slot freshness**: Accepts stale/outdated data
    /// - **Slot hash existence**: No verification against recent slot hashes
    /// - **Data integrity**: Minimal validation of instruction data
    ///
    /// ## Potential Attack Vectors
    /// - **Replay attacks**: Old data can be replayed without detection
    /// - **Time manipulation**: Attackers can use data from arbitrary past slots
    /// - **Stale data injection**: Outdated oracle data may be accepted as current
    ///
    /// ## Safe Usage Scenarios
    /// Only use this method when:
    /// - You're in a trusted environment and want to skip validation for performance
    /// - You're replaying historical data where slot hashes may not be available
    /// - You're testing with simulated data
    ///
    /// # Arguments
    /// * `ix_sysvar` - Any type that implements `AsAccountInfo` (e.g., `Sysvar<Instructions>`, direct `AccountInfo` reference, pinocchio AccountInfo)
    /// * `oracle_account` - Any type that implements `AsAccountInfo` (e.g., `AccountLoader<SwitchboardQuote>`, direct `AccountInfo` reference, pinocchio AccountInfo)
    /// * `instruction_index` - Index of the ED25519 instruction to extract (typically 0)
    ///
    /// # Example with Anchor
    /// ```rust,ignore
    /// use anchor_lang::prelude::*;
    /// use switchboard_on_demand::OracleQuote;
    ///
    /// pub fn update_oracle_unchecked(ctx: Context<UpdateCtx>) -> Result<()> {
    ///     let UpdateCtx { oracle, sysvars, .. } = ctx.accounts;
    ///
    ///     // Skip slot validation - trusts the slot in the instruction data
    ///     OracleQuote::write_from_ix_unchecked(&sysvars.instructions, &oracle, 0);
    ///     Ok(())
    /// }
    /// ```
    ///
    /// # Safety
    ///
    /// **EXTREME CAUTION REQUIRED**: This method:
    /// - Writes directly to account memory with minimal validation
    /// - Bypasses all temporal security checks
    /// - Can lead to critical security vulnerabilities if misused
    /// - Should never be used in production code without thorough security review
    ///
    /// **Requirements for safe usage**:
    /// - Instruction data must be from a completely trusted source
    /// - Data must be cryptographically verified externally
    /// - Must implement your own replay protection mechanisms
    /// - Thorough testing in isolated environments required
    ///
    /// # Panics
    /// Panics if instruction extraction fails or if the oracle account buffer is too small.
    ///
    /// # Security Recommendation
    /// **Strongly consider using [`write_from_ix`] instead**, which includes proper slot validation.
    ///
    /// [`write_from_ix`]: Self::write_from_ix
    #[inline(always)]
    #[allow(clippy::missing_safety_doc)] // Safety documentation is comprehensive above
    pub fn write_from_ix_unchecked<'b, I, O>(
        ix_sysvar: I,
        oracle_account: O,
        queue: &[u8; 32],
        instruction_index: usize,
    ) where
        I: AsAccountInfo<'b>,
        O: AsAccountInfo<'b>,
    {
        let ix_sysvar = ix_sysvar.as_account_info();
        let oracle_account = oracle_account.as_account_info();

        let data = Instructions::extract_ix_data_unchecked(ix_sysvar, instruction_index);
        Self::write_unchecked(data, queue, oracle_account);
    }

    /// Derives the canonical program-derived address (PDA) for this oracle quote.
    ///
    /// This function computes a deterministic address based on the feed IDs contained
    /// in this oracle quote. The canonical address can be used to store or reference
    /// data associated with this specific combination of feeds.
    ///
    /// # Arguments
    /// * `program_id` - The program ID to use for PDA derivation
    ///
    /// # Returns
    /// A tuple containing:
    /// * `Pubkey` - The derived program address
    /// * `Vec<&[u8; 32]>` - Vector of feed ID references used as seeds
    /// * `u8` - The bump seed found during PDA derivation
    ///
    /// # Example
    /// ```rust,ignore
    /// use crate::Pubkey;
    ///
    /// let quote = verifier.verify_instruction_at(0)?;
    /// let program_id = Pubkey::new_unique();
    /// let (address, seeds, bump) = quote.canonical_address(&program_id);
    ///
    /// // Use the derived address for account operations
    /// println!("Canonical address: {}", address);
    /// println!("Used {} feed IDs as seeds", seeds.len());
    /// ```
    ///
    /// # Implementation Details
    /// - Uses all feed IDs from `self.feeds()` as seeds for PDA derivation
    /// - Feed IDs are processed in the order they appear in the quote
    /// - The resulting address is deterministic for the same set of feeds and program ID
    #[inline(always)]
    pub fn find_canonical_address(
        &self,
        queue_key: &Pubkey,
        program_id: &Pubkey,
    ) -> (Pubkey, Vec<Vec<u8>>, u8) {
        // Stack-allocated array for up to 9 feeds + queue (common case)
        let mut seed_refs: [&[u8]; 10] = [&[]; 10];
        let mut len = 0;

        // Add queue key directly as reference (no allocation)
        seed_refs[len] = queue_key.as_ref();
        len += 1;

        // Add feed IDs directly as references (no allocation)
        for info in self.feeds() {
            if len >= 10 {
                break; // Safety: prevent array overflow
            }
            seed_refs[len] = info.feed_id();
            len += 1;
        }

        let address = Pubkey::find_program_address(&seed_refs[..len], program_id);

        // Only allocate Vec for return value compatibility (but we could optimize this API too)
        let mut seeds: Vec<Vec<u8>> = Vec::with_capacity(len);
        seeds.push(queue_key.to_bytes().to_vec());
        for feed_info in self.feeds() {
            seeds.push(feed_info.feed_id().to_vec());
        }

        (address.0, seeds, address.1)
    }

    /// Get the canonical oracle account public key for this quote's feeds.
    ///
    /// This is a convenience method that extracts feed IDs from the current quote
    /// and derives the canonical oracle account using the provided program ID.
    ///
    /// # Arguments
    /// * `queue_key` - The queue public key to use as the first seed
    /// * `program_id` - The program ID that owns the oracle account (usually the quote program)
    ///
    /// # Returns
    /// The canonical oracle account public key for this quote's feeds
    ///
    /// # Example
    /// ```rust,ignore
    /// let canonical_key = quote.canonical_key(&queue_key, &quote_program_id);
    /// ```
    #[inline(always)]
    pub fn canonical_key(&self, queue_key: &Pubkey, program_id: &Pubkey) -> Pubkey {
        let (canonical_key, _, _) = self.find_canonical_address(queue_key, program_id);
        canonical_key
    }

    #[inline(always)]
    #[cfg(target_os = "solana")]
    pub fn create_canonical_address(
        &self,
        queue_key: &Pubkey,
        program_id: &Pubkey,
        bump: &[u8],
    ) -> Pubkey {
        use crate::solana_program::syscalls;
        let mut seeds: [&[u8]; 10] = [&[]; 10];
        let mut len: usize = 0;

        seeds[len] = queue_key.as_ref();
        len += 1;

        for info in self.feeds() {
            seeds[len] = info.feed_id().as_ref();
            len += 1;
        }

        seeds[len] = bump;
        len += 1;

        let mut bytes = [0; 32];
        unsafe {
            let res = syscalls::sol_create_program_address(
                &seeds as *const _ as *const u8,
                len as u64,
                program_id as *const _ as *const u8,
                &mut bytes as *mut _ as *mut u8,
            );
            assert!(res == 0, "Failed to create program address");
        };

        Pubkey::new_from_array(bytes)
    }

    /// Compares the keys of this oracle quote with another oracle quote to ensure they match.
    ///
    /// This method validates that both oracle quotes have:
    /// - The same number of feeds and feed IDs in the exact same order
    /// - The same number of oracles and oracle indices in the exact same order
    ///
    /// This is useful for ensuring that two oracle quotes are comparable and represent
    /// data from the same feeds and oracle set in the same order.
    ///
    /// # Arguments
    /// * `other` - Another oracle quote to compare against
    ///
    /// # Returns
    /// * `true` - If both quotes have matching feed IDs and oracle indices in the same order
    /// * `false` - If there are differences in counts, feed IDs, or oracle indices
    ///
    /// # Example
    /// ```rust,ignore
    /// let quote1 = verifier.verify_instruction_at(0)?;
    /// let quote2 = verifier.verify_instruction_at(1)?;
    ///
    /// if quote1.keys_match(&quote2) {
    ///     println!("Quotes have matching keys - safe to compare");
    /// } else {
    ///     println!("Quotes have different keys - comparison may not be meaningful");
    /// }
    /// ```
    #[inline(always)]
    pub fn keys_match(&self, other: &OracleQuote) -> bool {
        // Compare counts first for early exit
        if self.feed_count != other.feed_count {
            return false;
        }

        // Compare feed IDs in order (avoiding method calls)
        let feed_count = self.feed_count as usize;
        for i in 0..feed_count {
            if !check_pubkey_eq(
                self.packed_feed_infos[i].feed_id(),
                other.packed_feed_infos[i].feed_id(),
            ) {
                return false;
            }
        }

        true
    }
}
