//! Oracle quote verification for creating and verifying oracle data quotes
//!
//! This module provides the `QuoteVerifier` which allows you to construct
//! a verifier with specific accounts and parameters, then use it to verify ED25519
//! instruction data and create validated `OracleQuote` instances.
//!
//! The verification process checks:
//! - ED25519 signature validity
//! - Oracle signing key authorization
//! - Slot hash verification against the sysvar
//! - Quote age validation against max_age parameter (requires clock sysvar)
//! - Oracle quote data integrity
//!
//! For debugging or analysis purposes, the verifier also provides `parse_unverified` methods
//! that extract quote structure without performing security validations.

use core::ptr::read_unaligned;

use anyhow::{bail, Error as AnyError};
// Conditional import for non-pinocchio builds
#[cfg(not(feature = "pinocchio"))]
use solana_program::sysvar::instructions::get_instruction_relative;

use crate::prelude::*;
// Use our AccountInfo type alias that conditionally uses pinocchio or anchor/solana-program
use crate::AccountInfo;
use crate::{
    borrow_account_data, check_p64_eq, check_pubkey_eq, get_account_key, solana_program,
    AsAccountInfo,
};
#[allow(unused_imports)]
use crate::{ON_DEMAND_DEVNET_PID, ON_DEMAND_MAINNET_PID};

/// Maximum number of slots stored in the slot hash sysvar
const SYSVAR_SLOT_LEN: u64 = 512;

/// Oracle quote verifier with builder pattern for configuring and performing verification.
///
/// This verifier allows you to configure the required accounts step by step before
/// using it to verify oracle quotes. All required accounts must be set before
/// verification can be performed.
///
/// The verifier accepts any type that implements `AsAccountInfo`, making it compatible
/// with Anchor wrapper types like `AccountLoader`, `Sysvar`, etc., as well as pinocchio AccountInfo.
///
/// # Example with Anchor Context
/// ```rust,ignore
/// use anchor_lang::prelude::*;
/// use switchboard_on_demand::QuoteVerifier;
///
/// pub fn verify(ctx: Context<VerifyCtx>) -> Result<()> {
///     let VerifyCtx { queue, oracle, sysvars, .. } = ctx.accounts;
///     let clock_slot = switchboard_on_demand::clock::get_slot(&sysvars.clock);
///
///     let quote = QuoteVerifier::new()
///         .queue(&queue)
///         .slothash_sysvar(&sysvars.slothashes)
///         .ix_sysvar(&sysvars.instructions)
///         .clock_slot(clock_slot)
///         .verify_account(&oracle)
///         .unwrap();
///
///     // Use the verified quote data
///     for feed in quote.feeds() {
///         msg!("Feed {}: {}", feed.hex_id(), feed.value());
///     }
///     Ok(())
/// }
/// ```
#[derive(Clone)]
#[cfg(feature = "pinocchio")]
pub struct QuoteVerifier<'a> {
    queue: Option<&'a AccountInfo>,
    slothash_sysvar: Option<&'a AccountInfo>,
    ix_sysvar: Option<&'a AccountInfo>,
    clock_slot: Option<u64>,
    max_age: u64,
}

#[derive(Clone)]
#[cfg(not(feature = "pinocchio"))]
pub struct QuoteVerifier<'a> {
    queue: Option<AccountInfo<'a>>,
    slothash_sysvar: Option<AccountInfo<'a>>,
    ix_sysvar: Option<AccountInfo<'a>>,
    clock_slot: Option<u64>,
    max_age: u64,
}

#[cfg(feature = "pinocchio")]
impl<'a> Default for QuoteVerifier<'a> {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(not(feature = "pinocchio"))]
impl<'a> Default for QuoteVerifier<'a> {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(feature = "pinocchio")]
impl<'a> QuoteVerifier<'a> {
    /// Creates a new `QuoteVerifier` with default values.
    #[inline(always)]
    pub fn new() -> Self {
        Self {
            queue: None,
            slothash_sysvar: None,
            ix_sysvar: None,
            clock_slot: None,
            max_age: 30,
        }
    }

    /// Sets the oracle queue account for verification.
    ///
    /// The queue account contains the authorized oracle signing keys that will
    /// be used to validate the signatures in the oracle quote.
    ///
    /// # Arguments
    /// * `account` - Any type that implements `AsAccountInfo` (e.g., `AccountLoader`, direct `AccountInfo` reference, pinocchio AccountInfo)
    ///
    /// # Example
    /// ```rust,ignore
    /// verifier.queue(&ctx.accounts.queue);  // Works with Anchor AccountLoader
    /// verifier.queue(&account_info);        // Works with AccountInfo reference
    /// verifier.queue(&pinocchio_account);   // Works with pinocchio AccountInfo
    /// ```
    #[inline(always)]
    pub fn queue(&mut self, account: &'a AccountInfo) -> &mut Self {
        self.queue = Some(account);
        self
    }

    /// Sets the slot hash sysvar account for verification.
    ///
    /// The slot hash sysvar is used to validate that the signed slot hash
    /// in the oracle quote corresponds to a valid historical slot.
    ///
    /// # Arguments
    /// * `sysvar` - Any type that implements `AsAccountInfo` (e.g., `Sysvar<SlotHashes>`, direct `AccountInfo` reference, pinocchio AccountInfo)
    ///
    /// # Example
    /// ```rust,ignore
    /// verifier.slothash_sysvar(&ctx.accounts.slothashes);  // Works with Anchor Sysvar
    /// verifier.slothash_sysvar(&slothash_account);         // Works with AccountInfo reference
    /// verifier.slothash_sysvar(&pinocchio_account);        // Works with pinocchio AccountInfo
    /// ```
    #[inline(always)]
    pub fn slothash_sysvar(&mut self, sysvar: &'a AccountInfo) -> &mut Self {
        self.slothash_sysvar = Some(sysvar);
        self
    }

    /// Sets the instructions sysvar account for verification.
    ///
    /// The instructions sysvar contains the ED25519 instruction data that
    /// will be parsed to extract the oracle signatures and quote data.
    ///
    /// # Arguments
    /// * `sysvar` - Any type that implements `AsAccountInfo` (e.g., `Sysvar<Instructions>`, direct `AccountInfo` reference, pinocchio AccountInfo)
    ///
    /// # Example
    /// ```rust,ignore
    /// verifier.ix_sysvar(&ctx.accounts.instructions);  // Works with Anchor Sysvar
    /// verifier.ix_sysvar(&ix_account);                 // Works with AccountInfo reference
    /// verifier.ix_sysvar(&pinocchio_account);          // Works with pinocchio AccountInfo
    /// ```
    #[inline(always)]
    pub fn ix_sysvar(&mut self, sysvar: &'a AccountInfo) -> &mut Self {
        self.ix_sysvar = Some(sysvar);
        self
    }

    /// Sets the clock slot for freshness validation.
    #[inline(always)]
    pub fn clock_slot(&mut self, clock_slot: u64) -> &mut Self {
        self.clock_slot = Some(clock_slot);
        self
    }

    /// Sets the maximum age in slots for oracle quote freshness validation.
    ///
    /// Oracle quotes older than this many slots will be rejected during verification.
    /// This helps prevent replay attacks and ensures data freshness.
    ///
    /// # Arguments
    /// * `max_age` - Maximum age in slots (typically 100-500 slots)
    #[inline(always)]
    pub fn max_age(&mut self, max_age: u64) -> &mut Self {
        self.max_age = max_age;
        self
    }

    /// Verifies an oracle account containing oracle quote data.
    ///
    /// This method extracts the oracle quote data from an oracle account (skipping the
    /// 8-byte discriminator) and verifies it using the configured accounts.
    ///
    /// # Arguments
    /// * `oracle_account` - Any type that implements `AsAccountInfo` containing the oracle quote data
    ///   (e.g., `AccountLoader<SwitchboardQuote>`, direct `AccountInfo` reference, pinocchio AccountInfo)
    ///
    /// # Returns
    /// * `Ok(OracleQuote)` - Successfully verified oracle quote with feed data
    /// * `Err(AnyError)` - Verification failed (invalid signatures, expired data, etc.)
    ///
    /// # Example
    /// ```rust,ignore
    /// let quote = verifier.verify_account(&ctx.accounts.oracle)?;
    /// for feed in quote.feeds() {
    ///     println!("Feed {}: ${}", feed.hex_id(), feed.value());
    /// }
    /// ```
    #[cfg(feature = "pinocchio")]
    #[inline(always)]
    pub fn verify_account<'data, T>(
        &self,
        oracle_account: &'data T,
    ) -> Result<OracleQuote<'data>, AnyError>
    where
        T: AsAccountInfo<'data>,
    {
        let account_info = oracle_account.as_account_info();

        let oracle_data = unsafe { account_info.borrow_data_unchecked() };

        if oracle_data.len() < 40 {
            bail!(
                "Oracle account too small: {} bytes, expected at least 40",
                oracle_data.len()
            );
        }

        unsafe {
            if read_unaligned(oracle_data.as_ptr() as *const u64) != QUOTE_DISCRIMINATOR_U64_LE {
                bail!("Invalid oracle account discriminator");
            }
        }

        self.verify_delimited(&oracle_data[40..])
    }

    #[cfg(not(feature = "pinocchio"))]
    #[inline(always)]
    pub fn verify_account<'data, T>(
        &self,
        oracle_account: &'data T,
    ) -> Result<OracleQuote<'data>, AnyError>
    where
        T: AsAccountInfo<'data>,
    {
        let account_info = oracle_account.as_account_info();

        let oracle_data = unsafe { &*account_info.data.as_ptr() };

        if oracle_data.len() < 40 {
            bail!(
                "Oracle account too small: {} bytes, expected at least 40",
                oracle_data.len()
            );
        }

        unsafe {
            if read_unaligned(oracle_data.as_ptr() as *const u64) != QUOTE_DISCRIMINATOR_U64_LE {
                bail!("Invalid oracle account discriminator");
            }
        }

        self.verify_delimited(&oracle_data[40..])
    }

    /// Verifies raw ED25519 instruction data and creates a validated OracleQuote.
    ///
    /// This is the core verification method that performs all security checks:
    /// - Parses ED25519 signatures and extracts oracle indices
    /// - Validates oracle signing keys against the queue
    /// - Verifies slot hash against the sysvar
    /// - Validates quote age against max_age (requires clock sysvar)
    /// - Ensures oracle quote data integrity
    ///
    /// # Arguments
    /// * `data` - Raw ED25519 instruction data containing signatures and quote
    ///
    /// # Returns
    /// * `Ok(OracleQuote)` - Successfully verified and parsed oracle quote
    /// * `Err(AnyError)` - Verification failed with detailed error message
    ///
    /// # Errors
    /// - Clock slot not set
    /// - No signatures provided
    /// - Invalid oracle signing keys
    /// - Slot hash mismatch
    /// - Quote is too old (exceeds max_age slots)
    /// - Malformed instruction data
    #[inline(always)]
    pub fn verify_delimited<'data>(
        &self,
        data: &'data [u8],
    ) -> Result<OracleQuote<'data>, AnyError> {
        // # Safety
        //
        // This unsafe block is safe because:
        // - We verify `data` has at least 2 bytes before reading the length
        // - `read_unaligned` safely reads u16 from potentially unaligned memory
        // - The bounds check ensures we don't read beyond the data buffer
        // - Data slice is guaranteed valid for the function duration
        if data.len() < 2 {
            bail!("Data too small for length prefix: {} bytes", data.len());
        }
        unsafe {
            let len = read_unaligned(data.as_ptr() as *const u16) as usize;
            if data.len() < len + 2 {
                bail!(
                    "Data length mismatch: expected {}, got {}",
                    len + 2,
                    data.len()
                );
            }
            self.verify(&data[2..len + 2])
        }
    }

    /// Parses oracle quote data without performing any verification checks.
    ///
    /// This method extracts the quote structure from ED25519 instruction data
    /// but skips all security validations including:
    /// - Clock/age validation
    /// - Signature verification
    /// - Oracle key authorization
    /// - Slot hash verification
    ///
    /// **WARNING**: This method should only be used for debugging, analysis, or
    /// scenarios where verification is handled separately. Never use unverified
    /// quotes for production decisions.
    ///
    /// # Arguments
    /// * `data` - Raw ED25519 instruction data containing signatures and quote
    ///
    /// # Returns
    /// * `Ok(OracleQuote)` - Successfully parsed oracle quote (unverified)
    /// * `Err(AnyError)` - Failed to parse the quote data structure
    ///
    /// # Example
    /// ```rust,ignore
    /// // Parse quote without verification (use cautiously)
    /// let unverified_quote = verifier.parse_unverified(&instruction_data)?;
    /// println!("Quote contains {} feeds", unverified_quote.feeds().len());
    /// ```
    #[inline(always)]
    pub fn parse_unverified<'data>(
        &self,
        data: &'data [u8],
    ) -> Result<OracleQuote<'data>, AnyError> {
        let (parsed_sigs, sig_count, oracle_idxs, recent_slot, version) =
            Ed25519Sysvar::parse_instruction(data)?;

        if sig_count == 0 {
            bail!("No signatures provided");
        }

        let reference_sig = &parsed_sigs[0];
        let reference_feed_infos = unsafe { reference_sig.feed_infos() };
        let feed_count = reference_feed_infos.len();

        Ok(OracleQuote::new(
            unsafe { reference_sig.quote_header() },
            sig_count,
            reference_feed_infos,
            feed_count as u8,
            oracle_idxs,
            recent_slot,
            version,
            data,
        ))
    }

    /// Parses oracle quote data from an account without performing verification checks.
    ///
    /// This is a convenience method that extracts quote data from a Switchboard
    /// oracle account and parses it without any security validations.
    ///
    /// **WARNING**: This method should only be used for debugging, analysis, or
    /// scenarios where verification is handled separately. Never use unverified
    /// quotes for production decisions.
    ///
    /// # Arguments
    /// * `oracle_account` - Oracle account containing quote data
    ///
    /// # Returns
    /// * `Ok(OracleQuote)` - Successfully parsed oracle quote (unverified)
    /// * `Err(AnyError)` - Failed to parse the account or quote data
    ///
    /// # Example
    /// ```rust,ignore
    /// // Parse account quote without verification (use cautiously)
    /// let unverified_quote = verifier.parse_account_unverified(&oracle_account)?;
    /// ```
    #[cfg(feature = "pinocchio")]
    #[inline(always)]
    pub fn parse_account_unverified<'data, T>(
        &self,
        oracle_account: &'data T,
    ) -> Result<OracleQuote<'data>, AnyError>
    where
        T: AsAccountInfo<'data>,
    {
        let account_info = oracle_account.as_account_info();

        let oracle_data = unsafe { account_info.borrow_data_unchecked() };

        if oracle_data.len() < 40 {
            bail!(
                "Oracle account too small: {} bytes, expected at least 40",
                oracle_data.len()
            );
        }

        self.parse_unverified_delimited(&oracle_data[40..])
    }

    #[cfg(not(feature = "pinocchio"))]
    #[inline(always)]
    pub fn parse_account_unverified<'data, T>(
        &self,
        oracle_account: &'data T,
    ) -> Result<OracleQuote<'data>, AnyError>
    where
        T: AsAccountInfo<'data>,
    {
        let account_info = oracle_account.as_account_info();

        let oracle_data = unsafe { &*account_info.data.as_ptr() };

        if oracle_data.len() < 40 {
            bail!(
                "Oracle account too small: {} bytes, expected at least 40",
                oracle_data.len()
            );
        }

        self.parse_unverified_delimited(&oracle_data[40..])
    }

    /// Parses length-delimited oracle quote data without verification checks.
    ///
    /// This method handles the length prefix parsing and delegates to `parse_unverified`.
    ///
    /// # Arguments
    /// * `data` - Length-delimited ED25519 instruction data
    ///
    /// # Returns
    /// * `Ok(OracleQuote)` - Successfully parsed oracle quote (unverified)
    /// * `Err(AnyError)` - Failed to parse the data
    #[inline(always)]
    pub fn parse_unverified_delimited<'data>(
        &self,
        data: &'data [u8],
    ) -> Result<OracleQuote<'data>, AnyError> {
        if data.len() < 2 {
            bail!("Data too small for length prefix: {} bytes", data.len());
        }
        unsafe {
            let len = read_unaligned(data.as_ptr() as *const u16) as usize;
            if data.len() < len + 2 {
                bail!(
                    "Data length mismatch: expected {}, got {}",
                    len + 2,
                    data.len()
                );
            }
            self.parse_unverified(&data[2..len + 2])
        }
    }

    /// Verifies oracle quote data and returns a validated OracleQuote
    pub fn verify<'data>(&self, data: &'data [u8]) -> Result<OracleQuote<'data>, AnyError> {
        let (parsed_sigs, sig_count, oracle_idxs, recent_slot, version) =
            Ed25519Sysvar::parse_instruction(data)?;
        let queue = self
            .queue
            .as_ref()
            .ok_or_else(|| anyhow::anyhow!("Queue account not set"))?;
        let slothash_sysvar = self
            .slothash_sysvar
            .as_ref()
            .ok_or_else(|| anyhow::anyhow!("Slothash sysvar not set"))?;

        // Validate quote freshness - clock slot is required for all verifications
        let clock_slot = self
            .clock_slot
            .ok_or_else(|| anyhow::anyhow!("Clock slot not set"))?;
        if clock_slot < recent_slot || clock_slot - recent_slot > self.max_age {
            bail!(
                "Quote is too old: recent_slot={}, current_slot={}, max_age={}",
                recent_slot,
                clock_slot,
                self.max_age
            );
        }

        if sig_count == 0 {
            bail!("No signatures provided");
        }

        // Get queue data for oracle signing keys
        // Safely access queue data using RefCell borrow and try_from_bytes
        let queue_buf = unsafe { borrow_account_data!(queue) };
        if queue_buf.len() != 6280 {
            bail!("Queue account too small: {} bytes", queue_buf.len());
        }
        let queue_data: &QueueAccountData =
            unsafe { &*(queue_buf.as_ptr().add(8) as *const QueueAccountData) };

        // Find the target slothash from the oracle quote
        let reference_sig = &parsed_sigs[0];
        let header = unsafe { reference_sig.quote_header() };

        // Find the target slothash from oracle quote and get corresponding hash from sysvar
        let target_slothash = &header.signed_slothash as *const _ as *const u64;
        let found_slothash =
            &Self::find_slothash_in_sysvar(recent_slot, slothash_sysvar)? as *const _ as *const u64;

        assert!(unsafe { check_p64_eq(found_slothash, target_slothash) });

        // Oracle signing key validation (32 bytes per oracle: actual should match expected)
        for i in 0..sig_count {
            // Branchless bounds check,  30 is max oracles in queue
            let oracle_idx = (oracle_idxs[i as usize] as usize) % 30;
            let expected_oracle_key = queue_data.ed25519_oracle_signing_keys[oracle_idx];
            let actual_oracle_key = unsafe { parsed_sigs[i as usize].pubkey() };
            assert!(unsafe {
                check_p64_eq(
                    actual_oracle_key as *const _ as *const u64,
                    &expected_oracle_key as *const _ as *const u64,
                )
            });
        }

        // Continue with remaining processing...
        let reference_feed_infos = unsafe { reference_sig.feed_infos() };
        let feed_count = reference_feed_infos.len();

        Ok(OracleQuote::new(
            unsafe { reference_sig.quote_header() },
            sig_count,
            reference_feed_infos,
            feed_count as u8,
            oracle_idxs,
            recent_slot,
            version,
            data,
        ))
    }

    /// Loads and verifies an ED25519 instruction from the instructions sysvar with age validation.
    ///
    /// This method extracts instruction data from the instructions sysvar at the specified
    /// index, validates that it comes from the ED25519 program, checks the quote age against
    /// the current slot using the configured max_age, and then verifies the oracle quote data.
    ///
    /// # Arguments
    /// * `instruction_idx` - Index of the instruction to load from the sysvar (typically 0 for first instruction)
    ///
    /// # Returns
    /// * `Ok(OracleQuote)` - Successfully loaded and verified oracle quote
    /// * `Err(AnyError)` - Failed to load or verify the instruction
    ///
    /// # Errors
    /// - Instruction not found at the specified index
    /// - Instruction is not from the ED25519 program
    /// - Quote is too old (exceeds max_age slots)
    /// - Verification of the quote data fails
    #[inline(always)]
    pub fn verify_instruction_at(&self, instruction_idx: i64) -> Result<OracleQuote<'_>, AnyError> {
        use crate::Instructions;

        let ix_sysvar = self
            .ix_sysvar
            .as_ref()
            .ok_or_else(|| anyhow::anyhow!("Instructions sysvar not set"))?;

        // Extract instruction data and validate program ID using the existing helper
        let data = {
            #[cfg(feature = "pinocchio")]
            {
                Instructions::extract_ix_data(*ix_sysvar, instruction_idx as usize)
            }
            #[cfg(not(feature = "pinocchio"))]
            {
                Instructions::extract_ix_data(ix_sysvar, instruction_idx as usize)
            }
        };

        // Verify the instruction data
        self.verify(data)
    }

    /// Finds and returns a specific slot hash from the slot hash sysvar.
    ///
    /// This function searches through the slot hash sysvar to find the hash
    /// corresponding to the target slot. It uses an optimized search starting
    /// from an estimated position and working backwards.
    ///
    /// # Arguments
    /// * `target_slot` - The slot number to find the hash for
    /// * `slothash_sysvar` - Reference to the slot hash sysvar account
    ///
    /// # Returns
    /// * `Ok([u8; 32])` - The 32-byte hash for the target slot
    /// * `Err(AnyError)` - Slot not found in the sysvar
    ///
    /// # Performance
    /// Uses an estimated starting position based on slot ordering to minimize
    /// the number of entries that need to be checked.
    fn find_slothash_in_sysvar(
        target_slot: u64,
        slothash_sysvar: &AccountInfo,
    ) -> Result<[u8; 32], AnyError> {
        assert!(check_pubkey_eq(
            *get_account_key!(slothash_sysvar),
            solana_program::sysvar::slot_hashes::ID
        ));
        let slothash_data = unsafe { borrow_account_data!(slothash_sysvar) };

        // # Safety
        //
        // This transmute is safe because:
        // - SlotHash is a POD type with known layout (u64 + [u8; 32])
        // - We skip the 8-byte sysvar header before transmuting
        // - The Solana runtime guarantees proper alignment and initialization of sysvar data
        // - The slice length is determined by the actual data size
        let slot_data: &[SlotHash] = unsafe { std::mem::transmute(&slothash_data[8..]) };

        let mut estimated_idx = ((slot_data[0].slot - target_slot) % SYSVAR_SLOT_LEN) as usize;

        // Optimized search with early termination
        loop {
            let slot_entry = &slot_data[estimated_idx];
            if slot_entry.slot == target_slot {
                return Ok(slot_entry.hash);
            }
            if estimated_idx == 0 {
                break;
            }
            estimated_idx -= 1;
        }
        bail!("Slot not found in slothash sysvar");
    }
}

#[cfg(not(feature = "pinocchio"))]
impl<'a> QuoteVerifier<'a> {
    /// Creates a new `QuoteVerifier` with default values.
    #[inline(always)]
    pub fn new() -> Self {
        Self {
            queue: None,
            slothash_sysvar: None,
            ix_sysvar: None,
            clock_slot: None,
            max_age: 30,
        }
    }

    /// Sets the oracle queue account for verification.
    ///
    /// The queue account contains the authorized oracle signing keys that will
    /// be used to validate the signatures in the oracle quote.
    ///
    /// # Arguments
    /// * `account` - Any type that implements `AsAccountInfo` (e.g., `AccountLoader`, direct `AccountInfo` reference, pinocchio AccountInfo)
    ///
    /// # Example
    /// ```rust,ignore
    /// verifier.queue(&ctx.accounts.queue);  // Works with Anchor AccountLoader
    /// verifier.queue(&account_info);        // Works with AccountInfo reference
    /// verifier.queue(&pinocchio_account);   // Works with pinocchio AccountInfo
    /// ```
    #[inline(always)]
    pub fn queue<T>(&mut self, account: T) -> &mut Self
    where
        T: AsAccountInfo<'a>,
    {
        self.queue = Some(account.as_account_info().clone());
        self
    }

    /// Sets the slot hash sysvar account for verification.
    ///
    /// The slot hash sysvar is used to validate that the signed slot hash
    /// in the oracle quote corresponds to a valid historical slot.
    ///
    /// # Arguments
    /// * `sysvar` - Any type that implements `AsAccountInfo` (e.g., `Sysvar<SlotHashes>`, direct `AccountInfo` reference, pinocchio AccountInfo)
    ///
    /// # Example
    /// ```rust,ignore
    /// verifier.slothash_sysvar(&ctx.accounts.slothashes);  // Works with Anchor Sysvar
    /// verifier.slothash_sysvar(&slothash_account);         // Works with AccountInfo reference
    /// verifier.slothash_sysvar(&pinocchio_account);        // Works with pinocchio AccountInfo
    /// ```
    #[inline(always)]
    pub fn slothash_sysvar<T>(&mut self, sysvar: T) -> &mut Self
    where
        T: AsAccountInfo<'a>,
    {
        self.slothash_sysvar = Some(sysvar.as_account_info().clone());
        self
    }

    /// Sets the instructions sysvar account for verification.
    ///
    /// The instructions sysvar contains the ED25519 instruction data that
    /// will be parsed to extract the oracle signatures and quote data.
    ///
    /// # Arguments
    /// * `sysvar` - Any type that implements `AsAccountInfo` (e.g., `Sysvar<Instructions>`, direct `AccountInfo` reference, pinocchio AccountInfo)
    ///
    /// # Example
    /// ```rust,ignore
    /// verifier.ix_sysvar(&ctx.accounts.instructions);  // Works with Anchor Sysvar
    /// verifier.ix_sysvar(&ix_account);                 // Works with AccountInfo reference
    /// verifier.ix_sysvar(&pinocchio_account);          // Works with pinocchio AccountInfo
    /// ```
    #[inline(always)]
    pub fn ix_sysvar<T>(&mut self, sysvar: T) -> &mut Self
    where
        T: AsAccountInfo<'a>,
    {
        self.ix_sysvar = Some(sysvar.as_account_info().clone());
        self
    }

    /// Sets the clock slot for freshness validation.
    #[inline(always)]
    pub fn clock_slot(&mut self, clock_slot: u64) -> &mut Self {
        self.clock_slot = Some(clock_slot);
        self
    }

    /// Sets the maximum age in slots for oracle quote freshness validation.
    ///
    /// Oracle quotes older than this many slots will be rejected during verification.
    /// This helps prevent replay attacks and ensures data freshness.
    ///
    /// # Arguments
    /// * `max_age` - Maximum age in slots (typically 100-500 slots)
    #[inline(always)]
    pub fn max_age(&mut self, max_age: u64) -> &mut Self {
        self.max_age = max_age;
        self
    }

    /// Verifies an oracle account containing oracle quote data.
    ///
    /// This method extracts the oracle quote data from an oracle account (skipping the
    /// 8-byte discriminator) and verifies it using the configured accounts.
    ///
    /// # Arguments
    /// * `oracle_account` - Any type that implements `AsAccountInfo` containing the oracle quote data
    ///   (e.g., `AccountLoader<SwitchboardQuote>`, direct `AccountInfo` reference, pinocchio AccountInfo)
    ///
    /// # Returns
    /// * `Ok(OracleQuote)` - Successfully verified oracle quote with feed data
    /// * `Err(AnyError)` - Verification failed (invalid signatures, expired data, etc.)
    ///
    /// # Example
    /// ```rust,ignore
    /// let quote = verifier.verify_account(&ctx.accounts.oracle)?;
    /// for feed in quote.feeds() {
    ///     println!("Feed {}: ${}", feed.hex_id(), feed.value());
    /// }
    /// ```
    #[cfg(feature = "pinocchio")]
    #[inline(always)]
    pub fn verify_account<'data, T>(
        &self,
        queue: &[u8; 32],
        oracle_account: &'data T,
    ) -> Result<OracleQuote<'data>, AnyError>
    where
        T: AsAccountInfo<'data>,
    {
        let account_info = oracle_account.as_account_info();

        // For pinocchio, use raw data access to avoid temporary borrow lifetime issues
        // # Safety: Account data is memory-mapped by Solana runtime and lives for the transaction duration
        // We're using unsafe to extend the lifetime from the temporary borrow to match the account parameter
        let oracle_data: &'data [u8] = unsafe {
            let temp_borrow = account_info.borrow_data_unchecked();
            std::slice::from_raw_parts(temp_borrow.as_ptr(), temp_borrow.len())
        };

        if oracle_data.len() < 40 {
            bail!(
                "Oracle account too small: {} bytes, expected at least 40",
                oracle_data.len()
            );
        }

        unsafe {
            if read_unaligned(oracle_data.as_ptr() as *const u64) != QUOTE_DISCRIMINATOR_U64_LE {
                bail!("Invalid oracle account discriminator");
            }
            let data_ptr = oracle_data.as_ptr().add(8) as *const u64;
            let queue_ptr = queue.as_ptr() as *const u64;
            if !check_p64_eq(data_ptr, queue_ptr) {
                bail!("Oracle account does not belong to the specified queue");
            }
        }

        self.verify_delimited(&oracle_data[40..])
    }

    #[cfg(not(feature = "pinocchio"))]
    #[inline(always)]
    pub fn verify_account<'data, T>(
        &self,
        queue: &[u8; 32],
        oracle_account: &'data T,
    ) -> Result<OracleQuote<'data>, AnyError>
    where
        T: AsAccountInfo<'data>,
    {
        let account_info = oracle_account.as_account_info();

        let oracle_data = unsafe { &*account_info.data.as_ptr() };

        if oracle_data.len() < 40 {
            bail!(
                "Oracle account too small: {} bytes, expected at least 40",
                oracle_data.len()
            );
        }

        unsafe {
            if read_unaligned(oracle_data.as_ptr() as *const u64) != QUOTE_DISCRIMINATOR_U64_LE {
                bail!("Invalid oracle account discriminator");
            }
            let data_ptr = oracle_data.as_ptr().add(8) as *const u64;
            let queue_ptr = queue.as_ptr() as *const u64;
            if !check_p64_eq(data_ptr, queue_ptr) {
                bail!("Oracle account does not belong to the specified queue");
            }
        }

        self.verify_delimited(&oracle_data[40..])
    }

    /// Verifies raw ED25519 instruction data and creates a validated OracleQuote.
    ///
    /// This is the core verification method that performs all security checks:
    /// - Parses ED25519 signatures and extracts oracle indices
    /// - Validates oracle signing keys against the queue
    /// - Verifies slot hash against the sysvar
    /// - Validates quote age against max_age (requires clock sysvar)
    /// - Ensures oracle quote data integrity
    ///
    /// # Arguments
    /// * `data` - Raw ED25519 instruction data containing signatures and quote
    ///
    /// # Returns
    /// * `Ok(OracleQuote)` - Successfully verified and parsed oracle quote
    /// * `Err(AnyError)` - Verification failed with detailed error message
    ///
    /// # Errors
    /// - Clock slot not set
    /// - No signatures provided
    /// - Invalid oracle signing keys
    /// - Slot hash mismatch
    /// - Quote is too old (exceeds max_age slots)
    /// - Malformed instruction data
    #[inline(always)]
    pub fn verify_delimited<'data>(
        &self,
        data: &'data [u8],
    ) -> Result<OracleQuote<'data>, AnyError> {
        // # Safety
        //
        // This unsafe block is safe because:
        // - We verify `data` has at least 2 bytes before reading the length
        // - `read_unaligned` safely reads u16 from potentially unaligned memory
        // - The bounds check ensures we don't read beyond the data buffer
        // - Data slice is guaranteed valid for the function duration
        if data.len() < 2 {
            bail!("Data too small for length prefix: {} bytes", data.len());
        }
        unsafe {
            let len = read_unaligned(data.as_ptr() as *const u16) as usize;
            if data.len() < len + 2 {
                bail!(
                    "Data length mismatch: expected {}, got {}",
                    len + 2,
                    data.len()
                );
            }
            self.verify(&data[2..len + 2])
        }
    }

    /// Parses oracle quote data without performing any verification checks.
    ///
    /// This method extracts the quote structure from ED25519 instruction data
    /// but skips all security validations including:
    /// - Clock/age validation
    /// - Signature verification
    /// - Oracle key authorization
    /// - Slot hash verification
    ///
    /// **WARNING**: This method should only be used for debugging, analysis, or
    /// scenarios where verification is handled separately. Never use unverified
    /// quotes for production decisions.
    ///
    /// # Arguments
    /// * `data` - Raw ED25519 instruction data containing signatures and quote
    ///
    /// # Returns
    /// * `Ok(OracleQuote)` - Successfully parsed oracle quote (unverified)
    /// * `Err(AnyError)` - Failed to parse the quote data structure
    ///
    /// # Example
    /// ```rust,ignore
    /// // Parse quote without verification (use cautiously)
    /// let unverified_quote = verifier.parse_unverified(&instruction_data)?;
    /// println!("Quote contains {} feeds", unverified_quote.feeds().len());
    /// ```
    #[inline(always)]
    pub fn parse_unverified<'data>(
        &self,
        data: &'data [u8],
    ) -> Result<OracleQuote<'data>, AnyError> {
        let (parsed_sigs, sig_count, oracle_idxs, recent_slot, version) =
            Ed25519Sysvar::parse_instruction(data)?;

        if sig_count == 0 {
            bail!("No signatures provided");
        }

        let reference_sig = &parsed_sigs[0];
        let reference_feed_infos = unsafe { reference_sig.feed_infos() };
        let feed_count = reference_feed_infos.len();

        Ok(OracleQuote::new(
            unsafe { reference_sig.quote_header() },
            sig_count,
            reference_feed_infos,
            feed_count as u8,
            oracle_idxs,
            recent_slot,
            version,
            data,
        ))
    }

    /// Parses oracle quote data from an account without performing verification checks.
    ///
    /// This is a convenience method that extracts quote data from a Switchboard
    /// oracle account and parses it without any security validations.
    ///
    /// **WARNING**: This method should only be used for debugging, analysis, or
    /// scenarios where verification is handled separately. Never use unverified
    /// quotes for production decisions.
    ///
    /// # Arguments
    /// * `oracle_account` - Oracle account containing quote data
    ///
    /// # Returns
    /// * `Ok(OracleQuote)` - Successfully parsed oracle quote (unverified)
    /// * `Err(AnyError)` - Failed to parse the account or quote data
    ///
    /// # Example
    /// ```rust,ignore
    /// // Parse account quote without verification (use cautiously)
    /// let unverified_quote = verifier.parse_account_unverified(&oracle_account)?;
    /// ```
    #[cfg(feature = "pinocchio")]
    #[inline(always)]
    pub fn parse_account_unverified<'data, T>(
        &self,
        oracle_account: &'data T,
    ) -> Result<OracleQuote<'data>, AnyError>
    where
        T: AsAccountInfo<'data>,
    {
        let account_info = oracle_account.as_account_info();

        let oracle_data = account_info.borrow_data_unchecked();

        if oracle_data.len() < 40 {
            bail!(
                "Oracle account too small: {} bytes, expected at least 40",
                oracle_data.len()
            );
        }

        self.parse_unverified_delimited(&oracle_data[40..])
    }

    #[cfg(not(feature = "pinocchio"))]
    #[inline(always)]
    pub fn parse_account_unverified<'data, T>(
        &self,
        oracle_account: &'data T,
    ) -> Result<OracleQuote<'data>, AnyError>
    where
        T: AsAccountInfo<'data>,
    {
        let account_info = oracle_account.as_account_info();

        let oracle_data = unsafe { &*account_info.data.as_ptr() };

        if oracle_data.len() < 40 {
            bail!(
                "Oracle account too small: {} bytes, expected at least 40",
                oracle_data.len()
            );
        }

        self.parse_unverified_delimited(&oracle_data[40..])
    }

    /// Parses length-delimited oracle quote data without verification checks.
    ///
    /// This method handles the length prefix parsing and delegates to `parse_unverified`.
    ///
    /// # Arguments
    /// * `data` - Length-delimited ED25519 instruction data
    ///
    /// # Returns
    /// * `Ok(OracleQuote)` - Successfully parsed oracle quote (unverified)
    /// * `Err(AnyError)` - Failed to parse the data
    #[inline(always)]
    pub fn parse_unverified_delimited<'data>(
        &self,
        data: &'data [u8],
    ) -> Result<OracleQuote<'data>, AnyError> {
        if data.len() < 2 {
            bail!("Data too small for length prefix: {} bytes", data.len());
        }
        unsafe {
            let len = read_unaligned(data.as_ptr() as *const u16) as usize;
            if data.len() < len + 2 {
                bail!(
                    "Data length mismatch: expected {}, got {}",
                    len + 2,
                    data.len()
                );
            }
            self.parse_unverified(&data[2..len + 2])
        }
    }

    /// Verifies oracle quote data and returns a validated OracleQuote
    pub fn verify<'data>(&self, data: &'data [u8]) -> Result<OracleQuote<'data>, AnyError> {
        let (parsed_sigs, sig_count, oracle_idxs, recent_slot, version) =
            Ed25519Sysvar::parse_instruction(data)?;
        let queue = self
            .queue
            .as_ref()
            .ok_or_else(|| anyhow::anyhow!("Queue account not set"))?;
        let slothash_sysvar = self
            .slothash_sysvar
            .as_ref()
            .ok_or_else(|| anyhow::anyhow!("Slothash sysvar not set"))?;

        // Validate quote freshness - clock slot is required for all verifications
        let clock_slot = self
            .clock_slot
            .ok_or_else(|| anyhow::anyhow!("Clock slot not set"))?;
        if clock_slot < recent_slot || clock_slot - recent_slot > self.max_age {
            bail!(
                "Quote is too old: recent_slot={}, current_slot={}, max_age={}",
                recent_slot,
                clock_slot,
                self.max_age
            );
        }

        if sig_count == 0 {
            bail!("No signatures provided");
        }

        // Get queue data for oracle signing keys
        // Safely access queue data using RefCell borrow and try_from_bytes
        let queue_buf = borrow_account_data!(queue);
        if queue_buf.len() != 6280 {
            bail!("Queue account too small: {} bytes", queue_buf.len());
        }
        let queue_data: &QueueAccountData =
            unsafe { &*(queue_buf.as_ptr().add(8) as *const QueueAccountData) };

        // Find the target slothash from the oracle quote
        let reference_sig = &parsed_sigs[0];
        let header = unsafe { reference_sig.quote_header() };

        // Find the target slothash from oracle quote and get corresponding hash from sysvar
        let target_slothash = &header.signed_slothash as *const _ as *const u64;
        let found_slothash =
            &Self::find_slothash_in_sysvar(recent_slot, slothash_sysvar)? as *const _ as *const u64;

        assert!(unsafe { check_p64_eq(found_slothash, target_slothash) });

        // Oracle signing key validation (32 bytes per oracle: actual should match expected)
        for i in 0..sig_count {
            // Branchless bounds check,  30 is max oracles in queue
            let oracle_idx = (oracle_idxs[i as usize] as usize) % 30;
            let expected_oracle_key = queue_data.ed25519_oracle_signing_keys[oracle_idx];
            let actual_oracle_key = unsafe { parsed_sigs[i as usize].pubkey() };
            assert!(unsafe {
                check_p64_eq(
                    actual_oracle_key as *const _ as *const u64,
                    &expected_oracle_key as *const _ as *const u64,
                )
            });
        }

        // Continue with remaining processing...
        let reference_feed_infos = unsafe { reference_sig.feed_infos() };
        let feed_count = reference_feed_infos.len();

        Ok(OracleQuote::new(
            unsafe { reference_sig.quote_header() },
            sig_count,
            reference_feed_infos,
            feed_count as u8,
            oracle_idxs,
            recent_slot,
            version,
            data,
        ))
    }

    /// Loads and verifies an ED25519 instruction from the instructions sysvar with age validation.
    ///
    /// This method extracts instruction data from the instructions sysvar at the specified
    /// index, validates that it comes from the ED25519 program, checks the quote age against
    /// the current slot using the configured max_age, and then verifies the oracle quote data.
    ///
    /// # Arguments
    /// * `instruction_idx` - Index of the instruction to load from the sysvar (typically 0 for first instruction)
    ///
    /// # Returns
    /// * `Ok(OracleQuote)` - Successfully loaded and verified oracle quote
    /// * `Err(AnyError)` - Failed to load or verify the instruction
    ///
    /// # Errors
    /// - Instruction not found at the specified index
    /// - Instruction is not from the ED25519 program
    /// - Quote is too old (exceeds max_age slots)
    /// - Verification of the quote data fails
    #[inline(always)]
    pub fn verify_instruction_at(&self, instruction_idx: i64) -> Result<OracleQuote<'a>, AnyError> {
        use crate::Instructions;

        let ix_sysvar = self
            .ix_sysvar
            .as_ref()
            .ok_or_else(|| anyhow::anyhow!("Instructions sysvar not set"))?;

        // Extract instruction data and validate program ID using the existing helper
        let data = {
            #[cfg(feature = "pinocchio")]
            {
                Instructions::extract_ix_data(*ix_sysvar, instruction_idx as usize)
            }
            #[cfg(not(feature = "pinocchio"))]
            {
                Instructions::extract_ix_data(ix_sysvar, instruction_idx as usize)
            }
        };

        // Verify the instruction data
        self.verify(data)
    }

    /// Finds and returns a specific slot hash from the slot hash sysvar.
    ///
    /// This function searches through the slot hash sysvar to find the hash
    /// corresponding to the target slot. It uses an optimized search starting
    /// from an estimated position and working backwards.
    ///
    /// # Arguments
    /// * `target_slot` - The slot number to find the hash for
    /// * `slothash_sysvar` - Reference to the slot hash sysvar account
    ///
    /// # Returns
    /// * `Ok([u8; 32])` - The 32-byte hash for the target slot
    /// * `Err(AnyError)` - Slot not found in the sysvar
    ///
    /// # Performance
    /// Uses an estimated starting position based on slot ordering to minimize
    /// the number of entries that need to be checked.
    fn find_slothash_in_sysvar(
        target_slot: u64,
        slothash_sysvar: &AccountInfo,
    ) -> Result<[u8; 32], AnyError> {
        assert!(check_pubkey_eq(
            *get_account_key!(slothash_sysvar),
            solana_program::sysvar::slot_hashes::ID
        ));
        let slothash_data = borrow_account_data!(slothash_sysvar);

        // # Safety
        //
        // This transmute is safe because:
        // - SlotHash is a POD type with known layout (u64 + [u8; 32])
        // - We skip the 8-byte sysvar header before transmuting
        // - The Solana runtime guarantees proper alignment and initialization of sysvar data
        // - The slice length is determined by the actual data size
        let slot_data: &[SlotHash] = unsafe { std::mem::transmute(&slothash_data[8..]) };

        let mut estimated_idx = ((slot_data[0].slot - target_slot) % SYSVAR_SLOT_LEN) as usize;

        // Optimized search with early termination
        loop {
            let slot_entry = &slot_data[estimated_idx];
            if slot_entry.slot == target_slot {
                return Ok(slot_entry.hash);
            }
            if estimated_idx == 0 {
                break;
            }
            estimated_idx -= 1;
        }
        bail!("Slot not found in slothash sysvar");
    }
}

/// Convenience function for extracting the most recent ED25519 instruction from the instructions sysvar.
///
/// This function retrieves the instruction immediately preceding the current one,
/// which should contain the ED25519 signature data. It handles the type coercion
/// from Anchor's Sysvar wrapper to AccountInfo for easier usage in programs.
///
/// # Arguments
/// * `ix_sysvar` - Reference to the instructions sysvar (can be wrapped in various types)
///
/// # Returns
/// * `Ok(Instruction)` - The ED25519 instruction with signature data
/// * `Err(ProgramError)` - Failed to retrieve the instruction
///
/// # Example
/// ```rust,ignore
/// let ed25519_ix = get_ed25519_instruction(&ctx.accounts.instructions)?;
/// // Process the instruction data...
/// ```
#[inline(always)]
pub fn get_ed25519_instruction<'a, T>(
    ix_sysvar: &T,
) -> Result<solana_program::instruction::Instruction, solana_program::program_error::ProgramError>
where
    T: AsAccountInfo<'a>,
{
    #[cfg(feature = "pinocchio")]
    {
        use core::ptr::read_unaligned;

        use solana_program::ed25519_program::ID as ED25519_PROGRAM_ID;
        use solana_program::sysvar::instructions::ID as INSTRUCTIONS_SYSVAR_ID;

        use crate::{borrow_account_data, check_pubkey_eq, get_account_key, Instructions};

        // Get the previous instruction (index -1 relative to current)
        let ix_sysvar_account = ix_sysvar.as_account_info();

        // First, we need to get the number of instructions to calculate the previous instruction index
        assert!(check_pubkey_eq(
            *get_account_key!(ix_sysvar_account),
            INSTRUCTIONS_SYSVAR_ID
        ));

        let num_instructions = unsafe {
            let data = borrow_account_data!(ix_sysvar_account);
            read_unaligned(data.as_ptr() as *const u16) as usize
        };

        // For get_instruction_relative(-1, ...), we want the previous instruction
        // Since instructions are 0-indexed, the previous instruction is at index (num_instructions - 1)
        if num_instructions == 0 {
            return Err(solana_program::program_error::ProgramError::InvalidInstructionData);
        }

        let prev_instruction_idx = num_instructions - 1;
        let data = Instructions::extract_ix_data(ix_sysvar_account, prev_instruction_idx);

        // Create an Instruction struct from the extracted data
        use solana_program::instruction::Instruction;

        Ok(Instruction {
            program_id: ED25519_PROGRAM_ID,
            accounts: vec![], // We don't parse account metas for this use case
            data: data.to_vec(),
        })
    }

    #[cfg(not(feature = "pinocchio"))]
    get_instruction_relative(-1, ix_sysvar.as_account_info())
}
