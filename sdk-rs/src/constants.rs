use std::sync::OnceLock;

pub use drift_program::{
    math::constants::{
        BASE_PRECISION_U64 as BASE_PRECISION, QUOTE_PRECISION_U64 as QUOTE_PRECISION,
    },
    ID as PROGRAM_ID,
};
use solana_sdk::pubkey::Pubkey;
use substreams_solana_macro::b58;

use crate::types::Context;

static STATE_ACCOUNT: OnceLock<Pubkey> = OnceLock::new();
static SPOT_MARKETS_DEV: OnceLock<[SpotMarketConfig<'static>; 3]> = OnceLock::new();
static SPOT_MARKETS_MAINNET: OnceLock<[SpotMarketConfig<'static>; 7]> = OnceLock::new();
static PERP_MARKETS_DEV: OnceLock<[PerpMarketConfig<'static>; 18]> = OnceLock::new();
static PERP_MARKETS_MAINNET: OnceLock<[PerpMarketConfig<'static>; 18]> = OnceLock::new();

/// Drift state account
pub fn state_account() -> &'static Pubkey {
    STATE_ACCOUNT.get_or_init(|| {
        let (state_account, _seed) =
            Pubkey::find_program_address(&[&b"drift_state"[..]], &PROGRAM_ID);
        state_account
    })
}

/// Metadata of deployed spot market
#[derive(Copy, Clone)]
pub struct SpotMarketConfig<'a> {
    pub symbol: &'a str,
    pub market_index: u16,
    pub oracle: Pubkey,
    pub account: Pubkey,
    pub precision: u128,
    pub precision_exp: u8,
}

impl<'a> SpotMarketConfig<'a> {
    fn new(symbol: &'a str, market_index: u16, oracle: Pubkey, precision_exp: u8) -> Self {
        let (account, _seed) = Pubkey::find_program_address(
            &[&b"spot_market"[..], &market_index.to_le_bytes()],
            &PROGRAM_ID,
        );
        Self {
            symbol,
            market_index,
            oracle,
            account,
            precision: 10_u128.pow(precision_exp as u32),
            precision_exp,
        }
    }
}

/// Metadata of deployed perp market
#[derive(Copy, Clone)]
pub struct PerpMarketConfig<'a> {
    pub symbol: &'a str,
    pub base_asset_symbol: &'a str,
    pub market_index: u16,
    pub oracle: Pubkey,
    pub account: Pubkey,
}

impl<'a> PerpMarketConfig<'a> {
    fn new(symbol: &'a str, base_asset_symbol: &'a str, market_index: u16, oracle: Pubkey) -> Self {
        let (account, _seed) = Pubkey::find_program_address(
            &[&b"perp_market"[..], &market_index.to_le_bytes()],
            &PROGRAM_ID,
        );
        Self {
            symbol,
            base_asset_symbol,
            market_index,
            oracle,
            account,
        }
    }
}

/// Return known spot markets
pub fn spot_market_configs(context: Context) -> &'static [SpotMarketConfig<'static>] {
    match context {
        Context::DevNet => SPOT_MARKETS_DEV.get_or_init(init_spot_markets_dev).as_ref(),
        Context::MainNet => SPOT_MARKETS_MAINNET
            .get_or_init(init_spot_markets_mainnet)
            .as_ref(),
    }
}

/// Return the spot market config given a market index
pub fn spot_market_config_by_index(
    context: Context,
    market_index: u16,
) -> Option<&'static SpotMarketConfig<'static>> {
    match context {
        Context::DevNet => SPOT_MARKETS_DEV
            .get_or_init(init_spot_markets_dev)
            .get(market_index as usize),
        Context::MainNet => SPOT_MARKETS_MAINNET
            .get_or_init(init_spot_markets_mainnet)
            .get(market_index as usize),
    }
}

/// Return known perp markets
pub fn perp_market_configs(context: Context) -> &'static [PerpMarketConfig<'static>] {
    match context {
        Context::DevNet => PERP_MARKETS_DEV.get_or_init(init_perp_markets_dev),
        Context::MainNet => PERP_MARKETS_MAINNET.get_or_init(init_perp_markets_mainnet),
    }
}

/// Return the perp market config given a market index
pub fn perp_market_config_by_index(
    context: Context,
    market_index: u16,
) -> Option<&'static PerpMarketConfig<'static>> {
    match context {
        Context::DevNet => PERP_MARKETS_DEV
            .get_or_init(init_perp_markets_dev)
            .get(market_index as usize),
        Context::MainNet => PERP_MARKETS_MAINNET
            .get_or_init(init_perp_markets_mainnet)
            .get(market_index as usize),
    }
}

fn init_spot_markets_dev() -> [SpotMarketConfig<'static>; 3] {
    [
        SpotMarketConfig::new(
            "USDC",
            0,
            Pubkey::new_from_array(b58!("5SSkXsEKQepHHAewytPVwdej4epN1nxgLVM84L4KXgy7")),
            6,
        ),
        SpotMarketConfig::new(
            "SOL",
            1,
            Pubkey::new_from_array(b58!("J83w4HKfqxwcq3BEMMkPFSppX3gqekLyLJBexebFVkix")),
            8,
        ),
        SpotMarketConfig::new(
            "wBTC", // this is 'BTC" in the ts SDK, changed it for parity with equivalent mainnet market
            2,
            Pubkey::new_from_array(b58!("HovQMDrbAgAYPCmHVSrezcSmkMtXSSUsLDFANExrZh2J")),
            6,
        ),
    ]
}

fn init_spot_markets_mainnet() -> [SpotMarketConfig<'static>; 7] {
    [
        SpotMarketConfig::new(
            "USDC",
            0,
            Pubkey::new_from_array(b58!("Gnt27xtC473ZT2Mw5u8wZ68Z3gULkSTb5DuxJy7eJotD")),
            6,
        ),
        SpotMarketConfig::new(
            "SOL",
            1,
            Pubkey::new_from_array(b58!("H6ARHf6YXhGYeQfUzQNGk6rDNnLBQKrenN712K4AQJEG")),
            8,
        ),
        SpotMarketConfig::new(
            "mSOL",
            2,
            Pubkey::new_from_array(b58!("E4v1BBgoso9s64TQvmyownAVJbhbEPGyzA3qn4n46qj9")),
            9,
        ),
        SpotMarketConfig::new(
            "wBTC",
            3,
            Pubkey::new_from_array(b58!("GVXRSBjFk6e6J3NbVPXohDJetcTjaeeuykUpbQF8UoMU")),
            8,
        ),
        SpotMarketConfig::new(
            "wETH",
            4,
            Pubkey::new_from_array(b58!("JBu1AL4obBcCMqKBBxhpWCNUt136ijcuMZLFvTP7iWdB")),
            8,
        ),
        SpotMarketConfig::new(
            "USDT",
            5,
            Pubkey::new_from_array(b58!("3vxLXJqLqF3JG5TCbYycbKWRBbCJQLxQmBGCkyqEEefL")),
            6,
        ),
        SpotMarketConfig::new(
            "jitoSOL",
            6,
            Pubkey::new_from_array(b58!("7yyaeuJ1GGtVBLT2z2xub5ZWYKaNhF28mj1RdV4VDFVk")),
            9,
        ),
    ]
}

fn init_perp_markets_dev() -> [PerpMarketConfig<'static>; 18] {
    [
        PerpMarketConfig::new(
            "SOL-PERP",
            "SOL",
            0,
            Pubkey::new_from_array(b58!("J83w4HKfqxwcq3BEMMkPFSppX3gqekLyLJBexebFVkix")),
        ),
        PerpMarketConfig::new(
            "BTC-PERP",
            "BTC",
            1,
            Pubkey::new_from_array(b58!("HovQMDrbAgAYPCmHVSrezcSmkMtXSSUsLDFANExrZh2J")),
        ),
        PerpMarketConfig::new(
            "ETH-PERP",
            "ETH",
            2,
            Pubkey::new_from_array(b58!("EdVCmQ9FSPcVe5YySXDPCRmc8aDQLKJ9xvYBMZPie1Vw")),
        ),
        PerpMarketConfig::new(
            "APT-PERP",
            "APT",
            3,
            Pubkey::new_from_array(b58!("5d2QJ6u2NveZufmJ4noHja5EHs3Bv1DUMPLG5xfasSVs")),
        ),
        PerpMarketConfig::new(
            "1MBONK-PERP",
            "1MBONK",
            4,
            Pubkey::new_from_array(b58!("6bquU99ktV1VRiHDr8gMhDFt3kMfhCQo5nfNrg2Urvsn")),
        ),
        PerpMarketConfig::new(
            "MATIC-PERP",
            "MATIC",
            5,
            Pubkey::new_from_array(b58!("FBirwuDFuRAu4iSGc7RGxN5koHB7EJM1wbCmyPuQoGur")),
        ),
        PerpMarketConfig::new(
            "ARB-PERP",
            "ARB",
            6,
            Pubkey::new_from_array(b58!("4mRGHzjGerQNWKXyQAmr9kWqb9saPPHKqo1xziXGQ5Dh")),
        ),
        PerpMarketConfig::new(
            "DOGE-PERP",
            "DOGE",
            7,
            Pubkey::new_from_array(b58!("4L6YhY8VvUgmqG5MvJkUJATtzB2rFqdrJwQCmFLv4Jzy")),
        ),
        PerpMarketConfig::new(
            "BNB-PERP",
            "BNB",
            8,
            Pubkey::new_from_array(b58!("GwzBgrXb4PG59zjce24SF2b9JXbLEjJJTBkmytuEZj1b")),
        ),
        PerpMarketConfig::new(
            "SUI-PERP",
            "SUI",
            9,
            Pubkey::new_from_array(b58!("6SK9vS8eMSSj3LUX2dPku93CrNv8xLCp9ng39F39h7A5")),
        ),
        PerpMarketConfig::new(
            "1MPEPE-PERP",
            "1MPEPE",
            10,
            Pubkey::new_from_array(b58!("Gz9RfgDeAFSsH7BHDGyNTgCik74rjNwsodJpsCizzmkj")),
        ),
        PerpMarketConfig::new(
            "OP-PERP",
            "OP",
            11,
            Pubkey::new_from_array(b58!("8ctSiDhA7eJoii4TkKV8Rx4KFdz3ycsA1FXy9wq56quG")),
        ),
        PerpMarketConfig::new(
            "RNDR-PERP",
            "RNDR",
            12,
            Pubkey::new_from_array(b58!("C2QvUPBiU3fViSyqA4nZgGyYqLgYf9PRpd8B8oLoo48w")),
        ),
        PerpMarketConfig::new(
            "XRP-PERP",
            "XRP",
            13,
            Pubkey::new_from_array(b58!("DuG45Td6dgJBe64Ebymb1WjBys16L1VTQdoAURdsviqN")),
        ),
        PerpMarketConfig::new(
            "HNT-PERP",
            "HNT",
            14,
            Pubkey::new_from_array(b58!("6Eg8YdfFJQF2HHonzPUBSCCmyUEhrStg9VBLK957sBe6")),
        ),
        PerpMarketConfig::new(
            "INJ-PERP",
            "INJ",
            15,
            Pubkey::new_from_array(b58!("44uRsNnT35kjkscSu59MxRr9CfkLZWf6gny8bWqUbVxE")),
        ),
        PerpMarketConfig::new(
            "LINK-PERP",
            "LINK",
            16,
            Pubkey::new_from_array(b58!("9sGidS4qUXS2WvHZFhzw4df1jNd5TvUGZXZVsSjXo7UF")),
        ),
        PerpMarketConfig::new(
            "RLB-PERP",
            "RLB",
            17,
            Pubkey::new_from_array(b58!("6BmJozusMugAySsfNfMFsU1YRWcGwyP3oycNX9Pv9oCz")),
        ),
    ]
}

fn init_perp_markets_mainnet() -> [PerpMarketConfig<'static>; 18] {
    [
        PerpMarketConfig::new(
            "SOL-PERP",
            "SOL",
            0,
            Pubkey::new_from_array(b58!("H6ARHf6YXhGYeQfUzQNGk6rDNnLBQKrenN712K4AQJEG")),
        ),
        PerpMarketConfig::new(
            "BTC-PERP",
            "BTC",
            1,
            Pubkey::new_from_array(b58!("GVXRSBjFk6e6J3NbVPXohDJetcTjaeeuykUpbQF8UoMU")),
        ),
        PerpMarketConfig::new(
            "ETH-PERP",
            "ETH",
            2,
            Pubkey::new_from_array(b58!("JBu1AL4obBcCMqKBBxhpWCNUt136ijcuMZLFvTP7iWdB")),
        ),
        PerpMarketConfig::new(
            "APT-PERP",
            "APT",
            3,
            Pubkey::new_from_array(b58!("FNNvb1AFDnDVPkocEri8mWbJ1952HQZtFLuwPiUjSJQ")),
        ),
        PerpMarketConfig::new(
            "1MBONK-PERP",
            "1MBONK",
            4,
            Pubkey::new_from_array(b58!("8ihFLu5FimgTQ1Unh4dVyEHUGodJ5gJQCrQf4KUVB9bN")),
        ),
        PerpMarketConfig::new(
            "MATIC-PERP",
            "MATIC",
            5,
            Pubkey::new_from_array(b58!("7KVswB9vkCgeM3SHP7aGDijvdRAHK8P5wi9JXViCrtYh")),
        ),
        PerpMarketConfig::new(
            "ARB-PERP",
            "ARB",
            6,
            Pubkey::new_from_array(b58!("5HRrdmghsnU3i2u5StaKaydS7eq3vnKVKwXMzCNKsc4C")),
        ),
        PerpMarketConfig::new(
            "DOGE-PERP",
            "DOGE",
            7,
            Pubkey::new_from_array(b58!("FsSM3s38PX9K7Dn6eGzuE29S2Dsk1Sss1baytTQdCaQj")),
        ),
        PerpMarketConfig::new(
            "BNB-PERP",
            "BNB",
            8,
            Pubkey::new_from_array(b58!("4CkQJBxhU8EZ2UjhigbtdaPbpTe6mqf811fipYBFbSYN")),
        ),
        PerpMarketConfig::new(
            "SUI-PERP",
            "SUI",
            9,
            Pubkey::new_from_array(b58!("3Qub3HaAJaa2xNY7SUqPKd3vVwTqDfDDkEUMPjXD2c1q")),
        ),
        PerpMarketConfig::new(
            "1MPEPE-PERP",
            "1MPEPE",
            10,
            Pubkey::new_from_array(b58!("FSfxunDmjjbDV2QxpyxFCAPKmYJHSLnLuvQXDLkMzLBm")),
        ),
        PerpMarketConfig::new(
            "OP-PERP",
            "OP",
            11,
            Pubkey::new_from_array(b58!("4o4CUwzFwLqCvmA5x1G4VzoZkAhAcbiuiYyjWX1CVbY2")),
        ),
        PerpMarketConfig::new(
            "RNDR-PERP",
            "RNDR",
            12,
            Pubkey::new_from_array(b58!("CYGfrBJB9HgLf9iZyN4aH5HvUAi2htQ4MjPxeXMf4Egn")),
        ),
        PerpMarketConfig::new(
            "XRP-PERP",
            "XRP",
            13,
            Pubkey::new_from_array(b58!("Guffb8DAAxNH6kdoawYjPXTbwUhjmveh8R4LM6uEqRV1")),
        ),
        PerpMarketConfig::new(
            "HNT-PERP",
            "HNT",
            14,
            Pubkey::new_from_array(b58!("7moA1i5vQUpfDwSpK6Pw9s56ahB7WFGidtbL2ujWrVvm")),
        ),
        PerpMarketConfig::new(
            "INJ-PERP",
            "INJ",
            15,
            Pubkey::new_from_array(b58!("9EdtbaivHQYA4Nh3XzGR6DwRaoorqXYnmpfsnFhvwuVj")),
        ),
        PerpMarketConfig::new(
            "LINK-PERP",
            "LINK",
            16,
            Pubkey::new_from_array(b58!("ALdkqQDMfHNg77oCNskfX751kHys4KE7SFuZzuKaN536")),
        ),
        PerpMarketConfig::new(
            "RLB-PERP",
            "RLB",
            17,
            Pubkey::new_from_array(b58!("4BA3RcS4zE32WWgp49vvvre2t6nXY1W1kMyKZxeeuUey")),
        ),
    ]
}
