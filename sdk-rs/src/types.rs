use anyhow::{anyhow, Result};
use parking_lot::Mutex;
use std::collections::HashMap;
use std::sync::Arc;

use anchor_client::{solana_sdk::pubkey::Pubkey, Program};

use drift::state::perp_market::PerpMarket;
use drift::state::spot_market::SpotMarket;
use drift::state::user::User;

#[derive(Debug, Clone)]
pub struct AccountDataWithSlot<T> {
    pub data: T,
    pub slot: Option<u64>,
}

#[derive(Debug, Clone, Default)]
pub struct DriftClientAccountSubscriberCommon {
    pub program_id: Pubkey,

    pub perp_market_indexes_to_watch: Option<Vec<u16>>,
    pub spot_market_indexes_to_watch: Option<Vec<u16>>,
    pub authority_to_subaccount_ids_to_watch: Option<HashMap<Pubkey, Vec<u16>>>,

    pub perp_market_accounts: Arc<Mutex<HashMap<Pubkey, AccountDataWithSlot<PerpMarket>>>>,
    pub spot_market_accounts: Arc<Mutex<HashMap<Pubkey, AccountDataWithSlot<SpotMarket>>>>,

    /// Map of authority -> user pubkey -> user account
    pub user_accounts: Arc<Mutex<HashMap<Pubkey, HashMap<Pubkey, AccountDataWithSlot<User>>>>>,
}

pub trait DriftClientAccountSubscriber {
    fn load(&mut self) -> Result<(), anyhow::Error>;
    fn get_perp_market_by_pubkey(&self, pubkey: &Pubkey) -> Option<PerpMarket>;
    fn get_spot_market_by_pubkey(&self, pubkey: &Pubkey) -> Option<SpotMarket>;
    fn get_perp_market_by_market_index(&self, market_index: u16) -> Option<PerpMarket>;
    fn get_spot_market_by_market_index(&self, market_index: u16) -> Option<SpotMarket>;
    fn get_user(&self, authority: &Pubkey, subaccount_id: u16) -> Option<User>;
}

impl DriftClientAccountSubscriber for DriftClientAccountSubscriberCommon {
    fn load(&mut self) -> Result<(), anyhow::Error> {
        Err(anyhow!("Function not yet implemented"))
    }

    fn get_perp_market_by_pubkey(&self, pubkey: &Pubkey) -> Option<PerpMarket> {
        self.perp_market_accounts.lock().get(pubkey).map(|x| x.data)
    }

    fn get_spot_market_by_pubkey(&self, pubkey: &Pubkey) -> Option<SpotMarket> {
        self.spot_market_accounts.lock().get(pubkey).map(|x| x.data)
    }

    /// compute PDA of market account then check local map for it
    fn get_perp_market_by_market_index(&self, market_index: u16) -> Option<PerpMarket> {
        let pubkey = get_perp_market_pda(self.program_id, market_index);
        self.get_perp_market_by_pubkey(&pubkey)
    }

    /// compute PDA of market account then check local map for it
    fn get_spot_market_by_market_index(&self, market_index: u16) -> Option<SpotMarket> {
        let pubkey = get_spot_market_pda(self.program_id, market_index);
        self.get_spot_market_by_pubkey(&pubkey)
    }

    fn get_user(&self, authority: &Pubkey, subaccount_id: u16) -> Option<User> {
        let user_pubkey = get_user_pubkey_pda(self.program_id, authority, subaccount_id);
        self.user_accounts
            .lock()
            .get(authority)
            .map(|x| x.get(&user_pubkey))
            .flatten()
            .map(|x| x.data)
    }
}

pub fn get_perp_market_pda(program_id: Pubkey, market_index: u16) -> Pubkey {
    Pubkey::find_program_address(
        &[b"perp_market", market_index.to_le_bytes().as_ref()],
        &program_id,
    )
    .0
}

pub fn get_spot_market_pda(program_id: Pubkey, market_index: u16) -> Pubkey {
    Pubkey::find_program_address(
        &[b"spot_market", market_index.to_le_bytes().as_ref()],
        &program_id,
    )
    .0
}

pub fn get_user_pubkey_pda(program_id: Pubkey, authority: &Pubkey, subaccount_id: u16) -> Pubkey {
    Pubkey::find_program_address(
        &[
            b"user",
            authority.as_ref(),
            subaccount_id.to_le_bytes().as_ref(),
        ],
        &program_id,
    )
    .0
}
