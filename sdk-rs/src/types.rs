use anyhow::{anyhow, Result};
use parking_lot::Mutex;
use std::collections::HashMap;
use std::sync::Arc;

use anchor_client::{solana_sdk::pubkey::Pubkey, Program};

use drift::state::perp_market::PerpMarket;
use drift::state::spot_market::SpotMarket;

#[derive(Debug, Clone)]
pub struct AccountDataWithSlot<T> {
    pub data: T,
    pub slot: Option<u64>,
}

#[derive(Debug, Clone)]
pub struct DriftClientAccountSubscriberCommon {
    pub program_id: Pubkey,

    pub perp_market_indexes_to_watch: Option<Vec<u16>>,
    pub spot_market_indexes_to_watch: Option<Vec<u16>>,
    pub sub_account_ids_to_watch: Option<Vec<u16>>,

    pub perp_market_accounts: Arc<Mutex<HashMap<Pubkey, AccountDataWithSlot<PerpMarket>>>>,
    pub spot_market_accounts: Arc<Mutex<HashMap<Pubkey, AccountDataWithSlot<SpotMarket>>>>,
}

pub trait DriftClientAccountSubscriber {
    fn load(&mut self) -> Result<(), anyhow::Error>;
    fn get_perp_market_by_pubkey(&self, pubkey: &Pubkey) -> Option<PerpMarket>;
    fn get_spot_market_by_pubkey(&self, pubkey: &Pubkey) -> Option<SpotMarket>;
    fn get_perp_market_by_market_index(&self, market_index: u16) -> Option<PerpMarket>;
    fn get_spot_market_by_market_index(&self, market_index: u16) -> Option<SpotMarket>;
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
        let pubkey = Pubkey::find_program_address(
            &[b"perp_market", market_index.to_le_bytes().as_ref()],
            &self.program_id,
        )
        .0;
        self.get_perp_market_by_pubkey(&pubkey)
    }

    /// compute PDA of market account then check local map for it
    fn get_spot_market_by_market_index(&self, market_index: u16) -> Option<SpotMarket> {
        let pubkey = Pubkey::find_program_address(
            &[b"spot_market", market_index.to_le_bytes().as_ref()],
            &self.program_id,
        )
        .0;
        self.get_spot_market_by_pubkey(&pubkey)
    }
}
