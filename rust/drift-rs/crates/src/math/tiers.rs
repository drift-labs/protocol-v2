use crate::types::{AssetTier, ContractTier};

/// Extension trait: numeric ordering for drift's `ContractTier` (orphan rule).
pub trait ContractTierExt {
    fn to_number(&self) -> u8;
}
impl ContractTierExt for ContractTier {
    fn to_number(&self) -> u8 {
        match self {
            ContractTier::A => 0,
            ContractTier::B => 1,
            ContractTier::C => 2,
            ContractTier::Speculative => 3,
            ContractTier::HighlySpeculative => 4,
            ContractTier::Isolated => 5,
        }
    }
}

/// Extension trait: numeric ordering for drift's `AssetTier` (orphan rule).
pub trait AssetTierExt {
    fn to_number(&self) -> u8;
}
impl AssetTierExt for AssetTier {
    fn to_number(&self) -> u8 {
        match self {
            AssetTier::Collateral => 0,
            AssetTier::Protected => 1,
            AssetTier::Cross => 2,
            AssetTier::Isolated => 3,
            AssetTier::Unlisted => 4,
        }
    }
}

pub fn perp_tier_is_as_safe_as(perp_tier: u8, other_perp_tier: u8, other_spot_tier: u8) -> bool {
    let as_safe_as_perp = perp_tier <= other_perp_tier;
    let as_safe_as_spot = other_spot_tier == 4 || (other_spot_tier >= 2 && perp_tier <= 2);
    as_safe_as_spot && as_safe_as_perp
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_tier_safety_comparison() {
        let tier_a = ContractTier::A;
        let tier_b = ContractTier::B;
        let spot_cross = AssetTier::Cross;

        assert!(perp_tier_is_as_safe_as(
            tier_a.to_number(),
            tier_b.to_number(),
            spot_cross.to_number()
        ));

        assert!(!perp_tier_is_as_safe_as(
            tier_b.to_number(),
            tier_a.to_number(),
            spot_cross.to_number()
        ));
    }
}
