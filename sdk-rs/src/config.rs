use anyhow::Result;
use std::collections::HashMap;
use drift::state::perp_market::PerpMarket;
use drift::state::spot_market::SpotMarket;

use crate::types::OracleInfo;
use anchor_client::{Program};

pub struct FindAllMarketAndOraclesResult {
    pub perp_market_indexes: Vec<u16>,
    pub spot_market_indexes: Vec<u16>,
    pub oracles: Vec<OracleInfo>,
}
pub fn find_all_market_and_oracles(program: &Program) -> Result<FindAllMarketAndOraclesResult> {

    let mut oracles = HashMap::new();
    let mut perp_market_indexes: Vec<u16> = Vec::new();
    for perp_market in program.accounts_lazy::<PerpMarket>(vec![])? {
        match perp_market {
            Ok((_, perp_market)) => {
                perp_market_indexes.push(perp_market.market_index);
                oracles.insert(perp_market.amm.oracle.to_string(), OracleInfo {
                    public_key: perp_market.amm.oracle,
                    source: perp_market.amm.oracle_source,
                });
            }
            Err(err) => println!("Error: {:?}", err),
        }
    }

    let mut spot_market_indexes: Vec<u16> = Vec::new();
    for spot_market in program.accounts_lazy::<SpotMarket>(vec![])? {
        match spot_market {
            Ok((pubkey, spot_market)) => {
                spot_market_indexes.push(spot_market.market_index);
                oracles.insert(spot_market.oracle.to_string(), OracleInfo {
                    public_key: spot_market.oracle,
                    source: spot_market.oracle_source,
                });
            }
            Err(err) => println!("Error: {:?}", err),
        }
    }


    Ok(FindAllMarketAndOraclesResult {
        perp_market_indexes: perp_market_indexes,
        spot_market_indexes: spot_market_indexes,
        oracles: oracles.values().cloned().collect(),
    })
}