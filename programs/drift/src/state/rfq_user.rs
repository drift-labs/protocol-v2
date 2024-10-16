use crate::error::{DriftResult, ErrorCode};
use crate::ID;
use anchor_lang::prelude::{AccountInfo, AccountLoader, Pubkey};
use anchor_lang::{account, zero_copy};
use std::collections::BTreeMap;
use std::iter::Peekable;
use std::slice::Iter;

use crate::state::traits::Size;

pub const RFQ_PDA_SEED: &str = "RFQ";
#[zero_copy(unsafe)]
#[derive(Default, Eq, PartialEq, Debug)]
#[repr(C)]
pub struct RFQOrderId {
    pub uuid: [u8; 8],
    pub max_ts: i64,
}

impl RFQOrderId {
    pub fn new(uuid: [u8; 8], max_ts: i64) -> Self {
        Self { uuid, max_ts }
    }
}

impl Size for RFQUser {
    const SIZE: usize = 776;
}

#[account(zero_copy(unsafe))]
#[derive(Default, Eq, PartialEq, Debug)]
#[repr(C)]
pub struct RFQUser {
    pub user_pubkey: Pubkey,
    pub rfq_order_data: [RFQOrderId; 32],
}

impl RFQUser {
    pub fn check_exists_and_prune_stale_rfq_order_ids(
        &mut self,
        rfq_order_id: RFQOrderId,
        now: i64,
    ) -> DriftResult<bool> {
        let mut uuid_exists = false;
        for i in 0..self.rfq_order_data.len() {
            let existing_rfq_order_id = &mut self.rfq_order_data[i];
            if existing_rfq_order_id.uuid == rfq_order_id.uuid && existing_rfq_order_id.max_ts > now
            {
                uuid_exists = true;
            } else {
                if existing_rfq_order_id.max_ts < now {
                    existing_rfq_order_id.uuid = [0; 8];
                    existing_rfq_order_id.max_ts = 0;
                }
            }
        }
        Ok(uuid_exists)
    }

    pub fn add_rfq_order_id(&mut self, rfq_order_id: RFQOrderId) -> DriftResult {
        for i in 0..self.rfq_order_data.len() {
            if self.rfq_order_data[i].max_ts == 0 {
                self.rfq_order_data[i] = rfq_order_id;
                return Ok(());
            }
        }

        Err(ErrorCode::RFQUserAccountFull.into())
    }
}

pub fn derive_rfq_user_pda(user_account_pubkey: &Pubkey) -> DriftResult<Pubkey> {
    let (rfq_pubkey, _) = Pubkey::find_program_address(
        &[RFQ_PDA_SEED.as_bytes(), user_account_pubkey.as_ref()],
        &ID,
    );
    Ok(rfq_pubkey)
}

pub fn load_rfq_user_account_map<'a: 'b, 'b>(
    account_info_iter: &mut Peekable<Iter<'a, AccountInfo<'b>>>,
    user_pubkeys: Vec<Pubkey>,
) -> DriftResult<BTreeMap<Pubkey, AccountLoader<'a, RFQUser>>> {
    let mut rfq_user_account_map = BTreeMap::<Pubkey, AccountLoader<'a, RFQUser>>::new();

    let available_maker_pdas: BTreeMap<Pubkey, Pubkey> = user_pubkeys
        .iter()
        .map(|pubkey| {
            let pda = derive_rfq_user_pda(pubkey).unwrap();
            (pda, *pubkey)
        })
        .collect();

    for account_info in account_info_iter {
        let account_key = account_info.key;
        if let Some(pubkey) = available_maker_pdas.get(account_key) {
            let is_writable = account_info.is_writable;
            if !is_writable {
                return Err(ErrorCode::RFQUserAccountWrongMutability);
            }

            let account_loader: AccountLoader<'a, RFQUser> =
                AccountLoader::try_from(account_info).or(Err(ErrorCode::InvalidRFQUserAccount))?;

            rfq_user_account_map.insert(*pubkey, account_loader);
        }
    }

    Ok(rfq_user_account_map)
}
