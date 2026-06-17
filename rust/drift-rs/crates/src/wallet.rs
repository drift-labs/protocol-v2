use std::sync::Arc;

use crate::solana_sdk::{
    keypair::{keypair_from_seed, Keypair},
    message::{Hash, VersionedMessage},
    pubkey::Pubkey,
    signature::Signature,
    signer::Signer,
    transaction::versioned::VersionedTransaction,
};

use crate::{
    constants::{self},
    types::{accounts::SpotMarket, SdkError, SdkResult, SpotMarketExt},
    utils,
};

/// Wallet operation mode
#[derive(Clone, Debug)]
pub enum Mode {
    /// Normal tx signing
    Normal,
    /// Tx signing will fail
    ReadOnly,
    /// Tx signed by delegate
    Delegated,
}

/// Drift wallet
/// ```example(no_run)
/// // load wallet from base58 private key or path to wallet.json
/// let wallet = Wallet::try_from_str("PRIVATE_KEY").unwrap();
///
/// // construct wallet for delegated signing
/// let delegated_keypair = solana_sdk::signature::Keypair::new();
/// let delegated_wallet = Wallet::delegated(delegated_keypair, drift_account_key);
///
/// // place holder wallet for readonly apps
/// let ro_wallet = Wallet::read_only(drift_authority);
/// ```
#[derive(Clone, Debug)]
pub struct Wallet {
    /// The signing keypair, it could be authority or delegate
    signer: Arc<Keypair>,
    /// The drift 'authority' account
    /// user (sub)accounts are derived from this
    authority: Pubkey,
    /// The drift 'stats' account
    stats: Pubkey,
    /// Wallet operation mode
    mode: Mode,
}

impl Wallet {
    /// Returns true if the wallet is configured for delegated signing
    pub fn is_delegated(&self) -> bool {
        matches!(self.mode, Mode::Delegated)
    }
    /// Returns true if the wallet is configured for read-only/emulation mode
    pub fn is_read_only(&self) -> bool {
        matches!(self.mode, Mode::ReadOnly)
    }
    /// Init wallet from a string of either file path or the encoded private key
    /// ```example(no_run)
    /// // from private key str
    /// let wallet = Wallet::try_from_str("PRIVATE_KEY").unwrap();
    ///
    /// // from file path
    /// let wallet = Wallet::try_from_str("/path/to/wallet.json").unwrap();
    /// ```
    pub fn try_from_str(path_or_key: &str) -> SdkResult<Self> {
        let authority = utils::load_keypair_multi_format(path_or_key)?;
        Ok(Self::new(authority))
    }
    /// Construct a read-only wallet
    pub fn read_only(authority: Pubkey) -> Self {
        Self {
            signer: Arc::new(Keypair::new()),
            authority,
            stats: Wallet::derive_stats_account(&authority),
            mode: Mode::ReadOnly,
        }
    }
    /// Init wallet from base58 encoded seed, uses default sub-account
    ///
    /// * `seed` - base58 encoded private key
    ///
    /// # panics
    /// if the key is invalid
    pub fn from_seed_bs58(seed: &str) -> Self {
        let authority = Keypair::from_base58_string(seed);
        Self::new(authority)
    }
    /// Init wallet from seed bytes, uses default sub-account
    pub fn from_seed(seed: &[u8]) -> SdkResult<Self> {
        let authority = keypair_from_seed(seed).map_err(|_| SdkError::InvalidSeed)?;
        Ok(Self::new(authority))
    }
    /// Init wallet with keypair
    ///
    /// * `authority` - keypair for tx signing
    pub fn new(authority: Keypair) -> Self {
        Self {
            stats: Wallet::derive_stats_account(&authority.pubkey()),
            authority: authority.pubkey(),
            signer: Arc::new(authority),
            mode: Mode::Normal,
        }
    }
    /// Convert the wallet into a delegated one by providing the `authority` public key
    ///
    /// * `authority` - keypair for tx signing
    #[deprecated = "use Wallet::delegated"]
    pub fn to_delegated(&mut self, authority: Pubkey) {
        self.stats = Wallet::derive_stats_account(&authority);
        self.authority = authority;
        self.mode = Mode::Delegated;
    }
    /// Create a delegated wallet
    ///
    /// * `signer` - the delegated keypair for tx signing
    /// * `authority` - drift account to sign for (the delegator)
    pub fn delegated(signer: Keypair, authority: Pubkey) -> Self {
        Self {
            signer: Arc::new(signer),
            stats: Wallet::derive_stats_account(&authority),
            authority,
            mode: Mode::Delegated,
        }
    }
    /// Calculate the address of a drift user account/sub-account
    pub fn derive_user_account(authority: &Pubkey, sub_account_id: u16) -> Pubkey {
        let (account_drift_pda, _seed) = Pubkey::find_program_address(
            &[
                &b"user"[..],
                authority.as_ref(),
                &sub_account_id.to_le_bytes(),
            ],
            &constants::PROGRAM_ID,
        );
        account_drift_pda
    }

    /// Calculate the address of a drift stats account
    pub fn derive_stats_account(account: &Pubkey) -> Pubkey {
        let (account_drift_pda, _seed) = Pubkey::find_program_address(
            &[&b"user_stats"[..], account.as_ref()],
            &constants::PROGRAM_ID,
        );
        account_drift_pda
    }

    /// Calculate the address of `authority`s swift (taker) order account
    pub fn derive_swift_order_account(authority: &Pubkey) -> Pubkey {
        let (account_drift_pda, _seed) = Pubkey::find_program_address(
            &[&b"SIGNED_MSG"[..], authority.as_ref()],
            &constants::PROGRAM_ID,
        );
        account_drift_pda
    }

    /// Calculate the wallet's ATA for drift spot market
    pub fn derive_associated_token_address(authority: &Pubkey, market: &SpotMarket) -> Pubkey {
        spl_associated_token_account::get_associated_token_address_with_program_id(
            authority,
            &market.mint,
            &market.token_program(),
        )
    }

    /// Signs a solana message (ixs, accounts) and builds a signed tx
    /// ready for sending over RPC
    ///
    /// * `message` - solana VersionedMessage
    /// * `recent_block_hash` blockhash for  tx longevity
    ///
    /// Returns `VersionedTransaction` on success
    pub fn sign_tx(
        &self,
        mut message: VersionedMessage,
        recent_block_hash: Hash,
    ) -> SdkResult<VersionedTransaction> {
        message.set_recent_blockhash(recent_block_hash);
        let signer: &dyn Signer = self.signer.as_ref();
        match self.mode {
            Mode::ReadOnly => Err(SdkError::WalletSigningDisabled),
            _ => VersionedTransaction::try_new(message, &[signer]).map_err(Into::into),
        }
    }

    /// Sign message with the wallet's signer
    pub fn sign_message(&self, message: &[u8]) -> SdkResult<Signature> {
        let signer: &dyn Signer = self.signer.as_ref();
        match self.mode {
            Mode::ReadOnly => Err(SdkError::WalletSigningDisabled),
            _ => Ok(signer.sign_message(message)),
        }
    }
    /// Return the wallet authority address
    pub fn authority(&self) -> &Pubkey {
        &self.authority
    }
    /// Return the wallet signing address
    pub fn signer(&self) -> Pubkey {
        self.signer.pubkey()
    }
    /// Return the drift user stats address
    pub fn stats(&self) -> &Pubkey {
        &self.stats
    }
    /// Return the address of the default sub-account (0)
    pub fn default_sub_account(&self) -> Pubkey {
        self.sub_account(0)
    }
    /// Calculate the drift user address given a `sub_account_id`
    pub fn sub_account(&self, sub_account_id: u16) -> Pubkey {
        Self::derive_user_account(self.authority(), sub_account_id)
    }
}

impl From<Keypair> for Wallet {
    fn from(value: Keypair) -> Self {
        Self::new(value)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn wallet_read_only() {
        let keypair = Keypair::new();
        let ro = Wallet::read_only(keypair.pubkey());

        let rw = Wallet::new(keypair);
        assert_eq!(rw.authority, ro.authority);
        assert_eq!(rw.stats, ro.stats);
        assert_eq!(rw.default_sub_account(), ro.default_sub_account());
    }
}
