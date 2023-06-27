use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use anchor_client::Program;
use anchor_client::{
    solana_client::rpc_client::RpcClient, solana_sdk::commitment_config::CommitmentLevel,
};
use anchor_lang::prelude::Pubkey;
use drift::state::perp_market::PerpMarket;
use drift::state::spot_market::SpotMarket;
use drift::state::user::{User, UserStats};
use parking_lot::Mutex;

use crate::types::{
    AccountDataWithSlot, DriftClientAccountSubscriber, DriftClientAccountSubscriberCommon,
};

pub struct PollingAccountSubscriber {
    common: DriftClientAccountSubscriberCommon,
    poll_interval: Duration,
}

impl PollingAccountSubscriber {
    pub fn new(
        program: Program,
        commitment: CommitmentLevel,
        poll_interval: Duration,
        perp_market_indexes_to_watch: Option<Vec<u16>>,
        spot_market_indexes_to_watch: Option<Vec<u16>>,
        authorities_to_watch: Option<Vec<Pubkey>>,
    ) -> Self {
        Self {
            poll_interval,
            common: DriftClientAccountSubscriberCommon {
                program_id: program.id(),
                commitment,
                perp_market_indexes_to_watch: perp_market_indexes_to_watch.clone(),
                spot_market_indexes_to_watch: spot_market_indexes_to_watch.clone(),
                authorities_to_watch: authorities_to_watch.clone(),

                ..Default::default()
            },
        }
    }
}

impl DriftClientAccountSubscriber for PollingAccountSubscriber {
    fn load(&mut self) -> Result<(), anyhow::Error> {
        unimplemented!()
    }

    fn get_program_id(&self) -> Pubkey {
        self.common.get_program_id()
    }

    fn get_perp_market_accounts_map(
        &self,
    ) -> Arc<Mutex<HashMap<Pubkey, AccountDataWithSlot<PerpMarket>>>> {
        self.common.get_perp_market_accounts_map()
    }

    fn get_spot_market_accounts_map(
        &self,
    ) -> Arc<Mutex<HashMap<Pubkey, AccountDataWithSlot<SpotMarket>>>> {
        self.common.get_spot_market_accounts_map()
    }

    fn get_spot_market_by_pubkey(&self, pubkey: &Pubkey) -> Option<SpotMarket> {
        self.common.get_spot_market_by_pubkey(pubkey)
    }

    fn get_spot_market_by_market_index(&self, market_index: u16) -> Option<SpotMarket> {
        self.common.get_spot_market_by_market_index(market_index)
    }

    fn get_user_accounts_map(&self) -> Arc<Mutex<HashMap<Pubkey, AccountDataWithSlot<User>>>> {
        self.common.get_user_accounts_map()
    }

    fn get_user_stats_accounts_map(
        &self,
    ) -> Arc<Mutex<HashMap<Pubkey, AccountDataWithSlot<UserStats>>>> {
        self.common.get_user_stats_accounts_map()
    }

    fn get_perp_market_by_pubkey_with_slot(
        &self,
        pubkey: &Pubkey,
    ) -> Option<AccountDataWithSlot<PerpMarket>> {
        self.common.get_perp_market_by_pubkey_with_slot(pubkey)
    }

    fn get_spot_market_by_pubkey_with_slot(
        &self,
        pubkey: &Pubkey,
    ) -> Option<AccountDataWithSlot<SpotMarket>> {
        self.common.get_spot_market_by_pubkey_with_slot(pubkey)
    }

    fn get_perp_market_by_market_index_with_slot(
        &self,
        market_index: u16,
    ) -> Option<AccountDataWithSlot<PerpMarket>> {
        self.common
            .get_perp_market_by_market_index_with_slot(market_index)
    }

    fn get_spot_market_by_market_index_with_slot(
        &self,
        market_index: u16,
    ) -> Option<AccountDataWithSlot<SpotMarket>> {
        self.common
            .get_spot_market_by_market_index_with_slot(market_index)
    }

    fn get_user_with_slot(
        &self,
        authority: &Pubkey,
        subaccount_id: u16,
    ) -> Option<AccountDataWithSlot<User>> {
        self.common.get_user_with_slot(authority, subaccount_id)
    }

    fn get_user_stats_with_slot(
        &self,
        authority: &Pubkey,
    ) -> Option<AccountDataWithSlot<UserStats>> {
        self.common.get_user_stats_with_slot(authority)
    }
}
