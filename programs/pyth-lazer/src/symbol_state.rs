use {
    serde::{Deserialize, Serialize},
    std::fmt::Display,
};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SymbolState {
    ComingSoon,
    Stable,
    Inactive,
}

impl Display for SymbolState {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            SymbolState::ComingSoon => write!(f, "coming_soon"),
            SymbolState::Stable => write!(f, "stable"),
            SymbolState::Inactive => write!(f, "inactive"),
        }
    }
}
