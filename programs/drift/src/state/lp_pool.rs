use crate::error::{DriftResult, ErrorCode};
use crate::math::casting::Cast;
use crate::math::constants::{
    PERCENTAGE_PRECISION_I128, PERCENTAGE_PRECISION_I64, PRICE_PRECISION, PRICE_PRECISION_I64,
};
use crate::math::safe_math::SafeMath;
use crate::math::spot_balance::get_token_amount;
use anchor_lang::prelude::*;
use anchor_spl::token::Mint;
use borsh::{BorshDeserialize, BorshSerialize};

use super::oracle::OraclePriceData;
use super::oracle_map::OracleMap;
use super::spot_market::SpotMarket;
use super::zero_copy::{AccountZeroCopy, AccountZeroCopyMut, HasLen};
use crate::state::spot_market::{SpotBalance, SpotBalanceType};
use crate::state::traits::Size;
use crate::{impl_zero_copy_loader, validate};

pub const AMM_MAP_PDA_SEED: &str = "AMM_MAP";
pub const CONSTITUENT_PDA_SEED: &str = "CONSTITUENT";
pub const CONSTITUENT_TARGET_WEIGHT_PDA_SEED: &str = "CONSTITUENT_TARGET_WEIGHTS";
pub const CONSTITUENT_VAULT_PDA_SEED: &str = "CONSTITUENT_VAULT";

#[cfg(test)]
mod tests;

#[account(zero_copy(unsafe))]
#[derive(Default, Debug)]
#[repr(C)]
pub struct LPPool {
    /// name of vault, TODO: check type + size
    pub name: [u8; 32], // 32
    /// address of the vault.
    pub pubkey: Pubkey, // 32, 64
    // vault token mint
    pub mint: Pubkey, // 32, 96
    /// LPPool's token account
    // pub token_vault: Pubkey, // 32, 128

    /// token_supply? to simplify NAV calculation, or load from mint account
    /// token_total_supply: u64

    /// The current number of VaultConstituents in the vault, each constituent is pda(LPPool.address, constituent_index)
    /// which constituent is the quote, receives revenue pool distributions. (maybe this should just be implied idx 0)
    /// pub quote_constituent_index: u16,

    /// QUOTE_PRECISION: Max AUM, Prohibit minting new DLP beyond this
    pub max_aum: u128, // 8, 136

    /// QUOTE_PRECISION: AUM of the vault in USD, updated lazily
    pub last_aum: u128, // 8, 144

    /// timestamp of last AUM slot
    pub last_aum_slot: u64, // 8, 152
    /// timestamp of last AUM update
    pub last_aum_ts: i64, // 8, 160

    /// Oldest slot of constituent oracles
    pub oldest_oracle_slot: u64,

    /// timestamp of last vAMM revenue rebalance
    pub last_revenue_rebalance_ts: u64, // 8, 168

    /// all revenue settles recieved
    pub total_fees_received: u128, // 16, 176
    /// all revenues paid out
    pub total_fees_paid: u128, // 16, 192

    pub constituents: u16, // 2, 194

    pub _padding: [u8; 13],
}

impl Size for LPPool {
    const SIZE: usize = 216;
}

impl LPPool {
    pub fn get_nav(&self, mint: &Mint) -> Result<u128> {
        match mint.supply {
            0 => Ok(0),
            supply => {
                // TODO: assuming mint decimals = quote decimals = 6
                self.last_aum
                    .checked_div(supply.into())
                    .ok_or(ErrorCode::MathError.into())
            }
        }
    }

    /// get the swap price between two (non-LP token) constituents
    /// returns swap price in PRICE_PRECISION
    pub fn get_swap_price(
        &self,
        in_spot_market: &SpotMarket,
        out_spot_market: &SpotMarket,
        in_oracle: &OraclePriceData,
        out_oracle: &OraclePriceData,
        in_amount: u64,
    ) -> DriftResult<u64> {
        let in_price = in_oracle.price.cast::<u64>()?;
        let out_price = out_oracle.price.cast::<u64>()?;

        let (prec_diff_numerator, prec_diff_denominator) =
            if out_spot_market.decimals > in_spot_market.decimals {
                (
                    10_u64.pow(out_spot_market.decimals as u32 - in_spot_market.decimals as u32),
                    1,
                )
            } else {
                (
                    1,
                    10_u64.pow(in_spot_market.decimals as u32 - out_spot_market.decimals as u32),
                )
            };

        let swap_price = in_amount
            .safe_mul(in_price)?
            .safe_mul(prec_diff_numerator)?
            .safe_div(out_price.safe_mul(prec_diff_denominator)?)?;

        Ok(swap_price)
    }

    /// in the respective token units. Amounts are gross fees and in
    /// token mint precision.
    /// Positive fees are paid, negative fees are rebated
    /// Returns (in_amount out_amount, in_fee, out_fee)
    pub fn get_swap_amount(
        &self,
        in_oracle: &OraclePriceData,
        out_oracle: &OraclePriceData,
        in_constituent: &Constituent,
        out_constituent: &Constituent,
        in_spot_market: &SpotMarket,
        out_spot_market: &SpotMarket,
        in_target_weight: i64,
        out_target_weight: i64,
        in_amount: u64,
    ) -> DriftResult<(u64, u64, i64, i64)> {
        let swap_price = self.get_swap_price(
            in_spot_market,
            out_spot_market,
            in_oracle,
            out_oracle,
            in_amount,
        )?;

        let in_fee = self.get_swap_fees(
            in_spot_market,
            in_oracle,
            in_constituent,
            in_amount.cast::<i64>()?,
            in_target_weight,
        )?;
        let out_amount = in_amount
            .cast::<i64>()?
            .safe_sub(in_fee)?
            .safe_mul(swap_price.cast::<i64>()?)?
            .safe_div(PRICE_PRECISION_I64)?
            .cast::<u64>()?;
        let out_fee = self.get_swap_fees(
            out_spot_market,
            out_oracle,
            out_constituent,
            out_amount
                .cast::<i64>()?
                .checked_neg()
                .ok_or(ErrorCode::MathError.into())?,
            out_target_weight,
        )?;

        // TODO: additional spot quoter logic can go here
        // TODO: emit swap event

        Ok((in_amount, out_amount, in_fee, out_fee))
    }

    /// returns fee in PERCENTAGE_PRECISION
    pub fn get_swap_fees(
        &self,
        spot_market: &SpotMarket,
        oracle: &OraclePriceData,
        constituent: &Constituent,
        amount: i64,
        target_weight: i64,
    ) -> DriftResult<i64> {
        let weight_after =
            constituent.get_weight(oracle.price, spot_market, amount, self.last_aum)?;
        let fee = constituent.get_fee_to_charge(weight_after, target_weight)?;

        Ok(fee)
    }
}

#[zero_copy(unsafe)]
#[derive(Default, Eq, PartialEq, Debug, BorshDeserialize, BorshSerialize)]
#[repr(C)]
pub struct BLPosition {
    /// The scaled balance of the position. To get the token amount, multiply by the cumulative deposit/borrow
    /// interest of corresponding market.
    /// precision: SPOT_BALANCE_PRECISION
    pub scaled_balance: u64,
    /// The cumulative deposits/borrows a user has made into a market
    /// precision: token mint precision
    pub cumulative_deposits: i64,
    /// The market index of the corresponding spot market
    pub market_index: u16,
    /// Whether the position is deposit or borrow
    pub balance_type: SpotBalanceType,
    pub padding: [u8; 5],
}

impl SpotBalance for BLPosition {
    fn market_index(&self) -> u16 {
        self.market_index
    }

    fn balance_type(&self) -> &SpotBalanceType {
        &self.balance_type
    }

    fn balance(&self) -> u128 {
        self.scaled_balance as u128
    }

    fn increase_balance(&mut self, delta: u128) -> DriftResult {
        self.scaled_balance = self.scaled_balance.safe_add(delta.cast()?)?;
        Ok(())
    }

    fn decrease_balance(&mut self, delta: u128) -> DriftResult {
        self.scaled_balance = self.scaled_balance.safe_sub(delta.cast()?)?;
        Ok(())
    }

    fn update_balance_type(&mut self, balance_type: SpotBalanceType) -> DriftResult {
        self.balance_type = balance_type;
        Ok(())
    }
}

impl BLPosition {
    pub fn get_token_amount(&self, spot_market: &SpotMarket) -> DriftResult<u128> {
        get_token_amount(self.scaled_balance.cast()?, spot_market, &self.balance_type)
    }
}

#[account(zero_copy(unsafe))]
#[derive(Default, Debug, BorshDeserialize, BorshSerialize)]
#[repr(C)]
pub struct Constituent {
    /// address of the constituent
    pub pubkey: Pubkey,
    /// underlying drift spot market index
    pub spot_market_index: u16,
    /// idx in LPPool.constituents
    pub constituent_index: u16,

    pub decimals: u8,
    _padding1: [u8; 3],

    /// max deviation from target_weight allowed for the constituent
    /// precision: PERCENTAGE_PRECISION
    pub max_weight_deviation: i64,
    /// min fee charged on swaps to/from this constituent
    /// precision: PERCENTAGE_PRECISION
    pub swap_fee_min: i64,
    /// max fee charged on swaps to/from this constituent
    /// precision: PERCENTAGE_PRECISION
    pub swap_fee_max: i64,

    /// total fees received by the constituent. Positive = fees received, Negative = fees paid
    pub total_swap_fees: i128,

    /// ata token balance in SPOT_BALANCE_PRECISION
    pub token_balance: u64,

    /// spot borrow-lend balance for constituent
    pub spot_balance: BLPosition, // should be in constituent base asset

    pub last_oracle_price: i64,
    pub last_oracle_slot: u64,

    pub mint: Pubkey,
}

impl Size for Constituent {
    const SIZE: usize = 168;
}

impl Constituent {
    /// Returns the full balance of the Constituent, the total of the amount in Constituent's token
    /// account and in Drift Borrow-Lend.
    pub fn get_full_balance(&self, spot_market: &SpotMarket) -> DriftResult<i128> {
        match self.spot_balance.balance_type() {
            SpotBalanceType::Deposit => self.token_balance.cast::<i128>()?.safe_add(
                self.spot_balance
                    .get_token_amount(spot_market)?
                    .cast::<i128>()?,
            ),
            SpotBalanceType::Borrow => self.token_balance.cast::<i128>()?.safe_sub(
                self.spot_balance
                    .get_token_amount(spot_market)?
                    .cast::<i128>()?,
            ),
        }
    }

    pub fn record_swap_fees(&mut self, amount: i64) -> DriftResult {
        self.total_swap_fees = self.total_swap_fees.safe_add(amount.cast::<i128>()?)?;
        Ok(())
    }

    /// Current weight of this constituent = price * token_balance / lp_pool_aum
    /// Note: lp_pool_aum is from LPPool.last_aum, which is a lagged value updated via crank
    pub fn get_weight(
        &self,
        price: i64,
        spot_market: &SpotMarket,
        token_amount_delta: i64,
        lp_pool_aum: u128,
    ) -> DriftResult<i64> {
        let balance = self.get_full_balance(spot_market)?.cast::<i128>()?;
        let token_precision = 10_i128.pow(self.decimals as u32);

        let value_usd = balance
            .safe_add(token_amount_delta.cast::<i128>()?)?
            .safe_mul(price.cast::<i128>()?)?;

        value_usd
            .safe_mul(PERCENTAGE_PRECISION_I64.cast::<i128>()?)?
            .safe_div(lp_pool_aum.cast::<i128>()?.safe_mul(token_precision)?)?
            .cast::<i64>()
    }

    /// Returns the fee to charge for a swap to/from this constituent
    /// The fee is a linear interpolation between the swap_fee_min and swap_fee_max based on the post-swap deviation from the target weight
    /// precision: PERCENTAGE_PRECISION
    pub fn get_fee_to_charge(&self, post_swap_weight: i64, target_weight: i64) -> DriftResult<i64> {
        let min_weight = target_weight.safe_sub(self.max_weight_deviation as i64)?;
        let max_weight = target_weight.safe_add(self.max_weight_deviation as i64)?;
        let (slope_numerator, slope_denominator) = if post_swap_weight > target_weight {
            let num = self.swap_fee_max.safe_sub(self.swap_fee_min)?;
            let denom = max_weight.safe_sub(target_weight)?;
            (num, denom)
        } else {
            let num = self.swap_fee_min.safe_sub(self.swap_fee_max)?;
            let denom = target_weight.safe_sub(min_weight)?;
            (num, denom)
        };

        let b = self
            .swap_fee_min
            .safe_mul(slope_denominator)?
            .safe_sub(target_weight.safe_mul(slope_numerator)?)?;
        Ok(post_swap_weight
            .safe_mul(slope_numerator)?
            .safe_add(b)?
            .safe_div(slope_denominator)?)
    }

    /// Calculates the amount to transfer to (SpotBalanceType::Deposit) or from (SpotBalanceType::Borrow)
    /// the constituent's SpotBalance to stay within limits.
    pub fn get_amount_to_rebalance_borrow_lend(
        &self,
        token_balance: u64,
        amount: u64,
    ) -> DriftResult<(SpotBalanceType, u64)> {
        // i.e. max +90% lending, 10% in token account
        // i.e. max -90% borrowed
        Ok((SpotBalanceType::Deposit, 0))
    }
}

//   pub struct PerpConstituent {
//   }

#[zero_copy]
#[derive(Debug, Default, BorshDeserialize, BorshSerialize)]
#[repr(C)]
pub struct AmmConstituentDatum {
    pub perp_market_index: u16,
    pub constituent_index: u16,
    pub _padding: [u8; 4],
    pub last_slot: u64,
    /// PERCENTAGE_PRECISION. The weight this constituent has on the perp market
    pub weight: i64,
}

#[zero_copy]
#[derive(Debug, Default)]
#[repr(C)]
pub struct AmmConstituentMappingFixed {
    pub len: u32,
    pub _pad: [u8; 4],
}

impl HasLen for AmmConstituentMappingFixed {
    fn len(&self) -> u32 {
        self.len
    }
}

#[account]
#[derive(Debug)]
#[repr(C)]
pub struct AmmConstituentMapping {
    // PERCENTAGE_PRECISION. Each datum represents the target weight for a single (AMM, Constituent) pair.
    // An AMM may be partially backed by multiple Constituents
    pub weights: Vec<AmmConstituentDatum>,
}

impl AmmConstituentMapping {
    pub fn space(num_constituents: usize) -> usize {
        8 + 8 + 4 + num_constituents * 24
    }

    pub fn validate(&self) -> DriftResult<()> {
        validate!(
            self.weights.len() <= 128,
            ErrorCode::DefaultError,
            "Number of constituents len must be between 1 and 128"
        )?;
        Ok(())
    }
}

impl_zero_copy_loader!(
    AmmConstituentMapping,
    crate::id,
    AmmConstituentMappingFixed,
    AmmConstituentDatum
);

#[zero_copy]
#[derive(Debug, Default, BorshDeserialize, BorshSerialize)]
#[repr(C)]
pub struct WeightDatum {
    pub last_slot: u64,
    pub weight: i64,
}

#[zero_copy]
#[derive(Debug, Default)]
#[repr(C)]
pub struct ConstituentTargetWeightsFixed {
    /// total elements in the flattened `data` vec
    pub len: u32,
    pub _pad: [u8; 4],
}

impl HasLen for ConstituentTargetWeightsFixed {
    fn len(&self) -> u32 {
        self.len
    }
}

#[account]
#[derive(Debug)]
#[repr(C)]
pub struct ConstituentTargetWeights {
    // PERCENTAGE_PRECISION. The weights of the target weight matrix. Updated async
    pub weights: Vec<WeightDatum>,
}

impl ConstituentTargetWeights {
    pub fn space(num_constituents: usize) -> usize {
        8 + 8 + 4 + num_constituents * 16
    }

    pub fn validate(&self) -> DriftResult<()> {
        validate!(
            self.weights.len() <= 128,
            ErrorCode::DefaultError,
            "Number of constituents len must be between 1 and 128"
        )?;
        Ok(())
    }
}

impl_zero_copy_loader!(
    ConstituentTargetWeights,
    crate::id,
    ConstituentTargetWeightsFixed,
    WeightDatum
);

impl Default for ConstituentTargetWeights {
    fn default() -> Self {
        ConstituentTargetWeights {
            weights: Vec::with_capacity(0),
        }
    }
}

#[derive(Clone, Copy, BorshSerialize, BorshDeserialize, PartialEq, Debug, Eq)]
pub enum WeightValidationFlags {
    NONE = 0b0000_0000,
    EnforceTotalWeight100 = 0b0000_0001,
    NoNegativeWeights = 0b0000_0010,
    NoOverweight = 0b0000_0100,
}

impl<'a> AccountZeroCopy<'a, WeightDatum, ConstituentTargetWeightsFixed> {
    pub fn get_target_weight(&self, constituent_index: u16) -> DriftResult<i64> {
        validate!(
            constituent_index < self.len() as u16,
            ErrorCode::InvalidConstituent,
            "Invalid constituent_index = {}, ConstituentTargetWeights len = {}",
            constituent_index,
            self.len()
        )?;
        let datum = self.get(constituent_index as u32);
        Ok(datum.weight)
    }
}

/// Update target weights based on amm_inventory and mapping
impl<'a> AccountZeroCopyMut<'a, WeightDatum, ConstituentTargetWeightsFixed> {
    pub fn update_target_weights(
        &mut self,
        mapping: &AccountZeroCopy<'a, AmmConstituentDatum, AmmConstituentMappingFixed>,
        // (perp market index, inventory, price)
        amm_inventory: &[(u16, i64)],
        constituents_indexes: &[u16],
        prices: &[i64],
        aum: u128,
        slot: u64,
        validation_flags: WeightValidationFlags,
    ) -> DriftResult<i128> {
        let mut total_weight: i128 = 0;
        let aum_i128 = aum.cast::<i128>()?;
        for (i, constituent_index) in constituents_indexes.iter().enumerate() {
            let mut target_amount = 0i128;

            for (perp_market_index, inventory) in amm_inventory.iter() {
                let idx = mapping
                    .iter()
                    .position(|d| &d.perp_market_index == perp_market_index)
                    .expect("missing mapping for this market index");
                let weight = mapping.get(idx as u32).weight; // PERCENTAGE_PRECISION

                target_amount += (*inventory as i128)
                    .saturating_mul(weight as i128)
                    .saturating_div(PERCENTAGE_PRECISION_I64 as i128);
            }

            let price = prices[i] as i128;

            // assumes PRICE_PRECISION = PERCENTAGE_PRECISION
            let target_weight: i128 = if aum > 0 {
                target_amount.saturating_mul(price).saturating_div(aum_i128)
            } else {
                0
            };

            if (validation_flags as u8 & (WeightValidationFlags::NoNegativeWeights as u8) != 0)
                && target_weight < 0
            {
                return Err(ErrorCode::DefaultError);
            }
            if (validation_flags as u8 & (WeightValidationFlags::NoOverweight as u8) != 0)
                && target_weight > PERCENTAGE_PRECISION_I64 as i128
            {
                return Err(ErrorCode::DefaultError);
            }

            let cell = self.get_mut(i as u32);
            msg!(
                "updating constituent index {} target weight to {}",
                constituent_index,
                target_weight
            );
            cell.weight =
                target_weight.clamp(-PERCENTAGE_PRECISION_I128, PERCENTAGE_PRECISION_I128) as i64;
            cell.last_slot = slot;

            total_weight = total_weight.saturating_add(target_weight);
        }

        if (validation_flags as u8) & WeightValidationFlags::EnforceTotalWeight100 as u8 != 0 {
            let deviation = (total_weight - PERCENTAGE_PRECISION_I128).abs();
            let tolerance = 100;
            if deviation > tolerance {
                return Err(ErrorCode::DefaultError);
            }
        }

        Ok(total_weight)
    }
}

impl<'a> AccountZeroCopyMut<'a, AmmConstituentDatum, AmmConstituentMappingFixed> {
    pub fn add_amm_constituent_datum(&mut self, datum: AmmConstituentDatum) -> DriftResult<()> {
        let len = self.len();

        let mut open_slot_index: Option<u32> = None;
        for i in 0..len {
            let cell = self.get(i as u32);
            if cell.constituent_index == datum.constituent_index {
                return Err(ErrorCode::DefaultError);
            }
            if cell.last_slot == 0 && open_slot_index.is_none() {
                open_slot_index = Some(i);
            }
        }
        let open_slot = open_slot_index.ok_or_else(|| ErrorCode::DefaultError.into())?;

        let cell = self.get_mut(open_slot);
        *cell = datum;

        Ok(())
    }
}
