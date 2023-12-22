use std::sync::OnceLock;

use drift_program::state::{perp_market::PerpMarket, spot_market::SpotMarket};
pub use drift_program::{
    math::constants::{
        BASE_PRECISION_U64 as BASE_PRECISION, PRICE_PRECISION,
        QUOTE_PRECISION_U64 as QUOTE_PRECISION, SPOT_BALANCE_PRECISION,
    },
    ID as PROGRAM_ID,
};
use solana_sdk::pubkey::Pubkey;

use crate::types::Context;

static STATE_ACCOUNT: OnceLock<Pubkey> = OnceLock::new();
static SPOT_MARKETS_DEV: OnceLock<&'static [SpotMarket]> = OnceLock::new();
static SPOT_MARKETS_MAINNET: OnceLock<&'static [SpotMarket]> = OnceLock::new();
static PERP_MARKETS_DEV: OnceLock<&'static [PerpMarket]> = OnceLock::new();
static PERP_MARKETS_MAINNET: OnceLock<&'static [PerpMarket]> = OnceLock::new();

/// Drift state account
pub fn state_account() -> &'static Pubkey {
    STATE_ACCOUNT.get_or_init(|| {
        let (state_account, _seed) =
            Pubkey::find_program_address(&[&b"drift_state"[..]], &PROGRAM_ID);
        state_account
    })
}

/// calculate the PDA of a drift spot market given index
pub fn derive_spot_market_account(market_index: u16) -> Pubkey {
    let (account, _seed) = Pubkey::find_program_address(
        &[&b"spot_market"[..], &market_index.to_le_bytes()],
        &PROGRAM_ID,
    );
    account
}

/// Initialize market metadata
/// Called once on start up
pub fn init_markets(context: Context, mut spot: Vec<SpotMarket>, mut perp: Vec<PerpMarket>) {
    spot.sort_by(|a, b| a.market_index.cmp(&b.market_index));
    perp.sort_by(|a, b| a.market_index.cmp(&b.market_index));
    // other code relies on aligned indexes for fast lookups
    assert!(
        spot.iter()
            .enumerate()
            .all(|(idx, x)| idx == x.market_index as usize),
        "spot indexes unaligned"
    );
    assert!(
        perp.iter()
            .enumerate()
            .all(|(idx, x)| idx == x.market_index as usize),
        "perp indexes unaligned"
    );
    match context {
        Context::DevNet => {
            SPOT_MARKETS_DEV
                .set(Box::leak(spot.into_boxed_slice()))
                .expect("set once");
            PERP_MARKETS_DEV
                .set(Box::leak(perp.into_boxed_slice()))
                .expect("set once");
        }
        Context::MainNet => {
            SPOT_MARKETS_MAINNET
                .set(Box::leak(spot.into_boxed_slice()))
                .expect("set once");
            PERP_MARKETS_MAINNET
                .set(Box::leak(perp.into_boxed_slice()))
                .expect("set once");
        }
    }
}

/// Return known spot markets
pub fn spot_market_configs(context: Context) -> &'static [SpotMarket] {
    match context {
        Context::DevNet => SPOT_MARKETS_DEV.get().expect("markets initialized"),
        Context::MainNet => SPOT_MARKETS_MAINNET.get().expect("markets initialized"),
    }
}

/// Return the spot market config given a market index
pub fn spot_market_config_by_index(
    context: Context,
    market_index: u16,
) -> Option<&'static SpotMarket> {
    match context {
        Context::DevNet => SPOT_MARKETS_DEV.get()?.get(market_index as usize),
        Context::MainNet => SPOT_MARKETS_MAINNET.get()?.get(market_index as usize),
    }
}

/// Return known perp markets
pub fn perp_market_configs(context: Context) -> &'static [PerpMarket] {
    match context {
        Context::DevNet => PERP_MARKETS_DEV.get().expect("markets initialized"),
        Context::MainNet => PERP_MARKETS_MAINNET.get().expect("markets initialized"),
    }
}

/// Return the perp market config given a market index
pub fn perp_market_config_by_index(
    context: Context,
    market_index: u16,
) -> Option<&'static PerpMarket> {
    match context {
        Context::DevNet => PERP_MARKETS_DEV.get()?.get(market_index as usize),
        Context::MainNet => PERP_MARKETS_MAINNET.get()?.get(market_index as usize),
    }
}
