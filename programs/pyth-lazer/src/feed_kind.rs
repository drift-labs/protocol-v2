use {
    serde::{Deserialize, Serialize},
    std::fmt::Display,
};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum FeedKind {
    Price,
    FundingRate,
}

impl Display for FeedKind {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            FeedKind::Price => write!(f, "price"),
            FeedKind::FundingRate => write!(f, "fundingRate"),
        }
    }
}
