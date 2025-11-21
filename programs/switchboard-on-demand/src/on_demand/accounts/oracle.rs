#[cfg(feature = "pinocchio")]
type Ref<'a, T> = pinocchio::account_info::Ref<'a, T>;

#[cfg(not(feature = "pinocchio"))]
use std::cell::Ref;

use solana_program::sysvar::clock::Clock;

use crate::anchor_traits::*;
#[allow(unused_imports)]
use crate::impl_account_deserialize;
// Use our AccountInfo type alias that conditionally uses pinocchio or anchor/solana-program
use crate::AccountInfo;
use crate::{cfg_client, get_sb_program_id, OnDemandError, Quote};
cfg_client! {
    use crate::address_lookup_table;
    use spl_associated_token_account::solana_program::address_lookup_table::AddressLookupTableAccount;
    use spl_associated_token_account::solana_program::address_lookup_table::instruction::derive_lookup_table_address;
    use crate::find_lut_signer;
}

use crate::{solana_program, Pubkey};

/// Seed for deriving oracle feed statistics PDAs
pub const ORACLE_FEED_STATS_SEED: &[u8; 15] = b"OracleFeedStats";

/// Number of slots to keep oracle key rotation alive
pub const KEY_ROTATE_KEEPALIVE_SLOTS: u64 = 1500;

/// Maximum number of seconds before oracle data is considered stale
pub const MAX_STALE_SECONDS: i64 = 300;

/// Oracle verification status for TEE attestation
#[repr(u8)]
#[derive(Copy, Clone, Default, Debug, Eq, PartialEq)]
pub enum VerificationStatus {
    /// No verification status
    #[default]
    None = 0,
    /// Verification is pending
    VerificationPending = 1 << 0,
    /// Verification failed
    VerificationFailure = 1 << 1,
    /// Verification succeeded
    VerificationSuccess = 1 << 2,
    /// Verification was overridden by authority
    VerificationOverride = 1 << 3,
}
impl From<VerificationStatus> for u8 {
    fn from(value: VerificationStatus) -> Self {
        match value {
            VerificationStatus::VerificationPending => 1 << 0,
            VerificationStatus::VerificationFailure => 1 << 1,
            VerificationStatus::VerificationSuccess => 1 << 2,
            VerificationStatus::VerificationOverride => 1 << 3,
            _ => 0,
        }
    }
}
impl From<u8> for VerificationStatus {
    fn from(value: u8) -> Self {
        match value {
            1 => VerificationStatus::VerificationPending,
            2 => VerificationStatus::VerificationFailure,
            4 => VerificationStatus::VerificationSuccess,
            8 => VerificationStatus::VerificationOverride,
            _ => VerificationStatus::default(),
        }
    }
}

/// Oracle account data containing TEE enclave information and configuration
#[repr(C)]
#[derive(bytemuck::Zeroable, bytemuck::Pod, Debug, Copy, Clone)]
pub struct OracleAccountData {
    /// Represents the state of the quote verifiers enclave.
    pub enclave: Quote,

    // Accounts Config
    /// The authority of the EnclaveAccount which is permitted to make account changes.
    pub authority: Pubkey,
    /// Queue used for attestation to verify a MRENCLAVE measurement.
    pub queue: Pubkey,

    // Metadata Config
    /// The unix timestamp when the quote was created.
    pub created_at: i64,

    /// The last time the quote heartbeated on-chain.
    pub last_heartbeat: i64,

    /// SECP256K1 public key for oracle authority
    pub secp_authority: [u8; 64],

    /// URI location of the verifier's gateway.
    pub gateway_uri: [u8; 64],
    /// Permission flags for oracle operations
    pub permissions: u64,
    /// Whether the quote is located on the AttestationQueues buffer.
    pub is_on_queue: u8,
    _padding1: [u8; 7],
    /// Slot number for address lookup table
    pub lut_slot: u64,
    /// Last epoch when oracle received rewards
    pub last_reward_epoch: u64,

    /// Public key of the oracle operator
    pub operator: Pubkey,
    _ebuf3: [u8; 16],
    _ebuf2: [u8; 64],
    _ebuf1: [u8; 1024],
}

cfg_client! {
    impl_account_deserialize!(OracleAccountData);
}

impl Discriminator for OracleAccountData {
    const DISCRIMINATOR: &'static [u8] = &[128, 30, 16, 241, 170, 73, 55, 54];
}

impl Owner for OracleAccountData {
    fn owner() -> Pubkey {
        if crate::utils::is_devnet() {
            get_sb_program_id("devnet")
        } else {
            get_sb_program_id("mainnet")
        }
    }
}

impl OracleAccountData {
    /// Returns the total size of an oracle account in bytes
    pub fn size() -> usize {
        8 + std::mem::size_of::<OracleAccountData>()
    }

    /// Returns the deserialized Switchboard Quote account
    ///
    /// # Arguments
    ///
    /// * `quote_account_info` - A Solana AccountInfo referencing an existing Switchboard QuoteAccount
    ///
    /// # Examples
    ///
    /// ```ignore
    /// use switchboard_on_demand::OracleAccountData;
    ///
    /// let quote_account = OracleAccountData::new(quote_account_info)?;
    /// ```
    pub fn new<'info>(
        quote_account_info: &'info AccountInfo,
    ) -> Result<Ref<'info, OracleAccountData>, OnDemandError> {
        let data = quote_account_info
            .try_borrow_data()
            .map_err(|_| OnDemandError::AccountBorrowError)?;
        if data.len() < OracleAccountData::DISCRIMINATOR.len() {
            return Err(OnDemandError::InvalidDiscriminator);
        }

        let mut disc_bytes = [0u8; 8];
        disc_bytes.copy_from_slice(&data[..8]);
        if disc_bytes != *OracleAccountData::DISCRIMINATOR {
            return Err(OnDemandError::InvalidDiscriminator);
        }

        // Check size before attempting to parse
        let expected_size = std::mem::size_of::<OracleAccountData>() + 8;
        if data.len() < expected_size {
            return Err(OnDemandError::InvalidData);
        }

        // Validate the slice can be safely cast before using from_bytes
        let slice_to_parse = &data[8..expected_size];
        if slice_to_parse.len() != std::mem::size_of::<OracleAccountData>() {
            return Err(OnDemandError::InvalidData);
        }

        // Check alignment requirements for bytemuck
        match bytemuck::try_from_bytes::<OracleAccountData>(slice_to_parse) {
            Ok(_) => {
                // If try_from_bytes succeeds, we know from_bytes will also succeed
                Ok(Ref::map(data, |data| {
                    bytemuck::from_bytes::<OracleAccountData>(
                        &data[8..std::mem::size_of::<OracleAccountData>() + 8],
                    )
                }))
            }
            Err(_) => Err(OnDemandError::AccountDeserializeError),
        }
    }

    /// Returns the deserialized Switchboard Quote account
    ///
    /// # Arguments
    ///
    /// * `data` - A Solana AccountInfo's data buffer
    ///
    /// # Examples
    ///
    /// ```ignore
    /// use switchboard_on_demand::OracleAccountData;
    ///
    /// let quote_account = OracleAccountData::new(quote_account_info.try_borrow_data()?)?;
    /// ```
    pub fn new_from_bytes(data: &[u8]) -> Result<&OracleAccountData, OnDemandError> {
        if data.len() < OracleAccountData::DISCRIMINATOR.len() {
            return Err(OnDemandError::InvalidDiscriminator);
        }

        let mut disc_bytes = [0u8; 8];
        disc_bytes.copy_from_slice(&data[..8]);
        if disc_bytes != *OracleAccountData::DISCRIMINATOR {
            return Err(OnDemandError::InvalidDiscriminator);
        }

        // Check size before attempting to parse
        let expected_size = std::mem::size_of::<OracleAccountData>() + 8;
        if data.len() < expected_size {
            return Err(OnDemandError::InvalidData);
        }

        // Validate the slice can be safely cast before using from_bytes
        let slice_to_parse = &data[8..expected_size];
        if slice_to_parse.len() != std::mem::size_of::<OracleAccountData>() {
            return Err(OnDemandError::InvalidData);
        }

        // Use try_from_bytes for safety
        match bytemuck::try_from_bytes::<OracleAccountData>(slice_to_parse) {
            Ok(oracle_data) => Ok(oracle_data),
            Err(_) => Err(OnDemandError::AccountDeserializeError),
        }
    }

    /// Returns the public key of the oracle's enclave signer
    pub fn signer(&self) -> &Pubkey {
        &self.enclave.enclave_signer
    }

    /// Returns true if the oracle's TEE enclave is verified and valid
    pub fn is_verified(&self, clock: &Clock) -> bool {
        match self.enclave.verification_status.into() {
            VerificationStatus::VerificationOverride => true,
            VerificationStatus::VerificationSuccess => {
                self.enclave.valid_until > clock.unix_timestamp
            }
            _ => false,
        }
    }

    /// Verifies the oracle's enclave status against current clock
    pub fn verify(&self, clock: &Clock) -> std::result::Result<(), OnDemandError> {
        if !self.is_verified(clock) {
            return Err(OnDemandError::InvalidQuote);
        }

        Ok(())
    }

    /// Returns the oracle's gateway URI if available
    pub fn gateway_uri(&self) -> Option<String> {
        let uri = self.gateway_uri;
        let uri = String::from_utf8_lossy(&uri);
        let uri = uri
            .split_at(uri.find('\0').unwrap_or(uri.len()))
            .0
            .to_string();
        if uri.is_empty() {
            return None;
        }
        Some(uri)
    }

    /// Returns the ED25519 signer public key if set
    pub fn ed25519_signer(&self) -> Option<Pubkey> {
        let key = self.enclave.enclave_signer;
        if key == Pubkey::default() {
            return None;
        }
        Some(key)
    }

    /// Returns the SECP256K1 authority key if set
    pub fn secp_authority(&self) -> Option<[u8; 64]> {
        let key = self.secp_authority;
        if key == [0u8; 64] {
            return None;
        }
        Some(key)
    }

    /// Returns the SECP256K1 signer key if set
    pub fn secp256k1_signer(&self) -> Option<[u8; 64]> {
        let key = self.enclave.secp256k1_signer;
        if key == [0u8; 64] {
            return None;
        }
        Some(key)
    }

    /// Returns the SECP256K1 signer as a libsecp256k1::PublicKey
    pub fn libsecp256k1_signer(&self) -> Option<libsecp256k1::PublicKey> {
        let bytes = self.secp256k1_signer()?;
        let tag_full_pubkey: Vec<u8> = vec![4u8];
        let bytes = [tag_full_pubkey, bytes.into()].concat().try_into().ok()?;
        libsecp256k1::PublicKey::parse(&bytes).ok()
    }

    /// Derives the PDA for oracle statistics account
    pub fn stats_key(key: &Pubkey) -> Pubkey {
        let pid = OracleAccountData::owner();
        let oracle_stats_seed = b"OracleStats";
        let (key, _) =
            Pubkey::find_program_address(&[oracle_stats_seed.as_slice(), &key.to_bytes()], &pid);
        key
    }

    /// Derives the PDA for oracle feed statistics account
    pub fn feed_stats_key(feed: &Pubkey, oracle: &Pubkey) -> (Pubkey, u8) {
        let pid = OracleAccountData::owner();
        Pubkey::find_program_address(
            &Self::feed_stats_seed(&feed.to_bytes(), &oracle.to_bytes(), &[]),
            &pid,
        )
    }

    /// Returns the seed components for deriving oracle feed stats PDA
    pub fn feed_stats_seed<'a>(feed: &'a [u8], oracle: &'a [u8], bump: &'a [u8]) -> [&'a [u8]; 4] {
        [ORACLE_FEED_STATS_SEED.as_slice(), feed, oracle, bump]
    }

    cfg_client! {

        pub async fn fetch_async(
            client: &crate::RpcClient,
            pubkey: Pubkey,
        ) -> std::result::Result<Self, crate::OnDemandError> {
            let pubkey = pubkey.to_bytes().into();
            crate::client::fetch_zerocopy_account(client, pubkey).await
        }

        pub async fn fetch_many(
            client: &crate::RpcClient,
            oracles: &[Pubkey],
        ) -> std::result::Result<Vec<OracleAccountData>, crate::OnDemandError> {
            let converted_oracles: Vec<anchor_client::solana_sdk::pubkey::Pubkey> = oracles.iter().map(|pk| pk.to_bytes().into()).collect();
            Ok(client
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
                .collect())
        }

        pub async fn fetch_lut(
            &self,
            oracle_pubkey: &Pubkey,
            client: &crate::RpcClient,
        ) -> std::result::Result<AddressLookupTableAccount, crate::OnDemandError> {
            let lut_slot = self.lut_slot;
            let lut_signer: Pubkey = find_lut_signer(oracle_pubkey);
            let lut = derive_lookup_table_address(&lut_signer.to_bytes().into(), lut_slot).0;
            address_lookup_table::fetch(client, &lut.to_bytes().into()).await
        }
    }
}
