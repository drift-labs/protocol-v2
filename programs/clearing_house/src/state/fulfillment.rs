#[derive(Debug, PartialEq, Eq)]
pub enum PerpFulfillmentMethod {
    AMM,
    Match,
    AMMToPrice, // fill up to price for amm
}

#[derive(Debug)]
pub enum SpotFulfillmentMethod {
    SerumV3,
    Match,
}
