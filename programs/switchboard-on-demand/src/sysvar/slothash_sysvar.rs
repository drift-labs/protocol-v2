use anyhow::{anyhow, bail, Result};
use arrayref::array_ref;
use bytemuck;

use crate::solana_compat::{msg, sysvar};
use crate::{borrow_account_data, check_pubkey_eq, get_account_key};

/// Solana slot hash data structure containing slot number and corresponding hash
#[repr(C)]
#[derive(bytemuck::Pod, bytemuck::Zeroable, Debug, Clone, Copy)]
pub struct SlotHash {
    /// Slot number
    pub slot: u64,
    /// 32-byte hash for this slot
    pub hash: [u8; 32],
}

/// Finds the index of a specific slot in the slot hashes array using binary search
/// since slots are often skipped
pub fn find_idx(slot_hashes: &[SlotHash], slot: u64) -> Option<usize> {
    slot_hashes.binary_search_by(|x| slot.cmp(&x.slot)).ok()
}

/// Slot hashes sysvar for Solana slot hash verification
#[derive(Copy, Clone, Default, serde::Serialize, serde::Deserialize)]
pub struct SlotHashes;

#[cfg(feature = "anchor")]
impl anchor_lang::solana_program::sysvar::SysvarId for SlotHashes {
    fn id() -> anchor_lang::solana_program::pubkey::Pubkey {
        sysvar::slot_hashes::id().to_bytes().into()
    }

    fn check_id(id: &anchor_lang::solana_program::pubkey::Pubkey) -> bool {
        sysvar::slot_hashes::id() == id.to_bytes().into()
    }
}
#[cfg(feature = "anchor")]
impl anchor_lang::solana_program::sysvar::Sysvar for SlotHashes {
    // override
    fn size_of() -> usize {
        // hard-coded so that we don't have to construct an empty
        20_488 // golden, update if MAX_ENTRIES changes
    }

    fn from_account_info(
        _account_info: &anchor_lang::prelude::AccountInfo,
    ) -> Result<Self, anchor_lang::solana_program::program_error::ProgramError> {
        Ok(Self {})
    }
}

impl<'a> SlotHashes {
    /// Gets slot hash using lower byte optimization for performance
    #[inline(always)]
    pub fn get_slothash_from_lower_byte(
        slot_hashes: &crate::AccountInfo,
        slot: u16,
    ) -> Result<SlotHash> {
        let (upper_slot, lower_slot) = {
            #[allow(unused_unsafe)]
            let slots_data = unsafe { borrow_account_data!(slot_hashes) };
            let slots: &[u8] = array_ref![slots_data, 8, 20_480];
            // 20_480 / 40 = 512
            let slots: &[SlotHash] =
                unsafe { std::slice::from_raw_parts(slots.as_ptr() as *const SlotHash, 512) };
            let upper_slot = (slots[0].slot & 0xFFFFFFFFFFFF0000) | slot as u64;
            let lower_slot = (slots[slots.len() - 1].slot & 0xFFFFFFFFFFFF0000) | slot as u64;
            (upper_slot, lower_slot)
        };
        if let Ok(slothash) = Self::get_slothash(slot_hashes, upper_slot) {
            return Ok(SlotHash {
                slot: upper_slot,
                hash: slothash,
            });
        }
        Self::get_slothash(slot_hashes, lower_slot).map(|hash| SlotHash {
            slot: lower_slot,
            hash,
        })
    }

    /// Gets the slot hash for a specific slot from the slot hashes sysvar
    pub fn get_slothash(slot_sysvar: &crate::AccountInfo, slot: u64) -> Result<[u8; 32]> {
        assert!(check_pubkey_eq(
            sysvar::slot_hashes::ID,
            *get_account_key!(slot_sysvar)
        ));
        let slot_hashes = slot_sysvar;
        #[allow(unused_unsafe)]
        let slots_data = unsafe { borrow_account_data!(slot_hashes) };
        let slots: &[u8] = array_ref![slots_data, 8, 20_480];
        // 20_480 / 40 = 512
        let slots: &[SlotHash] =
            unsafe { std::slice::from_raw_parts(slots.as_ptr() as *const SlotHash, 512) };
        if slot > slots[0].slot {
            msg!("Error: Your provided slot is too new. Please use confirmed commitment for your connection and processed for simulation.");
            bail!("SwitchboardError::InvalidSlotNumber");
        }
        let idx = find_idx(slots, slot).ok_or_else(|| anyhow!("InvalidSlotNumber"))?;
        let signed_slot = slots[idx];
        assert_eq!(signed_slot.slot, slot);
        Ok(signed_slot.hash)
    }

    /// Parses slot hash data from raw bytes into SlotHash array
    pub fn parse(data: &'a [u8]) -> &'a [SlotHash] {
        unsafe { std::slice::from_raw_parts(data[8..].as_ptr() as *const SlotHash, 512) }
    }
}
