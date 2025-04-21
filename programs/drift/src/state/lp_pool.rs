use crate::error::{DriftResult, ErrorCode};
use crate::math::casting::Cast;
use crate::math::constants::{PERCENTAGE_PRECISION_I128, PERCENTAGE_PRECISION_I64};
use crate::math::safe_math::SafeMath;
use crate::state::oracle::OracleSource;
use crate::state::spot_market::{SpotBalance, SpotBalanceType, SpotMarket};
use crate::state::traits::Size;
use anchor_lang::prelude::*;
use borsh::{BorshDeserialize, BorshSerialize};

#[cfg(test)]
mod tests;

#[account(zero_copy)]
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
    pub max_aum: u64, // 8, 136

    /// QUOTE_PRECISION: AUM of the vault in USD, updated lazily
    pub last_aum: u64, // 8, 144

    /// timestamp of last AUM slot
    pub last_aum_slot: u64, // 8, 152
    /// timestamp of last AUM update
    pub last_aum_ts: u64, // 8, 160

    /// timestamp of last vAMM revenue rebalance
    pub last_revenue_rebalance_ts: u64, // 8, 168

    /// all revenue settles recieved
    pub total_fees_received: u128, // 16, 176
    /// all revenues paid out
    pub total_fees_paid: u128, // 16, 192

    pub constituents: u16, // 2, 194
    pub padding: [u8; 6],
}

impl Size for LPPool {
    const SIZE: usize = 1743;
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
    pub padding: [u8; 4],
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

    /// max deviation from target_weight allowed for the constituent
    /// precision: PERCENTAGE_PRECISION
    pub max_weight_deviation: u64,
    /// min fee charged on swaps to this constituent
    /// precision: PERCENTAGE_PRECISION
    pub swap_fee_min: u64,
    /// max premium to be applied to swap_fee_min when the constituent is at max deviation from target_weight
    /// precision: PERCENTAGE_PRECISION
    pub max_fee_premium: u64,

    /// spot borrow-lend balance for constituent
    pub spot_balance: BLPosition, // should be in constituent base asset
    pub padding: [u8; 16],
}

//   pub struct PerpConstituent {
//   }

#[zero_copy]
#[derive(Debug, BorshDeserialize, BorshSerialize)]
#[repr(C)]
pub struct AmmConstituentDatum {
    pub perp_market_index: u16,
    pub constituent_index: u16,
    pub padding: [u8; 4],
    /// PERCENTAGE_PRECISION. The weight this constituent has on the perp market
    pub data: i64,
    pub last_slot: u64,
}

#[zero_copy]
#[derive(Debug, BorshDeserialize, BorshSerialize)]
#[repr(C)]
pub struct WeightDatum {
    pub constituent_index: u16,
    pub padding: [u8; 6],
    /// PERCENTAGE_PRECISION. The weights of the target weight matrix
    pub data: i64,
    pub last_slot: u64,
}

#[account]
#[derive(Debug)]
#[repr(C)]
pub struct AmmConstituentMapping {
    // PERCENTAGE_PRECISION. Each datum represents the target weight for a single (AMM, Constituent) pair.
    // An AMM may be partially backed by multiple Constituents
    pub data: Vec<AmmConstituentDatum>,
}

#[account]
#[derive(Debug)]
#[repr(C)]
pub struct ConstituentTargetWeights {
    // PERCENTAGE_PRECISION. The weights of the target weight matrix. Updated async
    pub data: Vec<WeightDatum>,
}

impl Default for ConstituentTargetWeights {
    fn default() -> Self {
        ConstituentTargetWeights {
            data: Vec::with_capacity(0),
        }
    }
}

impl ConstituentTargetWeights {
    /// Update target weights based on amm_inventory and mapping
    pub fn update_target_weights(
        &mut self,
        mapping: &AmmConstituentMapping,
        amm_inventory: &[(u16, i64)],
        constituents: &[Constituent],
        prices: &[u64], // same order as constituents
        aum: u64,
        slot: u64,
    ) -> DriftResult<()> {
        // assert_ne!(aum, 0);
        assert_eq!(prices.len(), constituents.len());

        self.data.clear();

        for (constituent_index, constituent) in constituents.iter().enumerate() {
            let mut target_amount = 0i128;

            for (perp_market_index, inventory) in amm_inventory.iter() {
                let idx = mapping
                    .data
                    .iter()
                    .position(|d| &d.perp_market_index == perp_market_index)
                    .expect("missing mapping for this market index");
                let weight = mapping.data[idx].data; // PERCENTAGE_PRECISION
                target_amount +=
                    (*inventory as i128) * weight as i128 / PERCENTAGE_PRECISION_I64 as i128;
            }

            let price = prices[constituent_index] as i128;
            let target_weight = target_amount
                .saturating_mul(price)
                .saturating_div(aum.max(1) as i128);

            // PERCENTAGE_PRECISION capped
            let weight_datum = (target_weight).min(PERCENTAGE_PRECISION_I128);

            self.data.push(WeightDatum {
                constituent_index: constituent_index as u16,
                padding: [0; 6],
                data: weight_datum as i64,
                last_slot: slot,
            });
        }

        Ok(())
    }

    pub fn get_target_weight(&self, constituent_index: u16) -> DriftResult<i64> {
        let weight_datum = self
            .data
            .iter()
            .find(|d| d.constituent_index == constituent_index)
            .expect("missing target weight for this constituent");
        Ok(weight_datum.data)
    }
}
