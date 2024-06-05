use solana_program::pubkey::Pubkey;

#[derive(Debug, PartialEq, Eq)]
pub enum PerpFulfillmentMethod {
    AMM(Option<u64>),
    Match(Pubkey, u16),
}

#[derive(Debug)]
pub enum SpotFulfillmentMethod {
    ExternalMarket,
    Match(Pubkey, u16),
}
