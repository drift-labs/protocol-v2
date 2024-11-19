use anchor_lang::prelude::*;
use enumflags2::BitFlags;

use crate::error::DriftResult;
use crate::math::constants::{
    FEE_DENOMINATOR, FEE_PERCENTAGE_DENOMINATOR, MAX_REFERRER_REWARD_EPOCH_UPPER_BOUND,
};
use crate::math::safe_math::SafeMath;
use crate::math::safe_unwrap::SafeUnwrap;
use crate::state::traits::Size;
use crate::{LAMPORTS_PER_SOL_U64, PERCENTAGE_PRECISION_U64};

#[cfg(test)]
mod tests;

#[account]
#[derive(Default)]
#[repr(C)]
pub struct State {
    pub admin: Pubkey,
    pub whitelist_mint: Pubkey,
    pub discount_mint: Pubkey,
    pub signer: Pubkey,
    pub srm_vault: Pubkey,
    pub perp_fee_structure: FeeStructure,
    pub spot_fee_structure: FeeStructure,
    pub oracle_guard_rails: OracleGuardRails,
    pub number_of_authorities: u64,
    pub number_of_sub_accounts: u64,
    pub lp_cooldown_time: u64,
    pub liquidation_margin_buffer_ratio: u32,
    pub settlement_duration: u16,
    pub number_of_markets: u16,
    pub number_of_spot_markets: u16,
    pub signer_nonce: u8,
    pub min_perp_auction_duration: u8,
    pub default_market_order_time_in_force: u8,
    pub default_spot_auction_duration: u8,
    pub exchange_status: u8,
    pub liquidation_duration: u8,
    pub initial_pct_to_liquidate: u16,
    pub max_number_of_sub_accounts: u16,
    pub max_initialize_user_fee: u16,
    pub padding: [u8; 10],
}

#[derive(BitFlags, Clone, Copy, PartialEq, Debug, Eq)]
pub enum ExchangeStatus {
    // Active = 0b00000000
    DepositPaused = 0b00000001,
    WithdrawPaused = 0b00000010,
    AmmPaused = 0b00000100,
    FillPaused = 0b00001000,
    LiqPaused = 0b00010000,
    FundingPaused = 0b00100000,
    SettlePnlPaused = 0b01000000,
    AmmImmediateFillPaused = 0b10000000,
    // Paused = 0b11111111
}

impl ExchangeStatus {
    pub fn active() -> u8 {
        BitFlags::<ExchangeStatus>::empty().bits() as u8
    }
}

impl State {
    pub fn get_exchange_status(&self) -> DriftResult<BitFlags<ExchangeStatus>> {
        BitFlags::<ExchangeStatus>::from_bits(usize::from(self.exchange_status)).safe_unwrap()
    }

    pub fn amm_immediate_fill_paused(&self) -> DriftResult<bool> {
        Ok(self
            .get_exchange_status()?
            .contains(ExchangeStatus::AmmImmediateFillPaused))
    }

    pub fn amm_paused(&self) -> DriftResult<bool> {
        Ok(self
            .get_exchange_status()?
            .contains(ExchangeStatus::AmmPaused))
    }

    pub fn funding_paused(&self) -> DriftResult<bool> {
        Ok(self
            .get_exchange_status()?
            .contains(ExchangeStatus::FundingPaused))
    }

    pub fn max_number_of_sub_accounts(&self) -> u64 {
        if self.max_number_of_sub_accounts <= 5 {
            return self.max_number_of_sub_accounts as u64;
        }

        (self.max_number_of_sub_accounts as u64).saturating_mul(100)
    }

    pub fn get_init_user_fee(&self) -> DriftResult<u64> {
        let max_init_fee: u64 = (self.max_initialize_user_fee as u64) * LAMPORTS_PER_SOL_U64 / 100;

        let target_utilization: u64 = 8 * PERCENTAGE_PRECISION_U64 / 10;

        let account_space_utilization: u64 = self
            .number_of_sub_accounts
            .safe_mul(PERCENTAGE_PRECISION_U64)?
            .safe_div(self.max_number_of_sub_accounts().max(1))?;

        let init_fee: u64 = if account_space_utilization > target_utilization {
            max_init_fee
                .safe_mul(account_space_utilization.safe_sub(target_utilization)?)?
                .safe_div(PERCENTAGE_PRECISION_U64.safe_sub(target_utilization)?)?
        } else {
            0
        };

        Ok(init_fee)
    }
}

impl Size for State {
    const SIZE: usize = 992;
}

#[derive(Copy, AnchorSerialize, AnchorDeserialize, Clone, Debug)]
pub struct OracleGuardRails {
    pub price_divergence: PriceDivergenceGuardRails,
    pub validity: ValidityGuardRails,
}

impl Default for OracleGuardRails {
    fn default() -> Self {
        OracleGuardRails {
            price_divergence: PriceDivergenceGuardRails::default(),
            validity: ValidityGuardRails {
                slots_before_stale_for_amm: 10,       // ~5 seconds
                slots_before_stale_for_margin: 120,   // ~60 seconds
                confidence_interval_max_size: 20_000, // 2% of price
                too_volatile_ratio: 5,                // 5x or 80% down
            },
        }
    }
}

impl OracleGuardRails {
    pub fn max_oracle_twap_5min_percent_divergence(&self) -> u64 {
        self.price_divergence
            .oracle_twap_5min_percent_divergence
            .max(PERCENTAGE_PRECISION_U64 / 2)
    }
}

#[derive(Copy, AnchorSerialize, AnchorDeserialize, Clone, Debug)]
pub struct PriceDivergenceGuardRails {
    pub mark_oracle_percent_divergence: u64,
    pub oracle_twap_5min_percent_divergence: u64,
}

impl Default for PriceDivergenceGuardRails {
    fn default() -> Self {
        PriceDivergenceGuardRails {
            mark_oracle_percent_divergence: PERCENTAGE_PRECISION_U64 / 10,
            oracle_twap_5min_percent_divergence: PERCENTAGE_PRECISION_U64 / 2,
        }
    }
}

#[derive(Copy, AnchorSerialize, AnchorDeserialize, Clone, Default, Debug)]
pub struct ValidityGuardRails {
    pub slots_before_stale_for_amm: i64,
    pub slots_before_stale_for_margin: i64,
    pub confidence_interval_max_size: u64,
    pub too_volatile_ratio: i64,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug)]
pub struct FeeStructure {
    pub fee_tiers: [FeeTier; 10],
    pub filler_reward_structure: OrderFillerRewardStructure,
    pub referrer_reward_epoch_upper_bound: u64,
    pub flat_filler_fee: u64,
}

impl Default for FeeStructure {
    fn default() -> Self {
        FeeStructure::perps_default()
    }
}

#[derive(AnchorSerialize, AnchorDeserialize, Copy, Clone, Debug)]
pub struct FeeTier {
    pub fee_numerator: u32,
    pub fee_denominator: u32,
    pub maker_rebate_numerator: u32,
    pub maker_rebate_denominator: u32,
    pub referrer_reward_numerator: u32,
    pub referrer_reward_denominator: u32,
    pub referee_fee_numerator: u32,
    pub referee_fee_denominator: u32,
}

impl Default for FeeTier {
    fn default() -> Self {
        FeeTier {
            fee_numerator: 0,
            fee_denominator: FEE_DENOMINATOR,
            maker_rebate_numerator: 0,
            maker_rebate_denominator: FEE_DENOMINATOR,
            referrer_reward_numerator: 0,
            referrer_reward_denominator: FEE_PERCENTAGE_DENOMINATOR,
            referee_fee_numerator: 0,
            referee_fee_denominator: FEE_PERCENTAGE_DENOMINATOR,
        }
    }
}

#[derive(AnchorSerialize, AnchorDeserialize, Default, Clone, Debug)]
pub struct OrderFillerRewardStructure {
    pub reward_numerator: u32,
    pub reward_denominator: u32,
    pub time_based_reward_lower_bound: u128, // minimum filler reward for time-based reward
}

impl FeeStructure {
    pub fn perps_default() -> Self {
        let mut fee_tiers = [FeeTier::default(); 10];
        fee_tiers[0] = FeeTier {
            fee_numerator: 100,
            fee_denominator: FEE_DENOMINATOR, // 10 bps
            maker_rebate_numerator: 20,
            maker_rebate_denominator: FEE_DENOMINATOR, // 2bps
            referrer_reward_numerator: 15,
            referrer_reward_denominator: FEE_PERCENTAGE_DENOMINATOR, // 15% of taker fee
            referee_fee_numerator: 5,
            referee_fee_denominator: FEE_PERCENTAGE_DENOMINATOR, // 5%
        };
        fee_tiers[1] = FeeTier {
            fee_numerator: 90,
            fee_denominator: FEE_DENOMINATOR, // 8 bps
            maker_rebate_numerator: 20,
            maker_rebate_denominator: FEE_DENOMINATOR, // 2bps
            referrer_reward_numerator: 15,
            referrer_reward_denominator: FEE_PERCENTAGE_DENOMINATOR, // 15% of taker fee
            referee_fee_numerator: 5,
            referee_fee_denominator: FEE_PERCENTAGE_DENOMINATOR, // 5%
        };
        fee_tiers[2] = FeeTier {
            fee_numerator: 80,
            fee_denominator: FEE_DENOMINATOR, // 6 bps
            maker_rebate_numerator: 20,
            maker_rebate_denominator: FEE_DENOMINATOR, // 2bps
            referrer_reward_numerator: 15,
            referrer_reward_denominator: FEE_PERCENTAGE_DENOMINATOR, // 15% of taker fee
            referee_fee_numerator: 5,
            referee_fee_denominator: FEE_PERCENTAGE_DENOMINATOR, // 5%
        };
        fee_tiers[3] = FeeTier {
            fee_numerator: 70,
            fee_denominator: FEE_DENOMINATOR, // 5 bps
            maker_rebate_numerator: 20,
            maker_rebate_denominator: FEE_DENOMINATOR, // 2bps
            referrer_reward_numerator: 15,
            referrer_reward_denominator: FEE_PERCENTAGE_DENOMINATOR, // 15% of taker fee
            referee_fee_numerator: 5,
            referee_fee_denominator: FEE_PERCENTAGE_DENOMINATOR, // 5%
        };
        fee_tiers[4] = FeeTier {
            fee_numerator: 60,
            fee_denominator: FEE_DENOMINATOR, // 4 bps
            maker_rebate_numerator: 20,
            maker_rebate_denominator: FEE_DENOMINATOR, // 2bps
            referrer_reward_numerator: 15,
            referrer_reward_denominator: FEE_PERCENTAGE_DENOMINATOR, // 15% of taker fee
            referee_fee_numerator: 5,
            referee_fee_denominator: FEE_PERCENTAGE_DENOMINATOR, // 5%
        };
        fee_tiers[5] = FeeTier {
            fee_numerator: 50,
            fee_denominator: FEE_DENOMINATOR, // 3.5 bps
            maker_rebate_numerator: 20,
            maker_rebate_denominator: FEE_DENOMINATOR, // 2bps
            referrer_reward_numerator: 15,
            referrer_reward_denominator: FEE_PERCENTAGE_DENOMINATOR, // 15% of taker fee
            referee_fee_numerator: 5,
            referee_fee_denominator: FEE_PERCENTAGE_DENOMINATOR, // 5%
        };
        FeeStructure {
            fee_tiers,
            filler_reward_structure: OrderFillerRewardStructure {
                reward_numerator: 10,
                reward_denominator: FEE_PERCENTAGE_DENOMINATOR,
                time_based_reward_lower_bound: 10_000, // 1 cent
            },
            flat_filler_fee: 10_000,
            referrer_reward_epoch_upper_bound: MAX_REFERRER_REWARD_EPOCH_UPPER_BOUND,
        }
    }

    pub fn spot_default() -> Self {
        let mut fee_tiers = [FeeTier::default(); 10];
        fee_tiers[0] = FeeTier {
            fee_numerator: 100,
            fee_denominator: FEE_DENOMINATOR, // 10 bps
            maker_rebate_numerator: 20,
            maker_rebate_denominator: FEE_DENOMINATOR, // 2bps
            referrer_reward_numerator: 0,
            referrer_reward_denominator: FEE_PERCENTAGE_DENOMINATOR, // 0% of taker fee
            referee_fee_numerator: 0,
            referee_fee_denominator: FEE_PERCENTAGE_DENOMINATOR, // 0%
        };
        FeeStructure {
            fee_tiers,
            filler_reward_structure: OrderFillerRewardStructure {
                reward_numerator: 10,
                reward_denominator: FEE_PERCENTAGE_DENOMINATOR,
                time_based_reward_lower_bound: 10_000, // 1 cent
            },
            flat_filler_fee: 10_000,
            referrer_reward_epoch_upper_bound: MAX_REFERRER_REWARD_EPOCH_UPPER_BOUND,
        }
    }
}

#[cfg(test)]
impl FeeStructure {
    pub fn test_default() -> Self {
        let mut fee_tiers = [FeeTier::default(); 10];
        fee_tiers[0] = FeeTier {
            fee_numerator: 100,
            fee_denominator: FEE_DENOMINATOR,
            maker_rebate_numerator: 60,
            maker_rebate_denominator: FEE_DENOMINATOR,
            referrer_reward_numerator: 10,
            referrer_reward_denominator: FEE_PERCENTAGE_DENOMINATOR,
            referee_fee_numerator: 10,
            referee_fee_denominator: FEE_PERCENTAGE_DENOMINATOR,
        };
        FeeStructure {
            fee_tiers,
            filler_reward_structure: OrderFillerRewardStructure {
                reward_numerator: 10,
                reward_denominator: FEE_PERCENTAGE_DENOMINATOR,
                time_based_reward_lower_bound: 10_000, // 1 cent
            },
            ..FeeStructure::perps_default()
        }
    }
}
