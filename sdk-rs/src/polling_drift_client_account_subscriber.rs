use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use anchor_client::solana_client::rpc_client::RpcClient;
use anchor_client::Program;
use anchor_lang::prelude::Pubkey;
use drift::state::perp_market::PerpMarket;
use drift::state::spot_market::SpotMarket;
use parking_lot::Mutex;

use crate::types::{DriftClientAccountSubscriber, DriftClientAccountSubscriberCommon};

pub struct PollingAccountSubscriber {
    common: DriftClientAccountSubscriberCommon,
    rpc_client: Arc<RpcClient>,
    poll_interval: Duration,
}

impl PollingAccountSubscriber {
    pub fn new(
        rpc_client: Arc<RpcClient>,
        program: Program,
        poll_interval: Duration,
        perp_market_indexes_to_watch: Option<Vec<u16>>,
        spot_market_indexes_to_watch: Option<Vec<u16>>,
        sub_account_ids_to_watch: Option<Vec<u16>>,
    ) -> Self {
        Self {
            rpc_client,
            poll_interval,
            common: DriftClientAccountSubscriberCommon {
                program_id: program.id(),
                perp_market_indexes_to_watch: perp_market_indexes_to_watch.clone(),
                spot_market_indexes_to_watch: spot_market_indexes_to_watch.clone(),
                sub_account_ids_to_watch: sub_account_ids_to_watch.clone(),
                perp_market_accounts: Arc::new(Mutex::new(HashMap::new())),
                spot_market_accounts: Arc::new(Mutex::new(HashMap::new())),
            },
        }
    }
}

impl DriftClientAccountSubscriber for PollingAccountSubscriber {
    fn load(&mut self) -> Result<(), anyhow::Error> {
        unimplemented!()
    }

    fn get_perp_market_by_pubkey(&self, pubkey: &Pubkey) -> Option<PerpMarket> {
        self.common.get_perp_market_by_pubkey(pubkey)
    }

    fn get_spot_market_by_pubkey(&self, pubkey: &Pubkey) -> Option<SpotMarket> {
        self.common.get_spot_market_by_pubkey(pubkey)
    }

    fn get_perp_market_by_market_index(&self, market_index: u16) -> Option<PerpMarket> {
        self.common.get_perp_market_by_market_index(market_index)
    }

    fn get_spot_market_by_market_index(&self, market_index: u16) -> Option<SpotMarket> {
        self.common.get_spot_market_by_market_index(market_index)
    }
}
