use crate::error::{DriftResult, ErrorCode};
use crate::ID;
use anchor_lang::prelude::Pubkey;
use anchor_lang::{account, zero_copy};

use crate::state::traits::Size;

pub const SWIFT_PDA_SEED: &str = "SWIFT";
pub const SWIFT_SLOT_EVICTION_BUFFER: u64 = 10;

mod tests;

#[zero_copy(unsafe)]
#[derive(Default, Eq, PartialEq, Debug)]
#[repr(C)]
pub struct SwiftOrderId {
    pub uuid: [u8; 8],
    pub max_slot: u64,
    pub order_id: u32,
}

impl SwiftOrderId {
    pub fn new(uuid: [u8; 8], max_slot: u64, order_id: u32) -> Self {
        Self {
            uuid,
            max_slot,
            order_id,
        }
    }
}

impl Size for SwiftUserOrder {
    const SIZE: usize = 808;
}

#[account(zero_copy(unsafe))]
#[derive(Default, Eq, PartialEq, Debug)]
#[repr(C)]
pub struct SwiftUserOrder {
    pub user_pubkey: Pubkey,
    pub swift_order_data: [SwiftOrderId; 32],
}

impl SwiftUserOrder {
    pub fn check_exists_and_prune_stale_swift_order_ids(
        &mut self,
        swift_order_id: SwiftOrderId,
        current_slot: u64,
    ) -> bool {
        let mut uuid_exists = false;
        for i in 0..self.swift_order_data.len() {
            let existing_swift_order_id = &mut self.swift_order_data[i];
            if existing_swift_order_id.uuid == swift_order_id.uuid
                && existing_swift_order_id.max_slot + SWIFT_SLOT_EVICTION_BUFFER >= current_slot
            {
                uuid_exists = true;
            } else {
                if existing_swift_order_id.max_slot + SWIFT_SLOT_EVICTION_BUFFER < current_slot {
                    existing_swift_order_id.uuid = [0; 8];
                    existing_swift_order_id.max_slot = 0;
                    existing_swift_order_id.order_id = 0;
                }
            }
        }
        uuid_exists
    }

    pub fn add_swift_order_id(&mut self, swift_order_id: SwiftOrderId) -> DriftResult {
        for i in 0..self.swift_order_data.len() {
            if self.swift_order_data[i].max_slot == 0 {
                self.swift_order_data[i] = swift_order_id;
                return Ok(());
            }
        }

        Err(ErrorCode::SwiftUserOrderAccountFull.into())
    }
}

pub fn derive_swift_user_pda(user_account_pubkey: &Pubkey) -> DriftResult<Pubkey> {
    let (swift_pubkey, _) = Pubkey::find_program_address(
        &[SWIFT_PDA_SEED.as_bytes(), user_account_pubkey.as_ref()],
        &ID,
    );
    Ok(swift_pubkey)
}
