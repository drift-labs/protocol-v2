use std::rc::Rc;
use std::str::FromStr;

use anchor_client::solana_client::rpc_client::RpcClient;
use anchor_client::solana_sdk::commitment_config::{CommitmentConfig, CommitmentLevel};
use anchor_client::solana_sdk::pubkey::Pubkey;
use anchor_client::solana_sdk::signature::Keypair;
use anchor_client::{Client, Cluster, Program};

use crate::utils::http_to_ws_url;

pub struct DriftClient {
    // to interact with the chain
    pub cluster: Cluster,
    pub provider: Client,
    pub program: Program,
    pub rpc_client: RpcClient,
    // on chain accounts
    // pub perp_markets
}

impl DriftClient {
    pub fn builder() -> DriftClientBuilder {
        DriftClientBuilder::default()
    }
}

pub struct DriftClientBuilder {
    pub cluster: Cluster,
    pub commitment: CommitmentLevel,
    pub drift_program_id: Pubkey,
    pub rpc_http_url: Option<String>,
    pub rpc_ws_url: Option<String>,
    pub signing_authority: Option<Keypair>,
    pub readonly_authority: Option<Pubkey>,
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

    pub fn signing_authority(mut self, authority: Keypair) -> Self {
        self.signing_authority = Some(authority);
        self
    }

    pub fn readonly_authority(mut self, authority: Pubkey) -> Self {
        self.readonly_authority = Some(authority);
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
        let rpc_client = RpcClient::new_with_commitment(
            cluster.url(),
            CommitmentConfig {
                commitment: self.commitment,
            },
        );

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

        Ok(DriftClient {
            cluster,
            program: provider.program(self.drift_program_id),
            provider,
            rpc_client,
        })
    }
}

/// OnChainAccount is a trait implemented by account data that is stored on chain and
/// cached locally.
trait OnChainAccount {
    /// update the account with the latest data
    fn update<T>(&mut self, pubkey: Pubkey, slot_updated: u64, data: T) -> Result<(), T>;
}
