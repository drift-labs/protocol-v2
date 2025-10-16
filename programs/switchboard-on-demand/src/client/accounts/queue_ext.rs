// Client-specific extensions for QueueAccountData
use super::super::lut_owner::LutOwner;
use super::super::gateway::Gateway;
use super::super::crossbar::CrossbarClient;
use crate::on_demand::accounts::QueueAccountData;
use crate::RpcClient;
use crate::Pubkey;
use anyhow::{anyhow, Context};
use anyhow::Error as AnyhowError;
use futures::future::join_all;

// Client-specific trait implementation
impl LutOwner for QueueAccountData {
    fn lut_slot(&self) -> u64 {
        self.lut_slot
    }
}

impl QueueAccountData {
    /// Loads queue data from on-chain
    pub async fn load(client: &RpcClient, key: &Pubkey) -> Result<QueueAccountData, AnyhowError> {
        let key_anchor: anchor_client::solana_sdk::pubkey::Pubkey = key.to_bytes().into();
        let account = client
            .get_account_data(&key_anchor)
            .await
            .map_err(|_| anyhow!("QueueAccountData.load: Account not found"))?;
        let buf = account[8..].to_vec();
        let parsed: &QueueAccountData = bytemuck::try_from_bytes(&buf)
            .map_err(|e| anyhow!("Failed to parse QueueAccountData: {:?}", e))?;
        Ok(*parsed)
    }

    /// Fetches all gateways from the oracle accounts and tests them to see if they are reachable.
    /// Returns a list of reachable gateways.
    /// # Arguments
    /// * `client` - The RPC client to use for fetching the oracle accounts.
    /// # Returns
    /// A list of reachable gateways.
    pub async fn fetch_gateways(&self, client: &RpcClient) -> Result<Vec<Gateway>, AnyhowError> {
        let oracles = self.fetch_oracles(client).await?;
        let gateways = oracles
            .into_iter()
            .map(|x| x.1)
            .filter_map(|x| x.gateway_uri())
            .map(Gateway::new)
            .collect::<Vec<_>>();

        let mut test_futures = Vec::new();
        for gateway in gateways.iter() {
            test_futures.push(gateway.test_gateway());
        }
        let results = join_all(test_futures).await;
        let mut good_gws = Vec::new();
        for (i, is_good) in results.into_iter().enumerate() {
            if is_good {
                good_gws.push(gateways[i].clone());
            }
        }
        Ok(good_gws)
    }

    /// Fetches a gateway from the crossbar service
    ///
    /// # Arguments
    /// * `crossbar` - The crossbar client to use for fetching gateways
    ///
    /// # Returns
    /// * `Result<Gateway, AnyhowError>` - A Gateway instance ready for use
    pub async fn fetch_gateway_from_crossbar(&self, crossbar: &CrossbarClient) -> Result<Gateway, AnyhowError> {
        // Default to mainnet, but this could be made configurable
        let network = "mainnet";

        // Fetch gateways for the network
        let gateways = crossbar.fetch_gateways(network).await
            .context("Failed to fetch gateways from crossbar")?;

        let gateway_url = gateways
            .first()
            .ok_or_else(|| anyhow!("No gateways available for network: {}", network))?;

        Ok(Gateway::new(gateway_url.clone()))
    }
}

/// Higher-level Queue struct that matches the JavaScript pattern
///
/// This struct represents a queue instance with a specific pubkey,
/// similar to the JavaScript Queue class which has a program and pubkey.
pub struct Queue {
    pub pubkey: Pubkey,
    pub client: RpcClient,
}

impl Queue {
    /// Default devnet queue key
    pub const DEFAULT_DEVNET_KEY: &'static str = "EYiAmGSdsQTuCw413V5BzaruWuCCSDgTPtBGvLkXHbe7";

    /// Default mainnet queue key
    pub const DEFAULT_MAINNET_KEY: &'static str = "A43DyUGA7s8eXPxqEjJY6EBu1KKbNgfxF8h17VAHn13w";

    /// Creates a new Queue instance
    ///
    /// # Arguments
    /// * `client` - RPC client for Solana connections
    /// * `pubkey` - The public key of the queue account
    pub fn new(client: RpcClient, pubkey: Pubkey) -> Self {
        Self { pubkey, client }
    }

    /// Creates a Queue instance with the default mainnet key
    ///
    /// # Arguments
    /// * `client` - RPC client for Solana connections
    pub fn default_mainnet(client: RpcClient) -> Result<Self, AnyhowError> {
        let pubkey_str = Self::DEFAULT_MAINNET_KEY;
        let bytes: [u8; 32] = bs58::decode(pubkey_str)
            .into_vec()
            .map_err(|e| anyhow!("Failed to decode mainnet queue key: {}", e))?
            .try_into()
            .map_err(|_| anyhow!("Invalid mainnet queue key length"))?;
        let pubkey = Pubkey::new_from_array(bytes);
        Ok(Self::new(client, pubkey))
    }

    /// Creates a Queue instance with the default devnet key
    ///
    /// # Arguments
    /// * `client` - RPC client for Solana connections
    pub fn default_devnet(client: RpcClient) -> Result<Self, AnyhowError> {
        let pubkey_str = Self::DEFAULT_DEVNET_KEY;
        let bytes: [u8; 32] = bs58::decode(pubkey_str)
            .into_vec()
            .map_err(|e| anyhow!("Failed to decode devnet queue key: {}", e))?
            .try_into()
            .map_err(|_| anyhow!("Invalid devnet queue key length"))?;
        let pubkey = Pubkey::new_from_array(bytes);
        Ok(Self::new(client, pubkey))
    }

    /// Loads the queue data from on-chain
    ///
    /// # Returns
    /// * `Result<QueueAccountData, AnyhowError>` - The queue account data
    pub async fn load_data(&self) -> Result<QueueAccountData, AnyhowError> {
        QueueAccountData::load(&self.client, &self.pubkey).await
    }

    /// Fetches a gateway from the crossbar service, automatically detecting network
    ///
    /// This method matches the JavaScript implementation exactly:
    /// 1. Tries to load data from the default mainnet queue
    /// 2. If that fails, assumes devnet
    /// 3. Fetches available gateways for the detected network
    /// 4. Returns the first gateway
    ///
    /// # Arguments
    /// * `crossbar` - The crossbar client to use for fetching gateways
    ///
    /// # Returns
    /// * `Result<Gateway, AnyhowError>` - A Gateway instance ready for use
    ///
    /// # Example
    /// ```rust,no_run
    /// use switchboard_on_demand::client::{CrossbarClient, Queue};
    /// use switchboard_on_demand::RpcClient;
    ///
    /// # async fn example() -> Result<(), Box<dyn std::error::Error>> {
    /// let client = RpcClient::new("https://api.mainnet-beta.solana.com".to_string());
    /// let queue = Queue::default_mainnet(client)?;
    /// let crossbar = CrossbarClient::default();
    /// let gateway = queue.fetch_gateway_from_crossbar(&crossbar).await?;
    /// # Ok(())
    /// # }
    /// ```
    pub async fn fetch_gateway_from_crossbar(&self, crossbar: &CrossbarClient) -> Result<Gateway, AnyhowError> {
        let mut network = "mainnet";

        // Try to load data from the default mainnet queue to detect network
        let mainnet_client = RpcClient::new(self.client.url());
        let mainnet_queue = Queue::default_mainnet(mainnet_client)?;

        if mainnet_queue.load_data().await.is_err() {
            network = "devnet";
        }

        // Fetch gateways for the detected network
        let gateways = crossbar.fetch_gateways(network).await
            .context("Failed to fetch gateways from crossbar")?;

        let gateway_url = gateways
            .first()
            .ok_or_else(|| anyhow!("No gateways available for network: {}", network))?;

        Ok(Gateway::new(gateway_url.clone()))
    }
}
