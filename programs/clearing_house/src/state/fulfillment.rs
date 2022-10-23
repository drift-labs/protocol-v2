#[derive(Debug, PartialEq, Eq)]
pub enum PerpFulfillmentMethod {
    AMM(Option<u64>),
    Match,
}

#[derive(Debug)]
pub enum SpotFulfillmentMethod {
    SerumV3,
    Match,
}
