use solana_pubkey::Pubkey;

use drift::{
    sdk::calculate_margin,
    state::margin_calculation::{MarginCalculation, MarginContext},
};

use super::{
    account_list_builder::AccountsListBuilder,
    constants::{AMM_RESERVE_PRECISION, BASE_PRECISION, MARGIN_PRECISION, PRICE_PRECISION},
};
use crate::{
    accounts::PerpMarket, types::accounts::User, ContractType, DriftClient, MarginRequirementType,
    MarketId, PositionDirection, SdkError, SdkResult,
};

pub fn get_leverage(client: &DriftClient, user: &User) -> SdkResult<u128> {
    let mut builder = AccountsListBuilder::default();
    let accounts = builder.try_build(client, user, &[])?;
    let margin_calculation = calculate_margin(
        user,
        accounts,
        MarginContext::standard(MarginRequirementType::Maintenance),
    )
    .map_err(|e| SdkError::Anchor(Box::new(e.into())))?;

    let net_asset_value = calculate_net_asset_value(
        margin_calculation.total_collateral,
        margin_calculation.total_spot_liability_value,
    );

    if net_asset_value == i128::MIN {
        return Err(SdkError::MathError(
            "Net asset value is less than i128::MIN",
        ));
    }

    let total_liability_value = margin_calculation
        .total_perp_liability_value
        .checked_add(margin_calculation.total_spot_liability_value)
        .expect("fits u128");

    let leverage = calculate_leverage(total_liability_value, net_asset_value);

    Ok(leverage)
}

pub fn get_spot_asset_value(client: &DriftClient, user: &User) -> SdkResult<i128> {
    let mut builder = AccountsListBuilder::default();
    let accounts = builder.try_build(client, user, &[])?;

    let margin_calculation = calculate_margin(
        user,
        accounts,
        MarginContext::standard(MarginRequirementType::Maintenance),
    )
    .map_err(|e| SdkError::Anchor(Box::new(e.into())))?;

    Ok(margin_calculation.total_spot_asset_value
        - margin_calculation.total_spot_liability_value as i128)
}

fn calculate_net_asset_value(total_collateral: i128, total_spot_liability_value: u128) -> i128 {
    if total_spot_liability_value <= i128::MAX as u128 {
        total_collateral - total_spot_liability_value as i128
    } else {
        let overflow = total_spot_liability_value - i128::MAX as u128;
        if overflow <= total_collateral as u128 + 1 {
            total_collateral - (i128::MAX as u128 - (overflow - 1)) as i128
        } else {
            i128::MIN
        }
    }
}

fn calculate_leverage(total_liability_value: u128, net_asset_value: i128) -> u128 {
    let sign: i128 = if net_asset_value < 0 { -1 } else { 1 };

    let leverage = (total_liability_value as f64) / (net_asset_value.abs() as f64);

    sign as u128 * (leverage * PRICE_PRECISION as f64) as u128
}

/// Provides margin calculation helpers for User accounts
///
/// sync, requires client is subscribed to necessary markets beforehand
pub trait UserMargin {
    /// Calculate user's max. trade size in USDC for a given market and direction
    ///
    /// * `user` - the user account
    /// * `market` - the market to trade
    /// * `trade_side` - the direction of the trade
    ///
    /// Returns max USDC trade size (PRICE_PRECISION)
    fn max_trade_size(
        &self,
        user: &Pubkey,
        market: MarketId,
        trade_side: PositionDirection,
    ) -> SdkResult<u64>;
    fn calculate_perp_buying_power(
        &self,
        user: &User,
        market: &PerpMarket,
        oracle_price: i64,
        collateral_buffer: u64,
    ) -> SdkResult<u128>;
    /// Calculate the user's live margin information
    fn calculate_margin_info(&self, user: &User) -> SdkResult<MarginCalculation>;
}

impl UserMargin for DriftClient {
    fn calculate_margin_info(&self, user: &User) -> SdkResult<MarginCalculation> {
        let mut builder = AccountsListBuilder::default();
        let accounts = builder.try_build(self, user, &[])?;
        calculate_margin(
            user,
            accounts,
            MarginContext::standard(MarginRequirementType::Maintenance),
        )
        .map_err(|e| SdkError::Anchor(Box::new(e.into())))
    }
    fn max_trade_size(
        &self,
        user: &Pubkey,
        market: MarketId,
        trade_side: PositionDirection,
    ) -> SdkResult<u64> {
        let oracle = self
            .try_get_oracle_price_data_and_slot(market)
            .ok_or(SdkError::NoMarketData(market))?;
        let oracle_price = oracle.data.price;
        let user_account = self.try_get_account::<User>(user)?;

        if market.is_perp() {
            let market_account = self.try_get_perp_market_account(market.index())?;

            let position = user_account
                .get_perp_position(market_account.market_index)
                .map_err(|_| SdkError::NoMarketData(MarketId::perp(market_account.market_index)))?;
            // add any position we have on the opposite side of the current trade
            // because we can "flip" the size of this position without taking any extra leverage.
            let is_reduce_only = position.base_asset_amount.is_negative() as u8 != trade_side as u8;
            let opposite_side_liability_value = calculate_perp_liability_value(
                position.base_asset_amount,
                oracle_price,
                market_account.contract_type == ContractType::DeprecatedPrediction,
            );

            // LP shares removed upstream; preserve previous behavior for non-LP positions (lp_shares=0 → multiplier=1).
            let lp_buffer = (oracle_price as u64 * market_account.order_step_size)
                / AMM_RESERVE_PRECISION as u64;

            let max_position_size = self.calculate_perp_buying_power(
                &user_account,
                &market_account,
                oracle_price,
                lp_buffer,
            )?;

            Ok(max_position_size as u64 + opposite_side_liability_value * is_reduce_only as u64)
        } else {
            // TODO: implement for spot
            Err(SdkError::Generic("spot market unimplemented".to_string()))
        }
    }
    /// Calculate buying power = free collateral / initial margin ratio
    ///
    /// Returns buying power in `QUOTE_PRECISION` units
    fn calculate_perp_buying_power(
        &self,
        user: &User,
        market: &PerpMarket,
        oracle_price: i64,
        collateral_buffer: u64,
    ) -> SdkResult<u128> {
        let position = user
            .get_perp_position(market.market_index)
            .map_err(|_| SdkError::NoMarketData(MarketId::perp(market.market_index)))?;

        let worst_case_base_amount = position
            .worst_case_base_asset_amount(oracle_price)
            .map_err(|e| SdkError::Anchor(Box::new(e.into())))?;

        let margin_info = self.calculate_margin_info(user)?;
        let free_collateral = margin_info
            .get_cross_free_collateral()
            .map_err(|e| SdkError::Anchor(Box::new(e.into())))?
            .checked_sub(collateral_buffer as u128)
            .ok_or(SdkError::MathError("underflow"))?;

        let margin_ratio = market
            .get_margin_ratio(
                worst_case_base_amount.unsigned_abs(),
                MarginRequirementType::Initial,
            )
            .expect("got margin ratio");
        let margin_ratio = margin_ratio.max(user.max_margin_ratio);

        Ok((free_collateral * MARGIN_PRECISION as u128) / margin_ratio as u128)
    }
}

#[inline]
pub fn calculate_perp_liability_value(
    base_asset_amount: i64,
    price: i64,
    is_prediction_market: bool,
) -> u64 {
    let max_prediction_price = PRICE_PRECISION as i64;
    let max_price =
        max_prediction_price * base_asset_amount.is_negative() as i64 * is_prediction_market as i64;
    (base_asset_amount * (max_price - price) / BASE_PRECISION as i64).unsigned_abs()
}

#[cfg(test)]
mod tests {
    use super::calculate_perp_liability_value;

    #[test]
    fn calculate_perp_liability_value_works() {
        use crate::math::constants::{BASE_PRECISION_I64, PRICE_PRECISION_I64};
        // test values taken from TS sdk
        assert_eq!(
            calculate_perp_liability_value(1 * BASE_PRECISION_I64, 5 * PRICE_PRECISION_I64, false),
            5_000_000
        );
        assert_eq!(
            calculate_perp_liability_value(-1 * BASE_PRECISION_I64, 5 * PRICE_PRECISION_I64, false),
            5_000_000
        );
        assert_eq!(
            calculate_perp_liability_value(-1 * BASE_PRECISION_I64, 10_000, true),
            990_000
        );
        assert_eq!(
            calculate_perp_liability_value(1 * BASE_PRECISION_I64, 90_000, true),
            90_000
        );
    }
}

#[cfg(feature = "rpc_tests")]
mod rpc_tests {
    use crate::solana_sdk::signature::Keypair;

    use super::*;
    use crate::{
        utils::test_envs::{mainnet_endpoint, test_keypair},
        Context, RpcAccountProvider, Wallet,
    };

    #[tokio::test]
    async fn test_get_spot_market_value() {
        let wallet: Wallet = test_keypair().into();
        let pubkey = wallet.authority().clone();
        let drift_client = DriftClient::new(
            Context::MainNet,
            RpcAccountProvider::new(&mainnet_endpoint()),
            wallet,
        )
        .await
        .expect("drift client");
        drift_client.subscribe().await.expect("subscribe");

        tokio::time::sleep(tokio::time::Duration::from_secs(5)).await;

        let mut user = crate::user::DriftUser::new(
            Wallet::derive_user_account(&pubkey, 0, &constants::PROGRAM_ID),
            drift_client.clone(),
        )
        .await
        .expect("drift user");
        user.subscribe().await.expect("subscribe");

        let spot_asset_value = get_spot_asset_value(&drift_client, &user.get_user_account())
            .expect("spot asset value");
        println!("spot_asset_value: {}", spot_asset_value);
    }

    #[tokio::test]
    async fn test_leverage() {
        let wallet: Wallet = test_keypair().into();
        let pubkey = wallet.authority().clone();
        let drift_client = DriftClient::new(
            Context::MainNet,
            RpcAccountProvider::new & (mainnet_endpoint()),
            wallet,
        )
        .await
        .expect("drift client");
        drift_client.subscribe().await.expect("subscribe");

        tokio::time::sleep(tokio::time::Duration::from_secs(5)).await;

        let mut user = crate::user::DriftUser::new(
            Wallet::derive_user_account(&pubkey, 0, &constants::PROGRAM_ID),
            drift_client.clone(),
        )
        .await
        .expect("drift user");
        user.subscribe().await.expect("subscribe");

        let leverage = get_leverage(&drift_client, &user.get_user_account()).expect("leverage");
        println!("leverage: {}", leverage);
    }
}
