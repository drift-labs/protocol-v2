#![no_main]

use crate::arbitrary::Arbitrary;
use drift::controller::amm::update_pool_balances;
use drift::state::perp_market::{PerpMarket, AMM};
use drift::state::spot_market::SpotMarket;
use drift::state::user::SpotPosition;
use libfuzzer_sys::arbitrary;
use libfuzzer_sys::fuzz_target;

#[derive(Debug, Clone, Copy)]
struct Data {
    pub spot_position: SpotPosition,
    pub perp_market: PerpMarket,
    pub spot_market: SpotMarket,
    pub pnl: i128,
    pub ts: i64,
}

impl<'a> Arbitrary<'a> for Data {
    fn arbitrary(u: &mut arbitrary::Unstructured<'a>) -> arbitrary::Result<Self> {
        let perp_market = PerpMarket {
            ..PerpMarket::default()
        };
        let spot_market = SpotMarket {
            ..SpotMarket::default()
        };
        let spot_position = SpotPosition {
            ..SpotPosition::default()
        };
        let pnl = arbitrary_i128(u)?;
        let ts = arbitrary_i64(u)?;

        Ok(Self {
            spot_position,
            spot_market,
            perp_market,
            pnl,
            ts,
        })
    }
}

fn arbitrary_i128(u: &mut arbitrary::Unstructured) -> arbitrary::Result<i128> {
    let v = i128::arbitrary(u)?;
    if v > 0 {
        Ok(v.min(1 << 120))
    } else {
        Ok(v.max(-1 << 120))
    }
}

fn arbitrary_i64(u: &mut arbitrary::Unstructured) -> arbitrary::Result<i64> {
    let v = i64::arbitrary(u)?;
    if v > 0 {
        Ok(v.min(1 << 56))
    } else {
        Ok(v.max(-1 << 56))
    }
}

fuzz_target!(|data: Data| {
    // fuzzed code goes here
    fuzz(data);
});

fn fuzz(data: Data) {
    let spot_position_before = data.spot_position.clone();
    let perp_market_before = data.perp_market.clone();
    let spot_market_before = data.spot_market.clone();
    let pnl = data.pnl;
    let ts = data.ts;

    let spot_position_after = data.spot_position.clone();
    let mut perp_market_after = data.perp_market.clone();
    let mut spot_market_after = data.spot_market.clone();

    update_pool_balances(
        &mut perp_market_after,
        &mut spot_market_after,
        &spot_position_after,
        pnl,
        ts,
    )
    .unwrap();

    // do validates
}
