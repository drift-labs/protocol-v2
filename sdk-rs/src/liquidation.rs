//! liquidation and margin helpers
//!

use std::ops::Neg;

use anchor_lang::{prelude::AccountInfo, AnchorDeserialize};
use drift::{
    ids::pyth_program,
    instructions::optional_accounts::AccountMaps,
    math::{
        casting::Cast,
        constants::{
            BASE_PRECISION_I64, MARGIN_PRECISION, QUOTE_PRECISION_I64, SPOT_WEIGHT_PRECISION,
        },
        margin::{
            calculate_margin_requirement_and_total_collateral_and_liability_info,
            MarginRequirementType,
        },
    },
    state::{
        margin_calculation::MarginContext,
        oracle_map::OracleMap,
        perp_market::PerpMarket,
        perp_market_map::{MarketSet, PerpMarketMap},
        spot_market::SpotMarket,
        spot_market_map::SpotMarketMap,
        state::State,
        user::{PerpPosition, SpotPosition, User},
    },
};
use fnv::FnvHashSet;
use solana_client::rpc_response::Response;
use solana_sdk::{
    account::{Account, ReadableAccount},
    pubkey::Pubkey,
};

use crate::{constants, AccountProvider, DriftClient, MarketId, SdkError, SdkResult};

/// Builds an AccountMap of relevant spot, perp, and oracle accounts from rpc
#[derive(Default)]
struct AccountMapBuilder {
    accounts: Vec<Account>,
    account_keys: Vec<Pubkey>,
}

impl AccountMapBuilder {
    /// Constructs the account map + drift state account
    pub async fn build<T: AccountProvider>(
        &mut self,
        client: &DriftClient<T>,
        user: &User,
    ) -> SdkResult<AccountMaps> {
        let mut oracles = FnvHashSet::<Pubkey>::default();
        let mut spot_markets_count = 0_usize;
        let mut perp_markets_count = 0_usize;

        for p in user.spot_positions.iter().filter(|p| !p.is_available()) {
            let market = *client
                .program_data()
                .spot_market_config_by_index(p.market_index)
                .unwrap();
            self.account_keys.push(market.pubkey);
            oracles.insert(market.oracle);
            spot_markets_count += 1;
        }

        // always need quote market
        let quote_market = *client
            .program_data()
            .spot_market_config_by_index(MarketId::QUOTE_SPOT.index)
            .unwrap();
        if !oracles.contains(&quote_market.oracle) {
            self.account_keys.push(quote_market.pubkey);
            oracles.insert(quote_market.oracle);
            spot_markets_count += 1
        }

        for p in user.perp_positions.iter().filter(|p| !p.is_available()) {
            let market = *client
                .program_data()
                .perp_market_config_by_index(p.market_index)
                .unwrap();
            self.account_keys.push(market.pubkey);
            oracles.insert(market.amm.oracle);
            perp_markets_count += 1;
        }

        self.account_keys.extend(oracles.iter());
        self.account_keys.push(*constants::state_account());

        let Response { context, value } = client
            .inner()
            .get_multiple_accounts_with_config(self.account_keys.as_slice(), Default::default())
            .await?;

        self.accounts = value.into_iter().flatten().collect();

        if self.accounts.len() != self.account_keys.len() {
            return Err(SdkError::InvalidAccount);
        }
        let mut accounts_iter = self.account_keys.iter().zip(self.accounts.iter_mut());

        let mut spot_accounts = Vec::<AccountInfo>::with_capacity(spot_markets_count);
        for _ in 0..spot_markets_count {
            let (pubkey, acc) = accounts_iter.next().unwrap();
            spot_accounts.push(AccountInfo::new(
                pubkey,
                false,
                false,
                &mut acc.lamports,
                &mut acc.data[..],
                &constants::PROGRAM_ID,
                false,
                0,
            ));
        }

        let mut perp_accounts = Vec::<AccountInfo>::with_capacity(perp_markets_count);
        for _ in 0..perp_markets_count {
            let (pubkey, acc) = accounts_iter.next().unwrap();
            perp_accounts.push(AccountInfo::new(
                pubkey,
                false,
                false,
                &mut acc.lamports,
                &mut acc.data[..],
                &constants::PROGRAM_ID,
                false,
                0,
            ));
        }

        let mut oracle_accounts = Vec::<AccountInfo>::with_capacity(oracles.len());
        for _ in 0..oracles.len() {
            let (pubkey, acc) = accounts_iter.next().unwrap();
            oracle_accounts.push(AccountInfo::new(
                pubkey,
                false,
                false,
                &mut acc.lamports,
                &mut acc.data[..],
                &pyth_program::ID, // this could be wrong but it doesn't really matter for the liquidity calculation
                false,
                0,
            ));
        }

        let perp_market_map =
            PerpMarketMap::load(&MarketSet::default(), &mut perp_accounts.iter().peekable())
                .map_err(|err| SdkError::Anchor(Box::new(err.into())))?;
        let spot_market_map =
            SpotMarketMap::load(&MarketSet::default(), &mut spot_accounts.iter().peekable())
                .map_err(|err| SdkError::Anchor(Box::new(err.into())))?;

        let (_, state_account) = accounts_iter.next().unwrap();
        let state = State::deserialize(&mut state_account.data()).expect("valid state");
        let oracle_map = OracleMap::load(
            &mut oracle_accounts.iter().peekable(),
            context.slot,
            Some(state.oracle_guard_rails),
        )
        .map_err(|err| SdkError::Anchor(Box::new(err.into())))?;

        Ok(AccountMaps {
            spot_market_map,
            perp_market_map,
            oracle_map,
        })
    }
}

/// Calculate the liquidation price of a user's perp position (given by `market_index`)
///
/// Returns the liquidaton price (PRICE_PRECISION / 1e6)
pub async fn calculate_liquidation_price<'a, T: AccountProvider>(
    client: &DriftClient<T>,
    user: &User,
    market_index: u16,
) -> SdkResult<i64> {
    // TODO: this does a decent amount of rpc queries, it could make sense to cache it e.g. for calculating multiple perp positions
    let mut accounts_builder = AccountMapBuilder::default();
    let account_maps = accounts_builder.build(client, user).await?;
    calculate_liquidation_price_inner(user, market_index, account_maps)
}

fn calculate_liquidation_price_inner(
    user: &User,
    market_index: u16,
    account_maps: AccountMaps<'_>,
) -> SdkResult<i64> {
    let AccountMaps {
        perp_market_map,
        spot_market_map,
        mut oracle_map,
    } = account_maps;

    let margin_calculation = calculate_margin_requirement_and_total_collateral_and_liability_info(
        user,
        &perp_market_map,
        &spot_market_map,
        &mut oracle_map,
        MarginContext::standard(MarginRequirementType::Maintenance),
    )
    .map_err(|err| SdkError::Anchor(Box::new(err.into())))?;

    // calculate perp free collateral delta
    let perp_market = perp_market_map
        .get_ref(&market_index)
        .map_err(|err| SdkError::Anchor(Box::new(err.into())))?;
    let perp_free_collateral_delta = calculate_perp_free_collateral_delta(
        user.get_perp_position(market_index).unwrap(),
        &perp_market,
    );
    // user holding spot asset case
    let mut spot_free_collateral_delta = 0;
    if let Some(spot_market_index) = spot_market_map
        .0
        .iter()
        .position(|x| x.1.load().is_ok_and(|x| x.oracle == perp_market.amm.oracle))
    {
        if let Ok(spot_position) = user.get_spot_position(spot_market_index as u16) {
            if !spot_position.is_available() {
                let market = spot_market_map
                    .get_ref(&(spot_market_index as u16))
                    .unwrap();
                spot_free_collateral_delta =
                    calculate_spot_free_collateral_delta(spot_position, &market);
            }
        }
    }

    // calculate liquidation price
    // what price delta causes free collateral == 0
    let free_collateral = margin_calculation.get_free_collateral().unwrap();
    let free_collateral_delta = perp_free_collateral_delta + spot_free_collateral_delta;
    if free_collateral == 0 {
        return Ok(-1);
    }
    let liquidation_price_delta =
        (free_collateral as i64 * QUOTE_PRECISION_I64) / free_collateral_delta;

    let oracle_price_data = *oracle_map.get_price_data(&perp_market.amm.oracle).unwrap();
    let liquidation_price = oracle_price_data.price - liquidation_price_delta;
    if liquidation_price < 0 {
        Ok(-1)
    } else {
        Ok(liquidation_price)
    }
}

fn calculate_perp_free_collateral_delta(position: &PerpPosition, market: &PerpMarket) -> i64 {
    let worst_case_base_amount = position.worst_case_base_asset_amount().unwrap();
    let margin_ratio = market
        .get_margin_ratio(
            worst_case_base_amount.unsigned_abs(),
            MarginRequirementType::Maintenance,
        )
        .unwrap();
    let margin_ratio = (margin_ratio as i64 * QUOTE_PRECISION_I64) / MARGIN_PRECISION as i64;

    if worst_case_base_amount > 0 {
        ((QUOTE_PRECISION_I64 - margin_ratio) * worst_case_base_amount as i64) / BASE_PRECISION_I64
    } else {
        ((QUOTE_PRECISION_I64.neg() - margin_ratio) * worst_case_base_amount.abs() as i64)
            / BASE_PRECISION_I64
    }
}

fn calculate_spot_free_collateral_delta(position: &SpotPosition, market: &SpotMarket) -> i64 {
    let market_precision = 10_i64.pow(market.decimals);
    let signed_token_amount = position.get_signed_token_amount(market).unwrap();
    if signed_token_amount > 0 {
        let weight = market
            .get_asset_weight(
                signed_token_amount.unsigned_abs(),
                0, // unused by Maintenance margin type, hence 0
                &MarginRequirementType::Maintenance,
            )
            .unwrap() as i64;
        (((QUOTE_PRECISION_I64 * weight) / SPOT_WEIGHT_PRECISION as i64)
            * signed_token_amount.cast::<i64>().unwrap())
            / market_precision
    } else {
        let weight = market
            .get_liability_weight(
                signed_token_amount.unsigned_abs(),
                &MarginRequirementType::Maintenance,
            )
            .unwrap() as i64;
        (((QUOTE_PRECISION_I64.neg() * weight) / SPOT_WEIGHT_PRECISION as i64)
            * signed_token_amount.abs().cast::<i64>().unwrap())
            / market_precision
    }
}

#[cfg(test)]
mod tests {
    use std::str::FromStr;

    use anchor_lang::{Owner, ZeroCopy};
    use bytes::BytesMut;
    use drift::{
        math::constants::{
            AMM_RESERVE_PRECISION, LIQUIDATION_FEE_PRECISION, PEG_PRECISION,
            SPOT_BALANCE_PRECISION, SPOT_BALANCE_PRECISION_U64, SPOT_CUMULATIVE_INTEREST_PRECISION,
        },
        state::{
            oracle::{HistoricalOracleData, OracleSource},
            perp_market::{MarketStatus, AMM},
            user::SpotPosition,
        },
    };
    use pyth::pc::Price;
    use solana_sdk::signature::Keypair;

    use super::*;
    use crate::{MarketId, RpcAccountProvider, Wallet};

    const SOL_ORACLE: Pubkey = solana_sdk::pubkey!("J83w4HKfqxwcq3BEMMkPFSppX3gqekLyLJBexebFVkix");
    const BTC_ORACLE: Pubkey = solana_sdk::pubkey!("GVXRSBjFk6e6J3NbVPXohDJetcTjaeeuykUpbQF8UoMU");

    fn sol_spot_market() -> SpotMarket {
        SpotMarket {
            market_index: 1,
            oracle_source: OracleSource::Pyth,
            oracle: SOL_ORACLE,
            cumulative_deposit_interest: SPOT_CUMULATIVE_INTEREST_PRECISION,
            cumulative_borrow_interest: SPOT_CUMULATIVE_INTEREST_PRECISION,
            decimals: 9,
            initial_asset_weight: 8 * SPOT_WEIGHT_PRECISION / 10,
            maintenance_asset_weight: 9 * SPOT_WEIGHT_PRECISION / 10,
            initial_liability_weight: 12 * SPOT_WEIGHT_PRECISION / 10,
            maintenance_liability_weight: 11 * SPOT_WEIGHT_PRECISION / 10,
            liquidator_fee: LIQUIDATION_FEE_PRECISION / 1000,
            deposit_balance: 1000 * SPOT_BALANCE_PRECISION,
            ..SpotMarket::default()
        }
    }

    fn sol_perp_market() -> PerpMarket {
        PerpMarket {
            amm: AMM {
                base_asset_reserve: 100 * AMM_RESERVE_PRECISION,
                quote_asset_reserve: 100 * AMM_RESERVE_PRECISION,
                bid_base_asset_reserve: 101 * AMM_RESERVE_PRECISION,
                bid_quote_asset_reserve: 99 * AMM_RESERVE_PRECISION,
                ask_base_asset_reserve: 99 * AMM_RESERVE_PRECISION,
                ask_quote_asset_reserve: 101 * AMM_RESERVE_PRECISION,
                sqrt_k: 100 * AMM_RESERVE_PRECISION,
                peg_multiplier: 100 * PEG_PRECISION,
                order_step_size: 10000000,
                oracle: SOL_ORACLE,
                ..AMM::default()
            },
            market_index: 0,
            margin_ratio_initial: 1000,
            margin_ratio_maintenance: 500,
            status: MarketStatus::Initialized,
            ..PerpMarket::default()
        }
    }

    fn btc_perp_market() -> PerpMarket {
        PerpMarket {
            amm: AMM {
                base_asset_reserve: 100 * AMM_RESERVE_PRECISION,
                quote_asset_reserve: 100 * AMM_RESERVE_PRECISION,
                bid_base_asset_reserve: 101 * AMM_RESERVE_PRECISION,
                bid_quote_asset_reserve: 99 * AMM_RESERVE_PRECISION,
                ask_base_asset_reserve: 99 * AMM_RESERVE_PRECISION,
                ask_quote_asset_reserve: 101 * AMM_RESERVE_PRECISION,
                sqrt_k: 100 * AMM_RESERVE_PRECISION,
                oracle: BTC_ORACLE,
                ..AMM::default()
            },
            market_index: 1,
            margin_ratio_initial: 1000,
            margin_ratio_maintenance: 500,
            imf_factor: 1000, // 1_000/1_000_000 = .001
            unrealized_pnl_initial_asset_weight: 10000,
            unrealized_pnl_maintenance_asset_weight: 10000,
            status: MarketStatus::Initialized,
            ..PerpMarket::default()
        }
    }

    fn usdc_spot_market() -> SpotMarket {
        SpotMarket {
            market_index: 0,
            oracle_source: OracleSource::QuoteAsset,
            cumulative_deposit_interest: SPOT_CUMULATIVE_INTEREST_PRECISION,
            decimals: 6,
            initial_asset_weight: SPOT_WEIGHT_PRECISION,
            maintenance_asset_weight: SPOT_WEIGHT_PRECISION,
            deposit_balance: 100_000 * SPOT_BALANCE_PRECISION,
            liquidator_fee: 0,
            historical_oracle_data: HistoricalOracleData::default_quote_oracle(),
            ..SpotMarket::default()
        }
    }

    #[ignore]
    #[tokio::test]
    async fn calculate_liq_price() {
        let wallet = Wallet::read_only(
            Pubkey::from_str("DxoRJ4f5XRMvXU9SGuM4ZziBFUxbhB3ubur5sVZEvue2").unwrap(),
        );
        let client = DriftClient::new(
            crate::Context::MainNet,
            RpcAccountProvider::new("https://api.devnet.solana.com"),
            Keypair::new().into(),
        )
        .await
        .unwrap();
        let user = client
            .get_user_account(&wallet.default_sub_account())
            .await
            .unwrap();
        dbg!(calculate_liquidation_price(&client, &user, 0)
            .await
            .unwrap());
    }

    #[test]
    fn liquidation_price_short() {
        let sol_perp_index = 0;
        let mut user = User::default();
        user.perp_positions[0] = PerpPosition {
            market_index: sol_perp_index,
            base_asset_amount: -2 * BASE_PRECISION_I64,
            ..Default::default()
        };
        user.spot_positions[0] = SpotPosition {
            market_index: MarketId::QUOTE_SPOT.index,
            scaled_balance: 250_u64 * SPOT_BALANCE_PRECISION_U64,
            ..Default::default()
        };

        let mut sol_oracle_price = get_pyth_price(100, 6);
        crate::create_account_info!(sol_oracle_price, &SOL_ORACLE, &pyth::ID, sol_oracle);
        crate::create_anchor_account_info!(
            usdc_spot_market(),
            &constants::PROGRAM_ID,
            SpotMarket,
            usdc_spot
        );
        crate::create_anchor_account_info!(
            sol_perp_market(),
            &constants::PROGRAM_ID,
            PerpMarket,
            sol_perp
        );
        let accounts_map = build_account_map(&mut [sol_perp], &mut [usdc_spot], &mut [sol_oracle]);

        let liquidation_price =
            calculate_liquidation_price_inner(&user, sol_perp_index, accounts_map).unwrap();
        dbg!(liquidation_price);
        assert_eq!(liquidation_price, 119_047_619);
    }

    #[test]
    fn liquidation_price_long() {
        let sol_perp_index = 0;
        let mut user = User::default();
        user.perp_positions[0] = PerpPosition {
            market_index: sol_perp_index,
            base_asset_amount: 5 * BASE_PRECISION_I64,
            ..Default::default()
        };
        user.spot_positions[0] = SpotPosition {
            market_index: MarketId::QUOTE_SPOT.index,
            scaled_balance: 250_u64 * SPOT_BALANCE_PRECISION_U64,
            ..Default::default()
        };
        let mut sol_oracle_price = get_pyth_price(100, 6);
        crate::create_account_info!(sol_oracle_price, &SOL_ORACLE, &pyth::ID, sol_oracle);
        crate::create_anchor_account_info!(
            usdc_spot_market(),
            &constants::PROGRAM_ID,
            SpotMarket,
            usdc_spot
        );
        crate::create_anchor_account_info!(
            sol_perp_market(),
            &constants::PROGRAM_ID,
            PerpMarket,
            sol_perp
        );
        let accounts_map = build_account_map(&mut [sol_perp], &mut [usdc_spot], &mut [sol_oracle]);
        let liquidation_price =
            calculate_liquidation_price_inner(&user, sol_perp_index, accounts_map).unwrap();
        dbg!(liquidation_price);
        assert_eq!(liquidation_price, 52_631_579);
    }

    #[test]
    fn liquidation_price_short_with_spot_balance() {
        let btc_perp_index = 1;
        let mut user = User::default();
        user.perp_positions[0] = PerpPosition {
            market_index: btc_perp_index,
            base_asset_amount: -250_000_000, // 0.25btc
            ..Default::default()
        };
        user.spot_positions[0] = SpotPosition {
            market_index: 1,
            scaled_balance: 200 * SPOT_BALANCE_PRECISION_U64,
            ..Default::default()
        };
        let mut sol_oracle_price = get_pyth_price(100, 6);
        crate::create_account_info!(sol_oracle_price, &SOL_ORACLE, &pyth::ID, sol_oracle);
        let mut btc_oracle_price = get_pyth_price(40_000, 6);
        crate::create_account_info!(btc_oracle_price, &BTC_ORACLE, &pyth::ID, btc_oracle);
        crate::create_anchor_account_info!(
            usdc_spot_market(),
            &constants::PROGRAM_ID,
            SpotMarket,
            usdc_spot
        );
        crate::create_anchor_account_info!(
            sol_spot_market(),
            &constants::PROGRAM_ID,
            SpotMarket,
            sol_spot
        );
        crate::create_anchor_account_info!(
            btc_perp_market(),
            &constants::PROGRAM_ID,
            PerpMarket,
            btc_perp
        );
        let accounts_map = build_account_map(
            &mut [btc_perp],
            &mut [usdc_spot, sol_spot],
            &mut [sol_oracle, btc_oracle],
        );
        let liquidation_price =
            calculate_liquidation_price_inner(&user, btc_perp_index, accounts_map).unwrap();
        assert_eq!(liquidation_price, 68_571_428_571);
    }

    #[test]
    fn liquidation_price_long_with_spot_balance() {
        let sol_perp_index = 0;
        let mut user = User::default();
        user.perp_positions[0] = PerpPosition {
            market_index: sol_perp_index,
            base_asset_amount: 5 * BASE_PRECISION_I64,
            ..Default::default()
        };
        user.spot_positions[0] = SpotPosition {
            market_index: 1,
            scaled_balance: 2 * SPOT_BALANCE_PRECISION_U64,
            ..Default::default()
        };
        let mut sol_oracle_price = get_pyth_price(100, 6);
        crate::create_account_info!(sol_oracle_price, &SOL_ORACLE, &pyth::ID, sol_oracle);
        crate::create_anchor_account_info!(
            usdc_spot_market(),
            &constants::PROGRAM_ID,
            SpotMarket,
            usdc_spot
        );
        crate::create_anchor_account_info!(
            sol_spot_market(),
            &constants::PROGRAM_ID,
            SpotMarket,
            sol_spot
        );
        crate::create_anchor_account_info!(
            sol_perp_market(),
            &constants::PROGRAM_ID,
            PerpMarket,
            sol_perp
        );
        let accounts_map = build_account_map(
            &mut [sol_perp],
            &mut [usdc_spot, sol_spot],
            &mut [sol_oracle],
        );
        let liquidation_price =
            calculate_liquidation_price_inner(&user, sol_perp_index, accounts_map).unwrap();
        dbg!(liquidation_price);
        assert_eq!(liquidation_price, 76_335_878);
    }

    #[test]
    fn liquidation_price_no_positions() {
        let user = User::default();
        let accounts_map = build_account_map(&mut [], &mut [], &mut []);
        assert!(calculate_liquidation_price_inner(&user, 0, accounts_map).is_err());
    }

    fn build_account_map<'a>(
        perp: &mut [AccountInfo<'a>],
        spot: &mut [AccountInfo<'a>],
        oracle: &mut [AccountInfo<'a>],
    ) -> AccountMaps<'a> {
        AccountMaps {
            perp_market_map: PerpMarketMap::load(
                &MarketSet::default(),
                &mut perp.iter().peekable(),
            )
            .unwrap(),
            spot_market_map: SpotMarketMap::load(
                &MarketSet::default(),
                &mut spot.iter().peekable(),
            )
            .unwrap(),
            oracle_map: OracleMap::load(&mut oracle.iter().peekable(), 0, None).unwrap(),
        }
    }

    // helpers from drift-program test_utils.
    // TODO: re-export from there
    fn get_pyth_price(price: i64, expo: i32) -> Price {
        let mut pyth_price = Price::default();
        let price = price * 10_i64.pow(expo as u32);
        pyth_price.agg.price = price;
        pyth_price.twap = price;
        pyth_price.expo = expo;
        pyth_price
    }

    pub fn get_account_bytes<T: bytemuck::Pod>(account: &mut T) -> BytesMut {
        let mut bytes = BytesMut::new();
        let data = bytemuck::bytes_of_mut(account);
        bytes.extend_from_slice(data);
        bytes
    }

    pub fn get_anchor_account_bytes<T: ZeroCopy + Owner>(account: &mut T) -> BytesMut {
        let mut bytes = BytesMut::new();
        bytes.extend_from_slice(&T::discriminator());
        let data = bytemuck::bytes_of_mut(account);
        bytes.extend_from_slice(data);
        bytes
    }

    #[macro_export]
    macro_rules! create_account_info {
        ($account:expr, $owner:expr, $name: ident) => {
            let key = Pubkey::default();
            let mut lamports = 0;
            let mut data = get_account_bytes(&mut $account);
            let owner = $type::owner();
            let $name = AccountInfo::new(
                &key,
                true,
                false,
                &mut lamports,
                &mut data[..],
                $owner,
                false,
                0,
            );
        };
        ($account:expr, $pubkey:expr, $owner:expr, $name: ident) => {
            let mut lamports = 0;
            let mut data = get_account_bytes(&mut $account);
            let $name = AccountInfo::new(
                $pubkey,
                true,
                false,
                &mut lamports,
                &mut data[..],
                $owner,
                false,
                0,
            );
        };
    }

    #[macro_export]
    macro_rules! create_anchor_account_info {
        ($account:expr, $type:ident, $name: ident) => {
            let key = Pubkey::default();
            let mut lamports = 0;
            let mut data = get_anchor_account_bytes(&mut $account);
            let owner = $type::owner();
            let $name = AccountInfo::new(
                &key,
                true,
                false,
                &mut lamports,
                &mut data[..],
                &owner,
                false,
                0,
            );
        };
        ($account:expr, $pubkey:expr, $type:ident, $name: ident) => {
            let mut lamports = 0;
            let mut data = get_anchor_account_bytes(&mut $account);
            let owner = $type::owner();
            let $name = AccountInfo::new(
                $pubkey,
                true,
                false,
                &mut lamports,
                &mut data[..],
                &owner,
                false,
                0,
            );
        };
    }
}
