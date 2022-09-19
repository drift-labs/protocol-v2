use crate::state::fees::FeeStructure;
use anchor_lang::prelude::*;

#[account]
#[derive(Default)]
#[repr(packed)]
pub struct State {
    pub admin: Pubkey,
    pub exchange_paused: bool,
    pub funding_paused: bool,
    pub admin_controls_prices: bool,
    pub insurance_vault: Pubkey,
    pub whitelist_mint: Pubkey,
    pub discount_mint: Pubkey,
    pub oracle_guard_rails: OracleGuardRails,
    pub number_of_markets: u64,
    pub number_of_spot_markets: u64,
    pub min_order_quote_asset_amount: u128, // minimum est. quote_asset_amount for place_order to succeed
    pub min_perp_auction_duration: u8,
    pub default_market_order_time_in_force: u8,
    pub default_spot_auction_duration: u8,
    pub liquidation_margin_buffer_ratio: u32,
    pub settlement_duration: u16,
    pub signer: Pubkey,
    pub signer_nonce: u8,
    pub perp_fee_structure: FeeStructure,
    pub spot_fee_structure: FeeStructure,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct OracleGuardRails {
    pub price_divergence: PriceDivergenceGuardRails,
    pub validity: ValidityGuardRails,
    pub use_for_liquidations: bool,
}

impl Default for OracleGuardRails {
    fn default() -> Self {
        OracleGuardRails {
            price_divergence: PriceDivergenceGuardRails {
                mark_oracle_divergence_numerator: 100, // todo: have high default so previous tests dont fail
                mark_oracle_divergence_denominator: 10,
            },
            validity: ValidityGuardRails {
                slots_before_stale: 10,              // ~5 seconds
                confidence_interval_max_size: 20000, // 2% of price
                too_volatile_ratio: 5,               // 5x or 80% down
            },
            use_for_liquidations: true,
        }
    }
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Default)]
pub struct PriceDivergenceGuardRails {
    pub mark_oracle_divergence_numerator: u128,
    pub mark_oracle_divergence_denominator: u128,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Default)]
pub struct ValidityGuardRails {
    pub slots_before_stale: i64,
    pub confidence_interval_max_size: u128,
    pub too_volatile_ratio: i128,
}
