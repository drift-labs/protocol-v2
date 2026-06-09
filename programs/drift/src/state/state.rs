use anchor_lang::prelude::*;
use enumflags2::BitFlags;

use crate::{
    error::DriftResult,
    math::{
        constants::{
            FEE_DENOMINATOR, FEE_PERCENTAGE_DENOMINATOR, LAMPORTS_PER_SOL_U64,
            PERCENTAGE_PRECISION_U64,
        },
        safe_math::SafeMath,
        safe_unwrap::SafeUnwrap,
    },
    state::traits::Size,
};

#[cfg(test)]
mod tests;

#[account(zero_copy(unsafe))]
#[repr(C)]
#[derive(Debug)]
pub struct State {
    /// Root authority. Set at `initialize`; only this key can rotate `warm_admin`
    /// and `pause_admin`. Expected to sit behind a (small) timelocked multisig.
    pub cold_admin: Pubkey,
    /// Operational authority (e.g. multisig+timelock). Can rotate the 11 hot keys
    /// below. `Pubkey::default()` means unset — only `cold_admin` can act in that case.
    pub warm_admin: Pubkey,
    /// Emergency-pause authority. No on-chain timelock — intended to live behind a
    /// fast-acting multisig that can flip pause flags without delay. May only *add*
    /// pause bits (never clear them); cold/warm retain full pause + unpause power.
    /// `Pubkey::default()` means unassigned (only cold/warm can pause).
    pub pause_admin: Pubkey,
    /// Purpose-specific bot keys. `Pubkey::default()` means the role is unassigned
    /// and only warm/cold can call handlers gated on that role.
    pub hot_amm_crank: Pubkey,
    pub hot_lp_cache: Pubkey,
    pub hot_lp_swap: Pubkey,
    pub hot_lp_settle: Pubkey,
    pub hot_if_rebalance: Pubkey,
    pub hot_feature_flag: Pubkey,
    pub hot_fuel: Pubkey,
    pub hot_user_flag: Pubkey,
    pub hot_vault_deposit: Pubkey,
    pub hot_mm_oracle_crank: Pubkey,
    pub hot_amm_spread_adjust: Pubkey,

    pub whitelist_mint: Pubkey,
    pub discount_mint: Pubkey,
    pub signer: Pubkey,
    pub srm_vault: Pubkey,
    pub perp_fee_structure: FeeStructure,
    pub spot_fee_structure: FeeStructure,
    pub oracle_guard_rails: OracleGuardRails,
    pub number_of_authorities: u64,
    pub number_of_sub_accounts: u64,
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
    pub feature_bit_flags: u8,
    pub lp_pool_feature_bit_flags: u8,
    pub padding: [u8; 272],
}

/// Purpose-specific hot role keys held on `State`. Each variant maps to one of the
/// `hot_*` pubkey fields and is used by `State::require_hot` / `hot_key`.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, Eq, PartialEq)]
pub enum HotRole {
    AmmCrank,
    LpCache,
    LpSwap,
    LpSettle,
    IfRebalance,
    FeatureFlag,
    Fuel,
    UserFlag,
    VaultDeposit,
    MmOracleCrank,
    AmmSpreadAdjust,
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

impl Default for State {
    fn default() -> Self {
        State {
            cold_admin: Pubkey::default(),
            warm_admin: Pubkey::default(),
            pause_admin: Pubkey::default(),
            hot_amm_crank: Pubkey::default(),
            hot_lp_cache: Pubkey::default(),
            hot_lp_swap: Pubkey::default(),
            hot_lp_settle: Pubkey::default(),
            hot_if_rebalance: Pubkey::default(),
            hot_feature_flag: Pubkey::default(),
            hot_fuel: Pubkey::default(),
            hot_user_flag: Pubkey::default(),
            hot_vault_deposit: Pubkey::default(),
            hot_mm_oracle_crank: Pubkey::default(),
            hot_amm_spread_adjust: Pubkey::default(),
            whitelist_mint: Pubkey::default(),
            discount_mint: Pubkey::default(),
            signer: Pubkey::default(),
            srm_vault: Pubkey::default(),
            perp_fee_structure: FeeStructure::default(),
            spot_fee_structure: FeeStructure::default(),
            oracle_guard_rails: OracleGuardRails::default(),
            number_of_authorities: 0,
            number_of_sub_accounts: 0,
            liquidation_margin_buffer_ratio: 0,
            settlement_duration: 0,
            number_of_markets: 0,
            number_of_spot_markets: 0,
            signer_nonce: 0,
            min_perp_auction_duration: 0,
            default_market_order_time_in_force: 0,
            default_spot_auction_duration: 0,
            exchange_status: 0,
            liquidation_duration: 0,
            initial_pct_to_liquidate: 0,
            max_number_of_sub_accounts: 0,
            max_initialize_user_fee: 0,
            feature_bit_flags: 0,
            lp_pool_feature_bit_flags: 0,
            padding: [0; 272],
        }
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

    pub fn use_median_trigger_price(&self) -> bool {
        (self.feature_bit_flags & (FeatureBitFlags::MedianTriggerPrice as u8)) > 0
    }

    pub fn builder_codes_enabled(&self) -> bool {
        (self.feature_bit_flags & (FeatureBitFlags::BuilderCodes as u8)) > 0
    }

    pub fn allow_settle_lp_pool(&self) -> bool {
        (self.lp_pool_feature_bit_flags & (LpPoolFeatureBitFlags::SettleLpPool as u8)) > 0
    }

    pub fn allow_swap_lp_pool(&self) -> bool {
        (self.lp_pool_feature_bit_flags & (LpPoolFeatureBitFlags::SwapLpPool as u8)) > 0
    }

    pub fn allow_mint_redeem_lp_pool(&self) -> bool {
        (self.lp_pool_feature_bit_flags & (LpPoolFeatureBitFlags::MintRedeemLpPool as u8)) > 0
    }

    /// Pubkey assigned to a given hot role. `Pubkey::default()` if unassigned.
    pub fn hot_key(&self, role: HotRole) -> Pubkey {
        match role {
            HotRole::AmmCrank => self.hot_amm_crank,
            HotRole::LpCache => self.hot_lp_cache,
            HotRole::LpSwap => self.hot_lp_swap,
            HotRole::LpSettle => self.hot_lp_settle,
            HotRole::IfRebalance => self.hot_if_rebalance,
            HotRole::FeatureFlag => self.hot_feature_flag,
            HotRole::Fuel => self.hot_fuel,
            HotRole::UserFlag => self.hot_user_flag,
            HotRole::VaultDeposit => self.hot_vault_deposit,
            HotRole::MmOracleCrank => self.hot_mm_oracle_crank,
            HotRole::AmmSpreadAdjust => self.hot_amm_spread_adjust,
        }
    }

    pub fn set_hot_key(&mut self, role: HotRole, key: Pubkey) {
        match role {
            HotRole::AmmCrank => self.hot_amm_crank = key,
            HotRole::LpCache => self.hot_lp_cache = key,
            HotRole::LpSwap => self.hot_lp_swap = key,
            HotRole::LpSettle => self.hot_lp_settle = key,
            HotRole::IfRebalance => self.hot_if_rebalance = key,
            HotRole::FeatureFlag => self.hot_feature_flag = key,
            HotRole::Fuel => self.hot_fuel = key,
            HotRole::UserFlag => self.hot_user_flag = key,
            HotRole::VaultDeposit => self.hot_vault_deposit = key,
            HotRole::MmOracleCrank => self.hot_mm_oracle_crank = key,
            HotRole::AmmSpreadAdjust => self.hot_amm_spread_adjust = key,
        }
    }

    /// True if `signer` is the root (cold) admin. Mirrors the
    /// `cold_admin == admin.key()` constraint used by the cold-only Accounts
    /// structs (`ColdAdminUpdateState`, `UpdateWarmAdmin`, `UpdatePauseAdmin`),
    /// so a cold signer is recognised even when `warm_admin` is set — including
    /// the post-`handle_initialize` state where `warm_admin == cold_admin`.
    pub fn is_cold(&self, signer: &Pubkey) -> bool {
        self.cold_admin == *signer && self.cold_admin != Pubkey::default()
    }

    pub fn is_warm(&self, signer: &Pubkey) -> bool {
        self.is_cold(signer) || (self.warm_admin != Pubkey::default() && self.warm_admin == *signer)
    }

    /// True if `signer` can flip pause flags: cold, warm, or the dedicated
    /// fast-path pause admin. The pause path intentionally bypasses any warm
    /// timelock so a compromised market can be halted without delay.
    pub fn is_pause(&self, signer: &Pubkey) -> bool {
        self.is_warm(signer)
            || (self.pause_admin != Pubkey::default() && self.pause_admin == *signer)
    }

    pub fn is_hot(&self, signer: &Pubkey, role: HotRole) -> bool {
        if self.is_warm(signer) {
            return true;
        }
        let role_key = self.hot_key(role);
        role_key != Pubkey::default() && role_key == *signer
    }

    pub fn require_cold(&self, signer: &Pubkey) -> DriftResult<()> {
        if !self.is_cold(signer) {
            msg!("signer {} is not cold admin", signer);
            return Err(crate::error::ErrorCode::Unauthorized);
        }
        Ok(())
    }

    pub fn require_warm(&self, signer: &Pubkey) -> DriftResult<()> {
        if !self.is_warm(signer) {
            msg!("signer {} is neither cold nor warm admin", signer);
            return Err(crate::error::ErrorCode::Unauthorized);
        }
        Ok(())
    }

    pub fn require_pause(&self, signer: &Pubkey) -> DriftResult<()> {
        if !self.is_pause(signer) {
            msg!("signer {} is not authorized to flip pause flags", signer);
            return Err(crate::error::ErrorCode::Unauthorized);
        }
        Ok(())
    }

    pub fn require_hot(&self, signer: &Pubkey, role: HotRole) -> DriftResult<()> {
        if !self.is_hot(signer, role) {
            msg!("signer {} is not authorized for role {:?}", signer, role);
            return Err(crate::error::ErrorCode::Unauthorized);
        }
        Ok(())
    }
}

#[derive(Clone, Copy, PartialEq, Debug, Eq)]
pub enum FeatureBitFlags {
    MmOracleUpdate = 0b00000001,
    MedianTriggerPrice = 0b00000010,
    BuilderCodes = 0b00000100,
}

#[derive(Clone, Copy, PartialEq, Debug, Eq)]
pub enum LpPoolFeatureBitFlags {
    SettleLpPool = 0b00000001,
    SwapLpPool = 0b00000010,
    MintRedeemLpPool = 0b00000100,
}

impl Size for State {
    // 8 (disc) + 14 Pubkey (cold + warm + pause + 11 hot, 448 B) + 4 Pubkey (mint/signer, 128 B)
    // + 2*FeeStructure + OracleGuardRails + scalars + padding[272] = 1688 B.
    // Sized so (SIZE - 8) % 16 == 0 for the zero-copy alignment invariant.
    const SIZE: usize = 1688;
}

#[derive(Copy, AnchorSerialize, AnchorDeserialize, Clone, Debug)]
#[repr(C)]
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
#[repr(C)]
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
#[repr(C)]
pub struct ValidityGuardRails {
    pub slots_before_stale_for_amm: i64,
    pub slots_before_stale_for_margin: i64,
    pub confidence_interval_max_size: u64,
    pub too_volatile_ratio: i64,
}

#[derive(Copy, AnchorSerialize, AnchorDeserialize, Clone, Debug)]
#[repr(C)]
pub struct FeeStructure {
    pub fee_tiers: [FeeTier; 10],
    pub filler_reward_structure: OrderFillerRewardStructure,
    pub flat_filler_fee: u64,
    /// Reserved padding. Kept so `size_of::<FeeStructure>()` stays a multiple of 16
    /// (OrderFillerRewardStructure's u128 forces 16-byte alignment on host x86_64);
    /// removing it would diverge host vs. SBF layout.
    pub padding: u64,
}

impl Default for FeeStructure {
    fn default() -> Self {
        FeeStructure::perps_default()
    }
}

#[derive(AnchorSerialize, AnchorDeserialize, Copy, Clone, Debug)]
#[repr(C)]
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

/// `u128` is placed first so `#[repr(C)]` layout matches between host (x86_64,
/// align 16 in Rust ≥ 1.77) and the SBF VM (align 8). Trailing `_padding`
/// rounds the struct to a host-portable 32 bytes. See
/// `docs/alignment-and-native-offsets.md`.
#[derive(AnchorSerialize, AnchorDeserialize, Copy, Default, Clone, Debug)]
#[repr(C)]
pub struct OrderFillerRewardStructure {
    pub time_based_reward_lower_bound: u128,
    pub reward_numerator: u32,
    pub reward_denominator: u32,
    pub _padding: [u8; 8],
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
                time_based_reward_lower_bound: 10_000, // 1 cent
                reward_numerator: 10,
                reward_denominator: FEE_PERCENTAGE_DENOMINATOR,
                _padding: [0; 8],
            },
            flat_filler_fee: 10_000,
            padding: 0,
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
                time_based_reward_lower_bound: 10_000, // 1 cent
                reward_numerator: 10,
                reward_denominator: FEE_PERCENTAGE_DENOMINATOR,
                _padding: [0; 8],
            },
            flat_filler_fee: 10_000,
            padding: 0,
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
                time_based_reward_lower_bound: 10_000, // 1 cent
                reward_numerator: 10,
                reward_denominator: FEE_PERCENTAGE_DENOMINATOR,
                _padding: [0; 8],
            },
            ..FeeStructure::perps_default()
        }
    }
}
