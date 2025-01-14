use std::fmt;
use std::fmt::{Display, Formatter};

use anchor_lang::prelude::*;

use borsh::{BorshDeserialize, BorshSerialize};

use crate::error::{DriftResult, ErrorCode};
use crate::math::casting::Cast;
use crate::math::constants::{
    AMM_RESERVE_PRECISION, FIVE_MINUTE, MARGIN_PRECISION, ONE_HOUR, SPOT_WEIGHT_PRECISION_U128,
};
#[cfg(test)]
use crate::math::constants::{PRICE_PRECISION_I64, SPOT_CUMULATIVE_INTEREST_PRECISION};
use crate::math::margin::{
    calculate_size_discount_asset_weight, calculate_size_premium_liability_weight,
    MarginRequirementType,
};
use crate::math::safe_math::SafeMath;
use crate::math::spot_balance::{calculate_utilization, get_token_amount, get_token_value};

use crate::math::stats::calculate_new_twap;
use crate::state::oracle::{HistoricalIndexData, HistoricalOracleData, OracleSource};
use crate::state::paused_operations::{InsuranceFundOperation, SpotOperation};
use crate::state::perp_market::{MarketStatus, PoolBalance};
use crate::state::traits::{MarketIndexOffset, Size};
use crate::{validate, PERCENTAGE_PRECISION, PRICE_PRECISION, PRICE_PRECISION_U64};

use crate::state::oracle_map::OracleMap;
use crate::state::vault_constituent_map::VaultConstituentMap;

use super::vault_constituent::Constituent;

#[account]
#[derive(PartialEq, Eq, Debug)]
pub struct Vault {
    /// address of the vault.
    pub pubkey: Pubkey,
    // vault token mint
    pub mint: Pubkey,
    /// vault token token account
    pub token_vault: Pubkey,
    /// the constituents of the vault.
    pub constituents: Vec<Pubkey>,
    /// vault token supply
    pub token_supply: u64,
    /// AUM of the vault in USD, updated lazily
    pub last_aum: u128,
    /// timestamp of last AUM update
    pub last_aum_ts: i64,
}

impl Default for Vault {
    fn default() -> Self {
        Vault {
            pubkey: Pubkey::default(),
            mint: Pubkey::default(),
            token_vault: Pubkey::default(),
            constituents: vec![],
            token_supply: 0,
            last_aum: 0,
            last_aum_ts: 0,
        }
    }
}

impl Vault {
    pub fn update_aum_and_weights(
        &mut self,
        constituents: &VaultConstituentMap,
        oracle_map: &mut OracleMap,
        clock: &Clock,
    ) -> DriftResult<(u128, Vec<u128>)> {
        let mut aum = 0;
        let mut weights = vec![];

        for constituent_key in self.constituents.iter() {
            let constituent = constituents.get_ref(constituent_key)?;
            let oracle_price_data =
                oracle_map.get_price_data(&(constituent.oracle, constituent.oracle_source))?;
            let token_precision = 10_u128.pow(constituent.decimals as u32);

            // decimals * price
            aum = aum.safe_add(
                constituent
                    .deposit_balance
                    .safe_mul(oracle_price_data.price.cast()?)?
                    .safe_div(token_precision)?,
            )?;
        }

        for constituent_key in self.constituents.iter() {
            let constituent = constituents.get_ref(constituent_key)?;
            let oracle_price_data =
                oracle_map.get_price_data(&(constituent.oracle, constituent.oracle_source))?;
            let token_precision = 10_u128.pow(constituent.decimals as u32);

            weights.push(
                constituent
                    .deposit_balance
                    .safe_mul(oracle_price_data.price.cast()?)?
                    .safe_mul(PERCENTAGE_PRECISION)?
                    .safe_div(token_precision)?
                    .safe_div(aum)?,
            )
        }

        msg!("aum: {}, weights: {:?}", aum, weights);
        self.last_aum = aum;
        self.last_aum_ts = clock.unix_timestamp;

        Ok((aum, weights))
    }

    /// get nav of the vault
    /// returns NAV in PRICE_PRECISION
    pub fn get_nav(&self) -> DriftResult<u128> {
        if self.token_supply == 0 {
            return Ok(0);
        }

        self.last_aum
            .safe_mul(PRICE_PRECISION)?
            .safe_div(self.token_supply as u128)
    }

    /// get the swap price between two constituents. A `None` constituent is assumed to be the vault token.
    /// returns swap price in PRICE_PRECISION
    pub fn get_swap_price(
        &self,
        constituents: &VaultConstituentMap,
        oracle_map: &mut OracleMap,
        in_constituent: Option<Pubkey>,
        out_constituent: Option<Pubkey>,
        in_amount: u128,
    ) -> DriftResult<u128> {

        validate!(
            in_constituent.is_some() || out_constituent.is_some(),
            ErrorCode::DefaultError,
            "in_constituent and out_constituent cannot both be None"
        )?;

        let get_token_constituent = move |key: Pubkey| -> (Option<Constituent>, u32) {
            let c = constituents
                .get_ref(&key)
                .expect("failed to get constituent");
            (Some(*c), c.decimals)
        };
        let get_vault_token_constituent = || -> (Option<Constituent>, u32) { (None, 6) };

        let (in_constituent, in_decimals) =
            in_constituent.map_or_else(&get_vault_token_constituent, &get_token_constituent);
        let (out_constituent, out_decimals) =
            out_constituent.map_or_else(&get_vault_token_constituent, &get_token_constituent);

        let in_price = in_constituent.map_or_else(
            || self.get_nav().expect("failed to get nav"),
            |c| {
                oracle_map
                    .get_price_data(&(c.oracle, c.oracle_source))
                    .expect("failed to get price data")
                    .price
                    .cast()
                    .expect("failed to cast price")
            },
        );

        let out_price = out_constituent.map_or_else(
            || self.get_nav().expect("failed to get nav"),
            |c| {
                oracle_map
                    .get_price_data(&(c.oracle, c.oracle_source))
                    .expect("failed to get price data")
                    .price
                    .cast()
                    .expect("failed to cast price")
            },
        );

        let (prec_diff_numerator, prec_diff_denominator) = if out_decimals > in_decimals {
            (10_u128.pow(out_decimals - in_decimals), 1)
        } else {
            (1, 10_u128.pow(in_decimals - out_decimals))
        };

        let swap_price = in_amount
            .safe_mul(in_price)?
            .safe_mul(prec_diff_numerator)?
            .safe_div(out_price.safe_mul(prec_diff_denominator)?)?;

        Ok(swap_price)
    }

    pub fn swap(
        &mut self,
        in_constituent: Option<Pubkey>,
        out_constituent: Option<Pubkey>,
        in_amount: u128,
    ) -> DriftResult<u128> {
        Ok(0)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::state::vault_constituent::Constituent;
    use crate::test_utils::get_pyth_price;
    use crate::{create_account_info, create_anchor_account_info};
    use crate::{test_utils::*, PRICE_PRECISION};
    use anchor_lang::prelude::Pubkey;
    use std::str::FromStr;

    #[test]
    fn test_update_aum_and_weights() {
        let sol_account_key =
            Pubkey::from_str("B3VkEqUtGPMPu95iLVifzrtfzKQsrEy1trYrwLCRFQ6m").unwrap();
        let sol_oracle_key =
            Pubkey::from_str("BAtFj4kQttZRVep3UZS2aZRDixkGYgWsbqTBVDbnSsPF").unwrap();
        let btc_account_key =
            Pubkey::from_str("9nnLbotNTcUhvbrsA6Mdkx45Sm82G35zo28AqUvjExn8").unwrap();
        let btc_oracle_key =
            Pubkey::from_str("486kr3pmFPfTsS4aZgcsQ7kS4i9rjMsYYZup6HQNSTT4").unwrap();

        let mut vault = Vault {
            constituents: vec![sol_account_key, btc_account_key],
            ..Default::default()
        };

        let oracle_program = crate::ids::pyth_program::id();
        create_account_info!(
            get_pyth_price(200, 6),
            &sol_oracle_key,
            &oracle_program,
            sol_oracle_account_info
        );
        create_account_info!(
            get_pyth_price(100_000, 6),
            &btc_oracle_key,
            &oracle_program,
            btc_oracle_account_info
        );

        let mut oracle_map = OracleMap::load(
            &mut vec![sol_oracle_account_info, btc_oracle_account_info]
                .iter()
                .peekable(),
            0,
            None,
        )
        .expect("failed to load oracle map");

        create_anchor_account_info!(
            Constituent {
                pubkey: sol_account_key,
                oracle: sol_oracle_key,
                oracle_source: OracleSource::Pyth,
                deposit_balance: 500_000_000_000,
                decimals: 9,
                ..Default::default()
            },
            &sol_account_key,
            Constituent,
            sol_constituent_account_info
        );
        create_anchor_account_info!(
            Constituent {
                pubkey: btc_account_key,
                oracle: btc_oracle_key,
                oracle_source: OracleSource::Pyth,
                deposit_balance: 100_000_000,
                decimals: 8,
                ..Default::default()
            },
            &btc_account_key,
            Constituent,
            btc_constituent_account_info
        );

        let constituents = VaultConstituentMap::load_multiple(vec![
            &sol_constituent_account_info,
            &btc_constituent_account_info,
        ])
        .expect("failed to load constituents");

        let (aum, weights) = vault
            .update_aum_and_weights(&constituents, &mut oracle_map, &Clock::default())
            .expect("failed to update aum and weights");

        assert_eq!(aum, 200_000 * PRICE_PRECISION);
        assert_eq!(
            weights,
            vec![
                50 * PERCENTAGE_PRECISION / 100,
                50 * PERCENTAGE_PRECISION / 100
            ]
        );
    }

    #[test]
    fn test_get_nav() {
        let sol_account_key = Pubkey::from_str("B3VkEqUtGPMPu95iLVifzrtfzKQsrEy1trYrwLCRFQ6m").unwrap();
        let sol_oracle_key = Pubkey::from_str("BAtFj4kQttZRVep3UZS2aZRDixkGYgWsbqTBVDbnSsPF").unwrap();
        let btc_account_key = Pubkey::from_str("9nnLbotNTcUhvbrsA6Mdkx45Sm82G35zo28AqUvjExn8").unwrap();
        let btc_oracle_key = Pubkey::from_str("486kr3pmFPfTsS4aZgcsQ7kS4i9rjMsYYZup6HQNSTT4").unwrap();

        let vault = Vault {
            constituents: vec![sol_account_key, btc_account_key],
            token_supply: 100_000_000_000,
            last_aum: 200_000 * PRICE_PRECISION,
            ..Default::default()
        };

        let oracle_program = crate::ids::pyth_program::id();
        create_account_info!(
            get_pyth_price(200, 6),
            &sol_oracle_key,
            &oracle_program,
            sol_oracle_account_info
        );
        create_account_info!(
            get_pyth_price(100_000, 6),
            &btc_oracle_key,
            &oracle_program,
            btc_oracle_account_info
        );

        let mut oracle_map = OracleMap::load(
            &mut vec![sol_oracle_account_info, btc_oracle_account_info]
                .iter()
                .peekable(),
            0,
            None,
        )
        .expect("failed to load oracle map");

        create_anchor_account_info!(
            Constituent {
                pubkey: sol_account_key,
                oracle: sol_oracle_key,
                oracle_source: OracleSource::Pyth,
                deposit_balance: 500_000_000_000,
                decimals: 9,
                ..Default::default()
            },
            &sol_account_key,
            Constituent,
            sol_constituent_account_info
        );
        create_anchor_account_info!(
            Constituent {
                pubkey: btc_account_key,
                oracle: btc_oracle_key,
                oracle_source: OracleSource::Pyth,
                deposit_balance: 100_000_000,
                decimals: 8,
                ..Default::default()
            },
            &btc_account_key,
            Constituent,
            btc_constituent_account_info
        );

        let constituents = VaultConstituentMap::load_multiple(vec![
            &sol_constituent_account_info,
            &btc_constituent_account_info,
        ])
        .expect("failed to load constituents");

        let nav = vault
            .get_nav()
            .expect("failed to get nav");

        assert_eq!(nav, 2 * PRICE_PRECISION);
    }

    #[test]
    fn test_get_swap_price() {
        let sol_account_key =
            Pubkey::from_str("B3VkEqUtGPMPu95iLVifzrtfzKQsrEy1trYrwLCRFQ6m").unwrap();
        let sol_oracle_key =
            Pubkey::from_str("BAtFj4kQttZRVep3UZS2aZRDixkGYgWsbqTBVDbnSsPF").unwrap();
        let btc_account_key =
            Pubkey::from_str("9nnLbotNTcUhvbrsA6Mdkx45Sm82G35zo28AqUvjExn8").unwrap();
        let btc_oracle_key =
            Pubkey::from_str("486kr3pmFPfTsS4aZgcsQ7kS4i9rjMsYYZup6HQNSTT4").unwrap();

        let vault = Vault {
            constituents: vec![sol_account_key, btc_account_key],
            token_supply: 100_000_000_000,
            last_aum: 200_000 * PRICE_PRECISION,
            ..Default::default()
        };

        let oracle_program = crate::ids::pyth_program::id();
        create_account_info!(
            get_pyth_price(200, 6),
            &sol_oracle_key,
            &oracle_program,
            sol_oracle_account_info
        );
        create_account_info!(
            get_pyth_price(100_000, 6),
            &btc_oracle_key,
            &oracle_program,
            btc_oracle_account_info
        );

        let mut oracle_map = OracleMap::load(
            &mut vec![sol_oracle_account_info, btc_oracle_account_info]
                .iter()
                .peekable(),
            0,
            None,
        )
        .expect("failed to load oracle map");

        create_anchor_account_info!(
            Constituent {
                pubkey: sol_account_key,
                oracle: sol_oracle_key,
                oracle_source: OracleSource::Pyth,
                deposit_balance: 500_000_000_000,
                decimals: 9,
                ..Default::default()
            },
            &sol_account_key,
            Constituent,
            sol_constituent_account_info
        );
        create_anchor_account_info!(
            Constituent {
                pubkey: btc_account_key,
                oracle: btc_oracle_key,
                oracle_source: OracleSource::Pyth,
                deposit_balance: 100_000_000,
                decimals: 8,
                ..Default::default()
            },
            &btc_account_key,
            Constituent,
            btc_constituent_account_info
        );

        let constituents = VaultConstituentMap::load_multiple(vec![
            &sol_constituent_account_info,
            &btc_constituent_account_info,
        ])
        .expect("failed to load constituents");

        // Test SOL -> BTC swap price
        let out_amount = vault
            .get_swap_price(
                &constituents,
                &mut oracle_map,
                Some(sol_account_key),
                Some(btc_account_key),
                1_000_000_000, // 1 SOL
                &Clock::default(),
            )
            .expect("failed to get swap price");

        // 1 SOL = $200/$100k = 0.002 BTC
        assert_eq!(out_amount, 200_000);

        // Test BTC -> Vault token swap price
        let out_amount = vault
            .get_swap_price(
                &constituents,
                &mut oracle_map,
                Some(btc_account_key),
                Some(sol_account_key),
                100_000_000, // 1 BTC
                &Clock::default(),
            )
            .expect("failed to get swap price");

        // 1 BTC = $100k/$200 = 500 SOL
        assert_eq!(out_amount, 500_000_000_000);
    }
}
