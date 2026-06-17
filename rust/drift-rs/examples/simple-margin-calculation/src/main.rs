//! Example demonstrating the simplified margin calculation API
//! 
//! This example shows how to use the MarketState struct
//! to calculate simplified margin requirements.

use drift_rs::MarketState;
use drift_rs::drift_idl::{
    accounts::{SpotMarket, PerpMarket, User},
    types::MarginRequirementType,
};
use drift_rs::ffi::OraclePriceData;

fn main() -> Result<(), Box<dyn std::error::Error>> {
    println!("Drift Simplified Margin Calculation Example");

    // Create a new market state
    let market_state = MarketState::new();

    // Example: Add a spot market (you would populate this with real data)
    let spot_market = SpotMarket {
        market_index: 0,
        // ... other fields would be populated with real data
        ..Default::default()
    };

    // Example: Add a perp market
    let perp_market = PerpMarket {
        market_index: 0,
        // ... other fields would be populated with real data
        ..Default::default()
    };

    // Example: Add oracle price data
    let oracle_price = OraclePriceData {
        price: 100_000_000, // $100 in price precision
        // ... other fields would be populated with real data
        ..Default::default()
    };

    // Add markets and oracle data to the state
    market_state.set_spot_market(spot_market);
    market_state.set_perp_market(perp_market);
    market_state.set_spot_oracle_price(0, oracle_price);

    // Example: Create a user (you would populate this with real data)
    let user = User {
        // ... fields would be populated with real user data
        ..Default::default()
    };

    // Calculate simplified margin requirement
    let margin_calc = market_state.calculate_simplified_margin_requirement(
        &user,
        MarginRequirementType::Initial,
        None, // margin_buffer: Option<u32>
    )?;

    println!("Margin Calculation Results:");
    println!("  Total Collateral: {}", margin_calc.total_collateral);
    println!("  Margin Requirement: {}", margin_calc.margin_requirement);
    
    Ok(())
}
