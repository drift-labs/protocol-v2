use anyhow::{anyhow, Result};
use drift::math::constants::BASE_PRECISION;
use drift::math::constants::PRICE_PRECISION;
use drift::math::constants::QUOTE_PRECISION;
use drift::state::user::Order;
use drift::state::user::OrderStatus;
use drift::state::user::PerpPosition;
use parking_lot::Mutex;
use std::collections::HashMap;
use std::fmt::Display;
use std::str::FromStr;
use std::sync::Arc;

use anchor_client::solana_sdk::commitment_config::CommitmentLevel;
use anchor_client::solana_sdk::pubkey::Pubkey;

use drift::state::perp_market::PerpMarket;
use drift::state::spot_market::SpotMarket;
use drift::state::user::User;
use drift::state::user::UserStats;

#[derive(Debug, Clone)]
pub struct AccountDataWithSlot<T> {
    pub pubkey: Option<Pubkey>,
    pub data: T,
    pub slot: Option<u64>,
}

pub trait DriftClientAccountSubscriber {
    fn load(&mut self) -> Result<(), anyhow::Error>;

    fn get_program_id(&self) -> Pubkey;
    fn get_perp_market_accounts_map(
        &self,
    ) -> Arc<Mutex<HashMap<Pubkey, AccountDataWithSlot<PerpMarket>>>>;
    fn get_spot_market_accounts_map(
        &self,
    ) -> Arc<Mutex<HashMap<Pubkey, AccountDataWithSlot<SpotMarket>>>>;
    fn get_user_accounts_map(&self) -> Arc<Mutex<HashMap<Pubkey, AccountDataWithSlot<User>>>>;
    fn get_user_stats_accounts_map(
        &self,
    ) -> Arc<Mutex<HashMap<Pubkey, AccountDataWithSlot<UserStats>>>>;

    fn get_perp_market_by_pubkey(&self, pubkey: &Pubkey) -> Option<PerpMarket> {
        self.get_perp_market_accounts_map()
            .lock()
            .get(pubkey)
            .map(|x| x.data)
    }
    fn get_spot_market_by_pubkey(&self, pubkey: &Pubkey) -> Option<SpotMarket> {
        self.get_spot_market_accounts_map()
            .lock()
            .get(pubkey)
            .map(|x| x.data)
    }
    fn get_perp_market_by_market_index(&self, market_index: u16) -> Option<PerpMarket> {
        let pubkey = get_perp_market_pda(self.get_program_id(), market_index);
        self.get_perp_market_by_pubkey(&pubkey)
    }
    fn get_spot_market_by_market_index(&self, market_index: u16) -> Option<SpotMarket> {
        let pubkey = get_spot_market_pda(self.get_program_id(), market_index);
        self.get_spot_market_by_pubkey(&pubkey)
    }
    fn get_user(&self, authority: &Pubkey, subaccount_id: u16) -> Option<User> {
        let user_pubkey = get_user_pubkey_pda(self.get_program_id(), *authority, subaccount_id);
        self.get_user_accounts_map()
            .lock()
            .get(&user_pubkey)
            .map(|x| x.data)
    }
    fn get_user_stats(&self, authority: &Pubkey) -> Option<UserStats> {
        let user_stats_pubkey = get_user_stats_pubkey_pda(self.get_program_id(), *authority);
        self.get_user_stats_accounts_map()
            .lock()
            .get(&user_stats_pubkey)
            .map(|x| x.data)
    }
    fn get_all_users(&self) -> Vec<AccountDataWithSlot<User>> {
        self.get_user_accounts_map()
            .lock()
            .values()
            .map(|x| x.clone())
            .collect()
    }

    fn get_perp_market_by_pubkey_with_slot(
        &self,
        pubkey: &Pubkey,
    ) -> Option<AccountDataWithSlot<PerpMarket>> {
        self.get_perp_market_accounts_map()
            .lock()
            .get(pubkey)
            .map(|x| x)
            .cloned()
    }

    fn get_spot_market_by_pubkey_with_slot(
        &self,
        pubkey: &Pubkey,
    ) -> Option<AccountDataWithSlot<SpotMarket>> {
        self.get_spot_market_accounts_map()
            .lock()
            .get(pubkey)
            .map(|x| x)
            .cloned()
    }
    fn get_perp_market_by_market_index_with_slot(
        &self,
        market_index: u16,
    ) -> Option<AccountDataWithSlot<PerpMarket>> {
        let pubkey = get_perp_market_pda(self.get_program_id(), market_index);
        self.get_perp_market_by_pubkey_with_slot(&pubkey)
    }

    /// compute PDA of market account then check local map for it
    fn get_spot_market_by_market_index_with_slot(
        &self,
        market_index: u16,
    ) -> Option<AccountDataWithSlot<SpotMarket>> {
        let pubkey = get_spot_market_pda(self.get_program_id(), market_index);
        self.get_spot_market_by_pubkey_with_slot(&pubkey)
    }

    fn get_user_with_slot(
        &self,
        authority: &Pubkey,
        subaccount_id: u16,
    ) -> Option<AccountDataWithSlot<User>> {
        let user_pubkey = get_user_pubkey_pda(self.get_program_id(), *authority, subaccount_id);
        self.get_user_accounts_map()
            .lock()
            .get(&user_pubkey)
            .map(|x| x)
            .cloned()
    }

    fn get_user_stats_with_slot(
        &self,
        authority: &Pubkey,
    ) -> Option<AccountDataWithSlot<UserStats>> {
        let user_stats_pubkey = get_user_stats_pubkey_pda(self.get_program_id(), *authority);
        self.get_user_stats_accounts_map()
            .lock()
            .get(&user_stats_pubkey)
            .map(|x| x)
            .cloned()
    }

    fn num_tracked_perp_markets(&self) -> usize {
        self.get_perp_market_accounts_map().lock().len()
    }

    fn num_tracked_spot_markets(&self) -> usize {
        self.get_spot_market_accounts_map().lock().len()
    }

    fn num_tracked_users(&self) -> usize {
        self.get_user_accounts_map().lock().len()
    }
}

#[derive(Debug, Clone, Default)]
pub struct MockDriftClientAccountSubscriber {}

impl DriftClientAccountSubscriber for MockDriftClientAccountSubscriber {
    fn load(&mut self) -> Result<(), anyhow::Error> {
        Ok(())
    }

    fn get_program_id(&self) -> Pubkey {
        Pubkey::from_str("dRiftyHA39MWEi3m9aunc5MzRF1JYuBsbn6VPcn33UH").unwrap()
    }

    fn get_perp_market_accounts_map(
        &self,
    ) -> Arc<Mutex<HashMap<Pubkey, AccountDataWithSlot<PerpMarket>>>> {
        Arc::new(Mutex::new(HashMap::new()))
    }

    fn get_spot_market_accounts_map(
        &self,
    ) -> Arc<Mutex<HashMap<Pubkey, AccountDataWithSlot<SpotMarket>>>> {
        Arc::new(Mutex::new(HashMap::new()))
    }

    fn get_user_accounts_map(&self) -> Arc<Mutex<HashMap<Pubkey, AccountDataWithSlot<User>>>> {
        Arc::new(Mutex::new(HashMap::new()))
    }

    fn get_user_stats_accounts_map(
        &self,
    ) -> Arc<Mutex<HashMap<Pubkey, AccountDataWithSlot<UserStats>>>> {
        Arc::new(Mutex::new(HashMap::new()))
    }
}

#[derive(Debug, Clone, Default)]
pub struct DriftClientAccountSubscriberCommon {
    pub program_id: Pubkey,
    pub commitment: CommitmentLevel,

    pub perp_market_indexes_to_watch: Option<Vec<u16>>,
    pub spot_market_indexes_to_watch: Option<Vec<u16>>,
    pub authorities_to_watch: Option<Vec<Pubkey>>,

    pub perp_market_accounts: Arc<Mutex<HashMap<Pubkey, AccountDataWithSlot<PerpMarket>>>>,
    pub spot_market_accounts: Arc<Mutex<HashMap<Pubkey, AccountDataWithSlot<SpotMarket>>>>,

    /// Map of authority -> user pubkey -> user account
    pub user_accounts: Arc<Mutex<HashMap<Pubkey, AccountDataWithSlot<User>>>>,
    pub user_stats_accounts: Arc<Mutex<HashMap<Pubkey, AccountDataWithSlot<UserStats>>>>,
}

impl DriftClientAccountSubscriber for DriftClientAccountSubscriberCommon {
    fn load(&mut self) -> Result<(), anyhow::Error> {
        Err(anyhow!("Function not yet implemented"))
    }

    fn get_program_id(&self) -> Pubkey {
        self.program_id
    }

    fn get_perp_market_accounts_map(
        &self,
    ) -> Arc<Mutex<HashMap<Pubkey, AccountDataWithSlot<PerpMarket>>>> {
        self.perp_market_accounts.clone()
    }

    fn get_spot_market_accounts_map(
        &self,
    ) -> Arc<Mutex<HashMap<Pubkey, AccountDataWithSlot<SpotMarket>>>> {
        self.spot_market_accounts.clone()
    }

    fn get_user_accounts_map(&self) -> Arc<Mutex<HashMap<Pubkey, AccountDataWithSlot<User>>>> {
        self.user_accounts.clone()
    }

    fn get_user_stats_accounts_map(
        &self,
    ) -> Arc<Mutex<HashMap<Pubkey, AccountDataWithSlot<UserStats>>>> {
        self.user_stats_accounts.clone()
    }
}

pub fn get_perp_market_pda(program_id: Pubkey, market_index: u16) -> Pubkey {
    Pubkey::find_program_address(
        &[b"perp_market", market_index.to_le_bytes().as_ref()],
        &program_id,
    )
    .0
}

pub fn get_spot_market_pda(program_id: Pubkey, market_index: u16) -> Pubkey {
    Pubkey::find_program_address(
        &[b"spot_market", market_index.to_le_bytes().as_ref()],
        &program_id,
    )
    .0
}

pub fn get_user_pubkey_pda(program_id: Pubkey, authority: Pubkey, subaccount_id: u16) -> Pubkey {
    Pubkey::find_program_address(
        &[
            b"user",
            authority.as_ref(),
            subaccount_id.to_le_bytes().as_ref(),
        ],
        &program_id,
    )
    .0
}

pub fn get_user_stats_pubkey_pda(program_id: Pubkey, authority: Pubkey) -> Pubkey {
    Pubkey::find_program_address(&[b"user_stats", authority.to_bytes().as_ref()], &program_id).0
}

pub struct DisplayPerpPosition<'a>(pub &'a PerpPosition);
impl<'a> Display for DisplayPerpPosition<'a> {
    fn fmt(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
        let p = self.0;
        write!(
            f,
            "
Market Index: {}
  Base position:  {}
  Quote position: {}
  LP shares:      {}
        ",
            p.market_index,
            p.base_asset_amount as f64 / BASE_PRECISION as f64,
            p.quote_asset_amount as f64 / QUOTE_PRECISION as f64,
            p.lp_shares as f64 / BASE_PRECISION as f64,
        )
    }
}

pub struct DisplayUser<'a>(pub &'a User);
impl<'a> Display for DisplayUser<'a> {
    fn fmt(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
        let user = self.0;
        write!(
            f,
            "
Name:         {}
SubaccountID: {}
Idle: {}, Being Liquidated: {}, Bankrupt: {}
Next orderID: {}, Next liquidationID: {}
Authority:    {}
Delegate:     {}
Total deposits:  {}
Total withdraws: {}
Total social loss: {}
Open orders:   {} (has open orders: {})
Open auctions: {} (has open auctions: {})

Perp Positions:
{}
        ",
            String::from_utf8_lossy(&user.name),
            user.sub_account_id,
            user.idle,
            user.is_being_liquidated(),
            user.is_bankrupt(),
            user.next_order_id,
            user.next_liquidation_id,
            user.authority.to_string(),
            user.delegate.to_string(),
            user.total_deposits as f64 / QUOTE_PRECISION as f64,
            user.total_withdraws as f64 / QUOTE_PRECISION as f64,
            user.total_social_loss as f64 / QUOTE_PRECISION as f64,
            user.open_orders,
            user.has_open_order,
            user.open_auctions,
            user.has_open_auction,
            user.perp_positions
                .iter()
                .map(|x| {
                    if !x.is_available() {
                        return format!("{}", DisplayPerpPosition(x));
                    } else {
                        // return format!("{}: unavailable", x.market_index)
                        return format!("");
                    }
                })
                .collect::<Vec<_>>()
                .join(""),
        )
    }
}

pub struct DisplayOrder<'a>(pub &'a Order);
impl<'a> Display for DisplayOrder<'a> {
    fn fmt(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
        let order = self.0;
        write!(
            f,
            "
Status:    {:?}
OrderID:      {:?}
User OrderID: {:?}
Direction: {:?}
Order Type:   {:?}
Market Type:  {:?}
Market Index: {:?}
Base Asset Amount Filled: {:?}/{:?}
Quote Asset Amount Filled: {:?}

Price:               {:?}
Oracle Price Offset: {:?}
Auction Start Price: {:?}
Auction End Price:   {:?}
Auction Duration:    {:?}

Trigger Condition: {:?}
Trigger Price:     {:?}
        ",
            order.status,
            order.order_id,
            order.user_order_id,
            order.direction,
            order.order_type,
            order.market_type,
            order.market_index,
            order.base_asset_amount_filled as f64 / BASE_PRECISION as f64,
            order.base_asset_amount as f64 / BASE_PRECISION as f64,
            order.quote_asset_amount_filled as f64 / QUOTE_PRECISION as f64,
            order.price as f64 / PRICE_PRECISION as f64,
            order.oracle_price_offset as f64 / PRICE_PRECISION as f64,
            order.auction_start_price as f64 / PRICE_PRECISION as f64,
            order.auction_end_price as f64 / PRICE_PRECISION as f64,
            order.auction_duration,
            order.trigger_condition,
            order.trigger_price as f64 / PRICE_PRECISION as f64,
        )
    }
}
