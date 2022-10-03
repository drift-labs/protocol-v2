#[derive(Debug, PartialEq, Eq)]
pub enum PerpFulfillmentMethod {
    AMM,
    Match,
}

#[derive(Debug)]
pub enum SpotFulfillmentMethod {
    SerumV3,
    Match,
}
