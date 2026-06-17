use std::{collections::HashMap, time::Duration};

use crate::solana_sdk::{clock::Slot, commitment_config::CommitmentLevel, pubkey::Pubkey};
use ahash::HashSet;
use futures_util::{
    sink::SinkExt,
    stream::{FuturesUnordered, StreamExt},
};
use log::{error, info, warn};
use solana_rpc_client_api::filter::Memcmp;
use yellowstone_grpc_client::{
    ClientTlsConfig, GeyserGrpcBuilderError, GeyserGrpcClient, GeyserGrpcClientError, Interceptor,
};
use yellowstone_grpc_proto::{
    geyser::{
        CommitmentLevel as GeyserCommitmentLevel, SubscribeRequestFilterBlocksMeta,
        SubscribeUpdateAccountInfo, SubscribeUpdateBlockMeta,
    },
    prelude::{
        subscribe_request_filter_accounts_filter::Filter as AccountsFilterOneof,
        subscribe_request_filter_accounts_filter_memcmp::Data as AccountsFilterMemcmpOneof,
        subscribe_update::UpdateOneof, SubscribeRequest, SubscribeRequestFilterAccounts,
        SubscribeRequestFilterAccountsFilter, SubscribeRequestFilterAccountsFilterMemcmp,
        SubscribeRequestFilterSlots, SubscribeRequestFilterTransactions, SubscribeRequestPing,
    },
    tonic::{codec::CompressionEncoding, transport::Certificate, Status},
};

use crate::types::UnsubHandle;

use super::{AccountUpdate, OnAccountFn, OnTransactionFn, TransactionUpdate};

type SlotsFilterMap = HashMap<String, SubscribeRequestFilterSlots>;
type AccountFilterMap = HashMap<String, SubscribeRequestFilterAccounts>;
type TransactionFilterMap = HashMap<String, SubscribeRequestFilterTransactions>;
type Hooks = Vec<(AccountFilter, Box<OnAccountFn>)>;
type TransactionHooks = Vec<Box<OnTransactionFn>>;

/// Provides filter criteria for accounts over gRPC
///
/// There are two filter modes:
///
/// * `full` - requires all filters to trigger a match
/// * `partial` - any one filter will trigger a match
///
/// ```example(no_run)
/// // match on discriminator AND memcmp
///  let full = AccountFilter::full()
///     .with_discriminator(User::DISCRIMINATOR)
///     .with_memcmp(..);
///
/// // match on discriminator OR accounts
/// let partial = AccountFilter::partial()
///     .with_discriminator(User::DISCRIMINATOR)
///     .with_accounts([acc1,acc2])
/// ```
#[derive(Clone, Default, Debug)]
pub struct AccountFilter {
    /// optionally filter updates by discriminator
    discriminator: Option<&'static [u8]>,
    /// optionally filter updates by Solana Memcmp matches
    memcmp: Option<Memcmp>,
    /// optionally filter updates by pubkey
    accounts: Option<HashSet<Pubkey>>,
    /// true = full match mode, false = partial
    is_full: bool,
}

impl AccountFilter {
    /// Create a filter that matches ALL accounts!
    pub fn firehose() -> Self {
        AccountFilter::full()
    }
    /// Create a filter that matches iff all parameters are satisfied
    pub fn full() -> Self {
        AccountFilter {
            is_full: true,
            ..Default::default()
        }
    }
    /// Create a filter that matches when any criteria is satisfied
    pub fn partial() -> Self {
        AccountFilter {
            is_full: false,
            ..Default::default()
        }
    }
    /// add filter for given `pubkeys`
    pub fn with_accounts(mut self, pubkeys: impl Iterator<Item = Pubkey>) -> Self {
        self.accounts = Some(ahash::HashSet::from_iter(pubkeys));
        self
    }
    /// add filter for given anchor account `discriminator`
    pub fn with_discriminator(mut self, discriminator: &'static [u8]) -> Self {
        self.discriminator = Some(discriminator);
        self
    }
    /// add filter for given memcmp filter
    pub fn with_memcmp(mut self, memcmp: Memcmp) -> Self {
        self.memcmp = Some(memcmp);
        self
    }
    /// Returns true if pubkey/account matches the filter
    pub fn matches(&self, pubkey: &Pubkey, account: &SubscribeUpdateAccountInfo) -> bool {
        if !self.is_full {
            // partial matches
            self.discriminator.is_some_and(|x| x == &account.data[..8])
                || self.accounts.as_ref().is_some_and(|x| x.contains(pubkey))
                || self
                    .memcmp
                    .as_ref()
                    .is_some_and(|x| x.bytes_match(&account.data))
        } else {
            // full matches
            (match self.discriminator {
                Some(x) => x == &account.data[..8],
                None => true,
            }) && (match self.accounts.as_ref() {
                Some(x) => x.contains(pubkey),
                None => true,
            }) && (match self.memcmp.as_ref() {
                Some(x) => x.bytes_match(&account.data),
                None => true,
            })
        }
    }
}

#[derive(Debug, Clone)]
pub struct GrpcConnectionOpts {
    /// Apply a timeout to connecting to the uri.
    connect_timeout_ms: Option<u64>,
    /// Sets the tower service default internal buffer size, default is 1024
    buffer_size: Option<usize>,
    /// Sets whether to use an adaptive flow control. Uses hyper's default otherwise.
    http2_adaptive_window: Option<bool>,
    /// Set http2 KEEP_ALIVE_TIMEOUT. Uses hyper's default otherwise.
    http2_keep_alive_interval_ms: Option<u64>,
    /// Sets the max connection-level flow control for HTTP2, default is 65,535
    initial_connection_window_size: Option<u32>,
    ///Sets the SETTINGS_INITIAL_WINDOW_SIZE option for HTTP2 stream-level flow control, default is 65,535
    initial_stream_window_size: Option<u32>,
    ///Set http2 KEEP_ALIVE_TIMEOUT. Uses hyper's default otherwise.
    keep_alive_timeout_ms: Option<u64>,
    /// Set http2 KEEP_ALIVE_WHILE_IDLE. Uses hyper's default otherwise.
    keep_alive_while_idle: Option<bool>,
    /// Set whether TCP keepalive messages are enabled on accepted connections.
    tcp_keepalive_ms: Option<u64>,
    /// Set the value of TCP_NODELAY option for accepted connections. Enabled by default.
    tcp_nodelay: Option<bool>,
    /// Apply a timeout to each request.
    timeout_ms: Option<u64>,
    /// Max message size before decoding, full blocks can be super large, default is 1GiB
    max_decoding_message_size: usize,
    /// Turn on zstd compression
    compression: bool,
}

impl GrpcConnectionOpts {
    /// Enable compression
    pub fn enable_compression(mut self) -> Self {
        self.compression = true;
        self
    }
}

impl Default for GrpcConnectionOpts {
    fn default() -> Self {
        Self {
            connect_timeout_ms: None,
            buffer_size: None,
            http2_adaptive_window: None,
            http2_keep_alive_interval_ms: None,
            initial_connection_window_size: None,
            initial_stream_window_size: None,
            keep_alive_timeout_ms: None,
            keep_alive_while_idle: None,
            tcp_keepalive_ms: None,
            tcp_nodelay: None,
            timeout_ms: None,
            max_decoding_message_size: 1024 * 1024 * 1024,
            compression: false,
        }
    }
}

/// Options for the geyser subscription request
#[derive(Debug, Default, Clone)]
pub struct GeyserSubscribeOpts {
    /// Filter by Offset and Data, format: `offset,data in base58`
    pub accounts_memcmp: Vec<Memcmp>,
    /// Filter by Data size
    pub accounts_datasize: Option<u64>,
    /// subscribe must match one of these owners
    pub accounts_owners: Vec<String>,
    /// subscribe must match one of these pubkeys
    pub accounts_pubkeys: Vec<String>,
    /// Re-send message from slot
    pub from_slot: Option<u64>,
    /// Send ping in subscribe request
    pub ping: Option<i32>,
    /// Enable interslot updates
    pub interslot_updates: Option<bool>,
    /// Transaction filters: Filter txs that use any of these accounts
    pub transactions_accounts_include: Vec<String>,
    /// Transaction filters: Filter out txs that use any of these accounts
    pub transactions_accounts_exclude: Vec<String>,
    /// Transaction filters: Txs must include all of these accounts
    pub transactions_accounts_required: Vec<String>,
    /// Subscribe to block metadata updates
    pub blocks_meta: bool,
    /// subscribe to slot updates
    pub slot_updates: bool,
}

#[derive(Debug, thiserror::Error)]
/// drift gRPC error
pub enum GrpcError {
    #[error("grpc connect err: {0}")]
    Geyser(GeyserGrpcBuilderError),
    #[error("grpc request err: {0}")]
    Client(GeyserGrpcClientError),
    #[error("grpc stream err: {0}")]
    Stream(Status),
}

/// specialized Drift gRPC client
pub struct DriftGrpcClient {
    endpoint: String,
    x_token: String,
    grpc_opts: Option<GrpcConnectionOpts>,
    on_account_hooks: Hooks,
    on_slot: Box<dyn Fn(Slot) + Send + Sync + 'static>,
    on_transaction_hooks: TransactionHooks,
    on_block_meta: Box<dyn Fn(SubscribeUpdateBlockMeta) + Send + Sync + 'static>,
}

impl DriftGrpcClient {
    /// Create a new `DriftGrpcClient`
    ///
    /// It can be started by calling `subscribe`
    pub fn new(endpoint: String, x_token: String) -> Self {
        Self {
            endpoint,
            x_token,
            on_account_hooks: Default::default(),
            on_transaction_hooks: Default::default(),
            grpc_opts: None,
            on_slot: Box::new(move |_slot| {}),
            on_block_meta: Box::new(move |_meta| {}),
        }
    }

    /// Set gRPC network options
    pub fn grpc_connection_opts(mut self, grpc_opts: GrpcConnectionOpts) -> Self {
        let _ = self.grpc_opts.insert(grpc_opts);
        self
    }

    /// Add a callback on slot updates
    ///
    /// `on_slot` must prioritize fast handling or risk blocking the gRPC thread
    pub fn on_slot<F: Fn(Slot) + Send + Sync + 'static>(&mut self, on_slot: F) {
        self.on_slot = Box::new(on_slot);
    }

    /// Add a callback on block meta updates
    ///
    /// `on_block_meta` must prioritize fast handling or risk blocking the gRPC thread
    pub fn on_block_meta<F: Fn(SubscribeUpdateBlockMeta) + Send + Sync + 'static>(
        &mut self,
        on_block_meta: F,
    ) {
        self.on_block_meta = Box::new(on_block_meta);
    }

    /// Add a callback for all account updates matching `filter`
    ///
    /// This may be called many times to define multiple callbacks
    ///
    /// * `filter` - filter accounts by criteria
    /// * `on_account` - fn to receive callback on filter match
    ///
    /// DEV: `on_account` must prioritize fast handling or risk blocking the gRPC thread
    pub fn on_account<T: Fn(&AccountUpdate) + Send + Sync + 'static>(
        &mut self,
        filter: AccountFilter,
        on_account: T,
    ) {
        self.on_account_hooks.push((filter, Box::new(on_account)));
    }

    /// Add a callback for transaction updates
    /// !Use with `transaction_include_accounts` to subscribe to specific account txs
    ///
    /// This may be called many times to define multiple callbacks
    ///
    /// * `on_transaction` - fn to receive callback on accounts
    pub fn on_transaction<T: Fn(&TransactionUpdate) + Send + Sync + 'static>(
        &mut self,
        on_transaction: T,
    ) {
        self.on_transaction_hooks.push(Box::new(on_transaction));
    }

    /// Start subscription for geyser updates
    ///
    /// Returns an unsub handle on success
    pub async fn subscribe(
        self,
        commitment: CommitmentLevel,
        subscribe_opts: GeyserSubscribeOpts,
    ) -> Result<UnsubHandle, GrpcError> {
        let mut grpc_client = grpc_connect(
            self.endpoint.as_str(),
            self.x_token.as_str(),
            self.grpc_opts.clone().unwrap_or_default(),
        )
        .await
        .map_err(|err| {
            error!(target: "grpc", "connect failed: {err:?}");
            GrpcError::Geyser(err)
        })?;

        let resp = grpc_client.get_version().await.map_err(GrpcError::Client)?;
        info!("gRPC connected 🔌: {}", resp.version);
        let request = subscribe_opts.to_subscribe_request(commitment);
        info!(target: "grpc", "gRPC subscribing: {request:?}");

        let (unsub_tx, mut unsub_rx) = tokio::sync::oneshot::channel::<()>();

        // gRPC receives updates very frequently, don't want tokio scheduler moving it
        std::thread::spawn(|| {
            let rt = tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
                .unwrap();
            let ls = tokio::task::LocalSet::new();
            let geyser_task = ls.spawn_local(Self::geyser_subscribe(
                grpc_client,
                request,
                self.on_account_hooks,
                self.on_transaction_hooks,
                self.on_slot,
                self.on_block_meta,
            ));
            let mut waiter = FuturesUnordered::new();
            waiter.push(geyser_task);

            // nb: will cause grpc task to drop when triggered but-
            // it doesn't call any 'unsub' endpoint
            ls.block_on(&rt, async move {
                tokio::select! {
                    biased;
                    _ = &mut unsub_rx => (),
                    res = waiter.next() => {
                        if let Ok(Some(err)) = res.unwrap() {
                            log::error!(target: "grpc", "subscription task failed: {err:?}");
                        } else {
                            log::error!(target: "grpc", "subscription task ended unexpectedly");
                        }
                    }
                }
            });
            info!(target: "grpc", "gRPC connection unsubscribed");
        });

        info!(target: "grpc", "gRPC subscribed ⚡️");
        Ok(unsub_tx)
    }

    /// Run the gRPC subscription task
    ///
    /// It receives all configured updates and routes them to registered callbacks
    async fn geyser_subscribe(
        mut client: GeyserGrpcClient<impl Interceptor>,
        request: SubscribeRequest,
        on_account: Hooks,
        on_transaction: TransactionHooks,
        on_slot: impl Fn(Slot),
        on_block_meta: impl Fn(SubscribeUpdateBlockMeta),
    ) -> Option<GrpcError> {
        let max_retries = 3;
        let mut retry_count = 0;
        let mut latest_slot = 0;
        let mut last_error: Option<GrpcError> = None;
        loop {
            if retry_count >= max_retries {
                log::warn!(target: "grpc", "max retry attempts reached. disconnecting...");
                break;
            }
            let (mut subscribe_tx, mut stream) =
                match client.subscribe_with_request(Some(request.clone())).await {
                    Ok(res) => {
                        retry_count = 0;
                        res
                    }
                    Err(err) => {
                        log::warn!(target: "grpc", "failed subscription: {err:?}");
                        retry_count += 1;
                        tokio::time::sleep(Duration::from_secs(2_u64.pow(retry_count + 1))).await;
                        let _ = last_error.insert(GrpcError::Client(err));
                        continue;
                    }
                };

            while let Some(message) = stream.next().await {
                match message {
                    Ok(msg) => {
                        match msg.update_oneof {
                            Some(UpdateOneof::Account(account_update)) => {
                                let account = match account_update.account {
                                    Some(ref account) => account,
                                    None => {
                                        warn!(target: "grpc", "empty account update: {account_update:?}");
                                        continue;
                                    }
                                };
                                let pubkey = Pubkey::new_from_array(
                                    account.pubkey.as_slice().try_into().unwrap(),
                                );
                                log::trace!(target: "grpc", "account update: {pubkey}");
                                let update = AccountUpdate {
                                    owner: Pubkey::new_from_array(
                                        account.owner.as_slice().try_into().unwrap(),
                                    ),
                                    pubkey,
                                    slot: latest_slot,
                                    lamports: account.lamports,
                                    executable: account.executable,
                                    rent_epoch: account.rent_epoch,
                                    data: &account.data,
                                    write_version: account.write_version,
                                };

                                for (filter, hook) in &on_account {
                                    if filter.matches(&pubkey, account) {
                                        hook(&update);
                                    }
                                }
                            }
                            Some(UpdateOneof::Transaction(tx_update)) => {
                                let tx = match tx_update.transaction {
                                    Some(ref tx) => tx,
                                    None => {
                                        warn!(target: "grpc", "empty transaction update: {tx_update:?}");
                                        continue;
                                    }
                                };
                                let transaction = match tx.transaction {
                                    Some(ref tx) => tx,
                                    None => {
                                        warn!(target: "grpc", "empty transaction update: {tx_update:?}");
                                        continue;
                                    }
                                };
                                let meta = match tx.meta {
                                    Some(ref meta) => meta,
                                    None => {
                                        warn!(target: "grpc", "empty transaction meta: {tx_update:?}");
                                        continue;
                                    }
                                };
                                for hook in &on_transaction {
                                    let update = TransactionUpdate {
                                        slot: tx_update.slot,
                                        is_vote: tx.is_vote,
                                        transaction: transaction.clone(),
                                        meta: meta.clone(),
                                    };
                                    hook(&update);
                                }
                            }
                            Some(UpdateOneof::Slot(msg)) => {
                                log::trace!(target: "grpc", "slot: {}", msg.slot);
                                if msg.status() as u8 > 2 {
                                    log::debug!(target: "grpc", "slot: {}, {}", msg.slot, msg.status);
                                }
                                if msg.slot > latest_slot {
                                    latest_slot = msg.slot;
                                    on_slot(latest_slot);
                                }
                            }
                            Some(UpdateOneof::BlockMeta(msg)) => on_block_meta(msg),
                            Some(UpdateOneof::Ping(_)) => {
                                // This is necessary to keep load balancers that expect client pings alive. If your load balancer doesn't
                                // require periodic client pings then this is unnecessary
                                log::debug!(target: "grpc", "ping");
                                let ping = SubscribeRequest {
                                    ping: Some(SubscribeRequestPing { id: 1 }),
                                    ..Default::default()
                                };
                                match tokio::time::timeout(
                                    Duration::from_secs(5),
                                    subscribe_tx.send(ping),
                                )
                                .await
                                {
                                    Ok(Ok(_)) => (),
                                    Ok(Err(err)) => {
                                        log::warn!(target: "grpc", "ping failed: {err:?}");
                                    }
                                    Err(_) => {
                                        log::warn!(target: "grpc", "ping timeout");
                                    }
                                }
                            }
                            Some(UpdateOneof::Pong(_)) => {
                                log::trace!(target: "grpc", "pong");
                            }
                            Some(other_update) => {
                                warn!(target: "grpc", "unhandled update: {other_update:?}");
                            }
                            None => {
                                warn!(target: "grpc", "received empty update");
                                break;
                            }
                        }
                    }
                    Err(status) => {
                        error!(target: "grpc", "stream error: {status:?}");
                        let _ = last_error.insert(GrpcError::Stream(status));
                        break;
                    }
                }
            }
        }

        error!(target: "grpc", "gRPC stream closed");
        last_error
    }
}

impl GeyserSubscribeOpts {
    fn to_subscribe_request(&self, commitment: CommitmentLevel) -> SubscribeRequest {
        let mut accounts = AccountFilterMap::default();
        let mut filters = vec![];
        for filter in self.accounts_memcmp.iter() {
            filters.push(SubscribeRequestFilterAccountsFilter {
                filter: Some(AccountsFilterOneof::Memcmp(
                    SubscribeRequestFilterAccountsFilterMemcmp {
                        offset: filter.offset() as u64,
                        data: filter
                            .bytes()
                            .map(|b| AccountsFilterMemcmpOneof::Bytes(b.to_vec())),
                    },
                )),
            });
        }
        if let Some(datasize) = self.accounts_datasize {
            filters.push(SubscribeRequestFilterAccountsFilter {
                filter: Some(AccountsFilterOneof::Datasize(datasize)),
            });
        }

        if !self.accounts_pubkeys.is_empty() || !self.accounts_owners.is_empty() {
            accounts.insert(
                "client".to_owned(),
                SubscribeRequestFilterAccounts {
                    account: self.accounts_pubkeys.clone(),
                    owner: self.accounts_owners.clone(),
                    filters,
                    ..Default::default()
                },
            );
        }

        let mut slots = SlotsFilterMap::default();
        slots.insert(
            "client".to_owned(),
            SubscribeRequestFilterSlots {
                filter_by_commitment: Some(true),
                interslot_updates: self.interslot_updates,
            },
        );

        let mut blocks_meta = HashMap::new();
        if self.blocks_meta {
            blocks_meta.insert("client".to_owned(), SubscribeRequestFilterBlocksMeta {});
        }

        let mut transactions = TransactionFilterMap::default();
        if !self.transactions_accounts_include.is_empty()
            || !self.transactions_accounts_exclude.is_empty()
            || !self.transactions_accounts_required.is_empty()
        {
            transactions.insert(
                "client".to_owned(),
                SubscribeRequestFilterTransactions {
                    vote: Some(false),
                    failed: Some(false),
                    account_include: self.transactions_accounts_include.clone(),
                    account_exclude: self.transactions_accounts_exclude.clone(),
                    account_required: self.transactions_accounts_required.clone(),
                    ..Default::default()
                },
            );
        }

        let ping = self.ping.map(|id| SubscribeRequestPing { id });

        SubscribeRequest {
            slots,
            accounts,
            transactions,
            commitment: Some(match commitment {
                CommitmentLevel::Confirmed => GeyserCommitmentLevel::Confirmed,
                CommitmentLevel::Processed => GeyserCommitmentLevel::Processed,
                CommitmentLevel::Finalized => GeyserCommitmentLevel::Finalized,
            } as i32),
            ping,
            from_slot: self.from_slot,
            blocks_meta,
            ..Default::default()
        }
    }
}

/// Connect to gRPC endpoint
///
/// Returns a new `GeyserGrpcClient`
async fn grpc_connect(
    endpoint: &str,
    x_token: &str,
    opts: GrpcConnectionOpts,
) -> Result<GeyserGrpcClient<impl Interceptor>, GeyserGrpcBuilderError> {
    info!(target: "grpc", "gRPC connecting: {endpoint}...");
    let mut tls_config = ClientTlsConfig::new().with_native_roots();
    if let Ok(path) = &std::env::var("GRPC_CA_CERT") {
        let bytes = tokio::fs::read(path)
            .await
            .expect("GRPC_CA_CERT path exists");
        tls_config = tls_config.ca_certificate(Certificate::from_pem(bytes));
    }
    let mut builder = GeyserGrpcClient::build_from_shared(endpoint.to_string())?
        .x_token(Some(x_token))?
        .tls_config(tls_config)?
        .max_decoding_message_size(opts.max_decoding_message_size);

    if opts.compression {
        builder = builder.accept_compressed(CompressionEncoding::Zstd);
    }
    if let Some(duration) = opts.connect_timeout_ms {
        builder = builder.connect_timeout(Duration::from_millis(duration));
    }
    if let Some(sz) = opts.buffer_size {
        builder = builder.buffer_size(sz);
    }
    if let Some(enabled) = opts.http2_adaptive_window {
        builder = builder.http2_adaptive_window(enabled);
    }
    if let Some(duration) = opts.http2_keep_alive_interval_ms {
        builder = builder.http2_keep_alive_interval(Duration::from_millis(duration));
    }
    if let Some(sz) = opts.initial_connection_window_size {
        builder = builder.initial_connection_window_size(sz);
    }
    if let Some(sz) = opts.initial_stream_window_size {
        builder = builder.initial_stream_window_size(sz);
    }
    if let Some(duration) = opts.keep_alive_timeout_ms {
        builder = builder.keep_alive_timeout(Duration::from_millis(duration));
    }
    if let Some(enabled) = opts.keep_alive_while_idle {
        builder = builder.keep_alive_while_idle(enabled);
    }
    if let Some(duration) = opts.tcp_keepalive_ms {
        builder = builder.tcp_keepalive(Some(Duration::from_millis(duration)));
    }
    if let Some(enabled) = opts.tcp_nodelay {
        builder = builder.tcp_nodelay(enabled);
    }
    if let Some(duration) = opts.timeout_ms {
        builder = builder.timeout(Duration::from_millis(duration));
    }

    builder.connect().await
}

#[cfg(test)]
mod test {
    use solana_pubkey::Pubkey;

    use super::*;

    fn create_test_account(data: Vec<u8>) -> SubscribeUpdateAccountInfo {
        SubscribeUpdateAccountInfo {
            data,
            ..Default::default()
        }
    }

    #[test]
    fn grpc_partial_match_discriminator() {
        let discriminator = &[1, 2, 3, 4, 5, 6, 7, 8];
        let filter = AccountFilter::partial().with_discriminator(discriminator);

        // Test matching discriminator
        let account = create_test_account(vec![1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
        assert!(filter.matches(&Pubkey::new_unique(), &account));

        // Test non-matching discriminator
        let account = create_test_account(vec![8, 7, 6, 5, 4, 3, 2, 1, 9, 10]);
        assert!(!filter.matches(&Pubkey::new_unique(), &account));
    }

    #[test]
    fn grpc_partial_match_accounts() {
        let pubkey = Pubkey::new_unique();
        let filter = AccountFilter::partial().with_accounts([pubkey].into_iter());

        // Test matching pubkey
        let account = create_test_account(vec![1, 2, 3, 4]);
        assert!(filter.matches(&pubkey, &account));

        // Test non-matching pubkey
        let other_pubkey = Pubkey::new_unique();
        assert!(!filter.matches(&other_pubkey, &account));
    }

    #[test]
    fn grpc_partial_match_memcmp() {
        let memcmp = Memcmp::new_raw_bytes(0, vec![1, 2, 3]);
        let filter = AccountFilter::partial().with_memcmp(memcmp);

        // Test matching memcmp
        let account = create_test_account(vec![1, 2, 3, 4, 5]);
        assert!(filter.matches(&Pubkey::new_unique(), &account));

        // Test non-matching memcmp
        let account = create_test_account(vec![3, 2, 1, 4, 5]);
        assert!(!filter.matches(&Pubkey::new_unique(), &account));
    }

    #[test]
    fn grpc_full_match_all_filters() {
        let pubkey = Pubkey::new_unique();
        let discriminator = &[1, 2, 3, 4, 5, 6, 7, 8];
        let memcmp = Memcmp::new_raw_bytes(8, vec![9, 10]);

        let filter = AccountFilter::full()
            .with_discriminator(discriminator)
            .with_accounts([pubkey].into_iter())
            .with_memcmp(memcmp);

        // Test all match
        let account = create_test_account(vec![1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
        assert!(filter.matches(&pubkey, &account));

        // Test discriminator mismatch
        let account = create_test_account(vec![8, 7, 6, 5, 4, 3, 2, 1, 9, 10]);
        assert!(!filter.matches(&pubkey, &account));

        // Test pubkey mismatch
        let other_pubkey = Pubkey::new_unique();
        let account = create_test_account(vec![1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
        assert!(!filter.matches(&other_pubkey, &account));

        // Test memcmp mismatch
        let account = create_test_account(vec![1, 2, 3, 4, 5, 6, 7, 8, 10, 9]);
        assert!(!filter.matches(&pubkey, &account));
    }

    #[test]
    fn grpc_firehose_matches_everything() {
        let filter = AccountFilter::firehose();
        let pubkey = Pubkey::new_unique();
        let account = create_test_account(vec![1, 2, 3, 4]);

        assert!(filter.matches(&pubkey, &account));
    }
}
