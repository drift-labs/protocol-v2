use anchor_client::solana_client::pubsub_client::PubsubClient;
use anchor_client::solana_client::rpc_client::RpcClient;
use anchor_client::solana_client::rpc_config::{RpcAccountInfoConfig, RpcProgramAccountsConfig};
use anchor_client::solana_client::rpc_filter::{Memcmp, RpcFilterType};
use anchor_client::solana_sdk::account::Account;
use anchor_client::Program;
use anchor_lang::prelude::Pubkey;
use anchor_lang::{AccountDeserialize, Discriminator};
use parking_lot::Mutex;
use std::collections::HashMap;
use std::str::FromStr;
use std::sync::Arc;

use drift::state::perp_market::PerpMarket;
use drift::state::spot_market::SpotMarket;
use solana_account_decoder::UiAccountEncoding;

use crate::types::{
    get_user_pubkey_pda, AccountDataWithSlot, DriftClientAccountSubscriber,
    DriftClientAccountSubscriberCommon,
};

pub struct WebsocketAccountSubscriber {
    common: DriftClientAccountSubscriberCommon,
    rpc_client: Arc<RpcClient>,
    ws_url: String,
    program: Program,
}

impl WebsocketAccountSubscriber {
    pub fn new(
        rpc_client: Arc<RpcClient>,
        ws_url: String,
        program: Program,
        perp_market_indexes_to_watch: Option<Vec<u16>>,
        spot_market_indexes_to_watch: Option<Vec<u16>>,
        authority_to_subaccount_ids_to_watch: Option<HashMap<Pubkey, Vec<u16>>>,
    ) -> Self {
        Self {
            common: DriftClientAccountSubscriberCommon {
                // perp_market_indexes_to_watch: perp_market_indexes_to_watch.clone(),
                // spot_market_indexes_to_watch: spot_market_indexes_to_watch.clone(),
                // authority_to_subaccount_ids_to_watch: authority_to_subaccount_ids_to_watch.clone(),
                // perp_market_accounts: Arc::new(Mutex::new(HashMap::new())),
                // spot_market_accounts: Arc::new(Mutex::new(HashMap::new())),
                // user_accounts: Arc::new(Mutex::new(HashMap::new())),
                // program_id: program.id(),
                program_id: program.id(),
                perp_market_indexes_to_watch: perp_market_indexes_to_watch.clone(),
                spot_market_indexes_to_watch: spot_market_indexes_to_watch.clone(),
                authority_to_subaccount_ids_to_watch: authority_to_subaccount_ids_to_watch.clone(),

                ..Default::default()
            },
            rpc_client,
            ws_url,
            program,
        }
    }

    /// Loads market accounts data from the RPC node (fetch via http), then sets up websocket connections that
    /// update the account data as it's pushed from the node.
    ///
    /// This method refers to self.common.perp_market_indexes_to_watch and self.common.spot_market_indexes_to_watch to determine
    /// which markets to load.
    /// * If the corresponding field is None, then no markets will be loaded.
    /// * If the field is Some(vec![]), then all markets will be loaded.
    /// * (TODO) If the field is Some(vec![1, 2, 3]), then only markets with indexes 1, 2, and 3 will be loaded.
    fn load_market_accounts(&mut self) -> Result<(), anyhow::Error> {
        if self.common.perp_market_indexes_to_watch.is_some() {
            match self.program.accounts::<PerpMarket>(vec![]) {
                Ok(markets) => {
                    let markets_map: HashMap<Pubkey, AccountDataWithSlot<PerpMarket>> = markets
                        .into_iter()
                        .map(|m| {
                            (
                                m.0,
                                AccountDataWithSlot {
                                    data: m.1,
                                    slot: None,
                                },
                            )
                        })
                        .collect();
                    self.common.perp_market_accounts = Arc::new(Mutex::new(markets_map));
                }
                Err(err) => {
                    println!("Error: {:?}", err);
                    return Err(anyhow::Error::msg("Error loading perp markets"));
                }
            };
        }

        if self.common.spot_market_indexes_to_watch.is_some() {
            match self.program.accounts::<SpotMarket>(vec![]) {
                Ok(markets) => {
                    let markets_map: HashMap<Pubkey, AccountDataWithSlot<SpotMarket>> = markets
                        .into_iter()
                        .map(|m| {
                            (
                                m.0,
                                AccountDataWithSlot {
                                    data: m.1,
                                    slot: None,
                                },
                            )
                        })
                        .collect();
                    self.common.spot_market_accounts = Arc::new(Mutex::new(markets_map));
                }
                Err(err) => {
                    println!("Error: {:?}", err);
                    return Err(anyhow::Error::msg("Error loading spot markets"));
                }
            };
        }

        // make websocket subscriptions
        // TODO: catch connection problems and reconnect
        let ws_url = self.ws_url.clone();
        let program_id = self.common.program_id.clone();
        let accounts_cache = self.common.clone();
        std::thread::spawn(move || {
            match PubsubClient::program_subscribe(
                ws_url.as_str(),
                &program_id,
                Some(RpcProgramAccountsConfig {
                    filters: Some(vec![RpcFilterType::Memcmp(Memcmp::new_raw_bytes(
                        0,
                        PerpMarket::discriminator().to_vec(),
                    ))]),
                    account_config: RpcAccountInfoConfig {
                        encoding: Some(UiAccountEncoding::Base64),
                        ..RpcAccountInfoConfig::default()
                    },
                    with_context: Some(true),
                }),
            ) {
                Ok(sub) => {
                    println!("Websocket subscription successful");
                    loop {
                        match sub.1.recv() {
                            Ok(msg) => {
                                let pubkey = Pubkey::from_str(msg.value.pubkey.as_str()).unwrap();
                                let mut perp_market_map =
                                    accounts_cache.perp_market_accounts.lock();
                                match perp_market_map.get(&pubkey) {
                                    Some(market) => {
                                        let last_slot = market.slot.unwrap_or(0);
                                        if msg.context.slot >= last_slot {
                                            let acc: Account = msg.value.account.decode().unwrap();
                                            let p = PerpMarket::try_deserialize(
                                                &mut (&acc.data as &[u8]),
                                            )
                                            .unwrap();
                                            println!(
                                                "  updating ({} -> {}) {}",
                                                last_slot,
                                                msg.context.slot,
                                                String::from_utf8_lossy(&p.name)
                                            );
                                            perp_market_map.insert(
                                                pubkey,
                                                AccountDataWithSlot {
                                                    data: p,
                                                    slot: Some(msg.context.slot),
                                                },
                                            );
                                        } else {
                                            println!("old data on perp market")
                                        }
                                    }
                                    None => {
                                        println!("Error: perp market not found");
                                    }
                                }
                            }
                            Err(err) => {
                                println!("Websocket error: {:?}", err.to_string());
                                return;
                            }
                        }
                    }
                }
                Err(err) => {
                    // return Err(anyhow::Error::msg(format!("Error subscribing to websocket: {:?}", err)));
                    println!("Error subscribing to websocket: {:?}", err);
                    return;
                }
            }
        });

        let ws_url = self.ws_url.clone();
        let program_id = self.common.program_id;
        // let mut spot_market_map = self.common.spot_market_accounts.as_ref().clone();
        let accounts_cache = self.common.clone();
        std::thread::spawn(move || {
            match PubsubClient::program_subscribe(
                ws_url.as_str(),
                &program_id,
                Some(RpcProgramAccountsConfig {
                    filters: Some(vec![RpcFilterType::Memcmp(Memcmp::new_raw_bytes(
                        0,
                        SpotMarket::discriminator().to_vec(),
                    ))]),
                    account_config: RpcAccountInfoConfig {
                        encoding: Some(UiAccountEncoding::Base64),
                        ..RpcAccountInfoConfig::default()
                    },
                    with_context: Some(true),
                }),
            ) {
                Ok(sub) => {
                    println!("Websocket subscription successful");
                    loop {
                        match sub.1.recv() {
                            Ok(msg) => {
                                let pubkey = Pubkey::from_str(msg.value.pubkey.as_str()).unwrap();
                                let mut spot_market_map =
                                    accounts_cache.spot_market_accounts.lock();
                                match spot_market_map.get(&pubkey) {
                                    Some(market) => {
                                        let last_slot = market.slot.unwrap_or(0);
                                        if msg.context.slot >= last_slot {
                                            let acc: Account = msg.value.account.decode().unwrap();
                                            let p = SpotMarket::try_deserialize(
                                                &mut (&acc.data as &[u8]),
                                            )
                                            .unwrap();
                                            println!(
                                                "  updating ({} -> {}) {}",
                                                last_slot,
                                                msg.context.slot,
                                                String::from_utf8_lossy(&p.name)
                                            );
                                            spot_market_map.insert(
                                                pubkey,
                                                AccountDataWithSlot {
                                                    data: p,
                                                    slot: Some(msg.context.slot),
                                                },
                                            );
                                        } else {
                                            println!("old data on spot market")
                                        }
                                    }
                                    None => {
                                        println!("Error: spot market not found");
                                    }
                                }
                            }
                            Err(err) => {
                                println!("Websocket error: {:?}", err.to_string());
                                return;
                            }
                        }
                    }
                }
                Err(err) => {
                    // return Err(anyhow::Error::msg(format!("Error subscribing to websocket: {:?}", err)));
                    println!("Error subscribing to websocket: {:?}", err);
                    return;
                }
            }
        });

        Ok(())
    }

    /// Loads market accounts data from the RPC node (fetch via http), then sets up websocket connections that
    /// update the account data as it's pushed from the node.
    ///
    /// This method refers to self.common.perp_market_indexes_to_watch and self.common.spot_market_indexes_to_watch to determine
    /// which markets to load.
    /// * If the corresponding field is None, then no markets will be loaded.
    /// * If the field is Some(vec![]), then all markets will be loaded.
    /// * If the field is Some(vec![1, 2, 3]), then only markets with indexes 1, 2, and 3 will be loaded.
    fn load_user_accounts(&mut self) -> Result<(), anyhow::Error> {
        if self.common.authority_to_subaccount_ids_to_watch.is_none() {
            println!(
                "No authority_to_subaccount_ids_to_watch specified, not loading any user accounts"
            );
            return Ok(());
        }

        let user_keys = get_user_pubkeys_to_load(
            self.common
                .authority_to_subaccount_ids_to_watch
                .clone()
                .unwrap(),
            self.program.id(),
        );

        Ok(())
    }
}

impl DriftClientAccountSubscriber for WebsocketAccountSubscriber {
    fn load(&mut self) -> Result<(), anyhow::Error> {
        println!("WebsocketAccountSubscriber::load() called");
        match self.rpc_client.get_slot() {
            Ok(slot) => println!("WS LOADER: Current slot: {:?}", slot),
            Err(err) => println!("Error: {:?}", err),
        }

        self.load_market_accounts()?;

        Ok(())
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

    fn get_user(&self, authority: &Pubkey, subaccount_id: u16) -> Option<drift::state::user::User> {
        self.common.get_user(authority, subaccount_id)
    }
}

fn get_user_pubkeys_to_load(
    authority_to_subaccount_ids_to_watch: HashMap<Pubkey, Vec<u16>>,
    program_id: Pubkey,
) -> Vec<Pubkey> {
    authority_to_subaccount_ids_to_watch
        .iter()
        .map(|(authority, subaccount_ids)| {
            match subaccount_ids.len() {
                0 => {
                    // default will just load subaccount id 0
                    vec![get_user_pubkey_pda(program_id, authority, 0)]
                }
                _ => {
                    // else load specified subaccount ids
                    subaccount_ids
                        .iter()
                        .map(|subaccount_id| {
                            get_user_pubkey_pda(program_id, authority, *subaccount_id)
                        })
                        .collect::<Vec<Pubkey>>()
                }
            }
        })
        .flatten()
        .collect::<Vec<Pubkey>>()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_get_user_pubkeys_to_load() {
        let auth_to_subaccount_ids: HashMap<Pubkey, Vec<u16>> = [
            (
                Pubkey::from_str("CTh4Q6xooiaJMWCwKP5KLQ4j7X3NEJPf3Uq6rX8UsKSi").unwrap(),
                vec![0, 1, 2],
            ),
            (
                Pubkey::from_str("EWEWa4jZANb7VmDD6E3KHVkvUceHQQkeTANrJtb9P7dw").unwrap(),
                vec![0, 1, 2],
            ),
        ]
        .iter()
        .cloned()
        .collect();

        let auth_to_no_subaccount_ids: HashMap<Pubkey, Vec<u16>> = [
            (
                Pubkey::from_str("CTh4Q6xooiaJMWCwKP5KLQ4j7X3NEJPf3Uq6rX8UsKSi").unwrap(),
                vec![],
            ),
            (
                Pubkey::from_str("EWEWa4jZANb7VmDD6E3KHVkvUceHQQkeTANrJtb9P7dw").unwrap(),
                vec![],
            ),
        ]
        .iter()
        .cloned()
        .collect();

        let program_id = Pubkey::from_str("dRiftyHA39MWEi3m9aunc5MzRF1JYuBsbn6VPcn33UH").unwrap();

        let pubkeys_a = get_user_pubkeys_to_load(auth_to_subaccount_ids, program_id);
        assert!(pubkeys_a.len() == 6);
        // at least one of the pubkeys should be h5jfag
        assert!(pubkeys_a.iter().any(|pubkey| *pubkey
            == Pubkey::from_str("H5jfagEnMVNH3PMc2TU2F7tNuXE6b4zCwoL5ip1b4ZHi").unwrap()));
        assert!(pubkeys_a.iter().any(|pubkey| *pubkey
            == Pubkey::from_str("76YFECDc5MWvks3sYsaW1ULDyXgXEnATp22nCgLH44WF").unwrap()));

        let pubkeys_b = get_user_pubkeys_to_load(auth_to_no_subaccount_ids, program_id);
        assert!(pubkeys_b.len() == 2);
        assert!(pubkeys_b.iter().any(|pubkey| *pubkey
            == Pubkey::from_str("H5jfagEnMVNH3PMc2TU2F7tNuXE6b4zCwoL5ip1b4ZHi").unwrap()));
        assert!(pubkeys_b.iter().any(|pubkey| *pubkey
            == Pubkey::from_str("76YFECDc5MWvks3sYsaW1ULDyXgXEnATp22nCgLH44WF").unwrap()));
    }
}
