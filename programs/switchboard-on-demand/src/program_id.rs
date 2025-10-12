#[allow(unused_imports)]
use std::str::FromStr;

use crate::solana_compat::pubkey;
use crate::Pubkey;

/// Program id for the Switchboard oracle program
/// SW1TCH7qEPTdLsDHRgPuMQjbQxKdH2aBStViMFnt64f
pub const SWITCHBOARD_PROGRAM_ID: Pubkey = pubkey!("SW1TCH7qEPTdLsDHRgPuMQjbQxKdH2aBStViMFnt64f");

/// Switchboard On-Demand program ID for mainnet
pub const ON_DEMAND_MAINNET_PID: Pubkey = pubkey!("SBondMDrcV3K4kxZR1HNVT7osZxAHVHgYXL5Ze1oMUv");
/// Switchboard On-Demand program ID for devnet
pub const ON_DEMAND_DEVNET_PID: Pubkey = pubkey!("Aio4gaXjXzJNVLtzwtNVmSqGKpANtXhybbkhtAC94ji2");

pub const QUOTE_PROGRAM_ID: Pubkey = pubkey!("orac1eFjzWL5R3RbbdMV68K9H6TaCVVcL6LjvQQWAbz");

/// Gets the Switchboard on-demand program ID based on the current network
pub fn get_switchboard_on_demand_program_id() -> Pubkey {
    if crate::utils::is_devnet() {
        ON_DEMAND_DEVNET_PID
    } else {
        ON_DEMAND_MAINNET_PID
    }
}

/// Gets the Switchboard program ID for a specific cluster
pub fn get_sb_program_id(cluster: &str) -> Pubkey {
    if !cluster.starts_with("mainnet") {
        ON_DEMAND_DEVNET_PID
    } else {
        ON_DEMAND_MAINNET_PID
    }
}
