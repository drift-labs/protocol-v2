use solana_program::msg;

use crate::controller::spot_position::update_spot_position_balance;
use crate::error::{ClearingHouseResult, ErrorCode};
use crate::math::casting::{cast, cast_to_i128, cast_to_u64};
use crate::math::constants::{IF_FACTOR_PRECISION, ONE_HOUR, TWENTY_FOUR_HOUR};
use crate::math::spot_balance::{
    calculate_accumulated_interest, calculate_utilization, check_withdraw_limits,
    get_interest_token_amount, get_spot_balance, get_token_amount, InterestAccumulated,
};
use crate::math::stats::{calculate_new_twap, calculate_weighted_average};
use crate::math_error;
use crate::state::market::PerpMarket;
use crate::state::oracle::OraclePriceData;
use crate::state::spot_market::{SpotBalance, SpotBalanceType, SpotMarket};
use crate::state::user::SpotPosition;
use crate::validate;
use std::cmp::max;

pub fn update_spot_market_twap_stats(
    spot_market: &mut SpotMarket,
    oracle_price_data: Option<&OraclePriceData>,
    now: i64,
) -> ClearingHouseResult {
    let since_last = cast_to_i128(max(
        1,
        now.checked_sub(spot_market.last_twap_ts as i64)
            .ok_or_else(math_error!())?,
    ))?;
    let from_start = max(
        1,
        cast_to_i128(TWENTY_FOUR_HOUR)?
            .checked_sub(since_last)
            .ok_or_else(math_error!())?,
    );

    let deposit_token_amount = get_token_amount(
        spot_market.deposit_balance,
        spot_market,
        &SpotBalanceType::Deposit,
    )?;
    let borrow_token_amount = get_token_amount(
        spot_market.borrow_balance,
        spot_market,
        &SpotBalanceType::Borrow,
    )?;

    spot_market.deposit_token_twap = cast(calculate_weighted_average(
        cast(deposit_token_amount)?,
        cast(spot_market.deposit_token_twap)?,
        since_last,
        from_start,
    )?)?;

    spot_market.borrow_token_twap = cast(calculate_weighted_average(
        cast(borrow_token_amount)?,
        cast(spot_market.borrow_token_twap)?,
        since_last,
        from_start,
    )?)?;

    let utilization = calculate_utilization(deposit_token_amount, borrow_token_amount)?;

    spot_market.utilization_twap = cast(calculate_weighted_average(
        cast(utilization)?,
        cast(spot_market.utilization_twap)?,
        since_last,
        from_start,
    )?)?;

    if let Some(oracle_price_data) = oracle_price_data {
        let capped_oracle_update_price = oracle_price_data.price;

        let oracle_price_twap = calculate_new_twap(
            capped_oracle_update_price,
            now,
            spot_market.historical_oracle_data.last_oracle_price_twap,
            spot_market.historical_oracle_data.last_oracle_price_twap_ts,
            ONE_HOUR as i64,
        )?;

        let oracle_price_twap_5min = calculate_new_twap(
            capped_oracle_update_price,
            now,
            spot_market
                .historical_oracle_data
                .last_oracle_price_twap_5min,
            spot_market.historical_oracle_data.last_oracle_price_twap_ts,
            (60 * 5) as i64,
        )?;

        spot_market.historical_oracle_data.last_oracle_price_twap = oracle_price_twap;
        spot_market
            .historical_oracle_data
            .last_oracle_price_twap_5min = oracle_price_twap_5min;

        spot_market.historical_oracle_data.last_oracle_price = oracle_price_data.price;
        spot_market.historical_oracle_data.last_oracle_conf = oracle_price_data.confidence;
        spot_market.historical_oracle_data.last_oracle_delay = oracle_price_data.delay;
        spot_market.historical_oracle_data.last_oracle_price_twap_ts = now;
    }

    spot_market.last_twap_ts = cast_to_u64(now)?;

    Ok(())
}

pub fn update_spot_market_cumulative_interest(
    spot_market: &mut SpotMarket,
    oracle_price_data: Option<&OraclePriceData>,
    now: i64,
) -> ClearingHouseResult {
    let InterestAccumulated {
        deposit_interest,
        borrow_interest,
    } = calculate_accumulated_interest(spot_market, now)?;

    if deposit_interest > 0 && borrow_interest > 1 {
        // borrowers -> lenders IF fee here
        let deposit_interest_for_stakers = deposit_interest
            .checked_mul(spot_market.total_if_factor as u128)
            .ok_or_else(math_error!())?
            .checked_div(IF_FACTOR_PRECISION)
            .ok_or_else(math_error!())?;

        let deposit_interest_for_lenders = deposit_interest
            .checked_sub(deposit_interest_for_stakers)
            .ok_or_else(math_error!())?;

        if deposit_interest_for_lenders > 0 {
            spot_market.cumulative_deposit_interest = spot_market
                .cumulative_deposit_interest
                .checked_add(deposit_interest_for_lenders)
                .ok_or_else(math_error!())?;

            spot_market.cumulative_borrow_interest = spot_market
                .cumulative_borrow_interest
                .checked_add(borrow_interest)
                .ok_or_else(math_error!())?;
            spot_market.last_interest_ts = cast_to_u64(now)?;

            // add deposit_interest_for_stakers as balance for revenue_pool
            let token_amount = get_interest_token_amount(
                spot_market.deposit_balance,
                spot_market,
                deposit_interest_for_stakers,
            )?;

            update_revenue_pool_balances(token_amount, &SpotBalanceType::Deposit, spot_market)?;
        }
    }

    update_spot_market_twap_stats(spot_market, oracle_price_data, now)?;

    Ok(())
}

pub fn update_revenue_pool_balances(
    token_amount: u128,
    update_direction: &SpotBalanceType,
    spot_market: &mut SpotMarket,
) -> ClearingHouseResult {
    let mut spot_balance = spot_market.revenue_pool;
    update_spot_balances(
        token_amount,
        update_direction,
        spot_market,
        &mut spot_balance,
        false,
    )?;
    spot_market.revenue_pool = spot_balance;

    Ok(())
}

pub fn update_spot_balances(
    mut token_amount: u128,
    update_direction: &SpotBalanceType,
    spot_market: &mut SpotMarket,
    spot_balance: &mut dyn SpotBalance,
    force_round_up: bool,
) -> ClearingHouseResult {
    let increase_user_existing_balance = update_direction == spot_balance.balance_type();
    if increase_user_existing_balance {
        let round_up = spot_balance.balance_type() == &SpotBalanceType::Borrow;
        let balance_delta =
            get_spot_balance(token_amount, spot_market, update_direction, round_up)?;
        spot_balance.increase_balance(balance_delta)?;
        increase_spot_balance(balance_delta, spot_market, update_direction)?;
    } else {
        let current_token_amount = get_token_amount(
            spot_balance.balance(),
            spot_market,
            spot_balance.balance_type(),
        )?;

        let reduce_user_existing_balance = current_token_amount != 0;
        if reduce_user_existing_balance {
            // determine how much to reduce balance based on size of current token amount
            let (token_delta, balance_delta) = if current_token_amount > token_amount {
                let round_up =
                    force_round_up || spot_balance.balance_type() == &SpotBalanceType::Borrow;
                let balance_delta = get_spot_balance(
                    token_amount,
                    spot_market,
                    spot_balance.balance_type(),
                    round_up,
                )?;
                (token_amount, balance_delta)
            } else {
                (current_token_amount, spot_balance.balance())
            };

            decrease_spot_balance(balance_delta, spot_market, spot_balance.balance_type())?;
            spot_balance.decrease_balance(balance_delta)?;
            token_amount = token_amount
                .checked_sub(token_delta)
                .ok_or_else(math_error!())?;
        }

        if token_amount > 0 {
            spot_balance.update_balance_type(*update_direction)?;
            let round_up = update_direction == &SpotBalanceType::Borrow;
            let balance_delta =
                get_spot_balance(token_amount, spot_market, update_direction, round_up)?;
            spot_balance.increase_balance(balance_delta)?;
            increase_spot_balance(balance_delta, spot_market, update_direction)?;
        }
    }

    if let SpotBalanceType::Borrow = update_direction {
        let deposit_token_amount = get_token_amount(
            spot_market.deposit_balance,
            spot_market,
            &SpotBalanceType::Deposit,
        )?;

        let borrow_token_amount = get_token_amount(
            spot_market.borrow_balance,
            spot_market,
            &SpotBalanceType::Borrow,
        )?;

        validate!(
            deposit_token_amount >= borrow_token_amount,
            ErrorCode::SpotMarketInsufficientDeposits,
            "Spot Market has insufficent deposits to complete withdraw: deposits ({}) borrows ({})",
            deposit_token_amount,
            borrow_token_amount
        )?;
    }

    Ok(())
}

pub fn update_spot_position_balance_with_limits(
    token_amount: u128,
    update_direction: &SpotBalanceType,
    spot_market: &mut SpotMarket,
    spot_position: &mut SpotPosition,
) -> ClearingHouseResult {
    update_spot_position_balance(
        token_amount,
        update_direction,
        spot_market,
        spot_position,
        true,
    )?;

    let valid_withdraw = check_withdraw_limits(spot_market)?;

    validate!(
        valid_withdraw,
        ErrorCode::DailyWithdrawLimit,
        "Spot Market has hit daily withdraw limit"
    )?;

    Ok(())
}

pub fn check_perp_market_valid(
    perp_market: &PerpMarket,
    spot_market: &SpotMarket,
    spot_balance: &mut dyn SpotBalance,
    current_slot: u64,
) -> ClearingHouseResult {
    // todo

    if perp_market.amm.oracle == spot_market.oracle
        && spot_balance.balance_type() == &SpotBalanceType::Borrow
        && (perp_market.amm.last_update_slot != current_slot || !perp_market.amm.last_oracle_valid)
    {
        return Err(ErrorCode::InvalidOracle);
    }

    Ok(())
}

fn increase_spot_balance(
    delta: u128,
    spot_market: &mut SpotMarket,
    balance_type: &SpotBalanceType,
) -> ClearingHouseResult {
    match balance_type {
        SpotBalanceType::Deposit => {
            spot_market.deposit_balance = spot_market
                .deposit_balance
                .checked_add(delta)
                .ok_or_else(math_error!())?
        }
        SpotBalanceType::Borrow => {
            spot_market.borrow_balance = spot_market
                .borrow_balance
                .checked_add(delta)
                .ok_or_else(math_error!())?
        }
    }

    Ok(())
}

fn decrease_spot_balance(
    delta: u128,
    spot_market: &mut SpotMarket,
    balance_type: &SpotBalanceType,
) -> ClearingHouseResult {
    match balance_type {
        SpotBalanceType::Deposit => {
            spot_market.deposit_balance = spot_market
                .deposit_balance
                .checked_sub(delta)
                .ok_or_else(math_error!())?
        }
        SpotBalanceType::Borrow => {
            spot_market.borrow_balance = spot_market
                .borrow_balance
                .checked_sub(delta)
                .ok_or_else(math_error!())?
        }
    }

    Ok(())
}

#[cfg(test)]
mod test {
    use super::*;
    use crate::controller::insurance::settle_revenue_to_insurance_fund;
    use crate::create_account_info;
    use crate::create_anchor_account_info;
    use crate::math::constants::{
        AMM_RESERVE_PRECISION, BASE_PRECISION_I128, LIQUIDATION_FEE_PRECISION, PEG_PRECISION,
        QUOTE_PRECISION, QUOTE_PRECISION_I128, SPOT_BALANCE_PRECISION, SPOT_BALANCE_PRECISION_U64,
        SPOT_CUMULATIVE_INTEREST_PRECISION, SPOT_RATE_PRECISION, SPOT_UTILIZATION_PRECISION,
        SPOT_WEIGHT_PRECISION,
    };
    use crate::state::market::{MarketStatus, PerpMarket, AMM};
    use crate::state::oracle::{HistoricalOracleData, OracleSource};
    use crate::state::oracle_map::OracleMap;
    use crate::state::perp_market_map::PerpMarketMap;
    use crate::state::spot_market::{SpotBalanceType, SpotMarket};
    use crate::state::spot_market_map::SpotMarketMap;
    use crate::state::user::{Order, PerpPosition, SpotPosition, User};
    use crate::tests::utils::get_pyth_price;
    use crate::tests::utils::*;
    use anchor_lang::Owner;
    use solana_program::pubkey::Pubkey;
    use std::str::FromStr;

    #[test]
    fn check_withdraw_limits() {
        let now = 0_i64;
        let slot = 0_u64;

        let mut oracle_price = get_pyth_price(100, 6);
        let oracle_price_key =
            Pubkey::from_str("J83w4HKfqxwcq3BEMMkPFSppX3gqekLyLJBexebFVkix").unwrap();
        let pyth_program = crate::ids::pyth_program::id();
        create_account_info!(
            oracle_price,
            &oracle_price_key,
            &pyth_program,
            oracle_account_info
        );
        let _oracle_map = OracleMap::load_one(&oracle_account_info, slot, None).unwrap();

        let mut market = PerpMarket {
            amm: AMM {
                base_asset_reserve: 100 * AMM_RESERVE_PRECISION,
                quote_asset_reserve: 100 * AMM_RESERVE_PRECISION,
                bid_base_asset_reserve: 101 * AMM_RESERVE_PRECISION,
                bid_quote_asset_reserve: 99 * AMM_RESERVE_PRECISION,
                ask_base_asset_reserve: 99 * AMM_RESERVE_PRECISION,
                ask_quote_asset_reserve: 101 * AMM_RESERVE_PRECISION,
                sqrt_k: 100 * AMM_RESERVE_PRECISION,
                peg_multiplier: 100 * PEG_PRECISION,
                max_slippage_ratio: 50,
                max_base_asset_amount_ratio: 100,
                base_asset_amount_step_size: 10000000,
                quote_asset_amount_short: 50 * QUOTE_PRECISION_I128,
                net_base_asset_amount: BASE_PRECISION_I128,
                oracle: oracle_price_key,
                historical_oracle_data: HistoricalOracleData::default_price(
                    oracle_price.agg.price as i128,
                ),
                ..AMM::default()
            },
            margin_ratio_initial: 1000,
            margin_ratio_maintenance: 500,
            open_interest: 1,
            status: MarketStatus::Initialized,
            liquidator_fee: LIQUIDATION_FEE_PRECISION / 100,
            ..PerpMarket::default()
        };
        create_anchor_account_info!(market, PerpMarket, market_account_info);
        let _perp_market_map = PerpMarketMap::load_one(&market_account_info, true).unwrap();

        let mut spot_market = SpotMarket {
            market_index: 0,
            oracle_source: OracleSource::QuoteAsset,
            cumulative_deposit_interest: SPOT_CUMULATIVE_INTEREST_PRECISION,
            cumulative_borrow_interest: SPOT_CUMULATIVE_INTEREST_PRECISION,

            decimals: 6,
            initial_asset_weight: SPOT_WEIGHT_PRECISION,
            maintenance_asset_weight: SPOT_WEIGHT_PRECISION,
            deposit_balance: SPOT_BALANCE_PRECISION,
            borrow_balance: 0,
            deposit_token_twap: QUOTE_PRECISION / 2,
            ..SpotMarket::default()
        };
        create_anchor_account_info!(spot_market, SpotMarket, spot_market_account_info);
        let mut sol_spot_market = SpotMarket {
            market_index: 1,
            oracle_source: OracleSource::Pyth,
            oracle: oracle_price_key,
            cumulative_deposit_interest: SPOT_CUMULATIVE_INTEREST_PRECISION,
            cumulative_borrow_interest: SPOT_CUMULATIVE_INTEREST_PRECISION,
            decimals: 10,
            initial_asset_weight: 8 * SPOT_WEIGHT_PRECISION / 10,
            maintenance_asset_weight: 9 * SPOT_WEIGHT_PRECISION / 10,
            initial_liability_weight: 12 * SPOT_WEIGHT_PRECISION / 10,
            maintenance_liability_weight: 11 * SPOT_WEIGHT_PRECISION / 10,
            deposit_balance: SPOT_BALANCE_PRECISION,
            borrow_balance: SPOT_BALANCE_PRECISION,
            liquidator_fee: LIQUIDATION_FEE_PRECISION / 1000,
            ..SpotMarket::default()
        };
        create_anchor_account_info!(sol_spot_market, SpotMarket, sol_spot_market_account_info);
        let spot_market_account_infos =
            Vec::from([&spot_market_account_info, &sol_spot_market_account_info]);
        let _spot_market_map =
            SpotMarketMap::load_multiple(spot_market_account_infos, true).unwrap();

        let mut spot_positions = [SpotPosition::default(); 8];
        spot_positions[0] = SpotPosition {
            market_index: 0,
            balance_type: SpotBalanceType::Deposit,
            balance: SPOT_BALANCE_PRECISION_U64,
            ..SpotPosition::default()
        };
        let mut user = User {
            orders: [Order::default(); 32],
            perp_positions: [PerpPosition::default(); 8],
            spot_positions,
            ..User::default()
        };

        let amount: u64 = QUOTE_PRECISION as u64;

        assert_eq!(
            spot_market.cumulative_deposit_interest,
            SPOT_CUMULATIVE_INTEREST_PRECISION
        );
        assert_eq!(
            spot_market.cumulative_borrow_interest,
            SPOT_CUMULATIVE_INTEREST_PRECISION
        );

        // TEST USER WITHDRAW

        // fails
        let spot_market_backup = spot_market;
        let user_backup = user;
        assert!(update_spot_position_balance_with_limits(
            amount as u128,
            &SpotBalanceType::Borrow,
            &mut spot_market,
            &mut user.spot_positions[0],
        )
        .is_err());
        spot_market = spot_market_backup;
        user = user_backup;
        assert_eq!(spot_market.deposit_balance, SPOT_BALANCE_PRECISION);

        // .50 * .2 = .1
        assert_eq!(spot_market.deposit_token_twap, 500000);
        assert_eq!(user.spot_positions[0].balance, 1000000000);
        assert_eq!(spot_market.deposit_balance, 1000000000);
        assert_eq!(spot_market.borrow_balance, 0);
        assert_eq!((amount / 2), 500000);
        update_spot_position_balance_with_limits(
            (amount / 2) as u128,
            &SpotBalanceType::Borrow,
            &mut spot_market,
            &mut user.spot_positions[0],
        )
        .unwrap();
        assert_eq!(user.spot_positions[0].balance, 499999999);
        assert_eq!(spot_market.deposit_token_twap, 500000);
        assert_eq!(spot_market.deposit_balance, 499999999);
        assert_eq!(spot_market.borrow_balance, 0);

        // .50 * .2 = .1
        update_spot_position_balance_with_limits(
            ((amount / 10) - 2) as u128,
            &SpotBalanceType::Borrow,
            &mut spot_market,
            &mut user.spot_positions[0],
        )
        .unwrap();

        //fail
        let spot_market_backup = spot_market;
        let user_backup = user;
        assert!(update_spot_position_balance_with_limits(
            2_u128,
            &SpotBalanceType::Borrow,
            &mut spot_market,
            &mut user.spot_positions[0],
        )
        .is_err());
        spot_market = spot_market_backup;
        user = user_backup;
        assert_eq!(spot_market.deposit_balance, 400001998);
        assert_eq!(user.spot_positions[0].balance, 400001998);
        assert_eq!(user.spot_positions[0].market_index, 0);

        let old_twap = spot_market.deposit_token_twap;
        update_spot_market_cumulative_interest(&mut spot_market, None, now + 3600).unwrap();
        assert_eq!(spot_market.deposit_token_twap, 495834);
        update_spot_market_cumulative_interest(&mut spot_market, None, now + 3600 * 24).unwrap();
        assert_eq!(spot_market.deposit_token_twap, 403993); // little bit slower than 1 day
        update_spot_market_cumulative_interest(&mut spot_market, None, now + 3600 * 48 + 100)
            .unwrap();
        let new_twap = spot_market.deposit_token_twap;
        assert!(old_twap >= new_twap);
        assert_eq!(new_twap, 400001);

        // Borrowing blocks

        update_spot_position_balance_with_limits(
            QUOTE_PRECISION * 100000,
            &SpotBalanceType::Deposit,
            &mut spot_market,
            &mut user.spot_positions[0],
        )
        .unwrap();
        assert_eq!(spot_market.deposit_balance, 100000400001998);
        assert_eq!(user.spot_positions[0].balance, 100000400001998);
        assert_eq!(user.spot_positions[1].balance, 0);

        spot_market.last_interest_ts = now as u64;
        spot_market.last_twap_ts = now as u64;
        update_spot_market_cumulative_interest(&mut spot_market, None, now + 3600).unwrap();
        assert_eq!(spot_market.deposit_token_twap, 4167066666); //$4167.06
        update_spot_market_cumulative_interest(&mut spot_market, None, now + 3600 * 44).unwrap();
        assert_eq!(spot_market.deposit_token_twap, 99999780926); //$4167.06

        // tiny whale who will grow
        let mut whale = User {
            spot_positions: get_spot_positions(SpotPosition {
                market_index: 1,
                balance_type: SpotBalanceType::Deposit,
                balance: 50 * SPOT_BALANCE_PRECISION_U64,
                ..SpotPosition::default()
            }),
            ..User::default()
        };
        sol_spot_market.deposit_balance = 50 * SPOT_BALANCE_PRECISION;

        sol_spot_market.optimal_borrow_rate = SPOT_RATE_PRECISION / 5; //20% APR
        sol_spot_market.max_borrow_rate = SPOT_RATE_PRECISION; //100% APR

        update_spot_position_balance_with_limits(
            QUOTE_PRECISION * 50,
            &SpotBalanceType::Borrow,
            &mut spot_market,
            &mut whale.spot_positions[1],
        )
        .unwrap();

        assert_eq!(whale.spot_positions[0].market_index, 1);
        assert_eq!(whale.spot_positions[1].market_index, 0);
        assert_eq!(whale.spot_positions[1].balance, 50000000001);
        assert_eq!(
            whale.spot_positions[1].balance_type,
            SpotBalanceType::Borrow
        );
        assert_eq!(user.spot_positions[1].balance, 0);

        user.spot_positions[1].market_index = 1; // usually done elsewhere in instruction

        update_spot_position_balance_with_limits(
            100000 * 100000,
            &SpotBalanceType::Borrow,
            &mut sol_spot_market,
            &mut user.spot_positions[1],
        )
        .unwrap();
        assert_eq!(user.spot_positions[0].market_index, 0);

        assert_eq!(user.spot_positions[1].balance_type, SpotBalanceType::Borrow);
        assert_eq!(user.spot_positions[1].balance, 1000000001);

        assert_eq!(user.spot_positions[1].market_index, 1);

        assert_eq!(
            get_token_amount(
                user.spot_positions[1].balance as u128,
                &sol_spot_market,
                &SpotBalanceType::Borrow
            )
            .unwrap(),
            10000000010 //10 decimals
        );

        // 80% from 2% bad
        let spot_market_backup = sol_spot_market;
        let user_backup = user;
        assert!(update_spot_position_balance_with_limits(
            100000 * 100000 * 40,
            &SpotBalanceType::Borrow,
            &mut sol_spot_market,
            &mut user.spot_positions[1],
        )
        .is_err());
        sol_spot_market = spot_market_backup;
        user = user_backup;

        update_spot_position_balance_with_limits(
            100000 * 100000 * 6,
            &SpotBalanceType::Borrow,
            &mut sol_spot_market,
            &mut user.spot_positions[1],
        )
        .unwrap();

        assert_eq!(sol_spot_market.deposit_balance, 50000000000);
        assert_eq!(sol_spot_market.borrow_balance, 8000000002);
        assert_eq!(sol_spot_market.borrow_token_twap, 0);
        update_spot_market_cumulative_interest(&mut sol_spot_market, None, now + 3655 * 24)
            .unwrap();
        assert_eq!(sol_spot_market.deposit_token_twap, 500067287978);
        assert_eq!(sol_spot_market.borrow_token_twap, 80072075949);

        update_spot_position_balance_with_limits(
            100000 * 100000,
            &SpotBalanceType::Borrow,
            &mut sol_spot_market,
            &mut user.spot_positions[1],
        )
        .unwrap();

        // cant withdraw when market is invalid => delayed update
        market.amm.last_update_slot = 8008;
        assert!(check_perp_market_valid(
            &market,
            &sol_spot_market,
            &mut user.spot_positions[1],
            8009_u64
        )
        .is_err());

        // ok to withdraw when market is valid
        market.amm.last_update_slot = 8009;
        market.amm.last_oracle_valid = true;
        check_perp_market_valid(
            &market,
            &sol_spot_market,
            &mut user.spot_positions[1],
            8009_u64,
        )
        .unwrap();

        // ok to deposit when market is invalid
        update_spot_position_balance_with_limits(
            100000 * 100000 * 100,
            &SpotBalanceType::Deposit,
            &mut sol_spot_market,
            &mut user.spot_positions[1],
        )
        .unwrap();

        check_perp_market_valid(
            &market,
            &sol_spot_market,
            &mut user.spot_positions[1],
            100000_u64,
        )
        .unwrap();
    }
    #[test]
    fn check_fee_collection() {
        let mut now = 0_i64;
        let slot = 0_u64;

        let mut oracle_price = get_pyth_price(100, 6);
        let oracle_price_key =
            Pubkey::from_str("J83w4HKfqxwcq3BEMMkPFSppX3gqekLyLJBexebFVkix").unwrap();
        let pyth_program = crate::ids::pyth_program::id();
        create_account_info!(
            oracle_price,
            &oracle_price_key,
            &pyth_program,
            oracle_account_info
        );
        let _oracle_map = OracleMap::load_one(&oracle_account_info, slot, None).unwrap();

        let mut market = PerpMarket {
            amm: AMM {
                base_asset_reserve: 100 * AMM_RESERVE_PRECISION,
                quote_asset_reserve: 100 * AMM_RESERVE_PRECISION,
                bid_base_asset_reserve: 101 * AMM_RESERVE_PRECISION,
                bid_quote_asset_reserve: 99 * AMM_RESERVE_PRECISION,
                ask_base_asset_reserve: 99 * AMM_RESERVE_PRECISION,
                ask_quote_asset_reserve: 101 * AMM_RESERVE_PRECISION,
                sqrt_k: 100 * AMM_RESERVE_PRECISION,
                peg_multiplier: 100 * PEG_PRECISION,
                max_slippage_ratio: 50,
                max_base_asset_amount_ratio: 100,
                base_asset_amount_step_size: 10000000,
                quote_asset_amount_short: 50 * QUOTE_PRECISION_I128,
                net_base_asset_amount: BASE_PRECISION_I128,
                oracle: oracle_price_key,
                historical_oracle_data: HistoricalOracleData::default_price(
                    oracle_price.agg.price as i128,
                ),
                ..AMM::default()
            },
            margin_ratio_initial: 1000,
            margin_ratio_maintenance: 500,
            open_interest: 1,
            status: MarketStatus::Initialized,
            liquidator_fee: LIQUIDATION_FEE_PRECISION / 100,
            ..PerpMarket::default()
        };
        create_anchor_account_info!(market, PerpMarket, market_account_info);
        let _market_map = PerpMarketMap::load_one(&market_account_info, true).unwrap();

        let mut spot_market = SpotMarket {
            market_index: 0,
            oracle_source: OracleSource::QuoteAsset,
            cumulative_deposit_interest: SPOT_CUMULATIVE_INTEREST_PRECISION,
            cumulative_borrow_interest: SPOT_CUMULATIVE_INTEREST_PRECISION,
            decimals: 6,
            initial_asset_weight: SPOT_WEIGHT_PRECISION,
            maintenance_asset_weight: SPOT_WEIGHT_PRECISION,
            deposit_balance: SPOT_BALANCE_PRECISION,
            borrow_balance: 0,
            deposit_token_twap: QUOTE_PRECISION / 2,

            optimal_utilization: SPOT_UTILIZATION_PRECISION / 2,
            optimal_borrow_rate: SPOT_RATE_PRECISION * 20,
            max_borrow_rate: SPOT_RATE_PRECISION * 50,
            ..SpotMarket::default()
        };

        create_anchor_account_info!(spot_market, SpotMarket, spot_market_account_info);
        let mut sol_spot_market = SpotMarket {
            market_index: 1,
            oracle_source: OracleSource::Pyth,
            oracle: oracle_price_key,
            cumulative_deposit_interest: SPOT_CUMULATIVE_INTEREST_PRECISION,
            cumulative_borrow_interest: SPOT_CUMULATIVE_INTEREST_PRECISION,
            decimals: 10,
            initial_asset_weight: 8 * SPOT_WEIGHT_PRECISION / 10,
            maintenance_asset_weight: 9 * SPOT_WEIGHT_PRECISION / 10,
            initial_liability_weight: 12 * SPOT_WEIGHT_PRECISION / 10,
            maintenance_liability_weight: 11 * SPOT_WEIGHT_PRECISION / 10,
            deposit_balance: SPOT_BALANCE_PRECISION,
            borrow_balance: SPOT_BALANCE_PRECISION,
            liquidator_fee: LIQUIDATION_FEE_PRECISION / 1000,
            revenue_settle_period: 1,
            ..SpotMarket::default()
        };
        create_anchor_account_info!(sol_spot_market, SpotMarket, sol_spot_market_account_info);
        let spot_market_account_infos =
            Vec::from([&spot_market_account_info, &sol_spot_market_account_info]);
        let _spot_market_map =
            SpotMarketMap::load_multiple(spot_market_account_infos, true).unwrap();

        let mut spot_positions = [SpotPosition::default(); 8];
        spot_positions[0] = SpotPosition {
            market_index: 1,
            balance_type: SpotBalanceType::Deposit,
            balance: SPOT_BALANCE_PRECISION_U64,
            ..SpotPosition::default()
        };
        let mut user = User {
            orders: [Order::default(); 32],
            perp_positions: [PerpPosition::default(); 8],
            spot_positions,
            ..User::default()
        };

        spot_market.user_if_factor = 900;
        spot_market.total_if_factor = 1000; //1_000_000

        assert_eq!(spot_market.utilization_twap, 0);
        assert_eq!(spot_market.deposit_balance, 1000000000);
        assert_eq!(spot_market.borrow_balance, 0);

        let amount = QUOTE_PRECISION / 4;
        update_spot_position_balance_with_limits(
            (amount / 2) as u128,
            &SpotBalanceType::Borrow,
            &mut spot_market,
            &mut user.spot_positions[1],
        )
        .unwrap();

        assert_eq!(spot_market.deposit_balance, 1000000000);
        assert_eq!(spot_market.borrow_balance, 125000001);
        assert_eq!(spot_market.utilization_twap, 0);

        update_spot_market_cumulative_interest(&mut spot_market, None, now + 100).unwrap();

        assert_eq!(spot_market.revenue_pool.balance, 0);
        assert_eq!(spot_market.cumulative_deposit_interest, 10000019799);
        assert_eq!(spot_market.cumulative_borrow_interest, 10000158549);
        assert_eq!(spot_market.last_interest_ts, 100);
        assert_eq!(spot_market.last_twap_ts, 100);
        assert_eq!(spot_market.utilization_twap, 143);

        let deposit_tokens_1 = get_token_amount(
            spot_market.deposit_balance,
            &spot_market,
            &SpotBalanceType::Deposit,
        )
        .unwrap();
        let borrow_tokens_1 = get_token_amount(
            spot_market.borrow_balance,
            &spot_market,
            &SpotBalanceType::Borrow,
        )
        .unwrap();
        let if_tokens_1 = get_token_amount(
            spot_market.revenue_pool.balance,
            &spot_market,
            &SpotBalanceType::Borrow,
        )
        .unwrap();

        assert_eq!(deposit_tokens_1, 1000001);
        assert_eq!(borrow_tokens_1, 125001);
        assert_eq!(if_tokens_1, 0);

        update_spot_market_cumulative_interest(&mut spot_market, None, now + 7500).unwrap();

        assert_eq!(spot_market.last_interest_ts, 7500);
        assert_eq!(spot_market.last_twap_ts, 7500);
        assert_eq!(spot_market.utilization_twap, 10846);

        assert_eq!(spot_market.cumulative_deposit_interest, 10001484913);
        assert_eq!(spot_market.cumulative_borrow_interest, 10011891359);
        assert_eq!(spot_market.revenue_pool.balance, 0);

        let deposit_tokens_2 = get_token_amount(
            spot_market.deposit_balance,
            &spot_market,
            &SpotBalanceType::Deposit,
        )
        .unwrap();
        let borrow_tokens_2 = get_token_amount(
            spot_market.borrow_balance,
            &spot_market,
            &SpotBalanceType::Borrow,
        )
        .unwrap();
        let if_tokens_2 = get_token_amount(
            spot_market.revenue_pool.balance,
            &spot_market,
            &SpotBalanceType::Borrow,
        )
        .unwrap();

        assert_eq!(deposit_tokens_2, 1000148);
        assert_eq!(borrow_tokens_2, 125148);
        assert_eq!(if_tokens_2, 0);

        //assert >=0
        // assert_eq!(
        //     (borrow_tokens_2 - borrow_tokens_1) - (deposit_tokens_2 - deposit_tokens_1),
        //     0
        // );

        update_spot_market_cumulative_interest(
            &mut spot_market,
            None,
            now + 750 + (60 * 60 * 24 * 365),
        )
        .unwrap();

        now = now + 750 + (60 * 60 * 24 * 365);

        assert_eq!(spot_market.cumulative_deposit_interest, 16257718343);
        assert_eq!(spot_market.cumulative_borrow_interest, 60112283675);
        assert_eq!(spot_market.revenue_pool.balance, 385047);

        let deposit_tokens_3 = get_token_amount(
            spot_market.deposit_balance,
            &spot_market,
            &SpotBalanceType::Deposit,
        )
        .unwrap();
        let borrow_tokens_3 = get_token_amount(
            spot_market.borrow_balance,
            &spot_market,
            &SpotBalanceType::Borrow,
        )
        .unwrap();
        let if_tokens_3 = get_token_amount(
            spot_market.revenue_pool.balance,
            &spot_market,
            &SpotBalanceType::Borrow,
        )
        .unwrap();

        assert_eq!(deposit_tokens_3, 1626397);
        assert_eq!(borrow_tokens_3, 751403);
        assert_eq!(if_tokens_3, 2314);

        assert_eq!((borrow_tokens_3 - borrow_tokens_2), 626255);
        assert_eq!((deposit_tokens_3 - deposit_tokens_2), 626249);

        // assert >= 0
        assert_eq!(
            (borrow_tokens_3 - borrow_tokens_2) - (deposit_tokens_3 - deposit_tokens_2),
            6
        );

        // settle IF pool to 100% utilization boundary
        assert_eq!(spot_market.revenue_pool.balance, 385047);
        assert_eq!(spot_market.utilization_twap, 462003);
        spot_market.revenue_settle_period = 1;

        let settle_amount = settle_revenue_to_insurance_fund(
            deposit_tokens_3 as u64,
            if_tokens_3 as u64,
            &mut spot_market,
            now + 60,
        )
        .unwrap();

        assert_eq!(settle_amount, 626);
        assert_eq!(spot_market.user_if_shares, 0);
        assert_eq!(spot_market.total_if_shares, 0);
        assert_eq!(if_tokens_3 - (settle_amount as u128), 1688);
        assert_eq!(spot_market.revenue_pool.balance, 0);
        assert_eq!(spot_market.utilization_twap, 462004);

        let deposit_tokens_4 = get_token_amount(
            spot_market.deposit_balance,
            &spot_market,
            &SpotBalanceType::Deposit,
        )
        .unwrap();
        let borrow_tokens_4 = get_token_amount(
            spot_market.borrow_balance,
            &spot_market,
            &SpotBalanceType::Borrow,
        )
        .unwrap();
        let if_tokens_4 = get_token_amount(
            spot_market.revenue_pool.balance,
            &spot_market,
            &SpotBalanceType::Deposit,
        )
        .unwrap();

        assert_eq!(spot_market.borrow_token_twap, 751403);
        assert_eq!(spot_market.deposit_token_twap, 1626397);
        assert_eq!(
            spot_market.borrow_token_twap * SPOT_UTILIZATION_PRECISION
                / spot_market.deposit_token_twap,
            462004
        ); // 47.4%

        assert_eq!(spot_market.utilization_twap, 462004); // 46.2%
        assert_eq!(
            borrow_tokens_4 * SPOT_UTILIZATION_PRECISION / deposit_tokens_4,
            462190
        ); // 46.2%
        assert_eq!(SPOT_UTILIZATION_PRECISION, 1000000); // 100%

        assert_eq!(deposit_tokens_4 - borrow_tokens_4, 874369);
        assert_eq!(if_tokens_4, 0);

        // one more day later, twap update
        update_spot_market_cumulative_interest(&mut spot_market, None, now + 60 + (60 * 60 * 24))
            .unwrap();

        let deposit_tokens_5 = get_token_amount(
            spot_market.deposit_balance,
            &spot_market,
            &SpotBalanceType::Deposit,
        )
        .unwrap();
        let borrow_tokens_5 = get_token_amount(
            spot_market.borrow_balance,
            &spot_market,
            &SpotBalanceType::Borrow,
        )
        .unwrap();
        let _if_tokens_5 = get_token_amount(
            spot_market.revenue_pool.balance,
            &spot_market,
            &SpotBalanceType::Deposit,
        )
        .unwrap();

        assert_eq!(spot_market.borrow_token_twap, 789489);
        assert_eq!(spot_market.deposit_token_twap, 1663857);

        assert_eq!(
            spot_market.borrow_token_twap * SPOT_UTILIZATION_PRECISION
                / spot_market.deposit_token_twap,
            474493
        ); // 47.4%
        assert_eq!(spot_market.utilization_twap, 474492); // 47.4%
        assert_eq!(
            borrow_tokens_5 * SPOT_UTILIZATION_PRECISION / deposit_tokens_5,
            474493
        ); // 47.4%
        assert_eq!(SPOT_UTILIZATION_PRECISION, 1000000); // 100%
    }

    #[test]
    fn check_fee_collection_larger_nums() {
        let mut now = 0_i64;
        let slot = 0_u64;

        let mut oracle_price = get_pyth_price(100, 6);
        let oracle_price_key =
            Pubkey::from_str("J83w4HKfqxwcq3BEMMkPFSppX3gqekLyLJBexebFVkix").unwrap();
        let pyth_program = crate::ids::pyth_program::id();
        create_account_info!(
            oracle_price,
            &oracle_price_key,
            &pyth_program,
            oracle_account_info
        );
        let _oracle_map = OracleMap::load_one(&oracle_account_info, slot, None).unwrap();

        let mut market = PerpMarket {
            amm: AMM {
                base_asset_reserve: 100 * AMM_RESERVE_PRECISION,
                quote_asset_reserve: 100 * AMM_RESERVE_PRECISION,
                bid_base_asset_reserve: 101 * AMM_RESERVE_PRECISION,
                bid_quote_asset_reserve: 99 * AMM_RESERVE_PRECISION,
                ask_base_asset_reserve: 99 * AMM_RESERVE_PRECISION,
                ask_quote_asset_reserve: 101 * AMM_RESERVE_PRECISION,
                sqrt_k: 100 * AMM_RESERVE_PRECISION,
                peg_multiplier: 100 * PEG_PRECISION,
                max_slippage_ratio: 50,
                max_base_asset_amount_ratio: 100,
                base_asset_amount_step_size: 10000000,
                quote_asset_amount_short: 50 * QUOTE_PRECISION_I128,
                net_base_asset_amount: BASE_PRECISION_I128,
                oracle: oracle_price_key,
                historical_oracle_data: HistoricalOracleData::default_price(
                    oracle_price.agg.price as i128,
                ),
                ..AMM::default()
            },
            margin_ratio_initial: 1000,
            margin_ratio_maintenance: 500,
            open_interest: 1,
            status: MarketStatus::Initialized,
            liquidator_fee: LIQUIDATION_FEE_PRECISION / 100,
            ..PerpMarket::default()
        };
        create_anchor_account_info!(market, PerpMarket, market_account_info);
        let _market_map = PerpMarketMap::load_one(&market_account_info, true).unwrap();

        let mut spot_market = SpotMarket {
            market_index: 0,
            oracle_source: OracleSource::QuoteAsset,
            cumulative_deposit_interest: SPOT_CUMULATIVE_INTEREST_PRECISION,
            cumulative_borrow_interest: SPOT_CUMULATIVE_INTEREST_PRECISION,
            decimals: 6,
            initial_asset_weight: SPOT_WEIGHT_PRECISION,
            maintenance_asset_weight: SPOT_WEIGHT_PRECISION,
            deposit_balance: 1000000 * SPOT_BALANCE_PRECISION,
            borrow_balance: 0,
            deposit_token_twap: QUOTE_PRECISION / 2,

            optimal_utilization: SPOT_UTILIZATION_PRECISION / 2,
            optimal_borrow_rate: SPOT_RATE_PRECISION * 20,
            max_borrow_rate: SPOT_RATE_PRECISION * 50,
            ..SpotMarket::default()
        };

        create_anchor_account_info!(spot_market, SpotMarket, spot_market_account_info);
        let mut sol_spot_market = SpotMarket {
            market_index: 1,
            oracle_source: OracleSource::Pyth,
            oracle: oracle_price_key,
            cumulative_deposit_interest: SPOT_CUMULATIVE_INTEREST_PRECISION,
            cumulative_borrow_interest: SPOT_CUMULATIVE_INTEREST_PRECISION,
            decimals: 10,
            initial_asset_weight: 8 * SPOT_WEIGHT_PRECISION / 10,
            maintenance_asset_weight: 9 * SPOT_WEIGHT_PRECISION / 10,
            initial_liability_weight: 12 * SPOT_WEIGHT_PRECISION / 10,
            maintenance_liability_weight: 11 * SPOT_WEIGHT_PRECISION / 10,
            deposit_balance: SPOT_BALANCE_PRECISION,
            borrow_balance: SPOT_BALANCE_PRECISION,
            liquidator_fee: LIQUIDATION_FEE_PRECISION / 1000,
            ..SpotMarket::default()
        };
        create_anchor_account_info!(sol_spot_market, SpotMarket, sol_spot_market_account_info);
        let spot_market_account_infos =
            Vec::from([&spot_market_account_info, &sol_spot_market_account_info]);
        let _spot_market_map =
            SpotMarketMap::load_multiple(spot_market_account_infos, true).unwrap();

        let mut spot_positions = [SpotPosition::default(); 8];
        spot_positions[0] = SpotPosition {
            market_index: 1,
            balance_type: SpotBalanceType::Deposit,
            balance: SPOT_BALANCE_PRECISION_U64,
            ..SpotPosition::default()
        };
        let mut user = User {
            orders: [Order::default(); 32],
            perp_positions: [PerpPosition::default(); 8],
            spot_positions,
            ..User::default()
        };

        spot_market.user_if_factor = 90_000;
        spot_market.total_if_factor = 100_000;

        assert_eq!(spot_market.utilization_twap, 0);
        assert_eq!(
            spot_market.deposit_balance,
            1000000 * SPOT_BALANCE_PRECISION
        );
        assert_eq!(spot_market.borrow_balance, 0);

        let amount = 540510 * QUOTE_PRECISION;
        update_spot_balances(
            amount as u128,
            &SpotBalanceType::Borrow,
            &mut spot_market,
            &mut user.spot_positions[1],
            false,
        )
        .unwrap();

        assert_eq!(
            spot_market.deposit_balance,
            1000000 * SPOT_BALANCE_PRECISION
        );
        assert_eq!(spot_market.borrow_balance, 540510000000001);
        assert_eq!(spot_market.utilization_twap, 0);

        update_spot_market_cumulative_interest(&mut spot_market, None, now + 100).unwrap();

        assert_eq!(spot_market.revenue_pool.balance, 3844266986);
        assert_eq!(spot_market.cumulative_deposit_interest, 10000346004);
        assert_eq!(spot_market.cumulative_borrow_interest, 10000711270);
        assert_eq!(spot_market.last_interest_ts, 100);
        assert_eq!(spot_market.last_twap_ts, 100);
        assert_eq!(spot_market.utilization_twap, 624);

        let deposit_tokens_1 = get_token_amount(
            spot_market.deposit_balance,
            &spot_market,
            &SpotBalanceType::Deposit,
        )
        .unwrap();
        let borrow_tokens_1 = get_token_amount(
            spot_market.borrow_balance,
            &spot_market,
            &SpotBalanceType::Borrow,
        )
        .unwrap();
        let if_tokens_1 = get_token_amount(
            spot_market.revenue_pool.balance,
            &spot_market,
            &SpotBalanceType::Deposit,
        )
        .unwrap();

        assert_eq!(deposit_tokens_1, 1000038444799);
        assert_eq!(borrow_tokens_1, 540548444854);
        assert_eq!(if_tokens_1, 3844399);

        update_spot_market_cumulative_interest(&mut spot_market, None, now + 7500).unwrap();

        assert_eq!(spot_market.last_interest_ts, 7500);
        assert_eq!(spot_market.last_twap_ts, 7500);
        assert_eq!(spot_market.utilization_twap, 46976);

        assert_eq!(spot_market.cumulative_deposit_interest, 10025953120);
        assert_eq!(spot_market.cumulative_borrow_interest, 10053351363);
        assert_eq!(spot_market.revenue_pool.balance, 287632341391);

        let deposit_tokens_2 = get_token_amount(
            spot_market.deposit_balance,
            &spot_market,
            &SpotBalanceType::Deposit,
        )
        .unwrap();
        let borrow_tokens_2 = get_token_amount(
            spot_market.borrow_balance,
            &spot_market,
            &SpotBalanceType::Borrow,
        )
        .unwrap();
        let if_tokens_2 = get_token_amount(
            spot_market.revenue_pool.balance,
            &spot_market,
            &SpotBalanceType::Deposit,
        )
        .unwrap();

        assert_eq!(deposit_tokens_2, 1002883690837);
        assert_eq!(borrow_tokens_2, 543393694521);
        assert_eq!(if_tokens_2, 288378837);

        //assert >=0
        assert_eq!(
            (borrow_tokens_2 - borrow_tokens_1) - (deposit_tokens_2 - deposit_tokens_1),
            3629
        );

        update_spot_market_cumulative_interest(
            &mut spot_market,
            None,
            now + 750 + (60 * 60 * 24 * 365),
        )
        .unwrap();

        now = now + 750 + (60 * 60 * 24 * 365);

        assert_eq!(spot_market.cumulative_deposit_interest, 120056141117);
        assert_eq!(spot_market.cumulative_borrow_interest, 236304445676);
        assert_eq!(spot_market.revenue_pool.balance, 102149084836788);

        let deposit_tokens_3 = get_token_amount(
            spot_market.deposit_balance,
            &spot_market,
            &SpotBalanceType::Deposit,
        )
        .unwrap();
        let borrow_tokens_3 = get_token_amount(
            spot_market.borrow_balance,
            &spot_market,
            &SpotBalanceType::Borrow,
        )
        .unwrap();
        let if_tokens_3 = get_token_amount(
            spot_market.revenue_pool.balance,
            &spot_market,
            &SpotBalanceType::Deposit,
        )
        .unwrap();

        assert_eq!(deposit_tokens_3, 13231976606113);
        assert_eq!(borrow_tokens_3, 12772491593233);
        assert_eq!(if_tokens_3, 1226362494413);

        assert_eq!((borrow_tokens_3 - borrow_tokens_2), 12229097898712);
        assert_eq!((deposit_tokens_3 - deposit_tokens_2), 12229092915276);

        // assert >= 0
        assert_eq!(
            (borrow_tokens_3 - borrow_tokens_2) - (deposit_tokens_3 - deposit_tokens_2),
            4_983_436 //$4.98 missing
        );

        let mut if_balance_2 = 0;

        // settle IF pool to 100% utilization boundary
        // only half of depositors available claim was settled (to protect vault)
        assert_eq!(spot_market.revenue_pool.balance, 102149084836788);
        spot_market.revenue_settle_period = 1;
        let settle_amount = settle_revenue_to_insurance_fund(
            deposit_tokens_3 as u64,
            if_tokens_3 as u64,
            &mut spot_market,
            now + 60,
        )
        .unwrap();
        assert_eq!(settle_amount, 229742506021);
        assert_eq!(spot_market.user_if_shares, 0);
        assert_eq!(spot_market.total_if_shares, 0);
        if_balance_2 += settle_amount;
        assert_eq!(if_balance_2, 229742506021);
        assert_eq!(if_tokens_3 - (settle_amount as u128), 996619988392); // w/ update interest for settle_spot_market_to_if

        assert_eq!(spot_market.revenue_pool.balance, 83024042298872);
        assert_eq!(spot_market.utilization_twap, 965274);

        let deposit_tokens_4 = get_token_amount(
            spot_market.deposit_balance,
            &spot_market,
            &SpotBalanceType::Deposit,
        )
        .unwrap();
        let borrow_tokens_4 = get_token_amount(
            spot_market.borrow_balance,
            &spot_market,
            &SpotBalanceType::Borrow,
        )
        .unwrap();
        let if_tokens_4 = get_token_amount(
            spot_market.revenue_pool.balance,
            &spot_market,
            &SpotBalanceType::Deposit,
        )
        .unwrap();

        assert_eq!(deposit_tokens_4 - borrow_tokens_4, 229742506021);
        assert_eq!(if_tokens_4, 996833556272);
    }
}
