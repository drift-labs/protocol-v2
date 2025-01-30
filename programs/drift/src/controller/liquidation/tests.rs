pub mod liquidate_perp {
    use crate::math::constants::ONE_HOUR;
    use crate::state::state::State;
    use std::str::FromStr;

    use anchor_lang::Owner;
    use solana_program::pubkey::Pubkey;

    use crate::controller::liquidation::liquidate_perp;
    use crate::controller::position::PositionDirection;
    use crate::create_anchor_account_info;
    use crate::error::ErrorCode;
    use crate::math::constants::{
        AMM_RESERVE_PRECISION, BASE_PRECISION_I128, BASE_PRECISION_I64, BASE_PRECISION_U64,
        LIQUIDATION_FEE_PRECISION, LIQUIDATION_PCT_PRECISION, MARGIN_PRECISION,
        MARGIN_PRECISION_U128, PEG_PRECISION, PRICE_PRECISION, PRICE_PRECISION_U64,
        QUOTE_PRECISION, QUOTE_PRECISION_I128, QUOTE_PRECISION_I64, SPOT_BALANCE_PRECISION_U64,
        SPOT_CUMULATIVE_INTEREST_PRECISION, SPOT_WEIGHT_PRECISION,
    };
    use crate::math::liquidation::is_user_being_liquidated;
    use crate::math::margin::{
        calculate_margin_requirement_and_total_collateral_and_liability_info, MarginRequirementType,
    };
    use crate::math::position::calculate_base_asset_value_with_oracle_price;
    use crate::state::margin_calculation::{MarginCalculation, MarginContext};
    use crate::state::oracle::{HistoricalOracleData, OracleSource};
    use crate::state::oracle_map::OracleMap;
    use crate::state::perp_market::{MarketStatus, PerpMarket, AMM};
    use crate::state::perp_market_map::PerpMarketMap;
    use crate::state::spot_market::{SpotBalanceType, SpotMarket};
    use crate::state::spot_market_map::SpotMarketMap;
    use crate::state::user::{
        MarginMode, Order, OrderStatus, OrderType, PerpPosition, SpotPosition, User, UserStats,
    };
    use crate::test_utils::*;
    use crate::test_utils::{get_orders, get_positions, get_pyth_price, get_spot_positions};
    use crate::{create_account_info, PRICE_PRECISION_I64};

    #[test]
    pub fn successful_liquidation_long_perp() {
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
                max_fill_reserve_fraction: 100,
                order_step_size: 10000000,
                quote_asset_amount: -150 * QUOTE_PRECISION_I128,
                base_asset_amount_with_amm: BASE_PRECISION_I128,
                oracle: oracle_price_key,
                historical_oracle_data: HistoricalOracleData::default_price(oracle_price.agg.price),
                ..AMM::default()
            },
            margin_ratio_initial: 1000,
            margin_ratio_maintenance: 500,
            number_of_users_with_base: 1,
            status: MarketStatus::Initialized,
            liquidator_fee: LIQUIDATION_FEE_PRECISION / 100,
            if_liquidation_fee: LIQUIDATION_FEE_PRECISION / 100,
            ..PerpMarket::default()
        };
        create_anchor_account_info!(market, PerpMarket, market_account_info);
        let perp_market_map = PerpMarketMap::load_one(&market_account_info, true).unwrap();

        let mut spot_market = SpotMarket {
            market_index: 0,
            oracle_source: OracleSource::QuoteAsset,
            cumulative_deposit_interest: SPOT_CUMULATIVE_INTEREST_PRECISION,
            decimals: 6,
            initial_asset_weight: SPOT_WEIGHT_PRECISION,
            historical_oracle_data: HistoricalOracleData {
                last_oracle_price_twap: PRICE_PRECISION_I64,
                last_oracle_price_twap_5min: PRICE_PRECISION_I64,
                ..HistoricalOracleData::default()
            },
            ..SpotMarket::default()
        };
        create_anchor_account_info!(spot_market, SpotMarket, spot_market_account_info);
        let spot_market_map = SpotMarketMap::load_one(&spot_market_account_info, true).unwrap();

        let mut user = User {
            orders: get_orders(Order {
                market_index: 0,
                status: OrderStatus::Open,
                order_type: OrderType::Limit,
                direction: PositionDirection::Long,
                base_asset_amount: BASE_PRECISION_U64,
                slot: 0,
                ..Order::default()
            }),
            perp_positions: get_positions(PerpPosition {
                market_index: 0,
                base_asset_amount: BASE_PRECISION_I64,
                quote_asset_amount: -150 * QUOTE_PRECISION_I64,
                quote_entry_amount: -150 * QUOTE_PRECISION_I64,
                quote_break_even_amount: -150 * QUOTE_PRECISION_I64,
                open_orders: 1,
                open_bids: BASE_PRECISION_I64,
                ..PerpPosition::default()
            }),
            spot_positions: [SpotPosition::default(); 8],

            ..User::default()
        };

        let mut liquidator = User {
            spot_positions: get_spot_positions(SpotPosition {
                market_index: 0,
                balance_type: SpotBalanceType::Deposit,
                scaled_balance: 50 * SPOT_BALANCE_PRECISION_U64,
                ..SpotPosition::default()
            }),
            ..User::default()
        };

        let user_key = Pubkey::default();
        let liquidator_key = Pubkey::default();

        let mut user_stats = UserStats::default();
        let mut liquidator_stats = UserStats::default();
        let state = State {
            liquidation_margin_buffer_ratio: 10,
            initial_pct_to_liquidate: LIQUIDATION_PCT_PRECISION as u16,
            liquidation_duration: 150,
            ..Default::default()
        };
        liquidate_perp(
            0,
            BASE_PRECISION_U64,
            None,
            &mut user,
            &user_key,
            &mut user_stats,
            &mut liquidator,
            &liquidator_key,
            &mut liquidator_stats,
            &perp_market_map,
            &spot_market_map,
            &mut oracle_map,
            slot,
            now,
            &state,
        )
        .unwrap();

        assert_eq!(user.perp_positions[0].base_asset_amount, 0);
        assert_eq!(
            user.perp_positions[0].quote_asset_amount,
            -51 * QUOTE_PRECISION_I64
        );
        assert_eq!(user.perp_positions[0].open_orders, 0);
        assert_eq!(user.perp_positions[0].open_bids, 0);

        assert_eq!(
            liquidator.perp_positions[0].base_asset_amount,
            BASE_PRECISION_I64
        );
        assert_eq!(
            liquidator.perp_positions[0].quote_asset_amount,
            -99 * QUOTE_PRECISION_I64
        );

        let market_after = perp_market_map.get_ref(&0).unwrap();
        assert_eq!(market_after.amm.total_liquidation_fee, 0);
    }

    #[test]
    pub fn successful_liquidation_short_perp() {
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
                max_fill_reserve_fraction: 100,
                order_step_size: 10000000,
                quote_asset_amount: 50 * QUOTE_PRECISION_I128,
                base_asset_amount_with_amm: BASE_PRECISION_I128,
                oracle: oracle_price_key,
                historical_oracle_data: HistoricalOracleData::default_price(oracle_price.agg.price),
                funding_period: 3600,
                ..AMM::default()
            },
            margin_ratio_initial: 1000,
            margin_ratio_maintenance: 500,
            number_of_users_with_base: 1,
            status: MarketStatus::Initialized,
            liquidator_fee: LIQUIDATION_FEE_PRECISION / 100,
            if_liquidation_fee: LIQUIDATION_FEE_PRECISION / 100,
            ..PerpMarket::default()
        };
        create_anchor_account_info!(market, PerpMarket, market_account_info);
        let perp_market_map = PerpMarketMap::load_one(&market_account_info, true).unwrap();

        let mut spot_market = SpotMarket {
            market_index: 0,
            oracle_source: OracleSource::QuoteAsset,
            cumulative_deposit_interest: SPOT_CUMULATIVE_INTEREST_PRECISION,
            decimals: 6,
            initial_asset_weight: SPOT_WEIGHT_PRECISION,
            historical_oracle_data: HistoricalOracleData {
                last_oracle_price_twap: PRICE_PRECISION_I64,
                last_oracle_price_twap_5min: PRICE_PRECISION_I64,
                ..HistoricalOracleData::default()
            },
            ..SpotMarket::default()
        };
        create_anchor_account_info!(spot_market, SpotMarket, spot_market_account_info);
        let spot_market_map = SpotMarketMap::load_one(&spot_market_account_info, true).unwrap();

        let mut user = User {
            orders: get_orders(Order {
                market_index: 0,
                status: OrderStatus::Open,
                order_type: OrderType::Limit,
                direction: PositionDirection::Short,
                base_asset_amount: BASE_PRECISION_U64,
                slot: 0,
                ..Order::default()
            }),
            perp_positions: get_positions(PerpPosition {
                market_index: 0,
                base_asset_amount: -BASE_PRECISION_I64,
                quote_asset_amount: 50 * QUOTE_PRECISION_I64,
                quote_entry_amount: 50 * QUOTE_PRECISION_I64,
                quote_break_even_amount: 50 * QUOTE_PRECISION_I64,
                open_orders: 1,
                open_asks: -BASE_PRECISION_I64,
                ..PerpPosition::default()
            }),
            spot_positions: [SpotPosition::default(); 8],

            ..User::default()
        };

        let mut liquidator = User {
            spot_positions: get_spot_positions(SpotPosition {
                market_index: 0,
                balance_type: SpotBalanceType::Deposit,
                scaled_balance: 50 * SPOT_BALANCE_PRECISION_U64,
                ..SpotPosition::default()
            }),
            ..User::default()
        };

        let user_key = Pubkey::default();
        let liquidator_key = Pubkey::default();

        let mut user_stats = UserStats::default();
        let mut liquidator_stats = UserStats::default();
        let state = State {
            liquidation_margin_buffer_ratio: 10,
            initial_pct_to_liquidate: LIQUIDATION_PCT_PRECISION as u16,
            liquidation_duration: 150,
            ..Default::default()
        };
        liquidate_perp(
            0,
            BASE_PRECISION_U64,
            None,
            &mut user,
            &user_key,
            &mut user_stats,
            &mut liquidator,
            &liquidator_key,
            &mut liquidator_stats,
            &perp_market_map,
            &spot_market_map,
            &mut oracle_map,
            slot,
            now,
            &state,
        )
        .unwrap();

        assert_eq!(user.perp_positions[0].base_asset_amount, 0);
        assert_eq!(
            user.perp_positions[0].quote_asset_amount,
            -51 * QUOTE_PRECISION_I64
        );
        assert_eq!(user.perp_positions[0].open_orders, 0);
        assert_eq!(user.perp_positions[0].open_bids, 0);

        assert_eq!(
            liquidator.perp_positions[0].base_asset_amount,
            -BASE_PRECISION_I64
        );
        assert_eq!(
            liquidator.perp_positions[0].quote_asset_amount,
            101 * QUOTE_PRECISION_I64
        );

        let market_after = perp_market_map.get_ref(&0).unwrap();
        assert_eq!(market_after.amm.total_liquidation_fee, 0);
    }

    #[test]
    pub fn successful_liquidation_by_canceling_order() {
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
                max_fill_reserve_fraction: 100,
                order_step_size: 10000000,
                quote_asset_amount: 50 * QUOTE_PRECISION_I128,
                base_asset_amount_with_amm: BASE_PRECISION_I128,
                oracle: oracle_price_key,
                historical_oracle_data: HistoricalOracleData::default_price(oracle_price.agg.price),
                funding_period: 3600,
                ..AMM::default()
            },
            margin_ratio_initial: 1000,
            margin_ratio_maintenance: 500,
            number_of_users_with_base: 1,
            status: MarketStatus::Initialized,
            liquidator_fee: LIQUIDATION_FEE_PRECISION / 100,
            ..PerpMarket::default()
        };
        create_anchor_account_info!(market, PerpMarket, market_account_info);
        let perp_market_map = PerpMarketMap::load_one(&market_account_info, true).unwrap();

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

        let mut user = User {
            orders: get_orders(Order {
                market_index: 0,
                status: OrderStatus::Open,
                order_type: OrderType::Limit,
                direction: PositionDirection::Long,
                base_asset_amount: 1000 * BASE_PRECISION_U64,
                slot: 0,
                ..Order::default()
            }),
            perp_positions: get_positions(PerpPosition {
                market_index: 0,
                base_asset_amount: BASE_PRECISION_I64,
                quote_asset_amount: 100 * QUOTE_PRECISION_I64,
                open_orders: 1,
                open_bids: 1000 * BASE_PRECISION_I64,
                ..PerpPosition::default()
            }),
            spot_positions: get_spot_positions(SpotPosition {
                market_index: 0,
                balance_type: SpotBalanceType::Deposit,
                scaled_balance: 50 * SPOT_BALANCE_PRECISION_U64,
                ..SpotPosition::default()
            }),
            ..User::default()
        };

        let mut liquidator = User {
            spot_positions: get_spot_positions(SpotPosition {
                market_index: 0,
                balance_type: SpotBalanceType::Deposit,
                scaled_balance: 50 * SPOT_BALANCE_PRECISION_U64,
                ..SpotPosition::default()
            }),
            ..User::default()
        };

        let user_key = Pubkey::default();
        let liquidator_key = Pubkey::default();

        let mut user_stats = UserStats::default();
        let mut liquidator_stats = UserStats::default();
        let state = State {
            liquidation_margin_buffer_ratio: 255,
            initial_pct_to_liquidate: LIQUIDATION_PCT_PRECISION as u16,
            liquidation_duration: 150,
            ..Default::default()
        };
        liquidate_perp(
            0,
            BASE_PRECISION_U64,
            None,
            &mut user,
            &user_key,
            &mut user_stats,
            &mut liquidator,
            &liquidator_key,
            &mut liquidator_stats,
            &perp_market_map,
            &spot_market_map,
            &mut oracle_map,
            slot,
            now,
            &state,
        )
        .unwrap();

        assert_eq!(user.perp_positions[0].base_asset_amount, BASE_PRECISION_I64);
        assert_eq!(user.perp_positions[0].open_orders, 0);
        assert_eq!(user.perp_positions[0].open_bids, 0);

        assert_eq!(liquidator.perp_positions[0].base_asset_amount, 0);
    }

    #[test]
    pub fn successful_liquidation_up_to_max_liquidator_base_asset_amount() {
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
                max_fill_reserve_fraction: 100,
                order_step_size: 10000000,
                quote_asset_amount: -150 * QUOTE_PRECISION_I128,
                base_asset_amount_with_amm: BASE_PRECISION_I128,
                oracle: oracle_price_key,
                historical_oracle_data: HistoricalOracleData::default_price(oracle_price.agg.price),
                funding_period: ONE_HOUR,
                ..AMM::default()
            },
            margin_ratio_initial: 1000,
            margin_ratio_maintenance: 500,
            number_of_users_with_base: 1,
            status: MarketStatus::Initialized,
            liquidator_fee: LIQUIDATION_FEE_PRECISION / 100,
            if_liquidation_fee: LIQUIDATION_FEE_PRECISION / 100,
            ..PerpMarket::default()
        };
        create_anchor_account_info!(market, PerpMarket, market_account_info);
        let perp_market_map = PerpMarketMap::load_one(&market_account_info, true).unwrap();

        let mut spot_market = SpotMarket {
            market_index: 0,
            oracle_source: OracleSource::QuoteAsset,
            cumulative_deposit_interest: SPOT_CUMULATIVE_INTEREST_PRECISION,
            decimals: 6,
            initial_asset_weight: SPOT_WEIGHT_PRECISION,
            historical_oracle_data: HistoricalOracleData {
                last_oracle_price_twap: PRICE_PRECISION_I64,
                last_oracle_price_twap_5min: PRICE_PRECISION_I64,
                ..HistoricalOracleData::default()
            },
            ..SpotMarket::default()
        };
        create_anchor_account_info!(spot_market, SpotMarket, spot_market_account_info);
        let spot_market_map = SpotMarketMap::load_one(&spot_market_account_info, true).unwrap();

        let mut user = User {
            orders: get_orders(Order {
                market_index: 0,
                status: OrderStatus::Open,
                order_type: OrderType::Limit,
                direction: PositionDirection::Long,
                base_asset_amount: BASE_PRECISION_U64,
                slot: 0,
                ..Order::default()
            }),
            perp_positions: get_positions(PerpPosition {
                market_index: 0,
                base_asset_amount: BASE_PRECISION_I64,
                quote_asset_amount: -150 * QUOTE_PRECISION_I64,
                quote_entry_amount: -150 * QUOTE_PRECISION_I64,
                quote_break_even_amount: -150 * QUOTE_PRECISION_I64,
                open_orders: 1,
                open_bids: BASE_PRECISION_I64,
                ..PerpPosition::default()
            }),
            spot_positions: [SpotPosition::default(); 8],

            ..User::default()
        };

        let mut liquidator = User {
            spot_positions: get_spot_positions(SpotPosition {
                market_index: 0,
                balance_type: SpotBalanceType::Deposit,
                scaled_balance: 50 * SPOT_BALANCE_PRECISION_U64,
                ..SpotPosition::default()
            }),
            ..User::default()
        };

        let user_key = Pubkey::default();
        let liquidator_key = Pubkey::default();

        let mut user_stats = UserStats::default();
        let mut liquidator_stats = UserStats::default();
        let state = State {
            liquidation_margin_buffer_ratio: MARGIN_PRECISION / 50,
            initial_pct_to_liquidate: LIQUIDATION_PCT_PRECISION as u16,
            liquidation_duration: 150,
            ..Default::default()
        };
        liquidate_perp(
            0,
            BASE_PRECISION_U64 / 2,
            None,
            &mut user,
            &user_key,
            &mut user_stats,
            &mut liquidator,
            &liquidator_key,
            &mut liquidator_stats,
            &perp_market_map,
            &spot_market_map,
            &mut oracle_map,
            slot,
            now,
            &state,
        )
        .unwrap();

        assert_eq!(
            user.perp_positions[0].base_asset_amount,
            BASE_PRECISION_I64 / 2
        );
        assert_eq!(user.perp_positions[0].quote_asset_amount, -100500000);
        assert_eq!(user.perp_positions[0].quote_entry_amount, -75000000);
        assert_eq!(user.perp_positions[0].quote_break_even_amount, -75500000);
        assert_eq!(user.perp_positions[0].open_orders, 0);
        assert_eq!(user.perp_positions[0].open_bids, 0);

        assert_eq!(
            liquidator.perp_positions[0].base_asset_amount,
            BASE_PRECISION_I64 / 2
        );
        assert_eq!(liquidator.perp_positions[0].quote_asset_amount, -49500000);

        let market_after = perp_market_map.get_ref(&0).unwrap();
        assert_eq!(market_after.amm.total_liquidation_fee, 0)
    }

    #[test]
    pub fn successful_liquidation_to_cover_margin_shortage() {
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
                max_fill_reserve_fraction: 100,
                order_step_size: 10000000,
                quote_asset_amount: -150 * QUOTE_PRECISION_I128,
                base_asset_amount_with_amm: BASE_PRECISION_I128,
                oracle: oracle_price_key,
                historical_oracle_data: HistoricalOracleData::default_price(oracle_price.agg.price),
                funding_period: ONE_HOUR,
                ..AMM::default()
            },
            margin_ratio_initial: 1000,
            margin_ratio_maintenance: 500,
            number_of_users_with_base: 1,
            status: MarketStatus::Initialized,
            liquidator_fee: LIQUIDATION_FEE_PRECISION / 100,
            if_liquidation_fee: LIQUIDATION_FEE_PRECISION / 100,
            ..PerpMarket::default()
        };
        create_anchor_account_info!(market, PerpMarket, market_account_info);
        let perp_market_map = PerpMarketMap::load_one(&market_account_info, true).unwrap();

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

        let mut user = User {
            orders: get_orders(Order {
                market_index: 0,
                status: OrderStatus::Open,
                order_type: OrderType::Limit,
                direction: PositionDirection::Long,
                base_asset_amount: BASE_PRECISION_U64,
                slot: 0,
                ..Order::default()
            }),
            perp_positions: get_positions(PerpPosition {
                market_index: 0,
                base_asset_amount: 2 * BASE_PRECISION_I64,
                quote_asset_amount: -200 * QUOTE_PRECISION_I64,
                quote_entry_amount: -200 * QUOTE_PRECISION_I64,
                quote_break_even_amount: -200 * QUOTE_PRECISION_I64,
                open_orders: 1,
                open_bids: BASE_PRECISION_I64,
                ..PerpPosition::default()
            }),
            spot_positions: get_spot_positions(SpotPosition {
                market_index: 0,
                balance_type: SpotBalanceType::Deposit,
                scaled_balance: 5 * SPOT_BALANCE_PRECISION_U64,
                ..SpotPosition::default()
            }),

            ..User::default()
        };

        let mut liquidator = User {
            spot_positions: get_spot_positions(SpotPosition {
                market_index: 0,
                balance_type: SpotBalanceType::Deposit,
                scaled_balance: 50 * SPOT_BALANCE_PRECISION_U64,
                ..SpotPosition::default()
            }),
            ..User::default()
        };

        let user_key = Pubkey::default();
        let liquidator_key = Pubkey::default();

        let mut user_stats = UserStats::default();
        let mut liquidator_stats = UserStats::default();
        let state = State {
            liquidation_margin_buffer_ratio: MARGIN_PRECISION / 50,
            initial_pct_to_liquidate: LIQUIDATION_PCT_PRECISION as u16,
            liquidation_duration: 150,
            ..Default::default()
        };
        liquidate_perp(
            0,
            10 * BASE_PRECISION_U64,
            None,
            &mut user,
            &user_key,
            &mut user_stats,
            &mut liquidator,
            &liquidator_key,
            &mut liquidator_stats,
            &perp_market_map,
            &spot_market_map,
            &mut oracle_map,
            slot,
            now,
            &state,
        )
        .unwrap();

        assert_eq!(user.perp_positions[0].base_asset_amount, 200000000);
        assert_eq!(user.perp_positions[0].quote_asset_amount, -23600000);
        assert_eq!(user.perp_positions[0].quote_entry_amount, -20000000);
        assert_eq!(user.perp_positions[0].quote_break_even_amount, -23600000);
        assert_eq!(user.perp_positions[0].open_orders, 0);
        assert_eq!(user.perp_positions[0].open_bids, 0);

        let MarginCalculation {
            total_collateral,
            margin_requirement_plus_buffer,
            ..
        } = calculate_margin_requirement_and_total_collateral_and_liability_info(
            &user,
            &perp_market_map,
            &spot_market_map,
            &mut oracle_map,
            MarginContext::liquidation(state.liquidation_margin_buffer_ratio),
        )
        .unwrap();

        // user out of liq territory
        assert_eq!(
            total_collateral.unsigned_abs(),
            margin_requirement_plus_buffer
        );

        let oracle_price = oracle_map
            .get_price_data(&(oracle_price_key, OracleSource::Pyth))
            .unwrap()
            .price;

        let perp_value = calculate_base_asset_value_with_oracle_price(
            user.perp_positions[0].base_asset_amount as i128,
            oracle_price,
        )
        .unwrap();

        let margin_ratio = total_collateral.unsigned_abs() * MARGIN_PRECISION_U128 / perp_value;

        assert_eq!(margin_ratio, 700);

        assert_eq!(liquidator.perp_positions[0].base_asset_amount, 1800000000);
        assert_eq!(liquidator.perp_positions[0].quote_asset_amount, -178200000);

        let market_after = perp_market_map.get_ref(&0).unwrap();
        assert_eq!(market_after.amm.total_liquidation_fee, 1800000)
    }

    #[test]
    pub fn successful_liquidation_long_perp_whale_imf_factor() {
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
                max_fill_reserve_fraction: 100,
                order_step_size: 10000000,
                quote_asset_amount: -150 * QUOTE_PRECISION_I128,
                base_asset_amount_with_amm: BASE_PRECISION_I128,
                oracle: oracle_price_key,
                historical_oracle_data: HistoricalOracleData::default_price(oracle_price.agg.price),
                funding_period: ONE_HOUR,
                ..AMM::default()
            },
            margin_ratio_initial: 1000,
            margin_ratio_maintenance: 500,
            number_of_users_with_base: 1,
            status: MarketStatus::Initialized,
            imf_factor: 1000, // SPOT_IMF_PRECISION == 1e6
            liquidator_fee: LIQUIDATION_FEE_PRECISION / 100,
            if_liquidation_fee: LIQUIDATION_FEE_PRECISION / 100,
            ..PerpMarket::default()
        };
        create_anchor_account_info!(market, PerpMarket, market_account_info);
        let perp_market_map = PerpMarketMap::load_one(&market_account_info, true).unwrap();

        let mut spot_market = SpotMarket {
            market_index: 0,
            oracle_source: OracleSource::QuoteAsset,
            cumulative_deposit_interest: SPOT_CUMULATIVE_INTEREST_PRECISION,
            decimals: 6,
            initial_asset_weight: SPOT_WEIGHT_PRECISION,
            historical_oracle_data: HistoricalOracleData {
                last_oracle_price_twap: PRICE_PRECISION_I64,
                last_oracle_price_twap_5min: PRICE_PRECISION_I64,
                ..HistoricalOracleData::default()
            },
            ..SpotMarket::default()
        };
        create_anchor_account_info!(spot_market, SpotMarket, spot_market_account_info);
        let spot_market_map = SpotMarketMap::load_one(&spot_market_account_info, true).unwrap();

        let mut user = User {
            orders: get_orders(Order {
                market_index: 0,
                status: OrderStatus::Open,
                order_type: OrderType::Limit,
                direction: PositionDirection::Long,
                base_asset_amount: BASE_PRECISION_U64,
                slot: 0,
                ..Order::default()
            }),
            perp_positions: get_positions(PerpPosition {
                market_index: 0,
                base_asset_amount: BASE_PRECISION_I64 * 10000,
                quote_asset_amount: -150 * QUOTE_PRECISION_I64 * 10000,
                quote_entry_amount: -150 * QUOTE_PRECISION_I64 * 10000,
                quote_break_even_amount: -150 * QUOTE_PRECISION_I64 * 10000,
                open_orders: 1,
                open_bids: BASE_PRECISION_I64,
                ..PerpPosition::default()
            }),
            spot_positions: get_spot_positions(SpotPosition {
                market_index: 0,
                balance_type: SpotBalanceType::Deposit,
                scaled_balance: 150 * 10000 * SPOT_BALANCE_PRECISION_U64,
                ..SpotPosition::default()
            }),

            ..User::default()
        };

        let MarginCalculation {
            margin_requirement: margin_req,
            ..
        } = calculate_margin_requirement_and_total_collateral_and_liability_info(
            &user,
            &perp_market_map,
            &spot_market_map,
            &mut oracle_map,
            MarginContext::standard(MarginRequirementType::Maintenance),
        )
        .unwrap();
        assert_eq!(margin_req, 140014010000);
        assert!(!is_user_being_liquidated(
            &user,
            &perp_market_map,
            &spot_market_map,
            &mut oracle_map,
            0
        )
        .unwrap());

        {
            let market_to_edit = &mut perp_market_map.get_ref_mut(&0).unwrap();
            market_to_edit.imf_factor *= 10;
        }

        let MarginCalculation {
            margin_requirement: margin_req2,
            ..
        } = calculate_margin_requirement_and_total_collateral_and_liability_info(
            &user,
            &perp_market_map,
            &spot_market_map,
            &mut oracle_map,
            MarginContext::standard(MarginRequirementType::Maintenance),
        )
        .unwrap();
        assert_eq!(margin_req2, 1040104010000);
        assert!(is_user_being_liquidated(
            &user,
            &perp_market_map,
            &spot_market_map,
            &mut oracle_map,
            MARGIN_PRECISION / 50
        )
        .unwrap());

        let mut liquidator = User {
            spot_positions: get_spot_positions(SpotPosition {
                market_index: 0,
                balance_type: SpotBalanceType::Deposit,
                scaled_balance: 50 * SPOT_BALANCE_PRECISION_U64,
                ..SpotPosition::default()
            }),
            ..User::default()
        };

        let user_key = Pubkey::default();
        let liquidator_key = Pubkey::default();

        let mut user_stats = UserStats::default();
        let mut liquidator_stats = UserStats::default();
        let state = State {
            liquidation_margin_buffer_ratio: 10,
            initial_pct_to_liquidate: LIQUIDATION_PCT_PRECISION as u16,
            liquidation_duration: 150,
            ..Default::default()
        };
        liquidate_perp(
            0,
            BASE_PRECISION_U64,
            None,
            &mut user,
            &user_key,
            &mut user_stats,
            &mut liquidator,
            &liquidator_key,
            &mut liquidator_stats,
            &perp_market_map,
            &spot_market_map,
            &mut oracle_map,
            slot,
            now,
            &state,
        )
        .unwrap();

        assert_eq!(user.perp_positions[0].base_asset_amount, 9999000000000);
        assert_eq!(user.perp_positions[0].quote_asset_amount, -1499902000000);
        assert_eq!(user.perp_positions[0].open_orders, 0);
        assert_eq!(user.perp_positions[0].open_bids, 0);

        assert_eq!(
            liquidator.perp_positions[0].base_asset_amount,
            BASE_PRECISION_I64
        );
        assert_eq!(
            liquidator.perp_positions[0].quote_asset_amount,
            -99 * QUOTE_PRECISION_I64
        );

        let market_after = perp_market_map.get_ref(&0).unwrap();
        assert_eq!(market_after.amm.total_liquidation_fee, QUOTE_PRECISION);
    }

    #[test]
    pub fn fail_liquidating_long_perp_due_to_limit_price() {
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
                max_fill_reserve_fraction: 100,
                order_step_size: 10000000,
                quote_asset_amount: -150 * QUOTE_PRECISION_I128,
                base_asset_amount_with_amm: BASE_PRECISION_I128,
                oracle: oracle_price_key,
                historical_oracle_data: HistoricalOracleData::default_price(oracle_price.agg.price),
                funding_period: ONE_HOUR,
                ..AMM::default()
            },
            margin_ratio_initial: 1000,
            margin_ratio_maintenance: 500,
            number_of_users_with_base: 1,
            status: MarketStatus::Initialized,
            liquidator_fee: LIQUIDATION_FEE_PRECISION / 100,
            if_liquidation_fee: LIQUIDATION_FEE_PRECISION / 100,
            ..PerpMarket::default()
        };
        create_anchor_account_info!(market, PerpMarket, market_account_info);
        let perp_market_map = PerpMarketMap::load_one(&market_account_info, true).unwrap();

        let mut spot_market = SpotMarket {
            market_index: 0,
            oracle_source: OracleSource::QuoteAsset,
            cumulative_deposit_interest: SPOT_CUMULATIVE_INTEREST_PRECISION,
            decimals: 6,
            initial_asset_weight: SPOT_WEIGHT_PRECISION,
            historical_oracle_data: HistoricalOracleData {
                last_oracle_price_twap: PRICE_PRECISION_I64,
                last_oracle_price_twap_5min: PRICE_PRECISION_I64,
                ..HistoricalOracleData::default()
            },
            ..SpotMarket::default()
        };
        create_anchor_account_info!(spot_market, SpotMarket, spot_market_account_info);
        let spot_market_map = SpotMarketMap::load_one(&spot_market_account_info, true).unwrap();

        let mut user = User {
            orders: get_orders(Order {
                market_index: 0,
                status: OrderStatus::Open,
                order_type: OrderType::Limit,
                direction: PositionDirection::Long,
                base_asset_amount: BASE_PRECISION_U64,
                slot: 0,
                ..Order::default()
            }),
            perp_positions: get_positions(PerpPosition {
                market_index: 0,
                base_asset_amount: BASE_PRECISION_I64,
                quote_asset_amount: -150 * QUOTE_PRECISION_I64,
                quote_entry_amount: -150 * QUOTE_PRECISION_I64,
                quote_break_even_amount: -150 * QUOTE_PRECISION_I64,
                open_orders: 1,
                open_bids: BASE_PRECISION_I64,
                ..PerpPosition::default()
            }),
            spot_positions: [SpotPosition::default(); 8],

            ..User::default()
        };

        let mut liquidator = User {
            spot_positions: get_spot_positions(SpotPosition {
                market_index: 0,
                balance_type: SpotBalanceType::Deposit,
                scaled_balance: 50 * SPOT_BALANCE_PRECISION_U64,
                ..SpotPosition::default()
            }),
            ..User::default()
        };

        let user_key = Pubkey::default();
        let liquidator_key = Pubkey::default();

        let mut user_stats = UserStats::default();
        let mut liquidator_stats = UserStats::default();
        let state = State {
            liquidation_margin_buffer_ratio: 10,
            initial_pct_to_liquidate: LIQUIDATION_PCT_PRECISION as u16,
            liquidation_duration: 150,
            ..Default::default()
        };

        let result = liquidate_perp(
            0,
            BASE_PRECISION_U64,
            Some(50 * PRICE_PRECISION_U64),
            &mut user,
            &user_key,
            &mut user_stats,
            &mut liquidator,
            &liquidator_key,
            &mut liquidator_stats,
            &perp_market_map,
            &spot_market_map,
            &mut oracle_map,
            slot,
            now,
            &state,
        );

        assert_eq!(result, Err(ErrorCode::LiquidationDoesntSatisfyLimitPrice));
    }

    #[test]
    pub fn fail_liquidating_short_perp_due_to_limit_price() {
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
                max_fill_reserve_fraction: 100,
                order_step_size: 10000000,
                quote_asset_amount: 50 * QUOTE_PRECISION_I128,
                base_asset_amount_with_amm: BASE_PRECISION_I128,
                oracle: oracle_price_key,
                historical_oracle_data: HistoricalOracleData::default_price(oracle_price.agg.price),
                funding_period: ONE_HOUR,
                ..AMM::default()
            },
            margin_ratio_initial: 1000,
            margin_ratio_maintenance: 500,
            number_of_users_with_base: 1,
            status: MarketStatus::Initialized,
            liquidator_fee: LIQUIDATION_FEE_PRECISION / 100,
            if_liquidation_fee: LIQUIDATION_FEE_PRECISION / 100,
            ..PerpMarket::default()
        };
        create_anchor_account_info!(market, PerpMarket, market_account_info);
        let perp_market_map = PerpMarketMap::load_one(&market_account_info, true).unwrap();

        let mut spot_market = SpotMarket {
            market_index: 0,
            oracle_source: OracleSource::QuoteAsset,
            cumulative_deposit_interest: SPOT_CUMULATIVE_INTEREST_PRECISION,
            decimals: 6,
            initial_asset_weight: SPOT_WEIGHT_PRECISION,
            historical_oracle_data: HistoricalOracleData {
                last_oracle_price_twap: PRICE_PRECISION_I64,
                last_oracle_price_twap_5min: PRICE_PRECISION_I64,
                ..HistoricalOracleData::default()
            },
            ..SpotMarket::default()
        };
        create_anchor_account_info!(spot_market, SpotMarket, spot_market_account_info);
        let spot_market_map = SpotMarketMap::load_one(&spot_market_account_info, true).unwrap();

        let mut user = User {
            orders: get_orders(Order {
                market_index: 0,
                status: OrderStatus::Open,
                order_type: OrderType::Limit,
                direction: PositionDirection::Short,
                base_asset_amount: BASE_PRECISION_U64,
                slot: 0,
                ..Order::default()
            }),
            perp_positions: get_positions(PerpPosition {
                market_index: 0,
                base_asset_amount: -BASE_PRECISION_I64,
                quote_asset_amount: 50 * QUOTE_PRECISION_I64,
                quote_entry_amount: 50 * QUOTE_PRECISION_I64,
                quote_break_even_amount: 50 * QUOTE_PRECISION_I64,
                open_orders: 1,
                open_asks: -BASE_PRECISION_I64,
                ..PerpPosition::default()
            }),
            spot_positions: [SpotPosition::default(); 8],

            ..User::default()
        };

        let mut liquidator = User {
            spot_positions: get_spot_positions(SpotPosition {
                market_index: 0,
                balance_type: SpotBalanceType::Deposit,
                scaled_balance: 50 * SPOT_BALANCE_PRECISION_U64,
                ..SpotPosition::default()
            }),
            ..User::default()
        };

        let user_key = Pubkey::default();
        let liquidator_key = Pubkey::default();

        let mut user_stats = UserStats::default();
        let mut liquidator_stats = UserStats::default();
        let state = State {
            liquidation_margin_buffer_ratio: 10,
            initial_pct_to_liquidate: LIQUIDATION_PCT_PRECISION as u16,
            liquidation_duration: 150,
            ..Default::default()
        };

        let result = liquidate_perp(
            0,
            BASE_PRECISION_U64,
            Some(150 * PRICE_PRECISION_U64),
            &mut user,
            &user_key,
            &mut user_stats,
            &mut liquidator,
            &liquidator_key,
            &mut liquidator_stats,
            &perp_market_map,
            &spot_market_map,
            &mut oracle_map,
            slot,
            now,
            &state,
        );

        assert_eq!(result, Err(ErrorCode::LiquidationDoesntSatisfyLimitPrice));
    }

    #[test]
    pub fn liquidate_user_with_step_size_position() {
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
                max_fill_reserve_fraction: 100,
                order_step_size: 10000000,
                quote_asset_amount: -150 * QUOTE_PRECISION_I128,
                base_asset_amount_with_amm: BASE_PRECISION_I128,
                oracle: oracle_price_key,
                historical_oracle_data: HistoricalOracleData::default_price(oracle_price.agg.price),
                funding_period: ONE_HOUR,
                ..AMM::default()
            },
            margin_ratio_initial: 1000,
            margin_ratio_maintenance: 500,
            number_of_users_with_base: 1,
            status: MarketStatus::Initialized,
            liquidator_fee: LIQUIDATION_FEE_PRECISION / 100,
            if_liquidation_fee: LIQUIDATION_FEE_PRECISION / 100,
            ..PerpMarket::default()
        };
        create_anchor_account_info!(market, PerpMarket, market_account_info);
        let perp_market_map = PerpMarketMap::load_one(&market_account_info, true).unwrap();

        let mut spot_market = SpotMarket {
            market_index: 0,
            oracle_source: OracleSource::QuoteAsset,
            cumulative_deposit_interest: SPOT_CUMULATIVE_INTEREST_PRECISION,
            decimals: 6,
            initial_asset_weight: SPOT_WEIGHT_PRECISION,
            historical_oracle_data: HistoricalOracleData {
                last_oracle_price_twap: PRICE_PRECISION_I64,
                last_oracle_price_twap_5min: PRICE_PRECISION_I64,
                ..HistoricalOracleData::default()
            },
            ..SpotMarket::default()
        };
        create_anchor_account_info!(spot_market, SpotMarket, spot_market_account_info);
        let spot_market_map = SpotMarketMap::load_one(&spot_market_account_info, true).unwrap();

        let mut user = User {
            spot_positions: get_spot_positions(SpotPosition {
                market_index: 0,
                balance_type: SpotBalanceType::Deposit,
                scaled_balance: 6 * SPOT_BALANCE_PRECISION_U64 / 11,
                ..SpotPosition::default()
            }),
            perp_positions: get_positions(PerpPosition {
                market_index: 0,
                base_asset_amount: BASE_PRECISION_I64 / 100,
                quote_asset_amount: -150 * QUOTE_PRECISION_I64 / 100,
                quote_entry_amount: -150 * QUOTE_PRECISION_I64 / 100,
                quote_break_even_amount: -150 * QUOTE_PRECISION_I64 / 100,
                ..PerpPosition::default()
            }),
            ..User::default()
        };

        let mut liquidator = User {
            spot_positions: get_spot_positions(SpotPosition {
                market_index: 0,
                balance_type: SpotBalanceType::Deposit,
                scaled_balance: 50 * SPOT_BALANCE_PRECISION_U64,
                ..SpotPosition::default()
            }),
            ..User::default()
        };

        let user_key = Pubkey::default();
        let liquidator_key = Pubkey::default();

        let mut user_stats = UserStats::default();
        let mut liquidator_stats = UserStats::default();
        let state = State {
            liquidation_margin_buffer_ratio: 10,
            initial_pct_to_liquidate: LIQUIDATION_PCT_PRECISION as u16,
            liquidation_duration: 150,
            ..Default::default()
        };
        liquidate_perp(
            0,
            BASE_PRECISION_U64 / 100,
            None,
            &mut user,
            &user_key,
            &mut user_stats,
            &mut liquidator,
            &liquidator_key,
            &mut liquidator_stats,
            &perp_market_map,
            &spot_market_map,
            &mut oracle_map,
            slot,
            now,
            &state,
        )
        .unwrap();

        assert_eq!(user.perp_positions[0].base_asset_amount, 0);
        assert_eq!(
            user.perp_positions[0].quote_asset_amount,
            -52 * QUOTE_PRECISION_I64 / 100
        );
        assert_eq!(user.perp_positions[0].open_orders, 0);
        assert_eq!(user.perp_positions[0].open_bids, 0);

        assert_eq!(
            liquidator.perp_positions[0].base_asset_amount,
            BASE_PRECISION_I64 / 100
        );
        assert_eq!(
            liquidator.perp_positions[0].quote_asset_amount,
            -99 * QUOTE_PRECISION_I64 / 100
        );

        let market_after = perp_market_map.get_ref(&0).unwrap();
        assert_eq!(
            market_after.amm.total_liquidation_fee,
            QUOTE_PRECISION / 100
        );
    }

    #[test]
    pub fn liquidation_over_multiple_slots() {
        let now = 1_i64;
        let slot = 1_u64;

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
                max_fill_reserve_fraction: 100,
                order_step_size: 10000000,
                quote_asset_amount: -150 * QUOTE_PRECISION_I128,
                base_asset_amount_with_amm: BASE_PRECISION_I128,
                oracle: oracle_price_key,
                historical_oracle_data: HistoricalOracleData::default_price(oracle_price.agg.price),
                funding_period: ONE_HOUR,
                ..AMM::default()
            },
            margin_ratio_initial: 1000,
            margin_ratio_maintenance: 500,
            number_of_users_with_base: 1,
            status: MarketStatus::Initialized,
            liquidator_fee: LIQUIDATION_FEE_PRECISION / 100,
            if_liquidation_fee: LIQUIDATION_FEE_PRECISION / 100,
            ..PerpMarket::default()
        };
        create_anchor_account_info!(market, PerpMarket, market_account_info);
        let perp_market_map = PerpMarketMap::load_one(&market_account_info, true).unwrap();

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

        let mut user = User {
            orders: get_orders(Order {
                market_index: 0,
                status: OrderStatus::Open,
                order_type: OrderType::Limit,
                direction: PositionDirection::Long,
                base_asset_amount: 10 * BASE_PRECISION_U64,
                slot: 0,
                ..Order::default()
            }),
            perp_positions: get_positions(PerpPosition {
                market_index: 0,
                base_asset_amount: 20 * BASE_PRECISION_I64,
                quote_asset_amount: -2000 * QUOTE_PRECISION_I64,
                quote_entry_amount: -2000 * QUOTE_PRECISION_I64,
                quote_break_even_amount: -2000 * QUOTE_PRECISION_I64,
                open_orders: 1,
                open_bids: 10 * BASE_PRECISION_I64,
                ..PerpPosition::default()
            }),
            spot_positions: get_spot_positions(SpotPosition {
                market_index: 0,
                balance_type: SpotBalanceType::Deposit,
                scaled_balance: 50 * SPOT_BALANCE_PRECISION_U64,
                ..SpotPosition::default()
            }),

            ..User::default()
        };

        let mut liquidator = User {
            spot_positions: get_spot_positions(SpotPosition {
                market_index: 0,
                balance_type: SpotBalanceType::Deposit,
                scaled_balance: 500 * SPOT_BALANCE_PRECISION_U64,
                ..SpotPosition::default()
            }),
            ..User::default()
        };

        let user_key = Pubkey::default();
        let liquidator_key = Pubkey::default();

        let mut user_stats = UserStats::default();
        let mut liquidator_stats = UserStats::default();
        let state = State {
            liquidation_margin_buffer_ratio: MARGIN_PRECISION / 50,
            initial_pct_to_liquidate: (LIQUIDATION_PCT_PRECISION / 10) as u16,
            liquidation_duration: 150,
            ..Default::default()
        };
        liquidate_perp(
            0,
            10 * BASE_PRECISION_U64,
            None,
            &mut user,
            &user_key,
            &mut user_stats,
            &mut liquidator,
            &liquidator_key,
            &mut liquidator_stats,
            &perp_market_map,
            &spot_market_map,
            &mut oracle_map,
            slot,
            now,
            &state,
        )
        .unwrap();

        assert_eq!(user.last_active_slot, 1);
        assert_eq!(user.liquidation_margin_freed, 70010000);
        assert_eq!(user.perp_positions[0].base_asset_amount, 20000000000);

        // ~60% of liquidation finished
        let slot = 76_u64;
        liquidate_perp(
            0,
            10 * BASE_PRECISION_U64,
            None,
            &mut user,
            &user_key,
            &mut user_stats,
            &mut liquidator,
            &liquidator_key,
            &mut liquidator_stats,
            &perp_market_map,
            &spot_market_map,
            &mut oracle_map,
            slot,
            now,
            &state,
        )
        .unwrap();

        assert_eq!(user.last_active_slot, 1);
        assert_eq!(user.liquidation_margin_freed, 96010000);
        assert_eq!(user.perp_positions[0].base_asset_amount, 14800000000);

        let MarginCalculation {
            total_collateral,
            margin_requirement_plus_buffer,
            ..
        } = calculate_margin_requirement_and_total_collateral_and_liability_info(
            &user,
            &perp_market_map,
            &spot_market_map,
            &mut oracle_map,
            MarginContext::liquidation(state.liquidation_margin_buffer_ratio),
        )
        .unwrap();

        let margin_shortage =
            ((margin_requirement_plus_buffer as i128) - total_collateral).unsigned_abs();

        let pct_margin_freed = (user.liquidation_margin_freed as u128) * PRICE_PRECISION
            / (margin_shortage + user.liquidation_margin_freed as u128);
        assert_eq!(pct_margin_freed, 600024); // ~60%

        // dont change slot, still ~60% done
        let slot = 76_u64;
        liquidate_perp(
            0,
            100 * BASE_PRECISION_U64,
            None,
            &mut user,
            &user_key,
            &mut user_stats,
            &mut liquidator,
            &liquidator_key,
            &mut liquidator_stats,
            &perp_market_map,
            &spot_market_map,
            &mut oracle_map,
            slot,
            now,
            &state,
        )
        .unwrap();

        assert_eq!(user.last_active_slot, 1);
        assert_eq!(user.liquidation_margin_freed, 96010000); // no new margin freed
        assert_eq!(user.perp_positions[0].base_asset_amount, 14800000000);

        // ~76% of liquidation finished
        let slot = 101_u64;
        liquidate_perp(
            0,
            100 * BASE_PRECISION_U64,
            None,
            &mut user,
            &user_key,
            &mut user_stats,
            &mut liquidator,
            &liquidator_key,
            &mut liquidator_stats,
            &perp_market_map,
            &spot_market_map,
            &mut oracle_map,
            slot,
            now,
            &state,
        )
        .unwrap();

        assert_eq!(user.last_active_slot, 1);
        assert_eq!(user.liquidation_margin_freed, 122660000);
        assert_eq!(user.perp_positions[0].base_asset_amount, 9470000000);

        let MarginCalculation {
            total_collateral,
            margin_requirement_plus_buffer,
            ..
        } = calculate_margin_requirement_and_total_collateral_and_liability_info(
            &user,
            &perp_market_map,
            &spot_market_map,
            &mut oracle_map,
            MarginContext::liquidation(state.liquidation_margin_buffer_ratio),
        )
        .unwrap();

        let margin_shortage =
            ((margin_requirement_plus_buffer as i128) - total_collateral).unsigned_abs();

        let pct_margin_freed = (user.liquidation_margin_freed as u128) * PRICE_PRECISION
            / (margin_shortage + user.liquidation_margin_freed as u128);
        assert_eq!(pct_margin_freed, 766577); // ~76%

        // ~100% of liquidation finished
        let slot = 136_u64;
        liquidate_perp(
            0,
            100 * BASE_PRECISION_U64,
            None,
            &mut user,
            &user_key,
            &mut user_stats,
            &mut liquidator,
            &liquidator_key,
            &mut liquidator_stats,
            &perp_market_map,
            &spot_market_map,
            &mut oracle_map,
            slot,
            now,
            &state,
        )
        .unwrap();

        assert_eq!(user.status, 0);
        assert_eq!(user.last_active_slot, 1);
        assert_eq!(user.liquidation_margin_freed, 0);
        assert_eq!(user.perp_positions[0].base_asset_amount, 2000000000);
    }

    #[test]
    pub fn liquidation_accelerated() {
        let now = 1_i64;
        let slot = 1_u64;

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
                max_fill_reserve_fraction: 100,
                order_step_size: 10000000,
                quote_asset_amount: -150 * QUOTE_PRECISION_I128,
                base_asset_amount_with_amm: BASE_PRECISION_I128,
                oracle: oracle_price_key,
                historical_oracle_data: HistoricalOracleData::default_price(oracle_price.agg.price),
                funding_period: ONE_HOUR,
                ..AMM::default()
            },
            margin_ratio_initial: 1000,
            margin_ratio_maintenance: 500,
            number_of_users_with_base: 1,
            status: MarketStatus::Initialized,
            liquidator_fee: LIQUIDATION_FEE_PRECISION / 100,
            if_liquidation_fee: LIQUIDATION_FEE_PRECISION / 100,
            ..PerpMarket::default()
        };
        create_anchor_account_info!(market, PerpMarket, market_account_info);
        let perp_market_map = PerpMarketMap::load_one(&market_account_info, true).unwrap();

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

        let mut user = User {
            orders: get_orders(Order {
                market_index: 0,
                status: OrderStatus::Open,
                order_type: OrderType::Limit,
                direction: PositionDirection::Long,
                base_asset_amount: BASE_PRECISION_U64,
                slot: 0,
                ..Order::default()
            }),
            perp_positions: get_positions(PerpPosition {
                market_index: 0,
                base_asset_amount: 2 * BASE_PRECISION_I64,
                quote_asset_amount: -200 * QUOTE_PRECISION_I64,
                quote_entry_amount: -200 * QUOTE_PRECISION_I64,
                quote_break_even_amount: -200 * QUOTE_PRECISION_I64,
                open_orders: 1,
                open_bids: BASE_PRECISION_I64,
                ..PerpPosition::default()
            }),
            spot_positions: get_spot_positions(SpotPosition {
                market_index: 0,
                balance_type: SpotBalanceType::Deposit,
                scaled_balance: 5 * SPOT_BALANCE_PRECISION_U64,
                ..SpotPosition::default()
            }),

            ..User::default()
        };

        let mut liquidator = User {
            spot_positions: get_spot_positions(SpotPosition {
                market_index: 0,
                balance_type: SpotBalanceType::Deposit,
                scaled_balance: 50 * SPOT_BALANCE_PRECISION_U64,
                ..SpotPosition::default()
            }),
            ..User::default()
        };

        let user_key = Pubkey::default();
        let liquidator_key = Pubkey::default();

        let mut user_stats = UserStats::default();
        let mut liquidator_stats = UserStats::default();
        let state = State {
            liquidation_margin_buffer_ratio: MARGIN_PRECISION / 50,
            initial_pct_to_liquidate: (LIQUIDATION_PCT_PRECISION / 10) as u16,
            liquidation_duration: 150,
            ..Default::default()
        };
        liquidate_perp(
            0,
            10 * BASE_PRECISION_U64,
            None,
            &mut user,
            &user_key,
            &mut user_stats,
            &mut liquidator,
            &liquidator_key,
            &mut liquidator_stats,
            &perp_market_map,
            &spot_market_map,
            &mut oracle_map,
            slot,
            now,
            &state,
        )
        .unwrap();

        assert_eq!(user.status, 0);
        assert_eq!(user.last_active_slot, 1);
        assert_eq!(user.liquidation_margin_freed, 0);
        assert_eq!(user.perp_positions[0].base_asset_amount, 200000000);
    }

    #[test]
    pub fn partial_liquidation_oracle_down_20_pct() {
        let now = 1_i64;
        let slot = 1_u64;

        let mut oracle_price = get_pyth_price(80, 6);
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
                max_fill_reserve_fraction: 100,
                order_step_size: 10000000,
                quote_asset_amount: -150 * QUOTE_PRECISION_I128,
                base_asset_amount_with_amm: BASE_PRECISION_I128,
                oracle: oracle_price_key,
                historical_oracle_data: HistoricalOracleData::default_price(oracle_price.agg.price),
                funding_period: ONE_HOUR,
                ..AMM::default()
            },
            margin_ratio_initial: 1000,
            margin_ratio_maintenance: 500,
            number_of_users_with_base: 1,
            status: MarketStatus::Initialized,
            liquidator_fee: LIQUIDATION_FEE_PRECISION / 100,
            if_liquidation_fee: LIQUIDATION_FEE_PRECISION / 100,
            ..PerpMarket::default()
        };
        create_anchor_account_info!(market, PerpMarket, market_account_info);
        let perp_market_map = PerpMarketMap::load_one(&market_account_info, true).unwrap();

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

        let mut user = User {
            perp_positions: get_positions(PerpPosition {
                market_index: 0,
                base_asset_amount: BASE_PRECISION_I64,
                quote_asset_amount: -100 * QUOTE_PRECISION_I64,
                quote_entry_amount: -100 * QUOTE_PRECISION_I64,
                quote_break_even_amount: -100 * QUOTE_PRECISION_I64,
                ..PerpPosition::default()
            }),
            spot_positions: get_spot_positions(SpotPosition {
                market_index: 0,
                balance_type: SpotBalanceType::Deposit,
                scaled_balance: 10 * SPOT_BALANCE_PRECISION_U64,
                ..SpotPosition::default()
            }),
            ..User::default()
        };

        let mut liquidator = User {
            spot_positions: get_spot_positions(SpotPosition {
                market_index: 0,
                balance_type: SpotBalanceType::Deposit,
                scaled_balance: 50 * SPOT_BALANCE_PRECISION_U64,
                ..SpotPosition::default()
            }),
            ..User::default()
        };

        let user_key = Pubkey::default();
        let liquidator_key = Pubkey::default();

        let mut user_stats = UserStats::default();
        let mut liquidator_stats = UserStats::default();
        let state = State {
            liquidation_margin_buffer_ratio: MARGIN_PRECISION / 50,
            initial_pct_to_liquidate: (LIQUIDATION_PCT_PRECISION / 10) as u16,
            liquidation_duration: 150,
            ..Default::default()
        };
        liquidate_perp(
            0,
            10 * BASE_PRECISION_U64,
            None,
            &mut user,
            &user_key,
            &mut user_stats,
            &mut liquidator,
            &liquidator_key,
            &mut liquidator_stats,
            &perp_market_map,
            &spot_market_map,
            &mut oracle_map,
            slot,
            now,
            &state,
        )
        .unwrap();

        assert_eq!(user.last_active_slot, 1);
        assert_eq!(user.liquidation_margin_freed, 4800000);
        assert_eq!(user.perp_positions[0].base_asset_amount, 0);
    }

    #[test]
    pub fn successful_liquidation_half_of_if_fee() {
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
                max_fill_reserve_fraction: 100,
                order_step_size: 10000000,
                quote_asset_amount: 50 * QUOTE_PRECISION_I128,
                base_asset_amount_with_amm: BASE_PRECISION_I128,
                oracle: oracle_price_key,
                historical_oracle_data: HistoricalOracleData::default_price(oracle_price.agg.price),
                funding_period: 3600,
                ..AMM::default()
            },
            margin_ratio_initial: 1000,
            margin_ratio_maintenance: 500,
            number_of_users_with_base: 1,
            number_of_users: 1,
            status: MarketStatus::Initialized,
            liquidator_fee: LIQUIDATION_FEE_PRECISION / 100,
            if_liquidation_fee: LIQUIDATION_FEE_PRECISION / 100,
            ..PerpMarket::default()
        };
        create_anchor_account_info!(market, PerpMarket, market_account_info);
        let perp_market_map = PerpMarketMap::load_one(&market_account_info, true).unwrap();

        let mut spot_market = SpotMarket {
            market_index: 0,
            oracle_source: OracleSource::QuoteAsset,
            cumulative_deposit_interest: SPOT_CUMULATIVE_INTEREST_PRECISION,
            decimals: 6,
            initial_asset_weight: SPOT_WEIGHT_PRECISION,
            historical_oracle_data: HistoricalOracleData {
                last_oracle_price_twap: PRICE_PRECISION_I64,
                last_oracle_price_twap_5min: PRICE_PRECISION_I64,
                ..HistoricalOracleData::default()
            },
            ..SpotMarket::default()
        };
        create_anchor_account_info!(spot_market, SpotMarket, spot_market_account_info);
        let spot_market_map = SpotMarketMap::load_one(&spot_market_account_info, true).unwrap();

        let mut user = User {
            perp_positions: get_positions(PerpPosition {
                market_index: 0,
                base_asset_amount: -BASE_PRECISION_I64,
                quote_asset_amount: 100 * QUOTE_PRECISION_I64,
                quote_entry_amount: 100 * QUOTE_PRECISION_I64,
                quote_break_even_amount: 100 * QUOTE_PRECISION_I64,
                ..PerpPosition::default()
            }),
            spot_positions: get_spot_positions(SpotPosition {
                market_index: 0,
                balance_type: SpotBalanceType::Deposit,
                scaled_balance: 15 * SPOT_BALANCE_PRECISION_U64 / 10, // $1.5
                ..SpotPosition::default()
            }),
            ..User::default()
        };

        let mut liquidator = User {
            spot_positions: get_spot_positions(SpotPosition {
                market_index: 0,
                balance_type: SpotBalanceType::Deposit,
                scaled_balance: 50 * SPOT_BALANCE_PRECISION_U64,
                ..SpotPosition::default()
            }),
            ..User::default()
        };

        let user_key = Pubkey::default();
        let liquidator_key = Pubkey::default();

        let mut user_stats = UserStats::default();
        let mut liquidator_stats = UserStats::default();
        let state = State {
            liquidation_margin_buffer_ratio: 10,
            initial_pct_to_liquidate: LIQUIDATION_PCT_PRECISION as u16,
            liquidation_duration: 150,
            ..Default::default()
        };
        liquidate_perp(
            0,
            BASE_PRECISION_U64,
            None,
            &mut user,
            &user_key,
            &mut user_stats,
            &mut liquidator,
            &liquidator_key,
            &mut liquidator_stats,
            &perp_market_map,
            &spot_market_map,
            &mut oracle_map,
            slot,
            now,
            &state,
        )
        .unwrap();

        let market_after = perp_market_map.get_ref(&0).unwrap();
        // .5% * 100 * .95 =$0.475
        assert_eq!(market_after.amm.total_liquidation_fee, 475000);
    }

    #[test]
    pub fn successful_liquidation_portion_of_if_fee() {
        let now = 0_i64;
        let slot = 0_u64;

        let mut oracle_price = get_hardcoded_pyth_price(23244136, 6);
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
                max_fill_reserve_fraction: 100,
                order_step_size: 10000000,
                quote_asset_amount: 50 * QUOTE_PRECISION_I128,
                base_asset_amount_with_amm: BASE_PRECISION_I128,
                oracle: oracle_price_key,
                historical_oracle_data: HistoricalOracleData::default_price(oracle_price.agg.price),
                funding_period: 3600,
                ..AMM::default()
            },
            margin_ratio_initial: 1000,
            margin_ratio_maintenance: 500,
            number_of_users_with_base: 1,
            number_of_users: 1,
            status: MarketStatus::Initialized,
            liquidator_fee: LIQUIDATION_FEE_PRECISION / 100,
            if_liquidation_fee: LIQUIDATION_FEE_PRECISION / 100,
            ..PerpMarket::default()
        };
        create_anchor_account_info!(market, PerpMarket, market_account_info);
        let perp_market_map = PerpMarketMap::load_one(&market_account_info, true).unwrap();

        let mut spot_market = SpotMarket {
            market_index: 0,
            oracle_source: OracleSource::QuoteAsset,
            cumulative_deposit_interest: SPOT_CUMULATIVE_INTEREST_PRECISION,
            decimals: 6,
            initial_asset_weight: SPOT_WEIGHT_PRECISION,
            historical_oracle_data: HistoricalOracleData {
                last_oracle_price_twap: PRICE_PRECISION_I64,
                last_oracle_price_twap_5min: PRICE_PRECISION_I64,
                ..HistoricalOracleData::default()
            },
            ..SpotMarket::default()
        };
        create_anchor_account_info!(spot_market, SpotMarket, spot_market_account_info);
        let spot_market_map = SpotMarketMap::load_one(&spot_market_account_info, true).unwrap();

        let mut user = User {
            perp_positions: get_positions(PerpPosition {
                market_index: 0,
                base_asset_amount: -299400000000,
                quote_asset_amount: 6959294318,
                quote_entry_amount: 6959294318,
                quote_break_even_amount: 6959294318,
                ..PerpPosition::default()
            }),
            spot_positions: get_spot_positions(SpotPosition {
                market_index: 0,
                balance_type: SpotBalanceType::Deposit,
                scaled_balance: 113838792 * 1000,
                ..SpotPosition::default()
            }),
            ..User::default()
        };

        let mut liquidator = User {
            spot_positions: get_spot_positions(SpotPosition {
                market_index: 0,
                balance_type: SpotBalanceType::Deposit,
                scaled_balance: 50000 * SPOT_BALANCE_PRECISION_U64,
                ..SpotPosition::default()
            }),
            ..User::default()
        };

        let user_key = Pubkey::default();
        let liquidator_key = Pubkey::default();

        let mut user_stats = UserStats::default();
        let mut liquidator_stats = UserStats::default();
        let state = State {
            liquidation_margin_buffer_ratio: 200,
            initial_pct_to_liquidate: LIQUIDATION_PCT_PRECISION as u16,
            liquidation_duration: 150,
            ..Default::default()
        };
        liquidate_perp(
            0,
            300 * BASE_PRECISION_U64,
            None,
            &mut user,
            &user_key,
            &mut user_stats,
            &mut liquidator,
            &liquidator_key,
            &mut liquidator_stats,
            &perp_market_map,
            &spot_market_map,
            &mut oracle_map,
            slot,
            now,
            &state,
        )
        .unwrap();

        let market_after = perp_market_map.get_ref(&0).unwrap();
        assert!(!user.is_being_liquidated());
        assert_eq!(market_after.amm.total_liquidation_fee, 41787043);
    }

    #[test]
    pub fn successful_liquidate_perp_with_fill_long_high_leverage() {
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
                max_fill_reserve_fraction: 100,
                order_step_size: 10000000,
                quote_asset_amount: -150 * QUOTE_PRECISION_I128,
                base_asset_amount_with_amm: BASE_PRECISION_I128,
                oracle: oracle_price_key,
                historical_oracle_data: HistoricalOracleData::default_price(oracle_price.agg.price),
                funding_period: ONE_HOUR,
                ..AMM::default()
            },
            margin_ratio_initial: 1000,
            margin_ratio_maintenance: 500,
            high_leverage_margin_ratio_initial: 200,
            high_leverage_margin_ratio_maintenance: 100,
            number_of_users_with_base: 1,
            status: MarketStatus::Initialized,
            liquidator_fee: LIQUIDATION_FEE_PRECISION / 200,
            if_liquidation_fee: LIQUIDATION_FEE_PRECISION / 200,
            ..PerpMarket::default()
        };
        create_anchor_account_info!(market, PerpMarket, market_account_info);
        let perp_market_map = PerpMarketMap::load_one(&market_account_info, true).unwrap();

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

        let mut user = User {
            orders: get_orders(Order {
                market_index: 0,
                status: OrderStatus::Open,
                order_type: OrderType::Limit,
                direction: PositionDirection::Long,
                base_asset_amount: BASE_PRECISION_U64,
                slot: 0,
                ..Order::default()
            }),
            perp_positions: get_positions(PerpPosition {
                market_index: 0,
                base_asset_amount: 2 * BASE_PRECISION_I64,
                quote_asset_amount: -200 * QUOTE_PRECISION_I64,
                quote_entry_amount: -200 * QUOTE_PRECISION_I64,
                quote_break_even_amount: -200 * QUOTE_PRECISION_I64,
                open_orders: 1,
                open_bids: BASE_PRECISION_I64,
                ..PerpPosition::default()
            }),
            spot_positions: get_spot_positions(SpotPosition {
                market_index: 0,
                balance_type: SpotBalanceType::Deposit,
                scaled_balance: 3 * SPOT_BALANCE_PRECISION_U64,
                ..SpotPosition::default()
            }),
            margin_mode: MarginMode::HighLeverage,
            ..User::default()
        };

        let mut liquidator = User {
            spot_positions: get_spot_positions(SpotPosition {
                market_index: 0,
                balance_type: SpotBalanceType::Deposit,
                scaled_balance: 50 * SPOT_BALANCE_PRECISION_U64,
                ..SpotPosition::default()
            }),
            ..User::default()
        };

        let user_key = Pubkey::default();
        let liquidator_key = Pubkey::default();

        let mut user_stats = UserStats::default();
        let mut liquidator_stats = UserStats::default();
        let state = State {
            liquidation_margin_buffer_ratio: MARGIN_PRECISION / 50,
            initial_pct_to_liquidate: LIQUIDATION_PCT_PRECISION as u16,
            liquidation_duration: 150,
            ..Default::default()
        };
        liquidate_perp(
            0,
            10 * BASE_PRECISION_U64,
            None,
            &mut user,
            &user_key,
            &mut user_stats,
            &mut liquidator,
            &liquidator_key,
            &mut liquidator_stats,
            &perp_market_map,
            &spot_market_map,
            &mut oracle_map,
            slot,
            now,
            &state,
        )
        .unwrap();

        assert_eq!(user.perp_positions[0].base_asset_amount, 790000000);
        assert_eq!(user.perp_positions[0].quote_asset_amount, -79614680);
        assert_eq!(user.perp_positions[0].quote_entry_amount, -79000000);
        assert_eq!(user.perp_positions[0].quote_break_even_amount, -79614680);
        assert_eq!(user.perp_positions[0].open_orders, 0);
        assert_eq!(user.perp_positions[0].open_bids, 0);

        let MarginCalculation {
            total_collateral,
            margin_requirement_plus_buffer,
            ..
        } = calculate_margin_requirement_and_total_collateral_and_liability_info(
            &user,
            &perp_market_map,
            &spot_market_map,
            &mut oracle_map,
            MarginContext::liquidation(state.liquidation_margin_buffer_ratio),
        )
        .unwrap();

        // user out of liq territory
        assert!(total_collateral.unsigned_abs() > margin_requirement_plus_buffer);

        let oracle_price = oracle_map
            .get_price_data(&(oracle_price_key, OracleSource::Pyth))
            .unwrap()
            .price;

        let perp_value = calculate_base_asset_value_with_oracle_price(
            user.perp_positions[0].base_asset_amount as i128,
            oracle_price,
        )
        .unwrap();

        let margin_ratio = total_collateral.unsigned_abs() * MARGIN_PRECISION_U128 / perp_value;

        assert_eq!(margin_ratio, 301);

        assert_eq!(liquidator.perp_positions[0].base_asset_amount, 1210000000);
        assert_eq!(liquidator.perp_positions[0].quote_asset_amount, -120990320);

        let market_after = perp_market_map.get_ref(&0).unwrap();
        assert_eq!(market_after.amm.total_liquidation_fee, 605000)
    }
}

pub mod liquidate_perp_with_fill {

    use crate::state::state::State;
    use std::str::FromStr;

    use anchor_lang::prelude::AccountLoader;
    use anchor_lang::Owner;
    use solana_program::clock::Clock;
    use solana_program::pubkey::Pubkey;

    use crate::controller::liquidation::liquidate_perp_with_fill;
    use crate::controller::position::PositionDirection;
    use crate::create_anchor_account_info;

    use crate::math::constants::{
        AMM_RESERVE_PRECISION, BASE_PRECISION_I64, BASE_PRECISION_U64, LIQUIDATION_FEE_PRECISION,
        LIQUIDATION_PCT_PRECISION, PEG_PRECISION, PRICE_PRECISION_U64, QUOTE_PRECISION_I128,
        QUOTE_PRECISION_I64, SPOT_BALANCE_PRECISION_U64, SPOT_CUMULATIVE_INTEREST_PRECISION,
        SPOT_WEIGHT_PRECISION,
    };

    use crate::state::oracle::{HistoricalOracleData, OracleSource};
    use crate::state::oracle_map::OracleMap;
    use crate::state::perp_market::{MarketStatus, PerpMarket, AMM};
    use crate::state::perp_market_map::PerpMarketMap;
    use crate::state::spot_market::{SpotBalanceType, SpotMarket};
    use crate::state::spot_market_map::SpotMarketMap;
    use crate::state::user::{
        Order, OrderStatus, OrderType, PerpPosition, SpotPosition, User, UserStats,
    };
    use crate::state::user_map::{UserMap, UserStatsMap};
    use crate::test_utils::*;
    use crate::test_utils::{get_orders, get_positions, get_pyth_price, get_spot_positions};
    use crate::{create_account_info, PRICE_PRECISION_I64};

    #[test]
    pub fn successful_liquidate_perp_with_fill_long() {
        let now = 0_i64;
        let slot = 100_u64;

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

        let mut market = PerpMarket {
            amm: AMM {
                base_asset_reserve: 100 * AMM_RESERVE_PRECISION,
                quote_asset_reserve: 100 * AMM_RESERVE_PRECISION,
                terminal_quote_asset_reserve: 100 * AMM_RESERVE_PRECISION,
                bid_base_asset_reserve: 101 * AMM_RESERVE_PRECISION,
                bid_quote_asset_reserve: 99 * AMM_RESERVE_PRECISION,
                ask_base_asset_reserve: 99 * AMM_RESERVE_PRECISION,
                ask_quote_asset_reserve: 101 * AMM_RESERVE_PRECISION,
                sqrt_k: 100 * AMM_RESERVE_PRECISION,
                peg_multiplier: 100 * PEG_PRECISION,
                max_slippage_ratio: 50,
                max_fill_reserve_fraction: 100,
                order_step_size: 10000000,
                order_tick_size: 1,
                quote_asset_amount: -150 * QUOTE_PRECISION_I128,
                base_asset_amount_with_amm: 0,
                oracle: oracle_price_key,
                historical_oracle_data: HistoricalOracleData::default_price(oracle_price.agg.price),
                ..AMM::default()
            },
            margin_ratio_initial: 1000,
            margin_ratio_maintenance: 500,
            number_of_users_with_base: 1,
            status: MarketStatus::Active,
            liquidator_fee: LIQUIDATION_FEE_PRECISION / 100,
            if_liquidation_fee: LIQUIDATION_FEE_PRECISION / 100,
            ..PerpMarket::default()
        };
        create_anchor_account_info!(market, PerpMarket, market_account_info);
        let perp_market_map = PerpMarketMap::load_one(&market_account_info, true).unwrap();

        let mut spot_market = SpotMarket {
            market_index: 0,
            oracle_source: OracleSource::QuoteAsset,
            cumulative_deposit_interest: SPOT_CUMULATIVE_INTEREST_PRECISION,
            decimals: 6,
            initial_asset_weight: SPOT_WEIGHT_PRECISION,
            historical_oracle_data: HistoricalOracleData {
                last_oracle_price_twap: PRICE_PRECISION_I64,
                last_oracle_price_twap_5min: PRICE_PRECISION_I64,
                ..HistoricalOracleData::default()
            },
            ..SpotMarket::default()
        };
        create_anchor_account_info!(spot_market, SpotMarket, spot_market_account_info);
        let spot_market_map = SpotMarketMap::load_one(&spot_market_account_info, true).unwrap();

        let user_key = Pubkey::new_unique();
        let liquidator_key = Pubkey::new_unique();

        let mut user = User {
            perp_positions: get_positions(PerpPosition {
                market_index: 0,
                base_asset_amount: BASE_PRECISION_I64,
                quote_asset_amount: -100 * QUOTE_PRECISION_I64,
                quote_entry_amount: -100 * QUOTE_PRECISION_I64,
                quote_break_even_amount: -100 * QUOTE_PRECISION_I64,
                open_orders: 0,
                open_bids: 0,
                ..PerpPosition::default()
            }),
            spot_positions: get_spot_positions(SpotPosition {
                market_index: 0,
                balance_type: SpotBalanceType::Deposit,
                scaled_balance: 4 * SPOT_BALANCE_PRECISION_U64,
                ..SpotPosition::default()
            }),

            ..User::default()
        };

        create_anchor_account_info!(user, &user_key, User, user_account_info);
        let user_account_loader: AccountLoader<User> =
            AccountLoader::try_from(&user_account_info).unwrap();

        let liquidator_authority = Pubkey::new_unique();
        let mut liquidator = User {
            authority: liquidator_authority,
            spot_positions: get_spot_positions(SpotPosition {
                market_index: 0,
                balance_type: SpotBalanceType::Deposit,
                scaled_balance: 50 * SPOT_BALANCE_PRECISION_U64,
                ..SpotPosition::default()
            }),
            ..User::default()
        };

        create_anchor_account_info!(liquidator, &liquidator_key, User, liquidator_account_info);
        let liquidator_account_loader: AccountLoader<User> =
            AccountLoader::try_from(&liquidator_account_info).unwrap();

        let mut user_stats = UserStats::default();

        create_anchor_account_info!(user_stats, UserStats, user_stats_account_info);
        let user_stats_account_loader: AccountLoader<UserStats> =
            AccountLoader::try_from(&user_stats_account_info).unwrap();

        let mut liquidator_stats = UserStats::default();

        create_anchor_account_info!(liquidator_stats, UserStats, liquidator_stats_account_info);
        let liquidator_stats_account_loader: AccountLoader<UserStats> =
            AccountLoader::try_from(&liquidator_stats_account_info).unwrap();

        let state = State {
            liquidation_margin_buffer_ratio: 10,
            initial_pct_to_liquidate: LIQUIDATION_PCT_PRECISION as u16,
            liquidation_duration: 150,
            ..Default::default()
        };

        let maker_key = Pubkey::new_unique();
        let maker_authority = Pubkey::new_unique();
        let mut maker = User {
            authority: maker_authority,
            orders: get_orders(Order {
                status: OrderStatus::Open,
                market_index: 0,
                post_only: true,
                order_type: OrderType::Limit,
                direction: PositionDirection::Long,
                base_asset_amount: BASE_PRECISION_U64 / 2,
                price: 100 * PRICE_PRECISION_U64,
                slot: slot - 1,
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
                scaled_balance: 100 * SPOT_BALANCE_PRECISION_U64,
                ..SpotPosition::default()
            }),
            ..User::default()
        };
        create_anchor_account_info!(maker, &maker_key, User, maker_account_info);
        let makers_and_referrers = UserMap::load_one(&maker_account_info).unwrap();

        let mut maker_stats = UserStats {
            authority: maker_authority,
            ..UserStats::default()
        };
        create_anchor_account_info!(maker_stats, UserStats, maker_stats_account_info);
        let maker_and_referrer_stats = UserStatsMap::load_one(&maker_stats_account_info).unwrap();

        let clock = Clock {
            slot,
            unix_timestamp: now,
            ..Clock::default()
        };

        liquidate_perp_with_fill(
            0,
            &user_account_loader,
            &user_key,
            &user_stats_account_loader,
            &liquidator_account_loader,
            &liquidator_key,
            &liquidator_stats_account_loader,
            &makers_and_referrers,
            &maker_and_referrer_stats,
            &perp_market_map,
            &spot_market_map,
            &mut oracle_map,
            &clock,
            &state,
        )
        .unwrap();

        let user = user_account_loader.load().unwrap();
        assert_eq!(user.perp_positions[0].base_asset_amount, 640000000);
        assert_eq!(user.perp_positions[0].quote_asset_amount, -64396000);
        assert_eq!(user.perp_positions[0].open_orders, 0);
        assert_eq!(user.perp_positions[0].open_bids, 0);

        let maker = makers_and_referrers.get_ref(&maker_key).unwrap();
        assert_eq!(maker.perp_positions[0].base_asset_amount, 360000000);
        assert_eq!(maker.perp_positions[0].quote_asset_amount, -35992800);

        let liquidator = liquidator_account_loader.load().unwrap();
        assert_eq!(liquidator.perp_positions[0].base_asset_amount, 0);
        assert_eq!(liquidator.perp_positions[0].quote_asset_amount, 3600);

        let market_after = perp_market_map.get_ref(&0).unwrap();
        assert_eq!(market_after.amm.total_liquidation_fee, 360000);
    }

    #[test]
    pub fn successful_liquidate_perp_with_fill_short() {
        let now = 0_i64;
        let slot = 100_u64;

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

        let mut market = PerpMarket {
            amm: AMM {
                base_asset_reserve: 100 * AMM_RESERVE_PRECISION,
                quote_asset_reserve: 100 * AMM_RESERVE_PRECISION,
                terminal_quote_asset_reserve: 100 * AMM_RESERVE_PRECISION,
                bid_base_asset_reserve: 101 * AMM_RESERVE_PRECISION,
                bid_quote_asset_reserve: 99 * AMM_RESERVE_PRECISION,
                ask_base_asset_reserve: 99 * AMM_RESERVE_PRECISION,
                ask_quote_asset_reserve: 101 * AMM_RESERVE_PRECISION,
                sqrt_k: 100 * AMM_RESERVE_PRECISION,
                peg_multiplier: 100 * PEG_PRECISION,
                max_slippage_ratio: 50,
                max_fill_reserve_fraction: 100,
                order_step_size: 10000000,
                order_tick_size: 1,
                quote_asset_amount: -150 * QUOTE_PRECISION_I128,
                base_asset_amount_with_amm: 0,
                oracle: oracle_price_key,
                historical_oracle_data: HistoricalOracleData::default_price(oracle_price.agg.price),
                ..AMM::default()
            },
            margin_ratio_initial: 1000,
            margin_ratio_maintenance: 500,
            number_of_users_with_base: 1,
            status: MarketStatus::Active,
            liquidator_fee: LIQUIDATION_FEE_PRECISION / 100,
            if_liquidation_fee: LIQUIDATION_FEE_PRECISION / 100,
            ..PerpMarket::default()
        };
        create_anchor_account_info!(market, PerpMarket, market_account_info);
        let perp_market_map = PerpMarketMap::load_one(&market_account_info, true).unwrap();

        let mut spot_market = SpotMarket {
            market_index: 0,
            oracle_source: OracleSource::QuoteAsset,
            cumulative_deposit_interest: SPOT_CUMULATIVE_INTEREST_PRECISION,
            decimals: 6,
            initial_asset_weight: SPOT_WEIGHT_PRECISION,
            historical_oracle_data: HistoricalOracleData {
                last_oracle_price_twap: PRICE_PRECISION_I64,
                last_oracle_price_twap_5min: PRICE_PRECISION_I64,
                ..HistoricalOracleData::default()
            },
            ..SpotMarket::default()
        };
        create_anchor_account_info!(spot_market, SpotMarket, spot_market_account_info);
        let spot_market_map = SpotMarketMap::load_one(&spot_market_account_info, true).unwrap();

        let user_key = Pubkey::new_unique();
        let liquidator_key = Pubkey::new_unique();

        let mut user = User {
            perp_positions: get_positions(PerpPosition {
                market_index: 0,
                base_asset_amount: -BASE_PRECISION_I64,
                quote_asset_amount: 100 * QUOTE_PRECISION_I64,
                quote_entry_amount: 100 * QUOTE_PRECISION_I64,
                quote_break_even_amount: 100 * QUOTE_PRECISION_I64,
                open_orders: 0,
                open_bids: 0,
                ..PerpPosition::default()
            }),
            spot_positions: get_spot_positions(SpotPosition {
                market_index: 0,
                balance_type: SpotBalanceType::Deposit,
                scaled_balance: 4 * SPOT_BALANCE_PRECISION_U64,
                ..SpotPosition::default()
            }),

            ..User::default()
        };

        create_anchor_account_info!(user, &user_key, User, user_account_info);
        let user_account_loader: AccountLoader<User> =
            AccountLoader::try_from(&user_account_info).unwrap();

        let liquidator_authority = Pubkey::new_unique();
        let mut liquidator = User {
            authority: liquidator_authority,
            spot_positions: get_spot_positions(SpotPosition {
                market_index: 0,
                balance_type: SpotBalanceType::Deposit,
                scaled_balance: 50 * SPOT_BALANCE_PRECISION_U64,
                ..SpotPosition::default()
            }),
            ..User::default()
        };

        create_anchor_account_info!(liquidator, &liquidator_key, User, liquidator_account_info);
        let liquidator_account_loader: AccountLoader<User> =
            AccountLoader::try_from(&liquidator_account_info).unwrap();

        let mut user_stats = UserStats::default();

        create_anchor_account_info!(user_stats, UserStats, user_stats_account_info);
        let user_stats_account_loader: AccountLoader<UserStats> =
            AccountLoader::try_from(&user_stats_account_info).unwrap();

        let mut liquidator_stats = UserStats::default();

        create_anchor_account_info!(liquidator_stats, UserStats, liquidator_stats_account_info);
        let liquidator_stats_account_loader: AccountLoader<UserStats> =
            AccountLoader::try_from(&liquidator_stats_account_info).unwrap();

        let state = State {
            liquidation_margin_buffer_ratio: 10,
            initial_pct_to_liquidate: LIQUIDATION_PCT_PRECISION as u16,
            liquidation_duration: 150,
            ..Default::default()
        };

        let maker_key = Pubkey::new_unique();
        let maker_authority = Pubkey::new_unique();
        let mut maker = User {
            authority: maker_authority,
            orders: get_orders(Order {
                status: OrderStatus::Open,
                market_index: 0,
                post_only: true,
                order_type: OrderType::Limit,
                direction: PositionDirection::Short,
                base_asset_amount: BASE_PRECISION_U64 / 2,
                price: 100 * PRICE_PRECISION_U64,
                slot: slot - 1,
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

        let mut maker_stats = UserStats {
            authority: maker_authority,
            ..UserStats::default()
        };
        create_anchor_account_info!(maker_stats, UserStats, maker_stats_account_info);
        let maker_and_referrer_stats = UserStatsMap::load_one(&maker_stats_account_info).unwrap();

        let clock = Clock {
            slot,
            unix_timestamp: now,
            ..Clock::default()
        };

        liquidate_perp_with_fill(
            0,
            &user_account_loader,
            &user_key,
            &user_stats_account_loader,
            &liquidator_account_loader,
            &liquidator_key,
            &liquidator_stats_account_loader,
            &makers_and_referrers,
            &maker_and_referrer_stats,
            &perp_market_map,
            &spot_market_map,
            &mut oracle_map,
            &clock,
            &state,
        )
        .unwrap();

        let user = user_account_loader.load().unwrap();
        assert_eq!(user.perp_positions[0].base_asset_amount, -640000000);
        assert_eq!(user.perp_positions[0].quote_asset_amount, 63604000);
        assert_eq!(user.perp_positions[0].open_orders, 0);
        assert_eq!(user.perp_positions[0].open_bids, 0);

        let maker = makers_and_referrers.get_ref(&maker_key).unwrap();
        assert_eq!(maker.perp_positions[0].base_asset_amount, -360000000);
        assert_eq!(maker.perp_positions[0].quote_asset_amount, 36007200);

        let liquidator = liquidator_account_loader.load().unwrap();
        assert_eq!(liquidator.perp_positions[0].base_asset_amount, 0);
        assert_eq!(liquidator.perp_positions[0].quote_asset_amount, 3600);

        let market_after = perp_market_map.get_ref(&0).unwrap();
        assert_eq!(market_after.amm.total_liquidation_fee, 360000);
    }

    #[test]
    pub fn successful_liquidate_perp_with_fill_long_with_amm() {
        let now = 0_i64;
        let slot = 100_u64;

        let mut oracle_price = get_pyth_price(100, 6);
        oracle_price.curr_slot = slot;
        oracle_price.valid_slot = slot;
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

        let mut market = PerpMarket {
            amm: AMM {
                base_asset_reserve: 100 * AMM_RESERVE_PRECISION,
                quote_asset_reserve: 100 * AMM_RESERVE_PRECISION,
                terminal_quote_asset_reserve: 100 * AMM_RESERVE_PRECISION,
                bid_base_asset_reserve: 100 * AMM_RESERVE_PRECISION,
                bid_quote_asset_reserve: 100 * AMM_RESERVE_PRECISION,
                ask_base_asset_reserve: 100 * AMM_RESERVE_PRECISION,
                ask_quote_asset_reserve: 100 * AMM_RESERVE_PRECISION,
                sqrt_k: 100 * AMM_RESERVE_PRECISION,
                peg_multiplier: 100 * PEG_PRECISION,
                max_slippage_ratio: 50,
                max_fill_reserve_fraction: 100,
                order_step_size: 10000000,
                order_tick_size: 1,
                quote_asset_amount: -150 * QUOTE_PRECISION_I128,
                base_asset_amount_with_amm: 0,
                oracle: oracle_price_key,
                historical_oracle_data: HistoricalOracleData::default_price(oracle_price.agg.price),
                ..AMM::default()
            },
            margin_ratio_initial: 1000,
            margin_ratio_maintenance: 500,
            number_of_users_with_base: 1,
            status: MarketStatus::Active,
            liquidator_fee: LIQUIDATION_FEE_PRECISION / 100,
            if_liquidation_fee: LIQUIDATION_FEE_PRECISION / 100,
            ..PerpMarket::default()
        };
        market.amm.max_fill_reserve_fraction = 1;
        market.amm.max_base_asset_reserve = u64::MAX as u128;
        market.amm.min_base_asset_reserve = 0;
        create_anchor_account_info!(market, PerpMarket, market_account_info);
        let perp_market_map = PerpMarketMap::load_one(&market_account_info, true).unwrap();

        let mut spot_market = SpotMarket {
            market_index: 0,
            oracle_source: OracleSource::QuoteAsset,
            cumulative_deposit_interest: SPOT_CUMULATIVE_INTEREST_PRECISION,
            decimals: 6,
            initial_asset_weight: SPOT_WEIGHT_PRECISION,
            historical_oracle_data: HistoricalOracleData {
                last_oracle_price_twap: PRICE_PRECISION_I64,
                last_oracle_price_twap_5min: PRICE_PRECISION_I64,
                ..HistoricalOracleData::default()
            },
            ..SpotMarket::default()
        };
        create_anchor_account_info!(spot_market, SpotMarket, spot_market_account_info);
        let spot_market_map = SpotMarketMap::load_one(&spot_market_account_info, true).unwrap();

        let user_key = Pubkey::new_unique();
        let liquidator_key = Pubkey::new_unique();

        let mut user = User {
            perp_positions: get_positions(PerpPosition {
                market_index: 0,
                base_asset_amount: BASE_PRECISION_I64,
                quote_asset_amount: -100 * QUOTE_PRECISION_I64,
                quote_entry_amount: -100 * QUOTE_PRECISION_I64,
                quote_break_even_amount: -100 * QUOTE_PRECISION_I64,
                open_orders: 0,
                open_bids: 0,
                ..PerpPosition::default()
            }),
            spot_positions: get_spot_positions(SpotPosition {
                market_index: 0,
                balance_type: SpotBalanceType::Deposit,
                scaled_balance: 4 * SPOT_BALANCE_PRECISION_U64,
                ..SpotPosition::default()
            }),

            ..User::default()
        };

        create_anchor_account_info!(user, &user_key, User, user_account_info);
        let user_account_loader: AccountLoader<User> =
            AccountLoader::try_from(&user_account_info).unwrap();

        let liquidator_authority = Pubkey::new_unique();
        let mut liquidator = User {
            authority: liquidator_authority,
            spot_positions: get_spot_positions(SpotPosition {
                market_index: 0,
                balance_type: SpotBalanceType::Deposit,
                scaled_balance: 50 * SPOT_BALANCE_PRECISION_U64,
                ..SpotPosition::default()
            }),
            ..User::default()
        };

        create_anchor_account_info!(liquidator, &liquidator_key, User, liquidator_account_info);
        let liquidator_account_loader: AccountLoader<User> =
            AccountLoader::try_from(&liquidator_account_info).unwrap();

        let mut user_stats = UserStats::default();

        create_anchor_account_info!(user_stats, UserStats, user_stats_account_info);
        let user_stats_account_loader: AccountLoader<UserStats> =
            AccountLoader::try_from(&user_stats_account_info).unwrap();

        let mut liquidator_stats = UserStats::default();

        create_anchor_account_info!(liquidator_stats, UserStats, liquidator_stats_account_info);
        let liquidator_stats_account_loader: AccountLoader<UserStats> =
            AccountLoader::try_from(&liquidator_stats_account_info).unwrap();

        let state = State {
            liquidation_margin_buffer_ratio: 10,
            initial_pct_to_liquidate: LIQUIDATION_PCT_PRECISION as u16,
            liquidation_duration: 150,
            ..Default::default()
        };

        let clock = Clock {
            slot,
            unix_timestamp: now,
            ..Clock::default()
        };

        liquidate_perp_with_fill(
            0,
            &user_account_loader,
            &user_key,
            &user_stats_account_loader,
            &liquidator_account_loader,
            &liquidator_key,
            &liquidator_stats_account_loader,
            &UserMap::empty(),
            &UserStatsMap::empty(),
            &perp_market_map,
            &spot_market_map,
            &mut oracle_map,
            &clock,
            &state,
        )
        .unwrap();

        let user = user_account_loader.load().unwrap();
        assert_eq!(user.perp_positions[0].base_asset_amount, 640000000);
        assert_eq!(user.perp_positions[0].quote_asset_amount, -64523715);
        assert_eq!(user.perp_positions[0].open_orders, 0);
        assert_eq!(user.perp_positions[0].open_bids, 0);

        let liquidator = liquidator_account_loader.load().unwrap();
        assert_eq!(liquidator.perp_positions[0].base_asset_amount, 0);
        assert_eq!(liquidator.perp_positions[0].quote_asset_amount, 3587);

        let market_after = perp_market_map.get_ref(&0).unwrap();
        assert_eq!(market_after.amm.total_liquidation_fee, 358708);
    }

    #[test]
    pub fn successful_liquidate_perp_with_fill_short_with_amm() {
        let now = 0_i64;
        let slot = 100_u64;

        let mut oracle_price = get_pyth_price(100, 6);
        oracle_price.curr_slot = slot;
        oracle_price.valid_slot = slot;
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

        let mut market = PerpMarket {
            amm: AMM {
                base_asset_reserve: 100 * AMM_RESERVE_PRECISION,
                quote_asset_reserve: 100 * AMM_RESERVE_PRECISION,
                terminal_quote_asset_reserve: 100 * AMM_RESERVE_PRECISION,
                bid_base_asset_reserve: 100 * AMM_RESERVE_PRECISION,
                bid_quote_asset_reserve: 100 * AMM_RESERVE_PRECISION,
                ask_base_asset_reserve: 100 * AMM_RESERVE_PRECISION,
                ask_quote_asset_reserve: 100 * AMM_RESERVE_PRECISION,
                sqrt_k: 100 * AMM_RESERVE_PRECISION,
                peg_multiplier: 100 * PEG_PRECISION,
                max_slippage_ratio: 50,
                max_fill_reserve_fraction: 100,
                order_step_size: 10000000,
                order_tick_size: 1,
                quote_asset_amount: -150 * QUOTE_PRECISION_I128,
                base_asset_amount_with_amm: 0,
                oracle: oracle_price_key,
                historical_oracle_data: HistoricalOracleData::default_price(oracle_price.agg.price),
                ..AMM::default()
            },
            margin_ratio_initial: 1000,
            margin_ratio_maintenance: 500,
            number_of_users_with_base: 1,
            status: MarketStatus::Active,
            liquidator_fee: LIQUIDATION_FEE_PRECISION / 100,
            if_liquidation_fee: LIQUIDATION_FEE_PRECISION / 100,
            ..PerpMarket::default()
        };
        market.amm.max_fill_reserve_fraction = 1;
        market.amm.max_base_asset_reserve = u64::MAX as u128;
        market.amm.min_base_asset_reserve = 0;
        create_anchor_account_info!(market, PerpMarket, market_account_info);
        let perp_market_map = PerpMarketMap::load_one(&market_account_info, true).unwrap();

        let mut spot_market = SpotMarket {
            market_index: 0,
            oracle_source: OracleSource::QuoteAsset,
            cumulative_deposit_interest: SPOT_CUMULATIVE_INTEREST_PRECISION,
            decimals: 6,
            initial_asset_weight: SPOT_WEIGHT_PRECISION,
            historical_oracle_data: HistoricalOracleData {
                last_oracle_price_twap: PRICE_PRECISION_I64,
                last_oracle_price_twap_5min: PRICE_PRECISION_I64,
                ..HistoricalOracleData::default()
            },
            ..SpotMarket::default()
        };
        create_anchor_account_info!(spot_market, SpotMarket, spot_market_account_info);
        let spot_market_map = SpotMarketMap::load_one(&spot_market_account_info, true).unwrap();

        let user_key = Pubkey::new_unique();
        let liquidator_key = Pubkey::new_unique();

        let mut user = User {
            perp_positions: get_positions(PerpPosition {
                market_index: 0,
                base_asset_amount: -BASE_PRECISION_I64,
                quote_asset_amount: 100 * QUOTE_PRECISION_I64,
                quote_entry_amount: 100 * QUOTE_PRECISION_I64,
                quote_break_even_amount: 100 * QUOTE_PRECISION_I64,
                open_orders: 0,
                open_bids: 0,
                ..PerpPosition::default()
            }),
            spot_positions: get_spot_positions(SpotPosition {
                market_index: 0,
                balance_type: SpotBalanceType::Deposit,
                scaled_balance: 4 * SPOT_BALANCE_PRECISION_U64,
                ..SpotPosition::default()
            }),

            ..User::default()
        };

        create_anchor_account_info!(user, &user_key, User, user_account_info);
        let user_account_loader: AccountLoader<User> =
            AccountLoader::try_from(&user_account_info).unwrap();

        let liquidator_authority = Pubkey::new_unique();
        let mut liquidator = User {
            authority: liquidator_authority,
            spot_positions: get_spot_positions(SpotPosition {
                market_index: 0,
                balance_type: SpotBalanceType::Deposit,
                scaled_balance: 50 * SPOT_BALANCE_PRECISION_U64,
                ..SpotPosition::default()
            }),
            ..User::default()
        };

        create_anchor_account_info!(liquidator, &liquidator_key, User, liquidator_account_info);
        let liquidator_account_loader: AccountLoader<User> =
            AccountLoader::try_from(&liquidator_account_info).unwrap();

        let mut user_stats = UserStats::default();

        create_anchor_account_info!(user_stats, UserStats, user_stats_account_info);
        let user_stats_account_loader: AccountLoader<UserStats> =
            AccountLoader::try_from(&user_stats_account_info).unwrap();

        let mut liquidator_stats = UserStats::default();

        create_anchor_account_info!(liquidator_stats, UserStats, liquidator_stats_account_info);
        let liquidator_stats_account_loader: AccountLoader<UserStats> =
            AccountLoader::try_from(&liquidator_stats_account_info).unwrap();

        let state = State {
            liquidation_margin_buffer_ratio: 10,
            initial_pct_to_liquidate: LIQUIDATION_PCT_PRECISION as u16,
            liquidation_duration: 150,
            ..Default::default()
        };

        let clock = Clock {
            slot,
            unix_timestamp: now,
            ..Clock::default()
        };

        liquidate_perp_with_fill(
            0,
            &user_account_loader,
            &user_key,
            &user_stats_account_loader,
            &liquidator_account_loader,
            &liquidator_key,
            &liquidator_stats_account_loader,
            &UserMap::empty(),
            &UserStatsMap::empty(),
            &perp_market_map,
            &spot_market_map,
            &mut oracle_map,
            &clock,
            &state,
        )
        .unwrap();

        let user = user_account_loader.load().unwrap();
        assert_eq!(user.perp_positions[0].base_asset_amount, -640000000);
        assert_eq!(user.perp_positions[0].quote_asset_amount, 63472500);
        assert_eq!(user.perp_positions[0].open_orders, 0);
        assert_eq!(user.perp_positions[0].open_bids, 0);

        let liquidator = liquidator_account_loader.load().unwrap();
        assert_eq!(liquidator.perp_positions[0].base_asset_amount, 0);
        assert_eq!(liquidator.perp_positions[0].quote_asset_amount, 3613);

        let market_after = perp_market_map.get_ref(&0).unwrap();
        assert_eq!(market_after.amm.total_liquidation_fee, 361300);
    }
}

pub mod liquidate_spot {
    use crate::state::state::State;
    use std::ops::Deref;
    use std::str::FromStr;

    use anchor_lang::Owner;
    use solana_program::pubkey::Pubkey;

    use crate::controller::liquidation::liquidate_spot;
    use crate::create_anchor_account_info;
    use crate::error::ErrorCode;
    use crate::math::constants::{
        LIQUIDATION_FEE_PRECISION, LIQUIDATION_PCT_PRECISION, MARGIN_PRECISION,
        MARGIN_PRECISION_U128, PRICE_PRECISION, PRICE_PRECISION_U64, SPOT_BALANCE_PRECISION,
        SPOT_BALANCE_PRECISION_U64, SPOT_CUMULATIVE_INTEREST_PRECISION, SPOT_WEIGHT_PRECISION,
    };
    use crate::math::margin::calculate_margin_requirement_and_total_collateral_and_liability_info;
    use crate::math::spot_balance::{get_strict_token_value, get_token_amount, get_token_value};
    use crate::state::margin_calculation::{MarginCalculation, MarginContext};
    use crate::state::oracle::OracleSource;
    use crate::state::oracle::{HistoricalOracleData, StrictOraclePrice};
    use crate::state::oracle_map::OracleMap;
    use crate::state::perp_market_map::PerpMarketMap;
    use crate::state::spot_market::{SpotBalanceType, SpotMarket};
    use crate::state::spot_market_map::SpotMarketMap;
    use crate::state::user::UserStats;
    use crate::state::user::{Order, PerpPosition, SpotPosition, User};
    use crate::test_utils::*;
    use crate::test_utils::{get_pyth_price, get_spot_positions};
    use crate::{create_account_info, QUOTE_PRECISION_I64};

    #[test]
    pub fn successful_liquidation_liability_transfer_implied_by_asset_amount() {
        let now = 0_i64;
        let slot = 0_u64;

        let mut sol_oracle_price = get_pyth_price(100, 6);
        let sol_oracle_price_key =
            Pubkey::from_str("J83w4HKfqxwcq3BEMMkPFSppX3gqekLyLJBexebFVkix").unwrap();
        let pyth_program = crate::ids::pyth_program::id();
        create_account_info!(
            sol_oracle_price,
            &sol_oracle_price_key,
            &pyth_program,
            oracle_account_info
        );
        let mut oracle_map = OracleMap::load_one(&oracle_account_info, slot, None).unwrap();

        let perp_market_map = PerpMarketMap::empty();

        let mut usdc_market = SpotMarket {
            market_index: 0,
            oracle_source: OracleSource::QuoteAsset,
            cumulative_deposit_interest: SPOT_CUMULATIVE_INTEREST_PRECISION,
            decimals: 6,
            initial_asset_weight: SPOT_WEIGHT_PRECISION,
            maintenance_asset_weight: SPOT_WEIGHT_PRECISION,
            deposit_balance: 200 * SPOT_BALANCE_PRECISION,
            liquidator_fee: 0,
            historical_oracle_data: HistoricalOracleData {
                last_oracle_price_twap: QUOTE_PRECISION_I64,
                last_oracle_price_twap_5min: QUOTE_PRECISION_I64,
                ..HistoricalOracleData::default()
            },
            ..SpotMarket::default()
        };
        create_anchor_account_info!(usdc_market, SpotMarket, usdc_spot_market_account_info);
        let mut sol_market = SpotMarket {
            market_index: 1,
            oracle_source: OracleSource::Pyth,
            oracle: sol_oracle_price_key,
            cumulative_deposit_interest: SPOT_CUMULATIVE_INTEREST_PRECISION,
            cumulative_borrow_interest: SPOT_CUMULATIVE_INTEREST_PRECISION,
            decimals: 6,
            initial_asset_weight: 8 * SPOT_WEIGHT_PRECISION / 10,
            maintenance_asset_weight: 9 * SPOT_WEIGHT_PRECISION / 10,
            initial_liability_weight: 12 * SPOT_WEIGHT_PRECISION / 10,
            maintenance_liability_weight: 11 * SPOT_WEIGHT_PRECISION / 10,
            deposit_balance: SPOT_BALANCE_PRECISION,
            borrow_balance: SPOT_BALANCE_PRECISION,
            liquidator_fee: LIQUIDATION_FEE_PRECISION / 1000,
            historical_oracle_data: HistoricalOracleData {
                last_oracle_price_twap: (sol_oracle_price.agg.price * 99 / 100),
                last_oracle_price_twap_5min: (sol_oracle_price.agg.price * 99 / 100),
                ..HistoricalOracleData::default()
            },
            ..SpotMarket::default()
        };
        create_anchor_account_info!(sol_market, SpotMarket, sol_spot_market_account_info);
        let spot_market_account_infos = Vec::from([
            &usdc_spot_market_account_info,
            &sol_spot_market_account_info,
        ]);
        let spot_market_map =
            SpotMarketMap::load_multiple(spot_market_account_infos, true).unwrap();

        let mut spot_positions = [SpotPosition::default(); 8];
        spot_positions[0] = SpotPosition {
            market_index: 0,
            balance_type: SpotBalanceType::Deposit,
            scaled_balance: 100 * SPOT_BALANCE_PRECISION_U64,
            ..SpotPosition::default()
        };
        spot_positions[1] = SpotPosition {
            market_index: 1,
            balance_type: SpotBalanceType::Borrow,
            scaled_balance: SPOT_BALANCE_PRECISION_U64,
            ..SpotPosition::default()
        };
        let mut user = User {
            orders: [Order::default(); 32],
            perp_positions: [PerpPosition::default(); 8],
            spot_positions,
            ..User::default()
        };

        let mut liquidator = User {
            spot_positions: get_spot_positions(SpotPosition {
                market_index: 0,
                balance_type: SpotBalanceType::Deposit,
                scaled_balance: 100 * SPOT_BALANCE_PRECISION_U64,
                ..SpotPosition::default()
            }),
            ..User::default()
        };

        let user_key = Pubkey::default();
        let liquidator_key = Pubkey::default();

        let mut user_stats = UserStats::default();
        let mut liquidator_stats = UserStats::default();

        let state = State {
            liquidation_margin_buffer_ratio: 10,
            initial_pct_to_liquidate: LIQUIDATION_PCT_PRECISION as u16,
            liquidation_duration: 150,
            ..Default::default()
        };

        liquidate_spot(
            0,
            1,
            10_u128.pow(6),
            None,
            &mut user,
            &user_key,
            &mut user_stats,
            &mut liquidator,
            &liquidator_key,
            &mut liquidator_stats,
            &perp_market_map,
            &spot_market_map,
            &mut oracle_map,
            now,
            slot,
            &state,
        )
        .unwrap();

        assert_eq!(user.spot_positions[0].scaled_balance, 0);
        assert_eq!(user.spot_positions[1].scaled_balance, 999999);

        assert_eq!(
            liquidator.spot_positions[0].balance_type,
            SpotBalanceType::Deposit
        );
        assert_eq!(liquidator.spot_positions[0].scaled_balance, 200000000000);
        assert_eq!(
            liquidator.spot_positions[1].balance_type,
            SpotBalanceType::Borrow
        );
        assert_eq!(liquidator.spot_positions[1].scaled_balance, 999000001);
    }

    #[test]
    pub fn successful_liquidation_liquidator_max_liability_transfer() {
        let now = 0_i64;
        let slot = 0_u64;

        let mut sol_oracle_price = get_pyth_price(100, 6);
        let sol_oracle_price_key =
            Pubkey::from_str("J83w4HKfqxwcq3BEMMkPFSppX3gqekLyLJBexebFVkix").unwrap();
        let pyth_program = crate::ids::pyth_program::id();
        create_account_info!(
            sol_oracle_price,
            &sol_oracle_price_key,
            &pyth_program,
            oracle_account_info
        );
        let mut oracle_map = OracleMap::load_one(&oracle_account_info, slot, None).unwrap();

        let perp_market_map = PerpMarketMap::empty();

        let mut usdc_market = SpotMarket {
            market_index: 0,
            oracle_source: OracleSource::QuoteAsset,
            cumulative_deposit_interest: SPOT_CUMULATIVE_INTEREST_PRECISION,
            decimals: 6,
            initial_asset_weight: SPOT_WEIGHT_PRECISION,
            maintenance_asset_weight: SPOT_WEIGHT_PRECISION,
            deposit_balance: 200 * SPOT_BALANCE_PRECISION,
            liquidator_fee: 0,
            historical_oracle_data: HistoricalOracleData {
                last_oracle_price_twap: QUOTE_PRECISION_I64,
                last_oracle_price_twap_5min: QUOTE_PRECISION_I64,
                ..HistoricalOracleData::default()
            },
            ..SpotMarket::default()
        };
        create_anchor_account_info!(usdc_market, SpotMarket, usdc_spot_market_account_info);
        let mut sol_market = SpotMarket {
            market_index: 1,
            oracle_source: OracleSource::Pyth,
            oracle: sol_oracle_price_key,
            cumulative_deposit_interest: SPOT_CUMULATIVE_INTEREST_PRECISION,
            cumulative_borrow_interest: SPOT_CUMULATIVE_INTEREST_PRECISION,
            decimals: 6,
            initial_asset_weight: 8 * SPOT_WEIGHT_PRECISION / 10,
            maintenance_asset_weight: 9 * SPOT_WEIGHT_PRECISION / 10,
            initial_liability_weight: 12 * SPOT_WEIGHT_PRECISION / 10,
            maintenance_liability_weight: 11 * SPOT_WEIGHT_PRECISION / 10,
            deposit_balance: SPOT_BALANCE_PRECISION,
            borrow_balance: SPOT_BALANCE_PRECISION,
            liquidator_fee: LIQUIDATION_FEE_PRECISION / 1000,
            historical_oracle_data: HistoricalOracleData {
                last_oracle_price_twap: (sol_oracle_price.agg.price * 1442 / 10000),
                last_oracle_price_twap_5min: (sol_oracle_price.agg.price * 999 / 1000),
                ..HistoricalOracleData::default()
            },
            ..SpotMarket::default()
        };
        create_anchor_account_info!(sol_market, SpotMarket, sol_spot_market_account_info);
        let spot_market_account_infos = Vec::from([
            &usdc_spot_market_account_info,
            &sol_spot_market_account_info,
        ]);
        let spot_market_map =
            SpotMarketMap::load_multiple(spot_market_account_infos, true).unwrap();

        let mut spot_market = [SpotPosition::default(); 8];
        spot_market[0] = SpotPosition {
            market_index: 0,
            balance_type: SpotBalanceType::Deposit,
            scaled_balance: 100 * SPOT_BALANCE_PRECISION_U64,
            ..SpotPosition::default()
        };
        spot_market[1] = SpotPosition {
            market_index: 1,
            balance_type: SpotBalanceType::Borrow,
            scaled_balance: SPOT_BALANCE_PRECISION_U64,
            ..SpotPosition::default()
        };
        let mut user = User {
            orders: [Order::default(); 32],
            perp_positions: [PerpPosition::default(); 8],
            spot_positions: spot_market,
            ..User::default()
        };

        let mut liquidator = User {
            spot_positions: get_spot_positions(SpotPosition {
                market_index: 0,
                balance_type: SpotBalanceType::Deposit,
                scaled_balance: 100 * SPOT_BALANCE_PRECISION_U64,
                ..SpotPosition::default()
            }),
            ..User::default()
        };

        let user_key = Pubkey::default();
        let liquidator_key = Pubkey::default();

        let mut user_stats = UserStats::default();
        let mut liquidator_stats = UserStats::default();

        let state = State {
            liquidation_margin_buffer_ratio: 10,
            initial_pct_to_liquidate: LIQUIDATION_PCT_PRECISION as u16,
            liquidation_duration: 150,
            ..Default::default()
        };
        // oracle twap too volatile to liq rn
        assert!(liquidate_spot(
            0,
            1,
            10_u128.pow(6) / 10,
            None,
            &mut user,
            &user_key,
            &mut user_stats,
            &mut liquidator,
            &liquidator_key,
            &mut liquidator_stats,
            &perp_market_map,
            &spot_market_map,
            &mut oracle_map,
            now,
            slot,
            &state,
        )
        .is_err());

        // move twap closer to oracle price (within 80% below)
        let mut market1 = spot_market_map
            .get_ref_mut(&sol_market.market_index)
            .unwrap();
        market1.historical_oracle_data.last_oracle_price_twap =
            sol_oracle_price.agg.price * 6744 / 10000;
        drop(market1);

        liquidate_spot(
            0,
            1,
            10_u128.pow(6) / 10,
            None,
            &mut user,
            &user_key,
            &mut user_stats,
            &mut liquidator,
            &liquidator_key,
            &mut liquidator_stats,
            &perp_market_map,
            &spot_market_map,
            &mut oracle_map,
            now,
            slot,
            &state,
        )
        .unwrap();

        assert_eq!(user.spot_positions[0].scaled_balance, 89989990000);
        assert_eq!(user.spot_positions[1].scaled_balance, 899999999);

        assert_eq!(
            liquidator.spot_positions[0].balance_type,
            SpotBalanceType::Deposit
        );
        assert_eq!(liquidator.spot_positions[0].scaled_balance, 110010010000);
        assert_eq!(
            liquidator.spot_positions[1].balance_type,
            SpotBalanceType::Borrow
        );
        assert_eq!(liquidator.spot_positions[1].scaled_balance, 100000001);
    }

    #[test]
    pub fn successful_liquidation_liability_transfer_to_cover_margin_shortage() {
        let now = 0_i64;
        let slot = 0_u64;

        let mut user_stats = UserStats::default();
        let mut liquidator_stats = UserStats::default();

        let mut sol_oracle_price = get_pyth_price(100, 6);
        let sol_oracle_price_key =
            Pubkey::from_str("J83w4HKfqxwcq3BEMMkPFSppX3gqekLyLJBexebFVkix").unwrap();
        let pyth_program = crate::ids::pyth_program::id();
        create_account_info!(
            sol_oracle_price,
            &sol_oracle_price_key,
            &pyth_program,
            oracle_account_info
        );
        let mut oracle_map = OracleMap::load_one(&oracle_account_info, slot, None).unwrap();

        let market_map = PerpMarketMap::empty();

        let mut usdc_market = SpotMarket {
            market_index: 0,
            oracle_source: OracleSource::QuoteAsset,
            cumulative_deposit_interest: SPOT_CUMULATIVE_INTEREST_PRECISION,
            decimals: 6,
            initial_asset_weight: SPOT_WEIGHT_PRECISION,
            maintenance_asset_weight: SPOT_WEIGHT_PRECISION,
            deposit_balance: 200 * SPOT_BALANCE_PRECISION,
            liquidator_fee: 0,
            historical_oracle_data: HistoricalOracleData {
                last_oracle_price_twap: QUOTE_PRECISION_I64,
                last_oracle_price_twap_5min: QUOTE_PRECISION_I64,
                ..HistoricalOracleData::default()
            },
            ..SpotMarket::default()
        };
        create_anchor_account_info!(usdc_market, SpotMarket, usdc_spot_market_account_info);
        let mut sol_market = SpotMarket {
            market_index: 1,
            oracle_source: OracleSource::Pyth,
            oracle: sol_oracle_price_key,
            cumulative_deposit_interest: SPOT_CUMULATIVE_INTEREST_PRECISION,
            cumulative_borrow_interest: SPOT_CUMULATIVE_INTEREST_PRECISION,
            decimals: 6,
            initial_asset_weight: 8 * SPOT_WEIGHT_PRECISION / 10,
            maintenance_asset_weight: 9 * SPOT_WEIGHT_PRECISION / 10,
            initial_liability_weight: 12 * SPOT_WEIGHT_PRECISION / 10,
            maintenance_liability_weight: 11 * SPOT_WEIGHT_PRECISION / 10,
            deposit_balance: SPOT_BALANCE_PRECISION,
            borrow_balance: SPOT_BALANCE_PRECISION,
            liquidator_fee: LIQUIDATION_FEE_PRECISION / 1000,
            if_liquidation_fee: LIQUIDATION_FEE_PRECISION / 1000,
            historical_oracle_data: HistoricalOracleData {
                last_oracle_price_twap: (sol_oracle_price.agg.price * 99 / 100),
                last_oracle_price_twap_5min: (sol_oracle_price.agg.price * 99 / 100),
                ..HistoricalOracleData::default()
            },
            ..SpotMarket::default()
        };
        create_anchor_account_info!(sol_market, SpotMarket, sol_spot_market_account_info);
        let spot_market_account_infos = Vec::from([
            &usdc_spot_market_account_info,
            &sol_spot_market_account_info,
        ]);
        let spot_market_map =
            SpotMarketMap::load_multiple(spot_market_account_infos, true).unwrap();

        let mut spot_positions = [SpotPosition::default(); 8];
        spot_positions[0] = SpotPosition {
            market_index: 0,
            balance_type: SpotBalanceType::Deposit,
            scaled_balance: 105 * SPOT_BALANCE_PRECISION_U64,
            ..SpotPosition::default()
        };
        spot_positions[1] = SpotPosition {
            market_index: 1,
            balance_type: SpotBalanceType::Borrow,
            scaled_balance: SPOT_BALANCE_PRECISION_U64,
            ..SpotPosition::default()
        };
        let mut user = User {
            orders: [Order::default(); 32],
            perp_positions: [PerpPosition::default(); 8],
            spot_positions,
            ..User::default()
        };

        let mut liquidator = User {
            spot_positions: get_spot_positions(SpotPosition {
                market_index: 0,
                balance_type: SpotBalanceType::Deposit,
                scaled_balance: 100 * SPOT_BALANCE_PRECISION_U64,
                ..SpotPosition::default()
            }),
            ..User::default()
        };

        let user_key = Pubkey::default();
        let liquidator_key = Pubkey::default();

        let state = State {
            liquidation_margin_buffer_ratio: MARGIN_PRECISION / 50,
            initial_pct_to_liquidate: LIQUIDATION_PCT_PRECISION as u16,
            liquidation_duration: 150,
            ..Default::default()
        };
        liquidate_spot(
            0,
            1,
            10_u128.pow(6),
            None,
            &mut user,
            &user_key,
            &mut user_stats,
            &mut liquidator,
            &liquidator_key,
            &mut liquidator_stats,
            &market_map,
            &spot_market_map,
            &mut oracle_map,
            now,
            slot,
            &state,
        )
        .unwrap();

        assert_eq!(user.spot_positions[0].scaled_balance, 45558159000);
        assert_eq!(user.spot_positions[1].scaled_balance, 406768999);

        let liquidation_buffer = state.liquidation_margin_buffer_ratio;
        let MarginCalculation {
            margin_requirement,
            total_collateral,
            margin_requirement_plus_buffer,
            ..
        } = calculate_margin_requirement_and_total_collateral_and_liability_info(
            &user,
            &market_map,
            &spot_market_map,
            &mut oracle_map,
            MarginContext::liquidation(liquidation_buffer),
        )
        .unwrap();

        assert_eq!(margin_requirement, 44744590);
        assert_eq!(total_collateral, 45558159);
        assert_eq!(margin_requirement_plus_buffer, 45558128);

        let token_amount = get_token_amount(
            user.spot_positions[1].scaled_balance as u128,
            spot_market_map.get_ref(&1).unwrap().deref(),
            &user.spot_positions[1].balance_type,
        )
        .unwrap();
        let oracle_price_data = oracle_map
            .get_price_data(&(sol_oracle_price_key, OracleSource::Pyth))
            .unwrap();
        let token_value =
            get_token_value(token_amount as i128, 6, oracle_price_data.price).unwrap();

        let strict_price_1 = StrictOraclePrice {
            current: oracle_price_data.price,
            twap_5min: Some(oracle_price_data.price / 10),
        };
        let strict_token_value_1 =
            get_strict_token_value(token_amount as i128, 6, &strict_price_1).unwrap();

        let strict_price_2 = StrictOraclePrice {
            current: oracle_price_data.price,
            twap_5min: Some(oracle_price_data.price * 2),
        };
        let strict_token_value_2 =
            get_strict_token_value(token_amount as i128, 6, &strict_price_2).unwrap();

        let strict_price_3 = StrictOraclePrice {
            current: oracle_price_data.price,
            twap_5min: Some(oracle_price_data.price * 2),
        };
        let strict_token_value_3 =
            get_strict_token_value(-(token_amount as i128), 6, &strict_price_3).unwrap();

        assert_eq!(token_amount, 406769);
        assert_eq!(token_value, 40676900);
        assert_eq!(strict_token_value_1, 4067690); // if oracle price is more favorable than twap
        assert_eq!(strict_token_value_2, token_value); // oracle price is less favorable than twap
        assert_eq!(strict_token_value_3, -(token_value * 2)); // if liability and strict would value as twap

        let margin_ratio =
            total_collateral.unsigned_abs() * MARGIN_PRECISION_U128 / token_value.unsigned_abs();

        assert_eq!(margin_ratio, 11200); // 112%

        assert_eq!(
            liquidator.spot_positions[0].balance_type,
            SpotBalanceType::Deposit
        );
        assert_eq!(liquidator.spot_positions[0].scaled_balance, 159441841000);
        assert_eq!(
            liquidator.spot_positions[1].balance_type,
            SpotBalanceType::Borrow
        );
        assert_eq!(liquidator.spot_positions[1].scaled_balance, 593824001);

        let market_after = spot_market_map.get_ref(&1).unwrap();
        let market_revenue = get_token_amount(
            market_after.revenue_pool.scaled_balance,
            &market_after,
            &SpotBalanceType::Deposit,
        )
        .unwrap();

        assert_eq!(market_revenue, 593);
        assert_eq!(
            liquidator.spot_positions[1].scaled_balance + user.spot_positions[1].scaled_balance
                - market_after.revenue_pool.scaled_balance as u64,
            SPOT_BALANCE_PRECISION_U64
        );
    }

    #[test]
    pub fn failure_due_to_limit_price() {
        let now = 0_i64;
        let slot = 0_u64;
        let mut user_stats = UserStats::default();
        let mut liquidator_stats = UserStats::default();
        let mut sol_oracle_price = get_pyth_price(100, 6);
        let sol_oracle_price_key =
            Pubkey::from_str("J83w4HKfqxwcq3BEMMkPFSppX3gqekLyLJBexebFVkix").unwrap();
        let pyth_program = crate::ids::pyth_program::id();
        create_account_info!(
            sol_oracle_price,
            &sol_oracle_price_key,
            &pyth_program,
            oracle_account_info
        );
        let mut oracle_map = OracleMap::load_one(&oracle_account_info, slot, None).unwrap();

        let perp_market_map = PerpMarketMap::empty();

        let mut usdc_market = SpotMarket {
            market_index: 0,
            oracle_source: OracleSource::QuoteAsset,
            cumulative_deposit_interest: SPOT_CUMULATIVE_INTEREST_PRECISION,
            decimals: 6,
            initial_asset_weight: SPOT_WEIGHT_PRECISION,
            maintenance_asset_weight: SPOT_WEIGHT_PRECISION,
            deposit_balance: 200 * SPOT_BALANCE_PRECISION,
            liquidator_fee: 0,
            historical_oracle_data: HistoricalOracleData {
                last_oracle_price_twap: QUOTE_PRECISION_I64,
                last_oracle_price_twap_5min: QUOTE_PRECISION_I64,
                ..HistoricalOracleData::default()
            },
            ..SpotMarket::default()
        };
        create_anchor_account_info!(usdc_market, SpotMarket, usdc_spot_market_account_info);
        let mut sol_market = SpotMarket {
            market_index: 1,
            oracle_source: OracleSource::Pyth,
            oracle: sol_oracle_price_key,
            cumulative_deposit_interest: SPOT_CUMULATIVE_INTEREST_PRECISION,
            cumulative_borrow_interest: SPOT_CUMULATIVE_INTEREST_PRECISION,
            decimals: 6,
            initial_asset_weight: 8 * SPOT_WEIGHT_PRECISION / 10,
            maintenance_asset_weight: 9 * SPOT_WEIGHT_PRECISION / 10,
            initial_liability_weight: 12 * SPOT_WEIGHT_PRECISION / 10,
            maintenance_liability_weight: 11 * SPOT_WEIGHT_PRECISION / 10,
            deposit_balance: SPOT_BALANCE_PRECISION,
            borrow_balance: SPOT_BALANCE_PRECISION,
            liquidator_fee: LIQUIDATION_FEE_PRECISION / 1000,
            historical_oracle_data: HistoricalOracleData {
                last_oracle_price_twap: (sol_oracle_price.agg.price * 99 / 100),
                last_oracle_price_twap_5min: (sol_oracle_price.agg.price * 99 / 100),
                ..HistoricalOracleData::default()
            },
            ..SpotMarket::default()
        };
        create_anchor_account_info!(sol_market, SpotMarket, sol_spot_market_account_info);
        let spot_market_account_infos = Vec::from([
            &usdc_spot_market_account_info,
            &sol_spot_market_account_info,
        ]);
        let spot_market_map =
            SpotMarketMap::load_multiple(spot_market_account_infos, true).unwrap();

        let mut spot_positions = [SpotPosition::default(); 8];
        spot_positions[0] = SpotPosition {
            market_index: 0,
            balance_type: SpotBalanceType::Deposit,
            scaled_balance: 100 * SPOT_BALANCE_PRECISION_U64,
            ..SpotPosition::default()
        };
        spot_positions[1] = SpotPosition {
            market_index: 1,
            balance_type: SpotBalanceType::Borrow,
            scaled_balance: SPOT_BALANCE_PRECISION_U64,
            ..SpotPosition::default()
        };
        let mut user = User {
            orders: [Order::default(); 32],
            perp_positions: [PerpPosition::default(); 8],
            spot_positions,
            ..User::default()
        };

        let mut liquidator = User {
            spot_positions: get_spot_positions(SpotPosition {
                market_index: 0,
                balance_type: SpotBalanceType::Deposit,
                scaled_balance: 100 * SPOT_BALANCE_PRECISION_U64,
                ..SpotPosition::default()
            }),
            ..User::default()
        };

        let user_key = Pubkey::default();
        let liquidator_key = Pubkey::default();
        let state = State {
            liquidation_margin_buffer_ratio: MARGIN_PRECISION / 50,
            initial_pct_to_liquidate: LIQUIDATION_PCT_PRECISION as u16,
            liquidation_duration: 150,
            ..Default::default()
        };
        let limit_price = (100000000 * PRICE_PRECISION_U64 / 999000) + 1;
        let result = liquidate_spot(
            0,
            1,
            10_u128.pow(6),
            Some(limit_price),
            &mut user,
            &user_key,
            &mut user_stats,
            &mut liquidator,
            &liquidator_key,
            &mut liquidator_stats,
            &perp_market_map,
            &spot_market_map,
            &mut oracle_map,
            now,
            slot,
            &state,
        );

        assert_eq!(result, Err(ErrorCode::LiquidationDoesntSatisfyLimitPrice));
    }

    #[test]
    pub fn success_with_to_limit_price() {
        let now = 0_i64;
        let slot = 0_u64;
        let mut user_stats = UserStats::default();
        let mut liquidator_stats = UserStats::default();
        let mut sol_oracle_price = get_pyth_price(100, 6);
        let sol_oracle_price_key =
            Pubkey::from_str("J83w4HKfqxwcq3BEMMkPFSppX3gqekLyLJBexebFVkix").unwrap();
        let pyth_program = crate::ids::pyth_program::id();
        create_account_info!(
            sol_oracle_price,
            &sol_oracle_price_key,
            &pyth_program,
            oracle_account_info
        );
        let mut oracle_map = OracleMap::load_one(&oracle_account_info, slot, None).unwrap();

        let perp_market_map = PerpMarketMap::empty();

        let mut usdc_market = SpotMarket {
            market_index: 0,
            oracle_source: OracleSource::QuoteAsset,
            cumulative_deposit_interest: SPOT_CUMULATIVE_INTEREST_PRECISION,
            decimals: 6,
            initial_asset_weight: SPOT_WEIGHT_PRECISION,
            maintenance_asset_weight: SPOT_WEIGHT_PRECISION,
            deposit_balance: 200 * SPOT_BALANCE_PRECISION,
            liquidator_fee: 0,
            historical_oracle_data: HistoricalOracleData {
                last_oracle_price_twap: QUOTE_PRECISION_I64,
                last_oracle_price_twap_5min: QUOTE_PRECISION_I64,
                ..HistoricalOracleData::default()
            },
            ..SpotMarket::default()
        };
        create_anchor_account_info!(usdc_market, SpotMarket, usdc_spot_market_account_info);
        let mut sol_market = SpotMarket {
            market_index: 1,
            oracle_source: OracleSource::Pyth,
            oracle: sol_oracle_price_key,
            cumulative_deposit_interest: SPOT_CUMULATIVE_INTEREST_PRECISION,
            cumulative_borrow_interest: SPOT_CUMULATIVE_INTEREST_PRECISION,
            decimals: 6,
            initial_asset_weight: 8 * SPOT_WEIGHT_PRECISION / 10,
            maintenance_asset_weight: 9 * SPOT_WEIGHT_PRECISION / 10,
            initial_liability_weight: 12 * SPOT_WEIGHT_PRECISION / 10,
            maintenance_liability_weight: 11 * SPOT_WEIGHT_PRECISION / 10,
            deposit_balance: SPOT_BALANCE_PRECISION,
            borrow_balance: SPOT_BALANCE_PRECISION,
            liquidator_fee: LIQUIDATION_FEE_PRECISION / 1000,
            historical_oracle_data: HistoricalOracleData {
                last_oracle_price_twap: (sol_oracle_price.agg.price * 99 / 100),
                last_oracle_price_twap_5min: (sol_oracle_price.agg.price * 99 / 100),
                ..HistoricalOracleData::default()
            },
            ..SpotMarket::default()
        };
        create_anchor_account_info!(sol_market, SpotMarket, sol_spot_market_account_info);
        let spot_market_account_infos = Vec::from([
            &usdc_spot_market_account_info,
            &sol_spot_market_account_info,
        ]);
        let spot_market_map =
            SpotMarketMap::load_multiple(spot_market_account_infos, true).unwrap();

        let mut spot_positions = [SpotPosition::default(); 8];
        spot_positions[0] = SpotPosition {
            market_index: 0,
            balance_type: SpotBalanceType::Deposit,
            scaled_balance: 100 * SPOT_BALANCE_PRECISION_U64,
            ..SpotPosition::default()
        };
        spot_positions[1] = SpotPosition {
            market_index: 1,
            balance_type: SpotBalanceType::Borrow,
            scaled_balance: SPOT_BALANCE_PRECISION_U64,
            ..SpotPosition::default()
        };
        let mut user = User {
            orders: [Order::default(); 32],
            perp_positions: [PerpPosition::default(); 8],
            spot_positions,
            ..User::default()
        };

        let mut liquidator = User {
            spot_positions: get_spot_positions(SpotPosition {
                market_index: 0,
                balance_type: SpotBalanceType::Deposit,
                scaled_balance: 100 * SPOT_BALANCE_PRECISION_U64,
                ..SpotPosition::default()
            }),
            ..User::default()
        };

        let user_key = Pubkey::default();
        let liquidator_key = Pubkey::default();
        let state = State {
            liquidation_margin_buffer_ratio: MARGIN_PRECISION / 50,
            initial_pct_to_liquidate: LIQUIDATION_PCT_PRECISION as u16,
            liquidation_duration: 150,
            ..Default::default()
        };
        let limit_price = (100000000 * PRICE_PRECISION_U64 / 999000) - 1;
        let result = liquidate_spot(
            0,
            1,
            10_u128.pow(6),
            Some(limit_price),
            &mut user,
            &user_key,
            &mut user_stats,
            &mut liquidator,
            &liquidator_key,
            &mut liquidator_stats,
            &perp_market_map,
            &spot_market_map,
            &mut oracle_map,
            now,
            slot,
            &state,
        );

        assert_eq!(result, Ok(()));
    }

    #[test]
    pub fn successful_liquidation_dust_borrow() {
        let now = 0_i64;
        let slot = 0_u64;
        let mut user_stats = UserStats::default();
        let mut liquidator_stats = UserStats::default();
        let mut sol_oracle_price = get_pyth_price(100, 6);
        let sol_oracle_price_key =
            Pubkey::from_str("J83w4HKfqxwcq3BEMMkPFSppX3gqekLyLJBexebFVkix").unwrap();
        let pyth_program = crate::ids::pyth_program::id();
        create_account_info!(
            sol_oracle_price,
            &sol_oracle_price_key,
            &pyth_program,
            oracle_account_info
        );
        let mut oracle_map = OracleMap::load_one(&oracle_account_info, slot, None).unwrap();

        let market_map = PerpMarketMap::empty();

        let mut usdc_market = SpotMarket {
            market_index: 0,
            oracle_source: OracleSource::QuoteAsset,
            cumulative_deposit_interest: SPOT_CUMULATIVE_INTEREST_PRECISION,
            decimals: 6,
            initial_asset_weight: SPOT_WEIGHT_PRECISION,
            maintenance_asset_weight: SPOT_WEIGHT_PRECISION,
            deposit_balance: 200 * SPOT_BALANCE_PRECISION,
            liquidator_fee: 0,
            historical_oracle_data: HistoricalOracleData {
                last_oracle_price_twap: QUOTE_PRECISION_I64,
                last_oracle_price_twap_5min: QUOTE_PRECISION_I64,
                ..HistoricalOracleData::default()
            },
            ..SpotMarket::default()
        };
        create_anchor_account_info!(usdc_market, SpotMarket, usdc_spot_market_account_info);
        let mut sol_market = SpotMarket {
            market_index: 1,
            oracle_source: OracleSource::Pyth,
            oracle: sol_oracle_price_key,
            cumulative_deposit_interest: SPOT_CUMULATIVE_INTEREST_PRECISION,
            cumulative_borrow_interest: SPOT_CUMULATIVE_INTEREST_PRECISION,
            decimals: 6,
            initial_asset_weight: 8 * SPOT_WEIGHT_PRECISION / 10,
            maintenance_asset_weight: 9 * SPOT_WEIGHT_PRECISION / 10,
            initial_liability_weight: 12 * SPOT_WEIGHT_PRECISION / 10,
            maintenance_liability_weight: 11 * SPOT_WEIGHT_PRECISION / 10,
            deposit_balance: SPOT_BALANCE_PRECISION,
            borrow_balance: SPOT_BALANCE_PRECISION,
            liquidator_fee: LIQUIDATION_FEE_PRECISION / 1000,
            if_liquidation_fee: LIQUIDATION_FEE_PRECISION / 1000,
            historical_oracle_data: HistoricalOracleData {
                last_oracle_price_twap: (sol_oracle_price.agg.price * 99 / 100),
                last_oracle_price_twap_5min: (sol_oracle_price.agg.price * 99 / 100),
                ..HistoricalOracleData::default()
            },
            ..SpotMarket::default()
        };
        create_anchor_account_info!(sol_market, SpotMarket, sol_spot_market_account_info);
        let spot_market_account_infos = Vec::from([
            &usdc_spot_market_account_info,
            &sol_spot_market_account_info,
        ]);
        let spot_market_map =
            SpotMarketMap::load_multiple(spot_market_account_infos, true).unwrap();

        let mut spot_positions = [SpotPosition::default(); 8];
        spot_positions[0] = SpotPosition {
            market_index: 0,
            balance_type: SpotBalanceType::Deposit,
            scaled_balance: 107 * SPOT_BALANCE_PRECISION_U64 / 50,
            ..SpotPosition::default()
        };
        spot_positions[1] = SpotPosition {
            market_index: 1,
            balance_type: SpotBalanceType::Borrow,
            scaled_balance: SPOT_BALANCE_PRECISION_U64 / 50,
            ..SpotPosition::default()
        };
        let mut user = User {
            orders: [Order::default(); 32],
            perp_positions: [PerpPosition::default(); 8],
            spot_positions,
            ..User::default()
        };

        let mut liquidator = User {
            spot_positions: get_spot_positions(SpotPosition {
                market_index: 0,
                balance_type: SpotBalanceType::Deposit,
                scaled_balance: 100 * SPOT_BALANCE_PRECISION_U64,
                ..SpotPosition::default()
            }),
            ..User::default()
        };

        let user_key = Pubkey::default();
        let liquidator_key = Pubkey::default();

        let state = State {
            liquidation_margin_buffer_ratio: MARGIN_PRECISION / 50,
            initial_pct_to_liquidate: LIQUIDATION_PCT_PRECISION as u16,
            liquidation_duration: 150,
            ..Default::default()
        };
        liquidate_spot(
            0,
            1,
            10_u128.pow(6),
            None,
            &mut user,
            &user_key,
            &mut user_stats,
            &mut liquidator,
            &liquidator_key,
            &mut liquidator_stats,
            &market_map,
            &spot_market_map,
            &mut oracle_map,
            now,
            slot,
            &state,
        )
        .unwrap();

        assert_eq!(user.spot_positions[0].scaled_balance, 0);
        assert_eq!(user.spot_positions[1].scaled_balance, 19999);

        assert_eq!(liquidator.spot_positions[0].scaled_balance, 102140000000);
        assert_eq!(liquidator.spot_positions[1].scaled_balance, 20000001); // ~$1 worth of liability
    }

    #[test]
    pub fn liquidate_over_multiple_slots() {
        let now = 1_i64;
        let slot = 1_u64;

        let mut sol_oracle_price = get_pyth_price(100, 6);
        let sol_oracle_price_key =
            Pubkey::from_str("J83w4HKfqxwcq3BEMMkPFSppX3gqekLyLJBexebFVkix").unwrap();
        let pyth_program = crate::ids::pyth_program::id();
        create_account_info!(
            sol_oracle_price,
            &sol_oracle_price_key,
            &pyth_program,
            oracle_account_info
        );
        let mut oracle_map = OracleMap::load_one(&oracle_account_info, slot, None).unwrap();

        let market_map = PerpMarketMap::empty();

        let mut usdc_market = SpotMarket {
            market_index: 0,
            oracle_source: OracleSource::QuoteAsset,
            cumulative_deposit_interest: SPOT_CUMULATIVE_INTEREST_PRECISION,
            decimals: 6,
            initial_asset_weight: SPOT_WEIGHT_PRECISION,
            maintenance_asset_weight: SPOT_WEIGHT_PRECISION,
            deposit_balance: 200 * SPOT_BALANCE_PRECISION,
            liquidator_fee: 0,
            historical_oracle_data: HistoricalOracleData {
                last_oracle_price_twap: QUOTE_PRECISION_I64,
                last_oracle_price_twap_5min: QUOTE_PRECISION_I64,
                ..HistoricalOracleData::default()
            },
            ..SpotMarket::default()
        };
        create_anchor_account_info!(usdc_market, SpotMarket, usdc_spot_market_account_info);
        let mut sol_market = SpotMarket {
            market_index: 1,
            oracle_source: OracleSource::Pyth,
            oracle: sol_oracle_price_key,
            cumulative_deposit_interest: SPOT_CUMULATIVE_INTEREST_PRECISION,
            cumulative_borrow_interest: SPOT_CUMULATIVE_INTEREST_PRECISION,
            decimals: 6,
            initial_asset_weight: 8 * SPOT_WEIGHT_PRECISION / 10,
            maintenance_asset_weight: 9 * SPOT_WEIGHT_PRECISION / 10,
            initial_liability_weight: 12 * SPOT_WEIGHT_PRECISION / 10,
            maintenance_liability_weight: 11 * SPOT_WEIGHT_PRECISION / 10,
            deposit_balance: 10 * SPOT_BALANCE_PRECISION,
            borrow_balance: 10 * SPOT_BALANCE_PRECISION,
            liquidator_fee: LIQUIDATION_FEE_PRECISION / 1000,
            if_liquidation_fee: LIQUIDATION_FEE_PRECISION / 1000,
            historical_oracle_data: HistoricalOracleData {
                last_oracle_price_twap: (sol_oracle_price.agg.price * 99 / 100),
                last_oracle_price_twap_5min: (sol_oracle_price.agg.price * 99 / 100),
                ..HistoricalOracleData::default()
            },
            ..SpotMarket::default()
        };
        create_anchor_account_info!(sol_market, SpotMarket, sol_spot_market_account_info);
        let spot_market_account_infos = Vec::from([
            &usdc_spot_market_account_info,
            &sol_spot_market_account_info,
        ]);
        let spot_market_map =
            SpotMarketMap::load_multiple(spot_market_account_infos, true).unwrap();

        let mut spot_positions = [SpotPosition::default(); 8];
        spot_positions[0] = SpotPosition {
            market_index: 0,
            balance_type: SpotBalanceType::Deposit,
            scaled_balance: 1050 * SPOT_BALANCE_PRECISION_U64,
            ..SpotPosition::default()
        };
        spot_positions[1] = SpotPosition {
            market_index: 1,
            balance_type: SpotBalanceType::Borrow,
            scaled_balance: 10 * SPOT_BALANCE_PRECISION_U64,
            ..SpotPosition::default()
        };
        let mut user = User {
            orders: [Order::default(); 32],
            perp_positions: [PerpPosition::default(); 8],
            spot_positions,
            ..User::default()
        };

        let mut liquidator = User {
            spot_positions: get_spot_positions(SpotPosition {
                market_index: 0,
                balance_type: SpotBalanceType::Deposit,
                scaled_balance: 1000 * SPOT_BALANCE_PRECISION_U64,
                ..SpotPosition::default()
            }),
            ..User::default()
        };

        let user_key = Pubkey::default();
        let liquidator_key = Pubkey::default();
        let mut user_stats = UserStats::default();
        let mut liquidator_stats = UserStats::default();
        let state = State {
            liquidation_margin_buffer_ratio: MARGIN_PRECISION / 50,
            initial_pct_to_liquidate: (LIQUIDATION_PCT_PRECISION / 10) as u16,
            liquidation_duration: 150,
            ..Default::default()
        };

        let liquidation_buffer = state.liquidation_margin_buffer_ratio;

        liquidate_spot(
            0,
            1,
            10 * 10_u128.pow(6),
            None,
            &mut user,
            &user_key,
            &mut user_stats,
            &mut liquidator,
            &liquidator_key,
            &mut liquidator_stats,
            &market_map,
            &spot_market_map,
            &mut oracle_map,
            now,
            slot,
            &state,
        )
        .unwrap();

        assert_eq!(user.last_active_slot, 1);
        assert_eq!(user.is_being_liquidated(), true);
        assert_eq!(user.liquidation_margin_freed, 7000031);
        assert_eq!(user.spot_positions[0].scaled_balance, 990558159000);
        assert_eq!(user.spot_positions[1].scaled_balance, 9406768999);

        let MarginCalculation {
            total_collateral,
            margin_requirement_plus_buffer,
            ..
        } = calculate_margin_requirement_and_total_collateral_and_liability_info(
            &user,
            &market_map,
            &spot_market_map,
            &mut oracle_map,
            MarginContext::liquidation(liquidation_buffer),
        )
        .unwrap();

        let margin_shortage =
            ((margin_requirement_plus_buffer as i128) - total_collateral).unsigned_abs();

        let pct_margin_freed = (user.liquidation_margin_freed as u128) * PRICE_PRECISION
            / (margin_shortage + user.liquidation_margin_freed as u128);
        assert_eq!(pct_margin_freed, 100000); // ~10%

        let slot = 51_u64;
        liquidate_spot(
            0,
            1,
            10 * 10_u128.pow(6),
            None,
            &mut user,
            &user_key,
            &mut user_stats,
            &mut liquidator,
            &liquidator_key,
            &mut liquidator_stats,
            &market_map,
            &spot_market_map,
            &mut oracle_map,
            now,
            slot,
            &state,
        )
        .unwrap();

        assert_eq!(user.last_active_slot, 1);
        assert_eq!(user.liquidation_margin_freed, 30328714);
        assert_eq!(user.spot_positions[0].scaled_balance, 792456458000);
        assert_eq!(user.spot_positions[1].scaled_balance, 7429711998);

        let MarginCalculation {
            total_collateral,
            margin_requirement_plus_buffer,
            ..
        } = calculate_margin_requirement_and_total_collateral_and_liability_info(
            &user,
            &market_map,
            &spot_market_map,
            &mut oracle_map,
            MarginContext::liquidation(liquidation_buffer),
        )
        .unwrap();

        let margin_shortage =
            ((margin_requirement_plus_buffer as i128) - total_collateral).unsigned_abs();

        let pct_margin_freed = (user.liquidation_margin_freed as u128) * PRICE_PRECISION
            / (margin_shortage + user.liquidation_margin_freed as u128);
        assert_eq!(pct_margin_freed, 433267); // ~43.3%
        assert_eq!(user.is_being_liquidated(), true);

        let slot = 136_u64;
        liquidate_spot(
            0,
            1,
            10 * 10_u128.pow(6),
            None,
            &mut user,
            &user_key,
            &mut user_stats,
            &mut liquidator,
            &liquidator_key,
            &mut liquidator_stats,
            &market_map,
            &spot_market_map,
            &mut oracle_map,
            now,
            slot,
            &state,
        )
        .unwrap();

        assert_eq!(user.last_active_slot, 1);
        assert_eq!(user.liquidation_margin_freed, 0);
        assert_eq!(user.spot_positions[0].scaled_balance, 455580082000);
        assert_eq!(user.spot_positions[1].scaled_balance, 4067681997);
        assert_eq!(user.is_being_liquidated(), false);
    }

    #[test]
    pub fn successful_liquidation_half_if_fee() {
        let now = 0_i64;
        let slot = 0_u64;

        let mut sol_oracle_price = get_pyth_price(100, 6);
        let sol_oracle_price_key =
            Pubkey::from_str("J83w4HKfqxwcq3BEMMkPFSppX3gqekLyLJBexebFVkix").unwrap();
        let pyth_program = crate::ids::pyth_program::id();
        create_account_info!(
            sol_oracle_price,
            &sol_oracle_price_key,
            &pyth_program,
            oracle_account_info
        );
        let mut oracle_map = OracleMap::load_one(&oracle_account_info, slot, None).unwrap();

        let market_map = PerpMarketMap::empty();

        let mut usdc_market = SpotMarket {
            market_index: 0,
            oracle_source: OracleSource::QuoteAsset,
            cumulative_deposit_interest: SPOT_CUMULATIVE_INTEREST_PRECISION,
            decimals: 6,
            initial_asset_weight: SPOT_WEIGHT_PRECISION,
            maintenance_asset_weight: SPOT_WEIGHT_PRECISION,
            deposit_balance: 200 * SPOT_BALANCE_PRECISION,
            liquidator_fee: 0,
            historical_oracle_data: HistoricalOracleData {
                last_oracle_price_twap: QUOTE_PRECISION_I64,
                last_oracle_price_twap_5min: QUOTE_PRECISION_I64,
                ..HistoricalOracleData::default()
            },
            ..SpotMarket::default()
        };
        create_anchor_account_info!(usdc_market, SpotMarket, usdc_spot_market_account_info);
        let mut sol_market = SpotMarket {
            market_index: 1,
            oracle_source: OracleSource::Pyth,
            oracle: sol_oracle_price_key,
            cumulative_deposit_interest: SPOT_CUMULATIVE_INTEREST_PRECISION,
            cumulative_borrow_interest: SPOT_CUMULATIVE_INTEREST_PRECISION,
            decimals: 9,
            initial_asset_weight: 8 * SPOT_WEIGHT_PRECISION / 10,
            maintenance_asset_weight: 9 * SPOT_WEIGHT_PRECISION / 10,
            initial_liability_weight: 12 * SPOT_WEIGHT_PRECISION / 10,
            maintenance_liability_weight: 11 * SPOT_WEIGHT_PRECISION / 10,
            deposit_balance: SPOT_BALANCE_PRECISION,
            borrow_balance: SPOT_BALANCE_PRECISION,
            liquidator_fee: LIQUIDATION_FEE_PRECISION / 100,
            if_liquidation_fee: LIQUIDATION_FEE_PRECISION / 20,
            historical_oracle_data: HistoricalOracleData {
                last_oracle_price_twap: (sol_oracle_price.agg.price * 99 / 100),
                last_oracle_price_twap_5min: (sol_oracle_price.agg.price * 99 / 100),
                ..HistoricalOracleData::default()
            },
            ..SpotMarket::default()
        };
        create_anchor_account_info!(sol_market, SpotMarket, sol_spot_market_account_info);
        let mut usdt_market = SpotMarket {
            market_index: 2,
            oracle_source: OracleSource::QuoteAsset,
            cumulative_deposit_interest: SPOT_CUMULATIVE_INTEREST_PRECISION,
            decimals: 6,
            initial_asset_weight: 8 * SPOT_WEIGHT_PRECISION / 10,
            maintenance_asset_weight: 9 * SPOT_WEIGHT_PRECISION / 10,
            deposit_balance: 200 * SPOT_BALANCE_PRECISION,
            liquidator_fee: LIQUIDATION_FEE_PRECISION / 100,
            historical_oracle_data: HistoricalOracleData {
                last_oracle_price_twap: QUOTE_PRECISION_I64,
                last_oracle_price_twap_5min: QUOTE_PRECISION_I64,
                ..HistoricalOracleData::default()
            },
            ..SpotMarket::default()
        };
        create_anchor_account_info!(usdt_market, SpotMarket, usdt_spot_market_account_info);
        let spot_market_account_infos = Vec::from([
            &usdc_spot_market_account_info,
            &sol_spot_market_account_info,
            &usdt_spot_market_account_info,
        ]);
        let spot_market_map =
            SpotMarketMap::load_multiple(spot_market_account_infos, true).unwrap();

        let mut spot_positions = [SpotPosition::default(); 8];
        spot_positions[1] = SpotPosition {
            market_index: 1,
            balance_type: SpotBalanceType::Borrow,
            scaled_balance: SPOT_BALANCE_PRECISION_U64,
            ..SpotPosition::default()
        };
        spot_positions[2] = SpotPosition {
            market_index: 2,
            balance_type: SpotBalanceType::Deposit,
            scaled_balance: 105 * SPOT_BALANCE_PRECISION_U64,
            ..SpotPosition::default()
        };
        let mut user = User {
            orders: [Order::default(); 32],
            perp_positions: [PerpPosition::default(); 8],
            spot_positions,
            ..User::default()
        };

        let mut liquidator = User {
            spot_positions: get_spot_positions(SpotPosition {
                market_index: 0,
                balance_type: SpotBalanceType::Deposit,
                scaled_balance: 100 * SPOT_BALANCE_PRECISION_U64,
                ..SpotPosition::default()
            }),
            ..User::default()
        };

        let user_key = Pubkey::default();
        let liquidator_key = Pubkey::default();

        let liquidation_buffer = MARGIN_PRECISION / 50;
        let state = State {
            liquidation_margin_buffer_ratio: liquidation_buffer,
            initial_pct_to_liquidate: LIQUIDATION_PCT_PRECISION as u16,
            liquidation_duration: 150,
            ..Default::default()
        };

        let mut user_stats = UserStats::default();
        let mut liquidator_stats = UserStats::default();

        liquidate_spot(
            2,
            1,
            10_u128.pow(9),
            None,
            &mut user,
            &user_key,
            &mut user_stats,
            &mut liquidator,
            &liquidator_key,
            &mut liquidator_stats,
            &market_map,
            &spot_market_map,
            &mut oracle_map,
            now,
            slot,
            &state,
        )
        .unwrap();

        let liability_market = spot_market_map.get_ref(&1).unwrap();
        let revenue_pool_token_amount = get_token_amount(
            liability_market.revenue_pool.scaled_balance,
            &liability_market,
            &SpotBalanceType::Deposit,
        )
        .unwrap();

        assert_eq!(revenue_pool_token_amount, 23944781); // 2.39%

        let margin_calc = calculate_margin_requirement_and_total_collateral_and_liability_info(
            &user,
            &market_map,
            &spot_market_map,
            &mut oracle_map,
            MarginContext::liquidation(liquidation_buffer),
        )
        .unwrap();

        print!("{:?}", margin_calc);
        assert!(margin_calc.meets_margin_requirement());
    }
}

pub mod liquidate_borrow_for_perp_pnl {
    use std::ops::Deref;
    use std::str::FromStr;

    use anchor_lang::Owner;
    use solana_program::pubkey::Pubkey;

    use crate::controller::liquidation::liquidate_borrow_for_perp_pnl;
    use crate::create_account_info;
    use crate::create_anchor_account_info;
    use crate::error::ErrorCode;
    use crate::math::constants::{
        AMM_RESERVE_PRECISION, BASE_PRECISION_I128, LIQUIDATION_FEE_PRECISION,
        LIQUIDATION_PCT_PRECISION, MARGIN_PRECISION, MARGIN_PRECISION_U128, PEG_PRECISION,
        PERCENTAGE_PRECISION, PRICE_PRECISION, PRICE_PRECISION_U64, QUOTE_PRECISION_I128,
        QUOTE_PRECISION_I64, SPOT_BALANCE_PRECISION, SPOT_BALANCE_PRECISION_U64,
        SPOT_CUMULATIVE_INTEREST_PRECISION, SPOT_WEIGHT_PRECISION,
    };
    use crate::math::margin::calculate_margin_requirement_and_total_collateral_and_liability_info;
    use crate::math::spot_balance::{get_token_amount, get_token_value};
    use crate::state::margin_calculation::{MarginCalculation, MarginContext};
    use crate::state::oracle::HistoricalOracleData;
    use crate::state::oracle::OracleSource;
    use crate::state::oracle_map::OracleMap;
    use crate::state::perp_market::{MarketStatus, PerpMarket, AMM};
    use crate::state::perp_market_map::PerpMarketMap;
    use crate::state::spot_market::{SpotBalanceType, SpotMarket};
    use crate::state::spot_market_map::SpotMarketMap;
    use crate::state::user::{Order, PerpPosition, SpotPosition, User};
    use crate::test_utils::*;
    use crate::test_utils::{get_positions, get_pyth_price, get_spot_positions};

    #[test]
    pub fn successful_liquidation_liquidator_max_liability_transfer() {
        let now = 0_i64;
        let slot = 0_u64;

        let mut sol_oracle_price = get_pyth_price(100, 6);
        let sol_oracle_price_key =
            Pubkey::from_str("J83w4HKfqxwcq3BEMMkPFSppX3gqekLyLJBexebFVkix").unwrap();
        let pyth_program = crate::ids::pyth_program::id();
        create_account_info!(
            sol_oracle_price,
            &sol_oracle_price_key,
            &pyth_program,
            oracle_account_info
        );
        let mut oracle_map = OracleMap::load_one(&oracle_account_info, slot, None).unwrap();

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
                max_fill_reserve_fraction: 100,
                order_step_size: 10000000,
                quote_asset_amount: 150 * QUOTE_PRECISION_I128,
                base_asset_amount_with_amm: BASE_PRECISION_I128,
                oracle: sol_oracle_price_key,
                ..AMM::default()
            },
            margin_ratio_initial: 1000,
            margin_ratio_maintenance: 500,
            unrealized_pnl_initial_asset_weight: 9000,
            unrealized_pnl_maintenance_asset_weight: 10000,
            number_of_users_with_base: 1,
            status: MarketStatus::Initialized,
            liquidator_fee: LIQUIDATION_FEE_PRECISION / 100,
            ..PerpMarket::default()
        };
        create_anchor_account_info!(market, PerpMarket, market_account_info);
        let market_map = PerpMarketMap::load_one(&market_account_info, true).unwrap();

        let mut usdc_market = SpotMarket {
            market_index: 0,
            oracle_source: OracleSource::QuoteAsset,
            cumulative_deposit_interest: SPOT_CUMULATIVE_INTEREST_PRECISION,
            decimals: 6,
            initial_asset_weight: SPOT_WEIGHT_PRECISION,
            maintenance_asset_weight: SPOT_WEIGHT_PRECISION,
            deposit_balance: 200 * SPOT_BALANCE_PRECISION,
            liquidator_fee: 0,
            historical_oracle_data: HistoricalOracleData {
                last_oracle_price_twap: QUOTE_PRECISION_I64,
                last_oracle_price_twap_5min: QUOTE_PRECISION_I64,
                ..HistoricalOracleData::default()
            },
            ..SpotMarket::default()
        };
        create_anchor_account_info!(usdc_market, SpotMarket, usdc_spot_market_account_info);
        let mut sol_market = SpotMarket {
            market_index: 1,
            oracle_source: OracleSource::Pyth,
            oracle: sol_oracle_price_key,
            cumulative_deposit_interest: SPOT_CUMULATIVE_INTEREST_PRECISION,
            cumulative_borrow_interest: SPOT_CUMULATIVE_INTEREST_PRECISION,
            decimals: 6,
            initial_asset_weight: 8 * SPOT_WEIGHT_PRECISION / 10,
            maintenance_asset_weight: 9 * SPOT_WEIGHT_PRECISION / 10,
            initial_liability_weight: 12 * SPOT_WEIGHT_PRECISION / 10,
            maintenance_liability_weight: 11 * SPOT_WEIGHT_PRECISION / 10,
            deposit_balance: SPOT_BALANCE_PRECISION,
            borrow_balance: SPOT_BALANCE_PRECISION,
            liquidator_fee: LIQUIDATION_FEE_PRECISION / 1000,
            historical_oracle_data: HistoricalOracleData {
                last_oracle_price_twap: (sol_oracle_price.agg.price * 99 / 100),
                last_oracle_price_twap_5min: (sol_oracle_price.agg.price * 99 / 100),
                ..HistoricalOracleData::default()
            },
            ..SpotMarket::default()
        };
        create_anchor_account_info!(sol_market, SpotMarket, sol_spot_market_account_info);
        let spot_market_account_infos = Vec::from([
            &usdc_spot_market_account_info,
            &sol_spot_market_account_info,
        ]);
        let spot_market_map =
            SpotMarketMap::load_multiple(spot_market_account_infos, true).unwrap();

        let mut spot_positions = [SpotPosition::default(); 8];
        spot_positions[0] = SpotPosition {
            market_index: 1,
            balance_type: SpotBalanceType::Borrow,
            scaled_balance: SPOT_BALANCE_PRECISION_U64,
            ..SpotPosition::default()
        };
        let mut user = User {
            orders: [Order::default(); 32],
            perp_positions: get_positions(PerpPosition {
                market_index: 0,
                quote_asset_amount: 100 * QUOTE_PRECISION_I64,
                ..PerpPosition::default()
            }),
            spot_positions,
            ..User::default()
        };

        let mut liquidator = User {
            spot_positions: get_spot_positions(SpotPosition {
                market_index: 0,
                balance_type: SpotBalanceType::Deposit,
                scaled_balance: 100 * SPOT_BALANCE_PRECISION_U64,
                ..SpotPosition::default()
            }),
            ..User::default()
        };

        let user_key = Pubkey::default();
        let liquidator_key = Pubkey::default();

        liquidate_borrow_for_perp_pnl(
            0,
            1,
            8 * 10_u128.pow(5), // .8
            None,
            &mut user,
            &user_key,
            &mut liquidator,
            &liquidator_key,
            &market_map,
            &spot_market_map,
            &mut oracle_map,
            now,
            slot,
            10,
            PERCENTAGE_PRECISION,
            150,
        )
        .unwrap();

        assert_eq!(user.spot_positions[0].scaled_balance, 199999999);
        assert_eq!(user.perp_positions[0].quote_asset_amount, 19119120);

        assert_eq!(
            liquidator.spot_positions[1].balance_type,
            SpotBalanceType::Borrow
        );
        assert_eq!(liquidator.spot_positions[1].scaled_balance, 800000001);
        assert_eq!(liquidator.perp_positions[0].quote_asset_amount, 80880880);
    }

    #[test]
    pub fn successful_liquidation_liability_transfer_to_cover_margin_shortage() {
        let now = 0_i64;
        let slot = 0_u64;

        let mut sol_oracle_price = get_pyth_price(100, 6);
        let sol_oracle_price_key =
            Pubkey::from_str("J83w4HKfqxwcq3BEMMkPFSppX3gqekLyLJBexebFVkix").unwrap();
        let pyth_program = crate::ids::pyth_program::id();
        create_account_info!(
            sol_oracle_price,
            &sol_oracle_price_key,
            &pyth_program,
            oracle_account_info
        );
        let mut oracle_map = OracleMap::load_one(&oracle_account_info, slot, None).unwrap();

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
                max_fill_reserve_fraction: 100,
                order_step_size: 10000000,
                quote_asset_amount: 150 * QUOTE_PRECISION_I128,
                base_asset_amount_with_amm: BASE_PRECISION_I128,
                oracle: sol_oracle_price_key,
                ..AMM::default()
            },
            margin_ratio_initial: 1000,
            margin_ratio_maintenance: 500,
            unrealized_pnl_initial_asset_weight: 9000,
            unrealized_pnl_maintenance_asset_weight: 10000,
            number_of_users_with_base: 1,
            status: MarketStatus::Initialized,
            liquidator_fee: LIQUIDATION_FEE_PRECISION / 100,
            ..PerpMarket::default()
        };
        create_anchor_account_info!(market, PerpMarket, market_account_info);
        let market_map = PerpMarketMap::load_one(&market_account_info, true).unwrap();

        let mut usdc_market = SpotMarket {
            market_index: 0,
            oracle_source: OracleSource::QuoteAsset,
            cumulative_deposit_interest: SPOT_CUMULATIVE_INTEREST_PRECISION,
            decimals: 6,
            initial_asset_weight: SPOT_WEIGHT_PRECISION,
            maintenance_asset_weight: SPOT_WEIGHT_PRECISION,
            deposit_balance: 200 * SPOT_BALANCE_PRECISION,
            liquidator_fee: 0,
            historical_oracle_data: HistoricalOracleData {
                last_oracle_price_twap: QUOTE_PRECISION_I64,
                last_oracle_price_twap_5min: QUOTE_PRECISION_I64,
                ..HistoricalOracleData::default()
            },
            ..SpotMarket::default()
        };
        create_anchor_account_info!(usdc_market, SpotMarket, usdc_spot_market_account_info);
        let mut sol_market = SpotMarket {
            market_index: 1,
            oracle_source: OracleSource::Pyth,
            oracle: sol_oracle_price_key,
            cumulative_deposit_interest: SPOT_CUMULATIVE_INTEREST_PRECISION,
            cumulative_borrow_interest: SPOT_CUMULATIVE_INTEREST_PRECISION,
            decimals: 6,
            initial_asset_weight: 8 * SPOT_WEIGHT_PRECISION / 10,
            maintenance_asset_weight: 9 * SPOT_WEIGHT_PRECISION / 10,
            initial_liability_weight: 12 * SPOT_WEIGHT_PRECISION / 10,
            maintenance_liability_weight: 11 * SPOT_WEIGHT_PRECISION / 10,
            deposit_balance: SPOT_BALANCE_PRECISION,
            borrow_balance: SPOT_BALANCE_PRECISION,
            liquidator_fee: LIQUIDATION_FEE_PRECISION / 1000,
            if_liquidation_fee: LIQUIDATION_FEE_PRECISION / 1000,
            historical_oracle_data: HistoricalOracleData {
                last_oracle_price_twap: (sol_oracle_price.agg.price * 99 / 100),
                last_oracle_price_twap_5min: (sol_oracle_price.agg.price * 99 / 100),
                ..HistoricalOracleData::default()
            },
            ..SpotMarket::default()
        };
        create_anchor_account_info!(sol_market, SpotMarket, sol_spot_market_account_info);
        let spot_market_account_infos = Vec::from([
            &usdc_spot_market_account_info,
            &sol_spot_market_account_info,
        ]);
        let spot_market_map =
            SpotMarketMap::load_multiple(spot_market_account_infos, true).unwrap();

        let mut spot_positions = [SpotPosition::default(); 8];
        spot_positions[0] = SpotPosition {
            market_index: 1,
            balance_type: SpotBalanceType::Borrow,
            scaled_balance: SPOT_BALANCE_PRECISION_U64,
            ..SpotPosition::default()
        };
        let mut user = User {
            orders: [Order::default(); 32],
            perp_positions: get_positions(PerpPosition {
                market_index: 0,
                quote_asset_amount: 105 * QUOTE_PRECISION_I64,
                ..PerpPosition::default()
            }),
            spot_positions,
            ..User::default()
        };

        let mut liquidator = User {
            spot_positions: get_spot_positions(SpotPosition {
                market_index: 0,
                balance_type: SpotBalanceType::Deposit,
                scaled_balance: 100 * SPOT_BALANCE_PRECISION_U64,
                ..SpotPosition::default()
            }),
            ..User::default()
        };

        let user_key = Pubkey::default();
        let liquidator_key = Pubkey::default();

        let liquidation_buffer = MARGIN_PRECISION / 50;
        liquidate_borrow_for_perp_pnl(
            0,
            1,
            2 * 10_u128.pow(6),
            None,
            &mut user,
            &user_key,
            &mut liquidator,
            &liquidator_key,
            &market_map,
            &spot_market_map,
            &mut oracle_map,
            now,
            slot,
            liquidation_buffer,
            PERCENTAGE_PRECISION,
            150,
        )
        .unwrap();

        assert_eq!(user.spot_positions[0].scaled_balance, 357739999);
        assert_eq!(user.perp_positions[0].quote_asset_amount, 40066807);

        let MarginCalculation {
            total_collateral,
            margin_requirement_plus_buffer,
            ..
        } = calculate_margin_requirement_and_total_collateral_and_liability_info(
            &user,
            &market_map,
            &spot_market_map,
            &mut oracle_map,
            MarginContext::liquidation(liquidation_buffer),
        )
        .unwrap();

        assert_eq!(total_collateral, 40066807);
        assert_eq!(margin_requirement_plus_buffer, 40066880);

        let token_amount = get_token_amount(
            user.spot_positions[0].scaled_balance as u128,
            spot_market_map.get_ref(&1).unwrap().deref(),
            &user.spot_positions[0].balance_type,
        )
        .unwrap();
        let oracle_price_data = oracle_map
            .get_price_data(&(sol_oracle_price_key, OracleSource::Pyth))
            .unwrap();
        let token_value =
            get_token_value(token_amount as i128, 6, oracle_price_data.price).unwrap();

        let margin_ratio =
            total_collateral.unsigned_abs() * MARGIN_PRECISION_U128 / token_value.unsigned_abs();

        assert_eq!(margin_ratio, 11199); // ~112%

        assert_eq!(
            liquidator.spot_positions[1].balance_type,
            SpotBalanceType::Borrow
        );
        assert_eq!(liquidator.spot_positions[1].scaled_balance, 642260001);
        assert_eq!(liquidator.perp_positions[0].quote_asset_amount, 64933193);

        let market_after = spot_market_map.get_ref(&1).unwrap();
        let market_revenue = get_token_amount(
            market_after.revenue_pool.scaled_balance,
            &market_after,
            &SpotBalanceType::Deposit,
        )
        .unwrap();

        assert_eq!(market_revenue, 0);
    }

    #[test]
    pub fn successful_liquidation_liability_transfer_implied_by_pnl() {
        let now = 0_i64;
        let slot = 0_u64;

        let mut sol_oracle_price = get_pyth_price(100, 6);
        let sol_oracle_price_key =
            Pubkey::from_str("J83w4HKfqxwcq3BEMMkPFSppX3gqekLyLJBexebFVkix").unwrap();
        let pyth_program = crate::ids::pyth_program::id();
        create_account_info!(
            sol_oracle_price,
            &sol_oracle_price_key,
            &pyth_program,
            oracle_account_info
        );
        let mut oracle_map = OracleMap::load_one(&oracle_account_info, slot, None).unwrap();

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
                max_fill_reserve_fraction: 100,
                order_step_size: 10000000,
                quote_asset_amount: 150 * QUOTE_PRECISION_I128,
                base_asset_amount_with_amm: BASE_PRECISION_I128,
                oracle: sol_oracle_price_key,
                ..AMM::default()
            },
            margin_ratio_initial: 1000,
            unrealized_pnl_initial_asset_weight: 9000,
            unrealized_pnl_maintenance_asset_weight: 10000,
            number_of_users_with_base: 1,
            status: MarketStatus::Initialized,
            liquidator_fee: LIQUIDATION_FEE_PRECISION / 100,
            ..PerpMarket::default()
        };
        create_anchor_account_info!(market, PerpMarket, market_account_info);
        let market_map = PerpMarketMap::load_one(&market_account_info, true).unwrap();

        let mut usdc_market = SpotMarket {
            market_index: 0,
            oracle_source: OracleSource::QuoteAsset,
            cumulative_deposit_interest: SPOT_CUMULATIVE_INTEREST_PRECISION,
            decimals: 6,
            initial_asset_weight: SPOT_WEIGHT_PRECISION,
            maintenance_asset_weight: SPOT_WEIGHT_PRECISION,
            deposit_balance: 200 * SPOT_BALANCE_PRECISION,
            liquidator_fee: 0,
            historical_oracle_data: HistoricalOracleData {
                last_oracle_price_twap: QUOTE_PRECISION_I64,
                last_oracle_price_twap_5min: QUOTE_PRECISION_I64,
                ..HistoricalOracleData::default()
            },
            ..SpotMarket::default()
        };
        create_anchor_account_info!(usdc_market, SpotMarket, usdc_spot_market_account_info);
        let mut sol_market = SpotMarket {
            market_index: 1,
            oracle_source: OracleSource::Pyth,
            oracle: sol_oracle_price_key,
            cumulative_deposit_interest: SPOT_CUMULATIVE_INTEREST_PRECISION,
            cumulative_borrow_interest: SPOT_CUMULATIVE_INTEREST_PRECISION,
            decimals: 6,
            initial_asset_weight: 8 * SPOT_WEIGHT_PRECISION / 10,
            maintenance_asset_weight: 9 * SPOT_WEIGHT_PRECISION / 10,
            initial_liability_weight: 12 * SPOT_WEIGHT_PRECISION / 10,
            maintenance_liability_weight: 11 * SPOT_WEIGHT_PRECISION / 10,
            deposit_balance: SPOT_BALANCE_PRECISION,
            borrow_balance: SPOT_BALANCE_PRECISION,
            liquidator_fee: LIQUIDATION_FEE_PRECISION / 1000,
            historical_oracle_data: HistoricalOracleData {
                last_oracle_price_twap: (sol_oracle_price.agg.price * 99 / 100),
                last_oracle_price_twap_5min: (sol_oracle_price.agg.price * 99 / 100),
                ..HistoricalOracleData::default()
            },
            ..SpotMarket::default()
        };
        create_anchor_account_info!(sol_market, SpotMarket, sol_spot_market_account_info);
        let spot_market_account_infos = Vec::from([
            &usdc_spot_market_account_info,
            &sol_spot_market_account_info,
        ]);
        let spot_market_map =
            SpotMarketMap::load_multiple(spot_market_account_infos, true).unwrap();

        let mut spot_positions = [SpotPosition::default(); 8];
        spot_positions[0] = SpotPosition {
            market_index: 1,
            balance_type: SpotBalanceType::Borrow,
            scaled_balance: SPOT_BALANCE_PRECISION_U64,
            ..SpotPosition::default()
        };
        let mut user = User {
            orders: [Order::default(); 32],
            perp_positions: get_positions(PerpPosition {
                market_index: 0,
                quote_asset_amount: 80 * QUOTE_PRECISION_I64,
                ..PerpPosition::default()
            }),
            spot_positions,
            ..User::default()
        };

        let mut liquidator = User {
            spot_positions: get_spot_positions(SpotPosition {
                market_index: 0,
                balance_type: SpotBalanceType::Deposit,
                scaled_balance: 100 * SPOT_BALANCE_PRECISION_U64,
                ..SpotPosition::default()
            }),
            ..User::default()
        };

        let user_key = Pubkey::default();
        let liquidator_key = Pubkey::default();

        liquidate_borrow_for_perp_pnl(
            0,
            1,
            2 * 10_u128.pow(6),
            None,
            &mut user,
            &user_key,
            &mut liquidator,
            &liquidator_key,
            &market_map,
            &spot_market_map,
            &mut oracle_map,
            now,
            slot,
            10,
            PERCENTAGE_PRECISION,
            150,
        )
        .unwrap();

        assert_eq!(user.spot_positions[0].scaled_balance, 208711999);
        assert_eq!(user.perp_positions[0].quote_asset_amount, 0);

        assert_eq!(
            liquidator.spot_positions[1].balance_type,
            SpotBalanceType::Borrow
        );
        assert_eq!(liquidator.spot_positions[1].scaled_balance, 791288001);
        assert_eq!(liquidator.perp_positions[0].quote_asset_amount, 80000000);
    }

    #[test]
    pub fn failure_due_to_limit_price() {
        let now = 0_i64;
        let slot = 0_u64;

        let mut sol_oracle_price = get_pyth_price(100, 6);
        let sol_oracle_price_key =
            Pubkey::from_str("J83w4HKfqxwcq3BEMMkPFSppX3gqekLyLJBexebFVkix").unwrap();
        let pyth_program = crate::ids::pyth_program::id();
        create_account_info!(
            sol_oracle_price,
            &sol_oracle_price_key,
            &pyth_program,
            oracle_account_info
        );
        let mut oracle_map = OracleMap::load_one(&oracle_account_info, slot, None).unwrap();

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
                max_fill_reserve_fraction: 100,
                order_step_size: 10000000,
                quote_asset_amount: 150 * QUOTE_PRECISION_I128,
                base_asset_amount_with_amm: BASE_PRECISION_I128,
                oracle: sol_oracle_price_key,
                ..AMM::default()
            },
            margin_ratio_initial: 1000,
            margin_ratio_maintenance: 500,
            unrealized_pnl_initial_asset_weight: 9000,
            unrealized_pnl_maintenance_asset_weight: 10000,
            number_of_users_with_base: 1,
            status: MarketStatus::Initialized,
            liquidator_fee: LIQUIDATION_FEE_PRECISION / 100,
            ..PerpMarket::default()
        };
        create_anchor_account_info!(market, PerpMarket, market_account_info);
        let market_map = PerpMarketMap::load_one(&market_account_info, true).unwrap();

        let mut usdc_market = SpotMarket {
            market_index: 0,
            oracle_source: OracleSource::QuoteAsset,
            cumulative_deposit_interest: SPOT_CUMULATIVE_INTEREST_PRECISION,
            decimals: 6,
            initial_asset_weight: SPOT_WEIGHT_PRECISION,
            maintenance_asset_weight: SPOT_WEIGHT_PRECISION,
            deposit_balance: 200 * SPOT_BALANCE_PRECISION,
            liquidator_fee: 0,
            historical_oracle_data: HistoricalOracleData {
                last_oracle_price_twap: QUOTE_PRECISION_I64,
                last_oracle_price_twap_5min: QUOTE_PRECISION_I64,
                ..HistoricalOracleData::default()
            },
            ..SpotMarket::default()
        };
        create_anchor_account_info!(usdc_market, SpotMarket, usdc_spot_market_account_info);
        let mut sol_market = SpotMarket {
            market_index: 1,
            oracle_source: OracleSource::Pyth,
            oracle: sol_oracle_price_key,
            cumulative_deposit_interest: SPOT_CUMULATIVE_INTEREST_PRECISION,
            cumulative_borrow_interest: SPOT_CUMULATIVE_INTEREST_PRECISION,
            decimals: 6,
            initial_asset_weight: 8 * SPOT_WEIGHT_PRECISION / 10,
            maintenance_asset_weight: 9 * SPOT_WEIGHT_PRECISION / 10,
            initial_liability_weight: 12 * SPOT_WEIGHT_PRECISION / 10,
            maintenance_liability_weight: 11 * SPOT_WEIGHT_PRECISION / 10,
            deposit_balance: SPOT_BALANCE_PRECISION,
            borrow_balance: SPOT_BALANCE_PRECISION,
            liquidator_fee: LIQUIDATION_FEE_PRECISION / 1000,
            historical_oracle_data: HistoricalOracleData {
                last_oracle_price_twap: (sol_oracle_price.agg.price * 99 / 100),
                last_oracle_price_twap_5min: (sol_oracle_price.agg.price * 99 / 100),
                ..HistoricalOracleData::default()
            },
            ..SpotMarket::default()
        };
        create_anchor_account_info!(sol_market, SpotMarket, sol_spot_market_account_info);
        let spot_market_account_infos = Vec::from([
            &usdc_spot_market_account_info,
            &sol_spot_market_account_info,
        ]);
        let spot_market_map =
            SpotMarketMap::load_multiple(spot_market_account_infos, true).unwrap();

        let mut spot_positions = [SpotPosition::default(); 8];
        spot_positions[0] = SpotPosition {
            market_index: 1,
            balance_type: SpotBalanceType::Borrow,
            scaled_balance: SPOT_BALANCE_PRECISION_U64,
            ..SpotPosition::default()
        };
        let mut user = User {
            orders: [Order::default(); 32],
            perp_positions: get_positions(PerpPosition {
                market_index: 0,
                quote_asset_amount: 100 * QUOTE_PRECISION_I64,
                ..PerpPosition::default()
            }),
            spot_positions,
            ..User::default()
        };

        let mut liquidator = User {
            spot_positions: get_spot_positions(SpotPosition {
                market_index: 0,
                balance_type: SpotBalanceType::Deposit,
                scaled_balance: 100 * SPOT_BALANCE_PRECISION_U64,
                ..SpotPosition::default()
            }),
            ..User::default()
        };

        let user_key = Pubkey::default();
        let liquidator_key = Pubkey::default();

        let limit_price = (80880880 * PRICE_PRECISION_U64 / 800000) + 1;
        let result = liquidate_borrow_for_perp_pnl(
            0,
            1,
            8 * 10_u128.pow(5), // .8
            Some(limit_price),
            &mut user,
            &user_key,
            &mut liquidator,
            &liquidator_key,
            &market_map,
            &spot_market_map,
            &mut oracle_map,
            now,
            slot,
            10,
            PERCENTAGE_PRECISION,
            150,
        );

        assert_eq!(result, Err(ErrorCode::LiquidationDoesntSatisfyLimitPrice));
    }

    #[test]
    pub fn success_with_limit_price() {
        let now = 0_i64;
        let slot = 0_u64;

        let mut sol_oracle_price = get_pyth_price(100, 6);
        let sol_oracle_price_key =
            Pubkey::from_str("J83w4HKfqxwcq3BEMMkPFSppX3gqekLyLJBexebFVkix").unwrap();
        let pyth_program = crate::ids::pyth_program::id();
        create_account_info!(
            sol_oracle_price,
            &sol_oracle_price_key,
            &pyth_program,
            oracle_account_info
        );
        let mut oracle_map = OracleMap::load_one(&oracle_account_info, slot, None).unwrap();

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
                max_fill_reserve_fraction: 100,
                order_step_size: 10000000,
                quote_asset_amount: 150 * QUOTE_PRECISION_I128,
                base_asset_amount_with_amm: BASE_PRECISION_I128,
                oracle: sol_oracle_price_key,
                ..AMM::default()
            },
            margin_ratio_initial: 1000,
            margin_ratio_maintenance: 500,
            unrealized_pnl_initial_asset_weight: 9000,
            unrealized_pnl_maintenance_asset_weight: 10000,
            number_of_users_with_base: 1,
            status: MarketStatus::Initialized,
            liquidator_fee: LIQUIDATION_FEE_PRECISION / 100,
            ..PerpMarket::default()
        };
        create_anchor_account_info!(market, PerpMarket, market_account_info);
        let market_map = PerpMarketMap::load_one(&market_account_info, true).unwrap();

        let mut usdc_market = SpotMarket {
            market_index: 0,
            oracle_source: OracleSource::QuoteAsset,
            cumulative_deposit_interest: SPOT_CUMULATIVE_INTEREST_PRECISION,
            decimals: 6,
            initial_asset_weight: SPOT_WEIGHT_PRECISION,
            maintenance_asset_weight: SPOT_WEIGHT_PRECISION,
            deposit_balance: 200 * SPOT_BALANCE_PRECISION,
            liquidator_fee: 0,
            historical_oracle_data: HistoricalOracleData {
                last_oracle_price_twap: QUOTE_PRECISION_I64,
                last_oracle_price_twap_5min: QUOTE_PRECISION_I64,
                ..HistoricalOracleData::default()
            },
            ..SpotMarket::default()
        };
        create_anchor_account_info!(usdc_market, SpotMarket, usdc_spot_market_account_info);
        let mut sol_market = SpotMarket {
            market_index: 1,
            oracle_source: OracleSource::Pyth,
            oracle: sol_oracle_price_key,
            cumulative_deposit_interest: SPOT_CUMULATIVE_INTEREST_PRECISION,
            cumulative_borrow_interest: SPOT_CUMULATIVE_INTEREST_PRECISION,
            decimals: 6,
            initial_asset_weight: 8 * SPOT_WEIGHT_PRECISION / 10,
            maintenance_asset_weight: 9 * SPOT_WEIGHT_PRECISION / 10,
            initial_liability_weight: 12 * SPOT_WEIGHT_PRECISION / 10,
            maintenance_liability_weight: 11 * SPOT_WEIGHT_PRECISION / 10,
            deposit_balance: SPOT_BALANCE_PRECISION,
            borrow_balance: SPOT_BALANCE_PRECISION,
            liquidator_fee: LIQUIDATION_FEE_PRECISION / 1000,
            historical_oracle_data: HistoricalOracleData {
                last_oracle_price_twap: (sol_oracle_price.agg.price * 99 / 100),
                last_oracle_price_twap_5min: (sol_oracle_price.agg.price * 99 / 100),
                ..HistoricalOracleData::default()
            },
            ..SpotMarket::default()
        };
        create_anchor_account_info!(sol_market, SpotMarket, sol_spot_market_account_info);
        let spot_market_account_infos = Vec::from([
            &usdc_spot_market_account_info,
            &sol_spot_market_account_info,
        ]);
        let spot_market_map =
            SpotMarketMap::load_multiple(spot_market_account_infos, true).unwrap();

        let mut spot_positions = [SpotPosition::default(); 8];
        spot_positions[0] = SpotPosition {
            market_index: 1,
            balance_type: SpotBalanceType::Borrow,
            scaled_balance: SPOT_BALANCE_PRECISION_U64,
            ..SpotPosition::default()
        };
        let mut user = User {
            orders: [Order::default(); 32],
            perp_positions: get_positions(PerpPosition {
                market_index: 0,
                quote_asset_amount: 100 * QUOTE_PRECISION_I64,
                ..PerpPosition::default()
            }),
            spot_positions,
            ..User::default()
        };

        let mut liquidator = User {
            spot_positions: get_spot_positions(SpotPosition {
                market_index: 0,
                balance_type: SpotBalanceType::Deposit,
                scaled_balance: 100 * SPOT_BALANCE_PRECISION_U64,
                ..SpotPosition::default()
            }),
            ..User::default()
        };

        let user_key = Pubkey::default();
        let liquidator_key = Pubkey::default();

        let limit_price = (80880880 * PRICE_PRECISION_U64 / 800000) - 1;
        let result = liquidate_borrow_for_perp_pnl(
            0,
            1,
            8 * 10_u128.pow(5), // .8
            Some(limit_price),
            &mut user,
            &user_key,
            &mut liquidator,
            &liquidator_key,
            &market_map,
            &spot_market_map,
            &mut oracle_map,
            now,
            slot,
            10,
            PERCENTAGE_PRECISION,
            150,
        );

        assert_eq!(result, Ok(()));
    }

    #[test]
    pub fn successful_liquidation_dust_position() {
        let now = 0_i64;
        let slot = 0_u64;

        let mut sol_oracle_price = get_pyth_price(100, 6);
        let sol_oracle_price_key =
            Pubkey::from_str("J83w4HKfqxwcq3BEMMkPFSppX3gqekLyLJBexebFVkix").unwrap();
        let pyth_program = crate::ids::pyth_program::id();
        create_account_info!(
            sol_oracle_price,
            &sol_oracle_price_key,
            &pyth_program,
            oracle_account_info
        );
        let mut oracle_map = OracleMap::load_one(&oracle_account_info, slot, None).unwrap();

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
                max_fill_reserve_fraction: 100,
                order_step_size: 10000000,
                quote_asset_amount: 150 * QUOTE_PRECISION_I128,
                base_asset_amount_with_amm: BASE_PRECISION_I128,
                oracle: sol_oracle_price_key,
                ..AMM::default()
            },
            margin_ratio_initial: 1000,
            margin_ratio_maintenance: 500,
            unrealized_pnl_initial_asset_weight: 9000,
            unrealized_pnl_maintenance_asset_weight: 10000,
            number_of_users_with_base: 1,
            status: MarketStatus::Initialized,
            liquidator_fee: LIQUIDATION_FEE_PRECISION / 100,
            ..PerpMarket::default()
        };
        create_anchor_account_info!(market, PerpMarket, market_account_info);
        let market_map = PerpMarketMap::load_one(&market_account_info, true).unwrap();

        let mut usdc_market = SpotMarket {
            market_index: 0,
            oracle_source: OracleSource::QuoteAsset,
            cumulative_deposit_interest: SPOT_CUMULATIVE_INTEREST_PRECISION,
            decimals: 6,
            initial_asset_weight: SPOT_WEIGHT_PRECISION,
            maintenance_asset_weight: SPOT_WEIGHT_PRECISION,
            deposit_balance: 200 * SPOT_BALANCE_PRECISION,
            liquidator_fee: 0,
            historical_oracle_data: HistoricalOracleData {
                last_oracle_price_twap: QUOTE_PRECISION_I64,
                last_oracle_price_twap_5min: QUOTE_PRECISION_I64,
                ..HistoricalOracleData::default()
            },
            ..SpotMarket::default()
        };
        create_anchor_account_info!(usdc_market, SpotMarket, usdc_spot_market_account_info);
        let mut sol_market = SpotMarket {
            market_index: 1,
            oracle_source: OracleSource::Pyth,
            oracle: sol_oracle_price_key,
            cumulative_deposit_interest: SPOT_CUMULATIVE_INTEREST_PRECISION,
            cumulative_borrow_interest: SPOT_CUMULATIVE_INTEREST_PRECISION,
            decimals: 6,
            initial_asset_weight: 8 * SPOT_WEIGHT_PRECISION / 10,
            maintenance_asset_weight: 9 * SPOT_WEIGHT_PRECISION / 10,
            initial_liability_weight: 12 * SPOT_WEIGHT_PRECISION / 10,
            maintenance_liability_weight: 11 * SPOT_WEIGHT_PRECISION / 10,
            deposit_balance: SPOT_BALANCE_PRECISION,
            borrow_balance: SPOT_BALANCE_PRECISION / 50,
            liquidator_fee: LIQUIDATION_FEE_PRECISION / 1000,
            if_liquidation_fee: LIQUIDATION_FEE_PRECISION / 1000,
            historical_oracle_data: HistoricalOracleData {
                last_oracle_price_twap: (sol_oracle_price.agg.price * 99 / 100),
                last_oracle_price_twap_5min: (sol_oracle_price.agg.price * 99 / 100),
                ..HistoricalOracleData::default()
            },
            ..SpotMarket::default()
        };
        create_anchor_account_info!(sol_market, SpotMarket, sol_spot_market_account_info);
        let spot_market_account_infos = Vec::from([
            &usdc_spot_market_account_info,
            &sol_spot_market_account_info,
        ]);
        let spot_market_map =
            SpotMarketMap::load_multiple(spot_market_account_infos, true).unwrap();

        let mut spot_positions = [SpotPosition::default(); 8];
        spot_positions[0] = SpotPosition {
            market_index: 1,
            balance_type: SpotBalanceType::Borrow,
            scaled_balance: SPOT_BALANCE_PRECISION_U64 / 50,
            ..SpotPosition::default()
        };
        let mut user = User {
            orders: [Order::default(); 32],
            perp_positions: get_positions(PerpPosition {
                market_index: 0,
                quote_asset_amount: 107 * QUOTE_PRECISION_I64 / 50,
                ..PerpPosition::default()
            }),
            spot_positions,
            ..User::default()
        };

        let mut liquidator = User {
            spot_positions: get_spot_positions(SpotPosition {
                market_index: 0,
                balance_type: SpotBalanceType::Deposit,
                scaled_balance: 100 * SPOT_BALANCE_PRECISION_U64,
                ..SpotPosition::default()
            }),
            ..User::default()
        };

        let user_key = Pubkey::default();
        let liquidator_key = Pubkey::default();

        let liquidation_buffer = MARGIN_PRECISION / 50;
        liquidate_borrow_for_perp_pnl(
            0,
            1,
            2 * 10_u128.pow(6),
            None,
            &mut user,
            &user_key,
            &mut liquidator,
            &liquidator_key,
            &market_map,
            &spot_market_map,
            &mut oracle_map,
            now,
            slot,
            liquidation_buffer,
            PERCENTAGE_PRECISION,
            150,
        )
        .unwrap();

        assert_eq!(user.spot_positions[0].scaled_balance, 0);
        assert_eq!(user.perp_positions[0].quote_asset_amount, 0);

        assert_eq!(
            liquidator.spot_positions[1].balance_type,
            SpotBalanceType::Borrow
        );
        assert_eq!(liquidator.spot_positions[1].scaled_balance, 20000001); // ~$1 liability taken over
        assert_eq!(liquidator.perp_positions[0].quote_asset_amount, 2140000);
    }

    #[test]
    pub fn successful_liquidation_over_multiple_slots() {
        let now = 1_i64;
        let slot = 1_u64;

        let mut sol_oracle_price = get_pyth_price(100, 6);
        let sol_oracle_price_key =
            Pubkey::from_str("J83w4HKfqxwcq3BEMMkPFSppX3gqekLyLJBexebFVkix").unwrap();
        let pyth_program = crate::ids::pyth_program::id();
        create_account_info!(
            sol_oracle_price,
            &sol_oracle_price_key,
            &pyth_program,
            oracle_account_info
        );
        let mut oracle_map = OracleMap::load_one(&oracle_account_info, slot, None).unwrap();

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
                max_fill_reserve_fraction: 100,
                order_step_size: 10000000,
                quote_asset_amount: 150 * QUOTE_PRECISION_I128,
                base_asset_amount_with_amm: BASE_PRECISION_I128,
                oracle: sol_oracle_price_key,
                ..AMM::default()
            },
            margin_ratio_initial: 1000,
            margin_ratio_maintenance: 500,
            unrealized_pnl_initial_asset_weight: 9000,
            unrealized_pnl_maintenance_asset_weight: 10000,
            number_of_users_with_base: 1,
            status: MarketStatus::Initialized,
            liquidator_fee: LIQUIDATION_FEE_PRECISION / 100,
            ..PerpMarket::default()
        };
        create_anchor_account_info!(market, PerpMarket, market_account_info);
        let market_map = PerpMarketMap::load_one(&market_account_info, true).unwrap();

        let mut usdc_market = SpotMarket {
            market_index: 0,
            oracle_source: OracleSource::QuoteAsset,
            cumulative_deposit_interest: SPOT_CUMULATIVE_INTEREST_PRECISION,
            decimals: 6,
            initial_asset_weight: SPOT_WEIGHT_PRECISION,
            maintenance_asset_weight: SPOT_WEIGHT_PRECISION,
            deposit_balance: 200 * SPOT_BALANCE_PRECISION,
            liquidator_fee: 0,
            historical_oracle_data: HistoricalOracleData {
                last_oracle_price_twap: QUOTE_PRECISION_I64,
                last_oracle_price_twap_5min: QUOTE_PRECISION_I64,
                ..HistoricalOracleData::default()
            },
            ..SpotMarket::default()
        };
        create_anchor_account_info!(usdc_market, SpotMarket, usdc_spot_market_account_info);
        let mut sol_market = SpotMarket {
            market_index: 1,
            oracle_source: OracleSource::Pyth,
            oracle: sol_oracle_price_key,
            cumulative_deposit_interest: SPOT_CUMULATIVE_INTEREST_PRECISION,
            cumulative_borrow_interest: SPOT_CUMULATIVE_INTEREST_PRECISION,
            decimals: 6,
            initial_asset_weight: 8 * SPOT_WEIGHT_PRECISION / 10,
            maintenance_asset_weight: 9 * SPOT_WEIGHT_PRECISION / 10,
            initial_liability_weight: 12 * SPOT_WEIGHT_PRECISION / 10,
            maintenance_liability_weight: 11 * SPOT_WEIGHT_PRECISION / 10,
            deposit_balance: 100 * SPOT_BALANCE_PRECISION,
            borrow_balance: 11 * SPOT_BALANCE_PRECISION,
            liquidator_fee: LIQUIDATION_FEE_PRECISION / 1000,
            if_liquidation_fee: LIQUIDATION_FEE_PRECISION / 1000,
            historical_oracle_data: HistoricalOracleData {
                last_oracle_price_twap: (sol_oracle_price.agg.price * 99 / 100),
                last_oracle_price_twap_5min: (sol_oracle_price.agg.price * 99 / 100),
                ..HistoricalOracleData::default()
            },
            ..SpotMarket::default()
        };
        create_anchor_account_info!(sol_market, SpotMarket, sol_spot_market_account_info);
        let spot_market_account_infos = Vec::from([
            &usdc_spot_market_account_info,
            &sol_spot_market_account_info,
        ]);
        let spot_market_map =
            SpotMarketMap::load_multiple(spot_market_account_infos, true).unwrap();

        let mut spot_positions = [SpotPosition::default(); 8];
        spot_positions[0] = SpotPosition {
            market_index: 1,
            balance_type: SpotBalanceType::Borrow,
            scaled_balance: 10 * SPOT_BALANCE_PRECISION_U64,
            ..SpotPosition::default()
        };
        let mut user = User {
            orders: [Order::default(); 32],
            perp_positions: get_positions(PerpPosition {
                market_index: 0,
                quote_asset_amount: 1050 * QUOTE_PRECISION_I64,
                ..PerpPosition::default()
            }),
            spot_positions,
            ..User::default()
        };

        let mut liquidator = User {
            spot_positions: get_spot_positions(SpotPosition {
                market_index: 0,
                balance_type: SpotBalanceType::Deposit,
                scaled_balance: 1000 * SPOT_BALANCE_PRECISION_U64,
                ..SpotPosition::default()
            }),
            ..User::default()
        };

        let user_key = Pubkey::default();
        let liquidator_key = Pubkey::default();

        let liquidation_buffer = MARGIN_PRECISION / 50;
        liquidate_borrow_for_perp_pnl(
            0,
            1,
            10 * 10_u128.pow(6),
            None,
            &mut user,
            &user_key,
            &mut liquidator,
            &liquidator_key,
            &market_map,
            &spot_market_map,
            &mut oracle_map,
            now,
            slot,
            liquidation_buffer,
            LIQUIDATION_PCT_PRECISION / 10,
            150,
        )
        .unwrap();

        assert_eq!(user.last_active_slot, 1);
        assert_eq!(user.liquidation_margin_freed, 6999927);
        assert_eq!(user.spot_positions[0].scaled_balance, 9357739999);
        assert_eq!(user.perp_positions[0].quote_asset_amount, 985066807);

        let MarginCalculation {
            total_collateral,
            margin_requirement_plus_buffer,
            ..
        } = calculate_margin_requirement_and_total_collateral_and_liability_info(
            &user,
            &market_map,
            &spot_market_map,
            &mut oracle_map,
            MarginContext::liquidation(liquidation_buffer),
        )
        .unwrap();

        let margin_shortage =
            ((margin_requirement_plus_buffer as i128) - total_collateral).unsigned_abs();

        let pct_margin_freed = (user.liquidation_margin_freed as u128) * PRICE_PRECISION
            / (margin_shortage + user.liquidation_margin_freed as u128);
        assert_eq!(pct_margin_freed, 99998); // ~10%

        let slot = 51_u64;
        liquidate_borrow_for_perp_pnl(
            0,
            1,
            10 * 10_u128.pow(6),
            None,
            &mut user,
            &user_key,
            &mut liquidator,
            &liquidator_key,
            &market_map,
            &spot_market_map,
            &mut oracle_map,
            now,
            slot,
            liquidation_buffer,
            LIQUIDATION_PCT_PRECISION / 10,
            150,
        )
        .unwrap();

        assert_eq!(user.last_active_slot, 1);
        assert_eq!(user.liquidation_margin_freed, 30328628);
        assert_eq!(user.spot_positions[0].scaled_balance, 7217275998);
        assert_eq!(user.perp_positions[0].quote_asset_amount, 768663540);

        let MarginCalculation {
            total_collateral,
            margin_requirement_plus_buffer,
            ..
        } = calculate_margin_requirement_and_total_collateral_and_liability_info(
            &user,
            &market_map,
            &spot_market_map,
            &mut oracle_map,
            MarginContext::liquidation(liquidation_buffer),
        )
        .unwrap();

        let margin_shortage =
            ((margin_requirement_plus_buffer as i128) - total_collateral).unsigned_abs();

        let pct_margin_freed = (user.liquidation_margin_freed as u128) * PRICE_PRECISION
            / (margin_shortage + user.liquidation_margin_freed as u128);
        assert_eq!(pct_margin_freed, 433266); // ~43.3%

        let slot = 136_u64;
        liquidate_borrow_for_perp_pnl(
            0,
            1,
            10 * 10_u128.pow(6),
            None,
            &mut user,
            &user_key,
            &mut liquidator,
            &liquidator_key,
            &market_map,
            &spot_market_map,
            &mut oracle_map,
            now,
            slot,
            liquidation_buffer,
            LIQUIDATION_PCT_PRECISION / 10,
            150,
        )
        .unwrap();

        assert_eq!(user.liquidation_margin_freed, 0);
        assert_eq!(user.last_active_slot, 1);
    }
}

pub mod liquidate_perp_pnl_for_deposit {
    use crate::state::state::State;
    use std::str::FromStr;

    use anchor_lang::Owner;
    use solana_program::pubkey::Pubkey;

    use crate::controller::liquidation::{liquidate_perp_pnl_for_deposit, liquidate_spot};
    use crate::create_account_info;
    use crate::create_anchor_account_info;
    use crate::error::ErrorCode;
    use crate::math::constants::{
        AMM_RESERVE_PRECISION, BASE_PRECISION_I128, LIQUIDATION_FEE_PRECISION,
        LIQUIDATION_PCT_PRECISION, MARGIN_PRECISION, PEG_PRECISION, PERCENTAGE_PRECISION,
        PRICE_PRECISION, PRICE_PRECISION_U64, QUOTE_PRECISION_I128, QUOTE_PRECISION_I64,
        SPOT_BALANCE_PRECISION, SPOT_BALANCE_PRECISION_U64, SPOT_CUMULATIVE_INTEREST_PRECISION,
        SPOT_WEIGHT_PRECISION,
    };
    use crate::math::margin::calculate_margin_requirement_and_total_collateral_and_liability_info;
    use crate::state::margin_calculation::{MarginCalculation, MarginContext};
    use crate::state::oracle::HistoricalOracleData;
    use crate::state::oracle::OracleSource;
    use crate::state::oracle_map::OracleMap;
    use crate::state::perp_market::{ContractTier, MarketStatus, PerpMarket, AMM};
    use crate::state::perp_market_map::PerpMarketMap;
    use crate::state::spot_market::{AssetTier, SpotBalanceType, SpotMarket};
    use crate::state::spot_market_map::SpotMarketMap;
    use crate::state::user::UserStats;
    use crate::state::user::{Order, PerpPosition, SpotPosition, User, UserStatus};
    use crate::test_utils::*;
    use crate::test_utils::{get_positions, get_pyth_price, get_spot_positions};
    #[test]
    pub fn successful_liquidation_liquidator_max_pnl_transfer() {
        let now = 0_i64;
        let slot = 0_u64;

        let mut sol_oracle_price = get_pyth_price(100, 6);
        let sol_oracle_price_key =
            Pubkey::from_str("J83w4HKfqxwcq3BEMMkPFSppX3gqekLyLJBexebFVkix").unwrap();
        let pyth_program = crate::ids::pyth_program::id();
        create_account_info!(
            sol_oracle_price,
            &sol_oracle_price_key,
            &pyth_program,
            oracle_account_info
        );
        let mut oracle_map = OracleMap::load_one(&oracle_account_info, slot, None).unwrap();

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
                max_fill_reserve_fraction: 100,
                order_step_size: 10000000,
                quote_asset_amount: 150 * QUOTE_PRECISION_I128,
                base_asset_amount_with_amm: BASE_PRECISION_I128,
                oracle: sol_oracle_price_key,
                ..AMM::default()
            },
            margin_ratio_initial: 1000,
            margin_ratio_maintenance: 500,
            unrealized_pnl_initial_asset_weight: 9000,
            unrealized_pnl_maintenance_asset_weight: 10000,
            number_of_users_with_base: 1,
            status: MarketStatus::Initialized,
            liquidator_fee: LIQUIDATION_FEE_PRECISION / 100,
            ..PerpMarket::default()
        };
        create_anchor_account_info!(market, PerpMarket, market_account_info);
        let market_map = PerpMarketMap::load_one(&market_account_info, true).unwrap();

        let mut usdc_market = SpotMarket {
            market_index: 0,
            oracle_source: OracleSource::QuoteAsset,
            cumulative_deposit_interest: SPOT_CUMULATIVE_INTEREST_PRECISION,
            decimals: 6,
            initial_asset_weight: SPOT_WEIGHT_PRECISION,
            maintenance_asset_weight: SPOT_WEIGHT_PRECISION,
            deposit_balance: 200 * SPOT_BALANCE_PRECISION,
            liquidator_fee: 0,
            historical_oracle_data: HistoricalOracleData {
                last_oracle_price_twap: QUOTE_PRECISION_I64,
                last_oracle_price_twap_5min: QUOTE_PRECISION_I64,
                ..HistoricalOracleData::default()
            },
            ..SpotMarket::default()
        };
        create_anchor_account_info!(usdc_market, SpotMarket, usdc_spot_market_account_info);
        let mut sol_market = SpotMarket {
            market_index: 1,
            oracle_source: OracleSource::Pyth,
            oracle: sol_oracle_price_key,
            cumulative_deposit_interest: SPOT_CUMULATIVE_INTEREST_PRECISION,
            cumulative_borrow_interest: SPOT_CUMULATIVE_INTEREST_PRECISION,
            decimals: 6,
            initial_asset_weight: 8 * SPOT_WEIGHT_PRECISION / 10,
            maintenance_asset_weight: 9 * SPOT_WEIGHT_PRECISION / 10,
            initial_liability_weight: 12 * SPOT_WEIGHT_PRECISION / 10,
            maintenance_liability_weight: 11 * SPOT_WEIGHT_PRECISION / 10,
            deposit_balance: SPOT_BALANCE_PRECISION,
            borrow_balance: 0,
            liquidator_fee: LIQUIDATION_FEE_PRECISION / 1000,
            historical_oracle_data: HistoricalOracleData {
                last_oracle_price_twap: (sol_oracle_price.agg.price * 99 / 100),
                last_oracle_price_twap_5min: (sol_oracle_price.agg.price * 99 / 100),
                ..HistoricalOracleData::default()
            },
            ..SpotMarket::default()
        };
        create_anchor_account_info!(sol_market, SpotMarket, sol_spot_market_account_info);
        let spot_market_account_infos = Vec::from([
            &usdc_spot_market_account_info,
            &sol_spot_market_account_info,
        ]);
        let spot_market_map =
            SpotMarketMap::load_multiple(spot_market_account_infos, true).unwrap();

        let mut spot_positions = [SpotPosition::default(); 8];
        spot_positions[0] = SpotPosition {
            market_index: 1,
            balance_type: SpotBalanceType::Deposit,
            scaled_balance: SPOT_BALANCE_PRECISION_U64,
            ..SpotPosition::default()
        };
        let mut user = User {
            orders: [Order::default(); 32],
            perp_positions: get_positions(PerpPosition {
                market_index: 0,
                quote_asset_amount: -100 * QUOTE_PRECISION_I64,
                ..PerpPosition::default()
            }),
            spot_positions,
            ..User::default()
        };

        let mut liquidator = User {
            spot_positions: get_spot_positions(SpotPosition {
                market_index: 0,
                balance_type: SpotBalanceType::Deposit,
                scaled_balance: 100 * SPOT_BALANCE_PRECISION_U64,
                ..SpotPosition::default()
            }),
            ..User::default()
        };

        let user_key = Pubkey::default();
        let liquidator_key = Pubkey::default();

        liquidate_perp_pnl_for_deposit(
            0,
            1,
            50 * 10_u128.pow(6), // .8
            None,
            &mut user,
            &user_key,
            &mut liquidator,
            &liquidator_key,
            &market_map,
            &spot_market_map,
            &mut oracle_map,
            now,
            slot,
            10,
            PERCENTAGE_PRECISION,
            150,
        )
        .unwrap();

        assert_eq!(user.spot_positions[0].scaled_balance, 494445000);
        assert_eq!(user.perp_positions[0].quote_asset_amount, -50000000);

        assert_eq!(
            liquidator.spot_positions[1].balance_type,
            SpotBalanceType::Deposit
        );
        assert_eq!(liquidator.spot_positions[1].scaled_balance, 505555000);
        assert_eq!(liquidator.perp_positions[0].quote_asset_amount, -50000000);
    }

    #[test]
    pub fn successful_liquidation_pnl_transfer_to_cover_margin_shortage() {
        let now = 0_i64;
        let slot = 0_u64;

        let mut sol_oracle_price = get_pyth_price(100, 6);
        let sol_oracle_price_key =
            Pubkey::from_str("J83w4HKfqxwcq3BEMMkPFSppX3gqekLyLJBexebFVkix").unwrap();
        let pyth_program = crate::ids::pyth_program::id();
        create_account_info!(
            sol_oracle_price,
            &sol_oracle_price_key,
            &pyth_program,
            oracle_account_info
        );
        let mut oracle_map = OracleMap::load_one(&oracle_account_info, slot, None).unwrap();

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
                max_fill_reserve_fraction: 100,
                order_step_size: 10000000,
                quote_asset_amount: 150 * QUOTE_PRECISION_I128,
                base_asset_amount_with_amm: BASE_PRECISION_I128,
                oracle: sol_oracle_price_key,
                ..AMM::default()
            },
            margin_ratio_initial: 1000,
            margin_ratio_maintenance: 500,
            unrealized_pnl_initial_asset_weight: 9000,
            unrealized_pnl_maintenance_asset_weight: 10000,
            number_of_users_with_base: 1,
            status: MarketStatus::Initialized,
            liquidator_fee: LIQUIDATION_FEE_PRECISION / 100,
            if_liquidation_fee: LIQUIDATION_FEE_PRECISION / 100,
            ..PerpMarket::default()
        };
        create_anchor_account_info!(market, PerpMarket, market_account_info);
        let market_map = PerpMarketMap::load_one(&market_account_info, true).unwrap();

        let mut usdc_market = SpotMarket {
            market_index: 0,
            oracle_source: OracleSource::QuoteAsset,
            cumulative_deposit_interest: SPOT_CUMULATIVE_INTEREST_PRECISION,
            decimals: 6,
            initial_asset_weight: SPOT_WEIGHT_PRECISION,
            maintenance_asset_weight: SPOT_WEIGHT_PRECISION,
            deposit_balance: 200 * SPOT_BALANCE_PRECISION,
            liquidator_fee: 0,
            historical_oracle_data: HistoricalOracleData {
                last_oracle_price_twap: QUOTE_PRECISION_I64,
                last_oracle_price_twap_5min: QUOTE_PRECISION_I64,
                ..HistoricalOracleData::default()
            },
            ..SpotMarket::default()
        };
        create_anchor_account_info!(usdc_market, SpotMarket, usdc_spot_market_account_info);
        let mut sol_market = SpotMarket {
            market_index: 1,
            oracle_source: OracleSource::Pyth,
            oracle: sol_oracle_price_key,
            cumulative_deposit_interest: SPOT_CUMULATIVE_INTEREST_PRECISION,
            cumulative_borrow_interest: SPOT_CUMULATIVE_INTEREST_PRECISION,
            decimals: 6,
            initial_asset_weight: 8 * SPOT_WEIGHT_PRECISION / 10,
            maintenance_asset_weight: 9 * SPOT_WEIGHT_PRECISION / 10,
            initial_liability_weight: 12 * SPOT_WEIGHT_PRECISION / 10,
            maintenance_liability_weight: 11 * SPOT_WEIGHT_PRECISION / 10,
            deposit_balance: SPOT_BALANCE_PRECISION,
            borrow_balance: 0,
            liquidator_fee: LIQUIDATION_FEE_PRECISION / 1000,
            historical_oracle_data: HistoricalOracleData {
                last_oracle_price_twap: (sol_oracle_price.agg.price * 99 / 100),
                last_oracle_price_twap_5min: (sol_oracle_price.agg.price * 99 / 100),
                ..HistoricalOracleData::default()
            },
            ..SpotMarket::default()
        };
        create_anchor_account_info!(sol_market, SpotMarket, sol_spot_market_account_info);
        let spot_market_account_infos = Vec::from([
            &usdc_spot_market_account_info,
            &sol_spot_market_account_info,
        ]);
        let spot_market_map =
            SpotMarketMap::load_multiple(spot_market_account_infos, true).unwrap();

        let mut spot_positions = [SpotPosition::default(); 8];
        spot_positions[0] = SpotPosition {
            market_index: 1,
            balance_type: SpotBalanceType::Deposit,
            scaled_balance: SPOT_BALANCE_PRECISION_U64,
            ..SpotPosition::default()
        };
        let mut user = User {
            orders: [Order::default(); 32],
            perp_positions: get_positions(PerpPosition {
                market_index: 0,
                quote_asset_amount: -91 * QUOTE_PRECISION_I64,
                ..PerpPosition::default()
            }),
            spot_positions,
            ..User::default()
        };

        let mut liquidator = User {
            spot_positions: get_spot_positions(SpotPosition {
                market_index: 0,
                balance_type: SpotBalanceType::Deposit,
                scaled_balance: 100 * SPOT_BALANCE_PRECISION_U64,
                ..SpotPosition::default()
            }),
            ..User::default()
        };

        let user_key = Pubkey::default();
        let liquidator_key = Pubkey::default();

        liquidate_perp_pnl_for_deposit(
            0,
            1,
            200 * 10_u128.pow(6), // .8
            None,
            &mut user,
            &user_key,
            &mut liquidator,
            &liquidator_key,
            &market_map,
            &spot_market_map,
            &mut oracle_map,
            now,
            slot,
            MARGIN_PRECISION / 50,
            PERCENTAGE_PRECISION,
            150,
        )
        .unwrap();

        assert_eq!(user.spot_positions[0].scaled_balance, 887655000);
        assert_eq!(user.perp_positions[0].quote_asset_amount, -79888889);

        assert_eq!(
            liquidator.spot_positions[1].balance_type,
            SpotBalanceType::Deposit
        );
        assert_eq!(liquidator.spot_positions[1].scaled_balance, 112345000);
        assert_eq!(liquidator.perp_positions[0].quote_asset_amount, -11111111);

        let market_after = market_map.get_ref(&0).unwrap();
        assert_eq!(market_after.amm.total_liquidation_fee, 0);
    }

    #[test]
    pub fn successful_liquidation_pnl_transfer_implied_by_asset_amount() {
        let now = 0_i64;
        let slot = 0_u64;

        let mut sol_oracle_price = get_pyth_price(100, 6);
        let sol_oracle_price_key =
            Pubkey::from_str("J83w4HKfqxwcq3BEMMkPFSppX3gqekLyLJBexebFVkix").unwrap();
        let pyth_program = crate::ids::pyth_program::id();
        create_account_info!(
            sol_oracle_price,
            &sol_oracle_price_key,
            &pyth_program,
            oracle_account_info
        );
        let mut oracle_map = OracleMap::load_one(&oracle_account_info, slot, None).unwrap();

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
                max_fill_reserve_fraction: 100,
                order_step_size: 10000000,
                quote_asset_amount: 150 * QUOTE_PRECISION_I128,
                base_asset_amount_with_amm: BASE_PRECISION_I128,
                oracle: sol_oracle_price_key,
                ..AMM::default()
            },
            margin_ratio_initial: 1000,
            margin_ratio_maintenance: 500,
            unrealized_pnl_initial_asset_weight: 9000,
            unrealized_pnl_maintenance_asset_weight: 10000,
            number_of_users_with_base: 1,
            status: MarketStatus::Initialized,
            liquidator_fee: LIQUIDATION_FEE_PRECISION / 100,
            ..PerpMarket::default()
        };
        create_anchor_account_info!(market, PerpMarket, market_account_info);
        let market_map = PerpMarketMap::load_one(&market_account_info, true).unwrap();

        let mut usdc_market = SpotMarket {
            market_index: 0,
            oracle_source: OracleSource::QuoteAsset,
            cumulative_deposit_interest: SPOT_CUMULATIVE_INTEREST_PRECISION,
            decimals: 6,
            initial_asset_weight: SPOT_WEIGHT_PRECISION,
            maintenance_asset_weight: SPOT_WEIGHT_PRECISION,
            deposit_balance: 200 * SPOT_BALANCE_PRECISION,
            liquidator_fee: 0,
            historical_oracle_data: HistoricalOracleData {
                last_oracle_price_twap: QUOTE_PRECISION_I64,
                last_oracle_price_twap_5min: QUOTE_PRECISION_I64,
                ..HistoricalOracleData::default()
            },
            ..SpotMarket::default()
        };
        create_anchor_account_info!(usdc_market, SpotMarket, usdc_spot_market_account_info);
        let mut sol_market = SpotMarket {
            market_index: 1,
            oracle_source: OracleSource::Pyth,
            oracle: sol_oracle_price_key,
            cumulative_deposit_interest: SPOT_CUMULATIVE_INTEREST_PRECISION,
            cumulative_borrow_interest: SPOT_CUMULATIVE_INTEREST_PRECISION,
            decimals: 6,
            initial_asset_weight: 8 * SPOT_WEIGHT_PRECISION / 10,
            maintenance_asset_weight: 9 * SPOT_WEIGHT_PRECISION / 10,
            initial_liability_weight: 12 * SPOT_WEIGHT_PRECISION / 10,
            maintenance_liability_weight: 11 * SPOT_WEIGHT_PRECISION / 10,
            deposit_balance: SPOT_BALANCE_PRECISION,
            borrow_balance: 0,
            liquidator_fee: LIQUIDATION_FEE_PRECISION / 1000,
            historical_oracle_data: HistoricalOracleData {
                last_oracle_price_twap: (sol_oracle_price.agg.price * 99 / 100),
                last_oracle_price_twap_5min: (sol_oracle_price.agg.price * 99 / 100),
                ..HistoricalOracleData::default()
            },
            ..SpotMarket::default()
        };
        create_anchor_account_info!(sol_market, SpotMarket, sol_spot_market_account_info);
        let spot_market_account_infos = Vec::from([
            &usdc_spot_market_account_info,
            &sol_spot_market_account_info,
        ]);
        let spot_market_map =
            SpotMarketMap::load_multiple(spot_market_account_infos, true).unwrap();

        let mut spot_positions = [SpotPosition::default(); 8];
        spot_positions[0] = SpotPosition {
            market_index: 1,
            balance_type: SpotBalanceType::Deposit,
            scaled_balance: SPOT_BALANCE_PRECISION_U64,
            ..SpotPosition::default()
        };
        let mut user = User {
            orders: [Order::default(); 32],
            perp_positions: get_positions(PerpPosition {
                market_index: 0,
                quote_asset_amount: -150 * QUOTE_PRECISION_I64,
                ..PerpPosition::default()
            }),
            spot_positions,
            ..User::default()
        };

        let mut liquidator = User {
            spot_positions: get_spot_positions(SpotPosition {
                market_index: 0,
                balance_type: SpotBalanceType::Deposit,
                scaled_balance: 100 * SPOT_BALANCE_PRECISION_U64,
                ..SpotPosition::default()
            }),
            ..User::default()
        };

        let user_key = Pubkey::default();
        let liquidator_key = Pubkey::default();

        liquidate_perp_pnl_for_deposit(
            0,
            1,
            200 * 10_u128.pow(6), // .8
            None,
            &mut user,
            &user_key,
            &mut liquidator,
            &liquidator_key,
            &market_map,
            &spot_market_map,
            &mut oracle_map,
            now,
            slot,
            10,
            PERCENTAGE_PRECISION,
            150,
        )
        .unwrap();

        assert_eq!(user.spot_positions[0].scaled_balance, 0);
        assert_eq!(user.perp_positions[0].quote_asset_amount, -51098901);

        assert_eq!(
            liquidator.spot_positions[1].balance_type,
            SpotBalanceType::Deposit
        );
        assert_eq!(liquidator.spot_positions[1].scaled_balance, 1000000000);
        assert_eq!(liquidator.perp_positions[0].quote_asset_amount, -98901099);
    }

    #[test]
    pub fn failure_due_to_limit_price() {
        let now = 0_i64;
        let slot = 0_u64;

        let mut sol_oracle_price = get_pyth_price(100, 6);
        let sol_oracle_price_key =
            Pubkey::from_str("J83w4HKfqxwcq3BEMMkPFSppX3gqekLyLJBexebFVkix").unwrap();
        let pyth_program = crate::ids::pyth_program::id();
        create_account_info!(
            sol_oracle_price,
            &sol_oracle_price_key,
            &pyth_program,
            oracle_account_info
        );
        let mut oracle_map = OracleMap::load_one(&oracle_account_info, slot, None).unwrap();

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
                max_fill_reserve_fraction: 100,
                order_step_size: 10000000,
                quote_asset_amount: 150 * QUOTE_PRECISION_I128,
                base_asset_amount_with_amm: BASE_PRECISION_I128,
                oracle: sol_oracle_price_key,
                ..AMM::default()
            },
            margin_ratio_initial: 1000,
            margin_ratio_maintenance: 500,
            unrealized_pnl_initial_asset_weight: 9000,
            unrealized_pnl_maintenance_asset_weight: 10000,
            number_of_users_with_base: 1,
            status: MarketStatus::Initialized,
            liquidator_fee: LIQUIDATION_FEE_PRECISION / 100,
            ..PerpMarket::default()
        };
        create_anchor_account_info!(market, PerpMarket, market_account_info);
        let market_map = PerpMarketMap::load_one(&market_account_info, true).unwrap();

        let mut usdc_market = SpotMarket {
            market_index: 0,
            oracle_source: OracleSource::QuoteAsset,
            cumulative_deposit_interest: SPOT_CUMULATIVE_INTEREST_PRECISION,
            decimals: 6,
            initial_asset_weight: SPOT_WEIGHT_PRECISION,
            maintenance_asset_weight: SPOT_WEIGHT_PRECISION,
            deposit_balance: 200 * SPOT_BALANCE_PRECISION,
            liquidator_fee: 0,
            historical_oracle_data: HistoricalOracleData {
                last_oracle_price_twap: QUOTE_PRECISION_I64,
                last_oracle_price_twap_5min: QUOTE_PRECISION_I64,
                ..HistoricalOracleData::default()
            },
            ..SpotMarket::default()
        };
        create_anchor_account_info!(usdc_market, SpotMarket, usdc_spot_market_account_info);
        let mut sol_market = SpotMarket {
            market_index: 1,
            oracle_source: OracleSource::Pyth,
            oracle: sol_oracle_price_key,
            cumulative_deposit_interest: SPOT_CUMULATIVE_INTEREST_PRECISION,
            cumulative_borrow_interest: SPOT_CUMULATIVE_INTEREST_PRECISION,
            decimals: 6,
            initial_asset_weight: 8 * SPOT_WEIGHT_PRECISION / 10,
            maintenance_asset_weight: 9 * SPOT_WEIGHT_PRECISION / 10,
            initial_liability_weight: 12 * SPOT_WEIGHT_PRECISION / 10,
            maintenance_liability_weight: 11 * SPOT_WEIGHT_PRECISION / 10,
            deposit_balance: SPOT_BALANCE_PRECISION,
            borrow_balance: 0,
            liquidator_fee: LIQUIDATION_FEE_PRECISION / 1000,
            historical_oracle_data: HistoricalOracleData {
                last_oracle_price_twap: (sol_oracle_price.agg.price * 99 / 100),
                last_oracle_price_twap_5min: (sol_oracle_price.agg.price * 99 / 100),
                ..HistoricalOracleData::default()
            },
            ..SpotMarket::default()
        };
        create_anchor_account_info!(sol_market, SpotMarket, sol_spot_market_account_info);
        let spot_market_account_infos = Vec::from([
            &usdc_spot_market_account_info,
            &sol_spot_market_account_info,
        ]);
        let spot_market_map =
            SpotMarketMap::load_multiple(spot_market_account_infos, true).unwrap();

        let mut spot_positions = [SpotPosition::default(); 8];
        spot_positions[0] = SpotPosition {
            market_index: 1,
            balance_type: SpotBalanceType::Deposit,
            scaled_balance: SPOT_BALANCE_PRECISION_U64,
            ..SpotPosition::default()
        };
        let mut user = User {
            orders: [Order::default(); 32],
            perp_positions: get_positions(PerpPosition {
                market_index: 0,
                quote_asset_amount: -100 * QUOTE_PRECISION_I64,
                ..PerpPosition::default()
            }),
            spot_positions,
            ..User::default()
        };

        let mut liquidator = User {
            spot_positions: get_spot_positions(SpotPosition {
                market_index: 0,
                balance_type: SpotBalanceType::Deposit,
                scaled_balance: 100 * SPOT_BALANCE_PRECISION_U64,
                ..SpotPosition::default()
            }),
            ..User::default()
        };

        let user_key = Pubkey::default();
        let liquidator_key = Pubkey::default();

        let limit_price = 505555 * PRICE_PRECISION_U64 / 50000000 + 1;
        let result = liquidate_perp_pnl_for_deposit(
            0,
            1,
            50 * 10_u128.pow(6), // .8
            Some(limit_price),
            &mut user,
            &user_key,
            &mut liquidator,
            &liquidator_key,
            &market_map,
            &spot_market_map,
            &mut oracle_map,
            now,
            slot,
            10,
            PERCENTAGE_PRECISION,
            150,
        );

        assert_eq!(result, Err(ErrorCode::LiquidationDoesntSatisfyLimitPrice));
    }

    #[test]
    pub fn success_with_limit_price() {
        let now = 0_i64;
        let slot = 0_u64;

        let mut sol_oracle_price = get_pyth_price(100, 6);
        let sol_oracle_price_key =
            Pubkey::from_str("J83w4HKfqxwcq3BEMMkPFSppX3gqekLyLJBexebFVkix").unwrap();
        let pyth_program = crate::ids::pyth_program::id();
        create_account_info!(
            sol_oracle_price,
            &sol_oracle_price_key,
            &pyth_program,
            oracle_account_info
        );
        let mut oracle_map = OracleMap::load_one(&oracle_account_info, slot, None).unwrap();

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
                max_fill_reserve_fraction: 100,
                order_step_size: 10000000,
                quote_asset_amount: 150 * QUOTE_PRECISION_I128,
                base_asset_amount_with_amm: BASE_PRECISION_I128,
                oracle: sol_oracle_price_key,
                ..AMM::default()
            },
            margin_ratio_initial: 1000,
            margin_ratio_maintenance: 500,
            unrealized_pnl_initial_asset_weight: 9000,
            unrealized_pnl_maintenance_asset_weight: 10000,
            number_of_users_with_base: 1,
            status: MarketStatus::Initialized,
            liquidator_fee: LIQUIDATION_FEE_PRECISION / 100,
            ..PerpMarket::default()
        };
        create_anchor_account_info!(market, PerpMarket, market_account_info);
        let market_map = PerpMarketMap::load_one(&market_account_info, true).unwrap();

        let mut usdc_market = SpotMarket {
            market_index: 0,
            oracle_source: OracleSource::QuoteAsset,
            cumulative_deposit_interest: SPOT_CUMULATIVE_INTEREST_PRECISION,
            decimals: 6,
            initial_asset_weight: SPOT_WEIGHT_PRECISION,
            maintenance_asset_weight: SPOT_WEIGHT_PRECISION,
            deposit_balance: 200 * SPOT_BALANCE_PRECISION,
            liquidator_fee: 0,
            historical_oracle_data: HistoricalOracleData {
                last_oracle_price_twap: QUOTE_PRECISION_I64,
                last_oracle_price_twap_5min: QUOTE_PRECISION_I64,
                ..HistoricalOracleData::default()
            },
            ..SpotMarket::default()
        };
        create_anchor_account_info!(usdc_market, SpotMarket, usdc_spot_market_account_info);
        let mut sol_market = SpotMarket {
            market_index: 1,
            oracle_source: OracleSource::Pyth,
            oracle: sol_oracle_price_key,
            cumulative_deposit_interest: SPOT_CUMULATIVE_INTEREST_PRECISION,
            cumulative_borrow_interest: SPOT_CUMULATIVE_INTEREST_PRECISION,
            decimals: 6,
            initial_asset_weight: 8 * SPOT_WEIGHT_PRECISION / 10,
            maintenance_asset_weight: 9 * SPOT_WEIGHT_PRECISION / 10,
            initial_liability_weight: 12 * SPOT_WEIGHT_PRECISION / 10,
            maintenance_liability_weight: 11 * SPOT_WEIGHT_PRECISION / 10,
            deposit_balance: SPOT_BALANCE_PRECISION,
            borrow_balance: 0,
            liquidator_fee: LIQUIDATION_FEE_PRECISION / 1000,
            historical_oracle_data: HistoricalOracleData {
                last_oracle_price_twap: (sol_oracle_price.agg.price * 99 / 100),
                last_oracle_price_twap_5min: (sol_oracle_price.agg.price * 99 / 100),
                ..HistoricalOracleData::default()
            },
            ..SpotMarket::default()
        };
        create_anchor_account_info!(sol_market, SpotMarket, sol_spot_market_account_info);
        let spot_market_account_infos = Vec::from([
            &usdc_spot_market_account_info,
            &sol_spot_market_account_info,
        ]);
        let spot_market_map =
            SpotMarketMap::load_multiple(spot_market_account_infos, true).unwrap();

        let mut spot_positions = [SpotPosition::default(); 8];
        spot_positions[0] = SpotPosition {
            market_index: 1,
            balance_type: SpotBalanceType::Deposit,
            scaled_balance: SPOT_BALANCE_PRECISION_U64,
            ..SpotPosition::default()
        };
        let mut user = User {
            orders: [Order::default(); 32],
            perp_positions: get_positions(PerpPosition {
                market_index: 0,
                quote_asset_amount: -100 * QUOTE_PRECISION_I64,
                ..PerpPosition::default()
            }),
            spot_positions,
            ..User::default()
        };

        let mut liquidator = User {
            spot_positions: get_spot_positions(SpotPosition {
                market_index: 0,
                balance_type: SpotBalanceType::Deposit,
                scaled_balance: 100 * SPOT_BALANCE_PRECISION_U64,
                ..SpotPosition::default()
            }),
            ..User::default()
        };

        let user_key = Pubkey::default();
        let liquidator_key = Pubkey::default();

        let limit_price = 505555 * PRICE_PRECISION_U64 / 50000000 - 1;
        let result = liquidate_perp_pnl_for_deposit(
            0,
            1,
            50 * 10_u128.pow(6), // .8
            Some(limit_price),
            &mut user,
            &user_key,
            &mut liquidator,
            &liquidator_key,
            &market_map,
            &spot_market_map,
            &mut oracle_map,
            now,
            slot,
            10,
            PERCENTAGE_PRECISION,
            150,
        );

        assert_eq!(result, Ok(()));
    }

    #[test]
    pub fn successful_liquidate_dust_position() {
        let now = 0_i64;
        let slot = 0_u64;

        let mut sol_oracle_price = get_pyth_price(100, 6);
        let sol_oracle_price_key =
            Pubkey::from_str("J83w4HKfqxwcq3BEMMkPFSppX3gqekLyLJBexebFVkix").unwrap();
        let pyth_program = crate::ids::pyth_program::id();
        create_account_info!(
            sol_oracle_price,
            &sol_oracle_price_key,
            &pyth_program,
            oracle_account_info
        );
        let mut oracle_map = OracleMap::load_one(&oracle_account_info, slot, None).unwrap();

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
                max_fill_reserve_fraction: 100,
                order_step_size: 10000000,
                quote_asset_amount: 150 * QUOTE_PRECISION_I128,
                base_asset_amount_with_amm: BASE_PRECISION_I128,
                oracle: sol_oracle_price_key,
                ..AMM::default()
            },
            margin_ratio_initial: 1000,
            margin_ratio_maintenance: 500,
            unrealized_pnl_initial_asset_weight: 9000,
            unrealized_pnl_maintenance_asset_weight: 10000,
            number_of_users_with_base: 1,
            status: MarketStatus::Initialized,
            liquidator_fee: LIQUIDATION_FEE_PRECISION / 100,
            if_liquidation_fee: LIQUIDATION_FEE_PRECISION / 100,
            ..PerpMarket::default()
        };
        create_anchor_account_info!(market, PerpMarket, market_account_info);
        let market_map = PerpMarketMap::load_one(&market_account_info, true).unwrap();

        let mut usdc_market = SpotMarket {
            market_index: 0,
            oracle_source: OracleSource::QuoteAsset,
            cumulative_deposit_interest: SPOT_CUMULATIVE_INTEREST_PRECISION,
            decimals: 6,
            initial_asset_weight: SPOT_WEIGHT_PRECISION,
            maintenance_asset_weight: SPOT_WEIGHT_PRECISION,
            deposit_balance: 200 * SPOT_BALANCE_PRECISION,
            liquidator_fee: 0,
            historical_oracle_data: HistoricalOracleData {
                last_oracle_price_twap: QUOTE_PRECISION_I64,
                last_oracle_price_twap_5min: QUOTE_PRECISION_I64,
                ..HistoricalOracleData::default()
            },
            ..SpotMarket::default()
        };
        create_anchor_account_info!(usdc_market, SpotMarket, usdc_spot_market_account_info);
        let mut sol_market = SpotMarket {
            market_index: 1,
            oracle_source: OracleSource::Pyth,
            oracle: sol_oracle_price_key,
            cumulative_deposit_interest: SPOT_CUMULATIVE_INTEREST_PRECISION,
            cumulative_borrow_interest: SPOT_CUMULATIVE_INTEREST_PRECISION,
            decimals: 6,
            initial_asset_weight: 8 * SPOT_WEIGHT_PRECISION / 10,
            maintenance_asset_weight: 9 * SPOT_WEIGHT_PRECISION / 10,
            initial_liability_weight: 12 * SPOT_WEIGHT_PRECISION / 10,
            maintenance_liability_weight: 11 * SPOT_WEIGHT_PRECISION / 10,
            deposit_balance: SPOT_BALANCE_PRECISION,
            borrow_balance: 0,
            liquidator_fee: LIQUIDATION_FEE_PRECISION / 1000,
            historical_oracle_data: HistoricalOracleData {
                last_oracle_price_twap: (sol_oracle_price.agg.price * 99 / 100),
                last_oracle_price_twap_5min: (sol_oracle_price.agg.price * 99 / 100),
                ..HistoricalOracleData::default()
            },
            ..SpotMarket::default()
        };
        create_anchor_account_info!(sol_market, SpotMarket, sol_spot_market_account_info);
        let spot_market_account_infos = Vec::from([
            &usdc_spot_market_account_info,
            &sol_spot_market_account_info,
        ]);
        let spot_market_map =
            SpotMarketMap::load_multiple(spot_market_account_infos, true).unwrap();

        let mut spot_positions = [SpotPosition::default(); 8];
        spot_positions[0] = SpotPosition {
            market_index: 1,
            balance_type: SpotBalanceType::Deposit,
            scaled_balance: SPOT_BALANCE_PRECISION_U64 / 50,
            ..SpotPosition::default()
        };
        let mut user = User {
            orders: [Order::default(); 32],
            perp_positions: get_positions(PerpPosition {
                market_index: 0,
                quote_asset_amount: -91 * QUOTE_PRECISION_I64 / 50,
                ..PerpPosition::default()
            }),
            spot_positions,
            ..User::default()
        };

        let mut liquidator = User {
            spot_positions: get_spot_positions(SpotPosition {
                market_index: 0,
                balance_type: SpotBalanceType::Deposit,
                scaled_balance: 100 * SPOT_BALANCE_PRECISION_U64,
                ..SpotPosition::default()
            }),
            ..User::default()
        };

        let user_key = Pubkey::default();
        let liquidator_key = Pubkey::default();

        liquidate_perp_pnl_for_deposit(
            0,
            1,
            200 * 10_u128.pow(6), // .8
            None,
            &mut user,
            &user_key,
            &mut liquidator,
            &liquidator_key,
            &market_map,
            &spot_market_map,
            &mut oracle_map,
            now,
            slot,
            MARGIN_PRECISION / 50,
            PERCENTAGE_PRECISION,
            150,
        )
        .unwrap();

        assert_eq!(user.spot_positions[0].scaled_balance, 0);
        assert_eq!(user.perp_positions[0].quote_asset_amount, 0);

        assert_eq!(
            liquidator.spot_positions[1].balance_type,
            SpotBalanceType::Deposit
        );
        assert_eq!(liquidator.spot_positions[1].scaled_balance, 20000000);
        assert_eq!(liquidator.perp_positions[0].quote_asset_amount, -1820000); // -$1
    }

    #[test]
    pub fn successful_liquidation_over_multiple_slots() {
        let now = 1_i64;
        let slot = 1_u64;

        let mut sol_oracle_price = get_pyth_price(100, 6);
        let sol_oracle_price_key =
            Pubkey::from_str("J83w4HKfqxwcq3BEMMkPFSppX3gqekLyLJBexebFVkix").unwrap();
        let pyth_program = crate::ids::pyth_program::id();
        create_account_info!(
            sol_oracle_price,
            &sol_oracle_price_key,
            &pyth_program,
            oracle_account_info
        );
        let mut oracle_map = OracleMap::load_one(&oracle_account_info, slot, None).unwrap();

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
                max_fill_reserve_fraction: 100,
                order_step_size: 10000000,
                quote_asset_amount: 150 * QUOTE_PRECISION_I128,
                base_asset_amount_with_amm: BASE_PRECISION_I128,
                oracle: sol_oracle_price_key,
                ..AMM::default()
            },
            margin_ratio_initial: 1000,
            margin_ratio_maintenance: 500,
            unrealized_pnl_initial_asset_weight: 9000,
            unrealized_pnl_maintenance_asset_weight: 10000,
            number_of_users_with_base: 1,
            status: MarketStatus::Initialized,
            liquidator_fee: LIQUIDATION_FEE_PRECISION / 100,
            if_liquidation_fee: LIQUIDATION_FEE_PRECISION / 100,
            ..PerpMarket::default()
        };
        create_anchor_account_info!(market, PerpMarket, market_account_info);
        let market_map = PerpMarketMap::load_one(&market_account_info, true).unwrap();

        let mut usdc_market = SpotMarket {
            market_index: 0,
            oracle_source: OracleSource::QuoteAsset,
            cumulative_deposit_interest: SPOT_CUMULATIVE_INTEREST_PRECISION,
            decimals: 6,
            initial_asset_weight: SPOT_WEIGHT_PRECISION,
            maintenance_asset_weight: SPOT_WEIGHT_PRECISION,
            deposit_balance: 200 * SPOT_BALANCE_PRECISION,
            liquidator_fee: 0,
            historical_oracle_data: HistoricalOracleData {
                last_oracle_price_twap: QUOTE_PRECISION_I64,
                last_oracle_price_twap_5min: QUOTE_PRECISION_I64,
                ..HistoricalOracleData::default()
            },
            ..SpotMarket::default()
        };
        create_anchor_account_info!(usdc_market, SpotMarket, usdc_spot_market_account_info);
        let mut sol_market = SpotMarket {
            market_index: 1,
            oracle_source: OracleSource::Pyth,
            oracle: sol_oracle_price_key,
            cumulative_deposit_interest: SPOT_CUMULATIVE_INTEREST_PRECISION,
            cumulative_borrow_interest: SPOT_CUMULATIVE_INTEREST_PRECISION,
            decimals: 6,
            initial_asset_weight: 8 * SPOT_WEIGHT_PRECISION / 10,
            maintenance_asset_weight: 9 * SPOT_WEIGHT_PRECISION / 10,
            initial_liability_weight: 12 * SPOT_WEIGHT_PRECISION / 10,
            maintenance_liability_weight: 11 * SPOT_WEIGHT_PRECISION / 10,
            deposit_balance: SPOT_BALANCE_PRECISION,
            borrow_balance: 0,
            liquidator_fee: LIQUIDATION_FEE_PRECISION / 1000,
            historical_oracle_data: HistoricalOracleData {
                last_oracle_price_twap: (sol_oracle_price.agg.price * 99 / 100),
                last_oracle_price_twap_5min: (sol_oracle_price.agg.price * 99 / 100),
                ..HistoricalOracleData::default()
            },
            ..SpotMarket::default()
        };
        create_anchor_account_info!(sol_market, SpotMarket, sol_spot_market_account_info);
        let spot_market_account_infos = Vec::from([
            &usdc_spot_market_account_info,
            &sol_spot_market_account_info,
        ]);
        let spot_market_map =
            SpotMarketMap::load_multiple(spot_market_account_infos, true).unwrap();

        let mut spot_positions = [SpotPosition::default(); 8];
        spot_positions[0] = SpotPosition {
            market_index: 1,
            balance_type: SpotBalanceType::Deposit,
            scaled_balance: 10 * SPOT_BALANCE_PRECISION_U64,
            ..SpotPosition::default()
        };
        let mut user = User {
            orders: [Order::default(); 32],
            perp_positions: get_positions(PerpPosition {
                market_index: 0,
                quote_asset_amount: -950 * QUOTE_PRECISION_I64,
                ..PerpPosition::default()
            }),
            spot_positions,
            ..User::default()
        };

        let mut liquidator = User {
            spot_positions: get_spot_positions(SpotPosition {
                market_index: 0,
                balance_type: SpotBalanceType::Deposit,
                scaled_balance: 1000 * SPOT_BALANCE_PRECISION_U64,
                ..SpotPosition::default()
            }),
            ..User::default()
        };

        let user_key = Pubkey::default();
        let liquidator_key = Pubkey::default();

        let liquidation_buffer = MARGIN_PRECISION / 50;
        liquidate_perp_pnl_for_deposit(
            0,
            1,
            200 * 10_u128.pow(6), // .8
            None,
            &mut user,
            &user_key,
            &mut liquidator,
            &liquidator_key,
            &market_map,
            &spot_market_map,
            &mut oracle_map,
            now,
            slot,
            liquidation_buffer,
            LIQUIDATION_PCT_PRECISION / 10,
            150,
        )
        .unwrap();

        assert_eq!(user.last_active_slot, 1);
        assert_eq!(user.liquidation_margin_freed, 5000035);
        assert_eq!(user.spot_positions[0].scaled_balance, 9438272000);
        assert_eq!(user.perp_positions[0].quote_asset_amount, -894444445);

        let MarginCalculation {
            total_collateral,
            margin_requirement_plus_buffer,
            ..
        } = calculate_margin_requirement_and_total_collateral_and_liability_info(
            &user,
            &market_map,
            &spot_market_map,
            &mut oracle_map,
            MarginContext::liquidation(liquidation_buffer),
        )
        .unwrap();

        let margin_shortage =
            ((margin_requirement_plus_buffer as i128) - total_collateral).unsigned_abs();

        let pct_margin_freed = (user.liquidation_margin_freed as u128) * PRICE_PRECISION
            / (margin_shortage + user.liquidation_margin_freed as u128);
        assert_eq!(pct_margin_freed, 100000); // ~10%

        let slot = 51_u64;
        liquidate_perp_pnl_for_deposit(
            0,
            1,
            200 * 10_u128.pow(6), // .8
            None,
            &mut user,
            &user_key,
            &mut liquidator,
            &liquidator_key,
            &market_map,
            &spot_market_map,
            &mut oracle_map,
            now,
            slot,
            liquidation_buffer,
            LIQUIDATION_PCT_PRECISION / 10,
            150,
        )
        .unwrap();

        assert_eq!(user.last_active_slot, 1);
        assert_eq!(user.liquidation_margin_freed, 23000055);
        assert_eq!(user.spot_positions[0].scaled_balance, 7416050000);
        assert_eq!(user.perp_positions[0].quote_asset_amount, -694444445);

        let MarginCalculation {
            total_collateral,
            margin_requirement_plus_buffer,
            ..
        } = calculate_margin_requirement_and_total_collateral_and_liability_info(
            &user,
            &market_map,
            &spot_market_map,
            &mut oracle_map,
            MarginContext::liquidation(liquidation_buffer),
        )
        .unwrap();

        let margin_shortage =
            ((margin_requirement_plus_buffer as i128) - total_collateral).unsigned_abs();

        let pct_margin_freed = (user.liquidation_margin_freed as u128) * PRICE_PRECISION
            / (margin_shortage + user.liquidation_margin_freed as u128);
        assert_eq!(pct_margin_freed, 460001); // ~43%

        let slot = 136_u64;
        liquidate_perp_pnl_for_deposit(
            0,
            1,
            2000 * 10_u128.pow(6), // .8
            None,
            &mut user,
            &user_key,
            &mut liquidator,
            &liquidator_key,
            &market_map,
            &spot_market_map,
            &mut oracle_map,
            now,
            slot,
            liquidation_buffer,
            LIQUIDATION_PCT_PRECISION / 10,
            150,
        )
        .unwrap();

        assert_eq!(user.last_active_slot, 1);
        assert_eq!(user.liquidation_margin_freed, 0);
    }

    #[test]
    pub fn failure_due_to_asset_tier_violation() {
        let now = 0_i64;
        let slot = 0_u64;
        let mut user_stats = UserStats::default();
        let mut liquidator_stats = UserStats::default();
        let mut sol_oracle_price = get_pyth_price(100, 6);
        let sol_oracle_price_key =
            Pubkey::from_str("J83w4HKfqxwcq3BEMMkPFSppX3gqekLyLJBexebFVkix").unwrap();
        let pyth_program = crate::ids::pyth_program::id();
        create_account_info!(
            sol_oracle_price,
            &sol_oracle_price_key,
            &pyth_program,
            oracle_account_info
        );
        let mut oracle_map = OracleMap::load_one(&oracle_account_info, slot, None).unwrap();

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
                max_fill_reserve_fraction: 100,
                order_step_size: 10000000,
                quote_asset_amount: 150 * QUOTE_PRECISION_I128,
                base_asset_amount_with_amm: BASE_PRECISION_I128,
                oracle: sol_oracle_price_key,
                ..AMM::default()
            },
            margin_ratio_initial: 1000,
            margin_ratio_maintenance: 500,
            unrealized_pnl_initial_asset_weight: 9000,
            unrealized_pnl_maintenance_asset_weight: 10000,
            number_of_users_with_base: 1,
            status: MarketStatus::Initialized,
            liquidator_fee: LIQUIDATION_FEE_PRECISION / 100,
            ..PerpMarket::default()
        };
        create_anchor_account_info!(market, PerpMarket, market_account_info);
        let market_map = PerpMarketMap::load_one(&market_account_info, true).unwrap();

        let mut usdc_market = SpotMarket {
            market_index: 0,
            oracle_source: OracleSource::QuoteAsset,
            cumulative_deposit_interest: SPOT_CUMULATIVE_INTEREST_PRECISION,
            decimals: 6,
            initial_asset_weight: SPOT_WEIGHT_PRECISION,
            maintenance_asset_weight: SPOT_WEIGHT_PRECISION,
            deposit_balance: 200 * SPOT_BALANCE_PRECISION,
            liquidator_fee: 0,
            asset_tier: AssetTier::Collateral,
            historical_oracle_data: HistoricalOracleData {
                last_oracle_price_twap: PRICE_PRECISION as i64,
                last_oracle_price_twap_5min: PRICE_PRECISION as i64,

                ..HistoricalOracleData::default()
            },
            ..SpotMarket::default()
        };
        create_anchor_account_info!(usdc_market, SpotMarket, usdc_spot_market_account_info);
        let mut sol_market = SpotMarket {
            market_index: 1,
            oracle_source: OracleSource::Pyth,
            oracle: sol_oracle_price_key,
            cumulative_deposit_interest: SPOT_CUMULATIVE_INTEREST_PRECISION,
            cumulative_borrow_interest: SPOT_CUMULATIVE_INTEREST_PRECISION,
            decimals: 6,
            initial_asset_weight: 8 * SPOT_WEIGHT_PRECISION / 10,
            maintenance_asset_weight: 9 * SPOT_WEIGHT_PRECISION / 10,
            initial_liability_weight: 12 * SPOT_WEIGHT_PRECISION / 10,
            maintenance_liability_weight: 11 * SPOT_WEIGHT_PRECISION / 10,
            deposit_balance: 10 * SPOT_BALANCE_PRECISION,
            borrow_balance: SPOT_BALANCE_PRECISION,
            liquidator_fee: LIQUIDATION_FEE_PRECISION / 1000,
            historical_oracle_data: HistoricalOracleData {
                last_oracle_price_twap: (sol_oracle_price.agg.price * 99 / 100),
                last_oracle_price_twap_5min: (sol_oracle_price.agg.price * 99 / 100),

                ..HistoricalOracleData::default()
            },
            asset_tier: AssetTier::Collateral,
            ..SpotMarket::default()
        };
        create_anchor_account_info!(sol_market, SpotMarket, sol_spot_market_account_info);
        let spot_market_account_infos = Vec::from([
            &usdc_spot_market_account_info,
            &sol_spot_market_account_info,
        ]);
        let spot_market_map =
            SpotMarketMap::load_multiple(spot_market_account_infos, true).unwrap();

        let mut spot_positions = [SpotPosition::default(); 8];
        spot_positions[0] = SpotPosition {
            market_index: 0,
            balance_type: SpotBalanceType::Deposit,
            scaled_balance: 200 * SPOT_BALANCE_PRECISION_U64,
            ..SpotPosition::default()
        };
        spot_positions[1] = SpotPosition {
            market_index: 1,
            balance_type: SpotBalanceType::Borrow,
            scaled_balance: SPOT_BALANCE_PRECISION_U64,
            ..SpotPosition::default()
        };
        let mut user = User {
            orders: [Order::default(); 32],
            perp_positions: get_positions(PerpPosition {
                market_index: 0,
                quote_asset_amount: -100 * QUOTE_PRECISION_I64,
                ..PerpPosition::default()
            }),
            spot_positions,
            ..User::default()
        };

        let mut liquidator = User {
            spot_positions: get_spot_positions(SpotPosition {
                market_index: 0,
                balance_type: SpotBalanceType::Deposit,
                scaled_balance: 2500 * SPOT_BALANCE_PRECISION_U64,
                ..SpotPosition::default()
            }),
            ..User::default()
        };

        let user_key = Pubkey::default();
        let liquidator_key = Pubkey::default();

        assert!(liquidate_perp_pnl_for_deposit(
            0,
            0,
            50 * 10_u128.pow(6), // .8
            None,
            &mut user,
            &user_key,
            &mut liquidator,
            &liquidator_key,
            &market_map,
            &spot_market_map,
            &mut oracle_map,
            now,
            slot,
            10,
            PERCENTAGE_PRECISION,
            150,
        )
        .is_err());

        let state = State {
            liquidation_margin_buffer_ratio: MARGIN_PRECISION / 50,
            initial_pct_to_liquidate: (PERCENTAGE_PRECISION / 10) as u16,
            liquidation_duration: 150,
            ..Default::default()
        };

        liquidate_spot(
            0,
            1,
            10_u128.pow(9),
            None,
            &mut user,
            &user_key,
            &mut user_stats,
            &mut liquidator,
            &liquidator_key,
            &mut liquidator_stats,
            &market_map,
            &spot_market_map,
            &mut oracle_map,
            now,
            slot,
            &state,
        )
        .unwrap();

        assert_eq!(user.spot_positions[1].scaled_balance, 0);

        liquidate_perp_pnl_for_deposit(
            0,
            0,
            50 * 10_u128.pow(6), // .8
            None,
            &mut user,
            &user_key,
            &mut liquidator,
            &liquidator_key,
            &market_map,
            &spot_market_map,
            &mut oracle_map,
            now,
            slot,
            10,
            PERCENTAGE_PRECISION,
            150,
        )
        .unwrap();
        assert_eq!(user.perp_positions[0].quote_asset_amount, -50000000);
        assert_eq!(user.spot_positions[0].scaled_balance, 49394850000); // <$50
        assert_eq!(user.status, UserStatus::BeingLiquidated as u8);

        liquidate_perp_pnl_for_deposit(
            0,
            0,
            50 * 10_u128.pow(6), // .8
            None,
            &mut user,
            &user_key,
            &mut liquidator,
            &liquidator_key,
            &market_map,
            &spot_market_map,
            &mut oracle_map,
            now,
            slot,
            10,
            PERCENTAGE_PRECISION,
            150,
        )
        .unwrap();
        assert_eq!(user.spot_positions[0].scaled_balance, 0);
        assert_eq!(user.spot_positions[1].scaled_balance, 0);

        assert_eq!(user.perp_positions[0].quote_asset_amount, -1099098);
        assert_eq!(user.status, UserStatus::Bankrupt as u8);
    }

    #[test]
    pub fn failure_due_to_contract_tier_violation() {
        let now = 0_i64;
        let slot = 0_u64;

        let mut sol_oracle_price = get_pyth_price(100, 6);
        let sol_oracle_price_key =
            Pubkey::from_str("J83w4HKfqxwcq3BEMMkPFSppX3gqekLyLJBexebFVkix").unwrap();
        let pyth_program = crate::ids::pyth_program::id();
        create_account_info!(
            sol_oracle_price,
            &sol_oracle_price_key,
            &pyth_program,
            oracle_account_info
        );
        let mut oracle_map = OracleMap::load_one(&oracle_account_info, slot, None).unwrap();

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
                max_fill_reserve_fraction: 100,
                order_step_size: 10000000,
                quote_asset_amount: 150 * QUOTE_PRECISION_I128,
                base_asset_amount_with_amm: BASE_PRECISION_I128,
                oracle: sol_oracle_price_key,
                ..AMM::default()
            },
            margin_ratio_initial: 1000,
            margin_ratio_maintenance: 500,
            unrealized_pnl_initial_asset_weight: 9000,
            unrealized_pnl_maintenance_asset_weight: 10000,
            number_of_users_with_base: 1,
            status: MarketStatus::Initialized,
            liquidator_fee: LIQUIDATION_FEE_PRECISION / 100,
            market_index: 0,
            contract_tier: ContractTier::A,
            ..PerpMarket::default()
        };
        create_anchor_account_info!(market, PerpMarket, market_account_info);

        let mut bonk_market = PerpMarket {
            amm: AMM {
                base_asset_reserve: 100 * AMM_RESERVE_PRECISION,
                quote_asset_reserve: 100 * AMM_RESERVE_PRECISION,
                bid_base_asset_reserve: 101 * AMM_RESERVE_PRECISION,
                bid_quote_asset_reserve: 99 * AMM_RESERVE_PRECISION,
                ask_base_asset_reserve: 99 * AMM_RESERVE_PRECISION,
                ask_quote_asset_reserve: 101 * AMM_RESERVE_PRECISION,
                sqrt_k: 100 * AMM_RESERVE_PRECISION,
                peg_multiplier: 8000,
                max_slippage_ratio: 50,
                max_fill_reserve_fraction: 100,
                order_step_size: 10000000,
                quote_asset_amount: 150 * QUOTE_PRECISION_I128,
                base_asset_amount_with_amm: BASE_PRECISION_I128,
                oracle: sol_oracle_price_key,
                ..AMM::default()
            },
            margin_ratio_initial: 1000,
            margin_ratio_maintenance: 500,
            unrealized_pnl_initial_asset_weight: 9000,
            unrealized_pnl_maintenance_asset_weight: 10000,
            number_of_users_with_base: 1,
            status: MarketStatus::Initialized,
            liquidator_fee: LIQUIDATION_FEE_PRECISION / 100,
            contract_tier: ContractTier::Speculative,
            market_index: 1,
            ..PerpMarket::default()
        };
        create_anchor_account_info!(bonk_market, PerpMarket, bonk_market_account_info);

        let market_map = PerpMarketMap::load_multiple(
            vec![&market_account_info, &bonk_market_account_info],
            true,
        )
        .unwrap();

        let mut usdc_market = SpotMarket {
            market_index: 0,
            oracle_source: OracleSource::QuoteAsset,
            cumulative_deposit_interest: SPOT_CUMULATIVE_INTEREST_PRECISION,
            decimals: 6,
            initial_asset_weight: SPOT_WEIGHT_PRECISION,
            maintenance_asset_weight: SPOT_WEIGHT_PRECISION,
            deposit_balance: 200 * SPOT_BALANCE_PRECISION,
            liquidator_fee: 0,
            historical_oracle_data: HistoricalOracleData {
                last_oracle_price_twap: QUOTE_PRECISION_I64,
                last_oracle_price_twap_5min: QUOTE_PRECISION_I64,
                ..HistoricalOracleData::default()
            },
            ..SpotMarket::default()
        };
        create_anchor_account_info!(usdc_market, SpotMarket, usdc_spot_market_account_info);
        let mut sol_market = SpotMarket {
            market_index: 1,
            oracle_source: OracleSource::Pyth,
            oracle: sol_oracle_price_key,
            cumulative_deposit_interest: SPOT_CUMULATIVE_INTEREST_PRECISION,
            cumulative_borrow_interest: SPOT_CUMULATIVE_INTEREST_PRECISION,
            decimals: 6,
            initial_asset_weight: 8 * SPOT_WEIGHT_PRECISION / 10,
            maintenance_asset_weight: 9 * SPOT_WEIGHT_PRECISION / 10,
            initial_liability_weight: 12 * SPOT_WEIGHT_PRECISION / 10,
            maintenance_liability_weight: 11 * SPOT_WEIGHT_PRECISION / 10,
            deposit_balance: SPOT_BALANCE_PRECISION,
            borrow_balance: 0,
            liquidator_fee: LIQUIDATION_FEE_PRECISION / 1000,
            historical_oracle_data: HistoricalOracleData {
                last_oracle_price_twap: (sol_oracle_price.agg.price * 99 / 100),
                last_oracle_price_twap_5min: (sol_oracle_price.agg.price * 99 / 100),
                ..HistoricalOracleData::default()
            },
            ..SpotMarket::default()
        };
        create_anchor_account_info!(sol_market, SpotMarket, sol_spot_market_account_info);
        let spot_market_account_infos = Vec::from([
            &usdc_spot_market_account_info,
            &sol_spot_market_account_info,
        ]);
        let spot_market_map =
            SpotMarketMap::load_multiple(spot_market_account_infos, true).unwrap();

        let mut spot_positions = [SpotPosition::default(); 8];
        spot_positions[0] = SpotPosition {
            market_index: 0,
            balance_type: SpotBalanceType::Deposit,
            scaled_balance: 200 * SPOT_BALANCE_PRECISION_U64,
            ..SpotPosition::default()
        };
        spot_positions[1] = SpotPosition {
            market_index: 1,
            balance_type: SpotBalanceType::Deposit,
            scaled_balance: SPOT_BALANCE_PRECISION_U64 / 1000,
            ..SpotPosition::default()
        };
        let mut user = User {
            orders: [Order::default(); 32],
            perp_positions: get_positions(PerpPosition {
                market_index: 0,
                quote_asset_amount: -100 * QUOTE_PRECISION_I64,
                ..PerpPosition::default()
            }),
            spot_positions,
            ..User::default()
        };

        user.perp_positions[1] = PerpPosition {
            market_index: 1,
            quote_asset_amount: -150 * QUOTE_PRECISION_I64,
            ..PerpPosition::default()
        };

        let mut liquidator = User {
            spot_positions: get_spot_positions(SpotPosition {
                market_index: 0,
                balance_type: SpotBalanceType::Deposit,
                scaled_balance: 100 * SPOT_BALANCE_PRECISION_U64,
                ..SpotPosition::default()
            }),
            ..User::default()
        };

        let user_key = Pubkey::default();
        let liquidator_key = Pubkey::default();

        assert!(liquidate_perp_pnl_for_deposit(
            1,
            0,
            50 * 10_u128.pow(6), // .8
            None,
            &mut user,
            &user_key,
            &mut liquidator,
            &liquidator_key,
            &market_map,
            &spot_market_map,
            &mut oracle_map,
            now,
            slot,
            10,
            PERCENTAGE_PRECISION,
            150,
        )
        .is_err());
        assert_eq!(user.perp_positions[0].quote_asset_amount, -100000000);

        liquidate_perp_pnl_for_deposit(
            0,
            0,
            5000 * 10_u128.pow(6),
            None,
            &mut user,
            &user_key,
            &mut liquidator,
            &liquidator_key,
            &market_map,
            &spot_market_map,
            &mut oracle_map,
            now,
            slot,
            10,
            PERCENTAGE_PRECISION,
            150,
        )
        .unwrap();
        assert_eq!(user.perp_positions[0].quote_asset_amount, 0);

        liquidate_perp_pnl_for_deposit(
            1,
            0,
            50 * 10_u128.pow(6), // .8
            None,
            &mut user,
            &user_key,
            &mut liquidator,
            &liquidator_key,
            &market_map,
            &spot_market_map,
            &mut oracle_map,
            now,
            slot,
            10,
            PERCENTAGE_PRECISION,
            150,
        )
        .unwrap();

        assert_eq!(user.spot_positions[0].scaled_balance, 48484849000);
        assert_eq!(user.perp_positions[0].quote_asset_amount, 0);
        assert_eq!(user.perp_positions[1].quote_asset_amount, -100000000);

        assert_eq!(
            liquidator.spot_positions[1].balance_type,
            SpotBalanceType::Deposit
        );
        assert_eq!(liquidator.spot_positions[1].scaled_balance, 0);
        assert_eq!(liquidator.perp_positions[0].quote_asset_amount, -100000000);
    }
}

pub mod resolve_perp_bankruptcy {
    use std::str::FromStr;

    use anchor_lang::Owner;
    use solana_program::pubkey::Pubkey;

    use crate::controller::funding::settle_funding_payment;
    use crate::controller::liquidation::resolve_perp_bankruptcy;
    use crate::controller::position::PositionDirection;
    use crate::create_anchor_account_info;
    use crate::math::constants::{
        AMM_RESERVE_PRECISION, BASE_PRECISION_I128, BASE_PRECISION_I64, BASE_PRECISION_U64,
        FUNDING_RATE_PRECISION_I128, FUNDING_RATE_PRECISION_I64, LIQUIDATION_FEE_PRECISION,
        PEG_PRECISION, QUOTE_PRECISION_I128, QUOTE_PRECISION_I64, QUOTE_SPOT_MARKET_INDEX,
        SPOT_BALANCE_PRECISION, SPOT_BALANCE_PRECISION_U64, SPOT_CUMULATIVE_INTEREST_PRECISION,
        SPOT_WEIGHT_PRECISION,
    };
    use crate::state::oracle::{HistoricalOracleData, OracleSource};
    use crate::state::oracle_map::OracleMap;
    use crate::state::perp_market::{MarketStatus, PerpMarket, PoolBalance, AMM};
    use crate::state::perp_market_map::PerpMarketMap;
    use crate::state::spot_market::{SpotBalanceType, SpotMarket};
    use crate::state::spot_market_map::SpotMarketMap;
    use crate::state::user::{
        Order, OrderStatus, OrderType, PerpPosition, SpotPosition, User, UserStatus,
    };
    use crate::test_utils::*;
    use crate::test_utils::{get_orders, get_positions, get_pyth_price, get_spot_positions};
    use crate::{create_account_info, PRICE_PRECISION_I64};

    #[test]
    pub fn successful_resolve_perp_bankruptcy() {
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
                max_fill_reserve_fraction: 100,
                order_step_size: 10000000,
                quote_asset_amount: -150 * QUOTE_PRECISION_I128,
                base_asset_amount_long: 5 * BASE_PRECISION_I128,
                base_asset_amount_short: -5 * BASE_PRECISION_I128,
                base_asset_amount_with_amm: BASE_PRECISION_I128,
                oracle: oracle_price_key,
                cumulative_funding_rate_long: 1000 * FUNDING_RATE_PRECISION_I128,
                cumulative_funding_rate_short: -1000 * FUNDING_RATE_PRECISION_I128,
                ..AMM::default()
            },
            margin_ratio_initial: 1000,
            margin_ratio_maintenance: 500,
            status: MarketStatus::Initialized,
            liquidator_fee: LIQUIDATION_FEE_PRECISION / 100,
            number_of_users: 1,
            ..PerpMarket::default()
        };
        create_anchor_account_info!(market, PerpMarket, market_account_info);
        let market_map = PerpMarketMap::load_one(&market_account_info, true).unwrap();

        let mut spot_market = SpotMarket {
            market_index: 0,
            oracle_source: OracleSource::QuoteAsset,
            cumulative_deposit_interest: SPOT_CUMULATIVE_INTEREST_PRECISION,
            decimals: 6,
            initial_asset_weight: SPOT_WEIGHT_PRECISION,
            historical_oracle_data: HistoricalOracleData {
                last_oracle_price_twap: PRICE_PRECISION_I64,
                last_oracle_price_twap_5min: PRICE_PRECISION_I64,
                ..HistoricalOracleData::default()
            },
            ..SpotMarket::default()
        };
        create_anchor_account_info!(spot_market, SpotMarket, spot_market_account_info);
        let spot_market_map = SpotMarketMap::load_one(&spot_market_account_info, true).unwrap();

        let mut user = User {
            orders: get_orders(Order {
                market_index: 0,
                status: OrderStatus::Open,
                order_type: OrderType::Limit,
                direction: PositionDirection::Long,
                base_asset_amount: BASE_PRECISION_U64,
                slot: 0,
                ..Order::default()
            }),
            perp_positions: get_positions(PerpPosition {
                market_index: 0,
                base_asset_amount: 0,
                quote_asset_amount: -100 * QUOTE_PRECISION_I64,
                quote_entry_amount: -100 * QUOTE_PRECISION_I64,
                quote_break_even_amount: -100 * QUOTE_PRECISION_I64,
                open_orders: 1,
                open_bids: BASE_PRECISION_I64,
                ..PerpPosition::default()
            }),
            spot_positions: [SpotPosition::default(); 8],
            status: UserStatus::Bankrupt as u8,
            next_liquidation_id: 2,
            ..User::default()
        };

        let mut liquidator = User {
            spot_positions: get_spot_positions(SpotPosition {
                market_index: 0,
                balance_type: SpotBalanceType::Deposit,
                scaled_balance: 50 * SPOT_BALANCE_PRECISION_U64,
                ..SpotPosition::default()
            }),
            ..User::default()
        };

        let user_key = Pubkey::default();
        let liquidator_key = Pubkey::default();

        let mut expected_user = user;
        expected_user.status = 0;
        expected_user.perp_positions[0].quote_asset_amount = 0;
        expected_user.total_social_loss = 100000000;

        let mut expected_market = market;
        expected_market.amm.cumulative_funding_rate_long = 1010 * FUNDING_RATE_PRECISION_I128;
        expected_market.amm.cumulative_funding_rate_short = -1010 * FUNDING_RATE_PRECISION_I128;
        expected_market.amm.total_social_loss = 100000000;
        expected_market.amm.quote_asset_amount = -50 * QUOTE_PRECISION_I128;
        expected_market.number_of_users = 0;

        resolve_perp_bankruptcy(
            0,
            &mut user,
            &user_key,
            &mut liquidator,
            &liquidator_key,
            &market_map,
            &spot_market_map,
            &mut oracle_map,
            now,
            0,
        )
        .unwrap();

        assert_eq!(expected_user, user);
        assert_eq!(expected_market, market_map.get_ref(&0).unwrap().clone());

        let mut affected_long_user = User {
            orders: [Order::default(); 32],
            perp_positions: get_positions(PerpPosition {
                market_index: 0,
                base_asset_amount: 5 * BASE_PRECISION_I64,
                quote_asset_amount: -500 * QUOTE_PRECISION_I64,
                quote_break_even_amount: -500 * QUOTE_PRECISION_I64,
                quote_entry_amount: -500 * QUOTE_PRECISION_I64,
                open_bids: BASE_PRECISION_I64,
                last_cumulative_funding_rate: 1000 * FUNDING_RATE_PRECISION_I64,
                ..PerpPosition::default()
            }),
            spot_positions: [SpotPosition::default(); 8],
            ..User::default()
        };

        let mut expected_affected_long_user = affected_long_user;
        expected_affected_long_user.perp_positions[0].quote_asset_amount =
            -550 * QUOTE_PRECISION_I64; // loses $50
        expected_affected_long_user.perp_positions[0].quote_break_even_amount =
            -550 * QUOTE_PRECISION_I64; // loses $50
        expected_affected_long_user.perp_positions[0].last_cumulative_funding_rate =
            1010 * FUNDING_RATE_PRECISION_I64;
        expected_affected_long_user.cumulative_perp_funding = -50 * QUOTE_PRECISION_I64;

        {
            let mut market = market_map.get_ref_mut(&0).unwrap();
            settle_funding_payment(
                &mut affected_long_user,
                &Pubkey::default(),
                &mut market,
                now,
            )
            .unwrap()
        }

        assert_eq!(expected_affected_long_user, affected_long_user);

        let mut affected_short_user = User {
            orders: [Order::default(); 32],
            perp_positions: get_positions(PerpPosition {
                market_index: 0,
                base_asset_amount: -5 * BASE_PRECISION_I64,
                quote_asset_amount: 500 * QUOTE_PRECISION_I64,
                quote_entry_amount: 500 * QUOTE_PRECISION_I64,
                quote_break_even_amount: 500 * QUOTE_PRECISION_I64,
                open_bids: BASE_PRECISION_I64,
                last_cumulative_funding_rate: -1000 * FUNDING_RATE_PRECISION_I64,
                ..PerpPosition::default()
            }),
            spot_positions: [SpotPosition::default(); 8],
            ..User::default()
        };

        let mut expected_affected_short_user = affected_short_user;
        expected_affected_short_user.perp_positions[0].quote_asset_amount =
            450 * QUOTE_PRECISION_I64; // loses $50
        expected_affected_short_user.perp_positions[0].quote_break_even_amount =
            450 * QUOTE_PRECISION_I64; // loses $50
        expected_affected_short_user.perp_positions[0].last_cumulative_funding_rate =
            -1010 * FUNDING_RATE_PRECISION_I64;
        expected_affected_short_user.cumulative_perp_funding = -50 * QUOTE_PRECISION_I64;

        {
            let mut market = market_map.get_ref_mut(&0).unwrap();
            settle_funding_payment(
                &mut affected_short_user,
                &Pubkey::default(),
                &mut market,
                now,
            )
            .unwrap()
        }

        assert_eq!(expected_affected_short_user, affected_short_user);
    }

    #[test]
    pub fn successful_resolve_perp_bankruptcy_with_fee_pool() {
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
                max_fill_reserve_fraction: 100,
                order_step_size: 10000000,
                quote_asset_amount: -150 * QUOTE_PRECISION_I128,
                base_asset_amount_long: 5 * BASE_PRECISION_I128,
                base_asset_amount_short: -5 * BASE_PRECISION_I128,
                base_asset_amount_with_amm: BASE_PRECISION_I128,
                oracle: oracle_price_key,
                cumulative_funding_rate_long: 1000 * FUNDING_RATE_PRECISION_I128,
                cumulative_funding_rate_short: -1000 * FUNDING_RATE_PRECISION_I128,
                fee_pool: PoolBalance {
                    scaled_balance: 50 * SPOT_BALANCE_PRECISION,
                    market_index: QUOTE_SPOT_MARKET_INDEX,
                    ..PoolBalance::default()
                },
                ..AMM::default()
            },
            margin_ratio_initial: 1000,
            margin_ratio_maintenance: 500,
            status: MarketStatus::Initialized,
            liquidator_fee: LIQUIDATION_FEE_PRECISION / 100,
            number_of_users: 1,
            ..PerpMarket::default()
        };
        create_anchor_account_info!(market, PerpMarket, market_account_info);
        let market_map = PerpMarketMap::load_one(&market_account_info, true).unwrap();

        let mut spot_market = SpotMarket {
            market_index: 0,
            deposit_balance: 500 * SPOT_BALANCE_PRECISION,
            oracle_source: OracleSource::QuoteAsset,
            cumulative_deposit_interest: SPOT_CUMULATIVE_INTEREST_PRECISION,
            decimals: 6,
            initial_asset_weight: SPOT_WEIGHT_PRECISION,
            ..SpotMarket::default()
        };
        create_anchor_account_info!(spot_market, SpotMarket, spot_market_account_info);
        let spot_market_map = SpotMarketMap::load_one(&spot_market_account_info, true).unwrap();

        let mut user = User {
            orders: get_orders(Order {
                market_index: 0,
                status: OrderStatus::Open,
                order_type: OrderType::Limit,
                direction: PositionDirection::Long,
                base_asset_amount: BASE_PRECISION_U64,
                slot: 0,
                ..Order::default()
            }),
            perp_positions: get_positions(PerpPosition {
                market_index: 0,
                base_asset_amount: 0,
                quote_asset_amount: -100 * QUOTE_PRECISION_I64,
                quote_entry_amount: -100 * QUOTE_PRECISION_I64,
                quote_break_even_amount: -100 * QUOTE_PRECISION_I64,
                open_orders: 1,
                open_bids: BASE_PRECISION_I64,
                ..PerpPosition::default()
            }),
            spot_positions: [SpotPosition::default(); 8],
            status: UserStatus::Bankrupt as u8,
            next_liquidation_id: 2,
            ..User::default()
        };

        let mut liquidator = User {
            spot_positions: get_spot_positions(SpotPosition {
                market_index: 0,
                balance_type: SpotBalanceType::Deposit,
                scaled_balance: 50 * SPOT_BALANCE_PRECISION_U64,
                ..SpotPosition::default()
            }),
            ..User::default()
        };

        let user_key = Pubkey::default();
        let liquidator_key = Pubkey::default();

        let mut expected_user = user;
        expected_user.status = 0;
        expected_user.perp_positions[0].quote_asset_amount = 0;
        expected_user.total_social_loss = 100000000;

        let mut expected_market = market;
        expected_market.amm.cumulative_funding_rate_long = 1005 * FUNDING_RATE_PRECISION_I128;
        expected_market.amm.cumulative_funding_rate_short = -1005 * FUNDING_RATE_PRECISION_I128;
        expected_market.amm.total_social_loss = 50000000;
        expected_market.amm.quote_asset_amount = -50 * QUOTE_PRECISION_I128;
        expected_market.number_of_users = 0;
        expected_market.amm.fee_pool.scaled_balance = 0;

        resolve_perp_bankruptcy(
            0,
            &mut user,
            &user_key,
            &mut liquidator,
            &liquidator_key,
            &market_map,
            &spot_market_map,
            &mut oracle_map,
            now,
            0,
        )
        .unwrap();

        assert_eq!(user.total_social_loss, 100000000);
        assert_eq!(expected_user, user);
        assert_eq!(expected_market, market_map.get_ref(&0).unwrap().clone());

        let mut affected_long_user = User {
            orders: [Order::default(); 32],
            perp_positions: get_positions(PerpPosition {
                market_index: 0,
                base_asset_amount: 5 * BASE_PRECISION_I64,
                quote_asset_amount: -500 * QUOTE_PRECISION_I64,
                quote_break_even_amount: -500 * QUOTE_PRECISION_I64,
                quote_entry_amount: -500 * QUOTE_PRECISION_I64,
                open_bids: BASE_PRECISION_I64,
                last_cumulative_funding_rate: 1000 * FUNDING_RATE_PRECISION_I64,
                ..PerpPosition::default()
            }),
            spot_positions: [SpotPosition::default(); 8],
            ..User::default()
        };

        let mut expected_affected_long_user = affected_long_user;
        expected_affected_long_user.perp_positions[0].quote_asset_amount =
            -525 * QUOTE_PRECISION_I64; // loses $50
        expected_affected_long_user.perp_positions[0].quote_break_even_amount =
            -525 * QUOTE_PRECISION_I64; // loses $50
        expected_affected_long_user.perp_positions[0].last_cumulative_funding_rate =
            1005 * FUNDING_RATE_PRECISION_I64;
        expected_affected_long_user.cumulative_perp_funding = -25 * QUOTE_PRECISION_I64;

        {
            let mut market = market_map.get_ref_mut(&0).unwrap();
            settle_funding_payment(
                &mut affected_long_user,
                &Pubkey::default(),
                &mut market,
                now,
            )
            .unwrap()
        }

        assert_eq!(expected_affected_long_user, affected_long_user);

        let mut affected_short_user = User {
            orders: [Order::default(); 32],
            perp_positions: get_positions(PerpPosition {
                market_index: 0,
                base_asset_amount: -5 * BASE_PRECISION_I64,
                quote_asset_amount: 500 * QUOTE_PRECISION_I64,
                quote_entry_amount: 500 * QUOTE_PRECISION_I64,
                quote_break_even_amount: 500 * QUOTE_PRECISION_I64,
                open_bids: BASE_PRECISION_I64,
                last_cumulative_funding_rate: -1000 * FUNDING_RATE_PRECISION_I64,
                ..PerpPosition::default()
            }),
            spot_positions: [SpotPosition::default(); 8],
            ..User::default()
        };

        let mut expected_affected_short_user = affected_short_user;
        expected_affected_short_user.perp_positions[0].quote_asset_amount =
            475 * QUOTE_PRECISION_I64; // loses $50
        expected_affected_short_user.perp_positions[0].quote_break_even_amount =
            475 * QUOTE_PRECISION_I64; // loses $50
        expected_affected_short_user.perp_positions[0].last_cumulative_funding_rate =
            -1005 * FUNDING_RATE_PRECISION_I64;
        expected_affected_short_user.cumulative_perp_funding = -25 * QUOTE_PRECISION_I64;

        {
            let mut market = market_map.get_ref_mut(&0).unwrap();
            settle_funding_payment(
                &mut affected_short_user,
                &Pubkey::default(),
                &mut market,
                now,
            )
            .unwrap()
        }

        assert_eq!(expected_affected_short_user, affected_short_user);
    }
}

pub mod resolve_spot_bankruptcy {
    use std::str::FromStr;

    use anchor_lang::Owner;
    use solana_program::pubkey::Pubkey;

    use crate::controller::liquidation::resolve_spot_bankruptcy;
    use crate::controller::position::PositionDirection;
    use crate::create_account_info;
    use crate::create_anchor_account_info;
    use crate::math::constants::{
        AMM_RESERVE_PRECISION, BASE_PRECISION_I128, BASE_PRECISION_U64,
        FUNDING_RATE_PRECISION_I128, LIQUIDATION_FEE_PRECISION, PEG_PRECISION, QUOTE_PRECISION,
        QUOTE_PRECISION_I128, QUOTE_PRECISION_I64, SPOT_BALANCE_PRECISION,
        SPOT_BALANCE_PRECISION_U64, SPOT_CUMULATIVE_INTEREST_PRECISION, SPOT_WEIGHT_PRECISION,
    };
    use crate::math::spot_balance::get_token_amount;
    use crate::state::oracle::{HistoricalOracleData, OracleSource};
    use crate::state::oracle_map::OracleMap;
    use crate::state::perp_market::{MarketStatus, PerpMarket, AMM};
    use crate::state::perp_market_map::PerpMarketMap;
    use crate::state::spot_market::{SpotBalanceType, SpotMarket};
    use crate::state::spot_market_map::SpotMarketMap;
    use crate::state::user::{
        Order, OrderStatus, OrderType, PerpPosition, SpotPosition, User, UserStatus,
    };
    use crate::test_utils::*;
    use crate::test_utils::{get_orders, get_pyth_price, get_spot_positions};

    #[test]
    pub fn successful_resolve_spot_bankruptcy() {
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
                max_fill_reserve_fraction: 100,
                order_step_size: 10000000,
                quote_asset_amount: -150 * QUOTE_PRECISION_I128,
                base_asset_amount_with_amm: BASE_PRECISION_I128,
                base_asset_amount_long: 5 * BASE_PRECISION_I128,
                base_asset_amount_short: -5 * BASE_PRECISION_I128,
                oracle: oracle_price_key,
                cumulative_funding_rate_long: 1000 * FUNDING_RATE_PRECISION_I128,
                cumulative_funding_rate_short: -1000 * FUNDING_RATE_PRECISION_I128,
                ..AMM::default()
            },
            margin_ratio_initial: 1000,
            margin_ratio_maintenance: 500,
            status: MarketStatus::Initialized,
            liquidator_fee: LIQUIDATION_FEE_PRECISION / 100,
            ..PerpMarket::default()
        };
        create_anchor_account_info!(market, PerpMarket, market_account_info);
        let market_map = PerpMarketMap::load_one(&market_account_info, true).unwrap();

        let mut spot_market = SpotMarket {
            market_index: 0,
            oracle_source: OracleSource::QuoteAsset,
            cumulative_deposit_interest: SPOT_CUMULATIVE_INTEREST_PRECISION,
            cumulative_borrow_interest: SPOT_CUMULATIVE_INTEREST_PRECISION,
            decimals: 6,
            initial_asset_weight: SPOT_WEIGHT_PRECISION,
            deposit_balance: 1000 * SPOT_BALANCE_PRECISION,
            borrow_balance: 100 * SPOT_BALANCE_PRECISION,
            historical_oracle_data: HistoricalOracleData::default_price(QUOTE_PRECISION_I64),
            ..SpotMarket::default()
        };
        create_anchor_account_info!(spot_market, SpotMarket, spot_market_account_info);
        let spot_market_map = SpotMarketMap::load_one(&spot_market_account_info, true).unwrap();

        let mut user = User {
            orders: get_orders(Order {
                market_index: 0,
                status: OrderStatus::Open,
                order_type: OrderType::Limit,
                direction: PositionDirection::Long,
                base_asset_amount: BASE_PRECISION_U64,
                slot: 0,
                ..Order::default()
            }),
            perp_positions: [PerpPosition::default(); 8],
            spot_positions: get_spot_positions(SpotPosition {
                market_index: 0,
                scaled_balance: 100 * SPOT_BALANCE_PRECISION_U64,
                balance_type: SpotBalanceType::Borrow,
                ..SpotPosition::default()
            }),
            status: UserStatus::Bankrupt as u8,
            next_liquidation_id: 2,
            ..User::default()
        };

        let mut liquidator = User {
            spot_positions: get_spot_positions(SpotPosition {
                market_index: 0,
                balance_type: SpotBalanceType::Deposit,
                scaled_balance: 50 * SPOT_BALANCE_PRECISION_U64,
                ..SpotPosition::default()
            }),
            ..User::default()
        };

        let user_key = Pubkey::default();
        let liquidator_key = Pubkey::default();

        let mut expected_user = user;
        expected_user.status = 0;
        expected_user.spot_positions[0].scaled_balance = 0;
        expected_user.spot_positions[0].cumulative_deposits = 100 * QUOTE_PRECISION_I64;
        expected_user.total_social_loss = 100000000;

        let mut expected_spot_market = spot_market;
        expected_spot_market.borrow_balance = 0;
        expected_spot_market.cumulative_deposit_interest =
            9 * SPOT_CUMULATIVE_INTEREST_PRECISION / 10;
        expected_spot_market.total_social_loss = 100 * QUOTE_PRECISION;
        expected_spot_market.total_quote_social_loss = 100 * QUOTE_PRECISION;

        resolve_spot_bankruptcy(
            0,
            &mut user,
            &user_key,
            &mut liquidator,
            &liquidator_key,
            &market_map,
            &spot_market_map,
            &mut oracle_map,
            now,
            0,
        )
        .unwrap();

        assert_eq!(expected_user, user);
        assert_eq!(expected_spot_market, *spot_market_map.get_ref(&0).unwrap());

        let spot_market = spot_market_map.get_ref_mut(&0).unwrap();
        let deposit_balance = spot_market.deposit_balance;
        let deposit_token_amount =
            get_token_amount(deposit_balance, &spot_market, &SpotBalanceType::Deposit).unwrap();

        assert_eq!(deposit_token_amount, 900 * QUOTE_PRECISION);
    }
}

pub mod set_user_status_to_being_liquidated {

    use crate::state::state::State;
    use std::str::FromStr;

    use anchor_lang::Owner;
    use solana_program::pubkey::Pubkey;

    use crate::controller::liquidation::set_user_status_to_being_liquidated;
    use crate::controller::position::PositionDirection;
    use crate::error::ErrorCode;
    use crate::math::constants::{
        AMM_RESERVE_PRECISION, BASE_PRECISION_I128, BASE_PRECISION_I64, BASE_PRECISION_U64,
        LIQUIDATION_FEE_PRECISION, PEG_PRECISION, QUOTE_PRECISION_I128, QUOTE_PRECISION_I64,
        SPOT_CUMULATIVE_INTEREST_PRECISION, SPOT_WEIGHT_PRECISION,
    };
    use crate::state::oracle::{HistoricalOracleData, OracleSource};
    use crate::state::oracle_map::OracleMap;
    use crate::state::perp_market::{MarketStatus, PerpMarket, AMM};
    use crate::state::perp_market_map::PerpMarketMap;
    use crate::state::spot_market::{SpotBalanceType, SpotMarket};
    use crate::state::spot_market_map::SpotMarketMap;
    use crate::state::user::{
        Order, OrderStatus, OrderType, PerpPosition, SpotPosition, User, UserStatus,
    };
    use crate::test_utils::{get_orders, get_positions, get_pyth_price};
    use crate::{create_account_info, PRICE_PRECISION_I64};
    use crate::{create_anchor_account_info, LIQUIDATION_PCT_PRECISION};
    use crate::{test_utils::*, DEFAULT_LIQUIDATION_MARGIN_BUFFER_RATIO};

    #[test]
    pub fn failure_sufficient_collateral() {
        let slot = 0_u64;

        let mut oracle_price = get_pyth_price(200, 6);
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
                max_fill_reserve_fraction: 100,
                order_step_size: 10000000,
                quote_asset_amount: -150 * QUOTE_PRECISION_I128,
                base_asset_amount_with_amm: BASE_PRECISION_I128,
                oracle: oracle_price_key,
                historical_oracle_data: HistoricalOracleData::default_price(oracle_price.agg.price),
                ..AMM::default()
            },
            margin_ratio_initial: 1000,
            margin_ratio_maintenance: 500,
            number_of_users_with_base: 1,
            status: MarketStatus::Initialized,
            liquidator_fee: LIQUIDATION_FEE_PRECISION / 100,
            if_liquidation_fee: LIQUIDATION_FEE_PRECISION / 100,
            ..PerpMarket::default()
        };
        create_anchor_account_info!(market, PerpMarket, market_account_info);
        let perp_market_map = PerpMarketMap::load_one(&market_account_info, true).unwrap();

        let mut spot_market = SpotMarket {
            market_index: 0,
            oracle_source: OracleSource::QuoteAsset,
            cumulative_deposit_interest: SPOT_CUMULATIVE_INTEREST_PRECISION,
            decimals: 6,
            initial_asset_weight: SPOT_WEIGHT_PRECISION,
            maintenance_asset_weight: SPOT_WEIGHT_PRECISION,
            historical_oracle_data: HistoricalOracleData {
                last_oracle_price_twap: PRICE_PRECISION_I64,
                last_oracle_price_twap_5min: PRICE_PRECISION_I64,
                ..HistoricalOracleData::default()
            },
            ..SpotMarket::default()
        };
        create_anchor_account_info!(spot_market, SpotMarket, spot_market_account_info);
        let spot_market_map = SpotMarketMap::load_one(&spot_market_account_info, true).unwrap();

        let mut user = User {
            orders: get_orders(Order {
                market_index: 0,
                status: OrderStatus::Open,
                order_type: OrderType::Limit,
                direction: PositionDirection::Long,
                base_asset_amount: BASE_PRECISION_U64,
                slot: 0,
                ..Order::default()
            }),
            perp_positions: get_positions(PerpPosition {
                market_index: 0,
                base_asset_amount: BASE_PRECISION_I64,
                quote_asset_amount: 100 * QUOTE_PRECISION_I64,
                quote_entry_amount: 100 * QUOTE_PRECISION_I64,
                quote_break_even_amount: 100 * QUOTE_PRECISION_I64,
                open_orders: 1,
                open_bids: BASE_PRECISION_I64,
                ..PerpPosition::default()
            }),
            spot_positions: get_spot_positions(SpotPosition {
                market_index: 0,
                scaled_balance: 1000000000000,
                cumulative_deposits: 100000000000,
                balance_type: SpotBalanceType::Deposit,
                ..SpotPosition::default()
            }),
            ..User::default()
        };

        let state = State {
            liquidation_margin_buffer_ratio: DEFAULT_LIQUIDATION_MARGIN_BUFFER_RATIO,
            initial_pct_to_liquidate: LIQUIDATION_PCT_PRECISION as u16,
            liquidation_duration: 150,
            ..Default::default()
        };

        let result = set_user_status_to_being_liquidated(
            &mut user,
            &perp_market_map,
            &spot_market_map,
            &mut oracle_map,
            slot,
            &state,
        );

        assert_eq!(result, Err(ErrorCode::SufficientCollateral));
    }

    #[test]
    pub fn failure_from_user_statuses() {
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

        let mut user = User {
            orders: [Order::default(); 32],
            perp_positions: [PerpPosition::default(); 8],
            spot_positions: [SpotPosition::default(); 8],
            ..User::default()
        };

        user.add_user_status(UserStatus::Bankrupt);
        let state = State {
            liquidation_margin_buffer_ratio: DEFAULT_LIQUIDATION_MARGIN_BUFFER_RATIO,
            initial_pct_to_liquidate: LIQUIDATION_PCT_PRECISION as u16,
            liquidation_duration: 150,
            ..Default::default()
        };

        let mut market = PerpMarket {
            amm: AMM::default(),
            ..PerpMarket::default()
        };
        create_anchor_account_info!(market, PerpMarket, market_account_info);
        let perp_market_map = PerpMarketMap::load_one(&market_account_info, true).unwrap();
        let mut spot_market = SpotMarket::default();
        create_anchor_account_info!(spot_market, SpotMarket, spot_market_account_info);
        let spot_market_map = SpotMarketMap::load_one(&spot_market_account_info, true).unwrap();

        let mut result = set_user_status_to_being_liquidated(
            &mut user,
            &perp_market_map,
            &spot_market_map,
            &mut oracle_map,
            slot,
            &state,
        );

        assert_eq!(result, Err(ErrorCode::UserBankrupt));

        user.remove_user_status(UserStatus::Bankrupt);
        user.add_user_status(UserStatus::BeingLiquidated);
        result = set_user_status_to_being_liquidated(
            &mut user,
            &perp_market_map,
            &spot_market_map,
            &mut oracle_map,
            slot,
            &state,
        );
        assert_eq!(result, Err(ErrorCode::UserIsBeingLiquidated));
    }

    #[test]
    pub fn success() {
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
                max_fill_reserve_fraction: 100,
                order_step_size: 10000000,
                quote_asset_amount: -150 * QUOTE_PRECISION_I128,
                base_asset_amount_with_amm: BASE_PRECISION_I128,
                oracle: oracle_price_key,
                historical_oracle_data: HistoricalOracleData::default_price(oracle_price.agg.price),
                ..AMM::default()
            },
            margin_ratio_initial: 1000,
            margin_ratio_maintenance: 500,
            number_of_users_with_base: 1,
            status: MarketStatus::Initialized,
            liquidator_fee: LIQUIDATION_FEE_PRECISION / 100,
            if_liquidation_fee: LIQUIDATION_FEE_PRECISION / 100,
            ..PerpMarket::default()
        };
        create_anchor_account_info!(market, PerpMarket, market_account_info);
        let perp_market_map = PerpMarketMap::load_one(&market_account_info, true).unwrap();

        let mut spot_market = SpotMarket {
            market_index: 0,
            oracle_source: OracleSource::QuoteAsset,
            cumulative_deposit_interest: SPOT_CUMULATIVE_INTEREST_PRECISION,
            decimals: 6,
            historical_oracle_data: HistoricalOracleData {
                last_oracle_price_twap: PRICE_PRECISION_I64,
                last_oracle_price_twap_5min: PRICE_PRECISION_I64,
                ..HistoricalOracleData::default()
            },
            ..SpotMarket::default()
        };
        create_anchor_account_info!(spot_market, SpotMarket, spot_market_account_info);
        let spot_market_map = SpotMarketMap::load_one(&spot_market_account_info, true).unwrap();

        let mut user = User {
            orders: get_orders(Order {
                market_index: 0,
                status: OrderStatus::Open,
                order_type: OrderType::Limit,
                direction: PositionDirection::Long,
                base_asset_amount: BASE_PRECISION_U64,
                slot: 0,
                ..Order::default()
            }),
            perp_positions: get_positions(PerpPosition {
                market_index: 0,
                base_asset_amount: BASE_PRECISION_I64,
                quote_asset_amount: -150 * QUOTE_PRECISION_I64,
                quote_entry_amount: -150 * QUOTE_PRECISION_I64,
                quote_break_even_amount: -150 * QUOTE_PRECISION_I64,
                open_orders: 1,
                open_bids: BASE_PRECISION_I64,
                ..PerpPosition::default()
            }),
            ..User::default()
        };

        let state = State {
            liquidation_margin_buffer_ratio: DEFAULT_LIQUIDATION_MARGIN_BUFFER_RATIO,
            initial_pct_to_liquidate: LIQUIDATION_PCT_PRECISION as u16,
            liquidation_duration: 150,
            ..Default::default()
        };

        let result = set_user_status_to_being_liquidated(
            &mut user,
            &perp_market_map,
            &spot_market_map,
            &mut oracle_map,
            slot,
            &state,
        );

        assert_eq!(user.status, UserStatus::BeingLiquidated as u8);
        assert_eq!(result, Ok(()));
    }
}

pub mod liquidate_spot_with_swap {
    use crate::math::spot_balance::get_token_amount;
    use crate::state::oracle::{HistoricalOracleData, OracleSource};
    use crate::state::state::State;
    use std::ops::Deref;
    use std::str::FromStr;

    use anchor_lang::Owner;
    use solana_program::pubkey::Pubkey;

    use crate::controller::liquidation::{
        liquidate_spot_with_swap_begin, liquidate_spot_with_swap_end,
    };
    use crate::create_anchor_account_info;
    use crate::error::ErrorCode;
    use crate::math::constants::{
        LIQUIDATION_FEE_PRECISION, LIQUIDATION_PCT_PRECISION, MARGIN_PRECISION,
        SPOT_BALANCE_PRECISION, SPOT_BALANCE_PRECISION_U64, SPOT_CUMULATIVE_INTEREST_PRECISION,
        SPOT_WEIGHT_PRECISION,
    };
    use crate::state::oracle_map::OracleMap;
    use crate::state::perp_market_map::PerpMarketMap;
    use crate::state::spot_market::{SpotBalanceType, SpotMarket};
    use crate::state::spot_market_map::SpotMarketMap;
    use crate::state::user::UserStats;
    use crate::state::user::{Order, PerpPosition, SpotPosition, User};
    use crate::test_utils::*;
    use crate::test_utils::{get_pyth_price, get_spot_positions};
    use crate::{create_account_info, QUOTE_PRECISION_I64};

    #[test]
    pub fn successful_liquidation_liability_transfer_to_cover_margin_shortage() {
        let now = 0_i64;
        let slot = 0_u64;

        let mut user_stats = UserStats::default();
        let mut liquidator_stats = UserStats::default();

        let mut sol_oracle_price = get_pyth_price(100, 6);
        let sol_oracle_price_key =
            Pubkey::from_str("J83w4HKfqxwcq3BEMMkPFSppX3gqekLyLJBexebFVkix").unwrap();
        let pyth_program = crate::ids::pyth_program::id();
        create_account_info!(
            sol_oracle_price,
            &sol_oracle_price_key,
            &pyth_program,
            oracle_account_info
        );
        let mut oracle_map = OracleMap::load_one(&oracle_account_info, slot, None).unwrap();

        let market_map = PerpMarketMap::empty();

        let mut usdc_market = SpotMarket {
            market_index: 0,
            oracle_source: OracleSource::QuoteAsset,
            cumulative_deposit_interest: SPOT_CUMULATIVE_INTEREST_PRECISION,
            decimals: 6,
            initial_asset_weight: SPOT_WEIGHT_PRECISION,
            maintenance_asset_weight: SPOT_WEIGHT_PRECISION,
            deposit_balance: 200 * SPOT_BALANCE_PRECISION,
            liquidator_fee: 0,
            historical_oracle_data: HistoricalOracleData {
                last_oracle_price_twap: QUOTE_PRECISION_I64,
                last_oracle_price_twap_5min: QUOTE_PRECISION_I64,
                ..HistoricalOracleData::default()
            },
            ..SpotMarket::default()
        };
        create_anchor_account_info!(usdc_market, SpotMarket, usdc_spot_market_account_info);
        let mut sol_market = SpotMarket {
            market_index: 1,
            oracle_source: OracleSource::Pyth,
            oracle: sol_oracle_price_key,
            cumulative_deposit_interest: SPOT_CUMULATIVE_INTEREST_PRECISION,
            cumulative_borrow_interest: SPOT_CUMULATIVE_INTEREST_PRECISION,
            decimals: 6,
            initial_asset_weight: 8 * SPOT_WEIGHT_PRECISION / 10,
            maintenance_asset_weight: 9 * SPOT_WEIGHT_PRECISION / 10,
            initial_liability_weight: 12 * SPOT_WEIGHT_PRECISION / 10,
            maintenance_liability_weight: 11 * SPOT_WEIGHT_PRECISION / 10,
            deposit_balance: SPOT_BALANCE_PRECISION,
            borrow_balance: SPOT_BALANCE_PRECISION,
            liquidator_fee: LIQUIDATION_FEE_PRECISION / 100,
            if_liquidation_fee: LIQUIDATION_FEE_PRECISION / 100,
            historical_oracle_data: HistoricalOracleData {
                last_oracle_price_twap: (sol_oracle_price.agg.price * 99 / 100),
                last_oracle_price_twap_5min: (sol_oracle_price.agg.price * 99 / 100),
                ..HistoricalOracleData::default()
            },
            ..SpotMarket::default()
        };
        create_anchor_account_info!(sol_market, SpotMarket, sol_spot_market_account_info);
        let spot_market_account_infos = Vec::from([
            &usdc_spot_market_account_info,
            &sol_spot_market_account_info,
        ]);
        let spot_market_map =
            SpotMarketMap::load_multiple(spot_market_account_infos, true).unwrap();

        let mut spot_positions = [SpotPosition::default(); 8];
        spot_positions[0] = SpotPosition {
            market_index: 0,
            balance_type: SpotBalanceType::Deposit,
            scaled_balance: 105 * SPOT_BALANCE_PRECISION_U64,
            ..SpotPosition::default()
        };
        spot_positions[1] = SpotPosition {
            market_index: 1,
            balance_type: SpotBalanceType::Borrow,
            scaled_balance: SPOT_BALANCE_PRECISION_U64,
            ..SpotPosition::default()
        };
        let mut user = User {
            orders: [Order::default(); 32],
            perp_positions: [PerpPosition::default(); 8],
            spot_positions,
            ..User::default()
        };

        let mut liquidator = User {
            spot_positions: get_spot_positions(SpotPosition {
                market_index: 0,
                balance_type: SpotBalanceType::Deposit,
                scaled_balance: 100 * SPOT_BALANCE_PRECISION_U64,
                ..SpotPosition::default()
            }),
            ..User::default()
        };

        let user_key = Pubkey::default();
        let liquidator_key = Pubkey::default();

        let state = State {
            liquidation_margin_buffer_ratio: MARGIN_PRECISION / 50,
            initial_pct_to_liquidate: LIQUIDATION_PCT_PRECISION as u16,
            liquidation_duration: 150,
            ..Default::default()
        };

        let asset_transfer = 64338200;
        let liability_transfer = 643382;

        let res = liquidate_spot_with_swap_begin(
            0,
            1,
            asset_transfer + (asset_transfer / 400) + 1,
            &mut user,
            &user_key,
            &mut user_stats,
            &mut liquidator,
            &liquidator_key,
            &mut liquidator_stats,
            &market_map,
            &spot_market_map,
            &mut oracle_map,
            now,
            slot,
            &state,
        );

        assert_eq!(res, Err(ErrorCode::InvalidLiquidation));

        let res = liquidate_spot_with_swap_begin(
            0,
            1,
            asset_transfer,
            &mut user,
            &user_key,
            &mut user_stats,
            &mut liquidator,
            &liquidator_key,
            &mut liquidator_stats,
            &market_map,
            &spot_market_map,
            &mut oracle_map,
            now,
            slot,
            &state,
        );

        assert_eq!(res, Ok(()));

        liquidate_spot_with_swap_end(
            0,
            1,
            &mut user,
            &user_key,
            &mut user_stats,
            &mut liquidator,
            &liquidator_key,
            &mut liquidator_stats,
            &market_map,
            &spot_market_map,
            &mut oracle_map,
            now,
            slot,
            &state,
            asset_transfer as u128,
            liability_transfer as u128,
        )
        .unwrap();

        assert_eq!(user.is_being_liquidated(), false);

        let quote_spot_market = spot_market_map.get_ref(&0).unwrap();
        let sol_spot_market = spot_market_map.get_ref(&1).unwrap();

        assert_eq!(
            user.spot_positions[0]
                .get_signed_token_amount(&quote_spot_market)
                .unwrap(),
            40661800
        );
        assert_eq!(
            user.spot_positions[1]
                .get_signed_token_amount(&sol_spot_market)
                .unwrap(),
            -363051
        );

        let market_revenue = get_token_amount(
            sol_spot_market.revenue_pool.scaled_balance,
            &sol_spot_market,
            &SpotBalanceType::Deposit,
        )
        .unwrap();

        assert_eq!(market_revenue, liability_transfer / 100);
    }
}

mod liquidate_dust_prediction_market {

    use crate::controller::liquidation::liquidate_perp;

    use crate::state::oracle_map::OracleMap;
    use crate::state::perp_market_map::PerpMarketMap;
    use crate::state::state::State;
    use crate::state::user::{SpotPosition, User, UserStats};
    use crate::test_utils::{create_account_info, get_spot_positions};
    use crate::{MARGIN_PRECISION, SPOT_BALANCE_PRECISION_U64};

    use crate::state::spot_market_map::SpotMarketMap;
    use anchor_lang::prelude::{AccountLoader, Clock};
    use solana_program::pubkey::Pubkey;
    use std::str::FromStr;

    #[test]
    fn test() {
        let perp_market_str = String::from("Ct8MLGv1N/cN2/1GHLmpS8WGW5376xEzhmbkTG4n0gklXzszMyx0PZG/P6ZU3CggDMEzOjlWpifD6znbmZLE4IIU/HXShHTvAQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAQAAAAAAAAADAAAAAAAAAJZdRmcAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAzM6MJMwYAAAAAAAAAAAAAAAAAAAAAAAAAgMakfo0DAAAAAAAAAAAAAIDGpH6NAwAAAAAAAAAAADiUFQAAAAAAAAAAAAAAAADvebS0HYMCAAAAAAAAAAAAADCkGDUGBQAAAAAAAAAAAACAxqR+jQMAAAAAAAAAAAABAAAAAAAAAAAAAAAAAAAAAIDGpH6NAwAAAAAAAAAAAAAi5xKzIQAAAAAAAAAAAAAAdFGCxP7+////////////AJY4lXcg/////////////wAAAAAAAAAAAAAAAAAAAAAAAI1J/RoHAAAAAAAAAAAA/EgFjzAAAAAAAAAAAAAAAEdAN/36///////////////VVlbVJwAAAAAAAAAAAAAAg2E1/Pr//////////////54TJNYnAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD3wmKBAwAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAPfCYoEDAAAAAAAAAAAAAAD3wmKBAwAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAJhv6gAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAACxuvcxEAQAAAAAAAAAAAAAAOTXfHs3GwMAAAAAAAAAAFVVs9uovAQAAAAAAAAAAAAA4JT7HqoCAAAAAAAAAAAAAQAAAAAAAAAAAAAAAAAAAAMAAAAAAAAABAAAAAAAAAADAAAAAAAAAAMAAAAAAAAAlwQcEgAAAADAxi0AAAAAAPfCYoEDAAAAX0nCZgAAAAAsAQAAAAAAAADKmjsAAAAA6AMAAAAAAAAAypo7AAAAAAAAAAAAAAAACOsVDAAAAAAAAAAAAAAAALAGAAAAAAAAUtAzZwAAAAACAAAAAAAAAAAAAAAAAAAADl5GZwAAAACghgEAQA0DACChBwAgoQcAAAAAAAAAAABkADIAZGQGAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAM65Wok0tAAAAAAAAAAAAAAAAAAAAAAAAEtBTUFMQS1QT1BVTEFSLVZPVEUtMjAyNC1CRVQgICAgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAOwzZwAAAAABAAAAAAAAAOkZAAAAAAAAAQAAAAAAAAABAAAAAAAAAAEAAAAAAAAAqGEAAKhhAAAQJwAACycAAAAAAAAQJwAAcAEAAKYBAAAlAAcCBAMAAAAAAAUFAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==");

        let mut decoded_bytes = base64::decode(perp_market_str).unwrap();
        let perp_market_bytes = decoded_bytes.as_mut_slice();

        let key = Pubkey::default();
        let owner = Pubkey::from_str("dRiftyHA39MWEi3m9aunc5MzRF1JYuBsbn6VPcn33UH").unwrap();
        let mut lamports = 0;
        let perp_market_account_info =
            create_account_info(&key, true, &mut lamports, perp_market_bytes, &owner);

        let perp_market_map = PerpMarketMap::load_one(&perp_market_account_info, true).unwrap();

        let usdc_market_str = String::from("ZLEIa6hBQSdUX6MOo7w/PClm2otsPf7406t9pXygIypU5KAmT//Dwsy3xpWPA/Pp1GfkQjwaxq3rB7BfPBWigujgMxXAX1Z3xvp6877brTo9ZfNqq8l0MbG75MLS9uDkfKYCA0UvXWHmsHZFgFFAI49uEcLfeyYJqqXqJL+++g9w+I4yK2cfD1VTREMgICAgICAgICAgICAgICAgICAgICAgICAgICAgQEIPAAAAAACwBAAAAAAAABcAAAAAAAAAQUIPAAAAAABBQg8AAAAAADKjZGcAAAAAQEIPAAAAAABAQg8AAAAAAEBCDwAAAAAAQEIPAAAAAAAAAAAAAAAAAGf36kp9EAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABHkMifZGT+FrLhfKfHFav7xo95PrVMA7wMfE+znV7oD+waYT94EAAAAAAAAAAAAAPBS1ZcXBAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAgCMRAAAAAABql2RnAAAAABAOAAAAAAAAECcAAIgTAAAAAAAAAAAAAAAAAAAAAAAATgyPkSwaAAMAAAAAAAAAAGxBfbY4Lt0BAAAAAAAAAAAPzIadAgAAAAAAAAAAAAAAl9tr6wIAAAAAAAAAAAAAAFKXFXwAAAAAAAAAAAAAAACq1Rd8AAAAAAAAAAAAAAAAABCl1OgAAAAAQGNSv8YBABvlE5ni0AAA2zFuHsOUAAD8DwsAAAAAADKjZGcAAAAAMqNkZwAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAQAAAAAAAADkoacAAAAAABAnAAAQJwAAECcAABAnAAAAAAAAAAAAAIgTAABgrgoA8EkCAICEHgAGAAAAAAAACgEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAKMFwEAAAAAAMBuMdkQAQAAAAABAQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=");

        let mut decoded_bytes = base64::decode(usdc_market_str).unwrap();
        let usdc_market_bytes = decoded_bytes.as_mut_slice();

        let key = Pubkey::default();
        let owner = Pubkey::from_str("dRiftyHA39MWEi3m9aunc5MzRF1JYuBsbn6VPcn33UH").unwrap();
        let mut lamports = 0;
        let usdc_market_account_info =
            create_account_info(&key, true, &mut lamports, usdc_market_bytes, &owner);

        let sol_market_str = String::from("ZLEIa6hBQScr1lQqaOSFYS9WELcT14N7mJY9eLJbJXlsZ9Z5/AUPNpcdDKvImMwegHYSrqlRr4mPm/gqRPWD+8llAWp4/D4KBpuIV/6rgYT7aH9jRhjANdrEOdwa6ztVmKDwAAAAAAG8K5ZficO5VwesMce/cvsBy5AvfQoKym53Aehbqm9wSVNPTCAgICAgICAgICAgICAgICAgICAgICAgICAgICAgOJOxCwAAAACzfwMAAAAAACIAAAAAAAAAR1ScCwAAAAA766MLAAAAADOjZGcAAAAAoGSVCwAAAAAYS5YLAAAAAIY6nQsAAAAAbbeVCwAAAAAkoGRnAAAAADZtgZYAAAAAAAAAAAAAAAABAAAAAAAAALhrkeitgQIAAAAAAAAAAAAAAAAAAAAAADpkXCdmJx0EdwIORIO8ZZZfwYHxXgB+hbpTZnbj4vD287zFra0AAAAAAAAAAAAAAINoX/qOAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAgCMRAAAAAADommRnAAAAABAOAAAAAAAAQA0DAGDqAADXQ6dL2gAAAAAAAAAAAAAAHly4ea+fAQAAAAAAAAAAAMwVhVWukgAAAAAAAAAAAAD09OVpAgAAAAAAAAAAAAAAGIvYkQIAAAAAAAAAAAAAAC/oSAsAAAAAAAAAAAAAAABX51MBAAAAAAAAAAAAAAAAACA9iHktAAAAIA8MEgUDAMyNlp/K3AEAdwq7QcapAABZmgUAAAAAADOjZGcAAAAAM6NkZwAAAAAAAAAAAAAAAKCGAQAAAAAAZAAAAAAAAAAA4fUFAAAAAAAAAAAAAAAAlsgdAAAAAABUPZYAAAAAAEAfAAAoIwAA4C4AAPgqAADiBAAATB0AAORXAAAANQwA4CICAIBPEgAJAAAAAQABBwEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAJMvoAIAAAAAAEAPhLWjAAABAAABAQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=");

        let mut decoded_bytes = base64::decode(sol_market_str).unwrap();
        let sol_market_bytes = decoded_bytes.as_mut_slice();

        let key = Pubkey::default();
        let owner = Pubkey::from_str("dRiftyHA39MWEi3m9aunc5MzRF1JYuBsbn6VPcn33UH").unwrap();
        let mut lamports = 0;
        let sol_market_account_info =
            create_account_info(&key, true, &mut lamports, sol_market_bytes, &owner);

        let spot_market_map = SpotMarketMap::load_multiple(
            vec![&sol_market_account_info, &usdc_market_account_info],
            false,
        )
        .unwrap();

        let perp_market_oracle_str = String::from("XA6L6kj0RBoCAAAAAAAAAAIAAAAAAAAAAgAAAAAAAADgKWESAAAAAJcEHBIAAAAAJQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA");

        let mut decoded_bytes = base64::decode(perp_market_oracle_str).unwrap();
        let perp_market_oracle_bytes = decoded_bytes.as_mut_slice();

        let key = Pubkey::from_str("AowFw1dCVjS8kngvTCoT3oshiUyL69k7P1uxqXwteWH4").unwrap();
        let owner = Pubkey::from_str("dRiftyHA39MWEi3m9aunc5MzRF1JYuBsbn6VPcn33UH").unwrap();
        let mut lamports = 0;
        let perp_market_oracle_account_info =
            create_account_info(&key, true, &mut lamports, perp_market_oracle_bytes, &owner);

        let usdc_oracle_str = String::from("IvEjY51+9M3Mt8aVjwPz6dRn5EI8Gsat6wewXzwVooLo4DMVwF9WdwAD6qAgxhzEeXEoE0Yc4VOJSpamwAsh7Qz8J5jR+anpyUqE4fUFAAAAAODUAQAAAAAA+P///yejZGcAAAAAJqNkZwAAAACY3PUFAAAAANypAQAAAAAAgSJkEgAAAAA=");

        let mut decoded_bytes = base64::decode(usdc_oracle_str).unwrap();
        let usdc_oracle_bytes = decoded_bytes.as_mut_slice();

        let key = Pubkey::from_str("En8hkHLkRe9d9DraYmBTrus518BvmVH448YcvmrFM6Ce").unwrap();
        let owner = Pubkey::from_str("G6EoTTTgpkNBtVXo96EQp2m6uwwVh2Kt6YidjkmQqoha").unwrap();
        let mut lamports = 0;
        let usdc_oracle_account_info =
            create_account_info(&key, true, &mut lamports, usdc_oracle_bytes, &owner);

        let sol_oracle_str = String::from("IvEjY51+9M2XHQyryJjMHoB2Eq6pUa+Jj5v4KkT1g/vJZQFqePw+CgAC7w2Lb9os66QdoV1AldHaOSoNL47Qxse8D0z6yMKAtW3xgV2RBAAAAE/iXQEAAAAA+P///yOjZGcAAAAAIqNkZwAAAACAkY2JBAAAAGOzSwEAAAAAdyJkEgAAAAA=");

        let mut decoded_bytes = base64::decode(sol_oracle_str).unwrap();
        let sol_oracle_bytes = decoded_bytes.as_mut_slice();

        let key = Pubkey::from_str("BAtFj4kQttZRVep3UZS2aZRDixkGYgWsbqTBVDbnSsPF").unwrap();
        let owner = Pubkey::from_str("G6EoTTTgpkNBtVXo96EQp2m6uwwVh2Kt6YidjkmQqoha").unwrap();
        let mut lamports = 0;
        let sol_oracle_account_info =
            create_account_info(&key, true, &mut lamports, sol_oracle_bytes, &owner);

        let now = 1734646601;
        let clock_slot = 308552347;
        let clock = Clock {
            unix_timestamp: now,
            slot: clock_slot,
            ..Clock::default()
        };

        let account_infos = vec![
            perp_market_oracle_account_info,
            usdc_oracle_account_info,
            sol_oracle_account_info,
        ];
        let mut oracle_map =
            OracleMap::load(&mut account_infos.iter().peekable(), clock_slot, None).unwrap();

        let mut state = State::default();
        state
            .oracle_guard_rails
            .price_divergence
            .oracle_twap_5min_percent_divergence = 1000000000000000000;
        state.liquidation_margin_buffer_ratio = MARGIN_PRECISION / 50;

        let user_str = String::from("n3Vf4++XOuxhtjOJ66/9ylyuDtgBY0sRsymR5GfyzcrsvhwUew5glgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAATWFpbiBBY2NvdW50ICAgICAgICAgICAgICAgICAgICAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAACC8lIBAAAAAAAAAAAAAAAAAikxAAAAAAAAAAAAAAAAAAAAAAAAAAAAEcQyAAAAAAABAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAMqaOwAAAADIWPb//////8hY9v//////QFv2//////8AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAJQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA7B/J//////8AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAQEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAQEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAQEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAQEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAQEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAkgBJBwAAAABGr8cFAAAAAAAAAAAAAAAA+zqt/v////8AAAAAAAAAAKUL0v//////AAAAAAAAAADkXj8SAAAAAHEAAAAAAAAAAwAAAAAAAAAAAAAAAAAAAAxUVWcAAAAAAAAAAAAAAAA=");
        let mut decoded_bytes = base64::decode(user_str).unwrap();
        let user_bytes = decoded_bytes.as_mut_slice();

        let user_key = Pubkey::from_str("5smUuFz1ZzW3FVAF2W1GjYWzxsXQaVyPGdFKfvSnPpaL").unwrap();
        let owner = Pubkey::from_str("dRiftyHA39MWEi3m9aunc5MzRF1JYuBsbn6VPcn33UH").unwrap();
        let mut lamports = 0;
        let user_account_info =
            create_account_info(&user_key, true, &mut lamports, user_bytes, &owner);

        let user_account_loader: AccountLoader<User> =
            AccountLoader::try_from(&user_account_info).unwrap();

        let mut user = user_account_loader.load_mut().unwrap();

        let mut user_stats = UserStats::default();

        let mut liquidator = User::default();
        liquidator.spot_positions = get_spot_positions(SpotPosition {
            market_index: 0,
            scaled_balance: 100 * SPOT_BALANCE_PRECISION_U64,
            ..SpotPosition::default()
        });
        let liquidator_key =
            Pubkey::from_str("5smUuFz1ZzW3FVAF2W1GjYWzxsXQaVyPGdFKfvSnPpaL").unwrap();
        let mut liquidator_stats = UserStats::default();

        let result = liquidate_perp(
            37,
            1000000000000000000,
            None,
            &mut user,
            &user_key,
            &mut user_stats,
            &mut liquidator,
            &liquidator_key,
            &mut liquidator_stats,
            &perp_market_map,
            &spot_market_map,
            &mut oracle_map,
            clock_slot,
            now,
            &state,
        );

        assert_eq!(result, Ok(()));
    }
}

mod liquidate_dust_spot_market {

    use crate::controller::liquidation::liquidate_spot;

    use crate::state::oracle_map::OracleMap;
    use crate::state::perp_market_map::PerpMarketMap;
    use crate::state::state::State;
    use crate::state::user::{SpotPosition, User, UserStats};
    use crate::test_utils::{create_account_info, get_spot_positions};
    use crate::{MARGIN_PRECISION, SPOT_BALANCE_PRECISION_U64};

    use crate::state::spot_market_map::SpotMarketMap;
    use anchor_lang::prelude::{AccountLoader, Clock};
    use solana_program::pubkey::Pubkey;
    use std::str::FromStr;

    #[test]
    fn test() {
        let perp_market_map = PerpMarketMap::empty();

        let usdc_market_str = String::from("ZLEIa6hBQSdUX6MOo7w/PClm2otsPf7406t9pXygIypU5KAmT//Dwsy3xpWPA/Pp1GfkQjwaxq3rB7BfPBWigujgMxXAX1Z3xvp6877brTo9ZfNqq8l0MbG75MLS9uDkfKYCA0UvXWHmsHZFgFFAI49uEcLfeyYJqqXqJL+++g9w+I4yK2cfD1VTREMgICAgICAgICAgICAgICAgICAgICAgICAgICAgQEIPAAAAAAC5AwAAAAAAABEAAAAAAAAAQUIPAAAAAABBQg8AAAAAAN+/ZWcAAAAAQEIPAAAAAABAQg8AAAAAAEBCDwAAAAAAQEIPAAAAAAAAAAAAAAAAAO2k0ouFEwAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABHkMifZGT+FrLhfKfHFav7xo95PrVMA7wMfE+znV7oDDlnHAdcEAAAAAAAAAAAAAJCwvyUPBAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAgCMRAAAAAABuu2VnAAAAABAOAAAAAAAAECcAAIgTAAAAAAAAAAAAAAAAAAAAAAAACM/6sp9NEAMAAAAAAAAAANyWA1vB8vEBAAAAAAAAAAC5ZLedAgAAAAAAAAAAAAAAx/y56wIAAAAAAAAAAAAAACe+FXwAAAAAAAAAAAAAAAB//Bd8AAAAAAAAAAAAAAAAABCl1OgAAAAAQGNSv8YBAAVgYO6o1gAAlnYc/ceXAABv9QoAAAAAAOq/ZWcAAAAA6r9lZwAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAQAAAAAAAAAHvacAAAAAABAnAAAQJwAAECcAABAnAAAAAAAAAAAAAIgTAABgrgoA8EkCAICEHgAGAAAAAAAACgEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAKMFwEAAAAAAMBuMdkQAQAAAAABAQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=");

        let mut decoded_bytes = base64::decode(usdc_market_str).unwrap();
        let usdc_market_bytes = decoded_bytes.as_mut_slice();

        let key = Pubkey::default();
        let owner = Pubkey::from_str("dRiftyHA39MWEi3m9aunc5MzRF1JYuBsbn6VPcn33UH").unwrap();
        let mut lamports = 0;
        let usdc_market_account_info =
            create_account_info(&key, true, &mut lamports, usdc_market_bytes, &owner);

        let sol_market_str = String::from("ZLEIa6hBQScr1lQqaOSFYS9WELcT14N7mJY9eLJbJXlsZ9Z5/AUPNpcdDKvImMwegHYSrqlRr4mPm/gqRPWD+8llAWp4/D4KBpuIV/6rgYT7aH9jRhjANdrEOdwa6ztVmKDwAAAAAAG8K5ZficO5VwesMce/cvsBy5AvfQoKym53Aehbqm9wSVNPTCAgICAgICAgICAgICAgICAgICAgICAgICAgICAgw2JiCwAAAADvSgIAAAAAAAQAAAAAAAAAD2tcCwAAAADWJ18LAAAAAOW/ZWcAAAAA0LJdCwAAAABwOV8LAAAAAINtWwsAAAAAGKhZCwAAAAA9vWVnAAAAAFHWDB8BAAAAAAAAAAAAAAABAAAAAAAAAAqtcVLKhQIAAAAAAAAAAAAAAAAAAAAAADpkXCdmJx0EdwIORIO8ZZZfwYHxXgB+hbpTZnbj4vD2dYDtpq0AAAAAAAAAAAAAAFTJ1+mOAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAgCMRAAAAAADFsGVnAAAAABAOAAAAAAAAQA0DAGDqAAA3oFR62wAAAAAAAAAAAAAAFx41AuZzAQAAAAAAAAAAAFm4hCDxqQAAAAAAAAAAAADv3u5pAgAAAAAAAAAAAAAAPgX1kQIAAAAAAAAAAAAAAC/oSAsAAAAAAAAAAAAAAABX51MBAAAAAAAAAAAAAAAAACA9iHktAAAAIA8MEgUDAJo8rDZbtwEAj9xzvi6sAACCOAYAAAAAAOW/ZWcAAAAA5b9lZwAAAAAAAAAAAAAAAKCGAQAAAAAAZAAAAAAAAAAA4fUFAAAAAAAAAAAAAAAAHc0dAAAAAADqRJYAAAAAAEAfAAAoIwAA4C4AAPgqAADiBAAATB0AAORXAAAANQwA4CICAIBPEgAJAAAAAQABBwEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAJMvoAIAAAAAAEAPhLWjAAABAAABAQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=");

        let mut decoded_bytes = base64::decode(sol_market_str).unwrap();
        let sol_market_bytes = decoded_bytes.as_mut_slice();

        let key = Pubkey::default();
        let owner = Pubkey::from_str("dRiftyHA39MWEi3m9aunc5MzRF1JYuBsbn6VPcn33UH").unwrap();
        let mut lamports = 0;
        let sol_market_account_info =
            create_account_info(&key, true, &mut lamports, sol_market_bytes, &owner);

        let btc_market_str = String::from("ZLEIa6hBQSc8PneF/UaEHXUvNAKBDYzFEth8zuNsU/RjhT3POJeVtH29BUUxTm/izrxCmvmE71Qipt4AMCT0gQnMuKstsICKIzzqR01stRPa1CHILmgfgO11EkVd+5H8aDY7mdkVZYImEGLbWKmQIQDHgAf+18OTFJGMv5G6fep4zl3vqc926ndCVEMgICAgICAgICAgICAgICAgICAgICAgICAgICAg9RVThxYAAADCasMHAAAAACAAAAAAAAAAia/ThBYAAACESzuKFgAAAOW/ZWcAAAAAEICN4AsAAAAAFOhdDwAAAOFtO58NAAAA4W07nw0AAADZ6IdmAAAAAFA2AAAAAAAAAAAAAAAAAAADAAAAAAAAAChZ91WwAAAAAAAAAAAAAAAAAAAAAAAAAMVlHSELrQJ7Nn5RJ6oJu2KIpMq03lncOs4Msa86qgGtpMjdAgAAAAAAAAAAAAAAAODJ1gIAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAgCMRAAAAAADFsGVnAAAAABAOAAAAAAAAQA0DAGDqAABS7m5TAAAAAAAAAAAAAAAAt2mmiicAAAAAAAAAAAAAAPpey9ICAAAAAAAAAAAAAADxvsRVAgAAAAAAAAAAAAAAHZBkXQIAAAAAAAAAAAAAAKUIAAAAAAAAAAAAAAAAAACTWhMAAAAAAAAAAAAAAAAAAITXFwAAAAAArCP8BgAAAI7zK+4DAAAA6ZOxRwAAAABbGwEAAAAAAOW/ZWcAAAAA5b9lZwAAAAAAAAAAAAAAABAnAAAAAAAAECcAAAAAAAAQJwAAAAAAAAAAAAAAAAAA9A0AAAAAAAA8PgAAAAAAAEAfAAAoIwAA4C4AAPgqAAAomgEATB0AAPR+AAAgoQcAoIYBAGDjFgAIAAAAAwABBwEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAEDlnDASAAAAAAABAQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=");

        let mut decoded_bytes = base64::decode(btc_market_str).unwrap();
        let btc_market_bytes = decoded_bytes.as_mut_slice();

        let key = Pubkey::default();
        let owner = Pubkey::from_str("dRiftyHA39MWEi3m9aunc5MzRF1JYuBsbn6VPcn33UH").unwrap();
        let mut lamports = 0;
        let btc_market_account_info =
            create_account_info(&key, true, &mut lamports, btc_market_bytes, &owner);

        let spot_market_map = SpotMarketMap::load_multiple(
            vec![
                &sol_market_account_info,
                &usdc_market_account_info,
                &btc_market_account_info,
            ],
            true,
        )
        .unwrap();
        let usdc_oracle_str = String::from("IvEjY51+9M3Mt8aVjwPz6dRn5EI8Gsat6wewXzwVooLo4DMVwF9WdwAC6qAgxhzEeXEoE0Yc4VOJSpamwAsh7Qz8J5jR+anpyUrj3/UFAAAAAEV0AQAAAAAA+P///9a/ZWcAAAAA1b9lZwAAAACf5vUFAAAAAO80AQAAAAAALNNmEgAAAAA=");

        let mut decoded_bytes = base64::decode(usdc_oracle_str).unwrap();
        let usdc_oracle_bytes = decoded_bytes.as_mut_slice();

        let key = Pubkey::from_str("En8hkHLkRe9d9DraYmBTrus518BvmVH448YcvmrFM6Ce").unwrap();
        let owner = Pubkey::from_str("G6EoTTTgpkNBtVXo96EQp2m6uwwVh2Kt6YidjkmQqoha").unwrap();
        let mut lamports = 0;
        let usdc_oracle_account_info =
            create_account_info(&key, true, &mut lamports, usdc_oracle_bytes, &owner);

        let sol_oracle_str = String::from("IvEjY51+9M2XHQyryJjMHoB2Eq6pUa+Jj5v4KkT1g/vJZQFqePw+CgAC7w2Lb9os66QdoV1AldHaOSoNL47Qxse8D0z6yMKAtW1YlG5yBAAAAIhF5QAAAAAA+P///+K/ZWcAAAAA4b9lZwAAAABA7ldwBAAAAHvY2gAAAAAASNNmEgAAAAA=");

        let mut decoded_bytes = base64::decode(sol_oracle_str).unwrap();
        let sol_oracle_bytes = decoded_bytes.as_mut_slice();

        let key = Pubkey::from_str("BAtFj4kQttZRVep3UZS2aZRDixkGYgWsbqTBVDbnSsPF").unwrap();
        let owner = Pubkey::from_str("G6EoTTTgpkNBtVXo96EQp2m6uwwVh2Kt6YidjkmQqoha").unwrap();
        let mut lamports = 0;
        let sol_oracle_account_info =
            create_account_info(&key, true, &mut lamports, sol_oracle_bytes, &owner);

        let btc_oracle_str = String::from("IvEjY51+9M19vQVFMU5v4s68Qpr5hO9UIqbeADAk9IEJzLirLbCAigACydiwdaXGkwM2WuI2M9TghRmb9cUgo7kP7RMioDQv/DMSlHTczAgAANezVQgDAAAA+P///9a/ZWcAAAAA1b9lZwAAAACg990jzAgAAJQ+EgkDAAAALNNmEgAAAAA=");

        let mut decoded_bytes = base64::decode(btc_oracle_str).unwrap();
        let btc_oracle_bytes = decoded_bytes.as_mut_slice();

        let key = Pubkey::from_str("9Tq8iN5WnMX2PcZGj4iSFEAgHCi8cM6x8LsDUbuzq8uw").unwrap();
        let owner = Pubkey::from_str("G6EoTTTgpkNBtVXo96EQp2m6uwwVh2Kt6YidjkmQqoha").unwrap();
        let mut lamports = 0;
        let btc_oracle_account_info =
            create_account_info(&key, true, &mut lamports, btc_oracle_bytes, &owner);

        let now = 1734721516;
        let clock_slot = 308728664;
        let clock = Clock {
            unix_timestamp: now,
            slot: clock_slot,
            ..Clock::default()
        };

        let account_infos = vec![
            btc_oracle_account_info,
            usdc_oracle_account_info,
            sol_oracle_account_info,
        ];
        let mut oracle_map =
            OracleMap::load(&mut account_infos.iter().peekable(), clock_slot, None).unwrap();

        let mut state = State::default();
        state
            .oracle_guard_rails
            .price_divergence
            .oracle_twap_5min_percent_divergence = 1000000000000000000;
        state.liquidation_margin_buffer_ratio = MARGIN_PRECISION / 50;

        let user_str = String::from("n3Vf4++XOuwLsTVvD0RzIZV6wjrBQeGW8UQMhZsq83DJs/s2vF8BJgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAU3VwZXIgU3Rha2UgSml0b1NPTCAgICAgICAgICAgICAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAACLs0oSAAAAAAAAAQAAAAAAAgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAADAAEAAAAAAEoWAAAAAAAAAAAAAAAAAAAAAAAAAAAAAF7LlQIAAAAAAQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAACEq////////wkAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAKAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAArCdo+f////8AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAFAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAckVb/v////8AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAQEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAQEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAQEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAQEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAQEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA5m6nawIAAACpqB6cAgAAAAAAAAAAAAAAfM3A7f////8AAAAAAAAAAH0c1///////AAAAAAAAAADgQmISAAAAAA0AAADQBwAABwAAAAEBAAAAAAAAAAAAAOq/ZWcAAAAAAAAAAAAAAAA=");
        let mut decoded_bytes = base64::decode(user_str).unwrap();
        let user_bytes = decoded_bytes.as_mut_slice();

        let user_key = Pubkey::from_str("4U5qwCPc3fVfNjFpoLnBjtDNgbcyStpjmGuQiVgPQfdE").unwrap();
        let owner = Pubkey::from_str("dRiftyHA39MWEi3m9aunc5MzRF1JYuBsbn6VPcn33UH").unwrap();
        let mut lamports = 0;
        let user_account_info =
            create_account_info(&user_key, true, &mut lamports, user_bytes, &owner);

        let user_account_loader: AccountLoader<User> =
            AccountLoader::try_from(&user_account_info).unwrap();

        let mut user = user_account_loader.load_mut().unwrap();

        let mut user_stats = UserStats::default();

        let mut liquidator = User::default();
        liquidator.spot_positions = get_spot_positions(SpotPosition {
            market_index: 0,
            scaled_balance: 100 * SPOT_BALANCE_PRECISION_U64,
            ..SpotPosition::default()
        });
        let liquidator_key =
            Pubkey::from_str("5smUuFz1ZzW3FVAF2W1GjYWzxsXQaVyPGdFKfvSnPpaL").unwrap();
        let mut liquidator_stats = UserStats::default();

        let result = liquidate_spot(
            1,
            3,
            1,
            None,
            &mut user,
            &user_key,
            &mut user_stats,
            &mut liquidator,
            &liquidator_key,
            &mut liquidator_stats,
            &perp_market_map,
            &spot_market_map,
            &mut oracle_map,
            now,
            clock_slot,
            &state,
        );

        assert_eq!(result, Ok(()));
    }
}
