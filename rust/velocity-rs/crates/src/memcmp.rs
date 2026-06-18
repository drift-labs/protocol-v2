use anchor_lang::Discriminator;
use solana_rpc_client_api::filter::{Memcmp, RpcFilterType};

use crate::types::{
    accounts::{PerpMarket, SpotMarket, User, UserStats},
    MarketType,
};

pub fn get_user_filter() -> RpcFilterType {
    RpcFilterType::Memcmp(Memcmp::new_raw_bytes(0, User::DISCRIMINATOR.to_vec()))
}

pub fn get_hlm_user_filter() -> RpcFilterType {
    RpcFilterType::Memcmp(Memcmp::new_raw_bytes(4_355, vec![1]))
}

pub fn get_non_idle_user_filter() -> RpcFilterType {
    RpcFilterType::Memcmp(Memcmp::new_raw_bytes(4_350, vec![0]))
}

pub fn get_user_with_auction_filter() -> RpcFilterType {
    RpcFilterType::Memcmp(Memcmp::new_raw_bytes(4_354, vec![1]))
}

pub fn get_user_with_order_filter() -> RpcFilterType {
    RpcFilterType::Memcmp(Memcmp::new_raw_bytes(4_352, vec![1]))
}

pub fn get_user_stats_filter() -> RpcFilterType {
    RpcFilterType::Memcmp(Memcmp::new_raw_bytes(0, UserStats::DISCRIMINATOR.to_vec()))
}

pub fn get_user_stats_is_referred_filter() -> RpcFilterType {
    RpcFilterType::Memcmp(Memcmp::new_raw_bytes(188, vec![2]))
}

pub fn get_user_stats_is_referred_or_referrer_filter() -> RpcFilterType {
    RpcFilterType::Memcmp(Memcmp::new_raw_bytes(188, vec![3]))
}

pub fn get_market_filter(market_type: MarketType) -> RpcFilterType {
    match market_type {
        MarketType::Spot => {
            RpcFilterType::Memcmp(Memcmp::new_raw_bytes(0, SpotMarket::DISCRIMINATOR.to_vec()))
        }
        MarketType::Perp => {
            RpcFilterType::Memcmp(Memcmp::new_raw_bytes(0, PerpMarket::DISCRIMINATOR.to_vec()))
        }
    }
}
