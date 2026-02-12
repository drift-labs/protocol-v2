use core::ptr::read_unaligned;

use crate::solana_compat::ed25519_program::ID as ED25519_PROGRAM_ID;
use crate::solana_compat::sysvar::instructions::ID as INSTRUCTIONS_SYSVAR_ID;

use crate::{
    borrow_account_data, check_pubkey_eq, get_account_key, AsAccountInfo, Pubkey,
};

/// Optimized wrapper for Solana's Instructions sysvar with fast instruction data extraction.
///
/// This struct provides high-performance access to instruction data from the Instructions sysvar,
/// specifically optimized for ED25519 signature verification workflows.
#[derive(Clone, Default)]
#[cfg_attr(feature = "anchor", derive(serde::Serialize, serde::Deserialize))]
pub struct Instructions;

/*
#[repr(C)]
pub struct Ed25519SignatureOffsets {
    pub signature_offset: u16,
    pub signature_instruction_index: u16,
    pub public_key_offset: u16,
    pub public_key_instruction_index: u16,
    pub message_data_offset: u16,
    pub message_data_size: u16,
    pub message_instruction_index: u16,
}
*/

impl Instructions {
    /// Extracts instruction data at the specified index.
    ///
    /// # Arguments
    /// * `ix_sysvar` - Reference to the Instructions sysvar account
    /// * `idx` - Index of the instruction to extract
    ///
    /// # Returns
    /// * `&[u8]` - Reference to the instruction data
    ///
    /// # Performance
    /// Returns a reference to avoid copying data, saving compute units.
    #[inline(always)]
    pub fn extract_ix_data<'a, T>(ix_sysvar: T, idx: usize) -> &'a [u8]
    where
        T: AsAccountInfo<'a>,
    {
        let ix_sysvar = ix_sysvar.as_account_info();
        assert!(check_pubkey_eq(
            *get_account_key!(ix_sysvar),
            INSTRUCTIONS_SYSVAR_ID
        ));
        unsafe {
            let data = borrow_account_data!(ix_sysvar);
            let base = data.as_ptr();

            // Read num_instructions from offset
            let num_instructions = read_unaligned(base as *const u16) as usize;

            // Ensure idx is within bounds - all instruction indexes MUST match idx
            assert!(
                idx < num_instructions,
                "Instruction index {} out of bounds (max: {})",
                idx,
                num_instructions
            );

            // Read instruction offset from offset table at position (2 + idx * 2)
            let start_offset = read_unaligned(base.add(2 + (idx << 1)) as *const u16) as usize;

            let mut p = base.add(start_offset);

            let num_accounts = read_unaligned(p as *const u16) as usize;

            // Bounds check for account metas (1 byte meta + 32 byte pubkey each)
            p = p.add(2 + num_accounts * 33);

            // Read program_id (32 bytes) - return reference to avoid copying
            let program_id = &*(p as *const Pubkey);

            // Read data length
            let instruction_data_len = read_unaligned(p.add(32) as *const u16) as usize;

            let ix_data_ptr = p.add(34);
            let instruction_data = core::slice::from_raw_parts(ix_data_ptr, instruction_data_len);

            // Validate Ed25519SignatureOffsets if this appears to be an Ed25519 instruction
            assert!(check_pubkey_eq(program_id, ED25519_PROGRAM_ID));
            assert!(instruction_data_len >= 16);
            // Read the first Ed25519SignatureOffsets from instruction data
            // Skip 2-byte header (num_signatures + padding), then read offsets struct
            // This only checks the first header, the verify call checks that the rest of the
            // signatures match this index.
            let signature_instruction_index =
                read_unaligned(ix_data_ptr.add(4) as *const u16) as usize;
            let public_key_instruction_index =
                read_unaligned(ix_data_ptr.add(8) as *const u16) as usize;
            let message_instruction_index =
                read_unaligned(ix_data_ptr.add(14) as *const u16) as usize;

            // All instruction indexes MUST match the current instruction index
            assert!(
                signature_instruction_index == idx,
                "Signature instruction index {} does not match current instruction index {}",
                signature_instruction_index,
                idx
            );
            assert!(
                public_key_instruction_index == idx,
                "Public key instruction index {} does not match current instruction index {}",
                public_key_instruction_index,
                idx
            );
            assert!(
                message_instruction_index == idx,
                "Message instruction index {} does not match current instruction index {}",
                message_instruction_index,
                idx
            );

            instruction_data
        }
    }

    #[inline(always)]
    pub fn extract_ix_data_unchecked<'a, T>(ix_sysvar: T, idx: usize) -> &'a [u8]
    where
        T: AsAccountInfo<'a>,
    {
        let ix_sysvar = ix_sysvar.as_account_info();
        unsafe {
            let data = borrow_account_data!(ix_sysvar);
            let base = data.as_ptr();
            let start_offset = read_unaligned(base.add(2 + (idx << 1)) as *const u16) as usize;
            let mut p = base.add(start_offset);
            let num_accounts = read_unaligned(p as *const u16) as usize;
            p = p.add(2 + num_accounts * 33);
            let instruction_data_len = read_unaligned(p.add(32) as *const u16) as usize;
            core::slice::from_raw_parts(p.add(34), instruction_data_len)
        }
    }

    /// Parses instruction data from the Instructions sysvar at the specified index into an OracleQuote without verification.
    ///
    /// **WARNING**: This function does NOT perform cryptographic verification:
    /// - No ED25519 signature validation
    /// - No oracle authorization checks
    /// - No slot hash verification
    ///
    /// Use only for data extraction and analysis. For production use, use verified parsing methods.
    ///
    /// # Arguments
    /// * `ix_sysvar` - Reference to the Instructions sysvar account
    /// * `idx` - Index of the instruction to parse
    ///
    /// # Returns
    /// * `OracleQuote` - Parsed but unverified oracle quote
    ///
    /// # Performance
    /// Returns references to avoid copying data, saving compute units.
    #[inline(always)]
    pub fn parse_ix_data_unverified<'a, T>(
        ix_sysvar: T,
        idx: usize,
    ) -> Result<crate::on_demand::oracle_quote::quote::OracleQuote<'a>, anyhow::Error>
    where
        T: AsAccountInfo<'a>,
    {
        let instruction_data = Self::extract_ix_data(ix_sysvar, idx);

        // Create a temporary verifier to parse the instruction data
        let verifier = crate::on_demand::oracle_quote::quote_verifier::QuoteVerifier::new();
        let oracle_quote = verifier.parse_unverified(instruction_data)?;

        Ok(oracle_quote)
    }
}

#[cfg(feature = "anchor")]
impl anchor_lang::Owner for Instructions {
    fn owner() -> Pubkey {
        anchor_lang::solana_program::sysvar::instructions::id()
            .to_bytes()
            .into()
    }
}

#[cfg(feature = "anchor")]
impl anchor_lang::AccountDeserialize for Instructions {
    fn try_deserialize_unchecked(_buf: &mut &[u8]) -> anchor_lang::Result<Self> {
        // This should not be called for sysvars, but we provide a stub
        Err(anchor_lang::error::ErrorCode::AccountDidNotDeserialize.into())
    }
}

#[cfg(feature = "anchor")]
impl anchor_lang::AccountSerialize for Instructions {
    fn try_serialize<W: std::io::Write>(&self, _writer: &mut W) -> anchor_lang::Result<()> {
        // This should not be called for sysvars, but we provide a stub
        Err(anchor_lang::error::ErrorCode::AccountDidNotSerialize.into())
    }
}

#[cfg(feature = "anchor")]
impl anchor_lang::solana_program::sysvar::SysvarId for Instructions {
    fn id() -> anchor_lang::solana_program::pubkey::Pubkey {
        anchor_lang::solana_program::sysvar::instructions::id()
    }

    fn check_id(pubkey: &anchor_lang::solana_program::pubkey::Pubkey) -> bool {
        pubkey == &Self::id()
    }
}

#[cfg(feature = "anchor")]
impl anchor_lang::solana_program::sysvar::Sysvar for Instructions {
    fn size_of() -> usize {
        // Instructions sysvar has variable size, return 0 as it's not used for deserialization
        0
    }

    fn from_account_info(
        account_info: &anchor_lang::solana_program::account_info::AccountInfo,
    ) -> core::result::Result<Self, anchor_lang::solana_program::program_error::ProgramError> {
        use anchor_lang::solana_program::sysvar::SysvarId;
        // We don't actually deserialize the Instructions sysvar data since we access it directly
        // Just validate that it's the correct account
        if Self::check_id(account_info.key) {
            Ok(Self)
        } else {
            Err(anchor_lang::solana_program::program_error::ProgramError::InvalidAccountData)
        }
    }
}
