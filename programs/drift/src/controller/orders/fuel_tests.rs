use anchor_lang::prelude::Pubkey;
use anchor_lang::Owner;

use crate::math::constants::ONE_BPS_DENOMINATOR;
use crate::math::margin::MarginRequirementType;
use crate::state::margin_calculation::{MarginCalculation, MarginContext};
use crate::state::oracle_map::OracleMap;
use crate::state::state::{FeeStructure, FeeTier};
use crate::state::user::{Order, PerpPosition};

fn get_fee_structure() -> FeeStructure {
    let mut fee_tiers = [FeeTier::default(); 10];
    fee_tiers[0] = FeeTier {
        fee_numerator: 5,
        fee_denominator: ONE_BPS_DENOMINATOR,
        maker_rebate_numerator: 3,
        maker_rebate_denominator: ONE_BPS_DENOMINATOR,
        ..FeeTier::default()
    };
    FeeStructure {
        fee_tiers,
        ..FeeStructure::test_default()
    }
}

fn get_user_keys() -> (Pubkey, Pubkey, Pubkey) {
    (Pubkey::default(), Pubkey::default(), Pubkey::default())
}

#[cfg(test)]
pub mod fuel_scoring {
    use std::str::FromStr;

    use crate::controller::orders::fulfill_perp_order;
    use crate::controller::position::PositionDirection;
    use crate::create_account_info;
    use crate::create_anchor_account_info;
    use crate::math::constants::{PRICE_PRECISION_I64, QUOTE_PRECISION_I64};

    use crate::math::constants::PRICE_PRECISION_U64;
    use crate::math::constants::{
        AMM_RESERVE_PRECISION, BASE_PRECISION_I64, BASE_PRECISION_U64, PEG_PRECISION,
        PRICE_PRECISION, SPOT_BALANCE_PRECISION_U64, SPOT_CUMULATIVE_INTEREST_PRECISION,
        SPOT_WEIGHT_PRECISION,
    };
    use crate::state::fill_mode::FillMode;
    use crate::state::oracle::{HistoricalOracleData, OracleSource};
    use crate::state::perp_market::{MarketStatus, PerpMarket, AMM};
    use crate::state::perp_market_map::PerpMarketMap;
    use crate::state::spot_market::{SpotBalanceType, SpotMarket};
    use crate::state::spot_market_map::SpotMarketMap;
    use crate::state::user::{OrderStatus, OrderType, SpotPosition, User, UserStats};
    use crate::state::user_map::{UserMap, UserStatsMap};
    use crate::test_utils::*;
    use crate::test_utils::{get_orders, get_positions, get_pyth_price, get_spot_positions};

    use super::*;

    #[test]
    fn taker_maker_perp_fuel_boost() {
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
        let mut oracle_map = OracleMap::load_one(&oracle_account_info, slot, None).unwrap();

        // net users are short
        let mut market = PerpMarket {
            amm: AMM {
                base_asset_reserve: 100 * AMM_RESERVE_PRECISION,
                quote_asset_reserve: 100 * AMM_RESERVE_PRECISION,
                base_asset_amount_with_amm: (AMM_RESERVE_PRECISION / 2) as i128,
                base_asset_amount_long: (AMM_RESERVE_PRECISION / 2) as i128,
                sqrt_k: 100 * AMM_RESERVE_PRECISION,
                peg_multiplier: 100 * PEG_PRECISION,
                max_slippage_ratio: 50,
                max_fill_reserve_fraction: 100,
                order_step_size: 1000,
                order_tick_size: 1,
                oracle: oracle_price_key,
                amm_jit_intensity: 100,
                base_spread: 20000,
                long_spread: 20000,
                short_spread: 20000,
                historical_oracle_data: HistoricalOracleData {
                    last_oracle_price: (100 * PRICE_PRECISION) as i64,
                    last_oracle_price_twap: (100 * PRICE_PRECISION) as i64,
                    last_oracle_price_twap_5min: (100 * PRICE_PRECISION) as i64,

                    ..HistoricalOracleData::default()
                },

                ..AMM::default()
            },
            margin_ratio_initial: 1000,
            margin_ratio_maintenance: 500,
            status: MarketStatus::Initialized,
            fuel_boost_position: 250,
            fuel_boost_maker: 100,
            fuel_boost_taker: 50,
            ..PerpMarket::default_test()
        };
        market.amm.max_base_asset_reserve = u64::MAX as u128;
        market.amm.min_base_asset_reserve = 0;

        let (new_ask_base_asset_reserve, new_ask_quote_asset_reserve) =
            crate::math::amm_spread::calculate_spread_reserves(
                &market.amm,
                PositionDirection::Long,
            )
            .unwrap();
        let (new_bid_base_asset_reserve, new_bid_quote_asset_reserve) =
            crate::math::amm_spread::calculate_spread_reserves(
                &market.amm,
                PositionDirection::Short,
            )
            .unwrap();
        market.amm.ask_base_asset_reserve = new_ask_base_asset_reserve;
        market.amm.bid_base_asset_reserve = new_bid_base_asset_reserve;
        market.amm.ask_quote_asset_reserve = new_ask_quote_asset_reserve;
        market.amm.bid_quote_asset_reserve = new_bid_quote_asset_reserve;

        assert_eq!(new_bid_quote_asset_reserve, 99000000000);
        create_anchor_account_info!(market, PerpMarket, market_account_info);
        let market_map = PerpMarketMap::load_one(&market_account_info, true).unwrap();

        let mut spot_market = SpotMarket {
            market_index: 0,
            oracle_source: OracleSource::QuoteAsset,
            cumulative_deposit_interest: SPOT_CUMULATIVE_INTEREST_PRECISION,
            decimals: 6,
            initial_asset_weight: SPOT_WEIGHT_PRECISION,
            maintenance_asset_weight: SPOT_WEIGHT_PRECISION,
            historical_oracle_data: HistoricalOracleData::default_price(QUOTE_PRECISION_I64),
            ..SpotMarket::default()
        };
        create_anchor_account_info!(spot_market, SpotMarket, spot_market_account_info);
        let spot_market_map = SpotMarketMap::load_one(&spot_market_account_info, true).unwrap();

        // taker wants to go long (would improve balance)
        let mut taker = User {
            orders: get_orders(Order {
                market_index: 0,
                status: OrderStatus::Open,
                order_type: OrderType::Market,
                direction: PositionDirection::Long,
                base_asset_amount: BASE_PRECISION_U64,
                slot: 0,
                auction_start_price: 100 * PRICE_PRECISION_I64,
                auction_end_price: 100 * PRICE_PRECISION_I64,
                price: 100 * PRICE_PRECISION_U64 + 500000,
                auction_duration: 0,
                ..Order::default()
            }),
            perp_positions: get_positions(PerpPosition {
                market_index: 0,
                open_orders: 1,
                open_bids: BASE_PRECISION_I64,
                ..PerpPosition::default()
            }),
            spot_positions: get_spot_positions(SpotPosition {
                market_index: 0,
                balance_type: SpotBalanceType::Deposit,
                scaled_balance: 100 * SPOT_BALANCE_PRECISION_U64,
                ..SpotPosition::default()
            }),
            ..User::default()
        };

        let maker_key = Pubkey::from_str("My11111111111111111111111111111111111111113").unwrap();
        let maker_authority =
            Pubkey::from_str("J83w4HKfqxwcq3BEMMkPFSppX3gqekLyLJBexebFVkix").unwrap();
        let mut maker = User {
            authority: maker_authority,
            orders: get_orders(Order {
                market_index: 0,
                post_only: true,
                order_type: OrderType::Limit,
                direction: PositionDirection::Short,
                base_asset_amount: BASE_PRECISION_U64 / 2,
                price: 100 * PRICE_PRECISION_U64,
                ..Order::default()
            }),
            perp_positions: get_positions(PerpPosition {
                market_index: 0,
                open_orders: 1,
                open_asks: -BASE_PRECISION_I64 / 2,
                ..PerpPosition::default()
            }),
            spot_positions: get_spot_positions(SpotPosition {
                market_index: 0,
                balance_type: SpotBalanceType::Deposit,
                scaled_balance: 100 * 100 * SPOT_BALANCE_PRECISION_U64,
                ..SpotPosition::default()
            }),
            ..User::default()
        };
        create_anchor_account_info!(maker, &maker_key, User, maker_account_info);
        let makers_and_referrers = UserMap::load_one(&maker_account_info).unwrap();

        let mut filler = User::default();

        let fee_structure = get_fee_structure();

        let (taker_key, _, filler_key) = get_user_keys();

        let mut taker_stats = UserStats::default();

        let mut maker_stats = UserStats {
            authority: maker_authority,
            ..UserStats::default()
        };
        create_anchor_account_info!(maker_stats, UserStats, maker_stats_account_info);
        let maker_and_referrer_stats = UserStatsMap::load_one(&maker_stats_account_info).unwrap();

        let mut filler_stats: UserStats = UserStats::default();
        assert_eq!(maker_stats.fuel_deposits, 0);
        assert_eq!(taker_stats.fuel_deposits, 0);

        let (ba, qa) = fulfill_perp_order(
            &mut taker,
            0,
            &taker_key,
            &mut taker_stats,
            &makers_and_referrers,
            &maker_and_referrer_stats,
            &[(maker_key, 0, 100 * PRICE_PRECISION_U64)],
            &mut Some(&mut filler),
            &filler_key,
            &mut Some(&mut filler_stats),
            None,
            &spot_market_map,
            &market_map,
            &mut oracle_map,
            &fee_structure,
            0,
            Some(market.amm.historical_oracle_data.last_oracle_price),
            now,
            slot,
            0,
            true,
            FillMode::Fill,
        )
        .unwrap();

        assert_eq!(ba, 500000000);
        assert_eq!(qa, 50000000);

        let market_after = market_map.get_ref(&0).unwrap();
        assert_eq!(
            market_after.amm.base_asset_amount_with_amm,
            market.amm.base_asset_amount_with_amm
        );
        assert_ne!(taker.get_perp_position(0).unwrap().base_asset_amount, 0);
        let maker_after: std::cell::RefMut<User> =
            makers_and_referrers.get_ref_mut(&maker_key).unwrap();
        let maker_stats_after = if maker.authority == taker.authority {
            None
        } else {
            Some(
                maker_and_referrer_stats
                    .get_ref_mut(&maker.authority)
                    .unwrap(),
            )
        }
        .unwrap();

        assert_ne!(
            maker_after.get_perp_position(0).unwrap().base_asset_amount,
            0
        );

        assert!(maker_stats_after.fuel_maker > 0);
        assert!(taker_stats.fuel_taker > 0);
        assert_eq!(maker_stats_after.fuel_maker, 5000);
        assert_eq!(taker_stats.fuel_taker, 2500);

        now += 1000000;

        let mut margin_context = MarginContext::standard(MarginRequirementType::Initial);

        // todo? is assert bad?
        // need to pass correct time since last fuel bonus update in context
        let is_errored_attempted = taker
            .calculate_margin_and_increment_fuel_bonus(
                &market_map,
                &spot_market_map,
                &mut oracle_map,
                margin_context,
                &mut taker_stats,
                now,
            )
            .is_err();
        assert!(is_errored_attempted);

        margin_context.fuel_bonus_numerator = taker_stats
            .get_fuel_bonus_numerator(taker.last_fuel_bonus_update_ts, now)
            .unwrap();
        assert_eq!(margin_context.fuel_bonus_numerator, now);
        assert_eq!(taker.last_fuel_bonus_update_ts, 0);

        let margin_calc: MarginCalculation = taker
            .calculate_margin_and_increment_fuel_bonus(
                &market_map,
                &spot_market_map,
                &mut oracle_map,
                margin_context,
                &mut taker_stats,
                now,
            )
            .unwrap();

        assert_eq!(margin_calc.fuel_positions, 51669);
        // assert_eq!(taker_stats.fuel_positions, 25000000000 + margin_calc.fuel_positions);
    }

    #[test]
    fn deposit_and_borrow_fuel() {
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
        let mut oracle_map = OracleMap::load_one(&oracle_account_info, slot, None).unwrap();

        // net users are short
        let mut market = PerpMarket {
            amm: AMM {
                base_asset_reserve: 100 * AMM_RESERVE_PRECISION,
                quote_asset_reserve: 100 * AMM_RESERVE_PRECISION,
                base_asset_amount_with_amm: (AMM_RESERVE_PRECISION / 2) as i128,
                base_asset_amount_long: (AMM_RESERVE_PRECISION / 2) as i128,
                sqrt_k: 100 * AMM_RESERVE_PRECISION,
                peg_multiplier: 100 * PEG_PRECISION,
                max_slippage_ratio: 50,
                max_fill_reserve_fraction: 100,
                order_step_size: 1000,
                order_tick_size: 1,
                oracle: oracle_price_key,
                amm_jit_intensity: 100,
                base_spread: 20000,
                long_spread: 20000,
                short_spread: 20000,
                historical_oracle_data: HistoricalOracleData {
                    last_oracle_price: (100 * PRICE_PRECISION) as i64,
                    last_oracle_price_twap: (100 * PRICE_PRECISION) as i64,
                    last_oracle_price_twap_5min: (100 * PRICE_PRECISION) as i64,

                    ..HistoricalOracleData::default()
                },

                ..AMM::default()
            },
            margin_ratio_initial: 1000,
            margin_ratio_maintenance: 500,
            status: MarketStatus::Initialized,
            fuel_boost_position: 250,
            fuel_boost_maker: 100,
            fuel_boost_taker: 50,
            ..PerpMarket::default_test()
        };
        market.amm.max_base_asset_reserve = u64::MAX as u128;
        market.amm.min_base_asset_reserve = 0;

        let (new_ask_base_asset_reserve, new_ask_quote_asset_reserve) =
            crate::math::amm_spread::calculate_spread_reserves(
                &market.amm,
                PositionDirection::Long,
            )
            .unwrap();
        let (new_bid_base_asset_reserve, new_bid_quote_asset_reserve) =
            crate::math::amm_spread::calculate_spread_reserves(
                &market.amm,
                PositionDirection::Short,
            )
            .unwrap();
        market.amm.ask_base_asset_reserve = new_ask_base_asset_reserve;
        market.amm.bid_base_asset_reserve = new_bid_base_asset_reserve;
        market.amm.ask_quote_asset_reserve = new_ask_quote_asset_reserve;
        market.amm.bid_quote_asset_reserve = new_bid_quote_asset_reserve;

        assert_eq!(new_bid_quote_asset_reserve, 99000000000);
        create_anchor_account_info!(market, PerpMarket, market_account_info);
        let market_map = PerpMarketMap::load_one(&market_account_info, true).unwrap();

        let mut spot_market = SpotMarket {
            market_index: 0,
            oracle_source: OracleSource::QuoteAsset,
            cumulative_deposit_interest: SPOT_CUMULATIVE_INTEREST_PRECISION,
            decimals: 6,
            initial_asset_weight: SPOT_WEIGHT_PRECISION,
            maintenance_asset_weight: SPOT_WEIGHT_PRECISION,
            historical_oracle_data: HistoricalOracleData::default_price(QUOTE_PRECISION_I64),

            fuel_boost_deposits: 1,
            fuel_boost_borrows: 0,
            fuel_boost_maker: 0,
            fuel_boost_taker: 0,
            ..SpotMarket::default()
        };

        let mut sol_spot_market = SpotMarket {
            market_index: 1,
            oracle_source: OracleSource::Pyth,
            oracle: oracle_price_key,
            cumulative_deposit_interest: SPOT_CUMULATIVE_INTEREST_PRECISION * 2,
            cumulative_borrow_interest: SPOT_CUMULATIVE_INTEREST_PRECISION * 4,
            decimals: 9,
            initial_asset_weight: SPOT_WEIGHT_PRECISION * 8 / 10,
            maintenance_asset_weight: SPOT_WEIGHT_PRECISION * 9 / 10,
            initial_liability_weight: SPOT_WEIGHT_PRECISION * 12 / 10,
            maintenance_liability_weight: SPOT_WEIGHT_PRECISION * 11 / 10,
            historical_oracle_data: HistoricalOracleData {
                last_oracle_price: (100 * PRICE_PRECISION) as i64,
                last_oracle_price_twap: (100 * PRICE_PRECISION) as i64,
                last_oracle_price_twap_5min: (100 * PRICE_PRECISION) as i64,

                ..HistoricalOracleData::default()
            },
            fuel_boost_deposits: 0,
            fuel_boost_borrows: 5,
            fuel_boost_maker: 0,
            fuel_boost_taker: 0,
            ..SpotMarket::default()
        };

        create_anchor_account_info!(spot_market, SpotMarket, spot_market_account_info);
        create_anchor_account_info!(sol_spot_market, SpotMarket, sol_spot_market_account_info);

        let spot_market_account_infos =
            Vec::from([&spot_market_account_info, &sol_spot_market_account_info]);
        let spot_market_map =
            SpotMarketMap::load_multiple(spot_market_account_infos, true).unwrap();

        // taker wants to go long (would improve balance)
        let mut taker = User {
            orders: get_orders(Order {
                market_index: 0,
                status: OrderStatus::Open,
                order_type: OrderType::Market,
                direction: PositionDirection::Long,
                base_asset_amount: BASE_PRECISION_U64,
                slot: 0,
                auction_start_price: 100 * PRICE_PRECISION_I64,
                auction_end_price: 100 * PRICE_PRECISION_I64,
                price: 100 * PRICE_PRECISION_U64 + 500000,
                auction_duration: 0,
                ..Order::default()
            }),
            perp_positions: get_positions(PerpPosition {
                market_index: 0,
                open_orders: 1,
                open_bids: BASE_PRECISION_I64,
                ..PerpPosition::default()
            }),
            spot_positions: get_spot_positions(SpotPosition {
                market_index: 0,
                balance_type: SpotBalanceType::Deposit,
                scaled_balance: 100 * SPOT_BALANCE_PRECISION_U64,
                ..SpotPosition::default()
            }),
            ..User::default()
        };

        taker.spot_positions[1] = SpotPosition {
            market_index: 1,
            balance_type: SpotBalanceType::Borrow,
            scaled_balance: SPOT_BALANCE_PRECISION_U64 / 20,
            ..SpotPosition::default()
        };

        let maker_key = Pubkey::from_str("My11111111111111111111111111111111111111113").unwrap();
        let maker_authority =
            Pubkey::from_str("J83w4HKfqxwcq3BEMMkPFSppX3gqekLyLJBexebFVkix").unwrap();
        let mut maker = User {
            authority: maker_authority,
            orders: get_orders(Order {
                market_index: 0,
                post_only: true,
                order_type: OrderType::Limit,
                direction: PositionDirection::Short,
                base_asset_amount: BASE_PRECISION_U64 / 2,
                price: 100 * PRICE_PRECISION_U64,
                ..Order::default()
            }),
            perp_positions: get_positions(PerpPosition {
                market_index: 0,
                open_orders: 1,
                open_asks: -BASE_PRECISION_I64 / 2,
                ..PerpPosition::default()
            }),
            spot_positions: get_spot_positions(SpotPosition {
                market_index: 0,
                balance_type: SpotBalanceType::Deposit,
                scaled_balance: 100 * 100 * SPOT_BALANCE_PRECISION_U64,
                ..SpotPosition::default()
            }),
            ..User::default()
        };
        create_anchor_account_info!(maker, &maker_key, User, maker_account_info);
        let makers_and_referrers = UserMap::load_one(&maker_account_info).unwrap();

        let mut taker_stats = UserStats::default();

        let mut maker_stats = UserStats {
            authority: maker_authority,
            ..UserStats::default()
        };
        create_anchor_account_info!(maker_stats, UserStats, maker_stats_account_info);
        let maker_and_referrer_stats = UserStatsMap::load_one(&maker_stats_account_info).unwrap();

        assert_eq!(maker_stats.fuel_deposits, 0);
        assert_eq!(taker_stats.fuel_deposits, 0);

        let market_after = market_map.get_ref(&0).unwrap();
        assert_eq!(
            market_after.amm.base_asset_amount_with_amm,
            market.amm.base_asset_amount_with_amm
        );
        assert_eq!(taker.get_perp_position(0).unwrap().base_asset_amount, 0);
        now += 86400; // one day

        let maker_after: std::cell::RefMut<User> =
            makers_and_referrers.get_ref_mut(&maker_key).unwrap();
        let maker_stats_after = if maker.authority == taker.authority {
            None
        } else {
            Some(
                maker_and_referrer_stats
                    .get_ref_mut(&maker.authority)
                    .unwrap(),
            )
        }
        .unwrap();

        assert_eq!(
            maker_after.get_perp_position(0).unwrap().base_asset_amount,
            0
        );

        let margin_context =
            MarginContext::standard(MarginRequirementType::Initial).fuel_numerator(&maker, now);

        let margin_calc_maker = maker
            .calculate_margin_and_increment_fuel_bonus(
                &market_map,
                &spot_market_map,
                &mut oracle_map,
                margin_context,
                &mut maker_stats,
                now,
            )
            .unwrap();

        assert_eq!(margin_calc_maker.total_collateral, 10_000_000_000); // 10k

        assert_eq!(margin_calc_maker.fuel_deposits, 100_000 / 28);
        assert_eq!(maker_stats.fuel_deposits, margin_calc_maker.fuel_deposits);

        let margin_context =
            MarginContext::standard(MarginRequirementType::Initial).fuel_numerator(&taker, now);

        let margin_calc = taker
            .calculate_margin_and_increment_fuel_bonus(
                &market_map,
                &spot_market_map,
                &mut oracle_map,
                margin_context,
                &mut taker_stats,
                now,
            )
            .unwrap();

        assert_eq!(margin_calc.total_collateral, 100000000);

        let borrow_fuel_addition = 35; // todo: calc by hand
        assert_eq!(margin_calc.fuel_borrows, borrow_fuel_addition);
        // assert_eq!(taker_stats.fuel_borrow, margin_calc.fuel_borrow);
    }

    #[test]
    fn deposit_fuel() {
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
        let mut oracle_map = OracleMap::load_one(&oracle_account_info, slot, None).unwrap();

        // net users are short
        let mut market = PerpMarket {
            amm: AMM {
                base_asset_reserve: 100 * AMM_RESERVE_PRECISION,
                quote_asset_reserve: 100 * AMM_RESERVE_PRECISION,
                base_asset_amount_with_amm: (AMM_RESERVE_PRECISION / 2) as i128,
                base_asset_amount_long: (AMM_RESERVE_PRECISION / 2) as i128,
                sqrt_k: 100 * AMM_RESERVE_PRECISION,
                peg_multiplier: 100 * PEG_PRECISION,
                max_slippage_ratio: 50,
                max_fill_reserve_fraction: 100,
                order_step_size: 1000,
                order_tick_size: 1,
                oracle: oracle_price_key,
                amm_jit_intensity: 100,
                base_spread: 20000,
                long_spread: 20000,
                short_spread: 20000,
                historical_oracle_data: HistoricalOracleData {
                    last_oracle_price: (100 * PRICE_PRECISION) as i64,
                    last_oracle_price_twap: (100 * PRICE_PRECISION) as i64,
                    last_oracle_price_twap_5min: (100 * PRICE_PRECISION) as i64,

                    ..HistoricalOracleData::default()
                },

                ..AMM::default()
            },
            margin_ratio_initial: 1000,
            margin_ratio_maintenance: 500,
            status: MarketStatus::Initialized,
            fuel_boost_position: 250,
            fuel_boost_maker: 100,
            fuel_boost_taker: 50,
            ..PerpMarket::default_test()
        };
        market.amm.max_base_asset_reserve = u64::MAX as u128;
        market.amm.min_base_asset_reserve = 0;

        let (new_ask_base_asset_reserve, new_ask_quote_asset_reserve) =
            crate::math::amm_spread::calculate_spread_reserves(
                &market.amm,
                PositionDirection::Long,
            )
            .unwrap();
        let (new_bid_base_asset_reserve, new_bid_quote_asset_reserve) =
            crate::math::amm_spread::calculate_spread_reserves(
                &market.amm,
                PositionDirection::Short,
            )
            .unwrap();
        market.amm.ask_base_asset_reserve = new_ask_base_asset_reserve;
        market.amm.bid_base_asset_reserve = new_bid_base_asset_reserve;
        market.amm.ask_quote_asset_reserve = new_ask_quote_asset_reserve;
        market.amm.bid_quote_asset_reserve = new_bid_quote_asset_reserve;

        assert_eq!(new_bid_quote_asset_reserve, 99000000000);
        create_anchor_account_info!(market, PerpMarket, market_account_info);
        let market_map = PerpMarketMap::load_one(&market_account_info, true).unwrap();

        let mut spot_market = SpotMarket {
            market_index: 0,
            oracle_source: OracleSource::QuoteAsset,
            cumulative_deposit_interest: SPOT_CUMULATIVE_INTEREST_PRECISION,
            decimals: 6,
            initial_asset_weight: SPOT_WEIGHT_PRECISION,
            maintenance_asset_weight: SPOT_WEIGHT_PRECISION,
            historical_oracle_data: HistoricalOracleData::default_price(QUOTE_PRECISION_I64),

            fuel_boost_deposits: 1,
            fuel_boost_borrows: 5,
            fuel_boost_maker: 200,
            fuel_boost_taker: 90,
            ..SpotMarket::default()
        };

        create_anchor_account_info!(spot_market, SpotMarket, spot_market_account_info);
        let spot_market_map = SpotMarketMap::load_one(&spot_market_account_info, true).unwrap();

        // taker wants to go long (would improve balance)
        let mut taker = User {
            orders: get_orders(Order {
                market_index: 0,
                status: OrderStatus::Open,
                order_type: OrderType::Market,
                direction: PositionDirection::Long,
                base_asset_amount: BASE_PRECISION_U64,
                slot: 0,
                auction_start_price: 100 * PRICE_PRECISION_I64,
                auction_end_price: 100 * PRICE_PRECISION_I64,
                price: 100 * PRICE_PRECISION_U64 + 500000,
                auction_duration: 0,
                ..Order::default()
            }),
            perp_positions: get_positions(PerpPosition {
                market_index: 0,
                open_orders: 1,
                open_bids: BASE_PRECISION_I64,
                ..PerpPosition::default()
            }),
            spot_positions: get_spot_positions(SpotPosition {
                market_index: 0,
                balance_type: SpotBalanceType::Deposit,
                scaled_balance: 100 * SPOT_BALANCE_PRECISION_U64,
                ..SpotPosition::default()
            }),
            ..User::default()
        };

        let maker_key = Pubkey::from_str("My11111111111111111111111111111111111111113").unwrap();
        let maker_authority =
            Pubkey::from_str("J83w4HKfqxwcq3BEMMkPFSppX3gqekLyLJBexebFVkix").unwrap();
        let mut maker = User {
            authority: maker_authority,
            orders: get_orders(Order {
                market_index: 0,
                post_only: true,
                order_type: OrderType::Limit,
                direction: PositionDirection::Short,
                base_asset_amount: BASE_PRECISION_U64 / 2,
                price: 100 * PRICE_PRECISION_U64,
                ..Order::default()
            }),
            perp_positions: get_positions(PerpPosition {
                market_index: 0,
                open_orders: 1,
                open_asks: -BASE_PRECISION_I64 / 2,
                ..PerpPosition::default()
            }),
            spot_positions: get_spot_positions(SpotPosition {
                market_index: 0,
                balance_type: SpotBalanceType::Deposit,
                scaled_balance: 100 * 100 * SPOT_BALANCE_PRECISION_U64,
                ..SpotPosition::default()
            }),
            ..User::default()
        };
        create_anchor_account_info!(maker, &maker_key, User, maker_account_info);
        let makers_and_referrers = UserMap::load_one(&maker_account_info).unwrap();

        let mut taker_stats = UserStats::default();

        let mut maker_stats = UserStats {
            authority: maker_authority,
            ..UserStats::default()
        };
        create_anchor_account_info!(maker_stats, UserStats, maker_stats_account_info);
        let maker_and_referrer_stats = UserStatsMap::load_one(&maker_stats_account_info).unwrap();

        assert_eq!(maker_stats.fuel_deposits, 0);
        assert_eq!(taker_stats.fuel_deposits, 0);

        let market_after = market_map.get_ref(&0).unwrap();
        assert_eq!(
            market_after.amm.base_asset_amount_with_amm,
            market.amm.base_asset_amount_with_amm
        );
        assert_eq!(taker.get_perp_position(0).unwrap().base_asset_amount, 0);
        now += 86400; // one day

        let maker_after: std::cell::RefMut<User> =
            makers_and_referrers.get_ref_mut(&maker_key).unwrap();
        let maker_stats_after = if maker.authority == taker.authority {
            None
        } else {
            Some(
                maker_and_referrer_stats
                    .get_ref_mut(&maker.authority)
                    .unwrap(),
            )
        }
        .unwrap();

        assert_eq!(
            maker_after.get_perp_position(0).unwrap().base_asset_amount,
            0
        );

        let margin_context =
            MarginContext::standard(MarginRequirementType::Initial).fuel_numerator(&maker, now);

        let margin_calc_maker = maker
            .calculate_margin_and_increment_fuel_bonus(
                &market_map,
                &spot_market_map,
                &mut oracle_map,
                margin_context,
                &mut maker_stats,
                now,
            )
            .unwrap();

        assert_eq!(margin_calc_maker.total_collateral, 10_000_000_000); // 10k

        assert_eq!(margin_calc_maker.fuel_deposits, 100_000 / 28);
        assert_eq!(maker_stats.fuel_deposits, margin_calc_maker.fuel_deposits);

        let margin_context =
            MarginContext::standard(MarginRequirementType::Initial).fuel_numerator(&taker, now);

        let margin_calc = taker
            .calculate_margin_and_increment_fuel_bonus(
                &market_map,
                &spot_market_map,
                &mut oracle_map,
                margin_context,
                &mut taker_stats,
                now,
            )
            .unwrap();

        assert_eq!(margin_calc.total_collateral, 100000000);

        assert_eq!(margin_calc.fuel_deposits, 1000 / 28);
        assert_eq!(taker_stats.fuel_deposits, margin_calc.fuel_deposits);
    }
}
