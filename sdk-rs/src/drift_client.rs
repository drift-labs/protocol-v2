use std::rc::Rc;
use std::str::FromStr;
use std::sync::Arc;

use anchor_client::solana_client::rpc_client::RpcClient;
use anchor_client::solana_sdk::commitment_config::{CommitmentConfig, CommitmentLevel};
use anchor_client::solana_sdk::pubkey::Pubkey;
use anchor_client::solana_sdk::signature::Keypair;
use anchor_client::solana_sdk::signature::Signer;
use anchor_client::{Client, Cluster, Program};

use crate::types::DriftClientAccountSubscriber;
use crate::utils::http_to_ws_url;
use crate::websocket_drift_client_account_subscriber::WebsocketAccountSubscriber;

pub struct DriftClient {
    // to interact with the chain
    pub cluster: Cluster,
    pub provider: Client,
    pub program: Program,
    pub rpc_client: Arc<RpcClient>,

    // pub perp_market_indexes_to_watch: Option<Vec<u16>>,
    // pub spot_market_indexes_to_watch: Option<Vec<u16>>,
    // pub sub_account_ids_to_watch: Option<Vec<u16>>,
    pub account_subscriber: Box<dyn DriftClientAccountSubscriber>,
}

impl DriftClient {
    pub fn builder() -> DriftClientBuilder {
        DriftClientBuilder::default()
    }

    /// Loads on-chain accounts into the load drift client, you should call this after builder.build()
    pub fn load(&mut self) -> Result<(), anyhow::Error> {
        self.account_subscriber.load()
    }
}

pub struct DriftClientBuilder {
    pub cluster: Cluster,
    pub commitment: CommitmentLevel,
    pub drift_program_id: Pubkey,
    pub rpc_http_url: Option<String>,
    pub rpc_ws_url: Option<String>,

    /// A signing_authority can be provided if you want to sign transactions
    pub signing_authority: Option<Keypair>,

    /// A readonly_authority can be provided if you only want to read a certain user account's data
    pub readonly_authority: Option<Pubkey>,

    // pub perp_market_indexes_to_watch: Option<Vec<u16>>,
    // pub spot_market_indexes_to_watch: Option<Vec<u16>>,
    // pub sub_account_ids_to_watch: Option<Vec<u16>>,
    pub drift_client_account_subscriber: Option<Box<dyn DriftClientAccountSubscriber>>,
}

impl Default for DriftClientBuilder {
    fn default() -> Self {
        Self {
            cluster: Cluster::Mainnet,
            commitment: CommitmentLevel::Confirmed,
            drift_program_id: Pubkey::from_str("dRiftyHA39MWEi3m9aunc5MzRF1JYuBsbn6VPcn33UH")
                .unwrap(),
            rpc_http_url: None,
            rpc_ws_url: None,
            signing_authority: None,
            readonly_authority: None,
            // perp_market_indexes_to_watch: None,
            // spot_market_indexes_to_watch:  None,
            // sub_account_ids_to_watch:  None,
            drift_client_account_subscriber: None,
        }
    }
}

impl DriftClientBuilder {
    pub fn cluster(mut self, cluster: Cluster) -> Self {
        self.cluster = cluster;
        self
    }

    pub fn drift_program_id(mut self, program_id: Pubkey) -> Self {
        self.drift_program_id = program_id;
        self
    }

    pub fn rpc_http_url(mut self, url: String) -> Self {
        self.rpc_http_url = Some(url);
        self
    }

    pub fn rpc_ws_url(mut self, url: String) -> Self {
        self.rpc_ws_url = Some(url);
        self
    }

    pub fn commitment(mut self, commitment: CommitmentLevel) -> Self {
        self.commitment = commitment;
        self
    }

    pub fn signing_authority(mut self, authority: Keypair) -> Self {
        self.signing_authority = Some(authority);
        self
    }

    pub fn readonly_authority(mut self, authority: Pubkey) -> Self {
        self.readonly_authority = Some(authority);
        self
    }

    pub fn drift_client_account_subscriber(
        mut self,
        account_subscriber: Box<dyn DriftClientAccountSubscriber>,
    ) -> Self {
        self.drift_client_account_subscriber = Some(account_subscriber);
        self
    }

    pub fn build(self) -> Result<DriftClient, &'static str> {
        if self.signing_authority.is_none() && self.readonly_authority.is_none() {
            return Err("signing_authority or readonly_authority is required");
        }

        let cluster: Cluster = if self.rpc_http_url.is_some() {
            let rpc_http_url = self.rpc_http_url.unwrap();
            Cluster::Custom(
                rpc_http_url.clone(),
                self.rpc_ws_url
                    .unwrap_or(http_to_ws_url(rpc_http_url.as_str())),
            )
        } else {
            self.cluster
        };
        let rpc_client = Arc::new(RpcClient::new_with_commitment(
            cluster.url(),
            CommitmentConfig {
                commitment: self.commitment,
            },
        ));

        let user_to_load = if self.readonly_authority.is_some() {
            self.readonly_authority.unwrap()
        } else {
            self.signing_authority.as_ref().unwrap().pubkey()
        };

        let provider = Client::new_with_options(
            cluster.clone(),
            if self.signing_authority.is_some() {
                Rc::new(self.signing_authority.unwrap())
            } else {
                Rc::new(Keypair::new())
            },
            CommitmentConfig {
                commitment: CommitmentLevel::Confirmed,
            },
        );

        let account_subscriber: Box<dyn DriftClientAccountSubscriber> =
            if self.drift_client_account_subscriber.is_some() {
                self.drift_client_account_subscriber.unwrap()
            } else {
                Box::new(WebsocketAccountSubscriber::new(
                    rpc_client.clone(),
                    cluster.ws_url().to_string(),
                    self.commitment,
                    provider.program(self.drift_program_id),
                    Some(vec![]),
                    Some(vec![]),
                    Some(vec![user_to_load]),
                )) as Box<dyn DriftClientAccountSubscriber>
            };

        Ok(DriftClient {
            cluster,
            program: provider.program(self.drift_program_id),
            provider,
            rpc_client,

            // perp_market_indexes_to_watch: self.perp_market_indexes_to_watch,
            // spot_market_indexes_to_watch: self.spot_market_indexes_to_watch,
            // sub_account_ids_to_watch: self.sub_account_ids_to_watch,
            account_subscriber,
        })
    }
}
