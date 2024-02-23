use anchor_lang::Discriminator;
use drift::state::user::User;
use solana_client::rpc_filter::{Memcmp, RpcFilterType};

pub fn get_user_filter() -> RpcFilterType {
    RpcFilterType::Memcmp(Memcmp::new_raw_bytes(0, User::discriminator().into()))
}

pub fn get_non_idle_user_filter() -> RpcFilterType {
    RpcFilterType::Memcmp(Memcmp::new_raw_bytes(4_350, vec![1]))
}

pub fn get_user_with_auction_filter() -> RpcFilterType {
    RpcFilterType::Memcmp(Memcmp::new_raw_bytes(4_354, vec![1]))
}

pub fn get_user_with_order_filter() -> RpcFilterType {
    RpcFilterType::Memcmp(Memcmp::new_raw_bytes(4_352, vec![1]))
}
