#[cfg(feature = "pinocchio")]
type Ref<'a, T> = pinocchio::account_info::Ref<'a, T>;

#[cfg(not(feature = "pinocchio"))]
use std::cell::Ref;

use bytemuck::{Pod, Zeroable};

// Always import for macros to work
#[allow(unused_imports)]
use crate::impl_account_deserialize;
// Use our AccountInfo type alias that conditionally uses pinocchio or anchor/solana-program
use crate::AccountInfo;
#[allow(unused_imports)]
use crate::OracleAccountData;
use crate::{cfg_client, get_sb_program_id, OnDemandError};
cfg_client! {
    use spl_associated_token_account::solana_program::address_lookup_table::AddressLookupTableAccount;
}
use crate::Pubkey;

/// Queue account data containing oracle management and configuration
#[repr(C)]
#[derive(Debug, Copy, Clone)]
pub struct QueueAccountData {
    /// The address of the authority which is permitted to add/remove allowed enclave measurements.
    pub authority: Pubkey,
    /// Allowed enclave measurements.
    pub mr_enclaves: [[u8; 32]; 32],
    /// The addresses of the quote oracles who have a valid
    /// verification status and have heartbeated on-chain recently.
    pub oracle_keys: [Pubkey; 78],
    reserved1: [u8; 40],
    /// SECP256K1 signing keys for oracles
    pub secp_oracle_signing_keys: [[u8; 20]; 30],
    /// ED25519 signing keys for oracles
    pub ed25519_oracle_signing_keys: [Pubkey; 30],
    /// The maximum allowable time until a EnclaveAccount needs to be re-verified on-chain.
    pub max_quote_verification_age: i64,
    /// The unix timestamp when the last quote oracle heartbeated on-chain.
    pub last_heartbeat: i64,
    /// Timeout period for oracle nodes in seconds
    pub node_timeout: i64,
    /// The minimum number of lamports a quote oracle needs to lock-up in order to heartbeat and verify other quotes.
    pub oracle_min_stake: u64,
    /// Time after which authority override is allowed
    pub allow_authority_override_after: i64,

    /// The number of allowed enclave measurements.
    pub mr_enclaves_len: u32,
    /// The length of valid quote oracles for the given attestation queue.
    pub oracle_keys_len: u32,
    /// The reward paid to quote oracles for attesting on-chain.
    pub reward: u32,
    /// Incrementer used to track the current quote oracle permitted to run any available functions.
    pub curr_idx: u32,
    /// Incrementer used to garbage collect and remove stale quote oracles.
    pub gc_idx: u32,

    /// Whether authority permission is required for heartbeat
    pub require_authority_heartbeat_permission: u8,
    /// Whether authority permission is required for verification
    pub require_authority_verify_permission: u8,
    /// Whether usage permissions are required
    pub require_usage_permissions: u8,
    /// PDA bump seed for the queue signer
    pub signer_bump: u8,

    /// Token mint for queue operations
    pub mint: Pubkey,
    /// Address lookup table slot
    pub lut_slot: u64,
    /// Whether subsidies are allowed for oracle operations
    pub allow_subsidies: u8,

    _ebuf6: [u8; 15],
    /// Network coordination node public key
    pub ncn: Pubkey,
    _resrved: u64, // only necessary for multiple vaults at once, otherwise we can use the ncn
    // tickets
    /// Array of vault information for rewards
    pub vaults: [VaultInfo; 4],
    /// Last epoch when queue rewards were distributed
    pub last_reward_epoch: u64,
    _ebuf4: [u8; 32],
    _ebuf2: [u8; 256],
    _ebuf1: [u8; 504], // was 512 change to 504 to make room for new u64
}
unsafe impl Pod for QueueAccountData {}
unsafe impl Zeroable for QueueAccountData {}

/// Information about reward vault for oracle incentives
#[repr(C)]
#[derive(PartialEq, Debug, Copy, Clone)]
pub struct VaultInfo {
    /// Public key of the vault account
    pub vault_key: Pubkey,
    /// Last epoch when rewards were distributed
    pub last_reward_epoch: u64,
}
unsafe impl Pod for VaultInfo {}
unsafe impl Zeroable for VaultInfo {}

cfg_client! {
    impl_account_deserialize!(QueueAccountData);
}

/// Anchor discriminator for QueueAccountData
pub const QUEUE_ACCOUNT_DISCRIMINATOR: [u8; 8] = [217, 194, 55, 127, 184, 83, 138, 1];

// Always implement internal traits for client functionality
impl crate::anchor_traits::Discriminator for QueueAccountData {
    const DISCRIMINATOR: &'static [u8] = &QUEUE_ACCOUNT_DISCRIMINATOR;
}

impl crate::anchor_traits::Owner for QueueAccountData {
    fn owner() -> Pubkey {
        let pid = if crate::utils::is_devnet() {
            get_sb_program_id("devnet")
        } else {
            get_sb_program_id("mainnet")
        };
        pid.to_bytes().into()
    }
}

impl crate::anchor_traits::ZeroCopy for QueueAccountData {}

// Implement anchor traits when anchor feature is enabled
#[cfg(feature = "anchor")]
impl anchor_lang::Discriminator for QueueAccountData {
    const DISCRIMINATOR: &'static [u8] = &QUEUE_ACCOUNT_DISCRIMINATOR;
}

#[cfg(feature = "anchor")]
impl anchor_lang::Owner for QueueAccountData {
    fn owner() -> Pubkey {
        let pid = if crate::utils::is_devnet() {
            get_sb_program_id("devnet")
        } else {
            get_sb_program_id("mainnet")
        };
        pid.to_bytes().into()
    }
}

#[cfg(feature = "anchor")]
impl anchor_lang::ZeroCopy for QueueAccountData {}

#[cfg(feature = "anchor")]
impl anchor_lang::IdlBuild for QueueAccountData {}

impl QueueAccountData {
    /// Returns the total size of a queue account in bytes
    pub fn size() -> usize {
        8 + std::mem::size_of::<QueueAccountData>()
    }

    /// Returns the deserialized Switchboard AttestationQueue account
    ///
    /// # Arguments
    ///
    /// * `attestation_queue_account_info` - A Solana AccountInfo referencing an existing Switchboard AttestationQueue
    ///
    /// # Examples
    ///
    /// ```ignore
    /// use switchboard_solana::QueueAccountData;
    ///
    /// let attestation_queue = QueueAccountData::new(attestation_queue_account_info)?;
    /// ```
    pub fn new<'info>(
        attestation_queue_account_info: &'info AccountInfo,
    ) -> Result<Ref<'info, QueueAccountData>, OnDemandError> {
        let data = attestation_queue_account_info
            .try_borrow_data()
            .map_err(|_| OnDemandError::AccountBorrowError)?;
        if data.len() < QUEUE_ACCOUNT_DISCRIMINATOR.len() {
            return Err(OnDemandError::InvalidDiscriminator);
        }

        let mut disc_bytes = [0u8; 8];
        disc_bytes.copy_from_slice(&data[..8]);
        if disc_bytes != QUEUE_ACCOUNT_DISCRIMINATOR {
            return Err(OnDemandError::InvalidDiscriminator);
        }

        // Check size before attempting to parse
        let expected_size = std::mem::size_of::<QueueAccountData>() + 8;
        if data.len() < expected_size {
            return Err(OnDemandError::InvalidData);
        }

        // Validate the slice can be safely cast before using from_bytes
        let slice_to_parse = &data[8..expected_size];
        if slice_to_parse.len() != std::mem::size_of::<QueueAccountData>() {
            return Err(OnDemandError::InvalidData);
        }

        // Check alignment requirements for bytemuck
        match bytemuck::try_from_bytes::<QueueAccountData>(slice_to_parse) {
            Ok(_) => {
                // If try_from_bytes succeeds, we know from_bytes will also succeed
                Ok(Ref::map(data, |data| {
                    bytemuck::from_bytes::<QueueAccountData>(
                        &data[8..std::mem::size_of::<QueueAccountData>() + 8],
                    )
                }))
            }
            Err(_) => Err(OnDemandError::AccountDeserializeError),
        }
    }

    /// Returns the deserialized Switchboard AttestationQueue account
    ///
    /// # Arguments
    ///
    /// * `data` - A Solana AccountInfo's data buffer
    ///
    /// # Examples
    ///
    /// ```ignore
    /// use switchboard_solana::QueueAccountData;
    ///
    /// let attestation_queue = QueueAccountData::new(attestation_queue_account_info.try_borrow_data()?)?;
    /// ```
    pub fn new_from_bytes(data: &[u8]) -> Result<&QueueAccountData, OnDemandError> {
        if data.len() < QUEUE_ACCOUNT_DISCRIMINATOR.len() {
            return Err(OnDemandError::InvalidDiscriminator);
        }

        let mut disc_bytes = [0u8; 8];
        disc_bytes.copy_from_slice(&data[..8]);
        if disc_bytes != QUEUE_ACCOUNT_DISCRIMINATOR {
            return Err(OnDemandError::InvalidDiscriminator);
        }

        // Check size before attempting to parse
        let expected_size = std::mem::size_of::<QueueAccountData>() + 8;
        if data.len() < expected_size {
            return Err(OnDemandError::InvalidData);
        }

        // Validate the slice can be safely cast before using from_bytes
        let slice_to_parse = &data[8..expected_size];
        if slice_to_parse.len() != std::mem::size_of::<QueueAccountData>() {
            return Err(OnDemandError::InvalidData);
        }

        // Use try_from_bytes for safety
        match bytemuck::try_from_bytes::<QueueAccountData>(slice_to_parse) {
            Ok(queue_data) => Ok(queue_data),
            Err(_) => Err(OnDemandError::AccountDeserializeError),
        }
    }

    /// Returns true if the given MR_ENCLAVE measurement is permitted
    pub fn has_mr_enclave(&self, mr_enclave: &[u8]) -> bool {
        self.mr_enclaves[..self.mr_enclaves_len as usize]
            .iter()
            .any(|x| x.to_vec() == mr_enclave.to_vec())
    }

    /// Returns a vector of all permitted enclave measurements
    pub fn permitted_enclaves(&self) -> Vec<[u8; 32]> {
        self.mr_enclaves[..self.mr_enclaves_len as usize].to_vec()
    }

    /// Returns the garbage collection node public key if set
    pub fn garbage_collection_node(&self) -> Option<Pubkey> {
        let gc_node = self.oracle_keys[self.gc_idx as usize];
        if gc_node != Pubkey::default() {
            Some(gc_node)
        } else {
            None
        }
    }

    /// Returns the index of an oracle in the queue's oracle list
    pub fn idx_of_oracle(&self, oracle: &Pubkey) -> Option<usize> {
        self.oracle_keys[..self.oracle_keys_len as usize]
            .iter()
            .position(|x| x == oracle)
    }

    /// Returns a vector of all active oracle public keys in the queue
    pub fn oracle_keys(&self) -> Vec<Pubkey> {
        self.oracle_keys[..self.oracle_keys_len as usize].to_vec()
    }

    cfg_client! {

        /// Fetches a queue account asynchronously from the Solana network
        pub async fn fetch_async(
            client: &crate::RpcClient,
            pubkey: Pubkey,
        ) -> std::result::Result<Self, crate::OnDemandError> {
            let pubkey = pubkey.to_bytes().into();
            crate::client::fetch_zerocopy_account(client, pubkey).await
        }

        /// Fetches all oracle accounts associated with this queue
        pub async fn fetch_oracles(
            &self,
            client: &crate::RpcClient,
        ) -> std::result::Result<Vec<(Pubkey, OracleAccountData)>, crate::OnDemandError> {
            let oracles = &self.oracle_keys[..self.oracle_keys_len as usize];
            let converted_oracles: Vec<anchor_client::solana_sdk::pubkey::Pubkey> = oracles.iter().map(|pk| pk.to_bytes().into()).collect();
            let datas: Vec<_> = client
                .get_multiple_accounts(&converted_oracles)
                .await
                .map_err(|_e| crate::OnDemandError::NetworkError)?
                .into_iter()
                .flatten()
                .map(|x| x.data.clone())
                .collect::<Vec<_>>()
                .iter()
                .map(|x| OracleAccountData::new_from_bytes(x))
                .filter_map(|x| x.ok())
                .copied()
                .collect();
            Ok(oracles.iter().cloned().zip(datas).collect())
        }

        /// Fetches the address lookup table associated with this queue
        pub async fn fetch_lut(
            &self,
            pubkey: &Pubkey,
            client: &crate::RpcClient,
        ) -> std::result::Result<AddressLookupTableAccount, crate::OnDemandError> {
            use spl_associated_token_account::solana_program::address_lookup_table::instruction::derive_lookup_table_address;
            let lut_slot = self.lut_slot;
            let lut_signer: Pubkey = crate::find_lut_signer(pubkey);
            let lut = derive_lookup_table_address(&lut_signer.to_bytes().into(), lut_slot).0;
            crate::address_lookup_table::fetch(client, &lut.to_bytes().into()).await
        }
    }
}
