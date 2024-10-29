use crate::error::{DriftResult, ErrorCode};
use crate::math::safe_unwrap::SafeUnwrap;
use crate::ID;
use anchor_lang::prelude::{AccountInfo, AccountLoader, Pubkey};
use anchor_lang::{account, zero_copy, Discriminator};
use arrayref::array_ref;
use std::collections::BTreeMap;
use std::convert::TryFrom;
use std::iter::Peekable;
use std::slice::Iter;

use crate::state::traits::Size;

pub const SWIFT_PDA_SEED: &str = "SWIFT";
#[zero_copy(unsafe)]
#[derive(Default, Eq, PartialEq, Debug)]
#[repr(C)]
pub struct SwiftOrderId {
    pub uuid: [u8; 8],
    pub max_ts: i64,
}

impl SwiftOrderId {
    pub fn new(uuid: [u8; 8], max_ts: i64) -> Self {
        Self { uuid, max_ts }
    }
}

impl Size for SwiftUser {
    const SIZE: usize = 776;
}

#[account(zero_copy(unsafe))]
#[derive(Default, Eq, PartialEq, Debug)]
#[repr(C)]
pub struct SwiftUser {
    pub user_pubkey: Pubkey,
    pub swift_order_data: [SwiftOrderId; 32],
}

impl SwiftUser {
    pub fn check_exists_and_prune_stale_swift_order_ids(
        &mut self,
        swift_order_id: SwiftOrderId,
        now: i64,
    ) -> DriftResult<bool> {
        let mut uuid_exists = false;
        for i in 0..self.swift_order_data.len() {
            let existing_swift_order_id = &mut self.swift_order_data[i];
            if existing_swift_order_id.uuid == swift_order_id.uuid
                && existing_swift_order_id.max_ts > now
            {
                uuid_exists = true;
            } else {
                if existing_swift_order_id.max_ts < now {
                    existing_swift_order_id.uuid = [0; 8];
                    existing_swift_order_id.max_ts = 0;
                }
            }
        }
        Ok(uuid_exists)
    }

    pub fn add_swift_order_id(&mut self, swift_order_id: SwiftOrderId) -> DriftResult {
        for i in 0..self.swift_order_data.len() {
            if self.swift_order_data[i].max_ts == 0 {
                self.swift_order_data[i] = swift_order_id;
                return Ok(());
            }
        }

        Err(ErrorCode::SwiftUserAccountFull.into())
    }
}

pub fn derive_swift_user_pda(user_account_pubkey: &Pubkey) -> DriftResult<Pubkey> {
    let (swift_pubkey, _) = Pubkey::find_program_address(
        &[SWIFT_PDA_SEED.as_bytes(), user_account_pubkey.as_ref()],
        &ID,
    );
    Ok(swift_pubkey)
}

pub fn load_swift_user_account_map<'a: 'b, 'b>(
    account_info_iter: &mut Peekable<Iter<'a, AccountInfo<'b>>>,
) -> DriftResult<BTreeMap<Pubkey, AccountLoader<'a, SwiftUser>>> {
    let mut swift_user_account_map = BTreeMap::<Pubkey, AccountLoader<'a, SwiftUser>>::new();

    for account_info in account_info_iter {
        let data = account_info
            .try_borrow_data()
            .or(Err(ErrorCode::InvalidSwiftUserAccount))?;

        let expected_data_len = SwiftUser::SIZE;
        if data.len() < expected_data_len {
            break;
        }

        let account_discriminator = array_ref![data, 0, 8];
        if account_discriminator != &SwiftUser::discriminator() {
            break;
        }

        let user_pubkey_slice = array_ref![data, 8, 32];
        let user_pubkey: Pubkey = Pubkey::try_from(*user_pubkey_slice).safe_unwrap()?;

        let is_writable = account_info.is_writable;
        if !is_writable {
            return Err(ErrorCode::SwiftUserAccountWrongMutability);
        }

        let account_loader: AccountLoader<'a, SwiftUser> =
            AccountLoader::try_from(account_info).or(Err(ErrorCode::InvalidSwiftUserAccount))?;

        swift_user_account_map.insert(user_pubkey, account_loader);
    }

    Ok(swift_user_account_map)
}
