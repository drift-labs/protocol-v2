use crate::error::{DriftResult, ErrorCode};
use crate::math::casting::Cast;
use crate::math::constants::PERCENTAGE_PRECISION_U64;
use crate::math::safe_math::SafeMath;
use crate::state::oracle::OracleSource;
use crate::state::spot_market::{SpotBalance, SpotBalanceType, SpotMarket};
use anchor_lang::prelude::*;

#[cfg(test)]
mod tests;

pub struct LPPool {
    /// name of vault, TODO: check type + size
    pub name: [u8; 32],
    /// address of the vault.
    pub pubkey: Pubkey,
    // vault token mint
    pub mint: Pubkey,
    /// LPPool's token account
    pub token_vault: Pubkey,

    /// token_supply? to simplify NAV calculation, or load from mint account
    /// token_total_supply: u64

    /// The current number of VaultConstituents in the vault, each constituent is pda(LPPool.address, constituent_index)
    pub constituents: u16,
    /// which constituent is the quote, receives revenue pool distributions. (maybe this should just be implied idx 0)
    /// pub quote_constituent_index: u16,

    /// Max AUM. Prohibit minting new DLP beyond this
    /// pub max_aum: u64,

    /// AUM of the vault in USD, updated lazily
    pub last_aum: u64,

    /// timestamp of last AUM slot
    pub last_aum_slot: u64,
    /// timestamp of last AUM update
    pub last_aum_ts: u64,

    /// timestamp of last vAMM revenue rebalance
    pub last_revenue_rebalance_ts: u64,

    /// all revenue settles recieved
    pub total_fees_received: u128,
    /// all revenues paid out
    pub total_fees_paid: u128,
}

#[zero_copy(unsafe)]
#[derive(Default, Eq, PartialEq, Debug)]
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

pub struct Constituent {
    /// address of the constituent
    pub pubkey: Pubkey,
    /// idx in LPPool.constituents
    pub constituent_index: u16,

    /// how to store actual DLP spot balances:
    /// option 1) token account for the constituent (use this to isolate user deposits) - does not allow borrow/lend
    /// pub token_account: Pubkey,
    /// option 2) spot market balance (use this to deposit constituent balance into spot market and be exposed to borrow/lend interest)
    /// pub scaled_balance: u64,
    /// pub balance_type: BalanceType.

    /// oracle used to price the constituent
    pub oracle: Pubkey,
    pub oracle_source: OracleSource,
    /// max deviation from target_weight allowed for the constituent
    /// precision: PERCENTAGE_PRECISION
    pub max_weight_deviation: u64,
    /// min fee charged on swaps to this constituent
    /// precision: PERCENTAGE_PRECISION
    pub swap_fee_min: u64,
    /// max premium to be applied to swap_fee_min when the constituent is at max deviation from target_weight
    /// precision: PERCENTAGE_PRECISION
    pub max_fee_premium: u64,
    /// underlying drift spot market index
    pub spot_market_index: u16,
    /// oracle price at last update
    /// precision: PRICE_PRECISION_I64
    pub last_oracle_price: i64,
    /// timestamp of last oracle price update:
    pub last_oracle_price_ts: u64,

    /// spot borrow-lend balance for constituent
    pub spot_balance: BLPosition, // should be in constituent base asset
}

//   pub struct PerpConstituent {
//   }

pub struct WeightDatum {
    pub data: u64,
    pub last_slot: u64,
}

pub struct AmmConstituentMapping {
    // rows in the matrix, (perp markets)
    pub num_rows: u16,
    // columns in the matrix (VaultConstituents, spot markets)
    pub num_cols: u16,
    // flattened matrix elements, PERCENTAGE_PRECISION. Keep at the end of the account to allow expansion with new constituents.
    pub data: Vec<WeightDatum>,
}

pub struct ConstituentTargetWeights {
    // rows in the matrix (VaultConstituents)
    pub num_rows: u16,
    // columns in the matrix (0th is the weight, 1st is the last time the weight was updated)
    pub num_cols: u16,
    // ts of the oldest weight in data, for swaps to reference without traversing matrix
    pub oldest_weight_ts: u64,
    // PERCENTAGE_PRECISION. The weights of the target weight matrix. Updated async
    pub data: Vec<WeightDatum>,
}

impl Default for ConstituentTargetWeights {
    fn default() -> Self {
        ConstituentTargetWeights {
            num_rows: 0,
            num_cols: 0,
            oldest_weight_ts: 0,
            data: Vec::with_capacity(0),
        }
    }
}

impl ConstituentTargetWeights {
    /// Update target weights based on amm_inventory and mapping
    pub fn update_target_weights(
        &mut self,
        mapping: &AmmConstituentMapping,
        amm_inventory: &[u64], // length = mapping.num_rows
        constituents: &[Constituent],
        prices: &[u64], // same order as constituents
        aum: u64,
        slot: u64,
    ) -> DriftResult<()> {
        // assert_ne!(aum, 0);
        assert_eq!(constituents.len(), mapping.num_cols as usize);
        assert_eq!(amm_inventory.len(), mapping.num_rows as usize);
        assert_eq!(prices.len(), constituents.len());

        self.data.clear();
        self.num_rows = constituents.len() as u16;
        self.num_cols = 2;
        self.oldest_weight_ts = slot;

        for (constituent_index, constituent) in constituents.iter().enumerate() {
            let mut target_amount = 0u128;

            for (row_index, &inventory) in amm_inventory.iter().enumerate() {
                let idx = row_index * mapping.num_cols as usize + constituent_index;
                let weight = mapping.data[idx].data as u128; // PERCENTAGE_PRECISION

                target_amount += inventory as u128 * weight / PERCENTAGE_PRECISION_U64 as u128;
            }

            let price = prices[constituent_index] as u128;
            let target_weight = target_amount
                .saturating_mul(price)
                .saturating_div(aum.max(1) as u128);

            // PERCENTAGE_PRECISION capped
            let weight_datum = (target_weight as u64).min(PERCENTAGE_PRECISION_U64);

            self.data.push(WeightDatum {
                data: weight_datum,
                last_slot: slot,
            });
        }

        Ok(())
    }
}
