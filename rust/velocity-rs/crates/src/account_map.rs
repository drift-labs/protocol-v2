//! Hybrid solana account map backed by Ws or RPC polling
use std::{
    marker::PhantomData,
    ops::Deref,
    sync::{Arc, Mutex},
    time::Duration,
};

use crate::solana_sdk::{clock::Slot, commitment_config::CommitmentConfig, pubkey::Pubkey};
use anchor_lang::Discriminator;
use bytemuck::Pod;
use dashmap::DashMap;
use log::debug;
use program::sdk::AlignedAccountData;
use solana_account_decoder_client_types::UiAccountEncoding;
use solana_rpc_client::nonblocking::rpc_client::RpcClient;
use solana_rpc_client_api::{
    config::{RpcAccountInfoConfig, RpcProgramAccountsConfig},
    filter::RpcFilterType,
};
use velocity_pubsub_client::PubsubClient;

use crate::{
    constants::PROGRAM_ID,
    grpc::AccountUpdate,
    polled_account_subscriber::PolledAccountSubscriber,
    types::{DataAndSlot, EMPTY_ACCOUNT_CALLBACK},
    websocket_account_subscriber::WebsocketAccountSubscriber,
    SdkResult, UnsubHandle,
};

const LOG_TARGET: &str = "accountmap";

#[derive(Clone, Default)]
pub struct AccountSlot {
    /// Account bytes (discriminator + body) copied **once**, at ingest, into a
    /// 16-byte-aligned buffer. Shared via `Arc`, so every reader — the
    /// `try_deser_zero_copy` getters and the zero-copy [`AccountRef`] handle —
    /// works off this single aligned copy without re-copying or re-aligning.
    raw: Arc<AlignedAccountData>,
    slot: Slot,
    /// gRPC subscribed accounts only
    write_version: u64,
}

/// Set of subscriptions to network accounts
///
/// Accounts are subscribed by either Ws or polling at fixed intervals
pub struct AccountMap {
    pubsub: Arc<PubsubClient>,
    rpc: Arc<RpcClient>,
    commitment: CommitmentConfig,
    inner: Arc<DashMap<Pubkey, AccountSlot, ahash::RandomState>>,
    subscriptions: Arc<DashMap<Pubkey, AccountSub<Subscribed>, ahash::RandomState>>,
}

impl AccountMap {
    pub fn new(
        pubsub: Arc<PubsubClient>,
        rpc: Arc<RpcClient>,
        commitment: CommitmentConfig,
    ) -> Self {
        Self {
            pubsub,
            rpc,
            commitment,
            inner: Arc::default(),
            subscriptions: Arc::default(),
        }
    }
    pub fn iter_accounts_with<'a, T: Pod + Discriminator>(
        &self,
        mut f: impl FnMut(&Pubkey, &T, u64),
    ) {
        self.inner
            .iter()
            .filter(|x| x.raw.len() >= 8 && &x.raw[..8] == T::DISCRIMINATOR)
            .for_each(|x| {
                if let Some(v) = crate::utils::try_deser_zero_copy::<T>(x.raw.as_slice()) {
                    f(x.key(), &v, x.slot)
                }
            })
    }
    /// Subscribe account with Ws
    ///
    /// * `account` pubkey to subscribe
    ///
    pub async fn subscribe_account(&self, account: &Pubkey) -> SdkResult<()> {
        self.subscribe_account_inner(account, EMPTY_ACCOUNT_CALLBACK)
            .await
    }

    /// Subscribe account with Ws callback
    ///
    /// * `account` pubkey to subscribe
    /// * `on_account` callback function
    ///
    pub async fn subscribe_account_with_callback<F>(
        &self,
        account: &Pubkey,
        on_account: F,
    ) -> SdkResult<()>
    where
        F: Fn(&crate::AccountUpdate) + Send + Sync + 'static + Clone,
    {
        self.subscribe_account_inner(account, on_account).await
    }

    /// Subscribe account with Ws - inner implementation
    ///
    /// * `account` pubkey to subscribe
    /// * `on_account` callback function
    ///
    async fn subscribe_account_inner<F>(&self, account: &Pubkey, on_account: F) -> SdkResult<()>
    where
        F: Fn(&crate::AccountUpdate) + Send + Sync + 'static + Clone,
    {
        if self.inner.contains_key(account) {
            return Ok(());
        }
        debug!(target: LOG_TARGET, "subscribing: {account:?}");

        let user = AccountSub::new(Arc::clone(&self.pubsub), self.commitment, *account);
        let sub = user.subscribe(Arc::clone(&self.inner), on_account).await?;
        self.subscriptions.insert(*account, sub);

        Ok(())
    }

    /// Subscribe account with RPC polling
    ///
    /// * `account` pubkey to subscribe
    /// * `interval` to poll the account
    ///
    pub async fn subscribe_account_polled(
        &self,
        account: &Pubkey,
        interval: Option<Duration>,
    ) -> SdkResult<()> {
        self.subscribe_account_polled_inner(account, interval, EMPTY_ACCOUNT_CALLBACK)
            .await
    }

    pub async fn subscribe_account_polled_with_callback<F>(
        &self,
        account: &Pubkey,
        interval: Option<Duration>,
        on_account: F,
    ) -> SdkResult<()>
    where
        F: Fn(&crate::AccountUpdate) + Send + Sync + 'static + Clone,
    {
        self.subscribe_account_polled_inner(account, interval, on_account)
            .await
    }

    /// Subscribe account with RPC polling - inner implementation
    ///
    /// * `account` pubkey to subscribe
    /// * `interval` to poll the account
    /// * `on_account` callback function
    ///
    async fn subscribe_account_polled_inner<F>(
        &self,
        account: &Pubkey,
        interval: Option<Duration>,
        on_account: F,
    ) -> SdkResult<()>
    where
        F: Fn(&crate::AccountUpdate) + Send + Sync + 'static + Clone,
    {
        if self.inner.contains_key(account) {
            return Ok(());
        }
        debug!(
            target: LOG_TARGET,
            "subscribing: {account:?} @ {interval:?}"
        );

        let user = AccountSub::polled(Arc::clone(&self.rpc), *account, interval);
        let sub = user.subscribe(Arc::clone(&self.inner), on_account).await?;
        self.subscriptions.insert(*account, sub);

        Ok(())
    }

    /// On account hook for gRPC subscriber
    pub fn on_account_fn(&self) -> impl Fn(&AccountUpdate) {
        let accounts = Arc::clone(&self.inner);
        let subscriptions = Arc::clone(&self.subscriptions);
        move |update| {
            if update.lamports == 0 {
                accounts.remove(&update.pubkey);
                return;
            }
            accounts
                .entry(update.pubkey)
                .and_modify(|x| {
                    if update.write_version < x.write_version {
                        log::debug!(target: LOG_TARGET, "skip stale update pubkey={:?}. update: {}, current: {}", update.pubkey, update.write_version, x.write_version);
                        return;
                    }
                    x.slot = update.slot;
                    x.raw = Arc::new(AlignedAccountData::from_bytes(update.data));
                })
                .or_insert({
                    subscriptions.insert(
                        update.pubkey,
                        AccountSub {
                            pubkey: update.pubkey,
                            subscription: SubscriptionImpl::Grpc,
                            state: Subscribed {
                                unsub: Mutex::default(),
                            },
                        },
                    );
                    AccountSlot {
                        slot: update.slot,
                        raw: Arc::new(AlignedAccountData::from_bytes(update.data)),
                        write_version: update.write_version,
                    }
                });
        }
    }
    /// Unsubscribe user account
    pub fn unsubscribe_account(&self, account: &Pubkey) {
        if let Some((acc, sub)) = self.subscriptions.remove(account) {
            debug!(target: LOG_TARGET, "unsubscribing: {acc:?}");
            self.inner.remove(account);
            let _ = sub.unsubscribe();
        }
    }
    /// Return data of the given `account` as T, if it exists
    pub fn account_data<T: Pod + Discriminator>(&self, account: &Pubkey) -> Option<T> {
        self.account_data_and_slot(account).map(|x| x.data)
    }
    /// Return raw bytes of the given `account` (incl. 8-byte discriminator), if it exists.
    ///
    /// For accounts whose velocity-program type is non-`Pod` (e.g. `State`), callers
    /// can deserialize these bytes via `anchor_lang::AccountDeserialize::try_deserialize`.
    pub fn account_raw(&self, account: &Pubkey) -> Option<Arc<[u8]>> {
        // Copies out of the aligned store into a plain `Arc<[u8]>` to preserve
        // this method's contract. Used for non-`Pod` accounts (e.g. `State`,
        // decoded via Borsh `try_deserialize`), which are fetched rarely — the
        // copy is not on a hot path. `Pod` accounts should use
        // [`account_ref`](Self::account_ref) for zero-copy access instead.
        self.inner
            .get(account)
            .map(|x| Arc::<[u8]>::from(x.raw.as_slice()))
    }

    /// Zero-copy handle to `account` decoded as `T`.
    ///
    /// Shares the aligned buffer copied once at ingest (an `Arc` clone, no byte
    /// copy); every deref of the returned [`AccountRef`] is a by-reference cast,
    /// so reads stay zero-copy for the handle's lifetime. Returns `None` if the
    /// account is absent, its discriminator doesn't match `T`, or its data is
    /// too short to hold a `T`.
    pub fn account_ref<T: Pod + Discriminator>(&self, account: &Pubkey) -> Option<AccountRef<T>> {
        self.inner
            .get(account)
            .and_then(|x| AccountRef::from_arc(Arc::clone(&x.raw)))
    }
    /// Return data of the given `account` as T and slot, if it exists
    pub fn account_data_and_slot<T: Pod + Discriminator>(
        &self,
        account: &Pubkey,
    ) -> Option<DataAndSlot<T>> {
        self.inner.get(account).and_then(|x| {
            crate::utils::try_deser_zero_copy::<T>(x.raw.as_slice())
                .map(|data| DataAndSlot { slot: x.slot, data })
        })
    }

    pub async fn sync_stats_accounts(&self) -> SdkResult<()> {
        // TODO: rust sdk does not surface with_context slot on GPA
        let slot = self
            .rpc
            .get_slot_with_commitment(CommitmentConfig::confirmed())
            .await?;
        let stats_sync_result = self
            .rpc
            .get_program_ui_accounts_with_config(
                &PROGRAM_ID,
                RpcProgramAccountsConfig {
                    filters: Some(vec![crate::memcmp::get_user_stats_filter()]),
                    account_config: RpcAccountInfoConfig {
                        encoding: Some(UiAccountEncoding::Base64Zstd),
                        ..Default::default()
                    },
                    ..Default::default()
                },
            )
            .await?;

        for (pubkey, account) in stats_sync_result {
            self.on_account_fn()(&AccountUpdate {
                pubkey,
                data: &account.data.decode().unwrap_or_default(),
                lamports: account.lamports,
                owner: PROGRAM_ID,
                rent_epoch: u64::MAX,
                write_version: 0,
                executable: false,
                slot,
            });
        }
        Ok(())
    }

    pub async fn sync_user_accounts(&self, mut filters: Vec<RpcFilterType>) -> SdkResult<()> {
        // TODO: rust sdk does not surface with_context slot on GPA
        let slot = self
            .rpc
            .get_slot_with_commitment(CommitmentConfig::confirmed())
            .await?;
        filters.insert(0, crate::memcmp::get_user_filter());

        let sync_result = self
            .rpc
            .get_program_ui_accounts_with_config(
                &PROGRAM_ID,
                RpcProgramAccountsConfig {
                    filters: Some(filters),
                    account_config: RpcAccountInfoConfig {
                        encoding: Some(UiAccountEncoding::Base64Zstd),
                        ..Default::default()
                    },
                    ..Default::default()
                },
            )
            .await?;

        for (pubkey, account) in sync_result {
            self.on_account_fn()(&AccountUpdate {
                pubkey,
                data: &account.data.decode().unwrap_or_default(),
                lamports: account.lamports,
                owner: PROGRAM_ID,
                rent_epoch: u64::MAX,
                write_version: 0,
                executable: false,
                slot,
            });
        }

        Ok(())
    }
}

struct Subscribed {
    unsub: Mutex<Option<UnsubHandle>>,
}
struct Unsubscribed;

/// A subscription to a solana account
pub struct AccountSub<S> {
    /// account pubkey
    pub pubkey: Pubkey,
    /// underlying subscription
    subscription: SubscriptionImpl,
    /// subscription state
    state: S,
}

impl AccountSub<Unsubscribed> {
    pub const SUBSCRIPTION_ID: &'static str = "account";

    /// Create a new Ws account subscriber
    pub fn new(pubsub: Arc<PubsubClient>, commitment: CommitmentConfig, pubkey: Pubkey) -> Self {
        let subscription = WebsocketAccountSubscriber::new(pubsub, pubkey, commitment);

        Self {
            pubkey,
            subscription: SubscriptionImpl::Ws(subscription),
            state: Unsubscribed {},
        }
    }

    /// Create a new polled account subscriber
    pub fn polled(rpc: Arc<RpcClient>, pubkey: Pubkey, interval: Option<Duration>) -> Self {
        let subscription =
            PolledAccountSubscriber::new(pubkey, interval.unwrap_or(Duration::from_secs(5)), rpc);

        Self {
            pubkey,
            subscription: SubscriptionImpl::Polled(subscription),
            state: Unsubscribed {},
        }
    }

    /// Start the subscriber task
    pub async fn subscribe<F>(
        self,
        accounts: Arc<DashMap<Pubkey, AccountSlot, ahash::RandomState>>,
        on_account: F,
    ) -> SdkResult<AccountSub<Subscribed>>
    where
        F: Fn(&crate::AccountUpdate) + Send + Sync + 'static + Clone,
    {
        let unsub = match self.subscription {
            SubscriptionImpl::Ws(ref ws) => {
                let on_account = on_account.clone();
                let unsub = ws
                    .subscribe(Self::SUBSCRIPTION_ID, true, move |update| {
                        if update.lamports == 0 {
                            accounts.remove(&update.pubkey);
                            return;
                        }
                        accounts
                            .entry(update.pubkey)
                            .and_modify(|x| {
                                x.slot = update.slot;
                                x.raw = Arc::new(AlignedAccountData::from_bytes(
                                    update.data.as_slice(),
                                ));
                            })
                            .or_insert(AccountSlot {
                                raw: Arc::new(AlignedAccountData::from_bytes(
                                    update.data.as_slice(),
                                )),
                                slot: update.slot,
                                write_version: 0,
                            });

                        on_account(update);
                    })
                    .await?;
                Some(unsub)
            }
            SubscriptionImpl::Polled(ref poll) => {
                let on_account = on_account.clone();
                let unsub = poll.subscribe(move |update| {
                    if update.lamports == 0 {
                        accounts.remove(&update.pubkey);
                        return;
                    }
                    accounts
                        .entry(update.pubkey)
                        .and_modify(|x| {
                            x.slot = update.slot;
                            x.raw =
                                Arc::new(AlignedAccountData::from_bytes(update.data.as_slice()));
                        })
                        .or_insert(AccountSlot {
                            raw: Arc::new(AlignedAccountData::from_bytes(update.data.as_slice())),
                            slot: update.slot,
                            write_version: 0,
                        });

                    on_account(update);
                });
                Some(unsub)
            }
            SubscriptionImpl::Grpc => None,
        };

        Ok(AccountSub {
            pubkey: self.pubkey,
            subscription: self.subscription,
            state: Subscribed {
                unsub: Mutex::new(unsub),
            },
        })
    }
}

impl AccountSub<Subscribed> {
    /// Stop the user subscriber task, if it exists
    pub fn unsubscribe(self) -> AccountSub<Unsubscribed> {
        let mut guard = self.state.unsub.lock().expect("acquire");
        if let Some(unsub) = guard.take() {
            if unsub.send(()).is_err() {
                log::error!("couldn't unsubscribe");
            }
        }

        AccountSub {
            pubkey: self.pubkey,
            subscription: self.subscription,
            state: Unsubscribed,
        }
    }
}

enum SubscriptionImpl {
    Ws(WebsocketAccountSubscriber),
    Polled(PolledAccountSubscriber),
    Grpc,
}

/// Zero-copy, shareable handle to an account decoded as `T`.
///
/// Backs onto an [`AlignedAccountData`] (the body after the 8-byte discriminator
/// is 16-byte aligned), so [`Deref`] can cast `&T` **by reference** without the
/// `bytemuck::from_bytes` alignment panic that 16-aligned zero-copy structs
/// (`PerpMarket`/`SpotMarket`) hit off-chain. The byte copy into aligned form
/// happens once — at account ingest, when obtained via
/// [`AccountMap::account_ref`], or in [`AccountRef::try_new`] for ad-hoc bytes;
/// cloning the handle and every deref thereafter are zero-copy.
///
/// # Invariant
///
/// Every constructor validates that the backing buffer holds the 8-byte
/// discriminator plus a full `T` (`len >= 8 + size_of::<T>()`) and that the
/// discriminator matches. The buffer is immutable for the handle's lifetime, and
/// [`AlignedAccountData`] guarantees the body is correctly aligned. Together
/// these make [`Deref`] **infallible** — it never slices out of bounds and
/// `from_bytes` never trips a size/alignment check.
#[derive(Clone)]
pub struct AccountRef<T> {
    data: Arc<AlignedAccountData>,
    _marker: PhantomData<T>,
}

impl<T: Pod + Discriminator> AccountRef<T> {
    /// True if `raw` is long enough for a `T` and carries `T`'s discriminator —
    /// the invariant [`Deref`] relies on.
    fn is_valid(raw: &[u8]) -> bool {
        raw.len() >= 8 + std::mem::size_of::<T>() && &raw[..8] == T::DISCRIMINATOR
    }

    /// Copy `raw` (discriminator + body) once into aligned storage, returning
    /// `None` if `raw` is too short for a `T` or its discriminator doesn't match.
    /// Use [`AccountMap::account_ref`] instead when the bytes already live in the
    /// map — that shares the ingest copy rather than making a new one.
    pub fn try_new(raw: &[u8]) -> Option<Self> {
        Self::is_valid(raw).then(|| Self {
            data: Arc::new(AlignedAccountData::from_bytes(raw)),
            _marker: PhantomData,
        })
    }

    /// Share an already-aligned, already-validated buffer (e.g. the map's ingest
    /// copy) without copying. Returns `None` if `data` doesn't satisfy the
    /// [invariant](AccountRef#invariant).
    fn from_arc(data: Arc<AlignedAccountData>) -> Option<Self> {
        Self::is_valid(data.as_slice()).then_some(Self {
            data,
            _marker: PhantomData,
        })
    }

    /// Raw account bytes (including the 8-byte discriminator).
    pub fn raw(&self) -> &[u8] {
        self.data.as_slice()
    }
}

impl<T: Pod + Discriminator> Deref for AccountRef<T> {
    type Target = T;
    fn deref(&self) -> &T {
        // SAFETY of no-panic: the constructor invariant guarantees
        // `len >= 8 + size_of::<T>()` (so the slice is in bounds and exactly
        // `size_of::<T>()` long) and `AlignedAccountData` guarantees 16-byte
        // body alignment, so neither the index nor `from_bytes` can panic.
        bytemuck::from_bytes(&self.data.as_slice()[8..8 + std::mem::size_of::<T>()])
    }
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use super::*;
    use crate::{
        accounts::User,
        constants::{state_account, DEFAULT_PUBKEY},
        types::accounts::State,
        utils::{get_ws_url, test_envs::mainnet_endpoint},
        Wallet,
    };

    #[test]
    fn account_ref_is_alignment_safe_and_validates() {
        use crate::utils::zero_account_to_bytes;

        // Well-formed buffer: copied once into aligned storage; deref casts
        // `&User` by reference with no panic, and round-trips the bytes.
        let bytes = zero_account_to_bytes(User::default());
        let r = AccountRef::<User>::try_new(&bytes).expect("valid User bytes");
        assert_eq!(r.raw(), bytes.as_slice());
        assert_eq!(*r, User::default());
        // Cloning shares the aligned buffer (no copy); deref stays sound.
        let r2 = r.clone();
        assert_eq!(*r2, User::default());

        // Too short for a `User` => rejected at construction, so `Deref` can
        // never slice out of bounds.
        assert!(AccountRef::<User>::try_new(&bytes[..bytes.len() - 1]).is_none());
        assert!(AccountRef::<User>::try_new(&[]).is_none());

        // Correct length, wrong discriminator => rejected.
        let mut bad = bytes.clone();
        bad[0] ^= 0xff;
        assert!(AccountRef::<User>::try_new(&bad).is_none());
    }

    #[cfg(feature = "rpc_tests")]
    #[ignore = "MAINNET_NOT_LIVE: velocity mainnet not deployed yet — re-enable when live"]
    #[tokio::test]
    async fn test_user_subscribe() {
        let _ = env_logger::try_init();
        let pubsub = Arc::new(
            PubsubClient::new(&get_ws_url(&mainnet_endpoint()).unwrap())
                .await
                .expect("ws connects"),
        );
        let rpc = Arc::new(RpcClient::new(mainnet_endpoint()));
        let account_map = AccountMap::new(pubsub, rpc, CommitmentConfig::confirmed());
        let user_1 = Wallet::derive_user_account(
            &solana_pubkey::pubkey!("DxoRJ4f5XRMvXU9SGuM4ZziBFUxbhB3ubur5sVZEvue2"),
            0,
        );
        let user_2 = Wallet::derive_user_account(
            &solana_pubkey::pubkey!("Drift7AMLeq3FoKBMpT9wzqyMM3HVvvZFtsn81iSSkWV"),
            0,
        );

        let (res1, res2, res3) = tokio::join!(
            account_map.subscribe_account(&user_1),
            account_map.subscribe_account(&user_2),
            account_map.subscribe_account_polled(state_account(), Some(Duration::from_secs(2))),
        );
        assert!(res1.and(res2).and(res3).is_ok());

        let handle = tokio::spawn(async move {
            tokio::time::sleep(Duration::from_secs(8)).await;
            let account_data = account_map.account_data::<User>(&user_1);
            assert!(account_data.is_some_and(|x| x.authority != DEFAULT_PUBKEY));
            account_map.unsubscribe_account(&user_1);

            let account_data = account_map.account_data::<User>(&user_1);
            assert!(account_data.is_none());

            let account_data = account_map.account_data::<User>(&user_2);
            assert!(account_data.is_some_and(|x| x.authority != DEFAULT_PUBKEY));

            let state_account = account_map.account_data::<State>(state_account());
            assert!(state_account.is_some());
        });

        assert!(handle.await.is_ok());
    }
}
