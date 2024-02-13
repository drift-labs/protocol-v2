use anchor_lang::prelude::Pubkey;
use anchor_lang::Owner;

use crate::math::constants::ONE_BPS_DENOMINATOR;
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
pub mod amm_lp_jit {
    use std::str::FromStr;

    use crate::controller::orders::fulfill_perp_order;
    use crate::controller::position::PositionDirection;
    use crate::create_account_info;
    use crate::create_anchor_account_info;
    use crate::math::constants::{
        PERCENTAGE_PRECISION_I128, PRICE_PRECISION_I64, QUOTE_PRECISION_I64,
    };

    use crate::math::amm_jit::calculate_amm_jit_liquidity;
    use crate::math::amm_spread::calculate_inventory_liquidity_ratio;
    use crate::math::constants::{
        AMM_RESERVE_PRECISION, BASE_PRECISION_I128, BASE_PRECISION_I64, BASE_PRECISION_U64,
        PEG_PRECISION, PRICE_PRECISION, SPOT_BALANCE_PRECISION_U64,
        SPOT_CUMULATIVE_INTEREST_PRECISION, SPOT_WEIGHT_PRECISION,
    };
    use crate::math::constants::{CONCENTRATION_PRECISION, PRICE_PRECISION_U64};
    use crate::state::fill_mode::FillMode;
    use crate::state::oracle::{HistoricalOracleData, OracleSource};
    use crate::state::perp_market::{AMMLiquiditySplit, MarketStatus, PerpMarket, AMM};
    use crate::state::perp_market_map::PerpMarketMap;
    use crate::state::spot_market::{SpotBalanceType, SpotMarket};
    use crate::state::spot_market_map::SpotMarketMap;
    use crate::state::user::{OrderStatus, OrderType, SpotPosition, User, UserStats};
    use crate::state::user_map::{UserMap, UserStatsMap};
    use crate::test_utils::*;
    use crate::test_utils::{get_orders, get_positions, get_pyth_price, get_spot_positions};
    use crate::validation::perp_market::validate_perp_market;

    use super::*;

    #[test]
    fn max_jit_amounts() {
        let oracle_price_key =
            Pubkey::from_str("J83w4HKfqxwcq3BEMMkPFSppX3gqekLyLJBexebFVkix").unwrap();
        let mut market = PerpMarket {
            amm: AMM {
                base_asset_reserve: 100 * AMM_RESERVE_PRECISION,
                quote_asset_reserve: 100 * AMM_RESERVE_PRECISION,
                base_asset_amount_per_lp: -505801343,
                quote_asset_amount_per_lp: 10715933,
                target_base_asset_amount_per_lp: -1000000000,
                base_asset_amount_with_amm: (AMM_RESERVE_PRECISION / 2) as i128,
                base_asset_amount_long: (AMM_RESERVE_PRECISION / 2) as i128,
                sqrt_k: 100 * AMM_RESERVE_PRECISION,
                peg_multiplier: 100 * PEG_PRECISION,
                max_slippage_ratio: 50,
                max_fill_reserve_fraction: 100,
                order_step_size: 1000,
                order_tick_size: 1,
                oracle: oracle_price_key,
                amm_jit_intensity: 200,
                base_spread: 20000,
                long_spread: 2000,
                short_spread: 2000,
                historical_oracle_data: HistoricalOracleData {
                    last_oracle_price: (100 * PRICE_PRECISION) as i64,
                    last_oracle_price_twap: (100 * PRICE_PRECISION) as i64,
                    last_oracle_price_twap_5min: (100 * PRICE_PRECISION) as i64,

                    ..HistoricalOracleData::default()
                },
                user_lp_shares: 10 * AMM_RESERVE_PRECISION, // some lps exist
                concentration_coef: CONCENTRATION_PRECISION + 1,
                ..AMM::default()
            },
            margin_ratio_initial: 1000,
            margin_ratio_maintenance: 500,
            status: MarketStatus::Initialized,
            ..PerpMarket::default_test()
        };

        let jit_base_asset_amount = crate::math::amm_jit::calculate_jit_base_asset_amount(
            &market,
            BASE_PRECISION_U64,
            100 * PRICE_PRECISION_U64,
            Some(100 * PRICE_PRECISION_I64),
            PositionDirection::Short,
            AMMLiquiditySplit::Shared,
        )
        .unwrap();
        assert_eq!(jit_base_asset_amount, 500000000);

        let jit_base_asset_amount = crate::math::amm_jit::calculate_jit_base_asset_amount(
            &market,
            BASE_PRECISION_U64,
            100 * PRICE_PRECISION_U64,
            Some(100 * PRICE_PRECISION_I64),
            PositionDirection::Long,
            AMMLiquiditySplit::Shared,
        )
        .unwrap();
        assert_eq!(jit_base_asset_amount, 500000000);

        let jit_base_asset_amount = crate::math::amm_jit::calculate_jit_base_asset_amount(
            &market,
            BASE_PRECISION_U64,
            99_920_000,
            Some(100 * PRICE_PRECISION_I64),
            PositionDirection::Long,
            AMMLiquiditySplit::Shared,
        )
        .unwrap();
        assert_eq!(jit_base_asset_amount, 300000000);

        let jit_base_asset_amount = crate::math::amm_jit::calculate_jit_base_asset_amount(
            &market,
            BASE_PRECISION_U64,
            99 * PRICE_PRECISION_U64,
            Some(100 * PRICE_PRECISION_I64),
            PositionDirection::Long,
            AMMLiquiditySplit::Shared,
        )
        .unwrap();
        assert_eq!(jit_base_asset_amount, 0);

        market.amm.long_spread = 11000;
        market.amm.short_spread = 11000;

        let jit_base_asset_amount = crate::math::amm_jit::calculate_jit_base_asset_amount(
            &market,
            BASE_PRECISION_U64,
            99 * PRICE_PRECISION_U64,
            Some(100 * PRICE_PRECISION_I64),
            PositionDirection::Long,
            AMMLiquiditySplit::Shared,
        )
        .unwrap();
        assert_eq!(jit_base_asset_amount, 45454000);

        let jit_base_asset_amount = crate::math::amm_jit::calculate_jit_base_asset_amount(
            &market,
            BASE_PRECISION_U64,
            101 * PRICE_PRECISION_U64,
            Some(100 * PRICE_PRECISION_I64),
            PositionDirection::Short,
            AMMLiquiditySplit::Shared,
        )
        .unwrap();
        assert_eq!(jit_base_asset_amount, 45454000);

        let jit_base_asset_amount = crate::math::amm_jit::calculate_jit_base_asset_amount(
            &market,
            BASE_PRECISION_U64,
            102 * PRICE_PRECISION_U64,
            Some(100 * PRICE_PRECISION_I64),
            PositionDirection::Short,
            AMMLiquiditySplit::Shared,
        )
        .unwrap();
        assert_eq!(jit_base_asset_amount, 0);

        let jit_base_asset_amount = crate::math::amm_jit::calculate_jit_base_asset_amount(
            &market,
            BASE_PRECISION_U64,
            104 * PRICE_PRECISION_U64,
            Some(100 * PRICE_PRECISION_I64),
            PositionDirection::Short,
            AMMLiquiditySplit::Shared,
        )
        .unwrap();
        assert_eq!(jit_base_asset_amount, 0);

        market.amm.short_spread = 20000;

        let jit_base_asset_amount = crate::math::amm_jit::calculate_jit_base_asset_amount(
            &market,
            BASE_PRECISION_U64,
            104 * PRICE_PRECISION_U64,
            Some(100 * PRICE_PRECISION_I64),
            PositionDirection::Short,
            AMMLiquiditySplit::Shared,
        )
        .unwrap();
        assert_eq!(jit_base_asset_amount, 0);

        let jit_base_asset_amount = crate::math::amm_jit::calculate_jit_base_asset_amount(
            &market,
            BASE_PRECISION_U64,
            105 * PRICE_PRECISION_U64,
            Some(100 * PRICE_PRECISION_I64),
            PositionDirection::Short,
            AMMLiquiditySplit::Shared,
        )
        .unwrap();
        assert_eq!(jit_base_asset_amount, 0);

        market.amm.long_spread = 51000;
        let jit_base_asset_amount = crate::math::amm_jit::calculate_jit_base_asset_amount(
            &market,
            BASE_PRECISION_U64,
            105 * PRICE_PRECISION_U64,
            Some(100 * PRICE_PRECISION_I64),
            PositionDirection::Short,
            AMMLiquiditySplit::Shared,
        )
        .unwrap();
        assert_eq!(jit_base_asset_amount, 9803000);

        let jit_base_asset_amount = crate::math::amm_jit::calculate_jit_base_asset_amount(
            &market,
            BASE_PRECISION_U64,
            95 * PRICE_PRECISION_U64,
            Some(100 * PRICE_PRECISION_I64),
            PositionDirection::Long,
            AMMLiquiditySplit::Shared,
        )
        .unwrap();
        assert_eq!(jit_base_asset_amount, 0);
    }

    #[test]
    fn zero_asks_with_amm_lp_jit_taker_long() {
        let oracle_price_key =
            Pubkey::from_str("J83w4HKfqxwcq3BEMMkPFSppX3gqekLyLJBexebFVkix").unwrap();

        let mut market = PerpMarket {
            amm: AMM {
                base_asset_reserve: 100 * AMM_RESERVE_PRECISION,
                quote_asset_reserve: 100 * AMM_RESERVE_PRECISION,
                base_asset_amount_per_lp: -505801343,
                quote_asset_amount_per_lp: 10715933,
                target_base_asset_amount_per_lp: -1000000000,
                base_asset_amount_with_amm: (AMM_RESERVE_PRECISION / 2) as i128,
                base_asset_amount_long: (AMM_RESERVE_PRECISION / 2) as i128,
                sqrt_k: 100 * AMM_RESERVE_PRECISION,
                peg_multiplier: 100 * PEG_PRECISION,
                max_slippage_ratio: 50,
                max_fill_reserve_fraction: 100,
                order_step_size: 1000,
                order_tick_size: 1,
                oracle: oracle_price_key,
                amm_jit_intensity: 200,
                base_spread: 20000,
                long_spread: 20000,
                short_spread: 20000,
                historical_oracle_data: HistoricalOracleData {
                    last_oracle_price: (100 * PRICE_PRECISION) as i64,
                    last_oracle_price_twap: (100 * PRICE_PRECISION) as i64,
                    last_oracle_price_twap_5min: (100 * PRICE_PRECISION) as i64,

                    ..HistoricalOracleData::default()
                },
                user_lp_shares: 10 * AMM_RESERVE_PRECISION, // some lps exist
                concentration_coef: CONCENTRATION_PRECISION + 1,
                ..AMM::default()
            },
            margin_ratio_initial: 1000,
            margin_ratio_maintenance: 500,
            status: MarketStatus::Initialized,
            ..PerpMarket::default_test()
        };
        market.amm.base_asset_reserve = 0;
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

        let jit_base_asset_amount = crate::math::amm_jit::calculate_jit_base_asset_amount(
            &market,
            BASE_PRECISION_U64,
            100 * PRICE_PRECISION_U64,
            Some(100 * PRICE_PRECISION_I64),
            PositionDirection::Short,
            AMMLiquiditySplit::Shared,
        )
        .unwrap();
        assert_eq!(jit_base_asset_amount, 500000000);

        let jit_base_asset_amount = crate::math::amm_jit::calculate_jit_base_asset_amount(
            &market,
            BASE_PRECISION_U64,
            100 * PRICE_PRECISION_U64,
            Some(100 * PRICE_PRECISION_I64),
            PositionDirection::Long,
            AMMLiquiditySplit::Shared,
        )
        .unwrap();
        assert_eq!(jit_base_asset_amount, 500000000);

        let (jit_base_asset_amount, amm_liquidity_split) = calculate_amm_jit_liquidity(
            &mut market,
            PositionDirection::Short,
            100 * PRICE_PRECISION_U64,
            Some(100 * PRICE_PRECISION_I64),
            BASE_PRECISION_U64,
            BASE_PRECISION_U64,
            BASE_PRECISION_U64,
            false,
        )
        .unwrap();
        assert_eq!(amm_liquidity_split, AMMLiquiditySplit::ProtocolOwned);
        assert_eq!(jit_base_asset_amount, 500000000);
    }

    #[test]
    fn amm_lp_jit_amm_lp_same_side_imbalanced() {
        let oracle_price_key =
            Pubkey::from_str("J83w4HKfqxwcq3BEMMkPFSppX3gqekLyLJBexebFVkix").unwrap();

        let mut market = PerpMarket {
            amm: AMM {
                base_asset_reserve: 100 * AMM_RESERVE_PRECISION,
                quote_asset_reserve: 100 * AMM_RESERVE_PRECISION,
                base_asset_amount_per_lp: -505801343, // lps are long vs target, wants shorts
                quote_asset_amount_per_lp: 10715933,
                target_base_asset_amount_per_lp: -1000000000,
                base_asset_amount_with_amm: -((AMM_RESERVE_PRECISION / 2) as i128), // amm is too long vs target, wants shorts
                base_asset_amount_short: -((AMM_RESERVE_PRECISION / 2) as i128),
                sqrt_k: 100 * AMM_RESERVE_PRECISION,
                peg_multiplier: 100 * PEG_PRECISION,
                max_slippage_ratio: 50,
                max_fill_reserve_fraction: 100,
                order_step_size: 1000,
                order_tick_size: 1,
                oracle: oracle_price_key,
                amm_jit_intensity: 200,
                base_spread: 20000,
                long_spread: 20000,
                short_spread: 20000,
                historical_oracle_data: HistoricalOracleData {
                    last_oracle_price: (100 * PRICE_PRECISION) as i64,
                    last_oracle_price_twap: (100 * PRICE_PRECISION) as i64,
                    last_oracle_price_twap_5min: (100 * PRICE_PRECISION) as i64,

                    ..HistoricalOracleData::default()
                },
                user_lp_shares: 10 * AMM_RESERVE_PRECISION, // some lps exist
                concentration_coef: CONCENTRATION_PRECISION + 1,
                ..AMM::default()
            },
            margin_ratio_initial: 1000,
            margin_ratio_maintenance: 500,
            status: MarketStatus::Initialized,
            ..PerpMarket::default_test()
        };
        market.amm.max_base_asset_reserve = u64::MAX as u128;
        market.amm.min_base_asset_reserve = 0;

        // lp needs nearly 5 base to get to target
        assert_eq!(
            market.amm.imbalanced_base_asset_amount_with_lp().unwrap(),
            4_941_986_570
        );

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

        let amm_inventory_pct = calculate_inventory_liquidity_ratio(
            market.amm.base_asset_amount_with_amm,
            market.amm.base_asset_reserve,
            market.amm.min_base_asset_reserve,
            market.amm.max_base_asset_reserve,
        )
        .unwrap();
        assert_eq!(amm_inventory_pct, PERCENTAGE_PRECISION_I128 / 200); // .5% of amm inventory is in position

        // maker order satisfies taker, vAMM doing match
        let (jit_base_asset_amount, amm_liquidity_split) = calculate_amm_jit_liquidity(
            &mut market,
            PositionDirection::Long,
            100 * PRICE_PRECISION_U64,
            Some(100 * PRICE_PRECISION_I64),
            BASE_PRECISION_U64,
            BASE_PRECISION_U64,
            BASE_PRECISION_U64,
            false,
        )
        .unwrap();
        assert_eq!(amm_liquidity_split, AMMLiquiditySplit::Shared);
        assert_eq!(jit_base_asset_amount, 500000000);

        // taker order is heading to vAMM
        let (jit_base_asset_amount, amm_liquidity_split) = calculate_amm_jit_liquidity(
            &mut market,
            PositionDirection::Long,
            100 * PRICE_PRECISION_U64,
            Some(100 * PRICE_PRECISION_I64),
            BASE_PRECISION_U64,
            BASE_PRECISION_U64 * 2,
            BASE_PRECISION_U64,
            false,
        )
        .unwrap();
        assert_eq!(amm_liquidity_split, AMMLiquiditySplit::ProtocolOwned);
        assert_eq!(jit_base_asset_amount, 0); // its coming anyways

        // no jit for additional long (more shorts for amm)
        let (jit_base_asset_amount, amm_liquidity_split) = calculate_amm_jit_liquidity(
            &mut market,
            PositionDirection::Long,
            100 * PRICE_PRECISION_U64,
            Some(100 * PRICE_PRECISION_I64),
            BASE_PRECISION_U64,
            BASE_PRECISION_U64 * 100,
            BASE_PRECISION_U64 * 100,
            false,
        )
        .unwrap();
        assert_eq!(amm_liquidity_split, AMMLiquiditySplit::Shared);
        assert_eq!(jit_base_asset_amount, 500000000);

        // wrong direction (increases lp and vamm inventory)
        let (jit_base_asset_amount, amm_liquidity_split) = calculate_amm_jit_liquidity(
            &mut market,
            PositionDirection::Short,
            100 * PRICE_PRECISION_U64,
            Some(100 * PRICE_PRECISION_I64),
            BASE_PRECISION_U64,
            BASE_PRECISION_U64,
            BASE_PRECISION_U64,
            false,
        )
        .unwrap();
        assert_eq!(amm_liquidity_split, AMMLiquiditySplit::ProtocolOwned);
        assert_eq!(jit_base_asset_amount, 0);
    }

    #[test]
    fn no_fulfill_with_amm_lp_jit_taker_long() {
        let now = 0_i64;
        let slot = 0_u64;

        let mut oracle_price = get_pyth_price(21, 6);
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
                base_asset_amount_per_lp: -505801343,
                quote_asset_amount_per_lp: 10715933,
                target_base_asset_amount_per_lp: -500000000,
                base_asset_amount_with_amm: (AMM_RESERVE_PRECISION / 2) as i128,
                base_asset_amount_long: (AMM_RESERVE_PRECISION / 2) as i128,
                sqrt_k: 100 * AMM_RESERVE_PRECISION,
                peg_multiplier: 100 * PEG_PRECISION,
                max_slippage_ratio: 50,
                max_fill_reserve_fraction: 100,
                order_step_size: 1000,
                order_tick_size: 1,
                oracle: oracle_price_key,
                amm_jit_intensity: 200,
                base_spread: 20000,
                long_spread: 20000,
                short_spread: 20000,
                historical_oracle_data: HistoricalOracleData {
                    last_oracle_price: (21 * PRICE_PRECISION) as i64,
                    last_oracle_price_twap: (21 * PRICE_PRECISION) as i64,
                    last_oracle_price_twap_5min: (21 * PRICE_PRECISION) as i64,

                    ..HistoricalOracleData::default()
                },
                user_lp_shares: 10 * AMM_RESERVE_PRECISION, // some lps exist
                concentration_coef: CONCENTRATION_PRECISION + 1,
                ..AMM::default()
            },
            margin_ratio_initial: 1000,
            margin_ratio_maintenance: 500,
            status: MarketStatus::Active,
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
                auction_start_price: 0,
                auction_end_price: 100 * PRICE_PRECISION_I64,
                price: 100 * PRICE_PRECISION_U64,
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

        let mut filler_stats = UserStats::default();

        fulfill_perp_order(
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

        let market_after = market_map.get_ref(&0).unwrap();
        // amm jit doesnt take anything
        assert_eq!(
            market_after.amm.base_asset_amount_with_amm,
            market.amm.base_asset_amount_with_amm
        );
        assert_eq!(
            market_after.amm.base_asset_amount_per_lp,
            market.amm.base_asset_amount_per_lp
        );
        assert_eq!(
            market_after.amm.quote_asset_amount_per_lp,
            market.amm.quote_asset_amount_per_lp
        );
        assert_eq!(market_after.amm.total_fee_minus_distributions, 7500);
        assert_eq!(market_after.amm.total_exchange_fee, 7500);
    }

    #[test]
    fn fulfill_with_amm_lp_jit_small_maker_order() {
        let now = 0_i64;
        let slot = 5_u64;

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
                base_asset_amount_per_lp: -505801343,
                quote_asset_amount_per_lp: 10715933,
                target_base_asset_amount_per_lp: -1000000000,
                bid_base_asset_reserve: 101 * AMM_RESERVE_PRECISION,
                bid_quote_asset_reserve: 99 * AMM_RESERVE_PRECISION,
                ask_base_asset_reserve: 99 * AMM_RESERVE_PRECISION,
                ask_quote_asset_reserve: 101 * AMM_RESERVE_PRECISION,
                base_asset_amount_with_amm: -((AMM_RESERVE_PRECISION / 2) as i128),
                base_asset_amount_short: -((AMM_RESERVE_PRECISION / 2) as i128),
                sqrt_k: 100 * AMM_RESERVE_PRECISION,
                peg_multiplier: 90 * PEG_PRECISION,
                max_slippage_ratio: 50,
                max_fill_reserve_fraction: 100,
                order_step_size: 10000000,
                order_tick_size: 1,
                oracle: oracle_price_key,
                amm_jit_intensity: 200,
                historical_oracle_data: HistoricalOracleData {
                    last_oracle_price: (100 * PRICE_PRECISION) as i64,
                    last_oracle_price_twap: (100 * PRICE_PRECISION) as i64,
                    last_oracle_price_twap_5min: (100 * PRICE_PRECISION) as i64,

                    ..HistoricalOracleData::default()
                },
                user_lp_shares: 10 * AMM_RESERVE_PRECISION, // some lps exist
                concentration_coef: CONCENTRATION_PRECISION + 1,
                ..AMM::default()
            },
            margin_ratio_initial: 1000,
            margin_ratio_maintenance: 500,
            status: MarketStatus::Initialized,
            ..PerpMarket::default_test()
        };
        market.amm.max_base_asset_reserve = u64::MAX as u128;
        market.amm.min_base_asset_reserve = 0;

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
                base_asset_amount: BASE_PRECISION_U64 / 2 + BASE_PRECISION_U64 * 2, // if amm takes half it would flip
                slot: 0,
                price: 100 * PRICE_PRECISION as u64,
                auction_start_price: 0,
                auction_end_price: 200 * PRICE_PRECISION_I64,
                auction_duration: 10,
                ..Order::default()
            }),
            perp_positions: get_positions(PerpPosition {
                market_index: 0,
                open_orders: 1,
                open_bids: BASE_PRECISION_I64 / 2 + BASE_PRECISION_I64 * 2,
                ..PerpPosition::default()
            }),
            spot_positions: get_spot_positions(SpotPosition {
                market_index: 0,
                balance_type: SpotBalanceType::Deposit,
                scaled_balance: 1000 * SPOT_BALANCE_PRECISION_U64,
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
                base_asset_amount: BASE_PRECISION_U64 + BASE_PRECISION_U64 / 2, // maker wants full = amm wants BASE_PERCISION
                price: 99 * PRICE_PRECISION_U64,
                ..Order::default()
            }),
            perp_positions: get_positions(PerpPosition {
                market_index: 0,
                open_orders: 1,
                open_asks: -(BASE_PRECISION_I64 + BASE_PRECISION_I64 / 2),
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

        let mut filler_stats = UserStats::default();

        assert_eq!(market.amm.total_fee, 0);
        assert_eq!(market.amm.total_fee_minus_distributions, 0);
        assert_eq!(market.amm.net_revenue_since_last_funding, 0);
        assert_eq!(market.amm.total_mm_fee, 0);
        assert_eq!(market.amm.total_fee_withdrawn, 0);

        fulfill_perp_order(
            &mut taker,
            0,
            &taker_key,
            &mut taker_stats,
            &makers_and_referrers,
            &maker_and_referrer_stats,
            &[(maker_key, 0, 99 * PRICE_PRECISION_U64)],
            &mut Some(&mut filler),
            &filler_key,
            &mut Some(&mut filler_stats),
            None,
            &spot_market_map,
            &market_map,
            &mut oracle_map,
            &fee_structure,
            0,
            Some(PRICE_PRECISION_I64),
            now,
            slot,
            10,
            true,
            FillMode::Fill,
        )
        .unwrap();

        // maker got full size
        let maker = makers_and_referrers.get_ref_mut(&maker_key).unwrap();
        let maker_position = &maker.perp_positions[0];
        assert_eq!(
            maker_position.base_asset_amount,
            -(BASE_PRECISION_I64 + BASE_PRECISION_I64 / 2)
        );

        // nets to zero
        let market_after = market_map.get_ref(&0).unwrap();

        // make sure lps got more
        assert_eq!(market_after.amm.base_asset_amount_per_lp, -510801343);
        assert_eq!(market_after.amm.base_asset_amount_with_amm, -50000000);
        assert_eq!(
            market_after.amm.base_asset_amount_with_unsettled_lp,
            50000000
        );

        assert!(market_after.amm.base_asset_amount_per_lp != market.amm.base_asset_amount_per_lp);
        assert!(market_after.amm.quote_asset_amount_per_lp != market.amm.quote_asset_amount_per_lp);
        assert_eq!(market_after.amm.total_fee_minus_distributions, 2488712); //2510987 would-be w/o LP
        assert_eq!(market_after.amm.total_exchange_fee, 47025);
    }

    #[test]
    fn fulfill_with_amm_lp_jit_taker_long_max_amount() {
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
        let mut oracle_map = OracleMap::load_one(&oracle_account_info, slot, None).unwrap();

        // net users are short
        let mut market = PerpMarket {
            amm: AMM {
                base_asset_reserve: 100 * AMM_RESERVE_PRECISION,
                quote_asset_reserve: 100 * AMM_RESERVE_PRECISION,
                base_asset_amount_per_lp: -505801343,
                quote_asset_amount_per_lp: 10715933,
                target_base_asset_amount_per_lp: -1000000000,
                bid_base_asset_reserve: 101 * AMM_RESERVE_PRECISION,
                bid_quote_asset_reserve: 99 * AMM_RESERVE_PRECISION,
                ask_base_asset_reserve: 99 * AMM_RESERVE_PRECISION,
                ask_quote_asset_reserve: 101 * AMM_RESERVE_PRECISION,
                base_asset_amount_with_amm: -((AMM_RESERVE_PRECISION / 2) as i128),
                base_asset_amount_short: -((AMM_RESERVE_PRECISION / 2) as i128),
                sqrt_k: 100 * AMM_RESERVE_PRECISION,
                peg_multiplier: 100 * PEG_PRECISION,
                max_slippage_ratio: 50,
                max_fill_reserve_fraction: 100,
                order_step_size: 10000000,
                order_tick_size: 1,
                oracle: oracle_price_key,
                amm_jit_intensity: 200,
                historical_oracle_data: HistoricalOracleData {
                    last_oracle_price: (100 * PRICE_PRECISION) as i64,
                    last_oracle_price_twap: (100 * PRICE_PRECISION) as i64,
                    last_oracle_price_twap_5min: (100 * PRICE_PRECISION) as i64,

                    ..HistoricalOracleData::default()
                },
                user_lp_shares: 10 * AMM_RESERVE_PRECISION, // some lps exist
                concentration_coef: CONCENTRATION_PRECISION + 1,
                ..AMM::default()
            },
            margin_ratio_initial: 1000,
            margin_ratio_maintenance: 500,
            status: MarketStatus::Initialized,
            ..PerpMarket::default_test()
        };
        market.amm.max_base_asset_reserve = u64::MAX as u128;
        market.amm.min_base_asset_reserve = 0;

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
                base_asset_amount: BASE_PRECISION_U64 * 2, // if amm takes half it would flip
                slot: 0,
                price: 100 * PRICE_PRECISION as u64,
                auction_start_price: 0,
                auction_end_price: 100 * PRICE_PRECISION_I64,
                auction_duration: 0,
                ..Order::default()
            }),
            perp_positions: get_positions(PerpPosition {
                market_index: 0,
                open_orders: 1,
                open_bids: BASE_PRECISION_I64 * 2,
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
                base_asset_amount: BASE_PRECISION_U64 * 2, // maker wants full = amm wants BASE_PERCISION
                price: 99 * PRICE_PRECISION_U64,
                ..Order::default()
            }),
            perp_positions: get_positions(PerpPosition {
                market_index: 0,
                open_orders: 1,
                open_asks: -BASE_PRECISION_I64 * 2,
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

        let mut filler_stats = UserStats::default();

        assert_eq!(market.amm.total_fee, 0);
        assert_eq!(market.amm.total_fee_minus_distributions, 0);
        assert_eq!(market.amm.net_revenue_since_last_funding, 0);
        assert_eq!(market.amm.total_mm_fee, 0);
        assert_eq!(market.amm.total_fee_withdrawn, 0);

        fulfill_perp_order(
            &mut taker,
            0,
            &taker_key,
            &mut taker_stats,
            &makers_and_referrers,
            &maker_and_referrer_stats,
            &[(maker_key, 0, 99 * PRICE_PRECISION_U64)],
            &mut Some(&mut filler),
            &filler_key,
            &mut Some(&mut filler_stats),
            None,
            &spot_market_map,
            &market_map,
            &mut oracle_map,
            &fee_structure,
            0,
            Some(PRICE_PRECISION_I64),
            now,
            slot,
            10,
            true,
            FillMode::Fill,
        )
        .unwrap();

        assert_eq!(market.amm.base_asset_amount_with_amm, -500000000);
        assert_eq!(market.amm.base_asset_amount_per_lp, -505801343);

        let market_after = market_map.get_ref(&0).unwrap();

        // make sure moves closer TODO
        assert_eq!(market_after.amm.base_asset_amount_per_lp, -510801343);

        // nets to zero
        assert_eq!(market_after.amm.base_asset_amount_with_amm, -50000000);
        assert_eq!(
            market_after.amm.base_asset_amount_with_unsettled_lp,
            50000000
        );

        let maker = makers_and_referrers.get_ref_mut(&maker_key).unwrap();
        let maker_position: &PerpPosition = &maker.perp_positions[0];
        // maker got (full - net_baa)
        assert_eq!(
            maker_position.base_asset_amount as i128,
            -BASE_PRECISION_I128 * 2 - market.amm.base_asset_amount_with_amm
        );

        let taker_position: &PerpPosition = &taker.perp_positions[0];
        assert_eq!(
            taker_position.base_asset_amount as i128,
            BASE_PRECISION_I128 * 2
        );
    }

    #[test]
    fn fulfill_with_amm_lp_only_jit_taker_long_max_amount() {
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
        let mut oracle_map = OracleMap::load_one(&oracle_account_info, slot, None).unwrap();

        // net users are short
        let mut market = PerpMarket {
            amm: AMM {
                base_asset_reserve: 100 * AMM_RESERVE_PRECISION,
                quote_asset_reserve: 100 * AMM_RESERVE_PRECISION,
                terminal_quote_asset_reserve: 100 * AMM_RESERVE_PRECISION,
                base_asset_amount_per_lp: -505801343,
                quote_asset_amount_per_lp: 10715933,
                target_base_asset_amount_per_lp: -1000000000,
                bid_base_asset_reserve: 101 * AMM_RESERVE_PRECISION,
                bid_quote_asset_reserve: 99 * AMM_RESERVE_PRECISION,
                ask_base_asset_reserve: 99 * AMM_RESERVE_PRECISION,
                ask_quote_asset_reserve: 101 * AMM_RESERVE_PRECISION,
                base_asset_amount_with_amm: 0,
                base_asset_amount_long: ((166 * AMM_RESERVE_PRECISION / 2) as i128),
                base_asset_amount_short: -((166 * AMM_RESERVE_PRECISION / 2) as i128),
                sqrt_k: 100 * AMM_RESERVE_PRECISION,
                peg_multiplier: 100 * PEG_PRECISION,
                max_slippage_ratio: 50,
                max_fill_reserve_fraction: 100,
                order_step_size: 10000000,
                order_tick_size: 1,
                oracle: oracle_price_key,
                amm_jit_intensity: 200,
                historical_oracle_data: HistoricalOracleData {
                    last_oracle_price: (100 * PRICE_PRECISION) as i64,
                    last_oracle_price_twap: (100 * PRICE_PRECISION) as i64,
                    last_oracle_price_twap_5min: (100 * PRICE_PRECISION) as i64,

                    ..HistoricalOracleData::default()
                },
                user_lp_shares: 10 * AMM_RESERVE_PRECISION, // some lps exist
                concentration_coef: CONCENTRATION_PRECISION + 1,
                ..AMM::default()
            },
            margin_ratio_initial: 1000,
            margin_ratio_maintenance: 500,
            status: MarketStatus::Initialized,
            ..PerpMarket::default_test()
        };
        market.amm.max_base_asset_reserve = u64::MAX as u128;
        market.amm.min_base_asset_reserve = 0;

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
                base_asset_amount: BASE_PRECISION_U64 * 2, // if amm takes half it would flip
                slot: 0,
                price: 100 * PRICE_PRECISION as u64,
                auction_start_price: 0,
                auction_end_price: 100 * PRICE_PRECISION_I64,
                auction_duration: 0,
                ..Order::default()
            }),
            perp_positions: get_positions(PerpPosition {
                market_index: 0,
                open_orders: 1,
                open_bids: BASE_PRECISION_I64 * 2,
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
                base_asset_amount: BASE_PRECISION_U64 * 2, // maker wants full = amm wants BASE_PERCISION
                price: 99 * PRICE_PRECISION_U64,
                ..Order::default()
            }),
            perp_positions: get_positions(PerpPosition {
                market_index: 0,
                open_orders: 1,
                open_asks: -BASE_PRECISION_I64 * 2,
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

        let mut filler_stats = UserStats::default();

        assert_eq!(market.amm.total_fee, 0);
        assert_eq!(market.amm.total_fee_minus_distributions, 0);
        assert_eq!(market.amm.net_revenue_since_last_funding, 0);
        assert_eq!(market.amm.total_mm_fee, 0);
        assert_eq!(market.amm.total_fee_withdrawn, 0);

        fulfill_perp_order(
            &mut taker,
            0,
            &taker_key,
            &mut taker_stats,
            &makers_and_referrers,
            &maker_and_referrer_stats,
            &[(maker_key, 0, 99 * PRICE_PRECISION_U64)],
            &mut Some(&mut filler),
            &filler_key,
            &mut Some(&mut filler_stats),
            None,
            &spot_market_map,
            &market_map,
            &mut oracle_map,
            &fee_structure,
            0,
            Some(PRICE_PRECISION_I64),
            now,
            slot,
            10,
            true,
            FillMode::Fill,
        )
        .unwrap();

        assert_eq!(market.amm.base_asset_amount_per_lp, -505801343);
        assert_eq!(market.amm.quote_asset_amount_per_lp, 10715933);

        let market_after = market_map.get_ref(&0).unwrap();

        // make sure moves closer
        assert_eq!(market_after.amm.base_asset_amount_per_lp, -605801343);
        assert_eq!(market_after.amm.quote_asset_amount_per_lp, 20619497);

        // nets to zero
        assert_eq!(market_after.amm.base_asset_amount_with_amm, 0);
        assert_eq!(market_after.amm.base_asset_amount_long, 85000000000);
        assert_eq!(market_after.amm.base_asset_amount_short, -84000000000);

        assert_eq!(
            market_after.amm.base_asset_amount_with_unsettled_lp,
            1000000000
        );
        validate_perp_market(&market).unwrap();
        validate_perp_market(&market_after).unwrap();

        let maker = makers_and_referrers.get_ref_mut(&maker_key).unwrap();
        let maker_position: &PerpPosition = &maker.perp_positions[0];
        // maker got (full - net_unsettled_lp)
        assert_eq!(
            maker_position.base_asset_amount as i128,
            -(BASE_PRECISION_I128 * 2) + market_after.amm.base_asset_amount_with_unsettled_lp
        );

        let taker_position: &PerpPosition = &taker.perp_positions[0];
        assert_eq!(
            taker_position.base_asset_amount as i128,
            BASE_PRECISION_I128 * 2
        );
    }

    #[test]
    fn fulfill_with_amm_lp_jit_taker_short_max_amount() {
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
        let mut oracle_map = OracleMap::load_one(&oracle_account_info, slot, None).unwrap();

        // net users are short
        let mut market = PerpMarket {
            amm: AMM {
                base_asset_reserve: 100 * AMM_RESERVE_PRECISION,
                quote_asset_reserve: 100 * AMM_RESERVE_PRECISION,
                base_asset_amount_per_lp: -505801343,
                quote_asset_amount_per_lp: 10715933,
                target_base_asset_amount_per_lp: -500000000,
                bid_base_asset_reserve: 101 * AMM_RESERVE_PRECISION,
                bid_quote_asset_reserve: 99 * AMM_RESERVE_PRECISION,
                ask_base_asset_reserve: 99 * AMM_RESERVE_PRECISION,
                ask_quote_asset_reserve: 101 * AMM_RESERVE_PRECISION,
                base_asset_amount_with_amm: (AMM_RESERVE_PRECISION / 2) as i128,
                base_asset_amount_long: (AMM_RESERVE_PRECISION / 2) as i128,
                sqrt_k: 100 * AMM_RESERVE_PRECISION,
                peg_multiplier: 100 * PEG_PRECISION,
                max_slippage_ratio: 50,
                max_fill_reserve_fraction: 100,
                order_step_size: 10000000,
                order_tick_size: 1,
                oracle: oracle_price_key,
                amm_jit_intensity: 200,
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
            ..PerpMarket::default_test()
        };
        market.amm.max_base_asset_reserve = u64::MAX as u128;
        market.amm.min_base_asset_reserve = 0;

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
        let taker_mul: i64 = 20;
        let mut taker = User {
            orders: get_orders(Order {
                market_index: 0,
                status: OrderStatus::Open,
                order_type: OrderType::Market,
                direction: PositionDirection::Short,
                base_asset_amount: BASE_PRECISION_U64 * taker_mul as u64, // if amm takes half it would flip
                slot: 0,
                price: 100 * PRICE_PRECISION_U64,
                auction_start_price: 0,
                auction_end_price: 100 * PRICE_PRECISION_I64,
                auction_duration: 0,
                ..Order::default()
            }),
            perp_positions: get_positions(PerpPosition {
                market_index: 0,
                open_orders: 1,
                open_asks: -BASE_PRECISION_I64 * taker_mul,
                ..PerpPosition::default()
            }),
            spot_positions: get_spot_positions(SpotPosition {
                market_index: 0,
                balance_type: SpotBalanceType::Deposit,
                scaled_balance: 100 * SPOT_BALANCE_PRECISION_U64 * taker_mul as u64,
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
                direction: PositionDirection::Long,
                base_asset_amount: BASE_PRECISION_U64 * taker_mul as u64, // maker wants full = amm wants BASE_PERCISION
                price: 100 * PRICE_PRECISION_U64,
                ..Order::default()
            }),
            perp_positions: get_positions(PerpPosition {
                market_index: 0,
                open_orders: 1,
                open_bids: BASE_PRECISION_I64 * taker_mul,
                ..PerpPosition::default()
            }),
            spot_positions: get_spot_positions(SpotPosition {
                market_index: 0,
                balance_type: SpotBalanceType::Deposit,
                scaled_balance: 100 * 100 * SPOT_BALANCE_PRECISION_U64 * taker_mul as u64,
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
        let mut filler_stats = UserStats::default();

        assert_eq!(market.amm.total_fee, 0);
        assert_eq!(market.amm.total_fee_minus_distributions, 0);
        assert_eq!(market.amm.net_revenue_since_last_funding, 0);
        assert_eq!(market.amm.total_mm_fee, 0);
        assert_eq!(market.amm.total_fee_withdrawn, 0);

        fulfill_perp_order(
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
            Some(200 * PRICE_PRECISION_I64),
            now,
            slot,
            10,
            true,
            FillMode::Fill,
        )
        .unwrap();

        let market_after = market_map.get_ref(&0).unwrap();
        // nets to zero
        assert_eq!(market_after.amm.base_asset_amount_with_amm, 0);

        let maker = makers_and_referrers.get_ref_mut(&maker_key).unwrap();
        let maker_position = &maker.perp_positions[0];
        // maker got (full - net_baa)
        assert_eq!(
            maker_position.base_asset_amount as i128,
            BASE_PRECISION_I128 * taker_mul as i128 - market.amm.base_asset_amount_with_amm
        );
    }

    #[test]
    fn no_fulfill_with_amm_lp_jit_taker_short() {
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
        let mut oracle_map = OracleMap::load_one(&oracle_account_info, slot, None).unwrap();

        // amm is short
        let mut market = PerpMarket {
            amm: AMM {
                base_asset_reserve: 100 * AMM_RESERVE_PRECISION,
                quote_asset_reserve: 100 * AMM_RESERVE_PRECISION,
                base_asset_amount_per_lp: -505801343,
                quote_asset_amount_per_lp: 10715933,
                target_base_asset_amount_per_lp: -500000000,
                // bid_base_asset_reserve: 101 * AMM_RESERVE_PRECISION,
                // bid_quote_asset_reserve: 99 * AMM_RESERVE_PRECISION,
                // ask_base_asset_reserve: 99 * AMM_RESERVE_PRECISION,
                // ask_quote_asset_reserve: 101 * AMM_RESERVE_PRECISION,
                base_asset_amount_with_amm: -((AMM_RESERVE_PRECISION / 2) as i128),
                base_asset_amount_short: -((AMM_RESERVE_PRECISION / 2) as i128),
                sqrt_k: 100 * AMM_RESERVE_PRECISION,
                peg_multiplier: 100 * PEG_PRECISION,
                max_slippage_ratio: 50,
                max_fill_reserve_fraction: 100,
                order_step_size: 10000000,
                order_tick_size: 1,
                oracle: oracle_price_key,
                amm_jit_intensity: 200,
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

        let mut taker = User {
            orders: get_orders(Order {
                market_index: 0,
                status: OrderStatus::Open,
                order_type: OrderType::Market,
                direction: PositionDirection::Short, // doesnt improve balance
                base_asset_amount: BASE_PRECISION_U64,
                slot: 0,
                auction_start_price: 0,
                auction_end_price: 100 * PRICE_PRECISION_I64,
                auction_duration: 0,
                ..Order::default()
            }),
            perp_positions: get_positions(PerpPosition {
                market_index: 0,
                open_orders: 1,
                open_asks: -BASE_PRECISION_I64,
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
                direction: PositionDirection::Long,
                base_asset_amount: BASE_PRECISION_U64 / 2,
                price: 100 * PRICE_PRECISION_U64,
                ..Order::default()
            }),
            perp_positions: get_positions(PerpPosition {
                market_index: 0,
                open_orders: 1,
                open_bids: BASE_PRECISION_I64 / 2,
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
        let mut filler_stats = UserStats::default();

        let (base_asset_amount, _) = fulfill_perp_order(
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

        assert_eq!(base_asset_amount, BASE_PRECISION_U64);

        let taker_position = &taker.perp_positions[0];
        assert_eq!(taker_position.base_asset_amount, -BASE_PRECISION_I64);
        assert_eq!(taker.orders[0], Order::default());

        let maker = makers_and_referrers.get_ref_mut(&maker_key).unwrap();
        let maker_position = &maker.perp_positions[0];
        assert_eq!(maker_position.base_asset_amount, BASE_PRECISION_I64 / 2);
        assert_eq!(maker_position.quote_asset_amount, -49985000);
        assert_eq!(maker_position.quote_entry_amount, -50 * QUOTE_PRECISION_I64);
        assert_eq!(maker_position.quote_break_even_amount, -49985000);
        assert_eq!(maker_position.open_orders, 0);

        let market_after = market_map.get_ref(&0).unwrap();
        assert_eq!(market_after.amm.base_asset_amount_with_amm, -1000000000);
    }

    #[test]
    fn fulfill_with_amm_lp_jit_taker_short() {
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
        let mut oracle_map = OracleMap::load_one(&oracle_account_info, slot, None).unwrap();

        // net users are short
        let mut market = PerpMarket {
            amm: AMM {
                base_asset_reserve: 100 * AMM_RESERVE_PRECISION,
                quote_asset_reserve: 100 * AMM_RESERVE_PRECISION,
                base_asset_amount_per_lp: -505801343,
                quote_asset_amount_per_lp: 10715933,
                target_base_asset_amount_per_lp: -500000000,
                base_spread: 250,
                long_spread: 125,
                short_spread: 125,
                base_asset_amount_with_amm: (AMM_RESERVE_PRECISION / 2) as i128,
                base_asset_amount_long: (AMM_RESERVE_PRECISION / 2) as i128,
                sqrt_k: 100 * AMM_RESERVE_PRECISION,
                peg_multiplier: 100 * PEG_PRECISION,
                max_slippage_ratio: 50,
                max_fill_reserve_fraction: 100,
                order_step_size: 10000000,
                order_tick_size: 1,
                oracle: oracle_price_key,
                amm_jit_intensity: 200,
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
                direction: PositionDirection::Short,
                base_asset_amount: BASE_PRECISION_U64,
                slot: 0,
                auction_start_price: 0,
                auction_end_price: 100 * PRICE_PRECISION_I64,
                auction_duration: 0,
                ..Order::default()
            }),
            perp_positions: get_positions(PerpPosition {
                market_index: 0,
                open_orders: 1,
                open_asks: -BASE_PRECISION_I64,
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
                direction: PositionDirection::Long,
                base_asset_amount: BASE_PRECISION_U64 / 2,
                price: 100 * PRICE_PRECISION_U64,
                ..Order::default()
            }),
            perp_positions: get_positions(PerpPosition {
                market_index: 0,
                open_orders: 1,
                open_bids: BASE_PRECISION_I64 / 2,
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
        let mut filler_stats = UserStats::default();

        assert_eq!(market.amm.total_fee, 0);
        assert_eq!(market.amm.total_fee_minus_distributions, 0);
        assert_eq!(market.amm.net_revenue_since_last_funding, 0);
        assert_eq!(market.amm.total_mm_fee, 0);
        assert_eq!(market.amm.total_fee_withdrawn, 0);

        let (base_asset_amount, _) = fulfill_perp_order(
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

        // base is filled
        assert!(base_asset_amount > 0);

        let market_after = market_map.get_ref(&0).unwrap();
        assert!(
            market_after.amm.base_asset_amount_with_amm.abs()
                < market.amm.base_asset_amount_with_amm.abs()
        );

        let quote_asset_amount_surplus = market_after.amm.total_mm_fee - market.amm.total_mm_fee;
        assert!(quote_asset_amount_surplus > 0);
    }

    #[test]
    fn fulfill_with_amm_lp_jit_taker_long() {
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
        let mut oracle_map = OracleMap::load_one(&oracle_account_info, slot, None).unwrap();

        // net users are short
        let mut market = PerpMarket {
            amm: AMM {
                base_asset_reserve: 100 * AMM_RESERVE_PRECISION,
                quote_asset_reserve: 100 * AMM_RESERVE_PRECISION,
                base_asset_amount_per_lp: -505801343,
                quote_asset_amount_per_lp: 10715933,
                target_base_asset_amount_per_lp: -500000000,
                bid_base_asset_reserve: 101 * AMM_RESERVE_PRECISION,
                bid_quote_asset_reserve: 99 * AMM_RESERVE_PRECISION,
                ask_base_asset_reserve: 99 * AMM_RESERVE_PRECISION,
                ask_quote_asset_reserve: 101 * AMM_RESERVE_PRECISION,
                base_asset_amount_with_amm: -((AMM_RESERVE_PRECISION / 2) as i128),
                base_asset_amount_short: -((AMM_RESERVE_PRECISION / 2) as i128),
                sqrt_k: 100 * AMM_RESERVE_PRECISION,
                peg_multiplier: 100 * PEG_PRECISION,
                max_slippage_ratio: 50,
                max_fill_reserve_fraction: 100,
                order_step_size: 1000,
                order_tick_size: 1,
                oracle: oracle_price_key,
                amm_jit_intensity: 200,
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
                auction_start_price: 99 * PRICE_PRECISION_I64,
                auction_end_price: 100 * PRICE_PRECISION_I64,
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
                scaled_balance: 100 * SPOT_BALANCE_PRECISION_U64,
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
        let mut filler_stats = UserStats::default();

        let reserve_price_before = market.amm.reserve_price().unwrap();
        assert_eq!(reserve_price_before, 100 * PRICE_PRECISION_U64);

        fulfill_perp_order(
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

        // net baa improves
        let market_after = market_map.get_ref(&0).unwrap();
        assert!(
            market_after.amm.base_asset_amount_with_amm.abs()
                < market.amm.base_asset_amount_with_amm.abs()
        );
    }

    #[test]
    fn fulfill_with_amm_lp_jit_taker_long_neg_qas() {
        let now = 0_i64;
        let slot = 10_u64;

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
                base_asset_amount_per_lp: -505801343,
                quote_asset_amount_per_lp: 10715933,
                target_base_asset_amount_per_lp: -500000000,
                bid_base_asset_reserve: 101 * AMM_RESERVE_PRECISION,
                bid_quote_asset_reserve: 99 * AMM_RESERVE_PRECISION,
                ask_base_asset_reserve: 99 * AMM_RESERVE_PRECISION,
                ask_quote_asset_reserve: 101 * AMM_RESERVE_PRECISION,
                base_asset_amount_with_amm: -((AMM_RESERVE_PRECISION / 2) as i128),
                base_asset_amount_short: -((AMM_RESERVE_PRECISION / 2) as i128),
                sqrt_k: 100 * AMM_RESERVE_PRECISION,
                peg_multiplier: 100 * PEG_PRECISION,
                max_slippage_ratio: 50,
                max_fill_reserve_fraction: 100,
                order_step_size: 10000000,
                order_tick_size: 1,
                oracle: oracle_price_key,
                amm_jit_intensity: 200,
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
            ..PerpMarket::default_test()
        };
        market.amm.max_base_asset_reserve = u64::MAX as u128;
        market.amm.min_base_asset_reserve = 0;

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
                auction_start_price: 0,
                auction_end_price: 100 * PRICE_PRECISION_I64,
                auction_duration: 50, // !! amm will bid before the ask spread price
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
                price: 10 * PRICE_PRECISION_U64,
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
        let mut filler_stats = UserStats::default();

        assert_eq!(market.amm.total_fee, 0);
        assert_eq!(market.amm.total_fee_minus_distributions, 0);
        assert_eq!(market.amm.net_revenue_since_last_funding, 0);
        assert_eq!(market.amm.total_mm_fee, 0);
        assert_eq!(market.amm.total_fee_withdrawn, 0);

        // fulfill with match
        let (base_asset_amount, _) = fulfill_perp_order(
            &mut taker,
            0,
            &taker_key,
            &mut taker_stats,
            &makers_and_referrers,
            &maker_and_referrer_stats,
            &[(maker_key, 0, 10 * PRICE_PRECISION_U64)],
            &mut Some(&mut filler),
            &filler_key,
            &mut Some(&mut filler_stats),
            None,
            &spot_market_map,
            &market_map,
            &mut oracle_map,
            &fee_structure,
            0,
            Some(1),
            now,
            slot,
            10,
            true,
            FillMode::Fill,
        )
        .unwrap();

        assert_eq!(base_asset_amount, BASE_PRECISION_U64 * 3 / 4); // auctions not over so no amm fill

        let maker = makers_and_referrers.get_ref_mut(&maker_key).unwrap();
        let maker_position = &maker.perp_positions[0];
        assert_eq!(maker_position.base_asset_amount, -BASE_PRECISION_I64 / 2);

        let market_after = market_map.get_ref(&0).unwrap();
        assert_eq!(market_after.amm.base_asset_amount_with_amm, -250000000);

        let taker_position = &taker.perp_positions[0];
        assert_eq!(
            taker_position.base_asset_amount,
            BASE_PRECISION_I64 + market_after.amm.base_asset_amount_with_amm as i64
        );

        // market pays extra for trade
        let quote_asset_amount_surplus = market_after.amm.total_mm_fee - market.amm.total_mm_fee;
        assert!(quote_asset_amount_surplus < 0);
    }

    #[test]
    fn fulfill_with_amm_lp_jit_taker_short_neg_qas() {
        let now = 0_i64;
        let slot = 10_u64;

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
                base_asset_amount_per_lp: -505801343,
                quote_asset_amount_per_lp: 10715933,
                target_base_asset_amount_per_lp: -500000000,
                bid_base_asset_reserve: 101 * AMM_RESERVE_PRECISION,
                bid_quote_asset_reserve: 99 * AMM_RESERVE_PRECISION,
                ask_base_asset_reserve: 99 * AMM_RESERVE_PRECISION,
                ask_quote_asset_reserve: 101 * AMM_RESERVE_PRECISION,
                base_asset_amount_with_amm: (AMM_RESERVE_PRECISION / 2) as i128,
                base_asset_amount_long: (AMM_RESERVE_PRECISION / 2) as i128,
                sqrt_k: 100 * AMM_RESERVE_PRECISION,
                peg_multiplier: 100 * PEG_PRECISION,
                max_slippage_ratio: 50,
                max_fill_reserve_fraction: 100,
                order_step_size: 100,
                order_tick_size: 1,
                oracle: oracle_price_key,
                amm_jit_intensity: 200,
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
            ..PerpMarket::default_test()
        };
        market.amm.max_base_asset_reserve = u64::MAX as u128;
        market.amm.min_base_asset_reserve = 0;

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
                direction: PositionDirection::Short,
                base_asset_amount: BASE_PRECISION_U64,
                slot: 0,
                auction_end_price: 0,
                auction_start_price: 200 * PRICE_PRECISION as i64,
                auction_duration: 50, // !! amm will bid before the ask spread price
                ..Order::default()
            }),
            perp_positions: get_positions(PerpPosition {
                market_index: 0,
                open_orders: 1,
                open_asks: -BASE_PRECISION_I64,
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
                direction: PositionDirection::Long,
                base_asset_amount: BASE_PRECISION_U64 / 2,
                price: 200 * PRICE_PRECISION_U64,
                ..Order::default()
            }),
            perp_positions: get_positions(PerpPosition {
                market_index: 0,
                open_orders: 1,
                open_bids: BASE_PRECISION_I64 / 2,
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
        let mut filler_stats = UserStats::default();

        assert_eq!(market.amm.total_fee, 0);
        assert_eq!(market.amm.total_fee_minus_distributions, 0);
        assert_eq!(market.amm.net_revenue_since_last_funding, 0);
        assert_eq!(market.amm.total_mm_fee, 0);
        assert_eq!(market.amm.total_fee_withdrawn, 0);

        // fulfill with match
        let (base_asset_amount, _) = fulfill_perp_order(
            &mut taker,
            0,
            &taker_key,
            &mut taker_stats,
            &makers_and_referrers,
            &maker_and_referrer_stats,
            &[(maker_key, 0, 200 * PRICE_PRECISION_U64)],
            &mut Some(&mut filler),
            &filler_key,
            &mut Some(&mut filler_stats),
            None,
            &spot_market_map,
            &market_map,
            &mut oracle_map,
            &fee_structure,
            0,
            Some(200 * PRICE_PRECISION_I64),
            now,
            slot,
            10,
            true,
            FillMode::Fill,
        )
        .unwrap();

        assert_eq!(base_asset_amount, BASE_PRECISION_U64 * 3 / 4); // auctions not over so no amm fill

        let market_after = market_map.get_ref(&0).unwrap();

        let taker_position = &taker.perp_positions[0];
        assert_eq!(
            taker_position.base_asset_amount,
            -3 * BASE_PRECISION_I64 / 4
        );

        // mm gains from trade
        let quote_asset_amount_surplus = market_after.amm.total_mm_fee - market.amm.total_mm_fee;
        assert!(quote_asset_amount_surplus < 0);
    }

    #[allow(clippy::comparison_chain)]
    #[test]
    fn fulfill_with_amm_lp_jit_full_long() {
        let now = 0_i64;
        let mut slot = 0_u64;

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
        let reserves = 5 * AMM_RESERVE_PRECISION;
        let mut market = PerpMarket {
            amm: AMM {
                base_asset_reserve: reserves,
                quote_asset_reserve: reserves,
                base_asset_amount_with_amm: -(100 * AMM_RESERVE_PRECISION as i128),
                base_asset_amount_short: -(100 * AMM_RESERVE_PRECISION as i128),
                sqrt_k: reserves,
                peg_multiplier: 100 * PEG_PRECISION,
                max_slippage_ratio: 50,
                max_fill_reserve_fraction: 100,
                order_step_size: 1000,
                order_tick_size: 1,
                oracle: oracle_price_key,
                base_spread: 5000,
                max_spread: 1000000,
                long_spread: 50000,
                short_spread: 50000,
                amm_jit_intensity: 200,
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
        let auction_duration = 50;
        let mut taker = User {
            orders: get_orders(Order {
                market_index: 0,
                status: OrderStatus::Open,
                order_type: OrderType::Market,
                direction: PositionDirection::Long,
                base_asset_amount: 100 * BASE_PRECISION_U64,
                slot: 0,
                auction_duration,
                ..Order::default()
            }),
            perp_positions: get_positions(PerpPosition {
                market_index: 0,
                open_orders: 1,
                open_bids: -100 * BASE_PRECISION_I64,
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

        let auction_start_price = 95062500_i64;
        let auction_end_price = 132154089_i64;
        taker.orders[0].auction_start_price = auction_start_price;
        taker.orders[0].auction_end_price = auction_end_price;
        println!("start stop {} {}", auction_start_price, auction_end_price);

        let mut filler = User::default();

        let fee_structure = get_fee_structure();

        let (taker_key, _, filler_key) = get_user_keys();
        let maker_key = Pubkey::from_str("My11111111111111111111111111111111111111113").unwrap();
        let maker_authority =
            Pubkey::from_str("J83w4HKfqxwcq3BEMMkPFSppX3gqekLyLJBexebFVkix").unwrap();

        let mut taker_stats = UserStats::default();

        let mut maker_stats = UserStats {
            authority: maker_authority,
            ..UserStats::default()
        };
        create_anchor_account_info!(maker_stats, UserStats, maker_stats_account_info);
        let maker_and_referrer_stats = UserStatsMap::load_one(&maker_stats_account_info).unwrap();
        let mut filler_stats = UserStats::default();

        assert_eq!(market.amm.total_fee, 0);
        assert_eq!(market.amm.total_fee_minus_distributions, 0);
        assert_eq!(market.amm.net_revenue_since_last_funding, 0);
        assert_eq!(market.amm.total_mm_fee, 0);
        assert_eq!(market.amm.total_fee_withdrawn, 0);

        let (mut neg, mut pos, mut none) = (false, false, false);
        let mut prev_mm_fee = 0;
        let mut prev_net_baa = market.amm.base_asset_amount_with_amm;
        // track scaling
        let mut prev_qas = 0;
        let mut has_set_prev_qas = false;
        loop {
            println!("------");

            // compute auction price
            let is_complete = crate::math::auction::is_auction_complete(
                taker.orders[0].slot,
                auction_duration,
                slot,
            )
            .unwrap();
            if is_complete {
                break;
            }

            let auction_price =
                crate::math::auction::calculate_auction_price(&taker.orders[0], slot, 1, None)
                    .unwrap();
            let baa = market.amm.order_step_size * 4;

            let (mark, ask, bid) = {
                let market = market_map.get_ref(&0).unwrap();
                let mark = market.amm.reserve_price().unwrap();
                let ask = market.amm.ask_price(mark).unwrap();
                let bid = market.amm.bid_price(mark).unwrap();
                (mark, ask, bid)
            };
            println!("mark: {} bid ask: {} {}", mark, bid, ask);

            let mut maker = User {
                authority: maker_authority,
                orders: get_orders(Order {
                    market_index: 0,
                    post_only: true,
                    order_type: OrderType::Limit,
                    direction: PositionDirection::Short,
                    base_asset_amount: baa as u64,
                    price: auction_price,
                    ..Order::default()
                }),
                perp_positions: get_positions(PerpPosition {
                    market_index: 0,
                    open_orders: 1,
                    open_asks: -(baa as i64),
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

            // fulfill with match
            fulfill_perp_order(
                &mut taker,
                0,
                &taker_key,
                &mut taker_stats,
                &makers_and_referrers,
                &maker_and_referrer_stats,
                &[(maker_key, 0, auction_price)],
                &mut Some(&mut filler),
                &filler_key,
                &mut Some(&mut filler_stats),
                None,
                &spot_market_map,
                &market_map,
                &mut oracle_map,
                &fee_structure,
                0,
                Some(1),
                now,
                slot,
                auction_duration,
                true,
                FillMode::Fill,
            )
            .unwrap();

            let market_after = market_map.get_ref(&0).unwrap();
            let quote_asset_amount_surplus = market_after.amm.total_mm_fee - prev_mm_fee;
            prev_mm_fee = market_after.amm.total_mm_fee;

            // imbalance decreases
            assert!(market_after.amm.base_asset_amount_with_amm.abs() < prev_net_baa.abs());
            prev_net_baa = market_after.amm.base_asset_amount_with_amm;

            println!(
                "slot {} auction: {} surplus: {}",
                slot, auction_price, quote_asset_amount_surplus
            );

            if !has_set_prev_qas {
                prev_qas = quote_asset_amount_surplus;
                has_set_prev_qas = true;
            } else {
                // decreasing (amm paying less / earning more)
                assert!(prev_qas < quote_asset_amount_surplus);
                prev_qas = quote_asset_amount_surplus;
            }

            if quote_asset_amount_surplus < 0 {
                neg = true;
                assert!(!pos); // neg first
            } else if quote_asset_amount_surplus > 0 {
                pos = true;
                assert!(neg); // neg first
                              // sometimes skips over == 0 surplus
            } else {
                none = true;
                assert!(neg);
                assert!(!pos);
            }
            slot += 1;
        }
        // auction should go through both position and negative
        assert!(neg);
        assert!(pos);
        // assert!(none); //todo: skips over this (-1 -> 1)

        println!("{} {} {}", neg, pos, none);
    }

    #[allow(clippy::comparison_chain)]
    #[test]
    fn fulfill_with_amm_lp_jit_full_short() {
        let now = 0_i64;
        let mut slot = 0_u64;

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
        let reserves = 5 * AMM_RESERVE_PRECISION;
        let mut market = PerpMarket {
            amm: AMM {
                base_asset_reserve: reserves,
                quote_asset_reserve: reserves,
                base_asset_amount_with_amm: 100 * AMM_RESERVE_PRECISION as i128,
                base_asset_amount_long: 100 * AMM_RESERVE_PRECISION as i128,
                sqrt_k: reserves,
                peg_multiplier: 100 * PEG_PRECISION,
                max_slippage_ratio: 50,
                max_fill_reserve_fraction: 100,
                order_step_size: 1,
                order_tick_size: 1,
                oracle: oracle_price_key,
                base_spread: 5000,
                max_spread: 1000000,
                long_spread: 50000,
                short_spread: 50000,
                amm_jit_intensity: 200,
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
        let auction_duration = 50;
        let mut taker = User {
            orders: get_orders(Order {
                market_index: 0,
                status: OrderStatus::Open,
                order_type: OrderType::Market,
                direction: PositionDirection::Short,
                base_asset_amount: 100 * BASE_PRECISION_U64,
                slot: 0,
                auction_duration, // !! amm will bid before the ask spread price
                auction_end_price: 0,
                auction_start_price: 200 * PRICE_PRECISION as i64,
                ..Order::default()
            }),
            perp_positions: get_positions(PerpPosition {
                market_index: 0,
                open_orders: 1,
                open_asks: -100 * BASE_PRECISION_I64,
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

        let auction_start_price = 105062500;
        let auction_end_price = 79550209;
        taker.orders[0].auction_start_price = auction_start_price;
        taker.orders[0].auction_end_price = auction_end_price;
        println!("start stop {} {}", auction_start_price, auction_end_price);

        let mut filler = User::default();
        let fee_structure = get_fee_structure();

        let (taker_key, _, filler_key) = get_user_keys();
        let maker_key = Pubkey::from_str("My11111111111111111111111111111111111111113").unwrap();
        let maker_authority =
            Pubkey::from_str("J83w4HKfqxwcq3BEMMkPFSppX3gqekLyLJBexebFVkix").unwrap();

        let mut taker_stats = UserStats::default();

        let mut maker_stats = UserStats {
            authority: maker_authority,
            ..UserStats::default()
        };
        create_anchor_account_info!(maker_stats, UserStats, maker_stats_account_info);
        let maker_and_referrer_stats = UserStatsMap::load_one(&maker_stats_account_info).unwrap();
        let mut filler_stats = UserStats::default();

        assert_eq!(market.amm.total_fee, 0);
        assert_eq!(market.amm.total_fee_minus_distributions, 0);
        assert_eq!(market.amm.net_revenue_since_last_funding, 0);
        assert_eq!(market.amm.total_mm_fee, 0);
        assert_eq!(market.amm.total_fee_withdrawn, 0);

        let (mut neg, mut pos, mut none) = (false, false, false);
        let mut prev_mm_fee = 0;
        let mut prev_net_baa = market.amm.base_asset_amount_with_amm;
        // track scaling
        let mut prev_qas = 0;
        let mut has_set_prev_qas = false;

        loop {
            println!("------");

            // compute auction price
            let is_complete = crate::math::auction::is_auction_complete(
                taker.orders[0].slot,
                auction_duration,
                slot,
            )
            .unwrap();

            if is_complete {
                break;
            }

            let auction_price =
                crate::math::auction::calculate_auction_price(&taker.orders[0], slot, 1, None)
                    .unwrap();
            let baa = 1000 * 4;

            let (mark, ask, bid) = {
                let market = market_map.get_ref(&0).unwrap();
                let mark = market.amm.reserve_price().unwrap();
                let ask = market.amm.ask_price(mark).unwrap();
                let bid = market.amm.bid_price(mark).unwrap();
                (mark, ask, bid)
            };
            println!("mark: {} bid ask: {} {}", mark, bid, ask);

            let mut maker = User {
                authority: maker_authority,
                orders: get_orders(Order {
                    market_index: 0,
                    post_only: true,
                    order_type: OrderType::Limit,
                    direction: PositionDirection::Long,
                    base_asset_amount: baa as u64,
                    price: auction_price,
                    ..Order::default()
                }),
                perp_positions: get_positions(PerpPosition {
                    market_index: 0,
                    open_orders: 1,
                    open_bids: baa as i64,
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

            // fulfill with match
            fulfill_perp_order(
                &mut taker,
                0,
                &taker_key,
                &mut taker_stats,
                &makers_and_referrers,
                &maker_and_referrer_stats,
                &[(maker_key, 0, auction_price)],
                &mut Some(&mut filler),
                &filler_key,
                &mut Some(&mut filler_stats),
                None,
                &spot_market_map,
                &market_map,
                &mut oracle_map,
                &fee_structure,
                0,
                Some(200 * PRICE_PRECISION_I64),
                now,
                slot,
                10,
                true,
                FillMode::Fill,
            )
            .unwrap();

            let market_after = market_map.get_ref(&0).unwrap();
            let quote_asset_amount_surplus = market_after.amm.total_mm_fee - prev_mm_fee;
            prev_mm_fee = market_after.amm.total_mm_fee;

            // imbalance decreases or remains the same (damm wont always take on positions)
            assert!(market_after.amm.base_asset_amount_with_amm.abs() <= prev_net_baa.abs());
            prev_net_baa = market_after.amm.base_asset_amount_with_amm;

            println!(
                "slot {} auction: {} surplus: {}",
                slot, auction_price, quote_asset_amount_surplus
            );

            if !has_set_prev_qas {
                prev_qas = quote_asset_amount_surplus;
                has_set_prev_qas = true;
            } else {
                // decreasing (amm paying less / earning more)
                assert!(prev_qas <= quote_asset_amount_surplus);
                prev_qas = quote_asset_amount_surplus;
            }

            if quote_asset_amount_surplus < 0 {
                neg = true;
                assert!(!pos); // neg first
            } else if quote_asset_amount_surplus > 0 {
                pos = true;
                assert!(neg); // neg first
                              // sometimes skips over == 0 surplus
            } else {
                none = true;
                assert!(neg);
                assert!(!pos);
            }
            slot += 1;
        }
        // auction should go through both position and negative
        assert!(neg);
        assert!(pos);
        assert!(none);

        println!("{} {} {}", neg, pos, none);
    }

    #[test]
    fn fulfill_with_amm_lp_jit_taker_zero_price_long_imbalance() {
        let now = 0_i64;
        let slot = 10_u64;

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
                base_asset_amount_per_lp: -505801343,
                quote_asset_amount_per_lp: 10715933,
                target_base_asset_amount_per_lp: -500000000,
                bid_base_asset_reserve: 101 * AMM_RESERVE_PRECISION,
                bid_quote_asset_reserve: 99 * AMM_RESERVE_PRECISION,
                ask_base_asset_reserve: 99 * AMM_RESERVE_PRECISION,
                ask_quote_asset_reserve: 101 * AMM_RESERVE_PRECISION,
                base_asset_amount_with_amm: ((AMM_RESERVE_PRECISION / 2) as i128),
                base_asset_amount_long: ((AMM_RESERVE_PRECISION / 2) as i128),
                sqrt_k: 100 * AMM_RESERVE_PRECISION,
                peg_multiplier: 100 * PEG_PRECISION,
                max_slippage_ratio: 50,
                max_fill_reserve_fraction: 100,
                order_step_size: 10000000,
                order_tick_size: 1,
                oracle: oracle_price_key,
                amm_jit_intensity: 200,
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
            ..PerpMarket::default_test()
        };
        market.amm.max_base_asset_reserve = u64::MAX as u128;
        market.amm.min_base_asset_reserve = 0;

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
                auction_start_price: 0,
                auction_end_price: 100 * PRICE_PRECISION_I64,
                auction_duration: 0, // expired auction
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
            next_order_id: 1,
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
                price: 10 * PRICE_PRECISION_U64,
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
        let maker_key = Pubkey::from_str("My11111111111111111111111111111111111111113").unwrap();
        let maker_authority =
            Pubkey::from_str("J83w4HKfqxwcq3BEMMkPFSppX3gqekLyLJBexebFVkix").unwrap();

        let mut taker_stats = UserStats::default();

        let mut maker_stats = UserStats {
            authority: maker_authority,
            ..UserStats::default()
        };
        create_anchor_account_info!(maker_stats, UserStats, maker_stats_account_info);
        let maker_and_referrer_stats = UserStatsMap::load_one(&maker_stats_account_info).unwrap();
        let mut filler_stats = UserStats::default();

        assert_eq!(market.amm.total_fee, 0);
        assert_eq!(market.amm.total_fee_minus_distributions, 0);
        assert_eq!(market.amm.net_revenue_since_last_funding, 0);
        assert_eq!(market.amm.total_mm_fee, 0);
        assert_eq!(market.amm.total_fee_withdrawn, 0);
        assert_eq!(taker.perp_positions[0].open_orders, 1);

        // fulfill with match
        let (base_asset_amount, _) = fulfill_perp_order(
            &mut taker,
            0,
            &taker_key,
            &mut taker_stats,
            &makers_and_referrers,
            &maker_and_referrer_stats,
            &[(maker_key, 0, 10 * PRICE_PRECISION_U64)],
            &mut Some(&mut filler),
            &filler_key,
            &mut Some(&mut filler_stats),
            None,
            &spot_market_map,
            &market_map,
            &mut oracle_map,
            &fee_structure,
            0,
            Some(1),
            now,
            slot,
            0,
            true,
            FillMode::Fill,
        )
        .unwrap();

        assert_eq!(taker.perp_positions[0].open_orders, 0);
        assert_eq!(base_asset_amount, 1000000000);

        let market_after = market_map.get_ref(&0).unwrap();
        assert_eq!(market_after.amm.total_mm_fee, 2033008); // jit occured even tho maker offered full amount
        assert_eq!(market_after.amm.total_fee, 2057287);
    }
}
