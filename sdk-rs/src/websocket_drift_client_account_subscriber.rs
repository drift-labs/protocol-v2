use anchor_client::solana_client::pubsub_client::PubsubClient;
use anchor_client::solana_client::rpc_client::RpcClient;
use anchor_client::solana_client::rpc_config::{RpcAccountInfoConfig, RpcProgramAccountsConfig};
use anchor_client::solana_client::rpc_filter::{Memcmp, RpcFilterType};
use anchor_client::solana_sdk::account::Account;
use anchor_client::solana_sdk::commitment_config::{CommitmentConfig, CommitmentLevel};
use anchor_client::Program;
use anchor_lang::prelude::Pubkey;
use anchor_lang::{AccountDeserialize, Discriminator};
use drift::state::user::User;
use parking_lot::Mutex;
use std::collections::HashMap;
use std::fmt::Debug;
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
        commitment: CommitmentLevel,
        program: Program,
        perp_market_indexes_to_watch: Option<Vec<u16>>,
        spot_market_indexes_to_watch: Option<Vec<u16>>,
        authority_to_subaccount_ids_to_watch: Option<HashMap<Pubkey, Vec<u16>>>,
    ) -> Self {
        Self {
            common: DriftClientAccountSubscriberCommon {
                program_id: program.id(),
                commitment,
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

    fn load_market_account<
        T: 'static + AccountDeserialize + Discriminator + std::marker::Send + Clone + Debug,
    >(
        &self,
        market_indexes_to_watch: &Option<Vec<u16>>,
        accounts_map: &Arc<Mutex<HashMap<Pubkey, AccountDataWithSlot<T>>>>,
    ) -> Result<(), anyhow::Error> {
        // hydrate market map
        if market_indexes_to_watch.is_some() {
            match self.program.accounts::<T>(vec![]) {
                Ok(markets) => {
                    let markets_map: HashMap<Pubkey, AccountDataWithSlot<T>> = markets
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
                    *accounts_map.lock() = markets_map;
                }
                Err(err) => {
                    println!("Error: {:?}", err);
                    return Err(anyhow::Error::msg(format!(
                        "Error loading {:?} markets",
                        std::any::type_name::<T>()
                    )));
                }
            };
        }

        // make websocket subscription to update the map
        // TODO: catch connection problems and reconnect
        let ws_url = self.ws_url.clone();
        let program_id = self.common.program_id.clone();
        let accounts_map = Arc::clone(accounts_map);
        let commitment = self.common.commitment.clone();
        std::thread::spawn(move || {
            match PubsubClient::program_subscribe(
                ws_url.as_str(),
                &program_id,
                Some(RpcProgramAccountsConfig {
                    filters: Some(vec![RpcFilterType::Memcmp(Memcmp::new_raw_bytes(
                        0,
                        T::discriminator().to_vec(),
                    ))]),
                    account_config: RpcAccountInfoConfig {
                        encoding: Some(UiAccountEncoding::Base64),
                        commitment: Some(CommitmentConfig { commitment }),
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
                                let mut market_map = accounts_map.lock();
                                match market_map.get(&pubkey) {
                                    Some(market) => {
                                        let last_slot = market.slot.unwrap_or(0);
                                        if msg.context.slot >= last_slot {
                                            let acc: Account = msg.value.account.decode().unwrap();
                                            let p = T::try_deserialize(&mut (&acc.data as &[u8]))
                                                .unwrap();
                                            market_map.insert(
                                                pubkey,
                                                AccountDataWithSlot {
                                                    data: p,
                                                    slot: Some(msg.context.slot),
                                                },
                                            );
                                        } else {
                                            println!(
                                                "Updating old data on {:?} markets",
                                                std::any::type_name::<T>()
                                            );
                                        }
                                    }
                                    None => {
                                        println!(
                                            "Error: {:?} market not found",
                                            std::any::type_name::<T>()
                                        );
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
    /// * (TODO) If the field is Some(vec![1, 2, 3]), then only markets with indexes 1, 2, and 3 will be loaded.
    fn load_market_accounts(&mut self) -> Result<(), anyhow::Error> {
        // TODO: i think we can actually just store raw bytes in the maps like perp_market_accounts
        // and spot_market_accounts, and lazily deserialize it as needed. this would save a lot of
        // memory, and we could also just store the slot in the map instead of the whole context.
        //
        // but separating the maps by market type helps with lock contention i guess...

        self.load_market_account::<PerpMarket>(
            &self.common.perp_market_indexes_to_watch,
            &self.common.perp_market_accounts,
        )?;

        self.load_market_account::<SpotMarket>(
            &self.common.spot_market_indexes_to_watch,
            &self.common.spot_market_accounts,
        )?;

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
        } else {
            println!(
                "Loading user accounts: {:?}",
                self.common
                    .authority_to_subaccount_ids_to_watch
                    .as_ref()
                    .unwrap()
            );
        }

        let user_pubkeys = get_user_pubkeys_to_load(
            self.common
                .authority_to_subaccount_ids_to_watch
                .clone()
                .unwrap(),
            self.program.id(),
        );

        match self.rpc_client.get_multiple_accounts_with_config(
            &user_pubkeys,
            RpcAccountInfoConfig {
                encoding: Some(UiAccountEncoding::Base64),
                ..RpcAccountInfoConfig::default()
            },
        ) {
            Ok(accounts) => {
                let mut user_accounts_map: HashMap<Pubkey, AccountDataWithSlot<User>> =
                    HashMap::new();
                for account in accounts.value {
                    match account {
                        Some(account) => {
                            let p = User::try_deserialize(&mut (&account.data as &[u8])).unwrap();
                            let user_key = get_user_pubkey_pda(
                                self.program.id(),
                                &p.authority,
                                p.sub_account_id,
                            );
                            user_accounts_map.insert(
                                user_key,
                                AccountDataWithSlot {
                                    data: p,
                                    slot: Some(accounts.context.slot),
                                },
                            );
                        }
                        None => {
                            println!("Error: account not found");
                            continue;
                        }
                    }
                }
                self.common.user_accounts = Arc::new(Mutex::new(user_accounts_map));
            }
            Err(err) => {
                println!("Error: {:?}", err);
                return Err(anyhow::Error::msg("Error loading user accounts"));
            }
        };

        // make websocket subscription to update the map
        // TODO: catch connection problems and reconnect
        // TODO: this might be a problem, i think it opens up individual websocket connectsion for each account
        let ws_url = self.ws_url.clone();
        // let program_id = self.common.program_id.clone();
        // let accounts_cache = self.common.clone();
        let user_accounts_map = Arc::clone(&self.common.user_accounts);
        let pubkey = user_pubkeys[0].clone();
        let commitment = self.common.commitment.clone();
        std::thread::spawn(move || {
            match PubsubClient::account_subscribe(
                ws_url.as_str(),
                &pubkey,
                Some(RpcAccountInfoConfig {
                    encoding: Some(UiAccountEncoding::Base64),
                    commitment: Some(CommitmentConfig { commitment }),
                    ..RpcAccountInfoConfig::default()
                }),
            ) {
                Ok(sub) => {
                    println!("Websocket subscription successful");
                    loop {
                        match sub.1.recv() {
                            Ok(msg) => {
                                // let pubkey = Pubkey::from_str(msg.value.pubkey.as_str()).unwrap();
                                let mut user_accounts_map = user_accounts_map.lock();
                                match user_accounts_map.get(&pubkey) {
                                    Some(market) => {
                                        let last_slot = market.slot.unwrap_or(0);
                                        if msg.context.slot >= last_slot {
                                            let acc: Account = msg.value.decode().unwrap();
                                            let p =
                                                User::try_deserialize(&mut (&acc.data as &[u8]))
                                                    .unwrap();
                                            user_accounts_map.insert(
                                                pubkey,
                                                AccountDataWithSlot {
                                                    data: p,
                                                    slot: Some(msg.context.slot),
                                                },
                                            );
                                        } else {
                                            println!(
                                                "Updating old data on {:?} markets",
                                                std::any::type_name::<User>()
                                            );
                                        }
                                    }
                                    None => {
                                        println!(
                                            "Error: {:?} market not found",
                                            std::any::type_name::<User>()
                                        );
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
                    println!("Error subscribing to websocket: {:?}", err);
                    return;
                }
            }
        });

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
        self.load_user_accounts()?;

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
