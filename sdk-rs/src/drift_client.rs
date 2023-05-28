use std::rc::Rc;

use anchor_client::solana_client::rpc_client::RpcClient;
use anchor_client::solana_sdk::commitment_config::{CommitmentConfig, CommitmentLevel};
use anchor_client::solana_sdk::pubkey::Pubkey;
use anchor_client::solana_sdk::signature::Keypair;
use anchor_client::{Client, Cluster};

use crate::utils::http_to_ws_url;

pub struct DriftClient {
    pub provider: Client,
    pub rpc_client: RpcClient,
    pub rpc_http_url: String,
    pub rpc_ws_url: String,
}

impl DriftClient {
    pub fn builder() -> DriftClientBuilder {
        DriftClientBuilder::default()
    }
}

pub struct DriftClientBuilder {
    pub cluster: Cluster,
    pub commitment: CommitmentLevel,
    pub rpc_http_url: String,
    pub rpc_ws_url: Option<String>,
    pub signing_authority: Option<Keypair>,
    pub readonly_authority: Option<Pubkey>,
}

impl Default for DriftClientBuilder {
    fn default() -> Self {
        Self {
            cluster: Cluster::Mainnet,
            commitment: CommitmentLevel::Confirmed,
            rpc_http_url: Cluster::Mainnet.url().to_string(),
            rpc_ws_url: Some(Cluster::Mainnet.ws_url().to_string()),
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

    pub fn rpc_http_url(mut self, url: String) -> Self {
        self.rpc_http_url = url;
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

        let rpc_client = RpcClient::new_with_commitment(
            self.rpc_http_url.clone(),
            CommitmentConfig {
                commitment: self.commitment,
            },
        );

        let rpc_ws_url = if self.rpc_ws_url.is_some() {
            http_to_ws_url(self.rpc_http_url.as_str())
        } else {
            self.rpc_ws_url.unwrap()
        };

        Ok(DriftClient {
            rpc_client,
            rpc_http_url: self.rpc_http_url,
            rpc_ws_url,
            provider: Client::new_with_options(
                self.cluster,
                if self.signing_authority.is_some() {
                    Rc::new(self.signing_authority.unwrap())
                } else {
                    Rc::new(Keypair::new())
                },
                CommitmentConfig {
                    commitment: CommitmentLevel::Confirmed,
                },
            ),
        })
    }
}
