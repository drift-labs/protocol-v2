//! Drift gRPC module

use crate::solana_sdk::{
    clock::{Epoch, Slot},
    commitment_config::CommitmentLevel,
    pubkey::Pubkey,
};
use anchor_lang::Discriminator;
pub mod grpc_subscriber;
use grpc_subscriber::{AccountFilter, GrpcConnectionOpts};
use yellowstone_grpc_proto::{
    geyser::SubscribeUpdateBlockMeta,
    prelude::{Transaction, TransactionStatusMeta},
};

use crate::types::accounts::User;

/// grpc transaction update callback
pub type OnTransactionFn = dyn Fn(&TransactionUpdate) + Send + Sync + 'static;
/// grpc oracle account update callback
pub type OnOracleFn = dyn Fn(&AccountUpdate) + Send + Sync + 'static;
/// grpc account update callback
pub type OnAccountFn = dyn Fn(&AccountUpdate) + Send + Sync + 'static;
/// grpc slot update callback
pub type OnSlotFn = dyn Fn(Slot) + Send + Sync + 'static;
/// grpc block metadata update callback
pub type OnBlockMetaFn = dyn Fn(SubscribeUpdateBlockMeta) + Send + Sync + 'static;

/// Account update from gRPC
#[derive(PartialEq, Eq, Clone)]
pub struct AccountUpdate<'a> {
    /// the account's pubkey
    pub pubkey: Pubkey,
    /// the program that owns the account. If executable, the program that loads the account.
    pub owner: Pubkey,
    /// data held in the account
    pub data: &'a [u8],
    /// lamports in the account
    pub lamports: u64,
    /// the epoch at which the account will next owe rent
    pub rent_epoch: Epoch,
    /// Slot the update was retrieved
    pub slot: Slot,
    /// A global monotonically increasing atomic number, which can be used
    /// to tell the order of the account update. For example, when an
    /// account is updated in the same slot multiple times, the update
    /// with higher write_version should supersede the one with lower
    pub write_version: u64,
    /// the account's data contains a loaded program (and is now read-only)
    pub executable: bool,
}
/// Transaction update from gRPC
#[derive(Clone, Debug)]
pub struct TransactionUpdate {
    /// slot of the transaction
    pub slot: u64,
    /// true if this is a vote transaction
    pub is_vote: bool,
    pub transaction: Transaction,
    pub meta: TransactionStatusMeta,
}

/// Config options for drift gRPC subscription
///
/// ```example(no_run)
///   // subscribe to all user and users stats accounts
///   let opts = GrpcSubscribeOpts::default()
///                .usermap_on() // subscribe to ALL user accounts
///                .statsmap_on(); // subscribe to ALL user stats accounts
///
///  // cache specific user accounts only and set a new slot callback
///  let first_3_subaccounts = (0_u16..3).into_iter().map(|i| wallet.sub_account(i)).collect();
///  let opts = GrpcSubscribeOpts::default()
///                 .user_accounts(first_3_subaccounts);
///                 .on_slot(move |new_slot| {}) // slot callback
/// ```
///
pub struct GrpcSubscribeOpts {
    pub commitment: Option<CommitmentLevel>,
    /// cache user account updates (default: false)
    pub usermap: bool,
    /// cache oracle account updates (default: true)
    pub oraclemap: bool,
    /// toggle user stats map
    pub user_stats_map: bool,
    /// list of user (sub)accounts to subscribe
    pub user_accounts: Vec<Pubkey>,
    /// callback for slot updates
    pub on_slot: Option<Box<OnSlotFn>>,
    /// custom callback for account updates
    pub on_account: Option<Vec<(AccountFilter, Box<OnAccountFn>)>>,
    /// custom callback for tx updates
    pub on_transaction: Option<Box<OnTransactionFn>>,
    /// custom callback for oracle account updates
    pub on_oracle_update: Option<Box<OnOracleFn>>,
    /// Network level connection config
    pub connection_opts: GrpcConnectionOpts,
    /// Enable inter-slot update notifications
    pub interslot_updates: bool,
    /// Watch transactions including these accounts
    pub transaction_include_accounts: Vec<Pubkey>,
    /// Subscribe to block metadata updates
    pub subscribe_block_meta_updates: bool,
    /// custom callback for block meta updates
    pub on_block_meta: Option<Box<OnBlockMetaFn>>,
    /// Subscribe to slot updates
    pub subscribe_slot_updates: bool,
}

impl Default for GrpcSubscribeOpts {
    fn default() -> Self {
        Self {
            commitment: Some(CommitmentLevel::Confirmed),
            usermap: false,
            user_stats_map: false,
            oraclemap: true,
            user_accounts: Default::default(),
            transaction_include_accounts: Default::default(),
            on_slot: None,
            on_transaction: None,
            on_account: None,
            on_oracle_update: None,
            connection_opts: GrpcConnectionOpts::default(),
            interslot_updates: false,
            subscribe_block_meta_updates: false,
            subscribe_slot_updates: true,
            on_block_meta: None,
        }
    }
}

impl GrpcSubscribeOpts {
    /// Set the gRPC subscription's commitment level (default: 'confirmed')
    pub fn commitment(mut self, commitment: CommitmentLevel) -> Self {
        self.commitment = Some(commitment);
        self
    }
    /// Enables the subscription to receive updates for changes within a slot,  
    /// not just at the beginning of new slots. default: false
    pub fn interslot_updates_on(mut self) -> Self {
        self.interslot_updates = true;
        self
    }
    /// Cache ALL drift `User` account updates
    ///
    /// useful for e.g. building the DLOB, fast TX building for makers
    ///
    /// note: memory requirements ~2GiB
    pub fn usermap_on(mut self) -> Self {
        self.usermap = true;
        self
    }
    /// Disable oraclemap, will not cache oracle account updates
    pub fn oraclemap_off(mut self) -> Self {
        self.oraclemap = false;
        self
    }
    /// Cache ALL drift `UserStats` account updates
    ///
    /// useful for e.g. fast TX building for makers
    pub fn statsmap_on(mut self) -> Self {
        self.user_stats_map = true;
        self
    }
    /// Cache ALL drift `UserStats` account updates
    ///
    /// useful for e.g. fast TX building for makers
    pub fn statsmap_off(mut self) -> Self {
        self.user_stats_map = false;
        self
    }
    /// Cache account updates for given `users` only
    pub fn user_accounts(mut self, users: Vec<Pubkey>) -> Self {
        self.user_accounts = users;
        self
    }
    /// Set a callback to invoke on new slot updates
    ///
    /// * `on_slot` - the callback for new slot updates
    ///
    /// ! `on_slot` must not block the gRPC task
    pub fn on_slot(mut self, on_slot: impl Fn(Slot) + Send + Sync + 'static) -> Self {
        self.on_slot = Some(Box::new(on_slot));
        self
    }
    /// Set a callback to invoke on new block metadata updates
    ///
    /// Caller should also set `subscribe_block_meta(true)` or no updates will be received
    ///
    /// * `on_block_meta` - the callback for new block metadata updates
    ///
    /// ! `on_block_meta` must not block the gRPC task
    pub fn on_block_meta(
        mut self,
        on_block_meta: impl Fn(SubscribeUpdateBlockMeta) + Send + Sync + 'static,
    ) -> Self {
        self.on_block_meta = Some(Box::new(on_block_meta));
        self
    }
    /// Register a custom callback for account updates
    ///
    /// * `filter` - accounts matching filter will invoke the callback
    /// * `callback` - fn to invoke on matching account update
    ///
    /// ! `callback` must not block the gRPC task
    pub fn on_account(
        mut self,
        filter: AccountFilter,
        callback: impl Fn(&AccountUpdate) + Send + Sync + 'static,
    ) -> Self {
        match &mut self.on_account {
            Some(on_account) => {
                on_account.push((filter, Box::new(callback)));
            }
            None => {
                self.on_account = Some(vec![(filter, Box::new(callback))]);
            }
        }
        self
    }
    /// Register a custom callback for User account updates
    ///
    /// * `callback` - fn to invoke on all User account update
    ///
    /// ! `callback` must not block the gRPC task
    pub fn on_user_account(
        self,
        callback: impl Fn(&AccountUpdate) + Send + Sync + 'static,
    ) -> Self {
        let filter = AccountFilter::partial().with_discriminator(User::DISCRIMINATOR);
        self.on_account(filter, callback)
    }
    /// Register a custom callback for oracle account updates
    /// It will be called _before_ the oraclemap is updated
    ///
    /// * `callback` - fn to invoke on matching account update
    ///
    /// ! `callback` must not block the gRPC task
    pub fn on_oracle_update(
        mut self,
        callback: impl Fn(&AccountUpdate) + Send + Sync + 'static,
    ) -> Self {
        self.on_oracle_update = Some(Box::new(callback));
        self
    }
    /// Set network level connection opts
    pub fn connection_opts(mut self, opts: GrpcConnectionOpts) -> Self {
        self.connection_opts = opts;
        self
    }
    /// Subscribe to transactions including `accounts`
    pub fn transaction_include_accounts(mut self, accounts: Vec<Pubkey>) -> Self {
        self.transaction_include_accounts = accounts;
        self
    }
    /// Register a custom callback for transaction updates
    ///
    /// * `callback` - fn to invoke on matching account update
    ///
    /// ! `callback` must not block the gRPC task
    pub fn on_transaction(
        mut self,
        callback: impl Fn(&TransactionUpdate) + Send + Sync + 'static,
    ) -> Self {
        self.on_transaction = Some(Box::new(callback));
        self
    }
    /// Subscribe to slot updates (default: true)
    pub fn subscribe_slots(mut self, subscribe: bool) -> Self {
        self.subscribe_slot_updates = subscribe;
        self
    }
    /// Subscribe to slot updates (default: false)
    pub fn subscribe_block_meta(mut self, subscribe: bool) -> Self {
        self.subscribe_block_meta_updates = subscribe;
        self
    }
}
