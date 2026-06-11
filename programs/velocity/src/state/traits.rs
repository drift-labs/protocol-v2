#[cfg(test)]
mod tests;

pub trait Size {
    const SIZE: usize;
}

pub trait MarketIndexOffset {
    const MARKET_INDEX_OFFSET: usize;
}
